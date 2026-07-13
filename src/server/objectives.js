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

function finalizeTeamControlVictory(room, team, now) {
  const { teamLabel } = require("./players");
  const { finalizeMatchRewards } = require("./economy");
  const { broadcastRoom, broadcastSnapshot } = require("./messages");

  const winningPlayer = [...room.players.values()].find(p => p.team === team);
  const teamName = teamLabel(room, team, winningPlayer ? winningPlayer.name : `Wing ${team}`);

  room.winner = {
    id: winningPlayer ? winningPlayer.id : null,
    team: team,
    name: teamName
  };
  room.winnerAt = now;
  room.phase = "ended";
  finalizeMatchRewards(room);
  broadcastRoom(room, { type: "notice", message: `${teamName} won the match` });
  broadcastSnapshot(room, now, true);
}

function finalizeSoloControlVictory(room, playerId, now) {
  const { finalizeMatchRewards } = require("./economy");
  const { broadcastRoom, broadcastSnapshot } = require("./messages");

  const player = room.players.get(playerId);
  const playerName = player ? player.name : "A player";

  room.winner = {
    id: playerId,
    team: player ? player.team : null,
    name: playerName
  };
  room.winnerAt = now;
  room.phase = "ended";
  finalizeMatchRewards(room);
  broadcastRoom(room, { type: "notice", message: `${playerName} won the match` });
  broadcastSnapshot(room, now, true);
}

function updateScoring(room, now) {
  if (room.phase !== "active" || room.winner) return;

  // 1. Keep score incrementing over time as a secondary stat/economy/reward metric
  const tickScore = now - (room.lastScoreAt || 0) >= 1000;
  if (tickScore) {
    room.lastScoreAt = now;
    for (const point of room.points) {
      if (!point.ownerTeam || point.progress < 0.98) continue;
      for (const player of room.players.values()) {
        if (player.team === point.ownerTeam) player.score += SCORE_PER_CONTROLLED_POINT;
      }
    }
  }

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
  updateScoring
};
