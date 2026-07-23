import { dom } from "./dom.js";

let closeReturnFocus = null;

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

export async function requestCloseBlueprintDesigner() {
  const { wiringReadinessWarning } = await import("./wiringUi.js");
  const warning = wiringReadinessWarning();
  if (!warning) {
    closeBlueprintDesigner();
    return true;
  }

  closeReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : dom.closeBlueprintDesignerButton;
  dom.confirmModal.dataset.intent = "wiring-warning";
  dom.confirmModal.dataset.pendingDesignerClose = "true";
  dom.confirmModalTitle.textContent = warning.kind === "no-wiring"
    ? "Close with no wiring?"
    : "Close with incomplete wiring?";
  dom.confirmModalMessage.textContent = `${warning.message} Close the designer anyway?`;
  dom.confirmAcceptButton.textContent = "Close Anyway";
  dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
  return false;
}

export function confirmPendingDesignerClose() {
  if (dom.confirmModal?.dataset.pendingDesignerClose !== "true") return false;
  delete dom.confirmModal.dataset.pendingDesignerClose;
  delete dom.confirmModal.dataset.intent;
  dom.confirmModal.hidden = true;
  closeReturnFocus = null;
  closeBlueprintDesigner();
  return true;
}

export function cancelPendingDesignerClose() {
  if (dom.confirmModal?.dataset.pendingDesignerClose !== "true") return false;
  delete dom.confirmModal.dataset.pendingDesignerClose;
  delete dom.confirmModal.dataset.intent;
  dom.confirmModal.hidden = true;
  closeReturnFocus?.focus?.();
  closeReturnFocus = null;
  return true;
}
