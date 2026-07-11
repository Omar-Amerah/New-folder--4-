// Builds state snapshot objects representing game rooms and serializes them for network transmission.

const { round } = require("./utils");
const { teamLabel } = require("./players");
const { getActiveFleetCost } = require("./economy");
const { summarizeStats, computeStats } = require("./shipStats");
const { getPlayerRallyPoint } = require("./ships");

// Builds the parts of a snapshot that are identical for every viewer so they can
// be computed once per broadcast instead of once per client.
function buildSharedSnapshot(room, now, sendStatic) {
  const ships = [];
  for (const ship of room.ships.values()) {
    if (ship.removed) continue;
    const entry = {
      id: ship.id,
      ownerId: ship.ownerId,
      x: round(ship.x),
      y: round(ship.y),
      vx: round(ship.vx),
      vy: round(ship.vy),
      angle: round(ship.angle),
      combatStyle: ship.combatStyle || "charge",
      targetX: round(ship.targetX),
      targetY: round(ship.targetY),
      hp: round(ship.hp),
      maxHp: round(ship.maxHp),
      shield: round(ship.shield),
      maxShield: round(ship.maxShield),
      radius: round(ship.radius),
      cost: ship.cost || ship.stats?.unitCost || 0,
      focusTargetId: ship.focusTargetId,
      combatTargetId: ship.combatTargetId || null,
      weaponAngles: (ship.weaponAngles || []).map(round),
      alive: ship.alive,
      blasterRange: ship.stats?.blasterRange || 0,
      missileRange: ship.stats?.missileRange || 0,
      railgunRange: ship.stats?.railgunRange || 0,
      beamRange: ship.stats?.beamRange || 0,
      beamRadius: ship.stats?.beamRadius || 0,
      respawnIn: 0,
      removeIn: ship.alive ? 0 : Math.max(0, Math.ceil(((ship.removeAt || now) - now) / 1000))
    };
    if (ship.selfDestructAt && ship.alive) {
      const span = ship.selfDestructAt - ship.selfDestructStart;
      entry.destructProgress = span > 0 ? round(Math.max(0, Math.min(1, (now - ship.selfDestructStart) / span))) : 1;
    }
    // A ship's design never changes after spawn, so only send it on static
    // snapshots or the first broadcast that includes the ship. Clients cache it.
    if (sendStatic || !ship.designSent) {
      entry.design = ship.design || [];
    }
    ships.push(entry);
  }

  const objectiveControl = {
    total: room.points.length,
    neutral: 0,
    contested: 0,
    teams: {},
    players: {}
  };
  for (const point of room.points) {
    if (point.contested) {
      objectiveControl.contested++;
    } else if (room.rules?.gameMode === "solo") {
      if (!point.ownerId || point.progress < 0.98) {
        objectiveControl.neutral++;
      } else {
        objectiveControl.players[point.ownerId] = (objectiveControl.players[point.ownerId] || 0) + 1;
      }
    } else {
      if (!point.ownerTeam || point.progress < 0.98) {
        objectiveControl.neutral++;
      } else {
        objectiveControl.teams[point.ownerTeam] = (objectiveControl.teams[point.ownerTeam] || 0) + 1;
      }
    }
  }

  return {
    ships,
    bullets: room.bullets.map((bullet) => ({
      id: bullet.id,
      type: bullet.type,
      subtype: bullet.subtype,
      ownerId: bullet.ownerId,
      x: round(bullet.x),
      y: round(bullet.y),
      vx: round(bullet.vx),
      vy: round(bullet.vy)
    })),
    points: room.points.map((point) => ({
      id: point.id,
      x: point.x,
      y: point.y,
      radius: point.radius,
      ownerId: point.ownerId,
      ownerTeam: point.ownerTeam,
      contested: Boolean(point.contested),
      progress: round(point.progress)
    })),
    effects: room.effects.map((effect) => ({ ...effect, age: Math.max(0, round(now - effect.at)), subtype: effect.subtype })),
    objectiveControl
  };
}

function snapshotRoom(room, now, viewer = null, sendStatic = true, shared = null) {
  if (!shared) shared = buildSharedSnapshot(room, now, sendStatic);

  const players = [...room.players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    team: player.team,
    teamName: teamLabel(room, player.team, player.name),
    isBot: player.isBot,
    isAdmin: room.adminId === player.id,
    connected: player.connected !== false,
    ready: player.ready,
    money: (room.phase === "ended" || canViewPlayerEconomy(viewer, player)) ? Math.floor(player.money) : null,
    income: canViewPlayerEconomy(viewer, player) ? round(player.income) : null,
    earned: (room.phase === "ended" || canViewPlayerEconomy(viewer, player)) ? Math.floor(player.earned) : null,
    spent: (room.phase === "ended" || canViewPlayerEconomy(viewer, player)) ? Math.floor(player.spent) : null,
    shipCap: player.shipCap,
    activeFleetCost: canViewPlayerEconomy(viewer, player) ? getActiveFleetCost(player) : null,
    deployedFleetCost: (room.phase === "ended" || canViewPlayerEconomy(viewer, player)) ? Math.floor(player.deployedFleetCost) : null,
    destroyedEnemyCost: Math.floor(player.destroyedEnemyCost),
    lastReward: player.lastReward,
    activeShips: player.ships.filter((ship) => ship.alive).length,
    score: Math.floor(player.score),
    kills: player.kills,
    losses: player.losses,
    captures: player.captures,
    design: sendStatic ? player.design : undefined,
    stats: sendStatic ? summarizeStats(player.stats || computeStats(player.design)) : undefined,
    rallyPoint: getPlayerRallyPoint(room, player),
    rallyPointCustom: Boolean(player.rallyPoint),
    shipsBuilt: player.shipsBuilt || 0,
    lostFleetCost: Math.floor(player.lostFleetCost || 0)
  }));

  return {
    type: "state",
    room: room.code,
    phase: room.phase,
    adminId: room.adminId,
    mapSizeLabel: sendStatic ? room.mapSizeLabel : undefined,
    world: sendStatic ? room.world : undefined,
    map: sendStatic ? room.map : undefined,
    players,
    ships: shared.ships,
    bullets: shared.bullets,
    points: shared.points,
    effects: shared.effects,
    winner: room.winner,
    matchStartedAt: room.matchStartedAt,
    maxScore: room.maxScore,
    rules: sendStatic ? room.rules : undefined,
    controlVictory: room.controlVictory ? {
      active: Boolean(room.controlVictory.team || room.controlVictory.playerId),
      team: room.controlVictory.team,
      playerId: room.controlVictory.playerId,
      remaining: room.controlVictory.remaining,
      requiredSeconds: room.controlVictory.requiredSeconds,
      fullControl: Boolean(room.controlVictory.team || room.controlVictory.playerId)
    } : null,
    objectiveControl: shared.objectiveControl,
    time: Math.floor(now)
  };
}

// Marks every current ship design as broadcast so subsequent dynamic snapshots omit it.
function markShipDesignsSent(room) {
  for (const ship of room.ships.values()) {
    if (!ship.designSent) ship.designSent = true;
  }
}

function canViewPlayerEconomy(viewer, player) {
  if (!viewer || !player) return false;
  if (viewer.id === player.id) return true;
  return viewer.team === player.team;
}

module.exports = {
  snapshotRoom,
  buildSharedSnapshot,
  markShipDesignsSent,
  canViewPlayerEconomy
};
