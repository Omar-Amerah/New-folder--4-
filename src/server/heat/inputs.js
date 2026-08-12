"use strict";

// Runtime Heat producers feed this boundary. Authored activityHeat/heatPerShot
// values and actual-work calculations remain in their existing authorities.
const { PARTS } = require("../components");
const HeatRules = require("../../../public/src/shared/heatRules");
const {
  addPendingHeatInput,
  clearPendingHeatInputs
} = require("./lifecycle");

const { STATE, activeOutputForState } = HeatRules;

function addComponentHeat(ship, index, amount) {
  if (!ship.componentHeatInput || !Number.isFinite(amount) || amount <= 0) return;
  if (index < 0 || index >= ship.componentHeatInput.length) return;
  ship.componentHeatInput[index] += amount;
  addPendingHeatInput(ship, index);
  ship.hasPendingHeatInput = true;
  ship.hasActiveHeat = true;
}

function distributeComponentHeatByWeight(ship, contributions, amount) {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const heatInputLength = ship?.componentHeatInput?.length || 0;
  if (!heatInputLength || !Array.isArray(contributions)) return 0;

  const weightsByIndex = new Map();
  for (const contribution of contributions) {
    const index = contribution?.index;
    if (!Number.isInteger(index) || index < 0 || index >= heatInputLength) continue;
    if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
    const rawWeight = contribution.weight ?? contribution.capacity;
    const weight = Number(rawWeight);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    weightsByIndex.set(index, (weightsByIndex.get(index) || 0) + weight);
  }

  const valid = [...weightsByIndex.entries()]
    .filter(([, weight]) => Number.isFinite(weight) && weight > 0)
    .map(([index, weight]) => ({ index, weight }));
  const totalWeight = valid.reduce((sum, contribution) => sum + contribution.weight, 0);
  if (!valid.length || !Number.isFinite(totalWeight) || totalWeight <= 0) return 0;

  let distributed = 0;
  for (let i = 0; i < valid.length; i += 1) {
    const share = i === valid.length - 1
      ? amount - distributed
      : amount * valid[i].weight / totalWeight;
    distributed += share;
    addComponentHeat(ship, valid[i].index, share);
  }
  return distributed;
}

function applyHeatInputs(ship, runtime, elapsed) {
  for (const index of runtime.workComponents) {
    const alive = (ship.componentHp?.[index] ?? 1) > 0;
    const part = PARTS[ship.design[index].type] || {};
    const thermal = ship.componentThermals[index];
    const generationUsedMw = Number(ship.powerAnalysis?.byComponentIndex?.[index]?.generationUsedMw);
    const ratedGenerationMw = Math.max(0, Number(part.powerGeneration) || 0);
    const generationFraction = ratedGenerationMw > 0 && Number.isFinite(generationUsedMw)
      ? Math.max(0, Math.min(1, generationUsedMw / ratedGenerationMw))
      : 0;
    const steady = alive && ratedGenerationMw > 0
      ? Math.max(0, Number(part.activityHeat) || 0) * generationFraction * elapsed
      : 0;
    const generated = alive ? (Number(ship.componentHeatInput[index]) || 0) + steady : 0;
    ship.componentHeatInput[index] = 0;
    ship.componentHeatGenerated[index] = generated;
    runtime.delta[index] += generated;
    // Keep the local thermal variable referenced in this phase so future
    // catalogue additions cannot accidentally make a missing profile silent.
    void thermal;
  }
  clearPendingHeatInputs(runtime);
}

function componentPerformance(ship, index) {
  return activeOutputForState(ship.componentHeatState?.[index] || STATE.NORMAL);
}

function effectiveComponentBonus(ship, propertyName, predicate) {
  const { getComponentPowerMultiplier } = require("../componentPower");
  let total = 0;
  for (let i = 0; i < (ship.design || []).length; i += 1) {
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    const placed = ship.design[i];
    const part = PARTS[placed.type] || {};
    if (predicate && !predicate(part, placed, i)) continue;
    total += (part[propertyName] || 0) * componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
  }
  return total;
}

module.exports = {
  addComponentHeat,
  distributeComponentHeatByWeight,
  applyHeatInputs,
  componentPerformance,
  effectiveComponentBonus
};
