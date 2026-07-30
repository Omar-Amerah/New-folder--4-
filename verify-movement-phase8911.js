"use strict";

// Phases 8 to 11.
//
// Phase 8  -- automatic nearest-enemy acquisition, bounded by weapon reach and
//             sticky enough not to swap targets every tick.
// Phase 9  -- Hold: approach to 90% of reach, stop, face, fire. 90% is a
//             threshold to cross, not a range to maintain.
// Phase 10 -- the command priority ladder and the transitions between states.
// Phase 11 -- a group attacking one target forms a firing line, not a ring.

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  rotateShips,
  stopShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { findTarget } = require("./src/server/combat");
const { sanitizeCombatStyle } = require("./src/server/validation");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { getMaxEffectiveWeaponRange } = require("./src/server/componentData");
const { HOLD_RANGE_RATIO, HOLD_RESUME_RATIO, ARRIVE_DISTANCE } = require("./src/server/movementTuning");

const DT = 1 / 30;

const ARMED_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];
const UNARMED_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

let shipSeq = 0;

function makeShip(x, y, angle = 0, design = ARMED_DESIGN, ownerId = "p1") {
  const stats = computeStats(design);
  const ship = {
    id: `s${String(++shipSeq).padStart(3, "0")}`,
    ownerId,
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: computeDesignCollisionRadius(design, stats),
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: "hold",
    weaponAngles: [],
    weaponCooldowns: [],
    desiredAngles: [],
    aimTargetIds: [],
    componentTargetIds: [],
    beamContacts: []
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function makeScenario(groups, options = {}) {
  const players = new Map();
  const ships = [];
  for (const [id, list] of Object.entries(groups)) {
    players.set(id, { id, team: id === "p1" ? "A" : "B", ships: list });
    ships.push(...list);
  }
  const room = {
    world: { width: 12000, height: 8000 },
    map: { asteroids: options.asteroids || [] },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players,
    stations: options.stations || [],
    stationsById: new Map((options.stations || []).map((s) => [s.id, s])),
    drones: new Map(),
    effects: []
  };
  buildRoomSpatialIndex(room, ships, 0);
  return { room, ships, players };
}

function simulate(room, ships, seconds, onTick = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    const now = tick * DT * 1000;
    buildRoomSpatialIndex(room, ships, now);
    for (const ship of ships) updateShipMovement(room, ship, DT, now);
    updateShipSeparation(room, ships, DT, now);
    if (onTick) onTick(tick, now);
  }
}

function speedOf(ship) {
  return Math.hypot(ship.vx, ship.vy);
}

function rangeTo(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function facingError(ship, target) {
  const bearing = Math.atan2(target.y - ship.y, target.x - ship.x);
  let delta = ship.angle - bearing;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

function run() {
  // =======================================================================
  // Phase 8 -- automatic acquisition
  // =======================================================================

  // No explicit target: pick the nearest valid enemy that is actually within
  // reach.
  {
    const hunter = makeShip(2000, 2000);
    const near = makeShip(2000 + 200, 2000, 0, UNARMED_DESIGN, "p2");
    const far = makeShip(2000 + 340, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships } = makeScenario({ p1: [hunter], p2: [near, far] });
    const picked = findTarget(room, hunter, ships);
    assert(picked, "a ship with no explicit target should acquire one");
    assert.strictEqual(picked.id, near.id, "it should acquire the nearest valid enemy");
  }

  // Ships do not detect enemies across the map: acquisition is bounded by what
  // the ship can actually shoot.
  {
    const hunter = makeShip(2000, 2000);
    const reach = getMaxEffectiveWeaponRange(hunter);
    assert(reach > 0 && reach < 4000, `the fixture should have a bounded reach (${reach})`);
    const distant = makeShip(2000 + reach * 4, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships } = makeScenario({ p1: [hunter], p2: [distant] });
    assert.strictEqual(findTarget(room, hunter, ships), null,
      "an enemy far beyond weapon reach must not be acquired");

    // ...and the acquisition margin is small, not unbounded.
    const marginal = makeShip(2000 + reach * 1.6, 2000, 0, UNARMED_DESIGN, "p2");
    const scenario = makeScenario({ p1: [hunter], p2: [marginal] });
    assert.strictEqual(findTarget(scenario.room, hunter, scenario.ships), null,
      "acquisition range should be close to weapon range, not a multiple of it");
  }

  // Hidden enemies are not selected.
  {
    const hunter = makeShip(2000, 2000);
    const hidden = makeShip(2200, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships } = makeScenario({ p1: [hunter], p2: [hidden] });
    // Sensor fog: make the room use visibility and hide the enemy from A.
    room.rules = { sensorFog: true };
    room.visibility = { generation: 1 };
    hidden.alive = true;
    const before = findTarget(room, hunter, ships);
    assert(before, "sanity: the enemy is acquirable while visible");
    hidden.alive = false; // the simplest "not a valid combat target" there is
    assert.strictEqual(findTarget(room, hunter, ships), null,
      "an invalid enemy must not be acquired");
  }

  // Target persistence: a marginally closer enemy does not steal the lock.
  {
    const hunter = makeShip(2000, 2000);
    const locked = makeShip(2200, 2000, 0, UNARMED_DESIGN, "p2");
    const interloper = makeShip(2190, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships } = makeScenario({ p1: [hunter], p2: [locked, interloper] });
    hunter.combatTargetId = locked.id;
    for (let i = 0; i < 20; i += 1) {
      const picked = findTarget(room, hunter, ships);
      assert.strictEqual(picked?.id, locked.id,
        "a marginally closer enemy must not take the lock every tick");
      hunter.combatTargetId = picked ? picked.id : null;
    }
  }

  // ...but a target that leaves the envelope substantially is released.
  {
    const hunter = makeShip(2000, 2000);
    const runner = makeShip(2200, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships } = makeScenario({ p1: [hunter], p2: [runner] });
    hunter.combatTargetId = runner.id;
    assert.strictEqual(findTarget(room, hunter, ships)?.id, runner.id, "sanity: locked");
    runner.x = 2000 + getMaxEffectiveWeaponRange(hunter) * 3;
    buildRoomSpatialIndex(room, ships, 0);
    assert.strictEqual(findTarget(room, hunter, ships), null,
      "a target well outside the envelope should be released");
  }

  // Targeting alone does not move the ship: with no combat style able to act on
  // it, a ship handed a target stays exactly where it is.
  {
    const hunter = makeShip(2000, 2000);
    const enemy = makeShip(2600, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships } = makeScenario({ p1: [hunter], p2: [enemy] });
    hunter.combatStyle = "static";
    hunter.combatTargetId = enemy.id;
    const start = { x: hunter.x, y: hunter.y };
    simulate(room, ships, 5);
    assert(Math.hypot(hunter.x - start.x, hunter.y - start.y) < 1,
      "a target alone must not cause movement without a stance that acts on it");
  }

  // Withdrawn stances migrate to Hold rather than leaving a ship unflyable.
  {
    assert.strictEqual(sanitizeCombatStyle("charge"), "hold", "Charge should migrate to Hold");
    assert.strictEqual(sanitizeCombatStyle("orbit"), "hold", "Orbit should migrate to Hold");
    assert.strictEqual(sanitizeCombatStyle("kite"), "hold", "Kite should migrate to Hold");
    assert.strictEqual(sanitizeCombatStyle("hold"), "hold");
  }

  // =======================================================================
  // Phase 9 -- Hold
  // =======================================================================

  // Approach to roughly 90% of reach, stop, and face the enemy.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    const reach = getMaxEffectiveWeaponRange(attacker);
    const hold = reach * HOLD_RANGE_RATIO;

    simulate(room, ships, 45);
    const settled = rangeTo(attacker, enemy);
    assert(Math.abs(settled - hold) < hold * 0.25,
      `should settle near 90% of reach (${settled.toFixed(0)} px vs a hold range of ${hold.toFixed(0)})`);
    assert(speedOf(attacker) < 2, `should stop (${speedOf(attacker).toFixed(1)} px/s)`);
    assert(facingError(attacker, enemy) < 0.1,
      `should face the enemy (${(facingError(attacker, enemy) * 180 / Math.PI).toFixed(1)} deg off)`);

    // It does not ram: it stopped well outside contact.
    assert(settled > attacker.physicalRadius + enemy.physicalRadius + 50,
      `should not ram (${settled.toFixed(0)} px)`);

    // It does not constantly correct its exact range, and it does not orbit.
    let drift = 0;
    let sweep = 0;
    let previousBearing = Math.atan2(enemy.y - attacker.y, enemy.x - attacker.x);
    simulate(room, ships, 25, () => {
      drift = Math.max(drift, Math.abs(rangeTo(attacker, enemy) - settled));
      const bearing = Math.atan2(enemy.y - attacker.y, enemy.x - attacker.x);
      let delta = bearing - previousBearing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      sweep += Math.abs(delta);
      previousBearing = bearing;
    });
    assert(drift < 2, `should not fidget with its range once established (${drift.toFixed(2)} px of drift)`);
    assert(sweep < 0.05, `should not orbit (${sweep.toFixed(3)} rad swept around the enemy)`);
  }

  // It does not retreat from an enemy that closes on it.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 45);
    const parked = { x: attacker.x, y: attacker.y };

    // Walk the enemy right up to the attacker -- but not past it, or the chase
    // that follows is legitimate rather than a retreat.
    const contact = attacker.physicalRadius + enemy.physicalRadius;
    for (let step = 0; step < 120 && rangeTo(attacker, enemy) > contact * 1.6; step += 1) {
      enemy.x -= 20;
      simulate(room, ships, 4 * DT);
    }
    assert(rangeTo(attacker, enemy) < contact * 2,
      `sanity: the enemy should have closed right up (${rangeTo(attacker, enemy).toFixed(0)} px)`);
    assert(Math.hypot(attacker.x - parked.x, attacker.y - parked.y) < 12,
      `Hold must not back away from an approaching enemy (moved ${Math.hypot(attacker.x - parked.x, attacker.y - parked.y).toFixed(1)} px)`);
    assert(facingError(attacker, enemy) < 0.15, "it should still be facing the enemy");
  }

  // It follows an enemy that runs beyond range, and stops again once back in it.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(4000, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 45);
    const reach = getMaxEffectiveWeaponRange(attacker);
    assert(speedOf(attacker) < 2, "sanity: engaged and stopped");

    // The enemy runs well clear.
    enemy.x += reach * 1.5;
    let moved = false;
    simulate(room, ships, 8, () => { if (speedOf(attacker) > 40) moved = true; });
    assert(moved, "Hold should chase a target that has run beyond the buffer");

    simulate(room, ships, 60);
    const regained = rangeTo(attacker, enemy);
    assert(Math.abs(regained - reach * HOLD_RANGE_RATIO) < reach * 0.25,
      `it should stop again at hold range (${regained.toFixed(0)} px)`);
    assert(speedOf(attacker) < 2, "it should come to rest again after regaining range");
  }

  // Hysteresis: a target loitering between the two thresholds does not make the
  // ship start and stop repeatedly.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(4000, 2000, 0, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 45);
    const reach = getMaxEffectiveWeaponRange(attacker);
    assert(HOLD_RESUME_RATIO > HOLD_RANGE_RATIO, "the two thresholds must differ");

    // Park the enemy between the enter and resume thresholds and jiggle it.
    let starts = 0;
    let wasMoving = false;
    for (let step = 0; step < 80; step += 1) {
      const ratio = (HOLD_RANGE_RATIO + HOLD_RESUME_RATIO) / 2;
      enemy.x = attacker.x + reach * ratio + (step % 2 === 0 ? 6 : -6);
      simulate(room, ships, 3 * DT, () => {
        const moving = speedOf(attacker) > 20;
        if (moving && !wasMoving) starts += 1;
        wasMoving = moving;
      });
    }
    assert(starts === 0,
      `a target inside the dead band must not restart the approach (${starts} starts)`);
  }

  // Hold uses pathfinding: an asteroid between attacker and enemy is routed
  // around, not driven through.
  {
    const asteroids = [{ x: 2400, y: 2000, radius: 340 }];
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(4200, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] }, { asteroids });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    let worst = Infinity;
    simulate(room, ships, 70, () => {
      worst = Math.min(worst, Math.hypot(attacker.x - asteroids[0].x, attacker.y - asteroids[0].y)
        - asteroids[0].radius - attacker.physicalRadius);
    });
    assert(worst > 5, `Hold should route around obstacles (closest ${worst.toFixed(1)} px)`);
    const reach = getMaxEffectiveWeaponRange(attacker);
    assert(rangeTo(attacker, enemy) < reach,
      `it should still reach a firing position (${rangeTo(attacker, enemy).toFixed(0)} px)`);
  }

  // Automatic target: Hold engages without any explicit order at all.
  {
    const attacker = makeShip(1000, 2000, 0);
    const reach = getMaxEffectiveWeaponRange(attacker);
    const enemy = makeShip(1000 + reach * 0.95, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships } = makeScenario({ p1: [attacker], p2: [enemy] });
    assert.strictEqual(attacker.movement, undefined, "no order has been issued");
    // Combat publishes its acquisition on the ship; movement only reads it.
    attacker.combatTargetId = enemy.id;
    simulate(room, ships, 40);
    assert(facingError(attacker, enemy) < 0.15,
      "a ship with an automatic target should face it");
    assert(rangeTo(attacker, enemy) <= reach,
      `it should be within firing range (${rangeTo(attacker, enemy).toFixed(0)} px of ${reach.toFixed(0)})`);
  }

  // =======================================================================
  // Phase 10 -- command priority and transitions
  // =======================================================================

  // Move overrides Hold: an engaged ship sent somewhere goes there.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 45);
    assert(speedOf(attacker) < 2, "sanity: engaged and stopped");

    commandShips(room, players.get("p1"), 1200, 5000, { shipIds: [attacker.id] });
    assert.strictEqual(attacker.movement.command.type, "move", "a Move should replace the attack order");
    simulate(room, ships, 60);
    assert(Math.hypot(attacker.x - 1200, attacker.y - 5000) <= ARRIVE_DISTANCE + 8,
      `Move should win over Hold (${Math.hypot(attacker.x - 1200, attacker.y - 5000).toFixed(1)} px away)`);
  }

  // Stop cancels movement but the ship may still face and fire at its target.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(5000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 4);
    assert(speedOf(attacker) > 50, "sanity: closing on the target");

    stopShips(room, players.get("p1"), [attacker.id]);
    simulate(room, ships, 20);
    assert(speedOf(attacker) === 0, "Stop should bring the ship to rest");
    const parked = { x: attacker.x, y: attacker.y };
    simulate(room, ships, 20);
    assert(Math.hypot(attacker.x - parked.x, attacker.y - parked.y) < 1e-6,
      "a stopped ship must not resume the approach on its own");
    assert.strictEqual(attacker.focusTargetId, enemy.id,
      "Stop should not clear the explicit target -- the ship can still shoot it");
  }

  // Target destroyed: the explicit target clears and the ship remains stopped
  // rather than driving on to where the target used to be.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(5000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 5);
    enemy.alive = false;
    simulate(room, ships, 1);
    assert.strictEqual(attacker.movement.command, null, "the order should clear with the target");
    assert.strictEqual(attacker.focusTargetId, null, "the explicit target should clear");
    simulate(room, ships, 20);
    assert(speedOf(attacker) < 2, "it should coast to a halt, not carry on");
  }

  // I/O overrides facing without deleting the order underneath it.
  {
    const attacker = makeShip(1000, 2000, 0);
    const enemy = makeShip(5000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: [attacker.id],
      targetId: enemy.id
    });
    simulate(room, ships, 3);
    rotateShips(room, players.get("p1"), { direction: 1, active: true, shipIds: [attacker.id] });
    simulate(room, ships, 1);
    assert.strictEqual(attacker.movement.command.type, "attack",
      "manual rotation must not delete the underlying order");
    assert.strictEqual(attacker.focusTargetId, enemy.id, "nor the explicit target");
    rotateShips(room, players.get("p1"), { direction: 1, active: false, shipIds: [attacker.id] });
    simulate(room, ships, 60);
    assert(facingError(attacker, enemy) < 0.15,
      "releasing the key should return the ship to its engagement");
  }

  // =======================================================================
  // Phase 11 -- group Hold
  // =======================================================================

  {
    const attackers = [];
    for (let i = 0; i < 6; i += 1) attackers.push(makeShip(1000, 1400 + i * 150, 0));
    const enemy = makeShip(5200, 2200, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: attackers, p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: attackers.map((s) => s.id),
      targetId: enemy.id
    });

    // Every ship gets its own place on the line.
    const laterals = attackers.map((ship) => ship.movement.command.firingLateral);
    assert.strictEqual(new Set(laterals).size, attackers.length,
      "each ship should get a distinct place on the firing line");

    let sweep = 0;
    let previous = attackers.map((ship) => Math.atan2(enemy.y - ship.y, enemy.x - ship.x));
    // Long enough for the whole group to cross 4000 px and settle on the line.
    simulate(room, ships, 120, () => {
      attackers.forEach((ship, index) => {
        const bearing = Math.atan2(enemy.y - ship.y, enemy.x - ship.x);
        let delta = bearing - previous[index];
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        sweep = Math.max(sweep, Math.abs(delta));
        previous[index] = bearing;
      });
    });

    // Not stacked. Side by side is fine and expected -- a ship already in range
    // stops where it stands rather than relocating to tidy the line, so pairs
    // can settle in contact and are held apart by separation. What must not
    // happen is hulls inside one another, or the whole group collapsing onto one
    // point.
    for (let i = 0; i < attackers.length; i += 1) {
      for (let j = i + 1; j < attackers.length; j += 1) {
        const gap = Math.hypot(attackers[i].x - attackers[j].x, attackers[i].y - attackers[j].y);
        assert(gap >= attackers[i].physicalRadius + attackers[j].physicalRadius - 1,
          `six ships attacking one target must not overlap (${gap.toFixed(1)} px apart)`);
      }
    }
    const groupCentre = {
      x: attackers.reduce((sum, ship) => sum + ship.x, 0) / attackers.length,
      y: attackers.reduce((sum, ship) => sum + ship.y, 0) / attackers.length
    };
    const extent = Math.max(...attackers.map((ship) =>
      Math.hypot(ship.x - groupCentre.x, ship.y - groupCentre.y)));
    assert(extent > attackers[0].physicalRadius * 3,
      `the group should be spread across a firing formation, not piled up (${extent.toFixed(0)} px across)`);
    // All stopped, all facing the enemy, none of them orbiting it.
    for (const ship of attackers) {
      assert(speedOf(ship) < 3, `${ship.id} should stop in its firing position`);
      assert(facingError(ship, enemy) < 0.2, `${ship.id} should face the target`);
    }
    // A line, not a ring: every ship should be on broadly the same side of the
    // target. Measured as a circular spread about the mean bearing, because the
    // group sits astride the +/-PI seam and a plain max-minus-min there reports
    // a 348 degree arc for six ships standing shoulder to shoulder.
    const bearings = attackers.map((ship) => Math.atan2(ship.y - enemy.y, ship.x - enemy.x));
    const meanBearing = Math.atan2(
      bearings.reduce((sum, b) => sum + Math.sin(b), 0),
      bearings.reduce((sum, b) => sum + Math.cos(b), 0)
    );
    const spread = 2 * Math.max(...bearings.map((b) => {
      let delta = b - meanBearing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return Math.abs(delta);
    }));
    assert(spread < Math.PI / 2,
      `the group should form a firing line, not a ring (${(spread * 180 / Math.PI).toFixed(0)} deg of arc)`);
  }

  // Ships already in range do not shuffle to tidy the formation.
  {
    const attackers = [];
    const enemy = makeShip(3000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const reach = getMaxEffectiveWeaponRange(makeShip(0, 0));
    for (let i = 0; i < 4; i += 1) {
      attackers.push(makeShip(3000 - reach * 0.7, 1800 + i * 120, 0));
    }
    const { room, ships, players } = makeScenario({ p1: attackers, p2: [enemy] });
    const before = attackers.map((ship) => ({ x: ship.x, y: ship.y }));
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: attackers.map((s) => s.id),
      targetId: enemy.id
    });
    simulate(room, ships, 25);
    for (let i = 0; i < attackers.length; i += 1) {
      const moved = Math.hypot(attackers[i].x - before[i].x, attackers[i].y - before[i].y);
      assert(moved < 60,
        `a ship already in range should not relocate to tidy the line (${attackers[i].id} moved ${moved.toFixed(1)} px)`);
    }
  }

  console.log("verify-movement-phase8911: OK");
}

run();
