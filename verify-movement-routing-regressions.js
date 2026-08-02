"use strict";

const assert = require("assert");
const { movementTestTick } = require("./tools/movementTestTick");
const { computeStats } = require("./src/server/shipStats");
const { commandShips, physicalCollisionRadius } = require("./src/server/movement");
const { getMaxEffectiveWeaponRange } = require("./src/server/componentData");
const { isLineBlocked } = require("./src/server/combat");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");
const { setMovementCommand, syncMovementTarget } = require("./src/server/movementRuntime");
const { HOLD_RANGE_RATIO, ARRIVE_DISTANCE } = require("./src/server/movementTuning");

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
  simulate(room, ships, 70, () => {
    if ((attacker.movement.path?.length || 0) > 1) routed = true;
    deviation = Math.max(deviation, Math.abs(attacker.y - 3000));
  });
  const blockerDisplacement = blockers.reduce((worst, blocker, index) => Math.max(
    worst,
    Math.hypot(blocker.x - starts[index].x, blocker.y - starts[index].y)
  ), 0);
  assert(routed, `${style} should acquire a route around a connected friendly screen`);
  assert(deviation > 180, `${style} should visibly pass around the wall (${deviation.toFixed(1)} px)`);
  assert(blockerDisplacement < 25,
    `${style} should not snowplough the friendly screen (${blockerDisplacement.toFixed(1)} px)`);
  if (style === "charge") {
    const contact = physicalCollisionRadius(attacker) + physicalCollisionRadius(target);
    assert(distance(attacker, target) < contact * 1.35,
      `Charge should reach contact beyond the friendly screen (${distance(attacker, target).toFixed(1)} px)`);
  } else {
    assert(distance(attacker, target) <= getMaxEffectiveWeaponRange(attacker) * 0.98,
      `Hold should regain firing range beyond the friendly screen (${distance(attacker, target).toFixed(1)} px)`);
  }
}

function run() {
  // Hold's visible rest point, not its hidden route endpoint, is 80% of reach.
  {
    const attacker = makeShip(1000, 2000);
    const target = makeShip(5000, 2000, { design: UNARMED, ownerId: "p2", angle: Math.PI });
    const { room, ships, players } = makeRoom({ p1: [attacker], p2: [target] });
    attack(room, players, attacker, target);
    simulate(room, ships, 50);
    const expected = getMaxEffectiveWeaponRange(attacker) * HOLD_RANGE_RATIO;
    assert(Math.abs(distance(attacker, target) - expected) < ARRIVE_DISTANCE * 0.5,
      `Hold should visibly settle at 80% (${distance(attacker, target).toFixed(1)} vs ${expected.toFixed(1)})`);
  }

  // A large explicit attack uses closer, staggered firing ranks. Those ranks
  // must not latch at the ordinary Hold radius on the way in, or the fleet
  // stays piled onto its outer ring and the ships at the back never fit.
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
    const innerRanks = attackers.filter((ship) => ship.movement.command.firingRadiusScale < 0.999);
    assert(innerRanks.length > 0, "a large attack should create closer firing ranks");
    assert(innerRanks.every((ship) => ship.movement.command.firingRank > 0),
      "inner firing rings should receive the priority that lets them pass the outer rank");
    assert(attackers.every((ship) => ship.movement.command.formationGroupId == null),
      "an attack must not inherit the ground-move formation queue");
    simulate(room, ships, 70);
    for (const ship of innerRanks) {
      const enter = getMaxEffectiveWeaponRange(ship) * HOLD_RANGE_RATIO
        * ship.movement.command.firingRadiusScale;
      assert(ship.movement.holdEngaged,
        `${ship.id} should establish at its assigned inner firing rank `
        + `(${ship.movement.phase}, ${distance(ship, target).toFixed(1)} px, `
        + `enter ${enter.toFixed(1)} px, scale ${ship.movement.command.firingRadiusScale})`);
      assert(distance(ship, target) <= enter + ARRIVE_DISTANCE * 1.5,
        `${ship.id} should enter its closer firing ring (${distance(ship, target).toFixed(1)} vs ${enter.toFixed(1)})`);
    }
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

  // A formation receives one centre corridor and distinct lane/queue waypoints.
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
    assert(movers.every((ship) => ship.movement.command.formationPath.length > 0),
      "an obstructed formation should share a centre corridor");
    movementTestTick(room, ships, DT, 0);
    const firstWaypoints = movers.map((ship) => ship.movement.path[0])
      .filter(Boolean)
      .map((point) => `${point.x.toFixed(1)}:${point.y.toFixed(1)}`);
    assert(new Set(firstWaypoints).size >= Math.ceil(movers.length * 0.75),
      `formation lanes should not collapse onto duplicate first waypoints (${new Set(firstWaypoints).size}/${movers.length})`);
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
