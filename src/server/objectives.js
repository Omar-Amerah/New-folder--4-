// Controls capture point states, capture progress increments, capture rewards, and game score updates.

const { ECONOMY, SCORE_PER_CONTROLLED_POINT } = require("./config");

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
        current.count += 1 + (ship.stats.captureBonus || 0);
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

function updateScoring(room, now) {
  if (room.phase !== "active" || room.winner) return;

  if (now - room.lastScoreAt < 1000) return;
  room.lastScoreAt = now;

  for (const point of room.points) {
    if (!point.ownerTeam || point.progress < 0.98) continue;
    for (const player of room.players.values()) {
      if (player.team === point.ownerTeam) player.score += SCORE_PER_CONTROLLED_POINT;
    }
  }

  const { teamLabel } = require("./players");
  const { finalizeMatchRewards } = require("./economy");
  const { broadcastRoom } = require("./messages");

  const winner = [...room.players.values()]
    .filter((player) => player.score >= room.maxScore)
    .sort((a, b) => b.score - a.score)[0];
  if (winner) {
    room.winner = {
      id: winner.id,
      team: winner.team,
      name: teamLabel(room, winner.team, winner.name)
    };
    room.winnerAt = now;
    room.phase = "ended";
    finalizeMatchRewards(room);
    broadcastRoom(room, { type: "notice", message: `${room.winner.name} won the match` });
  }
}

module.exports = {
  updateCapturePoints,
  updateScoring
};
