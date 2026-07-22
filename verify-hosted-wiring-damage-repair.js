#!/usr/bin/env node
"use strict";

const assert = require("assert");
const W = require("./public/src/shared/wiringRules");
const WiringInfrastructureRules = require("./public/src/shared/wiringInfrastructureRules.js");
const { PARTS } = require("./src/server/components");
const { BALANCE } = require("./src/server/balanceConfig");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, beginComponentLifecycleBatch, requestComponentLifecycleRefresh, endComponentLifecycleBatch } = require("./src/server/componentHealth");
const { rebuildShipWiringState } = require("./src/server/componentPower");
const Data = require("./src/server/componentData");

function mod(type, x, y) { return { type, x, y, rotation: 0 }; }
function section(x1, y1, x2, y2, tier = "heavy") { const id = W.sectionIdFromCells({ x: x1, y: y1 }, { x: x2, y: y2 }); const [a, b] = id.split(":").map((p) => p.split(",").map(Number)); return { id, x1: a[0], y1: a[1], x2: b[0], y2: b[1], tier }; }
function pathSecs(cells, tier = "heavy") { const out = []; for (let i = 1; i < cells.length; i += 1) out.push(section(cells[i - 1].x, cells[i - 1].y, cells[i].x, cells[i].y, tier)); return out; }
function conn(sourceIndex, targetIndex, cells) { return { sourceIndex, targetIndex, sectionIds: pathSecs(cells).map((s) => s.id) }; }
function wire(powerPaths = [], dataPaths = []) { const psecs = new Map(); const dsecs = new Map(); const powerConnections = []; const dataConnections = []; for (const p of powerPaths) { pathSecs(p.cells, p.tier || "heavy").forEach((s) => psecs.set(s.id, s)); powerConnections.push(conn(p.source, p.target, p.cells)); } for (const p of dataPaths) { pathSecs(p.cells, "standard").forEach((s) => dsecs.set(s.id, { ...s, tier: "standard" })); dataConnections.push(conn(p.source, p.target, p.cells)); } return { version: 3, power: { sections: [...psecs.values()], connections: powerConnections }, data: { sections: [...dsecs.values()], connections: dataConnections }, powerPolicy: W.PowerPolicyRules.defaultPolicy() }; }
function ship(design, wiring) { const s = { id: "s", ownerId: "p", alive: true, x: 0, y: 0, vx: 0, vy: 0, angle: 0, radius: 20, effects: [], design, wiring, stats: computeStats(design, wiring) }; initComponentState(s); rebuildShipWiringState(s, "test", { skipRuntimeStats: true }); return s; }
function destroyBatch(s, indices) { beginComponentLifecycleBatch(s); for (const i of indices) { s.componentHp[i] = 0; requestComponentLifecycleRefresh(s, { wiringTopology: true, wiringComponentIndex: i }); } endComponentLifecycleBatch(s); }
function repairBatch(s, indices) { beginComponentLifecycleBatch(s); for (const i of indices) { s.componentHp[i] = Math.max(1, s.componentMaxHp[i] * 0.1); requestComponentLifecycleRefresh(s, { wiringTopology: true, wiringComponentIndex: i }); } endComponentLifecycleBatch(s); }
function cp(s, i) { return s.componentPower.byComponentIndex[i]; }
function support(s, i) { return Data.getWeaponDataSupport(s, i); }
function finite(value) { if (typeof value === "number") assert(Number.isFinite(value) && !Object.is(value, -0)); else if (Array.isArray(value)) value.forEach(finite); else if (value && typeof value === "object") Object.values(value).forEach(finite); }
function snap(o) { return JSON.stringify(o); }
function staticDisplacement(design, wiring) { return snap(WiringInfrastructureRules.accountInfrastructure(design, wiring, PARTS, BALANCE.wiringInfrastructure).byComponentIndex.map((c) => [c.componentIndex, c.powerDisplacement, c.dataDisplacement])); }
function remapWiring(wiring, map) { const remapKind = (kind) => ({ sections: kind.sections.map((s) => ({ ...s })), connections: kind.connections.map((c) => ({ sourceIndex: map.get(c.sourceIndex), targetIndex: map.get(c.targetIndex), sectionIds: [...c.sectionIds] })) }); return { version: wiring.version, power: remapKind(wiring.power), data: remapKind(wiring.data), powerPolicy: { ...wiring.powerPolicy, customOrder: [...(wiring.powerPolicy?.customOrder || [])] } }; }

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

check("Power/Data overlap, partial damage, immutable blueprint, static displacement, repair", () => {
  const design = [mod("core", 0, 0), mod("frame", 1, 0), mod("frame", 2, 0), mod("blaster", 3, 0), mod("fireControl", 0, 1), mod("railgun", 3, 1), mod("frame", 1, 1), mod("frame", 2, 1)];
  const wiring = wire([{ source: 0, target: 3, cells: [{ x:0,y:0 },{ x:1,y:0 },{ x:2,y:0 },{ x:3,y:0 }] }, { source: 0, target: 4, cells: [{ x:0,y:0 },{ x:0,y:1 }] }], [{ source: 4, target: 5, cells: [{ x:0,y:1 },{ x:1,y:1 },{ x:2,y:1 },{ x:3,y:1 }] }]);
  const s = ship(design, wiring); const before = snap(s.wiring); const displacement = staticDisplacement(design, wiring); const restoredHeat = s.powerCableHeatRate;
  assert(cp(s, 3).allocatedMw > 0); assert(support(s, 5).fireRateBonus > 0); assert(restoredHeat > 0);
  s.componentHp[1] = s.componentMaxHp[1] / 2; rebuildShipWiringState(s, "partial", { skipRuntimeStats: true }); assert(cp(s, 3).allocatedMw > 0, "partial HP does not disable wiring");
  destroyBatch(s, [1, 6]);
  assert.strictEqual(cp(s, 3).allocatedMw, 0, "downstream Power loses allocation"); assert.strictEqual(support(s, 5).fireRateBonus, 0, "Data support removed when path is severed");
  assert(s.runtimeWiring.power.disabledCells.some((c) => c.x === 1 && c.y === 0 && c.routeType === "Power")); assert(s.runtimeWiring.data.disabledCells.some((c) => c.x === 1 && c.y === 1 && c.routeType === "Data"));
  for (const id of s.runtimeWiring.power.disabledSectionIds) assert(!s.powerFlow.sectionFlows.some((f) => f.sectionId === id && f.signedFlowMw !== 0), "disabled Power sections have zero flow");
  assert(s.powerCableHeatRate < restoredHeat, "severed downstream Power route leaves no stale dynamic cable Heat on disabled sections"); assert.strictEqual(staticDisplacement(design, wiring), displacement, "static Heat-capacity displacement remains"); assert.strictEqual(snap(s.wiring), before, "Blueprint wiring immutable");
  repairBatch(s, [1, 6]); assert(cp(s, 3).allocatedMw > 0); assert(support(s, 5).fireRateBonus > 0); assert.strictEqual(s.powerCableHeatRate, restoredHeat, "repair restores authoritative flow Heat");
});

check("surviving physical Data sections are authoritative over broken saved route metadata", () => {
  const design = [mod("core",0,0), mod("fireControl",0,1), mod("frame",1,1), mod("frame",2,1), mod("railgun",3,1), mod("frame",0,2), mod("frame",1,2), mod("frame",2,2), mod("frame",3,2)];
  const wiring = wire([{ source:0,target:1,cells:[{x:0,y:0},{x:0,y:1}] }], [{ source:1,target:4,cells:[{x:0,y:1},{x:1,y:1},{x:2,y:1},{x:3,y:1}] }, { source:1,target:4,cells:[{x:0,y:1},{x:0,y:2},{x:1,y:2},{x:2,y:2},{x:3,y:2},{x:3,y:1}] }]);
  const s = ship(design, wiring); assert(support(s,4).fireRateBonus > 0);
  destroyBatch(s, [2]); assert(support(s,4).fireRateBonus > 0, "alternate physical Data path survives a broken saved connection");
  destroyBatch(s, [6]); assert.strictEqual(support(s,4).fireRateBonus, 0, "support lost only after every physical path is severed");
  repairBatch(s, [2, 6]); assert(support(s,4).fireRateBonus > 0, "repair restores physical Data connectivity");
});

check("disabled-cell diagnostics are unique and aggregate sections/connections deterministically", () => {
  const design = [mod("core",0,1), mod("frame",1,1), mod("blaster",2,1), mod("fireControl",0,0), mod("railgun",2,0)];
  const wiring = wire([{ source:0,target:2,cells:[{x:0,y:1},{x:1,y:1},{x:2,y:1}] }], [{ source:3,target:4,cells:[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:2,y:1},{x:2,y:0}] }]);
  const s = ship(design, wiring); destroyBatch(s, [1]);
  const power = s.runtimeWiring.power.disabledCells.filter((c) => c.x === 1 && c.y === 1); const data = s.runtimeWiring.data.disabledCells.filter((c) => c.x === 1 && c.y === 1);
  assert.strictEqual(power.length, 1); assert.strictEqual(data.length, 1, "Power and Data overlap disable independently but only once per kind/coordinate");
  assert.deepStrictEqual(power[0].sectionIds, ["0,1:1,1", "1,1:2,1"]); assert.deepStrictEqual(power[0].ownerConnectionIds, [W.connectionKey(wiring.power.connections[0])]); assert.deepStrictEqual(power[0].tiers, ["heavy"]); assert.strictEqual(power[0].tier, "heavy");
  assert.deepStrictEqual(data[0].sectionIds, ["1,0:1,1", "1,1:2,1"]); assert.deepStrictEqual(data[0].ownerConnectionIds, [W.connectionKey(wiring.data.connections[0])]);
});

check("batched lifecycle counters and unrelated hosts", () => {
  global.__mfaDataSupportPerf = {}; const design = [mod("core",0,0), mod("frame",1,0), mod("blaster",2,0), mod("frame",3,0), mod("shield",4,0), mod("frame",5,5)]; const s = ship(design, wire([{ source:0,target:2,cells:[{x:0,y:0},{x:1,y:0},{x:2,y:0}] }, { source:0,target:4,cells:[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0},{x:4,y:0}] }]));
  global.__mfaDataSupportPerf = {}; destroyBatch(s, [1,3]); assert.strictEqual(global.__mfaDataSupportPerf.hostedWiringRebuildCount, 1); assert.strictEqual(global.__mfaDataSupportPerf.hostedPowerRefreshCount, 1); assert.strictEqual(global.__mfaDataSupportPerf.hostedDataRefreshCount, 1);
  global.__mfaDataSupportPerf = {}; repairBatch(s, [1,3]); assert.strictEqual(global.__mfaDataSupportPerf.hostedWiringRebuildCount, 1);
  global.__mfaDataSupportPerf = {}; destroyBatch(s, [5]); assert.strictEqual(global.__mfaDataSupportPerf.hostedWiringRebuildCount || 0, 0, "unrelated component skips hosted topology rebuild"); global.__mfaDataSupportPerf = null;
});

check("invalid/unhosted cells fail closed and true remapped order is deterministic", () => {
  const design = [mod("core",0,0), mod("frame",1,0), mod("blaster",2,0)]; const wiring = wire([{ source:0,target:2,cells:[{x:0,y:0},{x:1,y:0},{x:2,y:0}] }]); const s1 = ship(design, wiring); destroyBatch(s1, [1]);
  const order = [2,1,0]; const map = new Map(order.map((old, ni) => [old, ni])); const s2 = ship(order.map((i) => design[i]), remapWiring(wiring, map)); destroyBatch(s2, [map.get(1)]);
  assert.strictEqual(cp(s1,2).allocatedMw, 0); assert.strictEqual(cp(s2,map.get(2)).allocatedMw, 0); assert.deepStrictEqual(s1.runtimeWiring.power.disabledCells.map((c) => [c.routeType,c.x,c.y,c.sectionIds]), s2.runtimeWiring.power.disabledCells.map((c) => [c.routeType,c.x,c.y,c.sectionIds]));
  const invalid = ship([mod("core",0,0), mod("blaster",2,0)], { version:3, power:{ sections:[section(0,0,1,0), section(1,0,2,0)], connections:[] }, data:{ sections:[], connections:[] }, powerPolicy: W.PowerPolicyRules.defaultPolicy() }); assert.strictEqual(cp(invalid,1).allocatedMw, 0); assert.deepStrictEqual(invalid.runtimeWiring.power.disabledCells.map((c) => `${c.routeType}:${c.x},${c.y}`), ["Power:1,0"]);
  finite(s1.runtimeWiring); finite(s1.powerFlow); finite(s1.powerCableThermalAnalysis); finite(invalid.runtimeWiring); finite(invalid.powerFlow);
});

console.log(`Hosted wiring damage/repair verifier passed (${passed} groups).`);
