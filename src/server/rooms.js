// Owns room creation, room lookup, lifecycle cleanup, map generation, and room code generation.

const crypto = require("crypto");
const {
  WORLD_SIZES,
  MAX_PLAYERS_PER_ROOM,
  DEFAULT_ROOM_RULES,
  ASTEROID_DENSITY,
  ECONOMY,
  CLOSED_ROOM_CODE_TTL_MS,
  MAP_NAMES,
  MAP_CLOUD_COLORS,
  MAP_REFERENCE_AREA,
  resolveMapClearances
} = require("./config");
const { clearVisibilityForRoom, usesSensorVisibility } = require("./visibility");
const {
  clampNumber,
  rngRange,
  seededRandom,
  hashString,
  round,
  performanceNow
} = require("./utils");
const { sanitizeRoomCode } = require("./validation");
const { validateGeneratedMap } = require("./mapValidation");
const { getSpawnRegionPlan, invalidateSpawnPlan } = require("./spawnPlanner");

const rooms = new Map();
const closedRoomCodes = new Map();

const ROOM_ARRAY_SCRATCH_FIELDS = Object.freeze([
  "_liveShipScratch",
  "_projectileLiveShipScratch",
  "_supportSpatialScratch",
  "_weaponSupportSpatialScratch",
  "_droneMovementScratch",
  "_droneSeparationScratch",
  "_projectileSpare",
  "_effectSpare"
]);
const ROOM_OBJECT_ARRAY_SCRATCH_FIELDS = Object.freeze([
  "_pointDefenseSpatialScratch",
  "_projectileSpatialScratch"
]);

function clearRoomRuntimeScratch(room) {
  if (!room) return;
  for (const field of ROOM_ARRAY_SCRATCH_FIELDS) {
    if (Array.isArray(room[field])) room[field].length = 0;
  }
  for (const field of ROOM_OBJECT_ARRAY_SCRATCH_FIELDS) {
    const scratch = room[field];
    if (!scratch || typeof scratch !== "object") continue;
    for (const value of Object.values(scratch)) {
      if (Array.isArray(value)) value.length = 0;
    }
  }
}

function createRoom(code, options = {}) {
  const world = chooseWorldSize(1);
  const mapSeed = options.seed == null ? createMapSeed(code) : Number(options.seed) >>> 0;
  const map = generateMap(code, world, DEFAULT_ROOM_RULES.gameMode, DEFAULT_ROOM_RULES.asteroidDensity, { seed: mapSeed });
  return {
    code,
    adminId: null,
    phase: "lobby",
    world,
    mapSizeLabel: world.label,
    clients: new Set(),
    players: new Map(),
    ships: new Map(),
    drones: new Map(),
    decoys: new Map(),
    droneCounts: { byOwner: new Map(), byParent: new Map() },
    bullets: [],
    projectileById: new Map(),
    _projectileLookupInitialized: true,
    spatialIndex: null,
    effects: [],
    spawnReservations: [],
    spawnCollisionDiagnostics: {},
    map,
    mapSeed,
    points: map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 })),
    kickedNames: new Set(),
    nextEntityId: 1,
    nextBotId: 1,
    colorCursor: 0,
    lastEmptyAt: 0,
    winner: null,
    rewardsFinalizedForWinner: null,
    winnerAt: 0,
    controlVictory: {
      team: null,
      playerId: null,
      startedAt: null,
      remaining: null,
      requiredSeconds: 20
    },
    rules: { ...DEFAULT_ROOM_RULES },
    playerColors: new Map(),
    stateEpoch: 1,
    snapshotSeq: 0,
    staticRevision: 1,
    componentCatalogueRevision: 1
  };
}

function bumpStateEpoch(room, reason = "state-reset") {
  require("./relationships").invalidateRelationshipCache(room);
  room.stateEpoch = Math.max(1, Number(room.stateEpoch) || 1) + 1;
  room.snapshotSeq = 0;
  require("./projectileReplication").resetProjectileReplication(room, room.stateEpoch);
  room.staticRevision = Math.max(1, Number(room.staticRevision) || 1) + 1;
  room.lastEpochReason = reason;
  for (const ship of room.ships?.values?.() || []) {
    ship.designSent = false;
    ship.dirtyComponents?.clear?.();
    ship.dirtyHeat?.clear?.();
    ship.dirtyPower = false;
    ship.dirtyPowerProtection = false;
  }
  for (const client of room.clients || []) {
    if (client.snapshotBaseline) {
      client.snapshotBaseline.fullRequired = true;
      client.snapshotBaseline.stateEpoch = room.stateEpoch;
      client.snapshotBaseline.lastSentSeq = 0;
      client.snapshotBaseline.lastFullSeq = 0;
    }
  }
}

function setRoomRules(room, requester, updates) {
  const { isAdmin } = require("./players");
  if (!isAdmin(room, requester)) {
    const { sendPlayer } = require("./messages");
    sendPlayer(room, requester, { type: "error", message: "Only the room admin can change game rules" });
    return;
  }
  if (room.phase !== "lobby") {
    const { sendPlayer } = require("./messages");
    sendPlayer(room, requester, { type: "error", message: "Game rules are locked after ship design starts" });
    return;
  }

  // Map regeneration can reject a pathological layout. Apply the rule change
  // transactionally: on failure restore the previous rules/world/map so the
  // room is never left half-mutated, and tell the admin instead of surfacing
  // a generic internal error from the route dispatcher.
  const previous = { rules: room.rules, world: room.world, mapSizeLabel: room.mapSizeLabel, mapSeed: room.mapSeed, map: room.map, points: room.points, teams: new Map([...room.players.values()].map((player) => [player.id, player.team])) };
  room.rules = sanitizeRoomRules({ ...room.rules, ...updates }, room.players.size);
  bumpStateEpoch(room, "rule-regeneration");
  applyGameModeTeams(room);
  require("./relationships").revalidateTelemetryFocusForRoom(room);
  invalidateSpawnPlan(room);
  try {
    const world = chooseRoomWorld(room);
    room.world = world;
    room.mapSizeLabel = world.label;
    room.mapSeed = createMapSeed(room.code);
    room.map = generateMapWithAuthoritativeSafeZones(room);
    room.points = room.map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 }));
  } catch (error) {
    room.rules = previous.rules;
    room.world = previous.world;
    room.mapSizeLabel = previous.mapSizeLabel;
    room.mapSeed = previous.mapSeed;
    room.map = previous.map;
    room.points = previous.points;
    for (const player of room.players.values()) if (previous.teams.has(player.id)) player.team = previous.teams.get(player.id);
    invalidateSpawnPlan(room);
    console.error(`[rooms] rule change rejected for ${room.code}: ${String(error?.message || error)}`);
    const { sendPlayer, broadcastSnapshot: rebroadcast } = require("./messages");
    sendPlayer(room, requester, { type: "error", message: "Could not generate a map for those rules. The previous rules were kept." });
    rebroadcast(room, performanceNow(), true);
    return;
  }

  for (const player of room.players.values()) {
    player.money = room.rules.startingMoney;
    player.bank = room.rules.startingMoney;
    player.earned = room.rules.startingMoney;
    player.maxMoney = Math.max(ECONOMY.maxMoney, room.rules.startingMoney);
  }

  const { broadcastSnapshot } = require("./messages");
  broadcastSnapshot(room, performanceNow(), true);
}

function sanitizeInfrastructureMode(value) {
  if (value === "classic" || value === "stations") return value;
  return DEFAULT_ROOM_RULES.infrastructureMode;
}

function usesStationInfrastructure(room) {
  return room?.rules?.infrastructureMode === "stations";
}

function sanitizeVisibilityMode(value) {
  const text = String(value || "").trim().toLowerCase();
  if (text === "full" || text === "sensors" || text === "dark") return text;
  return DEFAULT_ROOM_RULES.visibilityMode;
}

function sanitizeRoomRules(input, playerCount = 1) {
  const currentPlayers = Math.max(1, Number(playerCount) || 1);
  const startingMoney = Math.round(clampNumber(input.startingMoney, 100, ECONOMY.maxMoney));
  const maxPlayers = Math.trunc(clampNumber(input.maxPlayers, Math.max(2, currentPlayers), MAX_PLAYERS_PER_ROOM));
  const mapSize = sanitizeMapSize(input.mapSize);
  const gameMode = sanitizeGameMode(input.gameMode);
  const asteroidDensity = sanitizeAsteroidDensity(input.asteroidDensity);
  const infrastructureMode = sanitizeInfrastructureMode(input.infrastructureMode);
  const visibilityMode = sanitizeVisibilityMode(input.visibilityMode);
  return { startingMoney, maxPlayers, mapSize, gameMode, asteroidDensity, infrastructureMode, visibilityMode };
}

function sanitizeAsteroidDensity(value) {
  const text = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(ASTEROID_DENSITY, text) ? text : DEFAULT_ROOM_RULES.asteroidDensity;
}

function sanitizeMapSize(value) {
  const text = String(value || "auto");
  if (text === "auto") return "auto";
  const match = WORLD_SIZES.find((size) => size.label === text);
  return match ? match.label : "auto";
}

function sanitizeGameMode(value) {
  const text = String(value || "").toLowerCase();
  return text === "solo" ? "solo" : "teams";
}

function applyGameModeTeams(room) {
  if (room.rules?.gameMode === "solo") {
    for (const player of room.players.values()) player.team = player.id;
    require("./relationships").invalidateRelationshipCache(room);
    return;
  }

  const { balanceTeam } = require("./players");
  for (const player of room.players.values()) {
    if (player.team !== "blue" && player.team !== "red") {
      player.team = balanceTeam(room);
    }
  }
  require("./relationships").invalidateRelationshipCache(room);
}

function createMapSeed(roomCode = "") {
  // MFA_MAP_SEED pins every arena to one layout so a reported map can be replayed
  // exactly. crypto randomness already dominates the mix, so no clock term.
  const forced = Number.parseInt(process.env.MFA_MAP_SEED ?? "", 10);
  if (Number.isFinite(forced)) return forced >>> 0;
  return (crypto.randomBytes(4).readUInt32BE(0) ^ hashString(roomCode)) >>> 0;
}

function generateMap(roomCode, world, gameMode, asteroidDensity, options = {}) {
  const seed = Number.isInteger(options.seed) ? (options.seed >>> 0) : createMapSeed(roomCode);
  const rng = seededRandom(seed);
  const safeZones = options.safeZones || generateSafeZones(world, gameMode);
  const clearances = resolveMapClearances(world);
  const context = { roomCode, gameMode, asteroidDensity, safeZones };

  if (world.label === "Testing") {
    return validateMapOrFallback({
      seed,
      name: "Testing Sandbox",
      relays: [{ id: "A", x: Math.round(world.width * 0.5), y: Math.round(world.height * 0.5), radius: 160 }],
      asteroids: [],
      clouds: generateClouds(rng, world, 1),
      safeZones,
      generation: makeGenerationReport(1, 1, "skipped", { asteroids: 0, relays: 1 }, { asteroids: 0, relays: 1 })
    }, world, context);
  }

  const densityMultiplier = ASTEROID_DENSITY[asteroidDensity] ?? ASTEROID_DENSITY.medium;
  const areaScale = (world.width * world.height) / MAP_REFERENCE_AREA;
  const attempt = layOutTerrain(seed, world, safeZones, clearances, {
    densityMultiplier,
    areaScale,
    orders: symmetryOrderCandidates(resolveSymmetryOrder(options, gameMode, safeZones))
  });

  const map = {
    seed,
    name: MAP_NAMES[seed % MAP_NAMES.length],
    relays: attempt.relays.relays,
    asteroids: attempt.asteroids.asteroids,
    clouds: generateClouds(attempt.rng, world, areaScale),
    safeZones,
    generation: makeGenerationReport(
      attempt.order,
      areaScale,
      attempt.asteroids.connectivity,
      { asteroids: attempt.asteroids.requested, relays: attempt.relays.requested },
      { asteroids: attempt.asteroids.asteroids.length, relays: attempt.relays.relays.length }
    )
  };
  reportGenerationShortfall(map, context);
  return validateMapOrFallback(map, world, context);
}

// A rectangular arena cannot host every symmetry order: rotation is taken in
// normalized space, so for large N the images crowd together near the short axis
// and no group can ever satisfy its own clearance. Try the roster's own order
// first and step down through its divisors, so terrain is as fair as the arena
// can actually support and never degenerates into an empty map.
function layOutTerrain(seed, world, safeZones, clearances, options) {
  let last = null;
  for (let index = 0; index < options.orders.length; index += 1) {
    const order = options.orders[index];
    // Each order gets its own stream so a failed attempt cannot shift the
    // sequence the successful one draws from.
    const rng = seededRandom((seed ^ Math.imul(order, 0x9e3779b1)) >>> 0);
    const transforms = symmetryTransforms(world, order);
    const relays = generateRelays(rng, world, safeZones, transforms, clearances);
    const asteroids = generateAsteroidField(rng, world, relays.relays, safeZones, {
      densityMultiplier: options.densityMultiplier,
      areaScale: options.areaScale,
      transforms,
      clearances
    });
    last = { order, rng, relays, asteroids };
    if (index === options.orders.length - 1 || terrainIsHealthy(relays, asteroids)) return last;
  }
  return last;
}

function terrainIsHealthy(relays, asteroids) {
  if (relays.relays.length < 3) return false;
  return asteroids.requested === 0 || asteroids.asteroids.length >= asteroids.requested * 0.45;
}

// N first, then its divisors down to 2. Rotating by 2*pi/d where d divides N still
// maps the player ring onto itself, so a divisor keeps players interchangeable in
// groups rather than abandoning symmetry outright. Primes fall straight to 2.
function symmetryOrderCandidates(order) {
  const candidates = [order];
  for (let divisor = order - 1; divisor >= 2; divisor -= 1) {
    if (order % divisor === 0) candidates.push(divisor);
  }
  if (!candidates.includes(2)) candidates.push(2);
  return candidates;
}

function makeGenerationReport(symmetryOrder, areaScale, connectivity, requested, placed) {
  return { symmetryOrder, areaScale: round(areaScale), connectivity, requested, placed };
}

// Placement is best-effort by design, but silence turned "veryHigh" and "high"
// into the same map on saturated arenas. The exact counts always live on
// map.generation; warn only when the field came out badly short, since a dense
// arena legitimately saturates around 60-75% of its requested budget.
function reportGenerationShortfall(map, context) {
  const { requested, placed } = map.generation;
  if (requested.asteroids >= 6 && placed.asteroids < requested.asteroids * 0.4) {
    console.warn(`Map generation shortfall room=${context.roomCode || "?"} seed=${map.seed} density=${context.asteroidDensity} symmetry=${map.generation.symmetryOrder}: placed ${placed.asteroids}/${requested.asteroids} asteroids`);
  }
}

// Teams play across the x-axis, so 180deg point symmetry is the fair mapping.
// Solo players are distributed radially by spawnPlanner.preferredSlots, where
// 180deg is only fair for even rosters -- 3, 5 and 7 players used to get terrain
// that simply did not exist for someone else. Match the roster's own order.
function resolveSymmetryOrder(options, gameMode, safeZones) {
  if (Number.isInteger(options.symmetryOrder)) return Math.max(1, Math.min(8, options.symmetryOrder));
  if (gameMode !== "solo") return 2;
  return Math.max(2, Math.min(8, safeZones.length || 2));
}

// Rotation happens in the unit-ellipse space centred on the world, which is the
// same basis spawnPlanner uses to lay out solo players, so terrain symmetry lines
// up with base symmetry on non-square arenas. Snapping keeps order 2 exactly
// equal to the historical integer mirror (width - x, height - y).
function symmetryTransforms(world, order) {
  const cx = world.width / 2;
  const cy = world.height / 2;
  const transforms = [];
  for (let k = 0; k < order; k += 1) {
    const angle = (2 * Math.PI * k) / order;
    const cos = snapUnit(Math.cos(angle));
    const sin = snapUnit(Math.sin(angle));
    transforms.push((x, y) => {
      const nx = (x - cx) / cx;
      const ny = (y - cy) / cy;
      return { x: cx + (nx * cos - ny * sin) * cx, y: cy + (nx * sin + ny * cos) * cy };
    });
  }
  return transforms;
}

function snapUnit(value) {
  if (Math.abs(value) < 1e-9) return 0;
  if (Math.abs(value - 1) < 1e-9) return 1;
  if (Math.abs(value + 1) < 1e-9) return -1;
  return value;
}

// The N images of a seed sit on a ring, so neighbours are a chord apart:
// 2 * r * sin(pi / N). Below this radius a group can never satisfy its own mutual
// clearance and every attempt is wasted. Deliberately optimistic (longer
// semi-axis): this is only an attempt filter, and the real pairwise check in
// asteroidGroupIsPlaceable is authoritative, so it must never exclude a ring that
// would actually have fit.
function minNormalizedRadius(world, order, requiredGap) {
  if (order < 2) return 0;
  const maxSemiAxis = Math.max(world.width, world.height) / 2;
  return requiredGap / (maxSemiAxis * 2 * Math.sin(Math.PI / order));
}

// Area-uniform sampling in the normalized annulus, so features do not bunch up
// near the centre the way a uniform radius would.
function sampleAnnulus(rng, minRadius, maxRadius) {
  return Math.sqrt(rngRange(rng, minRadius * minRadius, maxRadius * maxRadius));
}

function symmetricImages(transforms, circle) {
  return transforms.map((transform) => {
    const point = transform(circle.x, circle.y);
    return roundMapCircle({ x: point.x, y: point.y, radius: circle.radius });
  });
}

function validateMapOrFallback(map, world, context = {}) {
  const validation = validateGeneratedMap(map, world, { seed: map?.seed });
  if (validation.ok) return map;
  const message = `Generated invalid map seed=${validation.seed} room=${context.roomCode || "?"}: ${validation.errors.join("; ")}`;
  console.error(message);
  return buildFallbackMap(map, world, context);
}

function buildFallbackMap(map, world, context) {
  // Reuse the authoritative safe zones. Regenerating the static ones here used to
  // leave room.map.safeZones disagreeing with the spawn plan players actually
  // spawn into, and could drop the fallback relay straight onto a base.
  const safeZones = context.safeZones || generateSafeZones(world, context.gameMode || "teams");
  const clearances = resolveMapClearances(world);
  const central = searchOpenCircle(world, safeZones, clearances.relayToSafeZone, 160)
    || searchOpenCircle(world, safeZones, clearances.relayToSafeZone, 110);
  const fallback = {
    seed: (map?.seed ?? 0) >>> 0,
    name: "Fallback Arena",
    relays: central ? [{ id: "A", x: central.x, y: central.y, radius: central.radius }] : [],
    asteroids: [],
    clouds: [],
    safeZones,
    generation: makeGenerationReport(1, 1, "fallback", { asteroids: 0, relays: 1 }, { asteroids: 0, relays: central ? 1 : 0 })
  };
  const check = validateGeneratedMap(fallback, world, { seed: fallback.seed });
  if (!check.ok) console.error(`Fallback arena is also invalid room=${context.roomCode || "?"}: ${check.errors.join("; ")}`);
  return fallback;
}

// Default zones for direct generateMap calls (tests, tooling). Live rooms always
// pass authoritative zones from spawnPlanner via options.safeZones.
// Fallback regions, used only until the authoritative per-roster plan resolves
// (see applyAuthoritativeSafeZones). A home station is planted on the centre of
// whichever region belongs to the team, so both the radius and the inset from
// the world edge have to be able to hold the structure — otherwise the station
// hangs off the side of the map for the first few frames of a room's life.
function generateSafeZones(world, gameMode) {
  const zones = [];
  const { buildHomeStationGeometry } = require("./stationTemplates");
  const stationShell = buildHomeStationGeometry().shell;
  const stationRadius = Math.hypot(
    stationShell.maxX - stationShell.minX,
    stationShell.maxY - stationShell.minY
  ) / 2 + 40;
  const spawnRadius = Math.max(275, Math.ceil(stationRadius));
  const sideInset = spawnRadius;
  if (gameMode === "teams") {
    zones.push({ x: sideInset, y: world.height * 0.5, radius: spawnRadius, color: "rgba(63,214,255,0.06)", borderColor: "#38d5ff", isSpawn: true, team: "blue" });
    zones.push({ x: world.width - sideInset, y: world.height * 0.5, radius: spawnRadius, color: "rgba(255,95,126,0.06)", borderColor: "#ff5f7e", isSpawn: true, team: "red" });
  } else {
    // Solo zones
    zones.push({ x: sideInset, y: world.height * 0.5, radius: spawnRadius, color: "rgba(255,255,255,0.06)", isSpawn: true });
    zones.push({ x: world.width - sideInset, y: world.height * 0.5, radius: spawnRadius, color: "rgba(255,255,255,0.06)", isSpawn: true });
    zones.push({ x: world.width * 0.5, y: sideInset, radius: spawnRadius, color: "rgba(255,255,255,0.06)", isSpawn: true });
    zones.push({ x: world.width * 0.5, y: world.height - sideInset, radius: spawnRadius, color: "rgba(255,255,255,0.06)", isSpawn: true });
  }
  return zones;
}

function applyAuthoritativeSafeZones(room) {
  invalidateSpawnPlan(room);
  const plan = getSpawnRegionPlan(room);
  room.map.safeZones = plan.safeZones;
  return plan;
}

function generateMapWithAuthoritativeSafeZones(room) {
  // Bases resolve against a deliberately empty map: terrain yields to spawns,
  // never the reverse. spawnPlanner.isLegal's asteroid/relay checks are therefore
  // no-ops here and only bite on a later re-plan against real terrain.
  room.map = { seed: room.mapSeed, name: "Planning", relays: [], asteroids: [], clouds: [], safeZones: [] };
  invalidateSpawnPlan(room);
  const plan = getSpawnRegionPlan(room);
  return generateMap(room.code, room.world, room.rules?.gameMode || "teams", room.rules?.asteroidDensity, { seed: room.mapSeed, safeZones: plan.safeZones });
}

function generateRelays(rng, world, safeZones, transforms, clearances) {
  const withCentral = buildRelayLayout(rng, world, safeZones, transforms, clearances, true);
  // On a crowded arena the central relay's exclusion radius can be the only thing
  // blocking every outer group, leaving a single capture point and a degenerate
  // control game. Trading it for a real layout is the better arena.
  if (withCentral.relays.length >= 3) return finalizeRelays(withCentral);
  const withoutCentral = buildRelayLayout(rng, world, safeZones, transforms, clearances, false);
  return finalizeRelays(withoutCentral.relays.length > withCentral.relays.length ? withoutCentral : withCentral);
}

function buildRelayLayout(rng, world, safeZones, transforms, clearances, useCentral) {
  const relays = [];
  // Added first so symmetric groups check clearance against it.
  const central = useCentral ? placeCentralRelay(rng, world, safeZones, clearances) : null;
  if (central) relays.push(central);

  const order = transforms.length;
  // Aim for roughly 5-7 relays whatever the symmetry order happens to be.
  const groupCount = Math.max(1, Math.min(3, Math.round(5 / order)));
  for (let group = 0; group < groupCount; group += 1) {
    addSymmetricRelayGroup(rng, relays, world, safeZones, transforms, clearances);
  }
  return { relays, requested: (useCentral ? 1 : 0) + groupCount * order };
}

function finalizeRelays(layout) {
  const ordered = layout.relays
    .sort((a, b) => a.x - b.x || a.y - b.y)
    .map((relay, index) => ({ id: relayId(index), x: relay.x, y: relay.y, radius: relay.radius }));
  return { relays: ordered, requested: layout.requested };
}

function relayId(index) {
  const letter = String.fromCharCode(65 + (index % 26));
  return index < 26 ? letter : `${letter}${Math.floor(index / 26) + 1}`;
}

// Relaxes across attempts (widening box, shrinking radius) and finally falls back
// to a deterministic grid search. It never throws: an unplaceable relay used to
// blow up the roster-change handler that triggered arena preparation.
function placeCentralRelay(rng, world, safeZones, clearances) {
  const buffer = clearances.relayToSafeZone;
  const preferredRadius = rngRange(rng, 150, 180);
  const attempts = 48;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const progress = attempt / attempts;
    const spread = 200 + progress * Math.min(world.width, world.height) * 0.25;
    const candidate = roundMapCircle({
      x: world.width * 0.5 + rngRange(rng, -spread, spread),
      y: world.height * 0.5 + rngRange(rng, -spread, spread),
      radius: Math.max(110, preferredRadius * (1 - progress * 0.35))
    });
    if (insideWorld(candidate, world, 0) && circlesClear(candidate, safeZones, buffer)) return candidate;
  }
  return searchOpenCircle(world, safeZones, buffer, 140) || searchOpenCircle(world, safeZones, buffer, 110);
}

// Deterministic coarse sweep for the spot with the most slack against every safe
// zone. Used as the last resort for the central relay and by the fallback arena.
function searchOpenCircle(world, safeZones, buffer, radius) {
  const steps = 24;
  let best = null;
  let bestSlack = -Infinity;
  for (let ix = 1; ix < steps; ix += 1) {
    for (let iy = 1; iy < steps; iy += 1) {
      const x = Math.round((world.width * ix) / steps);
      const y = Math.round((world.height * iy) / steps);
      if (x - radius < 0 || x + radius > world.width || y - radius < 0 || y + radius > world.height) continue;
      let slack = Infinity;
      for (const zone of safeZones) slack = Math.min(slack, Math.hypot(x - zone.x, y - zone.y) - zone.radius - radius - buffer);
      if (slack > bestSlack) {
        bestSlack = slack;
        best = { x, y, radius };
      }
    }
  }
  return bestSlack >= 0 ? best : null;
}

const RELAY_RADIUS_RANGE = Object.freeze({ min: 140, max: 170 });

function addSymmetricRelayGroup(rng, relays, world, safeZones, transforms, clearances) {
  const cx = world.width / 2;
  const cy = world.height / 2;
  // Normalized polar sampling scales with the world. The old fixed left-hand
  // rectangle plus an absolute 800u gap starved small arenas of relays.
  const floor = minNormalizedRadius(world, transforms.length, RELAY_RADIUS_RANGE.max * 2 + clearances.relayToRelay);
  const minRadius = Math.max(0.3, floor);
  const maxRadius = 0.86;
  if (minRadius >= maxRadius) return false;
  const attempts = 160;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const nr = sampleAnnulus(rng, minRadius, maxRadius);
    const theta = rngRange(rng, 0, Math.PI * 2);
    // Shrink toward the floor as attempts fail, matching placeCentralRelay. A
    // crowded arena is better served by smaller relays than by none at all.
    const ceiling = RELAY_RADIUS_RANGE.max - (RELAY_RADIUS_RANGE.max - RELAY_RADIUS_RANGE.min) * (attempt / attempts);
    const images = symmetricImages(transforms, {
      x: cx + Math.cos(theta) * nr * cx,
      y: cy + Math.sin(theta) * nr * cy,
      radius: rngRange(rng, Math.min(RELAY_RADIUS_RANGE.min, ceiling), ceiling)
    });
    if (!relayGroupIsPlaceable(images, world, relays, safeZones, clearances)) continue;
    relays.push(...images);
    return true;
  }
  return false;
}

function relayGroupIsPlaceable(images, world, relays, safeZones, clearances) {
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (!insideWorld(image, world, 0)) return false;
    if (!circlesClear(image, relays, clearances.relayToRelay)) return false;
    if (!circlesClear(image, safeZones, clearances.relayToSafeZone)) return false;
    for (let j = i + 1; j < images.length; j += 1) {
      if (!circlesClear(image, [images[j]], clearances.relayToRelay)) return false;
    }
  }
  return true;
}

function generateAsteroidField(rng, world, relays, safeZones, options) {
  const { densityMultiplier, areaScale, transforms, clearances } = options;
  if (densityMultiplier <= 0) return { asteroids: [], requested: 0, connectivity: "clear" };

  // Budgets are totals scaled by world area -- they used to be flat counts, so a
  // Grand battle map got a Duel map's rock budget over 3.5x the area.
  const fieldTotal = (16 + Math.floor(rng() * 16)) * densityMultiplier * areaScale;
  const centralTotal = (8 + Math.floor(rng() * 8)) * densityMultiplier * areaScale;
  const order = transforms.length;
  const fieldGroups = Math.max(0, Math.round(fieldTotal / order));
  const centralGroups = Math.max(0, Math.round(centralTotal / order));
  // Requested counts what generation actually set out to place, so the shortfall
  // warning measures placement failure rather than group-rounding.
  const requested = (fieldGroups + centralGroups) * order;
  const bands = asteroidBands(world, order, clearances);
  const anchors = makeClusterAnchors(rng, bands);

  let asteroids = [];
  // Terrain that walls a relay off is worse than sparse terrain, so retry with a
  // thinner field. Never fatal: the last attempt is kept and the outcome recorded,
  // so a coarse-grid false negative can never take a room down.
  for (let pass = 0; pass < 3; pass += 1) {
    const thinning = 0.75 ** pass;
    asteroids = layAsteroids(rng, world, relays, safeZones, {
      fieldGroups: Math.round(fieldGroups * thinning),
      centralGroups: Math.round(centralGroups * thinning),
      anchors,
      bands,
      transforms,
      clearances
    });
    if (relaysAreReachable(world, asteroids, relays, safeZones)) {
      return { asteroids, requested, connectivity: pass === 0 ? "clear" : "clear-after-thinning" };
    }
  }
  return { asteroids, requested, connectivity: "degraded" };
}

const ASTEROID_RADIUS_RANGE = Object.freeze({ min: 60, max: 140 });

// The placeable annulus for a symmetry order, plus the innermost slice of it that
// still counts as the contested middle. The outer bound is where a rock of the
// largest radius still clears the world edge, so attempts are not spent outside.
function asteroidBands(world, order, clearances) {
  const minSemiAxis = Math.min(world.width, world.height) / 2;
  const floor = minNormalizedRadius(world, order, ASTEROID_RADIUS_RANGE.max * 2 + clearances.asteroidToAsteroid);
  const min = Math.max(0.08, floor);
  const max = 1 - (ASTEROID_RADIUS_RANGE.max + clearances.edgeInset) / minSemiAxis;
  return { min, max, centralMax: Math.min(max, Math.max(min + 0.1, 0.34)), placeable: min < max };
}

function normalizedRadius(point, world) {
  const nx = (point.x - world.width / 2) / (world.width / 2);
  const ny = (point.y - world.height / 2) / (world.height / 2);
  return Math.hypot(nx, ny);
}

// Cluster anchors turn a uniform scatter into belts and fields. Asteroids block
// line of sight in combat.js, so terrain shape is a tactical input, not decoration.
function makeClusterAnchors(rng, bands) {
  if (!bands.placeable) return [];
  const anchors = [];
  for (let i = 0; i < 4; i += 1) {
    const nr = sampleAnnulus(rng, bands.min, Math.min(bands.max, 0.85));
    const theta = rngRange(rng, 0, Math.PI * 2);
    anchors.push({ nx: Math.cos(theta) * nr, ny: Math.sin(theta) * nr });
  }
  return anchors;
}

function layAsteroids(rng, world, relays, safeZones, options) {
  const { fieldGroups, centralGroups, anchors, bands, transforms, clearances } = options;
  if (!bands.placeable) return [];
  const asteroids = [];
  const reserved = safeZones.map((zone) => ({ x: zone.x, y: zone.y, radius: zone.radius }));
  const cx = world.width / 2;
  const cy = world.height / 2;
  let nextId = 1;

  const tryGroup = (seedCircle) => {
    // One relay buffer per group, shared by every image. Sampling it per circle
    // meant a rock and its mirror were judged against different constraints.
    const relayBuffer = rngRange(rng, clearances.asteroidToRelayMin, clearances.asteroidToRelayMax);
    const images = symmetricImages(transforms, seedCircle);
    if (!asteroidGroupIsPlaceable(images, world, reserved, asteroids, relays, relayBuffer, clearances)) return false;
    for (const image of images) {
      asteroids.push(makeAsteroid(rng, `R${nextId}`, image));
      nextId += 1;
    }
    return true;
  };

  const fromPolar = (nr, theta, radius) => ({ x: cx + Math.cos(theta) * nr * cx, y: cy + Math.sin(theta) * nr * cy, radius });

  for (let group = 0; group < fieldGroups; group += 1) {
    for (let attempt = 0; attempt < 220; attempt += 1) {
      const radius = rngRange(rng, ASTEROID_RADIUS_RANGE.min, ASTEROID_RADIUS_RANGE.max);
      const anchor = anchors.length && rng() < 0.65 ? anchors[Math.floor(rng() * anchors.length)] : null;
      // Rectangular sampling for the open field so the map corners stay usable;
      // the band floor below is what keeps a high symmetry order from spending
      // every attempt on a ring too tight to hold its own images.
      const seedCircle = anchor
        ? { x: cx + (anchor.nx + rngRange(rng, -0.16, 0.16)) * cx, y: cy + (anchor.ny + rngRange(rng, -0.16, 0.16)) * cy, radius }
        : { x: rngRange(rng, world.width * 0.05, world.width * 0.95), y: rngRange(rng, world.height * 0.05, world.height * 0.95), radius };
      if (normalizedRadius(seedCircle, world) < bands.min) continue;
      if (tryGroup(seedCircle)) break;
    }
  }

  // Contested middle: the innermost ring symmetry allows. The old absolute +-800
  // box covered 38% of a Duel map but only 20% of a Grand battle map.
  for (let group = 0; group < centralGroups; group += 1) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const seedCircle = fromPolar(
        sampleAnnulus(rng, bands.min, bands.centralMax),
        rngRange(rng, 0, Math.PI * 2),
        rngRange(rng, 70, 120)
      );
      if (tryGroup(seedCircle)) break;
    }
  }

  return asteroids;
}

function asteroidGroupIsPlaceable(images, world, reserved, asteroids, relays, relayBuffer, clearances) {
  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (!insideWorld(image, world, clearances.edgeInset)) return false;
    if (!circlesClear(image, reserved, clearances.asteroidToSafeZone)) return false;
    if (!circlesClear(image, asteroids, clearances.asteroidToAsteroid)) return false;
    if (!circlesClear(image, relays, relayBuffer)) return false;
    for (let j = i + 1; j < images.length; j += 1) {
      if (!circlesClear(image, [images[j]], clearances.asteroidToAsteroid)) return false;
    }
  }
  return true;
}

const REACHABILITY_NEIGHBOURS = Object.freeze([[1, 0], [-1, 0], [0, 1], [0, -1]]);

// Coarse grid flood fill: nothing previously stopped a belt from walling a relay
// off entirely, which surfaces as "my fleet will not path to B". Orthogonal-only
// steps keep it conservative -- a path is never assumed through a blocked corner.
function relaysAreReachable(world, asteroids, relays, safeZones) {
  if (!relays.length || !safeZones.length) return true;
  const cell = 100;
  const inflate = 45;
  const cols = Math.max(1, Math.ceil(world.width / cell));
  const rows = Math.max(1, Math.ceil(world.height / cell));
  const blocked = new Uint8Array(cols * rows);

  for (const asteroid of asteroids) {
    const reach = asteroid.radius + inflate;
    const minX = Math.max(0, Math.floor((asteroid.x - reach) / cell));
    const maxX = Math.min(cols - 1, Math.floor((asteroid.x + reach) / cell));
    const minY = Math.max(0, Math.floor((asteroid.y - reach) / cell));
    const maxY = Math.min(rows - 1, Math.floor((asteroid.y + reach) / cell));
    for (let gy = minY; gy <= maxY; gy += 1) {
      for (let gx = minX; gx <= maxX; gx += 1) {
        const dx = (gx + 0.5) * cell - asteroid.x;
        const dy = (gy + 0.5) * cell - asteroid.y;
        if (Math.hypot(dx, dy) <= reach) blocked[gy * cols + gx] = 1;
      }
    }
  }

  const startIndex = reachabilityCell(safeZones[0], cell, cols, rows);
  if (blocked[startIndex]) return true;
  const seen = new Uint8Array(cols * rows);
  const queue = [startIndex];
  seen[startIndex] = 1;
  for (let head = 0; head < queue.length; head += 1) {
    const index = queue[head];
    const gx = index % cols;
    const gy = (index - gx) / cols;
    for (const [dx, dy] of REACHABILITY_NEIGHBOURS) {
      const nx = gx + dx;
      const ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const next = ny * cols + nx;
      if (seen[next] || blocked[next]) continue;
      seen[next] = 1;
      queue.push(next);
    }
  }

  for (const target of relays) if (!seen[reachabilityCell(target, cell, cols, rows)]) return false;
  for (const target of safeZones) if (!seen[reachabilityCell(target, cell, cols, rows)]) return false;
  return true;
}

function reachabilityCell(point, cell, cols, rows) {
  const gx = Math.max(0, Math.min(cols - 1, Math.floor(point.x / cell)));
  const gy = Math.max(0, Math.min(rows - 1, Math.floor(point.y / cell)));
  return gy * cols + gx;
}

function roundMapCircle(circle) {
  return {
    x: Math.round(circle.x),
    y: Math.round(circle.y),
    radius: Math.round(circle.radius)
  };
}

function makeAsteroid(rng, id, asteroid) {
  const points = 12;
  const shape = [];
  const craters = [];

  for (let i = 0; i < points; i += 1) {
    shape.push(round(rngRange(rng, 0.82, 1.16)));
  }
  for (let i = 0; i < 4; i += 1) {
    craters.push({
      angle: round(rngRange(rng, 0, Math.PI * 2)),
      distance: round(rngRange(rng, 0.12, 0.58)),
      radius: round(rngRange(rng, 0.08, 0.18))
    });
  }

  return {
    id,
    x: Math.round(asteroid.x),
    y: Math.round(asteroid.y),
    radius: Math.round(asteroid.radius),
    rotation: round(rngRange(rng, 0, Math.PI * 2)),
    spin: round(rngRange(rng, -0.018, 0.018)),
    shade: rng() > 0.52 ? "cold" : "warm",
    shape,
    craters
  };
}

function generateClouds(rng, world, areaScale = 1) {
  const clouds = [];
  // Scaled by area: a flat 5-8 left the largest arenas looking empty.
  const count = Math.max(4, Math.min(24, Math.round((5 + Math.floor(rng() * 4)) * areaScale)));
  for (let i = 0; i < count; i += 1) {
    clouds.push({
      id: `N${i + 1}`,
      x: Math.round(rngRange(rng, 260, world.width - 260)),
      y: Math.round(rngRange(rng, 190, world.height - 190)),
      rx: Math.round(rngRange(rng, 250, 560)),
      ry: Math.round(rngRange(rng, 130, 310)),
      rotation: round(rngRange(rng, -0.7, 0.7)),
      color: MAP_CLOUD_COLORS[Math.floor(rng() * MAP_CLOUD_COLORS.length)],
      alpha: round(rngRange(rng, 0.08, 0.18))
    });
  }
  return clouds;
}

function insideWorld(circle, world, inset) {
  if (circle.x - circle.radius < inset || circle.x + circle.radius > world.width - inset) return false;
  if (circle.y - circle.radius < inset || circle.y + circle.radius > world.height - inset) return false;
  return true;
}

function circlesClear(circle, others, buffer) {
  for (const other of others) {
    const minimum = circle.radius + other.radius + buffer;
    if (Math.hypot(circle.x - other.x, circle.y - other.y) < minimum) return false;
  }
  return true;
}

function prepareArenaForCurrentPlayers(room) {
  bumpStateEpoch(room, "arena-preparation");
  const world = chooseRoomWorld(room);
  room.world = world;
  room.mapSizeLabel = world.label;
  // forcedMapSeed lets a rematch or a bug report replay an exact layout.
  room.mapSeed = Number.isInteger(room.forcedMapSeed) ? (room.forcedMapSeed >>> 0) : createMapSeed(room.code);
  room.map = generateMapWithAuthoritativeSafeZones(room);
  room.points = room.map.relays.map((relay) => ({ ...relay, ownerId: null, ownerTeam: null, progress: 0 }));
  require("./projectiles").resetProjectileRuntime(room);
  require("./drones").resetDroneRuntime(room);
  require("./decoys").resetDecoyRuntime(room);
  require("./spatialIndex").clearRoomSpatialIndex(room);
  room.effects = [];
  room.spawnReservations = [];
  room.spawnCollisionDiagnostics = {};
  clearRoomRuntimeScratch(room);
  room.nextEntityId = 1;
}

function chooseWorldSize(playerCount) {
  for (let i = 0; i < WORLD_SIZES.length; i += 1) {
    const candidate = WORLD_SIZES[i];
    if (playerCount <= candidate.maxPlayers) {
      return { width: candidate.width, height: candidate.height, label: candidate.label };
    }
  }
  const fallback = WORLD_SIZES[WORLD_SIZES.length - 1];
  return { width: fallback.width, height: fallback.height, label: fallback.label };
}

function chooseRoomWorld(room) {
  const requested = room.rules?.mapSize;
  if (requested && requested !== "auto") {
    const fixed = WORLD_SIZES.find((candidate) => candidate.label === requested);
    if (fixed) return { width: fixed.width, height: fixed.height, label: fixed.label };
  }
  return chooseWorldSize(Math.max(1, room.players.size));
}

function makeRoomCode() {
  let code = "";
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  do {
    code = "";
    for (let i = 0; i < 5; i += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
  } while (rooms.has(code) || isClosedRoomCode(code));
  return code;
}

function rememberClosedRoom(code) {
  const clean = sanitizeRoomCode(code);
  if (!clean) return;
  closedRoomCodes.set(clean, Date.now() + CLOSED_ROOM_CODE_TTL_MS);
}

function deleteRoomIfCurrent(room, options = {}) {
  if (!room?.code || rooms.get(room.code) !== room) return false;
  if (options.rememberCode) rememberClosedRoom(room.code);
  rooms.delete(room.code);
  return true;
}

function isClosedRoomCode(code) {
  const clean = sanitizeRoomCode(code);
  const expiresAt = closedRoomCodes.get(clean);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    closedRoomCodes.delete(clean);
    return false;
  }
  return true;
}

function pruneClosedRoomCodes(now) {
  for (const [code, expiresAt] of closedRoomCodes) {
    if (expiresAt <= now) closedRoomCodes.delete(code);
  }
}

function resetMatch(room, now) {
  bumpStateEpoch(room, "new-match");
  const { resetRoundPlayerStats, resetPlayerForMatch } = require("./players");
  const { broadcastRoom } = require("./messages");

  room.winner = null;
  room.rewardsFinalizedForWinner = null;
  room.winnerAt = 0;
  require("./drones").resetDroneRuntime(room);
  require("./decoys").resetDecoyRuntime(room);
  require("./projectiles").resetProjectileRuntime(room);
  require("./spatialIndex").clearRoomSpatialIndex(room);
  room.spawnReservations = [];
  applyAuthoritativeSafeZones(room);
  for (const point of room.points) {
    point.ownerId = null;
    point.ownerTeam = null;
    point.progress = 0;
  }
  for (const player of room.players.values()) {
    resetRoundPlayerStats(player);
    resetPlayerForMatch(room, player, now);
  }
  clearRoomRuntimeScratch(room);
  clearVisibilityForRoom(room);
  broadcastRoom(room, { type: "notice", message: "New match started" });
}

module.exports = {
  rooms,
  closedRoomCodes,
  createRoom,
  bumpStateEpoch,
  setRoomRules,
  sanitizeRoomRules,
  sanitizeInfrastructureMode,
  usesStationInfrastructure,
  sanitizeMapSize,
  sanitizeGameMode,
  sanitizeVisibilityMode,
  usesSensorVisibility,
  applyGameModeTeams,
  createMapSeed,
  generateMap,
  validateMapOrFallback,
  generateRelays,
  generateAsteroidField,
  relaysAreReachable,
  symmetryTransforms,
  makeAsteroid,
  generateClouds,
  generateSafeZones,
  applyAuthoritativeSafeZones,
  generateMapWithAuthoritativeSafeZones,
  insideWorld,
  circlesClear,
  prepareArenaForCurrentPlayers,
  chooseWorldSize,
  chooseRoomWorld,
  makeRoomCode,
  rememberClosedRoom,
  deleteRoomIfCurrent,
  isClosedRoomCode,
  pruneClosedRoomCodes,
  resetMatch,
  clearRoomRuntimeScratch
};
