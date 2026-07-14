// Controls capture point states, capture progress increments, capture rewards, and game score updates.

const { ECONOMY, SCORE_PER_CONTROLLED_POINT } = require("./config");
const { effectiveComponentBonus } = require("./heat");

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
      point.progress = Math.max(0, point.progress - 0.08 * dt);
      continue;
    }

    if (contenders.length > 1 && contenders[0][1].count === contenders[1][1].count) {
      point.contested = true;
      continue;
    }

    const [leaderTeam, leader] = contenders[0];
    const captureRate = (0.1 + leader.count * 0.045) * dt;

    if (point.ownerTeam === leaderTeam) {
      point.progress = Math.min(1, point.progress + captureRate);
    } else {
      point.progress -= captureRate;
      if (point.progress <= 0) {
        point.ownerTeam = leaderTeam;
        point.ownerId = leader.ownerId;
        point.progress = Math.min(1, captureRate * 3);
        for (const player of room.players.values()) {
          if (player.team === leaderTeam) {
            player.captures += 1;
            player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, player.money + ECONOMY.captureBonus);
            player.earned += ECONOMY.captureBonus;
            player.score += 14;
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
  const sides = new Map();
  for (const player of room.players.values()) {
    const side = room.rules?.gameMode === "solo" ? player.id : player.team;
    sides.set(side, (sides.get(side) || 0) + Math.floor(player.score || 0));
  }
  return [...sides.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || null;
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
    for (const point of room.points) {
      if (point.contested || point.progress < 0.98) continue;
      const ownerKey = room.rules?.gameMode === "solo" ? point.ownerId : point.ownerTeam;
      if (!ownerKey) continue;
      for (const player of room.players.values()) {
        const playerKey = room.rules?.gameMode === "solo" ? player.id : player.team;
        if (playerKey === ownerKey) player.score += SCORE_PER_CONTROLLED_POINT;
      }
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
  getTeamWithFullControl,
  getPlayerWithFullControl,
  finalizeMatchWinner,
  finalizeScoreVictoryIfNeeded
};
