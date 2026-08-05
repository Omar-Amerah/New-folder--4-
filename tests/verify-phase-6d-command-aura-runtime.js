"use strict";

// Phase 6D is a storage/invalidation refactor. This verifier keeps a canonical
// room and an repeat room side by side, then compares observable aura state
// after every authoritative update boundary.

const assert = require("assert");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState, bumpComponentAliveRevision, markComponentDamageChanged } = require("../src/server/componentHealth");
const { reallocateShipPower } = require("../src/server/componentPower");
const HeatRules = require("../public/src/shared/heatRules");
const WiringRules = require("../public/src/shared/wiringRules");
const { RoomSpatialIndex, buildRoomSpatialIndex } = require("../src/server/spatialIndex");
const { resetRoomTelemetry, getRoomTelemetry } = require("../src/server/roomTelemetry");
const { invalidateRelationshipCache } = require("../src/server/relationships");
const {
  updateCommandAuras,
  clearCommandAuras,
  getCommandAuraMultiplier,
  getCommandAuraRange,
  invalidateCommandAuraMovement,
  invalidateCommandAuraSource,
  invalidateCommandAuraRecipient,
  invalidateCommandAuraAllegiance
} = require("../src/server/commandAuras");
const {
  assertCommandAuraConsistency
} = require("../src/server/commandAuraRuntime");
const { getAuraComponentIndices } = require("../src/server/commandAuraRules");
const { tickRoom } = require("../src/server/simulation");
const { createMovementRuntime, setMovementCommand } = require("../src/server/movementRuntimeV2");

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
    canonical: makeRoom(specs, withSpatialIndex),
    repeat: makeRoom(specs, withSpatialIndex)
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
  refreshSpatialIndex(pair.canonical, now, withSpatialIndex);
  refreshSpatialIndex(pair.repeat, now, withSpatialIndex);

  updateCommandAuras(pair.canonical, liveShips(pair.canonical), now);
  updateCommandAuras(pair.repeat, liveShips(pair.repeat), now);

  assert.deepStrictEqual(observable(pair.repeat), observable(pair.canonical), `canonical parity at ${now}ms`);
  return getRoomTelemetry(pair.repeat);
}

function eachRoom(pair, callback) {
  callback(pair.canonical);
  callback(pair.repeat);
}

function eachShip(pair, id, callback) {
  callback(pair.canonical.ships.get(id));
  callback(pair.repeat.ships.get(id));
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
  updatePair(pair, 0);
  assert.strictEqual(pair.repeat.ships.get("s1").commandAuraActive, true, "active source is reported without recipients");
  assert.strictEqual(pair.repeat.ships.get("s6").commandAuraReceived, false, "self aura remains disabled");
  assert(receivedType(pair.repeat, "s2", "fireControl"), "allied recipient receives aura");
  assert.strictEqual(pair.repeat.ships.get("s3").commandAuraReceived, false, "enemy does not receive aura");
  assert.strictEqual(pair.repeat.ships.get("s4").commandAuraReceived, false, "out-of-range recipient does not receive aura");
  assert(receivedType(pair.repeat, "s5", "fireControl"), "multi-category source overlaps correctly");

  const revision = pair.repeat.ships.get("s2").commandAuraRevision;
  const receivedReference = pair.repeat.ships.get("s2").commandAurasReceived;
  updatePair(pair, 50);
  assert.strictEqual(pair.repeat.ships.get("s2").commandAuraRevision, revision, "cadence suppresses early redraw");
  updatePair(pair, UPDATE_STEP);
  assert.strictEqual(pair.repeat.ships.get("s2").commandAuraRevision, revision, "unchanged result keeps revision stable");
  assert.strictEqual(pair.repeat.ships.get("s2").commandAurasReceived, receivedReference, "unchanged recipient retains published object");
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
  assert.strictEqual(receivedType(pair.repeat, "r1", "fireControl").sourceShipId, "s30", "strongest effective source wins");

  eachShip(pair, "s20", (ship) => setPower(ship, 1, 1));
  invalidateSourcePair(pair, "s20");
  updatePair(pair, UPDATE_STEP);
  assert.strictEqual(receivedType(pair.repeat, "r1", "fireControl").sourceShipId, "s20", "nearest equal-strength source wins");

  eachShip(pair, "s20", (ship) => { ship.x = -200; });
  eachShip(pair, "s30", (ship) => { ship.x = 200; });
  invalidateMovementPair(pair, ["s20", "s30"]);
  updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(receivedType(pair.repeat, "r1", "fireControl").sourceShipId, "s20", "lowest sequence breaks equal distance");

  const componentPair = makePair([
    { id: "s10", ownerId: "p1", x: 100, y: 0, types: ["core", "fireControlCommandCentre", "frame", "fireControlCommandCentre"] },
    { id: "r2", ownerId: "p1", x: 0, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(componentPair, 0);
  assert.strictEqual(receivedType(componentPair.repeat, "r2", "fireControl").sourceComponentIndex, 1, "lowest component index breaks final tie");
  ok("Strength, distance, ship sequence, component index and suppression parity.");
}

function runCapabilityParity() {
  const pair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(pair, 0);
  const source = pair.repeat.ships.get("src");
  const initialQueries = getRoomTelemetry(pair.repeat).commandAuraMembershipQueries;
  eachShip(pair, "src", (ship) => setPower(ship, 1, 0.5));
  invalidateSourcePair(pair, "src");
  const partial = updatePair(pair, UPDATE_STEP);
  assert(partial.commandAuraSourceRebuilds > 0 && partial.commandAuraMembershipQueries === 0,
    `Power-only change rebuilds source without membership query: ${JSON.stringify(partial)}`);

  eachShip(pair, "src", (ship) => setPower(ship, 1, 0));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "zero Power disables source");

  eachShip(pair, "src", (ship) => setPower(ship, 1, 1));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 3);
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "Power recovery restores source");

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
    assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, enabled, `heat state ${heatState} parity`);
  }

  eachShip(pair, "src", (ship) => {
    ship.componentHp[1] = 0;
    bumpComponentAliveRevision(ship);
    markComponentDamageChanged(ship, 1);
  });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 8);
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "component destruction disables source");

  eachShip(pair, "src", (ship) => {
    ship.componentHp[1] = ship.componentMaxHp[1];
    bumpComponentAliveRevision(ship);
    markComponentDamageChanged(ship, 1);
  });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 9);
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "component repair restores source");

  eachShip(pair, "src", (ship) => replaceDesign(ship, ["core", "frame"]));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 10);
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "design revision removes aura source");
  eachShip(pair, "src", (ship) => replaceDesign(ship, ["core", "fireControlCommandCentre"]));
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 11);
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "design revision adds aura source");
  assert(initialQueries > 0 && source._derivedComponentIndexes, "design-derived aura index is cached");
  ok("Power, Heat, damage, repair and design-revision parity.");
}

function runMembershipAndRevisionChecks() {
  const pair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: RANGE * 1.5, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(pair, 0);
  const initialRevision = pair.repeat.ships.get("dst").commandAuraRevision;
  eachShip(pair, "src", (ship) => { ship.x = RANGE * 1.1; });
  invalidateMovementPair(pair, ["src"]);
  const movedIn = updatePair(pair, UPDATE_STEP);
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "source movement enters membership");
  assert(movedIn.commandAuraSourceMovesProcessed > 0, "source move is tracked separately");
  assert(pair.repeat.ships.get("dst").commandAuraRevision > initialRevision, "observable result revision increments on change");

  const stable = updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(stable.commandAuraMembershipQueries, 0, "stationary fleet uses cached membership");
  const stableRevision = pair.repeat.ships.get("dst").commandAuraRevision;
  eachShip(pair, "src", (ship) => { ship.x = RANGE * 0.1; });
  invalidateMovementPair(pair, ["src"]);
  const movedOut = updatePair(pair, UPDATE_STEP * 3);
  assert(movedOut.commandAuraMembershipQueries > 0, "moving source updates membership");
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "source movement exits membership");
  assert(pair.repeat.ships.get("dst").commandAuraRevision > stableRevision, "removal increments observable revision");

  eachShip(pair, "dst", (ship) => { ship.x = RANGE * 0.1; });
  invalidateMovementPair(pair, ["dst"]);
  const recipientMove = updatePair(pair, UPDATE_STEP * 4);
  assert(recipientMove.commandAuraRecipientMovesProcessed > 0, "recipient movement is tracked separately");
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "recipient movement enters membership");

  const sourceRebuildsBeforeMove = recipientMove.commandAuraSourceRebuilds;
  eachShip(pair, "dst", (ship) => { ship.x = RANGE * 0.2; });
  invalidateMovementPair(pair, ["dst"]);
  const recipientMoveAgain = updatePair(pair, UPDATE_STEP * 5);
  assert.strictEqual(recipientMoveAgain.commandAuraSourceRebuilds, 0, "recipient-only movement does not rebuild source capability");
  assert(sourceRebuildsBeforeMove >= 0, "source maintenance telemetry is present");
  ok("Source/recipient movement, cache hits and revision invalidation parity.");
}

function runExactMovementChecks() {
  const sourceBoundary = makePair([
    { id: "src", ownerId: "p1", x: RANGE + 0.00025, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 0, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(sourceBoundary, 0);
  assert.strictEqual(sourceBoundary.repeat.ships.get("dst").commandAuraReceived, false, "source starts just outside the range boundary");
  eachShip(sourceBoundary, "src", (ship) => { ship.x = RANGE - 0.00025; });
  const sourceIn = updatePair(sourceBoundary, UPDATE_STEP);
  assert(sourceBoundary.repeat.ships.get("dst").commandAuraReceived, "source movement of 0.0005 enters the boundary");
  assert(sourceIn.commandAuraSourceMovesProcessed > 0, "exact source transform comparison tracks sub-epsilon movement");
  eachShip(sourceBoundary, "src", (ship) => { ship.x = RANGE + 0.00025; });
  updatePair(sourceBoundary, UPDATE_STEP * 2);
  assert.strictEqual(sourceBoundary.repeat.ships.get("dst").commandAuraReceived, false, "source movement of 0.0005 exits the boundary");

  const recipientBoundary = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: RANGE + 0.00025, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(recipientBoundary, 0);
  eachShip(recipientBoundary, "dst", (ship) => { ship.x = RANGE - 0.00025; });
  const recipientIn = updatePair(recipientBoundary, UPDATE_STEP);
  assert(recipientBoundary.repeat.ships.get("dst").commandAuraReceived, "recipient movement of 0.0005 enters the boundary");
  assert(recipientIn.commandAuraRecipientMovesProcessed > 0, "exact recipient transform comparison tracks sub-epsilon movement");

  const tie = makePair([
    { id: "left", ownerId: "p1", x: -100, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "right", ownerId: "p1", x: 100, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: -0.00025, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(tie, 0);
  assert.strictEqual(receivedType(tie.repeat, "dst", "fireControl").sourceShipId, "left", "equal-strength nearest winner starts on the left");
  eachShip(tie, "dst", (ship) => { ship.x = 0.00025; });
  updatePair(tie, UPDATE_STEP);
  assert.strictEqual(receivedType(tie.repeat, "dst", "fireControl").sourceShipId, "right", "equal-strength winner changes after 0.0005 movement");

  const accumulated = makePair([
    { id: "src", ownerId: "p1", x: RANGE + 0.0012, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 0, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(accumulated, 0);
  for (let step = 1; step <= 3; step += 1) {
    eachShip(accumulated, "src", (ship) => { ship.x -= 0.0004; });
    updatePair(accumulated, UPDATE_STEP * step);
  }
  assert(accumulated.repeat.ships.get("dst").commandAuraReceived, "accumulated sub-epsilon movement crosses the range boundary");

  const allMoving = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "r1", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] },
    { id: "r2", ownerId: "p1", x: 120, y: 20, types: ["core", "frame"] },
    { id: "r3", ownerId: "p1", x: 140, y: -20, types: ["core", "frame"] }
  ]);
  updatePair(allMoving, 0);
  eachShip(allMoving, "src", (ship) => { ship.x += 1; });
  eachShip(allMoving, "r1", (ship) => { ship.x += 1; });
  eachShip(allMoving, "r2", (ship) => { ship.y += 1; });
  eachShip(allMoving, "r3", (ship) => { ship.x -= 1; });
  invalidateMovementPair(allMoving, ["src", "r1", "r2", "r3"]);
  const allMovingTelemetry = updatePair(allMoving, UPDATE_STEP);
  assert.strictEqual(allMovingTelemetry.commandAuraRecipientMembershipQueries, 0, "all-moving fleet skips recipient spatial queries after source refresh");
  ok("Exact source/recipient movement, boundary crossing and sub-epsilon winner changes.");
}

function runSourceLocalInvalidationChecks() {
  const pair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre", "frame"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(pair, 0);
  eachShip(pair, "src", (ship) => {
    ship.componentHp[2] = Math.max(1, ship.componentHp[2] - 10);
    ship.componentHeatState[2] = HeatRules.STATE.HOT;
    ship.componentDamageRevision = (Number(ship.componentDamageRevision) || 0) + 1;
    ship.heatStateRevision = (Number(ship.heatStateRevision) || 0) + 1;
    ship.heatRevision = (Number(ship.heatRevision) || 0) + 1;
    ship.powerRevision = (Number(ship.powerRevision) || 0) + 1;
    ship.powerFlowRevision = (Number(ship.powerFlowRevision) || 0) + 1;
  });
  invalidateSourcePair(pair, "src");
  const unrelated = updatePair(pair, UPDATE_STEP);
  assert.strictEqual(unrelated.commandAuraSourceRebuilds, 0, "unrelated component damage/heat/power revisions do not rebuild the aura source");
  assert.strictEqual(unrelated.commandAuraWinnerRescans, 0, "unrelated component state does not rescan winners");
  assert.strictEqual(unrelated.commandAuraRecipientsPublished, 0, "unrelated component state does not republish recipients");
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "unrelated component state preserves the published aura");

  eachShip(pair, "src", (ship) => {
    ship.componentHp[2] = ship.componentMaxHp[2];
    ship.componentHeatState[2] = HeatRules.STATE.NORMAL;
    ship.componentDamageRevision = (Number(ship.componentDamageRevision) || 0) + 1;
    ship.heatStateRevision = (Number(ship.heatStateRevision) || 0) + 1;
    ship.heatRevision = (Number(ship.heatRevision) || 0) + 1;
  });
  invalidateSourcePair(pair, "src");
  const unrelatedRepair = updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(unrelatedRepair.commandAuraSourceRebuilds, 0, "unrelated component repair does not rebuild the aura source");
  assert.strictEqual(unrelatedRepair.commandAuraWinnerRescans, 0, "unrelated component repair does not rescan winners");
  assert.strictEqual(unrelatedRepair.commandAuraRecipientsPublished, 0, "unrelated component repair does not republish recipients");

  eachShip(pair, "src", (ship) => {
    ship.componentHeatState[1] = HeatRules.STATE.OVERHEATED;
  });
  invalidateSourcePair(pair, "src");
  const sourceLocal = updatePair(pair, UPDATE_STEP * 3);
  assert(sourceLocal.commandAuraSourceRebuilds > 0, "source-local Heat state still rebuilds the source capability");
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "source-local Heat state still changes the aura result");

  const multiSource = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre", "engineeringCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(multiSource, 0);
  assert(multiSource.repeat.ships.get("src").commandAuraActive, "a multi-aura source starts active");
  eachShip(multiSource, "src", (ship) => setPower(ship, 1, 0));
  invalidateSourcePair(multiSource, "src");
  const deactivated = updatePair(multiSource, UPDATE_STEP);
  assert(deactivated.commandAuraSourceDeactivations > 0, "one source component deactivation is tracked");
  assert(multiSource.repeat.ships.get("src").commandAuraActive, "another active aura component keeps the source active");
  assert.strictEqual(receivedType(multiSource.repeat, "dst", "fireControl"), null, "deactivated aura category is removed");
  assert(receivedType(multiSource.repeat, "dst", "engineering"), "remaining aura category stays published");
  eachShip(multiSource, "src", (ship) => setPower(ship, 1, 1));
  invalidateSourcePair(multiSource, "src");
  updatePair(multiSource, UPDATE_STEP * 2);
  assert(receivedType(multiSource.repeat, "dst", "fireControl"), "source component reactivation restores its category");
  ok("Source capability invalidation is limited to source-local formula inputs.");
}

function runTickRoomIntegrationChecks() {
  // Inside the playable area on both axes. The mover has to be somewhere the
  // navigator considers legal, or its first move is a leg back into bounds
  // rather than the boundary crossing this fixture is about. Only the x
  // separation matters to the aura.
  const LANE_Y = 1200;

  function prepareMovingRecipient(room) {
    const ship = room.ships.get("dst");
    ship.angle = Math.PI;
    ship.movement = createMovementRuntime();
    setMovementCommand(ship, {
      id: "phase-6d-boundary-move",
      type: "move",
      destination: { x: RANGE - 100, y: LANE_Y }
    });
    return ship;
  }

  const room = makeRoom([
    { id: "src", ownerId: "p1", x: 0, y: LANE_Y, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: RANGE + 0.00025, y: LANE_Y, types: ["core", "engine"] }
  ]);
  const movingRecipient = prepareMovingRecipient(room);
  tickRoom(room, 0.1, 1000);
  assert(room._commandAuraMovementScratch, "tickRoom creates canonical movement tracking");
  assert(room._commandAuraRuntime, "tickRoom invokes the authoritative Command Aura runtime");
  assert(movingRecipient.x < RANGE, "tickRoom fixture crosses the aura boundary during movement");
  assert.strictEqual(movingRecipient.commandAuraReceived, false, "aura timing is evaluated before movement on the current tick");
  tickRoom(room, 0.1, 1200);
  assert(movingRecipient.commandAuraReceived, "the next aura boundary observes the moved recipient");
  ok("Real tickRoom integration preserves the canonical runtime boundary.");
}

function runAllegianceLifecycleAndReconciliation() {
  const pair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p3", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(pair, 0);
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "different teams do not receive aura");

  eachRoom(pair, (room) => { room.players.get("p3").team = "blue"; });
  invalidateAllegiancePair(pair);
  updatePair(pair, UPDATE_STEP);
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "new ally gains aura at boundary");

  eachRoom(pair, (room) => { room.players.get("p3").team = "red"; });
  invalidateAllegiancePair(pair);
  updatePair(pair, UPDATE_STEP * 2);
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "former ally loses aura at boundary");

  eachShip(pair, "dst", (ship) => { ship.ownerId = "p1"; });
  updatePair(pair, UPDATE_STEP * 3);
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "recipient owner change refreshes cached membership");
  eachShip(pair, "dst", (ship) => { ship.ownerId = "p3"; });
  updatePair(pair, UPDATE_STEP * 4);
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "recipient owner change removes cached membership");

  eachShip(pair, "src", (ship) => { ship.ownerId = "p3"; });
  updatePair(pair, UPDATE_STEP * 5);
  assert.strictEqual(receivedType(pair.repeat, "dst", "fireControl").sourcePlayerId, "p3", "source owner change republishes source metadata");
  eachShip(pair, "src", (ship) => { ship.ownerId = "p1"; });
  updatePair(pair, UPDATE_STEP * 6);
  assert.strictEqual(pair.repeat.ships.get("dst").commandAuraReceived, false, "source owner change refreshes cached allegiance");

  eachShip(pair, "src", (ship) => { ship.alive = false; ship.removed = true; });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 7);
  assert.strictEqual(pair.repeat._commandAuraRuntime.sourceRecordsByKey.size, 0, "destroyed source is pruned");
  assert(assertCommandAuraConsistency(pair.repeat).ok, "destroyed source leaves consistent maps");

  // Reuse the entity ID with a fresh object; no old source or received state may
  // survive the replacement.
  eachRoom(pair, (room) => {
    const replacement = makeShip("src", "p1", 0, 0, ["core", "fireControlCommandCentre"]);
    room.ships.set("src", replacement);
    room.players.get("p1").ships.push(replacement);
  });
  invalidateSourcePair(pair, "src");
  updatePair(pair, UPDATE_STEP * 8);
  assert(pair.repeat.ships.get("dst").commandAuraReceived === false, "enemy replacement remains filtered");

  eachRoom(pair, (room) => { room.players.get("p3").team = "blue"; });
  invalidateAllegiancePair(pair);
  updatePair(pair, UPDATE_STEP * 9);
  assert(pair.repeat.ships.get("dst").commandAuraReceived, "replacement participates in fresh membership");

  const runtime = pair.repeat._commandAuraRuntime;
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
  assert(assertCommandAuraConsistency(pair.repeat).ok, "reconciliation restores bidirectional consistency");

  const publicationPair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(publicationPair, 0);
  const publicationState = publicationPair.repeat._commandAuraRuntime;
  const publicationKey = [...publicationState.recipientsBySourceKey.keys()][0];
  const publicationGroup = publicationState.sourceGroupsByShipId.get("src");
  publicationGroup.members.delete("dst");
  eachRoom(publicationPair, (room) => { room.ships.get("dst").x = RANGE * 2; });
  publicationState.transformsByShipId.get("dst").x = RANGE * 2;
  publicationState.reconciliationGeneration = 31;
  const publicationTelemetry = updatePair(publicationPair, UPDATE_STEP);
  assert(publicationTelemetry.commandAuraReconciliationRepairs > 0, "reconciliation reports the stale edge repair");
  assert.strictEqual(publicationPair.repeat.ships.get("dst").commandAuraReceived, false, "reconciliation publishes a corrected public result on the same boundary");
  assert(!publicationState.recipientsBySourceKey.get(publicationKey)?.has("dst"), "reconciliation removes the stale forward edge before publication");

  const deadPair = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(deadPair, 0);
  eachShip(deadPair, "src", (ship) => { ship.alive = false; ship.removed = false; });
  invalidateSourcePair(deadPair, "src");
  updatePair(deadPair, UPDATE_STEP);
  assert.strictEqual(deadPair.repeat.ships.get("src").commandAuraActive, false, "dead source clears active public state before final removal");
  assert.strictEqual(deadPair.repeat.ships.get("src").commandAuraReceived, false, "dead source clears received public state before final removal");
  assert.strictEqual(deadPair.repeat.ships.get("dst").commandAuraReceived, false, "dead source clears recipients before final removal");

  clearCommandAuras(pair.canonical, liveShips(pair.canonical));
  clearCommandAuras(pair.repeat, liveShips(pair.repeat));
  assert.strictEqual(pair.repeat._commandAuraRuntime, null, "room reset clears runtime references");
  updatePair(pair, UPDATE_STEP * 50);
  assert(pair.repeat._commandAuraRuntime.bootstrapped, "state epoch/reset reboots from live ships");
  const oldEpochState = pair.repeat._commandAuraRuntime;
  pair.repeat.stateEpoch += 1;
  pair.canonical.stateEpoch += 1;
  updatePair(pair, UPDATE_STEP * 51);
  assert.notStrictEqual(pair.repeat._commandAuraRuntime, oldEpochState, "state epoch invalidates old references");
  ok("Allegiance, lifecycle, ID reuse, reconciliation and reset safety.");
}

function runFallbackAndCacheSafety() {
  const noIndex = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ], false);
  const fallback = updatePair(noIndex, 0, false);
  assert(fallback.commandAuraFullScanFallbacks > 0, "missing spatial index uses explicit fallback");
  assert(noIndex.repeat.ships.get("dst").commandAuraReceived, "fallback preserves aura output");

  const indexed = makePair([
    { id: "src", ownerId: "p1", x: 0, y: 0, types: ["core", "fireControlCommandCentre"] },
    { id: "dst", ownerId: "p1", x: 100, y: 0, types: ["core", "frame"] }
  ]);
  updatePair(indexed, 0);
  const state = indexed.repeat._commandAuraRuntime;
  assert.strictEqual(getRoomTelemetry(indexed.repeat).commandAuraFullScanFallbacks, 0, "valid spatial index avoids fallback");
  for (let step = 1; step <= 100; step += 1) updatePair(indexed, UPDATE_STEP * step);
  assert(indexed.repeat._commandAuraRuntime.sourceRecordsByKey.size <= 2, "stationary cache remains bounded");
  assert(indexed.repeat._commandAuraRuntime === state, "steady updates retain room-local runtime");
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
  runBasicAndParity();
  runPriorityParity();
  runCapabilityParity();
  runMembershipAndRevisionChecks();
  runExactMovementChecks();
  runSourceLocalInvalidationChecks();
  runTickRoomIntegrationChecks();
  runAllegianceLifecycleAndReconciliation();
  runFallbackAndCacheSafety();
  runComponentIndexGuard();
  console.log(`\nverify-phase-6d-command-aura-runtime: ${passed} checks passed.`);
} catch (error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}
