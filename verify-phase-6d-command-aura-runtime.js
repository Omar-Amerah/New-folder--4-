"use strict";

// Phase 6D is a storage/invalidation refactor. This verifier keeps a legacy
// room and an optimized room side by side, then compares observable aura state
// after every authoritative update boundary.

const assert = require("assert");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, bumpComponentAliveRevision, markComponentDamageChanged } = require("./src/server/componentHealth");
const { reallocateShipPower } = require("./src/server/componentPower");
const HeatRules = require("./public/src/shared/heatRules");
const WiringRules = require("./public/src/shared/wiringRules");
const { RoomSpatialIndex, buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { resetRoomTelemetry, getRoomTelemetry } = require("./src/server/roomTelemetry");
const { invalidateRelationshipCache } = require("./src/server/relationships");
const {
  updateCommandAuras,
  clearCommandAuras,
  getCommandAuraMultiplier,
  getCommandAuraRange,
  invalidateCommandAuraMovement,
  invalidateCommandAuraSource,
  invalidateCommandAuraRecipient,
  invalidateCommandAuraAllegiance
} = require("./src/server/commandAuras");
const {
  OPTIMIZED_COMMAND_AURA_RUNTIME,
  __setOPTIMIZED_COMMAND_AURA_RUNTIME
} = require("./src/server/performanceFlags");
const {
  assertCommandAuraConsistency
} = require("./src/server/commandAuraRuntime");
const { getAuraComponentIndices } = require("./src/server/commandAuraRules");

const RANGE = getCommandAuraRange();
const UPDATE_STEP = 200;
let passed = 0;

function ok(message) {
  passed += 1;
  console.log(`  ${message}`);
}

function designFor(types) {
  return types.map((type, index) => ({
    x: type === "core" ? 7 : 8,
    y: type === "reactor" ? 6 : 7,
    type,
    rotation: 0
  }));
}

function makeShip(id, ownerId, x, y, types) {
  const design = designFor(types.includes("reactor") ? types : [...types, "reactor"]);
  let wiring;
  try {
    wiring = WiringRules.createGeneratedPowerWiring(design, PARTS);
  } catch (_) {
    // These fixtures intentionally overlap several aura footprints to exercise
    // same-position priority ties; the runtime fixture does not test wiring
    // validity, so use the existing unconnected-test fallback.
    wiring = { power: [], data: [] };
  }
  const stats = computeStats(design, wiring);
  const ship = {
    id,
    ownerId,
    x,
    y,
    angle: 0,
    vx: 0,
    vy: 0,
    radius: Math.max(20, Number(stats.radius) || 20),
    physicalRadius: Math.max(20, Number(stats.radius) || 20),
    design,
    designRevision: 1,
    wiring,
    stats,
    alive: true,
    removed: false,
    hp: stats.maxHp || 500,
    maxHp: stats.maxHp || 500,
    shield: 0,
    maxShield: 0,
    commandState: "mainCore",
    commandAurasReceived: {},
    commandAuraMultipliers: {},
    commandAuraRevision: 0,
    commandAuraActive: false,
    commandAuraReceived: false
  };
  ship.componentHeatState = design.map(() => HeatRules.STATE.NORMAL);
  ship.heatStateRevision = 1;
  ship.heatRevision = 1;
  initComponentState(ship);
  reallocateShipPower(ship, "phase-6d-fixture");
  ship.weaponAngles = design.map(() => 0);
  ship.weaponCooldowns = design.map(() => 0);
  return ship;
}

function ownerTeam(ownerId) {
  return ownerId === "p1" || ownerId === "p4" ? "blue" : "red";
}

function makeRoom(specs, withSpatialIndex = true) {
  const players = new Map();
  const ships = new Map();
  for (const spec of specs) {
    if (!players.has(spec.ownerId)) {
      players.set(spec.ownerId, {
        id: spec.ownerId,
        team: ownerTeam(spec.ownerId),
        removed: false,
        ships: []
      });
    }
  }
  for (const spec of specs) {
    const ship = makeShip(spec.id, spec.ownerId, spec.x, spec.y, spec.types);
    ships.set(ship.id, ship);
    players.get(ship.ownerId).ships.push(ship);
  }
  const room = {
    code: "phase-6d",
    phase: "active",
    stateEpoch: 1,
    relationshipRevision: 1,
    rules: { gameMode: "teams" },
    players,
    ships,
    stations: [],
    drones: new Map(),
    bullets: [],
    points: [],
    effects: [],
    map: { asteroids: [] },
    world: { width: 10000, height: 10000 },
    spatialCellSize: 320
  };
  if (withSpatialIndex) room.spatialIndex = new RoomSpatialIndex(320);
  resetRoomTelemetry(room);
  refreshSpatialIndex(room, 0, withSpatialIndex);
  return room;
}

function liveShips(room) {
  return [...room.ships.values()].filter((ship) => ship.alive && !ship.removed);
}

function refreshSpatialIndex(room, now, enabled = true) {
  if (!enabled) {
    room.spatialIndex = null;
    return;
  }
  if (!(room.spatialIndex instanceof RoomSpatialIndex)) room.spatialIndex = new RoomSpatialIndex(320);
  buildRoomSpatialIndex(room, liveShips(room), now);
}

function makePair(specs, withSpatialIndex = true) {
  return {
    legacy: makeRoom(specs, withSpatialIndex),
    optimized: makeRoom(specs, withSpatialIndex)
  };
}

function observable(room) {
  return [...room.ships.values()]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((ship) => ({
      id: ship.id,
      commandAuraActive: Boolean(ship.commandAuraActive),
      commandAuraReceived: Boolean(ship.commandAuraReceived),
      commandAuraMultipliers: ship.commandAuraMultipliers || {},
      commandAurasReceived: ship.commandAurasReceived || {}
    }));
}

function updatePair(pair, now, withSpatialIndex = true) {
  refreshSpatialIndex(pair.legacy, now, withSpatialIndex);
  refreshSpatialIndex(pair.optimized, now, withSpatialIndex);

  __setOPTIMIZED_COMMAND_AURA_RUNTIME(false);
  updateCommandAuras(pair.legacy, liveShips(pair.legacy), now);
  __setOPTIMIZED_COMMAND_AURA_RUNTIME(true);
  updateCommandAuras(pair.optimized, liveShips(pair.optimized), now);

  assert.deepStrictEqual(observable(pair.optimized), observable(pair.legacy), `legacy parity at ${now}ms`);
  return getRoomTelemetry(pair.optimized);
}

function eachRoom(pair, callback) {
  callback(pair.legacy);
  callback(pair.optimized);
}

function eachShip(pair, id, callback) {
  callback(pair.legacy.ships.get(id));
  callback(pair.optimized.ships.get(id));
}

function invalidateMovementPair(pair, ids) {
  eachRoom(pair, (room) => invalidateCommandAuraMovement(room, ids));
}

function invalidateSourcePair(pair, id) {
  eachRoom(pair, (room) => invalidateCommandAuraSource(room, room.ships.get(id), "phase-6d-test"));
}

function invalidateAllegiancePair(pair) {
  eachRoom(pair, (room) => {
    invalidateRelationshipCache(room);
    invalidateCommandAuraAllegiance(room);
  });
}

function setPower(ship, componentIndex, operationalMultiplier) {
  const entry = ship.componentPower?.byComponentIndex?.[componentIndex];
  assert(entry, `missing power entry ${ship.id}:${componentIndex}`);
  entry.operationalMultiplier = operationalMultiplier;
  entry.state = operationalMultiplier > 0 ? "powered" : "offline";
  ship.powerRevision = (Number(ship.powerRevision) || 0) + 1;
}

function setHeat(ship, componentIndex, state) {
  ship.componentHeatState[componentIndex] = state;
  ship.heatStateRevision = (Number(ship.heatStateRevision) || 0) + 1;
  ship.heatRevision = (Number(ship.heatRevision) || 0) + 1;
}

function replaceDesign(ship, types) {
  ship.design = designFor(types.includes("reactor") ? types : [...types, "reactor"]);
  try {
    ship.wiring = WiringRules.createGeneratedPowerWiring(ship.design, PARTS);
  } catch (_) {
    ship.wiring = { power: [], data: [] };
  }
  ship.stats = computeStats(ship.design, ship.wiring);
  ship.designRevision = (Number(ship.designRevision) || 1) + 1;
  initComponentState(ship);
  ship.componentHeatState = ship.design.map(() => HeatRules.STATE.NORMAL);
  ship.heatStateRevision = (Number(ship.heatStateRevision) || 0) + 1;
  ship.heatRevision = (Number(ship.heatRevision) || 0) + 1;
  reallocateShipPower(ship, "phase-6d-design-revision");
}

function receivedType(room, shipId, type) {
  return room.ships.get(shipId)?.commandAurasReceived?.[type] || null;
}

function runBasicAndParity() {
  const specs = [
    { id: "s1", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "s2", ownerId: "p1", x: RANGE * 0.4, y: 0, types: ["core", "frame"] },
    { id: "s3", ownerId: "p2", x: RANGE * 0.2, y: 0, types: ["core", "frame"] },
    { id: "s4", ownerId: "p1", x: RANGE * 1.5, y: 0, types: ["core", "frame"] },
    { id: "s5", ownerId: "p1", x: 80, y: 30, types: [
      "core", "shieldCommandRelay", "engineeringCommandCentre", "propulsionCommandRelay", "electronicWarfareCommandCentre"
    ] },
    { id: "s6", ownerId: "p1", x: 3000, y: 0, types: ["core", "fireControlCommandCentre"] }
  ];
  const pair = makePair(specs);
  const first = updatePair(pair, 0);
  assert.strictEqual(pair.optimized.ships.get("s1").commandAuraActive, true, "active source is reported without recipients");
  assert.strictEqual(pair.optimized.ships.get("s6").commandAuraReceived, false, "self aura remains disabled");
  assert(receivedType(pair.optimized, "s2", "fireControl"), "allied recipient receives aura");
  assert.strictEqual(pair.optimized.ships.get("s3").commandAuraReceived, false, "enemy does not receive aura");
  assert.strictEqual(pair.optimized.ships.get("s4").commandAuraReceived, false, "out-of-range recipient does not receive aura");
  assert(receivedType(pair.optimized, "s5", "fireControl"), "multi-category source overlaps correctly");
  assert(first.commandAuraSortsPerformed === 0, "optimized update performs no candidate sorts");

  const revision = pair.optimized.ships.get("s2").commandAuraRevision;
  const receivedReference = pair.optimized.ships.get("s2").commandAurasReceived;
  updatePair(pair, 50);
  assert.strictEqual(pair.optimized.ships.get("s2").commandAuraRevision, revision, "cadence suppresses early redraw");
  updatePair(pair, UPDATE_STEP);
  assert.strictEqual(pair.optimized.ships.get("s2").commandAuraRevision, revision, "unchanged result keeps revision stable");
  assert.strictEqual(pair.optimized.ships.get("s2").commandAurasReceived, receivedReference, "unchanged recipient retains published object");
  ok("Basic range, self, alliance, multi-category and cadence parity.");
}

function runPriorityParity() {
  const pair = makePair([
    { id: "s30", ownerId: "p1", x: 300, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "s20", ownerId: "p1", x: 100, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "r1", ownerId: "p1", x: 0, y: 0, types: ["core", "frame"] }
  ]);
  eachShip(pair, "s20", (ship) => setPower(ship, 1, 0.5));
  updatePair(pair, 0);
  assert.strictEqual(receivedType(pair.optimized, "r1", "fireControl").sourceShipId, "s30", "strongest effective source wins");

  eachShip(pair, "s20", (ship) => setPower(ship, 1, 1));
  invalidateSourcePair(pair, "s20");
  updatePair(pair, UPDATE_STEP);
  assert.strictEqual(receivedType(pair.optimized, "r1", "fireControl").sourceShipId, "s20", "nearest equal-strength source wins");

  eachShip(pair, "s20", (ship) => { ship.x = -200; });
  eachShip(pair, "s30", (ship) => { ship.x = 200; });
  invalidateMovementPair(pair, ["s20", "s30"]);
  updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(receivedType(pair.optimized, "r1", "fireControl").sourceShipId, "s20", "lowest sequence breaks equal distance");

  const componentPair = makePair([
    { id: "s10", ownerId: "p1", x: 100, y: 0, types: ["core", "fireControlCommandCentre", "frame", "fireControlCommandCentre"] },
    { id: "r2", ownerId: "p1", x: 0, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(componentPair, 0);
  assert.strictEqual(receivedType(componentPair.optimized, "r2", "fireControl").sourceComponentIndex, 1, "lowest component index breaks final tie");
  ok("Strength, distance, ship sequence, component index and suppression parity.");
}

function runCapabilityParity() {
  const pair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(pair, 0);
  const source = pair.optimized.ships.get("src");
  const initialQueries = getRoomTelemetry(pair.optimized).commandAuraMembershipQueries;
  eachShip(pair, "src", (ship) => setPower(ship, 1, 0.5));
  invalidateSourcePair(pair, "src");
  const partial = updatePair(pair, UPDATE_STEP);
  assert(partial.commandAuraSourceRebuilds > 0 && partial.commandAuraMembershipQueries === 0,
    `Power-only change rebuilds source without membership query: ${JSON.stringify(partial)}`);

  eachShip(pair, "src", (ship) => setPower(ship, 1, 0));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "zero Power disables source");

  eachShip(pair, "src", (ship) => setPower(ship, 1, 1));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 3);
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "Power recovery restores source");

  for (const [step, heatState] of [
    [4, HeatRules.STATE.HOT],
    [5, HeatRules.STATE.CRITICAL],
    [6, HeatRules.STATE.OVERHEATED],
    [7, HeatRules.STATE.NORMAL]
  ]) {
    eachShip(pair, "src", (ship) => setHeat(ship, 1, heatState));
    invalidateSourcePair(pair, "src");
    updatePair(pair, UPDATE_STEP * step);
    const enabled = heatState !== HeatRules.STATE.OVERHEATED;
    assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, enabled, `heat state ${heatState} parity`);
  }

  eachShip(pair, "src", (ship) => {
    ship.componentHp[1] = 0;
    bumpComponentAliveRevision(ship);
    markComponentDamageChanged(ship, 1);
  });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 8);
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "component destruction disables source");

  eachShip(pair, "src", (ship) => {
    ship.componentHp[1] = ship.componentMaxHp[1];
    bumpComponentAliveRevision(ship);
    markComponentDamageChanged(ship, 1);
  });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 9);
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "component repair restores source");

  eachShip(pair, "src", (ship) => replaceDesign(ship, ["core", "frame"]));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 10);
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "design revision removes aura source");
  eachShip(pair, "src", (ship) => replaceDesign(ship, ["core", "fireControlCommandCentre"]));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 11);
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "design revision adds aura source");
  assert(initialQueries > 0 && source._derivedComponentIndexes, "design-derived aura index is cached");
  ok("Power, Heat, damage, repair and design-revision parity.");
}

function runMembershipAndRevisionChecks() {
  const pair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: RANGE * 1.5, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(pair, 0);
  const initialRevision = pair.optimized.ships.get("dst").commandAuraRevision;
  eachShip(pair, "src", (ship) => { ship.x = RANGE * 1.1; });
  invalidateMovementPair(pair, ["src"]);
  const movedIn = updatePair(pair, UPDATE_STEP);
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "source movement enters membership");
  assert(movedIn.commandAuraSourceMovesProcessed > 0, "source move is tracked separately");
  assert(pair.optimized.ships.get("dst").commandAuraRevision > initialRevision, "observable result revision increments on change");

  const stable = updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(stable.commandAuraMembershipQueries, 0, "stationary fleet uses cached membership");
  const stableRevision = pair.optimized.ships.get("dst").commandAuraRevision;
  eachShip(pair, "src", (ship) => { ship.x = RANGE * 0.1; });
  invalidateMovementPair(pair, ["src"]);
  const movedOut = updatePair(pair, UPDATE_STEP * 3);
  assert(movedOut.commandAuraMembershipQueries > 0, "moving source updates membership");
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "source movement exits membership");
  assert(pair.optimized.ships.get("dst").commandAuraRevision > stableRevision, "removal increments observable revision");

  eachShip(pair, "dst", (ship) => { ship.x = RANGE * 0.1; });
  invalidateMovementPair(pair, ["dst"]);
  const recipientMove = updatePair(pair, UPDATE_STEP * 4);
  assert(recipientMove.commandAuraRecipientMovesProcessed > 0, "recipient movement is tracked separately");
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "recipient movement enters membership");

  const sourceRebuildsBeforeMove = recipientMove.commandAuraSourceRebuilds;
  eachShip(pair, "dst", (ship) => { ship.x = RANGE * 0.2; });
  invalidateMovementPair(pair, ["dst"]);
  const recipientMoveAgain = updatePair(pair, UPDATE_STEP * 5);
  assert.strictEqual(recipientMoveAgain.commandAuraSourceRebuilds, 0, "recipient-only movement does not rebuild source capability");
  assert(sourceRebuildsBeforeMove >= 0, "source maintenance telemetry is present");
  ok("Source/recipient movement, cache hits and revision invalidation parity.");
}

function runAllegianceLifecycleAndReconciliation() {
  const pair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p3", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(pair, 0);
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "different teams do not receive aura");

  eachRoom(pair, (room) => { room.players.get("p3").team = "blue"; });
  invalidateAllegiancePair(pair);
  updatePair(pair, UPDATE_STEP);
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "new ally gains aura at boundary");

  eachRoom(pair, (room) => { room.players.get("p3").team = "red"; });
  invalidateAllegiancePair(pair);
  updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "former ally loses aura at boundary");

  eachShip(pair, "dst", (ship) => { ship.ownerId = "p1"; });
  updatePair(pair, UPDATE_STEP * 3);
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "recipient owner change refreshes cached membership");
  eachShip(pair, "dst", (ship) => { ship.ownerId = "p3"; });
  updatePair(pair, UPDATE_STEP * 4);
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "recipient owner change removes cached membership");

  eachShip(pair, "src", (ship) => { ship.ownerId = "p3"; });
  updatePair(pair, UPDATE_STEP * 5);
  assert.strictEqual(receivedType(pair.optimized, "dst", "fireControl").sourcePlayerId, "p3", "source owner change republishes source metadata");
  eachShip(pair, "src", (ship) => { ship.ownerId = "p1"; });
  updatePair(pair, UPDATE_STEP * 6);
  assert.strictEqual(pair.optimized.ships.get("dst").commandAuraReceived, false, "source owner change refreshes cached allegiance");

  eachShip(pair, "src", (ship) => { ship.alive = false; ship.removed = true; });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 7);
  assert.strictEqual(pair.optimized._commandAuraRuntime.sourceRecordsByKey.size, 0, "destroyed source is pruned");
  assert(assertCommandAuraConsistency(pair.optimized).ok, "destroyed source leaves consistent maps");

  // Reuse the entity ID with a fresh object; no old source or received state may
  // survive the replacement.
  eachRoom(pair, (room) => {
    const replacement = makeShip("src", "p1", 0, 0, ["core", "fireControlCommandCentre"]);
    room.ships.set("src", replacement);
    room.players.get("p1").ships.push(replacement);
  });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 8);
  assert(pair.optimized.ships.get("dst").commandAuraReceived === false, "enemy replacement remains filtered");

  eachRoom(pair, (room) => { room.players.get("p3").team = "blue"; });
  invalidateAllegiancePair(pair);
  updatePair(pair, UPDATE_STEP * 9);
  assert(pair.optimized.ships.get("dst").commandAuraReceived, "replacement participates in fresh membership");

  const runtime = pair.optimized._commandAuraRuntime;
  const sourceKey = [...runtime.recipientsBySourceKey.keys()][0];
  const reverse = runtime.sourcesByRecipientId.get("dst");
  reverse.delete(sourceKey);
  let repaired = false;
  for (let step = 10; step < 45; step += 1) {
    const telemetry = updatePair(pair, UPDATE_STEP * step);
    if (telemetry.commandAuraReconciliations > 0) {
      repaired = telemetry.commandAuraReconciliationRepairs > 0;
      break;
    }
  }
  assert(repaired, "bounded reconciliation repairs a missed reverse edge");
  assert(assertCommandAuraConsistency(pair.optimized).ok, "reconciliation restores bidirectional consistency");

  clearCommandAuras(pair.legacy, liveShips(pair.legacy));
  clearCommandAuras(pair.optimized, liveShips(pair.optimized));
  assert.strictEqual(pair.optimized._commandAuraRuntime, null, "room reset clears runtime references");
  updatePair(pair, UPDATE_STEP * 50);
  assert(pair.optimized._commandAuraRuntime.bootstrapped, "state epoch/reset reboots from live ships");
  const oldEpochState = pair.optimized._commandAuraRuntime;
  pair.optimized.stateEpoch += 1;
  pair.legacy.stateEpoch += 1;
  updatePair(pair, UPDATE_STEP * 51);
  assert.notStrictEqual(pair.optimized._commandAuraRuntime, oldEpochState, "state epoch invalidates old references");
  ok("Allegiance, lifecycle, ID reuse, reconciliation and reset safety.");
}

function runFallbackAndCacheSafety() {
  const noIndex = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ], false);
  const fallback = updatePair(noIndex, 0, false);
  assert(fallback.commandAuraFullScanFallbacks > 0, "missing spatial index uses explicit fallback");
  assert(noIndex.optimized.ships.get("dst").commandAuraReceived, "fallback preserves aura output");

  const indexed = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(indexed, 0);
  const state = indexed.optimized._commandAuraRuntime;
  assert.strictEqual(getRoomTelemetry(indexed.optimized).commandAuraFullScanFallbacks, 0, "valid spatial index avoids fallback");
  for (let step = 1; step <= 100; step += 1) updatePair(indexed, UPDATE_STEP * step);
  assert.strictEqual(getRoomTelemetry(indexed.optimized).commandAuraSortsPerformed, 0, "optimized path performs zero candidate sorts");
  assert(indexed.optimized._commandAuraRuntime.sourceRecordsByKey.size <= 2, "stationary cache remains bounded");
  assert(indexed.optimized._commandAuraRuntime === state, "steady updates retain room-local runtime");
  assert(OPTIMIZED_COMMAND_AURA_RUNTIME(), "test override enables optimized path");
  __setOPTIMIZED_COMMAND_AURA_RUNTIME(false);
  assert(!OPTIMIZED_COMMAND_AURA_RUNTIME(), "production default is disabled after test");
  ok("Fallback diagnostics, zero-sort safety, bounded caches and flag default.");
}

function runComponentIndexGuard() {
  const ship = makeShip("index", "p1", 0, 0, ["core", "fireControlCommandCentre", "frame"]);
  const first = getAuraComponentIndices(ship);
  const second = getAuraComponentIndices(ship);
  assert.strictEqual(first, second, "aura component index list is reused for same design revision");
  ship.designRevision += 1;
  const third = getAuraComponentIndices(ship);
  assert.notStrictEqual(third, second, "design revision rebuilds aura component index list");
  ok("Design-derived aura component indexing is revision guarded.");
}

try {
  assert.strictEqual(OPTIMIZED_COMMAND_AURA_RUNTIME(), false, "optimized Command Aura runtime defaults false");
  runBasicAndParity();
  runPriorityParity();
  runCapabilityParity();
  runMembershipAndRevisionChecks();
  runAllegianceLifecycleAndReconciliation();
  runFallbackAndCacheSafety();
  runComponentIndexGuard();
  __setOPTIMIZED_COMMAND_AURA_RUNTIME(false);
  console.log(`\nverify-phase-6d-command-aura-runtime: ${passed} checks passed.`);
} catch (error) {
  __setOPTIMIZED_COMMAND_AURA_RUNTIME(false);
  console.error(error.stack || error);
  process.exitCode = 1;
}
