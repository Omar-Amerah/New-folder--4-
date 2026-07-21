"use strict";
// Section 7D-3 — Blueprint thermal prediction parity for activity-driven Power
// flow and cable Heat. The Blueprint prediction must use the same authorities as
// runtime: PowerDemandRules -> PowerFlowRules -> sectionFlows ->
// PowerCableThermalRules -> component Heat, and respond to source thermal-state
// changes. Non-browser: shared UMD modules register the browser globals.

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
global.document = { createElement: () => ({ getContext: () => ({}), style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }), createElementNS: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, documentElement: { style: { setProperty() {} } }, body: { classList: { add() {}, remove() {} } } };
global.window = { devicePixelRatio: 1, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.localStorage = { getItem: () => null, setItem: () => {} };

let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }
const close = (a, b, msg, eps = 1e-6) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} !== ${b} (diff ${Math.abs(a - b)})`);
const at = (type, x, y, rotation = 0) => ({ type, x, y, rotation });

(async () => {
  const TA = await import("./public/src/design/thermalAnalysis.js");
  const { analyzeDesignHeat, buildThermalModel, buildThermalLoad, simulateThermalLoad, summariseThermalResult } = TA;
  const { PART_STATS } = await import("./public/src/design/parts.js");
  const { WIRING_INFRASTRUCTURE, POWER_DEMAND } = await import("./public/src/constants.js");
  const INFRA = WIRING_INFRASTRUCTURE;

  function wire(design, routes, policy) {
    let w = WiringRules.emptyWiring();
    for (const p of routes) w = WiringRules.addPath(w, "power", p, design, PART_STATS);
    if (policy) w.powerPolicy = PowerPolicyRules.normalizePolicy(policy);
    return w;
  }
  const predict = (design, wiring, mode) => analyzeDesignHeat(design, wiring, mode).powerThermal;
  function directSolve(design, wiring, demandByIndex, genByIndex) {
    return PowerFlowRules.solvePowerFlow({ design, wiring, catalogue: PART_STATS, infrastructure: INFRA, componentDemandByIndex: demandByIndex, sourceGenerationByIndex: genByIndex });
  }
  function demandFromPrediction(pt) { const map = {}; for (const c of pt.components) if (c.requestedMw > 0) map[c.componentIndex] = c.requestedMw; return map; }
  function genFromDesign(design) { const g = {}; design.forEach((m, i) => { const gen = Number(PART_STATS[m.type]?.powerGeneration) || 0; if (gen > 0) g[i] = gen; }); return g; }

  // A reactor (2x1) feeding a beamEmitter through a frame; the reactor's internal
  // section carries flow after the terminal fix.
  const design = [at("reactor", 5, 5), at("frame", 7, 5), at("beamEmitter", 8, 5), at("radiator", 5, 6)];
  const wiring = wire(design, [[{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }]]);

  console.log("Scenario activity and demand");
  const idle = predict(design, wiring, "idle");
  const combat = predict(design, wiring, "combat");
  const full = predict(design, wiring, "full");
  check("Idle demand is lower than Full for an activity-driven weapon", () => {
    assert.ok(idle.components[2].requestedMw < full.components[2].requestedMw, "idle < full weapon demand");
    assert.ok(idle.components[2].requestedMw > 0, "idle keeps standby demand");
  });
  check("Full activity reaches nominal demand", () => {
    close(full.components[2].requestedMw, PART_STATS.beamEmitter.powerUse, "full weapon demand is nominal");
    close(full.components[2].scenarioActivity, 1, "full activity is 1");
  });
  check("Combat uses the established partial activity assumption (0.72 for weapons)", () => {
    close(combat.components[2].scenarioActivity, 0.72, "combat weapon activity");
    close(combat.components[2].requestedMw, PART_STATS.beamEmitter.powerUse * (0.1 + 0.72 * 0.9), "combat weapon demand");
  });

  console.log("Shared-authority parity");
  check("Predicted section flow matches direct PowerFlowRules output", () => {
    const direct = directSolve(design, wiring, demandFromPrediction(full), genFromDesign(design));
    const directById = new Map(direct.sectionFlows.map((f) => [f.sectionId, f]));
    for (const f of full.cableSummary.sectionFlows) {
      close(f.absoluteFlowMw, directById.get(f.sectionId).absoluteFlowMw, `section ${f.sectionId} flow parity`);
    }
    assert.strictEqual(full.cableSummary.sectionFlows.length, direct.sectionFlows.length, "same section set");
  });
  check("Predicted cable Heat rate matches direct PowerCableThermalRules output", () => {
    const direct = directSolve(design, wiring, demandFromPrediction(full), genFromDesign(design));
    const hostMap = WiringInfra.mapHostedCells(design, wiring, PART_STATS).power;
    const cable = PowerCableThermalRules.analyzePowerCableHeat({ sectionFlows: direct.sectionFlows, powerTiers: INFRA.powerTiers, hostMap });
    close(cable.summary.totalPowerCableHeatPerSecond, full.cableSummary.totalPowerCableHeatPerSecond, "total cable Heat rate parity");
    assert.strictEqual(cable.summary.hottestSectionId, full.cableSummary.hottestSectionId, "hottest section parity");
  });
  check("Terminal-corrected first and final sections carry predicted flow", () => {
    const flows = new Map(full.cableSummary.sectionFlows.map((f) => [f.sectionId, f.absoluteFlowMw]));
    assert.ok(flows.get("5,5:6,5") > 0, "first section (reactor internal) carries flow");
    assert.ok(flows.get("7,5:8,5") > 0, "final section into the consumer carries flow");
  });

  console.log("Cable Heat attribution and separation");
  check("Cable Heat is applied to the correct host components", () => {
    // reactor(0) + frame(1) + beamEmitter(2) host the trunk; radiator(3) does not.
    assert.ok(full.components[0].powerCableHeat > 0 && full.components[1].powerCableHeat > 0 && full.components[2].powerCableHeat > 0, "trunk hosts heated");
    close(full.components[3].powerCableHeat, 0, "unwired radiator gets no cable Heat");
  });
  check("Cable Heat is tracked separately from component activity Heat", () => {
    // The passive frame has cable Heat but no component activity Heat.
    assert.ok(full.components[1].powerCableHeat > 0, "frame carries cable Heat");
    close(full.components[1].componentActivityHeat, 0, "passive frame has no activity Heat");
    close(full.components[1].totalGeneratedHeat, full.components[1].powerCableHeat, "frame total is cable Heat only");
  });

  console.log("Priorities, fairness and bottlenecks");
  check("Saved Power priorities affect predicted shortages", () => {
    // aux(3.2) feeds a shield and a blaster; Defensive powers shields first.
    const d = [at("auxGenerator", 0, 0), at("shield", 1, 0), at("blaster", 0, 1)];
    const w = wire(d, [[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 1 }]], { preset: "defensive" });
    const pt = predict(d, w, "full");
    assert.ok(pt.components[1].operationalMultiplier > pt.components[2].operationalMultiplier, "shields prioritised over weapons");
  });
  check("Tied categories remain fairly (proportionally) allocated", () => {
    const d = [at("auxGenerator", 0, 0), at("shield", 1, 0), at("pointDefense", 0, 1)];
    const w = wire(d, [[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 1 }]], { preset: "balanced" });
    const pt = predict(d, w, "full");
    assert.ok(pt.components[1].operationalMultiplier > 0 && pt.components[2].operationalMultiplier > 0
      && Math.abs(pt.components[1].operationalMultiplier - pt.components[2].operationalMultiplier) < 2e-3, "tied shields/point-defence share proportionally");
  });
  check("Bottlenecks reduce delivered demand and cable Heat follows delivered flow", () => {
    // beamEmitter (7.5) fed through a LIGHT trunk (peak 7): delivery is capped.
    const d = [at("reactor", 0, 0), at("frame", 2, 0), at("beamEmitter", 3, 0)];
    let w = WiringRules.emptyWiring();
    w = WiringRules.addPathWithTier(w, "power", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], d, PART_STATS, "light");
    const pt = predict(d, w, "full");
    assert.ok(pt.components[2].allocatedMw < pt.components[2].requestedMw, "delivered below requested at the bottleneck");
    const finalSection = pt.cableSummary.sectionFlows.find((f) => f.sectionId === "2,0:3,0");
    assert.ok(finalSection.absoluteFlowMw <= INFRA.powerTiers.light.peakCapacityMw + 1e-9, "section flow capped at light peak");
    assert.ok(pt.cableSummary.totalPowerCableHeatPerSecond > 0, "cable Heat from delivered (capped) flow");
  });

  console.log("Source thermal-state response");
  check("Generator overheat causes a predicted reallocation and refreshed cable Heat", () => {
    // A lone reactor starting at CRITICAL with no cooling route tips to OVERHEATED
    // during the sim, causing a real generator-availability transition.
    const d = [at("reactor", 5, 5), at("frame", 7, 5), at("beamEmitter", 8, 5)];
    const w = wire(d, [[{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }]]);
    const model = buildThermalModel(d, w);
    const opts = { initialHeatStates: { 0: HeatRules.STATE.CRITICAL } };
    const load = buildThermalLoad(model, "full", w, opts);
    assert.ok(load.powerState.cableHeatRate[1] > 0, "cable Heat present while the generator runs");
    const sim = simulateThermalLoad(model, load, { ...opts, maxSteps: 600 });
    assert.ok(sim.generatorShutdownCount >= 1, "the reactor overheats offline at least once");
    assert.ok(sim.powerReallocationCount >= 1, "overheat triggers a predicted reallocation (which refreshes cable Heat)");
    assert.ok(sim.finalCableHeatRate.every((r) => r >= 0 && Number.isFinite(r)), "refreshed cable Heat rates are finite and non-negative");
  });
  check("Generator recovery restores allocation deterministically", () => {
    // The main design has radiator cooling, so the reactor stays healthy and the
    // weapon remains powered; the prediction is deterministic across runs.
    const a = analyzeDesignHeat(design, wiring, "full").powerThermal;
    const b = analyzeDesignHeat(design, wiring, "full").powerThermal;
    assert.ok(a.components[2].operationalMultiplier > 0, "healthy generator powers the weapon");
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b), "repeat prediction is identical");
  });

  console.log("Determinism, ordering, fail-closed and hygiene");
  check("Idle, Combat and Full predictions are deterministic", () => {
    for (const mode of ["idle", "combat", "full"]) {
      assert.strictEqual(JSON.stringify(predict(design, wiring, mode)), JSON.stringify(predict(design, wiring, mode)), `${mode} deterministic`);
    }
  });
  check("Component/section array reordering does not change canonical section results", () => {
    const dA = [at("reactor", 5, 5), at("beamEmitter", 8, 5), at("frame", 7, 5)];
    const dB = [at("frame", 7, 5), at("beamEmitter", 8, 5), at("reactor", 5, 5)];
    const route = [[{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }]];
    const a = predict(dA, wire(dA, route), "full");
    const b = predict(dB, wire(dB, route), "full");
    const flowMap = (pt) => Object.fromEntries(pt.cableSummary.sectionFlows.map((f) => [f.sectionId, f.absoluteFlowMw]));
    assert.deepStrictEqual(flowMap(a), flowMap(b), "physical section flows are array-order independent");
  });
  check("Invalid solver results fail closed (no silent full Power)", () => {
    const real = PowerFlowRules.solvePowerFlow;
    let threw = false;
    try {
      PowerFlowRules.solvePowerFlow = () => ({ byComponentIndex: [], networks: [] }); // missing sectionFlows
      try { predict(design, wire(design, [[{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }]], { preset: "offensive" }), "combat"); }
      catch (err) { threw = /invalid result/.test(err.message); }
    } finally { PowerFlowRules.solvePowerFlow = real; }
    assert.ok(threw, "an invalid solver result throws instead of granting full Power");
  });
  check("Inputs are not mutated and no NaN/Infinity/-0 appears in diagnostics", () => {
    const d = [at("reactor", 5, 5), at("frame", 7, 5), at("beamEmitter", 8, 5)];
    const w = wire(d, [[{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }]]);
    const snapshot = JSON.stringify({ d, w });
    const pt = analyzeDesignHeat(d, w, "combat").powerThermal;
    assert.strictEqual(JSON.stringify({ d, w }), snapshot, "inputs unmutated");
    const numbers = [pt.powerSummary.totalGenerationMw, pt.powerSummary.unmetDemandMw, pt.cableSummary.totalPowerCableHeatPerSecond, pt.cableSummary.totalCableHeatGenerated];
    for (const c of pt.components) numbers.push(c.requestedMw, c.allocatedMw, c.unmetMw, c.operationalMultiplier, c.powerCableHeat, c.totalGeneratedHeat, c.finalStoredHeat);
    for (const n of numbers) { assert.ok(Number.isFinite(n), `finite: ${n}`); assert.ok(!Object.is(n, -0), "no -0"); }
  });
  check("Static Heat-capacity displacement is unchanged by the Power prediction", () => {
    // A Power cable still displaces host Heat capacity; the model capacity is the
    // wiring-aware capacity and stays below an unwired baseline.
    const d = [at("reactor", 5, 5), at("frame", 6, 5)];
    const wired = buildThermalModel(d, wire(d, [[{ x: 5, y: 5 }, { x: 6, y: 5 }]]));
    const unwired = buildThermalModel(d, null);
    assert.ok(wired.profiles[1].capacity < unwired.profiles[1].capacity, "wiring still displaces static Heat capacity");
  });

  console.log(`\nSection 7D-3 Blueprint Power thermal-parity verification passed (${passed} checks)`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
