"use strict";

// Command-time formations.
//
// There is one shape: a compact clump. It is a decision taken once, when the
// order is issued, and these tests are about the slots that decision produces.
// That they are deterministic. That they are spaced by what the hulls
// physically are. That a slot which lands in an obstacle is the only one that
// moves. That an empty-space move ends with the whole group facing one shared
// travel direction rather than looking inward at where it was sent. That a Hold
// attack produces one clump on the near side of the enemy, placed close enough
// for the shortest-ranged ship in it to fire from the rear-most slot -- and that
// nothing rebuilds any of it while the order runs.

const assert = require("node:assert/strict");
const { movementTestTick } = require("./tools/movementTestTick");
const {
  FORMATION_TYPES,
  commandShips,
  physicalCollisionRadius,
  planAttackFormation,
  planFormation,
  sanitizeFormationType
} = require("./src/server/movement");
const { getMaxEffectiveWeaponRange } = require("./src/server/componentData");
const { FORMATION_VISUAL_GAP, HOLD_RANGE_RATIO } = require("./src/server/movementTuning");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");
const { computeDesignCollisionRadius } = require("./src/server/componentGeometry");

const DT = 1 / 30;
const BASE = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];
const HEAVY = [
  ...BASE,
  { x: 6, y: 6, type: "frame" },
  { x: 9, y: 6, type: "frame" },
  { x: 6, y: 9, type: "frame" },
  { x: 9, y: 9, type: "frame" }
];
const GUNSHIP = [...BASE, { x: 6, y: 7, type: "blaster", rotation: 0 }];
// A shorter reach than the blaster, on a hull that is otherwise identical.
const SHORT_RANGE = [...BASE, { x: 6, y: 7, type: "autocannon", rotation: 0 }];

function makeShip({ id, x, y, design = BASE, angle = 0, ownerId = "p1", combatStyle = "hold" }) {
  const stats = computeStats(design);
  const ship = {
    id,
    ownerId,
    team: ownerId === "p1" ? "A" : "B",
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
    physicalRadius: computeDesignCollisionRadius(design, stats),
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats: { ...stats },
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

function makeRoom(ships, asteroids = [], enemy = null) {
  const all = enemy ? [...ships, enemy] : ships;
  const players = new Map([["p1", { id: "p1", team: "A", ships: [...ships] }]]);
  if (enemy) players.set("p2", { id: "p2", team: "B", ships: [enemy] });
  return {
    phase: "active",
    world: { width: 6000, height: 4000 },
    map: { asteroids, relays: [], revision: 1 },
    ships: new Map(all.map((ship) => [ship.id, ship])),
    players,
    stations: [],
    stationsById: new Map(),
    drones: new Map(),
    bullets: [],
    effects: [],
    spawnCollisionDiagnostics: {}
  };
}

function column(count, { design = BASE, x = 1000, y0 = 800, pitch = 200 } = {}) {
  return Array.from({ length: count }, (_, index) => makeShip({
    id: `f-${index}`,
    x,
    y: y0 + index * pitch,
    design
  }));
}

function slotOf(ship) {
  return { x: ship.movement.destination.x, y: ship.movement.destination.y };
}

// Slots back in formation space: +x along travel, +y to its right.
function toFormationSpace(x, y, centreX, centreY, direction) {
  const dx = x - centreX;
  const dy = y - centreY;
  const cos = Math.cos(-direction);
  const sin = Math.sin(-direction);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function localOffset(ship, formation) {
  return toFormationSpace(
    ship.movement.destination.x,
    ship.movement.destination.y,
    formation.centreX,
    formation.centreY,
    formation.direction
  );
}

function localOffsetOf(slot, plan) {
  return toFormationSpace(slot.x, slot.y, plan.x, plan.y, plan.direction);
}

function expectedSpacing(ships) {
  return Math.max(...ships.map(physicalCollisionRadius)) * 2 + FORMATION_VISUAL_GAP;
}

function centreOf(ships) {
  return {
    x: ships.reduce((sum, ship) => sum + ship.x, 0) / ships.length,
    y: ships.reduce((sum, ship) => sum + ship.y, 0) / ships.length
  };
}

function angleError(a, b) {
  let error = Math.abs(a - b) % (Math.PI * 2);
  if (error > Math.PI) error = Math.PI * 2 - error;
  return error;
}

function assertNoSlotOverlap(ships, label) {
  for (let i = 0; i < ships.length; i += 1) {
    for (let j = i + 1; j < ships.length; j += 1) {
      const a = slotOf(ships[i]);
      const b = slotOf(ships[j]);
      const gap = Math.hypot(a.x - b.x, a.y - b.y);
      const minimum = physicalCollisionRadius(ships[i]) + physicalCollisionRadius(ships[j]);
      assert(gap >= minimum,
        `${label}: slots ${ships[i].id}/${ships[j].id} start overlapped (${gap.toFixed(1)} < ${minimum.toFixed(1)})`);
    }
  }
}

function attackSlotState(ship) {
  return ship.movement.attackSlot;
}

// A slot's own position, in the target-anchored frame the runtime holds it in.
function attackSlotWorldPoint(slot, target) {
  const lateralX = -slot.awayY;
  const lateralY = slot.awayX;
  const along = slot.centreDistance + slot.forwardOffset;
  return {
    x: target.x + slot.awayX * along + lateralX * slot.lateralOffset,
    y: target.y + slot.awayY * along + lateralY * slot.lateralOffset
  };
}

function holdRangeOf(ship) {
  return getMaxEffectiveWeaponRange(ship) * HOLD_RANGE_RATIO;
}

function run() {
  // --- there is exactly one formation --------------------------------------
  {
    assert.deepEqual([...FORMATION_TYPES], ["clump"], "clump is the only formation");
    for (const legacy of ["line", "wedge", "LINE", "Wedge", "", "  ", "column", null, undefined, 7, {}]) {
      assert.equal(sanitizeFormationType(legacy), "clump",
        `an absent, unknown, old or malformed formation must resolve to clump (${String(legacy)})`);
    }
    // No production movement code branches on the removed shapes.
    const fs = require("node:fs");
    const production = [
      "src/server/movementFlags.js",
      "src/server/movementFormations.js",
      "src/server/movementV2.js",
      "src/server/movementRuntimeV2.js",
      "src/server/clientSchemas.js"
    ].map((file) => fs.readFileSync(file, "utf8")
      // Comments may still explain what was removed and why; code may not.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, ""));
    for (const source of production) {
      assert.equal(/["']wedge["']/i.test(source), false, "production movement still names the wedge");
      assert.equal(/["']line["']/i.test(source), false, "production movement still names the line");
    }
  }

  // --- ten ships, one compact clump ----------------------------------------
  {
    const ships = column(10, { pitch: 120 });
    const room = makeRoom(ships);
    const result = commandShips(room, room.players.get("p1"), 3600, 1600, {
      shipIds: ships.map((ship) => ship.id)
    });
    assert.equal(result.commanded, 10);
    assert.equal(result.formation, "clump");

    const slots = ships.map(slotOf);
    assert.equal(new Set(slots.map((slot) => `${slot.x}:${slot.y}`)).size, 10, "ten distinct slots");
    assertNoSlotOverlap(ships, "clump");

    // The shape faces the way the fleet was sent, not world-east.
    const formation = ships[0].movement.command.formation;
    assert.equal(formation.type, "clump");
    const centre = centreOf(ships);
    const travel = Math.atan2(1600 - centre.y, 3600 - centre.x);
    assert(Math.abs(formation.direction - travel) < 1e-9,
      `the clump faces the way the fleet travels (${formation.direction} vs ${travel})`);

    // Compact: every slot inside the spiral radius the layout promises, rather
    // than a shape hundreds of pixels long in one axis.
    const spacing = expectedSpacing(ships);
    const radii = ships.map((ship) => Math.hypot(localOffset(ship, formation).x, localOffset(ship, formation).y));
    assert(Math.max(...radii) <= spacing * Math.sqrt(ships.length - 1) + 1e-6,
      "a clump should stay a compact cluster");

    // Re-issuing the same order is a pure function of the same inputs, and an
    // unknown formation name lands on the same plan.
    for (const requested of [undefined, "clump", "wedge", "line"]) {
      const repeat = planFormation(room, ships, { x: 3600, y: 1600, formation: requested });
      assert.deepEqual(repeat.slots.map((slot) => [slot.shipId, slot.x, slot.y]),
        ships.map((ship) => [ship.id, slotOf(ship).x, slotOf(ship).y]),
        `the same order must produce the same assignment (${String(requested)})`);
    }

    // ...and nothing rebuilds the shape while the order runs.
    const before = ships.map(slotOf);
    for (let index = 0; index < 900; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);
    assert.deepEqual(ships.map(slotOf), before, "slots must not be regenerated during the command");
    assert(ships.every((ship, index) => Math.hypot(ship.x - before[index].x, ship.y - before[index].y) < 60),
      "each ship should settle on its own slot");

    // Settled means settled: a clump at rest is not a standing shoving match.
    const settled = ships.map((ship) => ({ x: ship.x, y: ship.y }));
    for (let index = 0; index < 120; index += 1) movementTestTick(room, ships, DT, 40000 + index * DT * 1000);
    assert(ships.every((ship, index) => Math.hypot(ship.x - settled[index].x, ship.y - settled[index].y) < 3),
      "a settled clump should not continuously push");
  }

  // --- mixed hull sizes ----------------------------------------------------
  {
    // The largest hull in the order sets the pitch, so the small ones cannot end
    // up parked inside the big one.
    const ships = column(5).map((ship, index) => (index % 2 === 0
      ? ship
      : makeShip({ id: ship.id, x: ship.x, y: ship.y, design: HEAVY })));
    const room = makeRoom(ships);
    commandShips(room, room.players.get("p1"), 3600, 1600, {
      shipIds: ships.map((ship) => ship.id)
    });
    assertNoSlotOverlap(ships, "mixed clump");
  }

  // --- slots go to the ships already standing in that order ----------------
  {
    // A column strung out across the axis of travel. Assigning slots by entity
    // id would hand the leftmost ship whichever slot its id sorted to and send
    // the fleet crossing through itself; the shape should form where it stands.
    const ships = column(5, { x: 1000, y0: 800, pitch: 220 });
    // Ids deliberately out of step with position.
    const reversed = ["f-4", "f-3", "f-2", "f-1", "f-0"];
    ships.forEach((ship, index) => { ship.id = reversed[index]; });
    const room = makeRoom(ships);
    commandShips(room, room.players.get("p1"), 3600, 1500, {
      shipIds: ships.map((ship) => ship.id)
    });

    const formation = ships[0].movement.command.formation;
    const cos = Math.cos(-formation.direction);
    const sin = Math.sin(-formation.direction);
    const acrossOf = (x, y) => (x - formation.centreX) * sin + (y - formation.centreY) * cos;
    const startOrder = ships.map((ship) => acrossOf(ship.x, ship.y));
    const slotOrder = ships.map((ship) => localOffset(ship, formation).y);
    // No two ships have to swap sides, so no two run-ins cross.
    for (let i = 0; i < ships.length; i += 1) {
      for (let j = i + 1; j < ships.length; j += 1) {
        const crossed = (startOrder[i] - startOrder[j]) * (slotOrder[i] - slotOrder[j]) < 0;
        assert(!crossed, `${ships[i].id} and ${ships[j].id} would have to trade sides`);
      }
    }
  }

  // --- one shared forward facing -------------------------------------------
  {
    const ships = column(6, { x: 900, y0: 900, pitch: 240 });
    const room = makeRoom(ships);
    const fleet = centreOf(ships);
    commandShips(room, room.players.get("p1"), 3200, 1800, {
      shipIds: ships.map((ship) => ship.id)
    });

    const expected = Math.atan2(1800 - fleet.y, 3200 - fleet.x);
    const facings = ships.map((ship) => ship.movement.command.finalFacing);
    assert(facings.every((facing) => Math.abs(facing - facings[0]) < 1e-9),
      "every command carries the same final facing");
    assert(Math.abs(facings[0] - expected) < 1e-9,
      "final facing is the fleet-centre-to-click direction");
    // ...and specifically NOT each ship's own bearing to the clicked point.
    const individual = ships.map((ship) => Math.atan2(1800 - ship.y, 3200 - ship.x));
    assert(individual.some((bearing) => angleError(bearing, facings[0]) > 0.05),
      "final facing must not be each ship's individual bearing to the click");

    for (let index = 0; index < 900; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);
    const clumpCentre = centreOf(ships);
    for (const ship of ships) {
      assert(angleError(ship.angle, expected) < 0.1,
        `a settled clump shares one heading (${ship.id} off by ${angleError(ship.angle, expected).toFixed(3)} rad)`);
    }
    // The group did not settle looking in at its own middle -- which is also
    // where it was clicked, so this rules out both failure modes at once.
    const inwardError = ships.reduce((sum, ship) => (
      sum + angleError(ship.angle, Math.atan2(clumpCentre.y - ship.y, clumpCentre.x - ship.x))
    ), 0) / ships.length;
    assert(inwardError > 0.5,
      `ships must not finish facing inward at the clump centre (mean error ${inwardError.toFixed(2)} rad)`);
  }

  // --- a click on top of the fleet falls back to the fleet's own heading ----
  {
    const heading = 0.9;
    const ships = column(4, { x: 2000, y0: 2000, pitch: 0 })
      .map((ship, index) => makeShip({
        id: `near-${index}`,
        x: 2000 + index,
        y: 2000,
        angle: heading
      }));
    const room = makeRoom(ships);
    const fleet = centreOf(ships);
    const plan = planFormation(room, ships, { x: fleet.x, y: fleet.y });
    assert(Math.abs(plan.direction - heading) < 1e-6,
      `a near-zero-distance click keeps the current fleet heading (${plan.direction})`);
    // Stable: the same degenerate click twice is the same answer.
    const repeat = planFormation(room, ships, { x: fleet.x, y: fleet.y });
    assert.equal(repeat.direction, plan.direction, "the fallback heading is stable");
    assert.deepEqual(repeat.slots.map((slot) => [slot.shipId, slot.x, slot.y]),
      plan.slots.map((slot) => [slot.shipId, slot.x, slot.y]),
      "...and so is the shape it produces");

    // Two hulls nose to nose: the circular average cancels out, so the fallback
    // is a deterministic one of their headings rather than world-east.
    const opposed = [
      makeShip({ id: "op-a", x: 2000, y: 2000, angle: 1.1 }),
      makeShip({ id: "op-b", x: 2000, y: 2000, angle: 1.1 - Math.PI })
    ];
    const opposedRoom = makeRoom(opposed);
    const opposedPlan = planFormation(opposedRoom, opposed, { x: 2000, y: 2000 });
    assert(opposed.some((ship) => Math.abs(opposedPlan.direction - ship.angle) < 1e-9),
      `cancelling headings fall back to one of the ships' own (${opposedPlan.direction})`);
    assert.equal(planFormation(opposedRoom, opposed, { x: 2000, y: 2000 }).direction,
      opposedPlan.direction, "...deterministically");
  }

  // --- one slot inside an asteroid ----------------------------------------
  {
    const ships = column(5);
    const clean = makeRoom(ships);
    const unobstructed = planFormation(clean, ships, { x: 3600, y: 1600 });
    const blockedSlot = unobstructed.slots.find((slot) => (
      unobstructed.slots.every((other) => other === slot
        || Math.hypot(other.x - slot.x, other.y - slot.y) > 120)
    )) || unobstructed.slots[0];
    const blockedIndex = unobstructed.slots.indexOf(blockedSlot);

    // Small enough that only one slot is inside it: the neighbouring slots must
    // come out untouched.
    const asteroid = { id: "rock", x: blockedSlot.x, y: blockedSlot.y, radius: 40 };
    const room = makeRoom(ships, [asteroid]);
    const plan = planFormation(room, ships, { x: 3600, y: 1600 });

    assert.equal(plan.slots.filter((slot) => slot.adjusted).length, 1, "only the blocked slot is adjusted");
    assert.equal(plan.slots[blockedIndex].adjusted, true);
    for (let index = 0; index < plan.slots.length; index += 1) {
      if (index === blockedIndex) continue;
      assert.equal(plan.slots[index].x, unobstructed.slots[index].x, "unaffected slots must not move");
      assert.equal(plan.slots[index].y, unobstructed.slots[index].y, "unaffected slots must not move");
      assert.equal(plan.slots[index].adjusted, false);
    }
    // The adjusted slot is somewhere the hull can physically sit, and it stayed
    // on its own side of the formation rather than being rotated elsewhere.
    const moved = plan.slots[blockedIndex];
    assert(moved.reachable, "the adjusted slot must be a point the ship can occupy");
    assert(Math.hypot(moved.x - asteroid.x, moved.y - asteroid.y)
      >= asteroid.radius + physicalCollisionRadius(moved.ship),
    "the adjusted slot must clear the asteroid");
    assert.equal(Math.sign(localOffsetOf(moved, plan).y), Math.sign(moved.offsetY),
      "the adjusted slot keeps its own side of the formation");
    assert.equal(plan.slots[blockedIndex].shipId, unobstructed.slots[blockedIndex].shipId,
      "and it is still the same ship's slot");
  }

  // --- several slots inside the same asteroid ------------------------------
  {
    // One rock over the middle of the clump. Walking each blocked slot to the
    // nearest clear ground independently would pile them onto the same patch of
    // it; they have to be checked against each other afterwards.
    const ships = column(6);
    const clean = makeRoom(ships);
    const unobstructed = planFormation(clean, ships, { x: 3600, y: 1600 });
    const asteroid = { id: "big-rock", x: unobstructed.x, y: unobstructed.y, radius: 150 };
    const room = makeRoom(ships, [asteroid]);
    const plan = planFormation(room, ships, { x: 3600, y: 1600 });

    const adjusted = plan.slots.filter((slot) => slot.adjusted);
    assert(adjusted.length >= 3, `the rock should displace several slots (${adjusted.length})`);
    for (const slot of plan.slots) {
      assert(Math.hypot(slot.x - asteroid.x, slot.y - asteroid.y)
        >= asteroid.radius + physicalCollisionRadius(slot.ship) - 1e-6,
      "every slot must end up outside the rock");
    }
    for (let i = 0; i < plan.slots.length; i += 1) {
      for (let j = i + 1; j < plan.slots.length; j += 1) {
        const gap = Math.hypot(plan.slots[i].x - plan.slots[j].x, plan.slots[i].y - plan.slots[j].y);
        const minimum = physicalCollisionRadius(plan.slots[i].ship)
          + physicalCollisionRadius(plan.slots[j].ship);
        assert(gap >= minimum,
          `displaced slots collapsed together (${gap.toFixed(1)} < ${minimum.toFixed(1)})`);
      }
    }
    // Repeating the same order still lands on the same answer.
    const repeat = planFormation(room, ships, { x: 3600, y: 1600 });
    assert.deepEqual(repeat.slots.map((slot) => [slot.shipId, slot.x, slot.y]),
      plan.slots.map((slot) => [slot.shipId, slot.x, slot.y]),
      "slot separation must be deterministic");
  }

  // --- a later order replaces the shape completely -------------------------
  {
    const ships = column(5);
    const room = makeRoom(ships);
    commandShips(room, room.players.get("p1"), 3600, 1600, { shipIds: ships.map((ship) => ship.id) });
    const first = ships.map(slotOf);
    for (let index = 0; index < 30; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);

    commandShips(room, room.players.get("p1"), 2400, 2600, { shipIds: ships.map((ship) => ship.id) });
    assert(ships.every((ship, index) => (
      ship.movement.destination.x !== first[index].x
        || ship.movement.destination.y !== first[index].y
    )), "the new order must replace every previous slot");
    assert(ships.every((ship) => ship.movement.route === null && ship.movement.path.length === 0),
      "no route from the old slot may survive the new order");

    const second = ships.map(slotOf);
    for (let index = 0; index < 900; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);
    assert.deepEqual(ships.map(slotOf), second, "the new slots stand for the whole order");
    assert(ships.every((ship, index) => Math.hypot(ship.x - second[index].x, ship.y - second[index].y) < 60),
      "ships should end up on the new slots, not the old ones");
  }

  // --- a Hold attack is one clump on the near side of the enemy ------------
  {
    const ships = column(5, { design: GUNSHIP, x: 900, y0: 800, pitch: 220 });
    const enemy = makeShip({ id: "enemy", x: 3400, y: 1500, design: GUNSHIP, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    const fleet = centreOf(ships);
    const result = commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });
    assert.equal(result.code, "attack");
    assert(ships.every((ship) => ship.movement.command.formation === null),
      "combat orders carry no move formation");

    const slots = ships.map(attackSlotState);
    assert(slots.every(Boolean), "every Hold ship gets an attack slot");
    assert.equal(new Set(slots.map((slot) => `${slot.forwardOffset.toFixed(3)}:${slot.lateralOffset.toFixed(3)}`)).size,
      ships.length, "each slot in the clump is distinct");
    assert.equal(new Set(slots.map((slot) => slot.assignedShipId)).size, ships.length,
      "one slot per ship");

    // One clump: every slot shares the same anchor, approach axis and centre.
    assert.equal(new Set(slots.map((slot) => (
      `${slot.targetId}:${slot.awayX.toFixed(9)}:${slot.awayY.toFixed(9)}:${slot.centreDistance.toFixed(6)}`
    ))).size, 1, "all attack slots belong to one clump");
    // The clump forms on the side the fleet is already coming from.
    const away = Math.atan2(fleet.y - enemy.y, fleet.x - enemy.x);
    assert(angleError(Math.atan2(slots[0].awayY, slots[0].awayX), away) < 1e-9,
      "the approach axis points from the target back toward the fleet");

    // Not five independent near-identical radial destinations: the slots are
    // spread across the approach axis, and the group is a cluster.
    const points = slots.map((slot) => attackSlotWorldPoint(slot, enemy));
    const lateralSpread = Math.max(...slots.map((slot) => slot.lateralOffset))
      - Math.min(...slots.map((slot) => slot.lateralOffset));
    assert(lateralSpread > expectedSpacing(ships),
      `an enemy click must spread the fleet, not stack it (${lateralSpread.toFixed(0)} px)`);
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        assert(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)
          >= physicalCollisionRadius(ships[i]) + physicalCollisionRadius(ships[j]),
        "attack slots must not overlap");
      }
    }

    // Assignments do not drift while the fleet closes, and nobody crosses the
    // group to reach a slot on the far side of it.
    const cos = Math.cos(-away);
    const sin = Math.sin(-away);
    const acrossOf = (x, y) => (x - enemy.x) * sin + (y - enemy.y) * cos;
    const startOrder = ships.map((ship) => acrossOf(ship.x, ship.y));
    const assignedOrder = slots.map((slot) => slot.lateralOffset);
    for (let i = 0; i < ships.length; i += 1) {
      for (let j = i + 1; j < ships.length; j += 1) {
        assert(!((startOrder[i] - startOrder[j]) * (assignedOrder[i] - assignedOrder[j]) < 0),
          `${ships[i].id} and ${ships[j].id} would have to cross the clump`);
      }
    }

    const identity = slots.map((slot) => ({ ...slot }));
    for (let index = 0; index < 240; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    for (let index = 0; index < ships.length; index += 1) {
      const current = attackSlotState(ships[index]);
      if (!current) continue;
      assert.equal(current.assignedShipId, identity[index].assignedShipId, "no reassignment while approaching");
      assert.equal(current.forwardOffset, identity[index].forwardOffset, "offsets are stable while approaching");
      assert.equal(current.lateralOffset, identity[index].lateralOffset, "offsets are stable while approaching");
    }

    for (let index = 0; index < 1200; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    assert(ships.every((ship) => ship.movement.holdEngaged),
      `each ship should reach its slot and engage (${ships.map((ship) => ship.movement.phase).join(",")})`);
    assert(ships.every((ship) => ship.movement.attackSlot === null),
      "a ship releases its slot when it enters Hold");
    assert.equal(new Set(ships.map((ship) => `${ship.x.toFixed(1)}:${ship.y.toFixed(1)}`)).size, ships.length,
      "no two ships are assigned one shared combat position");
  }

  // --- the whole clump is placed by the shortest usable range --------------
  {
    // Four long-range gunships in front, one shorter-ranged hull at the back:
    // the clump goes where the ship in the rear-most slot can still fire, and
    // nobody is pushed forward on their own.
    const front = Array.from({ length: 4 }, (_, index) => makeShip({
      id: `long-${index}`,
      x: 3750,
      y: 1500 + index * 90,
      design: GUNSHIP
    }));
    const rear = makeShip({ id: "short-range", x: 900, y: 1650, design: SHORT_RANGE });
    const ships = [...front, rear];
    const enemy = makeShip({ id: "enemy", x: 4200, y: 1650, design: GUNSHIP, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);

    const shortReach = holdRangeOf(rear);
    const longReach = holdRangeOf(front[0]);
    assert(shortReach < longReach, "the test needs a genuinely shorter-ranged hull");

    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });

    const slots = ships.map(attackSlotState);
    const rearSlot = attackSlotState(rear);
    // Starting furthest from the enemy, the short-range hull takes a slot in the
    // back of the clump -- it is not pushed forward through the ships in front
    // of it to make up its own range, and nothing sorted the group by reach.
    assert(rearSlot.forwardOffset > 0,
      `the ship that started furthest back belongs to the rear of the clump (${rearSlot.forwardOffset.toFixed(0)})`);
    // Every slot -- the rear-most included -- is inside the shortest range.
    for (const slot of slots) {
      const point = attackSlotWorldPoint(slot, enemy);
      const range = Math.hypot(point.x - enemy.x, point.y - enemy.y);
      assert(range <= shortReach,
        `slot at ${range.toFixed(0)} px is outside the shortest usable range ${shortReach.toFixed(0)}`);
    }
    // ...and the clump is not simply piled onto the enemy either.
    assert(slots.every((slot) => {
      const point = attackSlotWorldPoint(slot, enemy);
      return Math.hypot(point.x - enemy.x, point.y - enemy.y)
        >= physicalCollisionRadius(enemy) + physicalCollisionRadius(rear);
    }), "the clump keeps its distance from the target's hull");

    // The long-range ships are already inside their own reach at the order, and
    // must not stop there.
    const longStart = Math.hypot(front[0].x - enemy.x, front[0].y - enemy.y);
    assert(longStart < longReach, "the front ships should begin inside their own weapon range");
    assert(front.every((ship) => !ship.movement.holdEngaged),
      "being in range at command time must not latch Hold");

    for (let index = 0; index < 1500; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    assert(ships.every((ship) => ship.movement.holdEngaged),
      `every armed ship eventually enters Hold (${ships.map((ship) => `${ship.id}:${ship.movement.phase}`).join(",")})`);
    const rearRange = Math.hypot(rear.x - enemy.x, rear.y - enemy.y);
    assert(rearRange <= shortReach + 40,
      `the short-range ship must be in range where it stops (${rearRange.toFixed(0)} vs ${shortReach.toFixed(0)})`);
  }

  // --- a long-range ship out in front does not latch Hold early ------------
  {
    const scout = makeShip({ id: "scout", x: 3300, y: 1500, design: GUNSHIP });
    const pack = Array.from({ length: 3 }, (_, index) => makeShip({
      id: `pack-${index}`,
      x: 1000,
      y: 1200 + index * 260,
      design: GUNSHIP
    }));
    const ships = [scout, ...pack];
    const enemy = makeShip({ id: "enemy", x: 3800, y: 1500, design: GUNSHIP, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });

    const slot = attackSlotState(scout);
    const target = attackSlotWorldPoint(slot, enemy);
    const startRange = Math.hypot(scout.x - enemy.x, scout.y - enemy.y);
    assert(startRange <= holdRangeOf(scout),
      "the scout should already be inside weapon range before it reaches its slot");
    assert(Math.hypot(scout.x - target.x, scout.y - target.y) > 60,
      "...and not already standing on its slot");

    let latchedBeforeArrival = false;
    let arrivedAt = -1;
    for (let index = 0; index < 900; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
      const point = attackSlotWorldPoint(slot, enemy);
      const atSlot = Math.hypot(scout.x - point.x, scout.y - point.y) <= 40;
      if (scout.movement.holdEngaged) {
        if (!atSlot && arrivedAt < 0) latchedBeforeArrival = true;
        if (arrivedAt < 0) arrivedAt = index;
        break;
      }
      if (atSlot && arrivedAt < 0) arrivedAt = index;
    }
    assert.equal(latchedBeforeArrival, false, "crossing into range must not latch Hold early");
    assert(scout.movement.holdEngaged, "it engages once it is standing on its assigned slot");
    assert(arrivedAt >= 0, "it reached the slot before engaging");
  }

  // --- a moving target carries the clump with it ---------------------------
  {
    const ships = column(4, { design: GUNSHIP, x: 900, y0: 1000, pitch: 240 });
    const enemy = makeShip({ id: "runner", x: 4200, y: 1600, design: GUNSHIP, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });
    const planned = ships.map((ship) => ({ ...attackSlotState(ship) }));

    for (let index = 0; index < 120; index += 1) {
      enemy.x += 4;
      enemy.y += 2;
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }

    for (let index = 0; index < ships.length; index += 1) {
      const slot = attackSlotState(ships[index]);
      assert(slot, "a ship still approaching keeps its slot");
      assert.equal(slot.assignedShipId, planned[index].assignedShipId, "no reassignment because the target moved");
      assert.equal(slot.forwardOffset, planned[index].forwardOffset, "offsets are preserved");
      assert.equal(slot.lateralOffset, planned[index].lateralOffset, "offsets are preserved");
      assert.equal(slot.awayX, planned[index].awayX, "the clump keeps its orientation");
      // The destination the ship is flying to has moved with the enemy.
      const expected = attackSlotWorldPoint(slot, enemy);
      assert(Math.hypot(ships[index].movement.destination.x - expected.x,
        ships[index].movement.destination.y - expected.y) < 1e-6,
      "the slot translates with the target");
    }

    for (let index = 0; index < 2000; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    assert(ships.every((ship) => ship.movement.holdEngaged && ship.movement.attackSlot === null),
      "engaged ships are released from attack-slot control");
    // A target that walks in closer does not drag an engaged hull backward.
    const parked = ships.map((ship) => ({ x: ship.x, y: ship.y }));
    for (let index = 0; index < 120; index += 1) {
      enemy.x -= 3;
      movementTestTick(room, [...ships, enemy], DT, 80000 + index * DT * 1000);
    }
    assert(ships.every((ship, index) => Math.hypot(ship.x - parked[index].x, ship.y - parked[index].y) < 12),
      "a closer target must not pull an engaged Hold ship backward");
  }

  // --- an enemy that drives into the group ---------------------------------
  {
    // The clump hangs off the target, so an enemy closing past the front of it
    // would otherwise push every unengaged slot out behind the ships. Hold does
    // not give ground: the approach is abandoned at point-blank range and the
    // ordinary rules take over.
    const ships = column(3, { design: GUNSHIP, x: 900, y0: 1200, pitch: 240 });
    const enemy = makeShip({ id: "rammer", x: 3600, y: 1440, design: GUNSHIP, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });
    assert(ships.every((ship) => ship.movement.attackSlot), "the order plans a clump");

    // Teleport the enemy into the middle of the still-approaching fleet.
    enemy.x = centreOf(ships).x;
    enemy.y = centreOf(ships).y;
    const before = ships.map((ship) => ({ x: ship.x, y: ship.y }));
    for (let index = 0; index < 90; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    assert(ships.every((ship) => ship.movement.attackSlot === null),
      "a target at point-blank range releases the clump rather than pushing ships back");
    assert(ships.every((ship, index) => (
      Math.hypot(ship.x - enemy.x, ship.y - enemy.y)
        <= Math.hypot(before[index].x - enemy.x, before[index].y - enemy.y) + 40
    )), "no ship is driven backward away from a target that closed on it");
  }

  // --- a blocked attack slot gets a bounded, local adjustment --------------
  {
    const ships = column(5, { design: GUNSHIP, x: 900, y0: 1000, pitch: 220 });
    const enemy = makeShip({ id: "enemy", x: 3600, y: 1600, design: GUNSHIP, ownerId: "p2" });
    const clean = makeRoom(ships, [], enemy);
    const holdRange = (ship) => ({ range: holdRangeOf(ship), armed: true });
    const unobstructed = planAttackFormation(clean, ships, enemy, { holdRange });
    const blocked = unobstructed.slots.find((slot) => (
      unobstructed.slots.every((other) => other === slot
        || Math.hypot(other.x - slot.x, other.y - slot.y) > 130)
    )) || unobstructed.slots[0];
    const blockedIndex = unobstructed.slots.indexOf(blocked);

    const asteroid = { id: "slot-rock", x: blocked.x, y: blocked.y, radius: 40 };
    const room = makeRoom(ships, [asteroid], enemy);
    const plan = planAttackFormation(room, ships, enemy, { holdRange });

    assert.equal(plan.slots.filter((slot) => slot.adjusted).length, 1,
      "only the blocked slot is adjusted");
    for (let index = 0; index < plan.slots.length; index += 1) {
      if (index === blockedIndex) continue;
      assert.equal(plan.slots[index].x, unobstructed.slots[index].x, "other slots are unchanged");
      assert.equal(plan.slots[index].y, unobstructed.slots[index].y, "other slots are unchanged");
    }
    const moved = plan.slots[blockedIndex];
    assert(moved.reachable, "the adjusted slot is a point the hull can occupy");
    assert(Math.hypot(moved.x - asteroid.x, moved.y - asteroid.y)
      >= asteroid.radius + physicalCollisionRadius(moved.ship),
    "the adjusted slot clears the rock");
    assert(Math.hypot(moved.x - blocked.x, moved.y - blocked.y) < 400,
      "the adjustment stays local to the slot");
    assert.equal(Math.sign(moved.lateralOffset), Math.sign(unobstructed.slots[blockedIndex].lateralOffset),
      "the adjusted slot stays on its own side of the clump");
    assert.equal(plan.centreDistance, unobstructed.centreDistance,
      "one blocked slot does not move the clump");
  }

  // --- a slot the hull can sit on but cannot shoot from --------------------
  {
    // The slot itself is clear; what is blocked is the line from it to the
    // enemy. That gets a bounded walk around the slot, on the same side of the
    // clump, rather than a new plan for everybody.
    const ship = makeShip({ id: "sniper", x: 1000, y: 1500, design: GUNSHIP });
    const enemy = makeShip({ id: "enemy", x: 3000, y: 1500, design: GUNSHIP, ownerId: "p2" });
    const clean = makeRoom([ship], [], enemy);
    const planned = planAttackFormation(clean, [ship], enemy, {
      holdRange: (candidate) => ({ range: holdRangeOf(candidate), armed: true })
    });
    const slotPoint = planned.slots[0];
    // Between the slot and the target, well clear of both.
    const asteroid = {
      id: "sight-rock",
      x: (slotPoint.x + enemy.x) / 2,
      y: 1500,
      radius: 60
    };
    const room = makeRoom([ship], [asteroid], enemy);
    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: [ship.id],
      targetId: enemy.id
    });
    const original = { ...attackSlotState(ship) };
    assert(Math.hypot(slotPoint.x - asteroid.x, slotPoint.y - asteroid.y)
      > asteroid.radius + physicalCollisionRadius(ship),
    "the slot itself must be clear ground -- this is a line-of-sight case");

    for (let index = 0; index < 900; index += 1) {
      movementTestTick(room, [ship, enemy], DT, index * DT * 1000);
      if (ship.movement.holdEngaged) break;
    }
    assert(ship.movement.holdEngaged, "the ship should find a spot it can shoot from");
    assert.equal(ship.movement.firingSolution, null,
      "the slot was walked around, not abandoned for a per-ship firing search");
    const adjustment = Math.hypot(ship.x - slotPoint.x, ship.y - slotPoint.y);
    assert(adjustment > 40, "the slot must have been adjusted at all");
    assert(adjustment < 400, `the adjustment stays bounded and local (${adjustment.toFixed(0)} px)`);
    // Same side of the clump, and still the same clump: the centre did not move.
    assert.equal(Math.sign(original.lateralOffset) || 1, Math.sign(
      (ship.y - enemy.y) * original.awayX - (ship.x - enemy.x) * original.awayY
    ) || 1, "the adjusted position keeps its own side of the clump");
  }

  // --- armed and unarmed ships together ------------------------------------
  {
    const armed = Array.from({ length: 3 }, (_, index) => makeShip({
      id: `armed-${index}`,
      x: 1400,
      y: 1200 + index * 240,
      design: GUNSHIP
    }));
    const unarmed = makeShip({ id: "hauler", x: 900, y: 1440, design: BASE });
    const ships = [...armed, unarmed];
    const enemy = makeShip({ id: "enemy", x: 4000, y: 1440, design: GUNSHIP, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });

    const slots = ships.map(attackSlotState);
    assert(slots.every(Boolean), "an unarmed ship still gets a slot");
    // The armed ships set the distance: a hull with nothing that reaches does
    // not drag the clump onto the enemy.
    const armedOnly = planAttackFormation(room, armed, enemy, {
      holdRange: (ship) => ({ range: holdRangeOf(ship), armed: true })
    });
    assert(Math.abs(slots[0].centreDistance - armedOnly.centreDistance) < 200,
      `an unarmed ship must not collapse the clump (${slots[0].centreDistance.toFixed(0)} vs ${armedOnly.centreDistance.toFixed(0)})`);
    assert(slots[0].centreDistance > physicalCollisionRadius(enemy) * 4,
      "the clump is not stacked on the target");
    // Safe, non-overlapping, and toward the back.
    const points = slots.map((slot) => attackSlotWorldPoint(slot, enemy));
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        assert(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)
          >= physicalCollisionRadius(ships[i]) + physicalCollisionRadius(ships[j]),
        "unarmed and armed slots must not overlap");
      }
    }

    for (let index = 0; index < 1500; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    assert(armed.every((ship) => ship.movement.holdEngaged), "the armed ships engage");
    assert(Math.hypot(unarmed.x - attackSlotWorldPoint(slots[3], enemy).x,
      unarmed.y - attackSlotWorldPoint(slots[3], enemy).y) < 120,
    "the unarmed ship reaches its clump slot");
  }

  // --- Charge is not a clump stance ----------------------------------------
  {
    const ships = column(3, { design: GUNSHIP, x: 900, y0: 1000, pitch: 260 })
      .map((ship) => makeShip({ id: ship.id, x: ship.x, y: ship.y, design: GUNSHIP, combatStyle: "charge" }));
    const enemy = makeShip({ id: "charge-enemy", x: 3400, y: 1500, design: BASE, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });
    assert(ships.every((ship) => ship.movement.attackSlot === null),
      "Charge never takes a clump Hold position");

    for (let index = 0; index < 1200; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    const reach = getMaxEffectiveWeaponRange(ships[0]);
    let atContact = 0;
    for (const ship of ships) {
      const gap = Math.hypot(ship.x - enemy.x, ship.y - enemy.y);
      const contact = physicalCollisionRadius(ship) + physicalCollisionRadius(enemy);
      // The stance is contact-seeking, so the only thing that may hold a hull
      // short is another hull. Friendlies are solid and deliberately not
      // navigable, so a charger behind one that is itself in contact is pressed
      // as far in as the stance can get it -- which is the current behaviour,
      // and not a standoff distance the controller chose.
      if (gap <= contact + 24) {
        atContact += 1;
      } else {
        const unitX = (enemy.x - ship.x) / gap;
        const unitY = (enemy.y - ship.y) / gap;
        const blocker = ships.find((other) => {
          if (other === ship) return false;
          const along = (other.x - ship.x) * unitX + (other.y - ship.y) * unitY;
          const lateral = Math.abs((other.x - ship.x) * -unitY + (other.y - ship.y) * unitX);
          return along > 0 && along < gap
            && lateral < physicalCollisionRadius(ship) + physicalCollisionRadius(other);
        });
        assert(blocker,
          `Charge should close to contact unless a friendly is in the way (${gap.toFixed(0)} px against ${contact.toFixed(0)})`);
        assert(ship.movement.chargeEngaged === false,
          "a charger held up by its own wing has not decided it has arrived");
      }
      assert(gap < reach * 0.3,
        `Charge must not stop at a fraction of weapon range (${gap.toFixed(0)} px, reach ${reach.toFixed(0)})`);
    }
    assert(atContact >= 2, `most of the wing should make contact (${atContact} of ${ships.length})`);
  }

  // --- Charge routes around static geometry --------------------------------
  {
    const asteroid = { id: "charge-rock", x: 2200, y: 1500, radius: 320 };
    const ship = makeShip({ id: "charger", x: 800, y: 1500, design: GUNSHIP, combatStyle: "charge" });
    const enemy = makeShip({ id: "charge-target", x: 3600, y: 1500, design: BASE, ownerId: "p2" });
    const room = makeRoom([ship], [asteroid], enemy);
    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: [ship.id],
      targetId: enemy.id
    });
    movementTestTick(room, [ship, enemy], DT, 0);
    assert(ship.movement.path.length > 1,
      `a rock between charger and target should produce a route (${ship.movement.path.length})`);

    let worstClearance = Infinity;
    for (let index = 0; index < 1400; index += 1) {
      movementTestTick(room, [ship, enemy], DT, index * DT * 1000);
      worstClearance = Math.min(
        worstClearance,
        Math.hypot(ship.x - asteroid.x, ship.y - asteroid.y)
          - asteroid.radius - physicalCollisionRadius(ship)
      );
    }
    assert(worstClearance > -0.5,
      `the charger must route around the rock, not grind along it (${worstClearance.toFixed(1)} px)`);
    const gap = Math.hypot(ship.x - enemy.x, ship.y - enemy.y);
    const contact = physicalCollisionRadius(ship) + physicalCollisionRadius(enemy);
    assert(gap <= contact + 24, `and still reach contact (${gap.toFixed(0)} px against ${contact.toFixed(0)})`);
    // Once past the rock it closes directly again rather than staying on rails.
    assert.equal(ship.movement.path.length, 0, "the route is dropped for the final run-in");
  }

  // --- an allied click is a repair order, never an attack clump ------------
  {
    const medics = column(2, { design: [...BASE, { x: 6, y: 7, type: "repairBeam", rotation: 0 }], x: 900, y0: 1200, pitch: 220 });
    const patient = makeShip({ id: "patient", x: 2600, y: 1400, design: BASE });
    const room = makeRoom([...medics, patient]);
    room.players.get("p1").ships = [...medics, patient];
    const result = commandShips(room, room.players.get("p1"), patient.x, patient.y, {
      shipIds: medics.map((ship) => ship.id),
      targetId: patient.id
    });
    assert.equal(result.code, "repair");
    assert(medics.every((ship) => ship.movement.attackSlot === null),
      "an allied target must not produce a Hold attack clump");
    assert(medics.every((ship) => ship.movement.command.type === "repair"));
  }

  console.log("verify-movement-formations: OK");
}

run();
