"use strict";
// Group 6 (thermodynamics): component cooling is literal, and heat routes
// through frames into a central heat sink (centralised heat-buffer layout).
const assert = require("assert");
const { initShipHeat, updateShipHeat } = require("../src/server/heat");
const { PARTS } = require("../src/server/components");

function shipFor(design) {
  const hp = design.map((module) => PARTS[module.type]?.hp || 40);
  const ship = { alive: true, design, componentHp: hp.slice(), componentMaxHp: hp.slice(), stats: { powerUse: 0, powerGeneration: 1 } };
  initShipHeat(ship);
  return ship;
}
function ticks(ship, count) { for (let i = 0; i < count; i += 1) updateShipHeat(ship, 0.2); }

// 1. Cooling rate does not vary with the amount of stored Heat.
function dissipatedAt(fillRatio) {
  const ship = shipFor([{ x: 7, y: 7, type: "blaster" }]);
  ship.componentHeat[0] = ship.componentThermals[0].capacity * fillRatio;
  ship.hasActiveHeat = true;
  updateShipHeat(ship, 0.2);
  return ship.componentHeatRemoved[0];
}
const hot = dissipatedAt(0.9);
const cool = dissipatedAt(0.3);
assert.strictEqual(hot, cool, `cooling rate is literal (hot=${hot.toFixed(2)} cool=${cool.toFixed(2)})`);

// 2. Local conduction still works: a heat sink in direct contact with the source
// buffers it and delays overheating versus an equivalent frame.
const { STATE } = require("../public/src/shared/heatRules");
function ticksToOverheat(design) {
  const ship = shipFor(design);
  for (let i = 0; i < 4000; i += 1) {
    ship.componentHeatInput[0] += 6; ship.hasActiveHeat = true;
    ticks(ship, 1);
    if (ship.componentHeatState[0] >= STATE.OVERHEATED) return { count: i + 1, ship };
  }
  return { count: Infinity, ship };
}
const adjacentSinkRun = ticksToOverheat([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "heatSink" }]);
const adjacentFrameRun = ticksToOverheat([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "frame" }]);
assert(adjacentSinkRun.ship.componentHeat[1] > 0, "heat should conduct into a directly adjacent heat sink");
assert(adjacentSinkRun.count > adjacentFrameRun.count,
  `an adjacent heat sink should delay the source overheating (sink=${adjacentSinkRun.count} vs frame=${adjacentFrameRun.count} ticks)`);

// 3. Distance is what needs a Heat Pipe. A sink three tiles away is only useful
// when a coolant network reaches it; an intervening chain of frames is not a
// coolant route, so it barely helps.
const pipedSinkRun = ticksToOverheat([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "heatPipe" }, { x: 7, y: 7, type: "heatPipe" }, { x: 8, y: 7, type: "heatSink" }]);
const framedSinkRun = ticksToOverheat([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "frame" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "heatSink" }]);
assert(pipedSinkRun.ship.componentHeat[3] > framedSinkRun.ship.componentHeat[3] * 2,
  `a Heat Pipe run should fill a distant sink far faster than a frame chain (pipe=${pipedSinkRun.ship.componentHeat[3].toFixed(1)} frame=${framedSinkRun.ship.componentHeat[3].toFixed(1)})`);
assert(pipedSinkRun.count > framedSinkRun.count,
  `a piped distant sink should delay overheating more than a framed one (pipe=${pipedSinkRun.count} vs frame=${framedSinkRun.count} ticks)`);

console.log("Heat thermodynamics verification passed");
