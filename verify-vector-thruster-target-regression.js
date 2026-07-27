"use strict";
// Regression test: Vector Thruster movement must never clear combat target IDs.
// Bug f761a54 introduced getActiveCombatTarget({ ships: new Map() }, ship) inside
// applyVectorThrusterForces, which searched an empty ship map, failed to find the
// real target, and cleared focusTargetId / combatTargetId / commandMode every
// movement substep.  This test verifies the fix stays in place.
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { PARTS } = require("./src/server/components");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { updateShipMovement } = require("./src/server/movement");
const { getShipComponentIndexes } = require("./src/server/componentIndexes");

function mod(type, x, y, rotation = 0) { return { type, x, y, rotation }; }

function runtimeShip(design, overrides = {}) {
  const stats = computeStats(design);
  const ship = {
    id: "test", ownerId: "p1", alive: true, x: 300, y: 300, vx: 0, vy: 0, angle: 0,
    targetX: 300, targetY: 600, arrived: false, isManualMove: true,
    radius: stats.radius || 30, design, wiring: createGeneratedPowerWiring(design),
    stats, ...overrides
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function emptyRoom() {
  return { world: { width: 2000, height: 1600 }, map: { asteroids: [] }, ships: new Map() };
}

function run() {
  // ── 1. Vector Thruster ship retains combat target across movement steps ──
  const vtDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("vectorThruster", 6, 7, 90)];
  const vtShip = runtimeShip(vtDesign, {
    combatStyle: "evasive",
    targetX: 600, targetY: 300, arrived: false,
    focusTargetId: "enemy",
    combatTargetId: "enemy",
    commandMode: "attack"
  });
  const vtIndexes = getShipComponentIndexes(vtShip);
  assert(vtIndexes.vectorThrusterIndices.length === 1, "Ship must have a vector thruster");

  const enemy = { id: "enemy", ownerId: "p2", alive: true, x: 600, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  const room = emptyRoom();
  room.ships.set("enemy", enemy);

  // Run multiple movement substeps — the bug would clear target IDs on every step
  for (let i = 0; i < 10; i++) {
    updateShipMovement(room, vtShip, 1 / 30, 1000 + i * 33);
  }

  assert(vtShip.focusTargetId === "enemy", `focusTargetId must remain "enemy" after movement, got ${vtShip.focusTargetId}`);
  assert(vtShip.combatTargetId === "enemy", `combatTargetId must remain "enemy" after movement, got ${vtShip.combatTargetId}`);
  assert(vtShip.commandMode === "attack", `commandMode must remain "attack" after movement, got ${vtShip.commandMode}`);
  console.log("  ✓ Vector Thruster ship retains combat target IDs across movement substeps");

  // ── 2. No temporary Map allocation during movement ──────────────────────
  // The bug created `new Map()` every substep.  We verify by checking that
  // movement does not throw and target IDs survive even with many substeps.
  const vtShip2 = runtimeShip(vtDesign, {
    combatStyle: "interceptor",
    targetX: 600, targetY: 300, arrived: false,
    focusTargetId: "enemy2",
    combatTargetId: "enemy2",
    commandMode: "attack"
  });
  const enemy2 = { id: "enemy2", ownerId: "p2", alive: true, x: 600, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  const room2 = emptyRoom();
  room2.ships.set("enemy2", enemy2);

  // Large dt triggers multiple substeps
  updateShipMovement(room2, vtShip2, 0.5, 2000);

  assert(vtShip2.focusTargetId === "enemy2", `focusTargetId must survive multi-substep movement, got ${vtShip2.focusTargetId}`);
  assert(vtShip2.combatTargetId === "enemy2", `combatTargetId must survive multi-substep movement, got ${vtShip2.combatTargetId}`);
  console.log("  ✓ Vector Thruster ship retains target IDs through multi-substep movement");

  // ── 3. Vector Thruster with zero force inputs does not generate heat ────
  // A ship with no combat style that triggers lateral/braking/reverse input
  // should return before the heat loop.
  const vtShip3 = runtimeShip(vtDesign, {
    combatStyle: "hold",
    targetX: 300, targetY: 300, arrived: true,
    focusTargetId: "enemy3",
    combatTargetId: "enemy3",
    commandMode: "attack"
  });
  const enemy3 = { id: "enemy3", ownerId: "p2", alive: true, x: 300, y: 350, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  const room3 = emptyRoom();
  room3.ships.set("enemy3", enemy3);

  const vtIndex = vtIndexes.vectorThrusterIndices[0];
  const heatBefore = vtShip3.componentHeat[vtIndex] || 0;

  // Ship is arrived with hold style — no lateral/braking/reverse input
  updateShipMovement(room3, vtShip3, 1 / 30, 3000);

  const heatAfter = vtShip3.componentHeat[vtIndex] || 0;
  assert(heatAfter === heatBefore, `Vector Thruster should not generate heat when all force inputs are zero (before: ${heatBefore}, after: ${heatAfter})`);
  console.log("  ✓ Vector Thruster does not generate heat when force inputs are zero");

  // ── 4. Hull-angle cache prevents repeated full searches ─────────────────
  // Enable profiling and verify cache hits occur during repeated movement steps
  global.__mfaMovePerf = {};
  const weaponDesign = [mod("core", 7, 7), mod("reactor", 8, 7), mod("engine", 7, 8), mod("blaster", 6, 7), mod("blaster", 8, 6)];
  const weaponShip = runtimeShip(weaponDesign, {
    combatStyle: "hold",
    targetX: 300, targetY: 300, arrived: true,
    focusTargetId: "enemy4",
    combatTargetId: "enemy4",
    commandMode: "attack",
    holdState: { phase: "holding", x: 300, y: 300 }
  });
  const enemy4 = { id: "enemy4", ownerId: "p2", alive: true, x: 500, y: 300, vx: 0, vy: 0, angle: 0, radius: 30, design: [mod("core", 7, 7)], stats: { radius: 30 } };
  const room4 = emptyRoom();
  room4.ships.set("enemy4", enemy4);

  // Run several movement steps — ship is arrived so rotateHullForCombat runs
  for (let i = 0; i < 10; i++) {
    updateShipMovement(room4, weaponShip, 1 / 30, 4000 + i * 33);
  }

  const perf = global.__mfaMovePerf;
  assert(perf.hullAngleSearches > 0, "At least one hull-angle search should have occurred");
  assert(perf.hullAngleCacheHits > 0, "Hull-angle cache should have hits after repeated steps");
  const totalAngleOps = perf.hullAngleSearches + perf.hullAngleCacheHits;
  const cacheRatio = perf.hullAngleCacheHits / totalAngleOps;
  assert(cacheRatio > 0.5, `Cache hit ratio should be > 50% after first search, got ${(cacheRatio * 100).toFixed(1)}%`);
  console.log(`  ✓ Hull-angle cache: ${perf.hullAngleSearches} searches, ${perf.hullAngleCacheHits} cache hits (${(cacheRatio * 100).toFixed(1)}% hit ratio)`);

  delete global.__mfaMovePerf;

  // ── 5. Effective weapon cache uses revision-based validation ────────────
  global.__mfaDataSupportPerf = {};
  const { getEffectiveWeaponStats } = require("./src/server/componentData");
  const weaponShip2 = runtimeShip(weaponDesign, {
    targetX: 300, targetY: 300, arrived: true
  });

  // First call builds the cache
  getEffectiveWeaponStats(weaponShip2, 3);
  const firstSigCount = global.__mfaDataSupportPerf.effectiveWeaponSignatureCalculations || 0;
  assert(firstSigCount > 0, "First call should compute cache signature");

  // Second call should still check the signature but not rebuild
  const sigBeforeSecond = global.__mfaDataSupportPerf.effectiveWeaponSignatureCalculations || 0;
  getEffectiveWeaponStats(weaponShip2, 3);
  const sigAfterSecond = global.__mfaDataSupportPerf.effectiveWeaponSignatureCalculations || 0;
  assert(sigAfterSecond === sigBeforeSecond + 1, "Second call should increment signature calculation counter (revision check)");
  assert((global.__mfaDataSupportPerf.profileBuildCount || 0) === 1, "Cache should not be rebuilt on second call");

  console.log("  ✓ Effective weapon cache uses revision-based validation (no string rebuild on cache hit)");

  delete global.__mfaDataSupportPerf;

  console.log("\nAll vector thruster target regression tests passed ✓");
}

try { run(); } catch (err) { console.error(err.message); process.exit(1); }
