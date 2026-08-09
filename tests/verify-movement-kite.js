"use strict";

// Kite: a travelling ranged stance, per ship, with no reverse thrust.
//
// The invariants this file exists to hold are the ones that are easy to break
// by accident later:
//
//   * a Kite ship never asks for a negative speed and never turns to face what
//     it is running from just because it is attacking it;
//   * the band comes from the MAIN battery, so a point-defence turret or a
//     short secondary cannot decide how far away the ship fights;
//   * a rear-mounted gun's ideal hull heading is the escape heading, and the
//     controller has to find that without knowing what a railgun is;
//   * asteroids, stations and the map edge are navigated, not discovered by
//     collision;
//   * every scrap of Kite state is per ship and dies with the order.

const assert = require("assert");
const { movementTestTick } = require("../tools/movementTestTick");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { computeDesignCollisionRadius } = require("../src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("../src/server/spatialIndex");
const {
  isTargetInWeaponArc,
  mainBatteryProfile,
  updateShipWeapons
} = require("../src/server/combat");
const {
  applyCombatStyle,
  applyMovementToggles,
  commandShips,
  kiteRangeBand,
  physicalCollisionRadius,
  stopShips
} = require("../src/server/movement");
const { sanitizeCombatStyle } = require("../src/server/validation");
const { validateClientMessage } = require("../src/server/clientSchemas");
const {
  KITE_INNER_RANGE_RATIO,
  KITE_OUTER_RANGE_RATIO,
  KITE_PREFERRED_RANGE_RATIO,
  WORLD_MARGIN
} = require("../src/server/movementTuning");
const { isSegmentStationClear } = require("../src/server/stationCollision");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 8, y: 8, type: "engine" }
];

// The archetype the stance is built around: fast, and with its main gun facing
// backwards so that "run away" and "keep shooting" are the same hull heading.
const REAR_RAILGUN = BASE.concat([{ x: 6, y: 7, type: "railgun", rotation: 180 }]);
const FORWARD_RAILGUN = BASE.concat([{ x: 6, y: 7, type: "railgun", rotation: 0 }]);
const UNARMED = BASE.map((module) => ({ ...module }));

let sequence = 0;

function makeShip(x, y, design, ownerId, angle = 0, style = "kite") {
  const stats = computeStats(design);
  const ship = {
    id: `kite-${++sequence}`,
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
    dataLinks: [],
    stats,
    combatStyle: style,
    combatStyleRaw: style
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  if (!ship.componentPowerState) ship.componentPowerState = new Array(design.length).fill(1);
  return ship;
}

function makeRoom(ships, asteroids = [], stations = []) {
  const room = {
    world: { width: 12000, height: 9000 },
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

// A bare obstacle station: one rotated collision box, built the shape the real
// station builder produces. Deliberately NOT axis-aligned, so a controller that
// quietly treated stations as circles would be caught below.
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

function attack(room, ship, target, owner = "p1") {
  return commandShips(room, room.players.get(owner), target.x, target.y, {
    shipIds: [ship.id],
    targetId: target.id
  });
}

function distance(a, b) {
  return Math.hypot((b.x || 0) - (a.x || 0), (b.y || 0) - (a.y || 0));
}

function angleDelta(a, b) {
  let delta = (a || 0) - (b || 0);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

// Everything a run must never do, watched on every tick rather than only at the
// end: one bad tick anywhere is a bug, and a final-frame assertion misses it.
function invariantWatcher(room, ship, target, asteroids = []) {
  let negativeSpeedTicks = 0;
  let nonFiniteTicks = 0;
  let collisionTicks = 0;
  let stationContacts = 0;
  let worstAsteroid = Infinity;
  let outsideMargin = 0;
  const modes = new Set();
  const headings = [];
  return {
    sample() {
      const runtime = ship.movement || {};
      if ((Number(runtime.desiredSpeed) || 0) < 0) negativeSpeedTicks += 1;
      for (const value of [
        ship.x, ship.y, ship.vx, ship.vy, ship.angle,
        runtime.desiredSpeed, runtime.kiteSpeedLimit,
        runtime.destination?.x, runtime.destination?.y
      ]) {
        if (value !== undefined && value !== null && !Number.isFinite(Number(value))) nonFiniteTicks += 1;
      }
      if (runtime.kiteHeading !== null && runtime.kiteHeading !== undefined) {
        if (!Number.isFinite(Number(runtime.kiteHeading))) nonFiniteTicks += 1;
        else headings.push(Number(runtime.kiteHeading));
      }
      if (runtime.kiteMode) modes.add(runtime.kiteMode);
      if ((Number(ship._staticCollisionCorrectionDistance) || 0) > 0) collisionTicks += 1;
      if (!isSegmentStationClear(room, ship.x, ship.y, ship.x, ship.y, physicalCollisionRadius(ship))) {
        stationContacts += 1;
      }
      for (const asteroid of asteroids) {
        worstAsteroid = Math.min(
          worstAsteroid,
          Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y)
            - (Number(asteroid.radius) || 0)
            - physicalCollisionRadius(ship)
        );
      }
      const width = room.world.width;
      const height = room.world.height;
      if (ship.x < WORLD_MARGIN || ship.x > width - WORLD_MARGIN
        || ship.y < WORLD_MARGIN || ship.y > height - WORLD_MARGIN) outsideMargin += 1;
      void target;
    },
    // How many times the chosen heading crossed from one side of the previous
    // one to the other by more than a token amount. This is the flip-flop
    // measure: a ship weaving between two mirror-image escapes racks it up.
    get headingReversals() {
      let reversals = 0;
      for (let index = 2; index < headings.length; index += 1) {
        const previous = angleDelta(headings[index - 1], headings[index - 2]);
        const current = angleDelta(headings[index], headings[index - 1]);
        if (Math.abs(previous) > 0.05 && Math.abs(current) > 0.05
          && Math.sign(previous) !== Math.sign(current)) reversals += 1;
      }
      return reversals;
    },
    get negativeSpeedTicks() { return negativeSpeedTicks; },
    get nonFiniteTicks() { return nonFiniteTicks; },
    get collisionTicks() { return collisionTicks; },
    get stationContacts() { return stationContacts; },
    get worstAsteroid() { return worstAsteroid; },
    get outsideMargin() { return outsideMargin; },
    get modes() { return modes; }
  };
}

function simulate(room, ships, seconds, startTick = 0, observe = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    movementTestTick(room, ships, DT, (startTick + tick) * DT * 1000);
    if (observe) observe();
  }
  return startTick + ticks;
}

function run() {
  // --- Validation and the wire -------------------------------------------
  {
    assert.strictEqual(sanitizeCombatStyle("kite"), "kite",
      "Kite is a live stance again and must not resolve to Hold");
    assert.strictEqual(sanitizeCombatStyle("KITE"), "kite", "stance names are case insensitive");
    for (const stance of ["charge", "hold", "orbit", "static"]) {
      assert.strictEqual(sanitizeCombatStyle(stance), stance, `${stance} is unaffected`);
    }
    // The compatibility aliases are untouched by reinstating Kite.
    assert.strictEqual(sanitizeCombatStyle("brawler"), "charge");
    assert.strictEqual(sanitizeCombatStyle("evasive"), "orbit");
    assert.strictEqual(sanitizeCombatStyle("sentry"), "hold");
    // ...and nothing that is not a stance may sneak through as one.
    for (const nonsense of ["kite-left", "kite-right", "retreat", "skirmish", "", null, undefined, 7]) {
      assert.strictEqual(sanitizeCombatStyle(nonsense), "hold",
        `an unusable style (${String(nonsense)}) must fall back safely`);
    }
    // A saved preference of "kite" now survives the fallback path too, rather
    // than being quietly rewritten to Hold on the way in.
    assert.strictEqual(sanitizeCombatStyle("nonsense", "kite"), "kite",
      "a stored Kite preference is what an unknown request falls back to");

    assert.strictEqual(
      validateClientMessage({ type: "setCombatStyle", combatStyle: "kite", shipIds: ["s1"] }).ok,
      true,
      "the wire schema accepts kite");
  }

  // --- The client still offers exactly one Kite button --------------------
  {
    const fs = require("fs");
    const path = require("path");
    const root = path.dirname(__dirname);
    const panel = fs.readFileSync(path.join(root, "public", "src", "ui", "sidePanelUi.js"), "utf8");
    const descriptions = fs.readFileSync(path.join(root, "public", "src", "ui", "section13bUi.js"), "utf8");
    assert.ok(/id:\s*"kite"/.test(panel), "the selected-ship stance list must offer Kite");
    for (const invented of ["kite-left", "kite-right", "\"retreat\"", "\"skirmish\""]) {
      assert.ok(!panel.includes(invented),
        `Kite is one stance: the client must not invent ${invented}`);
    }
    assert.ok(/kite:\s*"/.test(descriptions), "Kite needs a tooltip like every other stance");
  }

  // --- The band comes from the main battery -------------------------------
  {
    const ship = makeShip(4000, 4000, REAR_RAILGUN, "p1");
    const target = makeShip(5000, 4000, UNARMED, "p2");
    const profile = mainBatteryProfile(ship);
    const band = kiteRangeBand(ship, target);
    assert.ok(profile.standoffRange > 0, "an armed hull has a battery to hold a band around");
    assert.ok(Math.abs(band.preferred - profile.standoffRange * KITE_PREFERRED_RANGE_RATIO) < 1e-6,
      "preferred range is the configured fraction of the battery reach");
    assert.ok(Math.abs(band.inner - profile.standoffRange * KITE_INNER_RANGE_RATIO) < 1e-6,
      "the retreat threshold is the configured fraction of the battery reach");
    assert.ok(Math.abs(band.outer - profile.standoffRange * KITE_OUTER_RANGE_RATIO) < 1e-6,
      "the re-approach threshold is the configured fraction of the battery reach");
    assert.ok(band.inner < band.preferred && band.preferred < band.outer,
      "the band must be ordered, or there is no hysteresis between the modes");

    // A short secondary does not get a vote. The railgun reaches 1720 and the
    // autocannon 400: a battery chosen by the shortest gun would fight at a
    // quarter of the range.
    const mixed = makeShip(4000, 4000, REAR_RAILGUN.concat([{ x: 8, y: 6, type: "autocannon", rotation: 0 }]), "p1");
    const mixedProfile = mainBatteryProfile(mixed);
    assert.strictEqual(mixedProfile.weapons.length, 1,
      "only guns within 90% of the longest reach are main battery");
    assert.ok(mixedProfile.standoffRange > 1000,
      "a long railgun, not a short autocannon, sets the band");

    // Defensive systems and support are not offensive output and must not set
    // the band either.
    const defended = makeShip(4000, 4000, REAR_RAILGUN.concat([
      { x: 8, y: 6, type: "pointDefense", rotation: 0 },
      { x: 6, y: 8, type: "repairBeam", rotation: 0 }
    ]), "p1");
    assert.strictEqual(mainBatteryProfile(defended).weapons.length, 1,
      "point defence and repair beams are not main battery");

    // Module ORDER is not a property of the ship, so it must not change the
    // answer.
    const forwards = makeShip(4000, 4000, [
      { x: 8, y: 6, type: "autocannon", rotation: 0 }
    ].concat(REAR_RAILGUN), "p1");
    assert.ok(
      Math.abs(mainBatteryProfile(forwards).standoffRange - mixedProfile.standoffRange) < 1e-6,
      "the battery is a property of the design, not of how its modules are listed");

    // A zero-damage induction weapon has real tactical output -- heat -- and is
    // recognised as a weapon the stance may be flown for.
    const lance = makeShip(4000, 4000, BASE.concat([
      { x: 6, y: 7, type: "thermalInductionLance", rotation: 180 }
    ]), "p1");
    const lanceProfile = mainBatteryProfile(lance);
    assert.strictEqual(lanceProfile.weapons.length, 1,
      "an induction lance is a usable main battery despite doing no damage");
    assert.ok(lanceProfile.output > 0, "its tactical output is its heat, not its DPS");

    // ...and a hull with nothing ranged at all has no band to hold.
    assert.strictEqual(mainBatteryProfile(makeShip(0, 0, UNARMED, "p1")).standoffRange, 0,
      "an unarmed hull has no battery reach");
  }

  // --- An unarmed Kite ship falls back rather than fleeing forever ---------
  {
    const ship = makeShip(4000, 4000, UNARMED, "p1");
    const target = makeShip(4300, 4000, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    attack(room, ship, target);
    simulate(room, [ship], 4);
    assert.strictEqual(ship.movement.kiteSteering, false,
      "with no ranged battery Kite does not steer -- it falls back to Hold");
    assert.strictEqual(ship.movement.holdEngaged, true,
      "and it engages from where it stands like a Hold ship would");
  }

  // --- The rear-facing railgun: run and shoot at once ---------------------
  {
    // Target directly BEHIND the ship's nose, well inside the retreat band.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5200, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    const band = kiteRangeBand(ship, target);
    assert.ok(distance(ship, target) < band.inner, "constructed inside the retreat band");

    attack(room, ship, target);
    assert.strictEqual(ship.movement.holdEngaged, false,
      "a Kite order must never acquire the Hold latch -- that is what would park it");

    const watcher = invariantWatcher(room, ship, target);
    const opening = distance(ship, target);
    simulate(room, [ship], 6, 0, () => watcher.sample());

    assert.strictEqual(watcher.negativeSpeedTicks, 0,
      "there is no reverse thrust: the desired speed is never negative");
    assert.strictEqual(watcher.nonFiniteTicks, 0, "no NaN or Infinity reaches the ship state");
    assert.ok(distance(ship, target) > opening + 400,
      `forward propulsion must open the range (was ${opening | 0}, now ${distance(ship, target) | 0})`);

    // The nose points AWAY. A ship that merely faced its target and reversed
    // would fail this, and so would one that turned to face what it is shooting
    // just because it is attacking it.
    const awayBearing = Math.atan2(ship.y - target.y, ship.x - target.x);
    assert.ok(Math.abs(angleDelta(ship.angle, awayBearing)) < 0.6,
      "the ideal hull heading for a rear-mounted gun is straight away from the target");

    // ...and the rear-mounted gun is still on it.
    const railIndex = ship.design.findIndex((module) => module.type === "railgun");
    assert.ok(isTargetInWeaponArc(ship, ship.design[railIndex], target, mainBatteryProfile(ship).weapons[0].arcRadians),
      "the rear railgun stays inside its own firing arc while the ship flees");

    room.bullets.length = 0;
    for (let tick = 0; tick < 200 && !room.bullets.length; tick += 1) {
      updateShipWeapons(room, ship, [ship, target], DT, 6000 + tick * DT * 1000);
    }
    assert.ok(room.bullets.length > 0, "and it fires while the range is being opened");
  }

  // --- ...and slows down rather than running out of its own range ---------
  {
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5200, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    const band = kiteRangeBand(ship, target);
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target);
    simulate(room, [ship], 30, 0, () => watcher.sample());

    const settled = distance(ship, target);
    assert.ok(settled < band.outer + 200,
      `a Kite ship settles near the band rather than running away forever (${settled | 0} vs outer ${band.outer | 0})`);
    assert.ok(settled > band.inner - 200,
      `...and does not drift back inside the band it just escaped (${settled | 0} vs inner ${band.inner | 0})`);
    assert.strictEqual(watcher.negativeSpeedTicks, 0, "still no negative speed once settled");
    // A stationary enemy is not a reason to keep running at full power.
    assert.ok(Math.hypot(ship.vx, ship.vy) < Number(ship.stats.maxSpeed) * 0.85,
      "against a stationary target the ship comes off full throttle");
  }

  // --- A closing target triggers the retreat before the band is breached ---
  {
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(4000, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    const band = kiteRangeBand(ship, target);
    // Parked inside the band, so range alone says "maintain"...
    ship.x = target.x + band.inner + 200;
    // ...but the target is charging at it.
    target.vx = 380;
    attack(room, ship, target);
    let ranEarly = false;
    let breached = false;
    simulate(room, [ship], 1, 0, () => {
      if (distance(ship, target) <= band.inner) breached = true;
      if (!breached && ship.movement.kiteMode === "retreat") ranEarly = true;
      target.x += target.vx * DT;
    });
    assert.ok(ranEarly,
      "a fast closing target makes the ship run before the range actually collapses");
  }

  // --- A slower target does not chase the ship out of its own range -------
  {
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(4000, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    const band = kiteRangeBand(ship, target);
    ship.x = target.x + band.preferred;
    target.vx = 40;
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target);
    simulate(room, [ship], 20, 0, () => {
      target.x += target.vx * DT;
      watcher.sample();
    });
    assert.ok(distance(ship, target) < band.outer + 250,
      "a slow target must not push the ship past its own weapon range");
    assert.strictEqual(watcher.negativeSpeedTicks, 0, "no reversal against a slow target");
  }

  // --- Re-approach, and Pursue --------------------------------------------
  {
    const ship = makeShip(9000, 4500, REAR_RAILGUN, "p1", Math.PI);
    const target = makeShip(4000, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    const band = kiteRangeBand(ship, target);
    assert.ok(distance(ship, target) > band.outer, "constructed outside the band");
    attack(room, ship, target);
    const opening = distance(ship, target);
    simulate(room, [ship], 8);
    assert.ok(distance(ship, target) < opening - 400,
      "outside the outer band with Pursue on, a Kite ship closes");
    assert.ok(distance(ship, target) > band.inner,
      "...but it closes to the band, not through it");
  }
  {
    const ship = makeShip(9000, 4500, REAR_RAILGUN, "p1", Math.PI);
    const target = makeShip(4000, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    applyMovementToggles(ship, { pursue: false });
    attack(room, ship, target);
    const opening = distance(ship, target);
    const watcher = invariantWatcher(room, ship, target);
    simulate(room, [ship], 8, 0, () => watcher.sample());
    assert.ok(Math.abs(distance(ship, target) - opening) < 120,
      "with Pursue off a Kite ship does not chase a target that has opened the range");
    assert.strictEqual(watcher.negativeSpeedTicks, 0, "and it still never reverses");
  }
  {
    // Pursue off must not disarm the emergency retreat.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5600, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    applyMovementToggles(ship, { pursue: false });
    attack(room, ship, target);
    const opening = distance(ship, target);
    simulate(room, [ship], 5);
    assert.ok(distance(ship, target) > opening + 200,
      "Pursue off removes the chase, never the escape");
  }

  // --- Auto Engage off leaves an automatic target alone -------------------
  {
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5600, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    applyMovementToggles(ship, { autoEngage: false });
    // Acquired by combat rather than ordered by the player.
    ship.combatTargetId = target.id;
    const opening = distance(ship, target);
    simulate(room, [ship], 4);
    assert.strictEqual(ship.movement.kiteSteering, false,
      "an automatically acquired target must not make an Auto-Engage-off ship kite");
    assert.ok(Math.abs(distance(ship, target) - opening) < 40, "so the ship has not moved");
  }

  // --- A forward-facing gun may lose coverage while it runs ---------------
  {
    const ship = makeShip(6000, 4500, FORWARD_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target);
    const opening = distance(ship, target);
    simulate(room, [ship], 8, 0, () => watcher.sample());
    assert.ok(distance(ship, target) > opening + 300,
      "survival outranks weapon coverage inside the danger band");
    assert.strictEqual(watcher.negativeSpeedTicks, 0,
      "and it still does not try to move backwards while facing the target");
    assert.ok(watcher.headingReversals <= 2,
      `a forward-gun ship must not oscillate between facing toward and away (${watcher.headingReversals} reversals)`);
  }

  // --- Asteroids ----------------------------------------------------------
  {
    // Nothing in the way: the straight escape is used and no path search is
    // needed for it.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    attack(room, ship, target);
    simulate(room, [ship], 2);
    assert.strictEqual(ship.movement.kiteDirect, true,
      "a clear escape is steered directly, not routed");
    assert.strictEqual((ship.movement.path || []).length, 0,
      "...and a directly steered aim point is never handed to the route planner");
  }
  {
    // An asteroid sitting exactly on the straight-away line.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const asteroid = { x: 6800, y: 4500, radius: 420 };
    const room = makeRoom([ship, target], [asteroid]);
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target, [asteroid]);
    const opening = distance(ship, target);
    simulate(room, [ship], 20, 0, () => watcher.sample());

    assert.ok(watcher.worstAsteroid > 0,
      `the hull must never touch the rock behind it (worst clearance ${watcher.worstAsteroid.toFixed(1)})`);
    assert.strictEqual(watcher.collisionTicks, 0,
      "the map-collision safety net must never have to push the hull out");
    assert.ok(distance(ship, target) > opening + 300,
      "it goes around and keeps opening the range rather than parking beside the rock");
    // "Does not stop beside the asteroid" is a question about WHERE it ends up,
    // not about whether it is still moving: a ship that has reached its band
    // against a stationary target is supposed to be still.
    const band = kiteRangeBand(ship, target);
    assert.ok(Math.abs(distance(ship, target) - band.preferred) < 250,
      "it reaches the band it was going for rather than being stopped short by the rock");
    assert.ok(Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y) - asteroid.radius
      > physicalCollisionRadius(ship) + 60,
      "and it ends up clear of the rock, not resting against it");
    assert.ok(watcher.headingReversals <= 4,
      `the chosen way round must persist rather than alternating (${watcher.headingReversals} reversals)`);
  }
  {
    // Arriving at a rock at speed: the shared braking ceiling has to bite
    // whatever the plan says.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const asteroid = { x: 6900, y: 4500, radius: 500 };
    const room = makeRoom([ship, target], [asteroid]);
    ship.vx = Number(ship.stats.maxSpeed);
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target, [asteroid]);
    simulate(room, [ship], 8, 0, () => watcher.sample());
    assert.ok(watcher.worstAsteroid > 0,
      `a hull carrying full speed at a rock must brake before contact (worst ${watcher.worstAsteroid.toFixed(1)})`);
  }
  {
    // Starting inside the navigation padding -- four pixels of hull clearance,
    // well inside the eight the planner insists on. Every segment out of it
    // reads as blocked, so the ship has to be able to crawl out rather than
    // being trapped by its own clearance envelope.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const asteroid = { x: 6000, y: 4500 - (physicalCollisionRadius(ship) + 304), radius: 300 };
    const room = makeRoom([ship, target], [asteroid]);
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target, [asteroid]);
    const start = { x: ship.x, y: ship.y };
    simulate(room, [ship], 10, 0, () => watcher.sample());
    assert.ok(distance(start, ship) > 100, "a ship inside its own padding must be able to leave");
    assert.ok(watcher.worstAsteroid > 0,
      "and it leaves without ever touching the rock it started against");
    assert.strictEqual(watcher.collisionTicks, 0,
      "the collision safety net is never the thing that gets it out");
  }

  // --- Stations -----------------------------------------------------------
  {
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const station = makeObstacleStation("blocker", 6900, 4500, 460, 300, 0.4);
    const room = makeRoom([ship, target], [], [station]);
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target);
    const opening = distance(ship, target);
    simulate(room, [ship], 20, 0, () => watcher.sample());
    assert.strictEqual(watcher.stationContacts, 0,
      "the whole compound collision hull is solid: the ship must never be inside it");
    assert.strictEqual(watcher.collisionTicks, 0, "and never has to be pushed back out of it");
    assert.ok(distance(ship, target) > opening + 300,
      "the station is routed around rather than ground along");
  }
  {
    // A station as the TARGET: range is measured to its attackable surface, and
    // the ship must not route into the thing it is shooting.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const station = makeObstacleStation("victim", 5000, 4500, 400, 400, 0);
    const room = makeRoom([ship], [], [station]);
    room.players.get("p1").ships = [ship];
    const band = kiteRangeBand(ship, station);
    assert.ok(band.preferred > 0, "a station target still produces a band");
    ship.combatTargetId = station.id;
    ship.focusTargetId = station.id;
    const watcher = invariantWatcher(room, ship, station);
    simulate(room, [ship], 10, 0, () => watcher.sample());
    assert.strictEqual(watcher.stationContacts, 0, "a Kite ship never routes into its target station");
    assert.strictEqual(watcher.negativeSpeedTicks, 0, "and never reverses toward it");
  }

  // --- The world edge -----------------------------------------------------
  {
    // Target to the LEFT, ship hard against the RIGHT edge. Straight away
    // points out of the map and must be rejected.
    const ship = makeShip(0, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(0, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    ship.x = room.world.width - 260;
    target.x = ship.x - 500;
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target);
    const startX = ship.x;
    let furthestEast = ship.x;
    simulate(room, [ship], 20, 0, () => {
      furthestEast = Math.max(furthestEast, ship.x);
      watcher.sample();
    });

    assert.strictEqual(watcher.outsideMargin, 0,
      "the ship must never be driven outside the world margin");
    assert.strictEqual(watcher.collisionTicks, 0,
      "edge clamping is a final safety net and must never actually be needed");
    // Some eastward drift is the hull carrying momentum through the turn, not
    // thrust into the wall. What would fail here is a ship that kept the
    // straight-away heading and ran at the boundary.
    assert.ok(furthestEast - startX < 80,
      `it must not keep accelerating into the wall it is already against (drifted ${(furthestEast - startX) | 0})`);
    assert.ok(Math.abs(ship.y - 4500) > 10 * (furthestEast - startX),
      "it slides along the boundary instead, which is the only way out");
    assert.ok(watcher.headingReversals <= 4,
      `the chosen edge-escape side must persist (${watcher.headingReversals} reversals)`);
    const side = ship.movement.kiteEscapeSide;
    assert.ok(side === 1 || side === -1 || side === 0, "the escape side is a sign, not a heading");
  }
  {
    // The same geometry twice must produce the same choice: nothing here may
    // depend on Math.random().
    const build = () => {
      const ship = makeShip(0, 0, REAR_RAILGUN, "p1", 0);
      const target = makeShip(0, 0, UNARMED, "p2");
      const room = makeRoom([ship, target]);
      ship.x = room.world.width - 260;
      ship.y = 4500;
      target.x = ship.x - 500;
      target.y = 4500;
      attack(room, ship, target);
      simulate(room, [ship], 6);
      return { x: ship.x, y: ship.y, heading: ship.movement.kiteHeading, side: ship.movement.kiteEscapeSide };
    };
    const first = build();
    const second = build();
    assert.deepStrictEqual(first, second,
      "edge-escape side selection must be deterministic");
  }
  {
    // A corner. Every range-opening direction leaves the map, so losing range
    // for a moment is correct -- being pinned is not.
    const ship = makeShip(0, 0, REAR_RAILGUN, "p1", 0);
    const target = makeShip(0, 0, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    ship.x = room.world.width - 230;
    ship.y = room.world.height - 230;
    target.x = ship.x - 420;
    target.y = ship.y - 420;
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target);
    const start = { x: ship.x, y: ship.y };
    simulate(room, [ship], 20, 0, () => watcher.sample());
    assert.strictEqual(watcher.outsideMargin, 0, "a cornered ship is still never pushed off the map");
    assert.ok(distance(start, ship) > 150, "and it recovers room rather than sitting in the corner");
    assert.strictEqual(watcher.negativeSpeedTicks, 0, "with no reversal used to get out");
  }
  {
    // No destination or waypoint may ever be placed outside the navigable inset.
    const ship = makeShip(0, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(0, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    ship.x = room.world.width - 300;
    target.x = ship.x - 500;
    attack(room, ship, target);
    let worst = Infinity;
    simulate(room, [ship], 15, 0, () => {
      const points = (ship.movement.destination ? [ship.movement.destination] : [])
        .concat(ship.movement.path || []);
      for (const point of points) {
        worst = Math.min(
          worst,
          point.x - WORLD_MARGIN,
          room.world.width - WORLD_MARGIN - point.x,
          point.y - WORLD_MARGIN,
          room.world.height - WORLD_MARGIN - point.y
        );
      }
    });
    assert.ok(worst > 0, `every Kite destination stays inside the world margin (worst ${worst})`);
  }

  // --- Line of sight ------------------------------------------------------
  {
    // Safe range, but a rock between the two. The ship must go and find a
    // firing position, not drive at the target to see it.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(6000, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    const band = kiteRangeBand(ship, target);
    target.x = ship.x - band.preferred;
    const asteroid = { x: (ship.x + target.x) / 2, y: 4500, radius: 400 };
    room.map.asteroids.push(asteroid);
    buildRoomSpatialIndex(room, [ship, target], 0);
    attack(room, ship, target);
    const watcher = invariantWatcher(room, ship, target, [asteroid]);
    simulate(room, [ship], 2, 0, () => watcher.sample());
    assert.ok(watcher.modes.has("reposition"),
      "a blocked line at safe range is a reason to reposition");
    const before = distance(ship, target);
    simulate(room, [ship], 12, 60, () => watcher.sample());
    assert.ok(distance(ship, target) > before - 400,
      "and repositioning must not turn into a close-range rush");
    assert.ok(watcher.worstAsteroid > 0, "without touching the rock it is going round");
  }

  // --- Damage, power and heat --------------------------------------------
  {
    // The same fight, once healthy and once with the drive crippled. The
    // crippled ship must still kite, just worse -- never faster, never stuck.
    const fight = (mutate) => {
      const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
      const target = makeShip(5400, 4500, UNARMED, "p2");
      const room = makeRoom([ship, target]);
      attack(room, ship, target);
      if (mutate) mutate(ship);
      const watcher = invariantWatcher(room, ship, target);
      const opening = distance(ship, target);
      simulate(room, [ship], 8, 0, () => watcher.sample());
      return { gained: distance(ship, target) - opening, watcher };
    };
    const healthy = fight(null);
    const crippled = fight((ship) => {
      // One of the two engines shot away. The design is untouched: what changes
      // is the live movement capability the controller reads, which is the whole
      // point -- Kite must ask what the hull can do now, not what it could do
      // when it was built.
      const engine = ship.design.findIndex((module) => module.type === "engine");
      ship.componentHp[engine] = 0;
      ship.componentAliveRevision = (Number(ship.componentAliveRevision) || 0) + 1;
    });
    assert.ok(crippled.gained < healthy.gained,
      "a ship with starved engines cannot open the range as fast as a healthy one");
    assert.strictEqual(crippled.watcher.negativeSpeedTicks, 0,
      "and it does not fabricate movement authority to make up the difference");
    assert.strictEqual(crippled.watcher.nonFiniteTicks, 0, "nor produce a degenerate speed");
  }

  // --- State and lifecycle ------------------------------------------------
  {
    const clean = (ship, what) => {
      const runtime = ship.movement;
      assert.strictEqual(runtime.kiteSteering, false, `${what}: no Kite steering left`);
      assert.strictEqual(runtime.kiteSpeedLimit, 0, `${what}: no stale Kite speed ceiling`);
      assert.strictEqual(runtime.kitePlan, null, `${what}: no stale Kite plan`);
      assert.strictEqual(runtime.kiteHeading, null, `${what}: no stale Kite heading`);
      assert.strictEqual(runtime.kiteTargetId, null, `${what}: no stale Kite target`);
      assert.strictEqual(runtime.kiteEscapeSide, 0, `${what}: no stale Kite escape side`);
      assert.strictEqual(runtime.kiteMode, null, `${what}: no stale Kite mode`);
    };

    const engaged = () => {
      const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
      const target = makeShip(5400, 4500, UNARMED, "p2");
      const room = makeRoom([ship, target]);
      attack(room, ship, target);
      simulate(room, [ship], 2);
      assert.strictEqual(ship.movement.kiteSteering, true, "engaged, by construction");
      return { ship, target, room };
    };

    for (const stance of ["hold", "orbit", "charge", "static"]) {
      const { ship, target } = engaged();
      applyCombatStyle(ship, stance);
      clean(ship, `switching to ${stance}`);
      assert.strictEqual(ship.combatTargetId, target.id,
        `switching to ${stance} must not cost the ship its target`);
    }

    {
      const { ship, room } = engaged();
      commandShips(room, room.players.get("p1"), 3000, 3000, { shipIds: [ship.id] });
      clean(ship, "a new Move order");
    }
    {
      const { ship, room } = engaged();
      stopShips(room, room.players.get("p1"), [ship.id]);
      clean(ship, "a Stop order");
      simulate(room, [ship], 3);
      assert.ok(Math.hypot(ship.vx, ship.vy) < 8, "and Stop still brakes normally");
    }
    {
      const { ship, target, room } = engaged();
      target.alive = false;
      room.ships.delete(target.id);
      simulate(room, [ship], 1);
      clean(ship, "the target dying");
    }
    {
      // Retargeting must not inherit the old target's band or escape side.
      const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
      const first = makeShip(5400, 4500, UNARMED, "p2");
      const second = makeShip(6000, 3900, UNARMED, "p2");
      const room = makeRoom([ship, first, second]);
      attack(room, ship, first);
      simulate(room, [ship], 3);
      const inherited = ship.movement.kiteHeading;
      attack(room, ship, second);
      assert.strictEqual(ship.movement.kiteTargetId, null,
        "a new attack order retires the previous Kite plan outright");
      simulate(room, [ship], 3);
      assert.strictEqual(ship.movement.kiteTargetId, second.id,
        "and the state is rebuilt for the new target");
      assert.notStrictEqual(ship.movement.kiteHeading, inherited,
        "the old target's firing solution is not reused for the new one");
    }
    {
      // A runtime built before Kite existed must come up with safe defaults
      // rather than reaching the controller half-initialised.
      const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
      const target = makeShip(5400, 4500, UNARMED, "p2");
      const room = makeRoom([ship, target]);
      attack(room, ship, target);
      for (const key of Object.keys(ship.movement)) {
        if (key.startsWith("kite")) delete ship.movement[key];
      }
      simulate(room, [ship], 2);
      assert.strictEqual(ship.movement.kiteSteering, true,
        "an older runtime is brought up to shape and flies normally");
      assert.ok(Number.isFinite(Number(ship.movement.kiteSpeedLimit)),
        "with a usable speed ceiling rather than undefined");
    }
  }

  // --- Kite is per ship ---------------------------------------------------
  {
    // Two ships, same order, different positions. Nothing they use may be
    // shared, and neither may wait for the other.
    const one = makeShip(6000, 4200, REAR_RAILGUN, "p1", 0);
    const two = makeShip(6000, 4800, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const room = makeRoom([one, two, target]);
    commandShips(room, room.players.get("p1"), target.x, target.y, {
      shipIds: [one.id, two.id],
      targetId: target.id
    });
    simulate(room, [one, two], 8);
    assert.notStrictEqual(one.movement.kitePlan, two.movement.kitePlan,
      "two kiting ships must not share one plan object");
    assert.ok(Math.abs(one.movement.kiteHeading - two.movement.kiteHeading) > 1e-6,
      "each ship escapes from its own position, on its own heading");
    assert.strictEqual(one.movement.attackLane, null, "Kite takes no attack lane");
    assert.strictEqual(two.movement.attackLane, null, "Kite takes no attack lane");
    assert.ok(Math.abs(one.y - two.y) > 300,
      "they separate naturally rather than preserving a clump");
  }

  // --- Cadence ------------------------------------------------------------
  {
    // A clear path is not searched with A* every tick. The plan is committed and
    // only the aim point moves.
    const ship = makeShip(6000, 4500, REAR_RAILGUN, "p1", 0);
    const target = makeShip(5400, 4500, UNARMED, "p2");
    const room = makeRoom([ship, target]);
    attack(room, ship, target);
    const plans = new Set();
    let aimPointMoves = 0;
    let previousDestination = null;
    const ticks = Math.round(3 / DT);
    simulate(room, [ship], 3, 0, () => {
      if (ship.movement.kitePlan) plans.add(ship.movement.kitePlan);
      const destination = ship.movement.destination;
      if (destination && previousDestination
        && distance(previousDestination, destination) > 0.5) aimPointMoves += 1;
      previousDestination = destination ? { ...destination } : null;
    });
    // Three seconds at a 500ms replan cadence is a handful of plans. One per
    // tick would be ninety, which is what a controller that re-searched every
    // frame would produce.
    assert.ok(plans.size <= 12,
      `a committed plan is kept between replans rather than rebuilt every tick (${plans.size} plans in ${ticks} ticks)`);
    assert.ok(aimPointMoves > ticks * 0.5,
      "while the aim point itself is regenerated ahead of the hull every tick");
  }

  console.log("verify-movement-kite: OK");
}

run();
