"use strict";
const assert = require("assert");
const DataRules = require("./public/src/shared/dataSupportRules");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const fixtures = require("./test-fixtures/dataSupportReferenceShips");
const close = (a,b,msg,eps=1e-9)=>assert(Math.abs(a-b)<=eps, `${msg}: ${a} !== ${b}`);
const deepFreeze = (o)=>{ if(o&&typeof o==='object'){ Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
const budget = (t)=>DataRules.nominalSupportBudget(t, PARTS);
function validateFixture(f){
  const occupied=new Map();
  f.design.forEach((m,i)=>{ assert(PARTS[m.type], `${f.name} type exists ${m.type}`); WiringRules.moduleCells(m, PARTS).forEach(c=>{ const k=`${c.x},${c.y}`; assert(!occupied.has(k), `${f.name} overlap ${k}`); occupied.set(k,i); }); });
  for (const kind of ["power","data"]) for (const s of f.wiring[kind].sections){
    assert.equal(Math.abs(s.x1-s.x2)+Math.abs(s.y1-s.y2),1, `${f.name} ${kind} orthogonal one cell ${s.id}`);
    assert(occupied.has(`${s.x1},${s.y1}`) && occupied.has(`${s.x2},${s.y2}`), `${f.name} hosted ${s.id}`);
  }
  const ids=f.wiring.data.sections.map(s=>s.id); assert.equal(new Set(ids).size, ids.length, `${f.name} duplicate data sections`);
  assert.deepEqual(WiringRules.normalizeWiring(f.wiring,f.design,PARTS).wiring, f.wiring, `${f.name} normalization idempotent`);
  const analysis=WiringRules.analyzeWiring(f.design,f.wiring,PARTS); assert.equal(analysis.data.networks.length, f.expectedNetworkCount, `${f.name} network count`);
  assert(analysis.power.connectedConsumerIndices.length===analysis.power.consumerIndices.length, `${f.name} all powered`);
  analysis.data.sourceIndices.forEach(i=>assert(DataRules.isDataSupportSource(f.design[i].type), `${f.name} source recognized`));
  analysis.data.weaponIndices.forEach(i=>assert(PARTS[f.design[i].type].weapon, `${f.name} weapon eligible`));
  const frozenDesign=deepFreeze(JSON.parse(JSON.stringify(f.design))); const frozenNetworks=deepFreeze(JSON.parse(JSON.stringify(analysis.data.networks)));
  assert.deepEqual(DataRules.analyzeDataSupport(frozenDesign, frozenNetworks, PARTS), DataRules.analyzeDataSupport(frozenDesign, frozenNetworks, PARTS), `${f.name} deterministic allocation`);
  return analysis.data.supportAnalysis;
}
function assertConservation(a){ for(const s of a.sources){ close(s.bonusPerWeapon*s.recipientCount, s.effectiveBudget, `source ${s.sourceIndex} budget conservation`); } }
function byType(f,t){ return f.design.map((m,i)=>m.type===t?i:-1).filter(i=>i>=0); }
function profile(f,i,a){ return DataRules.effectiveWeaponProfile(PARTS[f.design[i].type].weapon, DataRules.weaponSupportForIndex(a,i)); }
const refs=fixtures.allReferenceShips(); assert.deepEqual(refs, fixtures.allReferenceShips(), "repeated fixture construction is deeply equal"); refs[0].design[0].x=99; assert.notEqual(fixtures.allReferenceShips()[0].design[0].x,99,"fixture clones are independent");
for (const f of fixtures.allReferenceShips()){ const a=validateFixture(f); assertConservation(a); for(const w of a.weapons){ const p=profile(f,w.weaponIndex,a); Object.values({range:p.range,accuracy:p.accuracy,fireRate:p.fireRate,reload:p.reload,dps:p.dps}).forEach(v=>assert(Number.isFinite(v), `${f.name} finite profile`)); } }
let f=fixtures.precisionBuild(), a=validateFixture(f), rail=byType(f,"railgun")[0]; close(DataRules.weaponSupportForIndex(a,rail).rangeBonus,budget("sensorArray"),"precision full range"); close(DataRules.weaponSupportForIndex(a,rail).accuracyBonus,budget("targetingComputer"),"precision full accuracy"); close(profile(f,rail,a).range, PARTS.railgun.weapon.range+budget("sensorArray"), "precision effective range"); assert(profile(f,rail,a).accuracy<=0.99,"precision accuracy capped");
f=fixtures.broadsideBuild(); a=validateFixture(f); const blasters=byType(f,"blaster"); blasters.forEach(i=>close(DataRules.weaponSupportForIndex(a,i).fireRateBonus,budget("fireControl")/4,"broadside equal split")); close(blasters.reduce((s,i)=>s+DataRules.weaponSupportForIndex(a,i).fireRateBonus,0),budget("fireControl"),"broadside sum");
f=fixtures.mixedSupportNetwork(); a=validateFixture(f); for(const t of ["railgun","blaster","pointDefense"]){ const i=byType(f,t)[0], s=DataRules.weaponSupportForIndex(a,i); close(s.rangeBonus,budget("sensorArray")/3,`${t} range split`); close(s.accuracyBonus,budget("targetingComputer")/3,`${t} accuracy split`); close(s.fireRateBonus,budget("fireControl")/3,`${t} fire split`); assert.equal(s.contributions.length,3,`${t} own indexed support`); }
f=fixtures.redundantNetwork(); a=validateFixture(f); const original=JSON.stringify(a.weaponBonusByIndex); let w=JSON.parse(JSON.stringify(f.wiring)); w.data.sections=w.data.sections.filter(s=>s.id!=="7,0:8,0"); close(WiringRules.analyzeWiring(f.design,w,PARTS).data.supportAnalysis.supportedWeaponCount,a.supportedWeaponCount,"redundant section removal preserves support"); w=JSON.parse(JSON.stringify(f.wiring)); w.data.sections=w.data.sections.filter(s=>!["7,0:8,0","7,1:8,1"].includes(s.id)); assert.notEqual(JSON.stringify(WiringRules.analyzeWiring(f.design,w,PARTS).data.supportAnalysis.weaponBonusByIndex),original,"both routes alter support");
f=fixtures.isolatedNetworks(); a=validateFixture(f); close(DataRules.weaponSupportForIndex(a,byType(f,"railgun")[0]).rangeBonus,budget("sensorArray"),"isolated rail only"); close(DataRules.weaponSupportForIndex(a,byType(f,"blaster")[0]).fireRateBonus,budget("fireControl"),"isolated blaster only");
console.log("Section 6E Data-support balance verification passed."); for(const f2 of fixtures.allReferenceShips()) console.log(`${f2.name}: ${f2.design.length} components, ${f2.summary.cost} cost, ${f2.summary.mass} mass, ${f2.summary.powerGeneration}/${f2.summary.powerUse.toFixed(1)} MW, ${f2.summary.dataCableSections} data sections`);
