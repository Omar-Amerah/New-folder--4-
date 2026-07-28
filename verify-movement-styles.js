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
const { getEffectiveWeaponRanges } = require("./src/server/componentData");
const { angleDifference } = require("./src/server/utils");
const { sanitizeCombatStyle } = require("./src/server/validation");
const { findShipHullOverlap } = require("./src/server/componentGeometry");
const { findTarget } = require("./src/server/combat");
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

function maximumWeaponRange(ship) {
  return Math.max(0, ...Object.values(getEffectiveWeaponRanges(ship)).map(Number).filter(Number.isFinite));
}

function run() {
  assert.strictEqual(sanitizeCombatStyle("circle"), "orbit", "Circle remains an Orbit alias");
  assert.strictEqual(sanitizeCombatStyle("maintain"), "hold", "Maintain migrates to Hold");
  assert.strictEqual(sanitizeCombatStyle("sentry"), "hold", "Sentry migrates to Hold");
  assert.strictEqual(sanitizeCombatStyle("direct"), "charge", "Direct migrates to Charge");
  assert.strictEqual(sanitizeCombatStyle("evasive"), "orbit", "Evasive migrates to Orbit");
  assert.deepStrictEqual(
    [...SUPPORTED_MOVEMENT_TYPES].sort(),
    ["charge", "hold", "kite", "move", "orbit", "repair", "stop"].sort(),
    "only the revised stance and command intent types are registered"
  );

  const combatStyles = ["charge", "hold", "orbit", "kite"];
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
    assert.strictEqual(intent.type, style,
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
  const indexSource = fs.readFileSync(path.join(__dirname, "public/index.html"), "utf8");
  assert.deepStrictEqual(
    [...indexSource.matchAll(/data-combat-style="([^"]+)"/g)].map((match) => match[1]),
    ["charge", "hold", "orbit", "kite"],
    "the in-match stance controls expose exactly the revised four stances"
  );
  const sidePanelSource = fs.readFileSync(
    path.join(__dirname, "public/src/ui/sidePanelUi.js"),
    "utf8"
  );
  for (const legacy of ["sentry", "maintain", "direct", "interceptor", "evasive", "brawler", "heavy"]) {
    assert(!sidePanelSource.includes(`{ id: "${legacy}"`),
      `legacy ${legacy} must not remain an in-match stance choice`);
  }

  // An acquired enemy must immediately hand movement to the combat stance,
  // even when a persistent Move/Rally/Stop command was already active.
  for (const style of combatStyles) {
    const setup = roomWithPlayers();
    const ship = runtimeShip(`command-priority-${style}`, 300, 500);
    ship.combatStyle = style;
    const target = {
      id: `command-priority-target-${style}`,
      ownerId: setup.enemyPlayer.id,
      alive: true,
      x: 900,
      y: 500,
      vx: 0,
      vy: 0,
      radius: 30,
      design: [],
      stats: { weaponDps: 1 }
    };
    addShip(setup.room, setup.player, ship);
    addShip(setup.room, setup.enemyPlayer, target);
    commandShips(setup.room, setup.player, 300, 1200, { shipIds: [ship.id] });
    ship.combatTargetId = target.id;
    assert.strictEqual(
      createMovementIntent(setup.room, ship, ship.stats, 0).type,
      style,
      `${style}: an acquired enemy overrides a persistent move command`
    );
    target.alive = false;
    assert.strictEqual(
      createMovementIntent(setup.room, ship, ship.stats, 0).type,
      "move",
      `${style}: the interrupted move command resumes after the enemy becomes invalid`
    );
    target.alive = true;
    stopShips(setup.room, setup.player, [ship.id]);
    ship.combatTargetId = target.id;
    assert.strictEqual(
      createMovementIntent(setup.room, ship, ship.stats, 0).type,
      style,
      `${style}: an acquired enemy overrides a persistent stop command`
    );
    target.alive = false;
    assert.strictEqual(
      createMovementIntent(setup.room, ship, ship.stats, 0).type,
      "stop",
      `${style}: the stop command resumes after the enemy becomes invalid`
    );
    ship.focusTargetId = ship.id;
    assert.strictEqual(
      createMovementIntent(setup.room, ship, ship.stats, 0).type,
      "stop",
      `${style}: a living allied/stale target ID does not activate combat movement`
    );
  }

  {
    const setup = roomWithPlayers();
    const hunter = runtimeShip("stable-target-hunter", 300, 500);
    hunter.combatStyle = "charge";
    const current = {
      id: "stable-current", ownerId: setup.enemyPlayer.id, alive: true,
      x: 650, y: 500, vx: 0, vy: 0, radius: 30, design: [], stats: { weaponDps: 1 }
    };
    const tempting = {
      id: "tempting-replacement", ownerId: setup.enemyPlayer.id, alive: true,
      x: 500, y: 500, vx: 0, vy: 0, radius: 30, design: [], stats: { weaponDps: 10000 }
    };
    addShip(setup.room, setup.player, hunter);
    addShip(setup.room, setup.enemyPlayer, current);
    addShip(setup.room, setup.enemyPlayer, tempting);
    hunter.combatTargetId = current.id;
    assert.strictEqual(findTarget(setup.room, hunter, [hunter, current, tempting]), current,
      "a valid current target remains stable despite another target's higher threat score");
    current.x = 5000;
    setup.room.map.asteroids.push({ x: 1000, y: 500, radius: 180 });
    assert.strictEqual(findTarget(setup.room, hunter, [hunter, current, tempting]), current,
      "range and asteroid occlusion do not invalidate the current movement target");
    current.alive = false;
    hunter.focusTargetId = current.id;
    hunter.combatTargetId = findTarget(
      setup.room,
      hunter,
      [hunter, current, tempting]
    )?.id || null;
    assert.strictEqual(hunter.combatTargetId, tempting.id,
      "a stance acquires another nearby enemy when its current target becomes invalid");
    assert.strictEqual(
      createMovementIntent(setup.room, hunter, hunter.stats, 0).facingTargetId,
      tempting.id,
      "a stale focus ID does not mask the valid replacement movement target"
    );
  }

  {
    const setup = roomWithPlayers();
    const holder = runtimeShip("local-hold-targeting", 300, 500);
    holder.combatStyle = "hold";
    const departed = {
      id: "departed-hold-target",
      ownerId: setup.enemyPlayer.id,
      alive: true,
      x: 1800,
      y: 500,
      vx: 0,
      vy: 0,
      radius: 30,
      design: [],
      stats: { weaponDps: 1 }
    };
    const nearby = {
      id: "nearby-hold-target",
      ownerId: setup.enemyPlayer.id,
      alive: true,
      x: 650,
      y: 500,
      vx: 0,
      vy: 0,
      radius: 30,
      design: [],
      stats: { weaponDps: 1 }
    };
    addShip(setup.room, setup.player, holder);
    addShip(setup.room, setup.enemyPlayer, departed);
    addShip(setup.room, setup.enemyPlayer, nearby);
    holder.combatTargetId = departed.id;
    assert.strictEqual(
      findTarget(setup.room, holder, [holder, departed, nearby]),
      nearby,
      "automatic Hold switches to a nearby engageable enemy instead of moving unnecessarily"
    );
    holder.focusTargetId = departed.id;
    assert.strictEqual(
      findTarget(setup.room, holder, [holder, departed, nearby]),
      departed,
      "an explicit target remains authoritative for Hold"
    );
  }

  // A Hold station outlives the target that prompted it: switching to another
  // enemy that is reachable from the same spot must not restart an approach.
  {
    const { room, ship, target } = battle("hold", { shipX: 200 });
    tick(room, [ship], 12);
    const station = { ...ship.movement.style.holdPosition };
    assert(Number.isFinite(station.x), "Hold has a station to retain");
    const replacement = {
      id: "second-hold-target",
      ownerId: room.players.get("p2").id,
      alive: true,
      x: station.x + maximumWeaponRange(ship) * 0.8,
      y: station.y + 60,
      vx: 0,
      vy: 0,
      radius: 30,
      stats: { mass: 20 },
      design: []
    };
    addShip(room, room.players.get("p2"), replacement);
    target.alive = false;
    ship.combatTargetId = replacement.id;
    const swapped = createMovementIntent(room, ship, ship.stats, 20000);
    assert.strictEqual(swapped.debugReason, "hold:station-retained-new-target",
      "Hold engages another nearby enemy from the position it already occupies");
    assert.deepStrictEqual(swapped.destination, station,
      "Hold does not move to the new target's range ring");
    assert.strictEqual(swapped.facingTargetId, replacement.id,
      "Hold turns to the replacement target without relocating");
    tick(room, [ship], 3, 21000);
    assert(Math.hypot(ship.x - station.x, ship.y - station.y) < 4,
      "Hold stays put while engaging the replacement target");
    // Out of reach of the station is the one case worth moving for.
    replacement.x = station.x + maximumWeaponRange(ship) + 400;
    assert.strictEqual(
      createMovementIntent(room, ship, ship.stats, 22000).debugReason,
      "hold:approach-outside-range",
      "Hold gives up its station once nothing it is shooting at is reachable from it"
    );
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

  // Hold approaches only from outside preferred weapon range, establishes a
  // fixed position inside it, and never retreats from a closer target.
  {
    const { room, ship, target } = battle("hold", { shipX: 200 });
    const positioning = createMovementIntent(room, ship, ship.stats, 0);
    assert.strictEqual(positioning.debugReason, "hold:approach-outside-range");
    ship.x = positioning.destination.x;
    ship.y = positioning.destination.y;
    ship.vx = 0;
    ship.vy = 0;
    tick(room, [ship], DT * 2);
    const held = { ...ship.movement.style.holdPosition };
    assert(Number.isFinite(held.x) && Number.isFinite(held.y), "Hold stores one fixed position");
    target.x = held.x + 40;
    target.y = held.y;
    const close = createMovementIntent(room, ship, ship.stats, 100);
    assert.deepStrictEqual(close.destination, held,
      "Hold never retreats when the target moves closer");
    target.x = 1000;
    target.y = 500;
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
    target.x = held.x + positioning.desiredRange * 2;
    const reacquireRange = createMovementIntent(room, ship, ship.stats, 12000);
    assert.strictEqual(reacquireRange.debugReason, "hold:approach-outside-range",
      "Hold approaches again after the target leaves preferred range");

    const simulated = battle("hold", { shipX: 200 });
    const simulatedRange = createMovementIntent(
      simulated.room,
      simulated.ship,
      simulated.ship.stats,
      0
    ).desiredRange;
    tick(simulated.room, [simulated.ship], 12);
    const settledDistance = Math.hypot(
      simulated.ship.x - simulated.target.x,
      simulated.ship.y - simulated.target.y
    );
    assert(settledDistance <= simulatedRange + 24,
      "Hold reaches its preferred range in the production movement loop");
    assert(Math.hypot(simulated.ship.vx, simulated.ship.vy) < 18,
      "Hold stops after entering its preferred range");
    // Arrival braking parks the ship short of the ring, so a commit test written
    // as distance <= desiredRange never fires in the real loop and the ship
    // range-keeps forever instead of establishing a station.
    assert(simulated.ship.movement.style.holdPosition,
      "Hold commits a station in the production movement loop, not only when placed exactly on the ring");
    assert.strictEqual(
      createMovementIntent(simulated.room, simulated.ship, simulated.ship.stats, 12500)
        .debugReason,
      "hold:established-position",
      "a settled Hold reports its established position rather than a permanent approach");
    const station = { x: simulated.ship.x, y: simulated.ship.y };
    // A target drifting past the preferred range but still shootable is not
    // worth giving up a firing position for.
    const holdMaximumRange = maximumWeaponRange(simulated.ship);
    simulated.target.x = station.x + (simulatedRange + holdMaximumRange) / 2;
    simulated.target.y = station.y;
    tick(simulated.room, [simulated.ship], 3, 12600);
    assert(Math.hypot(simulated.ship.x - station.x, simulated.ship.y - station.y) < 4,
      "Hold stays on station while the target is still inside weapon range");
    simulated.target.x = simulated.ship.x + 40;
    simulated.target.y = simulated.ship.y;
    tick(simulated.room, [simulated.ship], 3, 13000);
    assert(Math.hypot(simulated.ship.x - station.x, simulated.ship.y - station.y) < 4,
      "Hold does not retreat when its target closes");
    simulated.target.x = simulated.ship.x + simulatedRange + 250;
    const outsideDistance = Math.hypot(
      simulated.ship.x - simulated.target.x,
      simulated.ship.y - simulated.target.y
    );
    tick(simulated.room, [simulated.ship], 3, 17000);
    assert(Math.hypot(
      simulated.ship.x - simulated.target.x,
      simulated.ship.y - simulated.target.y
    ) < outsideDistance, "Hold approaches again when its target leaves range");
  }

  // Kite retreats only while too close, preserves separation in its safe band,
  // and approaches only after the target is beyond maximum weapon range.
  {
    const kite = battle("kite", { shipX: 950 });
    const retreat = createMovementIntent(kite.room, kite.ship, kite.ship.stats, 0);
    assert.strictEqual(retreat.debugReason, "kite:retreat-too-close");
    assert(Math.hypot(retreat.destination.x - kite.target.x, retreat.destination.y - kite.target.y)
      > Math.hypot(kite.ship.x - kite.target.x, kite.ship.y - kite.target.y),
    "Kite retreat destination increases separation");
    kite.ship.x = kite.target.x - (retreat.desiredRange + maximumWeaponRange(kite.ship)) / 2;
    kite.ship.vx = 0;
    kite.ship.vy = 0;
    const safe = createMovementIntent(kite.room, kite.ship, kite.ship.stats, 0);
    assert.strictEqual(safe.debugReason, "kite:safe-range-restored");
    assert.deepStrictEqual(safe.desiredVelocity, { x: 0, y: 0 },
      "Kite stops retreating once safe range is restored");
    kite.ship.x = 100;
    assert.strictEqual(createMovementIntent(kite.room, kite.ship, kite.ship.stats, 0)
      .debugReason, "kite:approach-outside-weapon-range",
    "Kite approaches only outside weapon range");

    const simulated = battle("kite", { shipX: 950 });
    const simulatedIntent = createMovementIntent(
      simulated.room,
      simulated.ship,
      simulated.ship.stats,
      0
    );
    tick(simulated.room, [simulated.ship], 12);
    const restoredDistance = Math.hypot(
      simulated.ship.x - simulated.target.x,
      simulated.ship.y - simulated.target.y
    );
    assert(Math.abs(restoredDistance - simulatedIntent.desiredRange) < 28,
      "Kite restores its safe range in the production movement loop");
    assert(Math.hypot(simulated.ship.vx, simulated.ship.vy) < 18,
      "Kite stops retreating once the static target is at safe range");
    simulated.target.x = simulated.ship.x + maximumWeaponRange(simulated.ship) + 250;
    simulated.target.y = simulated.ship.y;
    const farDistance = Math.hypot(
      simulated.ship.x - simulated.target.x,
      simulated.ship.y - simulated.target.y
    );
    tick(simulated.room, [simulated.ship], 3, 13000);
    assert(Math.hypot(
      simulated.ship.x - simulated.target.x,
      simulated.ship.y - simulated.target.y
    ) < farDistance, "Kite approaches after the target moves beyond weapon range");

    const obstacleKite = battle("kite", {
      shipX: 300,
      targetX: 1700,
      asteroids: [{ x: 900, y: 500, radius: 150 }]
    });
    updateShipMovement(obstacleKite.room, obstacleKite.ship, DT, 0);
    assert(obstacleKite.ship.movement.navigation.waypoints.length > 1,
      "Kite uses shared obstacle pathing");
  }

  // Orbit circles a lead point on the ring: it holds one radius and one
  // direction, never enters arrival braking, and paths around obstacles.
  {
    const { room, ship, target } = battle("orbit", { shipX: 580, targetX: 1000 });
    const first = createMovementIntent(room, ship, ship.stats, 0);
    const desiredRange = first.desiredRange;
    assert(Math.abs(desiredRange - maximumWeaponRange(ship) * 0.9) < 1,
      "Orbit circles at 90% of maximum weapon range");
    assert.strictEqual(first.arrivalRequired, false,
      "Orbit never requests arrival, so radius correction skips arrival braking");
    const errors = [];
    const speeds = [];
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
        speeds.push(Math.hypot(ship.vx, ship.vy));
      }
    }
    const averageError = errors.reduce((sum, value) => sum + value, 0) / errors.length;
    assert(averageError < desiredRange * 0.25,
      `Orbit radius error stays bounded (average ${averageError.toFixed(1)})`);
    // The previous radial+tangential blend crawled at roughly a tenth of top
    // speed because its tangential term was capped by sqrt(accel * r * 0.1).
    const averageSpeed = speeds.reduce((sum, value) => sum + value, 0) / speeds.length;
    assert(averageSpeed > ship.stats.maxSpeed * 0.35,
      `Orbit circles at a useful fraction of top speed (${averageSpeed.toFixed(1)} of ${ship.stats.maxSpeed.toFixed(1)})`);

    // An asteroid sitting on the circle is routed around, not flown into, and
    // the ship is still orbiting once it is past.
    const blocked = battle("orbit", { shipX: 300, targetX: 1200, targetY: 500 });
    const blockedRange = createMovementIntent(
      blocked.room,
      blocked.ship,
      blocked.ship.stats,
      0
    ).desiredRange;
    const rock = { x: 1200 - blockedRange, y: 500, radius: 140 };
    blocked.room.map.asteroids.push(rock);
    let routed = false;
    let minimumClearance = Infinity;
    for (let index = 0; index < 900; index += 1) {
      updateShipMovement(blocked.room, blocked.ship, DT, index * DT * 1000);
      routed ||= blocked.ship.movement.navigation.waypoints.length > 1;
      minimumClearance = Math.min(
        minimumClearance,
        Math.hypot(blocked.ship.x - rock.x, blocked.ship.y - rock.y) - rock.radius
      );
    }
    assert(routed, "Orbit uses shared obstacle pathing around an asteroid on its circle");
    assert(minimumClearance > 0,
      `Orbit never flies into the asteroid (closest approach ${minimumClearance.toFixed(1)} px)`);
    assert(Math.abs(
      Math.hypot(blocked.ship.x - blocked.target.x, blocked.ship.y - blocked.target.y)
        - blockedRange
    ) < blockedRange * 0.3, "Orbit rejoins its circle after clearing the obstacle");
  }

  // Charge pursues through weapon range and stops only at contact distance while
  // still using shared obstacle navigation.
  {
    const charge = battle("charge", {
      shipX: 300,
      targetX: 1700,
      asteroids: [{ x: 1000, y: 500, radius: 150 }]
    });
    const chargeIntent = createMovementIntent(charge.room, charge.ship, charge.ship.stats, 0);
    assert.strictEqual(chargeIntent.maxSpeedFactor, 1, "Charge requests normal maximum speed");
    assert.strictEqual(chargeIntent.arrivalRequired, true,
      "Charge stops only when its contact destination is reached");
    updateShipMovement(charge.room, charge.ship, DT, 0);
    assert(charge.ship.movement.navigation.waypoints.length > 1,
      "Charge does not bypass shared pathing");
    charge.ship.x = charge.target.x - maximumWeaponRange(charge.ship) * 0.5;
    charge.ship.y = charge.target.y;
    const insideWeaponRange = createMovementIntent(
      charge.room,
      charge.ship,
      charge.ship.stats,
      100
    );
    assert.strictEqual(insideWeaponRange.debugReason, "charge:pursue-to-contact");
    assert(insideWeaponRange.destination.x > charge.ship.x,
      "Charge continues closing after entering weapon range");

    const contact = battle("charge", { shipX: 300, targetX: 1000 });
    const contactIntent = createMovementIntent(contact.room, contact.ship, contact.ship.stats, 0);
    tick(contact.room, [contact.ship], 30);
    const contactDistance = Math.hypot(
      contact.ship.x - contact.target.x,
      contact.ship.y - contact.target.y
    );
    assert.strictEqual(contact.ship.movement.phase, "positioned",
      "Charge settles only after reaching contact distance");
    assert(Math.abs(contactDistance - contactIntent.desiredRange) < 24,
      `Charge stops near required contact distance (error ${Math.abs(contactDistance - contactIntent.desiredRange).toFixed(1)})`);
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
  console.log("  stances: charge/hold/orbit/kite");
  console.log("  commands: move/repair/stop");
  console.log("  pipeline: navigation -> controller -> facing -> propulsion -> collision");
}

run();
