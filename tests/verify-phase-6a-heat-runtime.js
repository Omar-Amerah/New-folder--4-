"use strict";

const assert = require("assert");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const { initializeComponentPower } = require("../src/server/componentPower");
const Heat = require("../src/server/heat");

const design = [
  { type: "core", x: 7, y: 7, rotation: 0 },
  { type: "reactor", x: 8, y: 7, rotation: 0 },
  { type: "radiator", x: 6, y: 7, rotation: 0 },
  { type: "blaster", x: 7, y: 6, rotation: 0 }
];

function makeShip(id) {
  const dataLinks = [];
  const ship = {
    id,
    alive: true,
    design: structuredClone(design),
    dataLinks,
    stats: computeStats(design, { dataLinks }),
    x: 0,
    y: 0,
    angle: 0,
    dirtyComponents: new Set(),
    dirtyHeat: new Set()
  };
  initComponentState(ship);
  ship.componentPowerState = ship.design.map(() => 1);
  initializeComponentPower(ship);
  Heat.initShipHeat(ship);
  return ship;
}

function run(id) {
  const ship = makeShip(id);
  const room = { effects: [], ships: new Map([[ship.id, ship]]) };
  Heat.addComponentHeat(ship, 1, 40);
  Heat.updateShipHeat(ship, 0.2, room, 200);
  Heat.updateShipHeat(ship, 0.2, room, 400);
  return ship;
}

const first = run("phase-6a-a");
const second = run("phase-6a-b");
assert(first.currentHeat > 0, "Heat accumulates through the authoritative runtime");
assert.deepEqual(first.componentHeat, second.componentHeat, "Heat updates are deterministic");
assert(first.componentHeatState.some((state) => state > Heat.STATE.NORMAL), "heated components enter a thermal state");
assert.equal(first._thermalRuntime.routeComponents, undefined, "Heat runtime has no obsolete route component list");
assert(first._thermalRuntime.topology, "thermal topology remains available for Heat transfer");

console.log("Phase 6A direct Heat runtime verification passed.");
