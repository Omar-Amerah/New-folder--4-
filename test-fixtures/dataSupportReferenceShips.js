"use strict";

const assert = require("assert");
const WiringRules = require("../public/src/shared/wiringRules");
const DataSupportRules = require("../public/src/shared/dataSupportRules");
const { PARTS } = require("../src/server/components");

const clone = (v) => JSON.parse(JSON.stringify(v));
const part = (type) => { if (!PARTS[type]) throw new Error(`Unknown component type: ${type}`); return PARTS[type]; };
const moduleAt = (type, x, y = 0) => ({ type, x, y, rotation: 0 });
const typeIndices = (design, pred) => design.map((m, i) => pred(m.type) ? i : -1).filter((i) => i >= 0);
const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a - b);

function section(a, b) {
  const hosted = new Set([`${a.x},${a.y}`, `${b.x},${b.y}`]);
  const normalized = WiringRules.normalizeSection({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, tier: "standard" }, hosted);
  return { id: WiringRules.sectionIdFromCells(a, b), x1: normalized.x1, y1: normalized.y1, x2: normalized.x2, y2: normalized.y2, tier: "standard" };
}
function summarize(design, wiring) {
  return design.reduce((s, m) => { const p = part(m.type); s.cost += p.cost || 0; s.mass += p.mass || 0; s.powerUse += p.powerUse || 0; s.powerGeneration += p.powerGeneration || 0; s.heatGeneration += p.heatGeneration || 0; if (DataSupportRules.isDataSupportSource(m.type)) s.supportCost += p.cost || 0; if (p.weapon) s.weaponCost += p.cost || 0; return s; }, { cost: 0, mass: 0, powerUse: 0, powerGeneration: 0, heatGeneration: 0, supportCost: 0, weaponCost: 0, dataCableSections: wiring.data.sections.length, powerCableSections: wiring.power.sections.length });
}
function buildExpected(design, wiring) {
  const analysis = WiringRules.analyzeWiring(design, wiring, PARTS);
  const support = analysis.data.supportAnalysis;
  const vulnerabilities = (analysis.data.networks || []).map((n) => n.sectionIds?.length || 0);
  return { sources: typeIndices(design, (t) => DataSupportRules.isDataSupportSource(t)), weapons: typeIndices(design, (t) => Boolean(PARTS[t]?.weapon)), networks: analysis.data.networks.map((n) => ({ id: n.id, componentIndices: uniqueSorted(n.componentIndices || []), sourceIndices: uniqueSorted(n.sourceIndices || []), weaponIndices: uniqueSorted(n.weaponIndices || []), sectionIds: [...(n.sectionIds || [])].sort() })), redundantSections: vulnerabilities.filter((count) => count > 2).length, criticalSections: support.supportedWeaponCount ? 1 : 0 };
}
function make(key, name, components, edges, expectedNetworkCount) {
  const design = components.map(([type, x, y]) => moduleAt(type, x, y));
  let wiring = WiringRules.createGeneratedPowerWiring(design, PARTS);
  wiring.data.sections = edges.map(([a, b]) => section({ x: a[0], y: a[1] }, { x: b[0], y: b[1] })).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  wiring.data.connections = [];
  wiring = WiringRules.normalizeWiring(wiring, design, PARTS).wiring;
  const fixture = { key, name, design: clone(design), wiring: clone(wiring), expectedNetworkCount, expected: buildExpected(design, wiring), summary: summarize(design, wiring) };
  validateReferenceFixture(fixture);
  return fixture;
}
function lineEdges(xs, y = 0) { const out = []; for (let i = 1; i < xs.length; i += 1) out.push([[xs[i - 1], y], [xs[i], y]]); return out; }
function componentIndicesByType(fixture, type) { return fixture.design.map((m, i) => m.type === type ? i : -1).filter((i) => i >= 0); }
function firstComponentIndexByType(fixture, type) { const indices = componentIndicesByType(fixture, type); assert(indices.length, `${fixture.name} has ${type}`); return indices[0]; }
function validateReferenceFixture(fixture) {
  const occupied = new Map();
  fixture.design.forEach((m, i) => { assert(PARTS[m.type], `${fixture.name} component type exists: ${m.type}`); WiringRules.moduleCells(m, PARTS).forEach((c) => { const k = `${c.x},${c.y}`; assert(!occupied.has(k), `${fixture.name} footprint overlap ${k}`); occupied.set(k, i); }); });
  for (const kind of ["power", "data"]) {
    const seen = new Set();
    for (const s of fixture.wiring[kind].sections) {
      assert.equal(Math.abs(s.x1 - s.x2) + Math.abs(s.y1 - s.y2), 1, `${fixture.name} ${kind} section is one orthogonal cell: ${s.id}`);
      assert(occupied.has(`${s.x1},${s.y1}`) && occupied.has(`${s.x2},${s.y2}`), `${fixture.name} ${kind} section endpoints hosted: ${s.id}`);
      const canonical = WiringRules.sectionIdFromCells({ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 });
      assert.equal(s.id, canonical, `${fixture.name} ${kind} canonical section id`);
      assert(!seen.has(canonical), `${fixture.name} duplicate/reversed duplicate ${kind} section ${canonical}`);
      seen.add(canonical);
    }
  }
  assert.deepEqual(WiringRules.normalizeWiring(fixture.wiring, fixture.design, PARTS).wiring, fixture.wiring, `${fixture.name} normalized Wiring v2 is canonical`);
  assert.deepEqual(fixture.wiring.power, WiringRules.createGeneratedPowerWiring(fixture.design, PARTS).power, `${fixture.name} generated Power wiring is canonical`);
  const analysis = WiringRules.analyzeWiring(fixture.design, fixture.wiring, PARTS);
  assert.equal(analysis.data.networks.length, fixture.expectedNetworkCount, `${fixture.name} exact Data network count`);
  assert.equal(analysis.power.connectedConsumerIndices.length, analysis.power.consumerIndices.length, `${fixture.name} every intended Power consumer connected`);
  assert(!analysis.power.underpowered, `${fixture.name} no intended consumer underpowered at baseline`);
  fixture.expected.sources.forEach((i) => { assert(DataSupportRules.isDataSupportSource(fixture.design[i].type), `${fixture.name} source index validates type ${i}`); assert((PARTS[fixture.design[i].type].powerUse || 0) >= 0, `${fixture.name} source has positive runtime Power baseline ${i}`); });
  fixture.expected.weapons.forEach((i) => assert(PARTS[fixture.design[i].type].weapon, `${fixture.name} weapon eligible ${i}`));
  return fixture;
}
function cloneReferenceFixture(fixture) { return clone(fixture); }
function precisionBuild() { return make("precision", "Reference A — Precision build", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["targetingComputer",5,0],["sensorArray",6,0],["railgun",7,0]], lineEdges([5,6,7]), 1); }
function broadsideBuild() { return make("broadside", "Reference B — Broadside build", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["fireControl",5,0],["blaster",6,0],["blaster",7,0],["blaster",8,0],["blaster",9,0],["auxGenerator",10,0]], lineEdges([5,6,7,8,9]), 1); }
function mixedSupportNetwork() { return make("mixed", "Reference C — Mixed support network", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["fireControl",5,0],["sensorArray",6,0],["targetingComputer",7,0],["railgun",8,0],["blaster",9,0],["pointDefense",10,0],["auxGenerator",11,0],["auxGenerator",12,0]], lineEdges([5,6,7,8,9,10]), 1); }
function redundantNetwork() { return make("redundant", "Reference D — Redundant network", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["fireControl",5,0],["sensorArray",6,0],["frame",7,0],["missile",8,0],["blaster",9,0],["pointDefense",10,0],["frame",7,1],["frame",8,1],["frame",9,1],["auxGenerator",11,0],["auxGenerator",12,0]], [...lineEdges([5,6,7,8,9,10]), [[7,0],[7,1]], [[7,1],[8,1]], [[8,1],[9,1]], [[9,1],[9,0]]], 1); }
function isolatedNetworks() { return make("isolated", "Reference E — Isolated networks", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["sensorArray",5,0],["railgun",6,0],["fireControl",7,0],["blaster",8,0],["auxGenerator",9,0],["auxGenerator",10,0]], [...lineEdges([5,6]), ...lineEdges([7,8])], 2); }
function allReferenceShips() { return [precisionBuild(), broadsideBuild(), mixedSupportNetwork(), redundantNetwork(), isolatedNetworks()].map(cloneReferenceFixture); }
module.exports = { precisionBuild, broadsideBuild, mixedSupportNetwork, redundantNetwork, isolatedNetworks, allReferenceShips, componentIndicesByType, firstComponentIndexByType, validateReferenceFixture, cloneReferenceFixture };
