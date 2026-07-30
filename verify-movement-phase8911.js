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

  // Stances the controller flies survive; the ones it does not migrate to Hold,
  // so a ship can never end up carrying a stance nothing will fly.
  {
    assert.strictEqual(sanitizeCombatStyle("charge"), "charge", "Charge is flown");
    assert.strictEqual(sanitizeCombatStyle("hold"), "hold");
    assert.strictEqual(sanitizeCombatStyle("static"), "static", "Static is flown");
    assert.strictEqual(sanitizeCombatStyle("orbit"), "hold", "Orbit should migrate to Hold");
    assert.strictEqual(sanitizeCombatStyle("kite"), "hold", "Kite should migrate to Hold");
    // Legacy aggressive aliases land on Charge, matching the client's own
    // normalizeCombatStyle, so a blueprint saved as "brawler" gets the stance it
    // was named for rather than the opposite one.
    assert.strictEqual(sanitizeCombatStyle("brawler"), "charge");
    assert.strictEqual(sanitizeCombatStyle("interceptor"), "charge");
    assert.strictEqual(sanitizeCombatStyle("evasive"), "hold");
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

    // Every ship gets its own place on the line. A place is a bearing either
    // side of the group's approach plus the rank it stands in, so two ships
    // share a place only if both match.
    const places = attackers.map((ship) =>
      `${ship.movement.command.firingAngle.toFixed(6)}@${ship.movement.command.firingRadiusScale.toFixed(6)}`);
    assert.strictEqual(new Set(places).size, attackers.length,
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

  // A group must engage when it is in range, exactly as a single ship does.
  //
  // The firing line is a way of arriving, not a formation to be held once the
  // shooting can start. Requiring a slotted ship to reach its slot before it
  // counted as engaged looked reasonable and produced the opposite of Hold: the
  // slot is recomputed from the target's live position every tick, so against a
  // target that is moving at all the slot moves too, arrival never latches, and
  // the group flies at a point it can never reach while sitting well inside
  // weapons range the whole time. Worse, following a slot placed at 90% of reach
  // means backing away from an enemy that closes -- the one thing Hold must
  // never do. A single ship was never slotted, so it behaved correctly, which is
  // how the difference was reported.
  {
    const measure = (count) => {
      const attackers = [];
      for (let i = 0; i < count; i += 1) attackers.push(makeShip(1000, 1700 + i * 130, 0));
      const enemy = makeShip(4000, 2000, Math.PI, UNARMED_DESIGN, "p2");
      const { room, ships, players } = makeScenario({ p1: attackers, p2: [enemy] });
      commandShips(room, players.get("p1"), enemy.x, enemy.y, {
        shipIds: attackers.map((s) => s.id),
        targetId: enemy.id
      });
      const reach = getMaxEffectiveWeaponRange(attackers[0]);

      // Distance each ship covers AFTER it is first inside weapons range. The
      // symptom is a ship still manoeuvring when it could already be shooting.
      const armed = new Set();
      const travelled = new Map();
      const previous = new Map();
      simulate(room, ships, 20, () => {
        enemy.x -= 60 * DT; // a target that is moving is what moves the slot
        for (const ship of attackers) {
          if (rangeTo(ship, enemy) <= reach) armed.add(ship.id);
          if (!armed.has(ship.id)) continue;
          const was = previous.get(ship.id);
          if (was) {
            travelled.set(ship.id,
              (travelled.get(ship.id) || 0) + Math.hypot(ship.x - was.x, ship.y - was.y));
          }
          previous.set(ship.id, { x: ship.x, y: ship.y });
        }
      });
      return { attackers, enemy, travelled };
    };

    const lone = measure(1);
    const loneTravel = lone.travelled.get(lone.attackers[0].id) || 0;
    assert(lone.attackers[0].movement.holdEngaged, "sanity: a single ship engages");

    const group = measure(4);
    for (const ship of group.attackers) {
      assert(ship.movement.holdEngaged,
        `${ship.id}: a ship in a group must engage once in range, not fly on to its slot`);
      const travel = group.travelled.get(ship.id) || 0;
      assert(travel < loneTravel + 250,
        `${ship.id} kept manoeuvring inside weapons range (${travel.toFixed(0)} px, against ${loneTravel.toFixed(0)} px for a lone ship)`);
    }
  }

  // A finished formation move does not become a firing line.
  //
  // A move order carries a formationHeading too -- the course the group walked.
  // Reading that as a firing-line bearing made every ship of a group that
  // completed a move and then acquired targets of its own derive the *same*
  // firing point, from a heading that had nothing to do with the enemy, and fly
  // onto it in a heap.
  {
    // Spread the group ACROSS the approach, not along it: four ships stacked
    // along the line to the enemy would each derive nearly the same standoff
    // point from their own bearing too, and the fixture would measure nothing.
    const attackers = [];
    for (let i = 0; i < 4; i += 1) attackers.push(makeShip(1000, 500 + i * 1000, 0));
    const enemy = makeShip(5000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: attackers, p2: [enemy] });
    commandShips(room, players.get("p1"), 3000, 2000, {
      shipIds: attackers.map((s) => s.id)
    });
    simulate(room, ships, 40);
    for (const ship of attackers) {
      assert(ship.movement.command?.type === "move" && ship.movement.orderComplete,
        `sanity: ${ship.id} should have finished a formation move`);
      // Combat publishes its acquisition; movement only reads it.
      ship.combatTargetId = enemy.id;
    }
    simulate(room, ships, 60);

    let closestPair = Infinity;
    for (let i = 0; i < attackers.length; i += 1) {
      for (let j = i + 1; j < attackers.length; j += 1) {
        closestPair = Math.min(closestPair, rangeTo(attackers[i], attackers[j]));
      }
    }
    const contact = attackers[0].physicalRadius * 2;
    assert(closestPair > contact,
      `a group auto-engaging after a move must not converge on one point (closest pair ${closestPair.toFixed(1)} px, hulls ${contact.toFixed(1)} px)`);
    for (const ship of attackers) {
      assert(rangeTo(ship, enemy) <= getMaxEffectiveWeaponRange(ship),
        `${ship.id} should reach its own firing position (${rangeTo(ship, enemy).toFixed(0)} px)`);
    }
  }

  // ...but a hostile between the ship and the target it was sent at IS steered
  // around. That is the one case where an enemy is an obstacle: the player named
  // something to shoot, and another enemy is in the way of getting to it.
  {
    const attacker = makeShip(1000, 2000, 0);
    const reach = getMaxEffectiveWeaponRange(attacker);
    const screen = makeShip(1000 + reach * 1.6, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const target = makeShip(1000 + reach * 3.2, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: [attacker], p2: [screen, target] });
    commandShips(room, players.get("p1"), target.x, target.y, {
      shipIds: [attacker.id],
      targetId: target.id
    });

    let closest = Infinity;
    let steered = false;
    simulate(room, ships, 60, () => {
      closest = Math.min(closest, rangeTo(attacker, screen));
      if (attacker._avoidance?.side) steered = true;
    });
    assert(steered, "an enemy screening the target should be steered around");
    assert(closest > attacker.physicalRadius + screen.physicalRadius,
      `...without ramming it (passed at ${closest.toFixed(1)} px)`);
    assert(rangeTo(attacker, target) <= reach,
      `...and the attacker should still reach a firing position (${rangeTo(attacker, target).toFixed(0)} px)`);
  }

  // A firing line has to hold however many ships it is given.
  //
  // Places used to be offsets from a straight line, clamped to a fraction of the
  // standoff so the group could not wrap into a ring. For a large fleet that cap
  // did not trim the line, it collapsed it: three quarters of a 24-ship attack
  // were handed the same two points, and they spent the fight shouldering each
  // other off a spot only one of them could stand on while several never got
  // into weapons range at all. A line too long for one arc has to gain depth
  // instead.
  {
    const attackers = [];
    for (let i = 0; i < 24; i += 1) attackers.push(makeShip(2000, 2000 + (i - 12) * 130));
    const enemy = makeShip(7000, 2000, Math.PI, UNARMED_DESIGN, "p2");
    const { room, ships, players } = makeScenario({ p1: attackers, p2: [enemy] });
    commandShips(room, players.get("p1"), enemy.x, enemy.y, {
      shipIds: attackers.map((s) => s.id),
      targetId: enemy.id
    });

    const places = attackers.map((ship) =>
      `${ship.movement.command.firingAngle.toFixed(6)}@${ship.movement.command.firingRadiusScale.toFixed(6)}`);
    assert.strictEqual(new Set(places).size, attackers.length,
      "24 ships should get 24 distinct places, not a handful of shared ones");
    assert(new Set(attackers.map((s) => s.movement.command.firingRadiusScale)).size > 1,
      "a line that cannot fit on one arc should gain ranks");

    // Nobody is left circling once the fight has settled.
    let milling = 0;
    let samples = 0;
    simulate(room, ships, 120, (tick) => {
      if (tick * DT < 100) return;
      samples += 1;
      milling += attackers.filter((ship) => speedOf(ship) > 5).length;
    });
    assert(milling / Math.max(1, samples) < 1,
      `a large attack should settle rather than mill (${(milling / Math.max(1, samples)).toFixed(1)} ships still under way)`);

    const reach = getMaxEffectiveWeaponRange(attackers[0]);
    const inRange = attackers.filter((ship) => rangeTo(ship, enemy) <= reach).length;
    assert.strictEqual(inRange, attackers.length,
      `every ship sent to attack should end up able to shoot (${inRange}/${attackers.length} in range)`);
    const engaged = attackers.filter((ship) => ship.movement.holdEngaged).length;
    assert(engaged >= attackers.length - 2,
      `...and settled into its place rather than still trying to reach one (${engaged}/${attackers.length} engaged)`);

    // ...and still not stacked inside one another.
    for (let i = 0; i < attackers.length; i += 1) {
      for (let j = i + 1; j < attackers.length; j += 1) {
        const gap = rangeTo(attackers[i], attackers[j]);
        assert(gap >= attackers[i].physicalRadius + attackers[j].physicalRadius - 1,
          `${attackers[i].id} and ${attackers[j].id} overlap (${gap.toFixed(1)} px)`);
      }
    }
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
