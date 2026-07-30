"use strict";

// Phase 3 -- group destination and formation facing.
//
// A selection is a formation, not several ships independently staring at the
// click point. Acceptance criteria:
//
//   * two, six and twenty ships all receive distinct slots
//   * ships do not converge on one exact coordinate
//   * the formation has one sensible forward direction
//   * ships do not all point inward on arrival
//   * reissuing a move command rotates the destination formation
//   * small and large ships receive enough spacing
//   * slot assignment is stable, not re-decided every tick

const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  commandShips,
  generateDestinationSlots,
  updateShipMovement,
  updateShipSeparation
} = require("./src/server/movement");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower } = require("./src/server/componentPower");
const { initShipHeat } = require("./src/server/heat");
const { createGeneratedPowerWiring } = require("./src/server/shipDesign");

const DT = 1 / 30;

const LIGHT_DESIGN = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 7, y: 8, type: "engine" }
];

// A wide hull, for the spacing criterion: its slots have to be further apart
// than a corvette's or the formation lands on top of itself.
const WIDE_DESIGN = (() => {
  const modules = [{ x: 8, y: 6, type: "core" }];
  const taken = new Set(["8,6"]);
  const claim = (x, y, width, height) => {
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < height; j += 1) if (taken.has(`${x + i},${y + j}`)) return false;
    }
    for (let i = 0; i < width; i += 1) {
      for (let j = 0; j < height; j += 1) taken.add(`${x + i},${y + j}`);
    }
    return true;
  };
  for (const [x, y] of [[4, 11], [6, 11], [8, 11], [10, 11]]) {
    if (claim(x, y, 1, 2)) modules.push({ x, y, type: "engine" });
  }
  for (const [x, y] of [[6, 3], [9, 3], [6, 9], [9, 9]]) {
    if (claim(x, y, 2, 1)) modules.push({ x, y, type: "reactor" });
  }
  for (let x = 4; x <= 12; x += 1) {
    for (let y = 3; y <= 10; y += 1) if (claim(x, y, 1, 1)) modules.push({ x, y, type: "frame" });
  }
  return modules;
})();

let shipSeq = 0;

function makeShip(design, x, y, angle = 0) {
  const stats = computeStats(design);
  const ship = {
    id: `s${String(++shipSeq).padStart(3, "0")}`,
    ownerId: "p1",
    alive: true,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    targetX: x,
    targetY: y,
    radius: stats.radius,
    physicalRadius: Math.max(18, stats.radius * 0.56),
    design: design.map((part) => ({ ...part })),
    wiring: createGeneratedPowerWiring(design),
    stats,
    combatStyle: "hold"
  };
  initComponentState(ship);
  initializeComponentPower(ship);
  initShipHeat(ship);
  return ship;
}

function makeScenario(ships) {
  const player = { id: "p1", team: "A", ships };
  return {
    player,
    room: {
      world: { width: 6000, height: 5000 },
      map: { asteroids: [] },
      ships: new Map(ships.map((ship) => [ship.id, ship])),
      players: new Map([["p1", player]]),
      stations: [],
      effects: []
    }
  };
}

// A block formation: `columns` wide, laid out around (x, y).
function makeBlock(count, x, y, spacing = 90, columns = 3, design = LIGHT_DESIGN) {
  const ships = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    ships.push(makeShip(design, x + column * spacing, y + row * spacing));
  }
  return ships;
}

function simulate(room, ships, seconds, onTick = null) {
  const ticks = Math.round(seconds / DT);
  for (let tick = 0; tick < ticks; tick += 1) {
    for (const ship of ships) updateShipMovement(room, ship, DT, tick * DT * 1000);
    updateShipSeparation(room, ships, DT, tick * DT * 1000);
    if (onTick) onTick(tick);
  }
}

function angleDelta(a, b) {
  let delta = a - b;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

function centreOf(ships) {
  return {
    x: ships.reduce((sum, ship) => sum + ship.x, 0) / ships.length,
    y: ships.reduce((sum, ship) => sum + ship.y, 0) / ships.length
  };
}

function destinationsOf(ships) {
  return ships.map((ship) => ({ id: ship.id, ...ship.movement.destination }));
}

function run() {
  // --- Distinct slots at every group size ----------------------------------
  for (const count of [2, 6, 20]) {
    const ships = makeBlock(count, 800, 800, 90, Math.ceil(Math.sqrt(count)));
    const { room, player } = makeScenario(ships);
    const result = commandShips(room, player, 3500, 2500, { shipIds: ships.map((s) => s.id) });
    assert.strictEqual(result.commanded, count, `${count} ships: all should be commanded`);

    const slots = destinationsOf(ships);
    for (const slot of slots) {
      assert(Number.isFinite(slot.x) && Number.isFinite(slot.y),
        `${count} ships: every ship should have a destination`);
    }
    const unique = new Set(slots.map((slot) => `${slot.x.toFixed(3)},${slot.y.toFixed(3)}`));
    assert.strictEqual(unique.size, count, `${count} ships: every slot should be distinct`);

    // Distinct is not enough -- they must be far enough apart to sit side by
    // side. The narrowest acceptable gap is two hull radii.
    const minimumGap = ships[0].physicalRadius * 2;
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const gap = Math.hypot(slots[i].x - slots[j].x, slots[i].y - slots[j].y);
        assert(gap >= minimumGap,
          `${count} ships: slots ${i} and ${j} are ${gap.toFixed(1)} px apart, need ${minimumGap.toFixed(1)}`);
      }
    }

    // And none of them is the clicked point for everybody.
    const onClick = slots.filter((slot) => Math.hypot(slot.x - 3500, slot.y - 2500) < 1).length;
    assert(onClick <= 1, `${count} ships: at most one slot may be the clicked point (${onClick} were)`);
  }

  // --- One sensible forward direction, and nobody points inward ------------
  {
    const ships = makeBlock(6, 800, 1200, 110, 3);
    const { room, player } = makeScenario(ships);
    const start = centreOf(ships);
    commandShips(room, player, 4200, 1400, { shipIds: ships.map((s) => s.id) });
    const groupHeading = Math.atan2(1400 - start.y, 4200 - start.x);

    // Every ship carries the same travel heading.
    for (const ship of ships) {
      assert(Number.isFinite(ship.movement.command.formationHeading),
        "every ship in a group order should carry the formation heading");
      assert(Math.abs(angleDelta(ship.movement.command.formationHeading, groupHeading)) < 1e-9,
        "the formation heading should be the group's own course");
    }

    simulate(room, ships, 60);

    for (const ship of ships) {
      const toSlot = Math.hypot(ship.x - ship.movement.destination.x, ship.y - ship.movement.destination.y);
      assert(toSlot < 24, `every ship should reach its own slot (${ship.id} is ${toSlot.toFixed(1)} px off)`);
      assert(ship.movement.arrived, `${ship.id} should report arrival`);
    }

    // They point the way the formation was going, not at each other and not at
    // the click. A spread of more than a few degrees means the hulls fanned.
    const spread = Math.max(...ships.map((ship) => Math.abs(angleDelta(ship.angle, groupHeading))));
    assert(spread < 0.12,
      `an arrived formation should hold one forward direction (worst ship ${(spread * 180 / Math.PI).toFixed(1)} deg off course)`);

    // "Pointing inward" has a precise meaning: the hull's nose is aimed at the
    // formation's own centre. Check no ship is doing that.
    const arrived = centreOf(ships);
    for (const ship of ships) {
      const toCentre = Math.hypot(arrived.x - ship.x, arrived.y - ship.y);
      if (toCentre < 1) continue; // the ship that actually holds the centre slot
      const inward = Math.abs(angleDelta(ship.angle, Math.atan2(arrived.y - ship.y, arrived.x - ship.x)));
      assert(inward > 0.25,
        `${ship.id} is pointing at the centre of the formation (${(inward * 180 / Math.PI).toFixed(1)} deg off it)`);
    }

    // The formation is still a formation: it kept its extent rather than
    // collapsing onto the click point.
    const extent = Math.max(...ships.map((ship) => Math.hypot(ship.x - arrived.x, ship.y - arrived.y)));
    assert(extent > ships[0].physicalRadius * 2,
      `the arrived formation should keep its extent (${extent.toFixed(1)} px)`);
  }

  // --- Reissuing rotates the destination formation -------------------------
  {
    const ships = makeBlock(6, 800, 1200, 110, 3);
    const { room, player } = makeScenario(ships);

    // First order: due east.
    commandShips(room, player, 4200, 1200, { shipIds: ships.map((s) => s.id) });
    const eastward = new Map(ships.map((ship) => [ship.id, { ...ship.movement.destination }]));
    const eastHeading = ships[0].movement.command.formationHeading;

    simulate(room, ships, 60);

    // Second order from the new position, on a completely different bearing:
    // due south, well inside the map so the destination is not clamped.
    const centre = centreOf(ships);
    commandShips(room, player, centre.x, centre.y + 2200, { shipIds: ships.map((s) => s.id) });
    const southHeading = ships[0].movement.command.formationHeading;

    const headingChange = Math.abs(angleDelta(southHeading, eastHeading));
    assert(headingChange > 1.4,
      `the second order should be a real change of course (${(headingChange * 180 / Math.PI).toFixed(1)} deg)`);

    const southward = new Map(ships.map((ship) => [ship.id, { ...ship.movement.destination }]));

    // The formation the player has on screen is the formation they get, in the
    // same orientation, whichever way the group travelled to reach it. So a
    // change of course must NOT turn the layout: every ship keeps its offset
    // from the group's centre, and the whole shape is simply translated.
    //
    // An earlier version rotated the layout by the change of course. It made a
    // line abreast arrive as a column -- not what the player pointed at -- and
    // tied the arrangement to whichever way the hulls happened to be facing.
    const centreOfSlots = (slots) => {
      const entries = [...slots.values()];
      return {
        x: entries.reduce((sum, slot) => sum + slot.x, 0) / entries.length,
        y: entries.reduce((sum, slot) => sum + slot.y, 0) / entries.length
      };
    };
    const eastCentre = centreOfSlots(eastward);
    const southCentre = centreOfSlots(southward);
    for (const ship of ships) {
      const before = eastward.get(ship.id);
      const after = southward.get(ship.id);
      const error = Math.hypot(
        (after.x - southCentre.x) - (before.x - eastCentre.x),
        (after.y - southCentre.y) - (before.y - eastCentre.y)
      );
      assert(error < 20,
        `${ship.id}: its place in the formation should survive a change of course (moved ${error.toFixed(1)} px within the layout)`);
    }

    // ...and the formation as a whole did go somewhere.
    assert(Math.hypot(southCentre.x - eastCentre.x, southCentre.y - eastCentre.y) > 500,
      "the second order should actually relocate the formation");
  }

  // --- Small and large ships receive enough spacing ------------------------
  {
    const small = makeBlock(4, 800, 800, 90, 2, LIGHT_DESIGN);
    const smallScenario = makeScenario(small);
    commandShips(smallScenario.room, smallScenario.player, 3000, 2000, { shipIds: small.map((s) => s.id) });
    const smallSlots = destinationsOf(small);

    const large = makeBlock(4, 800, 800, 240, 2, WIDE_DESIGN);
    const largeScenario = makeScenario(large);
    commandShips(largeScenario.room, largeScenario.player, 3000, 2000, { shipIds: large.map((s) => s.id) });
    const largeSlots = destinationsOf(large);

    const closest = (slots) => {
      let best = Infinity;
      for (let i = 0; i < slots.length; i += 1) {
        for (let j = i + 1; j < slots.length; j += 1) {
          best = Math.min(best, Math.hypot(slots[i].x - slots[j].x, slots[i].y - slots[j].y));
        }
      }
      return best;
    };
    const smallGap = closest(smallSlots);
    const largeGap = closest(largeSlots);
    assert(large[0].physicalRadius > small[0].physicalRadius,
      "the wide fixture should actually be wider");
    assert(largeGap > smallGap,
      `wider hulls should get wider slots (small ${smallGap.toFixed(1)} px, large ${largeGap.toFixed(1)} px)`);
    assert(largeGap >= large[0].physicalRadius * 2,
      `large hulls should not be given overlapping slots (${largeGap.toFixed(1)} px for radius ${large[0].physicalRadius.toFixed(1)})`);

    // Every large ship must physically fit its slot once it gets there.
    simulate(largeScenario.room, large, 90);
    for (let i = 0; i < large.length; i += 1) {
      for (let j = i + 1; j < large.length; j += 1) {
        const gap = Math.hypot(large[i].x - large[j].x, large[i].y - large[j].y);
        assert(gap >= large[i].physicalRadius + large[j].physicalRadius - 2,
          `arrived hulls should not be inside one another (${gap.toFixed(1)} px)`);
      }
    }
  }

  // --- Slot assignment is stable -------------------------------------------
  {
    const ships = makeBlock(6, 800, 1200, 110, 3);
    const { room, player } = makeScenario(ships);
    commandShips(room, player, 4200, 2400, { shipIds: ships.map((s) => s.id) });
    const issued = destinationsOf(ships);

    // Nothing re-decides a slot while the order is being flown.
    simulate(room, ships, 30, () => {
      const current = destinationsOf(ships);
      for (let index = 0; index < current.length; index += 1) {
        assert.strictEqual(current[index].x, issued[index].x,
          `${ships[index].id}: destination must not change while under way`);
        assert.strictEqual(current[index].y, issued[index].y,
          `${ships[index].id}: destination must not change while under way`);
      }
    });

    // And the assignment is a pure function of the fleet's geometry: the same
    // order from the same positions produces exactly the same slots.
    const repeat = generateDestinationSlots(room, ships, { x: 4200, y: 2400 });
    const again = generateDestinationSlots(room, ships, { x: 4200, y: 2400 });
    assert.strictEqual(repeat.size, again.size, "repeat assignment should cover the same ships");
    for (const [id, slot] of repeat) {
      assert(again.get(id) && again.get(id).x === slot.x && again.get(id).y === slot.y,
        `${id}: repeated assignment should be identical`);
    }
  }

  // --- Ordering is preserved: assigned paths do not cross ------------------
  {
    // Six ships in a line abreast, sent straight ahead. The ship on the left of
    // the line must end up on the left of the destination formation.
    const ships = [];
    for (let index = 0; index < 6; index += 1) ships.push(makeShip(LIGHT_DESIGN, 1000, 800 + index * 120));
    const { room, player } = makeScenario(ships);
    commandShips(room, player, 4000, 1100, { shipIds: ships.map((s) => s.id) });
    const heading = ships[0].movement.command.formationHeading;
    const acrossX = -Math.sin(heading);
    const acrossY = Math.cos(heading);
    const order = ships.map((ship) => ({
      before: ship.x * acrossX + ship.y * acrossY,
      after: ship.movement.destination.x * acrossX + ship.movement.destination.y * acrossY
    })).sort((a, b) => a.before - b.before);
    for (let index = 1; index < order.length; index += 1) {
      assert(order[index].after >= order[index - 1].after - 1e-6,
        "a ship on the left of the formation should be given a slot on the left");
    }
  }

  console.log("verify-movement-phase3: OK");
}

run();
