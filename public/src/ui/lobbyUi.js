import { LOCAL_NAME_KEY } from "../constants.js";
import { dom, state, showMenuNotice, clearMenuNotice } from "./dom.js";
import { returnToMainMenu } from "./endGameUi.js";
import { send, setConnectionStatus, updateLobbyState, handleServerMessage } from "./purchaseUi.js";
import { getSocketUrl, teamValue } from "./scoreboardUi.js";


export function createGame() {
  dom.roomCode.value = "";
  clearMenuNotice();
  joinRoom("");
}

export function joinExistingGame() {
  const code = dom.roomCode.value.trim().toUpperCase();
  clearMenuNotice();
  if (!code) {
    showMenuNotice("Enter a game code or click Create", "warning");
    dom.roomCode.focus();
    return;
  }
  joinRoom(code);
}

export function joinRoom(roomCode = "") {
  clearMenuNotice();
  if (state.socket) state.socket.close();
  state.room = "";
  state.snapshot = null;
  state.map = null;
  state.phase = "offline";
  state.adminId = null;
  state.selectedShipIds.clear();
  dom.roomLabel.textContent = "----";
  dom.roomCode.value = "";
  dom.currentRoomCode.textContent = "----";
  dom.currentRoomCard.hidden = true;

  const socket = new WebSocket(getSocketUrl());
  state.socket = socket;
  setConnectionStatus("connecting", "Connecting");
  updateLobbyState();

  socket.addEventListener("open", () => {
    if (socket !== state.socket) return;
    const name = dom.pilotName.value.trim();
    localStorage.setItem(LOCAL_NAME_KEY, name);
    send({ type: "join", name, team: teamValue(), room: roomCode });
    setConnectionStatus("online", "Dock linked");
    updateLobbyState();
  });

  socket.addEventListener("message", (event) => {
    if (socket !== state.socket) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    handleServerMessage(message);
  });

  socket.addEventListener("close", () => {
    if (socket !== state.socket) return;
    returnToMainMenu(state.room ? "Disconnected from lobby" : "", "warning");
  });

  socket.addEventListener("error", () => {
    if (socket !== state.socket) return;
    setConnectionStatus("error", "Link error");
    updateLobbyState();
  });
}