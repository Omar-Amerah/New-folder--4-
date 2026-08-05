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
  orbitTangent
} = require("./src/server/movement");
const { ORBIT_DIRECTION, sanitizeCombatStyle, sanitizeOrbitDirection } = require("./src/server/validation");
const { validateClientMessage } = require("./src/server/clientSchemas");
const { ORBIT_TURN_MARGIN } = require("./src/server/movementTuning");
const { heatAdjustedMovementStats } = require("./src/server/movementCapability");

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

function makeRoom(ships, asteroids = []) {
  const room = {
    world: { width: 9000, height: 6000 },
    map: { asteroids, relays: [], revision: 1 },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players: new Map([
      ["p1", { id: "p1", team: "A", ships: ships.filter((ship) => ship.ownerId === "p1") }],
      ["p2", { id: "p2", team: "B", ships: ships.filter((ship) => ship.ownerId === "p2") }]
    ]),
    stations: [],
    stationsById: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    nextEntityId: 1
  };
  buildRoomSpatialIndex(room, ships, 0);
  return room;
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

  // A rock sitting on the orbit gets a detour, and the detour is planned on a
  // cadence rather than every tick.
  //
  // The aim point moves with the hull by design, so handing it to the ordinary
  // route planner would rebuild the route continuously. The anchor is a fixed
  // point on the circle for exactly that reason, and the ship must come out the
  // far side still orbiting rather than grinding along the rock.
  {
    const ship = makeShip(2000, 2000, [...BASE, BLASTER], "p1");
    const target = makeShip(2600, 2000, UNARMED, "p2");
    // On the circle the ship will be flying, not between it and the target.
    const asteroids = [{ id: "rock", x: 2600, y: 2470, radius: 230 }];
    const room = makeRoom([ship, target], asteroids);
    commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: [ship.id],
      targetId: target.id
    });

    let detourPlans = 0;
    let lastAnchor = null;
    const sweep = sweepTracker(ship, target);
    let worstClearance = Infinity;
    simulate(room, [ship], 20, 0, () => {
      sweep.sample();
      const detour = ship.movement.orbitDetour;
      const anchor = detour ? `${Math.round(detour.x)}:${Math.round(detour.y)}` : null;
      if (anchor && anchor !== lastAnchor) detourPlans += 1;
      lastAnchor = anchor;
      worstClearance = Math.min(
        worstClearance,
        Math.hypot(ship.x - asteroids[0].x, ship.y - asteroids[0].y) - asteroids[0].radius
      );
    });

    assert(detourPlans > 0, "the rock on the circle should have forced at least one detour");
    // 20 seconds is 600 ticks. A per-tick replan would be hundreds of anchors.
    assert(detourPlans < 40,
      `detours must be planned on a cadence, not per tick (${detourPlans} anchors in 600 ticks)`);
    assert(worstClearance > 0,
      `the hull must go round the rock, not through it (closest approach ${worstClearance.toFixed(0)})`);
    assert(Math.abs(sweep.total) > 1.5,
      `the ship must still be circling the target, not stuck against the obstacle `
      + `(swept ${sweep.total.toFixed(2)} rad)`);
    assert.strictEqual(ship.movement.holdEngaged, false, "and it still never latches");
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
