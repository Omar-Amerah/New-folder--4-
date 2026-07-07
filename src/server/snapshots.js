// Builds state snapshot objects representing game rooms and serializes them for network transmission.

const { round } = require("./utils");
const { teamLabel } = require("./players");
const { getActiveFleetCost } = require("./economy");
const { summarizeStats, computeStats } = require("./shipStats");

function snapshotRoom(room, now, viewer = null) {
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
    money: canViewPlayerEconomy(viewer, player) ? Math.floor(player.money) : null,
    income: canViewPlayerEconomy(viewer, player) ? round(player.income) : null,
    earned: canViewPlayerEconomy(viewer, player) ? Math.floor(player.earned) : null,
    spent: canViewPlayerEconomy(viewer, player) ? Math.floor(player.spent) : null,
    shipCap: player.shipCap,
    activeFleetCost: canViewPlayerEconomy(viewer, player) ? getActiveFleetCost(player) : null,
    deployedFleetCost: canViewPlayerEconomy(viewer, player) ? Math.floor(player.deployedFleetCost) : null,
    destroyedEnemyCost: Math.floor(player.destroyedEnemyCost),
    lastReward: player.lastReward,
    activeShips: player.ships.filter((ship) => ship.alive && !ship.removed).length,
    score: Math.floor(player.score),
    kills: player.kills,
    losses: player.losses,
    captures: player.captures,
    design: player.design,
    stats: summarizeStats(player.stats || computeStats(player.design))
  }));

  const ships = [];
  for (const player of room.players.values()) {
    for (const ship of player.ships) {
      if (ship.removed) continue;
      ships.push({
        id: ship.id,
        ownerId: ship.ownerId,
        x: round(ship.x),
        y: round(ship.y),
        vx: round(ship.vx),
        vy: round(ship.vy),
        angle: round(ship.angle),
        targetX: round(ship.targetX),
        targetY: round(ship.targetY),
        hp: round(ship.hp),
        maxHp: round(ship.maxHp),
        shield: round(ship.shield),
        maxShield: round(ship.maxShield),
        radius: round(ship.radius),
        design: ship.design || [],
        cost: ship.cost || ship.stats?.unitCost || 0,
        focusTargetId: ship.focusTargetId,
        alive: ship.alive,
        respawnIn: 0,
        removeIn: ship.alive ? 0 : Math.max(0, Math.ceil(((ship.removeAt || now) - now) / 1000))
      });
    }
  }

  return {
    type: "state",
    room: room.code,
    phase: room.phase,
    adminId: room.adminId,
    mapSizeLabel: room.mapSizeLabel,
    world: room.world,
    map: room.map,
    players,
    ships,
    bullets: room.bullets.map((bullet) => ({
      id: bullet.id,
      type: bullet.type,
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
    effects: room.effects.map((effect) => ({ ...effect, age: Math.max(0, now - effect.at) })),
    winner: room.winner,
    maxScore: room.maxScore,
    rules: room.rules,
    time: Math.floor(now)
  };
}

function canViewPlayerEconomy(viewer, player) {
  if (!viewer || !player) return false;
  if (viewer.id === player.id) return true;
  return viewer.team === player.team;
}

module.exports = {
  snapshotRoom,
  canViewPlayerEconomy
};
