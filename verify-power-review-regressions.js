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
  const result = thermal([flow("section-1", 1), flow("section-2", 6), flow("section-3", 0)], { "section-1": cells(0,1), "section-2": cells(1,2), "section-3": cells(1,3), "section-4": cells(8,9) });
  assert.strictEqual(result.sections.length, 3, "disabled/broken omitted from active thermal sections");
  const by = new Map(result.sections.map(s=>[s.sectionId,s]));
  assert(by.get("section-1").baseHeatPerSecond > 0 && by.get("section-1").overloadHeatPerSecond === 0, "normal section has base heat only");
  assert(by.get("section-2").baseHeatPerSecond > 0 && by.get("section-2").overloadHeatPerSecond > 0, "overload section has additional overload heat");
  for (const s of result.sections) close(s.baseHeatPerSecond + s.overloadHeatPerSecond, s.totalHeatPerSecond, `base+overload ${s.sectionId}`);
  close(result.summary.totalPowerCableHeatPerSecond, result.sections.reduce((sum,s)=>sum+s.totalHeatPerSecond,0), "section sum matches summary");
  assert(result.components.find(c=>c.componentIndex===1).hostedActiveSectionIds.includes("section-1"));
  assert(result.components.find(c=>c.componentIndex===1).hostedActiveSectionIds.includes("section-2"));
});
check("Power and Data sections with similar raw IDs do not collide in Power Heat", () => {
  const result = thermal([flow("section-12", 2)], { "section-12": cells(0,1), "data:section-12": cells(2,3) });
  assert.deepStrictEqual(result.sections.map(s=>s.sectionId), ["section-12"]);
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
  close(Object.values(snap.powerCableHeatBySectionId).reduce((sum,h)=>sum+h.totalHeatMw,0), snap.powerCableHeatRate, "snapshot Heat total");
  for (const heat of Object.values(snap.powerCableHeatBySectionId)) close(heat.baseHeatMw + heat.overloadHeatMw, heat.totalHeatMw, "snapshot breakdown");
});
console.log(`verify-power-review-regressions: ${n} behavioural checks passed`);
