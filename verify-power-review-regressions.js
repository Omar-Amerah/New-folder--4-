"use strict";
const assert = require("assert");
const PowerCableThermalRules = require("./public/src/shared/powerCableThermalRules.js");
const { _test } = require("./src/server/snapshots.js");
const { BALANCE } = require("./src/server/balanceConfig");
let n = 0; function check(name, fn){ fn(); console.log(`  ok  ${++n}. ${name}`); }
const EPS = 1e-9;
function close(a,b,msg){ assert(Math.abs(a-b) <= EPS, `${msg}: ${a} != ${b}`); }
function thermal(sectionFlows, hosts){ return PowerCableThermalRules.analyzePowerCableHeat({ sectionFlows, powerTiers: BALANCE.wiringInfrastructure.powerTiers, hostMap:{ bySectionId:new Map(Object.entries(hosts).map(([sectionId, hostCells])=>[sectionId,{hostCells}])) } }); }
function cells(a,b){ return [{x:a,y:0,componentIndex:a},{x:b,y:0,componentIndex:b}]; }
function flow(id, mw, tier="light", operational=true){ const cfg=BALANCE.wiringInfrastructure.powerTiers[tier]; return { sectionId:id, tier, signedFlowMw:mw, absoluteFlowMw:Math.abs(mw), sustainedCapacityMw:cfg.sustainedCapacityMw, peakCapacityMw:cfg.peakCapacityMw, sustainedUtilisation:Math.abs(mw)/cfg.sustainedCapacityMw, peakUtilisation:Math.abs(mw)/cfg.peakCapacityMw, aboveSustained:Math.abs(mw)>cfg.sustainedCapacityMw, atPeak:Math.abs(mw)>=cfg.peakCapacityMw, operational }; }
check("Power cable Heat breakdown is behavioural and conserved", () => {
  const result = thermal([flow("section-1", 1), flow("section-2", 6), flow("section-3", 0), flow("section-4", 6, "light", false)], { "section-1": cells(0,1), "section-2": cells(1,2), "section-3": cells(1,3), "section-4": cells(8,9) });
  assert.strictEqual(result.sections.length, 3, "disabled/broken sections are omitted from active thermal sections");
  const by = new Map(result.sections.map(s=>[s.sectionId,s]));
  assert(by.get("section-1").baseHeatPerSecond > 0 && by.get("section-1").overloadHeatPerSecond === 0, "normal section has base heat only");
  assert(by.get("section-2").baseHeatPerSecond > 0 && by.get("section-2").overloadHeatPerSecond > 0, "overload section has additional overload heat");
  for (const s of result.sections) close(s.baseHeatPerSecond + s.overloadHeatPerSecond, s.totalHeatPerSecond, `base+overload ${s.sectionId}`);
  close(result.summary.totalPowerCableHeatPerSecond, result.sections.reduce((sum,s)=>sum+s.totalHeatPerSecond,0), "section sum matches summary");
  assert(!by.has("section-4"), "disabled overloaded section does not retain stale Heat");
  assert(result.components.find(c=>c.componentIndex===1).hostedActiveSectionIds.includes("section-1"));
  assert(result.components.find(c=>c.componentIndex===1).hostedActiveSectionIds.includes("section-2"));
});
check("disabled Power sections and similar Data IDs are deterministic and non-contributing", () => {
  const flows = [flow("section-12", 2), flow("data:section-12", 6, "light", false), flow("section-disabled", 6, "light", false)];
  const hosts = { "section-12": cells(0,1), "data:section-12": cells(2,3), "section-disabled": cells(4,5) };
  const a = thermal(flows, hosts);
  const b = thermal(flows, hosts);
  assert.deepStrictEqual(a.sections.map(s=>s.sectionId), ["section-12"]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), "repeated disabled-section analysis is deterministic");
  close(a.summary.totalPowerCableHeatPerSecond, a.sections[0].totalHeatPerSecond, "disabled sections do not contribute");
});
function shipForSwitch(record, hp=100){ return { runtimeSwitchgear:[{ sustainedCapacityMw:4, peakCapacityMw:7, signedTransferMw:0, utilisation:0, classification:"isolator", ratingTier:"light", decisionReason:"test", ...record }], componentHp:{ [record.componentIndex]:hp }, _powerProtection:{ switchgear:new Map(), sections:new Map() } }; }
function snapSwitch(record, hp){ return _test.buildSwitchgearSnapshot(shipForSwitch(record,hp))[0]; }
check("switchgear presentation states use explicit null network checks", () => {
  const cases = [
    [{componentIndex:1, mode:"open", state:"open", conducts:false, sideANetworkId:"0", sideBNetworkId:"n1"}, "open"],
    [{componentIndex:2, mode:"closed", state:"closed", conducts:true, sideANetworkId:"0", sideBNetworkId:"n1", signedTransferMw:3}, "closed-conducting"],
    [{componentIndex:3, mode:"closed", state:"closed", conducts:false, sideANetworkId:"0", sideBNetworkId:"n1"}, "unpowered"],
    [{componentIndex:4, mode:"automatic", state:"automatic", conducts:false, sideANetworkId:"a", sideBNetworkId:"b"}, "automatic-idle"],
    [{componentIndex:5, mode:"automatic", state:"automatic", conducts:true, sideANetworkId:"a", sideBNetworkId:"b"}, "automatic-conducting"],
    [{componentIndex:6, mode:"closed", state:"tripped", conducts:false, sideANetworkId:"a", sideBNetworkId:"b", cooldownRemaining:1.5, trippedReason:"overload"}, "tripped-cooling"],
    [{componentIndex:7, mode:"closed", state:"tripped", conducts:false, sideANetworkId:"a", sideBNetworkId:"b", cooldownRemaining:0, retryCount:2}, "tripped-retry-pending"],
    [{componentIndex:8, mode:"closed", state:"closed", conducts:false, sideANetworkId:"a", sideBNetworkId:"b"}, "destroyed", 0],
    [{componentIndex:9, mode:"closed", state:"closed", conducts:false, sideANetworkId:null, sideBNetworkId:null}, "disconnected"],
    [{componentIndex:10, mode:"closed", state:"closed", conducts:false, sideANetworkId:null, sideBNetworkId:"b"}, "disconnected"],
    [{componentIndex:11, mode:"closed", state:"closed", conducts:false, sideANetworkId:"a", sideBNetworkId:null}, "disconnected"]
  ];
  for (const [record, expected, hp] of cases) {
    const out = snapSwitch(record, hp);
    assert.strictEqual(out.presentationState, expected, `${record.componentIndex}`);
    assert.strictEqual(out.runtimeState, record.state);
    assert.strictEqual(out.conducts, Boolean(record.conducts));
    assert.strictEqual(out.sideANetworkId, record.sideANetworkId ?? null);
    assert.strictEqual(out.sideBNetworkId, record.sideBNetworkId ?? null);
    assert.strictEqual(out.sustainedCapacityMw, 4);
    assert.strictEqual(out.peakCapacityMw, 7);
    if (!record.conducts) assert(out.reasonNotConducting);
  }
});
function genSnapshot(cp){ const ship={ design:[{type:"reactor"}], componentHp:[100], componentPower:{byComponentIndex:[{role:"source", networkId:cp.networkId, requestedMw:0, allocatedMw:0, operationalMultiplier:1, ...cp}]}, powerFlow:{summary:{}}, powerCableThermalAnalysis:{sections:[],components:[],summary:{}}, componentHeatGenerated:[0], componentHeatCooled:[0], lastHeatTickDelta:1 }; return _test.buildRuntimePowerThermalSnapshot(ship).components[0]; }
check("generator runtime fields preserve missing vs authoritative zero", () => {
  assert.strictEqual(genSnapshot({}).availableGenerationMw, null);
  assert.strictEqual(genSnapshot({generationAvailableMw:0,generationUsedMw:0,generationReductionReasons:["destroyed-component"]}).availableGenerationMw, 0);
  assert.strictEqual(genSnapshot({generationAvailableMw:8,generationUsedMw:0,generationReductionReasons:["no-connected-demand"]}).unusedGenerationMw, 8);
  assert.strictEqual(genSnapshot({generationAvailableMw:8,generationUsedMw:3,generationReductionReasons:["curtailed-by-demand"]}).deliveredGenerationMw, 3);
  assert.deepStrictEqual(genSnapshot({generationAvailableMw:8,generationUsedMw:0,networkId:null,generationReductionReasons:["isolated-from-network"]}).reductionReasons, ["isolated-from-network"]);
});
check("snapshot section Heat uses authoritative thermal section values", () => {
  const analysis = thermal([flow("section-1", 1), flow("section-2", 6)], { "section-1": cells(0,1), "section-2": cells(1,2) });
  const ship={ design:[], componentPower:{byComponentIndex:[]}, powerFlow:{summary:{}}, powerCableThermalAnalysis:analysis, powerCableHeatRate:analysis.summary.totalPowerCableHeatPerSecond, componentHeatGenerated:[], componentHeatCooled:[], lastHeatTickDelta:1 };
  const snap = _test.buildRuntimePowerThermalSnapshot(ship);
  const json = JSON.parse(JSON.stringify(snap));
  close(Object.values(json.powerCableHeatBySectionId).reduce((sum,h)=>sum+h.totalHeatPerSecond,0), json.powerCableHeatRate, "snapshot Heat total");
  for (const heat of Object.values(json.powerCableHeatBySectionId)) {
    assert("baseHeatPerSecond" in heat && "overloadHeatPerSecond" in heat && "totalHeatPerSecond" in heat, "canonical Heat-rate names present");
    close(heat.baseHeatPerSecond + heat.overloadHeatPerSecond, heat.totalHeatPerSecond, "snapshot breakdown");
  }
});
check("ship summary generation fields preserve null, zero and positive values", () => {
  const baseShip = (summary) => ({ design:[], componentPower:{byComponentIndex:[]}, powerFlow:{summary}, powerCableThermalAnalysis:{sections:[],components:[],summary:{}}, powerCableHeatRate:0, componentHeatGenerated:[], componentHeatCooled:[], lastHeatTickDelta:1 });
  assert.strictEqual(_test.buildRuntimePowerThermalSnapshot(baseShip({})).totalAvailableGenerationMw, null);
  assert.strictEqual(_test.buildRuntimePowerThermalSnapshot(baseShip({availableGenerationMw:0, usedGenerationMw:0})).totalAvailableGenerationMw, 0);
  const positive = _test.buildRuntimePowerThermalSnapshot(baseShip({availableGenerationMw:12, usedGenerationMw:7}));
  assert.strictEqual(positive.totalAvailableGenerationMw, 12);
  assert.strictEqual(positive.totalDeliveredGenerationMw, 7);
  assert.strictEqual(_test.buildRuntimePowerThermalSnapshot(baseShip({availableGenerationMw:5})).totalDeliveredGenerationMw, null);
  assert.strictEqual(_test.buildRuntimePowerThermalSnapshot(baseShip({usedGenerationMw:3})).totalAvailableGenerationMw, null);
});
check("serialized combat Power snapshot v2 contract exposes stable fields", () => {
  const analysis = thermal([flow("section-normal", 1), flow("section-overload", 6), flow("section-disabled", 6, "light", false)], { "section-normal": cells(0,1), "section-overload": cells(1,2), "section-disabled": cells(3,4) });
  const ship = {
    design:[{type:"reactor"},{type:"auxGenerator"},{type:"shield"},{type:"switchgear"}], componentHp:[100,40,100,100],
    componentPower:{byComponentIndex:[
      {role:"source", networkId:"0", requestedMw:0, allocatedMw:0, operationalMultiplier:1, generationAvailableMw:10, generationUsedMw:8, generationReductionReasons:["curtailed-by-demand"]},
      {role:"source", networkId:"1", requestedMw:0, allocatedMw:0, operationalMultiplier:1, generationAvailableMw:0, generationUsedMw:0, generationReductionReasons:["thermal-penalty"]},
      {role:"consumer", networkId:"0", requestedMw:4, allocatedMw:4, operationalMultiplier:1},
      {role:"passive", networkId:"0", requestedMw:null, allocatedMw:null, operationalMultiplier:null}
    ]},
    powerFlow:{summary:{availableGenerationMw:10, usedGenerationMw:8, demandMw:4, allocatedMw:4, unmetMw:0, spareGenerationMw:6, aboveSustainedSections:1}},
    powerCableThermalAnalysis:analysis, powerCableHeatRate:analysis.summary.totalPowerCableHeatPerSecond, componentHeatGenerated:[0,0,0,0], componentHeatCooled:[0,0,0,0], lastHeatTickDelta:1,
    runtimeSwitchgear:[{componentIndex:3, mode:"open", state:"open", conducts:false, sideANetworkId:"0", sideBNetworkId:"1", sustainedCapacityMw:4, peakCapacityMw:7, signedTransferMw:0, utilisation:0, ratingTier:"light", classification:"bus-tie", decisionReason:"saved-mode-open"}], _powerProtection:{switchgear:new Map(), sections:new Map()}
  };
  const thermalSnap = JSON.parse(JSON.stringify(_test.buildRuntimePowerThermalSnapshot(ship)));
  const switchSnap = JSON.parse(JSON.stringify(_test.buildSwitchgearSnapshot(ship)));
  assert.strictEqual(thermalSnap.snapshotVersion, 2);
  for (const field of ["totalRatedGenerationMw","totalAvailableGenerationMw","totalDeliveredGenerationMw","requestedDemandMw","deliveredDemandMw","unmetDemandMw","sparePowerMw","powerCableHeatRate","powerCableOverloadHeatRate","aboveSustainedSectionCount"]) assert(field in thermalSnap, field);
  const gen = thermalSnap.components[0];
  for (const field of ["componentIndex","networkId","powerRole","requestedMw","allocatedMw","ratedGenerationMw","availableGenerationMw","deliveredGenerationMw","unusedGenerationMw","reductionReasons"]) assert(field in gen, field);
  const heat = thermalSnap.powerCableHeatBySectionId["power:section-overload"];
  assert(heat && heat.overloadHeatPerSecond > 0 && heat.totalHeatPerSecond > heat.baseHeatPerSecond);
  assert.strictEqual(switchSnap[0].presentationState, "open");
  assert.strictEqual(switchSnap[0].sideANetworkId, "0");
  assert.strictEqual(switchSnap[0].conducts, false);
});
console.log(`verify-power-review-regressions: ${n} behavioural checks passed`);
