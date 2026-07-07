// Creation, ownership mapping, death, and removal of ship entities (including bots).

const { COLORS, BOT_NAMES, MAX_PLAYERS_PER_ROOM, ECONOMY } = require("./config");
const { randomRange } = require("./utils");
const { computeStats } = require("./shipStats");
const { normalizeShipDesignSnapshot } = require("./shipDesign");

function spawnShip(room, player, now, index = 0, options = {}) {
  const { nearestClearPoint } = require("./movement");
  const stats = options.stats || player.stats || computeStats(player.design);
  const design = normalizeShipDesignSnapshot(options.design || player.design);
  const spawn = getPlayerSpawn(room, player.id);
  const offset = index - Math.floor(player.shipCap / 2);
  const ySpread = Math.sin(index * 1.7) * 54;
  const spawnPoint = nearestClearPoint(
    room,
    spawn.x + offset * 16 + randomRange(-26, 26),
    spawn.y + ySpread + randomRange(-32, 32),
    Math.max(46, stats.radius * 0.72)
  );
  const ship = {
    id: `s${room.nextEntityId++}`,
    ownerId: player.id,
    x: spawnPoint.x,
    y: spawnPoint.y,
    vx: 0,
    vy: 0,
    angle: spawn.angle,
    targetX: spawnPoint.x,
    targetY: spawnPoint.y,
    arrived: true,
    formationX: 0,
    formationY: 0,
    alive: true,
    removed: false,
    removeAt: 0,
    hp: stats.maxHp,
    shield: stats.maxShield,
    maxHp: stats.maxHp,
    maxShield: stats.maxShield,
    stats,
    design,
    cost: stats.unitCost,
    radius: stats.radius,
    blasterCooldown: randomRange(0.08, 0.42),
    missileCooldown: randomRange(0.35, 0.9),
    railgunCooldown: randomRange(0.45, 1.4),
    repairPulseAt: 0,
    focusTargetId: null,
    lastDamagedBy: null
  };
  player.ships.push(ship);
  room.ships.set(ship.id, ship);
  room.effects.push({ type: "warp", x: ship.x, y: ship.y, at: now });
  return ship;
}

function getLiveShips(room) {
  const ships = [];
  for (const ship of room.ships.values()) {
    if (ship.alive) ships.push(ship);
  }
  return ships;
}

function findShipById(room, id) {
  if (!id) return null;
  const ship = room.ships.get(id);
  if (ship && ship.alive) return ship;
  return null;
}

function addBot(room, requester) {
  const { chooseBotTeam } = require("./ships");
  const { broadcastRoom } = require("./messages");
  if (room.players.size >= (room.rules?.maxPlayers ?? MAX_PLAYERS_PER_ROOM)) return;

  const id = `bot${room.nextBotId++}`;
  const color = COLORS[room.colorCursor % COLORS.length];
  room.colorCursor += 1;
  const design = chooseBotDesign(room.nextBotId);
  const team = chooseBotTeam(room, requester, id);
  const name = BOT_NAMES[(room.nextBotId - 2) % BOT_NAMES.length];
  const player = {
    id,
    name,
    color,
    team,
    isBot: true,
    ai: { nextThinkAt: 0, objectiveId: null },
    ready: false,
    design,
    stats: computeStats(design),
    ships: [],
    money: room.rules?.startingMoney ?? ECONOMY.startingMoney,
    bank: room.rules?.startingMoney ?? ECONOMY.startingMoney,
    income: ECONOMY.baseIncome,
    earned: room.rules?.startingMoney ?? ECONOMY.startingMoney,
    spent: 0,
    maxMoney: ECONOMY.maxMoney,
    shipCap: ECONOMY.shipCap,
    deployedFleetCost: 0,
    destroyedEnemyCost: 0,
    lostFleetCost: 0,
    lastReward: null,
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    lastReadyAt: 0
  };

  room.players.set(player.id, player);
  broadcastRoom(room, { type: "notice", message: `${player.name} joined as a bot` });
}

function updateBots(room, now) {
  if (room.winner) return;

  const { buyShip } = require("./economy");
  const { areEnemies } = require("./combat");
  const { commandShips } = require("./movement");

  for (const player of room.players.values()) {
    if (!player.isBot || !player.ready || now < player.ai.nextThinkAt) continue;
    player.ai.nextThinkAt = now + randomRange(900, 1700);
    const currentCost = player.stats?.unitCost || computeStats(player.design).unitCost;
    if (player.money >= currentCost) {
      buyShip(room, player, now, { silent: true });
    }
    const ships = player.ships.filter((ship) => ship.alive);
    if (ships.length === 0) continue;

    const enemies = getLiveShips(room)
      .filter((ship) => areEnemies(room, player.id, ship.ownerId))
      .sort((a, b) => distanceToFleet(ships, a) - distanceToFleet(ships, b));
    const nearestEnemy = enemies[0];

    if (nearestEnemy && distanceToFleet(ships, nearestEnemy) < 760) {
      commandShips(room, player, nearestEnemy.x, nearestEnemy.y, {
        targetId: nearestEnemy.id,
        formation: ships.length > 2 ? "wedge" : "line"
      });
      continue;
    }

    const objective = room.points
      .filter((point) => point.ownerTeam !== player.team || point.progress < 0.95)
      .sort((a, b) => distanceToFleet(ships, a) - distanceToFleet(ships, b))[0] || room.points[Math.floor(Math.random() * room.points.length)];
    commandShips(room, player, objective.x + randomRange(-80, 80), objective.y + randomRange(-80, 80), {
      formation: ships.length > 3 ? "clump" : "line"
    });
  }
}

function chooseBotDesign(seed) {
  const heavy = [
    { x: 3, y: 3, type: "core" },
    { x: 2, y: 3, type: "armor" },
    { x: 4, y: 3, type: "armor" },
    { x: 3, y: 2, type: "shield" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 3, y: 1, type: "railgun" },
    { x: 2, y: 2, type: "blaster" },
    { x: 4, y: 2, type: "blaster" },
    { x: 3, y: 5, type: "battery" }
  ];
  const skirmish = [
    { x: 3, y: 3, type: "core" },
    { x: 2, y: 3, type: "blaster" },
    { x: 4, y: 3, type: "blaster" },
    { x: 3, y: 2, type: "missile" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 1, y: 4, type: "engine" },
    { x: 5, y: 4, type: "engine" },
    { x: 3, y: 5, type: "battery" }
  ];
  const support = [
    { x: 3, y: 3, type: "core" },
    { x: 3, y: 2, type: "shield" },
    { x: 2, y: 3, type: "repair" },
    { x: 4, y: 3, type: "repair" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 2, y: 2, type: "blaster" },
    { x: 4, y: 2, type: "missile" },
    { x: 3, y: 5, type: "battery" }
  ];
  return [heavy, skirmish, support][seed % 3].map((part) => ({ ...part }));
}

function chooseBotTeam(room, requester, fallbackId) {
  if (room.rules?.gameMode === "solo") return fallbackId;

  if (requester && (requester.team === "blue" || requester.team === "red")) {
    return requester.team === "blue" ? "red" : "blue";
  }

  const { balanceTeam } = require("./players");
  return balanceTeam(room);
}

function getPlayerSpawn(room, playerId) {
  const player = room.players.get(playerId);
  if (player?.team === "blue") {
    const teamMates = [...room.players.values()].filter((candidate) => candidate.team === "blue").map((candidate) => candidate.id).sort();
    const index = Math.max(0, teamMates.indexOf(playerId));
    const lanes = [0.32, 0.5, 0.68, 0.2, 0.8, 0.42, 0.58];
    return { x: 260, y: room.world.height * lanes[index % lanes.length], angle: 0 };
  }
  if (player?.team === "red") {
    const teamMates = [...room.players.values()].filter((candidate) => candidate.team === "red").map((candidate) => candidate.id).sort();
    const index = Math.max(0, teamMates.indexOf(playerId));
    const lanes = [0.68, 0.5, 0.32, 0.8, 0.2, 0.58, 0.42];
    return { x: room.world.width - 260, y: room.world.height * lanes[index % lanes.length], angle: Math.PI };
  }

  const ids = [...room.players.keys()].sort();
  const index = Math.max(0, ids.indexOf(playerId));
  const slots = [
    { x: 260, y: room.world.height * 0.5, angle: 0 },
    { x: room.world.width - 260, y: room.world.height * 0.5, angle: Math.PI },
    { x: room.world.width * 0.5, y: 220, angle: Math.PI / 2 },
    { x: room.world.width * 0.5, y: room.world.height - 220, angle: -Math.PI / 2 },
    { x: 340, y: 260, angle: 0.35 },
    { x: room.world.width - 340, y: room.world.height - 260, angle: Math.PI + 0.35 },
    { x: room.world.width - 340, y: 260, angle: Math.PI - 0.35 },
    { x: 340, y: room.world.height - 260, angle: -0.35 }
  ];
  return slots[index % slots.length];
}

function distanceToFleet(ships, target) {
  let best = Infinity;
  for (const ship of ships) {
    best = Math.min(best, Math.hypot(ship.x - target.x, ship.y - target.y));
  }
  return best;
}

module.exports = {
  spawnShip,
  getLiveShips,
  findShipById,
  addBot,
  updateBots,
  chooseBotDesign,
  chooseBotTeam,
  getPlayerSpawn,
  distanceToFleet
};
