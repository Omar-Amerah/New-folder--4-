"use strict";

const assert = require("node:assert/strict");
const flags = require("./src/server/performanceFlags");
const { createRoom } = require("./src/server/rooms");
const {
  computeTeamVisibility,
  ensureTeamVisibility,
  invalidateVisibility,
  canTeamSeeEntity,
  canTeamTargetEntity,
  isPointVisibleToTeam,
  DETECTION_LINGER_MS,
  REMEMBERED_CONTACT_MS
} = require("./src/server/visibility");
const { filterSnapshotForPlayer } = require("./src/server/visibilitySnapshots");
const { clearVisibilityForRoom } = require("./src/server/visibility");
const { RoomSpatialIndex } = require("./src/server/spatialIndex");
const {
  initializeClient,
  recordProjectileSpawn,
  buildClientBatch,
  markProjectilesWritten
} = require("./src/server/projectileReplication");

function addPlayer(room, id, team) {
  const player = { id, team, name: id, connected: true };
  room.players.set(id, player);
  return player;
}

function addShip(room, id, ownerId, x, y, options = {}) {
  const player = room.players.get(ownerId);
  const design = options.design || [];
  const ship = {
    id,
    type: "ship",
    entityType: "ship",
    ownerId,
    team: options.team || player?.team || null,
    alive: true,
    removed: false,
    hp: 100,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: options.angle || 0,
    radius: options.radius || 24,
    physicalRadius: options.radius || 24,
    design,
    componentHp: design.map(() => 100),
    componentMaxHp: design.map(() => 100),
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1, state: "powered" })) },
    stats: { massClass: options.massClass || "medium" }
  };
  room.ships.set(id, ship);
  return ship;
}

function addDrone(room, id, ownerId, x, y) {
  const player = room.players.get(ownerId);
  const drone = {
    id,
    type: "drone",
    entityType: "drone",
    ownerId,
    teamId: player?.team || null,
    x,
    y,
    vx: 0,
    vy: 0,
    radius: 10,
    hull: 20,
    maxHull: 20,
    destroyed: false,
    removed: false
  };
  room.drones.set(id, drone);
  return drone;
}

function addStation(room, id, stationType, team, x, y) {
  const station = {
    id,
    entityType: "station",
    stationType,
    team: team || null,
    ownerId: null,
    x,
    y,
    angle: 0,
    radius: 40,
    alive: true,
    state: team ? "operational" : "neutral",
    hp: 100,
    maxHp: 100,
    revision: 1,
    componentDamageRevision: 1,
    componentAliveRevision: 1,
    healthRevision: 1
  };
  room.stations.push(station);
  room.stationsById.set(id, station);
  return station;
}

function makeRoom(mode = "legacy", visibilityMode = "sensors", infrastructureMode = "stations") {
  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(mode === "optimized");
  const room = createRoom(`phase-6c-${mode}-${visibilityMode}-${infrastructureMode}`, { seed: 6126 });
  room.rules.visibilityMode = visibilityMode;
  room.rules.infrastructureMode = infrastructureMode;
  room.players = new Map();
  room.ships = new Map();
  room.drones = new Map();
  room.stations = [];
  room.stationsById = new Map();
  room.points = [];
  room.spatialIndex = null;
  room._phase6cMode = mode;
  addPlayer(room, "blue", "blue");
  addPlayer(room, "blue-ally", "blue");
  addPlayer(room, "red", "red");
  addShip(room, "blue-source", "blue", 0, 0);
  addShip(room, "red-target", "red", 400, 0);
  return room;
}

function withRoomMode(room, callback) {
  const previous = flags.OPTIMIZED_VISIBILITY_RUNTIME();
  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(room?._phase6cMode === "optimized");
  try {
    return callback();
  } finally {
    flags.__setOPTIMIZED_VISIBILITY_RUNTIME(previous);
  }
}

function invalidateFor(room, reason) {
  return withRoomMode(room, () => invalidateVisibility(room, reason));
}

function computeFor(room, teamId, now) {
  return withRoomMode(room, () => computeTeamVisibility(room, teamId, now));
}

function ensureFor(room, teamId, now) {
  return withRoomMode(room, () => ensureTeamVisibility(room, teamId, now));
}

function filterFor(room, player, snapshot, now) {
  return withRoomMode(room, () => filterSnapshotForPlayer(room, player, snapshot, now));
}

function roundNumber(value) {
  return Math.round((Number(value) || 0) * 1e6) / 1e6;
}

function stateSignature(state) {
  return {
    visible: [...state.visibleEntityIds].sort(),
    remembered: [...state.remembered.values()]
      .map((contact) => ({
        id: contact.id,
        entityType: contact.entityType,
        sourceEntityType: contact.sourceEntityType,
        contactClass: contact.contactClass,
        lastKnownX: roundNumber(contact.lastKnownX),
        lastKnownY: roundNumber(contact.lastKnownY),
        lastKnownAngle: roundNumber(contact.lastKnownAngle),
        lastSeenAt: roundNumber(contact.lastSeenAt)
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    coverage: (state.coverage || []).map((entry) => ({
      x: roundNumber(entry.x),
      y: roundNumber(entry.y),
      range: roundNumber(entry.range),
      rangeSquared: roundNumber(entry.rangeSquared ?? ((Number(entry.range) || 0) * (Number(entry.range) || 0))),
      shape: entry.shape,
      angle: roundNumber(entry.angle),
      halfAngle: roundNumber(entry.halfAngle)
    })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  };
}

function observe(room, teamId = "blue", now = 1000) {
  return withRoomMode(room, () => {
    invalidateVisibility(room, { reason: "phase-6c-test", geometryChanged: true });
    return computeTeamVisibility(room, teamId, now);
  });
}

function compareScenario(label, setup, checks = null) {
  const rooms = ["legacy", "optimized"].map((mode) => {
    const room = makeRoom(mode);
    setup(room);
    return room;
  });
  const signatures = rooms.map((room) => stateSignature(observe(room)));
  assert.deepEqual(signatures[1], signatures[0], `${label}: optimized result differs from legacy`);
  if (checks) checks(rooms[0], rooms[1]);
  return rooms;
}

function testFlagContract() {
  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(false);
  assert.equal(flags.OPTIMIZED_VISIBILITY_RUNTIME(), false, "Phase 6C defaults disabled");
  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(true);
  assert.equal(flags.OPTIMIZED_VISIBILITY_RUNTIME(), true, "Phase 6C test setter enables the full runtime");
  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(false);
}

function testModesAndGeometryParity() {
  for (const visibilityMode of ["sensors", "dark"]) {
    const rooms = ["legacy", "optimized"].map((mode) => {
      const room = makeRoom(mode, visibilityMode);
      observe(room);
      return room;
    });
    assert.deepEqual(stateSignature(computeFor(rooms[1], "blue", 1000)), stateSignature(computeFor(rooms[0], "blue", 1000)), `${visibilityMode}: parity`);
  }

  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(false);
  const fullRoom = makeRoom("legacy", "full");
  const fullEnemy = fullRoom.ships.get("red-target");
  assert.equal(withRoomMode(fullRoom, () => canTeamSeeEntity(fullRoom, "blue", fullEnemy, 0)), true, "full visibility remains visible");
  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(true);
  const fullOptimized = makeRoom("optimized", "full");
  assert.equal(withRoomMode(fullOptimized, () => canTeamSeeEntity(fullOptimized, "blue", fullOptimized.ships.get("red-target"), 0)), true, "optimized full visibility remains visible");

  compareScenario("multiple sources", (room) => {
    addShip(room, "blue-source-2", "blue", 0, 200);
    addShip(room, "red-target-2", "red", 350, 200);
  });

  compareScenario("directed cone boundary and target padding", (room) => {
    const source = room.ships.get("blue-source");
    source.design = [{ x: 7, y: 7, type: "largeDirectedSensor", rotation: 270 }];
    source.componentHp = [100];
    source.componentMaxHp = [100];
    source.componentPower = { byComponentIndex: [{ operationalMultiplier: 1 }] };
    const target = room.ships.get("red-target");
    target.x = 1300;
    target.y = 0;
    target.radius = 28;
  });
}

function testMovementCapabilityAndAuraParity() {
  const rooms = ["legacy", "optimized"].map((mode) => {
    const room = makeRoom(mode);
    const source = room.ships.get("blue-source");
    source.design = [{ x: 7, y: 7, type: "largeSensor" }];
    source.componentHp = [100];
    source.componentMaxHp = [100];
    source.componentPower = { byComponentIndex: [{ operationalMultiplier: 1 }] };
    observe(room);
    return room;
  });
  const optimizedSource = rooms[1].ships.get("blue-source");
  const legacySource = rooms[0].ships.get("blue-source");
  const optimizedRecord = rooms[1]._visibilityRuntime.sourceByEntityId.get("blue-source");
  const capabilityRevision = optimizedRecord.capabilityRevision;
  const transformRevision = optimizedRecord.transformRevision;
  optimizedSource.x = 80;
  optimizedSource.angle = Math.PI / 3;
  legacySource.x = 80;
  legacySource.angle = Math.PI / 3;
  for (const room of rooms) {
    invalidateFor(room, "source-transform");
    computeFor(room, "blue", 1100);
  }
  assert.equal(optimizedRecord.capabilityRevision, capabilityRevision, "movement does not refresh sensor capability");
  assert(optimizedRecord.transformRevision > transformRevision, "movement refreshes only transform state");
  assert.deepEqual(stateSignature(computeFor(rooms[1], "blue", 1100)), stateSignature(computeFor(rooms[0], "blue", 1100)), "moving source parity");

  optimizedSource.componentHp[0] = 0;
  optimizedSource.componentDamageRevision += 1;
  optimizedSource.componentAliveRevision += 1;
  optimizedSource.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  optimizedSource.powerRevision += 1;
  optimizedSource.heatStateRevision += 1;
  optimizedSource.commandAuraMultipliers = { sensorRangeMultiplier: 1.2 };
  legacySource.componentHp[0] = 0;
  legacySource.componentDamageRevision += 1;
  legacySource.componentAliveRevision += 1;
  legacySource.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  legacySource.powerRevision += 1;
  legacySource.heatStateRevision += 1;
  legacySource.commandAuraMultipliers = { sensorRangeMultiplier: 1.2 };
  for (const room of rooms) invalidateFor(room, "sensor-capability-change");
  const optimizedState = computeFor(rooms[1], "blue", 1200);
  const legacyState = computeFor(rooms[0], "blue", 1200);
  assert.deepEqual(stateSignature(optimizedState), stateSignature(legacyState), "damage, power, heat and aura parity");
  assert(optimizedRecord.capabilityRevision > capabilityRevision, "capability changes refresh the profile");
}

function testLifecycleMembershipAndRelayCapture() {
  const room = makeRoom("optimized");
  observe(room);
  const runtime = room._visibilityRuntime;
  const initialSources = runtime.sourceByEntityId.size;
  addDrone(room, "red-drone", "red", 200, 0);
  addStation(room, "red-station", "relay", "red", 300, 0);
  invalidateFor(room, "spawn");
  const state = ensureFor(room, "blue", 1100);
  assert(state.visibleEntityIds.has("red-drone"), "drone spawn enters maintained membership");
  assert(state.visibleEntityIds.has("red-station"), "station spawn enters maintained membership");
  assert(runtime.teamEntityIds.get("red").drones.has("red-drone"), "drone allied membership is maintained");
  room.drones.delete("red-drone");
  room.stations[0].state = "destroyed";
  room.stations[0].alive = false;
  invalidateFor(room, "destruction");
  ensureFor(room, "blue", 1200);
  assert(!runtime.teamEntityIds.get("red")?.drones?.has("red-drone"), "destroyed drone leaves membership");
  assert(!runtime.sourceByEntityId.has("red-station"), "destroyed station leaves source registry");

  const relayRoom = makeRoom("optimized", "sensors", "classic");
  relayRoom.points = [{ id: "relay-a", x: 200, y: 0, ownerTeam: "blue", state: "operational" }];
  observe(relayRoom);
  const relayRuntime = relayRoom._visibilityRuntime;
  assert(relayRuntime.sourcesByTeam.get("blue").some((source) => source.entityId === "relay-a"), "classic relay uses source abstraction");
  relayRoom.points[0].ownerTeam = "red";
  invalidateFor(relayRoom, { reason: "capture", allegianceChanged: true });
  ensureFor(relayRoom, "red", 1300);
  assert(!relayRuntime.sourcesByTeam.get("blue")?.some((source) => source.entityId === "relay-a"), "relay leaves old team source list");
  assert(relayRuntime.sourcesByTeam.get("red")?.some((source) => source.entityId === "relay-a"), "relay enters new team source list");
  assert.equal(relayRuntime.sourceByEntityId.size, initialSources + 1, "source registry remains bounded after lifecycle churn");
}

function testRememberedContactsAndTargeting() {
  const rooms = ["legacy", "optimized"].map((mode) => {
    const room = makeRoom(mode);
    observe(room, "blue", 1000);
    room.ships.get("red-target").x = 3000;
    invalidateFor(room, "target-moved");
    computeFor(room, "blue", 1100);
    return room;
  });
  const lingerAt = 1100 + DETECTION_LINGER_MS - 1;
  const rememberedAt = 1100 + DETECTION_LINGER_MS + 1;
  const linger = rooms.map((room) => stateSignature(computeFor(room, "blue", lingerAt)));
  const remembered = rooms.map((room) => stateSignature(computeFor(room, "blue", rememberedAt)));
  assert.deepEqual(linger[1], linger[0], "detection linger parity");
  assert.deepEqual(remembered[1], remembered[0], "remembered-contact parity");
  assert.equal(withRoomMode(rooms[1], () => canTeamTargetEntity(rooms[1], "blue", rooms[1].ships.get("red-target"), rememberedAt + 1000)), false, "remembered contact is not targetable");
  const expiredAt = 1100 + DETECTION_LINGER_MS + REMEMBERED_CONTACT_MS + 1;
  const expired = computeFor(rooms[1], "blue", expiredAt);
  assert.equal(expired.remembered.has("red-target"), false, "remembered contact expires");
}

function testSnapshotPrivacyAndSharedTeamResult() {
  const rooms = ["legacy", "optimized"].map((mode) => {
    const room = makeRoom(mode);
    room.ships.get("red-target").x = 3000;
    addDrone(room, "near-drone", "red", 100, 0);
    addDrone(room, "far-drone", "red", 3000, 0);
    addStation(room, "hidden-station", "relay", "red", 3000, 0);
    observe(room);
    return room;
  });
  const snapshots = rooms.map((room) => ({
    ships: [{ id: "blue-source", team: "blue", privatePower: "blue-only" }, { id: "red-target", team: "red", privatePower: "red-secret" }],
    drones: [{ id: "near-drone" }, { id: "far-drone" }],
    decoys: [],
    bullets: [{ id: "near-bullet", ownerId: "red", x: 100, y: 0 }, { id: "far-bullet", ownerId: "red", x: 3000, y: 0 }],
    effects: [{ id: "near-effect", x: 100, y: 0 }, { id: "far-effect", x: 3000, y: 0 }],
    stations: [{ id: "hidden-station", stationType: "relay", team: "red", state: "operational", x: 3000, y: 0, radius: 40, design: [] }]
  }));
  const filtered = rooms.map((room, index) => filterFor(room, room.players.get("blue"), snapshots[index], 1000));
  const simplify = (snapshot) => ({
    ships: snapshot.ships.map((entry) => entry.id),
    drones: snapshot.drones.map((entry) => entry.id),
    bullets: snapshot.bullets.map((entry) => entry.id),
    effects: snapshot.effects.map((entry) => entry.id),
    stations: snapshot.stations.map((entry) => ({ id: entry.id, conditionKnown: entry.conditionKnown, mapKnown: entry.mapKnown })),
    contacts: snapshot.contacts.map((entry) => entry.id)
  });
  assert.deepEqual(simplify(filtered[1]), simplify(filtered[0]), "team-filtered snapshot parity");
  assert.equal(filtered[1].ships.some((entry) => entry.privatePower === "red-secret"), false, "hidden enemy ship is absent");
  assert.equal(filtered[1].stations[0].conditionKnown, false, "hidden station condition remains private");

  const teammate = rooms[1].players.get("blue-ally");
  const first = filterFor(rooms[1], rooms[1].players.get("blue"), snapshots[1], 1000);
  const second = filterFor(rooms[1], teammate, snapshots[1], 1000);
  assert.equal(first.drones, second.drones, "teammates reuse the shared tactical drone array");
  assert.equal(first.bullets, second.bullets, "teammates reuse the shared tactical bullet array");
  assert.equal(first.ships === second.ships, false, "private ship rows are not reused as complete payloads");
}

function testSpatialFallbackRecoveryAndReset() {
  const room = makeRoom("optimized");
  room.spatialIndex = new RoomSpatialIndex(320);
  room.spatialIndex.rebuild(room, [...room.ships.values()], 1);
  observe(room);
  const runtime = room._visibilityRuntime;
  room.spatialIndex.dynamicValid = false;
  invalidateFor(room, "spatial-invalid");
  ensureFor(room, "blue", 1100);
  assert((room._roomTelemetry?.visibilityFullCollectionFallbacks || 0) > 0, "invalid spatial categories use recorded fallback scans");
  room.spatialIndex.rebuild(room, [...room.ships.values()], 2);
  invalidateFor(room, "spatial-recovered");
  ensureFor(room, "blue", 1200);
  assert.equal(runtime.sourceByEntityId.size, 2, "spatial recovery does not duplicate sources");
  const oldEpoch = room.stateEpoch;
  room.stateEpoch += 1;
  invalidateFor(room, "epoch-change");
  ensureFor(room, "blue", 1300);
  assert.notEqual(room._visibilityRuntime.epoch, oldEpoch, "state epoch creates a fresh visibility context");
  clearVisibilityForRoom(room);
  assert.equal(room._visibilityRuntime, null, "room reset removes optimized visibility runtime");
  assert.equal(room.visibilityByTeam.size, 0, "room reset removes team results");
}

function testProjectileVisibilityRevisionAndCursor() {
  const room = makeRoom("optimized");
  room.bullets = [];
  room.projectileById = new Map();
  const viewer = room.players.get("blue");
  const client = { player: viewer, protocol: { capabilities: ["projectileEventsV1"] } };
  const bullet = {
    id: "hidden-projectile",
    type: "bolt",
    subtype: null,
    ownerId: "red",
    x: 3000,
    y: 0,
    vx: 0,
    vy: 0,
    radius: 2,
    bornAt: 1000,
    life: 10
  };
  room.bullets.push(bullet);
  room.projectileById.set(bullet.id, bullet);

  withRoomMode(room, () => {
    initializeClient(client, room, false);
    recordProjectileSpawn(room, bullet, 1000);
    const hidden = buildClientBatch(room, client, 1000, false);
    assert.equal(hidden.events.length, 0, "hidden projectile event is not delivered");
    assert.equal(hidden.delivery.eventSeq, 1, "hidden projectile advances the event cursor");
    markProjectilesWritten(client, room, hidden.delivery);

    bullet.x = 100;
    invalidateVisibility(room, { reason: "projectile-entered-coverage", geometryChanged: true });
    const visible = buildClientBatch(room, client, 1000, false);
    assert.equal(visible.events.length, 1, "reacquired projectile gets a visibility transition");
    assert.equal(visible.events[0].type, "projectileSpawn", "reacquired projectile is a spawn transition");
  });
}

function testScopedInvalidationReusesUnchangedTeam() {
  const room = makeRoom("optimized");
  observe(room, "blue", 1000);
  ensureFor(room, "red", 1000);
  const before = room._visibilityComputeCount;
  invalidateFor(room, { reason: "blue-source-only", sourceTeams: ["blue"], sourceIds: ["blue-source"] });
  ensureFor(room, "blue", 1100);
  const afterBlue = room._visibilityComputeCount;
  ensureFor(room, "red", 1100);
  assert.equal(afterBlue, before + 1, "scoped invalidation recomputes the changed team");
  assert.equal(room._visibilityComputeCount, afterBlue, "scoped invalidation reuses the unchanged team result");
}

function testLongDifferentialAndBoundedCaches() {
  const rooms = ["legacy", "optimized"].map((mode) => makeRoom(mode));
  for (let step = 0; step < 80; step += 1) {
    for (const room of rooms) {
      const source = room.ships.get("blue-source");
      const target = room.ships.get("red-target");
      source.x = Math.sin(step * 0.17) * 260;
      source.y = Math.cos(step * 0.11) * 180;
      source.angle = step * 0.07;
      target.x = 250 + Math.sin(step * 0.13) * 650;
      target.y = Math.cos(step * 0.19) * 420;
      invalidateFor(room, "moving-battle");
    }
    const legacy = stateSignature(computeFor(rooms[0], "blue", 1000 + step * 33));
    const optimized = stateSignature(computeFor(rooms[1], "blue", 1000 + step * 33));
    assert.deepEqual(optimized, legacy, `long differential step ${step}`);
  }
  const runtime = rooms[1]._visibilityRuntime;
  assert.equal(runtime.sourceByEntityId.size, 2, "long soak does not grow source registry");
  assert(runtime.teamEntityIds.size <= 2, "long soak does not grow team membership maps");
  assert(runtime.teamStates.size <= 1, "only requested team result is retained");
}

function main() {
  try {
    testFlagContract();
    testModesAndGeometryParity();
    testMovementCapabilityAndAuraParity();
    testLifecycleMembershipAndRelayCapture();
    testRememberedContactsAndTargeting();
    testSnapshotPrivacyAndSharedTeamResult();
    testSpatialFallbackRecoveryAndReset();
    testProjectileVisibilityRevisionAndCursor();
    testScopedInvalidationReusesUnchangedTeam();
    testLongDifferentialAndBoundedCaches();
    console.log("verify-phase-6c-visibility-runtime: all passed");
  } finally {
    flags.__setOPTIMIZED_VISIBILITY_RUNTIME(false);
  }
}

main();
