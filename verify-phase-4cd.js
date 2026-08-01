#!/usr/bin/env node
"use strict";

// Browser-free Phase 4C/4D verification. The fixtures deliberately exercise
// both the direct collision API and the production movement/index lifecycle.

const assert = require("node:assert/strict");
const {
  SHARED_MOVEMENT_CONTACT_PAIRS,
  PACKED_FLEET_SOLVER,
  __setFIXED_AUTHORITATIVE_TIMESTEP,
  __setSHARED_MOVEMENT_CONTACT_PAIRS,
  __setPACKED_FLEET_SOLVER,
  __setINCREMENTAL_SPATIAL_INDEX
} = require("./src/server/performanceFlags");
const { createRoom, resetMatch } = require("./src/server/rooms");
const { tickRoom, advanceRoomAuthoritative, FIXED_STEP_MS } = require("./src/server/simulation");
const {
  RoomSpatialIndex,
  buildRoomSpatialIndex,
  shipBroadPhaseRadius
} = require("./src/server/spatialIndex");
const {
  beginMovementContactStep,
  buildMovementContactPairs,
  clearMovementContactPairs,
  collectMovementContactMovedShips,
  findMissingMovementContactPairs,
  getMovementContactPairs,
  hasMovementContactPair,
  markMovementContactPairsUnsafe,
  rebuildMovementContactPairsForRecovery,
  noteShipSpawnedDuringMovementContactStep,
  removeShipFromMovementContactPairs,
  validateMovementContactPairs
} = require("./src/server/movementContactPairs");
const { updateShipSeparation, resolveMapCollision } = require("./src/server/movementCollision");
const { resetRoomTelemetry } = require("./src/server/roomTelemetry");
const { spawnShip } = require("./src/server/ships");
const { destroyShip } = require("./src/server/combat");
const { computeStats } = require("./src/server/shipStats");
const { createStationsForRoom, enqueueStationProduction } = require("./src/server/stations");
const { canonicalBlueprintSignature, getOrCreateTemplate } = require("./src/server/shipTemplates");

const EPSILON = 1e-6;
let fixtureSequence = 0;

function activeRoom(code) {
  const room = createRoom(code, { seed: 1 });
  room.phase = "active";
  room.world = { width: 2000, height: 1600 };
  room.map = { asteroids: [], relays: [] };
  room.stations = [];
  room.drones = new Map();
  room.decoys = new Map();
  room.droneCounts = { byOwner: new Map(), byParent: new Map() };
  room.spatialIndex = null;
  room.spawnCollisionDiagnostics = {};
  return room;
}

function ship(id, overrides = {}) {
  return {
    id,
    ownerId: overrides.ownerId || "p1",
    team: overrides.team ?? 1,
    x: 500,
    y: 500,
    vx: 0,
    vy: 0,
    angle: 0,
    alive: true,
    removed: false,
    radius: 30,
    physicalRadius: 18,
    stats: { mass: 1, radius: 30, maxHp: 100 },
    design: [],
    componentHp: [],
    movement: {},
    ...overrides
  };
}

function installShips(room, ships, insertion = ships) {
  room.ships = new Map();
  for (const entity of insertion) room.ships.set(entity.id, entity);
  room.players = new Map();
  for (const entity of ships) {
    if (!room.players.has(entity.ownerId)) room.players.set(entity.ownerId, { id: entity.ownerId, ships: [] });
    room.players.get(entity.ownerId).ships.push(entity);
  }
}

function pairIds(room, stepId) {
  return getMovementContactPairs(room, stepId).map((pair) => `${pair.aId}:${pair.bId}`);
}

function buildPairs(room, ships, options = {}) {
  installShips(room, ships, options.insertion || ships);
  if (options.index) {
    room.spatialIndex = new RoomSpatialIndex(options.cellSize || 100);
    buildRoomSpatialIndex(room, ships, 0);
  }
  const stepId = beginMovementContactStep(room, ships, 1000);
  buildMovementContactPairs(room, ships, 1000, { stepId });
  return { stepId, pairs: getMovementContactPairs(room, stepId) };
}

function solverFixture(positions, overrides = {}) {
  const room = activeRoom(`SOLVE-${++fixtureSequence}`);
  // The fixture id is diagnostic only; solver state is deterministic because
  // ship ids and all physical inputs are explicit.
  const ships = positions.map((position, index) => ship(`s${index + 1}`, {
    x: position[0],
    y: position[1],
    vx: position[4] ?? overrides.vx ?? 0,
    vy: position[5] ?? overrides.vy ?? 0,
    physicalRadius: position[2] ?? overrides.physicalRadius ?? 18,
    radius: (position[2] ?? overrides.physicalRadius ?? 18) / 0.56,
    stats: { mass: position[3] ?? overrides.mass ?? 1, radius: 30, maxHp: 100 },
    movement: overrides.movement || {},
    ...overrides.shipOverrides
  }));
  const insertion = overrides.insertion === "reverse" ? ships.slice().reverse() : (overrides.insertion || ships);
  installShips(room, ships, insertion);
  const stepId = beginMovementContactStep(room, ships, 1000);
  buildMovementContactPairs(room, ships, 1000, { stepId });
  if (overrides.reversePairs) room._movementContactPairs.reverse();
  updateShipSeparation(room, ships, 1 / 30, 1000, { circular: true });
  return { room, ships, telemetry: room._roomTelemetry };
}

function snapshot(ships) {
  return ships
    .slice()
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((entity) => [entity.id, entity.x, entity.y, entity.vx, entity.vy]);
}

function finiteShips(ships) {
  return ships.every((entity) => [entity.x, entity.y, entity.vx, entity.vy].every(Number.isFinite));
}

function velocityDelta(ship, initialVx, initialVy) {
  return Math.hypot(ship.vx - initialVx, ship.vy - initialVy);
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// 1. Both new feature flags are default-off.
assert.equal(SHARED_MOVEMENT_CONTACT_PAIRS(), false, "SHARED_MOVEMENT_CONTACT_PAIRS defaults to false");
assert.equal(PACKED_FLEET_SOLVER(), false, "PACKED_FLEET_SOLVER defaults to false");

// 2-10. Canonical, duplicate-free, spatial-index-independent pair generation.
{
  __setSHARED_MOVEMENT_CONTACT_PAIRS(true);
  const room = activeRoom("PAIR-BASIC");
  const a = ship("s2", { x: 500, y: 500 });
  const b = ship("s10", { x: 520, y: 500 });
  const far = ship("s20", { x: 1500, y: 1200 });
  const built = buildPairs(room, [a, b, far], { index: true, cellSize: 32, insertion: [b, a, far] });
  assert.deepEqual(pairIds(room, built.stepId), ["s2:s10"], "nearby ships produce one canonical pair");
  assert.equal(built.pairs.every((pair) => pair.a !== pair.b), true, "self-pairs are excluded");
  assert.equal(new Set(pairIds(room, built.stepId)).size, built.pairs.length, "reversed duplicates are excluded");
  assert.equal(built.pairs[0].aId, "s2", "lower natural entity order is first");
  assert.equal(built.pairs[0].bId, "s10", "pair order uses the authoritative comparator");

  const reversedRoom = activeRoom("PAIR-REVERSED");
  const reversed = buildPairs(reversedRoom, [a, b, far], { index: false, insertion: [far, a, b] });
  assert.deepEqual(pairIds(reversedRoom, reversed.stepId), pairIds(room, built.stepId), "insertion order cannot change pair sequence");

  // A large record occupies several cells. The index query dedupes cells and
  // the pair builder's key set provides a second duplicate guard.
  const multiRoom = activeRoom("PAIR-MULTICELL");
  const large = ship("s1", { x: 400, y: 400, physicalRadius: 90, radius: 160 });
  const neighbour = ship("s2", { x: 510, y: 400 });
  const multi = buildPairs(multiRoom, [large, neighbour], { index: true, cellSize: 32 });
  assert.deepEqual(pairIds(multiRoom, multi.stepId), ["s1:s2"], "multi-cell ship yields one pair");

  const dead = ship("s3", { x: 510, y: 400, alive: false });
  const removed = ship("s4", { x: 510, y: 400, removed: true });
  const filteredRoom = activeRoom("PAIR-FILTER");
  const filtered = buildPairs(filteredRoom, [large, dead, removed], { index: false });
  assert.deepEqual(pairIds(filteredRoom, filtered.stepId), [], "dead and removed ships are excluded");

  const integrity = validateMovementContactPairs(room, [a, b, far], { stepId: built.stepId });
  assert.equal(integrity.ok, true, "pair integrity passes for an indexed build");

  const recoveryRoom = activeRoom("PAIR-RECOVERY");
  const recoveryA = ship("s1", { x: 500, y: 500 });
  const recoveryB = ship("s2", { x: 1000, y: 500 });
  const recoveryBuild = buildPairs(recoveryRoom, [recoveryA, recoveryB]);
  recoveryB.x = 510;
  const missed = validateMovementContactPairs(recoveryRoom, [recoveryA, recoveryB], { stepId: recoveryBuild.stepId });
  assert.ok(missed.missingOverlaps >= 1, "development integrity detects an overlap introduced after pair generation");
  rebuildMovementContactPairsForRecovery(recoveryRoom, [recoveryA, recoveryB], 1033);
  assert.equal(recoveryRoom._roomTelemetry.movementContactPairRecoveryBuilds, 1, "unexpected overlap uses one scoped recovery build");
}

// 11-14. Step lifecycle, room isolation, destruction and spawning.
{
  const room = activeRoom("PAIR-LIFECYCLE");
  const a = ship("s1", { x: 500, y: 500 });
  const b = ship("s2", { x: 510, y: 500 });
  const first = buildPairs(room, [a, b]);
  removeShipFromMovementContactPairs(room, b);
  assert.deepEqual(pairIds(room, first.stepId), [], "destroyed/removed pair references can be pruned immediately");
  b.alive = true;
  b.x = 520;
  const secondStep = beginMovementContactStep(room, [a, b], 1033);
  buildMovementContactPairs(room, [a, b], 1033, { stepId: secondStep });
  assert.deepEqual(pairIds(room, secondStep), ["s1:s2"], "a later step does not retain stale pair state");

  const other = activeRoom("PAIR-OTHER");
  const otherShip = ship("s1", { x: 500, y: 500 });
  const otherBuilt = buildPairs(other, [otherShip]);
  clearMovementContactPairs(room);
  assert.equal(getMovementContactPairs(room, secondStep).length, 0, "room reset clears the pair cache");
  assert.notEqual(room._movementContactPairPool, other._movementContactPairPool, "rooms do not share pair pools");
  assert.deepEqual(pairIds(other, otherBuilt.stepId), [], "a separate room has its own pair set");

  const launchRoom = activeRoom("PAIR-LAUNCH-RECOVERY");
  const launchA = ship("s1", { x: 500, y: 500 });
  installShips(launchRoom, [launchA]);
  const launchStep = beginMovementContactStep(launchRoom, [launchA], 1000);
  buildMovementContactPairs(launchRoom, [launchA], 1000, { stepId: launchStep });
  const launched = ship("s2", { x: 510, y: 500 });
  launchRoom.ships.set(launched.id, launched);
  noteShipSpawnedDuringMovementContactStep(launchRoom, launched);
  __setPACKED_FLEET_SOLVER(true);
  updateShipSeparation(launchRoom, [launchA], 1 / 30, 1000, { circular: true });
  assert.equal(launchRoom._roomTelemetry.movementContactPairRecoveryBuilds, 1, "post-build launch uses one scoped recovery build");
  assert.deepEqual(pairIds(launchRoom, launchStep), ["s1:s2"], "post-build launch is included in the recovery pair set");
}

// 15-16. One normal build per step and no solver-iteration broad phase.
{
  __setPACKED_FLEET_SOLVER(true);
  const room = activeRoom("PAIR-ONCE");
  const ships = [ship("s1", { x: 500, y: 500 }), ship("s2", { x: 510, y: 500 })];
  installShips(room, ships);
  resetRoomTelemetry(room);
  const step = beginMovementContactStep(room, ships, 1000);
  buildMovementContactPairs(room, ships, 1000, { stepId: step });
  buildMovementContactPairs(room, ships, 1000, { stepId: step });
  assert.equal(room._roomTelemetry.movementContactPairBuilds, 1, "a step has one normal pair build");
  updateShipSeparation(room, ships, 1 / 30, 1000, { circular: true });
  assert.equal(room._roomTelemetry.movementContactPairBuilds, 1, "solver iterations do not rebuild pairs");
  assert.equal(room._roomTelemetry.separationQueries, 0, "packed solver performs no routine per-ship queries");
  assert.equal(room._roomTelemetry.separationShipIndexRebuilds, 0, "packed solver performs no iteration index rebuilds");
  const next = beginMovementContactStep(room, ships, 1033);
  buildMovementContactPairs(room, ships, 1033, { stepId: next });
  assert.equal(room._roomTelemetry.movementContactPairBuilds, 2, "the next authoritative step gets a fresh build");
}

// 17-20. Shared candidates contain actual overlaps and remain duplicate-free in
// both full-rebuild and incremental-index modes.
{
  const make = (code) => {
    const room = activeRoom(code);
    const ships = [ship("s1", { x: 700, y: 700 }), ship("s2", { x: 710, y: 700 }), ship("s3", { x: 1300, y: 1300 })];
    installShips(room, ships);
    room.spatialIndex = new RoomSpatialIndex(80);
    buildRoomSpatialIndex(room, ships, 0);
    const step = beginMovementContactStep(room, ships, 1000);
    buildMovementContactPairs(room, ships, 1000, { stepId: step });
    return { room, ships, step };
  };
  __setINCREMENTAL_SPATIAL_INDEX(false);
  const full = make("PAIR-FULL");
  __setINCREMENTAL_SPATIAL_INDEX(true);
  const incremental = make("PAIR-INCREMENTAL");
  assert.deepEqual(pairIds(full.room, full.step), pairIds(incremental.room, incremental.step), "full and incremental indexes generate the same pairs");
  assert.equal(new Set(pairIds(incremental.room, incremental.step)).size, getMovementContactPairs(incremental.room, incremental.step).length, "incremental indexing creates no duplicate pairs");
  assert.equal(validateMovementContactPairs(full.room, full.ships, { stepId: full.step }).missingOverlaps, 0, "actual overlaps are in the conservative pair set");
}

// 20B. Steady and catch-up fixed-step callbacks produce the same packed state.
{
  __setFIXED_AUTHORITATIVE_TIMESTEP(true);
  __setINCREMENTAL_SPATIAL_INDEX(true);
  __setSHARED_MOVEMENT_CONTACT_PAIRS(true);
  __setPACKED_FLEET_SOLVER(true);
  const makeRoom = (code) => {
    const room = activeRoom(code);
    const ships = [
      ship("s1", { x: 500, y: 500, vx: 20, vy: 0 }),
      ship("s2", { x: 510, y: 500, vx: -20, vy: 0 }),
      ship("s3", { x: 540, y: 500, vx: 0, vy: 0 })
    ];
    installShips(room, ships);
    return room;
  };
  const steady = makeRoom("CALLBACK-STEADY");
  const catchUp = makeRoom("CALLBACK-CATCHUP");
  const t0 = 2_000_000;
  advanceRoomAuthoritative(steady, t0);
  advanceRoomAuthoritative(catchUp, t0);
  for (let step = 1; step <= 6; step += 1) {
    advanceRoomAuthoritative(steady, t0 + step * FIXED_STEP_MS);
  }
  advanceRoomAuthoritative(catchUp, t0 + 3 * FIXED_STEP_MS);
  advanceRoomAuthoritative(catchUp, t0 + 6 * FIXED_STEP_MS);
  assert.equal(steady._simulationStep, catchUp._simulationStep, "steady and catch-up callbacks execute the same fixed steps");
  assert.deepEqual(snapshot([...steady.ships.values()]), snapshot([...catchUp.ships.values()]), "steady and catch-up callbacks produce the same packed final state");
  __setFIXED_AUTHORITATIVE_TIMESTEP(false);
}

// 20A. A dense island can create a new edge after the batch correction. The
// normal pair set stays sparse, then the moved-ship recovery query finds and
// includes the external ship without an iteration-time broad-phase rebuild.
{
  __setSHARED_MOVEMENT_CONTACT_PAIRS(true);
  __setPACKED_FLEET_SOLVER(true);
  const room = activeRoom("PAIR-MISSING-EDGE");
  const ships = [
    ship("s1", { x: 210, y: 500, stats: { mass: 1e9, radius: 30, maxHp: 100 } }),
    ship("s2", { x: 210, y: 500, stats: { mass: 1e9, radius: 30, maxHp: 100 } }),
    ship("s3", { x: 210, y: 500, stats: { mass: 1e9, radius: 30, maxHp: 100 } }),
    ship("s4", { x: 230, y: 500, stats: { mass: 1, radius: 30, maxHp: 100 } }),
    ship("s5", { x: 306, y: 500, stats: { mass: 1, radius: 30, maxHp: 100 } })
  ];
  installShips(room, ships);
  room.spatialIndex = new RoomSpatialIndex(80);
  buildRoomSpatialIndex(room, ships, 0);
  const step = beginMovementContactStep(room, ships, 1000);
  buildMovementContactPairs(room, ships, 1000, { stepId: step });
  assert.equal(hasMovementContactPair(room, ships[3], ships[4]), false, `external ship starts outside the shared pair padding (${pairIds(room, step).join(",")})`);
  const modified = updateShipSeparation(room, ships, 1 / 30, 1000, { circular: true });
  const moved = collectMovementContactMovedShips(room, ships, modified);
  room.spatialIndex.updateLiveEntities("ships", ships, shipBroadPhaseRadius);
  const miss = findMissingMovementContactPairs(room, moved, { circular: true });
  assert.ok(miss.missingCount >= 1, `same-direction dense correction detects the newly created edge (${ships.map((entity) => `${entity.id}:${entity.x.toFixed(2)}`).join(",")})`);
  markMovementContactPairsUnsafe(room, "verifier-missing-edge");
  rebuildMovementContactPairsForRecovery(room, ships, 1000);
  const recoveredModified = updateShipSeparation(room, ships, 1 / 30, 1000, { circular: true });
  room.spatialIndex.updateLiveEntities("ships", ships, shipBroadPhaseRadius);
  assert.equal(hasMovementContactPair(room, ships[3], ships[4]), true, "recovery pair build includes the external ship");
  assert.equal(room._roomTelemetry.movementContactPairRecoveryBuilds, 1, "missing edge uses one exceptional recovery build");
  assert.ok(recoveredModified.length > 0, "recovery solve applies a bounded correction");
}

// 21-29. Packed solver geometry, mass, determinism, convergence, boundaries,
// intent preservation and finite-state guarantees.
{
  __setSHARED_MOVEMENT_CONTACT_PAIRS(true);
  __setPACKED_FLEET_SOLVER(true);
  const equal = solverFixture([[500, 500], [510, 500]]);
  assert.ok(distance(equal.ships[0], equal.ships[1]) >= 35.6, "equal-mass overlap separates to the configured tolerance");
  assert.equal(equal.telemetry.packedFleetIslands, 1, "contact pair creates one packed island");
  assert.equal(equal.telemetry.packedFleetRemainingOverlaps, 0, "equal-mass pair converges");

  const weighted = solverFixture([[500, 500, 18, 1], [510, 500, 18, 100]]);
  assert.ok(Math.abs(weighted.ships[0].x - 500) > Math.abs(weighted.ships[1].x - 510), "lighter ship receives the larger correction");

  const coincidentA = solverFixture([[500, 500], [500, 500]]);
  const coincidentB = solverFixture([[500, 500], [500, 500]], { insertion: "reverse" });
  assert.ok(finiteShips(coincidentA.ships), "coincident ships remain finite");
  assert.deepEqual(snapshot(coincidentA.ships), snapshot(coincidentB.ships), "coincident fallback normal is deterministic");

  const chain = solverFixture([[500, 500], [510, 500], [520, 500]]);
  assert.ok(chain.telemetry.packedFleetLargestIsland === 3, "contact chain is one island");
  assert.ok(chain.telemetry.packedFleetIterations <= 4, "packed iterations are bounded");

  const squarePositions = [];
  for (let y = 0; y < 3; y += 1) for (let x = 0; x < 3; x += 1) squarePositions.push([500 + x * 12, 500 + y * 12]);
  const square = solverFixture(squarePositions);
  assert.ok(finiteShips(square.ships), "dense square fleet remains finite");
  assert.equal(square.telemetry.packedFleetRemainingOverlaps, 0, "dense square fleet converges within the bounded solver");

  const circlePositions = [];
  for (let i = 0; i < 10; i += 1) circlePositions.push([500 + Math.cos(i * Math.PI * 0.2) * 12, 500 + Math.sin(i * Math.PI * 0.2) * 12]);
  const circle = solverFixture(circlePositions);
  assert.ok(finiteShips(circle.ships), "dense circular fleet remains finite");
  assert.equal(circle.telemetry.packedFleetRemainingOverlaps, 0, "dense circular fleet converges within the bounded solver");

  const mixed = solverFixture([[500, 500, 18], [510, 500, 42], [520, 500, 24]]);
  assert.ok(finiteShips(mixed.ships), "mixed radii remain finite");
  const extreme = solverFixture([[500, 500, 18, 1e9], [510, 500, 90, 1]]);
  assert.ok(finiteShips(extreme.ships), "extreme valid mass ratios remain finite");

  const singleContact = solverFixture([
    [500, 500, 18, 1e9, 100, 0],
    [520, 500, 18, 1, -100, 0]
  ]);
  const sameSide = solverFixture([
    [500, 500, 18, 1e9, 100, 0],
    [500, 500, 18, 1e9, 100, 0],
    [520, 500, 18, 1, -100, 0]
  ]);
  const singleCentralDelta = velocityDelta(singleContact.ships[1], -100, 0);
  const sameSideCentralDelta = velocityDelta(sameSide.ships[2], -100, 0);
  assert.ok(sameSideCentralDelta <= singleCentralDelta + EPSILON, "same-side contacts obey the per-ship collision-velocity budget");

  const symmetrical = solverFixture([
    [500, 500, 18, 1, 100, 0],
    [510, 500, 18, 1, 0, 0],
    [520, 500, 18, 1, -100, 0]
  ]);
  assert.ok(
    Math.abs(symmetrical.ships[1].vx) <= singleCentralDelta * 0.5 + EPSILON,
    `symmetrical impulses substantially cancel on the central ship (${symmetrical.ships.map((entity) => entity.vx.toFixed(3)).join(",")})`
  );

  const mixedMassVelocity = solverFixture([
    [500, 500, 18, 1e9, 120, 0],
    [500, 500, 42, 1, 120, 0],
    [530, 500, 24, 2, -120, 0]
  ]);
  assert.ok(finiteShips(mixedMassVelocity.ships), "mixed-mass collision velocities remain finite");

  const velocityFixture = [
    [500, 500, 18, 1e9, 100, 0],
    [500, 500, 18, 1e9, 100, 0],
    [520, 500, 18, 1, -100, 0]
  ];
  __setSHARED_MOVEMENT_CONTACT_PAIRS(false);
  __setPACKED_FLEET_SOLVER(false);
  const legacyVelocity = solverFixture(velocityFixture);
  __setSHARED_MOVEMENT_CONTACT_PAIRS(true);
  __setPACKED_FLEET_SOLVER(true);
  const packedVelocity = solverFixture(velocityFixture);
  const legacyCentralDelta = velocityDelta(legacyVelocity.ships[2], -100, 0);
  const packedCentralDelta = velocityDelta(packedVelocity.ships[2], -100, 0);
  assert.ok(
    packedCentralDelta <= legacyCentralDelta + singleCentralDelta * 0.1 + EPSILON,
    `packed velocity delta stays close to legacy multi-contact behavior (${packedCentralDelta.toFixed(3)} vs ${legacyCentralDelta.toFixed(3)})`
  );

  const reversedPairs = solverFixture([[500, 500], [510, 500], [520, 500]], { reversePairs: true });
  const forwardPairs = solverFixture([[500, 500], [510, 500], [520, 500]]);
  assert.deepEqual(snapshot(reversedPairs.ships), snapshot(forwardPairs.ships), "reversed pair order cannot change final state");

  const noContact = solverFixture([[500, 500], [800, 800]]);
  assert.equal(noContact.telemetry.packedFleetEarlyExits, 1, "no-overlap pair set exits early");
  assert.equal(noContact.telemetry.packedFleetRemainingOverlaps, 0, "no-contact fleet has no unresolved overlaps");

  const boundary = solverFixture([[62, 800], [67, 800]]);
  for (const entity of boundary.ships) {
    assert.ok(entity.x >= 42 + entity.physicalRadius - EPSILON, "boundary correction remains in bounds");
  }
  const intent = solverFixture([[500, 500], [510, 500]], { shipOverrides: { movement: { command: { type: "move", destination: { x: 900, y: 900 } } }, targetX: 900, targetY: 900 } });
  assert.equal(intent.ships[0].movement.command.type, "move", "movement intent survives separation");
  assert.equal(intent.ships[0].targetX, 900, "movement target survives separation");
  assert.ok(intent.telemetry.packedFleetCorrectionApplications > 0, "packed solver applies bounded corrections");
}

// 30. Shared-pair legacy parity, disabled fallback and final spatial publication.
{
  const legacyRoom = activeRoom("PARITY-LEGACY");
  const legacyShips = [ship("s1", { x: 500, y: 500 }), ship("s2", { x: 510, y: 500 })];
  installShips(legacyRoom, legacyShips);
  __setSHARED_MOVEMENT_CONTACT_PAIRS(false);
  __setPACKED_FLEET_SOLVER(false);
  updateShipSeparation(legacyRoom, legacyShips, 1 / 30, 1000, { circular: true });
  const legacySnapshot = snapshot(legacyShips);
  assert.ok(legacyRoom._roomTelemetry.separationQueries > 0, "disabled path preserves legacy broad-phase queries");

  const sharedRoom = activeRoom("PARITY-SHARED");
  const sharedShips = [ship("s1", { x: 500, y: 500 }), ship("s2", { x: 510, y: 500 })];
  installShips(sharedRoom, sharedShips);
  __setSHARED_MOVEMENT_CONTACT_PAIRS(true);
  const sharedStep = beginMovementContactStep(sharedRoom, sharedShips, 1000);
  buildMovementContactPairs(sharedRoom, sharedShips, 1000, { stepId: sharedStep });
  updateShipSeparation(sharedRoom, sharedShips, 1 / 30, 1000, { circular: true });
  assert.deepEqual(snapshot(sharedShips), legacySnapshot, "shared pairs with legacy solver preserve established collision results");

  sharedRoom.spatialIndex = new RoomSpatialIndex(80);
  buildRoomSpatialIndex(sharedRoom, sharedShips, 1);
  for (const entity of sharedShips) {
    const record = sharedRoom.spatialIndex.recordsByEntity.ships.get(entity);
    assert.equal(record.x, entity.x, "final spatial record x matches corrected position");
    assert.equal(record.y, entity.y, "final spatial record y matches corrected position");
  }
}

// 31-33. Real production paths: spawnShip, destroyShip, and authoritative tick.
{
  __setSHARED_MOVEMENT_CONTACT_PAIRS(true);
  __setPACKED_FLEET_SOLVER(true);
  __setINCREMENTAL_SPATIAL_INDEX(true);
  const room = activeRoom("PRODUCTION-PATH");
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 7, y: 9, type: "engine", rotation: 0 },
    { x: 7, y: 5, type: "blaster", rotation: 0 }
  ];
  const wiring = { version: 1, power: { sections: [], connections: [] }, data: { sections: [], connections: [] }, powerPolicy: null };
  const stats = computeStats(design, wiring);
  const player = {
    id: "p1", team: 1, ready: true, connected: true, design, wiring, stats,
    ships: [], shipCap: 12, money: 100000, combatStyle: "hold", movementToggles: {}
  };
  room.players.set("p1", player);
  room.spatialIndex = new RoomSpatialIndex(160);
  buildRoomSpatialIndex(room, [], 0);
  const spawned = spawnShip(room, player, 0, 0, { spawnPoint: { x: 700, y: 700, angle: 0 } });
  assert.ok(spawned && room.spatialIndex.count("ships") === 1, "real spawnShip publishes an indexed ship");
  const step = beginMovementContactStep(room, [spawned], 1000);
  buildMovementContactPairs(room, [spawned], 1000, { stepId: step });
  destroyShip(room, spawned, null, 1000);
  assert.equal(getMovementContactPairs(room, step).length, 0, "real destroyShip removes pair references");

  const tickRoomFixture = activeRoom("PRODUCTION-TICK");
  const one = ship("s1", { x: 500, y: 500, design: [{ x: 7, y: 7, type: "core" }, { x: 7, y: 9, type: "engine" }], componentHp: [50, 50] });
  const two = ship("s2", { x: 510, y: 500, design: [{ x: 7, y: 7, type: "core" }, { x: 7, y: 9, type: "engine" }], componentHp: [50, 50] });
  installShips(tickRoomFixture, [one, two]);
  tickRoomFixture._movementContactPairDiagnostics = true;
  tickRoom(tickRoomFixture, 1 / 30, 1000);
  assert.equal(tickRoomFixture._roomTelemetry.movementContactPairBuilds, 1, "authoritative movement tick builds one shared pair set");
  assert.ok(tickRoomFixture._roomTelemetry.packedFleetSolverSteps >= 1, "authoritative tick reaches packed solver");
  assert.equal(tickRoomFixture._roomTelemetry.movementContactPairMissDetections, 0, "authoritative tick has no missed contact diagnostic");
  assert.ok(tickRoomFixture.spatialIndex.verifyIntegrity("ships").ok, "final authoritative spatial index remains valid");

  const recoveryTickRoom = activeRoom("PRODUCTION-MISSING-EDGE");
  const recoveryTickShips = [
    ship("s1", { x: 210, y: 500, stats: { mass: 1e9, radius: 30, maxHp: 100 } }),
    ship("s2", { x: 210, y: 500, stats: { mass: 1e9, radius: 30, maxHp: 100 } }),
    ship("s3", { x: 210, y: 500, stats: { mass: 1e9, radius: 30, maxHp: 100 } }),
    ship("s4", { x: 230, y: 500, stats: { mass: 1, radius: 30, maxHp: 100 } }),
    ship("s5", { x: 306, y: 500, stats: { mass: 1, radius: 30, maxHp: 100 } })
  ];
  installShips(recoveryTickRoom, recoveryTickShips);
  recoveryTickRoom.spatialIndex = new RoomSpatialIndex(80);
  buildRoomSpatialIndex(recoveryTickRoom, recoveryTickShips, 0);
  tickRoom(recoveryTickRoom, 1 / 30, 1000);
  assert.equal(recoveryTickRoom._roomTelemetry.movementContactPairRecoveryBuilds, 1, "production tick performs one missing-edge recovery build");
  assert.equal(hasMovementContactPair(recoveryTickRoom, recoveryTickShips[3], recoveryTickShips[4]), true, "production recovery retains the new edge");
  assert.ok(recoveryTickRoom.spatialIndex.verifyIntegrity("ships").ok, "recovery tick publishes a valid final spatial index");

  const stationLaunchRoom = activeRoom("PRODUCTION-STATION-LAUNCH");
  stationLaunchRoom.rules = { ...stationLaunchRoom.rules, infrastructureMode: "stations", gameMode: "solo" };
  stationLaunchRoom.map.safeZones = [{ x: 600, y: 600, team: "p1", ownerId: "p1" }];
  stationLaunchRoom.map.relays = [];
  const launchDesign = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 7, y: 9, type: "engine", rotation: 0 }
  ];
  const launchWiring = { version: 1, power: { sections: [], connections: [] }, data: { sections: [], connections: [] }, powerPolicy: null };
  const launchStats = computeStats(launchDesign, launchWiring);
  const launchPlayer = {
    id: "p1", team: "p1", ready: true, connected: true, design: launchDesign, wiring: launchWiring,
    stats: launchStats, ships: [], shipCap: 8, money: 100000, combatStyle: "hold", movementToggles: {}
  };
  stationLaunchRoom.players.set("p1", launchPlayer);
  stationLaunchRoom.spatialIndex = new RoomSpatialIndex(160);
  buildRoomSpatialIndex(stationLaunchRoom, [], 0);
  createStationsForRoom(stationLaunchRoom, 0);
  const home = stationLaunchRoom.stations.find((station) => station.stationType === "home");
  assert.ok(home?.hangar, "production fixture creates a real home-station hangar");
  const queued = enqueueStationProduction(stationLaunchRoom, launchPlayer, {
    template: getOrCreateTemplate(
      "p1",
      launchDesign,
      launchWiring,
      launchStats,
      canonicalBlueprintSignature(launchDesign, launchWiring)
    ),
    request: { requestId: "phase4cd-launch", combatStyle: "hold" },
    validation: { count: 1, totalCost: launchStats.unitCost }
  }, 0);
  assert.equal(queued.ok, true, "real station production queue accepts the launch fixture");
  tickRoom(stationLaunchRoom, 1 / 30, 1000);
  assert.equal(stationLaunchRoom.stationCounters.stationLaunchSuccessCount, 1, "real station hangar launch creates a ship");
  const launchedShip = launchPlayer.ships.find((entity) => entity.alive);
  assert.ok(launchedShip?.launchPhase, "launched ship enters the authoritative launch phase");
  tickRoom(stationLaunchRoom, 1 / 30, 1033.3333333333);
  assert.ok(stationLaunchRoom._roomTelemetry.packedFleetSolverSteps >= 1, "real station launch reaches packed separation on the next tick");
  assert.ok(stationLaunchRoom.spatialIndex.verifyIntegrity("ships").ok, "real station launch leaves valid final spatial records");
}

// 34. Map correction remains finite and does not alter solver intent state.
{
  const room = activeRoom("STATIC");
  room.map.asteroids = [{ x: 700, y: 700, radius: 60 }];
  const entity = ship("s1", { x: 700, y: 700 });
  installShips(room, [entity]);
  resolveMapCollision(room, entity);
  assert.ok(finiteShips([entity]), "asteroid correction remains finite");
  assert.ok(entity.x !== 700 || entity.y !== 700, "asteroid correction moves the ship out of the hull");
}

// Restore default test state for callers that require this verifier in-process.
__setSHARED_MOVEMENT_CONTACT_PAIRS(false);
__setPACKED_FLEET_SOLVER(false);
__setINCREMENTAL_SPATIAL_INDEX(false);
__setFIXED_AUTHORITATIVE_TIMESTEP(false);
console.log("Phase 4C/4D shared contact-pair and packed-fleet verification passed");
