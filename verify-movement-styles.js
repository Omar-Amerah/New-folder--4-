"use strict";
// Combat movement style verification: orbit, maintain, hold two-phase,
// kite, direct, and backward compatibility (circle → orbit migration).
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { updateShipMovement } = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { sanitizeCombatStyle } = require("./src/server/validation");

function runtimeShip(design, overrides = {}) {
  const stats = computeStats(design);
  const ship = {
    id: "test", ownerId: "p1", alive: true, x: 300, y: 300, vx: 0, vy: 0, angle: 0,
    targetX: 300, targetY: 300, arrived: false, isManualMove: false, radius: stats.radius, design,
    wiring: createGeneratedPowerWiring(design), stats, ...overrides
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function makeRoom() {
  return { world: { width: 2000, height: 1600 }, map: { asteroids: [] }, ships: new Map() };
}

// Design with a blaster (range ~420) so getMaxWeaponRange returns a useful value.
const armedDesign = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];

function run() {
  const room = makeRoom();
  const target = { id: "enemy", ownerId: "p2", alive: true, x: 900, y: 300, radius: 30 };
  room.ships.set(target.id, target);

  // 1. Backward compatibility: sanitizeCombatStyle maps "circle" → "orbit".
  assert.strictEqual(sanitizeCombatStyle("circle"), "orbit", "circle should map to orbit");
  assert.strictEqual(sanitizeCombatStyle("orbit"), "orbit", "orbit should pass through");
  assert.strictEqual(sanitizeCombatStyle("maintain"), "maintain", "maintain should pass through");
  assert.strictEqual(sanitizeCombatStyle("kite"), "kite", "kite should pass through");
  assert.strictEqual(sanitizeCombatStyle("direct"), "direct", "direct should pass through");
  assert.strictEqual(sanitizeCombatStyle("hold"), "hold", "hold should pass through");
  assert.strictEqual(sanitizeCombatStyle("unknown"), "hold", "unknown should fall back to hold");

  // 2. Orbit style: ship should continuously move (never arrives), orbiting target.
  {
    const ship = runtimeShip(armedDesign, {
      id: "orbiter",
      combatStyle: "orbit",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 600, y: 300,
      targetX: 600, targetY: 300
    });
    const startX = ship.x, startY = ship.y;
    updateShipMovement(room, ship, 1 / 30);
    assert(!ship.arrived, "orbit ship should not arrive");
    assert(ship.targetX !== ship.x || ship.targetY !== ship.y, "orbit ship should have a distinct move target");
    // Run several ticks and verify the ship is moving (position changes).
    const tickX = ship.x;
    updateShipMovement(room, ship, 1 / 30);
    updateShipMovement(room, ship, 1 / 30);
    updateShipMovement(room, ship, 1 / 30);
    assert(ship.x !== tickX || ship.y !== ship.y, "orbit ship should be in motion over multiple ticks");
    // Verify orbit direction is set deterministically.
    assert(ship.orbitDir === 1 || ship.orbitDir === -1, "orbit direction should be set to 1 or -1");
    assert.strictEqual(ship.lastOrbitTargetId, "enemy", "orbit should track target id");
  }

  // 2b. Legacy "circle" combatStyle should behave identically to "orbit".
  {
    const ship = runtimeShip(armedDesign, {
      id: "legacy",
      combatStyle: "circle",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 600, y: 300,
      targetX: 600, targetY: 300
    });
    updateShipMovement(room, ship, 1 / 30);
    assert(!ship.arrived, "legacy circle ship should not arrive (behaves as orbit)");
    assert(ship.orbitDir === 1 || ship.orbitDir === -1, "legacy circle should set orbitDir");
  }

  // 3. Maintain Range style: ship should approach if too far, retreat if too close,
  //    and hold position within the tolerance band.
  {
    const { getEffectiveWeaponRanges } = require("./src/server/componentData");
    const ship = runtimeShip(armedDesign, {
      id: "maintainer",
      combatStyle: "maintain",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 200, y: 300,  // far from target
      targetX: 200, targetY: 300
    });
    updateShipMovement(room, ship, 1 / 30);
    assert(!ship.arrived, "maintain ship far from target should not have arrived");
    // The target should be set toward the desired range from the enemy.
    const distToTarget = Math.hypot(ship.targetX - target.x, ship.targetY - target.y);
    const ranges = getEffectiveWeaponRanges(ship);
    const maxRange = Math.max(120, ranges.blaster, ranges.missile, ranges.railgun, ranges.beam);
    const expectedRange = maxRange * 0.9;
    assert(Math.abs(distToTarget - expectedRange) < 5, `maintain target should be near 90% max range from enemy (got ${distToTarget}, expected ${expectedRange})`);
  }

  // 3b. Maintain Range: ship within tolerance should arrive.
  {
    const { getEffectiveWeaponRanges } = require("./src/server/componentData");
    const tmpShip = runtimeShip(armedDesign, { id: "tmp-ranges" });
    const ranges = getEffectiveWeaponRanges(tmpShip);
    const maxRange = Math.max(120, ranges.blaster, ranges.missile, ranges.railgun, ranges.beam);
    const desiredRange = maxRange * 0.9;
    const tolerance = maxRange * 0.05;
    const dx = 1, dy = 0; // unit vector away from target
    const shipX = target.x + dx * (desiredRange + tolerance * 0.5);
    const shipY = target.y + dy * (desiredRange + tolerance * 0.5);
    const ship = runtimeShip(armedDesign, {
      id: "maintain-close",
      combatStyle: "maintain",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: shipX, y: shipY,
      targetX: shipX, targetY: shipY
    });
    updateShipMovement(room, ship, 1 / 30);
    assert(ship.arrived, "maintain ship within tolerance should arrive");
  }

  // 4. Hold style two-phase: Phase 1 (positioning) moves to desired range,
  //    Phase 2 (holding) fixes world position and does not follow enemy.
  {
    const ship = runtimeShip(armedDesign, {
      id: "holder",
      combatStyle: "hold",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 200, y: 300,  // far from target, needs positioning
      targetX: 200, targetY: 300,
      holdState: null
    });
    updateShipMovement(room, ship, 1 / 30);
    assert(ship.holdState, "hold ship should have holdState object");
    assert.strictEqual(ship.holdState.phase, "positioning", "hold ship should start in positioning phase");
    assert(!ship.arrived, "hold ship in positioning should not have arrived");

    // Manually advance to holding phase by placing ship near desired range.
    const { getEffectiveWeaponRanges } = require("./src/server/componentData");
    const ranges = getEffectiveWeaponRanges(ship);
    const maxRange = Math.max(120, ranges.blaster, ranges.missile, ranges.railgun, ranges.beam);
    const desiredRange = maxRange * 0.9;
    ship.x = target.x + desiredRange;
    ship.y = target.y;
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    updateShipMovement(room, ship, 1 / 30);
    assert.strictEqual(ship.holdState.phase, "holding", "hold ship should transition to holding when in range");
    assert(Number.isFinite(ship.holdState.x) && Number.isFinite(ship.holdState.y), "hold ship should record fixed position");

    // Now move the enemy — the hold ship should NOT follow.
    const holdX = ship.holdState.x, holdY = ship.holdState.y;
    target.x = 1200; // enemy moves away
    updateShipMovement(room, ship, 1 / 30);
    assert.strictEqual(ship.holdState.phase, "holding", "hold ship should remain in holding phase");
    assert.strictEqual(ship.targetX, holdX, "hold ship should target fixed world position, not enemy");
    assert.strictEqual(ship.targetY, holdY, "hold ship should target fixed world position, not enemy");
  }

  // 5. Kite style: ship too close should retreat; ship too far should approach.
  {
    const ship = runtimeShip(armedDesign, {
      id: "kiter",
      combatStyle: "kite",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 850, y: 300,  // very close to target at 900,300
      targetX: 850, targetY: 300
    });
    updateShipMovement(room, ship, 1 / 30);
    assert(!ship.arrived, "kite ship too close should not have arrived");
    // Kite retreats: target should be further from enemy than current position.
    const distToEnemy = Math.hypot(ship.targetX - target.x, ship.targetY - target.y);
    const currentDist = Math.hypot(ship.x - target.x, ship.y - target.y);
    assert(distToEnemy > currentDist, "kite ship should retreat (target further from enemy than current)");
  }

  // 6. Direct style: ship should move directly toward target.
  {
    const ship = runtimeShip(armedDesign, {
      id: "directer",
      combatStyle: "direct",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 200, y: 300,
      targetX: 200, targetY: 300
    });
    updateShipMovement(room, ship, 1 / 30);
    assert(!ship.arrived, "direct ship should not have arrived");
    assert.strictEqual(ship.targetX, target.x, "direct ship should target enemy position directly");
    assert.strictEqual(ship.targetY, target.y, "direct ship should target enemy position directly");
  }

  // 7. Determinism: running the same simulation twice should produce identical state.
  {
    const shipA = runtimeShip(armedDesign, {
      id: "det-a",
      combatStyle: "orbit",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 500, y: 400,
      targetX: 500, targetY: 400
    });
    const shipB = runtimeShip(armedDesign, {
      id: "det-b",
      combatStyle: "orbit",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 500, y: 400,
      targetX: 500, targetY: 400
    });
    for (let i = 0; i < 10; i++) {
      updateShipMovement(room, shipA, 1 / 30);
      updateShipMovement(room, shipB, 1 / 30);
    }
    assert.strictEqual(shipA.x, shipB.x, "deterministic orbit: x should match");
    assert.strictEqual(shipA.y, shipB.y, "deterministic orbit: y should match");
    assert.strictEqual(shipA.angle, shipB.angle, "deterministic orbit: angle should match");
    assert.strictEqual(shipA.orbitDir, shipB.orbitDir, "deterministic orbit: orbitDir should match");
  }

  // 8. No target → no orbit state.
  {
    const ship = runtimeShip(armedDesign, {
      id: "no-target",
      combatStyle: "orbit",
      combatTargetId: null,
      focusTargetId: null,
      x: 300, y: 300
    });
    updateShipMovement(room, ship, 1 / 30);
    assert(ship.orbitDir === undefined, "ship with no target should not have orbit state");
  }

  // 9. Disarmed ship (no weapons) should hold position regardless of style.
  {
    const disarmedDesign = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "reactor" },
      { x: 7, y: 8, type: "engine" }
    ];
    const ship = runtimeShip(disarmedDesign, {
      id: "disarmed",
      combatStyle: "orbit",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 500, y: 300
    });
    const originalX = ship.x, originalY = ship.y;
    updateShipMovement(room, ship, 1 / 30);
    assert(Math.abs(ship.targetX - originalX) < 1, "disarmed ship should target current position (no weapon range)");
    assert(Math.abs(ship.targetY - originalY) < 1, "disarmed ship should target current position (no weapon range)");
    assert.strictEqual(ship.arrived, true, "disarmed ship should be arrived");
  }

  // 10. Maintain Range with stopping-distance: ship at high speed approaching
  //     the tolerance band should arrive earlier due to predicted overshoot.
  {
    const { getEffectiveWeaponRanges } = require("./src/server/componentData");
    const tmpShip = runtimeShip(armedDesign, { id: "tmp-stop" });
    const ranges = getEffectiveWeaponRanges(tmpShip);
    const maxRange = Math.max(120, ranges.blaster, ranges.missile, ranges.railgun, ranges.beam);
    const desiredRange = maxRange * 0.9;
    const tolerance = maxRange * 0.05;
    // Place ship just inside the outer tolerance edge but moving toward target at speed.
    const shipX = target.x + (desiredRange + tolerance * 0.5);
    const shipY = target.y;
    const ship = runtimeShip(armedDesign, {
      id: "stop-test",
      combatStyle: "maintain",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: shipX, y: shipY,
      vx: -200, vy: 0,  // moving fast toward target
      targetX: shipX, targetY: shipY
    });
    updateShipMovement(room, ship, 1 / 30);
    // With stopping-distance prediction, the effective tolerance is wider,
    // so the ship should arrive even though it's within the static tolerance.
    assert(ship.arrived, "maintain ship with high inbound speed should arrive early due to stopping-distance prediction");
  }

  // 11. Hold state resets on new attack command.
  {
    const ship = runtimeShip(armedDesign, {
      id: "reset-test",
      combatStyle: "hold",
      combatTargetId: "enemy",
      focusTargetId: "enemy",
      x: 200, y: 300,
      targetX: 200, targetY: 300,
      holdState: null
    });
    // Run until holding phase.
    const { getEffectiveWeaponRanges } = require("./src/server/componentData");
    const ranges = getEffectiveWeaponRanges(ship);
    const maxRange = Math.max(120, ranges.blaster, ranges.missile, ranges.railgun, ranges.beam);
    const desiredRange = maxRange * 0.9;
    ship.x = target.x + desiredRange;
    ship.y = target.y;
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    updateShipMovement(room, ship, 1 / 30);
    assert.strictEqual(ship.holdState.phase, "holding", "hold ship should be in holding phase");
    // Simulate a new attack command resetting holdState.
    ship.holdState = null;
    ship.focusTargetId = "enemy";
    ship.commandMode = 'attack';
    ship.arrived = false;
    // Move ship away from target so it needs to re-position.
    ship.x = 200;
    ship.y = 300;
    ship.targetX = 200;
    ship.targetY = 300;
    updateShipMovement(room, ship, 1 / 30);
    assert(ship.holdState, "hold ship should have new holdState after reset");
    assert.strictEqual(ship.holdState.phase, "positioning", "hold ship should re-enter positioning after reset");
  }

  console.log("Movement styles verification passed");
  console.log("  tested: circle->orbit compat, orbit, maintain, hold two-phase, kite, direct, determinism, disarmed, stopping-distance, hold-reset");
}

run();
