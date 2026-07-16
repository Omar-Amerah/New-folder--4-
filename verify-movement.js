"use strict";
// Group 1 acceptance: adding a powered engine must never reduce max speed,
// acceleration or effective thrust; unpowered/engineless ships cannot move or
// turn; engine stacking still shows diminishing efficiency.
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { segmentCircleClearance, commandShips, planFormation, updateShipMovement, updateShipSeparation, nearestClearPoint } = require("./src/server/movement");

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
    { x: 7, y: 8, type: "engine" },
    { x: 7, y: 6, type: "maneuverThruster", rotation: 90 }
  ]);
  const farThruster = computeStats([
    { x: 7, y: 7, type: "core" },
    { x: 8, y: 7, type: "reactor" },
    { x: 7, y: 8, type: "engine" },
    { x: 7, y: 6, type: "frame" },
    { x: 7, y: 5, type: "frame" },
    { x: 7, y: 4, type: "maneuverThruster", rotation: 90 }
  ]);
  // Main engines vector a little thrust for turning, so an engines-only ship
  // can rotate — but adding a maneuver thruster must make it noticeably faster.
  const enginesOnly = computeStats(buildShip(3));
  assert(enginesOnly.turnRate > 0, "a ship with only main engines should turn (slowly)");
  const enginesPlusThruster = computeStats([...buildShip(3), { x: 12, y: 7, type: "maneuverThruster" }]);
  assert(Math.max(enginesPlusThruster.turnRateLeft, enginesPlusThruster.turnRateRight) > enginesOnly.turnRate, `adding a maneuver thruster should raise at least one directional turn rate (engines=${enginesOnly.turnRate} left=${enginesPlusThruster.turnRateLeft} right=${enginesPlusThruster.turnRateRight})`);
  assert(enginesPlusThruster.turnRate === Math.min(enginesPlusThruster.turnRateLeft, enginesPlusThruster.turnRateRight), "turnRate remains the lower directional rate");
  assert(nearThruster.turnRateRight > 0 && farThruster.turnRateRight > 0, "thruster ships should be able to turn directionally");
  assert(farThruster.turnRateRight > nearThruster.turnRateRight, `a thruster far from the centre of mass should turn faster (near=${nearThruster.turnRateRight} far=${farThruster.turnRateRight})`);

  // 7. Asteroid route checks use the whole command segment, so a right-click
  // destination behind an asteroid is recognized before the ship noses into it.
  const blockedRoute = segmentCircleClearance(0, 0, 1000, 0, 500, 0, 120);
  const clearRoute = segmentCircleClearance(0, 0, 1000, 0, 500, 200, 120);
  assert(blockedRoute.blocked, "destination behind an asteroid should flag the route as blocked");
  assert(!clearRoute.blocked, "route outside asteroid clearance should remain clear");

  // 8. Command authorization semantics: omitted ids command all owned ships, but
  // an explicit empty or malformed selection never falls back to all ships.
  const room = { world: { width: 2000, height: 1600 }, map: { asteroids: [] }, ships: new Map(), players: new Map() };
  const player = { id: "p1", team: "blue", ships: [] };
  const enemy = { id: "p2", team: "red", ships: [] };
  room.players.set(player.id, player);
  room.players.set(enemy.id, enemy);
  for (const id of ["s1", "s2", "s10"]) {
    const ship = { id, ownerId: player.id, alive: true, x: 100, y: 100, vx: 0, vy: 0, angle: 0, radius: 40, stats: { accel: 0, maxSpeed: 0, turnRate: 0 }, design: [] };
    player.ships.push(ship);
    room.ships.set(id, ship);
  }
  const enemyShip = { id: "e1", ownerId: enemy.id, alive: true, x: 100, y: 100, vx: 0, vy: 0, angle: 0, radius: 40, stats: {}, design: [] };
  enemy.ships.push(enemyShip);
  room.ships.set(enemyShip.id, enemyShip);
  assert.strictEqual(commandShips(room, player, 500, 500, { shipIds: [] }).commanded, 0, "explicit empty selection should command no ships");
  assert.strictEqual(player.ships.filter((ship) => ship.targetX === 500).length, 0, "empty selection must not mutate all ships");
  assert.strictEqual(commandShips(room, player, 500, 500, { shipIds: ["s2", "e1", "s2"] }).commanded, 1, "mixed ids should command only owned live ships once");
  assert.strictEqual(enemyShip.targetX, undefined, "enemy ship must not be mutated by command");
  assert.strictEqual(commandShips(room, player, 700, 700, {}).commanded, 3, "omitted selection intentionally commands all owned live ships");
  assert.strictEqual(commandShips(room, player, 900, 900, { shipIds: Array.from({ length: 65 }, (_, i) => `s${i}`) }).ok, false, "oversized command arrays should be rejected");

  // 9. Formation planning is deterministic, stable under reversed selection order,
  // size-aware, centered, in bounds, and obstacle-adjusted without collapsing all slots.
  room.map.asteroids = [{ x: 1000, y: 800, radius: 100 }];
  player.ships[2].radius = 90;
  const planA = planFormation(room, player.ships, { x: 1000, y: 800, formation: "line" });
  const planB = planFormation(room, player.ships.slice().reverse(), { x: 1000, y: 800, formation: "line" });
  assert.deepStrictEqual(planA.slots.map((slot) => slot.shipId), planB.slots.map((slot) => slot.shipId), "formation assignment should not depend on selection order");
  assert(planA.slots.every((slot) => Number.isFinite(slot.x) && Number.isFinite(slot.y)), "formation slots must stay finite");
  assert(planA.slots.every((slot) => slot.x >= 42 && slot.x <= room.world.width - 42 && slot.y >= 42 && slot.y <= room.world.height - 42), "formation slots must stay in bounds");
  const uniqueSlotPositions = new Set(planA.slots.map((slot) => `${Math.round(slot.x)},${Math.round(slot.y)}`));
  assert(uniqueSlotPositions.size > 1, "obstacle adjustment must not collapse all slots to one point");
  const oneShip = planFormation(room, [player.ships[0]], { x: 300, y: 300, formation: "wedge" });
  assert(Math.hypot(oneShip.slots[0].x - 300, oneShip.slots[0].y - 300) < 1e-6, "one-ship formation targets requested clear location");

  // 10. Movement dt safety: non-positive/non-finite dt is ignored, large dt is
  // clamped/subdivided, and invalid state is sanitized back to finite values.
  const moving = { id: "m1", ownerId: player.id, alive: true, x: 200, y: 200, vx: 0, vy: 0, angle: 0, targetX: 1000, targetY: 200, radius: 35, stats: { accel: 120, maxSpeed: 180, turnRate: Math.PI }, design: [], componentHp: [] };
  updateShipMovement(room, moving, NaN);
  assert.strictEqual(moving.x, 200, "NaN dt should not move the ship");
  updateShipMovement(room, moving, 5);
  assert(Number.isFinite(moving.x) && Number.isFinite(moving.vx) && Math.hypot(moving.vx, moving.vy) <= moving.stats.maxSpeed + 1e-6, "large dt should remain finite and speed-capped");
  moving.x = Infinity;
  moving.vx = NaN;
  updateShipMovement(room, moving, 1 / 30);
  assert(Number.isFinite(moving.x) && Number.isFinite(moving.vx), "movement state should be sanitized to finite values");

  // 11. Exact-overlap separation uses a deterministic direction and converges.
  const overlapA = { id: "a", alive: true, x: 400, y: 400, vx: 0, vy: 0, radius: 40 };
  const overlapB = { id: "b", alive: true, x: 400, y: 400, vx: 0, vy: 0, radius: 40 };
  updateShipSeparation(room, [overlapB, overlapA], 1 / 30);
  assert(Math.hypot(overlapA.x - overlapB.x, overlapA.y - overlapB.y) > 0, "overlapped ships should separate deterministically");

  // 12. Nearest-clear-point reports metadata and clears all asteroid constraints when possible.
  const clear = nearestClearPoint(room, 1000, 800, 48);
  assert(clear.adjusted && clear.clear && clear.reason === "adjusted", "clear-point helper should expose successful adjustment metadata");

  console.log("Movement verification passed");
  console.log(`  speeds 1..8 engines: ${[1,2,3,4,5,6,7,8].map((n) => computeStats(buildShip(n)).maxSpeed).join(", ")}`);
  console.log(`  engine efficiency 1..8: ${efficiencies.map((e) => e.toFixed(2)).join(", ")}`);
}

run();
