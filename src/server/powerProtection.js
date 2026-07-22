// Section 7G — runtime Power overload protection.
//
// Event-driven, runtime-only overload accumulation over the solved Power
// section flows (physical cable sections plus Switchgear synthetic internal
// edges), deterministic Switchgear overload trips with cooldown and bounded
// retry, and compact brownout/load-shedding diagnostics. The shared
// PowerFlowRules solver remains the sole allocation authority and
// PowerCableThermalRules remains the sole dynamic cable-Heat authority; this
// module only reads their results. Nothing here is ever persisted into
// Blueprints, saved designs, loadouts or multiplayer design payloads.

const PowerProtectionRules = require("../../public/src/shared/powerProtectionRules");
const PowerAllocationRules = require("../../public/src/shared/powerAllocationRules");

const { sanitizeNumber, clamp01 } = PowerProtectionRules;

const perf = () => global.__mfaDataSupportPerf || null;
function bump(name) { const p = perf(); if (p) p[name] = (p[name] || 0) + 1; }

function componentPower() { return require("./componentPower"); }
function protectionConfig() { return componentPower().powerProtectionConfig(); }

// Runtime-only protection state container. Keyed by stable section id
// (physical cables keep their saved section ids; Switchgear internal edges use
// their stable synthetic "switchgear:<index>:A-B" ids) and by Switchgear
// component index for trip/cooldown/retry bookkeeping.
function protectionState(ship) {
  if (!ship._powerProtection) ship._powerProtection = { sections: new Map(), switchgear: new Map() };
  return ship._powerProtection;
}

function switchgearRuntime(state, componentIndex) {
  let runtime = state.switchgear.get(componentIndex);
  if (!runtime) {
    runtime = {
      componentIndex,
      cooldownRemaining: 0,
      retryCount: 0,
      retryEligible: false,
      lastRetryReason: null,
      lastTripReason: null,
      lastTripFlowMw: 0,
      lastTripUtilisation: 0,
      lastTripStress: 0
    };
    state.switchgear.set(componentIndex, runtime);
  }
  return runtime;
}

function formatMw(value) { return `${(Math.round(sanitizeNumber(value, 0) * 100) / 100)} MW`; }

// ---------------------------------------------------------------------------
// Overload accumulation — O(number of current Power edges). No topology
// rediscovery, no hosted-cell mapping, no Blueprint normalisation, no solve.
// ---------------------------------------------------------------------------
function accumulateSectionStress(ship, state, deltaSeconds, config) {
  const flows = ship.powerFlow && Array.isArray(ship.powerFlow.sectionFlows) ? ship.powerFlow.sectionFlows : [];
  const seen = new Set();
  for (const flow of flows) {
    if (!flow) continue;
    const id = String(flow.sectionId);
    seen.add(id);
    let record = state.sections.get(id);
    if (!record) {
      record = { sectionId: id, stress: 0, secondsAboveSustained: 0 };
      state.sections.set(id, record);
    }
    const absoluteFlowMw = flow.absoluteFlowMw != null ? Math.abs(sanitizeNumber(flow.absoluteFlowMw, 0)) : Math.abs(sanitizeNumber(flow.signedFlowMw, 0));
    const edge = {
      absoluteFlowMw,
      sustainedCapacityMw: sanitizeNumber(flow.sustainedCapacityMw, 0),
      peakCapacityMw: sanitizeNumber(flow.peakCapacityMw, 0)
    };
    const advanced = PowerProtectionRules.advanceStress(record, edge, deltaSeconds, config);
    record.stress = advanced.stress;
    record.secondsAboveSustained = advanced.secondsAboveSustained;
    record.kind = id.startsWith("switchgear:") ? "switchgear" : "power-section";
    record.tier = flow.tier || "standard";
    record.signedFlowMw = sanitizeNumber(flow.signedFlowMw, 0);
    record.absoluteFlowMw = absoluteFlowMw;
    record.sustainedCapacityMw = edge.sustainedCapacityMw;
    record.peakCapacityMw = edge.peakCapacityMw;
    record.sustainedUtilisation = sanitizeNumber(flow.sustainedUtilisation, 0);
    record.peakUtilisation = sanitizeNumber(flow.peakUtilisation, 0);
    record.overloadRatio = PowerProtectionRules.normalisedOverload(absoluteFlowMw, edge.sustainedCapacityMw, edge.peakCapacityMw);
    record.operational = flow.operational !== false;
    record.state = PowerProtectionRules.protectionStateFor({ ...record }, config);
    record.flowRevision = ship.powerFlowRevision || 0;
  }
  // Prune records whose stable section id is no longer part of the current
  // operational topology: disabled hosted sections carry zero flow and stop
  // accumulating; removed sections, destroyed Switchgear internal edges and
  // topology rebuilds that dropped a section all reset here. Restoring the
  // host later starts from a safe zero-stress runtime state.
  for (const id of [...state.sections.keys()]) if (!seen.has(id)) state.sections.delete(id);
}

// ---------------------------------------------------------------------------
// Switchgear overload trips.
// ---------------------------------------------------------------------------
function collectOverloadTrips(ship, state, config) {
  const trips = [];
  for (const record of Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : []) {
    // Only an intact, currently conducting Switchgear may overload-trip:
    // Closed or conducting Automatic. Open never conducts, already Tripped
    // cannot trip again, Destroyed remains Destroyed.
    if (!record.conducts) continue;
    const sectionRecord = state.sections.get(record.internalEdgeId);
    if (!sectionRecord) continue;
    if (sectionRecord.stress >= config.tripStressThreshold - 1e-9) trips.push({ record, sectionRecord });
  }
  trips.sort((a, b) => {
    const ka = componentPower().tieStableKey(a.record); const kb = componentPower().tieStableKey(b.record);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return trips;
}

function applyTripMarkers(ship, state, trips, config) {
  if (!trips.length) return;
  if (!ship._switchgearTrips) ship._switchgearTrips = {};
  for (const { record, sectionRecord } of trips) {
    const reason = `overload trip: ${formatMw(sectionRecord.absoluteFlowMw)} on ${record.ratingTier} internal edge`;
    // Runtime-only trip: the saved mode and rating and the Blueprint wiring
    // are never mutated. The batched rebuild below re-solves without this
    // internal edge, so its transfer becomes zero.
    ship._switchgearTrips[record.componentIndex] = reason;
    const runtime = switchgearRuntime(state, record.componentIndex);
    runtime.cooldownRemaining = config.tripCooldownSeconds;
    runtime.retryCount = 0;
    runtime.retryEligible = false;
    runtime.lastRetryReason = null;
    runtime.lastTripReason = reason;
    runtime.lastTripFlowMw = sanitizeNumber(sectionRecord.absoluteFlowMw, 0);
    runtime.lastTripUtilisation = sanitizeNumber(sectionRecord.peakUtilisation, 0);
    runtime.lastTripStress = clamp01(sectionRecord.stress);
    runtime.lastTripTier = record.ratingTier;
    // Reset the active internal-edge overload stress at the moment of trip.
    state.sections.delete(record.internalEdgeId);
  }
}

// Destroyed Switchgear never retries and repairing one begins from zero
// runtime protection state: clear its trip marker and runtime record while it
// is destroyed (its runtime state stays "destroyed" through the existing
// lifecycle either way).
function pruneDestroyedSwitchgear(ship, state) {
  for (const record of Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : []) {
    if ((ship.componentHp?.[record.componentIndex] ?? 1) > 0) continue;
    state.switchgear.delete(record.componentIndex);
    if (ship._switchgearTrips) delete ship._switchgearTrips[record.componentIndex];
  }
}

// ---------------------------------------------------------------------------
// Cooldown and deterministic retry. Cooldown-only ticks perform no Power
// solve and no topology work; only actual retry decisions do.
// ---------------------------------------------------------------------------
function updateCooldownsAndRetries(ship, state, freshTripIndices, deltaSeconds, config) {
  const cleared = [];
  const automaticRetried = [];
  const closedCandidates = [];
  const recordByIndex = new Map((Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : []).map((record) => [record.componentIndex, record]));
  for (const [index, runtime] of [...state.switchgear.entries()].sort((a, b) => a[0] - b[0])) {
    if (freshTripIndices.has(index)) continue; // tripped this update: cooldown starts next tick
    const tripped = Boolean(ship._switchgearTrips && Object.prototype.hasOwnProperty.call(ship._switchgearTrips, index));
    if (!tripped) { runtime.retryEligible = false; runtime.cooldownRemaining = 0; continue; }
    const record = recordByIndex.get(index);
    if (!record) continue;
    if ((ship.componentHp?.[index] ?? 1) <= 0) continue; // destroyed: pruned separately, never retries
    runtime.cooldownRemaining = Math.max(0, sanitizeNumber(runtime.cooldownRemaining, 0) - deltaSeconds);
    if (runtime.cooldownRemaining > 0) { runtime.retryEligible = false; continue; }
    // Cooldown reached zero: a retry evaluation is permitted only for saved
    // Closed or Automatic modes. Open saved mode remains open (no retry).
    if (record.mode === "open") {
      runtime.retryEligible = false;
      runtime.lastRetryReason = "open saved mode remains open";
      continue;
    }
    runtime.retryEligible = true;
    if (record.mode === "automatic") automaticRetried.push(index);
    else closedCandidates.push(record);
  }

  // Saved Automatic: clear the temporary trip lock; the batched rebuild
  // re-evaluates it through the existing Section 7F joint Automatic-tie
  // policy (manual Closed baseline, all six priority categories, donor-side
  // and equal-priority demand protection, stable tie keys). It either returns
  // to Automatic conducting or to normal Automatic non-conducting — never
  // remains labelled Tripped after cooldown plus a safe retry evaluation.
  for (const index of automaticRetried) {
    delete ship._switchgearTrips[index];
    const runtime = state.switchgear.get(index);
    runtime.retryCount += 1;
    runtime.retryEligible = false;
    runtime.cooldownRemaining = 0;
    cleared.push(index);
  }

  if (closedCandidates.length) {
    const decision = evaluateClosedRetries(ship, closedCandidates, config);
    for (const record of closedCandidates) {
      const runtime = state.switchgear.get(record.componentIndex);
      runtime.retryCount += 1;
      runtime.retryEligible = false;
      if (decision.reclose.has(record.componentIndex)) {
        delete ship._switchgearTrips[record.componentIndex];
        runtime.cooldownRemaining = 0;
        runtime.lastRetryReason = "reclosed: projected flow within safe threshold";
        cleared.push(record.componentIndex);
      } else {
        // Failed retry: stay Tripped and schedule the next deterministic
        // retry interval.
        runtime.cooldownRemaining = config.retryIntervalSeconds;
        runtime.lastRetryReason = decision.reasons.get(record.componentIndex) || "no safe reclose candidate";
      }
    }
  }

  return { cleared, automaticRetried };
}

// Joint bounded candidate evaluation for saved-Closed retries. All candidate
// solves go through the existing PowerFlowRules solver; external cable
// capacities stay authoritative because the solver enforces them. Subset
// ordering uses stable topology-derived tie keys, never component indices.
function evaluateClosedRetries(ship, candidates, config) {
  const cp = componentPower();
  const reasons = new Map();
  const reclose = new Set();
  const ordered = candidates.slice().sort((a, b) => {
    const ka = cp.tieStableKey(a); const kb = cp.tieStableKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // Oversized candidate groups fail safely: everything stays tripped and the
  // next retry interval is scheduled. Closing everything is never a fallback.
  if (2 ** ordered.length > config.maxAutomaticRetrySubsets) {
    for (const record of ordered) reasons.set(record.componentIndex, "evaluation bound exceeded");
    return { reclose, reasons };
  }

  const baseInput = cp.buildShipPowerSolveBaseInput(ship);
  const records = cp.liveSwitchgearRecords(ship, new Set());
  // Preserve every currently healthy conducting link in the candidate
  // baseline: manual Closed Switchgear plus currently conducting Automatic
  // ties (from the last authoritative solve), minus anything tripped.
  const baseClosed = new Set();
  for (const record of Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : []) {
    if (record.conducts && !(ship._switchgearTrips && Object.prototype.hasOwnProperty.call(ship._switchgearTrips, record.componentIndex))) {
      baseClosed.add(record.componentIndex);
    }
  }
  const recordsByIndex = new Map(records.map((record) => [record.componentIndex, record]));

  function subsetSafety(subset) {
    bump("powerProtectionRetrySolveCount");
    const result = cp.solveSwitchgearCandidate(baseInput, records, new Set([...baseClosed, ...subset]));
    if (!cp.finiteFlowResult(result)) return { safe: false, reason: "non-finite candidate solve" };
    const flowById = new Map((result.sectionFlows || []).map((flow) => [flow.sectionId, flow]));
    for (const index of subset) {
      const record = recordsByIndex.get(index);
      if (!record) return { safe: false, reason: "no valid topology" };
      const flow = flowById.get(record.internalEdgeId);
      if (!flow) return { safe: false, reason: "no valid topology" };
      const projected = Math.abs(sanitizeNumber(flow.signedFlowMw, 0));
      if (projected > config.safeRecloseSustainedRatio * sanitizeNumber(record.sustainedCapacityMw, 0) + 1e-9) {
        return { safe: false, reason: "projected flow above safe reclose threshold" };
      }
    }
    return { safe: true };
  }

  // Enumerate every non-empty subset; select the largest jointly safe subset
  // and fail safely for the rest. Stable topology keys are the final
  // tie-break so equivalent designs with remapped component indices make
  // identical decisions.
  let best = null;
  for (let mask = 1; mask < 2 ** ordered.length; mask += 1) {
    const subset = [];
    for (let i = 0; i < ordered.length; i += 1) if (mask & (1 << i)) subset.push(ordered[i].componentIndex);
    const safety = subsetSafety(subset);
    if (subset.length === 1) {
      const index = subset[0];
      if (!safety.safe && !reasons.has(index)) reasons.set(index, safety.reason);
    }
    if (!safety.safe) continue;
    const keys = subset.map((index) => cp.tieStableKey(recordsByIndex.get(index))).sort().join("|");
    if (!best || subset.length > best.subset.length || (subset.length === best.subset.length && keys < best.keys)) {
      best = { subset, keys };
    }
  }
  if (best) for (const index of best.subset) reclose.add(index);
  for (const record of ordered) {
    if (!reclose.has(record.componentIndex) && !reasons.has(record.componentIndex)) {
      reasons.set(record.componentIndex, "projected flow above safe reclose threshold");
    }
  }
  return { reclose, reasons };
}

// After the batched rebuild, record what the Section 7F automatic policy
// decided for each retried Automatic Switchgear.
function finalizeAutomaticRetries(ship, state, automaticRetried) {
  if (!automaticRetried.length) return;
  const recordByIndex = new Map((Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : []).map((record) => [record.componentIndex, record]));
  for (const index of automaticRetried) {
    const runtime = state.switchgear.get(index);
    if (!runtime) continue;
    const record = recordByIndex.get(index);
    runtime.lastRetryReason = record && record.automaticClosed
      ? "reclosed by automatic policy"
      : "no safe Automatic transfer";
  }
}

// ---------------------------------------------------------------------------
// The single event-driven runtime protection update. Called from the
// authoritative simulation tick after the current Power flow is available.
// Ordinary accumulation is O(current Power edges); only trip or retry
// connectivity transitions trigger one batched topology/allocation refresh.
// ---------------------------------------------------------------------------
function updateShipPowerProtection(ship, deltaSeconds) {
  if (!ship || ship.alive === false || !Array.isArray(ship.design) || !ship.design.length) return;
  const dt = Number(deltaSeconds);
  if (!(Number.isFinite(dt) && dt > 0)) return;
  const config = protectionConfig();
  bump("powerProtectionUpdateCount");
  const state = protectionState(ship);

  pruneDestroyedSwitchgear(ship, state);
  accumulateSectionStress(ship, state, dt, config);

  const trips = collectOverloadTrips(ship, state, config);
  const freshTripIndices = new Set(trips.map(({ record }) => record.componentIndex));
  applyTripMarkers(ship, state, trips, config);

  const retries = updateCooldownsAndRetries(ship, state, freshTripIndices, dt, config);

  // One lifecycle batch for every connectivity transition this update: one
  // topology/connectivity refresh, one final Power allocation, one Data
  // refresh through the existing lifecycle, one cable-Heat refresh (revision
  // guarded inside the allocation). Never one rebuild per component.
  if (trips.length || retries.cleared.length) {
    if (trips.length) bump("powerProtectionTripBatchCount");
    if (retries.cleared.length) bump("powerProtectionRetryBatchCount");
    componentPower().rebuildShipWiringState(ship, trips.length ? "switchgear-overload-trip" : "switchgear-overload-retry");
    finalizeAutomaticRetries(ship, state, retries.automaticRetried);
  }

  refreshShipPowerProtectionDiagnostics(ship);
}

// ---------------------------------------------------------------------------
// Diagnostics — derived from the existing authoritative solver result only.
// ---------------------------------------------------------------------------
function round3(value) { return sanitizeNumber(Math.round(sanitizeNumber(value, 0) * 1000) / 1000, 0); }
function round2(value) { return sanitizeNumber(Math.round(sanitizeNumber(value, 0) * 100) / 100, 0); }

function sortedSectionRecords(state) {
  return [...state.sections.values()].sort((a, b) => (a.sectionId < b.sectionId ? -1 : a.sectionId > b.sectionId ? 1 : 0));
}

function refreshShipPowerProtectionDiagnostics(ship) {
  if (!ship) return null;
  const config = protectionConfig();
  const state = protectionState(ship);
  const summary = (ship.powerFlow && ship.powerFlow.summary) || {};
  const entries = (ship.componentPower && ship.componentPower.byComponentIndex) || [];

  let partialConsumerCount = 0;
  let shedConsumerCount = 0;
  for (const entry of entries) {
    if (entry.state === "underpowered") partialConsumerCount += 1;
    else if ((entry.state === "unpowered" || entry.state === "disconnected") && sanitizeNumber(entry.requestedMw, 0) > 0) shedConsumerCount += 1;
  }

  const sections = sortedSectionRecords(state);
  let criticalSectionCount = 0;
  let mostStressed = null;
  for (const record of sections) {
    if (config.criticalStressRatio > 0 && record.stress >= config.criticalStressRatio) criticalSectionCount += 1;
    if (record.stress > 0 && (!mostStressed || record.stress > mostStressed.stress)) mostStressed = record;
  }

  const switchRecords = Array.isArray(ship.runtimeSwitchgear) ? ship.runtimeSwitchgear : [];
  const trippedSwitchgearCount = switchRecords.filter((record) => record.state === "tripped").length;
  let nextRetrySeconds = null;
  for (const record of switchRecords) {
    if (record.state !== "tripped") continue;
    const runtime = state.switchgear.get(record.componentIndex);
    if (!runtime) continue;
    const remaining = Math.max(0, sanitizeNumber(runtime.cooldownRemaining, 0));
    if (nextRetrySeconds === null || remaining < nextRetrySeconds) nextRetrySeconds = remaining;
  }

  const aboveSustainedSectionCount = sanitizeNumber(summary.aboveSustainedSections, 0);
  const atPeakSectionCount = sanitizeNumber(summary.atPeakSections, 0);

  const overall = PowerProtectionRules.shipProtectionState({
    trippedSwitchgearCount,
    shedConsumerCount,
    partialConsumerCount,
    overloadedSectionCount: aboveSustainedSectionCount
  });

  const diagnostics = {
    state: overall,
    requestedDemandMw: round2(summary.demandMw),
    deliveredDemandMw: round2(summary.allocatedMw),
    unmetDemandMw: round2(summary.unmetMw),
    spareGenerationMw: round2(summary.spareGenerationMw),
    aboveSustainedSectionCount,
    atPeakSectionCount,
    criticalSectionCount,
    mostStressedSectionId: mostStressed ? mostStressed.sectionId : null,
    mostStressedStress: mostStressed ? round3(mostStressed.stress) : 0,
    trippedSwitchgearCount,
    nextRetrySeconds: nextRetrySeconds === null ? 0 : round3(nextRetrySeconds),
    partialConsumerCount,
    shedConsumerCount
  };
  ship.powerProtectionDiagnostics = diagnostics;

  // Fixed-point signature over everything a player can observe: stress and
  // trip/retry changes must be delivered, unchanged protection state must not
  // spin revisions.
  const sectionSignature = sections
    .filter((record) => record.stress > 0 || record.state !== "normal")
    .map((record) => [
      record.sectionId,
      record.state,
      Math.round(record.stress * 1000),
      Math.round(Math.min(record.secondsAboveSustained, 3600) * 10),
      PowerAllocationRules.mwToPowerUnits(record.absoluteFlowMw || 0)
    ].join(":")).join("|");
  const switchgearSignature = [...state.switchgear.entries()].sort((a, b) => a[0] - b[0])
    .map(([index, runtime]) => [
      index,
      Math.round(Math.max(0, sanitizeNumber(runtime.cooldownRemaining, 0)) * 10),
      runtime.retryCount,
      runtime.retryEligible ? 1 : 0,
      runtime.lastRetryReason || "",
      runtime.lastTripReason || ""
    ].join(":")).join("|");
  const signature = [
    diagnostics.state,
    PowerAllocationRules.mwToPowerUnits(diagnostics.requestedDemandMw),
    PowerAllocationRules.mwToPowerUnits(diagnostics.deliveredDemandMw),
    PowerAllocationRules.mwToPowerUnits(diagnostics.spareGenerationMw),
    diagnostics.aboveSustainedSectionCount,
    diagnostics.atPeakSectionCount,
    diagnostics.criticalSectionCount,
    diagnostics.mostStressedSectionId || "",
    Math.round(diagnostics.mostStressedStress * 1000),
    diagnostics.trippedSwitchgearCount,
    Math.round(diagnostics.nextRetrySeconds * 10),
    diagnostics.partialConsumerCount,
    diagnostics.shedConsumerCount,
    sectionSignature,
    "#",
    switchgearSignature
  ].join("~");
  if (ship._powerProtectionSignature !== signature) {
    ship._powerProtectionSignature = signature;
    ship.powerProtectionRevision = (ship.powerProtectionRevision || 0) + 1;
    ship.dirtyPowerProtection = true;
  }
  return diagnostics;
}

// Spawn / design replacement: deterministic zero-stress runtime state and no
// stale diagnostics.
function resetShipPowerProtection(ship) {
  if (!ship) return;
  ship._powerProtection = { sections: new Map(), switchgear: new Map() };
  ship._powerProtectionSignature = undefined;
  ship.powerProtectionDiagnostics = null;
  // Runtime trip locks are protection state: a spawned or replaced design
  // starts from its saved Switchgear modes, never from stale trips.
  ship._switchgearTrips = null;
}

// ---------------------------------------------------------------------------
// Compact snapshot block. Only stressed/non-normal section records are sent;
// unchanged blocks are revision-guarded by the caller and compact deltas
// preserve the previous block when omitted. Every number is finite and never
// NaN, Infinity or negative zero.
// ---------------------------------------------------------------------------
function switchgearProtectionFields(ship, componentIndex) {
  const runtime = ship && ship._powerProtection ? ship._powerProtection.switchgear.get(componentIndex) : null;
  return {
    overloadStress: round3(clamp01(ship && ship._powerProtection ? (ship._powerProtection.sections.get(`switchgear:${componentIndex}:A-B`) || {}).stress : 0)),
    cooldownRemaining: round3(Math.max(0, sanitizeNumber(runtime && runtime.cooldownRemaining, 0))),
    retryCount: Math.max(0, Math.trunc(sanitizeNumber(runtime && runtime.retryCount, 0))),
    retryEligible: Boolean(runtime && runtime.retryEligible),
    lastRetryReason: (runtime && runtime.lastRetryReason) || null,
    lastTripReason: (runtime && runtime.lastTripReason) || null,
    lastTripFlowMw: round2(runtime && runtime.lastTripFlowMw),
    lastTripUtilisation: round3(runtime && runtime.lastTripUtilisation)
  };
}

function buildPowerProtectionSnapshot(ship) {
  const diagnostics = ship.powerProtectionDiagnostics || refreshShipPowerProtectionDiagnostics(ship) || {};
  const state = protectionState(ship);
  const sections = sortedSectionRecords(state)
    .filter((record) => record.stress > 0 || (record.state && record.state !== "normal"))
    .map((record) => ({
      sectionId: record.sectionId,
      kind: record.kind || "power-section",
      tier: record.tier || "standard",
      signedFlowMw: round2(record.signedFlowMw),
      absoluteFlowMw: round2(record.absoluteFlowMw),
      sustainedCapacityMw: round2(record.sustainedCapacityMw),
      peakCapacityMw: round2(record.peakCapacityMw),
      sustainedUtilisation: round3(record.sustainedUtilisation),
      peakUtilisation: round3(record.peakUtilisation),
      overloadRatio: round3(record.overloadRatio),
      stress: round3(record.stress),
      secondsAboveSustained: round2(record.secondsAboveSustained),
      state: record.state || "normal",
      operational: record.operational !== false
    }));
  const switchgear = [...state.switchgear.keys()].sort((a, b) => a - b)
    .map((componentIndex) => ({ componentIndex, ...switchgearProtectionFields(ship, componentIndex) }));
  return {
    revision: ship.powerProtectionRevision || 0,
    state: diagnostics.state || "normal",
    requestedDemandMw: sanitizeNumber(diagnostics.requestedDemandMw, 0),
    deliveredDemandMw: sanitizeNumber(diagnostics.deliveredDemandMw, 0),
    unmetDemandMw: sanitizeNumber(diagnostics.unmetDemandMw, 0),
    spareGenerationMw: sanitizeNumber(diagnostics.spareGenerationMw, 0),
    aboveSustainedSectionCount: sanitizeNumber(diagnostics.aboveSustainedSectionCount, 0),
    atPeakSectionCount: sanitizeNumber(diagnostics.atPeakSectionCount, 0),
    criticalSectionCount: sanitizeNumber(diagnostics.criticalSectionCount, 0),
    mostStressedSectionId: diagnostics.mostStressedSectionId || null,
    mostStressedStress: sanitizeNumber(diagnostics.mostStressedStress, 0),
    trippedSwitchgearCount: sanitizeNumber(diagnostics.trippedSwitchgearCount, 0),
    nextRetrySeconds: sanitizeNumber(diagnostics.nextRetrySeconds, 0),
    partialConsumerCount: sanitizeNumber(diagnostics.partialConsumerCount, 0),
    shedConsumerCount: sanitizeNumber(diagnostics.shedConsumerCount, 0),
    sections,
    switchgear
  };
}

module.exports = {
  updateShipPowerProtection,
  refreshShipPowerProtectionDiagnostics,
  resetShipPowerProtection,
  buildPowerProtectionSnapshot,
  switchgearProtectionFields
};
