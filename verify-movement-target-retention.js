"use strict";
// Regression test: movement must never clear combat target IDs.
// Bug f761a54 called getActiveCombatTarget({ ships: new Map() }, ship) inside the
// propulsion path, which searched an empty ship map, failed to find the real
// target, and cleared focusTargetId / combatTargetId every movement substep.
// This test verifies the fix stays in place.
//
// (Formerly verify-vector-thruster-target-regression.js. The vector thruster part
// it was built around never existed in the balance data, so the fixture silently
// fell back to a frame; the behaviour under test was never about that component.)
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { updateShipMovement } = require("./src/server/movement");
const { getShipComponentIndexes } = require("./src/server/componentIndexes");
const {
  createMovementRuntime,
  setMovementCommand
} = require("./src/server/movementRuntime");

function mod(type, x, y, rotation = 0) { return { type, x, y, rotation }; }

function runtimeShip(design, overrides = {}) {
  const stats = computeStats(design);
  const ship = {
    id: "test", ownerId: "p1", alive: true, x: 300, y: 300, vx: 0, vy: 0, angle: 0,
    targetX: 300, targetY: 300,
    radius: stats.radius || 30, design, wiring: createGeneratedPowerWiring(design),
    stats, ...overrides
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  ship.movement = createMovementRuntime();
  const targetId = ship.focusTargetId || ship.combatTargetId;
  if (targetId) {
    setMovementCommand(ship, {
      id: `attack-${ship.id}-${targetId}`,
      type: "attack",
      destination: null,
      targetId,
      finalFacing: null
    });
  }
  return ship;
}

function emptyRoom() {
  // Stance movement resolves its target through areEnemies, so a room without
  // both owners registered leaves every ship here with nothing to react to.
  return {
    world: { width: 2000, height: 1600 },
    map: { asteroids: [] },
    ships: new Map(),
    players: new Map([
      ["p1", { id: "p1", team: "blue", ships: [] }],
      ["p2", { id: "p2", team: "red", ships: [] }]
    ]),
    rules: { gameMode: "teams" }
  };
}

function run() {
  // ── 1. Manoeuvring ship retains its combat target across movement steps ──
  const thrusterDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("maneuverThruster", 6, 7, 90)];
  const ship1 = runtimeShip(thrusterDesign, {
    combatStyle: "orbit",
    targetX: 600, targetY: 300,
    focusTargetId: "enemy",
    combatTargetId: "enemy"
  });
  assert(getShipComponentIndexes(ship1).maneuverThrusterIndices.length === 1,
    "fixture precondition: ship must have a maneuver thruster");

  const enemy = { id: "enemy", ownerId: "p2", alive: true, x: 600, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  const room = emptyRoom();
  room.ships.set("enemy", enemy);

  // Run multiple movement substeps — the bug would clear target IDs on every step
  for (let i = 0; i < 10; i++) {
    updateShipMovement(room, ship1, 1 / 30, 1000 + i * 33);
  }

  assert(ship1.focusTargetId === "enemy", `focusTargetId must remain "enemy" after movement, got ${ship1.focusTargetId}`);
  assert(ship1.combatTargetId === "enemy", `combatTargetId must remain "enemy" after movement, got ${ship1.combatTargetId}`);
  assert.strictEqual(ship1.movement.command?.type, "attack",
    "authoritative attack command must survive movement");
  console.log("  ✓ ship retains combat target IDs across movement substeps");

  // ── 2. Target IDs survive a tick large enough to force several substeps ──
  const ship2 = runtimeShip(thrusterDesign, {
    combatStyle: "charge",
    targetX: 600, targetY: 300,
    focusTargetId: "enemy2",
    combatTargetId: "enemy2"
  });
  const enemy2 = { id: "enemy2", ownerId: "p2", alive: true, x: 600, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  const room2 = emptyRoom();
  room2.ships.set("enemy2", enemy2);

  updateShipMovement(room2, ship2, 0.5, 2000);

  assert(ship2.focusTargetId === "enemy2", `focusTargetId must survive multi-substep movement, got ${ship2.focusTargetId}`);
  assert(ship2.combatTargetId === "enemy2", `combatTargetId must survive multi-substep movement, got ${ship2.combatTargetId}`);
  console.log("  ✓ target IDs survive a multi-substep tick");

  // ── 3. Combat facing stays on the shared controller ─────────────────────
  global.__mfaMovePerf = {};
  const weaponDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("blaster", 6, 7), mod("blaster", 8, 6)];
  const weaponShip = runtimeShip(weaponDesign, {
    combatStyle: "hold",
    targetX: 300, targetY: 300,
    focusTargetId: "enemy4",
    combatTargetId: "enemy4"
  });
  const enemy4 = { id: "enemy4", ownerId: "p2", alive: true, x: 500, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  const room4 = emptyRoom();
  room4.ships.set("enemy4", enemy4);

  for (let i = 0; i < 10; i++) {
    updateShipMovement(room4, weaponShip, 1 / 30, 4000 + i * 33);
  }

  const perf = global.__mfaMovePerf;
  assert.strictEqual(perf.sharedControllerRuns, 10,
    "combat-facing ticks should use the shared controller");
  assert(!Object.prototype.hasOwnProperty.call(weaponShip, "_hullAngleCache"),
    "combat movement must not create the removed hull-angle cache");
  console.log("  ✓ combat facing uses the shared controller without legacy cache state");

  delete global.__mfaMovePerf;

  // ── 4. Effective weapon cache uses revision-based validation ────────────
  global.__mfaDataSupportPerf = {};
  const { getEffectiveWeaponStats } = require("./src/server/componentData");
  const weaponShip2 = runtimeShip(weaponDesign, {
    targetX: 300, targetY: 300
  });

  getEffectiveWeaponStats(weaponShip2, 3);
  const firstSigCount = global.__mfaDataSupportPerf.effectiveWeaponSignatureCalculations || 0;
  assert(firstSigCount > 0, "First call should compute cache signature");

  const sigBeforeSecond = global.__mfaDataSupportPerf.effectiveWeaponSignatureCalculations || 0;
  getEffectiveWeaponStats(weaponShip2, 3);
  const sigAfterSecond = global.__mfaDataSupportPerf.effectiveWeaponSignatureCalculations || 0;
  assert(sigAfterSecond === sigBeforeSecond + 1, "Second call should increment signature calculation counter (revision check)");
  assert((global.__mfaDataSupportPerf.profileBuildCount || 0) === 1, "Cache should not be rebuilt on second call");

  console.log("  ✓ effective weapon cache uses revision-based validation (no string rebuild on cache hit)");

  delete global.__mfaDataSupportPerf;

  console.log("\nAll movement target retention tests passed ✓");
}

try { run(); } catch (err) { console.error(err.message); process.exit(1); }
