import { dom } from "./dom.js";
import { state } from "../state.js";

let closeReturnFocus = null;
// Set when the designer was opened over the lobby panel, so closing it puts the
// player back where they were instead of dropping them onto the empty arena
// behind. Every menu screen shares one z-index, so the two cannot be stacked.
let reopenLobbyOnClose = false;

export function openBlueprintDesigner({ fromLobby = false } = {}) {
  if (fromLobby) {
    reopenLobbyOnClose = true;
    import("./lobbyUi.js").then((mod) => mod.hideMenuScreens?.());
  }
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = false;
  }
  import("./designerUi.js").then((mod) => mod.refreshBlueprintUndoControl?.());
}

export function openBlueprintDesignerFromLobby() {
  openBlueprintDesigner({ fromLobby: true });
}

export function closeBlueprintDesigner() {
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = true;
  }
  const returnToLobbyPanel = reopenLobbyOnClose;
  reopenLobbyOnClose = false;
  // Only while the room is still in the lobby: once the match has moved on, the
  // player wants the arena, not the panel they opened the designer from.
  if (returnToLobbyPanel && state.phase === "lobby") {
    import("./lobbyUi.js").then((mod) => mod.openLobbyManagement?.());
  }
}

export async function requestCloseBlueprintDesigner() {
  const { isEditorDirty } = await import("./savedBlueprintsUi.js");
  if (isEditorDirty()) {
    const { state } = await import("../state.js");
    closeReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : dom.closeBlueprintDesignerButton;
    state.pendingDirtyAction = closeBlueprintDesigner;
    state.pendingDeleteDesignId = null;
    state.pendingKickTargetId = null;
    state.pendingBlueprintDestructiveAction = null;
    state.pendingServerLeaveAction = null;
    if (dom.confirmModal) dom.confirmModal.dataset.intent = "dirty-editor";
    if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Unsaved Changes";
    if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = "Your current design has unsaved changes. What would you like to do?";
    if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Save Changes";
    if (dom.confirmDiscardButton) {
      dom.confirmDiscardButton.hidden = false;
      dom.confirmDiscardButton.textContent = "Continue Anyway";
    }
    if (dom.confirmModal) dom.confirmModal.hidden = false;
    dom.confirmCancelButton?.focus?.();
    return false;
  }

  const { state } = await import("../state.js");
  if (state.loadedEditorBlueprintId) {
    closeBlueprintDesigner();
    return true;
  }

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
