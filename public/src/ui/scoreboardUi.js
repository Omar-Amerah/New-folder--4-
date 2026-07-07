// Visualizes overall match scores, progress bars, player indicators, and activity logs.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { escapeHtml } from "../shared/formatting.js";
import { clamp } from "../shared/math.js";
import { isAdmin } from "./lobbyUi.js";

export function renderScoreboard() {
  if (!state.snapshot) return;
  const players = [...state.snapshot.players].sort((a, b) => b.score - a.score);
  dom.scoreList.textContent = "";
  updateMatchMeter(players);
  renderObjectiveSummary();
  renderTeamPanel(players);
}

export function renderObjectiveSummary() {
  const players = playerMap();
  const lines = state.snapshot.points.map((point) => {
    const owner = point.ownerId ? players.get(point.ownerId) : null;
    const ownerName = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
    return `${point.id}: ${ownerName} ${Math.round(point.progress * 100)}%`;
  });
  if (lines.length) {
    const row = document.createElement("div");
    row.className = "objective-summary";
    row.textContent = lines.join(" | ");
    dom.scoreList.appendChild(row);
  }
}

export function renderTeamPanel(players) {
  const soloMode = state.rules?.gameMode === "solo";
  const teams = soloMode ? players.map((player) => player.team) : ["blue", "red"];
  for (const team of teams) {
    const teamPlayers = players.filter((player) => player.team === team);
    const score = Math.max(0, ...teamPlayers.map((player) => player.score || 0));
    const objectives = state.snapshot.points.filter((point) => point.ownerTeam === team && point.progress > 0.98);
    const pointsPerSecond = objectives.length * 7;
    const title = soloMode
      ? (teamPlayers[0]?.name || "Solo")
      : `${team.toUpperCase()} TEAM`;
    const card = document.createElement("div");
    card.className = `team-card ${soloMode ? "solo" : team}`;
    card.innerHTML = `
      <div class="team-card-head">
        <strong>${escapeHtml(title)}</strong>
        <span>${score}/${state.snapshot.maxScore || 900} (+${pointsPerSecond}/s)</span>
      </div>
      <div class="team-objectives">Objectives: ${objectives.length ? objectives.map((point) => point.id).join(", ") : "None"}</div>
    `;

    if (!soloMode && !teamPlayers.length) {
      const empty = document.createElement("div");
      empty.className = "team-player empty";
      empty.textContent = "Empty slot";
      card.appendChild(empty);
    }

    for (const player of teamPlayers) {
      const row = document.createElement("div");
      row.className = `team-player${player.id === state.myId ? " mine" : ""}`;
      const status = player.ready ? "Ready" : state.phase === "design" ? "Building" : player.connected === false ? "Disconnected" : "In match";
      const canKick = isAdmin() && player.id !== state.myId && !player.isAdmin;
      const infoItems = [];
      if (player.money != null) infoItems.push(`$${player.money}`);
      infoItems.push(`${player.activeShips} ship${player.activeShips === 1 ? "" : "s"}`);
      infoItems.push(`${player.score}/${state.snapshot.maxScore || 900}`);
      row.innerHTML = `
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
      `;
      card.appendChild(row);
    }
    dom.scoreList.appendChild(card);
  }
}

export function updateMatchMeter(players) {
  if (!players.length) {
    dom.matchProgressFill.style.width = "0%";
    dom.matchSummary.textContent = "No active match";
    return;
  }

  const maxScore = state.snapshot.maxScore || 900;
  const leader = players[0];
  const progress = clamp(leader.score / maxScore * 100, 0, 100);
  const mapName = state.snapshot.map?.name ? `${state.snapshot.map.name} | ` : "";
  dom.matchProgressFill.style.width = `${progress}%`;
  dom.matchSummary.textContent = `${mapName}${leader.name} leads ${leader.score}/${maxScore}`;
}

export function playerMap() {
  return new Map((state.snapshot?.players || []).map((player) => [player.id, player]));
}
