"use strict";

const assert = require("node:assert/strict");
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
const {
  filterSnapshotForPlayer,
  auditSnapshotForInformationLeaks
} = require("./src/server/visibilitySnapshots");
const { clearVisibilityForRoom } = require("./src/server/visibility");
const { RoomSpatialIndex } = require("./src/server/spatialIndex");
const { reconcileVisibilityRuntime } = require("./src/server/visibilityRuntime");
const {
  initializeClient,
  recordProjectileSpawn,
  recordProjectileRemove,
  prepareRoomCorrections,
  buildClientBatch,
  markProjectilesWritten,
  getClientProjectileState,
  resetProjectileReplication,
  getTeamVisibleProjectiles
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

function makeRoom(mode = "canonical", visibilityMode = "sensors", infrastructureMode = "stations") {
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
  try {
    return callback();
  } finally {
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

function snapshotWithMeta(room, snapshot) {
  const entityTeamById = new Map();
  const shipsById = new Map();
  const dronesById = new Map();
  const stationsById = new Map();
  for (const ship of snapshot.ships || []) {
    shipsById.set(ship.id, ship);
    entityTeamById.set(ship.id, ship.team);
  }
  for (const drone of snapshot.drones || []) {
    dronesById.set(drone.id, drone);
    entityTeamById.set(drone.id, drone.team ?? drone.teamId ?? null);
  }
  for (const station of snapshot.stations || []) {
    stationsById.set(station.id, station);
    entityTeamById.set(station.id, station.team ?? null);
  }
  const meta = { shipsById, dronesById, stationsById, entityTeamById };
  Object.defineProperty(snapshot, "snapshotEntityMeta", {
    value: meta,
    enumerable: false,
    configurable: true
  });
  return snapshot;
}

function snapshotSignature(snapshot) {
  return {
    ships: (snapshot.ships || []).map((entry) => ({ id: entry.id, privatePower: entry.privatePower, marker: entry.marker })).sort((a, b) => a.id.localeCompare(b.id)),
    drones: (snapshot.drones || []).map((entry) => ({ id: entry.id, marker: entry.marker })).sort((a, b) => a.id.localeCompare(b.id)),
    bullets: (snapshot.bullets || []).map((entry) => ({ id: entry.id, marker: entry.marker })).sort((a, b) => a.id.localeCompare(b.id)),
    effects: (snapshot.effects || []).map((entry) => ({ id: entry.id, marker: entry.marker })).sort((a, b) => a.id.localeCompare(b.id)),
    stations: (snapshot.stations || []).map((entry) => ({
      id: entry.id,
      x: entry.x,
      conditionKnown: entry.conditionKnown,
      hasHp: entry.hp !== undefined || entry.maxHp !== undefined
    })).sort((a, b) => a.id.localeCompare(b.id)),
    contacts: (snapshot.contacts || []).map((entry) => entry.id).sort()
  };
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
  const rooms = ["canonical", "repeat"].map((mode) => {
    const room = makeRoom(mode);
    setup(room);
    return room;
  });
  const signatures = rooms.map((room) => stateSignature(observe(room)));
  assert.deepEqual(signatures[1], signatures[0], `${label}: repeat result differs from canonical`);
  if (checks) checks(rooms[0], rooms[1]);
  return rooms;
}

function testFlagContract() {
}

function testModesAndGeometryParity() {
  for (const visibilityMode of ["sensors", "dark"]) {
    const rooms = ["canonical", "repeat"].map((mode) => {
      const room = makeRoom(mode, visibilityMode);
      observe(room);
      return room;
    });
    assert.deepEqual(stateSignature(computeFor(rooms[1], "blue", 1000)), stateSignature(computeFor(rooms[0], "blue", 1000)), `${visibilityMode}: parity`);
  }

  const fullRoom = makeRoom("canonical", "full");
  const fullEnemy = fullRoom.ships.get("red-target");
  assert.equal(withRoomMode(fullRoom, () => canTeamSeeEntity(fullRoom, "blue", fullEnemy, 0)), true, "full visibility remains visible");
  const fullRepeat = makeRoom("repeat", "full");
  assert.equal(withRoomMode(fullRepeat, () => canTeamSeeEntity(fullRepeat, "blue", fullRepeat.ships.get("red-target"), 0)), true, "repeat full visibility remains visible");

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
  const rooms = ["canonical", "repeat"].map((mode) => {
    const room = makeRoom(mode);
    const source = room.ships.get("blue-source");
    source.design = [{ x: 7, y: 7, type: "largeSensor" }];
    source.componentHp = [100];
    source.componentMaxHp = [100];
    source.componentPower = { byComponentIndex: [{ operationalMultiplier: 1 }] };
    observe(room);
    return room;
  });
  const repeatSource = rooms[1].ships.get("blue-source");
  const canonicalSource = rooms[0].ships.get("blue-source");
  const repeatRecord = rooms[1]._visibilityRuntime.sourceByEntityId.get("blue-source");
  const capabilityRevision = repeatRecord.capabilityRevision;
  const transformRevision = repeatRecord.transformRevision;
  repeatSource.x = 80;
  repeatSource.angle = Math.PI / 3;
  canonicalSource.x = 80;
  canonicalSource.angle = Math.PI / 3;
  for (const room of rooms) {
    invalidateFor(room, "source-transform");
    computeFor(room, "blue", 1100);
  }
  assert.equal(repeatRecord.capabilityRevision, capabilityRevision, "movement does not refresh sensor capability");
  assert(repeatRecord.transformRevision > transformRevision, "movement refreshes only transform state");
  assert.deepEqual(stateSignature(computeFor(rooms[1], "blue", 1100)), stateSignature(computeFor(rooms[0], "blue", 1100)), "moving source parity");

  repeatSource.componentHp[0] = 0;
  repeatSource.componentDamageRevision += 1;
  repeatSource.componentAliveRevision += 1;
  repeatSource.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  repeatSource.powerRevision += 1;
  repeatSource.heatStateRevision += 1;
  repeatSource.commandAuraMultipliers = { sensorRangeMultiplier: 1.2 };
  canonicalSource.componentHp[0] = 0;
  canonicalSource.componentDamageRevision += 1;
  canonicalSource.componentAliveRevision += 1;
  canonicalSource.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  canonicalSource.powerRevision += 1;
  canonicalSource.heatStateRevision += 1;
  canonicalSource.commandAuraMultipliers = { sensorRangeMultiplier: 1.2 };
  for (const room of rooms) invalidateFor(room, "sensor-capability-change");
  const repeatState = computeFor(rooms[1], "blue", 1200);
  const canonicalState = computeFor(rooms[0], "blue", 1200);
  assert.deepEqual(stateSignature(repeatState), stateSignature(canonicalState), "damage, power, heat and aura parity");
  assert(repeatRecord.capabilityRevision > capabilityRevision, "capability changes refresh the profile");
}

function testLifecycleMembershipAndRelayCapture() {
  const room = makeRoom("repeat");
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

  const relayRoom = makeRoom("repeat", "sensors", "classic");
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
  const rooms = ["canonical", "repeat"].map((mode) => {
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
  const rooms = ["canonical", "repeat"].map((mode) => {
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

function testSnapshotCacheFreshness() {
  const room = makeRoom("repeat");
  addDrone(room, "near-drone", "red", 100, 0);
  addStation(room, "cache-station", "relay", "red", 3000, 0);
  observe(room);
  const player = room.players.get("blue");

  const makeSnapshot = (marker, revision = 1) => snapshotWithMeta(room, {
    stateEpoch: room.stateEpoch || 1,
    snapshotSeq: revision,
    staticRevision: revision,
    entityDeltaGeneration: revision,
    ships: [
      { id: "blue-source", team: "blue", x: 0, y: 0, privatePower: `blue-${marker}` },
      { id: "red-target", team: "red", x: 3000, y: 0, privatePower: `red-${marker}` }
    ],
    drones: [{ id: "near-drone", team: "red", x: 100, y: 0, marker }],
    decoys: [],
    bullets: [{ id: "near-bullet", ownerId: "red", x: 100, y: 0, marker }],
    effects: [{ id: "near-effect", x: 100, y: 0, marker }],
    stations: [{
      id: "cache-station",
      stationType: "relay",
      team: "red",
      state: "operational",
      x: 3000,
      y: 0,
      radius: 40,
      hp: 10,
      maxHp: 100,
      design: []
    }]
  });

  const snapshotA = makeSnapshot("old", 1);
  const first = filterFor(room, player, snapshotA, 1000);
  const buildsAfterFirst = room._roomTelemetry?.visibilitySnapshotFilterBuilds || 0;
  const cached = filterFor(room, player, snapshotA, 1000);
  assert.equal(cached.drones, first.drones, "unchanged shared snapshot reuses tactical arrays");
  assert.equal(
    room._roomTelemetry?.visibilitySnapshotFilterBuilds || 0,
    buildsAfterFirst,
    "unchanged shared snapshot does not rebuild the tactical layer"
  );

  const changed = filterFor(room, player, makeSnapshot("new", 2), 1000);
  assert((room._roomTelemetry?.visibilitySnapshotFilterBuilds || 0) > buildsAfterFirst, "changed snapshot identity rebuilds the tactical layer");
  assert.equal(changed.drones[0].marker, "new", "changed drone snapshot data is delivered");
  assert.equal(changed.bullets[0].marker, "new", "changed bullet snapshot data is delivered");
  assert.equal(changed.effects[0].marker, "new", "changed effect snapshot data is delivered");
  assert.equal(changed.ships[0].privatePower, "blue-new", "changed allied ship data remains player-specific");
  assert.equal(changed.stations[0].conditionKnown, false, "changed hidden station condition remains private");
  assert.equal(changed.stations[0].x, 3000, "station map geometry remains public");
  auditSnapshotForInformationLeaks(room, player, changed, 1000);

  // Per-player snapshots may share one tactical source object.  Metadata and
  // event mode still belong in the key even when every source array is reused.
  const eventShared = makeSnapshot("event", 10);
  eventShared.bullets = [eventShared.bullets[0]];
  const eventView = { ...eventShared, __visibilitySharedIdentity: eventShared };
  const eventFirst = filterFor(room, player, eventView, 1000);
  const beforeMetadataChange = room._roomTelemetry?.visibilitySnapshotFilterBuilds || 0;
  const eventModeChanged = {
    ...eventView,
    stateEpoch: (room.stateEpoch || 1) + 1,
    staticRevision: 11,
    entityDeltaGeneration: 11,
    projectileEvents: []
  };
  const eventSecond = filterFor(room, player, eventModeChanged, 1000);
  assert((room._roomTelemetry?.visibilitySnapshotFilterBuilds || 0) > beforeMetadataChange, "epoch, static revision and event mode invalidate the shared cache");
  assert.equal(eventSecond.bullets.length, 1, "event-mode snapshot carries only its authorised bullet baseline");
  auditSnapshotForInformationLeaks(room, player, eventSecond, 1000);
  assert(eventFirst && eventSecond, "snapshot cache freshness fixtures produced results");
}

function testSpatialFallbackRecoveryAndReset() {
  const room = makeRoom("repeat");
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
  assert.equal(room._visibilityRuntime, null, "room reset removes repeat visibility runtime");
  assert.equal(room._visibilityRuntime, null, "room reset removes team results");
}

function testReconciliationAndInvalidationTelemetry() {
  const room = makeRoom("repeat");
  observe(room);
  const runtime = room._visibilityRuntime;
  const original = room.ships.get("blue-source");
  const replacement = addShip(room, "blue-source", "blue", 0, 0, {
    design: [{ x: 7, y: 7, type: "largeSensor" }]
  });
  runtime.reconcileRequested = true;
  reconcileVisibilityRuntime(room);
  const replacementRecord = runtime.sourceByEntityId.get("blue-source");
  assert.equal(replacementRecord.entity, replacement, "reconciliation replaces a same-size direct map mutation");
  assert.notEqual(replacementRecord.entity, original, "reconciliation removes the stale source object");
  assert.equal(
    runtime.sourcesByTeam.get("blue").filter((record) => record.entityId === "blue-source").length,
    1,
    "reconciliation does not duplicate a replaced source"
  );

  room.ships.delete("blue-source");
  runtime.reconcileRequested = true;
  reconcileVisibilityRuntime(room);
  assert.equal(runtime.sourceByEntityId.has("blue-source"), false, "reconciliation removes a direct map deletion");
  assert.equal(runtime.entityTeamCache.has("blue-source"), false, "reconciliation removes deleted entity membership");

  for (let index = 0; index < 20; index += 1) {
    addShip(room, "churn-source", "blue", index, 0, {
      design: [{ x: 7, y: 7, type: "smallSensor" }]
    });
    runtime.reconcileRequested = true;
    reconcileVisibilityRuntime(room);
    room.ships.delete("churn-source");
    runtime.reconcileRequested = true;
    reconcileVisibilityRuntime(room);
  }
  assert(runtime.sourceByEntityId.size <= 2, "repeated direct spawn/destruction does not grow source registry");
  assert(runtime.entityTeamCache.size <= 2, "repeated direct spawn/destruction does not grow entity cache");

  room.simulationTimeMs = 2000;
  room._visibilityFinalizedAt = 2000;
  const beforeDuplicateInvalidations = room._roomTelemetry?.visibilityDuplicateInvalidations || 0;
  const beforeComputesAfterFinalization = room._roomTelemetry?.visibilityComputesAfterFinalization || 0;
  invalidateFor(room, { reason: "same-step-finalization", geometryChanged: true });
  invalidateFor(room, { reason: "same-step-finalization", geometryChanged: true });
  ensureFor(room, "blue", 2000);
  assert((room._roomTelemetry?.visibilityDuplicateInvalidations || 0) > beforeDuplicateInvalidations, "duplicate invalidations are recorded");
  assert((room._roomTelemetry?.visibilityComputesAfterFinalization || 0) > beforeComputesAfterFinalization, "post-finalization visibility computation is recorded");
}

function testProjectileVisibilityRevisionAndCursor() {
  const room = makeRoom("repeat");
  room.bullets = [];
  room.projectileById = new Map();
  const viewer = room.players.get("blue");
  const client = { player: viewer, protocol: { capabilities: ["projectileEventsV1"] } };
  const teammate = { player: room.players.get("blue-ally"), protocol: { capabilities: ["projectileEventsV1"] } };
  const bullet = {
    id: "hidden-projectile",
    type: "missile",
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
    initializeClient(teammate, room, false);
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
    markProjectilesWritten(client, room, visible.delivery);
    assert(getClientProjectileState(client, room).eventCursor > getClientProjectileState(teammate, room).eventCursor, "teammate projectile cursors remain independent");

    // A correction generated while the projectile is hidden advances the
    // private cursor but never becomes a wire payload.  If that cursor were
    // left behind, the correction would be replayed on reacquisition.
    bullet.x = 3000;
    invalidateVisibility(room, { reason: "projectile-left-coverage", geometryChanged: true });
    prepareRoomCorrections(room, 1200);
    const hiddenCorrection = buildClientBatch(room, client, 1200, false);
    assert.equal(hiddenCorrection.events.some((event) => event.type === "projectileCorrection"), false, "hidden projectile correction is not delivered");
    assert.equal(hiddenCorrection.delivery.correctionSeq, 1, "hidden correction advances the client correction cursor");
    markProjectilesWritten(client, room, hiddenCorrection.delivery);

    bullet.x = 100;
    invalidateVisibility(room, { reason: "projectile-reacquired-after-correction", geometryChanged: true });
    prepareRoomCorrections(room, 1300);
    const visibleAfterCorrection = buildClientBatch(room, client, 1300, false);
    assert.equal(
      visibleAfterCorrection.events.some((event) => event.type === "projectileCorrection" && event.simulationTimeMs === 1200),
      false,
      "hidden correction is not replayed after reacquisition"
    );
    assert.equal(
      visibleAfterCorrection.events.filter((event) => event.type === "projectileCorrection").length,
      1,
      "only the current visible correction is delivered"
    );
    markProjectilesWritten(client, room, visibleAfterCorrection.delivery);

    // The teammate starts from its own cursor and receives only the current
    // authorised transition; it does not inherit the first client's baseline.
    const teammateBatch = buildClientBatch(room, teammate, 1300, false);
    assert(teammateBatch.events.some((event) => event.type === "projectileSpawn"), "teammate receives its own visible projectile transition");
    assert.equal(teammateBatch.events.some((event) => event.type === "projectileCorrection" && event.simulationTimeMs === 1200), false, "teammate does not receive a hidden correction");
    markProjectilesWritten(teammate, room, teammateBatch.delivery);

    // Removing a projectile while hidden advances the lifecycle cursor without
    // exposing the hidden remove event or its final coordinates.
    bullet.x = 3000;
    invalidateVisibility(room, { reason: "projectile-hidden-before-remove", geometryChanged: true });
    const hiddenAgain = buildClientBatch(room, client, 1400, false);
    markProjectilesWritten(client, room, hiddenAgain.delivery);
    const removeSeqBefore = getClientProjectileState(client, room).eventCursor;
    recordProjectileRemove(room, bullet, "expired", 1400, 3000, 0);
    const hiddenRemove = buildClientBatch(room, client, 1400, false);
    assert.equal(hiddenRemove.events.length, 0, "hidden projectile removal is not delivered");
    assert(hiddenRemove.delivery.eventSeq > removeSeqBefore, "hidden projectile removal advances the event cursor");
    markProjectilesWritten(client, room, hiddenRemove.delivery);

    const lateBullet = {
      id: "late-visible-projectile",
      type: "bolt",
      subtype: null,
      ownerId: "red",
      x: 100,
      y: 0,
      vx: 0,
      vy: 0,
      radius: 2,
      bornAt: 1500,
      life: 10
    };
    room.bullets.push(lateBullet);
    room.projectileById.set(lateBullet.id, lateBullet);
    invalidateVisibility(room, { reason: "late-join-projectile", geometryChanged: true });
    recordProjectileSpawn(room, lateBullet, 1500);
    const late = { player: viewer, protocol: { capabilities: ["projectileEventsV1"] } };
    initializeClient(late, room, true);
    const baseline = buildClientBatch(room, late, 1500, true);
    assert.deepEqual(baseline.bullets.map((entry) => entry.id), ["late-visible-projectile"], "late join receives only the current visible projectile baseline");
    markProjectilesWritten(late, room, baseline.delivery);

    const nextEpoch = (room.stateEpoch || 1) + 1;
    room.stateEpoch = nextEpoch;
    resetProjectileReplication(room, nextEpoch);
    const epochClient = { player: viewer, protocol: { capabilities: ["projectileEventsV1"] } };
    initializeClient(epochClient, room, true);
    const epochBaseline = buildClientBatch(room, epochClient, 1500, true);
    assert.equal(epochBaseline.delivery.stateEpoch, nextEpoch, "state-epoch change creates a fresh projectile baseline context");
  });
}

function testScopedInvalidationReusesUnchangedTeam() {
  const room = makeRoom("repeat");
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
  const teams = ["blue", "red", "green"];
  const rooms = ["canonical", "repeat"].map((mode) => {
    const room = makeRoom(mode);
    addPlayer(room, "green", "green");
    addShip(room, "green-source", "green", 120, 160, {
      design: [{ x: 7, y: 7, type: "largeSensor" }]
    });
    addShip(room, "red-secondary", "red", 900, -120, {
      design: [{ x: 7, y: 7, type: "smallSensor" }]
    });
    addDrone(room, "soak-red-drone", "red", 350, 100);
    addDrone(room, "soak-green-drone", "green", -350, -100);
    addStation(room, "soak-relay", "relay", "red", 1200, 0);
    room.bullets = [{
      id: "soak-bullet",
      type: "bolt",
      entityType: "projectile",
      ownerId: "red",
      x: 700,
      y: 0,
      radius: 2,
      life: 10
    }];
    room.projectileById = new Map([["soak-bullet", room.bullets[0]]]);
    room.spatialIndex = new RoomSpatialIndex(320);
    room.spatialIndex.rebuild(room, [...room.ships.values()], 1);
    room.spatialIndex.updateLiveEntities("drones", room.drones.values(), (drone) => drone.radius);
    room.spatialIndex.updateLiveEntities("stations", room.stations, (station) => station.radius);
    return room;
  });

  const snapshotForStep = (room, step) => snapshotWithMeta(room, {
    stateEpoch: room.stateEpoch || 1,
    snapshotSeq: step + 1,
    staticRevision: 1 + Math.floor(step / 37),
    entityDeltaGeneration: step + 1,
    ships: [...room.ships.values()].map((ship) => ({
      id: ship.id,
      team: ship.team,
      x: ship.x,
      y: ship.y,
      privatePower: `${ship.team}-private-${step}`
    })),
    drones: [...room.drones.values()].map((drone) => ({
      id: drone.id,
      team: drone.teamId,
      x: drone.x,
      y: drone.y,
      radius: drone.radius
    })),
    decoys: [],
    bullets: room.bullets.map((bullet) => ({
      id: bullet.id,
      ownerId: bullet.ownerId,
      x: bullet.x,
      y: bullet.y,
      radius: bullet.radius
    })),
    effects: [
      { id: "soak-near-effect", x: 100, y: 0, marker: step },
      { id: "soak-far-effect", x: 5000, y: 0, marker: step }
    ],
    stations: room.stations.map((station) => ({
      id: station.id,
      stationType: station.stationType,
      team: station.team,
      ownerId: station.ownerId,
      state: station.state,
      x: station.x,
      y: station.y,
      radius: station.radius,
      hp: station.hp,
      maxHp: station.maxHp,
      design: []
    }))
  });

  for (let step = 0; step < 240; step += 1) {
    const now = 1000 + step * 33;
    for (const room of rooms) {
      room.simulationTimeMs = now;
      const blueSource = room.ships.get("blue-source");
      const greenSource = room.ships.get("green-source");
      const redTarget = room.ships.get("red-target");
      const redSecondary = room.ships.get("red-secondary");
      blueSource.x = Math.sin(step * 0.17) * 260;
      blueSource.y = Math.cos(step * 0.11) * 180;
      blueSource.angle = step * 0.07;
      greenSource.x = 120 + Math.cos(step * 0.09) * 300;
      greenSource.y = 160 + Math.sin(step * 0.14) * 240;
      greenSource.angle = -step * 0.05;
      redTarget.x = 250 + Math.sin(step * 0.13) * 650;
      redTarget.y = Math.cos(step * 0.19) * 420;
      redSecondary.x = 900 + Math.sin(step * 0.07) * 180;
      redSecondary.y = -120 + Math.cos(step * 0.12) * 140;
      room.drones.get("soak-red-drone").x = 350 + Math.sin(step * 0.08) * 280;
      room.drones.get("soak-red-drone").y = 100 + Math.cos(step * 0.16) * 190;
      room.drones.get("soak-green-drone").x = -350 + Math.cos(step * 0.1) * 240;
      room.drones.get("soak-green-drone").y = -100 + Math.sin(step * 0.15) * 210;
      const relay = room.stationsById.get("soak-relay");
      relay.x = 1200 + Math.sin(step * 0.06) * 160;
      relay.y = Math.cos(step * 0.1) * 120;
      if (step % 17 === 0) {
        relay.team = relay.team === "red" ? "blue" : "red";
        relay.state = "operational";
        relay.revision += 1;
      }
      if (step % 11 === 0) {
        const damaged = greenSource.componentHp[1] > 0;
        greenSource.componentHp[1] = damaged ? 0 : greenSource.componentMaxHp[1];
        greenSource.componentDamageRevision = (greenSource.componentDamageRevision || 0) + 1;
        greenSource.componentAliveRevision = (greenSource.componentAliveRevision || 0) + 1;
        greenSource.powerRevision = (greenSource.powerRevision || 0) + 1;
        greenSource.heatStateRevision = (greenSource.heatStateRevision || 0) + 1;
      }
      if (step % 13 === 0) {
        addDrone(room, "soak-transient-drone", "green", 1800, -600);
      }
      if (step % 13 === 6) room.drones.delete("soak-transient-drone");
      room.bullets[0].x = 700 + Math.sin(step * 0.15) * 900;
      room.bullets[0].y = Math.cos(step * 0.09) * 500;
      room.spatialIndex.updateLiveEntities("ships", room.ships.values(), (ship) => ship.radius);
      room.spatialIndex.updateLiveEntities("drones", room.drones.values(), (drone) => drone.radius);
      room.spatialIndex.updateLiveEntities("stations", room.stations, (station) => station.radius);
      invalidateFor(room, { reason: "moving-battle", geometryChanged: true, allegianceChanged: step % 17 === 0 });
    }

    const snapshots = rooms.map((room) => snapshotForStep(room, step));
    const stateByMode = rooms.map((room) => Object.fromEntries(teams.map((team) => [
      team,
      stateSignature(ensureFor(room, team, now))
    ])));
    assert.deepEqual(stateByMode[1], stateByMode[0], `long differential state parity at step ${step}`);

    const entities = [
      ...new Map([
        ...rooms[0].ships,
        ...rooms[0].drones,
        ...rooms[0].stationsById
      ]).values()
    ];
    for (const team of teams) {
      for (const entity of entities) {
        assert.equal(
          withRoomMode(rooms[1], () => canTeamSeeEntity(rooms[1], team, entity, now)),
          withRoomMode(rooms[0], () => canTeamSeeEntity(rooms[0], team, entity, now)),
          `canTeamSeeEntity parity at step ${step} for ${team}/${entity.id}`
        );
        assert.equal(
          withRoomMode(rooms[1], () => canTeamTargetEntity(rooms[1], team, entity, now)),
          withRoomMode(rooms[0], () => canTeamTargetEntity(rooms[0], team, entity, now)),
          `canTeamTargetEntity parity at step ${step} for ${team}/${entity.id}`
        );
      }
      for (const [x, y] of [[0, 0], [400, -300], [1300, 100], [5000, 3000]]) {
        assert.equal(
          withRoomMode(rooms[1], () => isPointVisibleToTeam(rooms[1], team, x, y, now)),
          withRoomMode(rooms[0], () => isPointVisibleToTeam(rooms[0], team, x, y, now)),
          `isPointVisibleToTeam parity at step ${step} for ${team} at ${x},${y}`
        );
      }
      assert.deepEqual(
        [...withRoomMode(rooms[1], () => getTeamVisibleProjectiles(rooms[1], team, now))].sort(),
        [...withRoomMode(rooms[0], () => getTeamVisibleProjectiles(rooms[0], team, now))].sort(),
        `projectile visibility parity at step ${step} for ${team}`
      );
    }

    for (const player of rooms[0].players.values()) {
      const repeatPlayer = rooms[1].players.get(player.id);
      const canonicalFiltered = filterFor(rooms[0], player, snapshots[0], now);
      const repeatFiltered = filterFor(rooms[1], repeatPlayer, snapshots[1], now);
      assert.deepEqual(snapshotSignature(repeatFiltered), snapshotSignature(canonicalFiltered), `team-filtered snapshot parity at step ${step} for ${player.id}`);
      withRoomMode(rooms[0], () => auditSnapshotForInformationLeaks(rooms[0], player, canonicalFiltered, now));
      withRoomMode(rooms[1], () => auditSnapshotForInformationLeaks(rooms[1], repeatPlayer, repeatFiltered, now));
    }
  }

  const runtime = rooms[1]._visibilityRuntime;
  assert(runtime.sourceByEntityId.size <= 8, "long soak does not grow source registry");
  assert(runtime.teamEntityIds.size <= 3, "long soak does not grow team membership maps");
  assert(runtime.teamStates.size <= 3, "long soak retains one state per active team");
  for (const state of runtime.teamStates.values()) {
    assert(state.snapshotFilterCache, "long soak leaves a bounded per-team snapshot cache");
  }
}

function main() {
  try {
    testFlagContract();
    testModesAndGeometryParity();
    testMovementCapabilityAndAuraParity();
    testLifecycleMembershipAndRelayCapture();
    testRememberedContactsAndTargeting();
    testSnapshotPrivacyAndSharedTeamResult();
    testSnapshotCacheFreshness();
    testSpatialFallbackRecoveryAndReset();
    testReconciliationAndInvalidationTelemetry();
    testProjectileVisibilityRevisionAndCursor();
    testScopedInvalidationReusesUnchangedTeam();
    testLongDifferentialAndBoundedCaches();
    console.log("verify-phase-6c-visibility-runtime: all passed");
  } finally {
  }
}

main();
