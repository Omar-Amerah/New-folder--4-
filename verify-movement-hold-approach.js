"use strict";

const assert = require("assert");
const { movementTestTick } = require("./tools/movementTestTick");
const { computeStats } = require("./src/server/shipStats");
const { commandShips, physicalCollisionRadius } = require("./src/server/movement");
const { getMaxEffectiveWeaponRange } = require("./src/server/componentData");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");
const { buildRoomSpatialIndex } = require("./src/server/spatialIndex");

const DT = 1 / 30;
const ARMED = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" }
];
const UNARMED = ARMED.slice(0, 3);
const LONG_RANGE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" },
  { x: 6, y: 7, type: "railgun" }
];
let sequence = 0;

function makeShip(x, y, options = {}) {
  const design = options.design || ARMED;
  const stats = computeStats(design);
  const ship = {
    id: options.id || `hold-approach-${++sequence}`,
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

function makeRoom(groups) {
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
  const room = {
    world: { width: 9000, height: 6000 },
    map: { asteroids: [], revision: 1 },
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

function simulate(room, ships, seconds, startMs = 0, onTick = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    const now = startMs + tick * DT * 1000;
    movementTestTick(room, ships, DT, now);
    if (onTick) onTick(tick, now);
  }
  return startMs + ticks * DT * 1000;
}

function attack(room, player, target, shipIds) {
  const result = commandShips(room, player, target.x, target.y, {
    shipIds,
    targetId: target.id
  });
  assert.strictEqual(result.code, "attack");
}

function laneSnapshot(ship) {
  const state = ship.movement?.holdApproach;
  return state && {
    commandId: state.commandId,
    laneIndex: state.laneIndex,
    laneOffset: state.laneOffset,
    approachX: state.approachX,
    approachY: state.approachY,
    perpendicularX: state.perpendicularX,
    perpendicularY: state.perpendicularY
  };
}

function lateralPosition(ship, target, state) {
  return (ship.x - target.x) * state.perpendicularX
    + (ship.y - target.y) * state.perpendicularY;
}

function addShip(room, ships, player, ship) {
  ships.push(ship);
  player.ships.push(ship);
  room.ships.set(ship.id, ship);
  buildRoomSpatialIndex(room, ships, 0);
}

function run() {
  // A selected Hold group receives one shallow, stable fan. The lanes are a
  // travel hint only: there are no target-relative combat slots or ring goals.
  {
    const target = makeShip(6500, 3000, { ownerId: "p2", design: UNARMED, angle: Math.PI });
    const ships = [
      makeShip(1800, 2600, { id: "hold-fan-0" }),
      makeShip(1800, 2800, { id: "hold-fan-1" }),
      makeShip(1800, 3000, { id: "hold-fan-2", design: LONG_RANGE }),
      makeShip(1800, 3200, { id: "hold-fan-3" }),
      makeShip(1800, 3400, { id: "hold-fan-4" })
    ];
    const { room, players } = makeRoom({ p1: ships, p2: [target] });
    attack(room, players.get("p1"), target, ships.map((ship) => ship.id));

    const before = new Map(ships.map((ship) => [ship.id, laneSnapshot(ship)]));
    assert(ships.every((ship) => before.get(ship.id)), "every Hold ship should receive a lane hint");
    assert.strictEqual(new Set(ships.map((ship) => before.get(ship.id).laneIndex)).size, ships.length,
      "the approach fan should assign one deterministic lane per ship");
    assert(ships.every((ship) => ship.movement.combatSlot === null),
      "Hold approach must not create target-relative combat slots");
    assert(ships.every((ship) => Math.abs(before.get(ship.id).approachX ** 2
      + before.get(ship.id).approachY ** 2 - 1) < 1e-6),
      "lane approach axes should be normalized");

    const ordered = ships.slice().sort((a, b) => before.get(a.id).laneOffset - before.get(b.id).laneOffset);
    let rangeChecked = false;
    const afterMs = simulate(room, ships, 5, 0, () => {
      if (rangeChecked) return;
      rangeChecked = true;
      const shortDestination = ships[0].movement.destination;
      const longDestination = ships[2].movement.destination;
      assert(shortDestination && longDestination,
        "each Hold ship should receive its own firing-range approach point");
      assert(Math.hypot(longDestination.x - target.x, longDestination.y - target.y)
        > Math.hypot(shortDestination.x - target.x, shortDestination.y - target.y) + 400,
      "a long-range Hold ship should approach to its own farther firing envelope");
    });
    assert(rangeChecked, "the fan range assertion should run during movement");
    for (const ship of ships) {
      assert.deepStrictEqual(laneSnapshot(ship), before.get(ship.id),
        `${ship.id} should retain its original lane after movement ticks`);
    }
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = before.get(ordered[index - 1].id);
      const current = before.get(ordered[index].id);
      assert(lateralPosition(ordered[index - 1], target, previous)
        <= lateralPosition(ordered[index], target, current) + 2,
      "Hold approach lanes must not cross while ships are travelling");
    }

    const removed = ships[2];
    removed.alive = false;
    const surviving = ships.filter((ship) => ship.alive);
    const survivingBefore = new Map(surviving.map((ship) => [ship.id, laneSnapshot(ship)]));
    const newcomer = makeShip(1800, 3500, { id: "hold-fan-new" });
    addShip(room, ships, players.get("p1"), newcomer);
    attack(room, players.get("p1"), target, [newcomer.id]);
    const newState = laneSnapshot(newcomer);
    const allOldOffsets = ships
      .filter((ship) => ship.id !== newcomer.id)
      .map((ship) => laneSnapshot(ship)?.laneOffset)
      .filter((offset) => Number.isFinite(offset));
    assert(newState.laneOffset < Math.min(...allOldOffsets)
      || newState.laneOffset > Math.max(...allOldOffsets),
    "a joining Hold ship should use an outer lane");
    for (const ship of surviving) {
      assert.deepStrictEqual(laneSnapshot(ship), survivingBefore.get(ship.id),
        `${ship.id} lane should not shift when a member dies and a new ship joins`);
    }
    // Keep the clock moving once after the join so the new state is exercised by
    // the same movement path that owns ordinary Hold orders.
    simulate(room, ships, 0.5, afterMs);
  }

  // Hold latches each hull independently. A target closing or moving sideways
  // only changes facing; pursuit resumes only after the firing solution is lost.
  {
    const target = makeShip(5200, 3000, { ownerId: "p2", design: UNARMED, angle: Math.PI });
    const near = makeShip(0, 0, { id: "hold-near" });
    near.x = target.x - getMaxEffectiveWeaponRange(near) * 0.65;
    near.y = target.y;
    near.targetX = near.x;
    near.targetY = near.y;
    const far = [
      makeShip(1700, 2400, { id: "hold-far-0" }),
      makeShip(1700, 2700, { id: "hold-far-1" }),
      makeShip(1700, 3300, { id: "hold-far-2" }),
      makeShip(1700, 3600, { id: "hold-far-3" })
    ];
    const ships = [near, ...far];
    const { room, players } = makeRoom({ p1: ships, p2: [target] });
    attack(room, players.get("p1"), target, ships.map((ship) => ship.id));
    movementTestTick(room, ships, DT, 0);
    assert(near.movement.holdEngaged, "a Hold ship already in a clear firing position should latch immediately");
    assert(!near.movement.destination, "an engaged Hold ship should not receive a pursuit destination");
    assert(far.some((ship) => !ship.movement.holdEngaged),
      "ships outside range should continue their own approach");

    const parked = { x: near.x, y: near.y };
    const parkedLane = laneSnapshot(near);
    let now = simulate(room, ships, 0.5, DT * 1000);
    target.x -= 120;
    target.y += 120;
    now = simulate(room, ships, 1, now);
    assert(near.movement.holdEngaged, "a target closing sideways inside the hold band must not pull the ship forward");
    assert(!near.movement.destination, "a latched Hold ship should rotate in place while the target remains fireable");
    assert(Math.hypot(near.x - parked.x, near.y - parked.y) < 8,
      "target-relative facing updates must not move an engaged Hold ship");
    assert.deepStrictEqual(laneSnapshot(near), parkedLane,
      "target movement must not regenerate the Hold approach lane");

    target.x += 2500;
    now = simulate(room, ships, 0.5, now);
    assert(!near.movement.holdEngaged, "Hold should leave its latch after the target opens the firing range");
    assert(near.movement.destination, "Hold should resume its own approach after losing firing range");
    assert.deepStrictEqual(laneSnapshot(near), parkedLane,
      "later pursuit should reuse the original lane hint");
  }

  // A friendly directly on a Hold approach produces one deterministic local
  // sidestep, while hard circular separation prevents deep overlap or pushing.
  {
    const attacker = makeShip(1000, 3000, { id: "hold-sidestep-attacker" });
    const blocker = makeShip(1550, 3000, { id: "hold-sidestep-blocker" });
    const target = makeShip(6000, 3000, { ownerId: "p2", design: UNARMED, angle: Math.PI });
    const { room, ships, players } = makeRoom({ p1: [attacker, blocker], p2: [target] });
    attack(room, players.get("p1"), target, [attacker.id]);
    let sidestepped = false;
    let minimumGap = Infinity;
    let maximumDeviation = 0;
    simulate(room, ships, 8, 0, () => {
      sidestepped ||= attacker.movement.traffic?.mode === "sidestep";
      minimumGap = Math.min(minimumGap,
        Math.hypot(attacker.x - blocker.x, attacker.y - blocker.y)
        - physicalCollisionRadius(attacker) - physicalCollisionRadius(blocker));
      maximumDeviation = Math.max(maximumDeviation, Math.abs(attacker.y - 3000));
    });
    assert(sidestepped || maximumDeviation > 20,
      "a Hold ship blocked by a friendly should commit a visible local sidestep");
    assert(minimumGap >= -1,
      `Hold friendly traffic should remain circularly separated (${minimumGap.toFixed(1)} px gap)`);
    assert(attacker.x > 1100, "a local sidestep should preserve forward progress after the blocker");
  }

  console.log("verify-movement-hold-approach: OK");
}

run();
