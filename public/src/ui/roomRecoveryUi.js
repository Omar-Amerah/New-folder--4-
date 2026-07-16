import { dom } from "./dom.js";
import { LOCAL_ACTIVE_ROOM_KEY } from "../constants.js";
import { getStorage } from "../localPreferences.js";
import { forgetRecoverableRoom } from "../storageRecovery.js";

export function getRecoverableRoom() {
  const storage = getStorage();
  try { return String(storage?.getItem(LOCAL_ACTIVE_ROOM_KEY) || "").toUpperCase().slice(0, 8); } catch { return ""; }
}
export function renderRecoveryCard() {
  if (!dom.roomRecoveryCard) return;
  const room = getRecoverableRoom();
  dom.roomRecoveryCard.hidden = !room;
  if (dom.roomRecoveryCode) dom.roomRecoveryCode.textContent = room || "----";
  if (dom.roomRecoveryStatus) dom.roomRecoveryStatus.textContent = room ? "Saved room can be resumed." : "";
}
export function bindRoomRecoveryCard() {
  dom.resumeRoomButton?.addEventListener("click", async () => { const room = getRecoverableRoom(); if (room) (await import("./lobbyUi.js")).joinRoom(room); });
  dom.forgetRoomButton?.addEventListener("click", () => { if (confirm("Forget this recoverable room?")) { forgetRecoverableRoom(); renderRecoveryCard(); } });
  renderRecoveryCard();
}
