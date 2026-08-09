// Creation, ownership mapping, death, and removal of ship entities (including bots).

const { COLORS, BOT_NAMES, MAX_PLAYERS_PER_ROOM, ECONOMY, DEFAULT_DESIGN } = require("./config");
const { sanitizeMovementToggles, sanitizeOrbitDirection } = require("./validation");
const { performanceNow, seededRandom, rngRange, hashString, compareIdStrings } = require("./utils");
const { invalidateRelationshipCache } = require("./relationships");
const { computeStats } = require("./shipStats");
const { recordPurchaseStage } = require("./performanceTelemetry");
const { createMovementRuntime } = require("./movementRuntime");

class SpawnPlacementError extends Error {
  constructor(reason = "no-clear-spawn") {
    super(reason);
    this.name = "SpawnPlacementError";
    this.code = reason;
  }
}

function clonePrebuiltShipState(prebuilt) {
  return cloneValue(prebuilt, new Set(["design", "stats", "thermalTopology", "_thermalRuntime"]));
}

function cloneValue(value, skipKeys = null) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item));
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) {
      const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      return new DataView(buffer);
    }
    return new value.constructor(value);
  }
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [cloneValue(k), cloneValue(v)]));
  if (value instanceof Set) return new Set([...value].map((v) => cloneValue(v)));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (skipKeys && skipKeys.has(key)) continue;
    out[key] = cloneValue(value[key]);
  }
  return out;
}

function spawnShip(room, player, now, index = 0, options = {}) {
  const { initComponentState, initProximityChargeState } = require("./componentHealth");
  const { initShipHeat } = require("./heat");
  
  // Use the immutable template when available; otherwise initialize from the
  // player's current design and Data Links.
  const template = options.template;
  const stats = template ? template.stats : { ...(options.stats || player.stats || computeStats(player.design)) };
  const design = template ? template.design : (options.design || player.design);
  const dataLinks = template ? template.dataLinks : (options.dataLinks !== undefined ? options.dataLinks : (player.dataLinks || []));
  
  const spawn = getPlayerSpawn(room, player.id);
  const spawnRng = seededRandom(((room.mapSeed || room.map?.seed || 0) ^ hashString(`${player.id}:${index}:${room.nextEntityId}`)) >>> 0);
  const { authoritativePhysicalRadius, findClearShipSpawnPoint } = require("./spawnPlanner");
  const { computeDesignCollisionRadius } = require("./componentGeometry");
  const physicalRadius = Math.max(authoritativePhysicalRadius(stats), computeDesignCollisionRadius(design, stats));
  const spawnPoint = options.spawnPoint || findClearShipSpawnPoint(room, {
    preferredX: spawn.x,
    preferredY: spawn.y,
    physicalRadius,
    navigationRadius: physicalRadius + Math.max(8, (Number(stats.radius) || 0) * 0.12),
    reservations: options.reservations,
    ownerId: player.id,
    requestId: options.requestId || `legacy:${room.nextEntityId}`,
    shipIndex: index,
    spawnAngle: spawn.angle
  });
  if (!spawnPoint?.ok && !Number.isFinite(spawnPoint?.x)) {
    throw new SpawnPlacementError(spawnPoint?.reason || "no-clear-spawn");
  }
  const ship = {
    id: `s${room.nextEntityId++}`,
    ownerId: player.id,
    x: spawnPoint.x,
    y: spawnPoint.y,
    vx: 0,
    vy: 0,
    angle: spawn.angle,
    combatStyle: options.combatStyle || "hold",
    combatStyleRaw: options.combatStyleRaw || options.combatStyle || "hold",
    // Which way round this hull orbits, whether or not it is orbiting yet. It
    // is carried like the stance rather than derived from it, so selecting Orbit
    // later already has a direction to use.
    orbitDirection: sanitizeOrbitDirection(options.orbitDirection, player?.orbitDirection),
    // A new hull inherits its owner' standing movement instructions, the same
    // way it inherits its combat stance.
    movementToggles: sanitizeMovementToggles(options.movementToggles || player?.movementToggles),
    targetX: spawnPoint.x,
    targetY: spawnPoint.y,
    alive: true,
    removed: false,
    removeAt: 0,
    hp: stats.maxHp,
    shield: 0,
    maxHp: stats.maxHp,
    maxShield: 0,
    stats,
    design,
    dataLinks,
    cost: stats.unitCost,
    radius: stats.radius,
    physicalRadius,
    blasterCooldown: rngRange(spawnRng, 0.08, 0.42),
    missileCooldown: rngRange(spawnRng, 0.35, 0.9),
    railgunCooldown: rngRange(spawnRng, 0.45, 1.4),
    repairPulseAt: 0,
    focusTargetId: null,
    lastDamagedBy: null,
    weaponAngles: [],
    weaponCooldowns: [],
    desiredAngles: [],
    aimTargetIds: [],
    componentTargetIds: [],
    beamContacts: []
  };
  ship.spawnState = {
    createdAt: now,
    expiresAt: now + 2400,
    launchPoint: { x: ship.x, y: ship.y },
    slotId: options.slotId || `${options.requestId || "spawn"}:${index}`
  };
  
  // Initialize design-index-aligned weapon runtime arrays before ship is placed in room.ships
  const { moduleRotationToRadians } = require("./combat");
  const { normalizeRotation } = require("./shipDesign");
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const part = require("./components").PARTS[module?.type];
    if (part?.weapon) {
      ship.weaponAngles[i] = moduleRotationToRadians(normalizeRotation(module.rotation));
      ship.weaponCooldowns[i] = 0;
      ship.desiredAngles[i] = 0;
      ship.aimTargetIds[i] = null;
      ship.componentTargetIds[i] = null;
      ship.beamContacts[i] = null;
    } else {
      ship.weaponAngles[i] = 0;
      ship.weaponCooldowns[i] = 0;
      ship.desiredAngles[i] = 0;
      ship.aimTargetIds[i] = null;
      ship.componentTargetIds[i] = null;
      ship.beamContacts[i] = null;
    }
  }
  
  // Per-component health, power, and heat state from the prebuilt template.
  const initStart = performance.now();
  if (template) {
    Object.assign(ship, clonePrebuiltShipState(template.prebuiltShipState));
    // Thermal topology is immutable design data and is intentionally shared by
    // every ship spawned from the same template.  All Heat arrays were cloned
    // above and remain ship-local.
    ship.thermalTopology = template.thermalTopology;
    const heatRuntime = require("./heat");
    heatRuntime.ensureThermalRuntime(ship);
    heatRuntime.refreshHeatRuntimeLists(ship);
    ship.componentCellIndex = new Map(template.componentCellIndex);
    ship.validEngineIndices = new Set(template.exhaustAnalysis.validEngineIndices);
    ship.blockedEngineIndices = new Set(template.exhaustAnalysis.blockedEngineIndices);
    ship.engineExhaustAnalysis = cloneValue(template.exhaustAnalysis);
    ship.engineExhaustRevision = 1;
  } else {
    initComponentState(ship);
    const { initializeComponentPower, effectiveShieldStats } = require("./componentPower");
    initializeComponentPower(ship);
    const shield = effectiveShieldStats(ship);
    ship.maxShield = Math.max(0, shield.capacity);
    ship.shield = ship.maxShield;
    initShipHeat(ship);
  }
  if (typeof recordPurchaseStage === 'function') {
    recordPurchaseStage("componentHealthInitialization", performance.now() - initStart);
    recordPurchaseStage("powerInitialization", 0);
    recordPurchaseStage("heatInitialization", 0);
  }
  
  // Drone Bay initialization
  const droneStart = performance.now();
  require("./drones").initializeDroneBays(room, ship, now);
  if (typeof recordPurchaseStage === 'function') {
    recordPurchaseStage("droneBayInitialization", performance.now() - droneStart);
  }
  
  // Decoy Launcher initialization
  const decoyStart = performance.now();
  require("./decoys").initializeDecoyLaunchers(room, ship, now);
  if (typeof recordPurchaseStage === 'function') {
    recordPurchaseStage("decoyLauncherInitialization", performance.now() - decoyStart);
  }

  ship.movement = createMovementRuntime();
  
  player.ships.push(ship);
  room.ships.set(ship.id, ship);
  if (room._visibilityRuntime) {
    const visibilityRuntime = require("./visibilityRuntime");
    visibilityRuntime.registerEntityMembership(room, room._visibilityRuntime, ship, "ship");
    visibilityRuntime.registerSensorSource(room, ship, "ship");
  }
  if (room.spatialIndex?.dynamicValid && typeof room.spatialIndex.append === "function") {
    const { shipBroadPhaseRadius } = require("./spatialIndex");
    room.spatialIndex.append("ships", ship, shipBroadPhaseRadius(ship));
  }
  const commandAura = require("./commandAuras");
  commandAura.invalidateCommandAuraSource(room, ship, "spawn");
  commandAura.invalidateCommandAuraRecipient(room, ship, "spawn");
  room.effects.push({ type: "warp", x: ship.x, y: ship.y, at: now });

  if (process.env.NODE_ENV !== "production") {
    console.log(`[DEBUG] Spawning ship ${ship.id} for player ${player.id} with combatStyle: ${ship.combatStyle}`);
  }

  return ship;
}

function getLiveShips(room, output = null) {
  const ships = output || [];
  ships.length = 0;
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
    dataLinks: [],
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
    kills: 0,
    losses: 0,
    captures: 0,
    connected: true,
    lastReadyAt: 0,
    purchaseRequests: new Map()
  };
  if (room.rules?.gameMode === "solo") player.team = player.id;

  room.players.set(player.id, player);
  invalidateRelationshipCache(room);
  invalidateSpawnPlan(room);
  broadcastRoom(room, { type: "notice", message: `${player.name} joined as a bot` });
  const { broadcastSnapshot } = require("./messages");
  broadcastSnapshot(room, performanceNow(), true);
}

function updateBots(room, now) {
  if (room.winner) return;

  const { buyShip } = require("./economy");
  const { areEnemies } = require("./combat");
  const { canTeamTargetEntity } = require("./visibility");
  const { commandShips } = require("./movement");
  const { usesStationInfrastructure } = require("./rooms");

  for (const player of room.players.values()) {
    if (!player.isBot || !player.ready || now < player.ai.nextThinkAt) continue;
    const ai = player.ai || (player.ai = { nextThinkAt: 0, objectiveId: null, decisionSeq: 0 });
    const seq = ai.decisionSeq || 0;
    const rng = seededRandom(((room.mapSeed || room.map?.seed || 0) ^ hashString(`${player.id}:bot:${seq}`)) >>> 0);
    ai.decisionSeq = seq + 1;
    ai.nextThinkAt = now + rngRange(rng, 900, 1700);
    const currentCost = player.stats?.unitCost || computeStats(player.design).unitCost;
    if (player.money >= currentCost) {
      // Station mode has no instant spawn: everything a player or bot buys is
      // built and launched by their home station.
      if (usesStationInfrastructure(room)) require("./stations").enqueueBotProduction(room, player, now);
      else buyShip(room, player, now, { silent: true });
    }
    const ships = player.ships.filter((ship) => ship.alive);
    if (ships.length === 0) continue;

    const enemies = getLiveShips(room)
      .filter((ship) => areEnemies(room, player.id, ship.ownerId) && canTeamTargetEntity(room, player.team, ship, now))
      .sort((a, b) => distanceToFleet(ships, a) - distanceToFleet(ships, b));
    const nearestEnemy = enemies[0];

    if (nearestEnemy && distanceToFleet(ships, nearestEnemy) < 760) {
      // Bots used to rotate through Charge/Orbit/Kite here. They stay on Hold:
      // Kite is still withdrawn, and picking between the flying stances is a
      // tactical decision this loop has no basis for making.
      for (const ship of ships) {
        if (!ship.combatStyle) ship.combatStyle = "hold";
      }
      commandShips(room, player, nearestEnemy.x, nearestEnemy.y, { targetId: nearestEnemy.id });
      continue;
    }

    const stationMode = usesStationInfrastructure(room);
    const objectiveList = stationMode ? (room.stations || []).filter((s) => s && s.stationType === "relay") : (room.points || []);
    const objectives = objectiveList
      .filter((point) => point && (stationMode ? !(point.state === "operational" && point.team === player.team) : (point.ownerTeam !== player.team || point.progress < 0.95)))
      .sort((a, b) => {
        const diff = distanceToFleet(ships, a) - distanceToFleet(ships, b);
        return diff || compareIdStrings(a.id || `${a.x},${a.y}`, b.id || `${b.x},${b.y}`);
      });
    const objective = objectives[0] || objectiveList[0];
    if (!objective) continue;
    commandShips(room, player, objective.x + rngRange(rng, -80, 80), objective.y + rngRange(rng, -80, 80));
  }
}

function chooseBotDesign() {
  return DEFAULT_DESIGN.map((part) => ({ ...part }));
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
  return null;
}

function applyRallyPoint(room, player, ships) {
  // A default spawn marker is informational, not an implicit movement order.
  // Newly purchased ships already have collision-safe launch positions, so only
  // send them elsewhere when the player has explicitly placed a rally point.
  if (!player?.rallyPoint) return new Map();
  const rallyPoint = getPlayerRallyPoint(room, player);
  if (!rallyPoint || !ships?.length) return new Map();
  const movingShips = ships.filter((ship) => Math.hypot(rallyPoint.x - ship.x, rallyPoint.y - ship.y) > 48);
  require("./movement").commandShipsToDestination(room, movingShips, rallyPoint, { prefix: "rally" });
  return rallyPoint;
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
  applyRallyPoint,
  distanceToFleet,
  getShipModuleWorldCoords,
  SpawnPlacementError
};
