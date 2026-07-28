// Authoritative regression and integration tests for the optional station
// infrastructure mode. Classic behaviour must remain untouched.

const { createRoom, sanitizeRoomRules, usesStationInfrastructure } = require("./src/server/rooms");
const {
  homeStationTemplate,
  relayStationTemplate,
  createStationsForRoom,
  destroyStationsForRoom,
  updateStations,
  isStation,
  isOperationalStation,
  isHostileEntity,
  enqueueStationProduction,
  enqueueBotProduction,
  queuedShipCount
} = require("./src/server/stations");
const { buildSharedSnapshot } = require("./src/server/snapshots");
const { computeStats } = require("./src/server/shipStats");
const { DEFAULT_ROOM_RULES } = require("./src/server/config");

function assert(condition, message) {
  if (!condition) {
    console.error("FAILED:", message);
    process.exitCode = 1;
    throw new Error(message);
  }
}

function section(label) {
  console.log(`  ${label}`);
}

function run() {
  console.log("verify-station-infrastructure");

  section("Default lobby rule is classic and immutable");
  assert(DEFAULT_ROOM_RULES.infrastructureMode === "classic", "DEFAULT_ROOM_RULES.infrastructureMode should be 'classic'");
  assert(Object.isFrozen(DEFAULT_ROOM_RULES), "DEFAULT_ROOM_RULES should be frozen");

  section("Sanitization preserves valid values and falls back to classic");
  assert(sanitizeRoomRules({}).infrastructureMode === "classic", "missing mode defaults to classic");
  assert(sanitizeRoomRules({ infrastructureMode: "classic" }).infrastructureMode === "classic", "classic passes through");
  assert(sanitizeRoomRules({ infrastructureMode: "stations" }).infrastructureMode === "stations", "stations passes through");
  assert(sanitizeRoomRules({ infrastructureMode: "sensors" }).infrastructureMode === "classic", "invalid mode falls back to classic");

  section("usesStationInfrastructure helper is phase/rule agnostic");
  assert(usesStationInfrastructure({ rules: { infrastructureMode: "classic" } }) === false, "classic -> false");
  assert(usesStationInfrastructure({ rules: { infrastructureMode: "stations" } }) === true, "stations -> true");
  assert(usesStationInfrastructure({ rules: {} }) === false, "missing rule -> false");
  assert(usesStationInfrastructure(null) === false, "null room -> false");

  section("Station templates are immutable, component-based, and compute valid stats");
  assert(Array.isArray(homeStationTemplate.design) && homeStationTemplate.design.length > 0, "home station design exists");
  assert(Array.isArray(relayStationTemplate.design) && relayStationTemplate.design.length > 0, "relay station design exists");
  assert(homeStationTemplate.stats && homeStationTemplate.stats.maxHp > 0, "home station has maxHp");
  assert(relayStationTemplate.stats && relayStationTemplate.stats.maxHp > 0, "relay station has maxHp");
  assert(homeStationTemplate.stats.radius >= relayStationTemplate.stats.radius, "home station is at least as large as relay");
  assert(Object.isFrozen(homeStationTemplate), "home station template is frozen");
  assert(Object.isFrozen(relayStationTemplate), "relay station template is frozen");

  section("Station lifecycle hooks create, update, and destroy cleanly");
  const room = createRoom("TEST");
  assert(room && room.map && room.map.safeZones, "room has safe zones");
  assert(Array.isArray(room.stations) === false || room.stations.length === 0, "new room has no stations");

  room.rules = { ...room.rules, infrastructureMode: "stations" };
  createStationsForRoom(room, 0);
  assert(Array.isArray(room.stations) && room.stations.length > 0, "stations are created for station mode");
  assert(room.stations.some((s) => s.stationType === "home"), "home station created");
  assert(room.stations.some((s) => s.stationType === "relay"), "relay station created");

  for (const station of room.stations) {
    assert(isStation(station), "created entity is a station");
    if (station.stationType === "home") {
      assert(station.state === "operational", "home station starts operational");
      assert(isOperationalStation(station), "isOperationalStation returns true");
      assert(station.hangar && typeof station.hangar.interiorSpawn === "object", "home station has hangar");
    }
    if (station.stationType === "relay") {
      assert(station.state === "neutral", "relay station starts neutral");
      assert(!isOperationalStation(station), "neutral relay is not operational");
    }
  }

  const home = room.stations.find((s) => s.stationType === "home");
  const relay = room.stations.find((s) => s.stationType === "relay");
  assert(isHostileEntity(home, relay) === true || home.team === null || relay.team === null, "hostility helper tolerates unset teams");

  updateStations(room, 0.016, 0);
  assert(Array.isArray(room.stations) && room.stations.length > 0, "stations remain after tick");

  destroyStationsForRoom(room);
  assert(Array.isArray(room.stations) && room.stations.length === 0, "stations destroyed on return to lobby");

  section("Classic mode never creates stations");
  const classicRoom = createRoom("CLSC");
  assert(classicRoom.rules.infrastructureMode === "classic", "classic room uses classic mode");
  createStationsForRoom(classicRoom, 0);
  assert((classicRoom.stations || []).length === 0, "no stations created in classic");
  updateStations(classicRoom, 0.016, 0);
  assert((classicRoom.stations || []).length === 0, "updateStations no-op in classic");

  runSnapshotChecks();
  runProductionChecks();

  console.log("  all station infrastructure checks passed");
}

// Builds a minimal but authentic active station room with one ready player, so
// production and snapshot behaviour can be exercised without a live socket.
function makeStationRoom(code, { money = 5000, shipCap = 4, isBot = false } = {}) {
  const room = createRoom(code);
  room.rules = sanitizeRoomRules({ ...room.rules, infrastructureMode: "stations" }, 1);
  room.phase = "active";
  const zone = room.map.safeZones[0];
  const player = {
    id: "p1",
    name: "Pilot",
    team: zone.team || zone.ownerId || "blue",
    ready: true,
    isBot,
    ai: { nextThinkAt: 0, objectiveId: null, decisionSeq: 0 },
    money,
    spent: 0,
    deployedFleetCost: 0,
    shipCap,
    ships: [],
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }, { x: 7, y: 6, type: "engine", rotation: 0 }],
    wiring: null,
    combatStyle: "hold",
    client: {},
    purchaseRequests: new Map()
  };
  player.stats = computeStats(player.design, player.wiring);
  room.players.set(player.id, player);
  createStationsForRoom(room, 0);
  return { room, player };
}

function runSnapshotChecks() {
  section("Snapshots carry station geometry statically and production continuously");
  const { room, player } = makeStationRoom("SNAP");
  const home = room.stations.find((s) => s.stationType === "home");
  home.team = player.team;
  enqueueStationProduction(room, player, {
    template: { design: player.design, wiring: player.wiring, stats: player.stats },
    request: { requestId: "req-1", combatStyle: "hold" },
    validation: { count: 1, totalCost: player.stats.unitCost }
  }, 0);

  const full = buildSharedSnapshot(room, 1000, true);
  assert(Array.isArray(full.stations) && full.stations.length === room.stations.length, "full snapshot lists every station");
  const fullHome = full.stations.find((s) => s.stationType === "home");
  assert(Array.isArray(fullHome.design) && fullHome.design.length > 0, "full snapshot carries station design");
  assert(fullHome.hangar && typeof fullHome.hangar.interiorSpawn === "object", "full snapshot carries hangar geometry");
  assert(Array.isArray(fullHome.productionQueue) && fullHome.productionQueue.length === 1, "full snapshot carries the production queue");

  const compact = buildSharedSnapshot(room, 2000, false);
  const compactHome = compact.stations.find((s) => s.stationType === "home");
  assert(Array.isArray(compactHome.design) && compactHome.design.length > 0, "compact snapshot carries static station design for rendering");
  assert(compactHome.hangar, "compact snapshot carries static hangar geometry for component-based station UX");
  assert(Array.isArray(compactHome.productionQueue) && compactHome.productionQueue.length === 1, "compact snapshot still carries the production queue");
  const item = compactHome.productionQueue[0];
  assert(typeof item.progress === "number" && item.progress >= 0 && item.progress <= 1, "queue progress is a resolved 0..1 ratio");
  assert(item.playerId === player.id, "queue items identify their owner");

  const classic = createRoom("SNCL");
  classic.phase = "active";
  assert(buildSharedSnapshot(classic, 1000, true).stations === undefined, "classic snapshots omit the stations field entirely");
}

function runProductionChecks() {
  section("Production is gated by the fleet cap including queued hulls");
  const { room, player } = makeStationRoom("PROD", { money: 100000, shipCap: 2 });
  const home = room.stations.find((s) => s.stationType === "home");
  home.team = player.team;
  const enqueue = (requestId, count = 1) => enqueueStationProduction(room, player, {
    template: { design: player.design, wiring: player.wiring, stats: player.stats },
    request: { requestId, combatStyle: "hold" },
    validation: { count, totalCost: player.stats.unitCost * count }
  }, 0);

  assert(enqueue("a").ok === true, "first purchase queues");
  assert(enqueue("b").ok === true, "second purchase queues to the cap");
  const overflow = enqueue("c");
  assert(overflow.ok === false && overflow.code === "fleet-cap", "queued hulls count against the fleet cap");
  assert(queuedShipCount(room, player.id) === 2, "queuedShipCount reports pending hulls");

  home.state = "disabled";
  const disabled = enqueue("d");
  assert(disabled.ok === false && disabled.code === "station-disabled", "a disabled station refuses production");
  home.state = "operational";

  section("Bots build through the station queue instead of spawning instantly");
  const bot = makeStationRoom("BOTS", { money: 100000, shipCap: 3, isBot: true });
  const botHome = bot.room.stations.find((s) => s.stationType === "home");
  botHome.team = bot.player.team;
  const before = bot.player.money;
  const result = enqueueBotProduction(bot.room, bot.player, 0);
  assert(result && result.ok === true, "bot purchase is accepted");
  assert(botHome.productionQueue.length === 1, "bot purchase lands in the station queue");
  assert(bot.player.ships.length === 0, "bot purchase does not spawn a hull immediately");
  assert(bot.player.money < before, "bot purchase debits the bot");

  bot.player.money = 0;
  assert(enqueueBotProduction(bot.room, bot.player, 0) === null, "a broke bot does not queue");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
