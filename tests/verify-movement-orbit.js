"use strict";

// Orbit: one stance, one direction, no formation.
//
// The invariants this file exists to hold are the ones that are easy to break
// by accident later: Orbit must never acquire the Hold latch, a direction
// toggle must never cost a ship its target, and every ship must orbit from its
// own angular position rather than converging on a shared one.

const assert = require("assert");
const { movementTestTick } = require("./tools/movementTestTick");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { mainBatteryOrbitRange, updateShipWeapons } = require("./src/server/combat");
const {
  applyCombatStyle,
  applyOrbitDirection,
  commandShips,
  orbitStandoff,
  orbitTangent,
  physicalCollisionRadius
} = require("./src/server/movement");
const { ORBIT_DIRECTION, sanitizeCombatStyle, sanitizeOrbitDirection } = require("./src/server/validation");
const { validateClientMessage } = require("./src/server/clientSchemas");
const { ORBIT_REJOIN_RADIAL_TOLERANCE, ORBIT_TURN_MARGIN } = require("./src/server/movementTuning");
const { heatAdjustedMovementStats } = require("./src/server/movementCapability");
const { isSegmentStationClear } = require("./src/server/stationCollision");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];
const BLASTER = { x: 6, y: 7, type: "blaster", rotation: 0 };
const UNARMED = BASE.map((module) => ({ ...module }));
let sequence = 0;

function makeShip(x, y, design, ownerId, angle = 0) {
  const stats = computeStats(design);
  const ship = {
    id: `orbit-${++sequence}`,
    ownerId,
    team: ownerId === "p1" ? "A" : "B",
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
    design: design.map((module) => ({ ...module })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: "orbit",
    combatStyleRaw: "orbit",
    orbitDirection: ORBIT_DIRECTION.CLOCKWISE
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  if (!ship.componentPowerState) ship.componentPowerState = new Array(design.length).fill(1);
  return ship;
}

function makeRoom(ships, asteroids = [], stations = []) {
  const room = {
    world: { width: 9000, height: 6000 },
    map: { asteroids, relays: [], revision: 1 },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players: new Map([
      ["p1", { id: "p1", team: "A", ships: ships.filter((ship) => ship.ownerId === "p1") }],
      ["p2", { id: "p2", team: "B", ships: ships.filter((ship) => ship.ownerId === "p2") }]
    ]),
    stations,
    stationsById: new Map(stations.map((station) => [station.id, station])),
    drones: new Map(),
    bullets: [],
    effects: [],
    nextEntityId: 1
  };
  buildRoomSpatialIndex(room, ships, 0);
  return room;
}

// A bare obstacle station: one rotated collision box, built the same shape the
// real station builder produces. Deliberately NOT axis-aligned, so a controller
// that quietly treated stations as circles or as their bounding box would be
// caught by the clearance assertions below.
function makeObstacleStation(id, x, y, halfWidth, halfHeight, angle) {
  const piece = {
    x,
    y,
    halfWidth,
    halfHeight,
    angle,
    cos: Math.cos(angle),
    sin: Math.sin(angle),
    radius: Math.hypot(halfWidth, halfHeight),
    door: false
  };
  return {
    id,
    entityType: "station",
    stationType: "relay",
    team: "C",
    alive: true,
    state: "active",
    x,
    y,
    angle,
    radius: piece.radius,
    collisionPieces: [piece]
  };
}

// The gap between the ship's actual hull and an asteroid's actual surface.
//
// Measured from the physical collision radius, not the hull centre. The first
// version of this file compared the centre against the asteroid radius alone,
// which reported a comfortable margin for a ship whose hull was flat against
// the rock -- and so passed while every lap ended in a scrape.
function asteroidHullClearance(ship, asteroid) {
  return fastDistance(ship.x, ship.y, asteroid.x, asteroid.y)
    - (Number(asteroid.radius) || 0)
    - physicalCollisionRadius(ship);
}

// Whether the hull, as a disc of its true collision radius, is clear of every
// rotated station piece. Asked through the shared station geometry rather than
// against the station's broad-phase radius, so an odd-shaped or rotated station
// is tested as the shape it actually is.
function stationHullClear(room, ship, margin = 0) {
  return isSegmentStationClear(
    room,
    ship.x,
    ship.y,
    ship.x,
    ship.y,
    physicalCollisionRadius(ship) + margin
  );
}

function fastDistance(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

// Watches a whole run and records the worst the hull ever got, so a single bad
// tick anywhere in the pass fails the test rather than only the final frame.
function clearanceWatcher(room, ship, asteroids) {
  let worstAsteroid = Infinity;
  let stationContacts = 0;
  let collisionTicks = 0;
  return {
    sample() {
      for (const asteroid of asteroids) {
        worstAsteroid = Math.min(worstAsteroid, asteroidHullClearance(ship, asteroid));
      }
      if (!stationHullClear(room, ship)) stationContacts += 1;
      // The map-collision safety net firing at all means the hull was inside
      // static geometry and had to be pushed back out.
      if ((Number(ship._staticCollisionCorrectionDistance) || 0) > 0) collisionTicks += 1;
    },
    get worstAsteroid() { return worstAsteroid; },
    get stationContacts() { return stationContacts; },
    get collisionTicks() { return collisionTicks; }
  };
}

function orbitAttack(room, ship, target) {
  return commandShips(room, room.players.get("p1"), target.x, target.y, {
    shipIds: [ship.id],
    targetId: target.id
  });
}

function simulate(room, ships, seconds, startTick = 0, observe = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const ship of ships) movementTestTick(room, [ship], DT, (startTick + tick) * DT * 1000);
    if (observe) observe();
  }
  return startTick + ticks;
}

// How far round the target a ship has actually travelled, signed and
// unwrapped. Comparing two bearings directly cannot tell a three-quarter turn
// one way from a quarter turn the other, and an orbit routinely does more than
// half a circle inside one test.
function sweepTracker(ship, target) {
  let previous = bearingFrom(target, ship);
  let total = 0;
  return {
    sample() {
      const current = bearingFrom(target, ship);
      total += angleDelta(current, previous);
      previous = current;
    },
    get total() { return total; }
  };
}

function bearingFrom(target, ship) {
  return Math.atan2(ship.y - target.y, ship.x - target.x);
}

function angleDelta(a, b) {
  let delta = (a || 0) - (b || 0);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function run() {
  // Orbit is a stance with a direction beside it, not two stances. Nothing in
  // the system should ever have to parse "orbit-clockwise".
  {
    assert.strictEqual(sanitizeCombatStyle("orbit"), "orbit", "Orbit is a live stance");
    assert.strictEqual(sanitizeCombatStyle("orbit-clockwise"), "hold",
      "a direction must never be smuggled through as a style name");
    assert.strictEqual(sanitizeOrbitDirection(-1), ORBIT_DIRECTION.ANTICLOCKWISE);
    assert.strictEqual(sanitizeOrbitDirection(1), ORBIT_DIRECTION.CLOCKWISE);
    for (const nonsense of [0, 2, -2, null, undefined, "left", NaN]) {
      assert.strictEqual(sanitizeOrbitDirection(nonsense), ORBIT_DIRECTION.CLOCKWISE,
        `an unusable direction (${String(nonsense)}) must resolve to clockwise, never to no direction`);
    }
    assert.strictEqual(sanitizeOrbitDirection(undefined, -1), ORBIT_DIRECTION.ANTICLOCKWISE,
      "an omitted direction falls back to the one already held");

    assert.strictEqual(
      validateClientMessage({ type: "setOrbitDirection", orbitDirection: -1, shipIds: ["s1"] }).ok, true);
    assert.strictEqual(
      validateClientMessage({ type: "setOrbitDirection", orbitDirection: 0, shipIds: ["s1"] }).code,
      "invalid-orbit-direction");
    assert.strictEqual(
      validateClientMessage({ type: "setOrbitDirection", orbitDirection: 1 }).code, "invalid-selection",
      "a direction change still has to say which ships");
    assert.strictEqual(
      validateClientMessage({ type: "setCombatStyle", combatStyle: "orbit", orbitDirection: -1, shipIds: ["s1"] }).ok,
      true, "selecting the stance may name the direction to start in");
  }

  // Screen y increases downward. On the right-hand side of the target the
  // outward radial is (+1, 0), and clockwise there has to send the ship DOWN
  // the screen. Getting this backwards is silent -- the ship still orbits --
  // so it is asserted geometrically rather than against the matrix.
  {
    const clockwise = orbitTangent(1, 0, ORBIT_DIRECTION.CLOCKWISE);
    assert(Math.abs(clockwise.x) < 1e-9 && clockwise.y > 0,
      "clockwise on the right-hand side of the target must travel down the screen");
    const anticlockwise = orbitTangent(1, 0, ORBIT_DIRECTION.ANTICLOCKWISE);
    assert(Math.abs(anticlockwise.x) < 1e-9 && anticlockwise.y < 0,
      "anticlockwise on the right-hand side must travel up the screen");
    // ...and the two are exact opposites everywhere, not just on that axis.
    for (const angle of [0.3, 1.1, 2.7, -2.2]) {
      const rx = Math.cos(angle);
      const ry = Math.sin(angle);
      const c = orbitTangent(rx, ry, ORBIT_DIRECTION.CLOCKWISE);
      const a = orbitTangent(rx, ry, ORBIT_DIRECTION.ANTICLOCKWISE);
      assert(Math.abs(c.x + a.x) < 1e-9 && Math.abs(c.y + a.y) < 1e-9);
      // A tangent is perpendicular to the radial, or it is not a tangent.
      assert(Math.abs(c.x * rx + c.y * ry) < 1e-9);
    }
  }

  // The orbit radius comes from the main battery, not from the longest envelope
  // on the hull and not from one short-ranged secondary.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    makeRoom([ship, target]);
    const battery = mainBatteryOrbitRange(ship);
    assert(battery > 0, "an armed hull reports a battery radius");
    const standoff = orbitStandoff(ship, target);
    assert(standoff < battery,
      "the orbit radius must sit inside the battery's reach, not on its edge");
    assert(standoff > battery * 0.5,
      "...but not so far inside that the stance throws away most of its range");

    // A hull carrying nothing offensive still has to orbit somewhere sane
    // rather than at radius zero.
    const unarmed = makeShip(2000, 2000, UNARMED, "p1");
    assert.strictEqual(mainBatteryOrbitRange(unarmed), 0);
    assert(orbitStandoff(unarmed, target) > 0,
      "a ship with no battery still gets a positive orbit radius");
  }

  // Clicking an enemy starts the attack immediately. Orbit never latches, never
  // parks, and keeps travelling round -- and it goes the way it was told.
  {
    for (const direction of [ORBIT_DIRECTION.CLOCKWISE, ORBIT_DIRECTION.ANTICLOCKWISE]) {
      const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
      ship.orbitDirection = direction;
      ship.movement = undefined;
      const target = makeShip(2900, 2000, UNARMED, "p2");
      const room = makeRoom([ship, target]);
      const command = commandShips(room, room.players.get("p1"), target.x, target.y, {
        shipIds: [ship.id],
        targetId: target.id
      });
      assert.strictEqual(command.code, "attack");
      assert.strictEqual(ship.movement.holdEngaged, false,
        "an Orbit attack order must not latch a Hold firing position");
      assert.strictEqual(ship.movement.attackLane, null,
        "Orbit takes no approach lane -- there is no abreast advance to plan");

      const sweep = sweepTracker(ship, target);
      simulate(room, [ship], 12, 0, sweep.sample);

      assert.strictEqual(ship.movement.holdEngaged, false,
        "Orbit must never acquire the Hold latch, at any range");
      const speed = Math.hypot(ship.vx, ship.vy);
      assert(speed > 10, `an orbiting ship keeps moving (was ${speed.toFixed(1)} px/s)`);

      // It has gone round, and round the correct way. Screen y is down, so a
      // clockwise orbit advances the bearing positively.
      const swept = sweep.total;
      assert(Math.abs(swept) > 0.6,
        `the ship should have travelled round the target (swept ${swept.toFixed(2)} rad)`);
      assert(Math.sign(swept) === direction,
        `direction ${direction} must sweep the bearing that way (got ${swept.toFixed(2)})`);

      // And it has closed to roughly its radius from well outside it.
      const distance = Math.hypot(ship.x - target.x, ship.y - target.y);
      const standoff = orbitStandoff(ship, target);
      assert(Math.abs(distance - standoff) < standoff * 0.35,
        `the ship should have spiralled onto its radius (${distance.toFixed(0)} vs ${standoff.toFixed(0)})`);
    }
  }

  // From inside the radius the correction pushes outward, not inward. The
  // spiral has to work both ways or the stance is just a slow Charge.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2080, 2000, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: [ship.id],
      targetId: target.id
    });
    const startDistance = Math.hypot(ship.x - target.x, ship.y - target.y);
    simulate(room, [ship], 10);
    const distance = Math.hypot(ship.x - target.x, ship.y - target.y);
    assert(distance > startDistance,
      `a ship inside the radius must open the range (${startDistance.toFixed(0)} -> ${distance.toFixed(0)})`);
    assert(distance <= orbitStandoff(ship, target) * 1.4,
      "...and stop opening it once it is out there, rather than running away");
  }

  // The circle is flown no faster than the hull can turn through it. A ship
  // that carried its straight-line top speed into an orbit would simply sail
  // off the outside of the circle and have to come back for it.
  //
  // The ceiling is measured against the same capability the controller flies
  // from -- heat, power and damage all move a hull's real turn rate away from
  // the paper figure on its blueprint, and it is the real one that decides
  // whether a circle can be held.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: [ship.id],
      targetId: target.id
    });
    simulate(room, [ship], 15);

    const live = heatAdjustedMovementStats(ship, ship.stats || {});
    const turnRate = Math.max(
      Number(live.turnRateLeft) || 0,
      Number(live.turnRateRight) || 0,
      Number(live.turnRate) || 0
    );
    const standoff = orbitStandoff(ship, target);
    const ceiling = turnRate * standoff * ORBIT_TURN_MARGIN;
    assert(Math.abs((Number(ship.movement.orbitSpeedLimit) || 0) - ceiling) < 1e-6,
      "the published orbit ceiling must be the turn rate through the radius being flown");

    const speed = Math.hypot(ship.vx, ship.vy);
    assert(speed <= ceiling + 1,
      `orbit speed ${speed.toFixed(1)} must respect the turn-rate ceiling ${ceiling.toFixed(1)}`);

    // The point of the ceiling, stated as the physical property it protects:
    // the angular rate the ship is actually sustaining has to be one the hull
    // can turn at, with margin to spare for steering.
    const radius = Math.hypot(ship.x - target.x, ship.y - target.y);
    const angularRate = speed / radius;
    assert(angularRate < turnRate,
      `the hull must be able to turn as fast as its own orbit sweeps `
      + `(${angularRate.toFixed(3)} rad/s round the target vs ${turnRate.toFixed(3)} rad/s of helm)`);
  }

  // Reversing direction changes the direction and nothing else. This is the
  // whole reason setOrbitDirection is not setCombatStyle.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2500, 2000, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: [ship.id],
      targetId: target.id
    });
    let tick = simulate(room, [ship], 8);

    const before = {
      commandId: ship.movement.command.id,
      commandType: ship.movement.command.type,
      targetId: ship.movement.command.targetId,
      focus: ship.focusTargetId,
      combat: ship.combatTargetId
    };

    assert.strictEqual(applyOrbitDirection(ship, ORBIT_DIRECTION.ANTICLOCKWISE), true);
    assert.strictEqual(ship.orbitDirection, ORBIT_DIRECTION.ANTICLOCKWISE);
    assert.strictEqual(ship.movement.orbitReversing, true, "a reversal is a manoeuvre, not a sign flip");
    assert.strictEqual(ship.movement.command.id, before.commandId, "the attack command must survive");
    assert.strictEqual(ship.movement.command.type, before.commandType);
    assert.strictEqual(ship.movement.command.targetId, before.targetId, "the target must survive");
    assert.strictEqual(ship.focusTargetId, before.focus, "weapon focus must survive");
    assert.strictEqual(ship.combatTargetId, before.combat, "target acquisition must not restart");
    assert.strictEqual(ship.combatStyle, "orbit", "the stance itself does not change");

    // A no-op toggle reports that nothing changed and does not start a reversal.
    ship.movement.orbitReversing = false;
    assert.strictEqual(applyOrbitDirection(ship, ORBIT_DIRECTION.ANTICLOCKWISE), false);
    assert.strictEqual(ship.movement.orbitReversing, false,
      "re-sending the direction a ship already has must not make it brake");

    // The turnaround completes and the ship comes round the other way rather
    // than travelling backwards along the old tangent.
    ship.movement.orbitReversing = true;
    const sweep = sweepTracker(ship, target);
    tick = simulate(room, [ship], 12, tick, sweep.sample);
    assert.strictEqual(ship.movement.orbitReversing, false, "the reversal should complete");
    assert(Math.sign(sweep.total) === ORBIT_DIRECTION.ANTICLOCKWISE && Math.abs(sweep.total) > 0.4,
      `the ship should now be going the other way round (swept ${sweep.total.toFixed(2)})`);
  }

  // The direction is a standing property of the ship. Switching stance away and
  // back must restore it, not quietly reset it to clockwise.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    applyOrbitDirection(ship, ORBIT_DIRECTION.ANTICLOCKWISE);
    applyCombatStyle(ship, "hold");
    assert.strictEqual(ship.orbitDirection, ORBIT_DIRECTION.ANTICLOCKWISE,
      "Hold must not forget which way the ship orbits");
    applyCombatStyle(ship, "orbit");
    assert.strictEqual(ship.orbitDirection, ORBIT_DIRECTION.ANTICLOCKWISE,
      "re-selecting Orbit restores the ship's own direction");
    assert.strictEqual(ship.movement.orbitDirection, ORBIT_DIRECTION.ANTICLOCKWISE,
      "...and the runtime is told about it");
    // An explicit direction on the stance change is still obeyed.
    applyCombatStyle(ship, "orbit", ORBIT_DIRECTION.CLOCKWISE);
    assert.strictEqual(ship.orbitDirection, ORBIT_DIRECTION.CLOCKWISE);
  }

  // Several ships on one target keep their own angular positions. Nothing
  // assigns them a shared waypoint, so the spread they arrived with survives.
  {
    const ships = [
      makeShip(1600, 1900, [...BASE, BLASTER], "p1"),
      makeShip(1600, 2000, [...BASE, BLASTER], "p1"),
      makeShip(1600, 2100, [...BASE, BLASTER], "p1")
    ];
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const room = makeRoom([...ships, target]);
    commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: target.id
    });
    simulate(room, ships, 14);

    const destinations = ships.map((ship) => ship.movement.destination);
    for (let i = 0; i < destinations.length; i += 1) {
      for (let j = i + 1; j < destinations.length; j += 1) {
        assert(Math.hypot(destinations[i].x - destinations[j].x, destinations[i].y - destinations[j].y) > 1,
          "no two orbiting ships may be steering at the same point");
      }
    }
    const bearings = ships.map((ship) => bearingFrom(target, ship));
    for (let i = 0; i < bearings.length; i += 1) {
      for (let j = i + 1; j < bearings.length; j += 1) {
        assert(Math.abs(angleDelta(bearings[i], bearings[j])) > 0.08,
          "ships orbiting one target must stay at distinct angular positions, not clump");
      }
    }
    for (const ship of ships) {
      assert.strictEqual(ship.movement.holdEngaged, false);
      assert(Math.hypot(ship.vx, ship.vy) > 5, "every ship is still travelling");
    }
  }

  // --- Static obstacle avoidance ------------------------------------------
  //
  // Orbit flies a closed path through static geometry, so anything sitting on
  // the circle will be reached sooner or later. What matters is that the ship
  // sees it coming, commits to a way round, and comes back to the circle --
  // rather than reacting late, abandoning the detour the moment the few metres
  // directly ahead look clear, and grinding along the obstacle.
  //
  // Every clearance assertion below is against the ship's PHYSICAL collision
  // radius. An earlier version of this file measured hull centre against
  // asteroid radius alone and so reported a comfortable margin for a ship that
  // was flat against the rock; it passed while every lap ended in a scrape.
  // Real daylight, not "did not quite overlap". Clearance measured in tenths of
  // a pixel is a ship grinding along the obstacle with the collision resolver
  // holding it off, which is the behaviour this whole section exists to stop.
  const AVOIDANCE_SAFETY_PAD = 5;

  // An asteroid squarely on an established orbit: two sizes, both ways round.
  // Both sizes are needed. The smaller rock is the ordinary case; the larger
  // one is big enough that the ship is still committed to its way around when
  // the next decision falls due, which is where an avoidance that reconsiders
  // too eagerly or too late shows up as a scrape.
  const ROUND_TRIP_ROCKS = [
    { id: "rock", x: 2600, y: 2470, radius: 230 },
    { id: "rock", x: 2600, y: 2500, radius: 340 }
  ];
  for (const rock of ROUND_TRIP_ROCKS) {
    for (const direction of [ORBIT_DIRECTION.CLOCKWISE, ORBIT_DIRECTION.ANTICLOCKWISE]) {
    const name = `${direction === ORBIT_DIRECTION.CLOCKWISE ? "clockwise" : "anticlockwise"}`
      + ` past r${rock.radius}`;
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    ship.orbitDirection = direction;
    ship.movement = undefined;
    const target = makeShip(2600, 2000, UNARMED, "p2");
    // Centred on the circle the ship will fly, so it cannot be dodged by a
    // slightly different radius -- it has to be gone around.
    const asteroids = [{ ...rock }];
    const room = makeRoom([ship, target], asteroids);
    orbitAttack(room, ship, target);

    const watcher = clearanceWatcher(room, ship, asteroids);
    const sweep = sweepTracker(ship, target);
    let sawDetour = false;
    let sawRejoin = false;
    let plans = 0;
    let lastPlannedAt = null;
    // How near the intended radius the ship ever got once it had started
    // avoiding. Sampling only the last tick would be a coin toss: a ship that
    // laps a rock is somewhere in a manoeuvre a good part of the time, and
    // being mid-detour when the clock stops says nothing about whether it
    // rejoins.
    let bestRadiusError = Infinity;
    simulate(room, [ship], 25, 0, () => {
      watcher.sample();
      sweep.sample();
      const avoidance = ship.movement.orbitAvoidance;
      if (sawDetour) {
        bestRadiusError = Math.min(
          bestRadiusError,
          Math.abs(Math.hypot(ship.x - target.x, ship.y - target.y) - orbitStandoff(ship, target))
        );
      }
      if (!avoidance) return;
      if (avoidance.phase === "detour") sawDetour = true;
      if (avoidance.phase === "rejoin") sawRejoin = true;
      if (avoidance.plannedAt !== lastPlannedAt) {
        plans += 1;
        lastPlannedAt = avoidance.plannedAt;
      }
    });

    assert(watcher.worstAsteroid > AVOIDANCE_SAFETY_PAD,
      `${name}: the whole hull must stay clear of the rock `
      + `(closest approach ${watcher.worstAsteroid.toFixed(1)} px of hull clearance)`);
    assert.strictEqual(watcher.collisionTicks, 0,
      `${name}: the map-collision safety net must never have to push the hull out `
      + `(${watcher.collisionTicks} ticks of correction)`);
    assert(sawDetour, `${name}: the rock should have forced a committed detour`);
    assert(sawRejoin, `${name}: ...and the ship should have rejoined the circle afterwards`);
    // 25 seconds is 750 ticks. A per-tick replan would be hundreds.
    assert(plans > 0 && plans < 40,
      `${name}: avoidance must be planned on a cadence, not per tick (${plans} plans in 750 ticks)`);
    assert(Math.sign(sweep.total) === direction && Math.abs(sweep.total) > 1.5,
      `${name}: the ship must keep going round the target the way it was told `
      + `(swept ${sweep.total.toFixed(2)} rad)`);
    assert.strictEqual(ship.movement.holdEngaged, false,
      `${name}: and it still never latches`);
    // It came back to the circle after going round, rather than being left
    // wide of it or cutting permanently inside.
    assert(bestRadiusError < ORBIT_REJOIN_RADIAL_TOLERANCE,
      `${name}: the ship should come back to its orbit radius after the obstacle `
      + `(closest it got was ${bestRadiusError.toFixed(0)} px off)`);
    assert.strictEqual(ship.movement.orbitSteering, true,
      `${name}: and the orbit controller is still the thing flying it`);
    }
  }

  // A station on the orbit. Routed around the real rotated collision piece --
  // not a circle approximating it, and not its bounding box.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    // Long, thin and rotated off both axes, lying across the circle.
    const station = makeObstacleStation("obstacle-station", 2600, 2465, 300, 90, 0.6);
    const room = makeRoom([ship, target], [], [station]);
    orbitAttack(room, ship, target);

    // The fixture is only meaningful if the station really does sit on the path.
    assert(!isSegmentStationClear(room, 2600, 2465, 2600, 2465, 0),
      "the station piece must actually occupy the point it was placed at");

    const watcher = clearanceWatcher(room, ship, []);
    const sweep = sweepTracker(ship, target);
    let sawDetour = false;
    simulate(room, [ship], 25, 0, () => {
      watcher.sample();
      sweep.sample();
      if (ship.movement.orbitAvoidance?.phase === "detour") sawDetour = true;
    });

    assert(sawDetour, "a station across the orbit should force a committed detour");
    assert.strictEqual(watcher.stationContacts, 0,
      `the hull must never overlap the rotated station footprint `
      + `(${watcher.stationContacts} ticks in contact)`);
    assert.strictEqual(watcher.collisionTicks, 0,
      "no static-collision correction should be needed during a successful pass");
    assert(Math.abs(sweep.total) > 1.5,
      `the ship must still be orbiting afterwards (swept ${sweep.total.toFixed(2)} rad)`);
  }

  // An obstacle on the inbound spiral, before the ship has ever reached its
  // radius. Avoidance has to work from the approach, not only from a settled
  // circle.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const asteroids = [{ id: "rock", x: 2330, y: 2160, radius: 150 }];
    const room = makeRoom([ship, target], asteroids);
    orbitAttack(room, ship, target);

    const watcher = clearanceWatcher(room, ship, asteroids);
    const sweep = sweepTracker(ship, target);
    simulate(room, [ship], 25, 0, () => {
      watcher.sample();
      sweep.sample();
    });

    assert(watcher.worstAsteroid > AVOIDANCE_SAFETY_PAD,
      `a rock on the inbound spiral must also be cleared `
      + `(closest approach ${watcher.worstAsteroid.toFixed(1)})`);
    assert.strictEqual(watcher.collisionTicks, 0, "and without collision correction");
    const standoff = orbitStandoff(ship, target);
    const finalDistance = Math.hypot(ship.x - target.x, ship.y - target.y);
    assert(Math.abs(finalDistance - standoff) < standoff * 0.4,
      "the ship should still reach its orbit radius afterwards");
    assert(Math.abs(sweep.total) > 3,
      `and get on with orbiting (swept ${sweep.total.toFixed(2)} rad)`);
  }

  // An obstacle too large for the nearest rejoin arc. The candidate list has to
  // be walked until one is actually reachable, rather than committing to a
  // point that is still behind or beside the obstacle.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const asteroids = [{ id: "wall", x: 2560, y: 2560, radius: 430 }];
    const room = makeRoom([ship, target], asteroids);
    orbitAttack(room, ship, target);

    const watcher = clearanceWatcher(room, ship, asteroids);
    const sweep = sweepTracker(ship, target);
    let widestArc = 0;
    // The furthest the ship ever strayed from its target. Avoidance is supposed
    // to be a course change; a ship that only notices the obstacle late has to
    // make a much larger deviation to get around it, and ends up abandoning the
    // engagement rather than orbiting it.
    let furthest = 0;
    simulate(room, [ship], 30, 0, () => {
      watcher.sample();
      sweep.sample();
      furthest = Math.max(furthest, Math.hypot(ship.x - target.x, ship.y - target.y));
      const rejoin = ship.movement.orbitAvoidance?.rejoin;
      if (!rejoin) return;
      // How far round the circle the committed rejoin point sits from the ship.
      widestArc = Math.max(widestArc, Math.abs(angleDelta(
        bearingFrom(target, rejoin),
        bearingFrom(target, ship)
      )));
    });

    assert(watcher.worstAsteroid > AVOIDANCE_SAFETY_PAD,
      `a large obstacle must still be cleared by the whole hull `
      + `(closest approach ${watcher.worstAsteroid.toFixed(1)})`);
    assert.strictEqual(watcher.collisionTicks, 0, "and without collision correction");
    assert(widestArc > Math.PI / 4 + 0.05,
      `a large obstacle must push the rejoin point past the first candidate arc `
      + `(widest committed arc was ${widestArc.toFixed(2)} rad)`);
    // Going around must stay a manoeuvre, not a departure. A ship that leaves
    // its weapon envelope to get past a rock has stopped fighting.
    const standoff = orbitStandoff(ship, target);
    assert(furthest < standoff * 1.9,
      `avoidance must not throw the ship far outside its own orbit `
      + `(reached ${furthest.toFixed(0)} px, orbit radius ${standoff.toFixed(0)})`);
    // ...and it must keep LAPPING. This is the assertion that pays for the
    // detection margin: seeing the obstacle early enough to steer round it is
    // worth several times the angular progress of noticing it late and having
    // to make one large deviation per lap. Safety is carried by the braking
    // ceiling, not by this -- but a "safe" orbit that barely gets round the
    // target is not doing its job either.
    assert(Math.abs(sweep.total) > 5,
      `the ship must keep orbiting past a large obstacle, not spend the fight `
      + `negotiating it (swept only ${sweep.total.toFixed(2)} rad in 30s)`);
  }

  // A heavy hull carrying real momentum begins its manoeuvre while it still has
  // room, rather than discovering the obstacle inside its own braking distance.
  {
    const heavy = [
      ...BASE,
      { x: 6, y: 6, type: "frame" },
      { x: 9, y: 6, type: "frame" },
      { x: 6, y: 9, type: "frame" },
      { x: 9, y: 9, type: "frame" },
      { x: 6, y: 7, type: "frame" },
      { x: 9, y: 7, type: "frame" },
      { x: 6, y: 8, type: "blaster", rotation: 0 }
    ];
    const ship = makeShip(2000, 2000, heavy, "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const asteroids = [{ id: "rock", x: 2600, y: 2470, radius: 230 }];
    const room = makeRoom([ship, target], asteroids);
    orbitAttack(room, ship, target);

    const watcher = clearanceWatcher(room, ship, asteroids);
    // The clearance the ship still had when it first committed, against the
    // distance it would have taken to stop from the speed it was doing.
    let clearanceAtCommit = null;
    let stoppingDistanceAtCommit = null;
    simulate(room, [ship], 25, 0, () => {
      watcher.sample();
      if (clearanceAtCommit === null && ship.movement.orbitAvoidance) {
        clearanceAtCommit = asteroidHullClearance(ship, asteroids[0]);
        const speed = Math.hypot(ship.vx, ship.vy);
        const live = heatAdjustedMovementStats(ship, ship.stats || {});
        // Same braking model the controller uses: five times drive acceleration.
        const deceleration = Math.max(1, (Number(live.accel) || 1) * 5);
        stoppingDistanceAtCommit = speed * speed / (2 * deceleration);
      }
    });

    assert(clearanceAtCommit !== null, "the heavy hull should have committed to a manoeuvre");
    assert(clearanceAtCommit > stoppingDistanceAtCommit,
      `a heavy ship must notice the obstacle while it can still steer around it, not `
      + `only once it must stand on the brakes (had ${clearanceAtCommit.toFixed(0)} px, `
      + `needed ${stoppingDistanceAtCommit.toFixed(0)} px just to stop)`);
    assert(watcher.worstAsteroid > AVOIDANCE_SAFETY_PAD,
      `...and it must not touch the rock (closest approach ${watcher.worstAsteroid.toFixed(1)})`);
    assert.strictEqual(watcher.collisionTicks, 0, "nor need collision correction");
  }

  // A target that moves while a detour is running invalidates the rejoin point,
  // because it was placed on a circle that has itself moved. The replan is
  // bounded: the route is not rebuilt every tick.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const asteroids = [{ id: "rock", x: 2600, y: 2470, radius: 230 }];
    const room = makeRoom([ship, target], asteroids);
    orbitAttack(room, ship, target);

    // Run until a manoeuvre is committed.
    let tick = 0;
    while (tick < 900 && !ship.movement.orbitAvoidance) {
      movementTestTick(room, [ship], DT, tick * DT * 1000);
      tick += 1;
    }
    assert(ship.movement.orbitAvoidance, "the rock should have forced a manoeuvre");

    const watcher = clearanceWatcher(room, ship, asteroids);
    let plans = 0;
    let lastPlannedAt = ship.movement.orbitAvoidance.plannedAt;
    const observedTicks = 300;
    for (let step = 0; step < observedTicks; step += 1) {
      // Drag the target steadily, so the circle keeps moving under the ship.
      target.x += 1.2;
      target.y += 0.6;
      buildRoomSpatialIndex(room, [ship, target], (tick + step) * DT * 1000);
      movementTestTick(room, [ship], DT, (tick + step) * DT * 1000);
      watcher.sample();
      const avoidance = ship.movement.orbitAvoidance;
      if (avoidance && avoidance.plannedAt !== lastPlannedAt) {
        plans += 1;
        lastPlannedAt = avoidance.plannedAt;
      }
    }

    assert(plans < observedTicks / 4,
      `a moving target must cause a bounded replan, not a rebuild every tick `
      + `(${plans} replans in ${observedTicks} ticks)`);
    assert(watcher.worstAsteroid > AVOIDANCE_SAFETY_PAD,
      `and the hull must stay clear throughout (closest ${watcher.worstAsteroid.toFixed(1)})`);
  }

  // Reversing direction mid-detour. The manoeuvre was planned to rejoin the
  // circle going one way and means nothing going the other, so it is rebuilt --
  // and NOTHING else is.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const asteroids = [{ id: "rock", x: 2600, y: 2470, radius: 230 }];
    const room = makeRoom([ship, target], asteroids);
    orbitAttack(room, ship, target);

    let tick = 0;
    while (tick < 900 && ship.movement.orbitAvoidance?.phase !== "detour") {
      movementTestTick(room, [ship], DT, tick * DT * 1000);
      tick += 1;
    }
    assert.strictEqual(ship.movement.orbitAvoidance?.phase, "detour",
      "the ship should be mid-detour before the direction is toggled");

    const before = {
      commandId: ship.movement.command.id,
      targetId: ship.movement.command.targetId,
      focus: ship.focusTargetId,
      combat: ship.combatTargetId,
      rejoin: { ...ship.movement.orbitAvoidance.rejoin }
    };

    assert.strictEqual(applyOrbitDirection(ship, ORBIT_DIRECTION.ANTICLOCKWISE), true);
    assert.strictEqual(ship.movement.command.id, before.commandId,
      "a direction toggle mid-detour must not replace the attack command");
    assert.strictEqual(ship.movement.command.targetId, before.targetId,
      "...nor the target");
    assert.strictEqual(ship.focusTargetId, before.focus, "...nor weapon focus");
    assert.strictEqual(ship.combatTargetId, before.combat, "...nor target acquisition");
    assert.strictEqual(ship.movement.orbitAvoidance, null,
      "...but the manoeuvre planned for the old direction is discarded");

    const watcher = clearanceWatcher(room, ship, asteroids);
    const sweep = sweepTracker(ship, target);
    tick = simulate(room, [ship], 25, tick, () => {
      watcher.sample();
      sweep.sample();
    });

    assert(watcher.worstAsteroid > AVOIDANCE_SAFETY_PAD,
      `the rebuilt manoeuvre must clear the rock too `
      + `(closest ${watcher.worstAsteroid.toFixed(1)})`);
    assert.strictEqual(watcher.collisionTicks, 0, "and need no collision correction");
    assert(sweep.total < -0.8,
      `the ship must end up orbiting the new way round (swept ${sweep.total.toFixed(2)} rad)`);
    assert.strictEqual(ship.combatTargetId, before.combat,
      "and it still has the target it started with");
  }

  // Once the obstacle is behind it, the ship lets go of the manoeuvre and the
  // temporary route with it -- otherwise the wide detour clearance and the
  // routed steering would quietly become permanent.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    // Placed so the ship meets it once on the way in and then has clear circle.
    const asteroids = [{ id: "rock", x: 2330, y: 2160, radius: 150 }];
    const room = makeRoom([ship, target], asteroids);
    orbitAttack(room, ship, target);

    let sawAvoidance = false;
    simulate(room, [ship], 30, 0, () => {
      if (ship.movement.orbitAvoidance) sawAvoidance = true;
    });

    assert(sawAvoidance, "the rock should have been avoided at some point");
    assert.strictEqual(ship.movement.orbitAvoidance, null,
      "the avoidance state must be released once the obstacle is behind the ship");
    assert.strictEqual(ship.movement.orbitDirect, true,
      "...and live orbit steering resumed");
    assert.strictEqual(ship.movement.path.length, 0,
      "...and the temporary route dropped");
  }

  // Open space is unchanged: no manoeuvre, no route, and no path search at all.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    orbitAttack(room, ship, target);

    const metrics = {};
    const previousMetrics = global.__mfaMovePerf;
    global.__mfaMovePerf = metrics;
    let avoidanceTicks = 0;
    let routedTicks = 0;
    try {
      simulate(room, [ship], 20, 0, () => {
        if (ship.movement.orbitAvoidance) avoidanceTicks += 1;
        if (ship.movement.path.length) routedTicks += 1;
      });
    } finally {
      global.__mfaMovePerf = previousMetrics;
    }

    assert.strictEqual(avoidanceTicks, 0, "open space must never invoke avoidance");
    assert.strictEqual(routedTicks, 0, "...nor produce a route");
    assert.strictEqual(Number(metrics.pathPlanCount) || 0, 0,
      `an unobstructed orbit must not run the path search at all `
      + `(${metrics.pathPlanCount} searches)`);
    assert.strictEqual(ship.movement.orbitDirect, true, "it steers at its own aim point");
  }

  // Weapons fire throughout, including while the ship is still closing on its
  // radius. Orbit must not wait for the circle to be established.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2380, 2000, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: [ship.id],
      targetId: target.id
    });
    ship.weaponCooldowns = new Array(ship.design.length).fill(0);
    ship.weaponAngles = new Array(ship.design.length).fill(0);
    ship.weaponAcquiredTargetIds = new Array(ship.design.length).fill(null);
    ship.weaponAcquiredTargetIds[3] = target.id;

    // One movement tick only: the ship is still spiralling, nowhere near
    // settled, and it must already be allowed to shoot.
    movementTestTick(room, [ship], DT, 0);
    assert.strictEqual(ship.movement.holdEngaged, false, "still closing, by construction");
    updateShipWeapons(room, ship, [ship, target], DT, 1000);
    assert(room.bullets.length > 0,
      "an orbiting ship must fire while it is still establishing the circle");
  }

  console.log("verify-movement-orbit: OK");
}

run();
