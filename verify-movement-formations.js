"use strict";

// Command-time formations.
//
// A formation is a decision taken once, when the order is issued. These tests
// are about the slots that decision produces: that they are deterministic, that
// they are spaced by what the hulls physically are, that a slot which lands in
// an obstacle is the only one that moves, and that nothing rebuilds the shape
// while the order runs.

const assert = require("node:assert/strict");
const { movementTestTick } = require("./tools/movementTestTick");
const {
  commandShips,
  physicalCollisionRadius,
  planFormation
} = require("./src/server/movement");
const { getMaxEffectiveWeaponRange } = require("./src/server/componentData");
const { FORMATION_VISUAL_GAP } = require("./src/server/movementTuning");
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
function localOffset(ship, formation) {
  const dx = ship.movement.destination.x - formation.centreX;
  const dy = ship.movement.destination.y - formation.centreY;
  const cos = Math.cos(-formation.direction);
  const sin = Math.sin(-formation.direction);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function expectedSpacing(ships) {
  return Math.max(...ships.map(physicalCollisionRadius)) * 2 + FORMATION_VISUAL_GAP;
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

function run() {
  // --- line ----------------------------------------------------------------
  {
    const ships = column(5);
    const room = makeRoom(ships);
    const result = commandShips(room, room.players.get("p1"), 3600, 1600, {
      shipIds: ships.map((ship) => ship.id),
      formation: "line"
    });
    assert.equal(result.commanded, 5);
    assert.equal(result.formation, "line");

    const slots = ships.map(slotOf);
    assert.equal(new Set(slots.map((slot) => `${slot.x}:${slot.y}`)).size, 5, "five distinct slots");
    assertNoSlotOverlap(ships, "line");

    // The shape faces the way the fleet was sent, not world-east.
    const formation = ships[0].movement.command.formation;
    const centreX = ships.reduce((sum, ship) => sum + ship.x, 0) / ships.length;
    const centreY = ships.reduce((sum, ship) => sum + ship.y, 0) / ships.length;
    const travel = Math.atan2(1600 - centreY, 3600 - centreX);
    assert(Math.abs(formation.direction - travel) < 1e-9,
      `line direction should follow travel (${formation.direction} vs ${travel})`);

    // Abreast: every slot is across the axis of travel, evenly pitched, and the
    // ordering follows the deterministic entity-id sort.
    const offsets = ships.map((ship) => localOffset(ship, formation));
    assert(offsets.every((offset) => Math.abs(offset.x) < 1e-6), "line slots sit on the cross axis");
    const spacing = expectedSpacing(ships);
    for (let index = 1; index < offsets.length; index += 1) {
      assert(Math.abs((offsets[index].y - offsets[index - 1].y) - spacing) < 1e-6,
        "line slots should be one spacing apart in sorted order");
    }
    assert(Math.abs(offsets[0].y + offsets[offsets.length - 1].y) < 1e-6, "the line is centred");

    // Re-issuing the same order is a pure function of the same inputs.
    const repeat = planFormation(room, ships, { x: 3600, y: 1600, formation: "line" });
    assert.deepEqual(repeat.slots.map((slot) => [slot.shipId, slot.x, slot.y]),
      ships.map((ship) => [ship.id, slotOf(ship).x, slotOf(ship).y]),
      "the same order must produce the same assignment");

    // ...and nothing rebuilds the shape while the order runs.
    const before = ships.map(slotOf);
    for (let index = 0; index < 600; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);
    assert.deepEqual(ships.map(slotOf), before, "slots must not be regenerated during the command");
    assert(ships.every((ship, index) => Math.hypot(ship.x - before[index].x, ship.y - before[index].y) < 40),
      "each ship should settle on its own slot");
  }

  // --- wedge ---------------------------------------------------------------
  {
    // Mixed hull sizes: the largest hull in the order sets the pitch, so the
    // small ones cannot end up parked inside the big one.
    const ships = column(5).map((ship, index) => (index % 2 === 0
      ? ship
      : makeShip({ id: ship.id, x: ship.x, y: ship.y, design: HEAVY })));
    const room = makeRoom(ships);
    commandShips(room, room.players.get("p1"), 3600, 1600, {
      shipIds: ships.map((ship) => ship.id),
      formation: "wedge"
    });

    const formation = ships[0].movement.command.formation;
    assert.equal(formation.type, "wedge");
    const offsets = ships.map((ship) => localOffset(ship, formation));

    assert(Math.abs(offsets[0].x) < 1e-6 && Math.abs(offsets[0].y) < 1e-6, "the lead ship takes the point");
    assert(offsets.slice(1).every((offset) => offset.x < -1e-6), "every other ship falls in behind the lead");
    for (let index = 1; index < offsets.length; index += 1) {
      const expectedSide = index % 2 === 0 ? -1 : 1;
      assert.equal(Math.sign(offsets[index].y), expectedSide,
        `wedge slot ${index} should sit on the ${expectedSide > 0 ? "right" : "left"}`);
    }
    // Ranks step back evenly.
    assert(Math.abs(offsets[1].x - offsets[2].x) < 1e-6
      && Math.abs(offsets[3].x - offsets[4].x) < 1e-6, "a rank shares one depth");
    assert(offsets[3].x < offsets[1].x, "later ranks sit further back");
    assertNoSlotOverlap(ships, "wedge");
  }

  // --- clump ---------------------------------------------------------------
  {
    const ships = column(10, { pitch: 120 });
    const room = makeRoom(ships);
    commandShips(room, room.players.get("p1"), 3600, 1600, {
      shipIds: ships.map((ship) => ship.id),
      formation: "clump"
    });

    assertNoSlotOverlap(ships, "clump");
    const formation = ships[0].movement.command.formation;
    const spacing = expectedSpacing(ships);
    const radii = ships.map((ship) => Math.hypot(localOffset(ship, formation).x, localOffset(ship, formation).y));
    // Compact: ten slots inside the spiral radius the layout promises, rather
    // than a line hundreds of pixels long.
    assert(Math.max(...radii) <= spacing * Math.sqrt(ships.length - 1) + 1e-6,
      "a clump should stay a compact cluster");

    const repeat = planFormation(room, ships, { x: 3600, y: 1600, formation: "clump" });
    assert.deepEqual(repeat.slots.map((slot) => [slot.shipId, slot.x, slot.y]),
      ships.map((ship) => [ship.id, slotOf(ship).x, slotOf(ship).y]),
      "repeating a clump order must produce the same cluster");
  }

  // --- one slot inside an asteroid ----------------------------------------
  {
    const ships = column(5);
    const clean = makeRoom(ships);
    const unobstructed = planFormation(clean, ships, { x: 3600, y: 1600, formation: "line" });
    const blockedSlot = unobstructed.slots[2];

    // Small enough that only the middle slot is inside it: the neighbouring
    // slots are a full spacing away and must come out untouched.
    const asteroid = { id: "rock", x: blockedSlot.x, y: blockedSlot.y, radius: 40 };
    const room = makeRoom(ships, [asteroid]);
    const plan = planFormation(room, ships, { x: 3600, y: 1600, formation: "line" });

    assert.equal(plan.slots.filter((slot) => slot.adjusted).length, 1, "only the blocked slot is adjusted");
    assert.equal(plan.slots[2].adjusted, true);
    for (const index of [0, 1, 3, 4]) {
      assert.equal(plan.slots[index].x, unobstructed.slots[index].x, "unaffected slots must not move");
      assert.equal(plan.slots[index].y, unobstructed.slots[index].y, "unaffected slots must not move");
      assert.equal(plan.slots[index].adjusted, false);
    }
    // The adjusted slot is somewhere the hull can physically sit, and it stayed
    // on its own side of the formation rather than being rotated elsewhere.
    const moved = plan.slots[2];
    assert(moved.reachable, "the adjusted slot must be a point the ship can occupy");
    assert(Math.hypot(moved.x - asteroid.x, moved.y - asteroid.y)
      >= asteroid.radius + physicalCollisionRadius(ships[2]),
    "the adjusted slot must clear the asteroid");
    const stillBetween = (moved.y - plan.slots[1].y) * (plan.slots[3].y - moved.y) > 0;
    assert(stillBetween, "the adjusted slot keeps its place in the line");
  }

  // --- a later order replaces the shape completely -------------------------
  {
    const ships = column(5);
    const room = makeRoom(ships);
    commandShips(room, room.players.get("p1"), 3600, 1600, {
      shipIds: ships.map((ship) => ship.id),
      formation: "line"
    });
    const lineSlots = ships.map(slotOf);
    for (let index = 0; index < 30; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);

    commandShips(room, room.players.get("p1"), 2400, 2600, {
      shipIds: ships.map((ship) => ship.id),
      formation: "wedge"
    });
    assert(ships.every((ship) => ship.movement.command.formation.type === "wedge"));
    assert(ships.every((ship, index) => (
      ship.movement.destination.x !== lineSlots[index].x
        || ship.movement.destination.y !== lineSlots[index].y
    )), "the new order must replace every previous slot");
    assert(ships.every((ship) => ship.movement.route === null && ship.movement.path.length === 0),
      "no route from the old slot may survive the new order");

    const wedgeSlots = ships.map(slotOf);
    for (let index = 0; index < 900; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);
    assert.deepEqual(ships.map(slotOf), wedgeSlots, "the wedge slots stand for the whole order");
    assert(ships.every((ship, index) => Math.hypot(ship.x - wedgeSlots[index].x, ship.y - wedgeSlots[index].y) < 40),
      "ships should end up on the new slots, not the old ones");
  }

  // --- a formation handed a Hold attack ------------------------------------
  {
    const ships = column(3, { design: GUNSHIP, x: 900, y0: 1000, pitch: 260 });
    const enemy = makeShip({ id: "enemy", x: 3400, y: 1500, design: GUNSHIP, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    commandShips(room, room.players.get("p1"), 2000, 1400, {
      shipIds: ships.map((ship) => ship.id),
      formation: "line"
    });
    const slots = ships.map(slotOf);
    for (let index = 0; index < 60; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);

    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });
    assert(ships.every((ship) => ship.movement.command.type === "attack"),
      "the attack order replaces the move order");
    assert(ships.every((ship) => ship.movement.command.formation === null),
      "combat orders carry no formation");
    assert(ships.every((ship) => ship.movement.command.targetId === enemy.id),
      "the fleet shares only the target identity");

    for (let index = 0; index < 900; index += 1) {
      movementTestTick(room, [...ships, enemy], DT, index * DT * 1000);
    }
    assert(ships.every((ship) => ship.movement.holdEngaged),
      `each ship should find its own firing position (${ships.map((ship) => ship.movement.phase).join(",")})`);
    assert.equal(new Set(ships.map((ship) => `${ship.x.toFixed(1)}:${ship.y.toFixed(1)}`)).size, ships.length,
      "no two ships are assigned one shared combat position");
    // The formation slots stopped controlling translation the moment the attack
    // order landed: nothing is holding a ship on the line it was flying.
    assert(ships.some((ship, index) => Math.hypot(ship.x - slots[index].x, ship.y - slots[index].y) > 200),
      "old formation slots must not keep pulling ships");
    const reach = getMaxEffectiveWeaponRange(ships[0]);
    const ranges = ships.map((ship) => Math.hypot(ship.x - enemy.x, ship.y - enemy.y));
    assert(ranges.every((range) => range <= reach + 80), "each ship stops inside its own firing envelope");
    // No ring: the stopping distances are whatever each approach produced, not
    // one shared radius the group was arranged on.
    assert(ships.every((ship) => ship.movement.command.formation === null
      && !Object.keys(ship.movement).some((key) => key.toLowerCase().includes("slot"))),
    "no combat formation or ring state is created");
  }

  // --- a formation handed a Charge -----------------------------------------
  {
    const ships = column(3, { design: GUNSHIP, x: 900, y0: 1000, pitch: 260 })
      .map((ship) => makeShip({ id: ship.id, x: ship.x, y: ship.y, design: GUNSHIP, combatStyle: "charge" }));
    const enemy = makeShip({ id: "charge-enemy", x: 3400, y: 1500, design: BASE, ownerId: "p2" });
    const room = makeRoom(ships, [], enemy);
    commandShips(room, room.players.get("p1"), 2000, 1400, {
      shipIds: ships.map((ship) => ship.id),
      formation: "wedge"
    });
    for (let index = 0; index < 60; index += 1) movementTestTick(room, ships, DT, index * DT * 1000);

    commandShips(room, room.players.get("p1"), enemy.x, enemy.y, {
      shipIds: ships.map((ship) => ship.id),
      targetId: enemy.id
    });
    assert(ships.every((ship) => ship.movement.command.formation === null),
      "a Charge order carries no formation either");

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
        // Occluding the run-in: a friendly nearer the target whose hull covers
        // the line this ship would have to fly down.
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

  console.log("verify-movement-formations: OK");
}

run();
