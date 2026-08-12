import { state } from "../../state.js";
import {
  dataLinksHintText,
  initDataLinksUi,
  refreshDataLinksControls,
  refreshDataLinksPresentation,
  renderDataAnalysisPanel,
  renderDataLinksOverlay,
  resetDataLinksUiState
} from "../dataLinksUi.js";

export function isDataLinksBlueprintMode(mode = state.blueprintView) {
  return mode === "dataLinks";
}

export {
  dataLinksHintText,
  initDataLinksUi,
  refreshDataLinksControls,
  refreshDataLinksPresentation,
  renderDataAnalysisPanel,
  renderDataLinksOverlay,
  resetDataLinksUiState
} from "../dataLinksUi.js";
