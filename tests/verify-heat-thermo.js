"use strict";
// Group 6 (thermodynamics): a hotter component sheds heat faster, and heat
// routes through frames into a central heat sink (centralised heat-buffer layout).
const assert = require("assert");
const { initShipHeat, updateShipHeat } = require("./src/server/heat");
const { PARTS } = require("./src/server/components");

function shipFor(design) {
  const hp = design.map((module) => PARTS[module.type]?.hp || 40);
  const ship = { alive: true, design, componentHp: hp.slice(), componentMaxHp: hp.slice(), stats: { powerUse: 0, powerGeneration: 1 } };
  initShipHeat(ship);
  return ship;
}
function ticks(ship, count) { for (let i = 0; i < count; i += 1) updateShipHeat(ship, 0.2); }

// 1. Temperature-dependent dissipation: identical component, hotter sheds more.
function dissipatedAt(fillRatio) {
  const ship = shipFor([{ x: 7, y: 7, type: "blaster" }]);
  ship.componentHeat[0] = ship.componentThermals[0].capacity * fillRatio;
  ship.hasActiveHeat = true;
  updateShipHeat(ship, 0.2);
  return ship.componentHeatRemoved[0];
}
const hot = dissipatedAt(0.9);
const cool = dissipatedAt(0.3);
assert(hot > cool * 1.5, `a hotter component should dissipate much faster (hot=${hot.toFixed(2)} cool=${cool.toFixed(2)})`);

// 2. Frames conduct heat into a central heat sink, whose large capacity buffers
// the ship and delays the source overheating vs an equivalent all-frame hull.
const { STATE } = require("./public/src/shared/heatRules");
function ticksToOverheat(design) {
  const ship = shipFor(design);
  for (let i = 0; i < 4000; i += 1) {
    ship.componentHeatInput[0] += 6; ship.hasActiveHeat = true;
    ticks(ship, 1);
    if (ship.componentHeatState[0] >= STATE.OVERHEATED) return { count: i + 1, ship };
  }
  return { count: Infinity, ship };
}
const sinkRun = ticksToOverheat([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "frame" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "heatSink" }]);
const frameRun = ticksToOverheat([{ x: 5, y: 7, type: "blaster" }, { x: 6, y: 7, type: "frame" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "frame" }]);
assert(sinkRun.ship.componentHeat[3] > 0, "heat should route through the frames into the central heat sink");
assert(sinkRun.count > frameRun.count, `heat sink should delay the source overheating (sink=${sinkRun.count} vs frame=${frameRun.count} ticks)`);

console.log("Heat thermodynamics verification passed");
