"use strict";

const assert = require("assert");
const UniversalPower = require("../public/src/shared/universalPower");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const health = require("../src/server/componentHealth");
const heat = require("../src/server/heat");
const componentPower = require("../src/server/componentPower");
const HeatRules = require("../public/src/shared/heatRules");

function close(actual, expected, message) {
  assert(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} !== ${expected}`);
}

function makeShip(design) {
  const hp = design.map((module) => PARTS[module.type]?.hp || 40);
  const ship = {
    id: "power-test",
    alive: true,
    design,
    stats: computeStats(design),
    componentHp: hp.slice(),
    componentMaxHp: hp.slice(),
    dirtyComponents: new Set(),
    dirtyHeat: new Set(),
    x: 0,
    y: 0,
    angle: 0,
    shield: 0
  };
  health.initComponentState(ship);
  heat.initShipHeat(ship);
  componentPower.initializeComponentPower(ship);
  return ship;
}

// The shared rule applies one ratio to all active consumers when generation is
// short. There is no component order or network topology in the result.
{
  const design = [{ type: "core" }, { type: "beamEmitter" }];
  const flow = UniversalPower.calculateUniversalPower(design, PARTS);
  close(flow.summary.availableGenerationMw, 4, "Core supply");
  close(flow.summary.demandMw, 7.5, "Beam demand");
  close(flow.summary.powerRatio, 4 / 7.5, "shortage ratio");
  close(flow.byComponentIndex[1].allocatedMw, 4, "shared consumer allocation");
  assert.strictEqual(flow.byComponentIndex[1].state, "underpowered");
}

// Batteries supplement the same pool, then their stored MJ changes only at a
// simulation-time boundary.
{
  const design = [{ type: "core" }, { type: "battery" }, { type: "beamEmitter" }];
  const flow = UniversalPower.calculateUniversalPower(design, PARTS);
  close(flow.summary.generatorOutputMw, 4, "generator output");
  close(flow.summary.storageDischargeMw, 3.5, "battery discharge supply");
  close(flow.summary.availableGenerationMw, 7.5, "battery-backed supply");
  close(flow.summary.powerRatio, 1, "battery-backed ratio");
  close(flow.summary.usedGenerationMw, 7.5, "battery plus generator delivered supply");
  assert.strictEqual(flow.byComponentIndex[2].state, "powered");

  const advanced = UniversalPower.calculateUniversalPower(design, PARTS, {
    componentStorageChargeByIndex: [0, 80, 0],
    elapsedSeconds: 1,
    availabilitySeconds: 1,
    advanceStorage: true
  });
  close(advanced.storageCharges[1], 80 - 3.5 / PARTS.battery.dischargeEfficiency, "battery MJ discharge");
}

{
  const design = [{ type: "core" }, { type: "beamEmitter" }];
  const stats = computeStats(design);
  close(stats.availablePower, 4, "server static available Power");
  close(stats.powerRatio, 0.53, "server static Power ratio");
  assert(stats.powerDebuff > 0, "server movement is penalized by a real shortage");
}

{
  const design = [{ type: "core" }, { type: "battery" }, { type: "beamEmitter" }];
  const ship = makeShip(design);
  const before = ship.componentStorageCharge[1];
  componentPower.updateShipPower(ship, 1);
  assert(ship.componentStorageCharge[1] < before, "runtime battery discharges over time");
  assert.strictEqual(ship.powerAnalysis.summary.powerRatio, 1, "battery keeps the active consumer powered");
}

{
  const design = [{ type: "core" }, { type: "reactor" }, { type: "beamEmitter" }];
  const hot = makeShip(design);
  hot.componentHeatState[1] = HeatRules.STATE.OVERHEATED;
  componentPower.reallocateShipPower(hot, "power-test", { skipDataRefresh: true, skipRuntimeStats: true });
  close(hot.powerAnalysis.summary.generatorOutputMw, 4, "overheated reactor is removed from supply");
  close(hot.powerAnalysis.summary.powerRatio, 4 / 7.5, "overheated reactor shortage ratio");

  hot.componentHp[1] = 0;
  componentPower.reallocateShipPower(hot, "power-test-destroyed", { skipDataRefresh: true, skipRuntimeStats: true });
  close(hot.powerAnalysis.summary.generatorOutputMw, 4, "destroyed reactor does not remove the Core");
  assert.strictEqual(hot.componentPower.byComponentIndex[1].state, "destroyed");
}

console.log("Universal Power verification passed");
