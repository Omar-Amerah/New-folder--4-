// Creation, ownership mapping, death, and removal of ship entities (including bots).

const { COLORS, BOT_NAMES, MAX_PLAYERS_PER_ROOM, ECONOMY, DEFAULT_DESIGN } = require("./config");
const { sanitizeMovementToggles } = require("./validation");
const { performanceNow, seededRandom, rngRange, hashString, compareIdStrings } = require("./utils");
const { invalidateRelationshipCache } = require("./relationships");
const { computeStats } = require("./shipStats");
const { createShipBlueprintSnapshot, createGeneratedPowerWiring } = require("./shipDesign");
const { recordPurchaseStage } = require("./performanceTelemetry");
const { createMovementRuntime } = require("./movementRuntime");
const { createComponentAdjacency } = require("./thermalTopology");

class SpawnPlacementError extends Error {
  constructor(reason = "no-clear-spawn") {
    super(reason);
    this.name = "SpawnPlacementError";
    this.code = reason;
  }
}

function clonePrebuiltShipState(prebuilt) {
  return cloneValue(prebuilt, new Set(["design", "wiring", "stats", "thermalTopology", "componentAdjacency", "_thermalRuntime", "_heatScratch"]));
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
  
  // Use template if provided, otherwise fall back to legacy path
  const template = options.template;
  const stats = template ? template.stats : { ...(options.stats || player.stats || computeStats(player.design, player.wiring)) };
  const design = template ? template.design : (options.design || player.design);
  const wiring = template ? template.wiring : (options.wiring !== undefined ? options.wiring : player.wiring);
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
    wiring,
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
    ship.componentAdjacency = createComponentAdjacency(template.thermalTopology);
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
  if (room.spatialIndex?.dynamicValid && typeof room.spatialIndex.append === "function") {
    const { shipBroadPhaseRadius } = require("./spatialIndex");
    room.spatialIndex.append("ships", ship, shipBroadPhaseRadius(ship));
  }
  require("./movementContactPairs").noteShipSpawnedDuringMovementContactStep(room, ship);
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
  const wiring = createGeneratedPowerWiring(design);
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
    wiring,
    stats: computeStats(design, wiring),
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
    const currentCost = player.stats?.unitCost || computeStats(player.design, player.wiring).unitCost;
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
      // Bots used to rotate through Charge/Orbit/Kite here. Those stances are
      // withdrawn while Hold is the only one the controller flies, and assigning
      // them would leave a bot carrying a stance nothing implements.
      for (const ship of ships) {
        if (!ship.combatStyle) ship.combatStyle = "hold";
      }
      commandShips(room, player, nearestEnemy.x, nearestEnemy.y, {
        targetId: nearestEnemy.id,
        formation: ships.length > 2 ? "wedge" : "line"
      });
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
    commandShips(room, player, objective.x + rngRange(rng, -80, 80), objective.y + rngRange(rng, -80, 80), {
      formation: ships.length > 3 ? "clump" : "line"
    });
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

function applyRallySlots(room, player, ships) {
  // A default spawn marker is informational, not an implicit movement order.
  // Newly purchased ships already have collision-safe launch positions, so only
  // send them elsewhere when the player has explicitly placed a rally point.
  if (!player?.rallyPoint) return new Map();
  const rallyPoint = getPlayerRallyPoint(room, player);
  if (!rallyPoint || !ships?.length) return new Map();
  const { assignRallyArrivalSlots } = require("./spawnPlanner");
  // The rest of the fleet already holds places in the formation. A hangar
  // launch calls this one ship at a time, so without them the new ship is
  // handed the slot its predecessor is still flying toward.
  const slots = assignRallyArrivalSlots(room, ships, rallyPoint, { fleet: player.ships });
  const movingShips = [];
  for (const ship of ships) {
    const slot = slots.get(ship.id);
    if (!slot || Math.hypot(slot.x - ship.x, slot.y - ship.y) <= 48) continue;
    movingShips.push(ship);
    if (ship.spawnState) ship.spawnState.slotId = slot.id;
  }
  require("./movement").commandShipsToAssignedSlots(
    room,
    movingShips,
    slots,
    { prefix: "rally" }
  );
  return slots;
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
  applyRallySlots,
  distanceToFleet,
  getShipModuleWorldCoords,
  SpawnPlacementError
};
