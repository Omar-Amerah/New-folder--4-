(function (root, factory) {
  const instance = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = instance;
  }
  const g = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : root;
  if (g) g.PowerDiagnostics = instance;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const EPSILON = 0.0005;

  const CATEGORY_LABELS = {
    command: "Command & Core",
    propulsion: "Propulsion",
    shields: "Shields",
    weapons: "Weapons",
    pointDefence: "Point Defence",
    coolingSupport: "Cooling & Support",
    uncategorised: "Uncategorised"
  };

  const PRESET_LABELS = {
    balanced: "Balanced",
    combat: "Combat-First",
    defense: "Defense-First",
    mobility: "Mobility-First",
    custom: "Custom"
  };

  function formatMw(value) {
    const rounded = Math.round((Number(value) || 0) * 10) / 10;
    return `${rounded.toFixed(1)} MW`;
  }

  function categoryLabel(cat) {
    return CATEGORY_LABELS[cat] || (cat ? cat[0].toUpperCase() + cat.slice(1) : "System");
  }

  function policyLabel(preset) {
    return PRESET_LABELS[preset] || (preset ? preset[0].toUpperCase() + preset.slice(1) : "Power");
  }

  /**
   * Classify power delivery issue for a single component consumer or source.
   */
  function classifyPowerDeliveryIssue(options = {}) {
    const { componentEntry, network, flow } = options;
    if (!componentEntry || componentEntry.role !== "consumer") {
      return {
        cause: "none",
        consequence: null,
        unmetMw: 0,
        causeMessage: "No consumer demand",
        consequenceMessage: null,
        summaryLabel: "No demand"
      };
    }

    const requestedMw = Number(componentEntry.requestedMw) || 0;
    const allocatedMw = Number(componentEntry.allocatedMw) || 0;
    const unmetMw = Math.max(0, requestedMw - allocatedMw);

    if (componentEntry.state === "destroyed") {
      return {
        cause: "destroyed",
        consequence: null,
        unmetMw,
        causeMessage: "Component is destroyed or disabled.",
        consequenceMessage: null,
        summaryLabel: "Destroyed"
      };
    }

    const totalAvailableGen = Number(flow?.summary?.availableGenerationMw) || 0;
    const totalDemand = Number(flow?.summary?.demandMw) || 0;

    if (componentEntry.state === "disconnected" || !network || !componentEntry.networkIds?.length) {
      if (totalAvailableGen > EPSILON) {
        return {
          cause: "isolated-generator",
          consequence: null,
          unmetMw,
          causeMessage: "Additional generation exists elsewhere on the ship but is not connected to this Power network.",
          consequenceMessage: null,
          summaryLabel: "Isolated generation"
        };
      }
      return {
        cause: "no-route",
        consequence: null,
        unmetMw,
        causeMessage: "No completed Power route.",
        consequenceMessage: null,
        summaryLabel: "No completed route"
      };
    }

    if (unmetMw <= EPSILON) {
      return {
        cause: "none",
        consequence: null,
        unmetMw: 0,
        causeMessage: "Power demand supplied.",
        consequenceMessage: null,
        summaryLabel: "Fully powered"
      };
    }

    const netGen = Number(network.availableGenerationMw) || 0;
    const netDemand = Number(network.demandMw) || 0;
    const netShortfall = netDemand - netGen;

    let consequence = null;
    let consequenceMessage = null;
    const loadShedCats = flow?.summary?.loadShedCategories || [];
    if (componentEntry.powerCategory && loadShedCats.includes(componentEntry.powerCategory)) {
      consequence = "priority-load-shed";
      const catName = categoryLabel(componentEntry.powerCategory);
      const polName = policyLabel(flow?.summary?.preset);
      consequenceMessage = `${catName} was shed by the ${polName} Power policy after higher-priority demand was supplied.`;
    }

    // Determine root cause
    if (netGen + EPSILON < netDemand) {
      // Network has less generation than demand
      if (totalAvailableGen + EPSILON >= totalDemand) {
        // Total ship generation could satisfy total demand if connected!
        return {
          cause: "isolated-generator",
          consequence,
          unmetMw,
          causeMessage: "Additional generation exists elsewhere on the ship but is not connected to this Power network.",
          consequenceMessage,
          summaryLabel: "Isolated generation"
        };
      }
      return {
        cause: "generation-shortage",
        consequence,
        unmetMw,
        causeMessage: `This network needs ${formatMw(netShortfall)} more generation.`,
        consequenceMessage,
        summaryLabel: "Insufficient generation"
      };
    }

    // Network has enough generation (netGen >= netDemand), but power did not reach component
    return {
      cause: "cable-bottleneck",
      consequence,
      unmetMw,
      causeMessage: `Enough generation exists, but the current route cannot deliver ${formatMw(requestedMw)} to this component.`,
      consequenceMessage,
      summaryLabel: "Cable bottleneck"
    };
  }

  /**
   * Classify ship-wide power summary.
   */
  function classifyShipPowerSummary(flow, stats = {}) {
    if (!flow || !flow.summary) {
      return {
        hasShortfall: false,
        cause: "none",
        unmetMw: 0,
        spareMw: 0,
        strandedMw: 0,
        overviewLabel: "0.0 MW",
        statusLevel: "neutral",
        statusMessage: "No Power system"
      };
    }

    const summary = flow.summary;
    const unmetMw = Number(summary.unmetDemandMw ?? summary.unmetMw) || 0;
    const spareMw = Number(summary.spareGenerationMw) || 0;
    const strandedMw = Number(summary.strandedGenerationMw) || 0;
    const requestedMw = Number(summary.requestedDemandMw ?? summary.demandMw) || 0;

    if (unmetMw <= EPSILON) {
      return {
        hasShortfall: false,
        cause: "none",
        unmetMw: 0,
        spareMw,
        strandedMw,
        overviewLabel: requestedMw > 0 ? `${formatMw(spareMw)} spare` : "0.0 MW",
        statusLevel: requestedMw > 0 ? "good" : "neutral",
        statusMessage: requestedMw > 0 ? "Fully powered" : "No active Power demand"
      };
    }

    // We have unmet demand > 0
    const networks = flow.networks || [];
    const unmetNetworks = networks.filter((n) => Number(n.unmetMw) > EPSILON);

    // Every consumer that did not get what it asked for is classified, including
    // consumers attached to no network at all — a Blueprint with no cables has no
    // "unmet network" to iterate, and its shortfall must still be explained.
    const causes = new Set();
    (flow.byComponentIndex || [])
      .filter((c) => c.role === "consumer" && Number(c.unmetMw) > EPSILON && c.state !== "destroyed")
      .forEach((c) => {
        const network = networks.find((n) => (c.networkIds || []).includes(n.id)) || null;
        const diag = classifyPowerDeliveryIssue({ componentEntry: c, network, flow });
        if (diag.cause !== "none") causes.add(diag.cause);
      });

    let primaryCause = "generation-shortage";
    if (causes.size > 1) {
      primaryCause = "mixed";
    } else if (causes.size === 1) {
      primaryCause = [...causes][0];
    } else if (flow.summary.loadShedCategories?.length > 0) {
      primaryCause = "load-shedding";
    }

    // Affected systems text
    const affected = [];
    if (Number(stats.effectiveThrust || 0) > 0 || Number(stats.powerDebuff || 0) > 0) affected.push("engines");
    if (Number(stats.maxShield || 0) > 0) affected.push("shields");
    if (Number(stats.weaponDps || 0) > 0) affected.push("weapons");
    if (Number(stats.repairRate || 0) > 0) affected.push("repair");
    const affectedText = affected.length
      ? affected.length === 1 ? affected[0] : `${affected.slice(0, -1).join(", ")} and ${affected[affected.length - 1]}`
      : "systems";

    let overviewLabel = `${formatMw(unmetMw)} short`;
    let statusMessage = `${formatMw(unmetMw)} short · ${affectedText} reduced`;

    if (primaryCause === "mixed") {
      overviewLabel = `${formatMw(unmetMw)} undelivered`;
      statusMessage = `${formatMw(unmetMw)} undelivered across ${unmetNetworks.length || 2} Power issues`;
    } else if (primaryCause === "cable-bottleneck") {
      overviewLabel = `${formatMw(unmetMw)} bottleneck`;
      statusMessage = `${formatMw(unmetMw)} undelivered · wiring bottleneck`;
    } else if (primaryCause === "isolated-generator") {
      overviewLabel = `${formatMw(unmetMw)} undelivered`;
      statusMessage = `${formatMw(unmetMw)} undelivered · generator isolated`;
    } else if (primaryCause === "no-route") {
      overviewLabel = `${formatMw(unmetMw)} unrouted`;
      statusMessage = `${formatMw(unmetMw)} undelivered · no completed route`;
    } else if (primaryCause === "load-shedding") {
      overviewLabel = `${formatMw(unmetMw)} shed`;
      statusMessage = `Load shedding active · ${affectedText} reduced`;
    }

    return {
      hasShortfall: true,
      cause: primaryCause,
      unmetMw,
      spareMw,
      strandedMw,
      overviewLabel,
      statusLevel: "bad",
      statusMessage
    };
  }

  // ------------------------------------------------------------------
  // Authoritative Power-balance presentation.
  //
  // buildPowerBalanceView() is the ONE place a solvePowerFlow() result is turned
  // into the words and numbers the designer shows. The Ship summary Power card,
  // Power details, the Power-balance tooltip, the component hover card and the
  // wiring overlay all read this view, so they cannot contradict each other.
  //
  // No balance value is recomputed here: every figure is copied from the solver
  // summary/networks/byComponentIndex. The only arithmetic is the split of the
  // solver's stranded generation into "reachable spare" (already decided by the
  // solver) and the remainder that no network can use.
  // ------------------------------------------------------------------

  function isSolvedFlow(value) {
    return Boolean(value && value.summary && Array.isArray(value.byComponentIndex) && Array.isArray(value.networks));
  }

  function num(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }

  function buildPowerBalanceView(flow, options = {}) {
    if (!isSolvedFlow(flow)) return null;
    const summary = flow.summary;
    const partNames = options.partNames || {};
    const design = Array.isArray(options.design) ? options.design : [];
    const labelFor = (index) => {
      if (typeof options.componentLabel === "function") {
        const supplied = options.componentLabel(index);
        if (supplied) return String(supplied);
      }
      const type = design[index] && design[index].type;
      return (type && (partNames[type] && partNames[type].name)) || (type ? String(type) : `Component ${index}`);
    };

    const generationMw = num(summary.availableGenerationMw);
    const demandMw = num(summary.demandMw);
    const deliveredMw = num(summary.allocatedMw);
    const unmetMw = num(summary.unmetMw);
    // The solver already refuses to call generation "spare" on a network that
    // still has unmet demand; the guard keeps that promise ship-wide too.
    const reachableSpareMw = unmetMw > EPSILON ? 0 : num(summary.spareGenerationMw);
    // Generation the solver could not route to any demand at all. Reachable
    // spare is a subset of the solver's stranded total, so it is removed here
    // rather than counted twice.
    const strandedMw = Math.max(0, num(summary.strandedGenerationMw) - num(summary.spareGenerationMw));

    const hasShortfall = unmetMw > EPSILON;
    const fullyPowered = !hasShortfall && demandMw > EPSILON;
    // Cause comes from the same per-consumer classification the hover card uses,
    // so the card, the summary and the tooltip name one reason. "Generation
    // deficit" is claimed only when the ship genuinely generates less than the
    // demand it carries — an unrouted or bottlenecked grid is a different fault
    // even though its arithmetic also looks short.
    const classified = hasShortfall ? classifyShipPowerSummary(flow, options.stats || {}) : null;
    const generationDeficit = hasShortfall
      && generationMw + EPSILON < demandMw
      && (classified.cause === "generation-shortage" || classified.cause === "load-shedding");
    const deficitMw = generationDeficit ? unmetMw : 0;

    // Categories the active policy left unmet, and the components inside them.
    const byCategory = summary.byCategory || {};
    const loadShedCategories = (summary.loadShedCategories || []).slice();
    const consumers = flow.byComponentIndex.filter((entry) => entry.role === "consumer");
    const shedComponents = consumers
      .filter((entry) => num(entry.unmetMw) > EPSILON && entry.state !== "destroyed")
      .map((entry) => ({
        componentIndex: entry.componentIndex,
        label: labelFor(entry.componentIndex),
        category: entry.powerCategory || "uncategorised",
        categoryLabel: categoryLabel(entry.powerCategory || "uncategorised"),
        priorityBand: entry.priorityBand,
        requestedMw: num(entry.requestedMw),
        allocatedMw: num(entry.allocatedMw),
        unmetMw: num(entry.unmetMw),
        state: entry.state
      }))
      // Lowest priority (largest band index) first: the components the policy
      // gave up on before anything else.
      .sort((a, b) => (num(b.priorityBand) - num(a.priorityBand)) || (b.unmetMw - a.unmetMw) || (a.componentIndex - b.componentIndex));

    // Genuine priority load shedding is a decision taken INSIDE one network: a
    // lower-priority consumer went unmet while a higher-priority consumer
    // drawing on the same generation was supplied in full. Demand that is unmet
    // because it has no route to any generation — a disconnected component, or a
    // network whose generator is isolated — is a wiring fault, not a policy
    // decision, and reporting it as load shedding is what made the warning
    // appear on ships whose connected components were all powered.
    //
    // Comparing whole-ship category totals cannot tell those apart: it pairs a
    // category supplied on one network against a category stranded on another.
    const byNetwork = new Map();
    for (const entry of consumers) {
      if (num(entry.requestedMw) <= EPSILON || entry.state === "destroyed" || entry.priorityBand == null) continue;
      for (const networkId of entry.networkIds || []) {
        if (!byNetwork.has(networkId)) byNetwork.set(networkId, []);
        byNetwork.get(networkId).push(entry);
      }
    }
    const policyShedIndices = new Set();
    for (const group of byNetwork.values()) {
      const suppliedBands = group
        .filter((entry) => num(entry.unmetMw) <= EPSILON)
        .map((entry) => num(entry.priorityBand));
      if (!suppliedBands.length) continue;
      const bestSuppliedBand = Math.min(...suppliedBands);
      for (const entry of group) {
        if (num(entry.unmetMw) > EPSILON && num(entry.priorityBand) > bestSuppliedBand) {
          policyShedIndices.add(entry.componentIndex);
        }
      }
    }
    const policyShedComponents = shedComponents.filter((entry) => policyShedIndices.has(entry.componentIndex));
    const loadShedActive = policyShedComponents.length > 0;

    // The category the policy sacrificed first, and its components. Only
    // genuinely deprioritised components are named, never merely unrouted ones.
    const shedCategoryOrder = [...new Set(policyShedComponents.map((entry) => entry.category))]
      .sort((a, b) => num((byCategory[b] || {}).priorityBand) - num((byCategory[a] || {}).priorityBand));
    const lowestShedCategory = shedCategoryOrder[0] || null;
    const lowestShedComponents = lowestShedCategory
      ? policyShedComponents.filter((entry) => entry.category === lowestShedCategory)
      : [];

    const preset = summary.preset || null;
    const presetName = policyLabel(preset);
    const joinNames = (names) => names.length <= 1
      ? (names[0] || "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

    let explanation = null;
    if (loadShedActive && lowestShedCategory) {
      const names = joinNames(lowestShedComponents.map((entry) => entry.label));
      const wasWere = lowestShedComponents.length === 1 ? "was" : "were";
      explanation = names
        ? `${names} ${wasWere} shed because ${categoryLabel(lowestShedCategory)} is lower priority under the ${presetName} Power policy.`
        : `${categoryLabel(lowestShedCategory)} was shed because it is lower priority under the ${presetName} Power policy.`;
    } else if (generationDeficit) {
      explanation = `Available generation is ${formatMw(generationMw)} against ${formatMw(demandMw)} of connected demand, so ${formatMw(unmetMw)} could not be supplied.`;
    } else if (hasShortfall) {
      explanation = `${formatMw(unmetMw)} of connected demand was not delivered over the current Power routing.`;
    }

    // Category / component attribution for Power details.
    const loadShedLabels = shedCategoryOrder.map((cat) => categoryLabel(cat));
    const shedDetail = lowestShedComponents.length
      ? `${categoryLabel(lowestShedCategory)} — ${joinNames(lowestShedComponents.map((entry) => entry.label))}`
      : (loadShedLabels.join(", ") || null);

    // Ship-summary wording. "Fully powered" is reachable only with no unmet
    // demand; a spare figure is never published while demand is undelivered.
    let headline;
    let statusMessage;
    let statusLevel;
    if (!hasShortfall) {
      headline = demandMw > EPSILON ? `${formatMw(reachableSpareMw)} spare` : `${formatMw(generationMw)} generation`;
      statusMessage = demandMw > EPSILON ? "Fully powered" : "No active Power demand";
      statusLevel = demandMw > EPSILON ? "good" : "neutral";
    } else if (generationDeficit) {
      headline = `${formatMw(unmetMw)} generation deficit`;
      statusMessage = `${formatMw(unmetMw)} generation deficit`;
      statusLevel = "bad";
    } else {
      headline = classified.overviewLabel;
      statusMessage = classified.statusMessage;
      statusLevel = "bad";
    }

    // Explicit tooltip rows. Every row names what it is; none of them is a
    // nominal catalogue total.
    const balanceRows = [
      { id: "availableGeneration", label: "Available generation", value: formatMw(generationMw), tone: "" },
      { id: "activeDemand", label: "Active demand", value: formatMw(demandMw), tone: "" },
      { id: "delivered", label: "Delivered", value: formatMw(deliveredMw), tone: "" },
      { id: "unmet", label: "Unmet", value: formatMw(unmetMw), tone: hasShortfall ? "bad" : "" },
      { id: "reachableSpare", label: "Reachable spare", value: formatMw(reachableSpareMw), tone: reachableSpareMw > EPSILON ? "good" : "" }
    ];
    if (strandedMw > EPSILON) {
      balanceRows.push({ id: "strandedGeneration", label: "Stranded generation", value: formatMw(strandedMw), tone: "warning" });
    }

    const balanceHeadline = hasShortfall
      ? `Grid Deficit: ${formatMw(unmetMw)}`
      : `Grid Surplus: ${formatMw(reachableSpareMw)}`;

    return {
      authoritative: true,
      preset,
      presetName,
      generationMw,
      demandMw,
      deliveredMw,
      unmetMw,
      spareMw: reachableSpareMw,
      strandedMw,
      hasShortfall,
      fullyPowered,
      cause: classified ? classified.cause : "none",
      generationDeficit,
      deficitMw,
      loadShedActive,
      loadShedCategories,
      loadShedLabels,
      shedComponents,
      lowestShedCategory,
      lowestShedComponents,
      shedDetail,
      shedMessage: loadShedActive ? "Load shedding active" : null,
      headline,
      statusMessage,
      statusLevel,
      balanceHeadline,
      balanceRows,
      explanation,
      aboveSustainedSections: num(summary.aboveSustainedSections),
      atPeakSections: num(summary.atPeakSections)
    };
  }

  return {
    EPSILON,
    formatMw,
    categoryLabel,
    policyLabel,
    isSolvedFlow,
    buildPowerBalanceView,
    classifyPowerDeliveryIssue,
    classifyShipPowerSummary
  };
}));
