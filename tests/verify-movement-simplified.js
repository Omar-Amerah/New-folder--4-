"use strict";

// Acceptance tests for the deliberately small movement model. These tests use
// the same movementTestTick boundary as the authoritative simulation.

const assert = require("node:assert/strict");
const fs = require("fs");
const { movementTestTick } = require("../tools/movementTestTick");
const {
  commandShips,
  maxFriendlyCorrectionPerTick,
  physicalCollisionRadius,
  resolveMapCollision,
  resolveSeparationPair
} = require("../src/server/movement");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const {
  computeDesignCollisionRadius,
  findShipHullOverlap,
  shipHullCircles
} = require("../src/server/componentGeometry");
const { getMaxEffectiveWeaponRange } = require("../src/server/componentData");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];
const GUNSHIP = [...BASE, { x: 6, y: 7, type: "blaster", rotation: 0 }];

let sequence = 0;

function makeShip({
  x,
  y,
  id = `simplified-${++sequence}`,
  ownerId = "p1",
  team = ownerId === "p1" ? "A" : "B",
  design = BASE,
  combatStyle = "hold",
  angle = 0,
  physicalRadius = null,
  mass = null
}) {
  const stats = computeStats(design);
  const ship = {
    id,
    ownerId,
    team,
    alive: true,
    removed: false,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: physicalRadius ?? computeDesignCollisionRadius(design, stats),
    design: design.map((part) => ({ ...part })),
    dataLinks: [],
    stats: { ...stats, ...(mass ? { mass } : {}) },
    combatStyle,
    combatStyleRaw: combatStyle,
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

function makeRoom(ships, asteroids = [], target = null) {
  const allShips = target ? [...ships, target] : [...ships];
  const players = new Map();
  for (const ship of allShips) {
    if (!players.has(ship.ownerId)) players.set(ship.ownerId, {
      id: ship.ownerId,
      team: ship.team,
      ships: []
    });
    players.get(ship.ownerId).ships.push(ship);
  }
  return {
    phase: "active",
    world: { width: 4200, height: 3000 },
    map: { asteroids, relays: [], revision: 1 },
    ships: new Map(allShips.map((ship) => [ship.id, ship])),
    players,
    stations: [],
    stationsById: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    spawnCollisionDiagnostics: {}
  };
}

function player(room, id = "p1") {
  return room.players.get(id);
}

function tick(room, ships, count, start = 0, onTick = null) {
  for (let index = 0; index < count; index += 1) {
    movementTestTick(room, ships, DT, start + index * DT * 1000);
    if (onTick) onTick(index);
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function hullClearance(a, b) {
  let clearance = Infinity;
  for (const ca of shipHullCircles(a)) {
    for (const cb of shipHullCircles(b)) {
      clearance = Math.min(clearance, Math.hypot(cb.x - ca.x, cb.y - ca.y) - ca.radius - cb.radius);
    }
  }
  return clearance;
}

function assertNoLegacyMovementState() {
  const production = [
    "src/server/movementV2.js",
    "src/server/movementRuntimeV2.js",
    "src/server/movementCollision.js",
    "src/server/movementContactPairs.js",
    "src/server/movementContactSafety.js",
    "src/server/ships.js",
    "src/server/spawnPlanner.js"
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const term of [
    "combatSlot",
    "holdApproach",
    "assignHoldApproachLanes",
    "friendlyHoldApproachPair",
    "tryStaticSlideRecovery",
    "trafficPriorityWinner",
    "softFriendlyContact",
    "formationSlot",
    "assignCombatSlots",
    "targetRelative",
    "laneIndex"
  ]) {
    assert.equal(production.includes(term), false, `production movement still references ${term}`);
  }
}

function run() {
  // Ordinary group movement: one fixed formation slot per ship, resolved once.
  {
    const ships = Array.from({ length: 10 }, (_, index) => makeShip({
      id: `crowd-${index}`,
      x: 400 + index * 110,
      y: 700,
      angle: 0
    }));
    const room = makeRoom(ships);
    const destination = { x: 2600, y: 1500 };
    const result = commandShips(room, player(room), destination.x, destination.y, {
      shipIds: ships.map((ship) => ship.id)
    });
    assert.equal(result.commanded, ships.length);
    assert.equal(result.formation, "clump");
    assert.equal(new Set(ships.map((ship) => `${ship.movement.destination.x}:${ship.movement.destination.y}`)).size,
      ships.length, "every ship should get its own fixed slot");
    assert.equal(new Set(ships.map((ship) => ship.movement.arrivalRadius)).size, 1);
    assert.equal(ships[0].movement.arrivalRadius, 16,
      "a ship with its own slot keeps the normal arrival radius");
    assert(ships.every((ship) => ship.movement.command.formation?.type === "clump"));
    assert(ships.every((ship) => !Object.keys(ship.movement).some((key) => (
      ["combatSlot", "holdApproach", "formationSlot", "laneIndex"].includes(key)
    ))));
    const assignedSlots = new Map(ships.map((ship) => [ship.id, { ...ship.movement.destination }]));

    let maximumDisplacementOverIntegration = 0;
    for (let tickIndex = 0; tickIndex < 1500; tickIndex += 1) {
      const before = new Map(ships.map((ship) => [ship.id, { x: ship.x, y: ship.y }]));
      movementTestTick(room, ships, DT, tickIndex * DT * 1000);
      for (const ship of ships) {
        const integrated = Math.hypot(ship._integratedMovementX || 0, ship._integratedMovementY || 0);
        const correctionAllowance = maxFriendlyCorrectionPerTick(ship) + 1e-6;
        const previous = before.get(ship.id);
        maximumDisplacementOverIntegration = Math.max(
          maximumDisplacementOverIntegration,
          Math.hypot(ship.x - previous.x, ship.y - previous.y) - integrated - correctionAllowance
        );
      }
      // Hulls, not bounding circles: ships are allowed to sit closer than the
      // sum of their radii, which is exactly the point of hull-level contact.
      // What they may not do is share space.
      for (let i = 0; i < ships.length; i += 1) {
        for (let j = i + 1; j < ships.length; j += 1) {
          const overlap = findShipHullOverlap(ships[i], ships[j]);
          assert(!overlap || overlap.penetration <= 8,
            `crowd ships visibly overlap at tick ${tickIndex}: ${ships[i].id}/${ships[j].id}`
              + ` penetration ${overlap ? overlap.penetration.toFixed(1) : 0}`);
        }
      }
    }
    assert(maximumDisplacementOverIntegration <= 0.01,
      `friendly correction exceeded its tick budget (${maximumDisplacementOverIntegration})`);
    assert(ships.every((ship) => {
      const slot = assignedSlots.get(ship.id);
      return ship.movement.destination.x === slot.x && ship.movement.destination.y === slot.y;
    }), "formation slots must not be regenerated while the order runs");
    assert(Math.max(...ships.map((ship) => distance(ship, assignedSlots.get(ship.id)))) <= 60,
      `every ship should settle on its own slot (${ships.map((ship) => `${ship.id}:${distance(ship, assignedSlots.get(ship.id)).toFixed(0)}`).join(",")})`);
    const settled = ships.map((ship) => [ship.x, ship.y]);
    tick(room, ships, 120, 25000);
    assert(ships.every((ship, index) => Math.hypot(ship.x - settled[index][0], ship.y - settled[index][1]) < 3),
      "a settled crowd should not continuously push or jitter");
  }

  // A single ship keeps the normal small arrival radius.
  {
    const ship = makeShip({ x: 400, y: 400 });
    const room = makeRoom([ship]);
    commandShips(room, player(room), 1300, 400, { shipIds: [ship.id] });
    assert.equal(ship.movement.arrivalRadius, 16);
    tick(room, [ship], 600);
    assert(distance(ship, { x: 1300, y: 400 }) <= 20, "a single ship should reach a clear destination");
  }

  // A route around one static obstacle remains an ordinary move order.
  {
    const ship = makeShip({ x: 400, y: 1000 });
    const asteroid = { id: "asteroid-1", x: 1100, y: 1000, radius: 170 };
    const room = makeRoom([ship], [asteroid]);
    commandShips(room, player(room), 1800, 1000, { shipIds: [ship.id] });
    tick(room, [ship], 1000);
    assert(distance(ship, { x: 1800, y: 1000 }) <= 28, "a ship should route around one asteroid");
    assert.equal(ship.movement.blocked, false, "a valid static route should not remain blocked");
  }

  // Static contact is physical and can slide. It is not itself a blocked order.
  {
    const ship = makeShip({ x: 700, y: 1000 });
    ship.vx = 0;
    ship.vy = 42;
    const asteroid = { id: "asteroid-slide", x: 500, y: 1000, radius: 182 };
    const room = makeRoom([ship], [asteroid]);
    resolveMapCollision(room, ship);
    assert(ship.vy > 40, "tangential velocity should survive asteroid contact");
    commandShips(room, player(room), 1600, 1000, { shipIds: [ship.id] });
    tick(room, [ship], 30);
    assert.notEqual(ship.movement.phase, "blocked", "touching an asteroid must not immediately block a move");
  }

  // Friendly separation is a capped, deterministic pair correction and keeps
  // tangential velocity instead of zeroing the whole vector.
  {
    const a = makeShip({ id: "pair-a", x: 1000, y: 1000, physicalRadius: 30 });
    const b = makeShip({ id: "pair-b", x: 1040, y: 1000, physicalRadius: 30 });
    a.vx = 20; a.vy = 17;
    b.vx = -20; b.vy = 17;
    const room = makeRoom([a, b]);
    const beforeA = { x: a.x, y: a.y };
    const beforeB = { x: b.x, y: b.y };
    const result = resolveSeparationPair(room, a, b);
    assert(result, "the overlapping friendly pair should resolve");
    assert(Math.hypot(a.x - beforeA.x, a.y - beforeA.y) <= maxFriendlyCorrectionPerTick(a) + 1e-6);
    assert(Math.hypot(b.x - beforeB.x, b.y - beforeB.y) <= maxFriendlyCorrectionPerTick(b) + 1e-6);
    assert.equal(a.vy, 17, "friendly collision should preserve tangent velocity on A");
    assert.equal(b.vy, 17, "friendly collision should preserve tangent velocity on B");
    // A head-on contact takes the closing speed off both hulls without
    // bouncing either of them back the way it came.
    assert(a.vx >= 0 && a.vx < 6, `A's inward speed should be taken off without a bounce (${a.vx})`);
    assert(b.vx >= 0 && b.vx < 6, `B's inward speed should be taken off without a bounce (${b.vx})`);
    assert(a.vx - b.vx < 20, "and the pair is no longer closing");
  }

  // A slow-turning hull takes a direct, convergent path rather than circling a
  // waypoint. The final distance is the player-facing invariant.
  {
    const slow = makeShip({ x: 700, y: 600, design: [...BASE,
      { x: 6, y: 6, type: "frame" }, { x: 9, y: 6, type: "frame" },
      { x: 6, y: 9, type: "frame" }, { x: 9, y: 9, type: "frame" }], angle: 0 });
    const room = makeRoom([slow]);
    commandShips(room, player(room), 700, 2200, { shipIds: [slow.id] });
    let minimum = Infinity;
    tick(room, [slow], 1200, 0, () => { minimum = Math.min(minimum, distance(slow, { x: 700, y: 2200 })); });
    assert(minimum < 200, "the slow-turning ship should converge on the waypoint");
    assert(distance(slow, { x: 700, y: 2200 }) < 30, "the slow-turning ship should not orbit the waypoint");
  }

  // Hold ships share only the target identity; firing solutions and stopping
  // points remain per ship.
  {
    const target = makeShip({ id: "hold-target", x: 2200, y: 1500, ownerId: "p2", team: "B", design: GUNSHIP });
    const ships = [
      makeShip({ id: "hold-a", x: 600, y: 1050, design: GUNSHIP, combatStyle: "hold" }),
      makeShip({ id: "hold-b", x: 600, y: 1950, design: GUNSHIP, combatStyle: "hold" })
    ];
    const room = makeRoom(ships, [], target);
    commandShips(room, player(room), target.x, target.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: target.id
    });
    assert(ships.every((ship) => ship.movement.command.targetId === target.id));
    tick(room, ships, 1000);
    const reach = Math.max(...ships.map((ship) => getMaxEffectiveWeaponRange(ship)));
    assert(ships.every((ship) => ship.movement.holdEngaged),
      `each Hold ship should stop at its own firing solution (${ships.map((ship) => ship.movement.phase).join(",")})`);
    assert(ships.every((ship) => distance(ship, target) <= reach + 80));
    assert.notDeepEqual([ships[0].x, ships[0].y], [ships[1].x, ships[1].y],
      "Hold ships should not be assigned one shared position");
  }

  // Charge ships use the same target id and go directly to physical contact;
  // there are no staging/contact rings.
  {
    const target = makeShip({ id: "charge-target", x: 2200, y: 1500, ownerId: "p2", team: "B", design: BASE });
    const ships = [
      makeShip({ id: "charge-a", x: 600, y: 1050, design: BASE, combatStyle: "charge" }),
      makeShip({ id: "charge-b", x: 600, y: 1950, design: BASE, combatStyle: "charge" })
    ];
    const room = makeRoom(ships, [], target);
    commandShips(room, player(room), target.x, target.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: target.id
    });
    assert(ships.every((ship) => ship.movement.command.targetId === target.id));
    tick(room, ships, 1000);
    assert(ships.every((ship) => distance(ship, target)
      <= physicalCollisionRadius(ship) + physicalCollisionRadius(target) + 18),
    "Charge ships should approach from their current sides and reach contact");
  }

  // Charge contact is measured against the live directional hull, not the one
  // bounding circle dictated by this target's long, wide nose. Exercise every
  // cardinal and diagonal approach so using that circle cannot pass unnoticed.
  {
    const asymmetricTarget = [
      { x: 7, y: 7, type: "core" },
      { x: 7, y: 6, type: "frame" },
      { x: 7, y: 5, type: "frame" },
      { x: 7, y: 4, type: "frame" },
      { x: 7, y: 3, type: "frame" },
      { x: 4, y: 2, type: "frame" },
      { x: 5, y: 2, type: "frame" },
      { x: 6, y: 2, type: "frame" },
      { x: 7, y: 2, type: "frame" },
      { x: 8, y: 2, type: "frame" },
      { x: 9, y: 2, type: "frame" },
      { x: 10, y: 2, type: "frame" },
      { x: 7, y: 8, type: "frame" },
      { x: 7, y: 9, type: "frame" }
    ];
    const directions = [
      [1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
      [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2]
    ];
    for (let index = 0; index < directions.length; index += 1) {
      const [dx, dy] = directions[index];
      const target = makeShip({
        id: `directional-target-${index}`,
        x: 2100,
        y: 1500,
        ownerId: "p2",
        team: "B",
        design: asymmetricTarget,
        combatStyle: "hold"
      });
      const charger = makeShip({
        id: `directional-charge-${index}`,
        x: target.x + dx * 900,
        y: target.y + dy * 900,
        design: BASE,
        combatStyle: "charge"
      });
      const room = makeRoom([charger], [], target);
      commandShips(room, player(room), target.x, target.y, {
        shipIds: [charger.id],
        targetId: target.id
      });
      let overlapSeen = false;
      let correctionSeen = false;
      let pushSeen = false;
      tick(room, [charger], 1200, 0, () => {
        overlapSeen ||= Boolean(findShipHullOverlap(charger, target));
        correctionSeen ||= Math.hypot(charger._collisionCorrectionX || 0, charger._collisionCorrectionY || 0) > 1e-6;
        pushSeen ||= Math.hypot(target.vx || 0, target.vy || 0) > 1e-6;
      });
      const clearance = hullClearance(charger, target);
      assert(charger.movement.chargeEngaged, `approach ${index}: Charge should settle`);
      assert(clearance >= 6 && clearance <= 10,
        `approach ${index}: live hull clearance should be about 8px, got ${clearance.toFixed(2)}px`);
      assert(!overlapSeen, `approach ${index}: hulls must never overlap`);
      assert(!correctionSeen, `approach ${index}: collision correction must not stop Charge`);
      assert(!pushSeen, `approach ${index}: Charge must not add push velocity to the Hold target`);
      assert(Math.hypot(target.x - 2100, target.y - 1500) <= 1e-6,
        `approach ${index}: the Hold target centre must remain fixed`);
    }
  }

  assertNoLegacyMovementState();
  console.log("verify-movement-simplified: OK");
}

run();
