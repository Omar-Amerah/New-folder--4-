"use strict";
const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const { initShipHeat, rebuildThermalNetworks, updateShipHeat, buildHeatDebug, addComponentHeat } = require("./src/server/heat");
const { PARTS } = require("./src/server/components");
const { validateDesign } = require("./src/server/shipDesign");

function shipFor(design) {
  const hp = design.map(module => PARTS[module.type]?.hp || 40);
  const ship = { alive: true, design, componentHp: hp.slice(), componentMaxHp: hp.slice(), stats: { powerUse: 0, powerGeneration: 1 } };
  initShipHeat(ship);
  return ship;
}
function ticks(ship, count) { for (let i = 0; i < count; i += 1) updateShipHeat(ship, 0.2); }

// Adjacent transfer and empty-space isolation.
const adjacent = shipFor([{ x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "armor" }]);
addComponentHeat(adjacent, 0, 100); ticks(adjacent, 2);
assert(adjacent.componentHeat[1] > 0, "adjacent component did not receive heat");
const separated = shipFor([{ x: 7, y: 7, type: "frame" }, { x: 9, y: 7, type: "armor" }]);
addComponentHeat(separated, 0, 100); ticks(separated, 4);
assert.strictEqual(separated.componentHeat[1], 0, "heat crossed empty space");

// Two 2x1 footprints share two occupied edges, represented once with edge count 2.
const multi = shipFor([{ x: 7, y: 7, type: "repairBeam" }, { x: 7, y: 8, type: "repairBeam" }]);
assert.strictEqual(multi.componentAdjacency[0][0].sharedEdges, 2, "multi-tile shared edge count is wrong");

// Simultaneous edge transfer is order independent.
function transferred(order) {
  const s = shipFor(order);
  s.componentHeat[0] = 90; s.componentHeat[1] = 35; s.componentHeat[2] = 0; s.hasActiveHeat = true;
  ticks(s, 1);
  return s.componentHeat.slice().sort((a, b) => a - b).map(value => value.toFixed(5));
}
assert.deepStrictEqual(
  transferred([{x:7,y:7,type:"frame"},{x:8,y:7,type:"frame"},{x:9,y:7,type:"frame"}]),
  transferred([{x:9,y:7,type:"frame"},{x:8,y:7,type:"frame"},{x:7,y:7,type:"frame"}]),
  "component order changed transfer result"
);

// Heat sinks store heat and saturate instead of deleting neighbour heat.
const sink = shipFor([{x:7,y:7,type:"frame"},{x:8,y:7,type:"heatSink"}]);
for (let i = 0; i < 180; i += 1) { addComponentHeat(sink, 0, 15); ticks(sink, 1); }
assert(sink.componentHeat[1] > sink.componentThermals[1].capacity * 0.4, "heat sink did not saturate");

// Exterior radiators outperform enclosed radiators.
const exterior = shipFor([{x:7,y:7,type:"radiator"}]);
const enclosed = shipFor([{x:7,y:7,type:"radiator"},{x:6,y:7,type:"frame"},{x:8,y:7,type:"frame"},{x:7,y:6,type:"frame"},{x:7,y:8,type:"frame"}]);
exterior.componentHeat[0] = 100; exterior.hasActiveHeat = true;
enclosed.componentHeat[0] = 100; enclosed.hasActiveHeat = true;
ticks(exterior, 20); ticks(enclosed, 20);
assert(exterior.currentHeat < enclosed.currentHeat, "radiator exposure has no cooling benefit");

// Sustained local heat can overheat a non-generating neighbour.
const neighbour = shipFor([{x:7,y:7,type:"frame"},{x:8,y:7,type:"frame"}]);
for (let i = 0; i < 700; i += 1) { addComponentHeat(neighbour, 0, 20); ticks(neighbour, 1); }
assert(neighbour.componentHeatState[1] >= HeatRules.STATE.HOT, "neighbour never became hot");

// Overheat hysteresis and accurate aggregate state.
assert.strictEqual(HeatRules.stateFor(0.8, HeatRules.STATE.OVERHEATED), HeatRules.STATE.OVERHEATED);
assert.notStrictEqual(HeatRules.stateFor(0.6, HeatRules.STATE.OVERHEATED), HeatRules.STATE.OVERHEATED);
const total = neighbour.componentHeat.reduce((sum, value) => sum + value, 0);
assert(Math.abs(neighbour.currentHeat - total) < 0.001, "ship heat is not component heat sum");
assert(Math.abs(neighbour.heatPressure - neighbour.currentHeat / neighbour.maxHeat) < 0.000001, "ship pressure is not summed heat/capacity");
const builds = neighbour.heatAdjacencyBuilds;
ticks(neighbour, 10);
assert.strictEqual(neighbour.heatAdjacencyBuilds, builds, "adjacency rebuilt during heat ticks");

// Cached frame networks carry heat several cells to central cooling and sever on destruction.
const routed = shipFor([
  {x:6,y:7,type:"blaster"}, {x:7,y:7,type:"frame"}, {x:8,y:7,type:"frame"},
  {x:9,y:7,type:"frame"}, {x:10,y:7,type:"radiator"}
]);
assert.strictEqual(routed.thermalNetworks.length, 1, "connected frames were not cached as one network");
assert(routed.thermalNetworks[0].generators.includes(0) && routed.thermalNetworks[0].radiators.includes(4), "network attachments are incomplete");
for (let i = 0; i < 350; i += 1) { addComponentHeat(routed, 0, 8); ticks(routed, 1); }
assert(routed.componentHeatRemoved[4] > 0 || routed.componentHeat[4] > 0, "central radiator received no heat through frame route");
const networkBuilds = routed.thermalNetworkBuilds;
ticks(routed, 5);
assert.strictEqual(routed.thermalNetworkBuilds, networkBuilds, "thermal network rebuilt during normal ticks");
routed.componentHp[2] = 0;
rebuildThermalNetworks(routed);
assert(routed.thermalNetworks.length >= 2, "destroyed frame did not sever cached network");
assert.notDeepStrictEqual(routed.componentThermalNetworks[0], routed.componentThermalNetworks[4], "generator stayed routed to cooling through destroyed frame");
routed.componentHeat.fill(0); routed.hasActiveHeat = true;
for (let i = 0; i < 80; i += 1) { addComponentHeat(routed, 0, 8); ticks(routed, 1); }
assert.strictEqual(routed.componentHeat[4], 0, "heat crossed a destroyed frame break");
routed.componentHp[2] = routed.componentMaxHp[2];
rebuildThermalNetworks(routed);
assert.deepStrictEqual(routed.componentThermalNetworks[0], routed.componentThermalNetworks[4], "restored frame did not reconnect cooling route");

// Same long frame route is noticeably cooler with a radiator, even though the
// radiator itself stays near 0 because it removes incoming heat immediately.
const withRadiator = shipFor([{x:6,y:7,type:"blaster"},{x:7,y:7,type:"frame"},{x:8,y:7,type:"frame"},{x:9,y:7,type:"frame"},{x:10,y:7,type:"radiator"}]);
const withoutRadiator = shipFor([{x:6,y:7,type:"blaster"},{x:7,y:7,type:"frame"},{x:8,y:7,type:"frame"},{x:9,y:7,type:"frame"},{x:10,y:7,type:"frame"}]);
for (let i = 0; i < 500; i += 1) {
  addComponentHeat(withRadiator, 0, 2); addComponentHeat(withoutRadiator, 0, 2);
  ticks(withRadiator, 1); ticks(withoutRadiator, 1);
}
assert(withRadiator.componentHeat[0] < withoutRadiator.componentHeat[0] * 0.85, "radiator did not meaningfully reduce distant hotspot");
assert(withRadiator.componentHeat[1] > withRadiator.componentHeat[2] && withRadiator.componentHeat[2] > withRadiator.componentHeat[3], "frame route lacks source-to-radiator gradient");
const debug = buildHeatDebug(withRadiator);
assert(debug.components[4].removedByRadiatorPerSecond > 0, "radiator debug output did not record network cooling");
assert(debug.networks[0].attachedRadiators.includes(4) && debug.networks[0].attachedHeatSources.includes(0), "network debug attachments missing");

// Heat pipes form lightweight thermal routes that let ships move heat into a central cooling bank.
const pipeRouted = shipFor([
  {x:6,y:7,type:"blaster"}, {x:7,y:7,type:"heatPipe"}, {x:8,y:7,type:"heatPipe"},
  {x:9,y:7,type:"heatPipe"}, {x:10,y:7,type:"radiator"}
]);
const pipeUncooled = shipFor([
  {x:6,y:7,type:"blaster"}, {x:7,y:7,type:"heatPipe"}, {x:8,y:7,type:"heatPipe"},
  {x:9,y:7,type:"heatPipe"}, {x:10,y:7,type:"frame"}
]);
assert.strictEqual(pipeRouted.thermalNetworks.length, 1, "heat pipes were not cached as one thermal route");
assert(pipeRouted.thermalNetworks[0].generators.includes(0) && pipeRouted.thermalNetworks[0].radiators.includes(4), "heat-pipe route did not attach source and central radiator");
for (let i = 0; i < 400; i += 1) {
  addComponentHeat(pipeRouted, 0, 2); addComponentHeat(pipeUncooled, 0, 2);
  ticks(pipeRouted, 1); ticks(pipeUncooled, 1);
}
assert(pipeRouted.componentHeat[0] < pipeUncooled.componentHeat[0] * 0.8, "heat pipe did not move hotspot heat to central cooling");
assert(pipeRouted.componentHeatRadiated[4] > 0, "central radiator did not radiate heat delivered by heat pipes");

assert(HeatRules.profile("heatPipe", PARTS.heatPipe).capacity < HeatRules.profile("frame", PARTS.frame).capacity, "heat pipe stores too much heat compared with frame");
assert.strictEqual(HeatRules.profile("heatPipe", PARTS.heatPipe).cooling, 0, "heat pipe should not cool by itself");
assert(HeatRules.profile("heatPipe", PARTS.heatPipe).conductivity > HeatRules.profile("frame", PARTS.frame).conductivity, "heat pipe should conduct better than frame");
assert(PARTS.heatPipe.hp < PARTS.frame.hp * 0.5, "heat pipe is not structurally weaker than frame");

const unsupportedByPipe = validateDesign([
  {x:7,y:7,type:"core"},
  {x:8,y:7,type:"heatPipe"},
  {x:9,y:7,type:"engine"}
]);
assert(!unsupportedByPipe.ok, "heat pipe incorrectly provided structural support between core and engine");

pipeRouted.componentHp[2] = 0;
rebuildThermalNetworks(pipeRouted);
pipeRouted.componentHeat.fill(0); pipeRouted.componentHeatRadiated.fill(0); pipeRouted.hasActiveHeat = true;
for (let i = 0; i < 80; i += 1) { addComponentHeat(pipeRouted, 0, 8); ticks(pipeRouted, 1); }
assert.strictEqual(pipeRouted.componentHeat[4], 0, "heat crossed a destroyed heat pipe break");
assert.strictEqual(pipeRouted.componentHeatRadiated[4], 0, "radiator cooled heat through a destroyed heat pipe");

console.log("Heat verification passed");
