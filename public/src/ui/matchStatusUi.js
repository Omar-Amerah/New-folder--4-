// Visualizes relay control, the victory countdown, player status, and activity.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { escapeHtml } from "../shared/formatting.js";
import { isAdmin } from "./lobbyUi.js";

// Snapshots arrive frequently, so steady-state updates are diffed before DOM writes.
let lastPlayerStatusHtml = null;

export function renderMatchStatus() {
  if (!state.snapshot) return;
  const players = [...state.snapshot.players].sort((a, b) => {
    const teamOrder = String(a.team || "").localeCompare(String(b.team || ""));
    return teamOrder || String(a.name || "").localeCompare(String(b.name || ""));
  });

  const html = generateMatchStatusHTML(players);
  if (dom.playerStatusList && html !== lastPlayerStatusHtml) {
    lastPlayerStatusHtml = html;
    dom.playerStatusList.innerHTML = html;
  }

  updateRelayControlMeter(players);
}

export function generateMatchStatusHTML(players) {
  let html = "";
  const pMap = playerMap();
  const lines = state.snapshot.points.map((point) => {
    const owner = point.ownerId ? pMap.get(point.ownerId) : null;
    const ownerName = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
    return `${point.id}: ${ownerName} ${Math.round(point.progress * 100)}%`;
  });

  if (lines.length) {
    html += `<div class="objective-summary">${escapeHtml(lines.join(" | "))}</div>`;
  }

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
      html += `<div class="team-player empty">Empty slot</div>`;
    }

    for (const player of teamPlayers) {
      const status = player.ready ? "Ready" : state.phase === "design" ? "Building" : player.connected === false ? "Disconnected" : "In match";
      const canKick = isAdmin() && player.id !== state.myId && !player.isAdmin && (state.phase === "lobby" || state.phase === "design");
      const infoItems = [];
      if (player.money != null) infoItems.push(`$${player.money}`);
      infoItems.push(`${player.activeShips} ship${player.activeShips === 1 ? "" : "s"}`);
      infoItems.push(`${player.captures} capture${player.captures === 1 ? "" : "s"}`);

      html += `
        <div class="team-player${player.id === state.myId ? " mine" : ""}">
          <span class="player-color" style="background:${player.color}"></span>
          <div class="team-player-body">
            <div class="team-player-main">
              <strong>${escapeHtml(player.name)}${player.isAdmin ? " [Host]" : ""}${player.isBot ? " CPU" : ""}</strong>
              <span class="team-player-status">${status}</span>
            </div>
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
    rightColor = "#ff5555";
    for (const [playerId, count] of Object.entries(objectiveControl.players)) {
      if (playerId !== state.myId) rightCount += count;
    }
  } else {
    leftName = "Wing Blue";
    leftColor = "var(--cyan)";
    leftCount = objectiveControl.teams.blue || 0;
    rightName = "Wing Red";
    rightColor = "var(--amber)";
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
  const players = state.snapshot?.players || [];
  if (playerMapCacheFor !== players) {
    playerMapCacheFor = players;
    playerMapCache = new Map(players.map((player) => [player.id, player]));
  }
  return playerMapCache;
}
