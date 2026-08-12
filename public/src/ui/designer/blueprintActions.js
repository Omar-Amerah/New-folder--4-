import { dom } from "../dom.js";
import { state } from "../../state.js";
import { PART_STATS, isFlippablePart, isRotatablePart } from "../../design/parts.js";
import { createPlacementCandidate } from "../../design/placementCandidate.js";
import { nextRotation } from "../../design/rotation.js";
import { isOutOfBounds, isOverlapping } from "../../design/blueprintValidation.js";
import { defaultDesign, persistDesign } from "../../design/blueprintStorage.js";
import {
  blueprintSnapshotsEqual,
  canUndoBlueprintEdit,
  captureBlueprintEditSnapshot,
  clearBlueprintEditHistory,
  pushBlueprintEditSnapshot,
  undoBlueprintEdit as popBlueprintEditUndo
} from "../../design/blueprintEditHistory.js";
import { invalidatePresentation } from "../../presentationInvalidation.js";
import { notify } from "../toastUi.js";
import { renderPartInspector } from "../partInspectorUi.js";
import { refreshLoadedBlueprintPresentation, renderSavedDesigns } from "../savedBlueprintsUi.js";
import {
  isBlueprintRemovalMode,
  isBlueprintRotationMode,
  refreshRotationIndicator,
  rememberPartTransform,
  renderHoverPreview
} from "./buildMode.js";
import { findPartAt } from "./layout.js";
import {
  clearHeatInspectionState,
  clearInvalidHeatIndexes,
  invalidateHeatAnalysisCache
} from "./heatMode.js";

let blueprintEditUiHooks = null;
let designerCoordinator = null;

export function configureBlueprintActions(coordinator) {
  designerCoordinator = coordinator;
}

export function refreshBlueprintUndoControl() {
  if (!dom.undoBlueprintEditButton) return;
  dom.undoBlueprintEditButton.disabled = !canUndoBlueprintEdit();
  dom.undoBlueprintEditButton.title = "Undo last blueprint edit (Ctrl+Z)";
  dom.undoBlueprintEditButton.setAttribute("aria-label", "Undo last blueprint edit");
}

function persistCurrentEditorDesign() {
  if (blueprintEditUiHooks?.persistDesign) return blueprintEditUiHooks.persistDesign(state.design, state.dataLinks, state.combatStyle);
  return persistDesign(state.design, state.dataLinks, state.combatStyle);
}

function refreshEditorAfterBlueprintHistoryChange() {
  if (blueprintEditUiHooks?.refresh) return blueprintEditUiHooks.refresh();
  designerCoordinator?.renderBuildGrid();
  designerCoordinator?.renderLocalStats();
  renderSavedDesigns();
  refreshBlueprintUndoControl();
}

export function setBlueprintEditHistoryUiHooksForTests(hooks = null) {
  blueprintEditUiHooks = hooks;
}

function refreshAfterPhysicalEdit() {
  clearInvalidHeatIndexes();
  invalidateHeatAnalysisCache();
  persistCurrentEditorDesign();
  refreshEditorAfterBlueprintHistoryChange();
  invalidatePresentation("blueprint-edit");
}

function restoreNoOpPhysicalEditUiState(uiBefore) {
  state.hoveredHeatPartIndex = uiBefore.hoveredHeatPartIndex;
}

function commitPhysicalEdit(before, applyChange) {
  const uiBefore = { hoveredHeatPartIndex: state.hoveredHeatPartIndex };
  applyChange();
  const after = captureBlueprintEditSnapshot(state);
  if (blueprintSnapshotsEqual(before, after)) {
    restoreNoOpPhysicalEditUiState(uiBefore);
    refreshBlueprintUndoControl();
    return false;
  }
  pushBlueprintEditSnapshot(before);
  refreshAfterPhysicalEdit();
  return true;
}

export function clearPhysicalBlueprintHistory() {
  clearBlueprintEditHistory();
  refreshBlueprintUndoControl();
}

export function undoBlueprintEdit() {
  if (!canUndoBlueprintEdit()) return false;
  const restored = popBlueprintEditUndo();
  if (!restored) return false;
  invalidateHeatAnalysisCache();
  clearHeatInspectionState();
  persistCurrentEditorDesign();
  invalidatePresentation("blueprint-edit");
  if (blueprintEditUiHooks?.refresh) {
    blueprintEditUiHooks.refresh();
  } else {
    designerCoordinator?.renderBuildGrid();
    designerCoordinator?.renderLocalStats();
    renderPartInspector();
    renderSavedDesigns();
    refreshBlueprintUndoControl();
  }
  return true;
}

export function editCell(x, y) {
  const existing = findPartAt(x, y);
  if (!state.selectedPart) {
    state.selectedCell = existing ? { x: existing.x, y: existing.y } : null;
    designerCoordinator?.renderBuildGrid();
    return;
  }
  if (existing?.type === "core") return;

  const candidate = createPlacementCandidate({
    grid: { x, y },
    componentType: state.selectedPart,
    rotation: state.previewRotation || 0,
    flipped: state.previewFlipped === true,
    design: state.design,
    catalogue: PART_STATS
  });

  state.selectedCell = { x: candidate.part?.x ?? x, y: candidate.part?.y ?? y };

  if (existing?.type === state.selectedPart) {
    if (isRotatablePart(existing.type)) rotateCell(existing.x, existing.y);
    return;
  }

  if (!candidate.ok) {
    notify.error(candidate.message);
    return;
  }

  const before = captureBlueprintEditSnapshot(state);
  commitPhysicalEdit(before, () => {
    state.design = candidate.nextDesign;
  });
  // Placing does not reset the orientation: the next copy of this part comes out
  // the same way round.
  rememberPartTransform(candidate.part.type, candidate.normalizedRotation, candidate.normalizedFlipped);
}

export function rotateCell(x, y) {
  const part = state.design.find((candidate) => candidate.x === x && candidate.y === y);
  if (!part || !isRotatablePart(part.type)) return false;

  const newRotation = nextRotation(part.rotation, PART_STATS[part.type]?.allowedRotations);
  const next = state.design.map((candidate) => candidate === part
    ? { ...candidate, rotation: newRotation }
    : candidate);

  if (isOutOfBounds(next)) {
    notify.error("Rotation goes outside build grid");
    return false;
  }
  if (isOverlapping(next)) {
    notify.error("Rotation overlaps another component");
    return false;
  }

  const before = captureBlueprintEditSnapshot(state);
  const changed = commitPhysicalEdit(before, () => {
    state.design = next;
    if (state.selectedPart === part.type) {
      state.previewRotation = newRotation;
    }
  });
  if (changed) rememberPartTransform(part.type, newRotation, part.flipped === true);
  return changed;
}

// Mirrors a placed component in place. The transformed footprint is rejected
// only when it leaves the grid or overlaps another component. Connectivity is
// allowed to be temporarily invalid while the blueprint is being edited.
export function flipCell(x, y) {
  const part = state.design.find((candidate) => candidate.x === x && candidate.y === y);
  if (!part || !isFlippablePart(part.type)) return false;

  const newFlipped = part.flipped !== true;
  const flippedPart = newFlipped
    ? { ...part, flipped: true }
    : (() => { const { flipped, ...rest } = part; return rest; })();
  const next = state.design.map((candidate) => candidate === part ? flippedPart : candidate);

  if (isOutOfBounds(next)) {
    notify.error("Mirrored placement goes outside build grid");
    return false;
  }
  if (isOverlapping(next)) {
    notify.error("Mirrored placement overlaps another component");
    return false;
  }

  const before = captureBlueprintEditSnapshot(state);
  const changed = commitPhysicalEdit(before, () => {
    state.design = next;
    if (state.selectedPart === part.type) {
      state.previewFlipped = newFlipped;
    }
  });
  if (changed) rememberPartTransform(part.type, part.rotation || 0, newFlipped);
  return changed;
}

export function rotateFocusedPart() {
  if (!isBlueprintRotationMode()) return;
  const cell = state.hoveredCell || state.selectedCell;
  const part = cell ? findPartAt(cell.x, cell.y) : null;
  if (part && isRotatablePart(part.type)) {
    rotateCell(part.x, part.y);
  } else if (state.selectedPart && isRotatablePart(state.selectedPart)) {
    state.previewRotation = nextRotation(state.previewRotation || 0, PART_STATS[state.selectedPart]?.allowedRotations);
    rememberPartTransform(state.selectedPart, state.previewRotation, state.previewFlipped === true);
    renderHoverPreview();
    refreshRotationIndicator();
  }
}

// F: mirror the hovered/selected placed component, or the pending placement when
// the cursor is not over one. A component that is not flippable is left alone :
// no error, no toast.
export function flipFocusedPart() {
  if (!isBlueprintRotationMode()) return false;
  const cell = state.hoveredCell || state.selectedCell;
  const part = cell ? findPartAt(cell.x, cell.y) : null;
  if (part && isFlippablePart(part.type)) return flipCell(part.x, part.y);
  if (part) return false; // hovering a component that cannot be mirrored
  if (!state.selectedPart || !isFlippablePart(state.selectedPart)) return false;
  state.previewFlipped = state.previewFlipped !== true;
  rememberPartTransform(state.selectedPart, state.previewRotation || 0, state.previewFlipped);
  renderHoverPreview();
  refreshRotationIndicator();
  return true;
}

export function removeCell(x, y) {
  if (!isBlueprintRemovalMode()) return false;
  const existing = findPartAt(x, y);
  if (!existing || existing.type === "core") return false;
  const next = state.design.filter((part) => part !== existing);
  const snapshot = captureBlueprintEditSnapshot(state);
  return commitPhysicalEdit(snapshot, () => {
    state.design = next;
  });
}


export function resetDesign() {
  const before = captureBlueprintEditSnapshot(state);
  commitPhysicalEdit(before, () => {
    state.design = defaultDesign();
    clearHeatInspectionState();
    state.loadedEditorBlueprintId = null;
    refreshLoadedBlueprintPresentation();
  });
}

export function clearDesign() {
  const before = captureBlueprintEditSnapshot(state);
  return commitPhysicalEdit(before, () => {
    const existingCore = state.design.find((part) => part.type === "core");
    const fallbackCore = defaultDesign().find((part) => part.type === "core");
    state.design = [{ ...(existingCore || fallbackCore) }];
    clearHeatInspectionState();
    state.loadedEditorBlueprintId = null;
    refreshLoadedBlueprintPresentation();
  });
}

export function requestResetDesign() {
  const modules = defaultDesign();
  const target = captureBlueprintEditSnapshot({ ...state, design: modules, loadedEditorBlueprintId: null });
  if (blueprintSnapshotsEqual(captureBlueprintEditSnapshot(state), target)) return false;
  openBlueprintDestructiveConfirm("reset");
  return true;
}

export function requestClearDesign() {
  return clearDesign();
}

function openBlueprintDestructiveConfirm(action) {
  state.pendingBlueprintDestructiveAction = action;
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  state.blueprintModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = action === "reset" ? "Reset to the starter ship?" : "Clear all components?";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = action === "reset" ? "Your current component layout will be replaced. You can Undo this afterward." : "Your current component layout will be removed. You can Undo this afterward.";
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = action === "reset" ? "Reset Ship" : "Clear All";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

export function handleBlueprintConfirmModalAction() {
  const action = state.pendingBlueprintDestructiveAction;
  if (!action) return false;
  state.pendingBlueprintDestructiveAction = null;
  if (dom.confirmModal) dom.confirmModal.hidden = true;
  if (action === "reset") resetDesign();
  else clearDesign();
  state.blueprintModalReturnFocus?.focus?.();
  state.blueprintModalReturnFocus = null;
  return true;
}

export function closeBlueprintConfirmModalIfPending() {
  if (!state.pendingBlueprintDestructiveAction) return false;
  state.pendingBlueprintDestructiveAction = null;
  if (dom.confirmModal) dom.confirmModal.hidden = true;
  state.blueprintModalReturnFocus?.focus?.();
  state.blueprintModalReturnFocus = null;
  return true;
}

export function configureSelectedDroneBay(value) {
  const cell = state.selectedCell || state.hoveredCell;
  const part = cell ? findPartAt(cell.x, cell.y) : null;
  const droneType = globalThis.DroneBayRules?.normalizeDroneType(value);
  if (!part || part.type !== "droneBay" || !droneType || part.droneType === droneType) return false;
  const before = captureBlueprintEditSnapshot(state);
  return commitPhysicalEdit(before, () => {
    state.design = state.design.map((candidate) => candidate === part ? { ...candidate, droneType } : candidate);
  });
}
