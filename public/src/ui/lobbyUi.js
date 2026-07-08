// Handles lobby screens, player wing choices, starting/leaving, rules updates, and host controls.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { send, getSocketUrl, getConfiguredServerUrl, connect } from "../network.js";
import { showToast } from "./toastUi.js";
import { renderSavedDesigns } from "./savedBlueprintsUi.js";
import { updateEconomyUi, renderPurchaseBar } from "./purchaseUi.js";
import { renderPalette } from "./partPaletteUi.js";
import { renderPartInspector } from "./partInspectorUi.js";
import { renderBuildGrid, renderLocalStats } from "./designerUi.js";
import { escapeHtml } from "../shared/formatting.js";
import { normalizeDesign } from "../design/blueprintStorage.js";
import { computeStats } from "../design/componentStats.js";
import { LOCAL_NAME_KEY, LOCAL_TEAM_KEY, LOCAL_SERVER_KEY, LOCAL_ACTIVE_ROOM_KEY, LOCAL_FORMATION_KEY, syncUrlParams } from "../constants.js";


export function isAdmin() {
  return state.adminId === state.myId || Boolean(state.mine?.isAdmin);
}

export function updateLobbyState() {
  const connected = state.socket?.readyState === WebSocket.OPEN && Boolean(state.room);
  const connecting = state.socket?.readyState === WebSocket.CONNECTING;
  const playerCount = state.snapshot?.players?.length || 0;
  const phase = state.snapshot?.phase || state.phase;
  const admin = isAdmin();
  dom.roomState.textContent = connected ? `${phaseLabel(phase)} | ${playerCount} in room` : connecting ? "Connecting" : "Not joined";
  dom.createButton.disabled = connecting;
  dom.joinButton.disabled = connecting;
  if (dom.mainMenuCloseButton) dom.mainMenuCloseButton.disabled = !connected;
  dom.copyButton.disabled = !state.room;
  dom.botButton.disabled = !connected || !admin || phase !== "lobby";
  if (dom.leaveLobbyButton) {
    dom.leaveLobbyButton.hidden = !connected || admin;
    dom.leaveLobbyButton.disabled = !connected || admin;
  }
  updateTeamChoiceControls(connected, phase);
  dom.adminControls.hidden = !connected || !admin || phase === "active";
  dom.startDesignButton.disabled = !connected || !admin || phase !== "lobby" || playerCount === 0;
  dom.closeLobbyButton.disabled = !connected || !admin || phase === "active";
  dom.currentRoomCard.hidden = !state.room;
  dom.currentRoomCode.textContent = state.room || "----";
  updateRulesControls(connected, admin, phase, playerCount);
  updatePhaseSteps(phase);
  updatePhaseDetail(phase);
  renderPlayerList();
}

export function updateRulesControls(connected, admin, phase, playerCount) {
  const editable = connected && admin && phase === "lobby";
  const rules = state.snapshot?.rules || state.rules || {};
  state.rules = { ...state.rules, ...rules };
  if (dom.rulesStatus) {
    dom.rulesStatus.textContent = editable
      ? "Host controls"
      : admin && connected ? "Locked after lobby" : "Host only";
  }
  setRuleControlValue(dom.gameModeSelect, rules.gameMode || state.rules.gameMode || "teams");
  setRuleControlValue(dom.startingMoneyInput, rules.startingMoney ?? state.rules.startingMoney);
  setRuleControlValue(dom.maxPlayersInput, rules.maxPlayers ?? state.rules.maxPlayers);
  setRuleControlValue(dom.mapSizeSelect, rules.mapSize || state.rules.mapSize || "auto");
  for (const element of [dom.gameModeSelect, dom.startingMoneyInput, dom.maxPlayersInput, dom.mapSizeSelect]) {
    if (element) element.disabled = !editable;
  }
  if (dom.maxPlayersInput) {
    dom.maxPlayersInput.min = String(Math.max(2, playerCount || 1));
  }
}

export function updateTeamChoiceControls(connected, phase) {
  const mode = state.rules?.gameMode || "teams";
  const inLobby = connected && phase === "lobby";
  const canChoose = inLobby && mode === "teams";
  const mine = state.mine;
  if (dom.teamChoiceCard) {
    dom.teamChoiceCard.hidden = !connected || mode === "solo";
    dom.teamChoiceCard.classList?.toggle?.("solo", mode === "solo");
  }
  if (dom.teamSelect) {
    if (mine?.team === "blue" || mine?.team === "red") dom.teamSelect.value = mine.team;
    dom.teamSelect.disabled = !canChoose;
  }
  if (dom.teamChoiceStatus) {
    dom.teamChoiceStatus.textContent = mode === "solo"
      ? "Solo mode: every player is an opponent"
      : canChoose ? "Choose before ship design" : "Locked after ship design starts";
  }
}

function setRuleControlValue(element, value) {
  if (!element || document.activeElement === element) return;
  element.value = String(value);
}

export function phaseLabel(phase) {
  if (phase === "lobby") return "Lobby";
  if (phase === "design") return "Ship design";
  if (phase === "active") return "Battle";
  if (phase === "ended") return "Ended";
  return "Offline";
}

export function updatePhaseSteps(phase) {
  const order = ["lobby", "design", "active", "ended"];
  const current = Math.max(0, order.indexOf(phase));
  const entries = [
    [dom.stepLobby, "lobby"],
    [dom.stepDesign, "design"],
    [dom.stepBattle, "active"],
    [dom.stepEnd, "ended"]
  ];
  for (const [element, key] of entries) {
    if (element) {
      const index = order.indexOf(key);
      element.className = index === current ? "active" : index < current ? "done" : "";
    }
  }
}

export function updatePhaseDetail(phase) {
  const players = state.snapshot?.players || [];
  const ready = players.filter((player) => player.ready).length;
  const mapName = state.snapshot?.map?.name;
  const size = state.snapshot?.mapSizeLabel;
  if (!state.room) {
    dom.phaseDetail.textContent = "Create or join a room to begin.";
  } else if (phase === "lobby") {
    const mapRule = (state.rules?.mapSize && state.rules.mapSize !== "auto")
      ? state.rules.mapSize
      : `${players.length || 1} player${players.length === 1 ? "" : "s"}`;
    const modeText = state.rules?.gameMode === "solo" ? "Solo mode" : "Teams mode";
    dom.phaseDetail.textContent = isAdmin()
      ? `Waiting room. ${modeText}. Add bots, share the code, then start ship design. Map size will use ${mapRule}.`
      : "Waiting for the room admin to start ship design.";
  } else if (phase === "design") {
    dom.phaseDetail.textContent = `${ready}/${players.length} ready. Edit your ship, then press Ready. ${size || "Map"}: ${mapName || "generated map"}.`;
  } else if (phase === "active") {
    dom.phaseDetail.textContent = `${size || "Map"}: ${mapName || "generated map"}. Capture relays, build ships, and fight.`;
  } else if (phase === "ended") {
    dom.phaseDetail.textContent = isAdmin() ? "Match ended. Choose Restart or Close lobby." : "Match ended. Waiting for the admin.";
  }
}

export function renderPlayerList() {
  if (!dom.playerList) return;
  const players = state.snapshot?.players || [];
  dom.playerList.textContent = "";
  if (!players.length) return;

  for (const player of players) {
    const row = document.createElement("div");
    row.className = `player-row${player.id === state.myId ? " mine" : ""}`;
    const canKick = isAdmin() && player.id !== state.myId && state.phase !== "active";
    const status = player.isAdmin ? "Admin" : player.ready ? "Ready" : state.phase === "design" ? "Designing" : player.isBot ? "Bot" : "Waiting";
    row.innerHTML = `
      <span class="score-color" style="background:${player.color}"></span>
      <div>
        <strong>${escapeHtml(player.name)}${player.id === state.myId ? " (you)" : ""}</strong>
        <span>${escapeHtml(state.rules?.gameMode === "solo" ? "No wing" : player.teamName || "Blue wing")} | ${status}</span>
      </div>
      ${canKick ? `<button type="button" data-kick="${escapeHtml(player.id)}">Kick</button>` : ""}
    `;
    dom.playerList.appendChild(row);
  }
}

export function createGame() {
  const name = String(dom.pilotName.value || "").trim().slice(0, 18);
  if (!name) {
    showMenuNotice("Name required to host", "error");
    return;
  }
  localStorage.setItem(LOCAL_NAME_KEY, name);
  localStorage.setItem(LOCAL_TEAM_KEY, teamValue());
  localStorage.setItem(LOCAL_FORMATION_KEY, dom.formationSelect.value);
  connect(getSocketUrl(), () => {
    send({ type: "join", name, room: "", team: teamValue() });
  });
}

export function joinExistingGame() {
  const room = String(dom.roomCode.value || "").trim().toUpperCase().slice(0, 8);
  if (!room) {
    showMenuNotice("Enter a room code", "error");
    return;
  }
  joinRoom(room);
}

export function joinRoom(roomCode = "") {
  const name = String(dom.pilotName.value || "").trim().slice(0, 18);
  if (!name) {
    showMenuNotice("Name required to join", "error");
    return;
  }
  localStorage.setItem(LOCAL_NAME_KEY, name);
  localStorage.setItem(LOCAL_TEAM_KEY, teamValue());
  localStorage.setItem(LOCAL_FORMATION_KEY, dom.formationSelect.value);
  connect(getSocketUrl(), () => {
    send({ type: "join", name, room: roomCode, team: teamValue() });
  });
}

export function deployDesign() {
  const stats = computeStats(state.design);
  const mine = state.mine;
  const isDesignStage = state.phase === "design";
  const ready = mine?.ready;

  if (isDesignStage && !ready) {
    send({ type: "deploy", design: state.design });
    send({ type: "ready" });
  } else if (state.phase === "active") {
    // If active, deployButton saves current blueprint
    import("./savedBlueprintsUi.js").then((mod) => {
      mod.saveCurrentDesign();
    });
  }
}

export function startDesign() {
  send({ type: "startDesign" });
}

export function restartMatch() {
  send({ type: "restart" });
}

export function closeLobby() {
  send({ type: "closeLobby" });
}

export function leaveLobby() {
  send({ type: "leaveLobby" });
}

export function setEndGameActionState(disabled) {
  for (const element of [dom.restartButton, dom.endCloseButton, dom.endLeaveButton]) {
    if (element) element.disabled = disabled;
  }
}

export function returnToMainMenu(message = "", tone = "warning") {
  clearRoomState();
  hideMenuScreens();
  openMainMenu();
  if (message) showMenuNotice(message, tone);
}

export function clearRoomState() {
  if (state.socket) {
    try {
      state.socket.close();
    } catch {
      // Ignore
    }
    state.socket = null;
  }
  state.room = "";
  state.myId = null;
  state.snapshot = null;
  state.mine = null;
  state.map = null;
  state.phase = "offline";
  state.adminId = null;
  state.selectedShipIds.clear();
  dom.roomCode.value = "";
  dom.currentRoomCode.textContent = "----";
  dom.currentRoomCard.hidden = true;
  dom.roomLabel.textContent = "----";
  setConnectionStatus("offline", "Disconnected");
  clearMatchPanels();
  updateLobbyState();
}

export function clearMatchPanels() {
  dom.winner.hidden = true;
  dom.endGameScreen.hidden = true;
}

export function showMenuScreen(screen) {
  for (const element of [dom.mainMenuScreen, dom.lobbyManagementScreen, dom.settingsScreen]) {
    if (element) element.hidden = element !== screen;
  }
}

export function hideMenuScreens() {
  for (const element of [dom.mainMenuScreen, dom.lobbyManagementScreen, dom.settingsScreen]) {
    if (element) element.hidden = true;
  }
}

export function openMainMenu() {
  showMenuScreen(dom.mainMenuScreen);
}

export function showMenuNotice(message, tone = "warning") {
  if (!dom.mainMenuNotice) return;
  dom.mainMenuNotice.textContent = message;
  dom.mainMenuNotice.className = `menu-notice ${tone}`;
  dom.mainMenuNotice.hidden = false;
}

export function clearMenuNotice() {
  if (!dom.mainMenuNotice) return;
  dom.mainMenuNotice.textContent = "";
  dom.mainMenuNotice.hidden = true;
}

export function openLobbyManagement() {
  showMenuScreen(dom.lobbyManagementScreen);
}

export function openSettings() {
  showMenuScreen(dom.settingsScreen);
  if (dom.serverUrlInput) {
    dom.serverUrlInput.value = getConfiguredServerUrl();
  }
}

export function saveServerSetting() {
  const value = String(dom.serverUrlInput?.value || "").trim();
  if (value) {
    localStorage.setItem(LOCAL_SERVER_KEY, value);
    showToast("Server URL saved", "good");
  } else {
    clearServerSetting();
  }
  syncUrlParams();
}

export function clearServerSetting() {
  localStorage.removeItem(LOCAL_SERVER_KEY);
  if (dom.serverUrlInput) dom.serverUrlInput.value = "";
  showToast("Using default server URL", "warning");
  syncUrlParams();
}

export function sendRulesUpdate() {
  if (!state.room || !isAdmin() || state.phase !== "lobby") return;
  const startingMoney = Number(dom.startingMoneyInput?.value) || 700;
  const maxPlayers = Number(dom.maxPlayersInput?.value) || 12;
  const mapSize = dom.mapSizeSelect?.value || "auto";
  const gameMode = dom.gameModeSelect?.value || "teams";
  send({
    type: "setRules",
    rules: { startingMoney, maxPlayers, mapSize, gameMode }
  });
}

export function kickPlayer(targetId) {
  const target = state.snapshot?.players?.find((player) => player.id === targetId);
  if (!target) return;
  openKickConfirmModal(target);
}

export function openKickConfirmModal(player) {
  state.pendingKickTargetId = player.id;
  state.pendingDeleteDesignId = null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = "Kick player?";
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = `Kick ${player.name} from the room?`;
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = "Kick";
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

export function bindKickButtonContainer(container) {
  if (!container) return;
  container.addEventListener("pointerdown", handleKickPointerDown);
  container.addEventListener("pointerup", handleKickPointerUp);
  container.addEventListener("click", handleKickKeyboardClick);
}

export function handleKickPointerDown(event) {
  if (event.button !== undefined && event.button !== 0) return;
  const button = event.target?.closest?.("[data-kick]");
  if (!button) return;
  event.preventDefault();
  clearKickPressedButtons();
  button.classList.add("pressed");
  state.kickPointer = {
    targetId: button.dataset.kick || "",
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY
  };
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  } catch {
    // Best effort
  }
}

export function handleKickPointerUp(event) {
  const pointer = state.kickPointer;
  if (!pointer || pointer.pointerId !== event.pointerId) return;
  clearKickPointer();
  try {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  } catch {
    // Best effort
  }
  const moved = Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y);
  if (moved > 12) return;
  event.preventDefault();
  kickPlayer(pointer.targetId);
}

export function clearKickPointer() {
  clearKickPressedButtons();
  state.kickPointer = null;
}

export function clearKickPressedButtons() {
  document.querySelectorAll("[data-kick].pressed")?.forEach((button) => {
    button.classList.remove("pressed");
  });
}

export function handleKickKeyboardClick(event) {
  if (event.detail !== 0) return;
  const button = event.target?.closest?.("[data-kick]");
  if (!button) return;
  event.preventDefault();
  kickPlayer(button.dataset.kick || "");
}

export function addBot() {
  send({ type: "addBot" });
}

function teamValue() {
  return dom.teamSelect?.value === "red" ? "red" : "blue";
}

export function setConnectionStatus(status, text) {
  if (!dom.status) return;
  dom.status.textContent = text;
  dom.status.className = `connection-status ${status}`;
}
