// Visualizes relay control, the victory countdown, player status, and activity.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { escapeHtml } from "../shared/formatting.js";
import { isAdmin } from "./lobbyUi.js";
import { updateWinnerBanner } from "./endGameUi.js";

// Snapshots arrive frequently, so steady-state updates are diffed before DOM writes.
let lastPlayerStatusHtml = null;
let lastRelayChipsHtml = null;

function bump(name) {
  const diagnostics = state.presentationDiagnostics;
  if (!diagnostics) return;
  diagnostics[name] = (diagnostics[name] || 0) + 1;
  diagnostics.matchStatusUpdateCount += 1;
}

function sortedPlayers() {
  return [...(state.snapshot?.players || [])].sort((a, b) => {
    const teamOrder = String(a.team || "").localeCompare(String(b.team || ""));
    return teamOrder || String(a.name || "").localeCompare(String(b.name || ""));
  });
}

export function updateScoreboardStatus() {
  bump("scoreboardStatusUpdateCount");
  if (!state.snapshot) return;
  const players = sortedPlayers();
  const html = generateMatchStatusHTML(players);
  if (dom.playerStatusList && html !== lastPlayerStatusHtml) {
    lastPlayerStatusHtml = html;
    dom.playerStatusList.innerHTML = html;
  }
}

export function updateControlVictoryStatus() {
  bump("controlVictoryStatusUpdateCount");
  if (!state.snapshot) return;
  const players = sortedPlayers();
  updateRelayControlMeter(players);
}

export function updateRelayStatus() {
  bump("relayStatusUpdateCount");
  if (!state.snapshot) return;
  const players = sortedPlayers();
  const relayChipsHtml = generateRelayChipsHTML(players);
  if (dom.relayChips && relayChipsHtml !== lastRelayChipsHtml) {
    lastRelayChipsHtml = relayChipsHtml;
    dom.relayChips.innerHTML = relayChipsHtml;
  }
}

export function updateWinnerStatus() {
  const diagnostics = state.presentationDiagnostics;
  if (diagnostics) diagnostics.winnerUpdateCount += 1;
  updateWinnerBanner();
}

export function renderMatchStatus() {
  updateScoreboardStatus();
  updateRelayStatus();
  updateControlVictoryStatus();
  updateWinnerStatus();
}

export function generateMatchStatusHTML(players) {
  let html = "";
  const soloMode = state.rules?.gameMode === "solo";
  const teams = soloMode ? players.map((player) => player.team) : ["blue", "red"];
  for (const team of teams) {
    const teamPlayers = players.filter((player) => player.team === team);
    const objectives = state.snapshot.points.filter((point) => point.ownerTeam === team && point.progress > 0.98);
    const title = soloMode
      ? (teamPlayers[0]?.name || "Solo")
      : `${team.toUpperCase()} TEAM`;

    html += `<div class="team-card ${soloMode ? "solo" : team}">
      <div class="team-card-head">
        <strong>${escapeHtml(title)}</strong>
      </div>
      <div class="team-objectives">Relays: ${objectives.length ? escapeHtml(objectives.map((point) => point.id).join(", ")) : "None"}</div>`;

    if (!soloMode && !teamPlayers.length) {
      html += `<div class="team-empty">Empty slot</div>`;
    }

    for (const player of teamPlayers) {
      const showReady = player.ready && state.phase !== "active";
      const status = showReady ? "Ready" : state.phase === "design" ? "Building" : state.phase === "lobby" ? "In lobby" : player.connected === false ? "Disconnected" : "In match";
      const statusClass = showReady ? "ready" : state.phase === "design" ? "building" : state.phase === "lobby" ? "lobby" : player.connected === false ? "disconnected" : "in-match";
      const canKick = isAdmin() && player.id !== state.myId && !player.isAdmin && (state.phase === "lobby" || state.phase === "design");
      const infoItems = [];
      infoItems.push(`${player.activeShips} ship${player.activeShips === 1 ? "" : "s"}`);
      infoItems.push(`${player.captures} capture${player.captures === 1 ? "" : "s"}`);

      html += `
        <div class="team-player${player.id === state.myId ? " mine" : ""}">
          <span class="player-color" style="background:${player.color}"></span>
          <div class="team-player-body">
            <strong>${escapeHtml(player.name)}${player.isAdmin ? " [Host]" : ""}${player.isBot ? " CPU" : ""}</strong>
            <span class="team-player-status ${statusClass}">${status}</span>
            <div class="team-player-metrics">
              ${infoItems.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
              <span>K ${player.kills} / L ${player.losses}</span>
            </div>
          </div>
          ${canKick ? `<button type="button" data-kick="${escapeHtml(player.id)}">Kick</button>` : ""}
        </div>
      `;
    }
    html += `</div>`;
  }
  return html;
}

function generateRelayChipsHTML(players) {
  const pMap = playerMap();
  const snapshot = state.snapshot;
  let targets = [];
  if (snapshot?.points?.length) {
    targets = snapshot.points.map((point) => ({
      id: point.id,
      contested: point.contested,
      progress: point.progress || 0,
      ownerId: point.ownerId,
      ownerTeam: point.ownerTeam
    }));
  } else if (snapshot?.stations?.length) {
    targets = snapshot.stations
      .filter((station) => station.stationType === "relay")
      .map((station) => ({
        id: station.id,
        contested: station.captureContested,
        progress: station.captureProgress || 0,
        ownerId: station.ownerId,
        ownerTeam: station.team
      }));
  }
  if (!targets.length) return "";

  const chips = targets.map((target) => {
    const owner = target.ownerId ? pMap.get(target.ownerId) : null;
    let ownerClass = "neutral";
    let color = "var(--faint)";
    let label = "Neutral";
    if (target.contested) {
      ownerClass = "contested";
      color = "var(--amber)";
      label = "Contested";
    } else if (owner) {
      ownerClass = owner.team || "neutral";
      color = owner.team === "blue" ? "var(--cyan)" : owner.team === "red" ? "var(--red)" : (owner.color || "var(--faint)");
      label = owner.teamName || owner.name;
    }
    const pct = Math.round(target.progress * 100);
    return `<div class="relay-chip ${escapeHtml(ownerClass)}" title="${escapeHtml(target.id)}: ${escapeHtml(label)} ${pct}%">
      <span class="relay-letter">${escapeHtml(target.id)}</span>
      <span class="relay-fill" style="width:${pct}%; background:${escapeHtml(color)}"></span>
      <span class="relay-pct">${pct}%</span>
    </div>`;
  });
  return `<div class="relay-chips-row" aria-label="Relay capture status">${chips.join("")}</div>`;
}

let relayControlMeterView = null;
let lastRelaySummaryHtml = null;

function ensureRelayControlMeterView() {
  const host = dom.matchProgressFill;
  if (!host) return null;
  if (relayControlMeterView?.host === host) return relayControlMeterView;
  host.style.display = "flex";
  host.style.width = "100%";
  host.style.height = "100%";
  host.style.background = "none";
  host.style.borderRadius = "inherit";
  host.innerHTML = `
    <span style="display:block; height:100%; transition:width 180ms ease;"></span>
    <span style="display:block; height:100%; background:rgba(255, 255, 255, 0.07); transition:width 180ms ease;"></span>
    <span style="display:block; height:100%; transition:width 180ms ease;"></span>
  `;
  const spans = host.querySelectorAll("span");
  relayControlMeterView = { host, left: spans[0], center: spans[1], right: spans[2], key: null };
  return relayControlMeterView;
}

export function updateRelayControlMeter(players) {
  if (!state.snapshot) return;

  const snapshot = state.snapshot;
  const points = snapshot.points || [];
  if (!points.length) {
    if (lastRelaySummaryHtml !== "No active match") {
      lastRelaySummaryHtml = "No active match";
      relayControlMeterView = null;
      dom.matchProgressFill.style.width = "0%";
      dom.matchSummary.textContent = "No active match";
    }
    return;
  }

  const objectiveControl = snapshot.objectiveControl || {
    total: points.length,
    neutral: 0,
    contested: 0,
    teams: {},
    players: {}
  };
  const soloMode = snapshot.rules?.gameMode === "solo";

  let leftName = "";
  let rightName = "";
  let leftColor = "";
  let rightColor = "";
  let leftCount = 0;
  let rightCount = 0;

  if (soloMode) {
    const me = players.find((player) => player.id === state.myId);
    leftName = me ? me.name : "Me";
    leftColor = me ? me.color || "#00f0ff" : "#00f0ff";
    leftCount = objectiveControl.players[state.myId] || 0;
    rightName = "Others";
    for (const [playerId, count] of Object.entries(objectiveControl.players)) {
      if (playerId !== state.myId) rightCount += count;
    }
    if (rightCount > 0) {
      const pMap = playerMap();
      const others = Object.entries(objectiveControl.players)
        .filter(([playerId]) => playerId !== state.myId)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      let acc = 0;
      const stops = [];
      for (const [playerId, count] of others) {
        const start = acc;
        acc += (count / rightCount) * 100;
        const color = pMap.get(playerId)?.color || "#ff5555";
        stops.push(`${color} ${start.toFixed(2)}%`);
        stops.push(`${color} ${acc.toFixed(2)}%`);
      }
      rightColor = stops.length ? `linear-gradient(90deg, ${stops.join(", ")})` : "#ff5555";
    } else {
      rightColor = "#ff5555";
    }
  } else {
    leftName = "Wing Blue";
    leftColor = "var(--cyan)";
    leftCount = objectiveControl.teams.blue || 0;
    rightName = "Wing Red";
    rightColor = "var(--red)";
    rightCount = objectiveControl.teams.red || 0;
  }

  const total = objectiveControl.total || points.length;
  const contested = objectiveControl.contested || 0;
  const leftPercent = (leftCount / total) * 100;
  const rightPercent = (rightCount / total) * 100;
  const centerPercent = Math.max(0, 100 - leftPercent - rightPercent);

  const meter = ensureRelayControlMeterView();
  if (meter) {
    const key = `${leftColor}|${rightColor}|${leftPercent}|${rightPercent}`;
    if (meter.key !== key) {
      meter.key = key;
      meter.left.style.background = leftColor;
      meter.left.style.width = `${leftPercent}%`;
      meter.center.style.width = `${centerPercent}%`;
      meter.right.style.background = rightColor;
      meter.right.style.width = `${rightPercent}%`;
    }
  }

  let summaryText = soloMode
    ? `${leftName} controls ${leftCount}/${total} relays.`
    : `${leftName}: ${leftCount}/${total} | ${rightName}: ${rightCount}/${total}`;
  if (contested > 0) {
    summaryText += soloMode
      ? ` ${contested} relay${contested === 1 ? "" : "s"} contested.`
      : ` | ${contested} contested`;
  }

  const controlVictory = snapshot.controlVictory;
  if (controlVictory?.active) {
    const seconds = Math.ceil(controlVictory.remaining);
    const winnerName = soloMode
      ? players.find((player) => player.id === controlVictory.playerId)?.name || "Pilot"
      : controlVictory.team === "blue" ? "Wing Blue" : "Wing Red";
    summaryText += `<div class="control-countdown" style="margin-top: 6px; color: #ffca57; font-weight: 800;">Victory for ${escapeHtml(winnerName)} in ${seconds}s</div>`;
  } else {
    summaryText += `<div class="control-instructions" style="margin-top: 6px; color: var(--muted); font-size: 11px;">Control all relays for 20s to win.</div>`;
  }

  if (summaryText !== lastRelaySummaryHtml) {
    lastRelaySummaryHtml = summaryText;
    dom.matchSummary.innerHTML = summaryText;
  }
}

let playerMapCache = null;
let playerMapCacheFor = null;
export function playerMap() {
  const indexed = state.snapshotIndex?.playerById;
  if (indexed) return indexed;
  const players = state.snapshot?.players || [];
  if (playerMapCacheFor !== players) {
    playerMapCacheFor = players;
    playerMapCache = new Map(players.map((player) => [player.id, player]));
  }
  return playerMapCache;
}
