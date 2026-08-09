// Visualizes saved designs and manages rename, delete, and use actions.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { escapeHtml } from "../shared/formatting.js";
import { formatSpeed } from "../design/statFormatting.js";
import { normalizeDesign, normalizeDesignDetailed, persistDesign, persistSavedDesigns, persistLoadouts, MAX_SAVED_DESIGNS } from "../design/blueprintStorage.js";
import { PART_STATS } from "../design/parts.js";
import { notify } from "./toastUi.js";
import { renderLoadoutManager } from "./purchaseUi.js";
import { invalidatePresentation } from "../presentationInvalidation.js";
import { send } from "../network.js";
import { makeDesignId } from "../shared/ids.js";
import { shipThumbnailDataUrl } from "./shipThumbnail.js";
import { playerMap } from "./matchStatusUi.js";
import { loadPreferences } from "../localPreferences.js";
import { invalidateHeatAnalysisCache, renderBuildGrid, renderLocalStats, clearPhysicalBlueprintHistory, handleBlueprintConfirmModalAction, closeBlueprintConfirmModalIfPending } from "./designerUi.js";
import { confirmPendingDesignerClose, cancelPendingDesignerClose } from "./designerScreenUi.js";
import { analyseBlueprintOnce, analyseSavedBlueprintOnce } from "../design/blueprintAnalysisCache.js";
let modalReturnFocus = null;
let persistSavedDesignsImpl = persistSavedDesigns;
let persistDesignImpl = persistDesign;

export function setSavedBlueprintPersistenceForTests(overrides = {}) {
  persistSavedDesignsImpl = overrides.persistSavedDesigns || persistSavedDesigns;
  persistDesignImpl = overrides.persistDesign || persistDesign;
}


export function weaponAbbrevText(stats) {
  return `${stats.weaponDps} DPS`;
}

// Preview tint: use the player's own colour when known, else the saved preference, else a neutral blue.
export function previewColor() {
  const me = state.myId ? playerMap().get(state.myId) : null;
  return (me && me.color) || loadPreferences().preferences.preferredColor || "#8fb4ff";
}

// ---- Dirty tracking -----------------------------------------------------------
// Dirty detection compares canonical, order-insensitive keys rather than raw
// JSON.stringify output. Stringifying the arrays reported "unsaved changes" for
// edits that changed nothing about the ship: a replaced part lands at the end of
// the modules array, and object key order differs between freshly placed parts
// rehydrated from storage.

function moduleIdentity(part) {
  return `${Math.trunc(Number(part?.x))},${Math.trunc(Number(part?.y))},${String(part?.type || "")}`;
}

function moduleKey(part) {
  return `${moduleIdentity(part)},${part?.rotation || 0},${part?.flipped === true ? "m" : ""},${part?.droneType || ""}`;
}

// Data links are (source, weapon) module-index pairs resolved to positional
// identities. Without them in the key, adding or removing a link would leave
// the editor looking clean.
function dataLinksKey(dataLinks, moduleRef) {
  return (Array.isArray(dataLinks) ? dataLinks : [])
    .map((link) => `${moduleRef(link?.sourceIndex)}>${moduleRef(link?.targetIndex)}`)
    .sort()
    .join("/");
}

function editorStateKey(modules, combatStyle, dataLinks) {
  const list = Array.isArray(modules) ? modules : [];
  // Link endpoints are module indexes into this exact array, so resolve them to
  // positional identities before sorting anything.
  const identities = list.map(moduleIdentity);
  const moduleRef = (index) => identities[index] ?? `#${index}`;
  const normalized = normalizeDesignDetailed(list, { allowEmpty: true }).modules.map(moduleKey).sort();
  return [
    normalized.join("/"),
    combatStyle || "hold",
    dataLinksKey(dataLinks, moduleRef)
  ].join("\n");
}

function currentEditorKey() {
  return editorStateKey(state.design, state.combatStyle, state.dataLinks);
}

function savedEditorKey(saved) {
  return editorStateKey(saved.blueprint, saved.combatStyle, saved.dataLinks);
}

// Baseline for a design that no saved blueprint backs. See isEditorDirty().
let editorBaselineKey = null;

export function captureEditorBaseline() {
  editorBaselineKey = currentEditorKey();
}

export function isEditorDirty() {
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
  const current = currentEditorKey();
  if (existing) {
    return current !== savedEditorKey(existing);
  }
  // No saved blueprint backs the editor. The working design is written to
  // localStorage on every edit, so closing the designer cannot lose it : only
  // loading another blueprint over it can. Treat it as dirty solely when it has
  // actually changed since the designer was opened (or since the last save/load).
  if (editorBaselineKey === null) editorBaselineKey = current;
  return current !== editorBaselineKey;
}

// True only when a saved blueprint is loaded and the editor has diverged from
// it : i.e. when discarding the editor would actually lose work that is not
// recoverable from the auto-persisted current design.
export function isLoadedBlueprintDirty() {
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
  if (!existing) return false;
  return currentEditorKey() !== savedEditorKey(existing);
}

export function refreshLoadedBlueprintPresentation() {
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
  if (dom.loadedBlueprintName) dom.loadedBlueprintName.textContent = existing?.name || "Unsaved design";
  const dirty = isEditorDirty();
  const savedToLibrary = Boolean(existing) && !dirty;
  if (dom.loadedBlueprintState) {
    dom.loadedBlueprintState.textContent = existing ? (dirty ? "Unsaved changes" : "Saved") : "Not in library";
    dom.loadedBlueprintState.classList.toggle("saved", savedToLibrary);
    dom.loadedBlueprintState.classList.toggle("unsaved", !savedToLibrary);
  }
  if (dom.saveDesignButton) {
    dom.saveDesignButton.disabled = savedToLibrary;
    dom.saveDesignButton.title = savedToLibrary ? "No unsaved changes" : "";
    dom.saveDesignButton.classList.toggle("is-primary", !savedToLibrary);
    dom.saveDesignButton.classList.toggle("secondary", savedToLibrary);
  }
}

function styleLabel(style) {
  const raw = style || "hold";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function renderSavedDesigns() {
  if (!dom.savedDesignList) return;
  if (dom.savedBlueprintCount) {
    dom.savedBlueprintCount.textContent = `${state.savedDesigns.length} / ${MAX_SAVED_DESIGNS}`;
  }
  if (isSavedDesignNameFocused()) return;
  dom.savedDesignList.textContent = "";
  if (!state.savedDesigns.length) {
    const empty = document.createElement("div");
    empty.className = "saved-design-empty";
    empty.textContent = "No saved blueprints yet : build a ship and press Save Blueprint.";
    dom.savedDesignList.appendChild(empty);
    renderLoadoutManager();
    return;
  }

  const color = previewColor();

  const query = String(state.savedBlueprintSearch || "").trim().toLowerCase();
  let designs = state.savedDesigns.filter(saved => !query || saved.name.toLowerCase().includes(query));
  if (state.savedBlueprintSort === "name") designs = designs.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (state.savedBlueprintSort === "updated") designs = designs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  for (const saved of designs) {
    dom.savedDesignList.appendChild(buildCard(saved, color));
  }
  if (!designs.length) {
    const empty = document.createElement("div");
    empty.className = "saved-design-empty";
    empty.textContent = "No blueprints match this search.";
    dom.savedDesignList.appendChild(empty);
  }
  renderLoadoutManager();
}

function statChips(stats) {
  return `
    <span class="bp-chip" title="Unit cost">$${stats.unitCost}</span>
    <span class="bp-chip" title="Weapon DPS">${stats.weaponDps} DPS</span>
    <span class="bp-chip" title="Hull">${Math.round(stats.maxHp)} HP</span>
    ${stats.maxShield > 0 ? `<span class="bp-chip bp-chip-shield" title="Shield">${Math.round(stats.maxShield)} SH</span>` : ""}
    <span class="bp-chip" title="Top speed">${formatSpeed(Math.round(stats.maxSpeed))}</span>`;
}

function buildCard(saved, color) {
  const analysis = analyseSavedBlueprintOnce(saved);
  const stats = analysis.stats;
  const isEditing = saved.id === state.loadedEditorBlueprintId;
  const isInvalid = Boolean(saved.invalid);
  const thumb = shipThumbnailDataUrl(saved.blueprint, color, 84);

  const card = document.createElement("div");
  card.className = `bp-card${isEditing ? " editing" : ""}${isInvalid ? " invalid" : ""}`;
  card.dataset.savedId = saved.id;
  // Drag is enabled only from the handle (below) so it never hijacks text
  // selection in the name input.
  card.setAttribute("draggable", "false");
  card.innerHTML = `
    <span class="bp-drag" aria-hidden="true" title="Drag to reorder">⠿</span>
    <div class="bp-thumb">${thumb ? `<img src="${thumb}" alt="" draggable="false">` : ""}</div>
    <div class="bp-main">
      <div class="bp-name-row">
        <input class="saved-design-name" value="${escapeHtml(saved.name)}" maxlength="28" aria-label="Blueprint name">
        ${isEditing ? `<span class="bp-editing-tag">Editing</span>` : ""}
        ${isInvalid ? `<span class="bp-editing-tag" title="${escapeHtml(saved.invalidReason || "Invalid blueprint")}">Invalid</span>` : ""}
      </div>
      <div class="bp-chips">${isInvalid ? escapeHtml(saved.invalidReason || "Invalid blueprint") : statChips(stats)}</div>
    </div>
    <div class="bp-actions saved-design-actions">
      <button type="button" data-saved-action="edit" data-saved-id="${escapeHtml(saved.id)}"${isInvalid ? " disabled" : ""}>Edit Original</button>
      <button type="button" class="primary" data-saved-action="load" data-saved-id="${escapeHtml(saved.id)}"${isInvalid ? " disabled" : ""}>Load Copy</button>
      <details class="bp-overflow">
        <summary aria-label="More actions for ${escapeHtml(saved.name)}" title="More actions">⋯</summary>
        <div class="bp-overflow-menu">
          <button type="button" data-saved-action="duplicate" data-saved-id="${escapeHtml(saved.id)}">Duplicate</button>
          <button type="button" class="danger" data-saved-action="delete" data-saved-id="${escapeHtml(saved.id)}">Delete</button>
        </div>
      </details>
    </div>
  `;

  const nameInput = card.querySelector(".saved-design-name");
  nameInput?.addEventListener("pointerdown", (event) => event.stopPropagation());
  nameInput?.addEventListener("click", (event) => event.stopPropagation());
  nameInput?.addEventListener("change", () => renameSavedDesign(saved.id, nameInput.value));
  nameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") nameInput.blur();
    event.stopPropagation();
  });

  if ((state.savedBlueprintSort || "manual") === "manual") bindCardDrag(card, saved.id);
  else card.querySelector(".bp-drag")?.setAttribute("hidden", "");
  return card;
}

function buildInspector(saved, color) {
  const analysis = analyseSavedBlueprintOnce(saved);
  const stats = analysis.stats;
  const thumb = shipThumbnailDataUrl(saved.blueprint, color, 160);
  const inspector = document.createElement("div");
  inspector.className = "bp-inspector";
  inspector.innerHTML = `
    <div class="bp-inspector-preview">${thumb ? `<img src="${thumb}" alt="Ship preview" draggable="false">` : ""}</div>
    <div class="bp-inspector-body">
      <div class="bp-inspector-title">${escapeHtml(saved.name)}</div>
      <div class="bp-inspector-style">Combat style: <strong>${styleLabel(saved.combatStyle)}</strong></div>
      <div class="bp-inspector-stats">
        <div class="bp-stat bp-stat-cost"><span>Cost</span><strong>$${stats.unitCost}</strong></div>
      </div>
      <div class="bp-inspector-actions">
        <button type="button" class="bp-editing-btn" disabled>● Editing</button>
      </div>
    </div>
  `;
  return inspector;
}

// ---- Drag-and-drop reordering -------------------------------------------------

function bindCardDrag(card, id) {
  const handle = card.querySelector(".bp-drag");
  handle?.addEventListener("mousedown", () => card.setAttribute("draggable", "true"));
  handle?.addEventListener("touchstart", () => card.setAttribute("draggable", "true"), { passive: true });
  card.addEventListener("dragstart", (event) => {
    state.draggingSavedDesignId = id;
    card.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      try { event.dataTransfer.setData("text/plain", id); } catch { /* some browsers restrict */ }
    }
  });
  card.addEventListener("dragend", () => {
    state.draggingSavedDesignId = null;
    card.classList.remove("dragging");
    card.setAttribute("draggable", "false");
    dom.savedDesignList?.querySelectorAll?.(".bp-card.drop-target")?.forEach((el) => el.classList.remove("drop-target"));
  });
  card.addEventListener("dragover", (event) => {
    if (!state.draggingSavedDesignId || state.draggingSavedDesignId === id) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    card.classList.add("drop-target");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
  card.addEventListener("drop", (event) => {
    event.preventDefault();
    card.classList.remove("drop-target");
    const fromId = state.draggingSavedDesignId;
    if (fromId && fromId !== id) reorderSavedDesign(fromId, id);
  });
}

function reorderSavedDesign(fromId, toId) {
  const list = state.savedDesigns.slice();
  const fromIndex = list.findIndex((d) => d.id === fromId);
  const toIndex = list.findIndex((d) => d.id === toId);
  if (fromIndex < 0 || toIndex < 0) return;
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  state.savedDesigns = list;
  persistSavedDesigns(state.savedDesigns);
  renderSavedDesigns();
}

export function handleSavedDesignPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const button = event.target?.closest?.("[data-saved-action]");
  if (!button || !dom.savedDesignList?.contains(button)) return;
  event.preventDefault();
  clearSavedDesignPressedButtons();
  button.classList.add("pressed");
  state.savedDesignPointer = {
    action: button.dataset.savedAction || "",
    id: button.dataset.savedId || "",
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY
  };
  try {
    dom.savedDesignList.setPointerCapture?.(event.pointerId);
  } catch {
    // Best effort pointer capture
  }
}

export function handleSavedDesignPointerUp(event) {
  const pointer = state.savedDesignPointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  clearSavedDesignPointer();
  try {
    dom.savedDesignList.releasePointerCapture?.(event.pointerId);
  } catch {
    // Best effort
  }
  const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
  const bounds = dom.savedDesignList.getBoundingClientRect();
  const releasedInside = event.clientX >= bounds.left
    && event.clientX <= bounds.right
    && event.clientY >= bounds.top
    && event.clientY <= bounds.bottom;
  if (moved > 12 || !releasedInside) return;
  event.preventDefault();
  runSavedDesignAction(pointer.action, pointer.id);
}

export function clearSavedDesignPointer() {
  clearSavedDesignPressedButtons();
  state.savedDesignPointer = null;
}

export function clearSavedDesignPressedButtons() {
  dom.savedDesignList?.querySelectorAll?.("[data-saved-action].pressed")?.forEach((button) => {
    button.classList.remove("pressed");
  });
}

export function handleSavedDesignKeyboardClick(event) {
  if (event.detail !== 0) return;
  const button = event.target?.closest?.("[data-saved-action]");
  if (!button || !dom.savedDesignList?.contains(button)) return;
  event.preventDefault();
  runSavedDesignAction(button.dataset.savedAction || "", button.dataset.savedId || "");
}

export function runSavedDesignAction(action, id) {
  if (action === "load") loadSavedDesign(id, false);
  else if (action === "edit") loadSavedDesign(id, true);
  else if (action === "duplicate") duplicateSavedDesign(id);
  else if (action === "delete") deleteSavedDesign(id);
}

// Adds an independent copy of a saved design right after the original, so a
// variant can be built without editing (or losing) the source blueprint.
export function duplicateSavedDesign(id) {
  const index = state.savedDesigns.findIndex((design) => design.id === id);
  if (index < 0) return;
  if (state.savedDesigns.length >= MAX_SAVED_DESIGNS) {
    notify.warning(`Design library is full (max ${MAX_SAVED_DESIGNS} slots). Delete some before duplicating.`);
    return;
  }
  const source = state.savedDesigns[index];
  const copyBlueprint = normalizeDesign(source.blueprint, { fallbackOnInvalid: false, allowEmpty: true }).map((part) => ({ ...part }));
  const copy = {
    ...source,
    id: makeDesignId(),
    name: `${source.name} copy`.slice(0, 28),
    blueprint: copyBlueprint,
    // Independent Data-link copies so editing the duplicate never touches the source.
    dataLinks: savedDataLinksCopy(copyBlueprint, source.dataLinks),
    invalid: Boolean(source.invalid),
    invalidReason: source.invalidReason || "Invalid blueprint.",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.savedDesigns.splice(index + 1, 0, copy);
  persistSavedDesigns(state.savedDesigns);
  renderSavedDesigns();
  invalidatePresentation("purchase-catalogue");
}

export function isSavedDesignNameFocused() {
  return Boolean(document.activeElement?.classList?.contains("saved-design-name"));
}

export function renameSavedDesign(id, name) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  const cleanName = String(name || "").trim().slice(0, 28);
  if (!cleanName || cleanName === saved.name) return;
  state.savedDesigns = state.savedDesigns.map((design) => design.id === id
    ? { ...design, name: cleanName, updatedAt: Date.now() }
    : design);
  persistSavedDesigns(state.savedDesigns);
  invalidatePresentation("purchase-catalogue");
  if (state.loadedEditorBlueprintId === id) refreshLoadedBlueprintPresentation();
}

export function deleteSavedDesign(id) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  openDeleteDesignModal(saved);
}

export function openDeleteDesignModal(saved) {
  state.pendingDirtyAction = null;
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.pendingDeleteDesignId = saved.id;
  state.pendingKickTargetId = null;
  if (dom.confirmModal) delete dom.confirmModal.dataset.intent;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Delete blueprint?";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = `Delete ${saved.name}? This cannot be undone.`;
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Delete";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

export function closeConfirmModal() {
  if (cancelPendingDesignerClose()) return;
  if (closeBlueprintConfirmModalIfPending()) return;
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  state.pendingServerLeaveAction = null;
  state.pendingDirtyAction = null;
  if (dom.confirmDiscardButton) dom.confirmDiscardButton.hidden = true;
  if (dom.confirmModal) {
    delete dom.confirmModal.dataset.intent;
    dom.confirmModal.hidden = true;
  }
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
}

export function confirmModalAction() {
  if (confirmPendingDesignerClose()) return;
  if (state.pendingDirtyAction) {
    const action = state.pendingDirtyAction;
    state.pendingDirtyAction = null;
    if (dom.confirmDiscardButton) dom.confirmDiscardButton.hidden = true;
    if (dom.confirmModal) {
      delete dom.confirmModal.dataset.intent;
      dom.confirmModal.hidden = true;
    }
    modalReturnFocus = null;
    void saveCurrentDesign().then((saved) => {
      if (saved) action();
    });
    return;
  }
  if (handleBlueprintConfirmModalAction()) return;
  if (state.pendingServerLeaveAction) {
    const action = state.pendingServerLeaveAction;
    closeConfirmModal();
    action();
    return;
  }
  if (state.pendingKickTargetId) {
    const targetId = state.pendingKickTargetId;
    closeConfirmModal();
    send({ type: "kick", targetId });
    return;
  }
  const id = state.pendingDeleteDesignId;
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) {
    closeConfirmModal();
    return;
  }
  state.savedDesigns = state.savedDesigns.filter((design) => design.id !== id);
  if (state.loadedEditorBlueprintId === id) {
    state.loadedEditorBlueprintId = null;
    refreshLoadedBlueprintPresentation();
  }
  // Drop the deleted design from any loadout tabs that referenced it.
  if (Array.isArray(state.loadouts) && state.loadouts.length) {
    state.loadouts = state.loadouts.map((lo) => ({ ...lo, designIds: lo.designIds.filter((did) => did !== id) }));
    persistLoadouts(state.loadouts);
  }
  persistSavedDesigns(state.savedDesigns);
  closeConfirmModal();
  renderSavedDesigns();
  invalidatePresentation("purchase-catalogue");
}

function loadSavedDesign(id, editSource = true) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  if (saved.invalid) {
    notify.warning(saved.invalidReason || "That blueprint is invalid.");
    return;
  }
  if (isEditorDirty()) {
    openDirtyEditorModal(() => doLoadSavedDesign(id, editSource));
    return;
  }
  doLoadSavedDesign(id, editSource);
}

function doLoadSavedDesign(id, editSource = true) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  const valid = normalizeDesign(saved.blueprint);
  state.design = valid;
  // Data links are stored as component indices, so they only mean anything
  // against the modules they were saved with. Re-normalize against those.
  state.dataLinks = globalThis.DataSupportRules?.normalizeDataLinks(valid, saved.dataLinks, PART_STATS) || [];
  clearPhysicalBlueprintHistory();
  invalidateHeatAnalysisCache();
  state.hoveredHeatPartIndex = null;
  state.combatStyle = saved.combatStyle || "hold";
  state.loadedEditorBlueprintId = editSource ? saved.id : null;
  captureEditorBaseline();
  refreshLoadedBlueprintPresentation();

  if (dom.combatStyleSelect) {
    dom.combatStyleSelect.value = state.combatStyle;
  }

  // Save the loaded design to localStorage.
  import("../design/blueprintStorage.js").then((mod) => {
    mod.persistDesign(state.design, state.dataLinks, state.combatStyle);
  });

  // Re-draw grid and update UI
  import("./designerUi.js").then((mod) => {
    mod.invalidateHeatAnalysisCache();
    mod.renderBuildGrid();
    mod.renderLocalStats();
  });
  renderSavedDesigns();
  invalidatePresentation("purchase-catalogue");
  document.dispatchEvent(new CustomEvent("designer-inspector-activate", { detail: { tab: "design" } }));
}

function openDirtyEditorModal(pendingAction) {
  state.pendingDirtyAction = pendingAction;
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  state.pendingBlueprintDestructiveAction = null;
  state.pendingServerLeaveAction = null;
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (dom.confirmModal) dom.confirmModal.dataset.intent = "dirty-editor";
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Unsaved Changes";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = "Your current design has unsaved changes. What would you like to do?";
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Save Changes";
  if (dom.confirmDiscardButton) {
    dom.confirmDiscardButton.hidden = false;
    dom.confirmDiscardButton.textContent = "Continue Anyway";
  }
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

export function confirmDiscardAction() {
  if (!state.pendingDirtyAction) return false;
  const action = state.pendingDirtyAction;
  state.pendingDirtyAction = null;
  if (dom.confirmDiscardButton) dom.confirmDiscardButton.hidden = true;
  if (dom.confirmModal) {
    delete dom.confirmModal.dataset.intent;
    dom.confirmModal.hidden = true;
  }
  modalReturnFocus = null;
  action();
  return true;
}

export function initializeSavedBlueprintLibraryControls() {
  if (dom.savedBlueprintSearch && dom.savedBlueprintSearch.dataset.bound !== "true") {
    dom.savedBlueprintSearch.value = state.savedBlueprintSearch || "";
    dom.savedBlueprintSearch.addEventListener("input", () => {
      state.savedBlueprintSearch = dom.savedBlueprintSearch.value;
      renderSavedDesigns();
    });
    dom.savedBlueprintSearch.dataset.bound = "true";
  }
  if (dom.savedBlueprintSort && dom.savedBlueprintSort.dataset.bound !== "true") {
    dom.savedBlueprintSort.value = state.savedBlueprintSort || "manual";
    dom.savedBlueprintSort.addEventListener("change", () => {
      state.savedBlueprintSort = dom.savedBlueprintSort.value;
      renderSavedDesigns();
    });
    dom.savedBlueprintSort.dataset.bound = "true";
  }
}

// Independent, normalized copy of the links, so editing the design later never
// reaches back into the saved entry (and dropped links never survive a save).
function savedDataLinksCopy(blueprint, dataLinks) {
  const rules = globalThis.DataSupportRules;
  if (!rules?.normalizeDataLinks) {
    return (Array.isArray(dataLinks) ? dataLinks : []).map((link) => ({ ...link }));
  }
  return rules.normalizeDataLinks(blueprint, dataLinks, PART_STATS) || [];
}

export async function saveCurrentDesignAsCopy() {
  state.loadedEditorBlueprintId = null;
  return saveCurrentDesign();
}

export async function saveCurrentDesign() {
  const blueprint = state.design.map((part) => ({ ...part }));
  const dataLinks = savedDataLinksCopy(blueprint, state.dataLinks);
  const analysis = analyseBlueprintOnce({ blueprint, dataLinks, combatStyle: state.combatStyle || "hold" });
  const stats = analysis.stats;
  const validation = analysis.validation;
  if (!validation.ok) {
    notify.warning(validation.errors[0] || "Cannot save invalid blueprint.");
    return false;
  }
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);

  if (existing) {
    state.savedDesigns = state.savedDesigns.map((design) => design.id === existing.id ? {
      ...design,
      blueprint,
      dataLinks,
      combatStyle: state.combatStyle || "hold",
      cost: stats.unitCost,
      weapons: weaponAbbrevText(stats),
      speed: Math.round(stats.maxSpeed),
      updatedAt: Date.now()
    } : design);
  } else {
    if (state.savedDesigns.length >= MAX_SAVED_DESIGNS) {
      notify.warning(`Design library is full (max ${MAX_SAVED_DESIGNS} slots). Delete some before saving.`);
      return false;
    }
    const name = `Design ${state.savedDesigns.length + 1}`;
    const id = makeDesignId();
    state.savedDesigns.push({
      id,
      name,
      blueprint,
      dataLinks,
      combatStyle: state.combatStyle || "hold",
      cost: stats.unitCost,
      weapons: weaponAbbrevText(stats),
      speed: Math.round(stats.maxSpeed),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    state.loadedEditorBlueprintId = id;
    refreshLoadedBlueprintPresentation();
  }

  const savedOk = persistSavedDesignsImpl(state.savedDesigns);
  if (!savedOk) {
    notify.warning("Could not save blueprint. Please try again.");
    return false;
  }
  const repaired = state.designNeedsAttention;
  if (repaired) {
    const repairedOk = persistDesignImpl(state.design, state.dataLinks, state.combatStyle);
    if (!repairedOk) {
      notify.warning("Could not save repaired blueprint. Please try again.");
      return false;
    }
    state.designNeedsAttention = false;
    state.designNormalizationIssues = [];
    renderLocalStats();
    renderBuildGrid();
  }
  
  if (state.phase === "active" && state.socket && state.socket.readyState === WebSocket.OPEN) {
    send({ type: "deploy", design: blueprint, dataLinks: state.dataLinks, combatStyle: state.combatStyle || "hold" });
  }

  captureEditorBaseline();
  refreshLoadedBlueprintPresentation();
  renderSavedDesigns();
  invalidatePresentation("purchase-catalogue");
  import("./designerUi.js").then((mod) => {
    mod.invalidateHeatAnalysisCache();
    mod.renderBuildGrid();
  });
  return true;
}


