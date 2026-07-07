import { dom, state, clearRoomState, clearMatchPanels, openMainMenu, showMenuNotice } from "./dom.js";
import { send, setConnectionStatus, updateLobbyState, forgetActiveRoom, renderSavedDesigns, updateEconomyUi, renderPurchaseBar } from "./purchaseUi.js";


export function restartMatch() {
  send({ type: "restart" });
}

export function closeLobby() {
  setEndGameActionState(true);
  send({ type: "closeLobby" });
  forgetActiveRoom();
  returnToMainMenu("Closing lobby", "warning");
}

export function leaveLobby() {
  if (!state.room) {
    openMainMenu();
    return;
  }
  send({ type: "leaveLobby" });
  forgetActiveRoom();
  returnToMainMenu("Left lobby", "warning");
}

export function setEndGameActionState(disabled) {
  if (dom.restartButton) dom.restartButton.disabled = disabled;
  if (dom.endCloseButton) dom.endCloseButton.disabled = disabled;
  if (dom.endLeaveButton) dom.endLeaveButton.disabled = disabled;
}

export function returnToMainMenu(message = "", tone = "warning") {
  clearRoomState();
  setConnectionStatus(state.socket?.readyState === WebSocket.OPEN ? "online" : "offline", state.socket?.readyState === WebSocket.OPEN ? "Dock linked" : "Offline dock");
  updateLobbyState();
  updateEconomyUi();
  renderSavedDesigns();
  renderPurchaseBar();
  clearMatchPanels();
  openMainMenu();
  if (message) showMenuNotice(message, tone);
}