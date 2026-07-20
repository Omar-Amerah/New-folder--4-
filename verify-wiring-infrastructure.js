#!/usr/bin/env node
"use strict";

// Section 7A — Advanced Power Distribution Foundations.
// Verifies Wiring v3 migration, Power cable tiers, single-tier Data, the shared
// hosted-cell mapper, unique hosted-cell accounting, infrastructure cost,
// static Heat-capacity displacement, Power policy, and regression safety.

const assert = require("assert");
const W = require("./public/src/shared/wiringRules");
const WI = require("./public/src/shared/wiringInfrastructureRules");
const PP = require("./public/src/shared/powerPolicyRules");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { computeStats } = require("./src/server/shipStats");
const { validateBuildShip } = require("./src/server/validation");
const { analyzeShipPower, createGeneratedPowerWiring } = require("./src/server/shipDesign");
const HeatRules = require("./public/src/shared/heatRules");
const heat = require("./src/server/heat");
const componentPower = require("./src/server/componentPower");

const INFRA = BALANCE.wiringInfrastructure;
let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }

function powerWiring(sections) {
  return { version: 3, power: { sections, connections: [] }, data: { sections: [], connections: [] }, powerPolicy: PP.defaultPolicy() };
}
function section(x1, y1, x2, y2, tier = "standard") { return { id: W.sectionIdFromCells({ x: x1, y: y1 }, { x: x2, y: y2 }), x1, y1, x2, y2, tier }; }

// ---------------------------------------------------------------------------
// Migration (1-8)
// ---------------------------------------------------------------------------
console.log("Migration");
check("1. Wiring v2 Power sections migrate to Standard", () => {
  const v2 = { version: 2, power: { sections: [{ id: "6,7:7,7", x1: 6, y1: 7, x2: 7, y2: 7, tier: "standard" }], connections: [] }, data: { sections: [], connections: [] } };
  const m = W.migrateWiringToCurrentVersion(v2);
  assert.strictEqual(m.version, 3);
  assert.strictEqual(m.power.sections[0].tier, "standard");
});
check("2. Wiring v2 Data sections remain valid single-tier", () => {
  const v2 = { version: 2, data: { sections: [{ id: "7,7:7,8", tier: "heavy" }], connections: [] } };
  const m = W.migrateWiringToCurrentVersion(v2);
  assert.strictEqual(m.data.sections[0].tier, "standard", "data never gains a functional tier");
});
check("3. Section IDs and coordinates are preserved", () => {
  const v2 = { version: 2, power: { sections: [{ id: "6,7:7,7", x1: 6, y1: 7, x2: 7, y2: 7, tier: "standard" }], connections: [] } };
  const m = W.migrateWiringToCurrentVersion(v2);
  assert.deepStrictEqual({ id: m.power.sections[0].id, x1: m.power.sections[0].x1, y1: m.power.sections[0].y1, x2: m.power.sections[0].x2, y2: m.power.sections[0].y2 }, { id: "6,7:7,7", x1: 6, y1: 7, x2: 7, y2: 7 });
});
check("4. Connections remain valid through migration", () => {
  const v2 = { version: 2, power: { sections: [{ id: "6,7:7,7", x1: 6, y1: 7, x2: 7, y2: 7, tier: "standard" }], connections: [{ sourceIndex: 0, targetIndex: 1, sectionIds: ["6,7:7,7"] }] } };
  const m = W.migrateWiringToCurrentVersion(v2);
  assert.deepStrictEqual(m.power.connections[0], { sourceIndex: 0, targetIndex: 1, sectionIds: ["6,7:7,7"] });
});
check("5. Missing policy becomes Balanced", () => {
  const m = W.migrateWiringToCurrentVersion({ version: 2, power: { sections: [], connections: [] } });
  assert.strictEqual(m.powerPolicy.preset, "balanced");
  assert.deepStrictEqual(m.powerPolicy.customOrder, ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]);
});
check("6. Invalid policy values normalise safely", () => {
  const m = W.migrateWiringToCurrentVersion({ version: 2, powerPolicy: { preset: "bogus", customOrder: ["weapons", "weapons", "nope"] } });
  assert.strictEqual(m.powerPolicy.preset, "balanced");
  assert.deepStrictEqual([...m.powerPolicy.customOrder].sort(), ["command", "coolingSupport", "pointDefence", "propulsion", "shields", "weapons"], "custom order repaired to a full deterministic permutation");
  assert.strictEqual(m.powerPolicy.customOrder[0], "weapons", "recognised categories keep supplied order");
});
check("7. Migration is idempotent", () => {
  const v2 = { version: 2, power: { sections: [{ id: "6,7:7,7", x1: 6, y1: 7, x2: 7, y2: 7, tier: "standard" }], connections: [] }, data: { sections: [], connections: [] } };
  const once = W.migrateWiringToCurrentVersion(v2);
  const twice = W.migrateWiringToCurrentVersion(once);
  assert.deepStrictEqual(once, twice);
});
check("8. Malformed / absent wiring migrates to safe empty v3 (never emptied route loss)", () => {
  assert.strictEqual(W.migrateWiringToCurrentVersion(null).version, 3);
  // Version-mismatched saves keep their sections instead of being wiped.
  const carried = W.migrateWiringToCurrentVersion({ version: 99, power: { sections: [{ id: "6,7:7,7", x1: 6, y1: 7, x2: 7, y2: 7, tier: "heavy" }], connections: [] } });
  assert.strictEqual(carried.power.sections.length, 1, "sections are carried forward across version mismatch");
});

// ---------------------------------------------------------------------------
// Tier validation (9-12)
// ---------------------------------------------------------------------------
console.log("Tier validation");
const tierDesign = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }];
check("9. Light, Standard and Heavy accepted for Power", () => {
  for (const tier of ["light", "standard", "heavy"]) {
    const n = W.normalizeWiring(powerWiring([section(6, 7, 7, 7, tier)]), tierDesign, PARTS).wiring;
    assert.strictEqual(n.power.sections[0].tier, tier);
  }
});
check("10. Invalid Power tiers normalise deterministically to standard", () => {
  const n = W.normalizeWiring(powerWiring([section(6, 7, 7, 7, "ultra")]), tierDesign, PARTS).wiring;
  assert.strictEqual(n.power.sections[0].tier, "standard");
});
check("11. Data cannot gain functional tier behaviour", () => {
  const wiring = { version: 3, power: { sections: [], connections: [] }, data: { sections: [section(7, 7, 8, 7, "heavy")], connections: [] }, powerPolicy: PP.defaultPolicy() };
  const n = W.normalizeWiring(wiring, tierDesign, PARTS).wiring;
  assert.strictEqual(n.data.sections[0].tier, "standard");
});
check("12. Default generated Power wiring is Standard", () => {
  const gen = createGeneratedPowerWiring(require("./src/server/config").DEFAULT_DESIGN);
  assert.ok(gen.power.sections.length > 0);
  assert.ok(gen.power.sections.every((s) => s.tier === "standard"));
});

// ---------------------------------------------------------------------------
// Hosted-cell mapping (13-17)
// ---------------------------------------------------------------------------
console.log("Hosted-cell mapping");
check("13. A one-section route maps to exactly two host cells", () => {
  const maps = WI.mapHostedCells(tierDesign, powerWiring([section(6, 7, 7, 7)]), PARTS);
  assert.strictEqual(maps.power.uniqueHostedCells.length, 2);
  const entry = maps.power.bySectionId.get("6,7:7,7");
  assert.strictEqual(entry.hostCells.length, 2);
  assert.deepStrictEqual(entry.uniqueComponentIndices, [0, 1]);
});
check("14. A multi-cell component may host both endpoints", () => {
  // engine footprint is 1x2 -> occupies (7,7) and (7,8).
  const design = [{ x: 7, y: 7, type: "engine", rotation: 0 }];
  const maps = WI.mapHostedCells(design, powerWiring([section(7, 7, 7, 8)]), PARTS);
  const entry = maps.power.bySectionId.get("7,7:7,8");
  assert.deepStrictEqual(entry.uniqueComponentIndices, [0], "both endpoints owned by one component");
  assert.strictEqual(maps.power.uniqueHostedCells.length, 2, "two distinct host cells still counted");
});
check("15. A branch junction returns deterministic host mappings", () => {
  const design = [{ x: 7, y: 6, type: "reactor" }, { x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "blaster" }];
  const wiring = powerWiring([section(7, 6, 7, 7), section(6, 7, 7, 7), section(7, 7, 8, 7)]);
  const a = JSON.stringify(WI.mapHostedCells(design, wiring, PARTS).power.uniqueHostedCells);
  const b = JSON.stringify(WI.mapHostedCells(design, wiring, PARTS).power.uniqueHostedCells);
  assert.strictEqual(a, b);
  assert.deepStrictEqual(JSON.parse(a), ["6,7", "7,6", "7,7", "8,7"], "deterministic sorted host cells");
});
check("16. Power and Data map to the same host cell independently", () => {
  const wiring = { version: 3, power: { sections: [section(6, 7, 7, 7)], connections: [] }, data: { sections: [section(6, 7, 7, 7)], connections: [] }, powerPolicy: PP.defaultPolicy() };
  const maps = WI.mapHostedCells(tierDesign, wiring, PARTS);
  assert.ok(maps.power.byCellKey.has("6,7") && maps.data.byCellKey.has("6,7"));
});
check("17. Same shared mapper result for client and server callers", () => {
  const wiring = powerWiring([section(6, 7, 7, 7)]);
  const clientView = WI.mapHostedCells(tierDesign, wiring, PARTS).power.uniqueHostedCells;
  // The server runtime reuses the identical shared authority.
  const ship = { design: tierDesign, wiring: W.normalizeWiring(wiring, tierDesign, PARTS).wiring };
  const serverMaps = WI.mapHostedCells(ship.design, ship.wiring, PARTS).power.uniqueHostedCells;
  assert.deepStrictEqual(clientView, serverMaps);
});

// ---------------------------------------------------------------------------
// Unique-cell accounting (18-22)
// ---------------------------------------------------------------------------
console.log("Unique-cell accounting");
const straight = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }];
check("18. A three-cell straight route counts three unique Power cells", () => {
  const acc = WI.accountInfrastructure(straight, powerWiring([section(6, 7, 7, 7), section(7, 7, 8, 7)]), PARTS, INFRA);
  assert.strictEqual(acc.power.uniqueHostedCellCount, 3);
});
check("19. Shared trunk cells are not double-counted", () => {
  const design = [{ x: 7, y: 6, type: "reactor" }, { x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "blaster" }];
  const acc = WI.accountInfrastructure(design, powerWiring([section(7, 6, 7, 7), section(6, 7, 7, 7), section(7, 7, 8, 7)]), PARTS, INFRA);
  assert.strictEqual(acc.power.uniqueHostedCellCount, 4, "junction cell 7,7 counted once");
});
check("20. A junction with Heavy and Light incident sections is accounted as Heavy", () => {
  const acc = WI.accountInfrastructure(straight, powerWiring([section(6, 7, 7, 7, "heavy"), section(7, 7, 8, 7, "light")]), PARTS, INFRA);
  assert.strictEqual(acc.maps.power.byCellKey.get("7,7").tier, "heavy");
});
check("21. The Light section itself remains Light", () => {
  const wiring = W.normalizeWiring(powerWiring([section(6, 7, 7, 7, "heavy"), section(7, 7, 8, 7, "light")]), straight, PARTS).wiring;
  assert.strictEqual(wiring.power.sections.find((s) => s.id === "7,7:8,7").tier, "light");
});
check("22. Power and Data overlap both contribute independently", () => {
  const wiring = { version: 3, power: { sections: [section(6, 7, 7, 7)], connections: [] }, data: { sections: [section(6, 7, 7, 7)], connections: [] }, powerPolicy: PP.defaultPolicy() };
  const acc = WI.accountInfrastructure(straight, wiring, PARTS, INFRA);
  assert.ok(acc.power.cost > 0 && acc.data.cost > 0);
  assert.ok(acc.power.displacement > 0 && acc.data.displacement > 0);
  const c0 = acc.byComponentIndex[0];
  assert.ok(c0.powerDisplacement > 0 && c0.dataDisplacement > 0, "one cell carries both power and data displacement");
});

// ---------------------------------------------------------------------------
// Cost (23-30)
// ---------------------------------------------------------------------------
console.log("Cost");
const oneCell = (tier) => WI.computeInfrastructureCost(straight, powerWiring([section(6, 7, 7, 7, tier)]), PARTS, INFRA).powerWiring;
check("23. Light costs less than Standard", () => assert.ok(oneCell("light") < oneCell("standard")));
check("24. Standard costs less than Heavy", () => assert.ok(oneCell("standard") < oneCell("heavy")));
check("25. Data costs less than Light Power cable", () => {
  const dataCost = WI.computeInfrastructureCost(straight, { version: 3, power: { sections: [], connections: [] }, data: { sections: [section(6, 7, 7, 7)], connections: [] } }, PARTS, INFRA).dataWiring;
  // per-cell comparison: one power light cell vs one data cell
  assert.ok(INFRA.data.costPerHostedCell < INFRA.powerTiers.light.costPerHostedCell);
  assert.ok(dataCost > 0);
});
check("26. Upgrading a section changes total by the correct hosted-cell difference", () => {
  const std = computeStats(straight, powerWiring([section(6, 7, 7, 7, "standard"), section(7, 7, 8, 7, "standard")]));
  const up = computeStats(straight, powerWiring([section(6, 7, 7, 7, "heavy"), section(7, 7, 8, 7, "standard")]));
  // Upgrading the 6,7:7,7 section lifts cells 6,7 and 7,7 from standard to heavy.
  const perCell = INFRA.powerTiers.heavy.costPerHostedCell - INFRA.powerTiers.standard.costPerHostedCell;
  assert.strictEqual(up.costBreakdown.totalInfrastructure - std.costBreakdown.totalInfrastructure, perCell * 2);
});
check("27. Downgrading reduces total cost correctly", () => {
  const heavy = computeStats(straight, powerWiring([section(6, 7, 7, 7, "heavy")]));
  const light = computeStats(straight, powerWiring([section(6, 7, 7, 7, "light")]));
  assert.ok(light.unitCost < heavy.unitCost);
});
check("28. Erasing wiring removes its design cost", () => {
  const wired = computeStats(straight, powerWiring([section(6, 7, 7, 7, "heavy")]));
  const erased = computeStats(straight, W.emptyWiring());
  assert.strictEqual(erased.costBreakdown.totalInfrastructure, 0);
  assert.ok(wired.unitCost > erased.unitCost);
});
check("29. Client and server totals match (shared presentation is authoritative)", () => {
  const wiring = powerWiring([section(6, 7, 7, 7, "heavy"), section(7, 7, 8, 7, "light")]);
  const server = computeStats(straight, wiring);
  const componentsOnly = computeStats(straight).unitCost;
  const infra = WI.computeInfrastructureCost(straight, wiring, PARTS, INFRA);
  const presentation = WI.infrastructureCostPresentation(componentsOnly, infra.powerWiring, infra.dataWiring);
  assert.strictEqual(server.unitCost, Math.round(presentation.totalShipCost));
});
check("30. Purchase validation uses the new total cost", () => {
  // A thrust-bearing design so validateBuildShip reaches the affordability gate.
  const thrustDesign = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }];
  const wiring = powerWiring([section(6, 7, 7, 7, "heavy")]);
  const withInfra = computeStats(thrustDesign, wiring);
  const componentsOnly = computeStats(thrustDesign);
  assert.ok(withInfra.unitCost > componentsOnly.unitCost, "infrastructure raises the price");
  const room = { phase: "design" };
  const rejected = validateBuildShip(room, { ready: true, money: withInfra.unitCost - 1 }, withInfra);
  assert.strictEqual(rejected.ok, false, "cannot afford total including infrastructure");
  const affordable = validateBuildShip(room, { ready: true, money: withInfra.unitCost }, withInfra);
  assert.strictEqual(affordable.ok, true);
});

// ---------------------------------------------------------------------------
// Thermal displacement (31-37)
// ---------------------------------------------------------------------------
console.log("Thermal displacement");
const dispBase = straight.map((m) => HeatRules.profile(m.type, PARTS[m.type] || {}).capacity);
const dispFor = (tier) => WI.componentThermalDiagnostics(straight, powerWiring([section(6, 7, 7, 7, tier)]), PARTS, INFRA, dispBase)[0].powerDisplacement;
check("31. Light displacement is less than Standard", () => assert.ok(dispFor("light") < dispFor("standard")));
check("32. Standard displacement is less than Heavy", () => assert.ok(dispFor("standard") < dispFor("heavy")));
check("33. Data applies its independent displacement", () => {
  const wiring = { version: 3, power: { sections: [], connections: [] }, data: { sections: [section(6, 7, 7, 7)], connections: [] } };
  const diag = WI.componentThermalDiagnostics(straight, wiring, PARTS, INFRA, dispBase);
  assert.strictEqual(diag[0].dataDisplacement, INFRA.data.heatCapacityDisplacement);
});
check("34. Multiple unique hosted cells stack", () => {
  // A 1x2 engine hosting a section between its own two cells hosts two cells.
  const design = [{ x: 7, y: 7, type: "engine", rotation: 0 }];
  const base = design.map((m) => HeatRules.profile(m.type, PARTS[m.type] || {}).capacity);
  const diag = WI.componentThermalDiagnostics(design, powerWiring([section(7, 7, 7, 8, "standard")]), PARTS, INFRA, base);
  assert.strictEqual(diag[0].powerDisplacement, INFRA.powerTiers.standard.heatCapacityDisplacement * 2);
});
check("35. Shared route metadata does not duplicate displacement", () => {
  const design = [{ x: 7, y: 6, type: "reactor" }, { x: 6, y: 7, type: "core" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "blaster" }];
  const base = design.map((m) => HeatRules.profile(m.type, PARTS[m.type] || {}).capacity);
  // frame (index 2) hosts the junction cell 7,7 which has three incident sections.
  const diag = WI.componentThermalDiagnostics(design, powerWiring([section(7, 6, 7, 7, "heavy"), section(6, 7, 7, 7, "heavy"), section(7, 7, 8, 7, "heavy")]), PARTS, INFRA, base);
  assert.strictEqual(diag[2].hostedHeavyCells, 1, "junction cell counted once for its component");
  assert.strictEqual(diag[2].powerDisplacement, INFRA.powerTiers.heavy.heatCapacityDisplacement);
});
check("36. Final capacity respects the configured minimum", () => {
  const clamped = WI.clampDisplacedCapacity(5, 1000, 1000, INFRA);
  assert.strictEqual(clamped, INFRA.minimumComponentHeatCapacity);
  assert.ok(clamped > 0 && Number.isFinite(clamped));
});
check("37. Blueprint thermal output matches server runtime capacity (no bonuses)", () => {
  const wiring = W.normalizeWiring(powerWiring([section(6, 7, 7, 7, "heavy"), section(7, 7, 8, 7, "light")]), straight, PARTS).wiring;
  const ship = { design: straight, wiring, componentHp: straight.map(() => 100), componentMaxHp: straight.map(() => 100) };
  heat.initShipHeat(ship);
  // With no heat sinks the client final capacity equals base - displacement.
  straight.forEach((m, i) => {
    const base = HeatRules.profile(m.type, PARTS[m.type] || {}).capacity;
    const disp = ship.componentWiringDisplacement[i];
    const clientCapacity = WI.clampDisplacedCapacity(base, disp, 0, INFRA);
    assert.strictEqual(clientCapacity, ship.componentThermals[i].capacity, `component ${i} capacity parity`);
  });
});
check("37b. Displacement is applied AFTER legitimate static bonuses (heat-sink adjacency)", () => {
  // frame(7,7) is adjacent to a heatSink(8,7) [+static bonus] and hosts a heavy
  // Power cell via reactor(6,7)-frame(7,7). Order must be base + bonus - disp.
  const design = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "frame" }, { x: 8, y: 7, type: "heatSink" }];
  const wiring = W.normalizeWiring(powerWiring([section(6, 7, 7, 7, "heavy")]), design, PARTS).wiring;
  const ship = { design, wiring, componentHp: design.map(() => 100), componentMaxHp: design.map(() => 100) };
  heat.initShipHeat(ship);
  const frameBase = HeatRules.profile("frame", PARTS.frame).capacity;
  const heavyDisp = INFRA.powerTiers.heavy.heatCapacityDisplacement;
  const expected = Math.max(INFRA.minimumComponentHeatCapacity, frameBase + 35 - heavyDisp);
  assert.strictEqual(ship.componentThermals[1].capacity, expected, "frame = base + heat-sink bonus - heavy displacement");
  // Wrong order (clamp base - disp first, then add bonus) would differ only when
  // clamped; assert the additive identity holds so bonus is not lost to clamp.
  assert.ok(ship.componentThermals[1].capacity > frameBase, "static bonus survives displacement");
  // Client parity: base + bonus then displacement, via the shared clamp.
  const clientCapacity = WI.clampDisplacedCapacity(frameBase + 35, heavyDisp, 0, INFRA);
  assert.strictEqual(clientCapacity, ship.componentThermals[1].capacity, "client and server agree on order");
});

// ---------------------------------------------------------------------------
// Regression (38-42)
// ---------------------------------------------------------------------------
console.log("Regression");
function buildShip(design, wiring) {
  const normalized = W.normalizeWiring(wiring, design, PARTS).wiring;
  const ship = { design, wiring: normalized, componentHp: design.map(() => 100), componentMaxHp: design.map(() => 100), alive: true, stats: { ...computeStats(design, normalized) } };
  componentPower.initializeComponentPower(ship);
  return ship;
}
const powerRegressionDesign = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }];
check("38. Existing Power allocation behaviour is unchanged across tiers", () => {
  const std = analyzeShipPower(powerRegressionDesign, W.normalizeWiring(powerWiring([section(6, 7, 7, 7, "standard"), section(7, 7, 8, 7, "standard")]), powerRegressionDesign, PARTS).wiring);
  const heavy = analyzeShipPower(powerRegressionDesign, W.normalizeWiring(powerWiring([section(6, 7, 7, 7, "heavy"), section(7, 7, 8, 7, "heavy")]), powerRegressionDesign, PARTS).wiring);
  assert.strictEqual(std.networks.length, heavy.networks.length);
  assert.strictEqual(std.totalConnectedGenerationMw, heavy.totalConnectedGenerationMw);
  assert.strictEqual(std.totalConnectedDemandMw, heavy.totalConnectedDemandMw);
  assert.deepStrictEqual(std.networks.map((n) => n.status), heavy.networks.map((n) => n.status));
});
check("39. Existing Data support behaviour is unchanged (tier-free)", () => {
  const design = [{ x: 5, y: 6, type: "fireControl" }, { x: 6, y: 6, type: "beamEmitter" }];
  const wiring = { version: 3, power: { sections: [], connections: [] }, data: { sections: [section(5, 6, 6, 6)], connections: [{ sourceIndex: 0, targetIndex: 1, sectionIds: ["5,6:6,6"] }] }, powerPolicy: PP.defaultPolicy() };
  const analysis = W.analyzeWiring(design, wiring, PARTS);
  assert.ok(analysis.data.networks.length >= 1);
});
check("40. Destroying a component still disables sections hosted by it", () => {
  const ship = buildShip(powerRegressionDesign, powerWiring([section(6, 7, 7, 7, "standard"), section(7, 7, 8, 7, "standard")]));
  const before = ship.runtimeWiring.power.operationalSectionIds.size;
  assert.ok(before >= 1);
  ship.componentHp[2] = 0; // blaster destroyed -> section 7,7:8,7 loses a host
  componentPower.rebuildShipWiringState(ship, "component-boundary");
  assert.ok(!ship.runtimeWiring.power.operationalSectionIds.has("7,7:8,7"), "section hosted by a destroyed component is disabled");
});
check("41. Repair still restores the original saved wiring", () => {
  const ship = buildShip(powerRegressionDesign, powerWiring([section(6, 7, 7, 7, "standard"), section(7, 7, 8, 7, "standard")]));
  ship.componentHp[2] = 0;
  componentPower.rebuildShipWiringState(ship, "component-boundary");
  assert.ok(!ship.runtimeWiring.power.operationalSectionIds.has("7,7:8,7"));
  ship.componentHp[2] = 100; // repaired
  componentPower.rebuildShipWiringState(ship, "component-boundary");
  assert.ok(ship.runtimeWiring.power.operationalSectionIds.has("7,7:8,7"), "saved wiring restored after repair");
  assert.strictEqual(ship.wiring.power.sections.length, 2, "immutable blueprint wiring never deleted");
});
check("42. Existing default ships remain valid and deployable", () => {
  const { DEFAULT_DESIGN } = require("./src/server/config");
  const wiring = createGeneratedPowerWiring(DEFAULT_DESIGN);
  const stats = computeStats(DEFAULT_DESIGN, wiring);
  assert.ok(stats.thrust > 0 && stats.unitCost > 0);
  assert.ok(stats.costBreakdown.totalInfrastructure >= 0);
});

// ---------------------------------------------------------------------------
// Power categories, policy and balance schema
// ---------------------------------------------------------------------------
console.log("Categories, policy and schema");
const { validateComponentBalance } = require("./src/server/componentSchema");
check("43. Every Power-consuming component has an authoritative category", () => {
  for (const component of BALANCE.components) {
    const consumes = (Number(component.powerUse) || 0) > 0 && !["core", "reactor", "auxGenerator"].includes(component.id);
    if (consumes) assert.ok(PP.isPowerCategory(component.powerCategory), `${component.id} needs a valid Power category`);
  }
  assert.strictEqual(PARTS.blaster.powerCategory, "weapons");
  assert.strictEqual(PARTS.shield.powerCategory, "shields");
  assert.strictEqual(PARTS.pointDefense.powerCategory, "pointDefence");
  assert.strictEqual(PARTS.reactor.powerCategory, null, "passive/source components need no category");
});
check("44. Schema rejects invalid categories and infrastructure", () => {
  const unknownCat = JSON.parse(JSON.stringify(BALANCE));
  unknownCat.components.find((c) => c.id === "blaster").powerCategory = "bogus";
  assert.strictEqual(validateComponentBalance(unknownCat).ok, false, "unknown category rejected");
  const missingCat = JSON.parse(JSON.stringify(BALANCE));
  delete missingCat.components.find((c) => c.id === "shield").powerCategory;
  assert.strictEqual(validateComponentBalance(missingCat).ok, false, "missing category on consumer rejected");
  const nonString = JSON.parse(JSON.stringify(BALANCE));
  nonString.components.find((c) => c.id === "railgun").powerCategory = 5;
  assert.strictEqual(validateComponentBalance(nonString).ok, false, "non-string category rejected");
  const badOrder = JSON.parse(JSON.stringify(BALANCE));
  badOrder.wiringInfrastructure.powerTiers.heavy.costPerHostedCell = 0;
  assert.strictEqual(validateComponentBalance(badOrder).ok, false, "heavy must cost more than standard");
  const badPeak = JSON.parse(JSON.stringify(BALANCE));
  badPeak.wiringInfrastructure.powerTiers.standard.peakCapacityMw = 1;
  assert.strictEqual(validateComponentBalance(badPeak).ok, false, "peak must be >= sustained");
  const badMin = JSON.parse(JSON.stringify(BALANCE));
  badMin.wiringInfrastructure.minimumComponentHeatCapacity = 0;
  assert.strictEqual(validateComponentBalance(badMin).ok, false, "minimum capacity must be positive");
});
check("45. Power policy normalisation is deterministic and clones independently", () => {
  const a = PP.normalizePolicy({ preset: "balanced" });
  const b = PP.clonePolicy(a);
  b.customOrder.push("weapons");
  assert.notStrictEqual(a.customOrder.length, b.customOrder.length, "clone does not share the order array");
  assert.ok(PP.isValidCustomOrder(PP.defaultPolicy().customOrder));
});
check("46. Locked preset names are Balanced/Defensive/Offensive/Mobility/Custom", () => {
  assert.deepStrictEqual(PP.ACCEPTED_PRESETS, ["balanced", "defensive", "offensive", "mobility", "custom"]);
  for (const name of ["balanced", "defensive", "offensive", "mobility", "custom"]) assert.ok(PP.isPresetName(name), `${name} accepted`);
  assert.strictEqual(PP.isPresetName("survival"), false, "survival is no longer a valid preset");
  // Named presets seed their order; custom without an order falls back to Balanced.
  assert.deepStrictEqual(PP.normalizePolicy({ preset: "mobility" }).customOrder, PP.POWER_PRESETS.mobility);
  assert.deepStrictEqual(PP.normalizePolicy({ preset: "defensive" }).customOrder, PP.POWER_PRESETS.defensive);
  const custom = PP.normalizePolicy({ preset: "custom", customOrder: ["weapons", "command"] });
  assert.strictEqual(custom.preset, "custom");
  assert.strictEqual(custom.customOrder[0], "weapons", "custom honours its own order");
  assert.ok(PP.isValidCustomOrder(custom.customOrder), "custom order is a full permutation");
});
check("47. wiringInfrastructure catalogue section is required, not optional", () => {
  const missing = JSON.parse(JSON.stringify(BALANCE));
  delete missing.wiringInfrastructure;
  assert.strictEqual(validateComponentBalance(missing).ok, false, "missing wiringInfrastructure rejected");
  for (const tier of ["light", "standard", "heavy"]) {
    const noTier = JSON.parse(JSON.stringify(BALANCE));
    delete noTier.wiringInfrastructure.powerTiers[tier];
    assert.strictEqual(validateComponentBalance(noTier).ok, false, `missing ${tier} tier rejected`);
  }
  const noData = JSON.parse(JSON.stringify(BALANCE));
  delete noData.wiringInfrastructure.data;
  assert.strictEqual(validateComponentBalance(noData).ok, false, "missing data section rejected");
  const noMin = JSON.parse(JSON.stringify(BALANCE));
  delete noMin.wiringInfrastructure.minimumComponentHeatCapacity;
  assert.strictEqual(validateComponentBalance(noMin).ok, false, "missing minimum capacity rejected");
});
check("48. All wiring reconstruction operations preserve a custom Power policy", () => {
  const design = [{ x: 6, y: 7, type: "reactor" }, { x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }];
  let wiring = W.normalizeWiring(powerWiring([section(6, 7, 7, 7, "standard"), section(7, 7, 8, 7, "standard")]), design, PARTS).wiring;
  // Set a distinctive custom policy on the saved Blueprint.
  wiring.powerPolicy = PP.normalizePolicy({ preset: "custom", customOrder: ["weapons", "command", "propulsion", "shields", "pointDefence", "coolingSupport"] });
  const expect = (result, label) => {
    assert.strictEqual(result.powerPolicy.preset, "custom", `${label} keeps preset`);
    assert.strictEqual(result.powerPolicy.customOrder[0], "weapons", `${label} keeps custom order`);
  };
  expect(W.normalizeWiring(wiring, design, PARTS).wiring, "normalizeWiring");
  expect(W.cloneWiring(wiring), "cloneWiring");
  expect(W.addPath(wiring, "data", [{ x: 7, y: 7 }, { x: 8, y: 7 }], design, PARTS), "addPath");
  expect(W.removeSection(wiring, "power", "7,7:8,7", design, PARTS), "removeSection");
  expect(W.removeBranch(wiring, "power", "7,7:8,7", null, design, PARTS).wiring, "removeBranch");
  const net = W.analyzeWiring(design, wiring, PARTS).power.networks[0];
  if (net) expect(W.removeNetwork(wiring, "power", net, design, PARTS), "removeNetwork");
  // Server Blueprint snapshot creation preserves the policy too.
  const { createShipBlueprintSnapshot } = require("./src/server/shipDesign");
  expect(createShipBlueprintSnapshot(design, wiring).wiring, "createShipBlueprintSnapshot");
});
check("49. Cost presentation field is named preInfrastructureShipCost (not misleading 'components')", () => {
  const presentation = WI.infrastructureCostPresentation(850, 4, 1);
  assert.strictEqual(presentation.preInfrastructureShipCost, 850);
  assert.strictEqual(presentation.components, undefined, "ambiguous 'components' field removed");
  assert.strictEqual(presentation.totalShipCost, 855);
});

console.log(`\nSection 7A wiring-infrastructure verification passed (${passed} checks)`);
