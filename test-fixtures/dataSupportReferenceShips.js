"use strict";

const WiringRules = require("../public/src/shared/wiringRules");
const DataSupportRules = require("../public/src/shared/dataSupportRules");
const { PARTS } = require("../src/server/components");

const clone = (v) => JSON.parse(JSON.stringify(v));
const part = (type) => { if (!PARTS[type]) throw new Error(`Unknown component type: ${type}`); return PARTS[type]; };
const moduleAt = (type, x, y = 0) => ({ type, x, y, rotation: 0 });
const section = (a, b) => ({ id: WiringRules.sectionIdFromCells(a, b), ...((({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 }))(WiringRules.normalizeSection({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, tier: "standard" }, new Set([`${a.x},${a.y}`, `${b.x},${b.y}`])))), tier: "standard" });
function summarize(design, wiring) {
  return design.reduce((s, m) => { const p = part(m.type); s.cost += p.cost || 0; s.mass += p.mass || 0; s.powerUse += p.powerUse || 0; s.powerGeneration += p.powerGeneration || 0; s.heatGeneration += p.heatGeneration || 0; if (DataSupportRules.isDataSupportSource(m.type)) s.supportCost += p.cost || 0; if (p.weapon) s.weaponCost += p.cost || 0; return s; }, { cost: 0, mass: 0, powerUse: 0, powerGeneration: 0, heatGeneration: 0, supportCost: 0, weaponCost: 0, dataCableSections: wiring.data.sections.length, powerCableSections: wiring.power.sections.length });
}
function make(name, components, edges, expectedNetworkCount) {
  const design = components.map(([type,x,y]) => moduleAt(type,x,y));
  let wiring = WiringRules.createGeneratedPowerWiring(design, PARTS);
  wiring.data.sections = edges.map(([a,b]) => section({ x:a[0], y:a[1] }, { x:b[0], y:b[1] })).sort((a,b)=>a.id.localeCompare(b.id, undefined, {numeric:true}));
  wiring.data.connections = [];
  wiring = WiringRules.normalizeWiring(wiring, design, PARTS).wiring;
  const analysis = WiringRules.analyzeWiring(design, wiring, PARTS);
  if (analysis.data.networks.length !== expectedNetworkCount) throw new Error(`${name} expected ${expectedNetworkCount} data networks, got ${analysis.data.networks.length}`);
  return { name, design: clone(design), wiring: clone(wiring), summary: summarize(design, wiring), expectedNetworkCount };
}
function lineEdges(xs, y=0) { const out=[]; for (let i=1;i<xs.length;i++) out.push([[xs[i-1],y],[xs[i],y]]); return out; }
function precisionBuild(){ return make("Reference A — Precision build", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["targetingComputer",5,0],["sensorArray",6,0],["railgun",7,0]], lineEdges([5,6,7]), 1); }
function broadsideBuild(){ return make("Reference B — Broadside build", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["fireControl",5,0],["blaster",6,0],["blaster",7,0],["blaster",8,0],["blaster",9,0],["auxGenerator",10,0]], lineEdges([5,6,7,8,9]), 1); }
function mixedSupportNetwork(){ return make("Reference C — Mixed support network", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["fireControl",5,0],["sensorArray",6,0],["targetingComputer",7,0],["railgun",8,0],["blaster",9,0],["pointDefense",10,0],["auxGenerator",11,0],["auxGenerator",12,0]], lineEdges([5,6,7,8,9,10]), 1); }
function redundantNetwork(){ return make("Reference D — Redundant network", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["fireControl",5,0],["sensorArray",6,0],["frame",7,0],["missile",8,0],["blaster",9,0],["pointDefense",10,0],["frame",7,1],["frame",8,1],["frame",9,1],["auxGenerator",11,0],["auxGenerator",12,0]], [...lineEdges([5,6,7,8,9,10]), [[7,0],[7,1]], [[7,1],[8,1]], [[8,1],[9,1]], [[9,1],[9,0]]], 1); }
function isolatedNetworks(){ return make("Reference E — Isolated networks", [["core",0,0],["reactor",1,0],["engine",3,0],["radiator",4,0],["sensorArray",5,0],["railgun",6,0],["fireControl",7,0],["blaster",8,0],["auxGenerator",9,0],["auxGenerator",10,0]], [...lineEdges([5,6]), ...lineEdges([7,8])], 2); }
function allReferenceShips(){ return [precisionBuild(), broadsideBuild(), mixedSupportNetwork(), redundantNetwork(), isolatedNetworks()].map(clone); }
module.exports = { precisionBuild, broadsideBuild, mixedSupportNetwork, redundantNetwork, isolatedNetworks, allReferenceShips };
