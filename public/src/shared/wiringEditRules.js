(function initWiringEditRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const wiring = onNode ? require("./wiringRules") : root.WiringRules;
  const infra = onNode ? require("./wiringInfrastructureRules") : root.WiringInfrastructureRules;
  const rules = factory(wiring, infra);
  if (onNode) module.exports = rules;
  root.WiringEditRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeWiringEditRules(WiringRules, WiringInfrastructureRules) {
  "use strict";

  if (!WiringRules) throw new Error("WiringRules must load before WiringEditRules");
  if (!WiringInfrastructureRules) throw new Error("WiringInfrastructureRules must load before WiringEditRules");

  const { accountInfrastructure, clampDisplacedCapacity } = WiringInfrastructureRules;

  function numberOr(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  // Deterministic infrastructure snapshot for one wiring value: Power/Data cost,
  // total infrastructure and total static Heat displacement, plus per-cell and
  // per-component detail used to diff two wiring states. All numbers come from
  // the shared 7A accounting authority — never estimated from raw section count.
  function infrastructureSnapshot(design, wiring, catalogue, infrastructure) {
    const accounting = accountInfrastructure(design, wiring, catalogue, infrastructure);
    const powerCost = accounting.power.cost;
    const dataCost = accounting.data.cost;
    const displacement = accounting.power.displacement + accounting.data.displacement;
    // Installed tier per Power host cell (highest incident) and Data occupancy.
    const powerCellTier = new Map();
    for (const key of accounting.maps.power.uniqueHostedCells) powerCellTier.set(key, accounting.maps.power.byCellKey.get(key).tier);
    const dataCells = new Set(accounting.maps.data.uniqueHostedCells);
    return {
      accounting,
      powerCost,
      dataCost,
      totalInfrastructure: powerCost + dataCost,
      displacement,
      powerCellCount: accounting.power.uniqueHostedCellCount,
      dataCellCount: accounting.data.uniqueHostedCellCount,
      powerCellTier,
      dataCells,
      byComponentIndex: accounting.byComponentIndex
    };
  }

  function baseCapacityFor(baseCapacities, index) {
    if (typeof baseCapacities === "function") return numberOr(baseCapacities(index), 0);
    if (Array.isArray(baseCapacities)) return numberOr(baseCapacities[index], 0);
    return 0;
  }

  // Compare a proposed wiring against the current wiring using only shared 7A
  // accounting. Returns cost/displacement current, proposed and delta plus the
  // components and hosted cells the edit actually affects. Never mutates input.
  function diffWiring(design, currentWiring, proposedWiring, catalogue, infrastructure, options = {}) {
    const current = infrastructureSnapshot(design, currentWiring, catalogue, infrastructure);
    const proposed = infrastructureSnapshot(design, proposedWiring, catalogue, infrastructure);
    const pre = numberOr(options.preInfrastructureShipCost, 0);
    const currentTotalShip = pre + current.totalInfrastructure;
    const proposedTotalShip = pre + proposed.totalInfrastructure;

    const currentBlock = {
      powerCost: current.powerCost,
      dataCost: current.dataCost,
      totalInfrastructure: current.totalInfrastructure,
      totalShipCost: currentTotalShip,
      infrastructurePercentage: currentTotalShip > 0 ? current.totalInfrastructure / currentTotalShip : 0,
      displacement: current.displacement
    };
    const proposedBlock = {
      powerCost: proposed.powerCost,
      dataCost: proposed.dataCost,
      totalInfrastructure: proposed.totalInfrastructure,
      totalShipCost: proposedTotalShip,
      infrastructurePercentage: proposedTotalShip > 0 ? proposed.totalInfrastructure / proposedTotalShip : 0,
      displacement: proposed.displacement
    };
    const delta = {
      powerCost: proposed.powerCost - current.powerCost,
      dataCost: proposed.dataCost - current.dataCost,
      totalInfrastructure: proposed.totalInfrastructure - current.totalInfrastructure,
      totalShipCost: proposedTotalShip - currentTotalShip,
      infrastructurePercentage: proposedBlock.infrastructurePercentage - currentBlock.infrastructurePercentage,
      displacement: proposed.displacement - current.displacement
    };

    // Hosted cells whose installed Power tier changed, or which were added or
    // removed for Power or Data. Deterministic order by cell key.
    const cellKeys = new Set([
      ...current.powerCellTier.keys(), ...proposed.powerCellTier.keys(),
      ...current.dataCells, ...proposed.dataCells
    ]);
    const affectedHostedCells = [];
    for (const key of [...cellKeys].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
      const beforeTier = current.powerCellTier.get(key) || null;
      const afterTier = proposed.powerCellTier.get(key) || null;
      const beforeData = current.dataCells.has(key);
      const afterData = proposed.dataCells.has(key);
      if (beforeTier === afterTier && beforeData === afterData) continue;
      const [x, y] = key.split(",").map(Number);
      affectedHostedCells.push({ key, x, y, powerTierBefore: beforeTier, powerTierAfter: afterTier, dataBefore: beforeData, dataAfter: afterData });
    }

    // Components whose final Heat capacity changes under the edit.
    const affectedComponents = [];
    const componentCount = Array.isArray(design) ? design.length : 0;
    for (let i = 0; i < componentCount; i += 1) {
      const base = baseCapacityFor(options.baseCapacities, i);
      const beforeEntry = current.byComponentIndex[i] || { powerDisplacement: 0, dataDisplacement: 0 };
      const afterEntry = proposed.byComponentIndex[i] || { powerDisplacement: 0, dataDisplacement: 0 };
      const beforeCapacity = clampDisplacedCapacity(base, beforeEntry.powerDisplacement, beforeEntry.dataDisplacement, infrastructure);
      const afterCapacity = clampDisplacedCapacity(base, afterEntry.powerDisplacement, afterEntry.dataDisplacement, infrastructure);
      if (beforeCapacity === afterCapacity) continue;
      affectedComponents.push({
        componentIndex: i,
        baseHeatCapacity: base,
        heatCapacityBefore: beforeCapacity,
        heatCapacityAfter: afterCapacity,
        heatCapacityDelta: afterCapacity - beforeCapacity
      });
    }

    return {
      valid: true,
      reason: null,
      current: currentBlock,
      proposed: proposedBlock,
      delta,
      newPowerCells: Math.max(0, proposed.powerCellCount - current.powerCellCount),
      removedPowerCells: Math.max(0, current.powerCellCount - proposed.powerCellCount),
      newDataCells: Math.max(0, proposed.dataCellCount - current.dataCellCount),
      removedDataCells: Math.max(0, current.dataCellCount - proposed.dataCellCount),
      affectedComponents,
      affectedHostedCells
    };
  }

  function invalidPreview(reason) {
    return { valid: false, reason, current: null, proposed: null, delta: null, affectedComponents: [], affectedHostedCells: [] };
  }

  // Preview a Power/Data Draw path with the selected tier. New sections receive
  // the tier; existing sections keep theirs.
  function previewPowerPathEdit(design, wiring, kind, cells, tier, catalogue, infrastructure, options = {}) {
    if (!Array.isArray(cells) || cells.length < 2) return invalidPreview("empty-path");
    let proposed;
    try { proposed = WiringRules.addPathWithTier(wiring, kind, cells, design, catalogue, tier); }
    catch (_) { return invalidPreview("invalid-path"); }
    const preview = diffWiring(design, WiringRules.normalizeWiring(wiring, design, catalogue).wiring, proposed, catalogue, infrastructure, options);
    preview.newSections = countNewSections(wiring, proposed, kind, design, catalogue);
    preview.proposedWiring = proposed;
    return preview;
  }

  // Preview a single-section tier change (upgrade or downgrade).
  function previewPowerTierEdit(design, wiring, sectionId, targetTier, catalogue, infrastructure, options = {}) {
    const result = WiringRules.setSectionTier(wiring, "power", sectionId, targetTier, design, catalogue);
    if (!result.changed) return invalidPreview(result.reason || "no-change");
    const preview = diffWiring(design, WiringRules.normalizeWiring(wiring, design, catalogue).wiring, result.wiring, catalogue, infrastructure, options);
    preview.affectedSectionIds = result.affectedSectionIds;
    preview.proposedWiring = result.wiring;
    return preview;
  }

  // Preview removal of one section (Power or Data).
  function previewWiringSectionRemoval(design, wiring, kind, sectionId, catalogue, infrastructure, options = {}) {
    const normalizedCurrent = WiringRules.normalizeWiring(wiring, design, catalogue).wiring;
    const exists = (normalizedCurrent[kind]?.sections || []).some((s) => WiringRules.segmentKey(s) === sectionId);
    if (!exists) return invalidPreview("missing-section");
    const proposed = WiringRules.removeSection(wiring, kind, sectionId, design, catalogue);
    const preview = diffWiring(design, normalizedCurrent, proposed, catalogue, infrastructure, options);
    preview.proposedWiring = proposed;
    return preview;
  }

  function countNewSections(currentWiring, proposedWiring, kind, design, catalogue) {
    const normalizedCurrent = WiringRules.normalizeWiring(currentWiring, design, catalogue).wiring;
    const before = new Set((normalizedCurrent[kind]?.sections || []).map((s) => WiringRules.segmentKey(s)));
    let count = 0;
    for (const section of proposedWiring[kind]?.sections || []) if (!before.has(WiringRules.segmentKey(section))) count += 1;
    return count;
  }

  // Deterministic cache signature for a hover/preview frame. Callers cache the
  // preview keyed by this string and invalidate it after a committed edit.
  function previewSignature(parts) {
    return JSON.stringify(parts);
  }

  return {
    infrastructureSnapshot,
    diffWiring,
    previewPowerPathEdit,
    previewPowerTierEdit,
    previewWiringSectionRemoval,
    previewSignature
  };
}));
