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
  isHostileEntity
} = require("./src/server/stations");
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

  console.log("  all station infrastructure checks passed");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
