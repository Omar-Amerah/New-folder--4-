"use strict";
// Group 1 acceptance: adding a powered engine must never reduce max speed,
// acceleration or effective thrust; unpowered/engineless ships cannot move or
// turn; engine stacking still shows diminishing efficiency.
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { segmentCircleClearance } = require("./src/server/movement");

// Build a design with `engineCount` engines (clear downward exhaust in their own
// columns) plus enough reactors to stay powered, a core, and optional dead mass.
function buildShip(engineCount, extraArmor = 0) {
  const modules = [];
  for (let i = 0; i < engineCount; i += 1) {
    modules.push({ x: i, y: 1, type: "engine" }); // footprint 1x2 -> (i,1),(i,2)
  }
  // Fixed, generous reactor bank so only engine count varies across the sweep
  // (3 reactors power 8+ engines) and the non-engine hull mass stays constant.
  const reactors = 3;
  for (let r = 0; r < reactors; r += 1) {
    modules.push({ x: 10 + (r % 2), y: 4 + Math.floor(r / 2), type: "reactor" });
  }
  modules.push({ x: 13, y: 13, type: "core" });
  for (let a = 0; a < extraArmor; a += 1) {
    modules.push({ x: 7 + (a % 3), y: 9 + Math.floor(a / 3), type: "armor" });
  }
  return modules;
}

function run() {
  // 1. No-engine invariants.
  const noEngine = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "reactor" }, { x: 6, y: 7, type: "blaster" }];
  const noEngineStats = computeStats(noEngine);
  assert.strictEqual(noEngineStats.maxSpeed, 0, "engineless ship should have 0 max speed");
  assert.strictEqual(noEngineStats.accel, 0, "engineless ship should have 0 acceleration");
  assert.strictEqual(noEngineStats.turnRate, 0, "engineless ship should have 0 turn rate");

  // Gyroscope alone (turn but no thrust) must not enable rotation.
  const gyroOnly = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "reactor" }, { x: 6, y: 7, type: "gyroscope" }];
  assert.strictEqual(computeStats(gyroOnly).turnRate, 0, "gyroscope without an engine should not rotate the ship");

  // 2. Monotonicity: adding a powered engine never worsens movement.
  let prev = null;
  const efficiencies = [];
  for (let n = 1; n <= 8; n += 1) {
    const stats = computeStats(buildShip(n));
    assert(stats.blockedEngines === 0, `n=${n}: engines should have clear exhaust (got ${stats.blockedEngines} blocked)`);
    assert(stats.powerGeneration >= stats.powerUse, `n=${n}: test ship should stay powered`);
    if (prev) {
      assert(stats.maxSpeed >= prev.maxSpeed - 1e-6, `n=${n}: max speed dropped (${prev.maxSpeed} -> ${stats.maxSpeed})`);
      assert(stats.accel >= prev.accel - 1e-6, `n=${n}: accel dropped (${prev.accel} -> ${stats.accel})`);
      assert(stats.effectiveThrust >= prev.effectiveThrust - 1e-6, `n=${n}: effective thrust dropped (${prev.effectiveThrust} -> ${stats.effectiveThrust})`);
    }
    efficiencies.push(stats.engineEfficiency);
    prev = stats;
  }

  // 3. Diminishing returns: per-engine efficiency should not increase.
  for (let i = 1; i < efficiencies.length; i += 1) {
    assert(efficiencies[i] <= efficiencies[i - 1] + 1e-6, `engine efficiency rose with more engines: ${efficiencies}`);
  }
  assert(efficiencies[efficiencies.length - 1] < efficiencies[0], "engine efficiency should fall as engines stack");

  // 4. Mass still matters: a heavier ship (dead armor mass) is not faster.
  const light = computeStats(buildShip(3, 0));
  const heavy = computeStats(buildShip(3, 12));
  assert(heavy.maxSpeed <= light.maxSpeed + 1e-6, "adding dead mass should not increase speed");
  assert(heavy.mass > light.mass, "armored ship should be heavier");

  // 5. Adding an engine to a heavy ship still improves it (heavy ships need more engines).
  const heavy1 = computeStats(buildShip(1, 16));
  const heavy2 = computeStats(buildShip(2, 16));
  assert(heavy2.maxSpeed >= heavy1.maxSpeed - 1e-6, "second engine should not slow a heavy ship");
  assert(heavy2.effectiveThrust > heavy1.effectiveThrust, "second engine should add effective thrust");

  // 6. Maneuvering torque: a thruster farther from the centre of mass turns the
  // ship faster than the same thruster placed near the centre.
  const nearThruster = computeStats([
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type: "reactor" },
    { x: 6, y: 7, type: "maneuverThruster" }
  ]);
  const farThruster = computeStats([
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type: "reactor" },
    { x: 1, y: 7, type: "maneuverThruster" }
  ]);
  // Main engines vector a little thrust for turning, so an engines-only ship
  // can rotate — but adding a maneuver thruster must make it noticeably faster.
  const enginesOnly = computeStats(buildShip(3));
  assert(enginesOnly.turnRate > 0, "a ship with only main engines should turn (slowly)");
  const enginesPlusThruster = computeStats([...buildShip(3), { x: 12, y: 7, type: "maneuverThruster" }]);
  assert(enginesPlusThruster.turnRate > enginesOnly.turnRate, `adding a maneuver thruster should raise turn rate (engines=${enginesOnly.turnRate} +thruster=${enginesPlusThruster.turnRate})`);
  assert(nearThruster.turnRate > 0 && farThruster.turnRate > 0, "thruster ships should be able to turn");
  assert(farThruster.turnRate > nearThruster.turnRate, `a thruster far from the centre of mass should turn faster (near=${nearThruster.turnRate} far=${farThruster.turnRate})`);

  // 7. Asteroid route checks use the whole command segment, so a right-click
  // destination behind an asteroid is recognized before the ship noses into it.
  const blockedRoute = segmentCircleClearance(0, 0, 1000, 0, 500, 0, 120);
  const clearRoute = segmentCircleClearance(0, 0, 1000, 0, 500, 200, 120);
  assert(blockedRoute.blocked, "destination behind an asteroid should flag the route as blocked");
  assert(!clearRoute.blocked, "route outside asteroid clearance should remain clear");

  console.log("Movement verification passed");
  console.log(`  speeds 1..8 engines: ${[1,2,3,4,5,6,7,8].map((n) => computeStats(buildShip(n)).maxSpeed).join(", ")}`);
  console.log(`  engine efficiency 1..8: ${efficiencies.map((e) => e.toFixed(2)).join(", ")}`);
}

run();
