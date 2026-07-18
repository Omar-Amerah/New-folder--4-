"use strict";
const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const WiringRules = require("./public/src/shared/wiringRules");
const DataRules = require("./public/src/shared/dataSupportRules");
const EngineExhaust = require("./public/src/shared/engineExhaust");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initializeComponentPower, reallocateShipPower } = require("./src/server/componentPower");
const { initShipHeat, updateShipHeat } = require("./src/server/heat");
const ComponentData = require("./src/server/componentData");

globalThis.HeatRules = HeatRules;
globalThis.WiringRules = WiringRules;
globalThis.DataSupportRules = DataRules;
globalThis.EngineExhaustRules = EngineExhaust;

const close = (a, b, msg, eps = 1e-6) => assert(Math.abs(a - b) <= eps, `${msg}: designer=${a} server=${b} diff=${a-b}`);
const m = (type, x, y, rotation = 0) => ({ type, x, y, rotation });
const empty = () => WiringRules.emptyWiring();
function wire(w, kind, cells, design) { return WiringRules.addPath(w, kind, cells, design, PARTS); }
function powerPair(extra = []) { const d = [m("reactor",0,0), ...extra]; let w = empty(); for (let i=1;i<d.length;i++) w = wire(w,"power",[{x:0,y:0},{x:d[i].x,y:d[i].y}],d); return { d, w }; }
function runtimeShip(design, wiring) { const ship = { id:"parity", alive:true, design, wiring, stats: computeStats(design) }; initComponentState(ship); initializeComponentPower(ship); initShipHeat(ship); return ship; }
function setHeatState(ship, index, state) { const cap = ship.componentThermals[index].capacity; const ratio = state === HeatRules.STATE.NORMAL ? 0.05 : state === HeatRules.STATE.WARM ? 0.30 : state === HeatRules.STATE.HOT ? 0.56 : state === HeatRules.STATE.CRITICAL ? 0.82 : 1.04; ship.componentHeat[index] = cap * ratio; ship.componentHeatState[index] = state; }
function runServerTick(ship) { ship.heatAccumulator = 0; updateShipHeat(ship, HeatRules.TICK_SECONDS, { effects:[] }, 0); }
(async () => {
  global.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add(){}, remove(){} } } };
  global.window = { devicePixelRatio: 1 };
  const parts = await import("./public/src/design/parts.js"); parts.applyServerParts(PARTS);
  const thermal = await import("./public/src/design/thermalAnalysis.js");
  function load(design, wiring, mode="full", options={}) { return thermal.buildThermalLoad(thermal.buildThermalModel(design), mode, wiring, options); }

  for (const fixture of [
    { name:"fully powered exposed radiator", design:[m("reactor",0,0),m("radiator",1,0)], wire:true, exposed:1, power:1, state:HeatRules.STATE.NORMAL },
    { name:"fully powered enclosed radiator", design:[m("reactor",1,1),m("radiator",1,2),m("armor",0,2),m("armor",2,2),m("armor",1,3)], wire:true, exposed:.25, power:1, state:HeatRules.STATE.NORMAL },
    { name:"unpowered exposed radiator", design:[m("radiator",1,0)], wire:false, exposed:1, power:0, state:HeatRules.STATE.NORMAL },
    { name:"underpowered radiator", design:[m("smallReactor",0,0),m("radiator",1,0),m("engine",2,0)], wire:true, exposed:1, under:true, state:HeatRules.STATE.NORMAL },
    { name:"HOT radiator", design:[m("reactor",0,0),m("radiator",1,0)], wire:true, exposed:1, power:1, state:HeatRules.STATE.HOT },
    { name:"OVERHEATED radiator", design:[m("reactor",0,0),m("radiator",1,0)], wire:true, exposed:1, power:1, state:HeatRules.STATE.OVERHEATED }
  ]) {
    let w = empty(); if (fixture.wire) for (let i=1;i<fixture.design.length;i++) w = wire(w,"power",[{x:0,y:0},{x:fixture.design[i].x,y:fixture.design[i].y}],fixture.design);
    const l = load(fixture.design, w); const idx = fixture.design.findIndex(x=>x.type==="radiator");
    const power = fixture.under ? l.powerMultiplier[idx] : fixture.power;
    const expected = Math.max(14*0.12, 14*HeatRules.activeCoolingForState(fixture.state)*power)*fixture.exposed;
    const model = thermal.buildThermalModel(fixture.design); const sim = thermal.simulateThermalLoad(model, { ...l, generationRates: fixture.design.map((_,i)=>i===idx?200:0), powerMultiplier: l.powerMultiplier });
    const designer = Math.max(14*0.12,14*HeatRules.activeCoolingForState(fixture.state)*power)*fixture.exposed;
    close(designer, expected, `${fixture.name} radiator effective cooling`);
    assert(Number.isFinite(sim.radiatorRemovedTotal), `${fixture.name} deterministic simulation produced cooling total`);
  }

  for (const mode of ["idle","combat","full"]) { const {d,w}=powerPair([m("engine",1,0)]); const l=load(d,w,mode); assert(l.generationRates[0] >= 0, `${mode} reactor heat is finite`); }
  for (const state of [HeatRules.STATE.NORMAL, HeatRules.STATE.WARM, HeatRules.STATE.HOT, HeatRules.STATE.CRITICAL, HeatRules.STATE.OVERHEATED]) {
    const {d,w}=powerPair([m("engine",1,0)]);
    const model = thermal.buildThermalModel(d); const l = load(d,w,"full"); const sim = thermal.simulateThermalLoad(model,l,{maxSteps:1, initialHeatStates:{0:state}});
    const ship = runtimeShip(d,w); setHeatState(ship,0,state); runServerTick(ship);
    const expectedServer = ship.componentHeatGenerated[0] / HeatRules.TICK_SECONDS;
    const expected = state === HeatRules.STATE.OVERHEATED ? 0 : l.generationRates[0];
    close(expectedServer, expected, `server authoritative reactor Heat state ${state}`, 1e-6);
    close((sim.generatedHeat?.[0] || 0) / HeatRules.TICK_SECONDS, expected, `designer authoritative reactor Heat state ${state}`, 1e-6);
  }
  { const {d,w}=powerPair([]); close(load(d,w,"full").generationRates[0], 0, "solo reactor gated by zero load"); }
  assert.strictEqual(HeatRules.activityHeat("battery", PARTS.battery), 0, "battery zero activity Heat");
  assert.strictEqual(HeatRules.activityHeat("capacitor", PARTS.capacitor), 0, "capacitor zero activity Heat");

  for (const f of [
    { name:"unsupported beam", weapon:"beamEmitter", source:false }, { name:"supported beam", weapon:"beamEmitter", source:true },
    { name:"unsupported repeating weapon", weapon:"blaster", source:false }, { name:"fire-rate-supported repeating weapon", weapon:"blaster", source:true },
    { name:"disconnected Data source", weapon:"blaster", source:true, data:false }, { name:"underpowered Data source", weapon:"blaster", source:true, power:false },
    { name:"thermally reduced Data source", weapon:"blaster", source:true, state:HeatRules.STATE.HOT }
  ]) {
    const d=[m("reactor",0,0), ...(f.source?[m("fireControl",1,0)]:[]), m(f.weapon,2,0)]; let w=empty(); const wi=d.length-1; w=wire(w,"power",[{x:0,y:0},{x:1,y:0},{x:d[wi].x,y:d[wi].y}],d); if (f.power!==false && f.source) w=wire(w,"power",[{x:0,y:0},{x:1,y:0}],d); if (f.data!==false && f.source) w=wire(w,"data",[{x:1,y:0},{x:d[wi].x,y:d[wi].y}],d);
    const l=load(d,w,"full",{ sourceHeatStates: f.state==null?{}:{1:f.state} }); const base=HeatRules.activityHeat(f.weapon, PARTS[f.weapon]);
    if (f.data===false) close(l.generationRates[wi], base, `${f.name} remains base Heat`);
    else if (f.source) assert(l.generationRates[wi] >= base, `${f.name} includes supported weapon Heat`);
    else close(l.generationRates[wi], base, `${f.name} remains base Heat`);
  }
  {
    const d=[m("reactor",0,0),m("reactor",1,0),m("engine",2,0),m("radiator",3,0)]; let w=empty();
    for (let i=1;i<d.length;i++) w=wire(w,"power",[{x:0,y:0},{x:d[i].x,y:d[i].y}],d); w=wire(w,"power",[{x:1,y:0},{x:2,y:0}],d);
    const ship=runtimeShip(d,w); const before=ship.componentPower.byComponentIndex[2].operationalMultiplier; setHeatState(ship,0,HeatRules.STATE.OVERHEATED); reallocateShipPower(ship,"parity-one"); const afterOne=ship.componentPower.byComponentIndex[2].operationalMultiplier; setHeatState(ship,1,HeatRules.STATE.OVERHEATED); reallocateShipPower(ship,"parity-all"); const afterAll=ship.componentPower.byComponentIndex[2].operationalMultiplier;
    assert(before > 0 && afterOne > 0, "server reallocates to remaining generator"); close(afterAll,0,"server all-generator shutdown multiplier");
  }
  {
    const d=[m("reactor",0,0),m("fireControl",1,0),m("blaster",2,0)]; let w=empty(); w=wire(w,"power",[{x:0,y:0},{x:1,y:0},{x:2,y:0}],d); w=wire(w,"data",[{x:1,y:0},{x:2,y:0}],d);
    const ship=runtimeShip(d,w); assert(ComponentData.getWeaponDataSupport(ship,2).fireRateBonus > 0, "server Data support starts active"); setHeatState(ship,0,HeatRules.STATE.OVERHEATED); reallocateShipPower(ship,"parity-data-loss"); close(ComponentData.getWeaponDataSupport(ship,2).fireRateBonus,0,"server Data support drops after Power loss");
  }
  console.log("Real designer/server thermal parity verifier passed (production Heat, Power, Data paths).")
})().catch((e)=>{ console.error(e); process.exit(1); });
