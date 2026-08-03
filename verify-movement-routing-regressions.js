"use strict";

const assert = require("assert");
const { movementTestTick } = require("./tools/movementTestTick");
const { computeStats } = require("./src/server/shipStats");
const { commandShips, physicalCollisionRadius, resolveMapCollision } = require("./src/server/movement");
const { getMaxEffectiveWeaponRange } = require("./src/server/componentData");
const { isLineBlocked } = require("./src/server/combat");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { setMovementCommand, syncMovementTarget } = require("./src/server/movementRuntime");
const { ARRIVE_DISTANCE } = require("./src/server/movementTuning");

const DT = 1 / 30;
const ARMED = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];
const UNARMED = ARMED.slice(0, 3);
let sequence = 0;

function makeShip(x, y, options = {}) {
  const design = options.design || ARMED;
  const stats = computeStats(design);
  const ship = {
    id: options.id || `routing-${++sequence}`,
    ownerId: options.ownerId || "p1",
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: options.angle || 0,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: computeDesignCollisionRadius(design, stats),
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: options.style || "hold",
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

function makeRoom(groups, options = {}) {
  const players = new Map();
  const ships = [];
  for (const [ownerId, ownerShips] of Object.entries(groups)) {
    players.set(ownerId, {
      id: ownerId,
      team: ownerId === "p1" ? "A" : "B",
      ships: ownerShips
    });
    ships.push(...ownerShips);
  }
  const stations = options.stations || [];
  const room = {
    world: { width: 9000, height: 6000 },
    map: { asteroids: options.asteroids || [], revision: options.mapRevision || 1 },
    ships: new Map(ships.map((ship) => [ship.id, ship])),
    players,
    stations,
    stationsById: new Map(stations.map((station) => [station.id, station])),
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
    movementTestTick(room, ships, DT, now);
    if (onTick) onTick(tick, now);
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function angleDelta(a, b) {
  let delta = (a || 0) - (b || 0);
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function attack(room, players, attacker, target) {
  const result = commandShips(room, players.get("p1"), target.x, target.y, {
    shipIds: [attacker.id],
    targetId: target.id
  });
  assert.strictEqual(result.code, "attack");
}

function runFriendlyScreen(style) {
  const attacker = makeShip(1000, 3000, { style });
  const blockers = [];
  for (let index = -2; index <= 2; index += 1) {
    blockers.push(makeShip(2600, 3000 + index * 100, {
      design: UNARMED,
      ownerId: "p1"
    }));
  }
  const target = makeShip(6500, 3000, {
    design: UNARMED,
    ownerId: "p2",
    angle: Math.PI
  });
  const { room, ships, players } = makeRoom({ p1: [attacker, ...blockers], p2: [target] });
  const starts = blockers.map((ship) => ({ x: ship.x, y: ship.y }));
  attack(room, players, attacker, target);
  let routed = false;
  let deviation = 0;
  let softContactObserved = false;
  simulate(room, ships, 70, () => {
    if ((attacker.movement.path?.length || 0) > 1
      || attacker.movement.traffic?.mode === "bypass") routed = true;
    if (attacker.movement.traffic?.mode === "soft") softContactObserved = true;
    deviation = Math.max(deviation, Math.abs(attacker.y - 3000));
  });
  const blockerDisplacement = blockers.reduce((worst, blocker, index) => Math.max(
    worst,
    Math.hypot(blocker.x - starts[index].x, blocker.y - starts[index].y)
  ), 0);
  const pressureReleased = attacker.movement.traffic?.mode === "soft";
  assert(routed || pressureReleased || softContactObserved,
    `${style} should either commit a bypass or release a blocked friendly screen`);
  assert(routed || deviation > 180 || pressureReleased || softContactObserved,
    `${style} should either pass around the wall or use the bounded soft-contact release (${deviation.toFixed(1)} px)`);
  assert(blockerDisplacement < 25,
    `${style} should not snowplough the friendly screen (${blockerDisplacement.toFixed(1)} px; ${blockers.map((ship, index) => `${index}:${ship.id}:${ship.x.toFixed(0)},${ship.y.toFixed(0)} v${Math.hypot(ship.vx,ship.vy).toFixed(0)} ${ship.movement?.phase}`).join(";")}; priorities ${JSON.stringify(Array.from(room._trafficPriorities || []))})`);
  if (style === "charge") {
    const contact = physicalCollisionRadius(attacker) + physicalCollisionRadius(target);
    assert(distance(attacker, target) < contact * 1.35,
      `Charge should reach contact beyond the friendly screen (${distance(attacker, target).toFixed(1)} px)`);
  } else {
    assert(distance(attacker, target) <= getMaxEffectiveWeaponRange(attacker) + 8,
      `Hold should regain firing range beyond the friendly screen (${distance(attacker, target).toFixed(1)} px)`);
  }
}

function run() {
  // A formation's stored course is only an arrival-facing preference. During
  // travel the live route waypoint must own the hull heading, even when the
  // command carries a different formation heading.
  {
    const mover = makeShip(1000, 1000, { angle: 0, design: UNARMED });
    const { room, ships } = makeRoom({ p1: [mover] });
    const destination = { x: 2200, y: 1800 };
    setMovementCommand(mover, {
      id: "waypoint-heading:mover",
      type: "move",
      destination,
      formationHeading: 0,
      manual: true
    });
    syncMovementTarget(mover);
    movementTestTick(room, ships, DT, 0);
    const index = mover.movement.waypointIndex || 0;
    const waypoint = mover.movement.path[index] || destination;
    // `desiredHeading` is the plan made at the start of the tick; compare it
    // with the waypoint bearing from that same position, before integration
    // moves the hull a few pixels closer to the goal.
    const waypointBearing = Math.atan2(waypoint.y - 1000, waypoint.x - 1000);
    assert(Math.abs(angleDelta(mover.movement.desiredHeading, waypointBearing)) < 1e-4,
      "travelling movement must face its active route waypoint");
    assert(Math.abs(angleDelta(mover.movement.desiredHeading, 0)) > 0.2,
      "a stale formation heading must not override waypoint steering");
  }

  // Static contact is hard but frictionless: only inward velocity is removed,
  // the hull is pushed clear, and the authoritative runtime records the
  // obstacle so the next steering step can keep a committed tangent.
  {
    const asteroid = { id: "slide-rock", x: 2200, y: 2000, radius: 200 };
    const mover = makeShip(1000, 2000, { angle: 0, design: UNARMED });
    const { room, ships } = makeRoom({ p1: [mover] }, { asteroids: [asteroid] });
    const radius = physicalCollisionRadius(mover);
    setMovementCommand(mover, {
      id: "static-slide:mover",
      type: "move",
      destination: { x: 3400, y: 2000 },
      manual: true
    });
    mover.x = asteroid.x - asteroid.radius - radius + 4;
    mover.vx = 140;
    mover.vy = 35;
    mover._simNow = 0;
    assert(resolveMapCollision(room, mover), "the static slide fixture should begin in contact");
    assert(Math.hypot(mover.x - asteroid.x, mover.y - asteroid.y)
      >= asteroid.radius + radius - 1e-6,
    "static collision must push the ship outside the obstacle");
    assert(Math.abs(mover.vx) < 1e-6,
      "static collision must remove only the ship's inward velocity");
    assert(Math.abs(mover.vy - 35) < 1e-6,
      "static collision must preserve movement parallel to the surface");
    assert.strictEqual(mover.movement.slide?.obstacleId, "asteroid:slide-rock");
    assert(mover.movement.slide?.expiresAt > 0,
      "static contact must install a short-lived slide state");
    movementTestTick(room, ships, DT, 0);
    assert(Math.hypot(mover.x - asteroid.x, mover.y - asteroid.y)
      >= asteroid.radius + radius - 1e-6,
    "slide steering must not phase the ship through static geometry");
  }

  // A ground mover that has already slowed for a stationary friendly still
  // needs one deterministic local bypass; avoidance must not switch off at a
  // low forward speed and repeatedly drive it back into the blocker.
  {
    const mover = makeShip(1000, 2000, { angle: 0, design: UNARMED });
    const blocker = makeShip(1260, 2000, { angle: 0, design: UNARMED });
    const { room, ships, players } = makeRoom({ p1: [mover, blocker] });
    commandShips(room, players.get("p1"), 3600, 2000, { shipIds: [mover.id] });
    let peakDeviation = 0;
    simulate(room, ships, 35, () => {
      peakDeviation = Math.max(peakDeviation, Math.abs(mover.y - 2000));
    });
    assert(peakDeviation > 20,
      `a slow follower should take a visible deterministic bypass (${peakDeviation.toFixed(1)} px)`);
    assert(distance(mover, blocker) > physicalCollisionRadius(mover) + physicalCollisionRadius(blocker),
      "the bypass should clear the stationary friendly");
    assert(Math.hypot(mover.x - 3600, mover.y - 2000) <= ARRIVE_DISTANCE + 12,
      "the bypass should still deliver the mover to its destination");
  }

  // A selected attack's visible rest point is its own target-relative slot, not
  // a shared formation radius. Hull clearance may make the slot slightly wider
  // than the nominal 76% comfort distance, but it must remain inside reach.
  {
    const attacker = makeShip(1000, 2000);
    const target = makeShip(5000, 2000, { design: UNARMED, ownerId: "p2", angle: Math.PI });
    const { room, ships, players } = makeRoom({ p1: [attacker], p2: [target] });
    attack(room, players, attacker, target);
    simulate(room, ships, 50);
    const expected = getMaxEffectiveWeaponRange(attacker);
    const slot = attacker.movement.combatSlot;
    assert.strictEqual(slot?.combatMode, "hold");
    const slotPoint = {
      x: target.x + Math.cos(slot.assignedAngle) * slot.assignedRadius,
      y: target.y + Math.sin(slot.assignedAngle) * slot.assignedRadius
    };
    assert(distance(attacker, slotPoint) <= ARRIVE_DISTANCE * 3,
      `Selected attack should settle at its assigned target-relative slot (${distance(attacker, slotPoint).toFixed(1)} px away)`);
    assert(distance(attacker, target) <= expected + 8,
      `Selected attack slot should remain inside weapon range (${distance(attacker, target).toFixed(1)} vs ${expected.toFixed(1)})`);
  }

  // A large explicit attack carries only independent target orders. Range,
  // LOS, traffic priority and any soft-contact tolerance are resolved per hull.
  {
    const attackers = [];
    for (let index = 0; index < 12; index += 1) {
      attackers.push(makeShip(
        900 + (index % 3) * 120,
        1800 + Math.floor(index / 3) * 480
      ));
    }
    const target = makeShip(6500, 3000, { design: UNARMED, ownerId: "p2", angle: Math.PI });
    const { room, ships, players } = makeRoom({ p1: attackers, p2: [target] });
    const result = commandShips(room, players.get("p1"), target.x, target.y, {
      shipIds: attackers.map((ship) => ship.id),
      targetId: target.id
    });
    assert.strictEqual(result.code, "attack");
    for (const ship of attackers) {
      assert.strictEqual(ship.movement.command.type, "attack");
      assert.strictEqual(ship.movement.command.targetId, target.id);
      assert(!Object.prototype.hasOwnProperty.call(ship.movement.command, "firingAngle"));
      assert(!Object.prototype.hasOwnProperty.call(ship.movement.command, "firingRadiusScale"));
      assert.strictEqual(ship.movement.command.formationGroupId, undefined,
        "an attack must not inherit the ground-move formation queue");
    }
    simulate(room, ships, 100);
    const reach = getMaxEffectiveWeaponRange(attackers[0]);
    assert(attackers.every((ship) => distance(ship, target) <= reach + 48),
      `every selected ship should independently reach weapon range or its bounded soft-contact tolerance (${attackers.map((ship) => `${ship.id}:${distance(ship, target).toFixed(0)}:${ship.movement.phase}:${JSON.stringify(ship.movement.traffic)}`).join(",")})`);
  }

  // Combat positioning is target-relative and persistent: short-range Hold
  // ships occupy inner rings, overflow creates another ring, and a stationary
  // target does not cause slot regeneration every tick.
  {
    const target = makeShip(6500, 3000, {
      design: UNARMED,
      ownerId: "p2",
      angle: Math.PI
    });
    const shortRange = [];
    for (let index = 0; index < 24; index += 1) {
      shortRange.push(makeShip(
        1800 + (index % 6) * 90,
        1900 + Math.floor(index / 6) * 260,
        { id: `hold-short-${String(index).padStart(2, "0")}`, design: UNARMED }
      ));
    }
    const longRange = [
      makeShip(1800, 1200, { id: "hold-long-00" }),
      makeShip(1920, 1200, { id: "hold-long-01" })
    ];
    const { room, ships, players } = makeRoom({ p1: [...shortRange, ...longRange], p2: [target] });
    const result = commandShips(room, players.get("p1"), target.x, target.y, {
      shipIds: [...shortRange, ...longRange].map((ship) => ship.id),
      targetId: target.id
    });
    assert.strictEqual(result.code, "attack");
    assert(shortRange.every((ship) => ship.movement.combatSlot?.combatMode === "hold"));
    assert(new Set(shortRange.map((ship) => ship.movement.combatSlot.ringIndex)).size > 1,
      "a crowded Hold group should create additional range rings instead of squeezing one ring");
    const shortPrimary = Math.min(...shortRange
      .filter((ship) => ship.movement.combatSlot.ringIndex === 0)
      .map((ship) => ship.movement.combatSlot.assignedRadius));
    const longRadius = Math.min(...longRange.map((ship) => ship.movement.combatSlot.assignedRadius));
    assert(longRadius > shortPrimary,
      "long-range Hold ships should be assigned outside the short-range ring");
    assert(shortRange.concat(longRange).every((ship) => {
      const slot = ship.movement.combatSlot;
      return slot.assignedRadius <= getMaxEffectiveWeaponRange(ship) + 8;
    }), "every Hold slot must remain inside its ship's weapon range");

    const stable = shortRange[0].movement.combatSlot;
    const stableAngle = stable.assignedAngle;
    const stableRadius = stable.assignedRadius;
    simulate(room, ships, 1);
    assert(Math.abs(angleDelta(shortRange[0].movement.combatSlot.assignedAngle, stableAngle)) < 1e-9,
      "a stationary target must not regenerate Hold angles every tick");
    assert(Math.abs(shortRange[0].movement.combatSlot.assignedRadius - stableRadius) < 1e-9,
      "a stationary target must not regenerate Hold radii every tick");

    target.x += 240;
    movementTestTick(room, ships, DT, 1000);
    assert.strictEqual(shortRange[0].movement.combatSlot.targetX, target.x,
      "a significant target move should refresh the target-relative slot anchor");
  }

  // Charge uses the nearest available contact sector and puts overflow on a
  // staging ring. When a contact charger disappears, a staging charger is
  // promoted instead of all ships competing for the same hull point.
  {
    const target = makeShip(5000, 3000, {
      design: UNARMED,
      ownerId: "p2",
      angle: Math.PI
    });
    const chargers = [];
    for (let index = 0; index < 18; index += 1) {
      chargers.push(makeShip(
        1200 + (index % 6) * 120,
        1900 + Math.floor(index / 6) * 300,
        { id: `charge-slot-${String(index).padStart(2, "0")}`, style: "charge", design: UNARMED }
      ));
    }
    const { room, ships, players } = makeRoom({ p1: chargers, p2: [target] });
    commandShips(room, players.get("p1"), target.x, target.y, {
      shipIds: chargers.map((ship) => ship.id),
      targetId: target.id
    });
    const staged = chargers.find((ship) => ship.movement.combatSlot?.staging);
    const contact = chargers.find((ship) => !ship.movement.combatSlot?.staging);
    assert(staged && contact, "an oversized Charge group should have contact and staging slots");
    const contactRadius = contact.movement.combatSlot.assignedRadius;
    assert(chargers.filter((ship) => !ship.movement.combatSlot.staging).length
      <= Math.floor((2 * Math.PI * contactRadius) / 64),
    "Charge contact occupancy should be bounded by ring circumference");

    contact.alive = false;
    staged.x = target.x - staged.movement.combatSlot.assignedRadius;
    staged.y = target.y;
    movementTestTick(room, ships, DT, 0);
    assert.strictEqual(staged.movement.combatSlot.staging, false,
      "a staging charger should promote into a freed contact sector");
    assert.notStrictEqual(staged.movement.traffic?.mode, "bypass",
      "combat slot traffic must use slowing/queueing, not sideways bypassing");
  }

  // Being in range is insufficient when an asteroid occludes the firing line.
  {
    const asteroid = { x: 2225, y: 2000, radius: 95 };
    const attacker = makeShip(2000, 2000);
    const target = makeShip(2450, 2000, { design: UNARMED, ownerId: "p2", angle: Math.PI });
    const { room, ships, players } = makeRoom(
      { p1: [attacker], p2: [target] },
      { asteroids: [asteroid] }
    );
    attack(room, players, attacker, target);
    movementTestTick(room, ships, DT, 0);
    assert(!attacker.movement.holdEngaged,
      "an in-range but occluded target must not latch Hold");
    assert(attacker.movement.destination,
      "an occluded Hold target should produce a reachable firing destination");
    simulate(room, ships, 35);
    assert(attacker.movement.holdEngaged, "Hold should engage after routing to a firing line");
    assert(!isLineBlocked(room, attacker.x, attacker.y, target.x, target.y, 8),
      "the final firing line should be statically clear");
  }

  runFriendlyScreen("hold");
  runFriendlyScreen("charge");

  // Completion remains a marker, but displacement reacquires the formation slot.
  {
    const mover = makeShip(1000, 1200, { design: UNARMED });
    const { room, ships, players } = makeRoom({ p1: [mover] });
    commandShips(room, players.get("p1"), 3000, 1200, { shipIds: [mover.id] });
    simulate(room, ships, 35);
    const destination = mover.movement.command.destination;
    assert(mover.movement.orderComplete, "the initial Move should complete");
    mover.x += 140;
    simulate(room, ships, 15);
    assert(mover.movement.orderComplete, "the reacquired Move should complete again");
    assert(Math.hypot(mover.x - destination.x, mover.y - destination.y) <= ARRIVE_DISTANCE + 8,
      "a displaced ship should return to its completed slot");
  }

  // An impossible requested point has a distinct terminal and stable blocked state.
  {
    const asteroid = { x: 3500, y: 1800, radius: 420 };
    const mover = makeShip(1000, 1800, { design: UNARMED });
    const { room, ships } = makeRoom({ p1: [mover] }, { asteroids: [asteroid] });
    setMovementCommand(mover, {
      id: "unreachable:mover",
      type: "move",
      destination: { x: asteroid.x, y: asteroid.y },
      manual: true
    });
    syncMovementTarget(mover);
    simulate(room, ships, 45);
    assert.strictEqual(mover.movement.phase, "blocked");
    assert.strictEqual(mover.movement.orderComplete, false);
    assert.strictEqual(mover.movement.route?.reachable, false);
    assert(Math.hypot(mover.vx, mover.vy) < 1, "a blocked ship should be stable, not travelling at zero");
    assert(distance(mover, mover.movement.route.terminal) <= ARRIVE_DISTANCE + 8,
      "a blocked ship should settle at the usable route terminal");
  }

  // Station pieces participate in the same LOS rule as navigation, while the
  // target station itself is not mistaken for an intervening obstruction.
  {
    const station = {
      id: "routing-station",
      entityType: "station",
      alive: true,
      x: 3000,
      y: 2500,
      collisionPieces: [{ x: 3000, y: 2500, halfWidth: 220, halfHeight: 180, angle: 0 }]
    };
    const { room } = makeRoom({}, { stations: [station] });
    assert(isLineBlocked(room, 2000, 2500, 4000, 2500, 8),
      "a station between two ships should block weapon LOS");
    assert(!isLineBlocked(room, 2000, 2500, station.x, station.y, 8),
      "a target station should not block LOS to itself");
  }

  // A formation assigns deterministic destination slots. Each hull then owns
  // its own static-obstacle route; no shared corridor or firing lane is built.
  {
    const asteroid = { x: 4300, y: 3000, radius: 430 };
    const movers = [];
    for (let index = 0; index < 12; index += 1) {
      movers.push(makeShip(1200 + Math.floor(index / 4) * 110, 2550 + (index % 4) * 300, {
        design: UNARMED
      }));
    }
    const { room, ships, players } = makeRoom({ p1: movers }, { asteroids: [asteroid] });
    commandShips(room, players.get("p1"), 7200, 3000, { shipIds: movers.map((ship) => ship.id) });
    assert(movers.every((ship) => ship.movement.command.destination
      && !Object.prototype.hasOwnProperty.call(ship.movement.command, "formationPath")),
    "each formation member should receive only its own destination slot");
    movementTestTick(room, ships, DT, 0);
    assert(movers.every((ship) => Array.isArray(ship.movement.path)),
      "each formation member should build an individual static route");
    simulate(room, ships, 100);
    for (const mover of movers) {
      const destination = mover.movement.command.destination;
      const remaining = Math.hypot(mover.x - destination.x, mover.y - destination.y);
      assert(remaining <= ARRIVE_DISTANCE * 2 + 2,
        `${mover.id} should reach its formation slot (${remaining.toFixed(1)} px, ${mover.movement.phase}, path ${mover.movement.path?.length || 0})`);
    }
  }

  console.log("verify-movement-routing-regressions: OK");
}

run();
