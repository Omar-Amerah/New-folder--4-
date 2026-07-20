#!/usr/bin/env node
"use strict";

// Section 7C-2 — Physical Power Topology and Cable-Capacity Solver.
// Pure shared solver: physical Wiring v3 sections determine topology; Light/
// Standard/Heavy peak capacities are hard limits; sustained is diagnostic;
// priority bands + proportional sharing drive allocation; fixed-point integers
// keep results deterministic. Nothing here touches runtime or Blueprint UI.

const assert = require("assert");
const W = require("./public/src/shared/wiringRules");
const PA = require("./public/src/shared/powerAllocationRules");
const PF = require("./public/src/shared/powerFlowRules");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");

const INFRA = BALANCE.wiringInfrastructure;
let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }

function sec(x1, y1, x2, y2, tier = "standard") {
  const id = W.sectionIdFromCells({ x: x1, y: y1 }, { x: x2, y: y2 });
  const a = { x: x1, y: y1 }; const b = { x: x2, y: y2 };
  const ordered = (a.y < b.y || (a.y === b.y && a.x <= b.x)) ? [a, b] : [b, a];
  return { id, x1: ordered[0].x, y1: ordered[0].y, x2: ordered[1].x, y2: ordered[1].y, tier };
}
function mk(sections, connections = []) {
  return { version: 3, power: { sections, connections }, data: { sections: [], connections: [] }, powerPolicy: W.PowerPolicyRules.defaultPolicy() };
}
function solve(design, sections, opts = {}) {
  return PF.solvePowerFlow({ design, wiring: mk(sections, opts.connections || []), catalogue: PARTS, infrastructure: INFRA, ...opts });
}
function consumer(result, index) { return result.byComponentIndex.find((c) => c.componentIndex === index); }
function sectionFlow(result, id) { return result.sectionFlows.find((s) => s.sectionId === id); }
function collectNumbers(value, out) {
  if (typeof value === "number") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectNumbers(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectNumbers(v, out));
  return out;
}

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------
console.log("Comparator");
check("1. Canonical ID sorting is lexical, not locale dependent", () => {
  assert.strictEqual(PA.compareCanonicalIds("10,0:11,0", "2,0:3,0"), -1, "'1' < '2' lexically");
  const ids = ["7,7:8,7", "10,7:11,7", "2,7:3,7"].slice().sort(PA.compareCanonicalIds);
  assert.deepStrictEqual(ids, ["10,7:11,7", "2,7:3,7", "7,7:8,7"]);
});
check("2. Input order does not affect allocation output", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "shield" }];
  const forward = solve(design, [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy")], { sourceGenerationByIndex: { 0: 15 } });
  const reversed = solve(design, [sec(7, 7, 8, 7, "heavy"), sec(6, 7, 7, 7, "heavy")], { sourceGenerationByIndex: { 0: 15 } });
  assert.deepStrictEqual(forward, reversed);
});

// ---------------------------------------------------------------------------
// Basic topology
// ---------------------------------------------------------------------------
console.log("Basic topology");
check("3. One source and one consumer receive full Power", () => {
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }], [sec(6, 7, 7, 7)]);
  assert.strictEqual(consumer(r, 1).state, "powered");
  assert.strictEqual(consumer(r, 1).allocatedMw, 2.4);
  assert.strictEqual(sectionFlow(r, "6,7:7,7").signedFlowMw, 2.4, "flow positive x1,y1 -> x2,y2");
});
check("4. A disconnected consumer receives zero", () => {
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }, { x: 10, y: 10, type: "shield" }], [sec(6, 7, 7, 7)]);
  assert.strictEqual(consumer(r, 2).state, "disconnected");
  assert.strictEqual(consumer(r, 2).allocatedMw, 0);
});
check("5. Unreferenced physical sections participate (no connection metadata needed)", () => {
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }], [sec(6, 7, 7, 7)]);
  assert.strictEqual(consumer(r, 1).allocatedMw, 2.4, "section with no connections still carries flow");
});
check("6. Connection metadata cannot create a missing physical route", () => {
  // A bogus connection references a section that does not exist; with no real
  // section between the components the consumer stays disconnected.
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }], [], { connections: [{ sourceIndex: 0, targetIndex: 1, sectionIds: ["6,7:7,7", "7,7:8,7"] }] });
  assert.strictEqual(consumer(r, 1).state, "disconnected");
  assert.strictEqual(consumer(r, 1).allocatedMw, 0);
});
check("7. A source with multiple terminals is counted once", () => {
  // reactor is 2x1 (cells 6,7 & 7,7), both section endpoints -> two terminals.
  const design = [{ x: 6, y: 7, type: "reactor" }, { x: 8, y: 7, type: "blaster" }];
  const r = solve(design, [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy")]);
  assert.strictEqual(r.summary.availableGenerationMw, 10, "reactor generation counted once, not per terminal");
  assert.strictEqual(consumer(r, 1).allocatedMw, 2.4);
});
check("8. A consumer with multiple terminals is counted once", () => {
  // engine is 1x2 (cells 7,7 & 7,8), demand 1.2 counted once.
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "engine" }];
  const r = solve(design, [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 7, 8, "heavy")]);
  assert.strictEqual(consumer(r, 1).requestedMw, 1.2, "demand counted once across terminals");
  assert.strictEqual(consumer(r, 1).allocatedMw, 1.2);
});
check("9-10. A passive component does not bridge separate cable islands", () => {
  // capacitor (2x1 passive) spans cell 1,0 (island A) and 2,0 (island B) but
  // there is no section 1,0:2,0, so the two islands stay separate.
  const design = [
    { x: 0, y: 0, type: "core" },       // 0: source, island A
    { x: 1, y: 0, type: "capacitor" },  // 1: passive spanning 1,0 & 2,0
    { x: 3, y: 0, type: "blaster" }     // 2: consumer, island B
  ];
  const r = solve(design, [sec(0, 0, 1, 0, "heavy"), sec(2, 0, 3, 0, "heavy")], { sourceGenerationByIndex: { 0: 50 } });
  assert.strictEqual(consumer(r, 2).state, "unpowered", "island B consumer cannot draw through the passive host");
  assert.strictEqual(consumer(r, 2).allocatedMw, 0);
  // The source's generation is stranded in island A, proving it never bridged
  // across the passive host into island B.
  assert.strictEqual(r.summary.strandedGenerationMw, 50, "island A generation stays stranded, never bridged to island B");
  assert.strictEqual(r.summary.usedGenerationMw, 0);
  assert.ok(r.networks.length >= 2, "two separate cable islands");
});

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------
console.log("Capacity");
for (const [label, tier, peak] of [["11. Light", "light", 7], ["12. Standard", "standard", 16], ["13. Heavy", "heavy", 36]]) {
  check(`${label} flow never exceeds ${tier} peak`, () => {
    const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }], [sec(6, 7, 7, 7, tier)], { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 100 } });
    assert.strictEqual(sectionFlow(r, "6,7:7,7").absoluteFlowMw, peak, `${tier} caps at peak ${peak}`);
    assert.strictEqual(sectionFlow(r, "6,7:7,7").atPeak, true);
    assert.strictEqual(consumer(r, 1).allocatedMw, peak);
  });
}
check("14. Above-sustained flow is allowed and flagged", () => {
  // Light sustained 4, peak 7. Demand 6 -> flow 6: above sustained, below peak.
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }], [sec(6, 7, 7, 7, "light")], { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 6 } });
  const f = sectionFlow(r, "6,7:7,7");
  assert.strictEqual(f.absoluteFlowMw, 6);
  assert.strictEqual(f.aboveSustained, true);
  assert.strictEqual(f.atPeak, false);
});
check("15. Flow at peak is flagged", () => {
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }], [sec(6, 7, 7, 7, "light")], { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 7 } });
  assert.strictEqual(sectionFlow(r, "6,7:7,7").atPeak, true);
});
check("16. No Heat or damage output is created", () => {
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }], [sec(6, 7, 7, 7)]);
  const keys = JSON.stringify(r).toLowerCase();
  for (const banned of ["heat", "damage", "overload", "breaker", "meltdown", "trip"]) assert.ok(!keys.includes(banned), `no '${banned}' in output`);
});
check("17-18. Downgrading a bottleneck reduces, upgrading increases reachable allocation", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }];
  const opts = { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 100 } };
  const light = solve(design, [sec(6, 7, 7, 7, "light")], opts);
  const standard = solve(design, [sec(6, 7, 7, 7, "standard")], opts);
  const heavy = solve(design, [sec(6, 7, 7, 7, "heavy")], opts);
  assert.ok(consumer(light, 1).allocatedMw < consumer(standard, 1).allocatedMw);
  assert.ok(consumer(standard, 1).allocatedMw < consumer(heavy, 1).allocatedMw);
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
console.log("Routing");
// Diamond: core(6,6) source; blaster(8,6) consumer; top path via 7,6; bottom
// path via 6,7-7,7-8,7. Two disjoint routes sharing only the endpoints.
const DIAMOND = [
  { x: 6, y: 6, type: "core" },   // 0 source
  { x: 8, y: 6, type: "blaster" },// 1 consumer
  { x: 7, y: 6, type: "frame" },  // 2 top
  { x: 6, y: 7, type: "frame" },  // 3 bottom
  { x: 7, y: 7, type: "frame" },  // 4 bottom
  { x: 8, y: 7, type: "frame" }   // 5 bottom
];
const DIAMOND_SECTIONS = [
  sec(6, 6, 7, 6, "light"), sec(7, 6, 8, 6, "light"),                         // top
  sec(6, 6, 6, 7, "light"), sec(6, 7, 7, 7, "light"), sec(7, 7, 8, 7, "light"), sec(8, 6, 8, 7, "light") // bottom
];
check("19. Parallel routes can both carry flow", () => {
  const r = solve(DIAMOND, DIAMOND_SECTIONS, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 12 } });
  assert.strictEqual(consumer(r, 1).allocatedMw, 12, "both light routes combine (>7)");
  assert.ok(sectionFlow(r, "6,6:7,6").absoluteFlowMw > 0, "top route carries");
  assert.ok(sectionFlow(r, "6,6:6,7").absoluteFlowMw > 0, "bottom route carries");
});
check("20. A longer route is used when a short route reaches peak", () => {
  // Short route = top (2 light sections, bottleneck 7). Long route = bottom.
  const r = solve(DIAMOND, DIAMOND_SECTIONS, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 12 } });
  assert.strictEqual(consumer(r, 1).allocatedMw, 12);
  const top = Math.max(sectionFlow(r, "6,6:7,6").absoluteFlowMw, sectionFlow(r, "7,6:8,6").absoluteFlowMw);
  const bottom = sectionFlow(r, "6,6:6,7").absoluteFlowMw;
  assert.ok(top <= 7 && bottom > 0, "short route capped at peak, longer route carries the remainder");
});
check("21. A ring routes around one missing section", () => {
  // Ring 6,6-7,6-7,7-6,7-6,6 with consumer tapped at 7,7. Drop 6,6:7,6; the
  // consumer is still reachable the other way around the ring.
  const design = [{ x: 6, y: 6, type: "core" }, { x: 7, y: 6, type: "frame" }, { x: 7, y: 7, type: "blaster" }, { x: 6, y: 7, type: "frame" }];
  const ring = [sec(6, 6, 7, 6, "heavy"), sec(7, 6, 7, 7, "heavy"), sec(6, 7, 7, 7, "heavy"), sec(6, 6, 6, 7, "heavy")];
  const r = solve(design, ring, { sectionOperationalById: { "6,6:7,6": false } });
  assert.strictEqual(consumer(r, 2).state, "powered", "still reachable around the ring");
  assert.strictEqual(consumer(r, 2).allocatedMw, 2.4);
});
check("22. Removing a bridge disconnects the expected consumer", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "blaster" }];
  const sections = [sec(6, 7, 7, 7), sec(7, 7, 8, 7)];
  const intact = solve(design, sections);
  assert.strictEqual(consumer(intact, 2).state, "powered");
  const cut = solve(design, sections, { sectionOperationalById: { "7,7:8,7": false } });
  // The consumer's only cable section is gone, so it has no live terminal.
  assert.strictEqual(consumer(cut, 2).state, "disconnected", "removing the only bridge strands the consumer");
  assert.strictEqual(consumer(cut, 2).allocatedMw, 0);
});
check("23. Section-array order does not change results", () => {
  const a = solve(DIAMOND, DIAMOND_SECTIONS, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 12 } });
  const shuffled = [...DIAMOND_SECTIONS].reverse();
  const b = solve(DIAMOND, shuffled, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 12 } });
  assert.deepStrictEqual(a, b);
});
check("24. Connection-array order does not change results", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }];
  const a = solve(design, [sec(6, 7, 7, 7)], { connections: [{ sourceIndex: 0, targetIndex: 1, sectionIds: ["6,7:7,7"] }] });
  const b = solve(design, [sec(6, 7, 7, 7)], { connections: [] });
  assert.deepStrictEqual(a, b, "connection metadata is ignored entirely");
});
check("25. Repeated solves return identical serialised output", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "shield" }];
  const s = () => JSON.stringify(solve(design, [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy")], { sourceGenerationByIndex: { 0: 15 } }));
  assert.strictEqual(s(), s());
});
check("26. No section exceeds peak", () => {
  const r = solve(DIAMOND, DIAMOND_SECTIONS, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 100 } });
  for (const f of r.sectionFlows) assert.ok(f.absoluteFlowMw <= f.peakCapacityMw + 1e-9, `${f.sectionId} within peak`);
});
check("27. Flow conservation holds at internal cable nodes", () => {
  // Series core(6,7)-frame(7,7)-blaster(8,7): flow into frame == flow out.
  const r = solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "blaster" }], [sec(6, 7, 7, 7), sec(7, 7, 8, 7)]);
  assert.strictEqual(Math.abs(sectionFlow(r, "6,7:7,7").signedFlowMw), Math.abs(sectionFlow(r, "7,7:8,7").signedFlowMw), "no leak at the frame node");
});
check("28. Total generation used equals total consumer allocation", () => {
  const r = solve(DIAMOND, DIAMOND_SECTIONS, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 12 } });
  assert.strictEqual(r.summary.usedGenerationMw, r.summary.allocatedMw);
});

// ---------------------------------------------------------------------------
// Priority and fairness
// ---------------------------------------------------------------------------
console.log("Priority and fairness");
// core(6,7) source; three 1x1 consumers reachable through a heavy trunk.
function triConsumer(types, gen, policy, demands) {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: types[0] }, { x: 8, y: 7, type: types[1] }, { x: 9, y: 7, type: types[2] }];
  const sections = [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy"), sec(8, 7, 9, 7, "heavy")];
  return solve(design, sections, { sourceGenerationByIndex: { 0: gen }, policy, consumerDemandByIndex: demands });
}
check("29. Balanced shortage allocates proportionally", () => {
  // gyroscope(propulsion,3) + blaster(weapons,3) both in one balanced band; gen 3.
  const r = triConsumer(["gyroscope", "blaster", "frame"], 3, { preset: "balanced" }, { 1: 3, 2: 3 });
  assert.strictEqual(consumer(r, 1).allocatedMw, 1.5);
  assert.strictEqual(consumer(r, 2).allocatedMw, 1.5);
});
check("30. Defensive favours Shields before Weapons", () => {
  const r = triConsumer(["shield", "blaster", "frame"], 4, { preset: "defensive" }, { 1: 3.5, 2: 2.4 });
  assert.strictEqual(consumer(r, 1).allocatedMw, 3.5, "shields fully served first");
  assert.strictEqual(consumer(r, 2).allocatedMw, 0.5, "weapons gets the remainder");
});
check("31. Offensive favours Weapons before Propulsion", () => {
  const r = triConsumer(["blaster", "gyroscope", "frame"], 3, { preset: "offensive" }, { 1: 2.4, 2: 3 });
  assert.strictEqual(consumer(r, 1).allocatedMw, 2.4, "weapons served first");
  assert.strictEqual(consumer(r, 2).allocatedMw, 0.6, "propulsion gets remainder");
});
check("32. Mobility favours Propulsion", () => {
  const r = triConsumer(["gyroscope", "blaster", "frame"], 3, { preset: "mobility" }, { 1: 3, 2: 2.4 });
  assert.strictEqual(consumer(r, 1).allocatedMw, 3, "propulsion served first");
  assert.strictEqual(consumer(r, 2).allocatedMw, 0);
});
check("33. Custom order is honoured", () => {
  // Custom puts weapons ahead of shields.
  const policy = { preset: "custom", customOrder: ["weapons", "command", "propulsion", "shields", "pointDefence", "coolingSupport"] };
  const r = triConsumer(["shield", "blaster", "frame"], 2.4, policy, { 1: 3.5, 2: 2.4 });
  assert.strictEqual(consumer(r, 2).allocatedMw, 2.4, "weapons served before shields under custom order");
  assert.strictEqual(consumer(r, 1).allocatedMw, 0);
});
check("34. Same-band consumers share proportionally", () => {
  // Two weapons consumers in the same band; gen forces a shortage.
  const r = triConsumer(["blaster", "blaster", "frame"], 2.4, { preset: "balanced" }, { 1: 2.4, 2: 4.8 });
  assert.strictEqual(consumer(r, 1).allocatedMw, 0.8);
  assert.strictEqual(consumer(r, 2).allocatedMw, 1.6);
});
check("35. Unreachable high-priority consumer does not block reachable lower-priority demand on another island", () => {
  // Island A: shield (high priority under defensive) with NO source -> unreachable.
  // Island B: core source + blaster (lower priority) -> must still be powered.
  const design = [
    { x: 0, y: 0, type: "shield" },  // 0 high priority, island A, no source
    { x: 1, y: 0, type: "frame" },   // 1 island A cable
    { x: 5, y: 0, type: "core" },    // 2 source, island B
    { x: 6, y: 0, type: "blaster" }  // 3 lower priority, island B
  ];
  const sections = [sec(0, 0, 1, 0, "heavy"), sec(5, 0, 6, 0, "heavy")];
  const r = solve(design, sections, { policy: { preset: "defensive" } });
  assert.strictEqual(consumer(r, 0).state, "unpowered", "unreachable shields consumer");
  assert.strictEqual(consumer(r, 3).state, "powered", "reachable weapons consumer keeps its power");
  assert.strictEqual(consumer(r, 3).allocatedMw, 2.4);
});

// ---------------------------------------------------------------------------
// Saved Wiring policy is the default authority
// ---------------------------------------------------------------------------
console.log("Saved Wiring policy default");
function solveSaved(design, sections, preset, opts = {}) {
  const wiring = { version: 3, power: { sections, connections: [] }, data: { sections: [], connections: [] }, powerPolicy: W.PowerPolicyRules.normalizePolicy({ preset, customOrder: opts.customOrder }) };
  return PF.solvePowerFlow({ design, wiring, catalogue: PARTS, infrastructure: INFRA, sourceGenerationByIndex: opts.sourceGenerationByIndex, consumerDemandByIndex: opts.consumerDemandByIndex });
}
const POLICY_DESIGN = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "shield" }, { x: 8, y: 7, type: "blaster" }, { x: 9, y: 7, type: "frame" }];
const POLICY_SECTIONS = [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy"), sec(8, 7, 9, 7, "heavy")];
check("D1. Defensive stored in wiring.powerPolicy affects allocation without options.policy", () => {
  const r = solveSaved(POLICY_DESIGN, POLICY_SECTIONS, "defensive", { sourceGenerationByIndex: { 0: 4 } });
  assert.strictEqual(consumer(r, 1).allocatedMw, 3.5, "shields served first from saved policy");
  assert.strictEqual(consumer(r, 2).allocatedMw, 0.5, "weapons gets the remainder");
});
check("D2. Offensive works from the saved Wiring policy", () => {
  const r = solveSaved(POLICY_DESIGN, POLICY_SECTIONS, "offensive", { sourceGenerationByIndex: { 0: 2.4 } });
  assert.strictEqual(consumer(r, 2).allocatedMw, 2.4, "weapons served first");
  assert.strictEqual(consumer(r, 1).allocatedMw, 0, "shields starved");
});
check("D3. Custom ordering works from the saved Wiring policy", () => {
  const r = solveSaved(POLICY_DESIGN, POLICY_SECTIONS, "custom", { customOrder: ["weapons", "command", "propulsion", "shields", "pointDefence", "coolingSupport"], sourceGenerationByIndex: { 0: 2.4 } });
  assert.strictEqual(consumer(r, 2).allocatedMw, 2.4, "weapons before shields under saved custom order");
  assert.strictEqual(consumer(r, 1).allocatedMw, 0);
});
check("D4. An explicit options.policy override still works", () => {
  // Saved policy is defensive (shields first), overridden to offensive (weapons first).
  const wiring = { version: 3, power: { sections: POLICY_SECTIONS, connections: [] }, data: { sections: [], connections: [] }, powerPolicy: W.PowerPolicyRules.normalizePolicy({ preset: "defensive" }) };
  const r = PF.solvePowerFlow({ design: POLICY_DESIGN, wiring, catalogue: PARTS, infrastructure: INFRA, sourceGenerationByIndex: { 0: 2.4 }, policy: { preset: "offensive" } });
  assert.strictEqual(consumer(r, 2).allocatedMw, 2.4, "override wins over saved policy");
  assert.strictEqual(consumer(r, 1).allocatedMw, 0);
});
check("D5. The saved Wiring policy is not mutated by the solver", () => {
  const wiring = { version: 3, power: { sections: POLICY_SECTIONS, connections: [] }, data: { sections: [], connections: [] }, powerPolicy: W.PowerPolicyRules.normalizePolicy({ preset: "defensive" }) };
  const snapshot = JSON.stringify(wiring.powerPolicy);
  PF.solvePowerFlow({ design: POLICY_DESIGN, wiring, catalogue: PARTS, infrastructure: INFRA, sourceGenerationByIndex: { 0: 4 } });
  assert.strictEqual(JSON.stringify(wiring.powerPolicy), snapshot);
});

// ---------------------------------------------------------------------------
// Per-network totals do not double-count multi-terminal components
// ---------------------------------------------------------------------------
console.log("Per-network attribution");
check("M1. A source/consumer spanning two islands is not double-counted per network", () => {
  // reactor (2x1) occupies 5,5 (island A) and 6,5 (island B); each island has
  // its own consumer. There is no section 5,5:6,5.
  const design = [{ x: 5, y: 5, type: "reactor" }, { x: 4, y: 5, type: "blaster" }, { x: 7, y: 5, type: "shield" }];
  const sections = [sec(4, 5, 5, 5, "heavy"), sec(6, 5, 7, 5, "heavy")];
  const r = solve(design, sections);
  // Counted once globally.
  assert.strictEqual(r.summary.availableGenerationMw, 10, "reactor generation counted once globally");
  assert.strictEqual(r.byComponentIndex.find((cpt) => cpt.componentIndex === 1).requestedMw, 2.4, "blaster demand once");
  assert.strictEqual(r.byComponentIndex.find((cpt) => cpt.componentIndex === 2).requestedMw, 3.5, "shield demand once");
  const sumUsed = r.networks.reduce((s, n) => s + n.usedGenerationMw, 0);
  const sumAlloc = r.networks.reduce((s, n) => s + n.allocatedMw, 0);
  assert.ok(sumUsed <= r.summary.usedGenerationMw + 1e-9, "sum of network used generation does not exceed global");
  assert.ok(sumAlloc <= r.summary.allocatedMw + 1e-9, "sum of network allocation does not exceed global");
  for (const n of r.networks) {
    assert.ok(n.usedGenerationMw <= n.availableGenerationMw + 1e-9, `${n.id}: used <= available`);
    assert.ok(n.allocatedMw <= n.demandMw + 1e-9, `${n.id}: allocated <= demand`);
  }
  // Deterministic after section reordering.
  const reordered = solve(design, [...sections].reverse());
  assert.deepStrictEqual(r, reordered);
});

// ---------------------------------------------------------------------------
// Residual fixed-point distribution
// ---------------------------------------------------------------------------
console.log("Residual distribution");
check("R1. Three tied 10 MW consumers share 10 MW: exact total, <=0.001 spread, canonical-first unit", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "blaster" }, { x: 9, y: 7, type: "blaster" }];
  const sections = [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy"), sec(8, 7, 9, 7, "heavy")];
  const r = solve(design, sections, { sourceGenerationByIndex: { 0: 10 }, consumerDemandByIndex: { 1: 10, 2: 10, 3: 10 } });
  const allocs = [1, 2, 3].map((i) => consumer(r, i).allocatedMw);
  assert.strictEqual(allocs.reduce((a, b) => a + b, 0), 10, "exactly 10 MW allocated");
  assert.ok(Math.max(...allocs) - Math.min(...allocs) <= 0.001 + 1e-9, "allocations differ by at most 0.001 MW");
  assert.strictEqual(allocs[0], 3.334, "canonically first consumer receives the rounding unit");
  assert.strictEqual(r.summary.strandedGenerationMw, 0, "no reachable generation left stranded");
});
check("R2. Two tied 3 MW consumers share 0.001 MW: allocated, not stranded, deterministic recipient", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "blaster" }];
  const sections = [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy")];
  const r = solve(design, sections, { sourceGenerationByIndex: { 0: 0.001 }, consumerDemandByIndex: { 1: 3, 2: 3 } });
  assert.strictEqual(r.summary.allocatedMw, 0.001, "exactly 0.001 MW allocated");
  assert.strictEqual(r.summary.strandedGenerationMw, 0, "single unit is not left stranded");
  assert.strictEqual(consumer(r, 1).allocatedMw, 0.001, "deterministic recipient is the canonically first consumer");
  assert.strictEqual(consumer(r, 2).allocatedMw, 0);
});
check("R3. Invariant: reachable unsatisfied demand + feasible augmentation means no unused generation", () => {
  // Ample (heavy) cable so peak never binds: any unmet demand can only mean
  // generation is exhausted. A shortage must therefore report zero stranded gen.
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }, { x: 8, y: 7, type: "blaster" }, { x: 9, y: 7, type: "blaster" }];
  const sections = [sec(6, 7, 7, 7, "heavy"), sec(7, 7, 8, 7, "heavy"), sec(8, 7, 9, 7, "heavy")];
  const r = solve(design, sections, { sourceGenerationByIndex: { 0: 10 }, consumerDemandByIndex: { 1: 10, 2: 10, 3: 10 } });
  assert.ok(r.summary.unmetMw > 0, "reachable demand is unsatisfied");
  assert.strictEqual(r.summary.strandedGenerationMw, 0, "no unused generation while reachable demand is unmet");
  assert.strictEqual(r.summary.usedGenerationMw, r.summary.availableGenerationMw, "all reachable generation is used");
});

// ---------------------------------------------------------------------------
// Stable physical ordering (design-array order independence)
// ---------------------------------------------------------------------------
console.log("Stable physical ordering");
check("S1. Reordering the design array (with remapped overrides) yields identical physical results", () => {
  // Symmetric two-source/two-consumer line: core-blaster-frame-blaster-core.
  const forwardDesign = [
    { x: 3, y: 7, type: "core" },    // 0 source
    { x: 4, y: 7, type: "blaster" }, // 1 consumer
    { x: 5, y: 7, type: "frame" },   // 2 passive
    { x: 6, y: 7, type: "blaster" }, // 3 consumer
    { x: 7, y: 7, type: "core" }     // 4 source
  ];
  const sections = [sec(3, 7, 4, 7, "heavy"), sec(4, 7, 5, 7, "heavy"), sec(5, 7, 6, 7, "heavy"), sec(6, 7, 7, 7, "heavy")];
  const forwardOverrides = { sourceGenerationByIndex: { 0: 5, 4: 5 }, consumerDemandByIndex: { 1: 8, 3: 8 } };
  const forward = solve(forwardDesign, sections, forwardOverrides);

  // Reorder the design array and remap the index-based overrides accordingly.
  const order = [4, 3, 2, 1, 0];
  const reorderedDesign = order.map((i) => forwardDesign[i]);
  const newIndexOf = (oldIndex) => order.indexOf(oldIndex);
  const remap = (byIndex) => Object.fromEntries(Object.entries(byIndex).map(([i, v]) => [newIndexOf(Number(i)), v]));
  const reordered = solve(reorderedDesign, [...sections].reverse(), {
    sourceGenerationByIndex: remap(forwardOverrides.sourceGenerationByIndex),
    consumerDemandByIndex: remap(forwardOverrides.consumerDemandByIndex)
  });

  const keyed = (design, result) => {
    const consumers = {}; const sources = {};
    for (const cpt of result.byComponentIndex) {
      const m = design[cpt.componentIndex]; const key = `${m.type}@${m.x},${m.y}`;
      if (cpt.role === "consumer") consumers[key] = cpt.allocatedMw;
      else if (cpt.role === "source") sources[key] = cpt.generationUsedMw;
    }
    const flows = {}; for (const f of result.sectionFlows) flows[f.sectionId] = f.signedFlowMw;
    const nets = {};
    for (const n of result.networks) nets[n.sectionIds.join(";")] = { avail: n.availableGenerationMw, used: n.usedGenerationMw, demand: n.demandMw, alloc: n.allocatedMw };
    return { consumers, sources, flows, nets };
  };
  const a = keyed(forwardDesign, forward);
  const b = keyed(reorderedDesign, reordered);
  assert.deepStrictEqual(a.consumers, b.consumers, "identical physical consumer allocations");
  assert.deepStrictEqual(a.sources, b.sources, "identical source usage");
  assert.deepStrictEqual(a.flows, b.flows, "identical signed section flows");
  assert.deepStrictEqual(a.nets, b.nets, "identical network totals by section signature");
});

// ---------------------------------------------------------------------------
// Output safety
// ---------------------------------------------------------------------------
console.log("Output safety");
check("36. Results contain no NaN, Infinity or negative zero", () => {
  const results = [
    solve(DIAMOND, DIAMOND_SECTIONS, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 12 } }),
    solve([{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }], [sec(6, 7, 7, 7, "light")], { consumerDemandByIndex: { 1: 0 } }),
    solve([{ x: 6, y: 7, type: "core" }], []),
    triConsumer(["shield", "blaster", "frame"], 4, { preset: "defensive" }, { 1: 3.5, 2: 2.4 })
  ];
  for (const r of results) for (const n of collectNumbers(r, [])) {
    assert.ok(Number.isFinite(n), `finite: ${n}`);
    assert.ok(!Object.is(n, -0), "no negative zero");
  }
});
check("37. Output arrays are canonically sorted", () => {
  const r = solve(DIAMOND, DIAMOND_SECTIONS, { sourceGenerationByIndex: { 0: 100 }, consumerDemandByIndex: { 1: 12 } });
  const ids = r.sectionFlows.map((s) => s.sectionId);
  assert.deepStrictEqual(ids, [...ids].sort(PA.compareCanonicalIds), "sectionFlows sorted canonically");
  const comps = r.byComponentIndex.map((c) => c.componentIndex);
  assert.deepStrictEqual(comps, [...comps].sort((a, b) => a - b), "byComponentIndex sorted by index");
  const nets = r.networks.map((n) => n.id);
  assert.deepStrictEqual(nets, [...nets].sort(PA.compareCanonicalIds), "networks sorted canonically");
});
check("38. Inputs are not mutated", () => {
  const design = [{ x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "blaster" }];
  const sections = [sec(6, 7, 7, 7, "heavy")];
  const wiring = mk(sections, [{ sourceIndex: 0, targetIndex: 1, sectionIds: ["6,7:7,7"] }]);
  const genByIndex = { 0: 50 };
  const snapshot = JSON.stringify({ design, wiring, genByIndex });
  PF.solvePowerFlow({ design, wiring, catalogue: PARTS, infrastructure: INFRA, sourceGenerationByIndex: genByIndex });
  assert.strictEqual(JSON.stringify({ design, wiring, genByIndex }), snapshot, "no input mutated");
});

console.log(`\nSection 7C-2 Power flow solver verification passed (${passed} checks)`);
