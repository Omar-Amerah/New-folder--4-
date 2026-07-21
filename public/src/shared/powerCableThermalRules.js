(function initPowerCableThermalRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  // The hosted-cell authority is optional: callers may pass a precomputed host
  // map (the runtime reuses its cached one) instead of design/wiring/catalogue.
  const infrastructure = onNode ? require("./wiringInfrastructureRules") : root.WiringInfrastructureRules;
  const rules = factory(infrastructure);
  if (onNode) module.exports = rules;
  root.PowerCableThermalRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makePowerCableThermalRules(WiringInfrastructureRules) {
  "use strict";

  // Section 7D-1 — authoritative runtime Power-cable Heat.
  //
  // Pure, dependency-light rules that turn solved Power-section flow
  // (PowerFlowRules.solvePowerFlow(...).sectionFlows) into dynamic Heat generated
  // by that flow. Heat rises nonlinearly with sustained utilisation and is
  // attributed to the components hosting each Power section's endpoint cells.
  // No server, DOM or UI dependencies; Data wiring produces no dynamic Heat.

  // Lexical (UTF-16), locale-independent id comparison — matches the solver's
  // canonical section ordering without importing the allocation module.
  function compareIds(a, b) {
    const sa = String(a); const sb = String(b);
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
  }
  function sortedUniqueIds(ids) {
    return [...new Set(ids)].sort(compareIds);
  }
  function bySectionIdMap(hostMap) {
    if (!hostMap) return new Map();
    if (hostMap.bySectionId instanceof Map) return hostMap.bySectionId;
    if (hostMap.bySectionId && typeof hostMap.bySectionId === "object") return new Map(Object.entries(hostMap.bySectionId));
    return new Map();
  }

  // Heat/second per hosted cell for one operational Power section. Zero flow is
  // exactly zero; direction is irrelevant (absolute flow); sustained flow yields
  // exactly the tier coefficient. Invalid configuration or sustained capacity is
  // rejected loudly rather than producing NaN/Infinity.
  function cableHeatRateForSection(sectionFlow, tierConfig) {
    const coefficient = Number(tierConfig && tierConfig.cableHeatAtSustainedPerHostedCell);
    const exponent = Number(tierConfig && tierConfig.cableHeatUtilisationExponent);
    if (!Number.isFinite(coefficient) || coefficient < 0) {
      throw new Error("cableHeatAtSustainedPerHostedCell must be a finite number >= 0");
    }
    if (!Number.isFinite(exponent) || exponent <= 1) {
      throw new Error("cableHeatUtilisationExponent must be a finite number > 1");
    }
    const sustained = Number(
      sectionFlow && sectionFlow.sustainedCapacityMw != null
        ? sectionFlow.sustainedCapacityMw
        : tierConfig && tierConfig.sustainedCapacityMw
    );
    if (!Number.isFinite(sustained) || sustained <= 0) {
      throw new Error("sustainedCapacityMw must be a finite number > 0");
    }
    const rawFlow = sectionFlow && sectionFlow.absoluteFlowMw != null ? sectionFlow.absoluteFlowMw : (sectionFlow && sectionFlow.signedFlowMw);
    const absoluteFlow = Math.abs(Number(rawFlow) || 0);
    if (!(absoluteFlow > 0)) return 0;
    const utilisation = absoluteFlow / sustained;
    const rate = coefficient * Math.pow(utilisation, exponent);
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  }

  // Full deterministic cable-Heat analysis. Inputs are never mutated.
  // options: { sectionFlows, powerTiers | infrastructure, hostMap | (design, wiring, catalogue) }
  function analyzePowerCableHeat(options) {
    const opts = options || {};
    const powerTiers = opts.powerTiers || (opts.infrastructure && opts.infrastructure.powerTiers) || {};
    const sectionFlows = Array.isArray(opts.sectionFlows) ? opts.sectionFlows : [];
    let hostMap = opts.hostMap;
    if (!hostMap) {
      if (!WiringInfrastructureRules || typeof WiringInfrastructureRules.mapHostedCells !== "function") {
        throw new Error("analyzePowerCableHeat requires a hostMap or WiringInfrastructureRules");
      }
      hostMap = WiringInfrastructureRules.mapHostedCells(opts.design || [], opts.wiring || {}, opts.catalogue || {}).power;
    }
    const bySectionId = bySectionIdMap(hostMap);

    const componentRate = new Map();
    const componentActive = new Map();
    const componentAbove = new Map();
    const componentPeak = new Map();
    const addTo = (map, index, id) => { (map.get(index) || map.set(index, []).get(index)).push(id); };
    const touch = (index) => { if (!componentRate.has(index)) componentRate.set(index, 0); };

    const sections = [];
    for (const flow of sectionFlows) {
      if (!flow || flow.operational === false) continue;
      const sectionId = flow.sectionId;
      // Fail closed: every operational section — even one currently at zero flow —
      // must have finite flow and exactly two valid hosted endpoints. A malformed
      // physical section must never silently vanish from Heat accounting.
      const signed = Number(flow.signedFlowMw);
      const absolute = flow.absoluteFlowMw != null ? Number(flow.absoluteFlowMw) : Math.abs(signed);
      if (!Number.isFinite(signed) || !Number.isFinite(absolute)) {
        throw new Error(`Power-cable Heat: section ${sectionId} has non-finite flow`);
      }
      const hostEntry = bySectionId.get(sectionId);
      if (!hostEntry) throw new Error(`Power-cable Heat: no host entry for section ${sectionId}`);
      const rawCells = Array.isArray(hostEntry.hostCells) ? hostEntry.hostCells : [];
      const seenCells = new Set();
      const hostedCells = [];
      for (const cell of rawCells) {
        if (!cell || !Number.isInteger(cell.componentIndex) || cell.componentIndex < 0) {
          throw new Error(`Power-cable Heat: section ${sectionId} has an invalid hosted endpoint`);
        }
        const key = `${cell.x},${cell.y}`;
        if (seenCells.has(key)) continue;
        seenCells.add(key);
        hostedCells.push({ x: cell.x, y: cell.y, componentIndex: cell.componentIndex });
      }
      if (hostedCells.length !== 2) {
        throw new Error(`Power-cable Heat: section ${sectionId} must host exactly two endpoint cells`);
      }
      const tierConfig = powerTiers[flow.tier] || {};
      const heatPerHostedCellPerSecond = cableHeatRateForSection(flow, tierConfig);
      const totalHeatPerSecond = heatPerHostedCellPerSecond * hostedCells.length;
      for (const cell of hostedCells) {
        touch(cell.componentIndex);
        componentRate.set(cell.componentIndex, componentRate.get(cell.componentIndex) + heatPerHostedCellPerSecond);
        if (heatPerHostedCellPerSecond > 0) addTo(componentActive, cell.componentIndex, flow.sectionId);
        if (flow.aboveSustained) addTo(componentAbove, cell.componentIndex, flow.sectionId);
        if (flow.atPeak) addTo(componentPeak, cell.componentIndex, flow.sectionId);
      }
      sections.push({
        sectionId,
        tier: flow.tier,
        signedFlowMw: signed,
        absoluteFlowMw: absolute,
        sustainedCapacityMw: Number(flow.sustainedCapacityMw) || 0,
        peakCapacityMw: Number(flow.peakCapacityMw) || 0,
        sustainedUtilisation: Number(flow.sustainedUtilisation) || 0,
        peakUtilisation: Number(flow.peakUtilisation) || 0,
        aboveSustained: Boolean(flow.aboveSustained),
        atPeak: Boolean(flow.atPeak),
        hostedCells,
        hostComponentIndexes: [...new Set(hostedCells.map((c) => c.componentIndex))].sort((a, b) => a - b),
        heatPerHostedCellPerSecond,
        totalHeatPerSecond
      });
    }
    sections.sort((a, b) => compareIds(a.sectionId, b.sectionId));

    const components = [...componentRate.keys()].sort((a, b) => a - b).map((componentIndex) => ({
      componentIndex,
      powerCableHeatPerSecond: componentRate.get(componentIndex),
      hostedActiveSectionIds: sortedUniqueIds(componentActive.get(componentIndex) || []),
      aboveSustainedSectionIds: sortedUniqueIds(componentAbove.get(componentIndex) || []),
      atPeakSectionIds: sortedUniqueIds(componentPeak.get(componentIndex) || [])
    }));

    let total = 0;
    for (const section of sections) total += section.totalHeatPerSecond;
    // Normalise -0 out of the conserved total.
    if (Object.is(total, -0)) total = 0;

    let hottestSectionId = null; let hottestSectionHeat = -Infinity;
    for (const section of sections) {
      if (section.totalHeatPerSecond > hottestSectionHeat) { hottestSectionHeat = section.totalHeatPerSecond; hottestSectionId = section.sectionId; }
    }
    if (!(hottestSectionHeat > 0)) hottestSectionId = null;
    let hottestHostComponentIndex = null; let hottestHostHeat = -Infinity;
    for (const component of components) {
      if (component.powerCableHeatPerSecond > hottestHostHeat) { hottestHostHeat = component.powerCableHeatPerSecond; hottestHostComponentIndex = component.componentIndex; }
    }
    if (!(hottestHostHeat > 0)) hottestHostComponentIndex = null;

    const summary = {
      totalPowerCableHeatPerSecond: total,
      activeSectionCount: sections.filter((s) => s.heatPerHostedCellPerSecond > 0).length,
      zeroFlowSectionCount: sections.filter((s) => !(s.absoluteFlowMw > 0)).length,
      aboveSustainedSectionCount: sections.filter((s) => s.aboveSustained).length,
      atPeakSectionCount: sections.filter((s) => s.atPeak).length,
      hottestSectionId,
      hottestHostComponentIndex
    };

    return { sections, components, summary };
  }

  function totalPowerCableHeatRate(result) {
    if (result && result.summary && Number.isFinite(result.summary.totalPowerCableHeatPerSecond)) {
      return result.summary.totalPowerCableHeatPerSecond;
    }
    let total = 0;
    for (const component of (result && result.components) || []) total += Number(component.powerCableHeatPerSecond) || 0;
    return Object.is(total, -0) ? 0 : total;
  }

  return { cableHeatRateForSection, analyzePowerCableHeat, totalPowerCableHeatRate };
}));
