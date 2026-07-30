"use strict";

// The Charge combat stance.
//
// Charge has one job: get as close to the enemy as it can and face it. Where
// "as close as it can" is depends on what the hull is carrying -- a demolition
// charge means the ship is the weapon and drives into contact; anything else
// pulls up alongside.
//
// Every assertion here is a property of that, and the facing ones matter as much
// as the range ones: a hull travels along its nose and fixed weapons only bear
// where it points, so a charger that arrives sideways has not charged anything.

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  stopShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { sanitizeCombatStyle } = require("./src/server/validation");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const {
  getMaxEffectiveWeaponRange,
  shipHasArmedProximityCharge
} = require("./src/server/componentData");

const DT = 1 / 30;

// A gunship: reaches, so Hold and Charge visibly disagree about where to stop.
const GUNSHIP = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];
// A bomber: the ship is the weapon.
const BOMBER = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "demolitionCharge" }
];
const UNARMED = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

let shipSeq = 0;

function makeShip(x, y, angle = 0, design = GUNSHIP, ownerId = "p1", combatStyle = "charge") {
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
    combatStyle,
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
    stations: [],
    stationsById: new Map(),
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

const speedOf = (ship) => Math.hypot(ship.vx, ship.vy);
const rangeTo = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const hullContact = (a, b) => a.physicalRadius + b.physicalRadius;

function facingError(ship, target) {
  let delta = ship.angle - Math.atan2(target.y - ship.y, target.x - ship.x);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return Math.abs(delta);
}

function attack(room, players, attackers, target) {
  commandShips(room, players.get("p1"), target.x, target.y, {
    shipIds: attackers.map((ship) => ship.id),
    targetId: target.id
  });
}

function run() {
  // --- The stance survives sanitization -------------------------------------
  {
    assert.strictEqual(sanitizeCombatStyle("charge"), "charge",
      "Charge must reach the controller rather than being resolved to Hold");
  }

  // --- A bomber drives into contact -----------------------------------------
  {
    const bomber = makeShip(1000, 2000, 0, BOMBER);
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED, "p2", "hold");
    const { room, ships, players } = makeScenario({ p1: [bomber], p2: [enemy] });
    assert(shipHasArmedProximityCharge(bomber), "sanity: the bomber is armed");
    attack(room, players, [bomber], enemy);

    simulate(room, ships, 45);
    const contact = hullContact(bomber, enemy);
    const settled = rangeTo(bomber, enemy);
    assert(settled < contact * 1.2,
      `a charge carrier should end up touching its target (${settled.toFixed(1)} px, hulls meet at ${contact.toFixed(1)})`);
    assert(speedOf(bomber) < 2, `...and stop there (${speedOf(bomber).toFixed(2)} px/s)`);
    assert(facingError(bomber, enemy) < 0.1,
      `...facing it (${(facingError(bomber, enemy) * 180 / Math.PI).toFixed(1)} deg off)`);
  }

  // --- A ship with no charge closes just as far, but stops alongside --------
  {
    const gunship = makeShip(1000, 2000, 0, GUNSHIP);
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED, "p2", "hold");
    const { room, ships, players } = makeScenario({ p1: [gunship], p2: [enemy] });
    assert(!shipHasArmedProximityCharge(gunship), "sanity: the gunship carries no charge");
    attack(room, players, [gunship], enemy);

    simulate(room, ships, 45);
    const contact = hullContact(gunship, enemy);
    const settled = rangeTo(gunship, enemy);
    assert(settled > contact,
      `a ship with no charge should not grind hulls (${settled.toFixed(1)} px vs ${contact.toFixed(1)})`);
    assert(settled < contact * 2,
      `...but should still be alongside (${settled.toFixed(1)} px)`);
    assert(facingError(gunship, enemy) < 0.1,
      `...facing it (${(facingError(gunship, enemy) * 180 / Math.PI).toFixed(1)} deg off)`);

    // ...and nothing like where Hold would have stopped. Charge ignores reach.
    assert(settled < getMaxEffectiveWeaponRange(gunship) * 0.25,
      `Charge should ignore weapon reach entirely (stopped ${settled.toFixed(0)} px from a ${getMaxEffectiveWeaponRange(gunship).toFixed(0)} px gun)`);
  }

  // --- A ram does not brake for its target ---------------------------------
  {
    // The two things that slow an ordinary approach both exist to set a ship
    // down gently on a spot: the arrival profile, which starts braking a third
    // of the map out, and the turn-radius cap, which collapses to a crawl as the
    // point gets close. A demolition ship wants neither -- it IS the weapon --
    // and with both in place it drifted up to its target and stopped politely a
    // hull's width short, never touching it at all.
    const measure = (design) => {
      const attacker = makeShip(1000, 2000, 0, design);
      const enemy = makeShip(6000, 2000, Math.PI, UNARMED, "p2", "hold");
      const { room, ships, players } = makeScenario({ p1: [attacker], p2: [enemy] });
      attack(room, players, [attacker], enemy);

      const contact = hullContact(attacker, enemy);
      let cruise = 0;
      let clear = 0;
      let impact = null;
      let passes = 0;
      let touching = false;
      simulate(room, ships, 60, () => {
        cruise = Math.max(cruise, speedOf(attacker));
        const range = rangeTo(attacker, enemy);
        // Speed on the last tick still clear of the hull. Sampling once they are
        // touching measures what the separation solver left behind rather than
        // what the ship arrived at.
        if (range > contact * 1.05) {
          clear = speedOf(attacker);
          if (range > contact * 2) touching = false;
        } else {
          if (impact === null) impact = clear;
          if (!touching) { passes += 1; touching = true; }
        }
      });
      return { attacker, enemy, contact, cruise, impact, passes };
    };

    const ram = measure(BOMBER);
    assert(ram.impact !== null, "a demolition ship should actually reach its target");
    assert(ram.impact > ram.cruise * 0.9,
      `a ram should arrive at full speed (${ram.impact.toFixed(0)} px/s against a cruise of ${ram.cruise.toFixed(0)})`);
    // Dropping the turn-radius cap is what makes that possible, and the risk it
    // carries is a hull that overshoots and has to come round for another go.
    assert.strictEqual(ram.passes, 1, `it should connect on the first pass, not circle (${ram.passes} passes)`);

    // A ship with no charge is not ramming anything: it still stops alongside,
    // under the ordinary arrival profile, at a speed it can survive.
    const alongside = measure(GUNSHIP);
    assert.strictEqual(alongside.impact, null,
      "a ship with no charge should stop alongside rather than colliding");
  }

  // --- Hold, for contrast ---------------------------------------------------
  {
    const holder = makeShip(1000, 2000, 0, GUNSHIP, "p1", "hold");
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED, "p2", "hold");
    const { room, ships, players } = makeScenario({ p1: [holder], p2: [enemy] });
    attack(room, players, [holder], enemy);
    simulate(room, ships, 45);
    assert(rangeTo(holder, enemy) > getMaxEffectiveWeaponRange(holder) * 0.7,
      "the same hull under Hold should stop out at weapons range");
  }

  // --- It clings, and it does not shove ------------------------------------
  {
    // Two separate promises, and they pull against each other: a charger has to
    // stay glued to a target that runs without bulldozing one that does not.
    const bomber = makeShip(1000, 2000, 0, BOMBER);
    const enemy = makeShip(1400, 2000, 0, UNARMED, "p2", "hold");
    const { room, ships, players } = makeScenario({ p1: [bomber], p2: [enemy] });
    attack(room, players, [bomber], enemy);
    simulate(room, ships, 20);
    const clung = rangeTo(bomber, enemy);
    assert(clung < hullContact(bomber, enemy) * 1.2, "sanity: attached before the target runs");

    // Not shoving: the target is under no orders and must not be pushed around
    // by the hull leaning on it.
    const before = { x: enemy.x, y: enemy.y };
    simulate(room, ships, 30);
    assert(Math.hypot(enemy.x - before.x, enemy.y - before.y) < 2,
      `a charger must not bulldoze a stationary target (moved it ${Math.hypot(enemy.x - before.x, enemy.y - before.y).toFixed(2)} px)`);

    // Now it runs, under its own orders so it has a velocity to read.
    commandShips(room, players.get("p2"), enemy.x + 4000, enemy.y, { shipIds: [enemy.id] });
    simulate(room, ships, 40);
    assert(rangeTo(bomber, enemy) < hullContact(bomber, enemy) * 1.4,
      `a charger should run a fleeing target down and re-attach (${rangeTo(bomber, enemy).toFixed(1)} px)`);
    assert(facingError(bomber, enemy) < 0.15, "...and still be facing it");
  }

  // --- Being jostled is not the target getting away -------------------------
  {
    // Four chargers packed around one hull shove each other constantly. A ship
    // that reads every shove as its target escaping lets go, starts steering at
    // a point again, and stops pointing at the thing it is charging.
    const chargers = [];
    for (let i = 0; i < 4; i += 1) chargers.push(makeShip(1000, 1400 + i * 200, 0, GUNSHIP));
    const enemy = makeShip(4000, 2000, Math.PI, UNARMED, "p2", "hold");
    const { room, ships, players } = makeScenario({ p1: chargers, p2: [enemy] });
    attack(room, players, chargers, enemy);
    simulate(room, ships, 70);

    for (const ship of chargers) {
      assert(rangeTo(ship, enemy) < hullContact(ship, enemy) * 2.2,
        `${ship.id} should get in among it (${rangeTo(ship, enemy).toFixed(0)} px)`);
    }
    // Not stacked inside one another.
    for (let i = 0; i < chargers.length; i += 1) {
      for (let j = i + 1; j < chargers.length; j += 1) {
        assert(rangeTo(chargers[i], chargers[j]) >= hullContact(chargers[i], chargers[j]) - 1,
          `chargers must not overlap (${rangeTo(chargers[i], chargers[j]).toFixed(1)} px apart)`);
      }
    }
    // And they are not all queued along one line into the target: arriving from
    // the sides they were given is what stops a group filing in nose to tail.
    const bearings = chargers.map((ship) => Math.atan2(ship.y - enemy.y, ship.x - enemy.x));
    const meanBearing = Math.atan2(
      bearings.reduce((sum, b) => sum + Math.sin(b), 0),
      bearings.reduce((sum, b) => sum + Math.cos(b), 0)
    );
    const spread = Math.max(...bearings.map((b) => {
      let delta = b - meanBearing;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      return Math.abs(delta);
    }));
    assert(spread > 0.5,
      `a group should spread around the hull, not queue on one bearing (${(spread * 180 / Math.PI).toFixed(0)} deg)`);
  }

  // --- Charge follows the ordinary command ladder ---------------------------
  {
    const bomber = makeShip(1000, 2000, 0, BOMBER);
    const enemy = makeShip(3000, 2000, Math.PI, UNARMED, "p2", "hold");
    const { room, ships, players } = makeScenario({ p1: [bomber], p2: [enemy] });
    attack(room, players, [bomber], enemy);
    simulate(room, ships, 4);
    assert(speedOf(bomber) > 40, "sanity: closing");

    // Stop outranks the stance, and the ship stays stopped.
    stopShips(room, players.get("p1"), [bomber.id]);
    simulate(room, ships, 15);
    assert(speedOf(bomber) === 0, "Stop must halt a charging ship");
    const parked = { x: bomber.x, y: bomber.y };
    simulate(room, ships, 15);
    assert(Math.hypot(bomber.x - parked.x, bomber.y - parked.y) < 1e-6,
      "a stopped charger must not resume the run on its own");
    assert(facingError(bomber, enemy) < 0.15,
      "...but it still faces what it was charging");

    // A move order outranks it too.
    commandShips(room, players.get("p1"), 1200, 5000, { shipIds: [bomber.id] });
    simulate(room, ships, 60);
    assert(Math.hypot(bomber.x - 1200, bomber.y - 5000) < 40,
      `a Move should win over Charge (${Math.hypot(bomber.x - 1200, bomber.y - 5000).toFixed(1)} px away)`);
  }

  // --- It charges a target nobody named -------------------------------------
  {
    // Combat publishes its acquisition on the ship; movement only reads it. A
    // stance that only worked off an explicit right-click would leave every
    // unordered ship standing still in the middle of a battle.
    const bomber = makeShip(1000, 2000, 0, BOMBER);
    const enemy = makeShip(2200, 2600, Math.PI, UNARMED, "p2", "hold");
    const { room, ships } = makeScenario({ p1: [bomber], p2: [enemy] });
    assert.strictEqual(bomber.movement, undefined, "no order has been issued");
    bomber.combatTargetId = enemy.id;

    simulate(room, ships, 60);
    assert(rangeTo(bomber, enemy) < hullContact(bomber, enemy) * 1.3,
      `an automatic target should be charged too (${rangeTo(bomber, enemy).toFixed(1)} px)`);
    assert(facingError(bomber, enemy) < 0.15, "...and faced");
  }

  // --- Static is the opposite, and still works ------------------------------
  {
    const sentry = makeShip(1000, 2000, 0, GUNSHIP, "p1", "static");
    const enemy = makeShip(2200, 2600, Math.PI, UNARMED, "p2", "hold");
    const { room, ships } = makeScenario({ p1: [sentry], p2: [enemy] });
    sentry.combatTargetId = enemy.id;
    const start = { x: sentry.x, y: sentry.y };

    simulate(room, ships, 40);
    assert(Math.hypot(sentry.x - start.x, sentry.y - start.y) < 1,
      `Static must never reposition for combat (moved ${Math.hypot(sentry.x - start.x, sentry.y - start.y).toFixed(2)} px)`);
    assert(facingError(sentry, enemy) < 0.1,
      "...but it turns to face what it can shoot");
  }

  // --- Charge still routes around the map -----------------------------------
  {
    const asteroids = [{ x: 2400, y: 2000, radius: 340 }];
    const bomber = makeShip(1000, 2000, 0, BOMBER);
    const enemy = makeShip(4200, 2000, Math.PI, UNARMED, "p2", "hold");
    const { room, ships, players } = makeScenario({ p1: [bomber], p2: [enemy] }, { asteroids });
    attack(room, players, [bomber], enemy);

    let worst = Infinity;
    simulate(room, ships, 80, () => {
      worst = Math.min(worst, Math.hypot(bomber.x - asteroids[0].x, bomber.y - asteroids[0].y)
        - asteroids[0].radius - bomber.physicalRadius);
    });
    assert(worst > 5, `Charge should route around obstacles, not through them (closest ${worst.toFixed(1)} px)`);
    assert(rangeTo(bomber, enemy) < hullContact(bomber, enemy) * 1.3,
      `...and still reach contact (${rangeTo(bomber, enemy).toFixed(1)} px)`);
  }

  console.log("verify-movement-charge: OK");
}

run();
