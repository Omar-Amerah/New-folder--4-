import { resizeArenaRenderer } from "../game/renderController.js";
import { getRenderQuality, setRenderQuality, getCombatEffectsEnabled, setCombatEffectsEnabled, getDebugRendererEnabled, setDebugRendererEnabled, getMobileTestingModeEnabled, setMobileTestingModeEnabled } from "../game/renderSettings.js";
// Handles lobby screens, player wing choices, starting/leaving, rules updates, and host controls.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { send, getSocketUrl, getConfiguredServerUrl, connect, disableReconnect, withClientProtocol } from "../network.js";
import { showToast } from "./toastUi.js";
import { renderSavedDesigns } from "./savedBlueprintsUi.js";
import { updateEconomyUi, renderPurchaseBar } from "./purchaseUi.js";
import { renderPalette } from "./partPaletteUi.js";
import { renderPartInspector } from "./partInspectorUi.js";
import { renderBuildGrid, renderLocalStats } from "./designerUi.js";
import { closeBlueprintDesigner } from "./designerScreenUi.js";
import { escapeHtml } from "../shared/formatting.js";
import { normalizeDesign } from "../design/blueprintStorage.js";
import { computeStats } from "../design/componentStats.js";
import { LOCAL_SERVER_KEY, LOCAL_ACTIVE_ROOM_KEY, syncUrlParams } from "../constants.js";
import { loadPreferences, persistPreferences, resetPreferences, applyInterfacePreferences } from "../localPreferences.js";
import { categoryPresence, clearCurrentBlueprint, clearSavedBlueprintsAndLoadouts, forgetRecoverableRoom } from "../storageRecovery.js";
import { exportBlueprints, importBlueprints, persistSavedDesigns, persistLoadouts } from "../design/blueprintStorage.js";
import { renderRecoveryCard } from "./roomRecoveryUi.js";
import { getResumeCredential } from "../reconnectStorage.js";

const ASTEROID_DENSITY_LABELS = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  veryHigh: "Very High"
};


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
  // Show a spinner from the create/join click until the room is joined (or the
  // attempt fails), so the wait on lobby creation has visible feedback.
  const joining = Boolean(state.joiningLobby) && !connected;
  dom.createButton.classList.toggle("is-loading", joining);
  dom.joinButton.classList.toggle("is-loading", joining);
  dom.createButton.disabled = connecting || joining;
  dom.joinButton.disabled = connecting || joining;
  if (dom.mainMenuCloseButton) dom.mainMenuCloseButton.disabled = !connected;
  dom.copyButton.disabled = !state.room;

  if (dom.botButton) {
    dom.botButton.hidden = !admin;
    dom.botButton.disabled = !connected || phase !== "lobby";
  }
  if (dom.leaveLobbyButton) {
    dom.leaveLobbyButton.hidden = admin;
    dom.leaveLobbyButton.disabled = !connected;
  }
  updateTeamChoiceControls(connected, phase);
  if (dom.startDesignButton) {
    dom.startDesignButton.hidden = !admin;
    dom.startDesignButton.disabled = !connected || phase !== "lobby" || playerCount === 0;
  }
  if (dom.restartLobbyButton) {
    const canRestartLobby = phase === "design" || phase === "active";
    dom.restartLobbyButton.hidden = !admin || !canRestartLobby;
    dom.restartLobbyButton.disabled = !connected || !canRestartLobby;
  }
  if (dom.closeLobbyButton) {
    dom.closeLobbyButton.hidden = !admin;
    // Admin can close the lobby in any phase, including an active battle.
    dom.closeLobbyButton.disabled = !connected;
  }
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
    if (editable) {
      dom.rulesStatus.textContent = "Host controls";
    } else {
      dom.rulesStatus.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>Locked after lobby';
    }
  }

  if (dom.rulesGrid && dom.rulesReadOnly) {
    if (editable) {
      dom.rulesGrid.hidden = false;
      dom.rulesReadOnly.hidden = true;
    } else {
      dom.rulesGrid.hidden = true;
      dom.rulesReadOnly.hidden = false;
      const gameMode = rules.gameMode === "solo" ? "Solo" : "Teams";
      const startMoney = rules.startingMoney ?? 700;
      const maxP = rules.maxPlayers ?? 12;
      const mapSize = rules.mapSize || "Auto";
      const asteroidDensity = ASTEROID_DENSITY_LABELS[rules.asteroidDensity] || "Medium";
      dom.rulesReadOnly.textContent = `Game mode: ${gameMode} | Starting money: ${startMoney} | Max players: ${maxP} | Map size: ${mapSize} | Asteroids: ${asteroidDensity}`;
    }
  }

  setRuleControlValue(dom.gameModeSelect, rules.gameMode || state.rules.gameMode || "teams");
  setRuleControlValue(dom.startingMoneyInput, rules.startingMoney ?? state.rules.startingMoney);
  setRuleControlValue(dom.maxPlayersInput, rules.maxPlayers ?? state.rules.maxPlayers);
  setRuleControlValue(dom.mapSizeSelect, rules.mapSize || state.rules.mapSize || "auto");
  setRuleControlValue(dom.asteroidDensitySelect, rules.asteroidDensity || state.rules.asteroidDensity || "medium");
  for (const element of [dom.gameModeSelect, dom.startingMoneyInput, dom.maxPlayersInput, dom.mapSizeSelect, dom.asteroidDensitySelect]) {
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
  if (!state.room) {
    dom.phaseDetail.textContent = "Create or join a room to begin.";
  } else if (phase === "lobby") {
    const mapRule = (state.rules?.mapSize && state.rules.mapSize !== "auto")
      ? state.rules.mapSize
      : `${players.length || 1} player${players.length === 1 ? "" : "s"}`;
    dom.phaseDetail.textContent = isAdmin()
      ? `Waiting room. Map: ${mapRule}.`
      : "Waiting for admin to start design.";
  } else if (phase === "design") {
    dom.phaseDetail.textContent = "Ship design phase.";
  } else if (phase === "active") {
    dom.phaseDetail.textContent = "Match in progress.";
  } else if (phase === "ended") {
    dom.phaseDetail.textContent = "Match ended.";
  }
}

function createPlayerRow(player) {
  const row = document.createElement("div");
  row.className = `player-row${player.id === state.myId ? " mine" : ""}`;
  const canKick = isAdmin() && player.id !== state.myId && (state.phase === "lobby" || state.phase === "design");
  const status = player.isAdmin ? "Admin" : player.ready ? "Ready" : state.phase === "design" ? "Designing" : player.isBot ? "Bot" : "Waiting";
  row.innerHTML = `
    <span class="score-color" style="background:${player.color}"></span>
    <div>
      <strong>${escapeHtml(player.name)}${player.id === state.myId ? " (you)" : ""}</strong>
      <span>${escapeHtml(state.rules?.gameMode === "solo" ? "No wing" : player.teamName || "Blue wing")} | ${status}</span>
    </div>
    ${canKick ? `<button type="button" data-kick="${escapeHtml(player.id)}">Kick</button>` : ""}
  `;
  return row;
}

export function renderPlayerList() {
  if (!dom.playerList || dom.lobbyManagementScreen?.hidden) return;
  const players = state.snapshot?.players || [];
  dom.playerList.textContent = "";
  if (!players.length) return;

  const max = state.rules?.maxPlayers || 12;
  const total = players.length;
  const ready = players.filter((p) => p.ready).length;

  const summary = document.createElement("div");
  summary.className = "section-heading compact";
  summary.style.marginTop = "0.5rem";
  summary.style.marginBottom = "0.5rem";

  if (state.rules?.gameMode === "solo") {
    summary.innerHTML = `<h2>Players: ${total} / ${max} | Ready: ${ready} / ${total}</h2>`;
    dom.playerList.appendChild(summary);

    for (const player of players) {
      dom.playerList.appendChild(createPlayerRow(player));
    }
  } else {
    const blueTeam = players.filter((p) => p.team !== "red");
    const redTeam = players.filter((p) => p.team === "red");

    const blueCount = blueTeam.length;
    const redCount = redTeam.length;
    summary.innerHTML = `<h2>Players: ${total} / ${max} | Ready: ${ready} / ${total} <span style="margin-left: 8px; color: var(--muted); font-weight: normal;">Blue: ${blueCount} | Red: ${redCount}</span></h2>`;
    dom.playerList.appendChild(summary);

    const blueHeader = document.createElement("div");
    blueHeader.className = "section-heading compact";
    blueHeader.innerHTML = "<h2>Blue wing</h2>";
    dom.playerList.appendChild(blueHeader);

    if (blueTeam.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No players";
      empty.style.opacity = "0.5";
      empty.style.marginBottom = "1rem";
      empty.style.fontSize = "0.85rem";
      dom.playerList.appendChild(empty);
    } else {
      for (const player of blueTeam) {
        dom.playerList.appendChild(createPlayerRow(player));
      }
    }

    const redHeader = document.createElement("div");
    redHeader.className = "section-heading compact";
    redHeader.style.marginTop = "0.5rem";
    redHeader.innerHTML = "<h2>Red wing</h2>";
    dom.playerList.appendChild(redHeader);

    if (redTeam.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No players";
      empty.style.opacity = "0.5";
      empty.style.fontSize = "0.85rem";
      dom.playerList.appendChild(empty);
    } else {
      for (const player of redTeam) {
        dom.playerList.appendChild(createPlayerRow(player));
      }
    }
  }
}

export function createGame() {
  const name = String(dom.pilotName.value || "").trim().slice(0, 18);
  if (!name) {
    showMenuNotice("Name required to host", "error");
    return;
  }
  persistPreferences({ ...loadPreferences().preferences, pilotName: name, preferredTeam: teamValue(), formation: dom.formationSelect.value });
  state.joiningLobby = true;
  const joinPayload = { type: "join", name, room: "", team: teamValue() };
  connect(getSocketUrl(), () => { send(withClientProtocol(joinPayload)); }, { joinPayload });
  updateLobbyState();
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
  persistPreferences({ ...loadPreferences().preferences, pilotName: name, preferredTeam: teamValue(), formation: dom.formationSelect.value });
  state.joiningLobby = true;
  const joinPayload = { type: "join", name, room: roomCode, team: teamValue(), resumeToken: getResumeCredential(roomCode) };
  connect(getSocketUrl(), () => { send(withClientProtocol(joinPayload)); }, { joinPayload });
  updateLobbyState();
}

function releaseClickedControlFocus() {
  if (document.activeElement instanceof HTMLElement && document.activeElement.tagName === "BUTTON") {
    document.activeElement.blur();
  }
}

export function deployDesign() {
  releaseClickedControlFocus();
  const stats = computeStats(state.design);
  const mine = state.mine;
  const isDesignStage = state.phase === "design";
  const ready = mine?.ready;

  if (isDesignStage && !ready) {
    send({
      type: "deploy",
      design: state.design,
      wiring: state.wiring,
      combatStyle: state.combatStyle || dom.combatStyleSelect?.value || "charge"
    });
    send({ type: "ready" });
    // Readying the first design confirms it; drop back to the arena view.
    closeBlueprintDesigner();
  }
}

export function startDesign() {
  releaseClickedControlFocus();
  send({ type: "startDesign" });
}

export function restartMatch() {
  send({ type: "restart" });
}

export function returnToLobby() {
  send({ type: "returnToLobby" });
}

export function closeLobby() {
  disableReconnect("room-closed");
  send({ type: "closeLobby" });
}

export function leaveLobby() {
  disableReconnect("explicit-leave");
  send({ type: "leaveLobby" });
}

export function setEndGameActionState(disabled) {
  for (const element of [dom.restartButton, dom.returnToLobbyButton, dom.endCloseButton, dom.endLeaveButton]) {
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
  state.joiningLobby = false;
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
  if (dom.showEndGameButton) dom.showEndGameButton.hidden = true;
  state.endGameMinimized = false;
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
  renderRecoveryCard();
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
  const prefs = loadPreferences().preferences;
  if (dom.serverUrlInput) {
    dom.serverUrlInput.value = getConfiguredServerUrl() || prefs.serverUrl;
  }
  if (dom.settingsTeamSelect) dom.settingsTeamSelect.value = prefs.preferredTeam;
  if (dom.settingsFormationSelect) dom.settingsFormationSelect.value = prefs.formation;
  if (dom.reducedMotionToggle) dom.reducedMotionToggle.checked = prefs.reducedMotion;
  if (dom.interfaceScaleSelect) dom.interfaceScaleSelect.value = String(prefs.interfaceScale);
  renderStorageStatus();
  if (dom.renderQualitySelect) {
    dom.renderQualitySelect.value = prefs.renderQuality || getRenderQuality();
  }
  if (dom.debugOverlayToggle) {
    dom.debugOverlayToggle.checked = getDebugRendererEnabled();
  }
  if (dom.combatEffectsToggle) {
    dom.combatEffectsToggle.checked = getCombatEffectsEnabled();
  }
  if (dom.mobileTestingToggle) {
    dom.mobileTestingToggle.checked = getMobileTestingModeEnabled();
  }
}

export function saveServerSetting() {
  const value = String(dom.serverUrlInput?.value || "").trim();
  if (value) {
    persistPreferences({ ...loadPreferences().preferences, serverUrl: value });
    localStorage.setItem(LOCAL_SERVER_KEY, value);
    showToast("Server URL saved", "good");
  } else {
    clearServerSetting();
  }
  syncUrlParams();
}

export function clearServerSetting() {
  persistPreferences({ ...loadPreferences().preferences, serverUrl: "" });
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
  const asteroidDensity = dom.asteroidDensitySelect?.value || "medium";
  send({
    type: "setRules",
    rules: { startingMoney, maxPlayers, mapSize, gameMode, asteroidDensity }
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


if (typeof window !== "undefined") {
  window.addEventListener("DOMContentLoaded", () => {
    if (dom.renderQualitySelect) {
      dom.renderQualitySelect.addEventListener("change", (e) => {
        setRenderQuality(e.target.value);
        resizeArenaRenderer();
      });
    }
    if (dom.debugOverlayToggle) {
      dom.debugOverlayToggle.addEventListener("change", (e) => {
        setDebugRendererEnabled(e.target.checked);
        if (dom.debugOverlay) dom.debugOverlay.style.display = e.target.checked ? "block" : "none";
      });
    }
    if (dom.combatEffectsToggle) {
      dom.combatEffectsToggle.addEventListener("change", (e) => {
        setCombatEffectsEnabled(e.target.checked);
      });
    }
    if (dom.mobileTestingToggle) {
      dom.mobileTestingToggle.addEventListener("change", (e) => {
        setMobileTestingModeEnabled(e.target.checked);
        showToast(`Mobile testing mode ${e.target.checked ? "on" : "off"}`, e.target.checked ? "good" : "warning");
      });
    }
  });
}


export function renderStorageStatus() {
  if (!dom.storageStatus) return;
  const p = categoryPresence();
  dom.storageStatus.textContent = `Present: settings ${p.settings ? "yes" : "no"}, current blueprint ${p.currentBlueprint ? "yes" : "no"}, saved blueprints ${p.savedBlueprints ? "yes" : "no"}, loadouts ${p.loadouts ? "yes" : "no"}, recoverable room ${p.recoverableRoom ? "yes" : "no"}.`;
}

function confirmAction(message, action) {
  if (!confirm(message)) return;
  action();
  renderStorageStatus();
  renderRecoveryCard();
}

export function bindSettingsRecoveryControls() {
  dom.settingsTeamSelect?.addEventListener("change", (e) => { persistPreferences({ ...loadPreferences().preferences, preferredTeam: e.target.value }); dom.teamSelect.value = e.target.value; });
  dom.settingsFormationSelect?.addEventListener("change", (e) => { persistPreferences({ ...loadPreferences().preferences, formation: e.target.value }); dom.formationSelect.value = e.target.value; });
  dom.reducedMotionToggle?.addEventListener("change", (e) => { const prefs = { ...loadPreferences().preferences, reducedMotion: e.target.checked }; persistPreferences(prefs); applyInterfacePreferences(prefs); });
  dom.interfaceScaleSelect?.addEventListener("change", (e) => { const prefs = { ...loadPreferences().preferences, interfaceScale: Number(e.target.value) }; persistPreferences(prefs); applyInterfacePreferences(prefs); });
  dom.resetSettingsButton?.addEventListener("click", () => confirmAction("Reset settings? Saved blueprints will be kept.", () => { resetPreferences(); applyInterfacePreferences(loadPreferences().preferences); openSettings(); }));
  dom.clearCurrentBlueprintButton?.addEventListener("click", () => confirmAction("Clear the current blueprint? Saved blueprints will be kept.", clearCurrentBlueprint));
  dom.clearSavedBlueprintsButton?.addEventListener("click", () => confirmAction("Clear saved blueprints and loadouts?", clearSavedBlueprintsAndLoadouts));
  dom.forgetRecoverableRoomButton?.addEventListener("click", () => confirmAction("Forget recoverable room state?", forgetRecoverableRoom));
  dom.exportBlueprintsButton?.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(exportBlueprints(state.savedDesigns, state.loadouts), null, 2)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "mfa-blueprints.json"; a.click(); URL.revokeObjectURL(a.href);
  });
  dom.importBlueprintsButton?.addEventListener("click", () => dom.importBlueprintsInput?.click());
  dom.importBlueprintsInput?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      const result = importBlueprints(JSON.parse(await file.text()), state.savedDesigns, state.loadouts);
      if (result.incompatibleVersion) {
        showToast("This export file uses an old blueprint format without wiring and cannot be imported.", "error");
        event.target.value = "";
        return;
      }
      state.savedDesigns = result.designs; state.loadouts = result.loadouts;
      persistSavedDesigns(state.savedDesigns); persistLoadouts(state.loadouts); renderSavedDesigns(); renderPurchaseBar(); showToast(`Imported ${result.acceptedDesigns ?? result.accepted} blueprints and ${result.acceptedLoadouts ?? 0} loadouts. Skipped ${result.rejectedDesigns ?? result.rejected} blueprint${(result.rejectedDesigns ?? result.rejected) === 1 ? "" : "s"} and ${result.rejectedLoadouts ?? 0} loadout${(result.rejectedLoadouts ?? 0) === 1 ? "" : "s"}.`, (result.rejectedDesigns || result.rejectedLoadouts || result.rejected) ? "warning" : "good");
    } catch { showToast("Blueprint import file was not valid JSON", "error"); }
    event.target.value = "";
  });
}
