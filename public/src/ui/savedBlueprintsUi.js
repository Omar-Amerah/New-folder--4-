// Visualizes saved designs and manages rename, delete, and use actions.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { computeStats } from "../design/componentStats.js";
import { escapeHtml } from "../shared/formatting.js";
import { formatSpeed } from "../design/statFormatting.js";
import { normalizeDesign, persistSavedDesigns } from "../design/blueprintStorage.js";
import { showToast } from "./toastUi.js";
import { updateEconomyUi, renderPurchaseBar } from "./purchaseUi.js";
import { send } from "../network.js";
import { makeDesignId } from "../shared/ids.js";


export function weaponAbbrevText(stats) {
  return `${Number(stats.blaster) || 0}b/${Number(stats.missile) || 0}m/${Number(stats.railgun) || 0}r`;
}

export function renderSavedDesigns() {
  if (!dom.savedDesignList) return;
  if (isSavedDesignNameFocused()) return;
  dom.savedDesignList.textContent = "";
  if (!state.savedDesigns.length) {
    const empty = document.createElement("div");
    empty.className = "saved-design-empty";
    empty.textContent = "No saved blueprints yet";
    dom.savedDesignList.appendChild(empty);
    renderPurchaseBar();
    return;
  }

  for (const saved of state.savedDesigns) {
    const stats = computeStats(saved.blueprint);
    const row = document.createElement("div");
    row.className = "saved-design-card";
    row.innerHTML = `
      <div class="saved-design-head">
        <input class="saved-design-name" value="${escapeHtml(saved.name)}" maxlength="28" aria-label="Blueprint name">
      </div>
      <div class="saved-design-summary">Cost $${stats.unitCost} · Weapons (${weaponAbbrevText(stats)}) · Speed ${formatSpeed(Math.round(stats.maxSpeed))}</div>
      <div class="saved-design-actions">
        <button type="button" data-saved-action="load" data-saved-id="${escapeHtml(saved.id)}">Use/Edit</button>
        <button type="button" data-saved-action="delete" data-saved-id="${escapeHtml(saved.id)}">Delete</button>
      </div>
    `;
    const nameInput = row.querySelector(".saved-design-name");
    nameInput?.addEventListener("pointerdown", (event) => event.stopPropagation());
    nameInput?.addEventListener("click", (event) => event.stopPropagation());
    nameInput?.addEventListener("change", () => renameSavedDesign(saved.id, nameInput.value));
    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") nameInput.blur();
      event.stopPropagation();
    });
    dom.savedDesignList.appendChild(row);
  }
  renderPurchaseBar();
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
  if (action === "load") loadSavedDesign(id);
  else if (action === "delete") deleteSavedDesign(id);
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
  state.pendingDeleteDesignId = saved.id;
  state.pendingKickTargetId = null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Delete blueprint?";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = `Delete ${saved.name}? This cannot be undone.`;
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Delete";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

export function closeConfirmModal() {
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  if (dom.confirmModal) dom.confirmModal.hidden = true;
}

export function confirmModalAction() {
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
  persistSavedDesigns(state.savedDesigns);
  closeConfirmModal();
  renderSavedDesigns();
  updateEconomyUi();
  showToast(`Deleted ${saved.name}`, "warning");
}

function loadSavedDesign(id) {
  const saved = state.savedDesigns.find((design) => design.id === id);
  if (!saved) return;
  const valid = normalizeDesign(saved.blueprint);
  state.design = valid;
  state.loadedEditorBlueprintId = saved.id;
  
  // Save design to localStorage v2
  import("../design/blueprintStorage.js").then((mod) => {
    mod.persistDesign(state.design);
  });

  // Re-draw grid and update UI
  import("./designerUi.js").then((mod) => {
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

export function saveCurrentDesign() {
  const blueprint = state.design.map((part) => ({ ...part }));
  const stats = computeStats(blueprint);
  const existing = state.savedDesigns.find((design) => design.id === state.loadedEditorBlueprintId);

  if (existing) {
    state.savedDesigns = state.savedDesigns.map((design) => design.id === existing.id ? {
      ...design,
      blueprint,
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
      cost: stats.unitCost,
      weapons: weaponAbbrevText(stats),
      speed: Math.round(stats.maxSpeed),
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    state.loadedEditorBlueprintId = id;
    showToast(`Saved blueprint as "${name}"`, "good");
  }

  persistSavedDesigns(state.savedDesigns);
  
  if (state.phase === "active" && state.socket && state.socket.readyState === WebSocket.OPEN) {
    send({ type: "deploy", design: blueprint });
  }

  renderSavedDesigns();
  updateEconomyUi();
  import("./designerUi.js").then((mod) => {
    mod.renderBuildGrid();
  });
}

