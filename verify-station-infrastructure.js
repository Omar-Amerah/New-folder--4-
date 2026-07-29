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
  queuedShipCount,
  resolveStationCollision
} = require("./src/server/stations");
const { buildSharedSnapshot } = require("./src/server/snapshots");
const { computeStats } = require("./src/server/shipStats");
const { DEFAULT_ROOM_RULES, INFRASTRUCTURE } = require("./src/server/config");
const { getShipComponentIndexes } = require("./src/server/componentIndexes");
const { moduleCentreToLocal } = require("./src/server/stationTemplates");
const { updateStationWeapons, stationModuleWorldPosition, damageStation } = require("./src/server/stationCombat");
const { PARTS } = require("./src/server/components");
const { areEnemies } = require("./src/server/combat");
const { filterSnapshotForPlayer } = require("./src/server/visibilitySnapshots");
const { resolveMapCollision } = require("./src/server/movement");

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

  section("Default lobby rule is stations and immutable");
  assert(DEFAULT_ROOM_RULES.infrastructureMode === "stations", "DEFAULT_ROOM_RULES.infrastructureMode should be 'stations'");
  assert(Object.isFrozen(DEFAULT_ROOM_RULES), "DEFAULT_ROOM_RULES should be frozen");

  section("Sanitization preserves valid values and falls back to stations");
  assert(sanitizeRoomRules({}).infrastructureMode === "stations", "missing mode defaults to stations");
  assert(sanitizeRoomRules({ infrastructureMode: "classic" }).infrastructureMode === "classic", "classic passes through");
  assert(sanitizeRoomRules({ infrastructureMode: "stations" }).infrastructureMode === "stations", "stations passes through");
  assert(sanitizeRoomRules({ infrastructureMode: "sensors" }).infrastructureMode === "stations", "invalid mode falls back to stations");

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
  classicRoom.rules.infrastructureMode = "classic";
  assert(classicRoom.rules.infrastructureMode === "classic", "classic room uses classic mode");
  createStationsForRoom(classicRoom, 0);
  assert((classicRoom.stations || []).length === 0, "no stations created in classic");
  updateStations(classicRoom, 0.016, 0);
  assert((classicRoom.stations || []).length === 0, "updateStations no-op in classic");

  section("A team shares one home station across all player safe zones");
  const shared = createRoom("SHARED");
  shared.rules = sanitizeRoomRules({ ...shared.rules, gameMode: "teams", infrastructureMode: "stations" }, 4);
  shared.map.safeZones = [
    { id: "blue-1", x: 300, y: 300, radius: 200, team: "blue" },
    { id: "blue-2", x: 300, y: 900, radius: 200, team: "blue" },
    { id: "red-1", x: shared.world.width - 300, y: 300, radius: 200, team: "red" },
    { id: "red-2", x: shared.world.width - 300, y: 900, radius: 200, team: "red" }
  ];
  shared.map.relays = [];
  createStationsForRoom(shared, 0);
  const homes = shared.stations.filter((station) => station.stationType === "home");
  assert(homes.length === 2, "four player regions create only one home station per team");
  assert(homes.filter((station) => station.team === "blue").length === 1, "blue has one shared home station");
  assert(homes.filter((station) => station.team === "red").length === 1, "red has one shared home station");

  runSnapshotChecks();
  runProductionChecks();
  runWeaponChecks();
  runCaptureChecks();
  runObjectiveHudChecks();
  runEnemyStationVisibilityChecks();
  runRepairBeamChecks();
  runHangarDoorChecks();

  console.log("  all station infrastructure checks passed");
}

// Every station battery must sit on, aim from and fire from its own module.
function runWeaponChecks() {
  section("Station batteries are mounted on their own modules and face outward");
  const { room } = makeStationRoom("GUNS");
  const home = room.stations.find((s) => s.stationType === "home");
  const weaponIndices = getShipComponentIndexes(home).weaponIndices;
  assert(weaponIndices.length > 0, "the home station carries weapons");

  const seen = new Set();
  for (const index of weaponIndices) {
    const module = home.design[index];
    const hardpoint = home.hardpoints[index];
    assert(hardpoint, `weapon ${index} has a hardpoint`);
    const expected = moduleCentreToLocal(module, home.moduleScale, PARTS[module.type].footprint);
    assert(
      Math.hypot(hardpoint.x - expected.x, hardpoint.y - expected.y) < 1e-9,
      `weapon ${index} (${module.type}) is mounted on its own module cell`
    );
    // A cosmetic layout cycled with a modulo used to stack several turrets on
    // one point; distinct modules must occupy distinct hardpoints.
    const key = `${hardpoint.x},${hardpoint.y}`;
    assert(!seen.has(key), `weapon ${index} does not share a hardpoint with another battery`);
    seen.add(key);
    // ...and the muzzle origin the combat code uses must agree with it.
    const world = stationModuleWorldPosition(home, index);
    const cos = Math.cos(home.angle);
    const sin = Math.sin(home.angle);
    assert(
      Math.hypot(world.x - (home.x + expected.x * cos - expected.y * sin), world.y - (home.y + expected.x * sin + expected.y * cos)) < 1e-9,
      `weapon ${index} fires from where it is drawn`
    );
  }

  // Rear and flank batteries must be turned to face out, or an arc-limited
  // weapon mounted on the back of the structure can never cover the back.
  const rearFacing = home.design.filter((m) => PARTS[m.type]?.weapon && m.rotation === 180);
  assert(rearFacing.length > 0, "the rear batteries face aft");
  const flankFacing = home.design.filter((m) => PARTS[m.type]?.weapon && (m.rotation === 90 || m.rotation === 270));
  assert(flankFacing.length > 0, "the flank batteries face outboard");

  section("A team home station with no owner still opens fire");
  // Safe zones carry a team and no ownerId, so a home station is built with
  // ownerId null. The shared relationship rules are keyed on player ids and
  // treat an unknown id as neither ally nor enemy, which left every home
  // station hostile to nobody: it never fired a shot all match.
  const teamRoom = makeStationRoom("TEAM").room;
  teamRoom.players.set("p2", { id: "p2", team: "red", ready: true, ships: [], client: {}, purchaseRequests: new Map() });
  const teamHome = teamRoom.stations.find((s) => s.stationType === "home");
  assert(teamHome.ownerId === null, "a map-built home station genuinely has no owner");
  assert(teamHome.team, "but it does have a team");
  const raider = {
    id: "e1", alive: true, ownerId: "p2", team: "red",
    x: teamHome.x + Math.cos(teamHome.angle) * 350, y: teamHome.y + Math.sin(teamHome.angle) * 350,
    vx: 0, vy: 0, radius: 26, hp: 5000, maxHp: 5000, shield: 0, maxShield: 0,
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }], componentHp: [500], componentMaxHp: [500]
  };
  teamRoom.ships.set(raider.id, raider);
  teamRoom.players.get("p2").ships = [raider];
  for (let tick = 0; tick < 300; tick += 1) updateStationWeapons(teamRoom, teamRoom.stations, [raider], 1 / 30, tick * 33);
  const teamShots = teamRoom.bullets || [];
  assert(teamShots.length > 0, "an unowned team home station engages enemy ships");
  // Rounds carrying ownerId null are hostile to nobody and pass through.
  assert(teamShots.every((bullet) => bullet.ownerId), "its rounds carry a resolvable owner");
  assert(
    teamShots.every((bullet) => areEnemies(teamRoom, bullet.ownerId, "p2")),
    "and are hostile to the ship they were fired at"
  );

  section("Station reload is seconds, not the balance sheet's milliseconds");
  const enemy = {
    id: "e1", entityType: "ship", alive: true, ownerId: "p2", team: "red",
    x: home.x + Math.cos(home.angle) * 300, y: home.y + Math.sin(home.angle) * 300,
    vx: 0, vy: 0, radius: 26, hp: 5000, maxHp: 5000, shield: 0, maxShield: 0,
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }], componentHp: [500], componentMaxHp: [500]
  };
  room.players.set("p2", { id: "p2", team: "red", ready: true, ships: [enemy], client: {}, purchaseRequests: new Map() });
  room.ships.set(enemy.id, enemy);
  home.team = "blue";
  home.ownerId = "p1";
  for (let tick = 0; tick < 300; tick += 1) updateStationWeapons(room, room.stations, [enemy], 1 / 30, tick * 33);
  // `weapon.reload` is 1000/fireRate; used directly as a seconds cooldown the
  // whole station managed a single volley per match.
  assert((room.bullets || []).length > 20, `stations lay down sustained fire (got ${(room.bullets || []).length} shots in 10s)`);
  assert((room.bullets || []).some((b) => b.type === "pdShot"), "station point defence engages, using the shared interceptor selector");
}

function runCaptureChecks() {
  section("Relay capture is timed, decays when abandoned, and honours the restore ratio");
  const { room } = makeStationRoom("CAPS");
  const relay = room.stations.find((s) => s.stationType === "relay");
  const cfg = INFRASTRUCTURE.relayStation;
  const duration = cfg.captureDurationSeconds;
  assert(duration > 0, "captureDurationSeconds is configured");
  assert(cfg.captureDecayPerSecond > 0, "captureDecayPerSecond is configured");

  const hull = (id, ownerId, team) => ({ id, alive: true, ownerId, team, x: relay.x, y: relay.y, vx: 0, vy: 0, radius: 26, hp: 100, maxHp: 100 });
  room.players.set("p2", { id: "p2", team: "red", ready: true, ships: [], client: {}, purchaseRequests: new Map() });
  room.ships.set("r1", hull("r1", "p2", "red"));

  let now = 0;
  let capturedAfter = null;
  for (let tick = 0; tick < duration * 60 && capturedAfter === null; tick += 1) {
    updateStations(room, 1 / 30, (now += 33));
    if (relay.team === "red") capturedAfter = tick / 30;
  }
  assert(capturedAfter !== null, "an unclaimed relay can be taken");
  // It used to flip owner on the first tick a hull entered the radius, which
  // made the capture ring and the objective HUD percentage meaningless.
  assert(Math.abs(capturedAfter - duration) < 0.5, `taking an unclaimed relay takes captureDurationSeconds (took ${capturedAfter}s)`);

  damageStation(room, relay, relay.maxHp * 3, "p1", now, 0, 0);
  assert(relay.state === "disabled", "enough damage disables a relay");
  room.ships.delete("r1");
  room.ships.set("b1", hull("b1", "p1", "blue"));
  for (let tick = 0; tick < duration * 12; tick += 1) updateStations(room, 1 / 30, (now += 33));
  const banked = relay.captureProgress;
  assert(banked > 0 && banked < 1, "a partial capture accumulates");
  room.ships.delete("b1");
  for (let tick = 0; tick < (1 / cfg.captureDecayPerSecond) * 60; tick += 1) updateStations(room, 1 / 30, (now += 33));
  assert(relay.captureProgress === 0, `abandoned capture progress decays back to zero (left ${relay.captureProgress})`);

  room.ships.set("b1", hull("b1", "p1", "blue"));
  let flipped = null;
  for (let tick = 0; tick < duration * 60 && flipped === null; tick += 1) {
    updateStations(room, 1 / 30, (now += 33));
    if (relay.team === "blue") flipped = tick / 30;
  }
  assert(flipped !== null, "a disabled relay can be taken off its owner");
  const restored = relay.hp / relay.maxHp;
  assert(
    Math.abs(restored - cfg.captureRestoreHpRatio) < 0.02,
    `a captured wreck comes back at captureRestoreHpRatio, not full health (got ${restored.toFixed(2)})`
  );
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
  const compactHome = compact.stations.find((s) => s.id === fullHome.id);
  assert(compactHome.design === undefined, "compact snapshot omits cached station design");
  assert(compactHome.hangar === undefined, "compact snapshot omits cached hangar geometry");
  assert(compactHome.hardpoints === undefined, "compact snapshot omits cached hardpoints");
  assert(compactHome.moduleScale === undefined, "compact snapshot omits cached module scale");
  assert(compactHome.componentHp === undefined, "shared compact snapshot omits revision-gated component health");
  assert(Array.isArray(compactHome.weaponAnglePairs), "compact snapshot carries sparse weapon bearings");
  assert(
    compactHome.weaponAnglePairs.length < fullHome.weaponAngles.length,
    "sparse weapon bearings are smaller than the design-sized baseline"
  );
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

// The Match panel, the relay chips and the victory meter all read
// snapshot.points, in both infrastructure modes.
function runObjectiveHudChecks() {
  section("Relays drive the objective HUD through snapshot.points");
  const { room } = makeStationRoom("HUD1");
  const relay = room.stations.find((s) => s.stationType === "relay");
  room.players.set("p2", { id: "p2", team: "red", ready: true, ships: [], client: {}, purchaseRequests: new Map() });
  room.ships.set("r1", { id: "r1", alive: true, ownerId: "p2", team: "red", x: relay.x, y: relay.y, vx: 0, vy: 0, radius: 26, hp: 100, maxHp: 100, shield: 0, maxShield: 0 });

  const pointsOf = (now) => buildSharedSnapshot(room, now, true).points;
  const idle = pointsOf(0);
  assert(idle.length === room.stations.filter((s) => s.stationType === "relay").length, "every relay appears as an objective point");
  // The letters the HUD and victory notices name relays by, not internal ids.
  assert(idle.every((point) => /^[A-Z]$/.test(String(point.id))), `objective points keep the map's relay letters (${idle.map((p) => p.id).join(",")})`);
  assert(idle.every((point) => point.progress === 0 && !point.ownerTeam), "an untouched relay reads neutral at 0%");

  let now = 0;
  const duration = INFRASTRUCTURE.relayStation.captureDurationSeconds;
  for (let tick = 0; tick < duration * 12; tick += 1) updateStations(room, 1 / 30, (now += 33));
  const mid = pointsOf(now).find((point) => point.id === relay.relayId);
  // The relay chips render this number; it used to be stuck at 0 all match
  // because room.points is never updated in station mode.
  assert(mid.progress > 0 && mid.progress < 1, `a capture in progress reports a partial percentage (got ${mid.progress})`);

  for (let tick = 0; tick < duration * 60; tick += 1) updateStations(room, 1 / 30, (now += 33));
  const held = pointsOf(now).find((point) => point.id === relay.relayId);
  assert(held.ownerTeam === "red", "a captured relay reports its owner");
  // captureProgress resets to 0 on capture; consumers treat >= 0.98 as held, so
  // a held relay has to report 1 or the HUD counts it neutral forever.
  assert(held.progress === 1, `a held relay reports full control (got ${held.progress})`);
  const control = buildSharedSnapshot(room, now, true).objectiveControl;
  assert(control.teams.red === 1, `objectiveControl credits the holding team (got ${JSON.stringify(control)})`);
  assert(control.neutral === control.total - 1, "the remaining relays stay neutral");
}

// Under sensor visibility an enemy station outside sensor range is reduced to a
// stub. A station is a fixed installation sitting in the open, so its structure
// and armament stay public knowledge; only its condition is withheld.
function runEnemyStationVisibilityChecks() {
  section("An unscanned enemy station still shows its structure and weapons");
  const { room } = makeStationRoom("FOG1");
  room.rules = sanitizeRoomRules({ ...room.rules, infrastructureMode: "stations", visibilityMode: "sensors" }, 2);
  const viewer = { id: "p2", name: "Scout", team: "red", ready: true, ships: [], client: {}, purchaseRequests: new Map() };
  room.players.set(viewer.id, viewer);
  const home = room.stations.find((s) => s.stationType === "home");
  home.team = "blue";

  const shared = buildSharedSnapshot(room, 1000, true);
  const filtered = filterSnapshotForPlayer(room, viewer, shared, 1000);
  const seen = filtered.stations.find((s) => s.id === home.id);
  assert(seen, "an enemy station is still on the map");
  assert(seen.state === "unknown", "an unscanned station reports an unknown condition");
  // The renderer needs all four to draw the structure and mount the turrets;
  // without them an enemy station appeared as an unarmed blob.
  assert(Array.isArray(seen.design) && seen.design.length > 0, "its module layout is visible");
  assert(Array.isArray(seen.hardpoints) && seen.hardpoints.some(Boolean), "its gun hardpoints are visible");
  assert(seen.moduleScale > 0, "its scale is visible, so it is drawn at the right size");
  assert(Array.isArray(seen.weaponAngles) && seen.weaponAngles.length > 0, "its turrets track visibly");
  // Condition stays private.
  assert(seen.hp === undefined && seen.maxHp === undefined, "its hull condition is withheld");
  assert(seen.componentHp === undefined, "its per-component damage is withheld");
  assert(seen.productionQueue === undefined, "its production queue is withheld");

  // Capture status is already public via the objective HUD, so an unscanned
  // neutral relay must still read as uncaptured rather than being masked.
  const neutralRelay = room.stations.find((s) => s.stationType === "relay");
  const seenRelay = filtered.stations.find((s) => s.id === neutralRelay.id);
  assert(neutralRelay.state === "neutral", "the relay under test is uncaptured");
  assert(seenRelay.state === "neutral", "an unscanned uncaptured relay still reads neutral, not unknown");

  neutralRelay.state = "operational";
  neutralRelay.team = "blue";
  neutralRelay.ownerId = "p1";
  const capturedSnapshot = buildSharedSnapshot(room, 1100, true);
  const capturedFiltered = filterSnapshotForPlayer(room, viewer, capturedSnapshot, 1100);
  const capturedRelay = capturedFiltered.stations.find((station) => station.id === neutralRelay.id);
  assert(capturedRelay.state === "controlled", "a hidden captured relay reports public control, not unscanned");
  assert(capturedRelay.conditionKnown === false, "the captured relay's operational condition remains concealed");
  assert(capturedRelay.hp === undefined && capturedRelay.maxHp === undefined, "captured relay health remains concealed");
}

function runRepairBeamChecks() {
  section("The home station projects long-range repair beams");
  const { room, player } = makeStationRoom("BEAM");
  const home = room.stations.find((s) => s.stationType === "home");
  home.team = player.team;
  home.ownerId = player.id;
  const emitters = getShipComponentIndexes(home).weaponIndices
    .filter((index) => home.design[index]?.type === "repairBeam");
  assert(emitters.length > 0, "the home station carries repair beam emitters");
  assert(emitters.every((index) => home.hardpoints[index]), "each emitter has a hardpoint, so it gets a turret sprite");

  const cfg = INFRASTRUCTURE.homeStation;
  assert(cfg.repairBeamRange > cfg.repairRadius, "the beams reach further than the close-in repair aura");

  // A wounded ally beyond the aura but inside beam range.
  const distance = (cfg.repairRadius + cfg.repairBeamRange) / 2;
  const ally = {
    id: "a1", alive: true, ownerId: player.id, team: player.team,
    x: home.x + distance, y: home.y, vx: 0, vy: 0, radius: 26,
    hp: 200, maxHp: 1000,
    design: [{ x: 7, y: 7, type: "core", rotation: 0 }, { x: 7, y: 6, type: "armor", rotation: 0 }],
    componentHp: [100, 100], componentMaxHp: [500, 500], stats: {}
  };
  room.ships.set(ally.id, ally);
  player.ships = [ally];
  room.effects.length = 0;
  const before = ally.hp;
  let now = 0;
  for (let tick = 0; tick < 90; tick += 1) updateStations(room, 1 / 30, (now += 33));
  assert(ally.hp > before, `a ship outside the aura is repaired by the beams (${before} -> ${ally.hp})`);
  assert(room.effects.some((effect) => effect.type === "repairbeam"), "the beams are visible, not a silent aura");
  assert(emitters.some((index) => Math.abs(home.weaponAngles[index]) > 0.01), "the emitters traverse onto their target");
}

// The hangar is a one-way door: a hull may leave, nothing may come back in.
function runHangarDoorChecks() {
  section("The hangar mouth is one-way, so nobody can bottle up the corridor");
  const { room } = makeStationRoom("DOOR");
  const home = room.stations.find((s) => s.stationType === "home");
  const cos = Math.cos(home.angle);
  const sin = Math.sin(home.angle);
  // Just inside the mouth, on the corridor centreline.
  const doorway = {
    x: home.hangar.mouth.x - cos * 8,
    y: home.hangar.mouth.y - sin * 8
  };
  // An enemy nosing into the mouth is pushed back out. Without this it could
  // sit in the corridor indefinitely: a launch only begins once the corridor is
  // clear, so one cheap hull would stop the station building ships at all.
  const intruder = { id: "x1", x: doorway.x, y: doorway.y, vx: -100 * cos, vy: -100 * sin };
  assert(resolveStationCollision(room, intruder, 26), "a ship entering the hangar mouth hits the door");

  // The hull this station is currently launching passes straight through.
  const launcher = {
    id: "x2", x: doorway.x, y: doorway.y, vx: 100 * cos, vy: 100 * sin,
    launchPhase: { stationId: home.id }
  };
  assert(!resolveStationCollision(room, launcher, 26), "the launching hull is not blocked by its own door");

  // A hull launching from a DIFFERENT station gets no free pass.
  const otherLauncher = {
    id: "x3", x: doorway.x, y: doorway.y, vx: 100 * cos, vy: 100 * sin,
    launchPhase: { stationId: "some-other-station" }
  };
  assert(resolveStationCollision(room, otherLauncher, 26), "another station's launch does not open this door");

  // The interior spawn point stays free, or nothing could ever be built.
  const spawn = home.hangar.interiorSpawn;
  const parked = { id: "x4", x: spawn.x, y: spawn.y, vx: 0, vy: 0 };
  assert(!resolveStationCollision(room, parked, 26), "the build position inside the corridor is still clear");

  section("Station solids eject embedded hulls during the shared map-collision pass");
  const solidRoom = {
    world: { width: 1200, height: 1000 },
    map: { asteroids: [] },
    stations: [{
      id: "solid",
      collisionPieces: [{ x: 600, y: 500, halfWidth: 100, halfHeight: 80, angle: 0 }]
    }]
  };
  const embedded = { id: "embedded", x: 600, y: 500, vx: 0, vy: 0 };
  assert(resolveStationCollision(solidRoom, embedded, 26), "a hull deep inside a solid station piece collides");
  assert(
    Math.abs(embedded.y - 500) >= 106,
    "an embedded hull clears the nearest station face by its full radius"
  );
  const sharedPassShip = {
    id: "shared-pass", x: 600, y: 500, vx: 0, vy: 0, radius: 46, physicalRadius: 26
  };
  assert(resolveMapCollision(solidRoom, sharedPassShip), "the shared map-collision pass includes station solids");
  assert(
    Math.abs(sharedPassShip.y - 500) >= 106,
    "movement substeps cannot leave a hull embedded inside a station"
  );

  section("Loitering outside the mouth no longer stalls the hangar");
  // The clearance check used to sweep all the way out to the release plane, so
  // anything drifting past the front of the station — including an enemy
  // parking there on purpose — froze production for as long as it stayed.
  const { room: prodRoom, player } = makeStationRoom("BLOK", { money: 100000, shipCap: 8, isBot: true });
  const prodHome = prodRoom.stations.find((s) => s.stationType === "home");
  prodHome.team = player.team;
  const outward = { x: Math.cos(prodHome.angle), y: Math.sin(prodHome.angle) };
  // 40 units beyond the mouth: outside the structure, dead ahead of the door.
  prodRoom.ships.set("block", {
    id: "block", alive: true, ownerId: "p2", team: "red",
    x: prodHome.hangar.mouth.x + outward.x * 40,
    y: prodHome.hangar.mouth.y + outward.y * 40,
    vx: 0, vy: 0, radius: 26, physicalRadius: 26, hp: 900, maxHp: 900
  });
  assert(enqueueBotProduction(prodRoom, player, 0), "the build is queued");
  let launched = false;
  let clock = 0;
  for (let tick = 0; tick < 600 && !launched; tick += 1) {
    updateStations(prodRoom, 1 / 30, (clock += 33));
    for (const ship of prodRoom.ships.values()) {
      if (ship.id !== "block" && ship.launchPhase) { ship.x += ship.vx / 30; ship.y += ship.vy / 30; }
    }
    launched = [...prodRoom.ships.keys()].some((id) => id !== "block");
  }
  assert(launched, "a hull still launches with a hostile parked in front of the mouth");
  assert(
    !(prodRoom.stationCounters?.stationLaunchBlockedCount > 0),
    `no launch was blocked (got ${prodRoom.stationCounters?.stationLaunchBlockedCount || 0})`
  );

  section("Build time scales with ship size");
  const cfg = INFRASTRUCTURE.homeStation;
  assert(cfg.productionSecondsPerModule > 0, "productionSecondsPerModule is configured");
  const buildSeconds = (moduleCount) => {
    const design = Array.from({ length: moduleCount }, (_, i) => ({ x: i % 15, y: Math.floor(i / 15), type: "armor", rotation: 0 }));
    const stats = computeStats(design, null);
    const queued = enqueueStationProduction(
      makeStationRoom(`SZ${moduleCount}`).room,
      { ...player, ships: [], money: 100000, shipCap: 8 },
      { template: { design, wiring: null, stats }, request: { requestId: `s${moduleCount}` }, validation: { count: 1, totalCost: stats.unitCost } },
      0
    );
    const unaccelerated = cfg.productionBaseSeconds
      + moduleCount * cfg.productionSecondsPerModule
      + stats.unitCost * cfg.productionCostSecondsMultiplier;
    const expectedDuration = Math.round(Math.max(0.2, unaccelerated / 2) * 100) / 100;
    assert(
      queued.buildDurationSeconds === expectedDuration,
      `the ${moduleCount}-module hull builds at exactly 2x speed`
    );
    return queued.buildDurationSeconds;
  };
  const small = buildSeconds(4);
  const large = buildSeconds(60);
  // It used to be driven by cost alone, which put every hull in the game within
  // 0.7s of every other one.
  assert(large > small * 2, `a large hull takes materially longer to build (${small}s vs ${large}s)`);

  section("A relay is built lighter than its raw component sheet");
  const relay = room.stations.find((s) => s.stationType === "relay");
  const scale = INFRASTRUCTURE.relayStation.hullScale;
  assert(scale > 0 && scale < 1, "relayStation.hullScale is configured below 1");
  const rawHp = relayStationTemplate.design.reduce((sum, module) => sum + (PARTS[module.type]?.hp || 0), 0);
  assert(relay.maxHp < rawHp, "the relay's hull is scaled down from its component total");
  // Per-component HP is scaled too, not just the total, so component damage and
  // destruction stay consistent with the hull bar.
  assert(
    Math.abs(relay.componentMaxHp.reduce((sum, hp) => sum + hp, 0) - relay.maxHp) < 0.001,
    "the per-component HP still sums to the hull total"
  );
  assert(relay.hp === relay.maxHp, "a fresh relay starts at full scaled health");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
