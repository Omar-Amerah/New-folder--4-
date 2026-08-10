// Shared ship-wide Power rules.
//
// Power is one ship-wide pool: live generator output and, when necessary,
// available battery discharge supply the active component demand. There is no
// topology, priority policy, cable capacity, or protection state in this model.

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, numberOr(value, min)));
}

function indexed(value, index, fallback) {
  const result = typeof value === "function"
    ? value(index)
    : Array.isArray(value)
      ? value[index]
      : value && typeof value === "object"
        ? value[index]
        : undefined;
  return result === undefined ? fallback : result;
}

function partFor(parts, type) {
  return parts?.[type] || parts?.frame || {};
}

function sumSorted(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  let total = 0;
  for (const value of sorted) total += value;
  return total;
}

function allocateStorageRate(entries, requestedMw, rateKey, availableRateOf) {
  const candidates = [];
  for (const entry of entries) {
    entry[rateKey] = 0;
    if (entry.role !== "storage" || !entry.alive || !entry.enabled) continue;
    const availableMw = Math.max(0, numberOr(availableRateOf(entry), 0));
    if (availableMw > 0) candidates.push({ entry, availableMw });
  }

  const totalAvailableMw = sumSorted(candidates.map(({ availableMw }) => availableMw));
  const requested = Math.max(0, numberOr(requestedMw, 0));
  const allocationScale = totalAvailableMw > 0
    ? Math.min(1, requested / totalAvailableMw)
    : 0;
  for (const { entry, availableMw } of candidates) {
    entry[rateKey] = availableMw * allocationScale;
  }
  return Math.min(requested, totalAvailableMw);
}

export function storageCapacityForPart(part = {}) {
  return Math.max(0, numberOr(part.energyCapacity ?? part.energyStorage, 0));
}

export function isPowerStoragePart(part = {}) {
  return numberOr(part.powerGeneration, 0) <= 0
    && (storageCapacityForPart(part) > 0 || numberOr(part.maxDischargeRate, 0) > 0);
}

export function powerRoleForPart(part = {}) {
  if (numberOr(part.powerGeneration, 0) > 0) return "source";
  if (isPowerStoragePart(part)) return "storage";
  if (numberOr(part.powerUse, 0) > 0) return "consumer";
  return "passive";
}

/**
 * Calculate the universal Power pool for a design.
 *
 * `sourceOutputByIndex` is used by the server to provide Heat-adjusted live
 * generator output. `demandByIndex` is used by the thermal designer for its
 * scenario activity levels. Storage starts full unless a charge array is
 * supplied. Storage charge is mutated only when `advanceStorage` is true.
 */
export function calculateUniversalPower(design = [], parts = {}, options = {}) {
  const modules = Array.isArray(design) ? design : [];
  const aliveOf = typeof options.isAlive === "function" ? options.isAlive : () => true;
  const enabledOf = typeof options.isEnabled === "function" ? options.isEnabled : () => true;
  const sourceOutputOf = options.sourceOutputByIndex;
  const sourceStateOf = options.sourceStateByIndex;
  const sourceReasonsOf = options.sourceGenerationReductionReasonsByIndex;
  const demandOverride = options.demandByIndex ?? options.activityDemandByIndex;
  const chargeInput = options.componentStorageChargeByIndex ?? options.storageChargeByIndex;
  const elapsedSeconds = Math.max(0, numberOr(options.elapsedSeconds, 0));
  const availabilitySeconds = Math.max(0.001, numberOr(options.availabilitySeconds, elapsedSeconds > 0 ? elapsedSeconds : 1));
  const advanceStorage = options.advanceStorage === true && elapsedSeconds > 0;

  const entries = modules.map((module, index) => {
    const part = partFor(parts, module?.type);
    const role = powerRoleForPart(part);
    const alive = Boolean(aliveOf(index, module, part));
    const enabled = Boolean(enabledOf(index, module, part));
    const requestedMw = Math.max(0, numberOr(indexed(demandOverride, index, part.powerUse), 0));
    const ratedGenerationMw = Math.max(0, numberOr(part.powerGeneration, 0));
    const storageCapacityMw = storageCapacityForPart(part);
    const initialChargeMj = role === "storage"
      ? clamp(indexed(chargeInput, index, storageCapacityMw), 0, storageCapacityMw)
      : 0;
    let sourceOutputMw = 0;
    if (role === "source" && alive && enabled) {
      const supplied = typeof sourceOutputOf === "function"
        ? sourceOutputOf(index, module, part)
        : indexed(sourceOutputOf, index, ratedGenerationMw);
      sourceOutputMw = clamp(supplied, 0, ratedGenerationMw);
    }
    return {
      componentIndex: index,
      module,
      part,
      role,
      alive,
      enabled,
      requestedMw,
      activeDemandMw: role === "consumer" && alive && enabled ? requestedMw : 0,
      ratedGenerationMw,
      sourceOutputMw,
      storageCapacityMw,
      currentChargeMj: initialChargeMj,
      maxChargeRateMw: Math.max(0, numberOr(part.maxChargeRate, 0)),
      maxDischargeRateMw: Math.max(0, numberOr(part.maxDischargeRate, 0)),
      chargeEfficiency: clamp(numberOr(part.chargeEfficiency, 1), 0, 1),
      dischargeEfficiency: clamp(numberOr(part.dischargeEfficiency, 1), 0.0001, 1),
      dischargeHeatAtMax: Math.max(0, numberOr(part.dischargeHeatAtMax ?? part.dischargeHeat, 0)),
      sourceState: typeof sourceStateOf === "function" ? sourceStateOf(index, module, part) : indexed(sourceStateOf, index, null),
      sourceReasons: typeof sourceReasonsOf === "function" ? sourceReasonsOf(index, module, part) : indexed(sourceReasonsOf, index, null)
    };
  });

  const demandMw = entries.reduce((sum, entry) => sum + entry.activeDemandMw, 0);
  const generatorOutputMw = entries.reduce((sum, entry) => sum + (entry.role === "source" ? entry.sourceOutputMw : 0), 0);
  let remainingDeficitMw = Math.max(0, demandMw - generatorOutputMw);

  // A shortage draws proportionally from every available storage component.
  // Each component supplies the same fraction of its available rate, so the
  // component-array order cannot become a hidden priority.
  const storageDischargeMw = allocateStorageRate(
    entries,
    remainingDeficitMw,
    "dischargeRateMw",
    (entry) => {
      const chargeLimitedMw = entry.currentChargeMj * entry.dischargeEfficiency / availabilitySeconds;
      return Math.min(entry.maxDischargeRateMw, Math.max(0, chargeLimitedMw));
    }
  );

  const availableGenerationMw = generatorOutputMw + storageDischargeMw;
  const powerRatio = demandMw > 0 ? clamp(availableGenerationMw / demandMw, 0, 1) : 1;
  let allocatedMw = 0;
  for (const entry of entries) {
    entry.allocatedMw = entry.activeDemandMw * powerRatio;
    entry.unmetMw = Math.max(0, entry.activeDemandMw - entry.allocatedMw);
    allocatedMw += entry.allocatedMw;
  }

  // Spare generator output charges storage after active demand is met. A
  // battery never discharges and charges in the same solve. Charging uses the
  // same proportional allocation rule as discharge.
  const remainingChargeMw = Math.max(0, generatorOutputMw - demandMw);
  const storageChargingMw = allocateStorageRate(
    entries,
    remainingChargeMw,
    "chargeRateMw",
    (entry) => {
      const roomMj = Math.max(0, entry.storageCapacityMw - entry.currentChargeMj);
      return entry.chargeEfficiency > 0
        ? Math.min(entry.maxChargeRateMw, roomMj / (entry.chargeEfficiency * availabilitySeconds))
        : 0;
    }
  );

  const generatorUsedForDemandMw = Math.min(generatorOutputMw, allocatedMw);
  const generatorUsedMw = generatorUsedForDemandMw + storageChargingMw;
  const storageCharges = [];
  const sourceConsumerShare = generatorOutputMw > 0 ? generatorUsedMw / generatorOutputMw : 0;

  for (const entry of entries) {
    const chargeRateMw = entry.chargeRateMw || 0;
    const dischargeRateMw = entry.dischargeRateMw || 0;
    const chargeDeltaMj = chargeRateMw * elapsedSeconds * entry.chargeEfficiency;
    const dischargeDeltaMj = entry.dischargeEfficiency > 0
      ? dischargeRateMw * elapsedSeconds / entry.dischargeEfficiency
      : 0;
    const nextChargeMj = advanceStorage
      ? clamp(entry.currentChargeMj + chargeDeltaMj - dischargeDeltaMj, 0, entry.storageCapacityMw)
      : entry.currentChargeMj;
    if (entry.role === "storage") storageCharges[entry.componentIndex] = nextChargeMj;

    if (entry.role === "source") {
      entry.generationUsedMw = entry.sourceOutputMw * sourceConsumerShare;
    } else if (entry.role === "storage") {
      entry.generationUsedMw = dischargeRateMw;
    } else {
      entry.generationUsedMw = 0;
    }
    entry.storageDetails = entry.role === "storage" ? {
      currentChargeMj: nextChargeMj,
      maxChargeMj: entry.storageCapacityMw,
      chargeRateMw,
      dischargeRateMw,
      chargePercentage: entry.storageCapacityMw > 0 ? nextChargeMj / entry.storageCapacityMw * 100 : 0,
      estimatedRuntimeSeconds: dischargeRateMw > 0 ? nextChargeMj / dischargeRateMw : null,
      dischargeHeat: entry.maxDischargeRateMw > 0
        ? entry.dischargeHeatAtMax * (dischargeRateMw / entry.maxDischargeRateMw) * elapsedSeconds
        : 0,
      state: !entry.alive ? "destroyed"
        : !entry.enabled ? "unpowered"
          : dischargeRateMw > 0 ? "discharging"
            : chargeRateMw > 0 ? "charging"
              : nextChargeMj >= entry.storageCapacityMw - 0.001 ? "full"
                : nextChargeMj <= 0.001 ? "empty" : "idle"
    } : undefined;
  }

  const byComponentIndex = entries.map((entry) => {
    const operationalMultiplier = entry.role === "consumer"
      ? (entry.alive && entry.enabled ? powerRatio : 0)
      : (entry.alive && entry.enabled ? 1 : 0);
    entry.powerRatio = operationalMultiplier;
    let state = "passive";
    if (!entry.alive) state = "destroyed";
    else if (!entry.enabled) state = "unpowered";
    else if (entry.role === "source") state = entry.sourceState || "source";
    else if (entry.role === "storage") state = entry.storageDetails?.state || "storage";
    else if (entry.role === "consumer") {
      state = entry.powerRatio <= 0 ? "unpowered" : entry.powerRatio < 1 ? "underpowered" : "powered";
    }

    let generationReductionReasons = Array.isArray(entry.sourceReasons) ? [...entry.sourceReasons] : [];
    if (entry.role === "source") {
      if (!entry.alive && !generationReductionReasons.includes("destroyed-component")) generationReductionReasons.push("destroyed-component");
      else if (!entry.enabled && !generationReductionReasons.includes("disabled-component")) generationReductionReasons.push("disabled-component");
      else if (entry.sourceOutputMw + 0.0005 < entry.ratedGenerationMw && !generationReductionReasons.length) generationReductionReasons.push("reduced-generator-output");
    }

    return {
      componentIndex: entry.componentIndex,
      state,
      availableEfficiency: operationalMultiplier,
      operationalMultiplier,
      role: entry.role,
      powerCategory: entry.part.powerCategory || null,
      requestedMw: entry.requestedMw,
      activeDemandMw: entry.activeDemandMw,
      allocatedMw: entry.allocatedMw || 0,
      unmetMw: entry.unmetMw || 0,
      generationAvailableMw: entry.role === "source" ? entry.sourceOutputMw : entry.role === "storage" ? (entry.dischargeRateMw || 0) : 0,
      generationUsedMw: entry.generationUsedMw || 0,
      generationReductionReasons,
      storageDetails: entry.storageDetails
    };
  });

  return {
    byComponentIndex,
    storageCharges,
    summary: {
      mode: "universal",
      availableGenerationMw,
      totalGenerationMw: generatorOutputMw,
      generatorOutputMw,
      storageDischargeMw,
      storageChargingMw,
      demandMw,
      requestedDemandMw: demandMw,
      allocatedMw,
      deliveredDemandMw: allocatedMw,
      unmetMw: Math.max(0, demandMw - allocatedMw),
      unmetDemandMw: Math.max(0, demandMw - allocatedMw),
      spareGenerationMw: Math.max(0, generatorOutputMw - demandMw - storageChargingMw),
      powerRatio,
      usedGenerationMw: generatorUsedMw + storageDischargeMw
    }
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    storageCapacityForPart,
    isPowerStoragePart,
    powerRoleForPart,
    calculateUniversalPower
  };
}
