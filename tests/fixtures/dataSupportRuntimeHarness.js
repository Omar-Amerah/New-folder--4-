"use strict";

const { PARTS } = require("../../src/server/components");
const { initComponentState, detonateComponent, repairShipComponents } = require("../../src/server/componentHealth");
const Power = require("../../src/server/componentPower");
const Data = require("../../src/server/componentData");
const Heat = require("../../src/server/heat");
const DataRules = require("../../public/src/shared/dataSupportRules");

const clone = (v) => JSON.parse(JSON.stringify(v));

function createRuntimeShip(fixture) {
  const ship = { id: `runtime-${fixture.key || fixture.name}`, x: 0, y: 0, angle: 0, radius: 40, alive: true,
    design: clone(fixture.design), dataLinks: clone(fixture.dataLinks || []), stats: { maxHp: 1000 }, weaponCooldowns: [] };
  ship.componentPowerState = ship.design.map(() => 1);
  initComponentState(ship);
  Heat.initShipHeat(ship);
  Power.initializeComponentPower(ship);
  Data.rebuildShipDataLinks(ship, "fixture-runtime");
  return ship;
}
function applyFullPower(ship) { delete ship._activityDemandByIndex; Power.applyShipPowerAllocation(ship); Data.refreshShipDataAllocation(ship, "full-power"); return ship.componentPower; }
function applyPartialPower(ship, sourceIndex, targetMultiplier = 0.5) {
  // Universal Power is binary at the component boundary: an explicitly
  // An unpowered source contributes zero; there is no partial-output tier.
  ship.componentPowerState[sourceIndex] = Number(targetMultiplier) < 1 ? 0 : 1;
  Power.reallocateShipPower(ship, "fixture-power-state");
  Data.refreshShipDataAllocation(ship, "partial-power-production");
  return ship.componentPower;
}
function disconnectSourcePower(ship, sourceIndex) { return applyPartialPower(ship, sourceIndex, 0); }
function initializeHeat(ship) { Heat.initShipHeat(ship); return ship.componentHeatState; }
function setSourceThermalState(ship, sourceIndex, state) {
  // Reach thermal tiers through production heat input/update. This helper never
  // writes componentHeatState directly; it stops once the runtime state machine
  // reports the requested tier.
  const room = { effects: [], ships: new Map([[ship.id, ship]]) };
  const targetState = Number(state);
  for (let i = 0; i < 240 && ship.componentHeatState?.[sourceIndex] !== targetState; i += 1) {
    Heat.addComponentHeat(ship, sourceIndex, (ship.componentHeatCapacity?.[sourceIndex] || ship.maxHeat || 100) * 0.35);
    Heat.updateShipHeat(ship, 1, room, i * 1000);
  }
  if (ship.componentHeatState?.[sourceIndex] !== targetState) throw new Error(`Unable to drive component ${sourceIndex} to thermal state ${targetState}; reached ${ship.componentHeatState?.[sourceIndex]}`);
  Data.refreshShipDataAllocation(ship, "heat-state-production");
  return ship.componentHeatState;
}
function destroyComponent(ship, componentIndex) { detonateComponent({ effects: [], ships: new Map([[ship.id, ship]]) }, ship, componentIndex, 0, 0, Date.now()); return ship; }
function repairComponent(ship, componentIndex) {
  const missing = Math.max(0, (ship.componentMaxHp?.[componentIndex] || 0) - (ship.componentHp?.[componentIndex] || 0));
  if (missing > 0) repairShipComponents({ effects: [], ships: new Map([[ship.id, ship]]) }, ship, missing, Date.now());
  return ship;
}
function refreshDataAllocation(ship) { return Data.refreshShipDataAllocation(ship, "manual-refresh"); }
function rebuildDataTopology(ship) { return Data.rebuildShipDataTopology(ship, "manual-rebuild"); }
function effectiveWeaponStats(ship, weaponIndex) { return Data.getEffectiveWeaponStats(ship, weaponIndex); }
function runtimeSourceAllocation(ship, sourceIndex) { return Data.getSourceDataAllocation(ship, sourceIndex); }
function runtimeWeaponSupport(ship, weaponIndex) { return Data.getWeaponDataSupport(ship, weaponIndex); }
function supportDisabledStats(ship, weaponIndex) { return DataRules.effectiveWeaponProfile(PARTS[ship.design[weaponIndex].type].weapon, null); }

module.exports = { createRuntimeShip, applyFullPower, applyPartialPower, disconnectSourcePower, initializeHeat, setSourceThermalState, destroyComponent, repairComponent, refreshDataAllocation, rebuildDataTopology, effectiveWeaponStats, runtimeSourceAllocation, runtimeWeaponSupport, supportDisabledStats, HeatState: Heat.STATE };
