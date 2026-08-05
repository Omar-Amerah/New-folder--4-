#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { WIRING_ENABLED } = require("../public/src/shared/featureFlags");
const { DEFAULT_DESIGN, DEFAULT_WIRING } = require("../src/server/config");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const {
  initializeComponentPower,
  reallocateShipPower,
  getComponentPowerMultiplier
} = require("../src/server/componentPower");
const { initShipHeat } = require("../src/server/heat");
const { getWeaponDataSupport, getEffectiveWeaponStats, refreshShipDataAllocation } = require("../src/server/componentData");
const DataSupportRules = require("../public/src/shared/dataSupportRules");

const design = DEFAULT_DESIGN.map((part) => ({ ...part }));
const stats = computeStats(design, DEFAULT_WIRING);
const ship = {
  design,
  wiring: DEFAULT_WIRING,
  stats: { ...stats },
  alive: true,
  componentHp: design.map((part) => PARTS[part.type]?.hp || 1),
  componentMaxHp: design.map((part) => PARTS[part.type]?.hp || 1),
  componentPowerState: design.map(() => 1),
  dirtyComponents: new Set()
};

global.__mfaDataSupportPerf = {};
initializeComponentPower(ship);
initShipHeat(ship);

if (WIRING_ENABLED) {
  assert.ok((global.__mfaDataSupportPerf.powerFlowSolveCount || 0) > 0, "enabled Wiring runs the authoritative Power solver");
  assert.ok((global.__mfaDataSupportPerf.wiringAnalysisCount || 0) > 0, "enabled Wiring analyzes physical topology");
  assert.notEqual(stats.costBreakdown.totalInfrastructure, undefined, "enabled Wiring includes infrastructure cost");
} else {
  assert.equal(global.__mfaDataSupportPerf.powerFlowSolveCount || 0, 0, "disabled Wiring skips Power-flow solves");
  assert.equal(global.__mfaDataSupportPerf.wiringAnalysisCount || 0, 0, "disabled Wiring skips physical topology analysis");
  assert.equal(ship.runtimeWiring.powerNetworks.length, 0, "disabled Wiring creates no runtime Power networks");
  assert.equal(ship.runtimeWiring.dataNetworks.length, 0, "disabled Wiring creates no runtime Data networks");
  assert.ok(ship.componentPower.byComponentIndex.every((entry) => entry.operationalMultiplier === 1), "live components receive universal Power");
  assert.ok(ship.componentWiringDisplacement.every((value) => value === 0), "disabled Wiring does not displace Heat capacity");
  assert.equal(ship.powerCableHeatRate, 0, "disabled Wiring generates no cable Heat");
  assert.equal(stats.powerEfficiency, 1, "universal Power gives full design efficiency");
  assert.equal(stats.powerDebuff, 0, "universal Power applies no movement penalty");
  assert.equal(stats.costBreakdown.totalInfrastructure, undefined, "disabled Wiring adds no infrastructure cost");

  const dataDesign = [
    { type: "fireControl", x: 6, y: 7, rotation: 0 },
    { type: "blaster", x: 7, y: 7, rotation: 0 },
    { type: "railgun", x: 8, y: 7, rotation: 0 }
  ];
  const dataShip = {
    design: dataDesign,
    wiring: null,
    stats: computeStats(dataDesign),
    alive: true,
    componentHp: dataDesign.map((part) => PARTS[part.type]?.hp || 1),
    componentMaxHp: dataDesign.map((part) => PARTS[part.type]?.hp || 1),
    componentPowerState: dataDesign.map(() => 1),
    dirtyComponents: new Set()
  };
  initializeComponentPower(dataShip);
  const expectedShare = DataSupportRules.nominalSupportBudget("fireControl", PARTS) / 2;
  assert.equal(dataShip.runtimeDataSupport.networks.length, 1, "disabled Wiring creates one automatic Data-link domain");
  assert.equal(getWeaponDataSupport(dataShip, 1).fireRateBonus, expectedShare, "first compatible weapon receives its diminished share");
  assert.equal(getWeaponDataSupport(dataShip, 2).fireRateBonus, expectedShare, "second compatible weapon receives its diminished share");
  assert.equal(
    getEffectiveWeaponStats(dataShip, 1).fireRate,
    PARTS.blaster.weapon.fireRate * (1 + expectedShare),
    "automatic Data share changes the authoritative weapon profile"
  );
  dataShip.componentHp[2] = 0;
  refreshShipDataAllocation(dataShip, "automatic-link-recipient-destroyed");
  assert.equal(getWeaponDataSupport(dataShip, 1).fireRateBonus, expectedShare * 2, "surviving weapon receives the source's full budget");
  assert.equal(getWeaponDataSupport(dataShip, 2).fireRateBonus, 0, "destroyed weapon no longer consumes a Data share");
  dataShip.componentHp[0] = 0;
  refreshShipDataAllocation(dataShip, "automatic-link-source-destroyed");
  assert.equal(getWeaponDataSupport(dataShip, 1).fireRateBonus, 0, "destroyed Data source stops supporting linked weapons");
}

const consumerIndex = design.findIndex((part) => (PARTS[part.type]?.powerUse || 0) > 0);
assert.ok(consumerIndex >= 0, "fixture contains a Power consumer");
ship.componentHp[consumerIndex] = 0;
reallocateShipPower(ship, "feature-flag-verification");
assert.equal(getComponentPowerMultiplier(ship, consumerIndex), 0, "destroyed components remain offline");

delete global.__mfaDataSupportPerf;
console.log(`Wiring feature-flag verification passed (${WIRING_ENABLED ? "enabled" : "disabled / universal Power"})`);
