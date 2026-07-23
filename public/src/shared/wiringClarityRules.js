(function initWiringClarityRules(root, factory) {
  const onNode = typeof module !== "undefined" && module.exports;
  const rules = factory();
  if (onNode) module.exports = rules;
  root.WiringClarityRules = rules;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeWiringClarityRules() {
  "use strict";

  // Wiring cost/benefit clarity rules — presentation-layer interpretation of
  // AUTHORITATIVE inputs only. Every capacity, cost, displacement, Heat and
  // flow number is read from the balance configuration or solver results the
  // caller passes in; this module holds guidance prose and comparison logic,
  // never duplicate tier constants and never a second allocation, Heat or
  // overload formula.

  function sanitize(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Object.is(n, -0) ? 0 : n;
  }
  function round2(value) { return sanitize(Math.round(sanitize(value) * 100) / 100); }
  function mw(value) { return `${round2(value)} MW`; }

  const POWER_TIER_ORDER = Object.freeze(["light", "standard", "heavy"]);

  function tierConfig(infrastructure, tier) {
    return (infrastructure && infrastructure.powerTiers && infrastructure.powerTiers[tier]) || {};
  }
  function tierName(infrastructure, tier) {
    const label = tierConfig(infrastructure, tier).inspectionLabel;
    return typeof label === "string" && label ? label : (tier ? tier[0].toUpperCase() + tier.slice(1) : "Unknown");
  }
  function capacityText(infrastructure, tier) {
    const config = tierConfig(infrastructure, tier);
    return `${sanitize(config.sustainedCapacityMw)} / ${sanitize(config.peakCapacityMw)} MW`;
  }

  // Fixed guidance prose per tier. No tier is described as universally best.
  const POWER_TIER_GUIDANCE = Object.freeze({
    light: Object.freeze({
      bestFor: "Short, low-demand final branches.",
      benefit: "Cheapest and smallest cable.",
      downside: "Easily becomes a bottleneck.",
      heatNote: "Lowest Heat per cell, but overload Heat rises steeply above sustained.",
      recommendation: (config) => `Good for final branches below ${sanitize(config.sustainedCapacityMw)} MW sustained.`,
      warning: () => "A Light bottleneck limits every heavier cable placed after it."
    }),
    standard: Object.freeze({
      bestFor: "Normal ship-wide distribution.",
      benefit: "Balanced cost, space and capacity.",
      downside: "Insufficient for major high-demand trunks.",
      heatNote: "Moderate Heat per cell at rating.",
      recommendation: (config) => `The usual choice for general routes up to ${sanitize(config.sustainedCapacityMw)} MW sustained.`,
      warning: () => "Not enough for a trunk that feeds many heavy consumers at once."
    }),
    heavy: Object.freeze({
      bestFor: "Large shared trunks carrying many loads.",
      benefit: "Highest sustained and peak capacity.",
      downside: "Expensive, bulky and wasteful on small branches.",
      heatNote: "Highest Heat per cell at rating, but runs coolest at equal load.",
      recommendation: (config) => `Reserve for trunks that genuinely approach ${sanitize(config.sustainedCapacityMw)} MW sustained.`,
      warning: () => "Heavy Bus is usually wasteful unless this route carries several consumers."
    })
  });

  const DATA_GUIDANCE = Object.freeze({
    bestFor: "Data-support connectivity.",
    benefit: "Cheap and low displacement.",
    downside: "Provides no Power and remains independently vulnerable.",
    recommendation: () => "Carries Data only.",
    warning: () => "No capacity, Heat or overload mechanics."
  });

  // Compact comparison cards for the Wiring panel. All numbers come from the
  // supplied authoritative infrastructure block.
  function tierCards(infrastructure) {
    const cards = POWER_TIER_ORDER.map((tier) => {
      const config = tierConfig(infrastructure, tier);
      const guidance = POWER_TIER_GUIDANCE[tier];
      return {
        key: tier,
        kind: "power",
        label: tierName(infrastructure, tier),
        sustainedMw: sanitize(config.sustainedCapacityMw),
        peakMw: sanitize(config.peakCapacityMw),
        costPerCell: sanitize(config.costPerHostedCell),
        displacementPerCell: sanitize(config.heatCapacityDisplacement),
        heatNote: guidance.heatNote,
        bestFor: guidance.bestFor,
        benefit: guidance.benefit,
        downside: guidance.downside
      };
    });
    const data = (infrastructure && infrastructure.data) || {};
    cards.push({
      key: "data",
      kind: "data",
      label: typeof data.inspectionLabel === "string" && data.inspectionLabel ? data.inspectionLabel : "Data Cable",
      sustainedMw: null,
      peakMw: null,
      costPerCell: sanitize(data.costPerHostedCell),
      displacementPerCell: sanitize(data.heatCapacityDisplacement),
      heatNote: "No dynamic Heat.",
      bestFor: DATA_GUIDANCE.bestFor,
      benefit: DATA_GUIDANCE.benefit,
      downside: DATA_GUIDANCE.downside
    });
    return cards;
  }

  // Prominent summary for the currently selected drawing tool/tier.
  function toolSummary(infrastructure, mode, tier) {
    if (mode === "data") {
      const data = (infrastructure && infrastructure.data) || {};
      return {
        title: typeof data.inspectionLabel === "string" && data.inspectionLabel ? data.inspectionLabel : "Data Cable",
        capacityText: "Carries Data only",
        costText: `$${sanitize(data.costPerHostedCell)} per new cell`,
        displacementText: `${sanitize(data.heatCapacityDisplacement)} Heat capacity per new cell`,
        recommendation: DATA_GUIDANCE.recommendation(),
        warning: DATA_GUIDANCE.warning()
      };
    }
    const config = tierConfig(infrastructure, tier);
    const guidance = POWER_TIER_GUIDANCE[tier] || POWER_TIER_GUIDANCE.standard;
    return {
      title: tierName(infrastructure, tier),
      capacityText: `${capacityText(infrastructure, tier)} sustained / peak`,
      costText: `$${sanitize(config.costPerHostedCell)} per new cell`,
      displacementText: `${sanitize(config.heatCapacityDisplacement)} Heat capacity per new cell`,
      recommendation: guidance.recommendation(config),
      warning: guidance.warning(config)
    };
  }

  // ------------------------------------------------------------------
  // Route/edit preview interpretation.
  // ------------------------------------------------------------------
  function cellChangeCounts(preview) {
    const affected = Array.isArray(preview && preview.affectedHostedCells) ? preview.affectedHostedCells : [];
    let upgraded = 0; let downgraded = 0;
    for (const cell of affected) {
      const before = POWER_TIER_ORDER.indexOf(cell.powerTierBefore);
      const after = POWER_TIER_ORDER.indexOf(cell.powerTierAfter);
      if (before >= 0 && after >= 0 && after > before) upgraded += 1;
      else if (before >= 0 && after >= 0 && after < before) downgraded += 1;
    }
    return { upgraded, downgraded };
  }

  // Live Draw-route preview lines. `pathCellCount` is the number of unique
  // cells on the proposed path; new-vs-reused cells come from the shared edit
  // preview so nothing is recounted here.
  function describeDrawPreview({ preview, infrastructure, mode, tier, pathCellCount, predictedRouteLoadMw }) {
    if (!preview || !preview.valid || !preview.delta) return { lines: [], warnings: [] };
    const isData = mode === "data";
    const newCells = sanitize(isData ? preview.newDataCells : preview.newPowerCells);
    const reused = Math.max(0, sanitize(pathCellCount) - newCells);
    const lines = [];
    lines.push(`New cells: ${newCells} · Reused cells: ${reused}`);
    lines.push(`Cost ${signedMoneyText(preview.delta.totalInfrastructure)} · Displacement ${signedText(preview.delta.displacement)}`);
    const warnings = [];
    if (!isData) {
      const config = tierConfig(infrastructure, tier);
      lines.push(`Route tier: ${tierName(infrastructure, tier)} — ${capacityText(infrastructure, tier)} sustained / peak (new sections only)`);
      const load = predictedRouteLoadMw;
      if (load != null && Number.isFinite(Number(load))) {
        const sustained = sanitize(config.sustainedCapacityMw);
        lines.push(`Predicted nearby load: ${mw(load)} (current estimate)`);
        if (sustained > 0 && sanitize(load) > sustained) warnings.push(`Predicted load ${mw(load)} exceeds this tier's ${mw(sustained)} sustained rating.`);
      } else {
        lines.push("No live load estimate is available before deployment.");
      }
    } else {
      lines.push("Carries Data only · No capacity, Heat or overload mechanics.");
    }
    return { lines, warnings };
  }

  function signedText(value) { const n = round2(value); return n > 0 ? `+${n}` : `${n}`; }
  function signedMoneyText(value) { const n = round2(value); return n >= 0 ? `+$${n}` : `-$${Math.abs(n)}`; }

  // ------------------------------------------------------------------
  // Upgrade / downgrade side-by-side comparison for one Power section.
  // All flow inputs are solved section flows from the authoritative solver
  // (current wiring and proposed wiring); this function only interprets them.
  // ------------------------------------------------------------------
  function tierChangeComparison({ infrastructure, fromTier, toTier, preview, currentSectionFlow, proposedSectionFlow, weakerTierRemainsOnRoute, routeEvidenceAvailable = false, currentCableHeatRate, proposedCableHeatRate }) {
    const fromConfig = tierConfig(infrastructure, fromTier);
    const toConfig = tierConfig(infrastructure, toTier);
    const upgrade = POWER_TIER_ORDER.indexOf(toTier) > POWER_TIER_ORDER.indexOf(fromTier);
    const flowMw = currentSectionFlow ? sanitize(currentSectionFlow.absoluteFlowMw) : null;
    const proposedFlowMw = proposedSectionFlow ? sanitize(proposedSectionFlow.absoluteFlowMw) : null;

    const block = (config, flow, heatRate) => ({
      tier: config === fromConfig ? fromTier : toTier,
      label: tierName(infrastructure, config === fromConfig ? fromTier : toTier),
      sustainedMw: sanitize(config.sustainedCapacityMw),
      peakMw: sanitize(config.peakCapacityMw),
      costPerCell: sanitize(config.costPerHostedCell),
      displacementPerCell: sanitize(config.heatCapacityDisplacement),
      utilisation: flow === null || sanitize(config.sustainedCapacityMw) <= 0 ? null : round2(flow / sanitize(config.sustainedCapacityMw)),
      cableHeatRate: heatRate != null && Number.isFinite(Number(heatRate)) ? round2(heatRate) : null
    });

    const current = block(fromConfig, flowMw, currentCableHeatRate);
    const proposed = block(toConfig, proposedFlowMw === null ? flowMw : proposedFlowMw, proposedCableHeatRate);
    const delta = {
      costPerCell: round2(proposed.costPerCell - current.costPerCell),
      displacementPerCell: round2(proposed.displacementPerCell - current.displacementPerCell),
      sustainedMw: round2(proposed.sustainedMw - current.sustainedMw),
      peakMw: round2(proposed.peakMw - current.peakMw),
      totalCost: preview && preview.delta ? round2(preview.delta.totalInfrastructure) : null,
      totalDisplacement: preview && preview.delta ? round2(preview.delta.displacement) : null
    };

    // Plain-language verdict from the solved flows only.
    let verdict;
    if (upgrade) {
      const wasLimited = Boolean(currentSectionFlow && (currentSectionFlow.aboveSustained || currentSectionFlow.atPeak));
      if (weakerTierRemainsOnRoute) verdict = routeEvidenceAvailable ? `Limited elsewhere: a weaker section on this selected source-to-consumer route still constrains delivery.` : "Caution: a weaker section exists in this network, but route-specific evidence is unavailable.";
      else if (wasLimited) verdict = `Useful upgrade: predicted sustained load is ${mw(proposedFlowMw === null ? flowMw : proposedFlowMw)}.`;
      else if (flowMw !== null && current.sustainedMw > 0 && flowMw <= current.sustainedMw * 0.9) verdict = `Likely unnecessary: predicted sustained load is only ${mw(flowMw)}.`;
      else verdict = "Adds headroom for future demand under this activity.";
    } else {
      if (flowMw !== null && proposed.peakMw > 0 && flowMw > proposed.peakMw) verdict = `Downgrade would cap delivery at ${mw(proposed.peakMw)} — current load is ${mw(flowMw)}.`;
      else if (flowMw !== null && proposed.sustainedMw > 0 && flowMw > proposed.sustainedMw) verdict = "Downgrade would overload this route during current activity.";
      else verdict = `Saves $${Math.abs(delta.costPerCell)} and ${Math.abs(delta.displacementPerCell)} displacement per affected cell.`;
    }
    const benefit = upgrade
      ? `Sustained capacity ${signedText(delta.sustainedMw)} MW · Peak ${signedText(delta.peakMw)} MW per section.`
      : `Cost ${signedText(delta.costPerCell)} · Displacement ${signedText(delta.displacementPerCell)} per affected cell.`;
    const drawback = upgrade
      ? `Cost ${signedText(delta.costPerCell)} · Displacement ${signedText(delta.displacementPerCell)} per affected cell.`
      : `Lost capacity: ${signedText(delta.sustainedMw)} MW sustained / ${signedText(delta.peakMw)} MW peak.`;
    return { upgrade, current, proposed, delta, verdict, benefit, drawback };
  }

  // ------------------------------------------------------------------
  // Selected-section interpretation.
  // ------------------------------------------------------------------
  function sectionInterpretation({ flow, disabled, isBottleneck, hasAlternateRoute }) {
    const sentences = [];
    if (disabled) {
      sentences.push("Disabled because its host component is destroyed.");
      return sentences;
    }
    if (flow) {
      const abs = sanitize(flow.absoluteFlowMw);
      const sustained = sanitize(flow.sustainedCapacityMw);
      if (flow.atPeak) sentences.push("At peak: additional demand will be shed.");
      else if (flow.aboveSustained) sentences.push("Above sustained: generating additional Heat and overload stress.");
      else if (sustained > 0 && abs >= sustained * 0.75) sentences.push("Near continuous capacity.");
      else sentences.push("Comfortably below sustained capacity.");
    }
    if (isBottleneck && flow && (flow.aboveSustained || flow.atPeak || sanitize(flow.absoluteFlowMw) >= sanitize(flow.sustainedCapacityMw))) sentences.push(`This section is limiting delivery: current flow ${mw(flow.absoluteFlowMw)} vs ${mw(flow.sustainedCapacityMw)} sustained / ${mw(flow.peakCapacityMw)} peak.`);
    if (hasAlternateRoute) sentences.push("This section has an alternate route.");
    else if (hasAlternateRoute === false) sentences.push("No alternate route detected.");
    return sentences;
  }

  // Cycle rank (independent alternate paths) of a set of two-endpoint
  // sections: E - V + C. Pure graph counting on the supplied topology.
  function alternatePathCount(sections) {
    const list = Array.isArray(sections) ? sections : [];
    if (!list.length) return 0;
    const cells = new Map();
    const parent = new Map();
    const find = (key) => { while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); } return key; };
    const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
    for (const section of list) {
      for (const key of [`${section.x1},${section.y1}`, `${section.x2},${section.y2}`]) {
        if (!parent.has(key)) { parent.set(key, key); cells.set(key, true); }
      }
      union(`${section.x1},${section.y1}`, `${section.x2},${section.y2}`);
    }
    const roots = new Set();
    for (const key of parent.keys()) roots.add(find(key));
    return Math.max(0, list.length - cells.size + roots.size);
  }

  // Whether removing one section disconnects part of its network (i.e. the
  // section lies on no cycle). sections = the network's section list.
  function sectionHasAlternateRoute(sections, sectionId) {
    const list = Array.isArray(sections) ? sections : [];
    const target = list.find((s) => s.id === sectionId);
    if (!target) return false;
    const without = list.filter((s) => s.id !== sectionId);
    // The section has an alternate route when its endpoints stay connected
    // without it.
    const parent = new Map();
    const find = (key) => { while (parent.get(key) !== key) { parent.set(key, parent.get(parent.get(key))); key = parent.get(key); } return key; };
    const add = (key) => { if (!parent.has(key)) parent.set(key, key); };
    for (const section of without) {
      const a = `${section.x1},${section.y1}`; const b = `${section.x2},${section.y2}`;
      add(a); add(b);
      const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra);
    }
    const a = `${target.x1},${target.y1}`; const b = `${target.x2},${target.y2}`;
    if (!parent.has(a) || !parent.has(b)) return false;
    return find(a) === find(b);
  }

  // ------------------------------------------------------------------
  // Blueprint-wide benefits/downsides observations. Inputs are authoritative
  // solver/accounting results assembled by the caller; every observation is
  // phrased as an estimate, never a guaranteed combat outcome.
  // ------------------------------------------------------------------
  function blueprintObservations(input) {
    const positives = [];
    const warnings = [];
    const infrastructure = input.infrastructure || {};
    const flows = Array.isArray(input.sectionFlows) ? input.sectionFlows : [];
    const summary = input.flowSummary || {};
    const networks = Array.isArray(input.powerNetworks) ? input.powerNetworks : [];
    const tierOf = (id) => (input.sectionTierById && input.sectionTierById[id]) || "standard";

    // Tier usage quality (based on the present Blueprint and current estimate).
    const lightLimited = flows.filter((f) => (f.aboveSustained || f.atPeak) && tierOf(f.sectionId) === "light");
    for (const flow of lightLimited.slice(0, 2)) {
      warnings.push(`Potential bottleneck: Light section ${flow.sectionId} is above rating under this activity: current flow ${mw(flow.absoluteFlowMw)} vs ${mw(flow.sustainedCapacityMw)} sustained / ${mw(flow.peakCapacityMw)} peak; consumers on this overloaded route may be limited, and upgrading this section can add headroom.`);
    }
    const heavyFlows = flows.filter((f) => tierOf(f.sectionId) === "heavy");
    const standardSustained = sanitize(tierConfig(infrastructure, "standard").sustainedCapacityMw);
    const lightHeavy = heavyFlows.filter((f) => standardSustained > 0 && sanitize(f.absoluteFlowMw) <= standardSustained * 0.9);
    if (heavyFlows.length && lightHeavy.length === heavyFlows.length) {
      warnings.push(`Heavy cable appears lightly loaded (current estimate ${mw(Math.max(...lightHeavy.map((f) => sanitize(f.absoluteFlowMw))))} peak section load) — a lower tier may suffice.`);
    } else if (heavyFlows.length) {
      positives.push("Heavy tier is carrying a genuinely high-load trunk under this activity.");
    }
    const lightOk = flows.some((f) => tierOf(f.sectionId) === "light" && !f.aboveSustained && !f.atPeak && sanitize(f.absoluteFlowMw) > 0);
    if (lightOk && !lightLimited.length) positives.push("Short Light branches carry their loads inexpensively.");
    const standardOk = flows.some((f) => tierOf(f.sectionId) === "standard" && sanitize(f.absoluteFlowMw) > 0 && !f.aboveSustained);
    if (standardOk) positives.push("Standard cable handles general distribution within its rating.");

    // Topology resilience (pure graph facts).
    const alternate = sanitize(input.alternatePaths);
    if (alternate > 0) positives.push(`Alternate Power path detected (${alternate} independent loop${alternate === 1 ? "" : "s"}). Parallel routes do not double usable capacity.`);
    const multiConsumerTrees = networks.filter((n) => sanitize(n.consumerCount) >= 2 && sanitize(n.alternatePaths) === 0 && (sanitize(n.bridgeSharedDemandMw) > 0 || sanitize(n.highFlowBridgeCount) > 0));
    if (multiConsumerTrees.length) {
      warnings.push("Potential weakness: a central-trunk vulnerability is evidenced by a bridge or articulation point carrying shared demand on that network.");
    }
    const usefulIndependent = networks.filter((n) => (sanitize(n.operationalGeneratorCount) > 0 || sanitize(n.generationMw) > 0 || sanitize(n.availableGenerationMw) > 0) && (sanitize(n.consumerCount) > 0 || sanitize(n.demandMw) > 0) && n.disconnected !== true);
    if (usefulIndependent.length >= 2) {
      positives.push("Independent powered grids detected: each has generation, demand and potential delivery.");
      const stranded = sanitize(summary.strandedGenerationMw);
      const spare = sanitize(summary.spareGenerationMw);
      if (stranded > 0 || (spare > 0 && sanitize(summary.unmetMw) > 0)) {
        warnings.push(`Duplicate generation creates stranded spare capacity (current estimate ${mw(stranded > 0 ? stranded : spare)}).`);
      }
    }

    // Switchgear observations (from authoritative design + tier data).
    for (const sg of Array.isArray(input.switchgear) ? input.switchgear : []) {
      if (sg.mode === "automatic") positives.push("Automatic tie can share spare generation when a priority-safe transfer exists.");
      const ratingSustained = sanitize(tierConfig(infrastructure, sg.ratingTier).sustainedCapacityMw);
      const maxAdjacent = Math.max(0, ...(sg.adjacentTiers || []).map((tier) => sanitize(tierConfig(infrastructure, tier).sustainedCapacityMw)));
      if (maxAdjacent > ratingSustained) {
        warnings.push(`Switchgear rating (${tierName(infrastructure, sg.ratingTier)}, ${mw(ratingSustained)} sustained) is below its surrounding cable capacity (${mw(maxAdjacent)}).`);
      }
    }

    // Data observations.
    const dataNetworks = Array.isArray(input.dataNetworks) ? input.dataNetworks : [];
    for (const network of dataNetworks) {
      if (sanitize(network.sectionCount) >= 3 && sanitize(network.alternatePaths) === 0) {
        warnings.push("Potential weakness: a Data network relies on a single vulnerable route.");
        break;
      }
    }
    if (input.dataSeparateFromPower === true) positives.push("Power and Data wiring do not occupy the same cells.");

    // Infrastructure share guidance (advisory only, never validation).
    const pct = sanitize(input.infrastructurePercentage) * 100;
    if (pct > 10) warnings.push(`Infrastructure cost is ${round2(pct)}% of total ship cost — high, but can be justified by Heavy trunks, ring routes or Switchgear protection.`);
    else if (pct > 0 && pct < 5) positives.push(`Infrastructure cost is ${round2(pct)}% of total ship cost — lower is cheaper but may indicate limited capacity or redundancy.`);

    // Branch isolation: tree branches only affect their own consumers.
    if (networks.length && !multiConsumerTrees.length && alternate > 0) {
      positives.push("Branch damage is unlikely to disable unrelated branches (based on the present Blueprint).");
    }
    return { positives, warnings };
  }

  // ------------------------------------------------------------------
  // Architecture comparison (prose; no numeric values).
  // ------------------------------------------------------------------
  const ARCHITECTURE_NOTES = Object.freeze([
    Object.freeze({ key: "central", label: "Central bus", benefits: "Cheapest, simplest, easy to understand when graph analysis shows a tree or shared trunk.", downsides: "Only a proven high-flow bridge or articulation point should be treated as a trunk vulnerability." }),
    Object.freeze({ key: "distributed", label: "Distributed grids", benefits: "Local damage isolation when each island has operational generation, demand and delivery.", downsides: "Duplicated generation and potentially stranded spare capacity." }),
    Object.freeze({ key: "ring", label: "Ring bus", benefits: "An alternate route can survive one relevant break.", downsides: "Increased cost and displacement; more cable installed." }),
    Object.freeze({ key: "hybrid", label: "Hybrid with Switchgear", benefits: "Independent grids with controlled spare sharing and isolation.", downsides: "Switchgear cost, space, rating limits and possible overload trips." })
  ]);
  const ARCHITECTURE_FACTS = Object.freeze([
    "Redundancy does not create free generation.",
    "Parallel routes do not automatically double usable capacity.",
    "Capacity remains limited by actual topology and bottlenecks.",
    "Switchgear is optional for ordinary branches."
  ]);

  const EMPTY_STATES = Object.freeze({
    noSelection: "Draw or select a route to compare tiers.",
    noLoadEstimate: "No live load estimate is available before deployment.",
    noPowerPath: "No Power path currently connects these components.",
    noAlternateRoute: "No alternate route detected.",
    dataNoPower: "Data cables do not carry Power.",
    incompleteRoute: "Heat estimate unavailable for an incomplete route."
  });

  return {
    POWER_TIER_ORDER,
    sanitize,
    round2,
    signedText,
    signedMoneyText,
    tierCards,
    toolSummary,
    cellChangeCounts,
    describeDrawPreview,
    tierChangeComparison,
    sectionInterpretation,
    alternatePathCount,
    sectionHasAlternateRoute,
    blueprintObservations,
    ARCHITECTURE_NOTES,
    ARCHITECTURE_FACTS,
    EMPTY_STATES
  };
}));
