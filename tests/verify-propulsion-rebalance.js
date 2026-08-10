"use strict";
// Propulsion rebalance acceptance tests for the reworked top-speed / acceleration split.
const assert = require("assert");
const { computeStats } = require("../src/server/shipStats");
const { PARTS } = require("../src/server/components");
const { calculateMovementStats } = require("../public/src/shared/movementStats.js");

function buildShip(engineCount, extraArmor = 0) {
  const modules = [];
  for (let i = 0; i < engineCount; i += 1) {
    modules.push({ x: i, y: 1, type: "engine" });
  }
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

function analyticalTravelTime(maxSpeed, accel, distance) {
  if (accel <= 0 || maxSpeed <= 0) return Infinity;
  const tToMax = maxSpeed / accel;
  const dToMax = 0.5 * accel * tToMax * tToMax;
  if (distance <= dToMax) return Math.sqrt(2 * distance / accel);
  return tToMax + (distance - dToMax) / maxSpeed;
}

function fmt(n) { return Number(n).toFixed(1); }

function run() {
  console.log("=== Propulsion Sweep ===");
  const sweep = [];
  let prev = null;
  for (let n = 1; n <= 6; n += 1) {
    const stats = computeStats(buildShip(n));
    const spd = Number(stats.maxSpeed || 0);
    const acc = Number(stats.accel || 0);
    const eff = Number(stats.engineEfficiency || 0);
    const tRatio = Number(stats.thrustRatio || 0);
    sweep.push({ n, mass: stats.mass, maxSpeed: spd, accel: acc, efficiency: eff, thrustRatio: tRatio });
    assert(stats.blockedEngines === 0, `n=${n}: engines blocked`);
    assert.strictEqual(stats.effectiveThrust, stats.thrust, `n=${n}: live engine thrust must stack linearly at full Power`);
    assert.strictEqual(stats.effectiveThrust, PARTS.engine.thrust * n, `n=${n}: effective thrust must equal the authored engine sum`);
    if (prev) {
      assert(spd >= prev.maxSpeed - 1e-6, `n=${n}: max speed dropped from ${prev.maxSpeed} to ${spd}`);
      assert(acc >= prev.accel - 1e-6, `n=${n}: acceleration dropped from ${prev.accel} to ${acc}`);
    }
    prev = { maxSpeed: spd, accel: acc };
  }
  for (const row of sweep) {
    console.log(`  engines=${row.n} mass=${row.mass}T maxSpeed=${fmt(row.maxSpeed)}m/s accel=${fmt(row.accel)}m/s² t/m=${fmt(row.thrustRatio)} eff=${(row.efficiency * 100).toFixed(0)}%`);
  }

  console.log("\n=== Representative Designs ===");
  const designs = [
    { name: "Scout (1 engine, no armor)", design: buildShip(1, 0) },
    { name: "Light fighter (2 engines, 1 armor)", design: buildShip(2, 1) },
    { name: "Interceptor (3 engines, 1 armor)", design: buildShip(3, 1) },
    { name: "Heavy interceptor (5 engines, 2 armor)", design: buildShip(5, 2) },
    { name: "Overloaded hull (1 engine, 4 armor)", design: buildShip(1, 4) }
  ];
  const rep = [];
  for (const d of designs) {
    const s = computeStats(d.design);
    rep.push({ name: d.name, mass: s.mass, maxSpeed: s.maxSpeed, accel: s.accel, thrustRatio: s.thrustRatio, efficiency: s.engineEfficiency });
    console.log(`  ${d.name.padEnd(38)} mass=${s.mass.toString().padStart(4)}T maxSpeed=${fmt(s.maxSpeed).padStart(6)}m/s accel=${fmt(s.accel).padStart(6)}m/s² t/m=${fmt(s.thrustRatio)}`);
  }

  console.log("\n=== Mass-boundary Continuity ===");
  const boundaryChecks = [
    { label: "Light boundary (54 vs 56 T)", low: buildShip(2, 1), high: buildShip(2, 2) },
    { label: "Medium boundary (124 vs 126 T)", low: buildShip(2, 7), high: buildShip(2, 8) },
    { label: "Heavy boundary (228 vs 232 T)", low: buildShip(2, 16), high: buildShip(2, 17) }
  ];
  for (const b of boundaryChecks) {
    const sLow = computeStats(b.low);
    const sHigh = computeStats(b.high);
    const speedDrop = (sLow.maxSpeed - sHigh.maxSpeed) / sLow.maxSpeed;
    console.log(`  ${b.label}: low=${sLow.mass}T/${fmt(sLow.maxSpeed)}m/s high=${sHigh.mass}T/${fmt(sHigh.maxSpeed)}m/s drop=${(speedDrop * 100).toFixed(1)}%`);
    assert(speedDrop < 0.10, `${b.label}: speed drop too large (${(speedDrop * 100).toFixed(1)}%)`);
  }

  console.log("\n=== Travel Simulation (analytical, seconds to cross) ===");
  const distances = [500, 1000, 2000];
  const travelDesigns = [
    { engines: 1, design: buildShip(1, 1) },
    { engines: 3, design: buildShip(3, 1) },
    { engines: 5, design: buildShip(5, 2) }
  ];
  const travel = [];
  for (const td of travelDesigns) {
    const s = computeStats(td.design);
    const row = { engines: td.engines };
    for (const dist of distances) {
      const t = analyticalTravelTime(s.maxSpeed, s.accel, dist);
      row[dist] = t;
      assert(Number.isFinite(t) && t > 0, `engine ${td.engines} failed to reach ${dist}m`);
    }
    travel.push(row);
    console.log(`  ${td.engines} engines: 500m=${row[500].toFixed(1)}s 1000m=${row[1000].toFixed(1)}s 2000m=${row[2000].toFixed(1)}s`);
  }
  // A dedicated speed build should pay off over longer distances.
  assert(travel[1][2000] < travel[0][2000], "3-engine ship should beat 1-engine ship over 2000m");
  assert(travel[2][2000] < travel[1][2000], "5-engine ship should beat 3-engine ship over 2000m");

  console.log("\n=== Server/Client Calculation Parity (via shared movementStats) ===");
  const check = computeStats(buildShip(3, 1));
  const movement = require("../public/src/shared/movementStats");
  const direct = movement.calculateMovementStats({
    mass: check.mass,
    thrust: check.thrust,
    turnBonus: 0,
    powerGeneration: check.powerGeneration,
    powerUse: check.powerUse,
    engineThrustValues: [227, 227, 227],
    engineMassValues: [4, 4, 4],
    turnModuleValues: [],
    directionalTurnInputs: null
  });
  assert(Math.abs(direct.maxSpeed - check.maxSpeed) < 1.0, "shared maxSpeed parity");
  assert(Math.abs(direct.accel - check.accel) < 1.0, "shared accel parity");
  console.log(`  maxSpeed server=${fmt(check.maxSpeed)} shared=${fmt(direct.maxSpeed)}`);
  console.log(`  accel    server=${fmt(check.accel)} shared=${fmt(direct.accel)}`);

  console.log("\nPropulsion rebalance verification passed ✓");
}

try { run(); } catch (err) { console.error(err); process.exit(1); }
