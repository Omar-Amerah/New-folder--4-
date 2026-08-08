"use strict";
const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");
const { initShipHeat, updateShipHeat, addComponentHeat, rebuildThermalNetworks, buildHeatDebug, isThermalRouteType } = require("../src/server/heat");
const { repairShipComponents } = require("../src/server/componentHealth");
const { PARTS } = require("../src/server/components");

function shipFor(design) {
  const hp = design.map(m => PARTS[m.type]?.hp || 40);
  const ship = { alive: true, design, componentHp: hp.slice(), componentMaxHp: hp.slice(), stats: { powerUse: 0, powerGeneration: 1 }, dirtyComponents: new Set() };
  initShipHeat(ship);
  return ship;
}
function tick(s) { s.hasActiveHeat = true; updateShipHeat(s, 0.2); }
function ticks(s, n) { for (let i = 0; i < n; i += 1) { s.hasActiveHeat = true; updateShipHeat(s, 0.2); } }

// ===========================================================================
// Section 1: Direct Heat Pipe attachment — components beside heat pipes join
// the same thermal network without needing an intermediate frame.
// ===========================================================================

// Weapon beside heat pipe joins network
let wpn = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]);
assert.strictEqual(wpn.thermalNetworks.length, 1, "weapon beside heat pipe should form one network");
assert(wpn.thermalNetworks[0].generators.includes(0), "weapon attached to heat pipe network");
assert(wpn.thermalNetworks[0].radiators.includes(2), "radiator attached to heat pipe network");
assert(wpn.thermalNetworks[0].attachedComponents.includes(0), "weapon is an attached component of heat pipe network");

// Engine beside heat pipe joins network
let eng = shipFor([{ x: 7, y: 7, type: "engine" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]);
assert.strictEqual(eng.thermalNetworks.length, 1, "engine beside heat pipe should form one network");
assert(eng.thermalNetworks[0].attachedComponents.includes(0), "engine is attached to heat pipe network");

// Heat Sink beside heat pipe joins network
let snk = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "heatSink" }]);
assert.strictEqual(snk.thermalNetworks.length, 1, "heat sink beside heat pipe should form one network");
assert(snk.thermalNetworks[0].sinks.includes(2), "heat sink attached to heat pipe network");

// Radiator beside heat pipe joins network
let rad = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]);
assert.strictEqual(rad.thermalNetworks.length, 1, "radiator beside heat pipe should form one network");
assert(rad.thermalNetworks[0].radiators.includes(2), "radiator attached to heat pipe network");

// Shield beside heat pipe joins network
let shd = shipFor([{ x: 7, y: 7, type: "shield" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]);
assert.strictEqual(shd.thermalNetworks.length, 1, "shield beside heat pipe should form one network");
assert(shd.thermalNetworks[0].attachedComponents.includes(0), "shield attached to heat pipe network");

// Multiple components attach to same pipe chain
let multi = shipFor([
  { x: 6, y: 7, type: "blaster" }, { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatPipe" },
  { x: 7, y: 6, type: "armor" }, { x: 8, y: 6, type: "armor" }, { x: 9, y: 7, type: "radiator" }
]);
assert.strictEqual(multi.thermalNetworks.length, 1, "multiple components on pipe chain form one network");
assert(multi.thermalNetworks[0].attachedComponents.includes(0), "blaster attached to pipe chain");
assert(multi.thermalNetworks[0].attachedComponents.includes(3), "engine attached to pipe chain");
assert(multi.thermalNetworks[0].attachedComponents.includes(4), "missile attached to pipe chain");

// Diagonal contact does not connect
let diag = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 8, type: "heatPipe" }, { x: 9, y: 8, type: "radiator" }]);
assert(diag.thermalTopology.incidentEdgeOffsets[0] === diag.thermalTopology.incidentEdgeOffsets[1], "diagonal blaster has no edge to heat pipe");
assert(diag.thermalNetworks.length === 1, "diagonal heat pipe still forms route with radiator");
assert(!diag.thermalNetworks[0].attachedComponents.includes(0), "diagonal weapon not attached to heat pipe network");

// Separated component does not connect
let sep = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 9, y: 7, type: "heatPipe" }, { x: 10, y: 7, type: "radiator" }]);
assert(!sep.thermalNetworks[0].attachedComponents.includes(0), "separated weapon not attached to heat pipe network");

// Components do not need intermediate frame
let noFrame = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]);
assert(noFrame.thermalNetworks[0].attachedComponents.includes(0), "weapon directly beside heat pipe with no frame");

// Attached system components do not become route nodes
let routeCheck = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]);
assert(isThermalRouteType("heatPipe"), "heat pipe is a thermal route");
assert(!isThermalRouteType("blaster"), "blaster is not a thermal route");
assert(routeCheck.thermalNetworks[0].frameIndices.includes(1), "heat pipe is a route node");
assert(!routeCheck.thermalNetworks[0].frameIndices.includes(0), "blaster is not a route node");

// heatPipeIndices tracked separately in network
assert.deepStrictEqual(wpn.thermalNetworks[0].heatPipeIndices, [1], "heatPipeIndices contains only the heat pipe");
assert.deepStrictEqual(wpn.thermalNetworks[0].frameOnlyIndices, [], "frameOnlyIndices empty when only heat pipe");

console.log("Section 1: Direct Heat Pipe attachment — passed");

// ===========================================================================
// Section 2: Transfer performance — Heat Pipe route vs Frame route
// ===========================================================================

// Comparable designs: Generator — Frame — Frame — Frame — Radiator
// vs Generator — Pipe — Pipe — Pipe — Radiator
const frameRoute = shipFor([
  { x: 6, y: 7, type: "blaster" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "frame" },
  { x: 9, y: 7, type: "frame" }, { x: 10, y: 7, type: "radiator" }
]);
const pipeRoute = shipFor([
  { x: 6, y: 7, type: "blaster" }, { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatPipe" },
  { x: 9, y: 7, type: "heatPipe" }, { x: 10, y: 7, type: "radiator" }
]);

// Apply identical heat for 20 seconds (100 ticks) at a moderate rate
let frameRadiated = 0;
let pipeRadiated = 0;
for (let i = 0; i < 100; i += 1) {
  addComponentHeat(frameRoute, 0, 3);
  addComponentHeat(pipeRoute, 0, 3);
  tick(frameRoute);
  tick(pipeRoute);
  frameRadiated += frameRoute.componentHeatRadiated[4];
  pipeRadiated += pipeRoute.componentHeatRadiated[4];
}

// Heat Pipe route should transfer more heat — generator should be cooler
assert(pipeRoute.componentHeat[0] < frameRoute.componentHeat[0],
  `Heat Pipe route did not cool generator better: pipe=${pipeRoute.componentHeat[0].toFixed(1)} frame=${frameRoute.componentHeat[0].toFixed(1)}`);

// Radiator should have received more heat through pipe route
const pipeRadiatorReceived = pipeRoute.componentHeatReceived[4];
const frameRadiatorReceived = frameRoute.componentHeatReceived[4];
assert(pipeRadiatorReceived > 0, "pipe route radiator received no heat");
assert(pipeRadiatorReceived >= frameRadiatorReceived * 1.5,
  `Heat Pipe route did not transfer at least 1.5x to radiator: pipe=${pipeRadiatorReceived.toFixed(1)} frame=${frameRadiatorReceived.toFixed(1)}`);

// Heat conserved (no NaN/negative)
assert(frameRoute.componentHeat.every(v => Number.isFinite(v) && v >= 0), "frame route has invalid heat values");
assert(pipeRoute.componentHeat.every(v => Number.isFinite(v) && v >= 0), "pipe route has invalid heat values");

// No instant equalization — heat still travels locally
assert(pipeRoute.componentHeat[0] > pipeRoute.componentHeat[2],
  "heat pipe route equalized instantly (source should still be hotter than middle)");

// Over the whole run, the coolant network delivered far more heat to the
// radiator than the frame chain did. This replaces the old per-tick
// transferred-out comparison, which measured the residual gradient rather than
// delivery: an efficient coolant network settles into a *small* per-tick
// gradient precisely because it has already moved the heat.
assert(pipeRadiated >= frameRadiated * 1.8,
  `Heat Pipe route did not radiate at least 1.8x as much: pipe=${pipeRadiated.toFixed(1)} frame=${frameRadiated.toFixed(1)}`);

// A chain of ordinary frames is not a coolant route: the source stays far hotter.
assert(frameRoute.componentHeat[0] > pipeRoute.componentHeat[0] * 1.5,
  `frame chain should not behave like a coolant network: frame=${frameRoute.componentHeat[0].toFixed(1)} pipe=${pipeRoute.componentHeat[0].toFixed(1)}`);

console.log("Section 2: Transfer performance — passed");

// ===========================================================================
// Section 3: Multi-source — multiple generators on same pipe chain
// ===========================================================================

const multiSource = shipFor([
  { x: 5, y: 6, type: "blaster" }, { x: 5, y: 7, type: "blaster" }, { x: 5, y: 8, type: "blaster" },
  { x: 6, y: 6, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" }, { x: 6, y: 8, type: "heatPipe" },
  { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatPipe" },
  { x: 9, y: 7, type: "radiator" }, { x: 8, y: 8, type: "heatSink" }
]);

assert.strictEqual(multiSource.thermalNetworks.length, 1, "multi-source pipe chain should form one network");
// All three generators should be attached
assert(multiSource.thermalNetworks[0].generators.includes(0), "generator 0 attached to multi-source network");
assert(multiSource.thermalNetworks[0].generators.includes(1), "generator 1 attached to multi-source network");
assert(multiSource.thermalNetworks[0].generators.includes(2), "generator 2 attached to multi-source network");
// Radiator and heat sink should be attached
assert(multiSource.thermalNetworks[0].radiators.includes(8), "radiator attached to multi-source network");
assert(multiSource.thermalNetworks[0].sinks.includes(9), "heat sink attached to multi-source network");

// Apply heat from all generators
for (let i = 0; i < 100; i += 1) {
  addComponentHeat(multiSource, 0, 5);
  addComponentHeat(multiSource, 1, 5);
  addComponentHeat(multiSource, 2, 5);
  tick(multiSource);
}

// Heat should reach radiator
assert(multiSource.componentHeatRadiated[8] > 0, "radiator did not radiate heat from multi-source pipe");
// Heat should reach heat sink
assert(multiSource.componentHeat[9] > 0, "heat sink did not receive heat from multi-source pipe");
// No heat lost or duplicated
assert(multiSource.componentHeat.every(v => Number.isFinite(v) && v >= 0), "multi-source has invalid heat values");
// Transfer order independent — verify by reversing generator order
const multiSourceReversed = shipFor([
  { x: 5, y: 8, type: "blaster" }, { x: 5, y: 7, type: "blaster" }, { x: 5, y: 6, type: "blaster" },
  { x: 6, y: 8, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" }, { x: 6, y: 6, type: "heatPipe" },
  { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatPipe" },
  { x: 9, y: 7, type: "radiator" }, { x: 8, y: 8, type: "heatSink" }
]);
for (let i = 0; i < 100; i += 1) {
  addComponentHeat(multiSourceReversed, 0, 5);
  addComponentHeat(multiSourceReversed, 1, 5);
  addComponentHeat(multiSourceReversed, 2, 5);
  tick(multiSourceReversed);
}
// Both should have similar total heat (order independent)
const totalA = multiSource.componentHeat.reduce((a, b) => a + b, 0);
const totalB = multiSourceReversed.componentHeat.reduce((a, b) => a + b, 0);
assert(Math.abs(totalA - totalB) < 5, `multi-source transfer is order-dependent: A=${totalA.toFixed(1)} B=${totalB.toFixed(1)}`);

console.log("Section 3: Multi-source — passed");

// ===========================================================================
// Section 4: Damage and repair — destroying heat pipe breaks route
// ===========================================================================

const damageShip = shipFor([
  { x: 6, y: 7, type: "blaster" }, { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatPipe" },
  { x: 9, y: 7, type: "heatPipe" }, { x: 10, y: 7, type: "radiator" }
]);
assert.strictEqual(damageShip.thermalNetworks.length, 1, "initial pipe chain forms one network");

// Destroy middle heat pipe
damageShip.componentHp[2] = 0;
rebuildThermalNetworks(damageShip);
assert(damageShip.thermalNetworks.length >= 2, "destroyed middle heat pipe did not break route");
assert.notDeepStrictEqual(damageShip.componentThermalNetworks[0], damageShip.componentThermalNetworks[4],
  "generator still connected to radiator through destroyed pipe");

// Heat should not cross the gap
damageShip.componentHeat.fill(0);
damageShip.hasActiveHeat = true;
for (let i = 0; i < 80; i += 1) { addComponentHeat(damageShip, 0, 8); tick(damageShip); }
assert.strictEqual(damageShip.componentHeat[4], 0, "heat crossed a destroyed heat pipe break");
assert.strictEqual(damageShip.componentHeatRadiated[4], 0, "radiator cooled through destroyed heat pipe");

// Components remain attached to local network
assert(damageShip.componentThermalNetworks[0].length > 0, "generator still in a local network");

// Repair the heat pipe
repairShipComponents(null, damageShip, damageShip.componentMaxHp[2], 0);
assert.strictEqual(damageShip.thermalNetworks.length, 1, "repaired heat pipe did not rebuild single route");
assert.deepStrictEqual(damageShip.componentThermalNetworks[0], damageShip.componentThermalNetworks[4],
  "repaired heat pipe did not reconnect generator to radiator");

// No duplicate network memberships after destroy/repair cycle
assert(damageShip.componentThermalNetworks[0].length === 1, "duplicate network memberships after repair");
assert(damageShip.componentThermalNetworks[4].length === 1, "duplicate network memberships for radiator after repair");

// Destroyed wreck conductivity is small/local
damageShip.componentHp[2] = 0;
rebuildThermalNetworks(damageShip);
damageShip.componentHeat.fill(0);
damageShip.componentHeat[1] = 50; // heat in pipe adjacent to wreck
damageShip.hasActiveHeat = true;
tick(damageShip);
// Wreck should exchange some heat via destroyed conductivity but not bridge route
assert(damageShip.componentHeat[3] < damageShip.componentHeat[1], "wreck conductivity too high — heat bridged through destroyed pipe");

console.log("Section 4: Damage and repair — passed");

// ===========================================================================
// Section 5: Heat Pipe properties and diagnostics
// ===========================================================================

// Heat Pipe capacity is low (conduit, not buffer)
assert(HeatRules.profile("heatPipe", PARTS.heatPipe).capacity < HeatRules.profile("frame", PARTS.frame).capacity,
  "heat pipe stores too much heat compared with frame");
assert(HeatRules.profile("heatPipe", PARTS.heatPipe).capacity < HeatRules.profile("heatSink", PARTS.heatSink).capacity,
  "heat pipe capacity should be below heat sink");
assert(HeatRules.profile("heatPipe", PARTS.heatPipe).capacity < HeatRules.profile("radiator", PARTS.radiator).capacity,
  "heat pipe capacity should be below radiator");

// Heat Pipe cooling is zero
assert.strictEqual(HeatRules.profile("heatPipe", PARTS.heatPipe).cooling, 0, "heat pipe should not cool by itself");

// Heat Pipe conductivity is higher than frame
assert(HeatRules.profile("heatPipe", PARTS.heatPipe).conductivity > HeatRules.profile("frame", PARTS.frame).conductivity,
  "heat pipe should conduct better than frame");

// Only Heat Pipes form the coolant transport network. Frames still conduct
// locally, but they are not transport nodes any more.
assert.strictEqual(HeatRules.isCoolantTransportType("heatPipe"), true, "heat pipe is coolant transport");
assert.strictEqual(HeatRules.isCoolantTransportType("frame"), false, "frame is not coolant transport");
assert.strictEqual(HeatRules.isCoolantTransportType("heavyFrame"), false, "heavy frame is not coolant transport");
assert.strictEqual(HeatRules.isCoolantTransportType("radiator"), false, "radiator is not coolant transport");
assert.strictEqual(HeatRules.routeTypeMultiplier, undefined, "the frame-route transfer boost is gone");

// effectiveSharedEdges caps at MAX_SHARED_EDGE_MULTIPLIER
assert.strictEqual(HeatRules.effectiveSharedEdges(1), 1, "effectiveSharedEdges(1)");
assert.strictEqual(HeatRules.effectiveSharedEdges(3), 3, "effectiveSharedEdges(3)");
assert.strictEqual(HeatRules.effectiveSharedEdges(5), 3, "effectiveSharedEdges(5) capped");
assert(HeatRules.MAX_SHARED_EDGE_MULTIPLIER === 3, "MAX_SHARED_EDGE_MULTIPLIER should be 3");

// Coolant throughput scales with contact area and is capped the same way.
assert.strictEqual(HeatRules.coolantEdgeBandwidth(1), HeatRules.COOLANT_ATTACHMENT_BANDWIDTH, "one shared edge gets the base bandwidth");
assert.strictEqual(HeatRules.coolantEdgeBandwidth(2), HeatRules.COOLANT_ATTACHMENT_BANDWIDTH * 2, "two shared edges get double bandwidth");
assert.strictEqual(HeatRules.coolantEdgeBandwidth(9), HeatRules.COOLANT_ATTACHMENT_BANDWIDTH * 3, "bandwidth is capped at the shared-edge cap");

// buildHeatDebug includes new diagnostics
const debugShip = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]);
addComponentHeat(debugShip, 0, 50);
tick(debugShip);
const dbg = buildHeatDebug(debugShip);
assert(dbg.components[0].thermalNetworkIds, "component debug has thermalNetworkIds");
assert(dbg.components[0].exposedEdges !== undefined, "component debug has exposedEdges");
assert(dbg.components[0].routeType, "component debug has routeType");
assert.strictEqual(dbg.components[0].routeType, "attached", "blaster routeType is attached");
assert.strictEqual(dbg.components[1].routeType, "heatPipe", "heat pipe routeType is heatPipe");
assert(dbg.components[0].adjacentHeatPipeEdges !== undefined, "component debug has adjacentHeatPipeEdges");
assert(dbg.components[0].adjacentHeatPipeEdges > 0, "blaster has adjacent heat pipe edges");
assert(dbg.networks[0].heatPipeIndices, "network debug has heatPipeIndices");
assert(dbg.networks[0].heatPipeIndices.includes(1), "network debug heatPipeIndices contains pipe index");
assert.strictEqual(dbg.components[1].coolantNetworkId, 0, "heat pipe reports its coolant network");
assert.strictEqual(dbg.components[0].coolantNetworkId, 0, "attached blaster reports the same coolant network");
assert(Array.isArray(dbg.coolantNetworks) && dbg.coolantNetworks.length === 1, "debug exposes one coolant network");
assert.deepStrictEqual(dbg.coolantNetworks[0].pipeIndices, [1], "coolant network debug lists its pipes");
assert.deepStrictEqual([...dbg.coolantNetworks[0].attachedComponents].sort((a, b) => a - b), [0, 2], "coolant network debug lists its attachments");
assert(dbg.coolantNetworks[0].transportedHeatPerSecond > 0, "coolant network debug reports transported heat");
assert(dbg.networks[0].frameIndices !== undefined, "network debug has frameIndices");
assert(dbg.networks[0].sinkIndices !== undefined, "network debug has sinkIndices");
assert(dbg.networks[0].radiatorIndices !== undefined, "network debug has radiatorIndices");
assert(dbg.networks[0].totalStorageCapacity !== undefined, "network debug has totalStorageCapacity");
assert(dbg.networks[0].heatPipeTransferPerSecond !== undefined, "network debug has heatPipeTransferPerSecond");

console.log("Section 5: Heat Pipe properties and diagnostics — passed");

// ===========================================================================
// Section 6: Heat conservation with heat pipe routes
// ===========================================================================

function assertConservation(label, ship, setup, tickCount = 1) {
  setup(ship);
  const initial = ship.componentHeat.reduce((sum, value) => sum + value, 0);
  let generated = 0, removed = 0;
  for (let i = 0; i < tickCount; i += 1) {
    updateShipHeat(ship, 0.2);
    generated += ship.componentHeatGenerated.reduce((sum, value) => sum + value, 0);
    removed += ship.componentHeatRemoved.reduce((sum, value) => sum + value, 0);
  }
  const final = ship.componentHeat.reduce((sum, value) => sum + value, 0);
  assert(Math.abs((initial + generated) - (final + removed)) < 1e-6, `${label} conserves ship Heat`);
  assert(ship.componentHeat.every(v => Number.isFinite(v) && v >= 0), `${label} has no NaN/negative heat`);
}

assertConservation("heat pipe route transfer",
  shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]),
  s => { s.componentHeat[0] = 50; s.hasActiveHeat = true; }, 10);

assertConservation("multi-pipe route transfer",
  shipFor([{ x: 6, y: 7, type: "blaster" }, { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "radiator" }]),
  s => { s.componentHeat[0] = 80; s.hasActiveHeat = true; }, 10);

assertConservation("pipe with heat sink",
  shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "heatSink" }]),
  s => { s.componentHeat[0] = 60; s.hasActiveHeat = true; }, 10);

console.log("Section 6: Heat conservation — passed");

// ===========================================================================
// Section 7: Heat Pipe does not function as heat sink or radiator
// ===========================================================================

const pipeOnly = shipFor([{ x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "heatPipe" }, { x: 9, y: 7, type: "heatPipe" }]);
for (let i = 0; i < 200; i += 1) { addComponentHeat(pipeOnly, 0, 10); tick(pipeOnly); }
// Heat pipe should not cool by itself — heat should accumulate
assert(pipeOnly.componentHeat[0] > 0, "heat pipe route with no cooler should not magically remove heat");
assert(pipeOnly.componentHeatRadiated.every(v => v === 0), "heat pipe should not radiate");

console.log("Section 7: Heat Pipe is not a heat sink or radiator — passed");

// ===========================================================================
// Section 8: Frame and Heat Pipe mixed routes
// ===========================================================================

const mixed = shipFor([
  { x: 6, y: 7, type: "blaster" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "heatPipe" },
  { x: 9, y: 7, type: "frame" }, { x: 10, y: 7, type: "radiator" }
]);
assert.strictEqual(mixed.thermalNetworks.length, 1, "mixed frame/pipe route should form one network");
assert(mixed.thermalNetworks[0].heatPipeIndices.includes(2), "mixed route has heat pipe index");
assert(mixed.thermalNetworks[0].frameOnlyIndices.includes(1), "mixed route has frame-only index");
assert(mixed.thermalNetworks[0].frameOnlyIndices.includes(3), "mixed route has second frame-only index");

// Heat should flow through mixed route
for (let i = 0; i < 100; i += 1) { addComponentHeat(mixed, 0, 5); tick(mixed); }
assert(mixed.componentHeatRadiated[4] > 0, "radiator did not receive heat through mixed route");
assert(mixed.componentHeat.every(v => Number.isFinite(v) && v >= 0), "mixed route has invalid heat values");

console.log("Section 8: Mixed frame/heat pipe routes — passed");

console.log("All Heat Pipe improvement tests passed");
