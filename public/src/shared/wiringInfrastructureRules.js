(function initWiringInfrastructureRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const wiring = onNode ? require("./wiringRules") : root.WiringRules;
  const rules = factory(wiring);
  if (onNode) module.exports = rules;
  root.WiringInfrastructureRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeWiringInfrastructureRules(WiringRules) {
  "use strict";

  if (!WiringRules) throw new Error("WiringRules must load before WiringInfrastructureRules");

  const { moduleCells, cellKey, sectionCells, POWER_TIERS, POWER_TIER_PRECEDENCE, higherPowerTier } = WiringRules;
  const KINDS = Object.freeze(["power", "data"]);

  function numberOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  // The single authoritative occupancy map. Every host lookup — cost, thermal
  // displacement and runtime host availability — resolves cells through this.
  function occupancy(design, catalogue) {
    const map = new Map();
    (Array.isArray(design) ? design : []).forEach((module, index) => {
      moduleCells(module, catalogue).forEach((cell) => map.set(cellKey(cell.x, cell.y), index));
    });
    return map;
  }

  function sortCellKeys(a, b) { return a.localeCompare(b, undefined, { numeric: true }); }

  // Canonical hosted-cell mapping for one wiring kind. A section is hosted by its
  // two canonical endpoint Blueprint cells; each cell maps to the physical
  // component that occupies it. Power tier is tracked per cell as the highest
  // installed tier of any incident Power section (Data has no functional tier).
  function mapHostedCellsForKind(design, kindValue, catalogue, kind) {
    const occupied = occupancy(design, catalogue);
    const sections = (kindValue?.sections || []).slice()
      .sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    const bySectionId = new Map();
    const byCellKey = new Map();
    for (const section of sections) {
      const cells = sectionCells(section);
      const hostCells = cells.map((cell) => ({ x: cell.x, y: cell.y, componentIndex: occupied.has(cellKey(cell.x, cell.y)) ? occupied.get(cellKey(cell.x, cell.y)) : null }));
      const tier = kind === "power" ? section.tier : "standard";
      const uniqueComponentIndices = [...new Set(hostCells.map((c) => c.componentIndex).filter((i) => i != null))].sort((a, b) => a - b);
      const valid = hostCells.every((c) => c.componentIndex != null);
      bySectionId.set(section.id, { sectionId: section.id, kind, tier, hostCells, uniqueComponentIndices, valid });
      for (const host of hostCells) {
        if (host.componentIndex == null) continue;
        const key = cellKey(host.x, host.y);
        let entry = byCellKey.get(key);
        if (!entry) {
          entry = { key, x: host.x, y: host.y, componentIndex: host.componentIndex, kind, tier, sectionIds: [] };
          byCellKey.set(key, entry);
        }
        if (kind === "power") entry.tier = higherPowerTier(entry.tier, tier);
        entry.sectionIds.push(section.id);
      }
    }
    const uniqueHostedCells = [...byCellKey.keys()].sort(sortCellKeys);
    const byComponentIndex = new Map();
    for (const key of uniqueHostedCells) {
      const entry = byCellKey.get(key);
      entry.sectionIds.sort(sortCellKeys);
      if (!byComponentIndex.has(entry.componentIndex)) byComponentIndex.set(entry.componentIndex, []);
      byComponentIndex.get(entry.componentIndex).push(key);
    }
    return { bySectionId, byCellKey, byComponentIndex, uniqueHostedCells };
  }

  function mapHostedCells(design, wiring, catalogue) {
    return {
      power: mapHostedCellsForKind(design, wiring?.power, catalogue, "power"),
      data: mapHostedCellsForKind(design, wiring?.data, catalogue, "data")
    };
  }

  function powerTierConfig(infrastructure, tier) {
    return (infrastructure?.powerTiers && infrastructure.powerTiers[tier]) || {};
  }

  // Unique hosted-cell accounting. Cost and static displacement are charged per
  // unique occupied host cell — never per raw section — so shared trunks and
  // junctions are counted exactly once. Power uses the installed (highest) tier
  // per cell; Data is single-tier. Power and Data occupy cells independently.
  function accountInfrastructure(design, wiring, catalogue, infrastructure) {
    const maps = mapHostedCells(design, wiring, catalogue);
    const componentCount = Array.isArray(design) ? design.length : 0;
    const perComponent = [];
    for (let i = 0; i < componentCount; i += 1) {
      perComponent.push({
        componentIndex: i,
        hostedLightCells: 0, hostedStandardCells: 0, hostedHeavyCells: 0, hostedDataCells: 0,
        powerCost: 0, dataCost: 0, powerDisplacement: 0, dataDisplacement: 0
      });
    }

    const cellsByTier = { light: [], standard: [], heavy: [] };
    let powerCost = 0; let powerDisplacement = 0;
    for (const key of maps.power.uniqueHostedCells) {
      const cell = maps.power.byCellKey.get(key);
      const config = powerTierConfig(infrastructure, cell.tier);
      const cost = numberOr(config.costPerHostedCell, 0);
      const displacement = numberOr(config.heatCapacityDisplacement, 0);
      powerCost += cost; powerDisplacement += displacement;
      (cellsByTier[cell.tier] || (cellsByTier[cell.tier] = [])).push({ key, x: cell.x, y: cell.y, componentIndex: cell.componentIndex, tier: cell.tier });
      const target = perComponent[cell.componentIndex];
      if (target) {
        if (cell.tier === "light") target.hostedLightCells += 1;
        else if (cell.tier === "heavy") target.hostedHeavyCells += 1;
        else target.hostedStandardCells += 1;
        target.powerCost += cost;
        target.powerDisplacement += displacement;
      }
    }

    const dataConfig = infrastructure?.data || {};
    const dataCostPerCell = numberOr(dataConfig.costPerHostedCell, 0);
    const dataDisplacementPerCell = numberOr(dataConfig.heatCapacityDisplacement, 0);
    let dataCost = 0; let dataDisplacement = 0;
    for (const key of maps.data.uniqueHostedCells) {
      const cell = maps.data.byCellKey.get(key);
      dataCost += dataCostPerCell; dataDisplacement += dataDisplacementPerCell;
      const target = perComponent[cell.componentIndex];
      if (target) {
        target.hostedDataCells += 1;
        target.dataCost += dataCostPerCell;
        target.dataDisplacement += dataDisplacementPerCell;
      }
    }

    return {
      maps,
      power: {
        uniqueHostedCellCount: maps.power.uniqueHostedCells.length,
        cellsByTier: {
          light: cellsByTier.light,
          standard: cellsByTier.standard,
          heavy: cellsByTier.heavy
        },
        cost: powerCost,
        displacement: powerDisplacement
      },
      data: {
        uniqueHostedCellCount: maps.data.uniqueHostedCells.length,
        cost: dataCost,
        displacement: dataDisplacement
      },
      byComponentIndex: perComponent
    };
  }

  function computeInfrastructureCost(design, wiring, catalogue, infrastructure) {
    const accounting = accountInfrastructure(design, wiring, catalogue, infrastructure);
    const powerWiring = accounting.power.cost;
    const dataWiring = accounting.data.cost;
    return { powerWiring, dataWiring, totalInfrastructure: powerWiring + dataWiring, accounting };
  }

  // Cost-ordering rule (Section 7A): the existing component-derived ship price is
  // calculated normally, then raw Power and Data infrastructure cost is added on
  // top. Infrastructure is NEVER multiplied by hull/mass/weapon premiums.
  function infrastructureCostPresentation(componentsCost, powerWiring, dataWiring) {
    const components = numberOr(componentsCost, 0);
    const power = numberOr(powerWiring, 0);
    const data = numberOr(dataWiring, 0);
    const totalInfrastructure = power + data;
    const totalShipCost = components + totalInfrastructure;
    return {
      components,
      powerWiring: power,
      dataWiring: data,
      totalInfrastructure,
      totalShipCost,
      infrastructurePercentage: totalShipCost > 0 ? totalInfrastructure / totalShipCost : 0
    };
  }

  function minimumCapacity(infrastructure) {
    const value = Number(infrastructure?.minimumComponentHeatCapacity);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  // Static Heat-capacity displacement. Installed wiring permanently reduces a
  // host component's Heat capacity: final = base - powerDisplacement -
  // dataDisplacement, clamped to the configured minimum. Never returns negative,
  // zero, NaN or infinite capacity.
  function clampDisplacedCapacity(baseCapacity, powerDisplacement, dataDisplacement, infrastructure) {
    const base = Number.isFinite(baseCapacity) ? baseCapacity : 0;
    const displaced = base - numberOr(powerDisplacement, 0) - numberOr(dataDisplacement, 0);
    const minimum = minimumCapacity(infrastructure);
    if (!Number.isFinite(displaced)) return minimum;
    return Math.max(minimum, displaced);
  }

  // Per-component thermal diagnostics. baseCapacities may be an array or a
  // function (index -> base capacity). Ordering is by design index.
  function componentThermalDiagnostics(design, wiring, catalogue, infrastructure, baseCapacities) {
    const accounting = accountInfrastructure(design, wiring, catalogue, infrastructure);
    const baseFor = typeof baseCapacities === "function"
      ? baseCapacities
      : (index) => (Array.isArray(baseCapacities) ? numberOr(baseCapacities[index], 0) : 0);
    return accounting.byComponentIndex.map((entry) => {
      const baseHeatCapacity = numberOr(baseFor(entry.componentIndex), 0);
      const finalHeatCapacity = clampDisplacedCapacity(baseHeatCapacity, entry.powerDisplacement, entry.dataDisplacement, infrastructure);
      return {
        componentIndex: entry.componentIndex,
        baseHeatCapacity,
        hostedLightCells: entry.hostedLightCells,
        hostedStandardCells: entry.hostedStandardCells,
        hostedHeavyCells: entry.hostedHeavyCells,
        hostedDataCells: entry.hostedDataCells,
        powerDisplacement: entry.powerDisplacement,
        dataDisplacement: entry.dataDisplacement,
        finalHeatCapacity
      };
    });
  }

  return {
    KINDS,
    POWER_TIERS,
    POWER_TIER_PRECEDENCE,
    occupancy,
    mapHostedCellsForKind,
    mapHostedCells,
    accountInfrastructure,
    computeInfrastructureCost,
    infrastructureCostPresentation,
    componentThermalDiagnostics,
    clampDisplacedCapacity,
    minimumCapacity
  };
}));
