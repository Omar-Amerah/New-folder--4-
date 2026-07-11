"use strict";
const assert = require("assert");
const EngineExhaust = require("./public/src/shared/engineExhaust.js");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, updateEngineExhaustState } = require("./src/server/componentHealth");

const recessed = [{x:7,y:7,type:"engine"},{x:6,y:7,type:"frame"},{x:8,y:7,type:"frame"}];
let analysis = EngineExhaust.analyze(recessed, PARTS);
assert(analysis.validEngineIndices.has(0), "recessed engine with clear channel was rejected");
assert.deepStrictEqual(analysis.engines.get(0).exhaust, {x:0,y:1});
assert.deepStrictEqual(analysis.engines.get(0).thrust, {x:0,y:-1});

const blocked = [...recessed,{x:7,y:11,type:"armor"}];
analysis = EngineExhaust.analyze(blocked, PARTS);
assert(analysis.blockedEngineIndices.has(0), "component down exhaust channel did not block engine");
assert(analysis.engines.get(0).blockedCells.some(cell => cell.index === 3), "exact blocker was not reported");
assert.strictEqual(computeStats(blocked).thrust, 0, "blocked engine silently contributed thrust");
assert(computeStats(blocked).blockedEngines === 1, "blocked engine count missing from stats");

const rotated = [{x:7,y:7,type:"engine",rotation:90},{x:4,y:7,type:"frame"}];
analysis = EngineExhaust.analyze(rotated, PARTS);
assert(analysis.blockedEngineIndices.has(0), "rotated exhaust direction was not checked");
assert.deepStrictEqual(analysis.engines.get(0).exhaust, {x:-1,y:0});

const customParts = {...PARTS,bigEngine:{thrust:300,footprint:{width:2,height:2}}};
analysis = EngineExhaust.analyze([{x:7,y:7,type:"bigEngine"},{x:8,y:11,type:"frame"}],customParts);
assert.strictEqual(analysis.engines.get(0).nozzleCells.length,2,"large engine did not receive a full-width exhaust channel");
assert(analysis.blockedEngineIndices.has(0),"one blocked lane did not invalidate large engine");

// Destroyed wrecks are treated as removed and restoration blocks the route again.
const runtime = {design:blocked,stats:{...computeStats(blocked)}};
initComponentState(runtime);
assert(runtime.blockedEngineIndices.has(0));
runtime.componentHp[3]=0;
updateEngineExhaustState(runtime);
assert(runtime.validEngineIndices.has(0),"destroyed blocker did not expose exhaust route");
runtime.componentHp[3]=runtime.componentMaxHp[3];
updateEngineExhaustState(runtime);
assert(runtime.blockedEngineIndices.has(0),"restored blocker did not invalidate exhaust route");

console.log("Engine exhaust verification passed");
