// Section 7G — runtime Power overload protection.
//
// Event-driven, runtime-only overload accumulation over the solved Power
// section flows, plus compact brownout/load-shedding diagnostics.
//
// Overload stress is diagnostic only: it drives the section protection state a
// player sees. Nothing opens a circuit in response to it, so protection never
// changes topology or allocation. The shared
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

// Runtime-only protection state container, keyed by stable section id
// (physical cables keep their saved section ids).
function protectionState(ship) {
  if (!ship._powerProtection) ship._powerProtection = { sections: new Map() };
  return ship._powerProtection;
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
    if (!flow || flow.internal) continue;
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
    record.kind = "power-section";
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
  // accumulating; removed sections and topology rebuilds that dropped a section
  // all reset here. Restoring the host later starts from a safe zero-stress
  // runtime state.
  for (const id of [...state.sections.keys()]) if (!seen.has(id)) state.sections.delete(id);
}

function updateShipPowerProtection(ship, deltaSeconds) {
  if (!ship || ship.alive === false || !Array.isArray(ship.design) || !ship.design.length) return;
  const dt = Number(deltaSeconds);
  if (!(Number.isFinite(dt) && dt > 0)) return;
  const config = protectionConfig();
  bump("powerProtectionUpdateCount");
  const state = protectionState(ship);

  // Cable sections accumulate and recover overload stress every update. With
  // Switchgear removed there is no device that can open a circuit, so stress is
  // now purely diagnostic: it drives the section protection state a player sees
  // and never changes topology, so no lifecycle rebuild is triggered here.
  accumulateSectionStress(ship, state, dt, config);

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

  const aboveSustainedSectionCount = sanitizeNumber(summary.aboveSustainedSections, 0);
  const atPeakSectionCount = sanitizeNumber(summary.atPeakSections, 0);

  const overall = PowerProtectionRules.shipProtectionState({
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
    diagnostics.partialConsumerCount,
    diagnostics.shedConsumerCount,
    sectionSignature,
    "#",
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
  ship._powerProtection = { sections: new Map() };
  ship._powerProtectionSignature = undefined;
  ship.powerProtectionDiagnostics = null;
}

// ---------------------------------------------------------------------------
// Compact snapshot block. Only stressed/non-normal section records are sent;
// unchanged blocks are revision-guarded by the caller and compact deltas
// preserve the previous block when omitted. Every number is finite and never
// NaN, Infinity or negative zero.
// ---------------------------------------------------------------------------

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
    partialConsumerCount: sanitizeNumber(diagnostics.partialConsumerCount, 0),
    shedConsumerCount: sanitizeNumber(diagnostics.shedConsumerCount, 0),
    sections,
  };
}

module.exports = {
  updateShipPowerProtection,
  refreshShipPowerProtectionDiagnostics,
  resetShipPowerProtection,
  buildPowerProtectionSnapshot,
};
