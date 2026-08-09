// Creation, ownership mapping, death, and removal of ship entities (including bots).

const { COLORS, BOT_NAMES, MAX_PLAYERS_PER_ROOM, ECONOMY, DEFAULT_DESIGN } = require("./config");
const { sanitizeMovementToggles, sanitizeOrbitDirection } = require("./validation");
const { performanceNow, seededRandom, rngRange, hashString, compareIdStrings } = require("./utils");
const { invalidateRelationshipCache } = require("./relationships");
const { computeStats } = require("./shipStats");
const { recordPurchaseStage } = require("./performanceTelemetry");
const { createMovementRuntime } = require("./movementRuntime");
const {
  AI_DESIGN_MODES,
  normalizeAiDesignMode,
  getAiBlueprintPool,
  cloneAiBlueprint,
  chooseInitialAiBlueprint,
  blueprintForDesign,
  ROLE_LABELS
} = require("./aiBlueprints");

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
    aiRole: options.aiRole || null,
    aiBlueprintId: options.aiBlueprintId || null,
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

  const botSequence = room.nextBotId;
  const id = `bot${room.nextBotId++}`;
  const color = COLORS[room.colorCursor % COLORS.length];
  room.colorCursor += 1;
  const initialBlueprint = chooseInitialAiBlueprint(
    room.rules?.aiDesignMode,
    botSequence,
    room.rules?.startingMoney ?? ECONOMY.startingMoney
  );
  const design = initialBlueprint.design;
  const team = chooseBotTeam(room, requester, id);
  const name = BOT_NAMES[(room.nextBotId - 2) % BOT_NAMES.length];
  const player = {
    id,
    name,
    color,
    team,
    isBot: true,
    ai: createBotAiState(room.rules?.aiDesignMode, botSequence, initialBlueprint),
    ready: false,
    design,
    dataLinks: [],
    stats: initialBlueprint.stats || computeStats(design),
    combatStyle: initialBlueprint.combatStyle,
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
  const { usesStationInfrastructure } = require("./rooms");
  const stationMode = usesStationInfrastructure(room);

  for (const player of room.players.values()) {
    if (!player.isBot || !player.ready) continue;
    const ai = player.ai || (player.ai = createBotAiState(room.rules?.aiDesignMode, 0, null));
    if (now < (Number(ai.nextThinkAt) || 0)) continue;
    const seq = ai.decisionSeq || 0;
    const rng = seededRandom(((room.mapSeed || room.map?.seed || 0) ^ hashString(`${player.id}:bot:${seq}`)) >>> 0);
    ai.decisionSeq = seq + 1;
    ai.nextThinkAt = now + rngRange(rng, 900, 1700);

    let context = buildBotBattlefieldContext(room, player, player.ships.filter((ship) => ship.alive), now, stationMode);
    const blueprint = chooseBotBlueprint(room, player, context, rng);
    const activeCount = player.ships.filter((ship) => ship.alive).length;
    const queuedCount = countQueuedBotShips(room, player.id);
    if (blueprint
      && player.money >= blueprint.stats.unitCost
      && activeCount + queuedCount < player.shipCap) {
      const purchaseOptions = {
        design: blueprint.design,
        dataLinks: blueprint.dataLinks,
        stats: blueprint.stats,
        combatStyle: blueprint.combatStyle,
        combatStyleRaw: blueprint.combatStyle,
        aiRole: blueprint.role,
        aiBlueprintId: blueprint.id,
        silent: true
      };
      const purchased = stationMode
        ? require("./stations").enqueueBotProduction(room, player, now, purchaseOptions)
        : buyShip(room, player, now, purchaseOptions);
      if (purchased) {
        if (purchased.ownerId) {
          purchased.aiRole = blueprint.role;
          purchased.aiBlueprintId = blueprint.id;
        }
        rememberBotBlueprint(ai, blueprint.id);
      }
    }

    const ships = player.ships.filter((ship) => ship.alive);
    if (ships.length === 0) continue;
    context = buildBotBattlefieldContext(room, player, ships, now, stationMode);
    ai.objectiveId = context.objective?.relayId || context.objective?.id || null;
    issueBotOrders(room, player, ships, context, rng, now);
  }
}

function createBotAiState(mode, sequence, initialBlueprint) {
  return {
    nextThinkAt: 0,
    objectiveId: null,
    decisionSeq: 0,
    designMode: normalizeAiDesignMode(mode),
    blueprintSequence: Number(sequence) || 0,
    initialBlueprintId: initialBlueprint?.id || null,
    recentBlueprintIds: [],
    commandByRole: Object.create(null)
  };
}

function refreshBotDesigns(room) {
  const mode = normalizeAiDesignMode(room.rules?.aiDesignMode);
  for (const player of room.players.values()) {
    if (!player.isBot) continue;
    const sequence = Number(player.ai?.blueprintSequence) || Number(String(player.id).replace(/\D/g, "")) || 0;
    const blueprint = chooseInitialAiBlueprint(mode, sequence, room.rules?.startingMoney ?? ECONOMY.startingMoney);
    player.design = blueprint.design.map((part) => ({ ...part }));
    player.dataLinks = [];
    player.stats = blueprint.stats || computeStats(player.design);
    player.combatStyle = blueprint.combatStyle;
    player.ai = createBotAiState(mode, sequence, blueprint);
  }
}

function chooseBotDesign(sequence = 0, mode = AI_DESIGN_MODES.STANDARD) {
  return chooseInitialAiBlueprint(mode, sequence, ECONOMY.startingMoney).design;
}

function legacyUpdateBots(room, now) {
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

function legacyChooseBotDesign() {
  return DEFAULT_DESIGN.map((part) => ({ ...part }));
}

const BOT_COMBAT_ROLES = new Set(["assault", "artillery", "defence", "demolition", "recon", "siege"]);

function rememberBotBlueprint(ai, blueprintId) {
  const recent = Array.isArray(ai.recentBlueprintIds) ? ai.recentBlueprintIds : (ai.recentBlueprintIds = []);
  recent.push(blueprintId);
  if (recent.length > 8) recent.splice(0, recent.length - 8);
}

function countQueuedBotShips(room, playerId) {
  let count = 0;
  for (const station of room.stations || []) {
    for (const item of station?.productionQueue || []) {
      if (item?.playerId !== playerId) continue;
      count += Math.max(1, Number(item.quantityRemaining) || 1);
    }
  }
  return count;
}

function botRoleForShip(ship) {
  if (ROLE_LABELS[ship?.aiRole]) return ship.aiRole;
  return blueprintForDesign(ship?.design)?.role || "assault";
}

function botRoleCounts(room, player) {
  const counts = Object.create(null);
  for (const ship of player.ships || []) {
    if (!ship.alive) continue;
    const role = botRoleForShip(ship);
    counts[role] = (counts[role] || 0) + 1;
  }
  for (const station of room.stations || []) {
    for (const item of station?.productionQueue || []) {
      if (item?.playerId !== player.id) continue;
      const role = ROLE_LABELS[item.aiRole] ? item.aiRole : "assault";
      counts[role] = (counts[role] || 0) + Math.max(1, Number(item.quantityRemaining) || 1);
    }
  }
  return counts;
}

function botObjectiveId(objective) {
  return objective?.relayId || objective?.id || null;
}

function botObjectiveTeam(objective, stationMode) {
  return stationMode ? (objective?.team || null) : (objective?.ownerTeam || null);
}

function botObjectiveNeedsAction(objective, player, stationMode) {
  if (!objective) return false;
  if (stationMode) {
    if (objective.state === "neutral") return true;
    return objective.team !== player.team;
  }
  return objective.ownerTeam !== player.team || (Number(objective.progress) || 0) < 0.98;
}

function botObjectivePriority(objective, player, stationMode) {
  if (stationMode) {
    if (objective.state === "neutral") return 0;
    if (objective.team !== player.team) return 1;
    return 2;
  }
  if (!objective.ownerTeam) return 0;
  if (objective.ownerTeam !== player.team) return 1;
  return 2;
}

function getBotObjectiveList(room, stationMode) {
  return ((stationMode ? room.stations : room.points) || [])
    .filter((objective) => objective && (stationMode ? objective.stationType === "relay" : true));
}

function getEnemyHomeStation(room, player) {
  return (room.stations || []).find((station) => station?.stationType === "home"
    && station.state !== "destroyed"
    && station.team !== player.team);
}

function chooseBotObjective(room, player, ships, stationMode) {
  const objectives = getBotObjectiveList(room, stationMode);
  const actionable = objectives
    .filter((objective) => botObjectiveNeedsAction(objective, player, stationMode))
    .sort((a, b) => {
      const priority = botObjectivePriority(a, player, stationMode) - botObjectivePriority(b, player, stationMode);
      if (priority) return priority;
      const distance = distanceToFleet(ships, a) - distanceToFleet(ships, b);
      return distance || compareIdStrings(String(botObjectiveId(a)), String(botObjectiveId(b)));
    });
  if (actionable[0]) return actionable[0];
  // Once every relay is secure, station-mode bots must attack the enemy home
  // instead of circling a friendly relay forever. Classic mode ends through
  // relay control, so it keeps no equivalent fallback target.
  return stationMode ? getEnemyHomeStation(room, player) : null;
}

function buildBotBattlefieldContext(room, player, ships, now, stationMode) {
  const { areEnemies } = require("./combat");
  const { canTeamTargetEntity, usesSensorVisibility, isPointVisibleToTeam } = require("./visibility");
  const { effectiveSensorProfile } = require("./sensorCapability");
  const allEnemyShips = getLiveShips(room)
    .filter((ship) => areEnemies(room, player.id, ship.ownerId));
  const visibleEnemies = allEnemyShips
    .filter((ship) => canTeamTargetEntity(room, player.team, ship, now));
  const objectives = getBotObjectiveList(room, stationMode);
  const objective = chooseBotObjective(room, player, ships, stationMode);
  const damagedShips = ships
    .filter((ship) => ship.hp < ship.maxHp * 0.88 || ship.shield < ship.maxShield * 0.35)
    .sort((a, b) => (a.hp / Math.max(1, a.maxHp)) - (b.hp / Math.max(1, b.maxHp)));
  const sensorVisibility = usesSensorVisibility(room);
  const hiddenEnemyCount = Math.max(0, allEnemyShips.length - visibleEnemies.length);
  const reconObjectives = sensorVisibility
    ? objectives
      .filter((point) => !isPointVisibleToTeam(room, player.team, point.x, point.y, now, 0))
      .sort((a, b) => distanceToFleet(ships, a) - distanceToFleet(ships, b))
    : [];
  const sensorRange = ships.reduce(
    (best, ship) => Math.max(best, Number(effectiveSensorProfile(ship, room).omniRange) || 0),
    0
  );
  const objectiveEnemy = stationMode
    && objective?.stationType
    && objective.state !== "neutral"
    && objective.team !== player.team;
  const objectiveNeedsCapture = objectives.some((point) => {
    if (stationMode) return point.state === "neutral";
    return !point.ownerTeam || point.ownerTeam !== player.team || (Number(point.progress) || 0) < 0.98;
  });

  return {
    stationMode,
    objectives,
    objective,
    objectiveEnemy,
    objectiveNeedsCapture,
    allEnemyShips,
    visibleEnemies,
    hiddenEnemyCount,
    sensorNeed: sensorVisibility && hiddenEnemyCount > 0 && visibleEnemies.length === 0,
    reconObjective: reconObjectives[0] || objective || null,
    sensorRange,
    damagedShips,
    roleCounts: botRoleCounts(room, player)
  };
}
function botRoleWeights(context) {
  const weights = {
    assault: 1.5,
    artillery: 1,
    capture: 1.5,
    defence: 0.7,
    demolition: 0.8,
    recon: 0.5,
    siege: 0.8,
    support: 1
  };
  if (context.objectiveNeedsCapture) {
    weights.capture += 4;
    weights.assault += 1.5;
    weights.support += 0.5;
  }
  if (context.objectiveEnemy) {
    weights.demolition += 4;
    weights.siege += 3;
    weights.assault += 2;
  }
  if (context.visibleEnemies.length) {
    weights.assault += 3;
    weights.artillery += 2;
    weights.siege += 2;
    weights.defence += 1;
  }
  if (context.sensorNeed) weights.recon += 5;
  if (context.damagedShips.length) weights.support += 4;
  return weights;
}

function chooseBotBlueprint(room, player, context, rng) {
  const mode = normalizeAiDesignMode(room.rules?.aiDesignMode);
  const pool = getAiBlueprintPool(mode);
  if (!pool.length) return null;
  if (mode !== AI_DESIGN_MODES.BETTER) return cloneAiBlueprint(pool[0]);

  const affordable = pool.filter((blueprint) => blueprint.stats.unitCost <= Math.max(0, Number(player.money) || 0));
  if (!affordable.length) return null;
  const weights = botRoleWeights(context);
  const roleCounts = context.roleCounts || {};
  const recent = new Set(player.ai?.recentBlueprintIds || []);
  let best = null;
  let bestScore = -Infinity;
  for (const blueprint of affordable) {
    const roleCount = Number(roleCounts[blueprint.role]) || 0;
    const dps = Number(blueprint.stats.weaponDps) || 0;
    const cost = Math.max(1, Number(blueprint.stats.unitCost) || 1);
    let score = (weights[blueprint.role] || 0) * 10;
    score += roleCount === 0 ? 4 : -roleCount * 1.25;
    if (recent.has(blueprint.id)) score -= 3.5;
    score += Math.min(3, dps / cost * 4);
    score += Math.min(2, (Number(blueprint.stats.repairRate) || 0) / 20);
    score += Math.min(2, (Number(blueprint.stats.sensorRange) || 0) / 900);
    if (blueprint.role === "capture" && context.objectiveNeedsCapture) score += 4;
    if (blueprint.role === "recon" && context.sensorNeed) score += 6;
    if (blueprint.role === "support" && context.damagedShips.length) score += 4;
    // Spend up to the current budget without making every early purchase a
    // capital ship. The role score wins when the battlefield calls for one.
    score -= Math.max(0, cost / Math.max(1, Number(player.money) || 1) - 0.75) * 2;
    score += rng() * 1.25;
    if (score > bestScore) {
      best = blueprint;
      bestScore = score;
    }
  }
  return cloneAiBlueprint(best);
}

function chooseBotEnemy(group, enemies, role) {
  let best = null;
  let bestScore = -Infinity;
  for (const enemy of enemies || []) {
    const distance = distanceToFleet(group, enemy);
    const threat = (Number(enemy.cost) || Number(enemy.stats?.unitCost) || 0)
      + (Number(enemy.stats?.weaponDps) || 0) * 2;
    let score;
    if (role === "artillery" || role === "siege") {
      score = threat - distance * 0.04;
    } else if (role === "demolition" || role === "assault" || role === "defence") {
      score = -distance + threat * 0.08;
    } else {
      score = -distance;
    }
    if (score > bestScore || (score === bestScore && compareIdStrings(String(enemy.id), String(best?.id)) < 0)) {
      best = enemy;
      bestScore = score;
    }
  }
  return best;
}

function hasRepairCapability(ships) {
  return (ships || []).some((ship) => (Number(ship.stats?.repair) || 0) > 0 || (Number(ship.stats?.repairRate) || 0) > 0);
}

function chooseBotRepairTarget(group, damagedShips) {
  const selected = new Set((group || []).map((ship) => ship.id));
  return (damagedShips || []).find((ship) => !selected.has(ship.id)) || null;
}

function botObjectiveDestination(room, objective, role) {
  if (!objective) return { x: room.world.width / 2, y: room.world.height / 2 };
  const offsetByRole = {
    capture: 0,
    assault: 65,
    demolition: 45,
    defence: 150,
    artillery: 230,
    recon: 0,
    siege: 190,
    support: 180
  };
  const offset = offsetByRole[role] ?? 90;
  if (!offset) return { x: objective.x, y: objective.y };
  const angle = Math.atan2(objective.y - room.world.height / 2, objective.x - room.world.width / 2);
  return {
    x: Math.max(0, Math.min(room.world.width, objective.x + Math.cos(angle) * offset)),
    y: Math.max(0, Math.min(room.world.height, objective.y + Math.sin(angle) * offset))
  };
}

function planBotRole(room, player, group, role, context) {
  const objective = context.objective;
  const objectiveAttackable = Boolean(objective?.stationType
    && objective.state !== "neutral"
    && objective.team !== player.team);

  if (role === "support" && hasRepairCapability(group)) {
    const repairTarget = chooseBotRepairTarget(group, context.damagedShips);
    if (repairTarget) return { targetId: repairTarget.id, x: repairTarget.x, y: repairTarget.y };
  }

  // A capture group remains physically on the relay while the assault group
  // peels off to deal with defenders. This is the important difference between
  // merely travelling to a point and actually taking it under pressure.
  if (role === "capture" && objective && !objectiveAttackable && context.objectiveNeedsCapture) {
    return { ...botObjectiveDestination(room, objective, role) };
  }

  if (objectiveAttackable && BOT_COMBAT_ROLES.has(role)) {
    return { targetId: objective.id, x: objective.x, y: objective.y };
  }

  if (role === "recon" && context.sensorNeed) {
    return { ...botObjectiveDestination(room, context.reconObjective, role) };
  }

  const enemy = chooseBotEnemy(group, context.visibleEnemies, role);
  if (enemy && BOT_COMBAT_ROLES.has(role)) {
    return { targetId: enemy.id, x: enemy.x, y: enemy.y };
  }

  if (objective) return botObjectiveDestination(room, objective, role);
  if (enemy) return { targetId: enemy.id, x: enemy.x, y: enemy.y };
  return { x: room.world.width / 2, y: room.world.height / 2 };
}

function issueBotOrders(room, player, ships, context, rng, now) {
  const { commandShips } = require("./movement");
  const groups = new Map();
  for (const ship of ships) {
    const role = botRoleForShip(ship);
    ship.aiRole = role;
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(ship);
  }

  const ai = player.ai || (player.ai = createBotAiState(room.rules?.aiDesignMode, 0, null));
  for (const [role, group] of groups) {
    const plan = planBotRole(room, player, group, role, context, rng);
    const shipIds = group.map((ship) => ship.id).sort(compareIdStrings);
    const targetPart = plan.targetId ? `target:${plan.targetId}` : `move:${Math.round(plan.x / 32)},${Math.round(plan.y / 32)}`;
    const signature = `${role}:${targetPart}:${shipIds.join(",")}`;
    const previous = ai.commandByRole?.[role];
    if (previous?.signature === signature && now - previous.at < 2600) continue;
    commandShips(room, player, plan.x, plan.y, { shipIds, targetId: plan.targetId || null });
    ai.commandByRole[role] = { signature, at: now };
  }
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
  chooseBotBlueprint,
  refreshBotDesigns,
  botRoleForShip,
  buildBotBattlefieldContext,
  chooseBotTeam,
  getPlayerSpawn,
  getPlayerRallyPoint,
  applyRallyPoint,
  distanceToFleet,
  getShipModuleWorldCoords,
  SpawnPlacementError
};
