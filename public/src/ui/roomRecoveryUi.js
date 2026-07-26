import { dom } from "./dom.js";
import { LOCAL_ACTIVE_ROOM_KEY } from "../constants.js";
import { getStorage } from "../localPreferences.js";
import { forgetRecoverableRoom } from "../storageRecovery.js";
import { state } from "../state.js";

export function getRecoverableRoom() {
  const storage = getStorage();
  try { return String(storage?.getItem(LOCAL_ACTIVE_ROOM_KEY) || "").toUpperCase().slice(0, 8); } catch { return ""; }
}
export function renderRecoveryCard() {
  if (!dom.roomRecoveryCard) return;
  const room = getRecoverableRoom();
  const inServer = Boolean(state.room) && (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING || state.phase !== "offline");
  dom.roomRecoveryCard.hidden = !room || inServer;
  if (dom.roomRecoveryCode) dom.roomRecoveryCode.textContent = room || "----";
  if (dom.roomRecoveryStatus) dom.roomRecoveryStatus.textContent = room ? "Saved room can be resumed." : "";
}
export function bindRoomRecoveryCard() {
  dom.resumeRoomButton?.addEventListener("click", async () => { const room = getRecoverableRoom(); if (room) (await import("./lobbyUi.js")).joinRoom(room); });
  dom.forgetRoomButton?.addEventListener("click", async () => {
    const room = getRecoverableRoom();
    const { openServerLeaveConfirmModal } = await import("./lobbyUi.js");
    openServerLeaveConfirmModal(() => {
      forgetRecoverableRoom();
      renderRecoveryCard();
    }, "Forget room?", `Remove saved recoverable room ${room || ""}?`, "Forget Room");
  });
  renderRecoveryCard();
}
