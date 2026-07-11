// Visualizes overall match scores, progress bars, player indicators, and activity logs.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { escapeHtml } from "../shared/formatting.js";
import { clamp } from "../shared/math.js";
import { isAdmin } from "./lobbyUi.js";

export function renderScoreboard() {
  if (!state.snapshot) return;
  const players = [...state.snapshot.players].sort((a, b) => b.score - a.score);
  
  const html = generateScoreboardHTML(players);
  if (dom.scoreList && dom.scoreList.innerHTML !== html) {
    dom.scoreList.innerHTML = html;
  }
  
  updateMatchMeter(players);
}

export function generateScoreboardHTML(players) {
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
    const score = Math.max(0, ...teamPlayers.map((player) => player.score || 0));
    const objectives = state.snapshot.points.filter((point) => point.ownerTeam === team && point.progress > 0.98);
    const title = soloMode
      ? (teamPlayers[0]?.name || "Solo")
      : `${team.toUpperCase()} TEAM`;

    html += `<div class="team-card ${soloMode ? "solo" : team}">
      <div class="team-card-head">
        <strong>${escapeHtml(title)}</strong>
        <span>Battle score: ${score}</span>
      </div>
      <div class="team-objectives">Objectives: ${objectives.length ? escapeHtml(objectives.map((point) => point.id).join(", ")) : "None"}</div>`;

    if (!soloMode && !teamPlayers.length) {
      html += `<div class="team-player empty">Empty slot</div>`;
    }

    for (const player of teamPlayers) {
      const status = player.ready ? "Ready" : state.phase === "design" ? "Building" : player.connected === false ? "Disconnected" : "In match";
      const canKick = isAdmin() && player.id !== state.myId && !player.isAdmin && (state.phase === "lobby" || state.phase === "design");
      const infoItems = [];
      if (player.money != null) infoItems.push(`$${player.money}`);
      infoItems.push(`${player.activeShips} ship${player.activeShips === 1 ? "" : "s"}`);
      infoItems.push(`Score: ${player.score}`);

      html += `
        <div class="team-player${player.id === state.myId ? " mine" : ""}">
          <span class="score-color" style="background:${player.color}"></span>
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

export function renderObjectiveSummary() {}
export function renderTeamPanel(players) {}

export function updateMatchMeter(players) {
  if (!state.snapshot) return;

  const snapshot = state.snapshot;
  const points = snapshot.points || [];
  if (!points.length) {
    dom.matchProgressFill.style.width = "0%";
    dom.matchSummary.textContent = "No active match";
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
    const me = players.find(p => p.id === state.myId);
    leftName = me ? me.name : "Me";
    leftColor = me ? me.color || "#00f0ff" : "#00f0ff";
    leftCount = objectiveControl.players[state.myId] || 0;

    rightName = "Others";
    rightColor = "#ff5555";
    rightCount = 0;
    for (const [pid, count] of Object.entries(objectiveControl.players)) {
      if (pid !== state.myId) {
        rightCount += count;
      }
    }
  } else {
    leftName = "Wing Blue";
    leftColor = "var(--cyan)";
    leftCount = objectiveControl.teams["blue"] || 0;

    rightName = "Wing Red";
    rightColor = "var(--amber)";
    rightCount = objectiveControl.teams["red"] || 0;
  }

  const total = objectiveControl.total || points.length;
  const contested = objectiveControl.contested || 0;

  const leftPercent = (leftCount / total) * 100;
  const rightPercent = (rightCount / total) * 100;
  const centerPercent = 100 - leftPercent - rightPercent;

  dom.matchProgressFill.style.display = "flex";
  dom.matchProgressFill.style.width = "100%";
  dom.matchProgressFill.style.height = "100%";
  dom.matchProgressFill.style.background = "none";
  dom.matchProgressFill.style.borderRadius = "inherit";

  dom.matchProgressFill.innerHTML = `
    <span style="display:block; height:100%; background:${leftColor}; width:${leftPercent}%; transition:width 180ms ease;"></span>
    <span style="display:block; height:100%; background:rgba(255, 255, 255, 0.07); width:${centerPercent}%; transition:width 180ms ease;"></span>
    <span style="display:block; height:100%; background:${rightColor}; width:${rightPercent}%; transition:width 180ms ease;"></span>
  `;

  let summaryText = "";
  if (soloMode) {
    summaryText = `${leftName} controls ${leftCount}/${total} relays.`;
    if (contested > 0) {
      summaryText += ` ${contested} relay${contested === 1 ? "" : "s"} contested.`;
    }
  } else {
    summaryText = `${leftName}: ${leftCount}/${total} | ${rightName}: ${rightCount}/${total}`;
    if (contested > 0) {
      summaryText += ` | ${contested} contested`;
    }
  }
  
  const controlVictory = snapshot.controlVictory;
  if (controlVictory && controlVictory.active) {
    const sec = Math.ceil(controlVictory.remaining);
    const winTeamName = soloMode ? "" : (controlVictory.team === "blue" ? "Wing Blue" : "Wing Red");
    
    if (soloMode) {
      summaryText += `<div class="control-countdown" style="margin-top: 6px; color: #ffca57; font-weight: 800;">Control all relays to win instantly.</div>`;
    } else {
      summaryText += `<div class="control-countdown" style="margin-top: 6px; color: #ffca57; font-weight: 800;">Victory for ${winTeamName} in ${sec}s</div>`;
    }
  } else {
    if (soloMode) {
      summaryText += `<div class="control-instructions" style="margin-top: 6px; color: var(--muted); font-size: 11px;">Control all relays to win instantly.</div>`;
    } else {
      summaryText += `<div class="control-instructions" style="margin-top: 6px; color: var(--muted); font-size: 11px;">Control all relays for 20s to win.</div>`;
    }
  }

  dom.matchSummary.innerHTML = summaryText;
}

export function playerMap() {
  return new Map((state.snapshot?.players || []).map((player) => [player.id, player]));
}
