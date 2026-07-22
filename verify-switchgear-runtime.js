const assert = require('assert');
const SwitchgearRules = require('./public/src/shared/switchgearRules');
const PowerFlowRules = require('./public/src/shared/powerFlowRules');
const WiringRules = require('./public/src/shared/wiringRules');
const { PARTS } = require('./src/server/components');
const { BALANCE } = require('./src/server/balanceConfig');
const { createShipBlueprintSnapshot } = require('./src/server/shipDesign');
const { initializeComponentPower, tripSwitchgear, resetSwitchgearTrip } = require('./src/server/componentPower');

for (const rotation of [0,90,180,270]) {
  const t = SwitchgearRules.terminalCells({ x: 5, y: 5, rotation });
  const manhattan = Math.abs(t.A.x - t.B.x) + Math.abs(t.A.y - t.B.y);
  assert.strictEqual(manhattan, 1, `rotation ${rotation} has opposite adjacent terminals`);
  assert.notDeepStrictEqual(t.A, t.B, `rotation ${rotation} terminals distinct`);
}
const migrated = SwitchgearRules.normalizeDesignPart({ type: 'switchgear', x: 1, y: 1, switchgearMode: 'bad', switchgearRatingTier: 'huge' });
assert.strictEqual(migrated.switchgearMode, 'closed');
assert.strictEqual(migrated.switchgearRatingTier, 'standard');
assert.deepStrictEqual(SwitchgearRules.normalizeDesignPart(migrated), migrated, 'migration idempotent');

function ship(mode='closed', rating='standard') {
  const design = [
    { x:0,y:0,type:'core' }, { x:0,y:1,type:'engine' },
    { x:3,y:0,type:'auxGenerator' }, { x:3,y:1,type:'shield' },
    { x:1,y:0,type:'switchgear',rotation:0,switchgearMode:mode,switchgearRatingTier:rating }
  ];
  const wiring = { version:3, power:{ sections:[
    {id:'a1',x1:0,y1:0,x2:1,y2:0,tier:'standard'},
    {id:'b1',x1:2,y1:0,x2:3,y2:0,tier:'standard'},
    {id:'b2',x1:3,y1:0,x2:3,y2:1,tier:'standard'}
  ], connections:[] }, data:{ sections:[{id:'d1',x1:0,y1:1,x2:3,y2:1,tier:'standard'}], connections:[] }, powerPolicy: { preset:'custom', customOrder:['command','propulsion','shields','pointDefence','weapons','coolingSupport'] } };
  const snap = createShipBlueprintSnapshot(design, wiring);
  return { design:snap.design, wiring:snap.wiring, componentHp: snap.design.map(()=>1), alive:true, stats:{} };
}
let s = ship('open'); initializeComponentPower(s);
assert.strictEqual(s.runtimeSwitchgear[0].state, 'open');
assert.strictEqual(s.runtimeSwitchgear[0].signedTransferMw, 0);
assert(!s.powerFlow.sectionFlows.some(f => f.sectionId.startsWith('switchgear:')), 'open has no internal edge');
assert.strictEqual(s.wiring.power.sections.length, 3, 'blueprint wiring not mutated by runtime internal edge');
assert(!s.wiring.power.sections.some(x => String(x.id).startsWith('switchgear:')), 'runtime state not persisted');
assert.strictEqual((s.powerFlow.sectionFlows||[]).some(f=>f.sectionId==='d1'), false, 'data never appears in power flows');

s = ship('closed','light'); initializeComponentPower(s);
let rec = s.runtimeSwitchgear[0];
assert.strictEqual(rec.state, 'closed');
assert.strictEqual(rec.peakCapacityMw, BALANCE.wiringInfrastructure.powerTiers.light.peakCapacityMw);
assert(s.powerFlow.sectionFlows.some(f => f.sectionId === rec.internalEdgeId), 'closed internal edge participates');

s = ship('automatic','heavy'); initializeComponentPower(s);
rec = s.runtimeSwitchgear[0];
assert.strictEqual(rec.state, 'automatic');
assert.strictEqual(typeof rec.automaticClosed, 'boolean');
assert(['branch-breaker','bus-tie','isolator'].includes(rec.classification));
assert(Number.isFinite(rec.signedTransferMw) && !Object.is(rec.signedTransferMw, -0));

tripSwitchgear(s, 4, 'verifier trip');
assert.strictEqual(s.runtimeSwitchgear[0].state, 'tripped');
assert.strictEqual(s.runtimeSwitchgear[0].signedTransferMw, 0);
resetSwitchgearTrip(s, 4);
s.componentHp[4] = 0; initializeComponentPower(s);
assert.strictEqual(s.runtimeSwitchgear[0].state, 'destroyed');
s.componentHp[4] = 1; initializeComponentPower(s);
assert.strictEqual(s.runtimeSwitchgear[0].state, 'automatic');


function autoShip({ donorDemand = 5, receiverDemand = 5, directBypass = false, mode = 'automatic' } = {}) {
  const sections = [
    {id:'left',x1:0,y1:0,x2:1,y2:0,tier:'standard'},
    {id:'right',x1:2,y1:0,x2:3,y2:0,tier:'standard'},
    {id:'loadL',x1:0,y1:0,x2:0,y2:1,tier:'standard'}
  ];
  if (directBypass) sections.push({id:'bypass',x1:1,y1:0,x2:2,y2:0,tier:'heavy'});
  const design = [
    { x:0,y:0,type:'reactor' }, { x:0,y:1,type:'engine' },
    { x:3,y:0,type:'shield' },
    { x:1,y:0,type:'switchgear',rotation:0,switchgearMode:mode,switchgearRatingTier:'standard' }
  ];
  const wiring = { version:3, power:{ sections, connections:[] }, data:{ sections:[], connections:[] }, powerPolicy: { preset:'custom', customOrder:['command','propulsion','shields','pointDefence','weapons','coolingSupport'] } };
  const snap = createShipBlueprintSnapshot(design, wiring);
  return { design:snap.design, wiring:snap.wiring, componentHp: snap.design.map(()=>1), alive:true, stats:{}, _activityDemandByIndex: { 1: donorDemand, 2: receiverDemand } };
}

s = autoShip({ donorDemand: 5, receiverDemand: 5 }); initializeComponentPower(s);
assert.strictEqual(s.runtimeSwitchgear[0].automaticClosed, true, 'automatic closes only for useful spare transfer');
assert(s.componentPower.byComponentIndex[2].allocatedMw > 0, 'receiver gets transferred spare power');

s = autoShip({ donorDemand: 50, receiverDemand: 5 }); initializeComponentPower(s);
assert.strictEqual(s.runtimeSwitchgear[0].automaticClosed, false, 'automatic does not sacrifice donor-side demand');
assert(/donor|no priority-safe|not useful|open/.test(s.runtimeSwitchgear[0].decisionReason), 'automatic explains safe open decision');

s = autoShip({ donorDemand: 5, receiverDemand: 5, directBypass: true, mode: 'open' }); initializeComponentPower(s);
assert.strictEqual(s.runtimeSwitchgear[0].state, 'open');
assert(!s.powerFlow.sectionFlows.some(f => f.sectionId === 'bypass' || String(f.sectionId).includes('1,0:2,0')), 'direct terminal cable bypass is excluded from runtime topology');
assert.strictEqual(s.componentPower.byComponentIndex[2].allocatedMw, 0, 'open Switchgear isolates even with a drawn A-B bypass section');



function fairTwoReceiverShip(order = "normal") {
  const parts = {
    reactor: { x:0,y:0,type:'reactor' }, donor: { x:0,y:1,type:'engine' },
    r1: { x:3,y:0,type:'shield' }, r2: { x:0,y:4,type:'shield' },
    t1: { x:1,y:0,type:'switchgear',rotation:0,switchgearMode:'automatic',switchgearRatingTier:'standard' },
    t2: { x:0,y:2,type:'switchgear',rotation:90,switchgearMode:'automatic',switchgearRatingTier:'standard' }
  };
  const design = order === "swapped"
    ? [parts.reactor, parts.donor, parts.r1, parts.r2, parts.t2, parts.t1]
    : [parts.reactor, parts.donor, parts.r1, parts.r2, parts.t1, parts.t2];
  const wiring = { version:3, power:{ sections:[
    {id:'source-donor',x1:0,y1:0,x2:0,y2:1,tier:'standard'},
    {id:'source-t1',x1:0,y1:0,x2:1,y2:0,tier:'standard'},
    {id:'t1-r1',x1:2,y1:0,x2:3,y2:0,tier:'standard'},
    {id:'donor-t2',x1:0,y1:1,x2:0,y2:2,tier:'standard'},
    {id:'t2-r2',x1:0,y1:3,x2:0,y2:4,tier:'standard'}
  ], connections:[] }, data:{ sections:[], connections:[] }, powerPolicy: { preset:'custom', customOrder:['command','propulsion','shields','pointDefence','weapons','coolingSupport'] } };
  const snap = createShipBlueprintSnapshot(design, wiring);
  const demand = {};
  snap.design.forEach((part, index) => { if (part.x === 0 && part.y === 1) demand[index] = 4; if ((part.x === 3 && part.y === 0) || (part.x === 0 && part.y === 4)) demand[index] = 4; });
  return { design:snap.design, wiring:snap.wiring, componentHp: snap.design.map(()=>1), alive:true, stats:{}, _activityDemandByIndex: demand };
}
function physicalAllocations(ship) {
  const out = {};
  ship.design.forEach((part, index) => { if (part.type === 'shield' || part.type === 'engine') out[`${part.x},${part.y}`] = ship.componentPower.byComponentIndex[index].allocatedMw; });
  return out;
}
function switchDecisionsByKey(ship) {
  const out = {};
  for (const record of ship.runtimeSwitchgear) out[SwitchgearRules.terminalPairKey(ship.design[record.componentIndex])] = record.automaticClosed;
  return out;
}
s = fairTwoReceiverShip('normal'); initializeComponentPower(s);
assert.deepStrictEqual(Object.values(switchDecisionsByKey(s)).sort(), [true, true], 'joint automatic evaluation conducts both useful equal-priority receiver ties');
let alloc = physicalAllocations(s);
assert(Math.abs(alloc['3,0'] - alloc['0,4']) < 0.01 && alloc['3,0'] > 0, 'equal-priority receivers share spare power fairly');
assert.strictEqual(alloc['0,1'], 4, 'source-side local donor demand is not reduced');
const firstDecision = switchDecisionsByKey(s); const firstAlloc = alloc;
s = fairTwoReceiverShip('swapped'); initializeComponentPower(s);
assert.deepStrictEqual(switchDecisionsByKey(s), firstDecision, 'swapping Switchgear component indices preserves physical tie decisions');
assert.deepStrictEqual(physicalAllocations(s), firstAlloc, 'correctly remapped reordered design preserves physical allocations');


function manualClosedBaselineShip() {
  const design = [
    { x:0,y:0,type:'reactor' },
    { x:3,y:0,type:'engine' },
    { x:0,y:3,type:'shield' },
    { x:3,y:3,type:'shield' },
    { x:1,y:0,type:'switchgear',rotation:0,switchgearMode:'closed',switchgearRatingTier:'standard' },
    { x:0,y:1,type:'switchgear',rotation:90,switchgearMode:'automatic',switchgearRatingTier:'standard' },
    { x:3,y:1,type:'switchgear',rotation:90,switchgearMode:'automatic',switchgearRatingTier:'standard' }
  ];
  const wiring = { version:3, power:{ sections:[
    {id:'source-manual-a',x1:0,y1:0,x2:1,y2:0,tier:'standard'},
    {id:'manual-donor-b',x1:2,y1:0,x2:3,y2:0,tier:'standard'},
    {id:'source-auto-a',x1:0,y1:0,x2:0,y2:1,tier:'standard'},
    {id:'auto-a-shield',x1:0,y1:2,x2:0,y2:3,tier:'standard'},
    {id:'donor-auto-b',x1:3,y1:0,x2:3,y2:1,tier:'standard'},
    {id:'auto-b-shield',x1:3,y1:2,x2:3,y2:3,tier:'standard'}
  ], connections:[] }, data:{ sections:[], connections:[] }, powerPolicy: { preset:'custom', customOrder:['shields','propulsion','command','pointDefence','weapons','coolingSupport'] } };
  const snap = createShipBlueprintSnapshot(design, wiring);
  return { design:snap.design, wiring:snap.wiring, componentHp: snap.design.map(()=>1), alive:true, stats:{}, _activityDemandByIndex: { 1: 10, 2: 4, 3: 4 } };
}
s = manualClosedBaselineShip(); initializeComponentPower(s);
const manualAlloc = physicalAllocations(s);
assert.strictEqual(manualAlloc['3,0'], 10, 'manual Closed tie baseline keeps donor-side allocation intact');
assert.deepStrictEqual(s.runtimeSwitchgear.filter(r => r.mode === 'automatic').map(r => r.automaticClosed), [false, false], 'automatic ties do not claim manual-Closed baseline gains or sacrifice donor allocation');
assert(s.runtimeSwitchgear.filter(r => r.mode === 'automatic').every(r => /no jointly valid|open/.test(r.decisionReason)), 'manual-Closed regression gives safe-open automatic reasons');

function chainShip() {
  const design = [
    { x:0,y:0,type:'reactor' },
    { x:2,y:1,type:'engine' },
    { x:5,y:0,type:'shield' },
    { x:1,y:0,type:'switchgear',rotation:0,switchgearMode:'automatic',switchgearRatingTier:'standard' },
    { x:3,y:0,type:'switchgear',rotation:0,switchgearMode:'automatic',switchgearRatingTier:'standard' }
  ];
  const wiring = { version:3, power:{ sections:[
    {id:'a',x1:0,y1:0,x2:1,y2:0,tier:'standard'},
    {id:'mid',x1:2,y1:0,x2:3,y2:0,tier:'standard'},
    {id:'mid-load',x1:2,y1:0,x2:2,y2:1,tier:'standard'},
    {id:'c',x1:4,y1:0,x2:5,y2:0,tier:'standard'}
  ], connections:[] }, data:{ sections:[], connections:[] }, powerPolicy: { preset:'custom', customOrder:['command','propulsion','shields','pointDefence','weapons','coolingSupport'] } };
  const snap = createShipBlueprintSnapshot(design, wiring);
  return { design:snap.design, wiring:snap.wiring, componentHp: snap.design.map(()=>1), alive:true, stats:{}, _activityDemandByIndex: { 1: 3, 2: 3 } };
}
s = chainShip(); initializeComponentPower(s);
assert.deepStrictEqual(s.runtimeSwitchgear.map(r => r.automaticClosed), [true, true], 'multiple automatic ties close deterministically across a three-grid chain');
assert(s.componentPower.byComponentIndex[1].allocatedMw > 0 && s.componentPower.byComponentIndex[2].allocatedMw > 0, 'three-grid chain transfers through both ties');

const reordered = chainShip();
reordered.design = [reordered.design[0], reordered.design[2], reordered.design[1], reordered.design[3], reordered.design[4]];
reordered._activityDemandByIndex = { 1: 3, 2: 3 };
initializeComponentPower(reordered);
assert.deepStrictEqual(reordered.runtimeSwitchgear.map(r => r.automaticClosed), [true, true], 'automatic tie result is stable under remapped input ordering');

console.log('verify-switchgear-runtime passed');
