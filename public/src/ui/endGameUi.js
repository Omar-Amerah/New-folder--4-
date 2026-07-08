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
    return;
  }
  dom.winner.hidden = false;
  dom.winner.textContent = `${winner.name} won`;
  dom.endGameScreen.hidden = false;
  dom.endGameTitle.textContent = `${winner.name} won`;
  dom.endGameSummary.innerHTML = renderBattleReport();
  const admin = isAdmin();
  dom.endGameActions.hidden = false;
  dom.restartButton.hidden = !admin;
  if (dom.returnToLobbyButton) dom.returnToLobbyButton.hidden = !admin;
  dom.endCloseButton.hidden = !admin;
  if (dom.endLeaveButton) dom.endLeaveButton.hidden = false;
  setEndGameActionState(false);

  dom.restartButton.disabled = false;
  if (dom.returnToLobbyButton) dom.returnToLobbyButton.disabled = false;
  dom.endCloseButton.disabled = false;
  if (dom.endLeaveButton) dom.endLeaveButton.disabled = false;

  console.log("updateWinnerBanner admin=", admin);
  console.log("dom.returnToLobbyButton.hidden=", dom.returnToLobbyButton?.hidden);
}

function formatTime(ms) {
  if (!ms || ms < 0) return "0:00";
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function renderBattleReport() {
  const snapshot = state.snapshot;
  if (!snapshot) return "";

  const mine = state.mine;
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
    </thead>
    <tbody>`;

  let mostCaptures = null;
  let mostKills = null;
  let mostEfficient = null;

  for (const player of snapshot.players) {
    const isMe = mine && mine.id === player.id;
    const rowClass = isMe ? "report-row-me" : "";
    html += `<tr class="${rowClass}" style="color: ${player.color}">
      <td>${escapeHtml(player.name)}</td>
      <td>${player.kills || 0}</td>
      <td>${player.losses || 0}</td>
      <td>${player.shipsBuilt || 0}</td>
      <td>$${player.earned || 0}</td>
      <td>$${player.spent || 0}</td>
      <td>$${player.destroyedEnemyCost || 0}</td>
      <td>$${player.lostFleetCost || 0}</td>
      <td>${player.captures || 0}</td>
    </tr>`;

    if (!mostCaptures || player.captures > mostCaptures.captures) mostCaptures = player;
    if (!mostKills || player.kills > mostKills.kills) mostKills = player;

    if (player.destroyedEnemyCost > 0 || player.lostFleetCost > 0) {
      const efficiency = (player.destroyedEnemyCost || 0) - (player.lostFleetCost || 0);
      if (!mostEfficient || efficiency > mostEfficient.eff) {
        mostEfficient = { player, eff: efficiency };
      }
    }
  }

  html += `</tbody></table>`;

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
