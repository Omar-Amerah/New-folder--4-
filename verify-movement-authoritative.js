"use strict";
// Long-running deterministic tests for the authoritative movement rewrite.
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { updateShipMovement, commandShips, createMovementIntent, nearestClearPoint, updateShipSeparation } = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");

const DT = 1 / 30;
function T(seconds) { return Math.round(seconds / DT); }

function runtimeShip(id, x, y, design, overrides = {}) {
  const stats = computeStats(design);
  const ship = {
    id, ownerId: "p1", alive: true, x, y, vx: 0, vy: 0, angle: 0,
    targetX: x, targetY: y, radius: stats.radius,
    design, wiring: createGeneratedPowerWiring(design), stats,
    combatStyle: "hold", focusTargetId: null, combatTargetId: null,
    ...overrides
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  ship.stats = stats;
  return ship;
}

function makeRoom(asteroids = []) {
  return { world: { width: 2000, height: 1600 }, map: { asteroids }, ships: new Map(), players: new Map() };
}

function addShip(room, player, ship) {
  player.ships.push(ship);
  room.ships.set(ship.id, ship);
}

function angleDifference(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function runAuthoritative() {
  global.__mfaMovePerf = {};

  // 1. Ships travel along their nose and nowhere else. Nothing aboard produces
  //    sideways thrust, so a ship changes course by turning, and its velocity
  //    stays on the hull axis. Maneuver thrusters buy turn rate, not strafing.
  {
    const room = makeRoom();
    const player = { id: "p1", team: "A", ships: [] };
    room.players.set("p1", player);
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "reactor" },
      { x: 7, y: 8, type: "engine" },
      { x: 6, y: 8, type: "maneuverThruster", rotation: 90 },
      { x: 8, y: 8, type: "maneuverThruster", rotation: 270 },
      { x: 6, y: 7, type: "blaster" }
    ];
    room.players.set("p2", { id: "p2", team: "B", ships: [] });
    const ship = runtimeShip("strafe", 300, 300, design, { combatStyle: "charge", focusTargetId: "enemy", combatTargetId: "enemy" });
    const enemy = { id: "enemy", ownerId: "p2", team: "B", alive: true, x: 800, y: 300, radius: 40, stats: {} };
    addShip(room, player, ship);
    room.ships.set("enemy", enemy);
    const startX = ship.x;
    let maximumHullAxisError = 0;
    for (let i = 0; i < T(10); i += 1) {
      updateShipMovement(room, ship, DT);
      if (Math.hypot(ship.vx, ship.vy) > 1) {
        maximumHullAxisError = Math.max(maximumHullAxisError, Math.abs(angleDifference(
          ship.angle,
          Math.atan2(ship.vy, ship.vx)
        )));
      }
      updateShipSeparation(room);
    }
    const distanceMovedX = ship.x - startX;
    assert(distanceMovedX > 50, `charging ship should close range (moved ${distanceMovedX.toFixed(1)} px)`);
    // Maneuver thrusters buy turn rate, not strafing: whatever the stance, the
    // velocity a ship builds up lies on its hull axis.
    assert(maximumHullAxisError < 0.2,
      `controller velocity should stay on the hull axis before collision impulses (error ${maximumHullAxisError.toFixed(3)})`);
    const bearingToEnemy = Math.atan2(enemy.y - ship.y, enemy.x - ship.x);
    assert(Math.abs(angleDifference(ship.angle, bearingToEnemy)) < 0.8,
      `a closing hull should keep its guns on the target (error ${Math.abs(angleDifference(ship.angle, bearingToEnemy)).toFixed(3)})`);
    console.log("  hull-axis-travel: passed");
  }


  // 2. Real pathfinding: a ship must navigate around a large asteroid.
  {
    const room = makeRoom([{ x: 1000, y: 300, radius: 150 }]);
    const player = { id: "p1", team: "A", ships: [] };
    room.players.set("p1", player);
    const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "reactor" }, { x: 7, y: 8, type: "engine" }];
    const ship = runtimeShip("path", 400, 300, design);
    addShip(room, player, ship);
    commandShips(room, player, 1600, 300, { shipIds: ["path"] });
    const targetX = ship.targetX;
    const targetY = ship.targetY;
    let minAsteroidDist = Infinity;
    let planHits = 0;
    let cacheHits = 0;
    for (let i = 0; i < T(40); i += 1) {
      updateShipMovement(room, ship, DT);
      const d = Math.hypot(ship.x - 1000, ship.y - 300) - 150;
      if (d < minAsteroidDist) minAsteroidDist = d;
      updateShipSeparation(room);
    }
    planHits = global.__mfaMovePerf.pathPlanCount || 0;
    cacheHits = global.__mfaMovePerf.pathCacheHitCount || 0;
    const finalDist = Math.hypot(ship.x - targetX, ship.y - targetY);
    assert.strictEqual(ship.movement.phase, "positioned",
      "pathfinding ship should arrive at target");
    assert(finalDist < 20, `arrival distance should be small (got ${finalDist.toFixed(1)})`);
    assert(minAsteroidDist > ship.radius * 0.5, `ship should keep a safe physical clearance from asteroid (min clearance ${minAsteroidDist.toFixed(1)})`);
    assert(planHits >= 1, "a path should be planned at least once");
    assert(cacheHits >= T(20) - 5, "waypoint path should be heavily cached after initial plan");
    console.log("  pathfinding-obstacle: passed");
  }

  // 3. Determinism: same initial state and command must produce identical results.
  {
    const makeScenario = () => {
      const room = makeRoom([{ x: 1000, y: 300, radius: 150 }]);
      const player = { id: "p1", team: "A", ships: [] };
      room.players.set("p1", player);
      const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "reactor" }, { x: 7, y: 8, type: "engine" }];
      const ship = runtimeShip("det", 400, 300, design);
      addShip(room, player, ship);
      commandShips(room, player, 1600, 300, { shipIds: ["det"] });
      return { room, ship };
    };
    const a = makeScenario();
    const b = makeScenario();
    for (let i = 0; i < T(15); i += 1) {
      updateShipMovement(a.room, a.ship, DT);
      updateShipMovement(b.room, b.ship, DT);
    }
    assert.strictEqual(a.ship.x, b.ship.x, "deterministic x");
    assert.strictEqual(a.ship.y, b.ship.y, "deterministic y");
    assert.strictEqual(a.ship.vx, b.ship.vx, "deterministic vx");
    assert.strictEqual(a.ship.vy, b.ship.vy, "deterministic vy");
    assert.strictEqual(a.ship.angle, b.ship.angle, "deterministic angle");
    console.log("  determinism: passed");
  }

  // 4. Braking-aware arrival: high-speed ship must stop cleanly at target.
  {
    const room = makeRoom();
    const player = { id: "p1", team: "A", ships: [] };
    room.players.set("p1", player);
    const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "reactor" }, { x: 7, y: 8, type: "engine" }];
    const ship = runtimeShip("brake", 100, 300, design, { vx: 120, vy: 0, angle: 0 });
    addShip(room, player, ship);
    commandShips(room, player, 1600, 300, { shipIds: ["brake"] });
    for (let i = 0; i < T(30); i += 1) {
      updateShipMovement(room, ship, DT);
      updateShipSeparation(room);
      if (i > T(5) && ship.movement.phase === "positioned") break;
    }
    assert.strictEqual(ship.movement.phase, "positioned",
      "braking ship should arrive");
    const speed = Math.hypot(ship.vx, ship.vy);
    assert(speed < 18, `arrival speed should be low (got ${speed.toFixed(1)})`);
    assert(ship.x >= 1580 && ship.x <= 1620, `ship should not overshoot target (x ${ship.x.toFixed(1)})`);
    console.log("  braking-arrival: passed");
  }

  // 5. Group move: ships receive nearby, non-overlapping slots and route independently.
  {
    const room = makeRoom();
    const player = { id: "p1", team: "A", ships: [] };
    room.players.set("p1", player);
    const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "reactor" }, { x: 7, y: 8, type: "engine" }];
    const a = runtimeShip("ga", 200, 300, design);
    const b = runtimeShip("gb", 300, 300, design);
    addShip(room, player, a);
    addShip(room, player, b);
    commandShips(room, player, 1000, 800, { shipIds: ["ga", "gb"] });
    assert(a.movement.command && b.movement.command, "group members must receive commands");
    assert.notStrictEqual(a.movement.command, b.movement.command, "group members own independent commands");
    assert(Math.hypot(
      a.movement.command.destination.x - b.movement.command.destination.x,
      a.movement.command.destination.y - b.movement.command.destination.y
    ) > 50, "group destination slots must not overlap");
    for (let i = 0; i < T(40); i += 1) {
      updateShipMovement(room, a, DT);
      updateShipMovement(room, b, DT);
      updateShipSeparation(room);
    }
    assert(a.movement.phase === "positioned" && b.movement.phase === "positioned",
      "both group ships should arrive");
    const dxEnd = b.x - a.x;
    const dyEnd = b.y - a.y;
    const separation = Math.hypot(dxEnd, dyEnd);
    assert(separation > 50, "group ships should not collapse into the same point");
    console.log("  group-slots: passed");
  }

  // 6. Blocked destination: command into an asteroid must resolve to a clear point.
  {
    const room = makeRoom([{ x: 1200, y: 800, radius: 120 }]);
    const player = { id: "p1", team: "A", ships: [] };
    room.players.set("p1", player);
    const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "reactor" }, { x: 7, y: 8, type: "engine" }];
    const ship = runtimeShip("block", 500, 800, design);
    addShip(room, player, ship);
    const inside = { x: 1200, y: 800 };
    const clear = nearestClearPoint(room, inside.x, inside.y, ship.radius + 12);
    assert(clear.adjusted, "nearestClearPoint should report an adjustment for a blocked point");
    assert(clear.clear, "nearestClearPoint should return a passable cell");
    commandShips(room, player, inside.x, inside.y, { shipIds: ["block"] });
    assert.strictEqual(ship.movement.command?.type, "move",
      "blocked move command should still become a move");
    const targetDistToAsteroid = Math.hypot(ship.targetX - inside.x, ship.targetY - inside.y);
    assert(targetDistToAsteroid >= 110, "ship target should be pushed outside the asteroid");
    for (let i = 0; i < T(40); i += 1) {
      updateShipMovement(room, ship, DT);
      updateShipSeparation(room);
    }
    assert.strictEqual(ship.movement.phase, "positioned",
      "ship should reach the adjusted clear target");
    console.log("  blocked-destination: passed");
  }

  // 7. Stable orbit: ship should stay near the orbit radius without spinning.
  {
    const room = makeRoom();
    const player = { id: "p1", team: "A", ships: [] };
    room.players.set("p1", player);
    room.players.set("p2", { id: "p2", team: "B", ships: [] });
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "reactor" },
      { x: 7, y: 8, type: "engine" },
      { x: 6, y: 7, type: "blaster" }
    ];
    const ship = runtimeShip("orbiter", 500, 300, design, { combatStyle: "orbit", focusTargetId: "target", combatTargetId: "target" });
    const target = { id: "target", ownerId: "p2", team: "B", alive: true, x: 900, y: 300, radius: 40, stats: {} };
    addShip(room, player, ship);
    room.ships.set("target", target);
    const desiredOrbitRange = createMovementIntent(room, ship, ship.stats, 0).desiredRange;
    let minRange = Infinity, maxRange = -Infinity, sumRange = 0, samples = 0;
    let lastAngle = ship.angle;
    let totalRotation = 0;
    for (let i = 0; i < T(20); i += 1) {
      updateShipMovement(room, ship, DT);
      const r = Math.hypot(ship.x - target.x, ship.y - target.y);
      if (r < minRange) minRange = r;
      if (r > maxRange) maxRange = r;
      sumRange += r;
      samples += 1;
      const delta = angleDifference(lastAngle, ship.angle);
      totalRotation += Math.abs(delta);
      lastAngle = ship.angle;
      updateShipSeparation(room);
    }
    const avgRange = sumRange / samples;
    assert(Math.abs(avgRange - desiredOrbitRange) < desiredOrbitRange * 0.25,
      `orbit should keep near desired radius (avg ${avgRange.toFixed(1)}, desired ${desiredOrbitRange.toFixed(1)})`);
    assert(maxRange - minRange < desiredOrbitRange * 0.8,
      `orbit range band should be reasonable (span ${(maxRange - minRange).toFixed(1)})`);
    assert(totalRotation < Math.PI * 12, `orbit should rotate in one direction (got ${totalRotation.toFixed(2)})`);
    assert(ship.movement.style.orbit?.direction === 1 || ship.movement.style.orbit?.direction === -1,
      "orbit direction should be committed");
    console.log("  stable-orbit: passed");
  }

  // 8. Hold range: ship should settle near 90% weapon range and stay.
  {
    const room = makeRoom();
    const player = { id: "p1", team: "A", ships: [] };
    room.players.set("p1", player);
    room.players.set("p2", { id: "p2", team: "B", ships: [] });
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "reactor" },
      { x: 7, y: 8, type: "engine" },
      { x: 6, y: 7, type: "blaster" }
    ];
    const ship = runtimeShip("hold", 200, 300, design, { combatStyle: "hold", focusTargetId: "target", combatTargetId: "target" });
    const target = { id: "target", ownerId: "p2", team: "B", alive: true, x: 900, y: 300, radius: 40, stats: {} };
    addShip(room, player, ship);
    room.ships.set("target", target);
    const ranges = require("./src/server/componentData").getEffectiveWeaponRanges(ship);
    const desiredRange = Math.max(120, ranges.blaster, ranges.missile, ranges.railgun, ranges.beam) * 0.9;
    for (let i = 0; i < T(5); i += 1) {
      updateShipMovement(room, ship, DT);
      updateShipSeparation(room);
    }
    let sumError = 0, samples = 0;
    for (let i = 0; i < T(10); i += 1) {
      updateShipMovement(room, ship, DT);
      const r = Math.hypot(ship.x - target.x, ship.y - target.y);
      sumError += Math.abs(r - desiredRange);
      samples += 1;
      updateShipSeparation(room);
    }
    const avgError = sumError / samples;
    assert(avgError < desiredRange * 0.12, `Hold range should stay close to desired (avg error ${avgError.toFixed(1)})`);
    console.log("  hold-range: passed");
  }

  console.log("Authoritative movement verification passed");
  console.log("Performance counters:", JSON.stringify(global.__mfaMovePerf));
}

runAuthoritative();
module.exports = { runAuthoritative };
