#!/usr/bin/env node
"use strict";

// Section 7B — Advanced Power Wiring Designer Tools.
// Verifies the shared edit/preview layer used by the tiered wiring editor:
// tier-aware Draw, Change Tier, Erase, live preview parity with committed
// results, client/server parity, and save/load compatibility.

const assert = require("assert");
const W = require("./public/src/shared/wiringRules");
const WI = require("./public/src/shared/wiringInfrastructureRules");
const WE = require("./public/src/shared/wiringEditRules");
const PP = require("./public/src/shared/powerPolicyRules");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { computeStats } = require("./src/server/shipStats");
const { validateWiring } = require("./src/server/shipDesign");
const HeatRules = require("./public/src/shared/heatRules");
const heat = require("./src/server/heat");

const INFRA = BALANCE.wiringInfrastructure;
let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }

const straight = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }];
const base = straight.map((m) => HeatRules.profile(m.type, PARTS[m.type] || {}).capacity);
const opts = { baseCapacities: base, preInfrastructureShipCost: 100 };
function empty() { return W.emptyWiring(); }
// Authoritative server per-component effective Heat capacities (base + heat-sink
// adjacency bonus - wiring displacement, clamped) for a design + wiring.
function serverCaps(design, wiring) {
  const ship = { design, wiring: W.normalizeWiring(wiring, design, PARTS).wiring, componentHp: design.map(() => 100), componentMaxHp: design.map(() => 100) };
  heat.initShipHeat(ship);
  return ship.componentThermals.map((t) => t.capacity);
}
function path(...cells) { return cells; }
function tierOf(wiring, id) { return wiring.power.sections.find((s) => s.id === id)?.tier; }
function normalized(wiring) { return W.normalizeWiring(wiring, straight, PARTS).wiring; }

// ---------------------------------------------------------------------------
// Draw mode (1-8)
// ---------------------------------------------------------------------------
console.log("Draw mode");
check("1-3. New path sections receive the selected tier", () => {
  for (const tier of ["light", "standard", "heavy"]) {
    const w = W.addPathWithTier(empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS, tier);
    assert.ok(w.power.sections.every((s) => s.tier === tier), `${tier} sections`);
  }
});
check("4. Existing sections keep their tier when Draw crosses them", () => {
  let w = W.addPathWithTier(empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }), straight, PARTS, "light");
  w = W.addPathWithTier(w, "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS, "heavy");
  assert.strictEqual(tierOf(w, "6,7:7,7"), "light", "existing Light section is not overwritten");
  assert.strictEqual(tierOf(w, "7,7:8,7"), "heavy", "new section is Heavy");
});
check("5. Duplicate sections are not created", () => {
  let w = W.addPathWithTier(empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }), straight, PARTS, "standard");
  w = W.addPathWithTier(w, "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }), straight, PARTS, "heavy");
  assert.strictEqual(w.power.sections.length, 1);
});
check("6. Data Draw remains single-tier regardless of requested tier", () => {
  const dataDesign = [{ x: 5, y: 6, type: "fireControl" }, { x: 6, y: 6, type: "beamEmitter" }];
  const w = W.addPathWithTier(W.emptyWiring(), "data", path({ x: 5, y: 6 }, { x: 6, y: 6 }), dataDesign, PARTS, "heavy");
  assert.ok(w.data.sections.every((s) => s.tier === "standard"));
});
check("7. Draw preserves powerPolicy", () => {
  let w = W.cloneWiring(empty());
  w.powerPolicy = PP.normalizePolicy({ preset: "custom", customOrder: ["weapons", "command", "propulsion", "shields", "pointDefence", "coolingSupport"] });
  const out = W.addPathWithTier(w, "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }), straight, PARTS, "heavy");
  assert.strictEqual(out.powerPolicy.preset, "custom");
  assert.strictEqual(out.powerPolicy.customOrder[0], "weapons");
});
check("8. Multi-section Draw yields a single proposed wiring (one Undo snapshot)", () => {
  const preview = WE.previewPowerPathEdit(straight, empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 }), "heavy", PARTS, INFRA, opts);
  assert.strictEqual(preview.newSections, 2, "two new sections committed together");
  assert.ok(preview.proposedWiring.power.sections.length === 2);
});

// ---------------------------------------------------------------------------
// Change Tier (9-20)
// ---------------------------------------------------------------------------
console.log("Change Tier");
function wired(t1, t2) {
  let w = W.addPathWithTier(empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }), straight, PARTS, t1);
  return W.addPathWithTier(w, "power", path({ x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS, t2);
}
const transitions = [
  ["9. Light upgrades to Standard", "light", "standard"],
  ["10. Light upgrades to Heavy", "light", "heavy"],
  ["11. Standard downgrades to Light", "standard", "light"],
  ["12. Standard upgrades to Heavy", "standard", "heavy"],
  ["13. Heavy downgrades to Standard", "heavy", "standard"],
  ["14. Heavy downgrades to Light", "heavy", "light"]
];
for (const [label, from, to] of transitions) {
  check(label, () => {
    const w = wired(from, from);
    const result = W.setSectionTier(w, "power", "6,7:7,7", to, straight, PARTS);
    assert.ok(result.changed);
    assert.strictEqual(tierOf(result.wiring, "6,7:7,7"), to);
  });
}
check("15. Applying the current tier is a deterministic no-op", () => {
  const w = wired("heavy", "heavy");
  const result = W.setSectionTier(w, "power", "6,7:7,7", "heavy", straight, PARTS);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.reason, "already-selected-tier");
  assert.deepStrictEqual(result.wiring.power.sections.map((s) => s.tier), w.power.sections.map((s) => s.tier));
});
check("16-17. Only the selected section changes; neighbours unchanged", () => {
  const w = wired("heavy", "heavy");
  const result = W.setSectionTier(w, "power", "6,7:7,7", "light", straight, PARTS);
  assert.strictEqual(tierOf(result.wiring, "6,7:7,7"), "light");
  assert.strictEqual(tierOf(result.wiring, "7,7:8,7"), "heavy", "neighbour section keeps Heavy");
});
check("18. Hosted-cell accounting updates correctly at junctions", () => {
  const w = wired("heavy", "light");
  // Junction cell 7,7 is Heavy (highest incident). Downgrade the heavy section:
  const result = W.setSectionTier(w, "power", "6,7:7,7", "light", straight, PARTS);
  const acc = WI.accountInfrastructure(straight, result.wiring, PARTS, INFRA);
  assert.strictEqual(acc.maps.power.byCellKey.get("7,7").tier, "light", "junction drops to Light once no heavy section is incident");
});
check("19. Change Tier preserves Data wiring", () => {
  let w = wired("standard", "standard");
  w = W.addPathWithTier(w, "data", path({ x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS, "standard");
  const before = JSON.stringify(w.data);
  const result = W.setSectionTier(w, "power", "6,7:7,7", "heavy", straight, PARTS);
  assert.strictEqual(JSON.stringify(result.wiring.data), before);
});
check("20. Change Tier preserves powerPolicy", () => {
  let w = wired("standard", "standard");
  w.powerPolicy = PP.normalizePolicy({ preset: "mobility" });
  const result = W.setSectionTier(w, "power", "6,7:7,7", "heavy", straight, PARTS);
  assert.strictEqual(result.wiring.powerPolicy.preset, "mobility");
});

// ---------------------------------------------------------------------------
// Erase (21-29)
// ---------------------------------------------------------------------------
console.log("Erase");
check("21-22. Erase removes only the target section; unrelated remain", () => {
  const w = wired("standard", "standard");
  const out = W.removeSection(w, "power", "7,7:8,7", straight, PARTS);
  assert.ok(!out.power.sections.some((s) => s.id === "7,7:8,7"));
  assert.ok(out.power.sections.some((s) => s.id === "6,7:7,7"), "unrelated section remains");
});
check("23-24. Data wiring and powerPolicy remain unchanged during Power erase", () => {
  let w = wired("standard", "standard");
  w = W.addPathWithTier(w, "data", path({ x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS, "standard");
  w.powerPolicy = PP.normalizePolicy({ preset: "offensive" });
  const before = JSON.stringify(w.data);
  const out = W.removeSection(w, "power", "7,7:8,7", straight, PARTS);
  assert.strictEqual(JSON.stringify(out.data), before);
  assert.strictEqual(out.powerPolicy.preset, "offensive");
});
check("25-26. Cost and Heat displacement decrease using unique hosted-cell accounting", () => {
  const w = wired("heavy", "heavy");
  const preview = WE.previewWiringSectionRemoval(straight, w, "power", "7,7:8,7", PARTS, INFRA, opts);
  assert.ok(preview.delta.totalInfrastructure < 0, "cost decreases");
  assert.ok(preview.delta.displacement < 0, "displacement decreases");
  // Only cell 8,7 is removed (7,7 still hosted by the other heavy section).
  assert.strictEqual(preview.delta.powerCost, -INFRA.powerTiers.heavy.costPerHostedCell);
});
check("27. Erasing a section invalidates connection metadata safely", () => {
  let w = W.addConnection(empty(), "power", 0, 2, path({ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS);
  const out = W.removeSection(w, "power", "7,7:8,7", straight, PARTS);
  assert.ok(!out.power.connections.some((c) => c.sectionIds.includes("7,7:8,7")), "stale connection metadata dropped");
  assert.strictEqual(out.version, 3);
});
check("28. Erasing empty space is a no-op with a reason", () => {
  const w = wired("standard", "standard");
  const preview = WE.previewWiringSectionRemoval(straight, w, "power", "0,0:1,0", PARTS, INFRA, opts);
  assert.strictEqual(preview.valid, false);
  assert.strictEqual(preview.reason, "missing-section");
});
check("29. Undo restores the exact erased section and tier (clone round-trip)", () => {
  const w = wired("heavy", "light");
  const snapshot = W.cloneWiring(w); // the editor pushes this before erasing
  const erased = W.removeSection(w, "power", "7,7:8,7", straight, PARTS);
  assert.ok(!erased.power.sections.some((s) => s.id === "7,7:8,7"));
  const restored = W.normalizeWiring(snapshot, straight, PARTS).wiring;
  assert.strictEqual(tierOf(restored, "7,7:8,7"), "light", "exact tier restored");
  assert.strictEqual(restored.power.sections.length, 2);
});

// ---------------------------------------------------------------------------
// Preview parity (30-37)
// ---------------------------------------------------------------------------
console.log("Preview parity");
function infraTotals(wiring) {
  const c = WI.computeInfrastructureCost(straight, wiring, PARTS, INFRA);
  const acc = WI.accountInfrastructure(straight, wiring, PARTS, INFRA);
  return { total: c.totalInfrastructure, displacement: acc.power.displacement + acc.data.displacement };
}
check("30. Draw preview delta matches the committed result", () => {
  const before = empty();
  const cells = path({ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 });
  const preview = WE.previewPowerPathEdit(straight, before, "power", cells, "heavy", PARTS, INFRA, opts);
  const committed = W.addPathWithTier(before, "power", cells, straight, PARTS, "heavy");
  const a = infraTotals(normalized(before)); const b = infraTotals(committed);
  assert.strictEqual(preview.delta.totalInfrastructure, b.total - a.total);
  assert.strictEqual(preview.delta.displacement, b.displacement - a.displacement);
});
check("31. Tier-change preview delta matches the committed result", () => {
  const w = wired("heavy", "light");
  const preview = WE.previewPowerTierEdit(straight, w, "6,7:7,7", "standard", PARTS, INFRA, opts);
  const committed = W.setSectionTier(w, "power", "6,7:7,7", "standard", straight, PARTS).wiring;
  const a = infraTotals(normalized(w)); const b = infraTotals(committed);
  assert.strictEqual(preview.delta.totalInfrastructure, b.total - a.total);
});
check("32. Erase preview delta matches the committed result", () => {
  const w = wired("heavy", "heavy");
  const preview = WE.previewWiringSectionRemoval(straight, w, "power", "7,7:8,7", PARTS, INFRA, opts);
  const committed = W.removeSection(w, "power", "7,7:8,7", straight, PARTS);
  const a = infraTotals(normalized(w)); const b = infraTotals(committed);
  assert.strictEqual(preview.delta.totalInfrastructure, b.total - a.total);
  assert.strictEqual(preview.delta.displacement, b.displacement - a.displacement);
});
check("33-34. Junction previews use highest-tier shared accounting (no double count)", () => {
  const w = wired("heavy", "light");
  // 3 unique cells: 6,7 heavy, 7,7 heavy (highest incident), 8,7 light.
  const acc = WI.accountInfrastructure(straight, w, PARTS, INFRA);
  assert.strictEqual(acc.power.uniqueHostedCellCount, 3);
  assert.strictEqual(acc.maps.power.byCellKey.get("7,7").tier, "heavy");
});
check("35. Power/Data overlap remains independently charged in previews", () => {
  let w = W.addPathWithTier(empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }), straight, PARTS, "standard");
  const preview = WE.previewPowerPathEdit(straight, w, "data", path({ x: 6, y: 7 }, { x: 7, y: 7 }), "standard", PARTS, INFRA, opts);
  assert.ok(preview.delta.dataCost > 0, "data cost added");
  assert.strictEqual(preview.delta.powerCost, 0, "power cost unchanged by a data draw");
});
check("36. Client total after edit matches server-computed total", () => {
  const w = W.addPathWithTier(empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS, "heavy");
  const server = computeStats(straight, w);
  const pre = computeStats(straight).unitCost;
  const infra = WI.computeInfrastructureCost(straight, w, PARTS, INFRA);
  assert.strictEqual(server.unitCost, Math.round(pre + infra.totalInfrastructure));
});
check("37. Client thermal capacity after edit matches server runtime capacity", () => {
  const w = W.addPathWithTier(empty(), "power", path({ x: 6, y: 7 }, { x: 7, y: 7 }, { x: 8, y: 7 }), straight, PARTS, "heavy");
  const ship = { design: straight, wiring: w, componentHp: straight.map(() => 100), componentMaxHp: straight.map(() => 100) };
  heat.initShipHeat(ship);
  straight.forEach((m, i) => {
    const b = HeatRules.profile(m.type, PARTS[m.type] || {}).capacity;
    const disp = ship.componentWiringDisplacement[i];
    assert.strictEqual(WI.clampDisplacedCapacity(b, disp, 0, INFRA), ship.componentThermals[i].capacity, `component ${i}`);
  });
});

// ---------------------------------------------------------------------------
// Rendering / UI logic (38-45 where Node-testable)
// ---------------------------------------------------------------------------
console.log("Rendering / UI logic");
check("38. Light, Standard and Heavy have strictly increasing rendered widths", () => {
  const t = INFRA.powerTiers;
  assert.ok(t.light.renderedThickness < t.standard.renderedThickness);
  assert.ok(t.standard.renderedThickness < t.heavy.renderedThickness);
});
check("40. Data has no functional tier (Change Tier on Data is a rejected reason)", () => {
  const result = W.setSectionTier(W.emptyWiring(), "data", "x", "heavy", straight, PARTS);
  assert.strictEqual(result.changed, false);
  assert.strictEqual(result.reason, "data-has-no-tiers");
});
check("42. Inspect/preview performs no Blueprint mutation", () => {
  const w = wired("heavy", "light");
  const snapshot = JSON.stringify(w);
  WE.previewWiringSectionRemoval(straight, w, "power", "7,7:8,7", PARTS, INFRA, opts);
  WE.previewPowerTierEdit(straight, w, "6,7:7,7", "standard", PARTS, INFRA, opts);
  assert.strictEqual(JSON.stringify(w), snapshot, "preview never mutates the input wiring");
});
check("43. Invalid actions expose a reason", () => {
  assert.strictEqual(WE.previewPowerPathEdit(straight, empty(), "power", [{ x: 6, y: 7 }], "heavy", PARTS, INFRA, opts).reason, "empty-path");
  assert.strictEqual(WE.previewPowerTierEdit(straight, empty(), "no-such", "heavy", PARTS, INFRA, opts).reason, "missing-section");
});

// ---------------------------------------------------------------------------
// Save/load regression (46-52)
// ---------------------------------------------------------------------------
console.log("Save/load regression");
check("46-47. Tiered wiring survives normalisation (local save/duplication)", () => {
  const w = wired("heavy", "light");
  const roundTrip = W.normalizeWiring(W.cloneWiring(w), straight, PARTS).wiring;
  assert.strictEqual(tierOf(roundTrip, "6,7:7,7"), "heavy");
  assert.strictEqual(tierOf(roundTrip, "7,7:8,7"), "light");
});
check("48-49. Tiered wiring survives server normalisation and stays version 3", () => {
  const w = wired("heavy", "light");
  const server = validateWiring(straight, w).wiring;
  assert.strictEqual(server.version, 3);
  assert.strictEqual(tierOf(server, "6,7:7,7"), "heavy");
  assert.strictEqual(tierOf(server, "7,7:8,7"), "light");
});
check("50. Migrated Standard designs behave unchanged (no re-migration drift)", () => {
  const v2 = { version: 2, power: { sections: [{ id: "6,7:7,7", x1: 6, y1: 7, x2: 7, y2: 7, tier: "standard" }], connections: [] }, data: { sections: [], connections: [] } };
  const once = W.normalizeWiring(v2, straight, PARTS).wiring;
  const twice = W.normalizeWiring(once, straight, PARTS).wiring;
  assert.deepStrictEqual(once, twice);
  assert.strictEqual(tierOf(once, "6,7:7,7"), "standard");
});
check("51-52. Power allocation and Data support behaviour unchanged by tiers", () => {
  const std = wired("standard", "standard");
  const heavy = wired("heavy", "heavy");
  const pa = W.analyzePowerNetworks(straight, std, PARTS);
  const pb = W.analyzePowerNetworks(straight, heavy, PARTS);
  assert.deepStrictEqual(pa.networks.map((n) => n.status), pb.networks.map((n) => n.status));
  assert.strictEqual(pa.totalConnectedDemandMw, pb.totalConnectedDemandMw);
});

// ---------------------------------------------------------------------------
// Actual Heat-capacity delta (heat-sink adjacency + minimum clamp)
// ---------------------------------------------------------------------------
console.log("Actual Heat-capacity delta");
check("A. Heat Sink adjacency: delta.actualHeatCapacity matches server thermal result", () => {
  // frame(7,7) is adjacent to a heatSink(8,7) [+35 static bonus] and hosts a
  // heavy Power cell via reactor(6,7)-frame(7,7).
  const design = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "heatSink" }];
  // Pre-displacement caps = base + heat-sink bonus (server with no wiring).
  const preCaps = serverCaps(design, W.emptyWiring());
  const wHeavy = W.addPathWithTier(W.emptyWiring(), "power", [{ x: 6, y: 7 }, { x: 7, y: 7 }], design, PARTS, "heavy");
  const capsHeavy = serverCaps(design, wHeavy);
  const capsRemoved = serverCaps(design, W.emptyWiring());
  const serverDelta = capsRemoved.reduce((sum, cap, i) => sum + (cap - capsHeavy[i]), 0);
  const preview = WE.previewWiringSectionRemoval(design, wHeavy, "power", "6,7:7,7", PARTS, INFRA, { baseCapacities: preCaps, preInfrastructureShipCost: 100 });
  assert.ok(preview.valid);
  assert.strictEqual(preview.delta.actualHeatCapacity, serverDelta, "actual capacity delta matches server");
  // The heat-sink bonus keeps the frame well above the minimum, so full capacity is restored.
  assert.ok(preview.delta.actualHeatCapacity > 0, "removing cable restores real capacity");
});
check("B. Minimum clamp: preview reports actual clamped change, not raw displacement", () => {
  const design = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "core" }];
  // Both components already at the configured minimum capacity.
  const atMin = design.map(() => INFRA.minimumComponentHeatCapacity);
  const preview = WE.previewPowerPathEdit(design, W.emptyWiring(), "power", [{ x: 6, y: 7 }, { x: 7, y: 7 }], "heavy", PARTS, INFRA, { baseCapacities: atMin, preInfrastructureShipCost: 100 });
  assert.ok(preview.valid);
  // Two heavy host cells → raw displacement is 2 x heavy, but capacity is clamped.
  assert.strictEqual(preview.delta.displacement, INFRA.powerTiers.heavy.heatCapacityDisplacement * 2, "raw displacement preserved");
  assert.strictEqual(preview.delta.actualHeatCapacity, 0, "clamped capacity does not actually change");
  assert.notStrictEqual(preview.delta.actualHeatCapacity, -preview.delta.displacement, "actual differs from raw displacement under clamp");
});

console.log(`\nSection 7B wiring-editor verification passed (${passed} checks)`);
