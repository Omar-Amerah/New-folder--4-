// Controls relay capture progress, capture rewards, and full-control victory.

const { ECONOMY } = require("./config");
const { BALANCE } = require("./balanceConfig");
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
    if (point.contested || !point.ownerTeam || (point.progress || 0) < 0.98) return null;
    if (!controllingTeam) controllingTeam = point.ownerTeam;
    else if (point.ownerTeam !== controllingTeam) return null;
  }
  return controllingTeam;
}

function getPlayerWithFullControl(room) {
  if (!room.points?.length) return null;

  let controllingPlayerId = null;
  for (const point of room.points) {
    if (point.contested || !point.ownerId || (point.progress || 0) < 0.98) return null;
    if (!controllingPlayerId) controllingPlayerId = point.ownerId;
    else if (point.ownerId !== controllingPlayerId) return null;
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
  const winningPlayer = [...room.players.values()].find((player) => player.team === team);
  const teamName = teamLabel(room, team, winningPlayer ? winningPlayer.name : `Wing ${team}`);
  finalizeMatchWinner(room, {
    id: winningPlayer ? winningPlayer.id : null,
    team,
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

function updateControlVictory(room, now) {
  if (room.phase !== "active" || room.winner) return;

  const { teamLabel } = require("./players");
  const { broadcastRoom } = require("./messages");

  if (room.rules?.gameMode === "solo") {
    const controllingPlayerId = getPlayerWithFullControl(room);
    if (!controllingPlayerId) {
      resetControlVictory(room, true);
      return;
    }

    if (room.controlVictory?.playerId !== controllingPlayerId) {
      const playerName = room.players.get(controllingPlayerId)?.name || "A player";
      room.controlVictory = {
        team: null,
        playerId: controllingPlayerId,
        startedAt: now,
        requiredSeconds: 20,
        remaining: 20
      };
      broadcastRoom(room, {
        type: "notice",
        message: `${playerName} controls all relays. Victory countdown started.`
      });
      return;
    }

    const elapsedSeconds = (now - room.controlVictory.startedAt) / 1000;
    room.controlVictory.remaining = Math.max(0, room.controlVictory.requiredSeconds - elapsedSeconds);
    if (elapsedSeconds >= room.controlVictory.requiredSeconds) {
      finalizeSoloControlVictory(room, controllingPlayerId, now);
    }
    return;
  }

  const controllingTeam = getTeamWithFullControl(room);
  if (!controllingTeam) {
    resetControlVictory(room, true);
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
    return;
  }

  const elapsedSeconds = (now - room.controlVictory.startedAt) / 1000;
  room.controlVictory.remaining = Math.max(0, room.controlVictory.requiredSeconds - elapsedSeconds);
  if (elapsedSeconds >= room.controlVictory.requiredSeconds) {
    finalizeTeamControlVictory(room, controllingTeam, now);
  }
}

module.exports = {
  updateCapturePoints,
  updateControlVictory,
  resetControlVictory,
  getTeamWithFullControl,
  getPlayerWithFullControl,
  finalizeMatchWinner
};
