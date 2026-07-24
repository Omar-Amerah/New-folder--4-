// Controls capture point states, capture progress increments, capture rewards, and game score updates.

const { ECONOMY, SCORE_PER_CONTROLLED_POINT } = require("./config");
const { BALANCE } = require("./balanceConfig");
const { effectiveComponentBonus } = require("./heat");

// ---------------------------------------------------------------------------
// Authoritative side scoring
//
// Objective score (relay captures + periodic relay-control income) belongs to a
// SIDE, not to individual players, so a larger team can never earn objective
// score faster than a smaller one. In team mode the authoritative store is a
// single room-level total per team (`room.teamScores`); in solo mode each
// player is their own side and keeps their per-player `player.score` (which, in
// solo, also includes personal combat score — solo scoring is unchanged).
//
// Decision — does personal combat score feed the shared team score?  NO. In
// team mode the shared team score is objective-only. Personal combat score
// (kills) still accrues on `player.score` as an individual statistic but does
// NOT contribute to the team total used by the scoreboard or victory checks, so
// team score stays strictly independent of team size. Solo mode is per-player,
// so combat score continues to count toward that player's own side score.
//
// Because the team total lives on the room (not summed from player records),
// joining / disconnecting / kicking / reconnecting can never duplicate or erase
// existing team score.
// ---------------------------------------------------------------------------

function isSoloMode(room) {
  return room.rules?.gameMode === "solo";
}

function ensureTeamScores(room) {
  if (!room.teamScores || typeof room.teamScores !== "object") room.teamScores = {};
  return room.teamScores;
}

function resetTeamScores(room) {
  room.teamScores = {};
}

// Add objective score to a side exactly once. In solo mode the side is a player
// id and the score lands on that player; in team mode it lands on the shared
// team total.
function addSideObjectiveScore(room, side, amount) {
  if (!side || !amount) return;
  if (isSoloMode(room)) {
    const player = room.players.get(side);
    if (player) player.score += amount;
  } else {
    const scores = ensureTeamScores(room);
    scores[side] = (scores[side] || 0) + amount;
  }
}

// The single authoritative score for a side, used by BOTH the scoreboard
// snapshot and the victory checks so the two can never disagree.
function sideScore(room, side) {
  if (isSoloMode(room)) return Math.floor(room.players.get(side)?.score || 0);
  return Math.floor(ensureTeamScores(room)[side] || 0);
}

// Map of side -> authoritative score for every side currently in play.
function scoreSides(room) {
  const sides = new Map();
  if (isSoloMode(room)) {
    for (const player of room.players.values()) sides.set(player.id, Math.floor(player.score || 0));
  } else {
    const scores = ensureTeamScores(room);
    for (const player of room.players.values()) {
      if (!sides.has(player.team)) sides.set(player.team, Math.floor(scores[player.team] || 0));
    }
    for (const team of Object.keys(scores)) {
      if (!sides.has(team)) sides.set(team, Math.floor(scores[team] || 0));
    }
  }
  return sides;
}

// Plain object of side -> score for embedding in a snapshot so clients render
// and compare against the exact authoritative values instead of reconstructing
// team totals from player records.
function snapshotSideScores(room) {
  const out = {};
  for (const [side, score] of scoreSides(room)) out[side] = score;
  return out;
}

function updateCapturePoints(room, ships, dt) {
  const { teamLabel } = require("./players");
  const { broadcastRoom } = require("./messages");

  for (const point of room.points) {
    const counts = new Map();

    for (const ship of ships) {
      if (Math.hypot(ship.x - point.x, ship.y - point.y) <= point.radius) {
        const player = room.players.get(ship.ownerId);
        if (!player) continue;
        const current = counts.get(player.team) || { count: 0, ownerId: ship.ownerId };
        current.count += 1 + effectiveComponentBonus(ship, "captureBonus");
        counts.set(player.team, current);
      }
    }

    const contenders = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
    point.contested = false;
    if (contenders.length === 0) {
      point.progress = Math.max(0, point.progress - BALANCE.capture.neutralDecayPerSecond * dt);
      continue;
    }

    if (contenders.length > 1 && contenders[0][1].count === contenders[1][1].count) {
      point.contested = true;
      continue;
    }

    const [leaderTeam, leader] = contenders[0];
    const captureRate = (BALANCE.capture.baseCaptureRate + leader.count * BALANCE.capture.captureRatePerShip) * dt;

    if (point.ownerTeam === leaderTeam) {
      point.progress = Math.min(1, point.progress + captureRate);
    } else {
      point.progress -= captureRate;
      if (point.progress <= 0) {
        point.ownerTeam = leaderTeam;
        point.ownerId = leader.ownerId;
        point.progress = Math.min(1, captureRate * BALANCE.capture.newOwnerProgressMultiplier);
        // Objective capture score is awarded once to the capturing side. Money
        // and personal capture counts stay per-player (economy/personal stats),
        // but the shared team objective score is not multiplied by team size.
        addSideObjectiveScore(room, leaderTeam, BALANCE.capture.captureScore);
        for (const player of room.players.values()) {
          if (player.team === leaderTeam) {
            player.captures += 1;
            player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, player.money + ECONOMY.captureBonus);
            player.earned += ECONOMY.captureBonus;
          }
        }
        broadcastRoom(room, {
          type: "notice",
          message: `${teamLabel(room, leaderTeam, "A wing")} captured relay ${point.id}: +$${ECONOMY.captureBonus}, +$${ECONOMY.relayIncome}/s`
        });
      }
    }
  }
}

function getTeamWithFullControl(room) {
  if (!room.points?.length) return null;

  let controllingTeam = null;

  for (const point of room.points) {
    if (point.contested) return null;
    if (!point.ownerTeam) return null;
    if ((point.progress || 0) < 0.98) return null;

    if (!controllingTeam) {
      controllingTeam = point.ownerTeam;
    } else if (point.ownerTeam !== controllingTeam) {
      return null;
    }
  }

  return controllingTeam;
}

function getPlayerWithFullControl(room) {
  if (!room.points?.length) return null;

  let controllingPlayerId = null;

  for (const point of room.points) {
    if (point.contested) return null;
    if (!point.ownerId) return null;
    if ((point.progress || 0) < 0.98) return null;

    if (!controllingPlayerId) {
      controllingPlayerId = point.ownerId;
    } else if (point.ownerId !== controllingPlayerId) {
      return null;
    }
  }

  return controllingPlayerId;
}

function resetControlVictory(room, broadcastReset = false) {
  if (!room.controlVictory) return;
  const hadActiveCountdown = Boolean(room.controlVictory.team || room.controlVictory.playerId);
  room.controlVictory.team = null;
  room.controlVictory.playerId = null;
  room.controlVictory.startedAt = null;
  room.controlVictory.remaining = null;

  if (hadActiveCountdown && broadcastReset) {
    const { broadcastRoom } = require("./messages");
    broadcastRoom(room, { type: "notice", message: "Victory countdown interrupted." });
  }
}

function finalizeMatchWinner(room, winner, now, message) {
  if (room.winner || room.phase === "ended") return false;
  const { finalizeMatchRewards } = require("./economy");
  const { broadcastRoom, broadcastSnapshot } = require("./messages");
  room.winner = winner;
  room.winnerAt = now;
  room.phase = "ended";
  resetControlVictory(room, false);
  finalizeMatchRewards(room);
  broadcastRoom(room, { type: "notice", message });
  broadcastSnapshot(room, now, true);
  return true;
}

function finalizeTeamControlVictory(room, team, now) {
  const { teamLabel } = require("./players");
  const winningPlayer = [...room.players.values()].find(p => p.team === team);
  const teamName = teamLabel(room, team, winningPlayer ? winningPlayer.name : `Wing ${team}`);

  finalizeMatchWinner(room, {
    id: winningPlayer ? winningPlayer.id : null,
    team: team,
    name: teamName,
    reason: "control"
  }, now, `${teamName} won the match`);
}

function finalizeSoloControlVictory(room, playerId, now) {
  const player = room.players.get(playerId);
  const playerName = player ? player.name : "A player";

  finalizeMatchWinner(room, {
    id: playerId,
    team: player ? player.team : playerId,
    name: playerName,
    reason: "control"
  }, now, `${playerName} won the match`);
}

function topScoringSide(room) {
  // Uses the same authoritative per-side score as the scoreboard snapshot.
  return [...scoreSides(room).entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || null;
}

function finalizeScoreVictoryIfNeeded(room, now) {
  if (!room.maxScore) return false;
  const top = topScoringSide(room);
  if (!top || top[1] < room.maxScore) return false;
  const side = top[0];
  const player = room.rules?.gameMode === "solo" ? room.players.get(side) : [...room.players.values()].find((candidate) => candidate.team === side);
  const { teamLabel } = require("./players");
  const name = room.rules?.gameMode === "solo" ? (player?.name || "A player") : teamLabel(room, side, `Wing ${side}`);
  return finalizeMatchWinner(room, { id: player?.id || null, team: player?.team || side, name, reason: "score" }, now, `${name} won by reaching ${room.maxScore} score`);
}

function updateScoring(room, now) {
  if (room.phase !== "active" || room.winner) return;

  // 1. Keep score incrementing over time as a secondary stat/economy/reward metric
  const tickScore = now - (room.lastScoreAt || 0) >= 1000;
  if (tickScore) {
    room.lastScoreAt = now;
    // Periodic relay-control income increments once per controlled relay per
    // side, never once per player, so a larger team does not earn faster.
    for (const point of room.points) {
      if (point.contested || point.progress < 0.98) continue;
      const ownerKey = isSoloMode(room) ? point.ownerId : point.ownerTeam;
      if (!ownerKey) continue;
      addSideObjectiveScore(room, ownerKey, SCORE_PER_CONTROLLED_POINT);
    }
  }

  if (finalizeScoreVictoryIfNeeded(room, now)) return;

  // 2. Authoritative Control Victory win conditions
  const { teamLabel } = require("./players");
  const { broadcastRoom } = require("./messages");

  if (room.rules?.gameMode === "solo") {
    const controllingPlayerId = getPlayerWithFullControl(room);
    if (!controllingPlayerId) {
      resetControlVictory(room, false);
      return;
    }
    finalizeSoloControlVictory(room, controllingPlayerId, now);
    return;
  }

  // Team mode
  const controllingTeam = getTeamWithFullControl(room);
  if (!controllingTeam) {
    resetControlVictory(room, true); // Broadcast when interrupted
    return;
  }

  if (room.controlVictory?.team !== controllingTeam) {
    room.controlVictory = {
      team: controllingTeam,
      playerId: null,
      startedAt: now,
      requiredSeconds: 20,
      remaining: 20
    };
    const teamName = teamLabel(room, controllingTeam, `Wing ${controllingTeam}`);
    broadcastRoom(room, {
      type: "notice",
      message: `${teamName} controls all relays. Victory countdown started.`
    });
  } else {
    const elapsedSeconds = (now - room.controlVictory.startedAt) / 1000;
    room.controlVictory.remaining = Math.max(0, room.controlVictory.requiredSeconds - elapsedSeconds);

    if (elapsedSeconds >= room.controlVictory.requiredSeconds) {
      finalizeTeamControlVictory(room, controllingTeam, now);
    }
  }
}

module.exports = {
  updateCapturePoints,
  updateScoring,
  resetControlVictory,
  resetTeamScores,
  getTeamWithFullControl,
  getPlayerWithFullControl,
  finalizeMatchWinner,
  finalizeScoreVictoryIfNeeded,
  addSideObjectiveScore,
  sideScore,
  scoreSides,
  snapshotSideScores,
  topScoringSide
};
