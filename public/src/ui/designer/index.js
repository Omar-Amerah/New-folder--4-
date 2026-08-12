// Coordinates the Blueprint Designer's responsibility-specific controllers.
// Authoritative Designer state remains in state.js; these modules only consume it.

import { state } from "../../state.js";
import { renderPartInspector } from "../partInspectorUi.js";
import {
  isDataLinksBlueprintMode,
  refreshDataLinksPresentation,
  renderDataLinksOverlay,
  resetDataLinksUiState
} from "./dataLinksMode.js";
import {
  isPhysicalBlueprintEditMode,
  refreshBlueprintDiscoverabilityUi,
  renderHoverPreview
} from "./buildMode.js";
import {
  clearHeatInspectionState,
  clearHeatPresentation,
  refreshHeatPresentationSafely,
  suppressHeatGridNativeTooltips
} from "./heatMode.js";
import {
  recordBlueprintDesignerGridSize,
  renderBaseBlueprintGridLayout
} from "./layout.js";
import { renderLocalStats } from "./analysisMode.js";
import { configureBlueprintActions, refreshBlueprintUndoControl } from "./blueprintActions.js";
import { ensureBlueprintGridEventHandlers } from "./selection.js";
import { ensureBlueprintToolbarEventHandlers, refreshBlueprintControls } from "./toolbar.js";

export { analyzeDesignHeat } from "../../design/thermalAnalysis.js";
export { currentPowerFlow, renderLocalStats } from "./analysisMode.js";
export {
  isBlueprintRemovalMode,
  isBlueprintRotationMode,
  isPaletteBlueprintEditMode,
  isPhysicalBlueprintEditMode,
  recalledPartTransform,
  refreshBlueprintSelectionPresentation,
  renderHoverPreview
} from "./buildMode.js";
export { isDataLinksBlueprintMode } from "./dataLinksMode.js";
export {
  clearPhysicalBlueprintHistory,
  clearDesign,
  closeBlueprintConfirmModalIfPending,
  editCell,
  flipCell,
  flipFocusedPart,
  handleBlueprintConfirmModalAction,
  refreshBlueprintUndoControl,
  removeCell,
  requestClearDesign,
  requestResetDesign,
  resetDesign,
  rotateCell,
  rotateFocusedPart,
  setBlueprintEditHistoryUiHooksForTests,
  undoBlueprintEdit
} from "./blueprintActions.js";
export {
  getScenarioHeatAnalysis,
  heatInteractionDiagnostics,
  invalidateHeatAnalysisCache
} from "./heatMode.js";
export { recordBlueprintDesignerGridSize } from "./layout.js";

export function renderBaseBlueprintGrid() {
  clearHeatInspectionState();
  renderBaseBlueprintGridLayout();
  ensureBlueprintGridEventHandlers();
  ensureBlueprintToolbarEventHandlers({ setBlueprintView, renderLocalStats });
}

export function renderBuildGrid() {
  renderBaseBlueprintGrid();
  if (state.blueprintView === "heat") {
    suppressHeatGridNativeTooltips();
    refreshHeatPresentationSafely();
  } else if (state.blueprintView === "dataLinks") {
    clearHeatPresentation();
    refreshDataLinksPresentation();
  } else {
    clearHeatPresentation();
  }
  // The Data Links overlay accepts pointer input while active, so every other
  // view must tear it down or it keeps swallowing grid clicks.
  if (state.blueprintView !== "dataLinks") renderDataLinksOverlay();
  refreshBlueprintControls();
  refreshBlueprintDiscoverabilityUi();
  refreshBlueprintUndoControl();
  renderHoverPreview();
  // The inspector's "Predicted in this design" rows track the live design and
  // the selected thermal scenario, so refresh it alongside the grid.
  renderPartInspector();
}

export function setBlueprintView(view) {
  const previousView = state.blueprintView;
  state.blueprintView = view === "heat" ? "heat" : view === "dataLinks" ? "dataLinks" : "build";
  if (previousView === state.blueprintView) {
    // `changed: false` keeps the inspector where the player left it; only a real
    // view switch moves them to that view's readout.
    refreshBlueprintControls();
    document.dispatchEvent?.(new CustomEvent("blueprint-mode-change", { detail: { mode: state.blueprintView, changed: false } }));
    return;
  }
  // Entering or leaving Data Links drops any armed source or selected link;
  // component indices are only meaningful against the design that produced them.
  if (previousView === "dataLinks" || state.blueprintView === "dataLinks") resetDataLinksUiState();
  refreshBlueprintControls();
  document.dispatchEvent?.(new CustomEvent("blueprint-mode-change", { detail: { mode: state.blueprintView, changed: true } }));
  renderHoverPreview();

  if (state.blueprintView === "heat") {
    suppressHeatGridNativeTooltips();
    refreshHeatPresentationSafely();
  } else {
    clearHeatInspectionState();
    clearHeatPresentation();
  }

  // Data Links owns an input-accepting overlay and dims the grid, so entering
  // and leaving it must be symmetric with Heat above. Switching view
  // does not necessarily re-render the grid, so this cannot live there.
  if (state.blueprintView === "dataLinks") {
    refreshDataLinksPresentation();
  } else {
    renderDataLinksOverlay();
  }
}

configureBlueprintActions({ renderBuildGrid, renderLocalStats });

globalThis.recordBlueprintDesignerGridSize = recordBlueprintDesignerGridSize;
