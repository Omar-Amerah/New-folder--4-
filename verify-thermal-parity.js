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

const ACCUMULATED_HEAT_EPSILON = 5;
const EXACT_EPSILON = 1e-6;
const REPRESENTATIVE_RATIOS = Object.freeze({
  [HeatRules.STATE.NORMAL]: 0.05,
  [HeatRules.STATE.WARM]: 0.50,
  [HeatRules.STATE.HOT]: 0.75,
  [HeatRules.STATE.CRITICAL]: 0.92,
  [HeatRules.STATE.OVERHEATED]: 1.04
});
const close = (a, b, msg, eps = EXACT_EPSILON, meta = "") => assert(Math.abs(a - b) <= eps, `${msg}${meta}: designer=${a} server=${b} diff=${Math.abs(a-b)}`);
const m = (type, x, y, rotation = 0) => ({ type, x, y, rotation });
const empty = () => WiringRules.emptyWiring();
function wire(w, kind, cells, design) { return WiringRules.addPath(w, kind, cells, design, PARTS); }
function powerPair(extra = []) { const d = [m("reactor",0,0), ...extra]; let w = empty(); for (let i=1;i<d.length;i++) w = wire(w,"power",[{x:0,y:0},{x:d[i].x,y:d[i].y}],d); return { d, w }; }
function runtimeShip(design, wiring) { const ship = { id:"parity", alive:true, design, wiring, stats: computeStats(design) }; initComponentState(ship); initializeComponentPower(ship); initShipHeat(ship); return ship; }
function setHeatState(ship, index, state) { const cap = ship.componentThermals[index].capacity; ship.componentHeat[index] = cap * REPRESENTATIVE_RATIOS[state]; ship.componentHeatState[index] = HeatRules.stateFor(ship.componentHeat[index] / cap, ship.componentHeatState[index]); assert.strictEqual(ship.componentHeatState[index], state, `fixture setup state ${state} derives from stored Heat`); }
function runServerTick(ship) { ship.heatAccumulator = 0; updateShipHeat(ship, HeatRules.TICK_SECONDS, { effects:[] }, 0); }
function zeroes(n) { return Array.from({ length:n }, () => 0); }

(async () => {
  global.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { classList: { add(){}, remove(){} } } };
  global.window = { devicePixelRatio: 1 };
  const parts = await import("./public/src/design/parts.js"); parts.applyServerParts(PARTS);
  const thermal = await import("./public/src/design/thermalAnalysis.js");
  function load(design, wiring, mode="full", options={}) { return thermal.buildThermalLoad(thermal.buildThermalModel(design), mode, wiring, options); }
  function serverCoolingRate(ship, model, i) {
    const th = ship.componentThermals[i]; let rate = th.cooling * th.retention;
    if (ship.design[i].type === "radiator") {
      const exposure = th.exposedEdges > 0 ? 1 : 0.25;
      const power = ship.componentPower.byComponentIndex[i].operationalMultiplier;
      rate = Math.max(th.cooling * 0.12, th.cooling * HeatRules.activeCoolingForState(ship.componentHeatState[i]) * power) * exposure * th.retention;
    } else if (model.exposed[i] > 0) rate *= 1.12;
    const ratio = Math.max(0, ship.componentHeat[i] / Math.max(1, th.capacity));
    return rate * (0.7 + 0.9 * ratio * ratio);
  }
  function failureMeta(name, design, model, sim, ship, i, steps) {
    const data = ComponentData.getWeaponDataSupport(ship,i).fireRateBonus || 0;
    const ratio = ship.componentHeat[i] / Math.max(1, ship.componentThermals[i].capacity);
    return ` [fixture=${name}; component=${i}; type=${design[i].type}; periodTicks=${steps}; Heat state=${ship.componentHeatState[i]}; storedHeatRatio=${ratio}; Power multiplier=${ship.componentPower.byComponentIndex[i].operationalMultiplier}; Data multiplier=${data}; exposure=${model.exposed[i] > 0 ? 1 : 0.25}]`;
  }
  function assertDesignerServerPair(fixture) {
    const steps = fixture.steps || 3;
    const model = thermal.buildThermalModel(fixture.design);
    const initOptions = fixture.initial || {};
    const l = thermal.buildThermalLoad(model, fixture.mode || "full", fixture.wiring || empty(), initOptions);
    const sim = thermal.simulateThermalLoad(model, l, { maxSteps: steps, ...initOptions });
    const ship = runtimeShip(fixture.design, fixture.wiring || empty());
    if (initOptions.initialHeatValues) for (const [k,v] of Object.entries(initOptions.initialHeatValues)) { const i=Number(k); ship.componentHeat[i]=v; ship.componentHeatState[i]=HeatRules.stateFor(v/ship.componentThermals[i].capacity, ship.componentHeatState[i]); }
    if (initOptions.initialHeatRatios) for (const [k,v] of Object.entries(initOptions.initialHeatRatios)) { const i=Number(k); ship.componentHeat[i]=ship.componentThermals[i].capacity * v; ship.componentHeatState[i]=HeatRules.stateFor(v, ship.componentHeatState[i]); }
    if (initOptions.initialHeatStates) for (const [k,v] of Object.entries(initOptions.initialHeatStates)) setHeatState(ship, Number(k), v);
    reallocateShipPower(ship, "parity-initial-heat");
    require("./src/server/componentData").refreshShipDataAllocation(ship, "parity-initial-heat");
    if (fixture.beforeServer) fixture.beforeServer(ship);
    const generated = zeroes(fixture.design.length), cooled = zeroes(fixture.design.length), peakRatio = zeroes(fixture.design.length), peakAvailable = zeroes(fixture.design.length);
    let totalGenerated = 0, totalCooled = 0, totalAvailable = 0, totalOverflow = 0;
    for (let t=0;t<steps;t++) {
      if (fixture.beforeServerTick) fixture.beforeServerTick(ship, t);
      runServerTick(ship);
      for (let i=0;i<fixture.design.length;i++) {
        generated[i] += ship.componentHeatGenerated[i]; cooled[i] += ship.componentHeatCooled[i];
        totalGenerated += ship.componentHeatGenerated[i]; totalCooled += ship.componentHeatCooled[i];
        const available = serverCoolingRate(ship, model, i); totalAvailable += available * HeatRules.TICK_SECONDS; peakAvailable[i] = Math.max(peakAvailable[i], available);
        peakRatio[i] = Math.max(peakRatio[i], ship.componentHeat[i] / Math.max(1, ship.componentThermals[i].capacity));
      }
      totalOverflow += ship.ventedOverflowHeatThisTick || 0;
    }
    for (let i=0;i<fixture.design.length;i++) {
      const meta = failureMeta(fixture.name, fixture.design, model, sim, ship, i, steps);
      close(sim.heat[i], ship.componentHeat[i], `${fixture.name} component ${i}/${fixture.design[i].type} final stored Heat`, fixture.eps || ACCUMULATED_HEAT_EPSILON, meta);
      close(sim.generatedHeat[i], generated[i], `${fixture.name} component ${i}/${fixture.design[i].type} cumulative generated Heat`, fixture.eps || ACCUMULATED_HEAT_EPSILON, meta);
      close(sim.cooling[i], cooled[i], `${fixture.name} component ${i}/${fixture.design[i].type} cumulative cooling removed`, fixture.eps || ACCUMULATED_HEAT_EPSILON, meta);
      close(sim.componentVentedOverflowHeat?.[i] || 0, ship.componentTotalVentedOverflowHeat?.[i] || 0, `${fixture.name} component ${i}/${fixture.design[i].type} cumulative vented overflow`, fixture.eps || ACCUMULATED_HEAT_EPSILON, meta);
      assert.strictEqual(sim.states[i], ship.componentHeatState[i], `${fixture.name} component ${i}/${fixture.design[i].type} final Heat state${meta}`);
      close(sim.finalPowerMultiplier[i], ship.componentPower.byComponentIndex[i].operationalMultiplier, `${fixture.name} component ${i}/${fixture.design[i].type} Power multiplier`, EXACT_EPSILON, meta);
      const finalDesignerData = sim.finalPowerMultiplier.some(value => value <= 0) ? sim.dataSupport : load(fixture.design, fixture.wiring || empty(), fixture.mode || "full", { sourceHeatStates: Object.fromEntries(sim.states.map((state, index) => [index, state])) }).dataSupport;
      const ds = finalDesignerData?.weaponSupportByIndex?.[i]?.fireRateBonus || 0, ss = ComponentData.getWeaponDataSupport(ship,i).fireRateBonus || 0;
      close(ds, ss, `${fixture.name} component ${i}/${fixture.design[i].type} final Data multiplier`, EXACT_EPSILON, meta);
      close(sim.peakRatios[i], peakRatio[i], `${fixture.name} component ${i}/${fixture.design[i].type} peak Heat ratio`, fixture.eps || ACCUMULATED_HEAT_EPSILON, meta);
      if (fixture.compareRadiator && fixture.design[i].type === "radiator") close(sim.cooling[i] / (steps * HeatRules.TICK_SECONDS), cooled[i] / (steps * HeatRules.TICK_SECONDS), `${fixture.name} actual cooling rate`, fixture.eps || ACCUMULATED_HEAT_EPSILON, meta);
    }
    close(sim.totalGeneratedHeat, totalGenerated, `${fixture.name} cumulative total generated Heat`, fixture.eps || ACCUMULATED_HEAT_EPSILON);
    close(sim.totalCoolingRemoved, totalCooled, `${fixture.name} cumulative total cooling removed`, fixture.eps || ACCUMULATED_HEAT_EPSILON);
    close(sim.totalVentedOverflowHeat || 0, totalOverflow, `${fixture.name} cumulative total vented overflow`, fixture.eps || ACCUMULATED_HEAT_EPSILON);
    close(sim.averageAvailableCoolingRate * sim.simulatedSeconds, totalAvailable, `${fixture.name} accumulated available cooling`, fixture.eps || ACCUMULATED_HEAT_EPSILON);
    assert(Number.isFinite(sim.peakAvailableCoolingRate), `${fixture.name} available cooling rate is finite`);
    return { sim, ship, model };
  }

  for (const state of Object.values(HeatRules.STATE)) {
    const {d,w}=powerPair([m("engine",1,0)]); const cap = HeatRules.profile("reactor", PARTS.reactor).capacity;
    const l = load(d,w,"full",{initialHeatStates:{0:state}});
    close(l.initialStoredHeat[0], cap * REPRESENTATIVE_RATIOS[state], `initialHeatState ${state} creates matching stored Heat`);
    assert.strictEqual(l.initialHeatStates[0], state, `initialHeatState ${state} derives back to same state`);
    const {sim, model} = assertDesignerServerPair({ name:`representative initial state ${state}`, design:d, wiring:w, steps:1, initial:{initialHeatStates:{0:state}} });
    const after = HeatRules.stateFor(sim.heat[0]/model.profiles[0].capacity, state);
    assert.strictEqual(sim.states[0], after, `initial state ${state} remains consistent after first tick unless threshold crossed`);
    assert.throws(() => load(d,w,"full",{initialHeatStates:{0:state}, initialHeatRatios:{0: state === HeatRules.STATE.NORMAL ? 0.75 : 0.05}}), /does not match stored Heat state/, `mismatched ratio/state fails for ${state}`);
    assert.throws(() => load(d,w,"full",{initialHeatStates:{0:state}, initialHeatValues:{0: cap * (state === HeatRules.STATE.NORMAL ? 0.75 : 0.05)}}), /does not match stored Heat state/, `mismatched value/state fails for ${state}`);
    assert.doesNotThrow(() => load(d,w,"full",{initialHeatStates:{0:state}, initialHeatRatios:{0:REPRESENTATIVE_RATIOS[state]}}), `matching ratio/state passes for ${state}`);
    assert.doesNotThrow(() => load(d,w,"full",{initialHeatStates:{0:state}, initialHeatValues:{0:cap*REPRESENTATIVE_RATIOS[state]}}), `matching value/state passes for ${state}`);
  }

  { const {d,w}=powerPair([m("engine",1,0)]); const {sim}=assertDesignerServerPair({ name:"initially OVERHEATED reactor with powered consumers", design:d, wiring:w, steps:1, initial:{ initialHeatStates:{0:HeatRules.STATE.OVERHEATED} } }); close(sim.initialPowerMultiplier[1],0,"initially OVERHEATED sole reactor gives consumers multiplier 0 before tick one"); close(sim.generatedHeat[0],0,"initially OVERHEATED reactor produces zero Heat"); }
  for (const state of [HeatRules.STATE.HOT, HeatRules.STATE.CRITICAL]) { const {d,w}=powerPair([m("engine",1,0)]); const {sim}=assertDesignerServerPair({ name:`${state} loaded reactor`, design:d, wiring:w, steps:1, initial:{ initialHeatStates:{0:state} } }); assert(sim.generatedHeat[0] > 0, `${state} reactor retains nominal generation`); }
  for (const fixture of [
    { name:"reactor entering OVERHEATED during simulation", initial:{initialHeatRatios:{0:1.03}}, steps:4 }, { name:"reactor recovering from OVERHEATED", initial:{initialHeatRatios:{0:1.01}}, steps:8 },
    { name:"two generators where one shuts down", design:[m("reactor",0,0),m("reactor",1,0),m("engine",2,0)], initial:{initialHeatStates:{0:HeatRules.STATE.OVERHEATED}}, steps:2 }, { name:"all generators shutting down", design:[m("reactor",0,0),m("engine",1,0)], initial:{initialHeatStates:{0:HeatRules.STATE.OVERHEATED}}, steps:2 }
  ]) { let d=fixture.design || powerPair([m("engine",1,0)]).d; let w=empty(); for (let i=1;i<d.length;i++) w=wire(w,"power",[{x:0,y:0},{x:d[i].x,y:d[i].y}],d); if (d[1]?.type==="reactor") w=wire(w,"power",[{x:1,y:0},{x:2,y:0}],d); assertDesignerServerPair({ ...fixture, design:d, wiring:w }); }

  {
    const d=[m("frame",0,0)]; const model=thermal.buildThermalModel(d); const initial={initialHeatRatios:{0:0.99}}; const baseLoad=thermal.buildThermalLoad(model,"full",empty(),initial);
    const customLoad={...baseLoad, generationRates:[50 / HeatRules.TICK_SECONDS]}; const sim=thermal.simulateThermalLoad(model,customLoad,{maxSteps:1,...initial});
    const ship=runtimeShip(d,empty()); ship.componentHeat[0]=ship.componentThermals[0].capacity*0.99; ship.componentHeatState[0]=HeatRules.stateFor(0.99, ship.componentHeatState[0]); ship.componentHeatInput[0]=sim.totalGeneratedHeat; runServerTick(ship);
    close(sim.heat[0], ship.componentHeat[0], "overflow fixture final retained Heat", ACCUMULATED_HEAT_EPSILON); close(sim.totalGeneratedHeat, ship.componentHeatGenerated[0], "overflow fixture total generated Heat", ACCUMULATED_HEAT_EPSILON); close(sim.totalCoolingRemoved, ship.componentHeatCooled[0], "overflow fixture total cooling removed", ACCUMULATED_HEAT_EPSILON); close(sim.totalVentedOverflowHeat, ship.totalVentedOverflowHeat, "overflow fixture total vented overflow", ACCUMULATED_HEAT_EPSILON); assert.strictEqual(sim.states[0], ship.componentHeatState[0], "overflow fixture final Heat state");
  }

  for (const mode of ["idle","combat","full"]) { const {d,w}=powerPair([m("engine",1,0)]); const l=load(d,w,mode); assert(l.generationRates[0] >= 0, `${mode} reactor heat is finite`); }
  { const {d,w}=powerPair([]); close(load(d,w,"full").generationRates[0], 0, "solo reactor gated by zero load"); }
  assert.strictEqual(HeatRules.activityHeat("battery", PARTS.battery), 0, "battery zero activity Heat"); assert.strictEqual(HeatRules.activityHeat("capacitor", PARTS.capacitor), 0, "capacitor zero activity Heat");
  { const d=[m("reactor",0,0),m("reactor",1,0),m("engine",2,0),m("radiator",3,0)]; let w=empty(); for (let i=1;i<d.length;i++) w=wire(w,"power",[{x:0,y:0},{x:d[i].x,y:d[i].y}],d); w=wire(w,"power",[{x:1,y:0},{x:2,y:0}],d); const ship=runtimeShip(d,w); const before=ship.componentPower.byComponentIndex[2].operationalMultiplier; setHeatState(ship,0,HeatRules.STATE.OVERHEATED); reallocateShipPower(ship,"parity-one"); const afterOne=ship.componentPower.byComponentIndex[2].operationalMultiplier; setHeatState(ship,1,HeatRules.STATE.OVERHEATED); reallocateShipPower(ship,"parity-all"); const afterAll=ship.componentPower.byComponentIndex[2].operationalMultiplier; assert(before > 0 && afterOne > 0, "server reallocates to remaining generator"); close(afterAll,0,"server all-generator shutdown multiplier"); }
  console.log("Real designer/server thermal parity verifier passed (production Heat, Power, Data paths).")
})().catch((e)=>{ console.error(e); process.exit(1); });
