"use strict";

const { PARTS } = require("../src/server/components");
const { initComponentState, detonateComponent, repairShipComponents } = require("../src/server/componentHealth");
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
function applyPartialPower(ship, sourceIndex, targetMultiplier = 0.5) {
  // Drive brownout through the production Power allocator by removing live
  // generation from the source's Power network. The resulting multiplier is the
  // authoritative runtime value; tests inspect it instead of fabricating it.
  applyFullPower(ship);
  const before = Power.getComponentPowerMultiplier(ship, sourceIndex);
  const target = Math.max(0, Math.min(1, Number(targetMultiplier) || 0));
  const networkId = ship.componentPower?.byComponentIndex?.[sourceIndex]?.networkId;
  const network = (ship.runtimeWiring?.powerNetworks || []).find((n) => n.id === networkId);
  const generators = (network?.sourceIndices || [])
    .filter((i) => i !== sourceIndex && (ship.componentHp?.[i] ?? 0) > 0)
    .sort((a, b) => (PARTS[ship.design[a].type]?.powerGeneration || 0) - (PARTS[ship.design[b].type]?.powerGeneration || 0));
  for (const index of generators) {
    if (Power.getComponentPowerMultiplier(ship, sourceIndex) <= target) break;
    destroyComponent(ship, index);
  }
  const after = Power.getComponentPowerMultiplier(ship, sourceIndex);
  if (target > 0 && before > target && after >= before) throw new Error(`Production Power flow did not reduce component ${sourceIndex}`);
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
