"use strict";

const { PARTS } = require("../src/server/components");
const { initComponentState } = require("../src/server/componentHealth");
const Power = require("../src/server/componentPower");
const Data = require("../src/server/componentData");
const Heat = require("../src/server/heat");
const DataRules = require("../public/src/shared/dataSupportRules");

const clone = (v) => JSON.parse(JSON.stringify(v));

function createRuntimeShip(fixture) {
  const ship = { id: `runtime-${fixture.key || fixture.name}`, x: 0, y: 0, angle: 0, radius: 40, alive: true,
    design: clone(fixture.design), wiring: clone(fixture.wiring), stats: { maxHp: 1000 }, weaponCooldowns: [] };
  initComponentState(ship);
  Heat.initShipHeat(ship);
  Power.initializeComponentPower(ship);
  Data.rebuildShipDataTopology(ship, "fixture-runtime");
  return ship;
}
function applyFullPower(ship) { Power.applyShipPowerAllocation(ship); Data.refreshShipDataAllocation(ship, "full-power"); return ship.componentPower; }
function applyPartialPower(ship, sourceIndex, multiplier) { ship.componentPower ||= { byComponentIndex: [] }; ship.componentPower.byComponentIndex[sourceIndex] ||= {}; ship.componentPower.byComponentIndex[sourceIndex].operationalMultiplier = Math.max(0, Math.min(1, Number(multiplier) || 0)); return Data.refreshShipDataAllocation(ship, "partial-power"); }
function disconnectSourcePower(ship, sourceIndex) { return applyPartialPower(ship, sourceIndex, 0); }
function initializeHeat(ship) { Heat.initShipHeat(ship); return ship.componentHeatState; }
function setSourceThermalState(ship, sourceIndex, state) { ship.componentHeatState ||= []; ship.componentHeatState[sourceIndex] = state; return Data.refreshShipDataAllocation(ship, "heat-state"); }
function destroyComponent(ship, componentIndex) { ship.componentHp[componentIndex] = 0; Power.rebuildShipWiringState(ship, `destroy-${componentIndex}`); return ship; }
function repairComponent(ship, componentIndex) { ship.componentHp[componentIndex] = ship.componentMaxHp[componentIndex] || 1; Power.rebuildShipWiringState(ship, `repair-${componentIndex}`); return ship; }
function refreshDataAllocation(ship) { return Data.refreshShipDataAllocation(ship, "manual-refresh"); }
function rebuildDataTopology(ship) { return Data.rebuildShipDataTopology(ship, "manual-rebuild"); }
function effectiveWeaponStats(ship, weaponIndex) { return Data.getEffectiveWeaponStats(ship, weaponIndex); }
function runtimeSourceAllocation(ship, sourceIndex) { return Data.getSourceDataAllocation(ship, sourceIndex); }
function runtimeWeaponSupport(ship, weaponIndex) { return Data.getWeaponDataSupport(ship, weaponIndex); }
function supportDisabledStats(ship, weaponIndex) { return DataRules.effectiveWeaponProfile(PARTS[ship.design[weaponIndex].type].weapon, null); }

module.exports = { createRuntimeShip, applyFullPower, applyPartialPower, disconnectSourcePower, initializeHeat, setSourceThermalState, destroyComponent, repairComponent, refreshDataAllocation, rebuildDataTopology, effectiveWeaponStats, runtimeSourceAllocation, runtimeWeaponSupport, supportDisabledStats, HeatState: Heat.STATE };
