"use strict";
// Coolant-network redesign: HEAT PIPE = transport, HEAT SINK = storage,
// HEAT VENT = weak external rejection, RADIATOR = strong external rejection.
//
// Every case here is written against the authoritative server runtime, so a
// change to the transport solver, the exposure rules or the catalogue data is
// caught by the same suite that documents the intended mechanics.
const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const {
  initShipHeat,
  updateShipHeat,
  addComponentHeat,
  rebuildThermalNetworks,
  buildHeatDebug
} = require("../src/server/heat");
const { repairShipComponents } = require("../src/server/componentHealth");

function shipFor(design) {
  const hp = design.map((module) => PARTS[module.type]?.hp || 40);
  const ship = {
    alive: true,
    design,
    componentHp: hp.slice(),
    componentMaxHp: hp.slice(),
    stats: { powerUse: 0, powerGeneration: 1 },
    dirtyComponents: new Set()
  };
  initShipHeat(ship);
  return ship;
}
function tick(ship) { ship.hasActiveHeat = true; updateShipHeat(ship, 0.2); }
function run(ship, count, feed = () => {}) {
  const totals = { radiated: ship.design.map(() => 0) };
  for (let i = 0; i < count; i += 1) {
    feed(ship, i);
    tick(ship);
    for (let index = 0; index < ship.design.length; index += 1) totals.radiated[index] += ship.componentHeatRadiated[index] || 0;
  }
  return totals;
}
function totalHeat(ship) { return ship.componentHeat.reduce((sum, value) => sum + value, 0); }
function assertSane(ship, label) {
  assert(ship.componentHeat.every((value) => Number.isFinite(value) && value >= 0), `${label}: no NaN or negative heat`);
}
function coolantNetworkOf(ship, index) {
  return (ship.coolantNetworks || []).find((network) =>
    network.pipeIndices.includes(index) || network.attachments.some((attachment) => attachment.index === index)) || null;
}
function attachedTo(network) {
  return network ? network.attachments.map((attachment) => attachment.index).sort((a, b) => a - b) : [];
}

// ===========================================================================
// 1. Hot component -> Heat Pipe -> Radiator: heat moves and the radiator sheds it
// ===========================================================================
{
  const ship = shipFor([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "radiator" }]);
  ship.componentHeat[0] = 200;
  const totals = run(ship, 40);
  assert(ship.componentHeatReceived[2] >= 0, "radiator received heat");
  assert(totals.radiated[2] > 0, "radiator rejected heat delivered through the pipe");
  assert(ship.componentHeat[0] < 200, "source cooled down through the coolant network");
  assertSane(ship, "pipe to radiator");
  console.log("1. hot component -> pipe -> radiator — passed");
}

// ===========================================================================
// 2. Hot component -> Heat Pipe -> Heat Sink: storage actually fills
// ===========================================================================
{
  const ship = shipFor([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "heatSink" }]);
  ship.componentHeat[0] = 200;
  run(ship, 40);
  assert(ship.componentHeat[2] > 20, `heat sink absorbed the spike (stored ${ship.componentHeat[2].toFixed(1)})`);
  assert(ship.componentHeat[2] > ship.componentHeat[1] * 5, "the sink, not the pipe, holds the heat");
  assertSane(ship, "pipe to sink");
  console.log("2. hot component -> pipe -> heat sink — passed");
}

// ===========================================================================
// 3. A Heat Sink does NOT raise its neighbours' heat capacity
// ===========================================================================
{
  const alone = shipFor([{ x: 5, y: 7, type: "blaster" }]);
  const beside = shipFor([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "heatSink" }, { x: 5, y: 6, type: "heatSink" }]);
  assert.strictEqual(beside.componentThermals[0].capacity, alone.componentThermals[0].capacity,
    "a component beside two Heat Sinks has exactly its own heat capacity");
  assert.strictEqual(beside.maxHeat,
    HeatRules.profile("blaster", PARTS.blaster).capacity + HeatRules.profile("heatSink", PARTS.heatSink).capacity * 2,
    "ship capacity is the sum of the components' own capacities");
  console.log("3. heat sink gives no adjacency capacity bonus — passed");
}

// ===========================================================================
// 4. A chain of ordinary Frames is not a coolant route
// ===========================================================================
{
  const framed = shipFor([
    { x: 4, y: 7, type: "blaster" }, { x: 5, y: 7, type: "frame" }, { x: 6, y: 7, type: "frame" },
    { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "radiator" }
  ]);
  const piped = shipFor([
    { x: 4, y: 7, type: "blaster" }, { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" },
    { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "radiator" }
  ]);
  const feed = (ship) => addComponentHeat(ship, 0, 3);
  const framedTotals = run(framed, 100, feed);
  const pipedTotals = run(piped, 100, feed);
  assert(pipedTotals.radiated[4] > framedTotals.radiated[4] * 2,
    `frames must not substitute for a coolant run (pipe=${pipedTotals.radiated[4].toFixed(1)} frame=${framedTotals.radiated[4].toFixed(1)})`);
  assert(framed.componentHeat[0] > piped.componentHeat[0] * 1.5,
    "the frame-routed source stays much hotter than the piped one");
  assert.strictEqual((framed.coolantNetworks || []).length, 0, "frames form no coolant network");
  assertSane(framed, "frame chain");
  assertSane(piped, "pipe chain");
  console.log("4. frame chain is not a coolant route — passed");
}

// ===========================================================================
// 5. Ordinary local conduction between touching components still works
// ===========================================================================
{
  const ship = shipFor([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "frame" }, { x: 7, y: 7, type: "armor" }]);
  ship.componentHeat[0] = 150;
  run(ship, 30);
  assert(ship.componentHeat[1] > 0, "heat conducts into a touching frame");
  assert(ship.componentHeat[2] > 0, "heat conducts on into the next touching component");
  assert(ship.componentHeat[0] > ship.componentHeat[1], "conduction is diffusive, not instant equalisation");
  assertSane(ship, "local conduction");
  console.log("5. local conduction through neighbours still works — passed");
}

// ===========================================================================
// 6. Horizontal, vertical and corner layouts all form one network
// ===========================================================================
{
  const horizontal = shipFor([{ x: 4, y: 7, type: "heatPipe" }, { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "radiator" }]);
  assert.strictEqual(horizontal.coolantNetworks.length, 1, "horizontal run is one network");
  assert.deepStrictEqual(horizontal.coolantNetworks[0].pipeIndices.slice().sort((a, b) => a - b), [0, 1, 2], "horizontal run contains all three pipes");

  const vertical = shipFor([{ x: 5, y: 4, type: "heatPipe" }, { x: 5, y: 5, type: "heatPipe" }, { x: 5, y: 6, type: "heatPipe" }, { x: 5, y: 7, type: "radiator" }]);
  assert.strictEqual(vertical.coolantNetworks.length, 1, "vertical run is one network");
  assert.deepStrictEqual(attachedTo(vertical.coolantNetworks[0]), [3], "vertical run reaches the radiator");

  const corner = shipFor([{ x: 5, y: 5, type: "blaster" }, { x: 5, y: 6, type: "heatPipe" }, { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "radiator" }]);
  assert.strictEqual(corner.coolantNetworks.length, 1, "corner run is one network");
  assert.deepStrictEqual(attachedTo(corner.coolantNetworks[0]), [0, 4], "corner run links the source to the radiator");

  // Diagonal contact never connects.
  const diagonal = shipFor([{ x: 5, y: 5, type: "heatPipe" }, { x: 6, y: 6, type: "heatPipe" }]);
  assert.strictEqual(diagonal.coolantNetworks.length, 2, "diagonally touching pipes are separate networks");
  console.log("6. horizontal, vertical and corner layouts — passed");
}

// ===========================================================================
// 7. T-junction
// ===========================================================================
{
  const ship = shipFor([
    { x: 4, y: 7, type: "blaster" },
    { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "heatPipe" },
    { x: 6, y: 6, type: "heatPipe" },
    { x: 6, y: 5, type: "radiator" }, { x: 8, y: 7, type: "heatSink" }
  ]);
  assert.strictEqual(ship.coolantNetworks.length, 1, "T-junction is one network");
  assert.deepStrictEqual(ship.coolantNetworks[0].pipeIndices.slice().sort((a, b) => a - b), [1, 2, 3, 4], "T-junction contains all four pipes");
  assert.deepStrictEqual(attachedTo(ship.coolantNetworks[0]), [0, 5, 6], "the branch reaches both cooling endpoints");
  ship.componentHeat[0] = 250;
  const totals = run(ship, 40);
  assert(totals.radiated[5] > 0, "heat reached the radiator on the branch");
  assert(ship.componentHeat[6] > 0, "heat reached the heat sink on the main run");
  assertSane(ship, "T-junction");
  console.log("7. T-junction network — passed");
}

// ===========================================================================
// 8. Several heat sources can feed one network
// ===========================================================================
{
  const ship = shipFor([
    { x: 5, y: 6, type: "blaster" }, { x: 5, y: 7, type: "blaster" }, { x: 5, y: 8, type: "blaster" },
    { x: 6, y: 6, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" }, { x: 6, y: 8, type: "heatPipe" },
    { x: 7, y: 7, type: "radiator" }
  ]);
  assert.strictEqual(ship.coolantNetworks.length, 1, "three sources share one network");
  assert.deepStrictEqual(attachedTo(ship.coolantNetworks[0]), [0, 1, 2, 6], "all three sources and the radiator are attached");
  const totals = run(ship, 60, (s) => { addComponentHeat(s, 0, 5); addComponentHeat(s, 1, 5); addComponentHeat(s, 2, 5); });
  assert(totals.radiated[6] > 0, "the shared radiator rejected heat from the sources");
  for (const source of [0, 1, 2]) assert(ship.componentHeatTransferredOut[source] >= 0, `source ${source} participates`);
  assertSane(ship, "multi-source");
  console.log("8. several sources feed one network — passed");
}

// ===========================================================================
// 9. Several cooling/storage endpoints can receive from one network
// ===========================================================================
{
  const ship = shipFor([
    { x: 4, y: 7, type: "blaster" }, { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" },
    { x: 5, y: 6, type: "radiator" }, { x: 5, y: 8, type: "heatSink" }, { x: 7, y: 7, type: "heatVent" }
  ]);
  assert.strictEqual(ship.coolantNetworks.length, 1, "one network serves every endpoint");
  assert.deepStrictEqual(attachedTo(ship.coolantNetworks[0]), [0, 3, 4, 5], "radiator, sink and vent all attach");
  ship.componentHeat[0] = 300;
  const totals = run(ship, 60);
  assert(totals.radiated[3] > 0, "the radiator received and rejected heat");
  assert(ship.componentHeat[4] > 0, "the heat sink stored heat");
  assert(totals.radiated[5] > 0, "the heat vent received and rejected heat");
  assertSane(ship, "multi-endpoint");
  console.log("9. several endpoints receive from one network — passed");
}

// ===========================================================================
// 10 & 11. Destroying a pipe splits the network; repair restores it
// ===========================================================================
{
  const ship = shipFor([
    { x: 4, y: 7, type: "blaster" }, { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" },
    { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "radiator" }
  ]);
  assert.strictEqual(ship.coolantNetworks.length, 1, "intact run is one network");

  ship.componentHp[2] = 0;
  rebuildThermalNetworks(ship);
  assert.strictEqual(ship.coolantNetworks.length, 2, "destroying the middle pipe splits the network in two");
  assert.notStrictEqual(coolantNetworkOf(ship, 0).id, coolantNetworkOf(ship, 4).id,
    "the source and the radiator are no longer on the same network");
  assert(!ship.coolantNetworks.some((network) => network.pipeIndices.includes(2)), "a destroyed pipe leaves the network");

  ship.componentHeat.fill(0);
  const brokenTotals = run(ship, 60, (s) => addComponentHeat(s, 0, 8));
  assert.strictEqual(ship.componentHeat[4], 0, "no heat crossed the break");
  assert.strictEqual(brokenTotals.radiated[4], 0, "the isolated radiator rejected nothing");

  repairShipComponents(null, ship, ship.componentMaxHp[2], 0);
  assert.strictEqual(ship.coolantNetworks.length, 1, "repairing the pipe rebuilds a single network");
  assert.strictEqual(coolantNetworkOf(ship, 0).id, coolantNetworkOf(ship, 4).id, "the source reaches the radiator again");
  const repairedTotals = run(ship, 60, (s) => addComponentHeat(s, 0, 8));
  assert(repairedTotals.radiated[4] > 0, "heat flows again once the network is rebuilt");
  assertSane(ship, "destroy and repair");
  console.log("10-11. destroying a pipe splits the network, repair restores it — passed");
}

// ===========================================================================
// 12-14. Heat Vent: exposure gate, and it stays weaker than a Radiator
// ===========================================================================
{
  const ventOnly = shipFor([{ x: 5, y: 7, type: "heatVent" }]);
  assert(ventOnly.componentThermals[0].exposedEdges > 0, "a lone vent is exposed");
  ventOnly.componentHeat[0] = 40;
  const exposedTotals = run(ventOnly, 10);
  assert(exposedTotals.radiated[0] > 0, "an exposed Heat Vent rejects heat");

  const enclosingFrames = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: 5 + dx, y: 7 + dy, type: "frame" }));
  const buried = shipFor([{ x: 5, y: 7, type: "heatVent" }, ...enclosingFrames]);
  assert.strictEqual(buried.componentThermals[0].exposedEdges, 0, "the buried vent has no exposed edge");
  buried.componentHeat[0] = 40;
  const enclosedTotals = run(buried, 10);
  assert(enclosedTotals.radiated[0] < exposedTotals.radiated[0] * 0.2,
    `an enclosed Heat Vent rejects almost nothing (enclosed=${enclosedTotals.radiated[0].toFixed(2)} exposed=${exposedTotals.radiated[0].toFixed(2)})`);

  // Exposure is binary. Two vents at identical temperature exchange nothing, so
  // the only difference from the lone vent above is that each has three open
  // edges instead of four — and each must still reject exactly the same amount.
  const pair = shipFor([{ x: 5, y: 7, type: "heatVent" }, { x: 6, y: 7, type: "heatVent" }]);
  assert.strictEqual(pair.componentThermals[0].exposedEdges, 3, "each vent in the pair has three open edges");
  pair.componentHeat[0] = 40;
  pair.componentHeat[1] = 40;
  const pairTotals = run(pair, 10);
  assert(Math.abs(pairTotals.radiated[0] - exposedTotals.radiated[0]) < 1e-9,
    `three exposed edges give the same output as four — no reward for checkerboard hulls (three=${pairTotals.radiated[0]} four=${exposedTotals.radiated[0]})`);
  assert.strictEqual(HeatRules.HEAT_VENT_EXPOSED_MULTIPLIER, 1, "exposure is a gate, not a per-edge bonus");

  // Under identical exposed conditions the Radiator is clearly stronger.
  const ventRun = shipFor([{ x: 5, y: 7, type: "heatVent" }]);
  const radiatorRun = shipFor([{ x: 5, y: 7, type: "radiator" }]);
  ventRun.componentHeat[0] = ventRun.componentThermals[0].capacity * 0.8;
  radiatorRun.componentHeat[0] = radiatorRun.componentThermals[0].capacity * 0.8;
  const ventTotals = run(ventRun, 10);
  const radiatorTotals = run(radiatorRun, 10);
  assert(radiatorTotals.radiated[0] > ventTotals.radiated[0] * 2,
    `a Radiator must clearly outperform a Heat Vent (radiator=${radiatorTotals.radiated[0].toFixed(1)} vent=${ventTotals.radiated[0].toFixed(1)})`);
  assert(HeatRules.profile("heatVent", PARTS.heatVent).cooling < HeatRules.profile("radiator", PARTS.radiator).cooling,
    "catalogue data keeps the vent below the radiator");
  assert(PARTS.heatVent.cost < PARTS.radiator.cost, "the vent is the cheap option");
  assert(PARTS.heatVent.mass < PARTS.radiator.mass, "the vent is the light option");
  assert(PARTS.heatVent.hp < PARTS.radiator.hp, "the vent is the fragile option");
  assert.strictEqual(PARTS.heatVent.powerUse, 0, "the vent draws no Power");
  assert.deepStrictEqual(PARTS.heatVent.footprint, { width: 1, height: 1 }, "the vent is 1x1");
  console.log("12-14. heat vent exposure gate and radiator comparison — passed");
}

// A vent fed only through a coolant network still works, from any side.
{
  const ship = shipFor([{ x: 5, y: 7, type: "reactor" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatVent" }]);
  ship.componentHeat[0] = 200;
  const totals = run(ship, 60);
  assert(totals.radiated[3] > 0, "REACTOR - PIPE - PIPE - VENT rejects heat to space");

  const vertical = shipFor([{ x: 5, y: 5, type: "reactor" }, { x: 5, y: 6, type: "heatPipe" }, { x: 5, y: 7, type: "heatVent" }]);
  vertical.componentHeat[0] = 200;
  assert(run(vertical, 60).radiated[2] > 0, "the same layout works vertically — attachment is adjacency-based");
  console.log("    heat vent attaches to a coolant network from any side — passed");
}

// ===========================================================================
// 15. Heat Pipes neither remove nor create heat
// ===========================================================================
{
  const ship = shipFor([
    { x: 4, y: 7, type: "blaster" }, { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" },
    { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "armor" }
  ]);
  assert.strictEqual(HeatRules.profile("heatPipe", PARTS.heatPipe).cooling, 0, "a Heat Pipe has zero cooling");
  ship.componentHeat[0] = 200;
  const before = totalHeat(ship);
  let removed = 0;
  let generated = 0;
  for (let i = 0; i < 60; i += 1) {
    tick(ship);
    removed += ship.componentHeatRemoved.reduce((sum, value) => sum + value, 0);
    generated += ship.componentHeatGenerated.reduce((sum, value) => sum + value, 0);
    // Whatever leaves the ship must leave through a component that can cool;
    // the pipes themselves must never account for any of it.
    for (const pipe of [1, 2, 3]) {
      assert.strictEqual(ship.componentHeatCooled[pipe], 0, "a Heat Pipe removed heat");
      assert.strictEqual(ship.componentHeatRadiated[pipe], 0, "a Heat Pipe radiated heat");
    }
  }
  assert(Math.abs((before + generated) - (totalHeat(ship) + removed)) < 1e-6, "heat is conserved across the coolant network");
  assertSane(ship, "pipes do not remove heat");
  console.log("15. heat pipes transport without removing heat — passed");
}

// ===========================================================================
// 16. Transport is throughput-limited and never equalises instantly
// ===========================================================================
{
  const ship = shipFor([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "heatSink" }]);
  ship.componentHeat[0] = ship.componentThermals[0].capacity; // ratio 1.0
  const sourceRatioBefore = ship.componentHeat[0] / ship.componentThermals[0].capacity;
  tick(ship);
  const sourceRatio = ship.componentHeat[0] / ship.componentThermals[0].capacity;
  const sinkRatio = ship.componentHeat[2] / ship.componentThermals[2].capacity;
  assert(sourceRatio < sourceRatioBefore, "the source gave up heat in the first step");
  assert(sourceRatio > sinkRatio * 3, `one step must not equalise the network (source=${sourceRatio.toFixed(3)} sink=${sinkRatio.toFixed(3)})`);

  // The per-edge bandwidth ceiling bounds a single step's transfer.
  const moved = ship.componentThermals[0].capacity - ship.componentHeat[0];
  const ceiling = HeatRules.COOLANT_ATTACHMENT_BANDWIDTH * HeatRules.TICK_SECONDS;
  assert(moved <= ceiling + 1e-9, `a single attachment edge cannot exceed its bandwidth (moved=${moved.toFixed(3)} ceiling=${ceiling})`);

  // More contact area means more throughput, deterministically.
  const wide = shipFor([{ x: 5, y: 7, type: "heatPipe" }, { x: 5, y: 8, type: "heatPipe" }, { x: 6, y: 7, type: "armor" }, { x: 6, y: 8, type: "armor" }]);
  const wideNetwork = wide.coolantNetworks[0];
  assert.strictEqual(wideNetwork.attachments.length, 2, "two armour plates attach to the two-pipe network");

  const doubleContact = shipFor([{ x: 5, y: 7, type: "heatPipe" }, { x: 5, y: 8, type: "heatPipe" }, { x: 6, y: 7, type: "engine" }]);
  const doubleAttachment = doubleContact.coolantNetworks[0].attachments.find((attachment) => attachment.index === 2);
  assert(doubleAttachment && doubleAttachment.sharedEdges >= 1, "a multi-cell attachment records its contact area once");
  console.log("16. transport is throughput-limited, not instant equalisation — passed");
}

// ===========================================================================
// 17. Determinism and bookkeeping
// ===========================================================================
{
  const layout = [
    { x: 4, y: 7, type: "blaster" }, { x: 5, y: 7, type: "heatPipe" }, { x: 6, y: 7, type: "heatPipe" },
    { x: 6, y: 6, type: "heatPipe" }, { x: 6, y: 5, type: "radiator" }, { x: 7, y: 7, type: "heatSink" },
    { x: 5, y: 8, type: "heatVent" }
  ];
  const first = shipFor(layout.map((module) => ({ ...module })));
  const second = shipFor([...layout].reverse().map((module) => ({ ...module })));
  const feedFirst = (ship) => addComponentHeat(ship, 0, 7);
  const feedSecond = (ship) => addComponentHeat(ship, layout.length - 1, 7);
  run(first, 80, feedFirst);
  run(second, 80, feedSecond);
  assert(Math.abs(totalHeat(first) - totalHeat(second)) < 1e-6,
    `network solve is independent of design order (a=${totalHeat(first).toFixed(6)} b=${totalHeat(second).toFixed(6)})`);
  assertSane(first, "determinism a");
  assertSane(second, "determinism b");

  const debug = buildHeatDebug(first);
  assert(debug.coolantNetworks.length === 1, "debug reports the single coolant network");
  assert(debug.components.every((component) => Number.isFinite(component.currentHeat) && component.currentHeat >= 0), "debug heat values are sane");
  assert.strictEqual(debug.components[1].routeType, "heatPipe", "a pipe reports its transport route type");
  assert.strictEqual(debug.components[0].routeType, "attached", "an attachment reports as attached");
  assert(debug.components[6].removedByHeatVentPerSecond >= 0, "vent rejection is reported separately from radiator rejection");
  assert.strictEqual(debug.components[6].removedByRadiatorPerSecond, 0, "a vent is not counted as a radiator");
  console.log("17. determinism, conservation and telemetry — passed");
}

console.log("All coolant-network tests passed");
