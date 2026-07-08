import { dom } from "./dom.js";

export function openBlueprintDesigner() {
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = false;
  }
}

export function closeBlueprintDesigner() {
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = true;
  }
}
