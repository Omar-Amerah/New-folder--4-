"use strict";

// Wiring cost/benefit clarity verifier. Confirms the presentation-layer
// clarity rules read authoritative balance/solver values, produce distinct
// per-tier guidance, correct upgrade/downgrade comparisons, supported
// observations, and that no tuning constants or gameplay formulas are
// duplicated into UI/clarity code. Presentation only — no Section 7 balance,
// allocation, Heat or overload behaviour is touched.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const clarity = require("./public/src/shared/wiringClarityRules.js");
const { BALANCE } = require("./src/server/balanceConfig");
const PowerFlowRules = require("./public/src/shared/powerFlowRules");
const WiringInfrastructureRules = require("./public/src/shared/wiringInfrastructureRules.js");
const PowerCableThermalRules = require("./public/src/shared/powerCableThermalRules.js");
const { PARTS } = require("./src/server/components");
const { createShipBlueprintSnapshot } = require("./src/server/shipDesign");

const infra = BALANCE.wiringInfrastructure;
let count = 0;
function check(name, fn) { fn(); count += 1; console.log(`  ok  ${count}. ${name}`); }

function finiteDeep(value, path = "value") {
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${path} must be finite, got ${value}`);
    assert(!Object.is(value, -0), `${path} must not be negative zero`);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => finiteDeep(item, `${path}[${i}]`));
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) finiteDeep(item, `${path}.${key}`);
  } else if (typeof value === "string") {
    assert(!/NaN|Infinity|undefined|-0\b/.test(value), `${path} string must not leak NaN/Infinity/undefined: "${value}"`);
  }
}

const UI_FILES = [
  "public/src/ui/wiringUi.js",
  "public/src/shared/wiringClarityRules.js"
];
function readFile(rel) { return fs.readFileSync(path.join(__dirname, rel), "utf8"); }

// ---- 1. tier cards read authoritative values ----
check("tier cards read authoritative balance values", () => {
  const cards = clarity.tierCards(infra);
  const byKey = Object.fromEntries(cards.map((c) => [c.key, c]));
  for (const tier of ["light", "standard", "heavy"]) {
    const cfg = infra.powerTiers[tier];
    assert.strictEqual(byKey[tier].sustainedMw, cfg.sustainedCapacityMw, `${tier} sustained`);
    assert.strictEqual(byKey[tier].peakMw, cfg.peakCapacityMw, `${tier} peak`);
    assert.strictEqual(byKey[tier].costPerCell, cfg.costPerHostedCell, `${tier} cost`);
    assert.strictEqual(byKey[tier].displacementPerCell, cfg.heatCapacityDisplacement, `${tier} displacement`);
    assert.strictEqual(byKey[tier].label, cfg.inspectionLabel, `${tier} label`);
  }
  assert.strictEqual(byKey.data.costPerCell, infra.data.costPerHostedCell);
  assert.strictEqual(byKey.data.displacementPerCell, infra.data.heatCapacityDisplacement);
  assert.strictEqual(byKey.data.sustainedMw, null, "Data card carries no capacity");
});

// ---- 2. no duplicate tier constants in UI code ----
check("no duplicate tier capacity/cost constants are hardcoded in UI code", () => {
  const capacityPairs = [["4", "7"], ["10", "16"], ["24", "36"]];
  for (const rel of UI_FILES) {
    const src = readFile(rel);
    for (const [s, p] of capacityPairs) {
      // A literal "4 / 7 MW" or "4 MW sustained / 7 MW" style constant would
      // duplicate the balance; the clarity module must template from config.
      const literal = new RegExp(`${s}\\s*/\\s*${p}\\s*MW`);
      assert(!literal.test(src), `${rel} must not hardcode the ${s}/${p} MW tier capacity`);
    }
  }
  // The clarity module holds no numeric tier table at all.
  const claritySrc = readFile("public/src/shared/wiringClarityRules.js");
  assert(!/sustainedCapacityMw\s*[:=]\s*\d/.test(claritySrc), "clarity module must not define its own capacity numbers");
  assert(!/costPerHostedCell\s*[:=]\s*\d/.test(claritySrc), "clarity module must not define its own cost numbers");
});

// ---- 3. distinct benefits and downsides per tier/Data ----
check("Light, Standard, Heavy and Data cards show distinct benefits and downsides", () => {
  const cards = clarity.tierCards(infra);
  const benefits = cards.map((c) => c.benefit);
  const downsides = cards.map((c) => c.downside);
  const bestFor = cards.map((c) => c.bestFor);
  assert.strictEqual(new Set(benefits).size, cards.length, "benefits distinct");
  assert.strictEqual(new Set(downsides).size, cards.length, "downsides distinct");
  assert.strictEqual(new Set(bestFor).size, cards.length, "best-for distinct");
  // No tier described as universally best.
  for (const card of cards) assert(!/\bbest\b/i.test(card.benefit + card.downside), "no 'best' superlative claim");
});

// ---- 4. selected-tool summary updates with the tool ----
check("selected-tool summary updates when the tool/mode changes", () => {
  const light = clarity.toolSummary(infra, "power", "light");
  const heavy = clarity.toolSummary(infra, "power", "heavy");
  const data = clarity.toolSummary(infra, "data", null);
  assert.notStrictEqual(light.title, heavy.title);
  assert.notStrictEqual(light.recommendation, heavy.recommendation);
  assert(light.capacityText.includes("4 / 7"), "light summary shows authoritative capacity");
  assert(heavy.capacityText.includes("24 / 36"));
  assert.strictEqual(data.capacityText, "Carries Data only");
  assert(/No capacity, Heat or overload/.test(data.warning));
  finiteDeep(light); finiteDeep(heavy); finiteDeep(data);
});

// ---- 5/6. live preview reports added/reused cells and cost/displacement deltas ----
check("live route preview reports added and reused cells, cost and displacement deltas", () => {
  const preview = { valid: true, delta: { totalInfrastructure: 3, displacement: 6 }, newPowerCells: 2 };
  const described = clarity.describeDrawPreview({ preview, infrastructure: infra, mode: "power", tier: "light", pathCellCount: 3, predictedRouteLoadMw: null });
  const joined = described.lines.join(" | ");
  assert(/New cells: 2/.test(joined), "reports new cells");
  assert(/Reused cells: 1/.test(joined), "reports reused cells (3 path - 2 new)");
  assert(/Cost \+\$3/.test(joined), "reports cost delta");
  assert(/Displacement \+6/.test(joined), "reports displacement delta");
  assert(/No live load estimate is available before deployment/.test(joined), "unavailable load falls back cleanly");
  finiteDeep(described);
});

// ---- 7. Light -> Standard comparison ----
check("Light -> Standard comparison reports correct capacity and cost deltas", () => {
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "light", toTier: "standard",
    preview: { delta: { totalInfrastructure: 2, displacement: 4 } },
    currentSectionFlow: { absoluteFlowMw: 3, sustainedCapacityMw: 4, peakCapacityMw: 7 },
    proposedSectionFlow: { absoluteFlowMw: 3, sustainedCapacityMw: 10, peakCapacityMw: 16 },
    weakerTierRemainsOnRoute: false, currentCableHeatRate: 0.5, proposedCableHeatRate: 0.1
  });
  assert.strictEqual(cmp.delta.sustainedMw, 6, "10 - 4");
  assert.strictEqual(cmp.delta.peakMw, 9, "16 - 7");
  assert.strictEqual(cmp.delta.costPerCell, 1, "2 - 1");
  assert.strictEqual(cmp.delta.displacementPerCell, 2, "4 - 2");
  assert.strictEqual(cmp.upgrade, true);
});

// ---- 8. Standard -> Heavy comparison ----
check("Standard -> Heavy comparison reports correct capacity and cost deltas", () => {
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "standard", toTier: "heavy",
    preview: { delta: { totalInfrastructure: 3, displacement: 4 } },
    currentSectionFlow: { absoluteFlowMw: 12, sustainedCapacityMw: 10, peakCapacityMw: 16, aboveSustained: true },
    proposedSectionFlow: { absoluteFlowMw: 12, sustainedCapacityMw: 24, peakCapacityMw: 36 },
    weakerTierRemainsOnRoute: false, currentCableHeatRate: 1, proposedCableHeatRate: 0.3
  });
  assert.strictEqual(cmp.delta.sustainedMw, 14, "24 - 10");
  assert.strictEqual(cmp.delta.peakMw, 20, "36 - 16");
  assert.strictEqual(cmp.delta.costPerCell, 3, "5 - 2");
  assert(/Useful upgrade/.test(cmp.verdict), "above-sustained flow makes the upgrade useful");
});

// ---- 9. downgrade comparison ----
check("downgrade comparison reports savings and lost capacity", () => {
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "heavy", toTier: "standard",
    preview: { delta: { totalInfrastructure: -3, displacement: -4 } },
    currentSectionFlow: { absoluteFlowMw: 4, sustainedCapacityMw: 24, peakCapacityMw: 36 },
    proposedSectionFlow: { absoluteFlowMw: 4, sustainedCapacityMw: 10, peakCapacityMw: 16 },
    weakerTierRemainsOnRoute: false, currentCableHeatRate: 0.1, proposedCableHeatRate: 0.2
  });
  assert.strictEqual(cmp.upgrade, false);
  assert.strictEqual(cmp.delta.sustainedMw, -14, "lost sustained capacity");
  assert.strictEqual(cmp.delta.costPerCell, -3, "cost saving");
  assert(/Lost capacity/.test(cmp.drawback), "names lost capacity");
  assert(/Saves \$3/.test(cmp.verdict), "names cost saving when load is safe");
});

// ---- 10. bottleneck warning persists when a weaker section remains ----
check("bottleneck warning remains when another weaker section exists on the route", () => {
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "light", toTier: "heavy",
    preview: { delta: { totalInfrastructure: 4, displacement: 6 } },
    currentSectionFlow: { absoluteFlowMw: 6, sustainedCapacityMw: 4, peakCapacityMw: 7, aboveSustained: true },
    proposedSectionFlow: { absoluteFlowMw: 6, sustainedCapacityMw: 24, peakCapacityMw: 36 },
    weakerTierRemainsOnRoute: true, routeEvidenceAvailable: true, currentCableHeatRate: 1.3, proposedCableHeatRate: 0.1
  });
  assert(/Limited elsewhere/.test(cmp.verdict), "warns another weaker section still limits the route");
});

// ---- 11. useful upgrade identified when load exceeds sustained ----
check("useful upgrade is identified when current load exceeds sustained capacity", () => {
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "light", toTier: "standard",
    preview: { delta: { totalInfrastructure: 2, displacement: 4 } },
    currentSectionFlow: { absoluteFlowMw: 7, sustainedCapacityMw: 4, peakCapacityMw: 7, atPeak: true },
    proposedSectionFlow: { absoluteFlowMw: 7, sustainedCapacityMw: 10, peakCapacityMw: 16 },
    weakerTierRemainsOnRoute: false, currentCableHeatRate: 1.4, proposedCableHeatRate: 0.3
  });
  assert(/Useful upgrade/.test(cmp.verdict));
});

// ---- 12. lightly loaded Heavy route presented as wasteful ----
check("lightly loaded Heavy route upgrade is presented as potentially wasteful", () => {
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "standard", toTier: "heavy",
    preview: { delta: { totalInfrastructure: 3, displacement: 4 } },
    currentSectionFlow: { absoluteFlowMw: 1.8, sustainedCapacityMw: 10, peakCapacityMw: 16, aboveSustained: false },
    proposedSectionFlow: { absoluteFlowMw: 1.8, sustainedCapacityMw: 24, peakCapacityMw: 36 },
    weakerTierRemainsOnRoute: false, currentCableHeatRate: 0.05, proposedCableHeatRate: 0.02
  });
  assert(/Likely unnecessary/.test(cmp.verdict), "low load flags an unnecessary upgrade");
});

// ---- 13. incomplete routes use unavailable states ----
check("incomplete routes and missing data use clear unavailable states", () => {
  const states = clarity.EMPTY_STATES;
  finiteDeep(states);
  assert(states.noSelection && states.noLoadEstimate && states.incompleteRoute && states.noAlternateRoute && states.dataNoPower && states.noPowerPath);
  // A section with no solved flow yields a "no Power path" interpretation.
  const interp = clarity.sectionInterpretation({ flow: null, disabled: false, isBottleneck: false, hasAlternateRoute: false });
  assert(interp.includes("No alternate route detected."));
  // Heat unavailable for an incomplete route in draw comparison uses the state.
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "light", toTier: "standard",
    preview: { delta: { totalInfrastructure: 2, displacement: 4 } },
    currentSectionFlow: null, proposedSectionFlow: null,
    weakerTierRemainsOnRoute: false, currentCableHeatRate: null, proposedCableHeatRate: null
  });
  assert.strictEqual(cmp.current.cableHeatRate, null, "no Heat rate without a solved flow");
  assert.strictEqual(cmp.current.utilisation, null, "no utilisation without a solved flow");
});

// Build a real design + wiring for accounting-based checks.
function overlapDesign() {
  const design = [
    { type: "core", x: 0, y: 0, rotation: 0 },
    { type: "fireControl", x: 1, y: 0, rotation: 0 },
    { type: "blaster", x: 2, y: 0, rotation: 0 }
  ];
  const wiring = {
    version: 3,
    power: { sections: [
      { id: "0,0:1,0", x1: 0, y1: 0, x2: 1, y2: 0, tier: "standard" },
      { id: "1,0:2,0", x1: 1, y1: 0, x2: 2, y2: 0, tier: "light" }
    ], connections: [] },
    data: { sections: [{ id: "1,0:2,0", x1: 1, y1: 0, x2: 2, y2: 0, tier: "standard" }], connections: [] },
    powerPolicy: { preset: "balanced", customOrder: ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"] }
  };
  return createShipBlueprintSnapshot(design, wiring);
}

// ---- 14/15. infrastructure summary separates costs and uses total ship cost ----
check("infrastructure summary separates Power, Data and Switchgear and uses total ship cost", () => {
  const { design, wiring } = overlapDesign();
  const acc = WiringInfrastructureRules.accountInfrastructure(design, wiring, PARTS, infra);
  // Power: standard(2) + light(1) unique cells... computed authoritatively.
  assert(acc.power.cost > 0 && acc.data.cost > 0, "Power and Data costs reported separately");
  const presentation = WiringInfrastructureRules.infrastructureCostPresentation(500, acc.power.cost, acc.data.cost);
  assert.strictEqual(presentation.totalInfrastructure, acc.power.cost + acc.data.cost);
  const expectedPct = presentation.totalInfrastructure / (500 + presentation.totalInfrastructure);
  assert(Math.abs(presentation.infrastructurePercentage - expectedPct) < 1e-9, "percentage uses total ship cost");
  // The wiring UI renders these as separate labelled rows.
  const src = readFile("public/src/ui/wiringUi.js");
  assert(/Power wiring \$\$\{acc\.power\.cost\}/.test(src) && /Data wiring \$\$\{acc\.data\.cost\}/.test(src) && /Switchgear components \$\$\{switchgearCost\}/.test(src), "UI renders separated infrastructure costs");
});

// ---- 16. 5-10% guidance is advisory ----
check("5-10% infrastructure guidance is advisory, not validation", () => {
  const src = readFile("public/src/ui/wiringUi.js");
  const designerSrc = fs.readFileSync(path.join(__dirname, "public/src/ui/designerUi.js"), "utf8");
  assert(/around 5–10%/.test(src) || /around 5-10%/.test(src), "wiring panel shows advisory range");
  assert(/around 5–10%/.test(designerSrc) || /around 5-10%/.test(designerSrc), "cost summary shows advisory range");
  // Guidance never gates a build: no 'invalid'/'blocked' language tied to the range.
  assert(!/invalid.*5.?10%|5.?10%.*invalid/i.test(src + designerSrc), "range is never a validation rule");
});

// ---- 17/18. unique cells not double-counted; Power/Data overlap independent ----
check("unique cells are not double-counted and Power/Data overlap costs stay independent", () => {
  const { design, wiring } = overlapDesign();
  const acc = WiringInfrastructureRules.accountInfrastructure(design, wiring, PARTS, infra);
  // 3 unique Power host cells (0,0 / 1,0 / 2,0), each counted once.
  assert.strictEqual(acc.power.uniqueHostedCellCount, 3);
  // Data occupies 1,0 and 2,0 independently — its cost is separate from Power.
  assert.strictEqual(acc.data.uniqueHostedCellCount, 2);
  const overlapCell = acc.byComponentIndex[1];
  assert(overlapCell.hostedStandardCells >= 1 && overlapCell.hostedDataCells === 1, "shared cell hosts both kinds, counted per kind");
  assert.strictEqual(acc.data.cost, 2 * infra.data.costPerHostedCell, "Data cost independent of Power");
});

// ---- 19. architecture summaries show benefits and downsides ----
check("architecture summaries list benefits and downsides for all four families", () => {
  const notes = clarity.ARCHITECTURE_NOTES;
  const keys = notes.map((n) => n.key);
  for (const family of ["central", "distributed", "ring", "hybrid"]) assert(keys.includes(family), `has ${family}`);
  for (const note of notes) { assert(note.benefits && note.downsides, `${note.key} has both`); }
  const facts = clarity.ARCHITECTURE_FACTS.join(" ");
  assert(/Redundancy does not create free generation/.test(facts));
  assert(/do not automatically double usable capacity/.test(facts));
  assert(/Switchgear is optional/.test(facts));
});

// ---- 20/21. observations only when supported by topology ----
check("central-bus vulnerability and alternate-route benefit show only when supported", () => {
  // A single multi-consumer tree network (no cycles) -> vulnerability warning.
  const treeObs = clarity.blueprintObservations({
    infrastructure: infra, sectionFlows: [], flowSummary: {}, sectionTierById: {},
    powerNetworks: [{ consumerCount: 3, alternatePaths: 0, highFlowBridgeCount: 1, bridgeSharedDemandMw: 6 }], dataNetworks: [], switchgear: [],
    alternatePaths: 0, infrastructurePercentage: 0.06, dataSeparateFromPower: false
  });
  assert(treeObs.warnings.some((w) => /central-trunk vulnerability/.test(w)), "vulnerability shown for tree");
  assert(!treeObs.positives.some((p) => /Alternate Power path/.test(p)), "no alternate-path claim without a loop");
  // A ring network -> alternate path positive, no single-vuln warning.
  const ringObs = clarity.blueprintObservations({
    infrastructure: infra, sectionFlows: [], flowSummary: {}, sectionTierById: {},
    powerNetworks: [{ consumerCount: 3, alternatePaths: 1, availableGenerationMw: 12, demandMw: 6 }], dataNetworks: [], switchgear: [],
    alternatePaths: 1, infrastructurePercentage: 0.06, dataSeparateFromPower: false
  });
  assert(ringObs.positives.some((p) => /Alternate Power path/.test(p)), "alternate path shown for a real loop");
  assert(ringObs.positives.some((p) => /do not double usable capacity/.test(p)), "reminds redundancy is not free capacity");
});

// ---- 22. distributed spare-generation warning uses authoritative data ----
check("distributed spare-generation warning uses authoritative generation/allocation data", () => {
  const obs = clarity.blueprintObservations({
    infrastructure: infra, sectionFlows: [], flowSummary: { strandedGenerationMw: 7.1, spareGenerationMw: 7.1, unmetMw: 0 },
    sectionTierById: {}, powerNetworks: [{ consumerCount: 1, alternatePaths: 0, availableGenerationMw: 8, demandMw: 3 }, { consumerCount: 1, alternatePaths: 0, availableGenerationMw: 8, demandMw: 3 }],
    dataNetworks: [], switchgear: [], alternatePaths: 0, infrastructurePercentage: 0.04, dataSeparateFromPower: false
  });
  assert(obs.positives.some((p) => /Independent powered grids/.test(p)));
  assert(obs.warnings.some((w) => /stranded spare capacity.*7\.1 MW/.test(w)), "uses the supplied stranded MW value");
});

// ---- 23/24/25. section interpretation for Power vs Data vs disabled ----
check("selected Power section interpretation covers capacity, disabled and bottleneck states", () => {
  const above = clarity.sectionInterpretation({ flow: { absoluteFlowMw: 6, sustainedCapacityMw: 4, peakCapacityMw: 7, aboveSustained: true, atPeak: false }, disabled: false, isBottleneck: true, hasAlternateRoute: false });
  assert(above.some((s) => /Above sustained/.test(s)));
  assert(above.some((s) => /limiting delivery/.test(s)));
  const peak = clarity.sectionInterpretation({ flow: { absoluteFlowMw: 7, sustainedCapacityMw: 4, peakCapacityMw: 7, atPeak: true }, disabled: false, isBottleneck: false, hasAlternateRoute: true });
  assert(peak.some((s) => /At peak: additional demand will be shed/.test(s)));
  assert(peak.some((s) => /alternate route/.test(s)));
  const disabled = clarity.sectionInterpretation({ flow: null, disabled: true, isBottleneck: false, hasAlternateRoute: false });
  assert.deepStrictEqual(disabled, ["Disabled because its host component is destroyed."]);
  const comfortable = clarity.sectionInterpretation({ flow: { absoluteFlowMw: 1, sustainedCapacityMw: 10, peakCapacityMw: 16 }, disabled: false, isBottleneck: false, hasAlternateRoute: false });
  assert(comfortable.some((s) => /Comfortably below sustained/.test(s)));
});
check("selected Data section shows cost/displacement but no Power-capacity or Heat rows", () => {
  const src = readFile("public/src/ui/wiringUi.js");
  // Data-section clarity renders cost/displacement + the no-Power note only.
  assert(/data-data-section-cost/.test(src) && /data-data-section-note/.test(src), "Data section renders cost + note");
  const dataBlock = src.slice(src.indexOf("data-data-section-cost") - 400, src.indexOf("data-data-section-note") + 200);
  assert(!/sustainedCapacityMw|peakCapacityMw|cableHeat/i.test(dataBlock), "Data section block adds no Power-capacity or Heat rows");
  assert(/No capacity, Heat or overload mechanics/.test(src));
});

// ---- 26. Switchgear cost and rating limitation shown ----
check("Switchgear cost and rating limitations are clearly shown", () => {
  const obs = clarity.blueprintObservations({
    infrastructure: infra, sectionFlows: [], flowSummary: {}, sectionTierById: {}, powerNetworks: [],
    dataNetworks: [], switchgear: [{ index: 4, mode: "closed", ratingTier: "light", adjacentTiers: ["standard", "heavy"] }],
    alternatePaths: 0, infrastructurePercentage: 0.05, dataSeparateFromPower: false
  });
  assert(obs.warnings.some((w) => /Switchgear rating.*below its surrounding cable capacity/.test(w)), "rating-below-cable warned");
  const src = readFile("public/src/ui/wiringUi.js");
  assert(/Switchgear components \$\$\{switchgearCost\}/.test(src), "wiring panel shows Switchgear component cost");
});

// ---- 27. all values finite and sanitised ----
check("all clarity outputs remain finite and sanitised", () => {
  finiteDeep(clarity.tierCards(infra), "tierCards");
  finiteDeep(clarity.toolSummary(infra, "power", "heavy"), "toolSummary");
  // Hostile inputs sanitise rather than leak NaN/Infinity/-0.
  const bad = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "light", toTier: "standard",
    preview: { delta: { totalInfrastructure: NaN, displacement: Infinity } },
    currentSectionFlow: { absoluteFlowMw: -0, sustainedCapacityMw: 0, peakCapacityMw: 0 },
    proposedSectionFlow: null, weakerTierRemainsOnRoute: false,
    currentCableHeatRate: NaN, proposedCableHeatRate: undefined
  });
  finiteDeep({ delta: bad.delta, current: { ...bad.current, cableHeatRate: bad.current.cableHeatRate ?? 0, utilisation: bad.current.utilisation ?? 0 } }, "badComparison");
  assert.strictEqual(clarity.sanitize(-0), 0);
  assert.strictEqual(clarity.sanitize(NaN, 5), 5);
});

// ---- 28. no balance values change ----
check("no Section 7 balance values changed", () => {
  const t = infra.powerTiers;
  assert.deepStrictEqual([t.light.sustainedCapacityMw, t.light.peakCapacityMw, t.light.costPerHostedCell, t.light.heatCapacityDisplacement], [4, 7, 1, 2]);
  assert.deepStrictEqual([t.standard.sustainedCapacityMw, t.standard.peakCapacityMw, t.standard.costPerHostedCell, t.standard.heatCapacityDisplacement], [10, 16, 2, 4]);
  assert.deepStrictEqual([t.heavy.sustainedCapacityMw, t.heavy.peakCapacityMw, t.heavy.costPerHostedCell, t.heavy.heatCapacityDisplacement], [24, 36, 5, 8]);
  assert.deepStrictEqual([infra.data.costPerHostedCell, infra.data.heatCapacityDisplacement], [0.25, 1]);
  assert.strictEqual(t.light.cableHeatUtilisationExponent, 2.2);
});

// ---- 29. no production allocation/Heat/overload formula duplicated ----
check("no production allocation, Heat or overload formula is duplicated in clarity code", () => {
  const src = readFile("public/src/shared/wiringClarityRules.js");
  // The clarity module must not re-implement the cable-Heat power curve, the
  // overload stress accumulation, or a max-flow allocator.
  assert(!/Math\.pow\([^)]*utilisation/i.test(src), "no cable-Heat power curve");
  assert(!/baseStressPerSecond|additionalStressPerSecondAtPeak|deltaSeconds/.test(src), "no overload stress formula");
  assert(!/maxflow|augmenting|residual/i.test(src), "no allocation solver");
  // Clarity does not require the solver/thermal modules directly (it consumes
  // their results passed in by the caller).
  assert(!/require\(.*powerFlowRules|require\(.*powerCableThermalRules|require\(.*powerProtectionRules/.test(src), "clarity does not import gameplay solvers");
});

// ---- 30/31. editing + Undo behaviour untouched ----
check("clarity code introduces no Blueprint mutation or Undo change", () => {
  const claritySrc = readFile("public/src/shared/wiringClarityRules.js");
  // Pure presentation module: no persistence, undo, or wiring-edit calls.
  assert(!/persistDesign|pushUndo|undoStack|commitWiring|addPathWithTier|setSectionTier|removeSection/.test(claritySrc), "clarity performs no edits");
  const uiSrc = readFile("public/src/ui/wiringUi.js");
  // The clarity render helpers never mutate wiring: they only read state.
  const renderBlock = uiSrc.slice(uiSrc.indexOf("function renderStaticClarity"), uiSrc.indexOf("function refreshToolbar"));
  assert(!/pushUndo|commitWiring|persistDesign|state\.wiring\s*=/.test(renderBlock), "clarity rendering never mutates wiring or Undo");
});

// ---- 32. no touch/mobile behaviour ----
check("no touch or mobile-specific behaviour is added", () => {
  // The new clarity module is pure presentation: no pointer/touch handlers.
  const claritySrc = readFile("public/src/shared/wiringClarityRules.js").toLowerCase();
  for (const token of ["touchstart", "touchend", "touchmove", "longpress", "long-press", "swipe", "gesture", "pointerdown", "pointermove", "addeventlistener"]) {
    assert(!claritySrc.includes(token), `clarity module must not add ${token} behaviour`);
  }
  // The wiring UI keeps its pre-existing desktop mouse/pen drag drawing
  // (pointerdown is guarded against pointerType === "touch"); the clarity pass
  // must not introduce genuinely touch/pen/mobile-specific interactions.
  const uiSrc = readFile("public/src/ui/wiringUi.js").toLowerCase();
  for (const token of ["touchstart", "touchend", "touchmove", "longpress", "long-press", "swipe", "gesture", "pen-only", "maxtouchpoints"]) {
    assert(!uiSrc.includes(token), `wiring UI must not add ${token} behaviour`);
  }
  assert(uiSrc.includes('pointertype === "touch"') || uiSrc.includes("pointertype !== \"mouse\""), "pre-existing pointer drawing still guards against touch");
});

// ---- Bonus: end-to-end parity with the authoritative cable-Heat rule ----
check("comparison Heat values match PowerCableThermalRules exactly", () => {
  const flow = { sectionId: "s", tier: "light", absoluteFlowMw: 6, signedFlowMw: 6, sustainedCapacityMw: 4, peakCapacityMw: 7, aboveSustained: true };
  const expected = PowerCableThermalRules.cableHeatRateForSection(flow, infra.powerTiers.light) * 2;
  const cmp = clarity.tierChangeComparison({
    infrastructure: infra, fromTier: "light", toTier: "standard",
    preview: { delta: { totalInfrastructure: 2, displacement: 4 } },
    currentSectionFlow: flow, proposedSectionFlow: null, weakerTierRemainsOnRoute: false,
    currentCableHeatRate: expected, proposedCableHeatRate: null
  });
  assert.strictEqual(cmp.current.cableHeatRate, clarity.round2(expected), "displayed Heat is the authoritative rate, not a UI re-derivation");
});

console.log(`\nWiring cost/benefit clarity verification passed (${count} checks).`);
