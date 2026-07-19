import { dom } from "./dom.js";

export function openBlueprintDesigner() {
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = false;
  }
  import("./designerUi.js").then((mod) => mod.refreshBlueprintUndoControl?.());
}

export function closeBlueprintDesigner() {
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = true;
  }
}
