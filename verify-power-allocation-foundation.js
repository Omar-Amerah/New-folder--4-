#!/usr/bin/env node
"use strict";

// Section 7C-1 — Power Priority and Fair-Allocation Foundation.
// Verifies policy priority-band resolution, deterministic fixed-point Power
// conversion, and pure proportional tied-band allocation. No gameplay, runtime
// allocation, cable behaviour or Blueprint UI is touched by this module.

const assert = require("assert");
const PP = require("./public/src/shared/powerPolicyRules");
const PA = require("./public/src/shared/powerAllocationRules");

let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }

const ALL = ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"];
function flat(bands) { return bands.reduce((acc, band) => acc.concat(band), []); }

// ---------------------------------------------------------------------------
// Policy priority bands
// ---------------------------------------------------------------------------
console.log("Policy priority bands");
check("1. Balanced returns one tied band containing all six categories", () => {
  assert.deepStrictEqual(PP.resolvePriorityBands({ preset: "balanced" }), [
    ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]
  ]);
});
check("2. Defensive returns the exact required bands", () => {
  assert.deepStrictEqual(PP.resolvePriorityBands({ preset: "defensive" }), [
    ["command"], ["shields", "pointDefence"], ["propulsion", "coolingSupport"], ["weapons"]
  ]);
});
check("3. Offensive returns the exact required bands", () => {
  assert.deepStrictEqual(PP.resolvePriorityBands({ preset: "offensive" }), [
    ["command"], ["weapons", "pointDefence"], ["shields"], ["propulsion", "coolingSupport"]
  ]);
});
check("4. Mobility returns the exact required bands", () => {
  assert.deepStrictEqual(PP.resolvePriorityBands({ preset: "mobility" }), [
    ["command"], ["propulsion"], ["pointDefence", "weapons"], ["shields", "coolingSupport"]
  ]);
});
check("5. Custom follows normalised customOrder (one band per category)", () => {
  const order = ["weapons", "command", "shields", "propulsion", "pointDefence", "coolingSupport"];
  assert.deepStrictEqual(PP.resolvePriorityBands({ preset: "custom", customOrder: order }), order.map((c) => [c]));
});
check("6. Malformed Custom policy repairs deterministically", () => {
  const bands = PP.resolvePriorityBands({ preset: "custom", customOrder: ["weapons", "weapons", "bogus", "command"] });
  // recognised categories keep supplied order, missing appended in canonical order
  assert.deepStrictEqual(bands, [["weapons"], ["command"], ["propulsion"], ["shields"], ["pointDefence"], ["coolingSupport"]]);
  // idempotent
  assert.deepStrictEqual(PP.resolvePriorityBands({ preset: "custom", customOrder: ["weapons", "weapons", "bogus", "command"] }), bands);
});
check("7. Every resolved policy includes every category exactly once", () => {
  for (const preset of ["balanced", "defensive", "offensive", "mobility", "custom"]) {
    const flatCats = flat(PP.resolvePriorityBands({ preset }));
    assert.deepStrictEqual([...flatCats].sort(), [...ALL].sort(), `${preset} has all categories`);
    assert.strictEqual(flatCats.length, ALL.length, `${preset} has no duplicates`);
  }
});
check("8. Returned bands do not share mutable references", () => {
  const a = PP.resolvePriorityBands({ preset: "defensive" });
  a[0].push("tampered"); a[1][0] = "tampered";
  const b = PP.resolvePriorityBands({ preset: "defensive" });
  assert.deepStrictEqual(b, [["command"], ["shields", "pointDefence"], ["propulsion", "coolingSupport"], ["weapons"]]);
});
check("9. Named presets preserve stored customOrder (input not mutated)", () => {
  const policy = { preset: "mobility", customOrder: ["shields", "weapons", "command", "propulsion", "pointDefence", "coolingSupport"] };
  const snapshot = JSON.stringify(policy);
  PP.resolvePriorityBands(policy);
  assert.strictEqual(JSON.stringify(policy), snapshot, "policy is not mutated");
  assert.deepStrictEqual(PP.normalizePolicy(policy).customOrder, policy.customOrder, "stored customOrder preserved");
});
check("Labels: authoritative category labels are exposed", () => {
  assert.strictEqual(PP.POWER_CATEGORY_LABELS.pointDefence, "Point Defence");
  assert.strictEqual(PP.POWER_CATEGORY_LABELS.coolingSupport, "Cooling & Support");
  assert.deepStrictEqual(Object.keys(PP.POWER_CATEGORY_LABELS).sort(), [...ALL].sort());
});

// ---------------------------------------------------------------------------
// Fixed-point Power helpers
// ---------------------------------------------------------------------------
console.log("Canonical comparator");
check("Canonical ID comparator is lexical (UTF-16) and locale-independent", () => {
  // Lexical, not numeric: "10" sorts before "2" because "1" < "2".
  assert.strictEqual(PA.compareCanonicalIds("10", "2"), -1);
  assert.strictEqual(PA.compareCanonicalIds("2", "10"), 1);
  assert.strictEqual(PA.compareCanonicalIds("a", "a"), 0);
  assert.strictEqual(PA.compareCanonicalIds("a", "b"), -1);
  // Allocation output uses the same lexical order for numeric-looking ids.
  const r = PA.allocateProportionally([{ id: "2", requestedMw: 10 }, { id: "10", requestedMw: 10 }], 100);
  assert.deepStrictEqual(r.allocations.map((a) => a.id), ["10", "2"]);
});

console.log("Fixed-point Power helpers");
check("10. MW converts deterministically to fixed-point units", () => {
  assert.strictEqual(PA.POWER_FLOW_SCALE, 1000);
  assert.strictEqual(PA.mwToPowerUnits(10), 10000);
  assert.strictEqual(PA.mwToPowerUnits(0.5), 500);
  assert.strictEqual(PA.mwToPowerUnits(10), PA.mwToPowerUnits(10), "deterministic");
  assert.strictEqual(PA.powerUnitsToMw(5000), 5);
  assert.ok(Number.isInteger(PA.mwToPowerUnits(3.14159)));
});
check("11. Negative and non-finite values cannot enter allocation", () => {
  for (const bad of [-1, -0.001, NaN, Infinity, -Infinity, "x", null, undefined, {}]) {
    assert.strictEqual(PA.mwToPowerUnits(bad), 0, `mwToPowerUnits(${String(bad)})`);
  }
  assert.strictEqual(PA.powerUnitsToMw(-5), 0);
  assert.ok(!Object.is(PA.powerUnitsToMw(0), -0), "no negative zero");
  assert.ok(!Object.is(PA.powerUnitsToMw(-5), -0), "no negative zero from negative");
});

// ---------------------------------------------------------------------------
// Proportional tied-band allocation
// ---------------------------------------------------------------------------
console.log("Proportional tied-band allocation");
function byId(result) { return new Map(result.allocations.map((a) => [a.id, a])); }
check("12. Full supply gives every consumer its full demand", () => {
  const r = PA.allocateProportionally([{ id: "a", requestedMw: 10 }, { id: "b", requestedMw: 20 }], 100);
  const m = byId(r);
  assert.strictEqual(m.get("a").allocatedMw, 10);
  assert.strictEqual(m.get("b").allocatedMw, 20);
  assert.strictEqual(m.get("a").satisfactionRatio, 1);
  assert.strictEqual(m.get("b").satisfactionRatio, 1);
});
check("13. A 10 MW and 20 MW consumer share 15 MW as 5 MW and 10 MW", () => {
  const m = byId(PA.allocateProportionally([{ id: "a", requestedMw: 10 }, { id: "b", requestedMw: 20 }], 15));
  assert.strictEqual(m.get("a").allocatedMw, 5);
  assert.strictEqual(m.get("b").allocatedMw, 10);
});
check("14. Three consumers share a shortage proportionally", () => {
  const m = byId(PA.allocateProportionally([{ id: "a", requestedMw: 10 }, { id: "b", requestedMw: 20 }, { id: "c", requestedMw: 30 }], 30));
  assert.strictEqual(m.get("a").allocatedMw, 5);
  assert.strictEqual(m.get("b").allocatedMw, 10);
  assert.strictEqual(m.get("c").allocatedMw, 15);
});
check("15. Zero-demand consumers are handled correctly", () => {
  const m = byId(PA.allocateProportionally([{ id: "z", requestedMw: 0 }, { id: "b", requestedMw: 10 }], 5));
  assert.strictEqual(m.get("z").allocatedMw, 0);
  assert.strictEqual(m.get("z").satisfactionRatio, 1, "zero demand is fully satisfied");
  assert.strictEqual(m.get("b").allocatedMw, 5);
});
check("16. Allocation never exceeds available Power", () => {
  const r = PA.allocateProportionally([{ id: "a", requestedMw: 10 }, { id: "b", requestedMw: 20 }, { id: "c", requestedMw: 7 }], 13);
  assert.ok(r.allocatedUnits <= r.availableUnits, "total allocated <= available");
  assert.strictEqual(r.allocatedMw, 13);
});
check("17. Allocation never exceeds demand", () => {
  const r = PA.allocateProportionally([{ id: "a", requestedMw: 3 }, { id: "b", requestedMw: 4 }], 100);
  for (const a of r.allocations) assert.ok(a.allocatedUnits <= a.requestedUnits, `${a.id} within demand`);
});
check("18. Input ordering does not change output", () => {
  const forward = PA.allocateProportionally([{ id: "a", requestedMw: 7 }, { id: "b", requestedMw: 11 }, { id: "c", requestedMw: 13 }], 17);
  const reverse = PA.allocateProportionally([{ id: "c", requestedMw: 13 }, { id: "b", requestedMw: 11 }, { id: "a", requestedMw: 7 }], 17);
  assert.deepStrictEqual(forward.allocations, reverse.allocations);
});
check("19. Rounding leftovers are deterministic (largest remainder, id tie-break)", () => {
  // 3 equal consumers of 10 MW sharing 10 MW: 10000 units / 3 = 3333 each, 1 unit
  // leftover goes to the largest remainder; all equal, so the lowest id wins.
  const m = byId(PA.allocateProportionally([{ id: "a", requestedMw: 10 }, { id: "b", requestedMw: 10 }, { id: "c", requestedMw: 10 }], 10));
  assert.strictEqual(m.get("a").allocatedUnits, 3334);
  assert.strictEqual(m.get("b").allocatedUnits, 3333);
  assert.strictEqual(m.get("c").allocatedUnits, 3333);
  // total conserved, within one unit of exact proportional
  assert.strictEqual(m.get("a").allocatedUnits + m.get("b").allocatedUnits + m.get("c").allocatedUnits, 10000);
});
check("20. Inputs are not mutated", () => {
  const requests = [{ id: "a", requestedMw: 10 }, { id: "b", requestedMw: 20 }];
  const snapshot = JSON.stringify(requests);
  PA.allocateProportionally(requests, 15);
  assert.strictEqual(JSON.stringify(requests), snapshot);
});
check("21. Results contain no NaN, Infinity or negative zero", () => {
  const results = [
    PA.allocateProportionally([{ id: "a", requestedMw: 10 }, { id: "b", requestedMw: 20 }], 15),
    PA.allocateProportionally([{ id: "z", requestedMw: 0 }], 0),
    PA.allocateProportionally([], 5),
    PA.allocateProportionally([{ id: "a", requestedMw: 10 }], 0)
  ];
  const numbers = [];
  for (const r of results) {
    numbers.push(r.availableMw, r.requestedMw, r.allocatedMw, r.unmetMw);
    for (const a of r.allocations) numbers.push(a.requestedMw, a.allocatedMw, a.unmetMw, a.satisfactionRatio);
  }
  for (const n of numbers) {
    assert.ok(Number.isFinite(n), `finite: ${n}`);
    assert.ok(!Object.is(n, -0), "no negative zero");
  }
});
check("Duplicate ids are deterministically consolidated by summing demand", () => {
  const r = PA.allocateProportionally([{ id: "a", requestedMw: 10 }, { id: "a", requestedMw: 5 }, { id: "b", requestedMw: 5 }], 100);
  assert.strictEqual(r.allocations.length, 2, "duplicate ids merged into one entry");
  assert.strictEqual(byId(r).get("a").requestedMw, 15);
  assert.strictEqual(byId(r).get("a").allocatedMw, 15);
});

// ---------------------------------------------------------------------------
// Optional priority-band orchestration (single shared pool)
// ---------------------------------------------------------------------------
console.log("Priority-band orchestration");
check("Higher bands are fully served before lower bands from one pool", () => {
  const consumers = [
    { id: "core", category: "command", requestedMw: 4 },
    { id: "gun", category: "weapons", requestedMw: 10 },
    { id: "shield", category: "shields", requestedMw: 8 }
  ];
  // Defensive: command band first, then shields band, then ... then weapons last.
  const out = PA.allocatePriorityBands({ consumers, availableMw: 10, policy: { preset: "defensive" } });
  const m = new Map(out.allocations.map((a) => [a.id, a]));
  assert.strictEqual(m.get("core").allocatedMw, 4, "command fully served first");
  assert.strictEqual(m.get("shield").allocatedMw, 6, "shields band gets the remainder");
  assert.strictEqual(m.get("gun").allocatedMw, 0, "weapons band (lowest) is starved");
  assert.strictEqual(out.remainingMw, 0);
});

console.log(`\nSection 7C-1 Power allocation foundation verification passed (${passed} checks)`);
