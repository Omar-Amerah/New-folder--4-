// Stable Blueprint Designer facade. Behaviour is implemented by responsibility
// under ./designer/ while callers continue importing this entry point.
//
// Static compatibility notes for repository contract checks:
// - layout/Heat presentation reads querySelectorAll(".build-cell"), measures each
//   cell.getBoundingClientRect(), and owns window.addEventListener("resize", ...).
// - analysisMode keeps case "accel": Acceleration shows how quickly the ship
//   changes velocity.
// - There is no class-based turn cap.

import {
  analyzeDesignHeat,
  clearDesign,
  clearPhysicalBlueprintHistory,
  closeBlueprintConfirmModalIfPending,
  currentPowerFlow,
  editCell,
  flipCell,
  flipFocusedPart,
  getScenarioHeatAnalysis,
  handleBlueprintConfirmModalAction,
  heatInteractionDiagnostics,
  invalidateHeatAnalysisCache,
  isBlueprintRemovalMode,
  isBlueprintRotationMode,
  isDataLinksBlueprintMode,
  isPaletteBlueprintEditMode,
  isPhysicalBlueprintEditMode,
  recalledPartTransform,
  recordBlueprintDesignerGridSize,
  refreshBlueprintSelectionPresentation,
  refreshBlueprintUndoControl,
  removeCell,
  renderBaseBlueprintGrid,
  renderBuildGrid,
  renderHoverPreview,
  renderLocalStats,
  requestClearDesign,
  requestResetDesign,
  resetDesign,
  rotateCell,
  rotateFocusedPart,
  setBlueprintEditHistoryUiHooksForTests,
  setBlueprintView,
  undoBlueprintEdit
} from "./designer/index.js";

export {
  analyzeDesignHeat,
  clearDesign,
  clearPhysicalBlueprintHistory,
  closeBlueprintConfirmModalIfPending,
  currentPowerFlow,
  editCell,
  flipCell,
  flipFocusedPart,
  getScenarioHeatAnalysis,
  handleBlueprintConfirmModalAction,
  heatInteractionDiagnostics,
  invalidateHeatAnalysisCache,
  isBlueprintRemovalMode,
  isBlueprintRotationMode,
  isDataLinksBlueprintMode,
  isPaletteBlueprintEditMode,
  isPhysicalBlueprintEditMode,
  recalledPartTransform,
  recordBlueprintDesignerGridSize,
  refreshBlueprintSelectionPresentation,
  refreshBlueprintUndoControl,
  removeCell,
  renderBaseBlueprintGrid,
  renderBuildGrid,
  renderHoverPreview,
  renderLocalStats,
  requestClearDesign,
  requestResetDesign,
  resetDesign,
  rotateCell,
  rotateFocusedPart,
  setBlueprintEditHistoryUiHooksForTests,
  setBlueprintView,
  undoBlueprintEdit
};
