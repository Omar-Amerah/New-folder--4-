import { dom } from "./dom.js";
import { state } from "../state.js";

let closeReturnFocus = null;
const BLUEPRINT_SCREEN_ROOM_KEY = "modular-fleet-blueprint-screen-room-v1";
// Set when the designer was opened over the lobby panel, so closing it puts the
// player back where they were instead of dropping them onto the empty arena
// behind. Every menu screen shares one z-index, so the two cannot be stacked.
let reopenLobbyOnClose = false;

function getSessionStorage() {
  try {
    if (typeof sessionStorage === "undefined" || !sessionStorage) return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function rememberLobbyDesigner(roomCode) {
  const storage = getSessionStorage();
  const room = String(roomCode || "").trim().toUpperCase().slice(0, 8);
  if (!storage || !room) return;
  try { storage.setItem(BLUEPRINT_SCREEN_ROOM_KEY, room); } catch { /* unavailable */ }
}

function forgetLobbyDesigner() {
  const storage = getSessionStorage();
  if (!storage) return;
  try { storage.removeItem(BLUEPRINT_SCREEN_ROOM_KEY); } catch { /* unavailable */ }
}

function wasLobbyDesignerOpen(roomCode) {
  const storage = getSessionStorage();
  const room = String(roomCode || "").trim().toUpperCase().slice(0, 8);
  if (!storage || !room) return false;
  try {
    return storage.getItem(BLUEPRINT_SCREEN_ROOM_KEY) === room;
  } catch {
    return false;
  }
}

export function openBlueprintDesigner({ fromLobby = false } = {}) {
  const openedFromLobby = fromLobby || state.phase === "lobby";
  if (openedFromLobby) {
    reopenLobbyOnClose = true;
    rememberLobbyDesigner(state.room);
    import("./lobbyUi.js").then((mod) => mod.hideMenuScreens?.());
  }
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = false;
  }
  // Anchor dirty tracking to what the editor looked like on open, so a design
  // that no saved blueprint backs only counts as dirty once it is actually edited.
  import("./savedBlueprintsUi.js").then((mod) => {
    mod.captureEditorBaseline?.();
    mod.refreshLoadedBlueprintPresentation?.();
  });
  import("./designerUi.js").then((mod) => mod.refreshBlueprintUndoControl?.());
}

export function openBlueprintDesignerFromLobby() {
  openBlueprintDesigner({ fromLobby: true });
}

export function closeBlueprintDesigner() {
  if (dom.blueprintDesignerScreen) {
    dom.blueprintDesignerScreen.hidden = true;
  }
  forgetLobbyDesigner();
  const returnToLobbyPanel = reopenLobbyOnClose;
  reopenLobbyOnClose = false;
  // Only while the room is still in the lobby: once the match has moved on, the
  // player wants the arena, not the panel they opened the designer from.
  if (returnToLobbyPanel && state.phase === "lobby") {
    import("./lobbyUi.js").then((mod) => mod.openLobbyManagement?.());
  }
}

export function restoreBlueprintDesignerAfterLobbyRejoin(roomCode) {
  if (!wasLobbyDesignerOpen(roomCode)) return false;
  openBlueprintDesigner({ fromLobby: true });
  return true;
}

export async function requestCloseBlueprintDesigner() {
  const { isEditorDirty, isLoadedBlueprintDirty } = await import("./savedBlueprintsUi.js");
  // Only a loaded blueprint can lose work on close: an unbacked design is
  // written to localStorage on every edit and comes back as-is next time.
  if (isLoadedBlueprintDirty()) {
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

  // Nothing was touched since the designer opened : never interrupt the close.
  if (!isEditorDirty()) {
    closeBlueprintDesigner();
    return true;
  }

  closeBlueprintDesigner();
  return true;
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
