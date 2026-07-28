"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  SUPPORTED_MOVEMENT_TYPES,
  applyCombatStyle,
  commandShips,
  createMovementIntent,
  movementIntentIsFinite,
  physicalCollisionRadius,
  rotateShips,
  stopShips,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { angleDifference } = require("./src/server/utils");
const { sanitizeCombatStyle } = require("./src/server/validation");
const { findShipHullOverlap } = require("./src/server/componentGeometry");
const { createMovementRuntime } = require("./src/server/movementRuntime");

const DT = 1 / 30;
const ARMED_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];

function runtimeShip(id, x, y, design = ARMED_DESIGN, overrides = {}) {
  const stats = computeStats(design);
  const ship = {
    id,
    ownerId: "p1",
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle: 0,
    targetX: x,
    targetY: y,
    combatStyle: "hold",
    radius: stats.radius,
    design,
    wiring: createGeneratedPowerWiring(design),
    stats,
    ...overrides
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function roomWithPlayers(asteroids = []) {
  const room = {
    world: { width: 2200, height: 1700 },
    map: { asteroids },
    ships: new Map(),
    players: new Map(),
    rules: { gameMode: "teams" }
  };
  const player = { id: "p1", team: "blue", ships: [] };
  const enemyPlayer = { id: "p2", team: "red", ships: [] };
  room.players.set(player.id, player);
  room.players.set(enemyPlayer.id, enemyPlayer);
  return { room, player, enemyPlayer };
}

function addShip(room, player, ship) {
  player.ships.push(ship);
  room.ships.set(ship.id, ship);
}

function battle(style, options = {}) {
  const setup = roomWithPlayers(options.asteroids || []);
  const ship = runtimeShip(
    options.shipId || `ship-${style}`,
    options.shipX ?? 300,
    options.shipY ?? 500,
    options.design || ARMED_DESIGN,
    { combatStyle: style }
  );
  const target = {
    id: options.targetId || `target-${style}`,
    ownerId: setup.enemyPlayer.id,
    alive: true,
    x: options.targetX ?? 1000,
    y: options.targetY ?? 500,
    vx: options.targetVx || 0,
    vy: options.targetVy || 0,
    radius: 32,
    stats: { mass: 20 },
    design: []
  };
  addShip(setup.room, setup.player, ship);
  addShip(setup.room, setup.enemyPlayer, target);
  commandShips(setup.room, setup.player, target.x, target.y, {
    shipIds: [ship.id],
    targetId: target.id
  });
  return { ...setup, ship, target };
}

function tick(room, ships, seconds, startNow = 0, separate = false) {
  const count = Math.ceil(seconds / DT);
  for (let index = 0; index < count; index += 1) {
    const now = startNow + index * DT * 1000;
    for (const ship of ships) updateShipMovement(room, ship, DT, now);
    if (separate) updateShipSeparation(room, ships, DT, now);
  }
}

function assertIntentShape(intent, label) {
  assert(movementIntentIsFinite(intent), `${label}: intent values must be finite`);
  assert(["travel", "target", "final", "current"].includes(intent.facingMode),
    `${label}: facing mode must be valid`);
  assert.strictEqual(typeof intent.arrivalRequired, "boolean", `${label}: arrivalRequired`);
  assert.strictEqual(typeof intent.persistent, "boolean", `${label}: persistent`);
  assert.strictEqual(typeof intent.debugReason, "string", `${label}: debugReason`);
}

function run() {
  assert.strictEqual(sanitizeCombatStyle("circle"), "orbit", "Circle remains an Orbit alias");
  assert.deepStrictEqual(
    [...SUPPORTED_MOVEMENT_TYPES].sort(),
    [
      "brawler", "charge", "direct", "evasive", "heavy", "hold",
      "interceptor", "kite", "maintain", "move", "orbit", "repair",
      "sentry", "stop"
    ].sort(),
    "all supported movement intent types remain registered"
  );

  const combatStyles = [
    "hold", "maintain", "kite", "orbit", "circle", "direct",
    "sentry", "charge", "interceptor", "evasive", "brawler", "heavy"
  ];
  for (const style of combatStyles) {
    const { room, ship } = battle(style);
    const before = {
      vx: ship.vx,
      vy: ship.vy,
      angle: ship.angle,
      targetX: ship.targetX,
      targetY: ship.targetY
    };
    const intent = createMovementIntent(room, ship, ship.stats, 1000);
    assertIntentShape(intent, style);
    assert.strictEqual(intent.type, style === "circle" ? "orbit" : style,
      `${style}: style maps to the expected intent`);
    assert.deepStrictEqual(
      {
        vx: ship.vx,
        vy: ship.vy,
        angle: ship.angle,
        targetX: ship.targetX,
        targetY: ship.targetY
      },
      before,
      `${style}: intent generation must not mutate velocity, angle, or compatibility targets`
    );

    global.__mfaMovePerf = {};
    updateShipMovement(room, ship, DT, 1000);
    for (const stage of [
      "sharedNavigationRuns",
      "sharedControllerRuns",
      "sharedFacingRuns",
      "sharedPropulsionRuns",
      "sharedCollisionRuns"
    ]) {
      assert.strictEqual(global.__mfaMovePerf[stage], 1,
        `${style}: production tick must pass through ${stage}`);
    }
    delete global.__mfaMovePerf;
  }

  const intentSource = fs.readFileSync(
    path.join(__dirname, "src/server/movementIntents.js"),
    "utf8"
  );
  for (const field of [
    "targetX", "targetY", "arrived", "commandMode", "angle", "vx", "vy",
    "manualRotation", "_movementPath"
  ]) {
    assert(!new RegExp(`ship\\.${field}\\s*=`).test(intentSource),
      `intent generators must not assign ship.${field}`);
  }

  // Hold commits one bounded fixed point, faces its target when settled, and
  // requests a return to that point after displacement.
  {
    const { room, ship, target } = battle("hold", { shipX: 200 });
    const positioning = createMovementIntent(room, ship, ship.stats, 0);
    ship.x = positioning.destination.x;
    ship.y = positioning.destination.y;
    ship.vx = 0;
    ship.vy = 0;
    tick(room, [ship], DT * 2);
    const held = { ...ship.movement.style.holdPosition };
    assert(Number.isFinite(held.x) && Number.isFinite(held.y), "Hold stores one fixed position");
    ship.x += 90;
    const returning = createMovementIntent(room, ship, ship.stats, 100);
    assert.deepStrictEqual(returning.destination, held, "Hold returns to its stored position");
    const before = Math.hypot(ship.x - held.x, ship.y - held.y);
    tick(room, [ship], 8, 200);
    assert(Math.hypot(ship.x - held.x, ship.y - held.y) < before, "Hold corrects displacement");
    ship.x = held.x;
    ship.y = held.y;
    ship.vx = 0;
    ship.vy = 0;
    ship.angle = Math.PI;
    const startError = Math.abs(angleDifference(ship.angle,
      Math.atan2(target.y - ship.y, target.x - ship.x)));
    tick(room, [ship], 2, 9000);
    const endError = Math.abs(angleDifference(ship.angle,
      Math.atan2(target.y - ship.y, target.x - ship.x)));
    assert(endError < startError, "settled Hold faces its target");
  }

  // Maintain and Kite share range intent generation without band flags.
  {
    const maintain = battle("maintain", { shipX: 150 });
    const far = createMovementIntent(maintain.room, maintain.ship, maintain.ship.stats, 0);
    assert(far.debugReason.endsWith("approach"), "Maintain approaches from outside range");
    const desiredRange = far.desiredRange;
    maintain.ship.x = maintain.target.x - 40;
    maintain.ship.vx = 0;
    const close = createMovementIntent(maintain.room, maintain.ship, maintain.ship.stats, 0);
    assert(close.debugReason.endsWith("retreat"), "Maintain retreats inside range");
    assert(Math.hypot(
      close.destination.x - maintain.target.x,
      close.destination.y - maintain.target.y
    ) > 40, "Maintain retreat destination is away from the target");
    maintain.ship.x = maintain.target.x - desiredRange;
    maintain.ship.y = maintain.target.y;
    maintain.ship.vx = 0;
    maintain.ship.vy = 0;
    const reasons = [];
    for (let index = 0; index < 90; index += 1) {
      reasons.push(createMovementIntent(
        maintain.room,
        maintain.ship,
        maintain.ship.stats,
        index * DT * 1000
      ).debugReason);
      updateShipMovement(maintain.room, maintain.ship, DT, index * DT * 1000);
    }
    const changes = reasons.slice(1).reduce(
      (count, reason, index) => count + (reason !== reasons[index] ? 1 : 0),
      0
    );
    assert(changes < 8, `Maintain must not rapidly alternate state (changes ${changes})`);
    assert(Math.abs(
      Math.hypot(maintain.ship.x - maintain.target.x, maintain.ship.y - maintain.target.y)
      - desiredRange
    ) < desiredRange * 0.12, "Maintain remains stable near desired range");

    const kite = battle("kite", { shipX: 950 });
    assert(createMovementIntent(kite.room, kite.ship, kite.ship.stats, 0)
      .debugReason.endsWith("retreat"), "Kite retreats when too close");
    kite.ship.x = 100;
    assert(createMovementIntent(kite.room, kite.ship, kite.ship.stats, 0)
      .debugReason.endsWith("approach"), "Kite approaches only outside range");

    const obstacleKite = battle("kite", {
      shipX: 300,
      targetX: 1700,
      asteroids: [{ x: 900, y: 500, radius: 150 }]
    });
    updateShipMovement(obstacleKite.room, obstacleKite.ship, DT, 0);
    assert(obstacleKite.ship.movement.navigation.waypoints.length > 1,
      "Kite uses shared obstacle pathing");
  }

  // Orbit uses one radial+tangential velocity and never enters arrival braking.
  {
    const { room, ship, target } = battle("orbit", { shipX: 580, targetX: 1000 });
    const first = createMovementIntent(room, ship, ship.stats, 0);
    const desiredRange = first.desiredRange;
    const errors = [];
    let direction = null;
    for (let index = 0; index < 600; index += 1) {
      updateShipMovement(room, ship, DT, index * DT * 1000);
      direction ??= ship.movement.style.orbit.direction;
      assert.strictEqual(ship.movement.style.orbit.direction, direction,
        "Orbit direction remains committed");
      assert.notStrictEqual(ship.movement.phase, "braking",
        "Orbit tangential motion never uses arrival braking");
      if (index > 120) {
        errors.push(Math.abs(
          Math.hypot(ship.x - target.x, ship.y - target.y) - desiredRange
        ));
      }
    }
    const averageError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    assert(averageError < desiredRange * 0.25,
      `Orbit radius error stays bounded (average ${averageError.toFixed(1)})`);
    assert.strictEqual(ship.movement.navigation.waypoints.length, 0,
      "Orbit does not manufacture advancing arrival waypoints");
  }

  // Direct, Charge and Interceptor express destination choices but still use
  // the same navigation/collision pipeline.
  {
    const direct = battle("direct", {
      shipX: 300,
      targetX: 1700,
      asteroids: [{ x: 1000, y: 500, radius: 150 }]
    });
    updateShipMovement(direct.room, direct.ship, DT, 0);
    assert(direct.ship.movement.navigation.waypoints.length > 1,
      "Direct follows the shared obstacle route");
    let nearest = Infinity;
    for (let index = 1; index < 1200; index += 1) {
      updateShipMovement(direct.room, direct.ship, DT, index * DT * 1000);
      nearest = Math.min(nearest, Math.hypot(
        direct.ship.x - direct.target.x,
        direct.ship.y - direct.target.y
      ));
    }
    assert(nearest < 180, `Direct reaches or follows its target (nearest ${nearest.toFixed(1)})`);

    const charge = battle("charge", {
      shipX: 300,
      targetX: 1700,
      asteroids: [{ x: 1000, y: 500, radius: 150 }]
    });
    const chargeIntent = createMovementIntent(charge.room, charge.ship, charge.ship.stats, 0);
    assert.strictEqual(chargeIntent.maxSpeedFactor, 1, "Charge requests normal maximum speed");
    updateShipMovement(charge.room, charge.ship, DT, 0);
    assert(charge.ship.movement.navigation.waypoints.length > 1,
      "Charge does not bypass shared pathing");

    const interceptor = battle("interceptor", {
      shipX: 300,
      targetX: 1200,
      targetVx: 120
    });
    const movingPrediction = createMovementIntent(
      interceptor.room,
      interceptor.ship,
      interceptor.ship.stats,
      0
    );
    interceptor.target.vx = 0;
    const staticPrediction = createMovementIntent(
      interceptor.room,
      interceptor.ship,
      interceptor.ship.stats,
      0
    );
    assert(Math.hypot(
      movingPrediction.destination.x - staticPrediction.destination.x,
      movingPrediction.destination.y - staticPrediction.destination.y
    ) > 10, "Interceptor predicts target velocity");
  }

  // Sentry returns to one stored point; Evasive stores only a bounded dodge
  // direction/expiry; Brawler and Heavy differ by configured desired range.
  {
    const sentry = battle("sentry", { shipX: 500, targetX: 1200 });
    applyCombatStyle(sentry.ship, "sentry");
    const sentryPoint = { ...sentry.ship.movement.style.sentryPosition };
    sentry.ship.x += 180;
    const sentryIntent = createMovementIntent(sentry.room, sentry.ship, sentry.ship.stats, 0);
    assert.deepStrictEqual(sentryIntent.destination, sentryPoint, "Sentry returns to stored position");
    const before = Math.hypot(sentry.ship.x - sentryPoint.x, sentry.ship.y - sentryPoint.y);
    tick(sentry.room, [sentry.ship], 12);
    assert(Math.hypot(sentry.ship.x - sentryPoint.x, sentry.ship.y - sentryPoint.y) < before,
      "Sentry moves back toward its post");

    const evasive = battle("evasive");
    const evasiveIntent = createMovementIntent(evasive.room, evasive.ship, evasive.ship.stats, 1000);
    assert(evasiveIntent.desiredVelocity
      && Math.hypot(evasiveIntent.desiredVelocity.x, evasiveIntent.desiredVelocity.y) <= 120,
    "Evasive adds a bounded lateral velocity");
    updateShipMovement(evasive.room, evasive.ship, DT, 1000);
    const dodge = { ...evasive.ship.movement.style.evasive };
    updateShipMovement(evasive.room, evasive.ship, DT, 1050);
    assert.deepStrictEqual(evasive.ship.movement.style.evasive, dodge,
      "Evasive direction remains stable before expiry");
    updateShipMovement(evasive.room, evasive.ship, DT, dodge.expiresAt + 1);
    assert(evasive.ship.movement.style.evasive.expiresAt > dodge.expiresAt,
      "Evasive direction has a bounded expiry");

    const brawler = battle("brawler");
    const heavy = battle("heavy");
    assert(
      createMovementIntent(brawler.room, brawler.ship, brawler.ship.stats, 0).desiredRange
      < createMovementIntent(heavy.room, heavy.ship, heavy.ship.stats, 0).desiredRange,
      "Brawler and Heavy retain distinct preferred ranges"
    );
  }

  // Manual rotation uses one API, releases cleanly, and every new command clears it.
  {
    const setup = roomWithPlayers();
    const ship = runtimeShip("manual", 300, 300);
    const enemy = {
      id: "manual-enemy", ownerId: setup.enemyPlayer.id, alive: true,
      x: 1000, y: 300, vx: 0, vy: 0, radius: 30, design: [], stats: {}
    };
    const ally = {
      id: "manual-ally", ownerId: setup.player.id, alive: true,
      x: 700, y: 500, vx: 0, vy: 0, radius: 30, design: [], stats: {}
    };
    addShip(setup.room, setup.player, ship);
    addShip(setup.room, setup.enemyPlayer, enemy);
    setup.room.ships.set(ally.id, ally);

    commandShips(setup.room, setup.player, 800, 400, { shipIds: [ship.id] });
    const moveCommandId = ship.movement.command.id;
    rotateShips(setup.room, setup.player, {
      direction: 1,
      active: true,
      shipIds: [ship.id]
    });
    assert.strictEqual(ship.manualRotation, 1, "active:true starts manual rotation");
    assert.strictEqual(ship.movement.command.id, moveCommandId,
      "manual rotation does not replace the active command");
    rotateShips(setup.room, setup.player, {
      direction: 1,
      active: false,
      shipIds: [ship.id]
    });
    assert.strictEqual(ship.manualRotation, null, "active:false releases manual rotation");

    rotateShips(setup.room, setup.player, { direction: -1, active: true, shipIds: [ship.id] });
    commandShips(setup.room, setup.player, 900, 500, { shipIds: [ship.id] });
    assert.strictEqual(ship.manualRotation, null, "Move clears manual rotation");
    rotateShips(setup.room, setup.player, { direction: 1, active: true, shipIds: [ship.id] });
    commandShips(setup.room, setup.player, enemy.x, enemy.y, {
      shipIds: [ship.id],
      targetId: enemy.id
    });
    assert.strictEqual(ship.manualRotation, null, "Attack clears manual rotation");
    rotateShips(setup.room, setup.player, { direction: 1, active: true, shipIds: [ship.id] });
    commandShips(setup.room, setup.player, ally.x, ally.y, {
      shipIds: [ship.id],
      targetId: ally.id
    });
    assert.strictEqual(ship.manualRotation, null, "Repair clears manual rotation");
    rotateShips(setup.room, setup.player, { direction: 1, active: true, shipIds: [ship.id] });
    stopShips(setup.room, setup.player, [ship.id]);
    assert.strictEqual(ship.manualRotation, null, "Stop clears manual rotation");
  }

  // A normal click stops, rotates to the final route segment, then completes.
  {
    const setup = roomWithPlayers();
    const ship = runtimeShip("final-facing", 300, 300);
    addShip(setup.room, setup.player, ship);
    commandShips(setup.room, setup.player, 1500, 700, { shipIds: [ship.id] });
    updateShipMovement(setup.room, ship, DT, 0);
    const routeFacing = ship.movement.navigation.finalFacing;
    tick(setup.room, [ship], 45, DT * 1000);
    assert.strictEqual(ship.movement.phase, "positioned", "Move completes after final-facing");
    assert(Math.hypot(ship.vx, ship.vy) < 18, "Move completes at low speed");
    assert(Math.hypot(
      ship.x - ship.movement.command.destination.x,
      ship.y - ship.movement.command.destination.y
    ) < 32, "Move completes near its destination");
    assert(Math.abs(angleDifference(ship.angle, routeFacing)) < 0.04,
      "plain click uses the final route segment as final facing");
  }

  // Group commands discard unsafe original offsets and assign independent slots.
  {
    const setup = roomWithPlayers();
    const ships = [
      runtimeShip("group-a", 200, 200),
      runtimeShip("group-b", 200, 200),
      runtimeShip("group-c", 1400, 1200)
    ];
    for (const ship of ships) addShip(setup.room, setup.player, ship);
    commandShips(setup.room, setup.player, 1100, 800, {
      shipIds: ships.map((ship) => ship.id)
    });
    const destinations = ships.map((ship) => ship.movement.command.destination);
    assert(Math.hypot(
      destinations[2].x - destinations[0].x,
      destinations[2].y - destinations[0].y
    ) < 300, "group slots do not preserve the unsafe original fleet offset");
    assert(new Set(ships.map((ship) => ship.movement.command.id)).size === ships.length,
      "each group ship owns an independent command/path cache");
    for (let left = 0; left < ships.length; left += 1) {
      for (let right = left + 1; right < ships.length; right += 1) {
        assert(Math.hypot(
          destinations[left].x - destinations[right].x,
          destinations[left].y - destinations[right].y
        ) > physicalCollisionRadius(ships[left]) + physicalCollisionRadius(ships[right]),
        "group destination slots do not overlap");
      }
    }
    tick(setup.room, ships, 65, 0, true);
    assert(ships.every((ship) => ship.movement.phase === "positioned"),
      "all group ships arrive and finish facing");
    for (let left = 0; left < ships.length; left += 1) {
      for (let right = left + 1; right < ships.length; right += 1) {
        assert.strictEqual(
          findShipHullOverlap(ships[left], ships[right]),
          null,
          "group ships do not overlap at arrival"
        );
      }
    }
  }

  // The runtime is clean construction only; no legacy movement migration remains.
  {
    assert.deepStrictEqual(createMovementRuntime(), {
      command: null,
      navigation: {
        waypoints: [],
        waypointIndex: 0,
        plannedDestination: null,
        plannedAt: 0,
        commandId: null,
        clearance: null,
        finalFacing: null
      },
      style: {
        orbit: null,
        evasive: null,
        sentryPosition: null,
        holdPosition: null,
        holdTargetId: null
      },
      phase: "idle"
    }, "new movement runtime starts clean");
    const runtimeSource = fs.readFileSync(
      path.join(__dirname, "src/server/movementRuntime.js"),
      "utf8"
    );
    for (const legacyName of [
      "_movementCommand", "_movementPath", "_movementWaypointIndex",
      "rotationInput", "holdState", "orbitDir", "_evasiveDodgeDir", "sentryX"
    ]) {
      assert(!runtimeSource.includes(legacyName),
        `movement runtime must not contain legacy migration field ${legacyName}`);
    }
  }

  console.log("Movement styles verification passed");
  console.log("  intents: move/hold/maintain/kite/orbit/direct/sentry/charge/interceptor/evasive/brawler/heavy/repair/stop");
  console.log("  pipeline: navigation -> controller -> facing -> propulsion -> collision");
}

run();
