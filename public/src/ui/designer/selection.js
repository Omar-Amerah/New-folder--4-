import { dom } from "../dom.js";
import { state } from "../../state.js";
import { renderHoverPreview, isBlueprintRemovalMode, isPhysicalBlueprintEditMode } from "./buildMode.js";
import { configureSelectedDroneBay, editCell, removeCell, rotateCell } from "./blueprintActions.js";
import {
  initDataLinksUi,
  isDataLinksBlueprintMode,
  refreshDataLinksPresentation,
  renderDataLinksOverlay
} from "./dataLinksMode.js";
import { gridCellFromPointer, findPartAt } from "./layout.js";
import { updateHoveredHeatPart } from "./heatMode.js";

export function ensureBlueprintGridEventHandlers() {
  initDataLinksUi();
  if (dom.grid.dataset.hasDelegatedClick) return;

  dom.grid.addEventListener("click", (event) => {
    if (isDataLinksBlueprintMode()) {
      const cell = event.target.closest(".build-cell");
      if (!cell || !dom.grid.contains(cell)) return;
      const pointed = gridCellFromPointer(event.clientX, event.clientY);
      const x = pointed?.x ?? Number(cell.dataset.x);
      const y = pointed?.y ?? Number(cell.dataset.y);
      state.selectedCell = { x, y };
      refreshDataLinksPresentation();
      return;
    }
    const cell = event.target.closest(".build-cell");
    if (!cell || !dom.grid.contains(cell)) return;
    const pointed = gridCellFromPointer(event.clientX, event.clientY);
    const x = pointed?.x ?? Number(cell.dataset.x);
    const y = pointed?.y ?? Number(cell.dataset.y);
    if (event.button !== undefined && event.button !== 0) return;
    if (isPhysicalBlueprintEditMode()) editCell(x, y);
  });
  // Hover preview is delegated so cells are never rebuilt mid-click:
  // rebuilding on hover destroyed the mousedown target, so no click event fired.
  dom.grid.addEventListener("mousemove", (event) => {
    const cell = event.target.closest(".build-cell");
    if (!cell || !dom.grid.contains(cell)) return;
    // A multi-cell component is one spanning DOM button, so its dataset only
    // contains the component anchor. Resolve the physical grid square under
    // the pointer so the right/left/top/bottom sections all behave normally.
    const pointed = gridCellFromPointer(event.clientX, event.clientY);
    const x = pointed?.x ?? Number(cell.dataset.x);
    const y = pointed?.y ?? Number(cell.dataset.y);
    if (state.hoveredCell?.x === x && state.hoveredCell?.y === y) return;
    state.hoveredCell = { x, y };
    if (isDataLinksBlueprintMode()) {
      renderDataLinksOverlay();
      renderHoverPreview();
      return;
    }
    updateHoveredHeatPart(x, y);
    renderHoverPreview();
  });
  dom.grid.addEventListener("mouseleave", () => {
    state.hoveredCell = null;
    if (isDataLinksBlueprintMode()) {
      renderDataLinksOverlay();
      return;
    }
    updateHoveredHeatPart(null, null);
    renderHoverPreview();
  });
  dom.grid.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cell = event.target.closest(".build-cell");
    if (!cell || !dom.grid.contains(cell)) return;
    if (!isBlueprintRemovalMode()) return;
    const pointed = gridCellFromPointer(event.clientX, event.clientY);
    const x = pointed?.x ?? Number(cell.dataset.x);
    const y = pointed?.y ?? Number(cell.dataset.y);
    if (!findPartAt(x, y)) return;
    removeCell(x, y);
  });
  document.addEventListener("blueprint-drone-config", (event) => { configureSelectedDroneBay(event.detail?.droneType); });
  document.addEventListener("blueprint-component-action", (event) => {
    const cell = state.selectedCell || state.hoveredCell;
    const part = cell ? findPartAt(cell.x, cell.y) : null;
    if (!part) return;
    if (event.detail?.action === "rotate") rotateCell(part.x, part.y);
    if (event.detail?.action === "remove") removeCell(part.x, part.y);
  });
  dom.grid.dataset.hasDelegatedClick = "true";
}
