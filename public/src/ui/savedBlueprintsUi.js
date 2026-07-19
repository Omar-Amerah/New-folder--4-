// Visualizes saved designs and manages rename, delete, and use actions.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { computeStats } from "../design/componentStats.js";
import { escapeHtml } from "../shared/formatting.js";
import { formatSpeed } from "../design/statFormatting.js";
import { normalizeDesign, normalizeWiring, persistDesign, persistSavedDesigns, persistLoadouts } from "../design/blueprintStorage.js";
import { validateBlueprint } from "../design/blueprintValidation.js";
import { showToast } from "./toastUi.js";
import { updateEconomyUi, renderPurchaseBar, renderLoadoutManager } from "./purchaseUi.js";
import { send } from "../network.js";
import { makeDesignId } from "../shared/ids.js";
import { shipThumbnailDataUrl } from "./shipThumbnail.js";
import { playerMap } from "./scoreboardUi.js";
import { blueprintComparisonRows, formatDelta, formatNumber } from "./section13bUi.js";
import { invalidateHeatAnalysisCache, renderBuildGrid, renderLocalStats, clearPhysicalBlueprintHistory, handleBlueprintConfirmModalAction, closeBlueprintConfirmModalIfPending } from "./designerUi.js";
import { resetWiringEditorState } from "./wiringUi.js";
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

// Preview tint: use the player's own team colour when known, else a neutral blue.
export function previewColor() {
  const me = state.myId ? playerMap().get(state.myId) : null;
  return (me && me.color) || "#8fb4ff";
}

function styleLabel(style) {
  const raw = style || "sentry";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function renderSavedDesigns() {
  if (!dom.savedDesignList) return;
  if (isSavedDesignNameFocused()) return;
  dom.savedDesignList.textContent = "";
  if (!state.savedDesigns.length) {
    const empty = document.createElement("div");
    empty.className = "saved-design-empty";
    empty.textContent = "No saved blueprints yet — build a ship and press Save Blueprint.";
    dom.savedDesignList.appendChild(empty);
    renderPurchaseBar();
    renderLoadoutManager();
    return;
  }

  const color = previewColor();
  // The inspector at the top reflects the design currently loaded in the editor —
  // it is populated only by pressing Edit, never by clicking a card.
  const editing = state.savedDesigns.find((d) => d.id === state.loadedEditorBlueprintId);
  if (editing) dom.savedDesignList.appendChild(buildInspector(editing, color));
  const comparison = buildComparison();
  if (comparison) dom.savedDesignList.appendChild(comparison);

  for (const saved of state.savedDesigns) {
    dom.savedDesignList.appendChild(buildCard(saved, color));
  }
  renderPurchaseBar();
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
  const stats = computeStats(saved.blueprint);
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
      <button type="button" data-saved-action="compare" data-saved-id="${escapeHtml(saved.id)}"${isInvalid ? " disabled" : ""} title="Compare with current editor design">Compare</button>
      <button type="button" data-saved-action="load" data-saved-id="${escapeHtml(saved.id)}"${isInvalid ? " disabled" : ""}>Edit</button>
      <button type="button" data-saved-action="duplicate" data-saved-id="${escapeHtml(saved.id)}" title="Duplicate">⧉</button>
      <button type="button" data-saved-action="delete" data-saved-id="${escapeHtml(saved.id)}" title="Delete">✕</button>
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

  bindCardDrag(card, saved.id);
  return card;
}

function buildInspector(saved, color) {
  const stats = computeStats(saved.blueprint);
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
  if (action === "compare") compareSavedDesign(id);
  else if (action === "clearCompare") { state.compareSavedBlueprintId = null; renderSavedDesigns(); }
  else if (action === "load") loadSavedDesign(id);
  else if (action === "duplicate") duplicateSavedDesign(id);
  else if (action === "delete") deleteSavedDesign(id);
}

// Adds an independent copy of a saved design right after the original, so a
// variant can be built without editing (or losing) the source blueprint.
export function duplicateSavedDesign(id) {
  const index = state.savedDesigns.findIndex((design) => design.id === id);
  if (index < 0) return;
  if (state.savedDesigns.length >= 12) {
    showToast("Design library is full (max 12 slots). Delete some before duplicating.", "warning");
    return;
  }
  const source = state.savedDesigns[index];
  const copyBlueprint = normalizeDesign(source.blueprint, { fallbackOnInvalid: false, allowEmpty: true }).map((part) => ({ ...part }));
  const copy = {
    ...source,
    id: makeDesignId(),
    name: `${source.name} copy`.slice(0, 28),
    blueprint: copyBlueprint,
    // Independent wiring copy so editing the duplicate never touches the source.
    wiring: normalizeWiring(source.wiring, copyBlueprint),
    invalid: Boolean(source.invalid),
    invalidReason: source.invalidReason || "Invalid blueprint.",
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  state.savedDesigns.splice(index + 1, 0, copy);
  persistSavedDesigns(state.savedDesigns);
  renderSavedDesigns();
  updateEconomyUi();
  showToast(`Duplicated "${source.name}"`, "good");
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
  renderPurchaseBar();
  if (state.loadedEditorBlueprintId === id && dom.saveDesignButton) {
    dom.saveDesignButton.textContent = saveBlueprintButtonText();
  }
}

export function deleteSavedDesign(id) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  openDeleteDesignModal(saved);
}

export function openDeleteDesignModal(saved) {
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.pendingDeleteDesignId = saved.id;
  state.pendingKickTargetId = null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Delete blueprint?";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = `Delete ${saved.name}? This cannot be undone.`;
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Delete";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

export function closeConfirmModal() {
  if (closeBlueprintConfirmModalIfPending()) return;
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  if (dom.confirmModal) dom.confirmModal.hidden = true;
  modalReturnFocus?.focus?.();
  modalReturnFocus = null;
}

export function confirmModalAction() {
  if (handleBlueprintConfirmModalAction()) return;
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
  if (state.loadedEditorBlueprintId === id) state.loadedEditorBlueprintId = null;
  // Drop the deleted design from any loadout tabs that referenced it.
  if (Array.isArray(state.loadouts) && state.loadouts.length) {
    state.loadouts = state.loadouts.map((lo) => ({ ...lo, designIds: lo.designIds.filter((did) => did !== id) }));
    persistLoadouts(state.loadouts);
  }
  persistSavedDesigns(state.savedDesigns);
  closeConfirmModal();
  renderSavedDesigns();
  updateEconomyUi();
  showToast(`Deleted ${saved.name}`, "warning");
}

function loadSavedDesign(id) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  if (saved.invalid) {
    showToast(saved.invalidReason || "That blueprint is invalid.", "warning");
    return;
  }
  const valid = normalizeDesign(saved.blueprint);
  state.design = valid;
  // Load an independent copy of the saved wiring alongside the modules, and
  // drop wiring-editor selection/undo state that referenced the old design.
  state.wiring = normalizeWiring(saved.wiring, valid);
  resetWiringEditorState();
  clearPhysicalBlueprintHistory();
  invalidateHeatAnalysisCache();
  state.hoveredHeatPartIndex = null;
  state.combatStyle = saved.combatStyle || "sentry";
  state.loadedEditorBlueprintId = saved.id;

  if (dom.combatStyleSelect) {
    dom.combatStyleSelect.value = state.combatStyle;
  }

  // Save design to localStorage (schema v2: modules + wiring)
  import("../design/blueprintStorage.js").then((mod) => {
    mod.persistDesign(state.design, state.wiring, state.combatStyle);
  });

  // Re-draw grid and update UI
  import("./designerUi.js").then((mod) => {
    mod.invalidateHeatAnalysisCache();
    mod.renderBuildGrid();
    mod.renderLocalStats();
  });
  renderSavedDesigns();
  updateEconomyUi();
  showToast(`Editing ${saved.name}`, "good");
}

function saveBlueprintButtonText() {
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);
  return existing ? `Update "${existing.name}"` : "Save Blueprint";
}

export async function saveCurrentDesign() {
  const blueprint = state.design.map((part) => ({ ...part }));
  // Saved designs keep an independent copy of the wiring arrays.
  const wiring = normalizeWiring(state.wiring, blueprint);
  const stats = computeStats(blueprint);
  const validation = validateBlueprint(blueprint, { requireThrust: true, stats });
  if (!validation.ok) {
    showToast(validation.errors[0] || "Cannot save invalid blueprint.", "warning");
    return;
  }
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);

  if (existing) {
    state.savedDesigns = state.savedDesigns.map((design) => design.id === existing.id ? {
      ...design,
      blueprint,
      wiring,
      combatStyle: state.combatStyle || "sentry",
      cost: stats.unitCost,
      weapons: weaponAbbrevText(stats),
      speed: Math.round(stats.maxSpeed),
      updatedAt: Date.now()
    } : design);
    showToast(`Updated blueprint "${existing.name}"`, "good");
  } else {
    if (state.savedDesigns.length >= 12) {
      showToast("Design library is full (max 12 slots). Delete some before saving.", "warning");
      return;
    }
    const name = `Design ${state.savedDesigns.length + 1}`;
    const id = makeDesignId();
    state.savedDesigns.push({
      id,
      name,
      blueprint,
      wiring,
      combatStyle: state.combatStyle || "sentry",
      cost: stats.unitCost,
      weapons: weaponAbbrevText(stats),
      speed: Math.round(stats.maxSpeed),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    state.loadedEditorBlueprintId = id;
    showToast(`Saved blueprint as "${name}"`, "good");
  }

  const savedOk = persistSavedDesignsImpl(state.savedDesigns);
  if (!savedOk) {
    showToast("Could not save blueprint. Please try again.", "warning");
    return;
  }
  const repaired = state.designNeedsAttention;
  if (repaired) {
    const repairedOk = persistDesignImpl(state.design, state.wiring, state.combatStyle);
    if (!repairedOk) {
      showToast("Could not save repaired blueprint. Please try again.", "warning");
      return;
    }
    state.designNeedsAttention = false;
    state.designNormalizationIssues = [];
    renderLocalStats();
    renderBuildGrid();
    showToast("Repaired blueprint saved. It can now be deployed.", "good");
  }
  
  if (state.phase === "active" && state.socket && state.socket.readyState === WebSocket.OPEN) {
    send({ type: "deploy", design: blueprint, wiring, combatStyle: state.combatStyle || "sentry" });
  }

  renderSavedDesigns();
  updateEconomyUi();
  import("./designerUi.js").then((mod) => {
    mod.invalidateHeatAnalysisCache();
    mod.renderBuildGrid();
  });
}


function compareSavedDesign(id) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved || saved.invalid) return;
  state.compareSavedBlueprintId = id;
  renderSavedDesigns();
}

function buildComparison() {
  const saved = state.savedDesigns.find((design) => design.id === state.compareSavedBlueprintId);
  if (!saved) return null;
  const panel = document.createElement("section");
  panel.className = "blueprint-comparison";
  panel.setAttribute("aria-label", `Comparing current design with ${saved.name}`);
  const rows = blueprintComparisonRows(state.design, saved.blueprint);
  panel.innerHTML = `
    <div class="section-heading compact"><h3>Comparison: ${escapeHtml(saved.name)}</h3><button type="button" class="secondary" data-saved-action="clearCompare" data-saved-id="${escapeHtml(saved.id)}">Clear</button></div>
    <div class="comparison-grid" role="table" aria-label="Current design versus saved blueprint statistics">
      <div role="row" class="comparison-row comparison-head"><span>Stat</span><span>Current</span><span>Saved</span><span>Difference</span></div>
      ${rows.map((row) => `<div role="row" class="comparison-row"><span>${escapeHtml(row.label)}</span><span>${formatNumber(row.current)} ${escapeHtml(row.unit)}</span><span>${formatNumber(row.saved)} ${escapeHtml(row.unit)}</span><span aria-label="Difference ${formatDelta(row.delta, row.unit)}">${formatDelta(row.delta, row.unit)}</span></div>`).join("")}
    </div>`;
  return panel;
}
