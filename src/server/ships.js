// Creation, ownership mapping, death, and removal of ship entities (including bots).

const { COLORS, BOT_NAMES, MAX_PLAYERS_PER_ROOM, ECONOMY } = require("./config");
const { performanceNow, seededRandom, rngRange, hashString } = require("./utils");
const { computeStats } = require("./shipStats");
const { normalizeShipDesignSnapshot } = require("./shipDesign");

function spawnShip(room, player, now, index = 0, options = {}) {
  const { nearestClearPoint } = require("./movement");
  const { initComponentState } = require("./componentHealth");
  const { initShipHeat } = require("./heat");
  // Shallow-clone: destroyed components mutate top-level stat fields per ship,
  // and the source stats object is shared by every ship of the player.
  const stats = { ...(options.stats || player.stats || computeStats(player.design)) };
  const design = normalizeShipDesignSnapshot(options.design || player.design);
  const spawn = getPlayerSpawn(room, player.id);
  const spawnRng = seededRandom(((room.mapSeed || room.map?.seed || 0) ^ hashString(`${player.id}:${index}:${room.nextEntityId}`)) >>> 0);
  const offset = index - Math.floor(player.shipCap / 2);
  const ySpread = Math.sin(index * 1.7) * 27;
  const spawnPoint = nearestClearPoint(
    room,
    spawn.x + offset * 8 + rngRange(spawnRng, -13, 13),
    spawn.y + ySpread + rngRange(spawnRng, -16, 16),
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
    combatStyle: options.combatStyle || "sentry",
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
    blasterCooldown: rngRange(spawnRng, 0.08, 0.42),
    missileCooldown: rngRange(spawnRng, 0.35, 0.9),
    railgunCooldown: rngRange(spawnRng, 0.45, 1.4),
    repairPulseAt: 0,
    focusTargetId: null,
    lastDamagedBy: null
  };
  // Per-component health pools; also sets ship.hp/maxHp to the component sum.
  initComponentState(ship);
  initShipHeat(ship);
  player.ships.push(ship);
  room.ships.set(ship.id, ship);
  room.effects.push({ type: "warp", x: ship.x, y: ship.y, at: now });

  const rallyPoint = getPlayerRallyPoint(room, player);
  if (rallyPoint) {
    const rallyTarget = nearestClearPoint(
      room,
      rallyPoint.x,
      rallyPoint.y,
      Math.max(42, ship.radius * 0.72)
    );
    if (Math.hypot(rallyTarget.x - ship.x, rallyTarget.y - ship.y) > 48) {
      ship.targetX = rallyTarget.x;
      ship.targetY = rallyTarget.y;
      ship.arrived = false;
      ship.isManualMove = true;
    }
  }

  if (process.env.NODE_ENV !== "production") {
    console.log(`[DEBUG] Spawning ship ${ship.id} for player ${player.id} with combatStyle: ${ship.combatStyle}`);
  }

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
  const { invalidateSpawnPlan } = require("./spawnPlanner");
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
    ai: { nextThinkAt: 0, objectiveId: null, decisionSeq: 0 },
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
    rallyPoint: null,
    score: 0,
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    lastReadyAt: 0,
    purchaseRequests: new Map()
  };
  if (room.rules?.gameMode === "solo") player.team = player.id;

  room.players.set(player.id, player);
  invalidateSpawnPlan(room);
  broadcastRoom(room, { type: "notice", message: `${player.name} joined as a bot` });
  const { broadcastSnapshot } = require("./messages");
  broadcastSnapshot(room, performanceNow(), true);
}

function updateBots(room, now) {
  if (room.winner) return;

  const { buyShip } = require("./economy");
  const { areEnemies } = require("./combat");
  const { commandShips } = require("./movement");

  for (const player of room.players.values()) {
    if (!player.isBot || !player.ready || now < player.ai.nextThinkAt) continue;
    const ai = player.ai || (player.ai = { nextThinkAt: 0, objectiveId: null, decisionSeq: 0 });
    const seq = ai.decisionSeq || 0;
    const rng = seededRandom(((room.mapSeed || room.map?.seed || 0) ^ hashString(`${player.id}:bot:${seq}`)) >>> 0);
    ai.decisionSeq = seq + 1;
    ai.nextThinkAt = now + rngRange(rng, 900, 1700);
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

    const objectives = (room.points || [])
      .filter((point) => point && (point.ownerTeam !== player.team || point.progress < 0.95))
      .sort((a, b) => {
        const diff = distanceToFleet(ships, a) - distanceToFleet(ships, b);
        return diff || String(a.id || `${a.x},${a.y}`).localeCompare(String(b.id || `${b.x},${b.y}`));
      });
    const objective = objectives[0] || (room.points || [])[0];
    if (!objective) continue;
    commandShips(room, player, objective.x + rngRange(rng, -80, 80), objective.y + rngRange(rng, -80, 80), {
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
  const { getPlannedSpawn } = require("./spawnPlanner");
  return getPlannedSpawn(room, playerId);
}

function getPlayerRallyPoint(room, player) {
  if (!room || !player) return null;
  if (room.phase === "lobby") return null;
  const rally = player.rallyPoint;
  if (rally && Number.isFinite(rally.x) && Number.isFinite(rally.y)) {
    return {
      x: Math.max(0, Math.min(room.world.width, rally.x)),
      y: Math.max(0, Math.min(room.world.height, rally.y))
    };
  }
  const spawn = getPlayerSpawn(room, player.id);
  return { x: spawn.x, y: spawn.y };
}

function distanceToFleet(ships, target) {
  let best = Infinity;
  for (const ship of ships) {
    best = Math.min(best, Math.hypot(ship.x - target.x, ship.y - target.y));
  }
  return best;
}

function getShipModuleWorldCoords(ship) {
  const scale = 13;
  if (!ship.moduleWorldCoords || ship.angle !== ship.lastPrecomputedAngle || ship.x !== ship.lastPrecomputedX || ship.y !== ship.lastPrecomputedY) {
    const cos = Math.cos(ship.angle);
    const sin = Math.sin(ship.angle);
    ship.moduleWorldCoords = (ship.design || []).map((module) => {
      const lx = (7 - module.y) * scale;
      const ly = (module.x - 7) * scale;
      return {
        x: ship.x + lx * cos - ly * sin,
        y: ship.y + lx * sin + ly * cos
      };
    });
    ship.lastPrecomputedAngle = ship.angle;
    ship.lastPrecomputedX = ship.x;
    ship.lastPrecomputedY = ship.y;
  }
  return ship.moduleWorldCoords;
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
  getPlayerRallyPoint,
  distanceToFleet,
  getShipModuleWorldCoords
};
