"use strict";

const assert = require("assert");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { initComponentState } = require("./src/server/componentHealth");
const { computeStats } = require("./src/server/shipStats");
const { initializeComponentPower, getComponentPowerMultiplier, effectiveShieldStats } = require("./src/server/componentPower");

const at = (type, x, y) => ({ type, x, y, rotation: 0 });
function wiringFor(design, paths) {
  let wiring = WiringRules.emptyWiring();
  for (const [source, target, cells] of paths) wiring = WiringRules.addConnection(wiring, "power", source, target, cells, design, PARTS);
  return wiring;
}
function shipFor(design, wiring) {
  const ship = { design, wiring, stats: { ...computeStats(design) }, shield: 0 };
  initComponentState(ship);
  initializeComponentPower(ship);
  return ship;
}

// One 3.2 MW auxiliary generator supplies two 1.8 MW engines at 8/9 output.
const design = [at("auxGenerator", 0, 0), at("engine", 1, 0), at("gyroscope", 2, 0), at("frame", 1, 1), at("gyroscope", 3, 0)];
const wiring = wiringFor(design, [
  [0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]],
  [0, 2, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]
]);
const ship = shipFor(design, wiring);
const efficiency = PARTS.auxGenerator.powerGeneration / (PARTS.engine.powerUse + PARTS.gyroscope.powerUse);
assert.equal(ship.componentPower.byComponentIndex[0].state, "source");
assert.equal(ship.componentPower.byComponentIndex[1].state, "underpowered");
// The shared power-flow solver allocates in fixed-point Power units, so the
// shared underpower ratio matches the ideal proportional efficiency to within
// one unit rather than exactly.
assert(Math.abs(getComponentPowerMultiplier(ship, 1) - efficiency) < 2e-3, "underpowered consumers share network efficiency");
assert.equal(getComponentPowerMultiplier(ship, 3), 1, "passive transit frame remains passive");
assert.equal(ship.componentPower.byComponentIndex[3].state, "passive", "wire transit never promotes a component");
assert.equal(getComponentPowerMultiplier(ship, 4), 0, "disconnected powered consumer is disabled");

const poweredDesign = [at("reactor", 0, 0), at("engine", 1, 0), at("frame", 2, 0)];
const powered = shipFor(poweredDesign, wiringFor(poweredDesign, [[0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]]]));
assert.equal(powered.componentPower.byComponentIndex[1].state, "powered");
assert.equal(getComponentPowerMultiplier(powered, 1), 1);

// A surplus on an isolated network cannot rescue another consumer.
const isolatedDesign = [at("reactor", 0, 0), at("engine", 1, 0), at("gyroscope", 3, 0)];
const isolated = shipFor(isolatedDesign, wiringFor(isolatedDesign, [[0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]]]));
assert.equal(getComponentPowerMultiplier(isolated, 1), 1);
assert.equal(getComponentPowerMultiplier(isolated, 2), 0);

// Shield capacity is the sum of operational component contributions, without
// mutating the catalogue/base balance values.
const shieldDesign = [at("auxGenerator", 0, 0), at("shield", 1, 0), at("shield", 3, 0)];
const shields = shipFor(shieldDesign, wiringFor(shieldDesign, [[0, 1, [{ x: 0, y: 0 }, { x: 1, y: 0 }]]]));
const shieldMultiplier = Math.min(1, PARTS.auxGenerator.powerGeneration / PARTS.shield.powerUse);
assert(Math.abs(effectiveShieldStats(shields).capacity - PARTS.shield.shield * shieldMultiplier) < 1e-6, "shield capacity scales with the solver's Power multiplier");
assert(Math.abs(effectiveShieldStats(shields).recharge - PARTS.shield.shieldRegen * shieldMultiplier) < 1e-6, "shield recharge scales with the solver's Power multiplier");

ship.componentHp[1] = 0;
assert.equal(getComponentPowerMultiplier(ship, 1), 0, "destruction overrides the intact topology snapshot");
assert.equal(ship.componentPower.byComponentIndex[1].state, "underpowered", "direct hp mutation does not pretend to rebuild topology");

console.log("Power runtime verification passed.");
