// Controls relay capture progress, capture rewards, and classic full-control
// victory. Station-mode victory is exclusively home-station destruction.

const { ECONOMY, TEAM_COLORS } = require("./config");
const { BALANCE } = require("./balanceConfig");
const { effectiveComponentBonus } = require("./heat");
const { performanceNow } = require("./utils");
const { bump, recordDuration, detailedProfileActive } = require("./roomTelemetry");

function updateCapturePoints(room, ships, dt) {
  if (room.rules?.infrastructureMode === "stations") return;
  const startedAt = performanceNow();
  const detailed = detailedProfileActive(room);
  const { teamLabel } = require("./players");
  const { broadcastRoom } = require("./messages");

  let pointsProcessed = 0;
  let candidatesVisited = 0;
  for (const point of room.points) {
    if (detailed) pointsProcessed += 1;
    const counts = new Map();

    for (const ship of ships) {
      if (detailed) candidatesVisited += 1;
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
  if (detailed) {
    bump(room, "classicCapturePointsProcessed", pointsProcessed);
    bump(room, "classicCaptureCandidatesVisited", candidatesVisited);
  }
  recordDuration(room, "classicCaptureRuntimeMs", startedAt);
}

function getTeamWithFullControl(room) {
  if (room.rules?.infrastructureMode === "stations") {
    const relays = (room.stations || []).filter((s) => s.stationType === "relay");
    if (!relays.length) return null;
    let controllingTeam = null;
    for (const relay of relays) {
      if (relay.state !== "operational" || !relay.team) return null;
      if (!controllingTeam) controllingTeam = relay.team;
      else if (relay.team !== controllingTeam) return null;
    }
    return controllingTeam;
  }

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
  if (room.rules?.infrastructureMode === "stations") {
    const relays = (room.stations || []).filter((s) => s.stationType === "relay");
    if (!relays.length) return null;
    let controllingPlayerId = null;
    for (const relay of relays) {
      if (relay.state !== "operational" || !relay.ownerId) return null;
      if (!controllingPlayerId) controllingPlayerId = relay.ownerId;
      else if (relay.ownerId !== controllingPlayerId) return null;
    }
    return controllingPlayerId;
  }

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

function finalizeHomeStationDestruction(room, station, attackerId, now) {
  if (!room || !station || station.stationType !== "home") return false;
  const activePlayers = [...room.players.values()].filter((player) => !player.removed);
  const attacker = room.players.get(attackerId);

  if (room.rules?.gameMode === "solo") {
    const defeatedPlayerId = station.ownerId || station.team;
    const winner = attacker && attacker.id !== defeatedPlayerId
      ? attacker
      : activePlayers.find((player) => player.id !== defeatedPlayerId);
    if (!winner) return false;
    return finalizeMatchWinner(room, {
      id: winner.id,
      playerId: winner.id,
      team: winner.team || winner.id,
      name: winner.name || "A player",
      reason: "home-base-destroyed"
    }, now, `${winner.name || "A player"} destroyed the enemy home station and won the match`);
  }

  const defeatedTeam = station.team;
  const opposingPlayers = activePlayers.filter((player) => player.team && player.team !== defeatedTeam);
  const winningTeam = attacker?.team && attacker.team !== defeatedTeam
    ? attacker.team
    : opposingPlayers[0]?.team;
  if (!winningTeam) return false;
  const winningPlayer = (attacker?.team === winningTeam ? attacker : null)
    || opposingPlayers.find((player) => player.team === winningTeam)
    || null;
  const { teamLabel } = require("./players");
  const winningName = teamLabel(room, winningTeam, winningPlayer?.name || `Wing ${winningTeam}`);
  const defeatedName = teamLabel(room, defeatedTeam, `Wing ${defeatedTeam}`);
  return finalizeMatchWinner(room, {
    id: winningPlayer?.id || null,
    playerId: winningPlayer?.id || null,
    team: winningTeam,
    name: winningName,
    reason: "home-base-destroyed"
  }, now, `${winningName} destroyed ${defeatedName}'s home station and won the match`);
}

function updateControlVictory(room, now) {
  if (room.phase !== "active" || room.winner) return;

  // Relays remain capture/economy objectives in station mode, but controlling
  // them must never end the match. The only station-mode victory authority is
  // finalizeHomeStationDestruction(). Clear any stale countdown state without
  // broadcasting a misleading interruption notice.
  if (room.rules?.infrastructureMode === "stations") {
    resetControlVictory(room, false);
    return;
  }

  const stationMode = room.rules?.infrastructureMode === "stations";
  const startedAt = stationMode ? performanceNow() : 0;
  if (stationMode && detailedProfileActive(room)) bump(room, "stationControlVictoryEvaluations");
  try {

  const { teamLabel } = require("./players");
  const { broadcastRoom } = require("./messages");

  if (room.rules?.gameMode === "solo") {
    const controllingPlayerId = getPlayerWithFullControl(room);
    if (!controllingPlayerId) {
      resetControlVictory(room, true);
      return;
    }

    if (room.controlVictory?.playerId !== controllingPlayerId) {
      const player = room.players.get(controllingPlayerId);
      const playerName = player?.name || "A player";
      room.controlVictory = {
        team: null,
        playerId: controllingPlayerId,
        startedAt: now,
        requiredSeconds: 20,
        remaining: 20
      };
      broadcastRoom(room, {
        type: "notice",
        message: `${playerName} controls all relays. Victory countdown started.`,
        color: player?.color || null
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
      message: `${teamName} controls all relays. Victory countdown started.`,
      color: TEAM_COLORS[controllingTeam] || null
    });
    return;
  }

  const elapsedSeconds = (now - room.controlVictory.startedAt) / 1000;
  room.controlVictory.remaining = Math.max(0, room.controlVictory.requiredSeconds - elapsedSeconds);
  if (elapsedSeconds >= room.controlVictory.requiredSeconds) {
    finalizeTeamControlVictory(room, controllingTeam, now);
  }
  } finally {
    if (stationMode) recordDuration(room, "stationControlVictoryMs", startedAt);
  }
}

module.exports = {
  updateCapturePoints,
  updateControlVictory,
  resetControlVictory,
  getTeamWithFullControl,
  getPlayerWithFullControl,
  finalizeMatchWinner,
  finalizeHomeStationDestruction
};
