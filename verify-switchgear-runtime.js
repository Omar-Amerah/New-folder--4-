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

console.log('verify-switchgear-runtime passed');
