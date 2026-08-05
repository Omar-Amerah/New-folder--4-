"use strict";
// Section 7D-1 — authoritative runtime Power-cable Heat.
// Shared-rule coverage (deterministic nonlinear Heat, host attribution,
// conservation, config rejection) plus runtime integration (solved section flow
// drives Heat, kept separate from component Heat, revision-cached, damage/repair).

const assert = require("assert");
const PCT = require("./public/src/shared/powerCableThermalRules");
const WiringRules = require("./public/src/shared/wiringRules");
const WiringInfra = require("./public/src/shared/wiringInfrastructureRules");
const PF = require("./public/src/shared/powerFlowRules");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat, updateShipHeat } = require("./src/server/heat");
const { rebuildShipWiringState } = require("./src/server/componentPower");

const TIERS = BALANCE.wiringInfrastructure.powerTiers;
let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }
const close = (a, b, msg, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${msg}: ${a} !== ${b}`);

// Synthetic section-flow record (as produced by PowerFlowRules.solvePowerFlow).
function flow(sectionId, tier, signedFlowMw, extra = {}) {
  const config = TIERS[tier];
  const abs = Math.abs(signedFlowMw);
  return {
    sectionId, tier, signedFlowMw, absoluteFlowMw: abs,
    sustainedCapacityMw: config.sustainedCapacityMw, peakCapacityMw: config.peakCapacityMw,
    sustainedUtilisation: abs / config.sustainedCapacityMw, peakUtilisation: abs / config.peakCapacityMw,
    aboveSustained: abs > config.sustainedCapacityMw, atPeak: abs === config.peakCapacityMw,
    operational: true, ...extra
  };
}
// Host map with the given per-section endpoint component indices.
function hostMap(spec) {
  const bySectionId = {};
  for (const [sectionId, cells] of Object.entries(spec)) {
    bySectionId[sectionId] = { sectionId, hostCells: cells.map(([x, y, componentIndex]) => ({ x, y, componentIndex })) };
  }
  return { bySectionId };
}

console.log("Shared cable-Heat rules");
check("cableHeatRateForSection: zero flow is exactly zero (no -0)", () => {
  const rate = PCT.cableHeatRateForSection(flow("s", "standard", 0), TIERS.standard);
  assert.strictEqual(rate, 0);
  assert.ok(!Object.is(rate, -0));
});
check("cableHeatRateForSection: sustained flow equals the tier coefficient exactly", () => {
  close(PCT.cableHeatRateForSection(flow("s", "light", 4), TIERS.light), 0.35, "light @ sustained");
  close(PCT.cableHeatRateForSection(flow("s", "standard", 10), TIERS.standard), 0.55, "standard @ sustained");
  close(PCT.cableHeatRateForSection(flow("s", "heavy", 24), TIERS.heavy), 0.9, "heavy @ sustained");
});
check("cableHeatRateForSection: direction does not matter (absolute flow)", () => {
  close(PCT.cableHeatRateForSection(flow("s", "standard", 6), TIERS.standard),
    PCT.cableHeatRateForSection(flow("s", "standard", -6), TIERS.standard), "sign parity");
});
check("cableHeatRateForSection: above-sustained flow is nonlinear (more than linear scaling)", () => {
  const atSustained = PCT.cableHeatRateForSection(flow("s", "standard", 10), TIERS.standard);
  const above = PCT.cableHeatRateForSection(flow("s", "standard", 15), TIERS.standard); // util 1.5
  const linear = atSustained * 1.5;
  assert.ok(above > linear, `nonlinear: ${above} should exceed linear ${linear}`);
  close(above, 0.55 * Math.pow(1.5, 2.2), "explicit nonlinear value");
});
check("cableHeatRateForSection: invalid configuration and capacity are rejected loudly", () => {
  assert.throws(() => PCT.cableHeatRateForSection(flow("s", "standard", 5), { cableHeatAtSustainedPerHostedCell: -1, cableHeatUtilisationExponent: 2.2 }), />= 0/);
  assert.throws(() => PCT.cableHeatRateForSection(flow("s", "standard", 5), { cableHeatAtSustainedPerHostedCell: 0.5, cableHeatUtilisationExponent: 1 }), /> 1/);
  assert.throws(() => PCT.cableHeatRateForSection(flow("s", "standard", 5), { cableHeatAtSustainedPerHostedCell: 0.5, cableHeatUtilisationExponent: NaN }), /> 1/);
  assert.throws(() => PCT.cableHeatRateForSection({ absoluteFlowMw: 5, sustainedCapacityMw: 0 }, TIERS.standard), /> 0/);
  assert.throws(() => PCT.cableHeatRateForSection({ absoluteFlowMw: 5, sustainedCapacityMw: -3 }, TIERS.standard), /> 0/);
});

console.log("Fail-closed host validation");
check("analyze: a missing host entry for an operational section throws (with section id)", () => {
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [flow("0,0:1,0", "standard", 5)], powerTiers: TIERS, hostMap: hostMap({})
  }), /no host entry for section 0,0:1,0/);
});
check("analyze: one invalid hosted endpoint throws", () => {
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [flow("s", "standard", 5)], powerTiers: TIERS, hostMap: hostMap({ s: [[0, 0, 0], [1, 0, null]] })
  }), /section s has an invalid hosted endpoint/);
});
check("analyze: both invalid hosted endpoints throw", () => {
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [flow("s", "standard", 5)], powerTiers: TIERS, hostMap: hostMap({ s: [[0, 0, null], [1, 0, null]] })
  }), /section s has an invalid hosted endpoint/);
});
check("analyze: validation applies even at zero flow (malformed hosts never vanish silently)", () => {
  // Missing host entry at zero flow still throws.
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [flow("z", "standard", 0)], powerTiers: TIERS, hostMap: hostMap({})
  }), /no host entry for section z/);
  // Invalid endpoint at zero flow still throws.
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [flow("z", "standard", 0)], powerTiers: TIERS, hostMap: hostMap({ z: [[0, 0, 0], [1, 0, null]] })
  }), /section z has an invalid hosted endpoint/);
});
check("analyze: a section not hosting exactly two endpoint cells throws", () => {
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [flow("s", "standard", 5)], powerTiers: TIERS, hostMap: hostMap({ s: [[0, 0, 0]] })
  }), /section s must host exactly two endpoint cells/);
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [flow("s", "standard", 5)], powerTiers: TIERS, hostMap: hostMap({ s: [[0, 0, 0], [1, 0, 1], [2, 0, 2]] })
  }), /section s must host exactly two endpoint cells/);
});
check("analyze: NaN flow throws rather than being treated as zero", () => {
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [{ sectionId: "s", tier: "standard", signedFlowMw: NaN, absoluteFlowMw: NaN, operational: true }],
    powerTiers: TIERS, hostMap: hostMap({ s: [[0, 0, 0], [1, 0, 1]] })
  }), /section s has non-finite flow/);
});
check("analyze: Infinity flow throws rather than being treated as zero", () => {
  assert.throws(() => PCT.analyzePowerCableHeat({
    sectionFlows: [{ sectionId: "s", tier: "standard", signedFlowMw: Infinity, absoluteFlowMw: Infinity, operational: true }],
    powerTiers: TIERS, hostMap: hostMap({ s: [[0, 0, 0], [1, 0, 1]] })
  }), /section s has non-finite flow/);
});
check("analyze: a valid zero-flow section with valid hosts still returns exactly zero Heat", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("s", "standard", 0)], powerTiers: TIERS, hostMap: hostMap({ s: [[0, 0, 0], [1, 0, 1]] })
  });
  assert.strictEqual(result.sections.length, 1);
  assert.strictEqual(result.sections[0].totalHeatPerSecond, 0);
  assert.ok(!Object.is(result.sections[0].totalHeatPerSecond, -0));
  assert.strictEqual(result.summary.totalPowerCableHeatPerSecond, 0);
  assert.deepStrictEqual(result.components.map((c) => c.powerCableHeatPerSecond), [0, 0]);
});

check("analyze: two different hosts each receive one share; total conserves", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("0,0:1,0", "standard", 5)],
    powerTiers: TIERS,
    hostMap: hostMap({ "0,0:1,0": [[0, 0, 0], [1, 0, 1]] })
  });
  const perCell = 0.55 * Math.pow(0.5, 2.2);
  assert.strictEqual(result.sections.length, 1);
  close(result.sections[0].heatPerHostedCellPerSecond, perCell, "per-cell");
  close(result.sections[0].totalHeatPerSecond, perCell * 2, "section total = 2 cells");
  const byIndex = new Map(result.components.map((c) => [c.componentIndex, c.powerCableHeatPerSecond]));
  close(byIndex.get(0), perCell, "host 0 one share");
  close(byIndex.get(1), perCell, "host 1 one share");
  const compTotal = result.components.reduce((s, c) => s + c.powerCableHeatPerSecond, 0);
  const secTotal = result.sections.reduce((s, x) => s + x.totalHeatPerSecond, 0);
  close(compTotal, secTotal, "component total == section total");
});
check("analyze: both endpoints inside one host give that host both shares", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("0,0:1,0", "standard", 10)],
    powerTiers: TIERS,
    hostMap: hostMap({ "0,0:1,0": [[0, 0, 4], [1, 0, 4]] })
  });
  assert.strictEqual(result.components.length, 1);
  close(result.components[0].powerCableHeatPerSecond, 0.55 * 2, "single host, both shares");
  close(result.components[0].powerCableHeatPerSecond, result.sections[0].totalHeatPerSecond, "conserves to one host");
});
check("analyze: multiple carrying sections stack on a shared host", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("a", "standard", 10), flow("b", "standard", 10)],
    powerTiers: TIERS,
    hostMap: hostMap({ a: [[0, 0, 0], [1, 0, 1]], b: [[1, 0, 1], [2, 0, 2]] })
  });
  const byIndex = new Map(result.components.map((c) => [c.componentIndex, c.powerCableHeatPerSecond]));
  close(byIndex.get(1), 0.55 * 2, "shared host stacks both sections");
  close(byIndex.get(0), 0.55, "end host one section");
  const compTotal = result.components.reduce((s, c) => s + c.powerCableHeatPerSecond, 0);
  const secTotal = result.sections.reduce((s, x) => s + x.totalHeatPerSecond, 0);
  close(compTotal, secTotal, "stacked conservation");
});
check("analyze: zero-flow sections generate zero and are counted", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("live", "standard", 8), flow("idle", "standard", 0)],
    powerTiers: TIERS,
    hostMap: hostMap({ live: [[0, 0, 0], [1, 0, 1]], idle: [[3, 0, 2], [4, 0, 3]] })
  });
  const idle = result.sections.find((s) => s.sectionId === "idle");
  assert.strictEqual(idle.totalHeatPerSecond, 0);
  assert.strictEqual(result.summary.zeroFlowSectionCount, 1);
  assert.strictEqual(result.summary.activeSectionCount, 1);
});
check("analyze: above-sustained and at-peak sections are flagged and summarised", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("above", "standard", 12), flow("peak", "standard", 16)],
    powerTiers: TIERS,
    hostMap: hostMap({ above: [[0, 0, 0], [1, 0, 1]], peak: [[1, 0, 1], [2, 0, 2]] })
  });
  assert.strictEqual(result.summary.aboveSustainedSectionCount, 2, "12 and 16 both above sustained 10");
  assert.strictEqual(result.summary.atPeakSectionCount, 1, "16 == peak");
  assert.deepStrictEqual(result.components.find((c) => c.componentIndex === 1).atPeakSectionIds, ["peak"]);
});
check("analyze: results are canonically ordered and never mutate inputs", () => {
  const sectionFlows = [flow("z", "standard", 5), flow("a", "standard", 5)];
  const map = hostMap({ z: [[0, 0, 1], [1, 0, 0]], a: [[2, 0, 3], [3, 0, 2]] });
  const before = JSON.stringify({ sectionFlows, map });
  const result = PCT.analyzePowerCableHeat({ sectionFlows, powerTiers: TIERS, hostMap: map });
  assert.deepStrictEqual(result.sections.map((s) => s.sectionId), ["a", "z"], "sections sorted by id");
  assert.deepStrictEqual(result.components.map((c) => c.componentIndex), [0, 1, 2, 3], "components sorted by index");
  assert.strictEqual(JSON.stringify({ sectionFlows, map }), before, "inputs unmutated");
});
check("analyze: no NaN, Infinity or negative zero anywhere", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("a", "light", 0), flow("b", "heavy", 30)],
    powerTiers: TIERS,
    hostMap: hostMap({ a: [[0, 0, 0], [1, 0, 1]], b: [[1, 0, 1], [2, 0, 2]] })
  });
  const numbers = [result.summary.totalPowerCableHeatPerSecond];
  for (const s of result.sections) numbers.push(s.heatPerHostedCellPerSecond, s.totalHeatPerSecond, s.absoluteFlowMw);
  for (const c of result.components) numbers.push(c.powerCableHeatPerSecond);
  for (const n of numbers) { assert.ok(Number.isFinite(n), `finite: ${n}`); assert.ok(!Object.is(n, -0), "no -0"); }
});
check("totalPowerCableHeatRate matches summary and component sum", () => {
  const result = PCT.analyzePowerCableHeat({
    sectionFlows: [flow("a", "standard", 7), flow("b", "light", 3)],
    powerTiers: TIERS,
    hostMap: hostMap({ a: [[0, 0, 0], [1, 0, 1]], b: [[1, 0, 1], [2, 0, 2]] })
  });
  close(PCT.totalPowerCableHeatRate(result), result.summary.totalPowerCableHeatPerSecond, "helper == summary");
  close(PCT.totalPowerCableHeatRate(result), result.components.reduce((s, c) => s + c.powerCableHeatPerSecond, 0), "helper == component sum");
});

// ---------------------------------------------------------------------------
// Runtime integration
// ---------------------------------------------------------------------------
const mod = (type, x, y) => ({ type, x, y, rotation: 0 });
function wiringFor(design, powerPaths, dataPaths = []) {
  let w = WiringRules.emptyWiring();
  for (const p of powerPaths) w = WiringRules.addPath(w, "power", p, design, PARTS);
  for (const p of dataPaths) w = WiringRules.addPath(w, "data", p, design, PARTS);
  return w;
}
function makeShip(design, powerPaths, dataPaths = []) {
  const s = { id: "s", ownerId: "p1", alive: true, x: 0, y: 0, vx: 0, vy: 0, angle: 0, radius: 30, stats: computeStats(design), design, wiring: wiringFor(design, powerPaths, dataPaths) };
  initComponentState(s); initShipHeat(s); rebuildShipWiringState(s, "test", { skipRuntimeStats: true }); return s;
}
function room() { return { effects: [], bullets: [], map: { asteroids: [] }, rules: { gameMode: "solo" }, players: new Map(), ships: new Map(), combatRandom: () => 0.5 }; }
function tick(s, seconds = 0.2, now = 1000) { updateShipHeat(s, seconds, room(), now); }

console.log("Runtime cable-Heat integration");
global.__mfaDataSupportPerf = {};
// core -> frame -> gyroscope: with corrected terminal attachment the source
// injects at a single cell, so both sections (including the one adjacent to the
// source) carry the 3 MW draw. The frame hosts two carrying sections.
let s = makeShip([mod("core", 0, 0), mod("frame", 1, 0), mod("gyroscope", 2, 0)], [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]]);

check("real solved section flow generates cable Heat on the hosting components", () => {
  assert.ok(s.componentPowerCableHeatRate[0] > 0 && s.componentPowerCableHeatRate[1] > 0 && s.componentPowerCableHeatRate[2] > 0, "every hosting component carries cable Heat");
  assert.ok(s.componentPowerCableHeatRate[1] > s.componentPowerCableHeatRate[0], "the frame hosts two carrying sections, so it is hottest");
  assert.ok(s.powerCableHeatRate > 0, "ship-level cable Heat rate is positive");
});
check("direct shared analysis matches the runtime cached analysis", () => {
  const direct = PCT.analyzePowerCableHeat({
    sectionFlows: s.powerFlow.sectionFlows,
    powerTiers: TIERS,
    hostMap: WiringInfra.mapHostedCells(s.design, s.wiring, PARTS).power
  });
  assert.strictEqual(JSON.stringify(direct), JSON.stringify(s.powerCableThermalAnalysis), "runtime uses the shared authority verbatim");
});
check("cable Heat is added to the thermal delta but kept separate from component Heat", () => {
  const heatBefore = s.componentHeat[1];
  tick(s, 0.2, 1000);
  assert.ok(s.componentPowerCableHeatGenerated[1] > 0, "frame records cable Heat generated");
  assert.strictEqual(s.componentHeatGenerated[1], 0, "cable Heat does not leak into componentHeatGenerated");
  assert.ok((s.componentHeat[1] + s.componentHeatTransferredOut[1] + s.componentHeatCooled[1]) >= heatBefore, "frame received thermal energy this tick");
  assert.ok(s.powerCableHeatGenerated > 0, "ship-level cable Heat generated this tick");
});
check("repeated ticks with unchanged flow do not rebuild the analysis", () => {
  const before = global.__mfaDataSupportPerf.powerCableThermalAnalysisCount;
  for (let n = 0; n < 5; n += 1) tick(s, 0.2, 2000 + n * 200);
  assert.strictEqual(global.__mfaDataSupportPerf.powerCableThermalAnalysisCount, before, "no rebuilds without a flow change");
});
check("changed flow (host destroyed) refreshes the analysis once and the broken route makes no Heat", () => {
  const before = global.__mfaDataSupportPerf.powerCableThermalAnalysisCount;
  s.componentHp[2] = 0; // destroy the gyroscope host/consumer
  rebuildShipWiringState(s, "destroy", { skipRuntimeStats: true });
  assert.strictEqual(global.__mfaDataSupportPerf.powerCableThermalAnalysisCount, before + 1, "exactly one refresh on the flow change");
  assert.strictEqual(s.powerCableHeatRate, 0, "no surviving carrying section => zero cable Heat");
  tick(s, 0.2, 5000);
  assert.deepStrictEqual([...s.componentPowerCableHeatGenerated], s.design.map(() => 0), "destroyed route generates no cable Heat");
});
check("repair restores cable Heat when the route carries flow again", () => {
  s.componentHp[2] = s.componentMaxHp[2];
  rebuildShipWiringState(s, "repair", { skipRuntimeStats: true });
  assert.ok(s.componentPowerCableHeatRate[1] > 0 && s.componentPowerCableHeatRate[2] > 0, "repaired route generates Heat again");
});
check("Data wiring produces no dynamic cable Heat", () => {
  // fireControl -> railgun over Data only; a reactor powers fireControl directly
  // (source-adjacent power section carries no solved flow, and Data never does).
  const ds = makeShip(
    [mod("reactor", 0, 0), mod("fireControl", 1, 0), mod("railgun", 2, 0)],
    [[{ x: 0, y: 0 }, { x: 1, y: 0 }]],
    [[{ x: 1, y: 0 }, { x: 2, y: 0 }]]
  );
  // Only power sectionFlows feed the analysis; the Data section is never present.
  const sectionIds = ds.powerCableThermalAnalysis.sections.map((x) => x.sectionId);
  assert.ok(!sectionIds.includes("1,0:2,0"), "the Data section never appears in cable-Heat analysis");
  assert.strictEqual(ds.powerCableThermalAnalysis.sections.every((x) => x.tier === "standard" || x.tier === "light" || x.tier === "heavy"), true, "only Power tiers present");
});
check("static Heat-capacity displacement is unchanged by the new cable-Heat fields", () => {
  assert.strictEqual(TIERS.light.heatCapacityDisplacement, 2);
  assert.strictEqual(TIERS.standard.heatCapacityDisplacement, 4);
  assert.strictEqual(TIERS.heavy.heatCapacityDisplacement, 8);
  // A component hosting cable still has its static capacity displaced (< base).
  assert.ok(s.componentHeatCapacity[1] > 0 && Number.isFinite(s.componentHeatCapacity[1]), "hosted component keeps a valid displaced capacity");
});

console.log(`\nSection 7D-1 Power-cable Heat verification passed (${passed} checks)`);
