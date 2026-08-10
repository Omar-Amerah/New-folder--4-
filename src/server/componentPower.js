"use strict";

// Component Power is intentionally universal. A component is supplied from one
// ship-wide pool; there is no topology, priority, cable, or protection solver.

const { PARTS } = require("./components");
const { getCommandAuraMultiplier } = require("./commandAuras");
const { clampNumber } = require("./utils");
const ShieldRules = require("../../public/src/shared/shieldRules");
const HeatRules = require("../../public/src/shared/heatRules");
const UniversalPower = require("../../public/src/shared/universalPower");

const perf = () => global.__mfaDataSupportPerf || null;
function bump(name) {
  const counters = perf();
  if (counters) counters[name] = (counters[name] || 0) + 1;
}

function isAlive(ship, index) {
  return (ship?.componentHp?.[index] ?? 1) > 0;
}

function isOperational(ship, index) {
  return isAlive(ship, index) && ship?.componentPowerState?.[index] !== 0;
}

function wakeHeatForRadiatorPowerChange(ship, previousPower, nextPower) {
  const runtime = ship?._thermalRuntime;
  if (!runtime || runtime.heatBearingComponents.length === 0) return;
  const previousEntries = previousPower?.byComponentIndex || [];
  const nextEntries = nextPower?.byComponentIndex || [];
  for (const index of runtime.topology.radiatorIndices || []) {
    const previous = Number(previousEntries[index]?.operationalMultiplier);
    const next = Number(nextEntries[index]?.operationalMultiplier);
    if ((Number.isFinite(previous) ? previous : 1) !== (Number.isFinite(next) ? next : 1)
      || previousEntries[index]?.state !== nextEntries[index]?.state) {
      require("./heat").wakeHeatRuntime?.(ship);
      return;
    }
  }
}

function summarizePower(entries) {
  const consumers = entries.filter((entry) => entry.role === "consumer");
  if (consumers.some((entry) => entry.state === "unpowered")) return "unpowered";
  if (consumers.some((entry) => entry.state === "underpowered")) return "underpowered";
  return "powered";
}

function storageChargeForShip(ship) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  if (!Array.isArray(ship.componentStorageCharge) || ship.componentStorageCharge.length !== design.length) {
    ship.componentStorageCharge = design.map((module) => {
      const part = PARTS[module?.type] || {};
      return UniversalPower.storageCapacityForPart(part);
    });
  }
  for (let index = 0; index < design.length; index += 1) {
    const part = PARTS[design[index]?.type] || {};
    if (UniversalPower.powerRoleForPart(part) !== "storage") continue;
    const capacity = UniversalPower.storageCapacityForPart(part);
    const current = Number(ship.componentStorageCharge[index]);
    if (!Number.isFinite(current)) ship.componentStorageCharge[index] = capacity;
    else ship.componentStorageCharge[index] = Math.max(0, Math.min(capacity, current));
  }
  return ship.componentStorageCharge;
}

function liveGeneratorOutput(ship, index, module, part) {
  if (!isAlive(ship, index) || !isOperational(ship, index)) return 0;
  const state = ship.componentHeatState?.[index] ?? HeatRules.STATE.NORMAL;
  return Math.max(0, Number(part.powerGeneration) || 0) * HeatRules.activeOutputForState(state);
}

function liveGeneratorState(ship, index, module, part) {
  if ((ship.componentHeatState?.[index] ?? HeatRules.STATE.NORMAL) === HeatRules.STATE.OVERHEATED) return "overheated";
  return "source";
}

function liveGeneratorReductionReasons(ship, index, module, part) {
  if (!isAlive(ship, index)) return ["destroyed-component"];
  if (!isOperational(ship, index)) return ["disabled-component"];
  const state = ship.componentHeatState?.[index] ?? HeatRules.STATE.NORMAL;
  if (state === HeatRules.STATE.OVERHEATED) return ["thermal-penalty"];
  if (HeatRules.activeOutputForState(state) < 1) return ["thermal-derating"];
  return [];
}

function operationalSignature(entries) {
  return entries.map((entry) => [
    entry.state,
    entry.role,
    entry.requestedMw,
    entry.activeDemandMw,
    entry.allocatedMw,
    entry.operationalMultiplier,
    entry.generationAvailableMw
  ].join(":")).join("|");
}

function applyShipPowerAllocation(ship, options = {}) {
  const design = Array.isArray(ship?.design) ? ship.design : [];
  const storageCharge = storageChargeForShip(ship);
  const result = UniversalPower.calculateUniversalPower(design, PARTS, {
    isAlive: (index) => isAlive(ship, index),
    isEnabled: (index) => isOperational(ship, index),
    sourceOutputByIndex: (index, module, part) => liveGeneratorOutput(ship, index, module, part),
    sourceStateByIndex: (index, module, part) => liveGeneratorState(ship, index, module, part),
    sourceGenerationReductionReasonsByIndex: (index, module, part) => liveGeneratorReductionReasons(ship, index, module, part),
    demandByIndex: options.demandByIndex ?? ship._activityDemandByIndex,
    componentStorageChargeByIndex: storageCharge,
    elapsedSeconds: options.elapsedSeconds,
    availabilitySeconds: options.availabilitySeconds,
    advanceStorage: options.advanceStorage
  });

  if (options.advanceStorage && options.elapsedSeconds > 0) {
    for (const [index, charge] of result.storageCharges.entries()) {
      if (charge === undefined) continue;
      storageCharge[index] = charge;
      const dischargeHeat = result.byComponentIndex[index]?.storageDetails?.dischargeHeat || 0;
      if (dischargeHeat > 0) require("./heat").addComponentHeat(ship, index, dischargeHeat);
    }
  }

  const byComponentIndex = result.byComponentIndex;
  const powerSignature = byComponentIndex.map((entry, index) => [
    entry.state,
    entry.role,
    entry.requestedMw,
    entry.activeDemandMw,
    entry.allocatedMw,
    entry.operationalMultiplier,
    entry.generationAvailableMw,
    storageCharge[index]
  ].join(":")) .join("|");
  if (ship._powerStateSignature !== powerSignature) {
    ship._powerStateSignature = powerSignature;
    ship.powerRevision = (ship.powerRevision || 0) + 1;
    ship.powerFlowRevision = ship.powerRevision;
    ship.dirtyPower = true;
  }

  const previousPower = ship.componentPower;
  ship.componentPower = { byComponentIndex };
  wakeHeatForRadiatorPowerChange(ship, previousPower, ship.componentPower);
  ship.powerAnalysis = result;
  ship.powerStatus = summarizePower(byComponentIndex);
  ship.powerThermal = undefined;
  ship.livePowerRatio = result.summary.powerRatio;
  if (!options.skipRuntimeStats && ship.alive !== false) require("./componentHealth").recalcEffectiveStats(ship);
  else if (ship.alive === false) { ship.maxShield = 0; ship.shield = 0; }
  return ship.componentPower;
}

function refreshShipPowerState(ship, reason = "component-boundary", options = {}) {
  applyShipPowerAllocation(ship, options);
  if (!options.skipDataRefresh) require("./componentData").rebuildShipDataLinks(ship, reason);
  return ship.componentPower;
}

function initializeComponentPower(ship) {
  ship.componentStorageCharge = (ship.design || []).map((module) => {
    const part = PARTS[module?.type] || {};
    return Number(part.energyCapacity ?? part.energyStorage) || 0;
  });
  return refreshShipPowerState(ship, "initialization", { skipRuntimeStats: true });
}

function reallocateShipPower(ship, reason = "component-state", options = {}) {
  applyShipPowerAllocation(ship, options);
  if (!options.skipDataRefresh) require("./componentData").refreshShipDataAllocation(ship, reason);
  return ship.componentPower;
}

function updateShipPower(ship, elapsedSeconds, reason = "simulation-tick") {
  if (!(Number(elapsedSeconds) > 0)) return ship?.componentPower;
  const hasStorage = (ship?.design || []).some((module) => UniversalPower.powerRoleForPart(PARTS[module?.type] || {}) === "storage");
  if (!hasStorage) return ship?.componentPower;
  const before = ship._powerOperationalSignature || operationalSignature(ship.componentPower?.byComponentIndex || []);
  applyShipPowerAllocation(ship, {
    elapsedSeconds,
    availabilitySeconds: elapsedSeconds,
    advanceStorage: true,
    skipRuntimeStats: true,
    skipDataRefresh: true
  });
  const after = operationalSignature(ship.componentPower?.byComponentIndex || []);
  ship._powerOperationalSignature = after;
  if (before !== after) require("./componentData").refreshShipDataAllocation(ship, reason);
  return ship.componentPower;
}

function getComponentPowerMultiplier(ship, componentIndex) {
  if (!isAlive(ship, componentIndex) || ship?.componentPowerState?.[componentIndex] === 0) return 0;
  const value = ship?.componentPower?.byComponentIndex?.[componentIndex]?.operationalMultiplier;
  return clampNumber(Number.isFinite(value) ? value : 1, 0, 1);
}

function effectiveLiveSourceGeneration(ship, index) {
  const module = ship?.design?.[index];
  const part = PARTS[module?.type] || {};
  return liveGeneratorOutput(ship, index, module, part);
}

function effectiveShieldCapacityContributions(ship) {
  return ShieldRules.calculateShieldCapacityContributions(ship.design || [], PARTS, {
    isLive: (index) => isOperational(ship, index)
  });
}

function calculateEffectiveShieldStats(ship) {
  const HeatRules = require("../../public/src/shared/heatRules");
  const stats = ShieldRules.calculateShieldStats(ship.design || [], PARTS, {
    isLive: (index) => isOperational(ship, index),
    powerMultiplier: (index) => getComponentPowerMultiplier(ship, index),
    heatMultiplier: (index, module, part) => (Number(part.shieldRegen) || 0) > 0
      ? HeatRules.activeOutputForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL)
      : 1
  });
  const shieldAura = getCommandAuraMultiplier(ship, "shieldRegenMultiplier");
  stats.recharge *= shieldAura;
  stats.regeneration = stats.recharge;
  if (Array.isArray(stats.regenerationContributions)) {
    stats.regenerationContributions = stats.regenerationContributions.map((contribution) => ({
      ...contribution,
      rate: contribution.rate * shieldAura,
      effectiveRate: contribution.effectiveRate * shieldAura
    }));
  }
  Object.freeze(stats);
  return stats;
}

let shieldCacheVerification = false;
function __setShieldCacheVerification(value) { shieldCacheVerification = Boolean(value); }

function shieldCacheMatches(ship, cache) {
  return cache
    && cache.powerRevision === (ship.powerRevision || 0)
    && cache.componentAliveRevision === (ship.componentAliveRevision || 0)
    && cache.heatStateRevision === (ship.heatStateRevision || 0)
    && cache.designRevision === (ship.designRevision || 1)
    && cache.auraMultiplier === getCommandAuraMultiplier(ship, "shieldRegenMultiplier");
}

function effectiveShieldStats(ship, room = null) {
  const cache = ship?._shieldStatsCache;
  if (shieldCacheMatches(ship, cache)) {
    if (room) require("./roomTelemetry").bump(room, "shieldDerivedStatCacheHits");
    if (shieldCacheVerification && room) {
      const fresh = calculateEffectiveShieldStats(ship);
      if (fresh.capacity !== cache.stats.capacity || fresh.recharge !== cache.stats.recharge) {
        require("./roomTelemetry").bump(room, "shieldDerivedStatVerificationFailures");
      }
    }
    return cache.stats;
  }
  if (room) {
    require("./roomTelemetry").bump(room, "shieldDerivedStatCacheMisses");
    require("./roomTelemetry").bump(room, "shieldDerivedStatCalculations");
  }
  const stats = calculateEffectiveShieldStats(ship);
  if (ship) {
    ship._shieldStatsCache = {
      powerRevision: ship.powerRevision || 0,
      componentAliveRevision: ship.componentAliveRevision || 0,
      heatStateRevision: ship.heatStateRevision || 0,
      designRevision: ship.designRevision || 1,
      auraMultiplier: getCommandAuraMultiplier(ship, "shieldRegenMultiplier"),
      stats
    };
  }
  return stats;
}

module.exports = {
  initializeComponentPower,
  refreshShipPowerState,
  reallocateShipPower,
  updateShipPower,
  applyShipPowerAllocation,
  getComponentPowerMultiplier,
  effectiveLiveSourceGeneration,
  effectiveShieldStats,
  __setShieldCacheVerification,
  effectiveShieldCapacityContributions
};
