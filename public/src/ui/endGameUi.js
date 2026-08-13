// Renders post-match summary boards, victory/defeat banners, and host action controls.

import { dom } from "./dom.js";
import { state } from "../state.js";
import { escapeHtml } from "../shared/formatting.js";
import { isAdmin, setEndGameActionState } from "./lobbyUi.js";

export function updateWinnerBanner() {
  const winner = state.snapshot?.winner;
  if (!winner || state.phase !== "ended") {
    dom.winner.hidden = true;
    dom.endGameScreen.hidden = true;
    if (dom.showEndGameButton) dom.showEndGameButton.hidden = true;
    dom.endGameSummary.dataset.reportRendered = "";
    return;
  }
  dom.winner.hidden = false;
  dom.winner.textContent = `${winner.name} won`;

  if (!dom.showEndGameButton || dom.showEndGameButton.hidden !== false || !dom.endGameScreen.hidden) {
    dom.endGameScreen.hidden = state.endGameMinimized === true;
    if (dom.showEndGameButton) dom.showEndGameButton.hidden = !dom.endGameScreen.hidden;
  }

  dom.endGameTitle.textContent = `${winner.name} won`;
  dom.endGameTitle.dataset.team = winner.team || "";
  if (!dom.endGameSummary.dataset.reportRendered) {
    dom.endGameSummary.dataset.reportRendered = "1";
    dom.endGameSummary.innerHTML = renderBattleReport();
    dom.endGameSummary.addEventListener("click", onReportRowClick);
  }
  const admin = isAdmin();
  dom.endGameActions.hidden = false;
  dom.restartButton.hidden = !admin;
  if (dom.returnToLobbyButton) dom.returnToLobbyButton.hidden = !admin;
  dom.endCloseButton.hidden = !admin;
  if (dom.endLeaveButton) dom.endLeaveButton.hidden = false;
  setEndGameActionState(Boolean(state.pendingEndGameAction));
}

function formatTime(ms) {
  if (!ms || ms < 0) return "0:00";
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatNumber(n) {
  return Math.floor(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function onReportRowClick(event) {
  const row = event.target.closest("tr.report-player-row");
  if (!row) return;
  const detail = row.nextElementSibling;
  if (detail && detail.classList.contains("report-detail-row")) {
    detail.hidden = !detail.hidden;
  }
}

function renderPlayerDetails(player) {
  return `<tr class="report-detail-row" hidden>
    <td colspan="9" class="report-detail-cell">
      <div class="report-detail-grid">
        <div class="report-detail-section">
          <h5>Combat</h5>
          <dl>
            <dt>Damage dealt</dt><dd>${formatNumber(player.damageDealt)}</dd>
            <dt>Shield damage</dt><dd>${formatNumber(player.shieldDamageDealt)}</dd>
            <dt>Components destroyed</dt><dd>${formatNumber(player.componentsDestroyed)}</dd>
            <dt>Missiles intercepted</dt><dd>${formatNumber(player.missilesIntercepted)}</dd>
          </dl>
        </div>
        <div class="report-detail-section">
          <h5>Support</h5>
          <dl>
            <dt>Hull repaired</dt><dd>${formatNumber(player.hullRepaired)}</dd>
            <dt>Shield restored</dt><dd>${formatNumber(player.shieldRestored)}</dd>
          </dl>
        </div>
        <div class="report-detail-section">
          <h5>Fleet</h5>
          <dl>
            <dt>Ships deployed</dt><dd>${formatNumber(player.shipsBuilt)}</dd>
            <dt>Ships lost</dt><dd>${formatNumber(player.losses)}</dd>
            <dt>Fleet value lost</dt><dd>$${formatNumber(player.lostFleetCost)}</dd>
          </dl>
        </div>
      </div>
    </td>
  </tr>`;
}

function teamReportClass(team) {
  if (team === "blue" || team === "red") return `report-team-${team}`;
  return "report-team-neutral";
}

function teamReportLabel(players, team, soloMode) {
  if (soloMode) return players[0]?.name || "Pilot";
  const namedPlayer = players.find((player) => player.teamName);
  if (namedPlayer) return namedPlayer.teamName;
  const fallback = String(team || "Unknown");
  return `${fallback.charAt(0).toUpperCase()}${fallback.slice(1)} wing`;
}

function groupedReportPlayers(players, soloMode, winningTeam) {
  const groups = new Map();
  for (const player of players) {
    const key = soloMode ? player.id : (player.team || "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(player);
  }
  return [...groups.entries()].sort(([left], [right]) => {
    if (!soloMode && left === winningTeam) return -1;
    if (!soloMode && right === winningTeam) return 1;
    return String(left).localeCompare(String(right));
  });
}

function renderBattleReport() {
  const snapshot = state.snapshot;
  if (!snapshot) return "";

  const mine = state.mine;
  const soloMode = (snapshot.rules?.gameMode || state.rules?.gameMode) === "solo";
  const winner = snapshot.winner;
  const matchDuration = snapshot.matchStartedAt ? snapshot.time - snapshot.matchStartedAt : 0;
  let html = `<div class="battle-report">`;
  html += `<div class="report-duration">Match duration: ${formatTime(matchDuration)}</div>`;

  html += `<table class="report-table">
    <thead>
      <tr>
        <th>Pilot</th>
        <th>Kills</th>
        <th>Losses</th>
        <th>Built</th>
        <th>Earned</th>
        <th>Spent</th>
        <th>Destroyed $</th>
        <th>Lost $</th>
        <th>Captures</th>
      </tr>
    </thead>`;

  let mostCaptures = null;
  let mostKills = null;
  let mostEfficient = null;

  for (const [team, players] of groupedReportPlayers(snapshot.players || [], soloMode, winner?.team)) {
    const won = soloMode ? winner?.id === team : winner?.team === team;
    const teamClass = teamReportClass(soloMode ? "neutral" : team);
    const label = teamReportLabel(players, team, soloMode);
    html += `<tbody class="report-team ${teamClass}${won ? " report-team-winner" : ""}" data-report-team="${escapeHtml(String(team))}">
      <tr class="report-team-heading">
        <th colspan="9" scope="rowgroup">
          <span>${escapeHtml(label)}</span>
          <small>${won ? "Winner" : `${players.length} pilot${players.length === 1 ? "" : "s"}`}</small>
        </th>
      </tr>`;

    for (const player of players) {
      const isMe = mine && mine.id === player.id;
      const rowClass = isMe ? "report-player-row report-row-me" : "report-player-row";
      html += `<tr class="${rowClass}" style="color: #ffffff">
        <td style="color: ${player.color}">${escapeHtml(player.name)}</td>
        <td>${player.kills || 0}</td>
        <td>${player.losses || 0}</td>
        <td>${player.shipsBuilt || 0}</td>
        <td>$${player.earned || 0}</td>
        <td>$${player.spent || 0}</td>
        <td>$${player.destroyedEnemyCost || 0}</td>
        <td>$${player.lostFleetCost || 0}</td>
        <td>${player.captures || 0}</td>
      </tr>`;
      html += renderPlayerDetails(player);

      if (!mostCaptures || player.captures > mostCaptures.captures) mostCaptures = player;
      if (!mostKills || player.kills > mostKills.kills) mostKills = player;

      if (player.destroyedEnemyCost > 0 || player.lostFleetCost > 0) {
        const efficiency = (player.destroyedEnemyCost || 0) - (player.lostFleetCost || 0);
        if (!mostEfficient || efficiency > mostEfficient.eff) {
          mostEfficient = { player, eff: efficiency };
        }
      }
    }
    html += `</tbody>`;
  }

  html += `</table>`;

  html += `<div class="report-highlights">
    <h4>Highlights</h4>
    <ul>`;
  if (mostKills && mostKills.kills > 0) {
    html += `<li><strong>Most Kills:</strong> ${escapeHtml(mostKills.name)} (${mostKills.kills})</li>`;
  }
  if (mostCaptures && mostCaptures.captures > 0) {
    html += `<li><strong>Most Captures:</strong> ${escapeHtml(mostCaptures.name)} (${mostCaptures.captures})</li>`;
  }
  if (mostEfficient && mostEfficient.eff > 0) {
    html += `<li><strong>Most Efficient:</strong> ${escapeHtml(mostEfficient.player.name)} (+$${mostEfficient.eff})</li>`;
  }
  html += `</ul></div>`;

  if (!isAdmin()) {
    html += `<div class="report-wait">Waiting for the room admin to restart or close the lobby.</div>`;
  }

  html += `</div>`;
  return html;
}
