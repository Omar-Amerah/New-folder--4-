"use strict";

// Phase 1 -- basic single-ship point-and-click movement.
//
// One ship, an empty map, and a right click. Every assertion here is an
// acceptance criterion for the rewritten controller:
//
//   * a destination ahead, to the side, and behind all work
//   * a new click while travelling works
//   * the ship never reverses
//   * the ship never circles its destination
//   * the ship stops, and stays stopped, without creeping -- and does it promptly
//   * a course change costs the ship its heading, not its momentum
//   * a light ship turns faster than a capital ship
//   * different tick partitions produce the same trajectory

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  stopShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { ARRIVE_DISTANCE } = require("./src/server/movementTuning");

const DT = 1 / 30;

const LIGHT_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

// A capital hull: heavy, fast in a straight line, and slow to answer the helm.
// Used for the "a light ship turns faster than a capital ship" criterion and
// for the no-circling case -- a hull that can outrun its own turn radius is
// exactly the one that orbits a destination instead of hitting it.
//
// The engines sit in a row across the stern with clear exhaust behind them, and
// the bulk is frame rather than armour: armour carries a turn penalty per plate
// and enough of it takes the hull's turn rate to zero, which would test nothing.
const CAPITAL_DESIGN = (() => {
  const modules = [{ x: 8, y: 6, type: "core" }];
  const taken = new Set(["8,6"]);
  const claim = (x, y, width, height) => {
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < height; j += 1) if (taken.has(`${x + i},${y + j}`)) return false;
    }
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < height; j += 1) taken.add(`${x + i},${y + j}`);
    }
    return true;
  };
  for (const [x, y] of [[4, 11], [6, 11], [8, 11], [10, 11]]) {
    if (claim(x, y, 1, 2)) modules.push({ x, y, type: "engine" });
  }
  for (const [x, y] of [[6, 3], [9, 3], [6, 9], [9, 9]]) {
    if (claim(x, y, 2, 1)) modules.push({ x, y, type: "reactor" });
  }
  for (let x = 4; x <= 12; x += 1) {
    for (let y = 3; y <= 10; y += 1) if (claim(x, y, 1, 1)) modules.push({ x, y, type: "frame" });
  }
  return modules;
})();

let shipSeq = 0;

function makeShip(design, x, y, angle = 0) {
  const stats = computeStats(design);
  const ship = {
    id: `s${++shipSeq}`,
    ownerId: "p1",
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: Math.max(18, stats.radius * 0.56),
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: "hold"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

// The default map is deliberately small. Cases that need a ship at full cruise
// with room to manoeuvre afterwards pass a bigger one -- this hull needs over
// 1300 px just to get up to speed.
function makeScenario(ships, asteroids = [], world = { width: 4000, height: 3000 }) {
  const player = { id: "p1", team: "A", ships };
  return {
    player,
    room: {
      world,
      map: { asteroids },
      ships: new Map(ships.map((ship) => [ship.id, ship])),
      players: new Map([["p1", player]]),
      stations: [],
      effects: []
    }
  };
}

function simulate(room, ships, seconds, dt = DT, onTick = null) {
  const ticks = Math.round(seconds / dt);
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const ship of ships) updateShipMovement(room, ship, dt, tick * dt * 1000);
    updateShipSeparation(room, ships, dt, tick * dt * 1000);
    if (onTick) onTick(tick);
  }
}

function speedOf(ship) {
  return Math.hypot(ship.vx, ship.vy);
}

function distanceTo(ship, x, y) {
  return Math.hypot(ship.x - x, ship.y - y);
}

// A ship must never travel backwards along its own nose. This is the invariant
// the whole propulsion model rests on, so it is checked continuously rather
// than at the end of a run.
function assertNeverReverses(ship, label) {
  const forward = (ship.vx || 0) * Math.cos(ship.angle) + (ship.vy || 0) * Math.sin(ship.angle);
  assert(forward >= -0.5, `${label}: ship reversed (forward speed ${forward.toFixed(3)})`);
}

function runDirectionCase(label, angle, destinationX, destinationY) {
  const ship = makeShip(LIGHT_DESIGN, 1200, 1200, angle);
  const { room, player } = makeScenario([ship]);
  commandShips(room, player, destinationX, destinationY, { shipIds: [ship.id] });

  let peakSpeed = 0;
  let maxDistanceAfterClosest = 0;
  let closest = Infinity;
  simulate(room, [ship], 45, DT, () => {
    assertNeverReverses(ship, label);
    peakSpeed = Math.max(peakSpeed, speedOf(ship));
    const distance = distanceTo(ship, destinationX, destinationY);
    closest = Math.min(closest, distance);
    // Once the ship has been within reach of the mark it must not wander back
    // out again -- that is the signature of a hull circling its destination.
    if (closest < ARRIVE_DISTANCE * 3) {
      maxDistanceAfterClosest = Math.max(maxDistanceAfterClosest, distance - closest);
    }
  });

  const finalDistance = distanceTo(ship, destinationX, destinationY);
  assert(finalDistance <= ARRIVE_DISTANCE + 4,
    `${label}: should stop on the mark (ended ${finalDistance.toFixed(1)} px away)`);
  assert.strictEqual(ship.movement.phase, "positioned", `${label}: should report arrival`);
  assert(ship.movement.arrived, `${label}: should latch arrival`);
  assert(speedOf(ship) < 1,
    `${label}: an arrived ship should be at rest (speed ${speedOf(ship).toFixed(3)})`);
  assert(peakSpeed > 150,
    `${label}: should cross open space at real thrust (peak ${peakSpeed.toFixed(0)} px/s)`);
  assert(maxDistanceAfterClosest < ARRIVE_DISTANCE * 2,
    `${label}: should not circle the destination (drifted ${maxDistanceAfterClosest.toFixed(1)} px back out)`);
  return ship;
}

function run() {
  // --- Destination ahead / left / right / behind ----------------------------
  runDirectionCase("ahead", 0, 2600, 1200);
  runDirectionCase("right", 0, 1200, 2400);
  runDirectionCase("left", 0, 1200, 200);
  runDirectionCase("behind", 0, 300, 1200);
  runDirectionCase("behind-and-offset", Math.PI / 2, 400, 400);

  // --- The ship does not need to face the destination before setting off ----
  {
    const ship = makeShip(LIGHT_DESIGN, 1200, 1200, Math.PI); // pointing away
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 2600, 1200, { shipIds: [ship.id] });
    let movedWhileTurning = false;
    simulate(room, [ship], 1.5, DT, () => {
      if (Math.abs(ship.angle) > 0.35 && speedOf(ship) > 1) movedWhileTurning = true;
    });
    assert(movedWhileTurning,
      "a ship should accelerate gently while still coming round onto its course");
  }

  // --- A new click while travelling ----------------------------------------
  {
    const ship = makeShip(LIGHT_DESIGN, 1200, 1200, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 3200, 1200, { shipIds: [ship.id] });
    simulate(room, [ship], 4);
    assert(speedOf(ship) > 50, "ship should be under way before the second order");
    commandShips(room, player, 1400, 2600, { shipIds: [ship.id] });
    assert.strictEqual(ship.movement.arrived, false, "a new order should clear the arrival latch");
    simulate(room, [ship], 45, DT, () => assertNeverReverses(ship, "redirect"));
    assert(distanceTo(ship, 1400, 2600) <= ARRIVE_DISTANCE + 4,
      `redirect: should reach the second destination (${distanceTo(ship, 1400, 2600).toFixed(1)} px away)`);
    assert(speedOf(ship) < 1, "redirect: should come to rest at the second destination");
  }

  // --- Stops without creeping ----------------------------------------------
  {
    const ship = makeShip(LIGHT_DESIGN, 1200, 1200, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 2000, 1200, { shipIds: [ship.id] });
    simulate(room, [ship], 30);
    const restX = ship.x;
    const restY = ship.y;
    const restAngle = ship.angle;
    simulate(room, [ship], 60);
    assert(Math.hypot(ship.x - restX, ship.y - restY) < 0.5,
      `a parked ship should not creep (drifted ${Math.hypot(ship.x - restX, ship.y - restY).toFixed(3)} px in 60 s)`);
    assert(Math.abs(ship.angle - restAngle) < 1e-6,
      "a parked ship should not rotate toward the destination it is sitting short of");
    assert.strictEqual(ship.vx, 0, "a parked ship should have exactly zero velocity");
    assert.strictEqual(ship.vy, 0, "a parked ship should have exactly zero velocity");
  }

  // --- A course change costs the heading, not the momentum ------------------
  {
    // A ship at cruise given a new destination square abeam must turn onto it
    // without braking for the turn.
    //
    // The alignment throttle exists to stop a ship accelerating along a heading
    // it is about to leave. Used as a speed *target* it does more than that: it
    // actively sheds momentum that costs nothing to keep, so every corner
    // becomes a stop followed by a fresh acceleration run and the whole fleet
    // reads as sluggish. The throttle is now a floor on thrust rather than a
    // speed to hold, with a separate ceiling saying what the ship may keep.
    const ship = makeShip(LIGHT_DESIGN, 3000, 6000, 0);
    const { room, player } = makeScenario([ship], [], { width: 12000, height: 12000 });
    commandShips(room, player, 11000, 6000, { shipIds: [ship.id] });
    simulate(room, [ship], 8);
    const cruise = speedOf(ship);
    assert(cruise > 450, `fixture should reach cruise first (${cruise.toFixed(0)} px/s)`);

    // A leg long enough that the arrival profile never binds during the turn.
    const destinationX = ship.x;
    const destinationY = ship.y + 4000;
    commandShips(room, player, destinationX, destinationY, { shipIds: [ship.id] });
    let lowest = Infinity;
    simulate(room, [ship], 4, DT, () => {
      lowest = Math.min(lowest, speedOf(ship));
      assertNeverReverses(ship, "abeam turn");
    });
    assert(lowest > cruise * 0.95,
      `a 90 degree course change should not cost the ship its speed (kept ${(lowest / cruise * 100).toFixed(0)}% of ${cruise.toFixed(0)} px/s)`);
    // Settled on the new leg -- measured as the bearing to the destination, not
    // as a fixed angle: the ship carries several hundred pixels of momentum
    // through the turn, so the leg it ends up flying is not quite the one that
    // was clicked from where it then stood.
    const bearingError = Math.abs(Math.atan2(destinationY - ship.y, destinationX - ship.x) - ship.angle);
    assert(bearingError < 0.05,
      `...and should still come round onto the new course (${bearingError.toFixed(3)} rad off)`);
  }

  // --- ...but momentum aimed the wrong way is still given up ----------------
  {
    // The other half of the same rule, and the reason the coast band is bounded:
    // once the destination is behind the ship the speed it is carrying is being
    // spent going the wrong way, so it has to be shed. Without this the band
    // would simply be "never brake", and a reversal would become a long lazy
    // loop through whatever the ship was flying past.
    const ship = makeShip(LIGHT_DESIGN, 3000, 6000, 0);
    const { room, player } = makeScenario([ship], [], { width: 12000, height: 12000 });
    commandShips(room, player, 11000, 6000, { shipIds: [ship.id] });
    simulate(room, [ship], 8);
    const cruise = speedOf(ship);
    const turnX = ship.x;

    commandShips(room, player, turnX - 4000, 6000, { shipIds: [ship.id] });
    let lowest = Infinity;
    let overshoot = 0;
    simulate(room, [ship], 6, DT, () => {
      lowest = Math.min(lowest, speedOf(ship));
      overshoot = Math.max(overshoot, ship.x - turnX);
    });
    assert(lowest < cruise * 0.7,
      `a reversal should shed speed (kept ${(lowest / cruise * 100).toFixed(0)}% of ${cruise.toFixed(0)} px/s)`);
    assert(overshoot < 350,
      `a reversal should not sail on past the turn (${overshoot.toFixed(0)} px)`);
  }

  // --- Stopping is prompt ---------------------------------------------------
  {
    // Deceleration is not acceleration run backwards: a hull that is no longer
    // being asked anywhere can put its engines and every attitude thruster into
    // braking. Sharing one figure with acceleration meant a ship needed its
    // entire acceleration run again to stop -- 1400 px and five and a half
    // seconds -- which is the "ships are on ice" complaint.
    const ship = makeShip(LIGHT_DESIGN, 3000, 6000, 0);
    const { room, player } = makeScenario([ship], [], { width: 12000, height: 12000 });
    commandShips(room, player, 11000, 6000, { shipIds: [ship.id] });
    simulate(room, [ship], 8);
    const cruise = speedOf(ship);
    const startX = ship.x;

    stopShips(room, player, [ship.id]);
    let stoppedAfter = null;
    simulate(room, [ship], 10, DT, (tick) => {
      if (stoppedAfter === null && speedOf(ship) < 1) stoppedAfter = (tick + 1) * DT;
    });
    const coasted = ship.x - startX;
    assert(stoppedAfter !== null && stoppedAfter < 2.5,
      `a stop order should stop the ship promptly (${stoppedAfter === null ? "never stopped" : stoppedAfter.toFixed(2) + " s"} from ${cruise.toFixed(0)} px/s)`);
    assert(coasted < 700,
      `a stop order should not coast half the map (${coasted.toFixed(0)} px)`);
    assert.strictEqual(ship.vx, 0, "a stopped ship should be exactly at rest");
    assert.strictEqual(ship.vy, 0, "a stopped ship should be exactly at rest");
  }

  // --- The course is smooth, not quantised ---------------------------------
  {
    // Regression: pairing an exact landing on the commanded heading with a
    // dead zone made a ship quantise its own course. It held still while the
    // bearing drifted out to the tolerance, snapped the accumulated error off
    // in one step, and repeated -- a 1.3 degree kink in the direction of travel,
    // several times a second, which is what "ships jitter while moving" was.
    //
    // A destination very slightly off the bow is the worst case: the bearing
    // error stays inside the dead zone for a long time before it escapes.
    const ship = makeShip(LIGHT_DESIGN, 600, 1500, 0);
    const { room, player } = makeScenario([ship]);
    commandShips(room, player, 3600, 1560, { shipIds: [ship.id] });

    let worstKink = 0;
    let previousCourse = null;
    simulate(room, [ship], 25, DT, () => {
      const speed = speedOf(ship);
      if (speed < 1) return;
      const course = Math.atan2(ship.vy, ship.vx);
      if (previousCourse !== null) {
        let delta = course - previousCourse;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        worstKink = Math.max(worstKink, Math.abs(delta));
      }
      previousCourse = course;
    });
    // The hull is rate-limited to turnRate * dt per tick even at full helm, so
    // anything approaching that on a course this straight is a snap, not a turn.
    const rateLimit = ship.stats.turnRate * DT;
    assert(worstKink < rateLimit * 0.2,
      `a near-straight run should not kink (worst ${worstKink.toFixed(5)} rad vs rate limit ${rateLimit.toFixed(5)})`);
  }

  // --- A light ship turns faster than a capital ship ------------------------
  {
    const light = makeShip(LIGHT_DESIGN, 1000, 1000, 0);
    const capital = makeShip(CAPITAL_DESIGN, 2000, 1000, 0);
    assert(capital.stats.mass > light.stats.mass * 3,
      `the capital fixture should be much heavier (light ${light.stats.mass}, capital ${capital.stats.mass})`);
    assert(capital.stats.turnRate > 0 && light.stats.turnRate > capital.stats.turnRate * 1.25,
      `the fixtures should differ in rated turn (light ${light.stats.turnRate}, capital ${capital.stats.turnRate})`);
    const lightScenario = makeScenario([light]);
    const capitalScenario = makeScenario([capital]);
    // Same manoeuvre for both: a destination square abeam, so the whole first
    // second is spent turning.
    commandShips(lightScenario.room, lightScenario.player, 1000, 2600, { shipIds: [light.id] });
    commandShips(capitalScenario.room, capitalScenario.player, 2000, 2600, { shipIds: [capital.id] });
    simulate(lightScenario.room, [light], 1);
    simulate(capitalScenario.room, [capital], 1);
    assert(Math.abs(light.angle) > Math.abs(capital.angle) * 1.25,
      `a light ship should turn faster than a capital (light ${light.angle.toFixed(3)} rad, capital ${capital.angle.toFixed(3)} rad in 1 s)`);
  }

  // --- A heavy hull does not orbit a close destination ----------------------
  {
    const capital = makeShip(CAPITAL_DESIGN, 1200, 1200, 0);
    const { room, player } = makeScenario([capital]);
    // Straight past the nose and then hard about: the classic orbit case.
    commandShips(room, player, 1500, 1200, { shipIds: [capital.id] });
    simulate(room, [capital], 3);
    commandShips(room, player, 1300, 1250, { shipIds: [capital.id] });
    let laps = 0;
    let previousBearing = Math.atan2(1250 - capital.y, 1300 - capital.x);
    let sweep = 0;
    simulate(room, [capital], 60, DT, () => {
      const bearing = Math.atan2(1250 - capital.y, 1300 - capital.x);
      let delta = bearing - previousBearing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      sweep += delta;
      previousBearing = bearing;
      laps = Math.max(laps, Math.abs(sweep) / (Math.PI * 2));
    });
    assert(laps < 1,
      `a heavy hull should close on a nearby destination, not orbit it (${laps.toFixed(2)} laps)`);
    assert(distanceTo(capital, 1300, 1250) <= ARRIVE_DISTANCE + 6,
      `heavy hull should arrive (${distanceTo(capital, 1300, 1250).toFixed(1)} px away)`);
  }

  // --- Tick partitioning ----------------------------------------------------
  {
    // 30 Hz, 60 Hz and 20 Hz all divide into whole 60 Hz physics substeps, so
    // the same 6 seconds of flight has to produce the same ship whichever way
    // the server sliced the frame.
    const results = [1 / 30, 1 / 60, 1 / 20].map((dt) => {
      const ship = makeShip(LIGHT_DESIGN, 1200, 1200, 0.7);
      const { room, player } = makeScenario([ship]);
      commandShips(room, player, 2400, 2000, { shipIds: [ship.id] });
      simulate(room, [ship], 6, dt);
      return { dt, x: ship.x, y: ship.y, angle: ship.angle, speed: speedOf(ship) };
    });
    const [base] = results;
    for (const result of results.slice(1)) {
      assert(Math.hypot(result.x - base.x, result.y - base.y) < 1e-6,
        `tick partition ${result.dt} should match ${base.dt} (moved ${Math.hypot(result.x - base.x, result.y - base.y).toExponential(2)} px apart)`);
      assert(Math.abs(result.angle - base.angle) < 1e-9,
        `tick partition ${result.dt} should match ${base.dt} in heading`);
    }

    // A cadence that is not a whole multiple of the substep cannot be
    // bit-identical: its substeps fall at different instants, so a curved course
    // is sampled at different points. What is guaranteed is that the difference
    // stays integration error and never becomes a difference in behaviour -- a
    // few pixels on a 1500 px flight, and the same arrival.
    const odd = (() => {
      const ship = makeShip(LIGHT_DESIGN, 1200, 1200, 0.7);
      const { room, player } = makeScenario([ship]);
      commandShips(room, player, 2400, 2000, { shipIds: [ship.id] });
      simulate(room, [ship], 6, 1 / 45);
      return ship;
    })();
    const drift = Math.hypot(odd.x - base.x, odd.y - base.y);
    assert(drift < 5, `an uneven tick partition should still track (${drift.toFixed(3)} px apart)`);
    assert(Math.abs(odd.angle - base.angle) < 0.01,
      `an uneven tick partition should still track in heading (${Math.abs(odd.angle - base.angle).toFixed(5)} rad apart)`);

    // ...and it must still arrive in the same place, which is the property that
    // actually matters to a player.
    for (const dt of [1 / 30, 1 / 45, 1 / 60]) {
      const ship = makeShip(LIGHT_DESIGN, 1200, 1200, 0.7);
      const { room, player } = makeScenario([ship]);
      commandShips(room, player, 2400, 2000, { shipIds: [ship.id] });
      simulate(room, [ship], 40, dt);
      assert(distanceTo(ship, 2400, 2000) <= ARRIVE_DISTANCE + 4,
        `tick partition ${dt.toFixed(4)} should arrive (${distanceTo(ship, 2400, 2000).toFixed(1)} px away)`);
      assert(speedOf(ship) < 1, `tick partition ${dt.toFixed(4)} should come to rest`);
    }
  }

  console.log("verify-movement-phase1: OK");
}

run();
