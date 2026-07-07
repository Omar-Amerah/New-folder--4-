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
  const mine = state.snapshot?.players?.find((player) => player.id === state.myId);
  dom.endGameSummary.innerHTML = rewardSummaryMarkup(mine?.lastReward, mine?.money);
  const admin = isAdmin();
  dom.endGameActions.hidden = false;
  dom.restartButton.hidden = !admin;
  dom.endCloseButton.hidden = !admin;
  if (dom.endLeaveButton) dom.endLeaveButton.hidden = admin;
  setEndGameActionState(false);
}

function rewardSummaryMarkup(reward, money) {
  if (!reward) {
    return escapeHtml(isAdmin()
      ? "Restart sends everyone back to ship design with a new generated map."
      : "Waiting for the room admin to restart or close the lobby.");
  }
  const title = reward.didWin ? "Battle Result: Victory" : "Battle Result: Defeat";
  const lines = reward.didWin
    ? [
        ["Base reward", reward.base],
        ["Enemy destroyed", reward.destroyed],
        ["Victory bonus", reward.victory],
        ["Survival bonus", reward.survival],
        ["Efficiency bonus", reward.efficiency]
      ]
    : [
        ["Loss support", reward.lossSupport],
        ["Enemy destroyed", reward.destroyed]
      ];
  const penalty = reward.didWin && reward.overpowerMultiplier < 1
    ? `<li>Overpowered fleet penalty applied: ${Math.round(reward.overpowerMultiplier * 100)}% victory bonus</li>`
    : "";
  return `
    <span>${escapeHtml(title)}</span>
    <ul class="reward-list">
      ${lines.map(([label, value]) => `<li>${escapeHtml(label)}: $${Math.round(value || 0)}</li>`).join("")}
      ${penalty}
      <li><strong>Total earned: $${Math.round(reward.total || 0)}</strong></li>
      <li>New balance: $${Math.floor(money || 0)}</li>
    </ul>
  `;
}
