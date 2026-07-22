#!/usr/bin/env node
"use strict";

const assert = require("assert");
const W = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, beginComponentLifecycleBatch, requestComponentLifecycleRefresh, endComponentLifecycleBatch } = require("./src/server/componentHealth");
const { rebuildShipWiringState } = require("./src/server/componentPower");
const Data = require("./src/server/componentData");

function mod(type, x, y) { return { type, x, y, rotation: 0 }; }
function pathSecs(cells, tier = "heavy") {
  const sections = [];
  for (let i = 1; i < cells.length; i += 1) {
    const id = W.sectionIdFromCells(cells[i - 1], cells[i]);
    const [a, b] = id.split(":").map((p) => p.split(",").map(Number));
    sections.push({ id, x1: a[0], y1: a[1], x2: b[0], y2: b[1], tier });
  }
  return sections;
}
function conn(sourceIndex, targetIndex, cells) { return { sourceIndex, targetIndex, sectionIds: pathSecs(cells).map((s) => s.id) }; }
function wire(powerPaths = [], dataPaths = []) {
  const psecs = new Map(); const dsecs = new Map(); const powerConnections = []; const dataConnections = [];
  for (const p of powerPaths) { pathSecs(p.cells, p.tier || "heavy").forEach((s) => psecs.set(s.id, s)); powerConnections.push(conn(p.source, p.target, p.cells)); }
  for (const p of dataPaths) { pathSecs(p.cells).forEach((s) => dsecs.set(s.id, { ...s, tier: "standard" })); dataConnections.push(conn(p.source, p.target, p.cells)); }
  return { version: 3, power: { sections: [...psecs.values()], connections: powerConnections }, data: { sections: [...dsecs.values()], connections: dataConnections }, powerPolicy: W.PowerPolicyRules.defaultPolicy() };
}
function ship(design, wiring) { const s = { id: "s", ownerId: "p", alive: true, x: 0, y: 0, vx: 0, vy: 0, angle: 0, radius: 20, effects: [], design, wiring, stats: computeStats(design, wiring) }; initComponentState(s); rebuildShipWiringState(s, "test", { skipRuntimeStats: true }); return s; }
function destroyBatch(s, indices) { beginComponentLifecycleBatch(s); for (const i of indices) { s.componentHp[i] = 0; requestComponentLifecycleRefresh(s, { wiringTopology: true, wiringComponentIndex: i }); } endComponentLifecycleBatch(s); }
function repairBatch(s, indices) { beginComponentLifecycleBatch(s); for (const i of indices) { s.componentHp[i] = Math.max(1, s.componentMaxHp[i] * 0.1); requestComponentLifecycleRefresh(s, { wiringTopology: true, wiringComponentIndex: i }); } endComponentLifecycleBatch(s); }
function cp(s, i) { return s.componentPower.byComponentIndex[i]; }
function finite(value) { if (typeof value === "number") assert(Number.isFinite(value) && !Object.is(value, -0)); else if (Array.isArray(value)) value.forEach(finite); else if (value && typeof value === "object") Object.values(value).forEach(finite); }
function snap(o) { return JSON.stringify(o); }

let passed = 0;
function check(name, fn) { fn(); passed += 1; console.log(`  ok  ${name}`); }

check("middle host destruction splits Power/Data and repair restores without blueprint mutation", () => {
  const design = [mod("core", 0, 0), mod("frame", 1, 0), mod("frame", 2, 0), mod("blaster", 3, 0), mod("fireControl", 0, 1), mod("railgun", 3, 1), mod("frame", 1, 1), mod("frame", 2, 1)];
  const wiring = wire([{ source: 0, target: 3, cells: [{ x:0,y:0 },{ x:1,y:0 },{ x:2,y:0 },{ x:3,y:0 }] }, { source: 0, target: 4, cells: [{ x:0,y:0 },{ x:0,y:1 }] }], [{ source: 4, target: 5, cells: [{ x:0,y:1 },{ x:1,y:1 },{ x:2,y:1 },{ x:3,y:1 }] }]);
  const s = ship(design, wiring); const before = snap(s.wiring);
  assert(cp(s, 3).allocatedMw > 0); assert(Data.getWeaponDataSupport(s, 5).fireRateBonus > 0);
  s.componentHp[1] = s.componentMaxHp[1] / 2; rebuildShipWiringState(s, "partial", { skipRuntimeStats: true });
  assert(cp(s, 3).allocatedMw > 0, "partial damage does not disable Power");
  destroyBatch(s, [1, 6]);
  assert.strictEqual(cp(s, 3).allocatedMw, 0, "downstream Power consumer loses allocation");
  assert.strictEqual(Data.getWeaponDataSupport(s, 5).fireRateBonus, 0, "downstream Data support removed");
  assert(s.runtimeWiring.power.disabledCells.some((c) => c.hostComponentIndex === 1));
  assert(s.runtimeWiring.data.disabledCells.some((c) => c.hostComponentIndex === 6));
  assert.strictEqual(snap(s.wiring), before, "Blueprint wiring immutable");
  repairBatch(s, [1, 6]);
  assert(cp(s, 3).allocatedMw > 0, "Power restored");
  assert(Data.getWeaponDataSupport(s, 5).fireRateBonus > 0, "Data restored");
});

check("redundant Power path survives one destroyed host and disabled cells have zero heat", () => {
  const design = [mod("core",0,0), mod("frame",1,0), mod("frame",2,0), mod("blaster",3,0), mod("frame",0,1), mod("frame",1,1), mod("frame",2,1), mod("frame",3,1)];
  const wiring = wire([{ source:0,target:3,cells:[{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}] }, { source:0,target:3,cells:[{x:0,y:0},{x:0,y:1},{x:1,y:1},{x:2,y:1},{x:3,y:1},{x:3,y:0}] }]);
  const s = ship(design, wiring); destroyBatch(s, [1]);
  assert(cp(s,3).allocatedMw > 0, "redundant path continues supply");
  for (const id of s.runtimeWiring.power.disabledSectionIds) assert(!s.powerFlow.sectionFlows.some((f) => f.sectionId === id && f.signedFlowMw !== 0), "disabled sections carry no flow");
  assert((s.powerCableHeatRate || 0) > 0, "surviving path still produces cable Heat");
  finite(s.runtimeWiring); finite(s.powerFlow); finite(s.powerCableThermalAnalysis);
});

check("batched lifecycle counters and unrelated hosts", () => {
  global.__mfaDataSupportPerf = {};
  const design = [mod("core",0,0), mod("frame",1,0), mod("blaster",2,0), mod("frame",5,5), mod("frame",6,5)];
  const s = ship(design, wire([{ source:0,target:2,cells:[{x:0,y:0},{x:1,y:0},{x:2,y:0}] }]));
  global.__mfaDataSupportPerf = {};
  destroyBatch(s, [1]);
  assert.strictEqual(global.__mfaDataSupportPerf.hostedWiringRebuildCount, 1);
  assert.strictEqual(global.__mfaDataSupportPerf.hostedPowerRefreshCount, 1);
  assert.strictEqual(global.__mfaDataSupportPerf.hostedDataRefreshCount, 1);
  global.__mfaDataSupportPerf = {};
  repairBatch(s, [1]);
  assert.strictEqual(global.__mfaDataSupportPerf.hostedWiringRebuildCount, 1);
  global.__mfaDataSupportPerf = {};
  destroyBatch(s, [3,4]);
  assert.strictEqual(global.__mfaDataSupportPerf.hostedWiringRebuildCount || 0, 0, "unrelated hosts skip wiring rebuild");
  global.__mfaDataSupportPerf = null;
});

check("invalid host references fail closed and spawn restore is deterministic", () => {
  const design = [mod("core",0,0), mod("blaster",2,0)];
  const wiring = { version:3, power:{ sections:[{ id:"0,0:1,0", x1:0,y1:0,x2:1,y2:0,tier:"heavy" }, { id:"1,0:2,0", x1:1,y1:0,x2:2,y2:0,tier:"heavy" }], connections:[] }, data:{ sections:[], connections:[] }, powerPolicy: W.PowerPolicyRules.defaultPolicy() };
  const s1 = ship(design, wiring); const s2 = ship([...design].reverse(), wiring);
  assert.strictEqual(cp(s1,1).allocatedMw, 0, "unhosted route fails closed");
  finite(s1.runtimeWiring); finite(s1.powerFlow);
  assert.deepStrictEqual(s1.runtimeWiring.power.disabledCells.map((c) => `${c.x},${c.y}`), ["1,0","1,0"]);
  assert.strictEqual(s2.powerStatus, s1.powerStatus, "deterministic under reordered design input");
});

console.log(`Hosted wiring damage/repair verifier passed (${passed} groups).`);
