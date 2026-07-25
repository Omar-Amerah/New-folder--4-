"use strict";
// Blueprint Designer Power reporting — one authority, no contradictions.
//
// Regression cover for the defect where the Ship summary Power card, the Power
// details section and the Power-balance tooltip each read a DIFFERENT source:
//
//   * the Ship summary read the thermal scenario's solve (scenario activity
//     demand, overheat-degraded generation),
//   * the wiring overlay and hover card read the authoritative Blueprint solve
//     (nominal demand, intact generation),
//   * the Power-balance tooltip read neither and simply printed
//     stats.powerGeneration - stats.powerUse as "Grid Surplus".
//
// A single ship could therefore claim 17.2 MW generated, 19.0 MW demand, an
// unpowered Signal Amplifier, 3.7 MW spare and "Fully powered" at once.
//
// Every check below reads solveBlueprintPower() / PowerFlowRules.solvePowerFlow()
// and asserts the presentation never contradicts it. No balance value, priority
// policy or allocation formula is exercised or asserted here beyond confirming
// the solver's own numbers survive unchanged into the words shown.

const assert = require("assert");

const HeatRules = require("./public/src/shared/heatRules");
const WiringRules = require("./public/src/shared/wiringRules");
const DataRules = require("./public/src/shared/dataSupportRules");
const EngineExhaust = require("./public/src/shared/engineExhaust");
const PowerPolicyRules = require("./public/src/shared/powerPolicyRules");
const PowerAllocationRules = require("./public/src/shared/powerAllocationRules");
const PowerDemandRules = require("./public/src/shared/powerDemandRules");
const PowerFlowRules = require("./public/src/shared/powerFlowRules");
const WiringInfra = require("./public/src/shared/wiringInfrastructureRules");
const PowerCableThermalRules = require("./public/src/shared/powerCableThermalRules");
const TurretRules = require("./public/src/shared/turretRules");
const PowerDiagnostics = require("./public/src/shared/powerDiagnostics");

globalThis.HeatRules = HeatRules;
globalThis.WiringRules = WiringRules;
globalThis.DataSupportRules = DataRules;
globalThis.EngineExhaustRules = EngineExhaust;
globalThis.PowerPolicyRules = PowerPolicyRules;
globalThis.PowerAllocationRules = PowerAllocationRules;
globalThis.PowerDemandRules = PowerDemandRules;
globalThis.PowerFlowRules = PowerFlowRules;
globalThis.WiringInfrastructureRules = WiringInfra;
globalThis.PowerCableThermalRules = PowerCableThermalRules;
globalThis.TurretRules = TurretRules;
globalThis.PowerDiagnostics = PowerDiagnostics;

global.document = { createElement: () => ({ getContext: () => ({}), style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }), createElementNS: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, documentElement: { style: { setProperty() {} } }, body: { classList: { add() {}, remove() {} } } };
global.window = { devicePixelRatio: 1, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.localStorage = { getItem: () => null, setItem: () => {} };

const EPS = PowerDiagnostics.EPSILON;
let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }
const at = (type, x, y, rotation = 0) => ({ type, x, y, rotation });
const mwText = (value) => `${(Math.round(Number(value) * 10) / 10).toFixed(1)} MW`;

(async () => {
  const { computeStats } = await import("./public/src/design/componentStats.js");
  const { PART_STATS, PART_DEFS } = await import("./public/src/design/parts.js");
  const { WIRING_INFRASTRUCTURE } = await import("./public/src/constants.js");
  const { solveBlueprintPower } = await import("./public/src/design/powerAllocationAnalysis.js");
  const { buildShipSummaryModel, resolvePowerSummary } = await import("./public/src/design/shipSummaryModel.js");

  /** Draw one Heavy trunk through the listed cells (no bottleneck of its own). */
  function trunk(wiring, design, cells) {
    return WiringRules.addPathWithTier(wiring, "power", cells, design, PART_STATS, "heavy");
  }
  function row(y, fromX, toX) {
    const cells = [];
    for (let x = fromX; x <= toX; x += 1) cells.push({ x, y });
    return cells;
  }
  function build(design, wiring) {
    const stats = computeStats(design, { wiring });
    const flow = solveBlueprintPower(design, wiring, PART_STATS, WIRING_INFRASTRUCTURE);
    const model = buildShipSummaryModel(stats, { design, powerSummary: flow, partNames: PART_DEFS });
    const view = PowerDiagnostics.buildPowerBalanceView(flow, { design, partNames: PART_DEFS, stats });
    return { stats, flow, model, view, power: model.power };
  }
  const detail = (model, id) => model.sections.find((s) => s.id === "power")?.rows.find((r) => r.id === id) || null;
  const statusIds = (model) => model.status.map((m) => m.id);
  const statusText = (model, id) => model.status.find((m) => m.id === id)?.text || null;

  // -------------------------------------------------------------------------
  // Fixture A — the reported ship. Generation below demand, with the
  // lowest-priority support component shed by the active policy.
  //
  //   generation  auxGenerator 3.2 + core 4.0 + reactor 10.0 = 17.2 MW
  //   demand      shield 3.5 + pointDefense 5.5 + flakCannon 3.3
  //               + missile 3.7 + signalAmplifier 3.0          = 19.0 MW
  // -------------------------------------------------------------------------
  const SHED_DESIGN = [
    at("auxGenerator", 1, 7),
    at("core", 2, 7),
    at("reactor", 3, 7),
    at("shield", 5, 7),
    at("pointDefense", 6, 7),
    at("flakCannon", 7, 7),
    at("missile", 8, 7),
    at("signalAmplifier", 9, 7)
  ];
  const shed = build(SHED_DESIGN, trunk(WiringRules.emptyWiring(), SHED_DESIGN, row(7, 1, 9)));

  check("the fixture reproduces generation below demand with a shed low-priority component", () => {
    const summary = shed.flow.summary;
    assert.equal(summary.availableGenerationMw, 17.2, "17.2 MW of reachable generation");
    assert.equal(summary.demandMw, 19, "19.0 MW of connected active demand");
    assert.equal(summary.allocatedMw, 17.2, "all reachable generation is delivered");
    assert.equal(summary.unmetMw, 1.8, "1.8 MW of demand is left unmet");
    const amplifier = shed.flow.byComponentIndex.find((entry) => SHED_DESIGN[entry.componentIndex].type === "signalAmplifier");
    assert.ok(amplifier.unmetMw > EPS, "the Signal Amplifier is the component left short");
    assert.deepEqual(summary.loadShedCategories, ["coolingSupport"], "only Cooling & Support is shed");
    // Higher-priority categories keep exactly what the solver gave them.
    for (const cat of ["shields", "pointDefence", "weapons"]) {
      assert.equal(summary.byCategory[cat].unmetMw, 0, `${cat} is supplied in full`);
    }
  });

  check("the Ship summary never claims Fully powered while unmet demand is positive", () => {
    assert.ok(shed.power.unmet > EPS, "the fixture has unmet demand");
    assert.equal(shed.power.fullyPowered, false, "the resolved Power view is not fully powered");
    assert.equal(statusIds(shed.model).includes("power-ok"), false, "no Fully powered status line");
    for (const message of shed.model.status) {
      assert.doesNotMatch(message.text, /fully powered/i, `"${message.text}" does not claim full Power`);
    }
    assert.doesNotMatch(shed.power.overviewText, /fully powered/i, "the Power card headline does not claim full Power");
  });

  check("no positive spare value is published while the same network has unmet demand", () => {
    // The single network carries both the delivered load and the shortfall.
    assert.equal(shed.flow.networks.length, 1, "one Power network");
    assert.ok(shed.flow.networks[0].unmetMw > EPS, "that network has unmet demand");
    assert.equal(shed.power.spare, 0, "resolved spare Power is zero");
    assert.equal(shed.view.spareMw, 0, "the shared balance view reports zero reachable spare");
    assert.equal(detail(shed.model, "power.spare"), null, "Power details renders no spare row");
    const spareRow = shed.view.balanceRows.find((r) => r.id === "reachableSpare");
    assert.equal(spareRow.value, "0.0 MW", "the tooltip reachable-spare row reads zero");
    for (const message of shed.model.status) {
      assert.doesNotMatch(message.text, /spare/i, `"${message.text}" does not offer spare Power`);
    }
  });

  check("the shortfall is worded as a generation deficit, never a negative surplus", () => {
    assert.equal(shed.power.overviewText, "1.8 MW generation deficit", "Power card headline");
    assert.equal(statusText(shed.model, "power-short"), "1.8 MW generation deficit", "Power status line");
    assert.equal(shed.view.balanceHeadline, "Grid Deficit: 1.8 MW", "tooltip headline");
    assert.doesNotMatch(shed.view.balanceHeadline, /surplus/i, "the tooltip does not say surplus");
    // A negative MW figure is exactly the presentation this replaces.
    const rendered = [shed.power.overviewText, shed.view.balanceHeadline, ...shed.view.balanceRows.map((r) => `${r.label}: ${r.value}`)];
    for (const line of rendered) assert.doesNotMatch(line, /-\d/, `"${line}" carries no negative MW value`);
  });

  check("load shedding is reported and the affected category and component are named", () => {
    assert.equal(shed.power.loadShedActive, true, "load shedding is active");
    assert.equal(statusText(shed.model, "power-shed"), "Load shedding active", "the status line states load shedding");
    const shedRow = detail(shed.model, "power.shed");
    assert.ok(shedRow, "Power details carries a Load shed row");
    assert.match(shedRow.value, /Cooling & Support/, "names the category");
    assert.match(shedRow.value, /Signal Amplifier/, "names the component");
    assert.equal(shed.view.explanation,
      "Signal Amplifier was shed because Cooling & Support is lower priority under the Balanced Power policy.",
      "the tooltip explains the priority decision");
  });

  check("the tooltip uses explicit rows and never calls undelivered demand consumed", () => {
    assert.deepEqual(shed.view.balanceRows.map((r) => r.label),
      ["Available generation", "Active demand", "Delivered", "Unmet", "Reachable spare"],
      "the five explicit rows, in order");
    assert.deepEqual(shed.view.balanceRows.map((r) => r.value),
      ["17.2 MW", "19.0 MW", "17.2 MW", "1.8 MW", "0.0 MW"],
      "every row carries the solved figure");
    for (const rowValue of shed.view.balanceRows) {
      assert.doesNotMatch(rowValue.label, /consumed/i, `"${rowValue.label}" does not describe demand as consumed`);
    }
    // Delivered plus unmet reconciles to demand: nothing is quietly absorbed.
    const delivered = shed.view.deliveredMw;
    const unmet = shed.view.unmetMw;
    assert.ok(Math.abs(delivered + unmet - shed.view.demandMw) <= EPS, "delivered + unmet == active demand");
  });

  check("Ship summary, Power details and the tooltip all read the same solved figures", () => {
    const summary = shed.flow.summary;
    // Ship summary Power details.
    assert.equal(detail(shed.model, "power.generation").value, mwText(summary.availableGenerationMw));
    assert.equal(detail(shed.model, "power.demand").value, mwText(summary.demandMw));
    assert.equal(detail(shed.model, "power.delivered").value, mwText(summary.allocatedMw));
    assert.equal(detail(shed.model, "power.unmet").value, mwText(summary.unmetMw));
    // Tooltip / shared balance view.
    assert.equal(shed.view.generationMw, summary.availableGenerationMw);
    assert.equal(shed.view.demandMw, summary.demandMw);
    assert.equal(shed.view.deliveredMw, summary.allocatedMw);
    assert.equal(shed.view.unmetMw, summary.unmetMw);
    // The component hover card classifies the same component the same way.
    const amplifier = shed.flow.byComponentIndex.find((entry) => SHED_DESIGN[entry.componentIndex].type === "signalAmplifier");
    const network = shed.flow.networks.find((n) => amplifier.networkIds.includes(n.id));
    const hover = PowerDiagnostics.classifyPowerDeliveryIssue({ componentEntry: amplifier, network, flow: shed.flow });
    assert.equal(hover.consequence, "priority-load-shed", "the hover card names the same priority decision");
    assert.equal(shed.view.cause, "generation-shortage", "the summary names the same root cause the hover card does");
    assert.equal(hover.cause, "generation-shortage");
  });

  check("nominal component totals never drive the authoritative Power conclusion", () => {
    // The nominal figures happen to agree here, so the check is that the view is
    // marked authoritative and carries no nominal-derived field, and that the
    // resolved values are the solver's rather than stats'.
    assert.equal(shed.power.authoritative, true, "the resolved Power view is authoritative");
    assert.equal(detail(shed.model, "power.basis"), null, "no nominal-basis label on an authoritative solve");
    // Feeding deliberately wrong nominal stats changes nothing.
    const misleading = resolvePowerSummary({ powerGeneration: 999, powerUse: 0, powerEfficiency: 1, powerDebuff: 0 }, shed.flow, { design: SHED_DESIGN, partNames: PART_DEFS });
    assert.equal(misleading.generation, 17.2, "generation comes from the solve, not from stats");
    assert.equal(misleading.requested, 19, "demand comes from the solve, not from stats");
    assert.equal(misleading.unmet, 1.8, "unmet comes from the solve, not from stats");
    assert.equal(misleading.spare, 0, "no spare is invented from nominal headroom");
  });

  check("without a solve the values are labelled as nominal rather than passed off as solved", () => {
    const stats = computeStats(SHED_DESIGN);
    const model = buildShipSummaryModel(stats, { design: SHED_DESIGN });
    assert.equal(model.power.authoritative, false, "flagged as non-authoritative");
    const basis = detail(model, "power.basis");
    assert.ok(basis, "Power details states the basis");
    assert.match(basis.value, /Nominal component totals/, "the label names the values as nominal");
  });

  // -------------------------------------------------------------------------
  // Fixture B — a fully supplied ship still reports its reachable spare.
  //   generation  core 4.0 + reactor 10.0 = 14.0 MW
  //   demand      shield 3.5 + blaster 2.4 = 5.9 MW
  // -------------------------------------------------------------------------
  const SPARE_DESIGN = [at("core", 1, 7), at("reactor", 2, 7), at("shield", 4, 7), at("blaster", 5, 7)];
  const spare = build(SPARE_DESIGN, trunk(WiringRules.emptyWiring(), SPARE_DESIGN, row(7, 1, 5)));

  check("a fully supplied ship reports Fully powered and its reachable spare", () => {
    const summary = spare.flow.summary;
    assert.equal(summary.unmetMw, 0, "nothing is unmet");
    assert.equal(summary.availableGenerationMw, 14, "14.0 MW reachable generation");
    assert.equal(summary.demandMw, 5.9, "5.9 MW connected demand");
    assert.equal(spare.power.fullyPowered, true);
    assert.equal(statusText(spare.model, "power-ok"), "Fully powered", "Fully powered is stated");
    assert.equal(statusIds(spare.model).includes("power-short"), false, "no shortfall line");
    assert.equal(statusIds(spare.model).includes("power-shed"), false, "no load-shedding line");
    // Spare is the solver's own reachable-spare figure, unchanged.
    assert.equal(spare.power.spare, summary.spareGenerationMw, "spare is the solver's spareGenerationMw");
    assert.equal(spare.power.spare, 8.1, "14.0 MW generation less 5.9 MW delivered");
    assert.equal(spare.power.overviewText, "8.1 MW spare", "the Power card headline states the spare");
    assert.equal(detail(spare.model, "power.spare").value, "8.1 MW", "Power details shows the spare");
    assert.equal(spare.view.balanceHeadline, "Grid Surplus: 8.1 MW", "the tooltip states a surplus");
    assert.equal(detail(spare.model, "power.unmet"), null, "no unmet row on a fully supplied ship");
  });

  // -------------------------------------------------------------------------
  // Fixture C — two isolated Power networks.
  //   net A: core 4.0 generation feeding blaster 2.4  -> 1.6 MW reachable spare
  //   net B: reactor 10.0 generation, no consumers    -> 10.0 MW stranded
  // -------------------------------------------------------------------------
  // The reactor is two cells wide, so its island trunk runs from its second cell
  // to a neighbouring frame: a section inside a single component is not a route.
  const ISLAND_DESIGN = [at("core", 1, 3), at("blaster", 2, 3), at("reactor", 1, 9), at("frame", 3, 9)];
  let islandWiring = trunk(WiringRules.emptyWiring(), ISLAND_DESIGN, row(3, 1, 2));
  islandWiring = trunk(islandWiring, ISLAND_DESIGN, row(9, 2, 3));
  const islands = build(ISLAND_DESIGN, islandWiring);

  check("isolated networks keep reachable spare and stranded generation distinct", () => {
    assert.equal(islands.flow.networks.length, 2, "two separate Power networks");
    const supplying = islands.flow.networks.find((n) => n.demandMw > EPS);
    const isolated = islands.flow.networks.find((n) => n.demandMw <= EPS);
    assert.ok(supplying && isolated, "one network carries demand, the other carries none");
    assert.equal(supplying.unmetMw, 0, "the supplying network meets its demand");
    assert.equal(isolated.availableGenerationMw, 10, "the isolated reactor's 10.0 MW is present");
    assert.equal(isolated.usedGenerationMw, 0, "and reaches nothing");

    // Reachable spare counts only the network that actually powers something.
    assert.equal(islands.power.spare, 1.6, "reachable spare is the supplying network's headroom only");
    assert.equal(islands.view.spareMw, 1.6);
    // The isolated reactor is preserved separately and never added to spare.
    assert.equal(islands.power.stranded, 10, "the isolated generation is reported as stranded");
    assert.equal(islands.view.strandedMw, 10);
    assert.notEqual(islands.power.spare, islands.power.spare + islands.power.stranded, "spare does not absorb stranded generation");
    assert.equal(detail(islands.model, "power.stranded").value, "10.0 MW", "Power details separates stranded generation");
    assert.equal(detail(islands.model, "power.spare").value, "1.6 MW", "Power details keeps reachable spare separate");
    assert.equal(statusText(islands.model, "power-stranded"), "10.0 MW stranded on isolated network");
    const strandedRow = islands.view.balanceRows.find((r) => r.id === "strandedGeneration");
    assert.equal(strandedRow.value, "10.0 MW", "the tooltip carries the stranded figure separately");
    assert.equal(islands.view.balanceRows.find((r) => r.id === "reachableSpare").value, "1.6 MW");
  });

  // -------------------------------------------------------------------------
  // Fixture D — an isolated generator. Everything that is connected to
  // generation is fully powered; the shortfall is unrouted demand, not a
  // priority decision. Load shedding must NOT be claimed here.
  //   net A: core 4.0 generation feeding blaster 2.4  -> fully supplied
  //   net B: reactor 10.0 generation, no route to any consumer
  //   net C: aegisProjector 8.0 + signalAmplifier 3.0, no generation at all
  // -------------------------------------------------------------------------
  const ISOLATED_DESIGN = [
    at("core", 1, 3), at("blaster", 2, 3),
    at("reactor", 1, 9), at("frame", 3, 9),
    at("aegisProjector", 6, 3), at("signalAmplifier", 8, 3)
  ];
  let isolatedWiring = trunk(WiringRules.emptyWiring(), ISOLATED_DESIGN, row(3, 1, 2));
  isolatedWiring = trunk(isolatedWiring, ISOLATED_DESIGN, row(9, 2, 3));
  isolatedWiring = trunk(isolatedWiring, ISOLATED_DESIGN, row(3, 6, 8));
  const isolated = build(ISOLATED_DESIGN, isolatedWiring);

  check("load shedding is not claimed when the shortfall is unrouted rather than deprioritised", () => {
    assert.ok(isolated.power.unmet > EPS, "the ship does have unmet demand");
    // Every consumer that can reach generation got everything it asked for.
    const reachable = isolated.flow.byComponentIndex.filter((entry) =>
      entry.role === "consumer" && entry.networkIds.some((id) => {
        const net = isolated.flow.networks.find((n) => n.id === id);
        return net && net.availableGenerationMw > EPS;
      }));
    assert.ok(reachable.length > 0, "at least one consumer reaches generation");
    for (const entry of reachable) {
      assert.ok(entry.unmetMw <= EPS, `${ISOLATED_DESIGN[entry.componentIndex].type} is fully powered`);
    }
    // The solver still lists those categories as unmet; the presentation must not
    // turn "unmet somewhere on the ship" into "the policy shed this".
    assert.ok(isolated.flow.summary.loadShedCategories.length > 0, "the solver reports unmet categories");
    assert.equal(isolated.power.loadShedActive, false, "no load shedding is claimed");
    assert.equal(isolated.view.loadShedActive, false);
    assert.equal(statusIds(isolated.model).includes("power-shed"), false, "no Load shedding active status line");
    assert.doesNotMatch(isolated.model.status.map((m) => m.text).join(" "), /load shedding/i);
    assert.equal(detail(isolated.model, "power.shed"), null, "Power details carries no Load shed row");
    assert.deepEqual(isolated.view.loadShedLabels, [], "no category is named as shed");
    assert.doesNotMatch(isolated.view.explanation || "", /lower priority/i,
      "the explanation describes the routing fault, not a priority decision");
  });

  check("load shedding is still reported when the policy really did deprioritise demand", () => {
    // Fixture A: one network, higher-priority categories supplied in full while
    // the lowest-priority component on that same network went short.
    assert.equal(shed.power.loadShedActive, true, "the genuine case still reports load shedding");
    const amplifier = shed.view.shedComponents.find((entry) => entry.label === "Signal Amplifier");
    assert.ok(amplifier, "the shed component is identified");
    assert.equal(shed.view.lowestShedCategory, "coolingSupport", "the lowest-priority shed category is named");
  });

  // -------------------------------------------------------------------------
  // Invariants across every fixture.
  // -------------------------------------------------------------------------
  check("the presentation is internally consistent for every fixture", () => {
    for (const [name, built] of [["shed", shed], ["spare", spare], ["islands", islands], ["isolated", isolated]]) {
      const p = built.power;
      assert.ok(!(p.spare > EPS && p.unmet > EPS), `${name}: spare and unmet are never published together`);
      // Load shedding is only ever claimed alongside real unmet demand.
      assert.ok(!(p.loadShedActive && p.unmet <= EPS), `${name}: no load shedding without unmet demand`);
      assert.ok(!(p.fullyPowered && p.unmet > EPS), `${name}: Fully powered implies no unmet demand`);
      assert.ok(Math.abs(p.delivered + p.unmet - p.requested) <= EPS, `${name}: delivered + unmet == demand`);
      assert.ok(p.delivered <= p.generation + EPS, `${name}: delivered never exceeds available generation`);
      // Reachable spare is drawn from the solver's stranded pool, never added to it.
      assert.ok(p.spare + p.stranded <= p.generation + EPS, `${name}: spare and stranded together fit inside generation`);
      for (const [id, value] of Object.entries({ generation: p.generation, requested: p.requested, delivered: p.delivered, spare: p.spare, stranded: p.stranded, unmet: p.unmet })) {
        assert.ok(Number.isFinite(value) && value >= 0, `${name}: ${id} is a finite non-negative MW figure`);
      }
    }
  });

  check("no Power balance value is altered by the presentation layer", () => {
    // Every figure the designer shows is byte-for-byte the solver's own output.
    for (const [name, built] of [["shed", shed], ["spare", spare], ["islands", islands], ["isolated", isolated]]) {
      const s = built.flow.summary;
      assert.equal(built.power.generation, s.availableGenerationMw, `${name}: generation unchanged`);
      assert.equal(built.power.requested, s.demandMw, `${name}: demand unchanged`);
      assert.equal(built.power.delivered, s.allocatedMw, `${name}: delivered unchanged`);
      assert.equal(built.power.unmet, s.unmetMw, `${name}: unmet unchanged`);
      assert.deepEqual(built.power.loadShedCategories, s.loadShedCategories, `${name}: load-shed categories unchanged`);
      // Spare is the solver's own value whenever it is shown at all.
      assert.equal(built.power.spare, built.power.unmet > EPS ? 0 : s.spareGenerationMw, `${name}: spare unchanged`);
      // Stranded is the solver's stranded pool minus the part it already called
      // spare, so the two are reported once each rather than double-counted.
      assert.equal(built.power.stranded, Math.max(0, s.strandedGenerationMw - s.spareGenerationMw), `${name}: stranded unchanged`);
    }
  });

  console.log(`\nPower summary authority checks: ${passed}/${passed} passed`);
  console.log("Blueprint Designer Power reporting authority verification passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
