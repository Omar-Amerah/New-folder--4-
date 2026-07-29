import { resizeArenaRenderer } from "../game/renderController.js";
import { getRenderQuality, setRenderQuality, getCombatEffectsEnabled, setCombatEffectsEnabled, getDebugRendererEnabled, setDebugRendererEnabled, getMobileTestingModeEnabled, setMobileTestingModeEnabled } from "../game/renderSettings.js";
// Handles lobby screens, player wing choices, starting/leaving, rules updates, and host controls.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { send, getSocketUrl, getConfiguredServerUrl, connect, disableReconnect, withClientProtocol } from "../network.js";
import { synchronizeTelemetryFocus } from "../telemetryFocus.js";
import { notify } from "./toastUi.js";
import { isBalanceIncompatible, balanceBlockMessage } from "../balanceStatus.js";
import { renderSavedDesigns } from "./savedBlueprintsUi.js";
import { updateEconomyUi, renderPurchaseBar, DESIGNER_PHASES } from "./purchaseUi.js";
import { renderPalette } from "./partPaletteUi.js";
import { renderPartInspector } from "./partInspectorUi.js";
import { renderBuildGrid, renderLocalStats } from "./designerUi.js";
import { invalidatePresentation } from "../presentationInvalidation.js";
import { closeBlueprintDesigner } from "./designerScreenUi.js";
import { escapeHtml, formatMoney } from "../shared/formatting.js";
import { normalizeDesign } from "../design/blueprintStorage.js";
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

const TEAM_LOADING_VALUE = "__loading__";
const TEAM_NONE_VALUE = "__none__";
const TEAM_PLACEHOLDER_VALUE = "";
const AUTHORITATIVE_TEAM_IDS = ["blue", "red"];
let pendingTeamChange = null;
let lastTeamOptionsSignature = "";
let lastRulesReadOnlySignature = "";

function bumpPresentation(name) {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics[name] = (diagnostics[name] || 0) + 1;
}

export function isAdmin() {
  return state.adminId === state.myId || Boolean(state.mine?.isAdmin);
}

export function getLobbyInteractionState() {
  const phase = state.snapshot?.phase ?? state.phase;
  const readyState = state.socket?.readyState;
  const connected = readyState === WebSocket.OPEN && Boolean(state.room);
  const connecting = readyState === WebSocket.CONNECTING;
  const admin = isAdmin();
  const playerCount = state.snapshotIndex?.playerById?.size
    ?? state.snapshot?.players?.length
    ?? 0;
  return {
    phase,
    connected,
    connecting,
    admin,
    playerCount,
    canEditRules: connected && admin && phase === "lobby",
    canChooseTeam: connected && phase === "lobby"
  };
}

export function isLobbyPresentationVisible() {
  // The lobby DOM is only meaningful when the main menu or lobby management
  // screen is actually visible. During active play these screens are hidden
  // and repeated snapshot-driven DOM rebuilds must be skipped.
  return Boolean(
    (dom.lobbyManagementScreen && !dom.lobbyManagementScreen.hidden) ||
    (dom.mainMenuScreen && !dom.mainMenuScreen.hidden)
  );
}

export function updateLobbyConnectionState(interaction = getLobbyInteractionState()) {
  const { connected, connecting, playerCount, phase, admin } = interaction;

  const roomStateText = connected ? `${phaseLabel(phase)} | ${playerCount} in Room` : connecting ? "Connecting" : "Not Joined";
  if (dom.roomState && dom.roomState.textContent !== roomStateText) dom.roomState.textContent = roomStateText;

  const joining = Boolean(state.joiningLobby) && !connected;
  dom.createButton?.classList.toggle("is-loading", joining);
  dom.joinButton?.classList.toggle("is-loading", joining);
  if (dom.createButton) dom.createButton.disabled = connecting || joining;
  if (dom.joinButton) dom.joinButton.disabled = connecting || joining;
  if (dom.mainMenuCloseButton) dom.mainMenuCloseButton.disabled = !connected;
  if (dom.copyButton) dom.copyButton.disabled = !state.room;

  if (dom.botButton) {
    dom.botButton.hidden = !admin;
    dom.botButton.disabled = !connected || phase !== "lobby";
  }
  if (dom.leaveLobbyButton) {
    dom.leaveLobbyButton.hidden = admin;
    dom.leaveLobbyButton.disabled = !connected;
  }
  if (dom.lobbyOpenDesignerButton) {
    // Not admin-gated: every player builds their own ship, and the lobby is the
    // one screen where they are all sitting and waiting.
    const balanceCompatible = !isBalanceIncompatible();
    dom.lobbyOpenDesignerButton.disabled = !connected
      || !DESIGNER_PHASES.includes(phase)
      || !balanceCompatible;
    dom.lobbyOpenDesignerButton.title = balanceCompatible ? "" : balanceBlockMessage();
  }
  if (dom.startDesignButton) {
    dom.startDesignButton.hidden = !admin;
    dom.startDesignButton.disabled = !connected || phase !== "lobby" || state.pendingStartDesign;
    dom.startDesignButton.classList.toggle("is-loading", state.pendingStartDesign);
    dom.startDesignButton.textContent = state.pendingStartDesign ? "Starting…" : "Start Blueprint Design";
  }
  if (dom.restartLobbyButton) {
    const canRestartLobby = phase === "design" || phase === "active";
    dom.restartLobbyButton.hidden = !admin || !canRestartLobby;
    dom.restartLobbyButton.disabled = !connected || !canRestartLobby;
  }
  if (dom.closeLobbyButton) {
    dom.closeLobbyButton.hidden = !admin;
    dom.closeLobbyButton.disabled = !connected;
  }
  if (dom.currentRoomCard) dom.currentRoomCard.hidden = !state.room;
  if (dom.currentRoomCode) dom.currentRoomCode.textContent = state.room || "----";
}

export function updateLobbyRulesState(interaction = getLobbyInteractionState()) {
  updateRulesControls(interaction);
  updateTeamChoiceControls(interaction);
}

export function updateLobbyPhaseState(interaction = getLobbyInteractionState()) {
  updatePhaseSteps(interaction.phase);
  updatePhaseDetail(interaction.phase);
}

export function updateLobbyPlayerState() {
  updateLobbyPlayerRows();
  updateLobbyPlayerStatus();
}

export function updateLobbyPlayerRows() {
  if (!isLobbyPresentationVisible() || !dom.playerList) return;
  renderPlayerList();
}

export function updateLobbyState() {
  if (!isLobbyPresentationVisible()) return;
  const interaction = getLobbyInteractionState();
  updateLobbyVisibility(interaction);
  updateLobbyRules(interaction);
  updateLobbyPlayerRows();
  updateLobbyPlayerStatus();
  renderRecoveryCard();
}

function renderRulesReadOnly(rules) {
  const missing = `<span class="rule-missing">Not set</span>`;
  const modeValue = rules.gameMode === "solo" ? "Solo" : "Teams";
  const moneyValue = typeof rules.startingMoney === "number" ? formatMoney(rules.startingMoney) : missing;
  const maxValue = typeof rules.maxPlayers === "number" ? String(rules.maxPlayers) : (rules.maxPlayers || missing);
  const mapValue = rules.mapSize === "auto" ? "Automatic by player count" : (escapeHtml(rules.mapSize) || missing);
  const densityValue = escapeHtml(ASTEROID_DENSITY_LABELS[rules.asteroidDensity] || rules.asteroidDensity || "Not set");
  const infrastructureValue = rules.infrastructureMode === "stations" ? "Stations" : "Classic";
  const visibilityValue = rules.visibilityMode === "dark"
    ? "Full Dark"
    : rules.visibilityMode === "sensors" ? "Sensor Fog" : "Full Visibility";
  return `
    <dl class="game-rules-grid">
      <div class="game-rule"><dt>Mode</dt><dd>${modeValue}</dd></div>
      <div class="game-rule"><dt>Starting money</dt><dd>${moneyValue}</dd></div>
      <div class="game-rule"><dt>Maximum players</dt><dd>${maxValue}</dd></div>
      <div class="game-rule"><dt>Map size</dt><dd>${mapValue}</dd></div>
      <div class="game-rule"><dt>Asteroid density</dt><dd>${densityValue}</dd></div>
      <div class="game-rule"><dt>Infrastructure</dt><dd>${infrastructureValue}</dd></div>
      <div class="game-rule"><dt>Visibility</dt><dd>${visibilityValue}</dd></div>
    </dl>
  `;
}

export function updateRulesControls(interaction = getLobbyInteractionState()) {
  const { connected, admin, phase, playerCount, canEditRules: editable } = interaction;
  const rules = state.snapshot?.rules || state.rules || {};
  state.rules = { ...state.rules, ...rules };
  if (dom.rulesStatus) {
    if (editable) {
      dom.rulesStatus.textContent = "Host Controls";
    } else if (phase !== "lobby") {
      dom.rulesStatus.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="margin-right:4px;"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>Locked after lobby';
    } else if (!connected) {
      dom.rulesStatus.textContent = "Reconnecting…";
    } else {
      dom.rulesStatus.textContent = admin ? "Host Controls" : "Host controls";
    }
  }

  if (dom.rulesGrid && dom.rulesReadOnly) {
    dom.rulesGrid.hidden = !editable;
    dom.rulesReadOnly.hidden = editable;
    if (editable) {
      setRuleControlValue(dom.gameModeSelect, rules.gameMode);
      setRuleControlValue(dom.startingMoneyInput, rules.startingMoney);
      setRuleControlValue(dom.maxPlayersInput, String(Math.min(Number(rules.maxPlayers) || 8, 8)));
      setRuleControlValue(dom.mapSizeSelect, rules.mapSize);
      setRuleControlValue(dom.asteroidDensitySelect, rules.asteroidDensity);
      setRuleControlValue(dom.infrastructureModeSelect, rules.infrastructureMode || "stations");
      setRuleControlValue(dom.visibilityModeSelect, rules.visibilityMode || "sensors");
    } else {
      const nextSignature = `${rules.gameMode}|${rules.startingMoney}|${rules.maxPlayers}|${rules.mapSize}|${rules.asteroidDensity}|${rules.infrastructureMode}|${rules.visibilityMode}|${phase}`;
      if (nextSignature !== lastRulesReadOnlySignature) {
        lastRulesReadOnlySignature = nextSignature;
        dom.rulesReadOnly.innerHTML = renderRulesReadOnly(rules);
      }
    }
  }

  if (dom.maxPlayersInput) {
    dom.maxPlayersInput.max = "8";
    dom.maxPlayersInput.min = String(Math.max(2, playerCount || 1));
  }
}

export function updateTeamChoiceControls(interaction = getLobbyInteractionState()) {
  if (!dom.teamChoiceCard) return;
  const { connected, phase, canChooseTeam: canChoose } = interaction;
  const gameMode = state.snapshot?.rules?.gameMode || state.rules?.gameMode || "teams";
  const isTeamMode = gameMode !== "solo";
  dom.teamChoiceCard.hidden = !isTeamMode;
  if (!isTeamMode) return;

  const loading = !state.snapshot || !Array.isArray(state.snapshot.players);
  const teams = loading ? [] : getAuthoritativeTeams();
  buildTeamSelectOptions(loading, teams);
  const myTeam = state.mine?.team || (state.snapshot?.players?.find((p) => p.id === state.myId)?.team) || "";
  setTeamSelectValue(myTeam);
  dom.teamSelect.disabled = loading || teams.length === 0 || !canChoose;
  updateTeamChoiceStatus(myTeam, canChoose, connected, phase);
  if (pendingTeamChange && myTeam === pendingTeamChange) pendingTeamChange = null;
}

function setRuleControlValue(element, value) {
  if (!element || document.activeElement === element) return;
  element.value = String(value);
}

function getTeamFallbackName(id) {
  return { blue: "Blue Wing", red: "Red Wing" }[id] || `${String(id).charAt(0).toUpperCase()}${String(id).slice(1)}`;
}

function getAuthoritativeTeams() {
  const players = state.snapshot?.players || [];
  const labels = new Map();
  for (const player of players) {
    if (player.team && typeof player.teamName === "string" && !labels.has(player.team)) {
      labels.set(player.team, player.teamName);
    }
  }
  const teams = [];
  for (const id of AUTHORITATIVE_TEAM_IDS) {
    teams.push({ id, name: labels.get(id) || getTeamFallbackName(id) });
  }
  return teams;
}

function buildTeamSelectOptions(loading, teams) {
  if (!dom.teamSelect) return;
  const ids = loading ? [TEAM_LOADING_VALUE] : (teams.length === 0 ? [TEAM_NONE_VALUE] : teams.map((t) => t.id));
  const signature = JSON.stringify([loading, ids, state.rules?.gameMode]);
  if (signature === lastTeamOptionsSignature) return;
  lastTeamOptionsSignature = signature;
  const previousValue = dom.teamSelect.value;
  dom.teamSelect.innerHTML = "";
  if (loading) {
    const option = document.createElement("option");
    option.value = TEAM_LOADING_VALUE;
    option.textContent = "Loading teams…";
    option.disabled = true;
    option.selected = true;
    dom.teamSelect.appendChild(option);
    return;
  }
  if (teams.length === 0) {
    const option = document.createElement("option");
    option.value = TEAM_NONE_VALUE;
    option.textContent = "No teams available";
    option.disabled = true;
    option.selected = true;
    dom.teamSelect.appendChild(option);
    return;
  }
  const placeholder = document.createElement("option");
  placeholder.value = TEAM_PLACEHOLDER_VALUE;
  placeholder.textContent = "Choose a team";
  placeholder.disabled = true;
  dom.teamSelect.appendChild(placeholder);
  for (const team of teams) {
    const option = document.createElement("option");
    option.value = team.id;
    option.textContent = team.name;
    dom.teamSelect.appendChild(option);
  }
  const stillValid = previousValue && ids.includes(previousValue);
  if (stillValid) dom.teamSelect.value = previousValue;
}

function setTeamSelectValue(value) {
  if (!dom.teamSelect || document.activeElement === dom.teamSelect) return;
  const exists = Array.from(dom.teamSelect.options).some((o) => o.value === value && !o.disabled);
  const placeholder = Array.from(dom.teamSelect.options).find((o) => o.value === TEAM_PLACEHOLDER_VALUE);
  if (exists) {
    dom.teamSelect.value = value;
  } else if (placeholder) {
    dom.teamSelect.value = placeholder.value;
  } else if (dom.teamSelect.options[0]) {
    dom.teamSelect.value = dom.teamSelect.options[0].value;
  }
}

function getTeamDisplayName(team) {
  const label = (state.snapshot?.players || []).find((p) => p.team === team && p.teamName)?.teamName;
  return label || getTeamFallbackName(team);
}

function updateTeamChoiceStatus(myTeam, canChoose, connected, phase) {
  if (!dom.teamChoiceStatus) return;
  if (phase === "lobby" && !connected) {
    dom.teamChoiceStatus.textContent = "Reconnecting…";
    return;
  }
  if (myTeam) {
    dom.teamChoiceStatus.textContent = `${getTeamDisplayName(myTeam)}${canChoose ? "" : " (Locked)"}`;
  } else {
    dom.teamChoiceStatus.textContent = canChoose ? "Choose your team before ship design" : "Locked after ship design starts";
  }
}

function handleTeamSelectChange() {
  if (!dom.teamSelect) return;
  const value = dom.teamSelect.value;
  if (!value || value === TEAM_LOADING_VALUE || value === TEAM_NONE_VALUE) return;
  const myTeam = state.mine?.team || (state.snapshot?.players?.find((p) => p.id === state.myId)?.team) || "";
  if (value === myTeam) return;
  pendingTeamChange = value;
  persistPreferences({ ...loadPreferences().preferences, preferredTeam: value });
  if (state.room && state.socket?.readyState === WebSocket.OPEN) {
    const sent = send({ type: "setTeam", team: value });
    if (!sent) {
      pendingTeamChange = null;
      setTeamSelectValue(myTeam);
      notify.error("Team change could not be sent. Please check your connection.");
    }
  }
}

export function onServerError(message = {}) {
  if (state.pendingEndGameAction) clearPendingEndGameAction();
  if (pendingTeamChange) {
    pendingTeamChange = null;
    const phase = state.snapshot?.phase || state.phase;
    updateTeamChoiceControls(getLobbyInteractionState());
  }
  if (state.pendingStartDesign || state.pendingDeploy) {
    state.pendingStartDesign = false;
    state.pendingDeploy = false;
    if (dom.startDesignButton) {
      dom.startDesignButton.classList.remove("is-loading");
      dom.startDesignButton.textContent = "Start Blueprint Design";
    }
    if (dom.deployButton) {
      dom.deployButton.classList.remove("is-loading");
    }
    invalidatePresentation("deployment");
    updateLobbyConnectionState();
    if (message.message) notify.error(message.message);
  }
}

export function phaseLabel(phase) {
  if (phase === "lobby") return "Lobby";
  if (phase === "design") return "Ship Design";
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
      ? `Waiting Room. Map: ${mapRule}.`
      : "Waiting for Admin to Start Design.";
  } else if (phase === "design") {
    dom.phaseDetail.textContent = "Ship Design Phase.";
  } else if (phase === "active") {
    dom.phaseDetail.textContent = "Match in Progress.";
  } else if (phase === "ended") {
    dom.phaseDetail.textContent = "Match Ended.";
  }
}

function lobbyPlayerStatus(player) {
  if (player.connected === false) return "Disconnected";
  if (player.isAdmin) return "Admin";
  if (player.ready) return "Ready";
  if (state.phase === "design") return "Designing";
  return player.isBot ? "Bot" : "Waiting";
}

function createPlayerRow(player) {
  const row = document.createElement("div");
  row.className = `player-row${player.id === state.myId ? " mine" : ""}`;
  row.dataset.playerId = player.id;
  const canKick = isAdmin() && player.id !== state.myId && (state.phase === "lobby" || state.phase === "design");
  const status = lobbyPlayerStatus(player);
  row.innerHTML = `
    <span class="player-color" data-player-color style="background:${player.color}"></span>
    <div>
      <strong data-player-name>${escapeHtml(player.name)}${player.id === state.myId ? " (you)" : ""}</strong>
      <span><span data-player-team>${escapeHtml(state.rules?.gameMode === "solo" ? "No wing" : player.teamName || getTeamFallbackName(player.team || "blue"))}</span><span data-player-status>${escapeHtml(status)}</span></span>
    </div>
    ${canKick ? `<button type="button" data-kick="${escapeHtml(player.id)}">Kick</button>` : ""}
  `;
  return row;
}

export function renderPlayerList() {
  if (!dom.playerList || !isLobbyPresentationVisible()) return;
  bumpPresentation("lobbyPlayerListRebuildCount");
  const players = state.snapshot?.players || [];
  dom.playerList.textContent = "";
  if (!players.length) return;

  const max = state.rules?.maxPlayers || 8;
  const total = players.length;
  const ready = players.filter((p) => p.ready).length;

  const summary = document.createElement("div");
  summary.className = "section-heading compact";
  summary.style.marginTop = "0.5rem";
  summary.style.marginBottom = "0.5rem";

  if (state.rules?.gameMode === "solo") {
    summary.innerHTML = `<h2><span data-lobby-summary-main>Players: ${total} / ${max} | Ready: ${ready} / ${total}</span></h2>`;
    dom.playerList.appendChild(summary);

    for (const player of players) {
      dom.playerList.appendChild(createPlayerRow(player));
    }
  } else {
    const blueTeam = players.filter((p) => p.team !== "red");
    const redTeam = players.filter((p) => p.team === "red");

    const blueCount = blueTeam.length;
    const redCount = redTeam.length;
    summary.innerHTML = `<h2><span data-lobby-summary-main>Players: ${total} / ${max} | Ready: ${ready} / ${total}</span> <span data-lobby-summary-teams style="margin-left: 8px; color: var(--muted); font-weight: normal;">Blue: ${blueCount} | Red: ${redCount}</span></h2>`;
    dom.playerList.appendChild(summary);

    const blueHeader = document.createElement("div");
    blueHeader.className = "section-heading compact";
    blueHeader.innerHTML = '<h2><span class="team-color-swatch" style="background:var(--cyan)"></span>Blue wing</h2>';
    dom.playerList.appendChild(blueHeader);

    const blueGroup = document.createElement("div");
    blueGroup.className = "team-group blue-team";
    if (blueTeam.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No players";
      empty.style.opacity = "0.5";
      empty.style.fontSize = "0.85rem";
      blueGroup.appendChild(empty);
    } else {
      for (const player of blueTeam) {
        blueGroup.appendChild(createPlayerRow(player));
      }
    }
    dom.playerList.appendChild(blueGroup);

    const redHeader = document.createElement("div");
    redHeader.className = "section-heading compact";
    redHeader.style.marginTop = "0.5rem";
    redHeader.innerHTML = '<h2><span class="team-color-swatch" style="background:var(--red)"></span>Red wing</h2>';
    dom.playerList.appendChild(redHeader);

    const redGroup = document.createElement("div");
    redGroup.className = "team-group red-team";
    if (redTeam.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "No players";
      empty.style.opacity = "0.5";
      empty.style.fontSize = "0.85rem";
      redGroup.appendChild(empty);
    } else {
      for (const player of redTeam) {
        redGroup.appendChild(createPlayerRow(player));
      }
    }
    dom.playerList.appendChild(redGroup);
  }
}

export function updateLobbyPlayerStatus() {
  if (!isLobbyPresentationVisible() || !dom.playerList) return;
  const players = state.snapshot?.players || [];
  let patchCount = 0;
  for (const player of players) {
    const row = dom.playerList.querySelector?.(`[data-player-id="${player.id}"]`);
    if (!row) continue;
    const status = lobbyPlayerStatus(player);
    const statusElement = row.querySelector?.("[data-player-status]");
    if (statusElement && statusElement.textContent !== status) {
      statusElement.textContent = status;
      patchCount += 1;
    }
  }
  const total = players.length;
  const ready = players.filter((player) => player.ready).length;
  const max = state.rules?.maxPlayers || 8;
  const blueCount = players.filter((player) => player.team !== "red").length;
  const redCount = total - blueCount;
  const summary = `Players: ${total} / ${max} | Ready: ${ready} / ${total}`;
  const summaryElement = dom.playerList.querySelector?.("[data-lobby-summary-main]");
  if (summaryElement && summaryElement.textContent !== summary) {
    summaryElement.textContent = summary;
    patchCount += 1;
  }
  const teamSummary = `Blue: ${blueCount} | Red: ${redCount}`;
  const teamSummaryElement = dom.playerList.querySelector?.("[data-lobby-summary-teams]");
  if (teamSummaryElement && teamSummaryElement.textContent !== teamSummary) {
    teamSummaryElement.textContent = teamSummary;
    patchCount += 1;
  }
  if (patchCount) {
    const diagnostics = state.presentationDiagnostics;
    if (diagnostics) {
      diagnostics.lobbyPlayerRowPatchCount += patchCount;
      diagnostics.presentationDomWriteCount += patchCount;
      diagnostics.lobbyDomWriteCount += patchCount;
    }
  }
}

export function openServerLeaveConfirmModal(onConfirmAction, messageTitle = "Leave server?", messageBody = "", acceptText = "Leave & Create") {
  state.pendingServerLeaveAction = onConfirmAction;
  state.pendingDeleteDesignId = null;
  state.pendingKickTargetId = null;
  if (dom.confirmModalTitle) dom.confirmModalTitle.textContent = messageTitle;
  if (dom.confirmModalMessage) dom.confirmModalMessage.textContent = messageBody || `You are currently connected to server ${state.room}. Continue and leave the server?`;
  if (dom.confirmAcceptButton) dom.confirmAcceptButton.textContent = acceptText;
  if (dom.confirmModal) dom.confirmModal.hidden = false;
  dom.confirmCancelButton?.focus?.();
}

export function createGame() {
  const name = String(dom.pilotName.value || "").trim().slice(0, 18);
  if (!name) {
    showMenuNotice("Name required to host", "error");
    return;
  }
  const inServer = Boolean(state.room) && (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING || state.phase !== "offline");
  if (inServer) {
    openServerLeaveConfirmModal(() => {
      leaveLobby();
      persistPreferences({ ...loadPreferences().preferences, pilotName: name, preferredTeam: teamValue(), preferredColor: colorValue() });
      state.joiningLobby = true;
      const joinPayload = { type: "join", name, room: "", team: teamValue(), color: colorValue() };
      connect(getSocketUrl(), () => { send(withClientProtocol(joinPayload)); }, { joinPayload });
      updateLobbyState();
    }, "Leave server to create game?", `You are currently connected to server ${state.room}. Creating a new game will leave this server.`, "Leave & Create");
    return;
  }
  persistPreferences({ ...loadPreferences().preferences, pilotName: name, preferredTeam: teamValue(), preferredColor: colorValue() });
  state.joiningLobby = true;
  const joinPayload = { type: "join", name, room: "", team: teamValue(), color: colorValue() };
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
  const targetRoom = String(roomCode || "").trim().toUpperCase().slice(0, 8);
  const inServer = Boolean(state.room) && (state.socket?.readyState === WebSocket.OPEN || state.socket?.readyState === WebSocket.CONNECTING || state.phase !== "offline");
  if (inServer && state.room !== targetRoom) {
    openServerLeaveConfirmModal(() => {
      leaveLobby();
      persistPreferences({ ...loadPreferences().preferences, pilotName: name, preferredTeam: teamValue(), preferredColor: colorValue() });
      state.joiningLobby = true;
      const joinPayload = { type: "join", name, room: targetRoom, team: teamValue(), color: colorValue(), resumeToken: getResumeCredential(targetRoom) };
      connect(getSocketUrl(), () => { send(withClientProtocol(joinPayload)); }, { joinPayload });
      updateLobbyState();
    }, "Leave server to join game?", `You are currently connected to server ${state.room}. Joining room ${targetRoom} will leave this server.`, "Leave & Join");
    return;
  }
  persistPreferences({ ...loadPreferences().preferences, pilotName: name, preferredTeam: teamValue(), preferredColor: colorValue() });
  state.joiningLobby = true;
  const joinPayload = { type: "join", name, room: targetRoom, team: teamValue(), color: colorValue(), resumeToken: getResumeCredential(targetRoom) };
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
  if (state.pendingDeploy) return;
  const mine = state.mine;
  const isDesignStage = state.phase === "design";
  const ready = mine?.ready;

  if (isDesignStage && !ready) {
    state.pendingDeploy = true;
    invalidatePresentation("deployment");
    // Deploying during the design phase marks the player ready server-side;
    // there is no separate "ready" message in the protocol.
    const sent = send({
      type: "deploy",
      design: state.design,
      wiring: state.wiring,
      combatStyle: state.combatStyle || dom.combatStyleSelect?.value || "hold"
    });
    if (!sent) {
      state.pendingDeploy = false;
      invalidatePresentation("deployment");
      notify.error("Deploy request could not be sent.");
      return;
    }
    // Readying the first design confirms it; drop back to the arena view.
    closeBlueprintDesigner();
  }
}

export function startDesign() {
  releaseClickedControlFocus();
  if (state.pendingStartDesign) return;
  const sent = send({ type: "startDesign" });
  if (sent) {
    state.pendingStartDesign = true;
    updateLobbyConnectionState();
    invalidatePresentation("deployment");
  } else {
    notify.error("Start Blueprint Design request could not be sent.");
  }
}

export function restartMatch() {
  // A rematch returns the existing room and roster to Lobby so the host can
  // review teams/rules before starting the next design phase.
  return sendEndGameAction("returnToLobby", "rematch");
}

export function returnToLobby() {
  return sendEndGameAction("returnToLobby", "return-to-lobby");
}

export function closeLobby() {
  const sent = sendEndGameAction("closeLobby", "close-lobby");
  if (sent) disableReconnect("room-closed");
  return sent;
}

export function leaveLobby() {
  const sent = sendEndGameAction("leaveLobby", "leave-lobby");
  if (sent) disableReconnect("explicit-leave");
  return sent;
}

export function setEndGameActionState(disabled) {
  for (const element of [dom.restartButton, dom.returnToLobbyButton, dom.endCloseButton, dom.endLeaveButton]) {
    if (element) element.disabled = disabled;
  }
}

function sendEndGameAction(type, action) {
  const fromEndGame = state.phase === "ended";
  if (fromEndGame && state.pendingEndGameAction) return false;
  if (fromEndGame) {
    state.pendingEndGameAction = action;
    setEndGameActionState(true);
  }
  const sent = send({ type });
  if (!sent && fromEndGame) {
    clearPendingEndGameAction();
    notify.error("End-game action could not be sent. Check your connection and try again.");
  }
  return sent;
}

export function clearPendingEndGameAction() {
  state.pendingEndGameAction = null;
  setEndGameActionState(false);
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
  state.joinedConnectionGeneration = null;
  synchronizeTelemetryFocus();
  dom.roomCode.value = "";
  dom.currentRoomCode.textContent = "----";
  dom.currentRoomCard.hidden = true;
  dom.roomLabel.textContent = "----";
  setConnectionStatus("offline", "Disconnected");
  clearMatchPanels();
  updateLobbyState();
}

export function clearMatchPanels() {
  clearPendingEndGameAction();
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
  updateLobbyState();
}

export function openSettings() {
  showMenuScreen(dom.settingsScreen);
  const prefs = loadPreferences().preferences;
  if (dom.serverUrlInput) {
    dom.serverUrlInput.value = getConfiguredServerUrl() || prefs.serverUrl;
  }
  if (dom.settingsTeamSelect) dom.settingsTeamSelect.value = prefs.preferredTeam;
  if (dom.settingsColorSelect) dom.settingsColorSelect.value = prefs.preferredColor;
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

export function closeSettings() {
  if (state.room) {
    hideMenuScreens();
    return;
  }
  openMainMenu();
}

export function saveServerSetting() {
  const value = String(dom.serverUrlInput?.value || "").trim();
  if (value) {
    persistPreferences({ ...loadPreferences().preferences, serverUrl: value });
    localStorage.setItem(LOCAL_SERVER_KEY, value);
  } else {
    clearServerSetting();
    return;
  }
  syncUrlParams();
  if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
    window.location.reload();
  }
}

export function clearServerSetting() {
  persistPreferences({ ...loadPreferences().preferences, serverUrl: "" });
  localStorage.removeItem(LOCAL_SERVER_KEY);
  if (dom.serverUrlInput) dom.serverUrlInput.value = "";
  syncUrlParams();
  if (typeof window !== "undefined" && typeof window.location?.reload === "function") {
    window.location.reload();
  }
}

export function sendRulesUpdate() {
  if (!state.room || !isAdmin() || state.phase !== "lobby") return;
  const startingMoney = Number(dom.startingMoneyInput?.value) || state.rules.startingMoney;
  const maxPlayers = Math.min(Math.max(Number(dom.maxPlayersInput?.value) || 8, 2), 8);
  const mapSize = dom.mapSizeSelect?.value || "auto";
  const gameMode = dom.gameModeSelect?.value || "teams";
  const asteroidDensity = dom.asteroidDensitySelect?.value || "medium";
  const infrastructureMode = dom.infrastructureModeSelect?.value || "stations";
  const visibilityMode = dom.visibilityModeSelect?.value || "sensors";
  send({
    type: "setRules",
    rules: { startingMoney, maxPlayers, mapSize, gameMode, asteroidDensity, infrastructureMode, visibilityMode }
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
  const value = dom.teamSelect?.value || "";
  const known = new Set(AUTHORITATIVE_TEAM_IDS);
  if (known.has(value)) return value;
  return loadPreferences().preferences.preferredTeam || "blue";
}

function colorValue() {
  const raw = String(dom.pilotColor?.value || loadPreferences().preferences.preferredColor || "").trim();
  return /^#[0-9A-Fa-f]{6}$/.test(raw) ? raw.toLowerCase() : loadPreferences().preferences.preferredColor;
}

export function setConnectionStatus(status, text) {
  if (dom.status) {
    dom.status.textContent = text;
    dom.status.className = `connection-status ${status}`;
  }
  invalidatePresentation("lobby-connection");
}

export function updateLobbyVisibility(interaction = getLobbyInteractionState()) {
  if (!isLobbyPresentationVisible()) return;
  updateLobbyConnectionState(interaction);
  updateLobbyPhaseState(interaction);
}

export function updateLobbyRules(interaction = getLobbyInteractionState()) {
  if (!isLobbyPresentationVisible()) return;
  updateLobbyRulesState(interaction);
}


if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
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
      });
    }
    if (dom.teamSelect) {
      dom.teamSelect.addEventListener("change", handleTeamSelectChange);
    }
  });
}


export function renderStorageStatus() {
  if (!dom.storageStatus) return;
  const p = categoryPresence();
  dom.storageStatus.textContent = `Present: settings ${p.settings ? "yes" : "no"}, current blueprint ${p.currentBlueprint ? "yes" : "no"}, saved blueprints ${p.savedBlueprints ? "yes" : "no"}, loadouts ${p.loadouts ? "yes" : "no"}, recoverable room ${p.recoverableRoom ? "yes" : "no"}.`;
}

function confirmAction(message, action) {
  openServerLeaveConfirmModal(() => {
    action();
    renderStorageStatus();
    renderRecoveryCard();
  }, "Confirm action", message, "Confirm");
}

export function bindSettingsRecoveryControls() {
  dom.settingsTeamSelect?.addEventListener("change", (e) => { persistPreferences({ ...loadPreferences().preferences, preferredTeam: e.target.value }); dom.teamSelect.value = e.target.value; });
  dom.settingsColorSelect?.addEventListener("change", (e) => {
    const color = String(e.target.value || "").trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(color)) {
      persistPreferences({ ...loadPreferences().preferences, preferredColor: color });
      if (dom.pilotColor) dom.pilotColor.value = color;
      if (state.room && state.socket?.readyState === WebSocket.OPEN) {
        send({ type: "setColor", color });
      }
    }
  });
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
        notify.error("This export file uses an old blueprint format without wiring and cannot be imported.");
        event.target.value = "";
        return;
      }
      state.savedDesigns = result.designs; state.loadouts = result.loadouts;
      persistSavedDesigns(state.savedDesigns); persistLoadouts(state.loadouts); renderSavedDesigns(); renderPurchaseBar();
      notify.log(`Imported ${result.acceptedDesigns ?? result.accepted} blueprints and ${result.acceptedLoadouts ?? 0} loadouts. Skipped ${result.rejectedDesigns ?? result.rejected} blueprint${(result.rejectedDesigns ?? result.rejected) === 1 ? "" : "s"} and ${result.rejectedLoadouts ?? 0} loadout${(result.rejectedLoadouts ?? 0) === 1 ? "" : "s"}.`, (result.rejectedDesigns || result.rejectedLoadouts || result.rejected) ? "warning" : "good");
    } catch { notify.error("Blueprint import file was not valid JSON"); }
    event.target.value = "";
  });
}
