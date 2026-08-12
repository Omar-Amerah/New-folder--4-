"use strict";

// External and internal cooling, including the existing Burst Cooler lifecycle.
const { PARTS } = require("../components");
const { getCommandAuraMultiplier } = require("../commandAuras");
const HeatRules = require("../../../public/src/shared/heatRules");

const {
  STATE,
  activeCoolingForState,
  RADIATOR_EXPOSED_MULTIPLIER,
  RADIATOR_ENCLOSED_MULTIPLIER,
  HEAT_VENT_EXPOSED_MULTIPLIER,
  HEAT_VENT_ENCLOSED_MULTIPLIER
} = HeatRules;

// Every other cooling component in the catalogue is either a sustained remover
// (Radiator, Closed-Cycle Cooler) or a passive buffer (Heat Sink). A Burst
// Cooler charges from the Heat network and dumps its store in a single tick.
function burstCoolerConfig(ship, index) {
  const config = PARTS[ship.design?.[index]?.type]?.burstCooler;
  return config && config.burstHeat > 0 ? config : null;
}

function updateBurstCooler(ship, index, thermal, heat, runtime, elapsed) {
  const config = burstCoolerConfig(ship, index);
  if (!config) return;
  if (!(ship.componentBurstCoolerRecharge instanceof Float64Array)
    || ship.componentBurstCoolerRecharge.length !== ship.design.length) {
    ship.componentBurstCoolerRecharge = new Float64Array(ship.design.length);
  }
  const recharge = ship.componentBurstCoolerRecharge;
  if (recharge[index] > 0) {
    recharge[index] = Math.max(0, recharge[index] - elapsed);
    return;
  }
  const alive = (ship.componentHp?.[index] ?? 1) > 0;
  if (!alive) return;
  const { getComponentPowerMultiplier } = require("../componentPower");
  const power = getComponentPowerMultiplier(ship, index);
  if (power <= 0) return;
  const stored = Math.max(0, heat[index] + runtime.delta[index]);
  const capacity = Math.max(1, thermal.capacity);
  if (stored / capacity < config.triggerHeatRatio) return;
  const vented = Math.min(stored, config.burstHeat * power);
  if (vented <= 0) return;
  runtime.delta[index] -= vented;
  ship.componentHeatRemoved[index] += vented;
  ship.componentHeatCooled[index] += vented;
  recharge[index] = config.rechargeSeconds;
}

function applyHeatCooling(ship, heat, runtime, elapsed) {
  const heatDissipationMult = getCommandAuraMultiplier(ship, "heatDissipationMultiplier");
  const overheatRecoveryMult = getCommandAuraMultiplier(ship, "overheatRecoveryMultiplier");
  const { getComponentPowerMultiplier } = require("../componentPower");
  for (const index of runtime.touchedComponents) {
    const thermal = ship.componentThermals[index];
    let coolingRate = thermal.cooling * thermal.retention * heatDissipationMult;
    if (ship.design[index].type === "radiator") {
      const alive = (ship.componentHp?.[index] ?? 1) > 0;
      const exposure = thermal.exposedEdges > 0 ? RADIATOR_EXPOSED_MULTIPLIER : RADIATOR_ENCLOSED_MULTIPLIER;
      const active = alive ? thermal.cooling * activeCoolingForState(ship.componentHeatState?.[index] || STATE.NORMAL) : 0;
      coolingRate = active * exposure * thermal.retention * heatDissipationMult;
    } else if (ship.design[index].type === "heatVent") {
      // Passive hull grille: no Power, no heat-state scaling, and almost nothing
      // at all unless at least one of its edges opens onto space.
      const exposure = thermal.exposedEdges > 0 ? HEAT_VENT_EXPOSED_MULTIPLIER : HEAT_VENT_ENCLOSED_MULTIPLIER;
      coolingRate = thermal.cooling * exposure * thermal.retention * heatDissipationMult;
    } else if (ship.design[index].type === "closedCycleCooler") {
      const power = getComponentPowerMultiplier(ship, index);
      const active = thermal.cooling * activeCoolingForState(ship.componentHeatState?.[index] || STATE.NORMAL) * power;
      const passiveFloor = thermal.passiveCooling;
      coolingRate = Math.max(passiveFloor, active) * thermal.retention * heatDissipationMult;
    } else if (burstCoolerConfig(ship, index)) {
      // A Burst Cooler removes almost nothing continuously; its whole output is
      // the vent below. While recharging it drops to a trickle of its rating.
      const config = burstCoolerConfig(ship, index);
      const recharging = (ship.componentBurstCoolerRecharge?.[index] || 0) > 0;
      coolingRate = thermal.cooling * (recharging ? config.rechargeCoolingFraction : 1) * thermal.retention * heatDissipationMult;
    }
    const currentState = ship.componentHeatState?.[index];
    if (currentState >= STATE.CRITICAL && overheatRecoveryMult > 1) coolingRate *= overheatRecoveryMult;
    const removed = Math.min(Math.max(0, heat[index] + runtime.delta[index]), coolingRate * elapsed);
    ship.componentHeatRemoved[index] += removed;
    ship.componentHeatCooled[index] += removed;
    // Radiators and Heat Vents are the two parts that reject heat outside the
    // hull, so both report through the radiated telemetry channel.
    if (ship.design[index].type === "radiator" || ship.design[index].type === "heatVent") ship.componentHeatRadiated[index] = removed;
    runtime.delta[index] -= removed;
    updateBurstCooler(ship, index, thermal, heat, runtime, elapsed);
  }
  return overheatRecoveryMult;
}

module.exports = {
  applyHeatCooling
};
