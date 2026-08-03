"use strict";
const assert = require("assert");
const { initShipHeat, rebuildThermalNetworks, isThermalRouteType } = require("./src/server/heat");
const { repairShipComponents } = require("./src/server/componentHealth");
const { PARTS } = require("./src/server/components");
const { getOccupiedCells } = require("./src/server/footprint");
const { buildThermalTopology, createComponentAdjacency } = require("./src/server/thermalTopology");
function shipFor(design){ const hp=design.map(m=>PARTS[m.type]?.hp||40); const ship={alive:true,design,componentHp:hp.slice(),componentMaxHp:hp.slice(),stats:{powerUse:0,powerGeneration:1},dirtyComponents:new Set()}; initShipHeat(ship); return ship; }
function edges(s,a,b){ return createComponentAdjacency(s.thermalTopology)[a].find(e=>e.index===b)?.sharedEdges||0; }
function exposed(s,i){ return s.componentThermals[i].exposedEdges; }
for (const rot of [0,90,180,270]) {
  let s=shipFor([{x:0,y:0,type:"frame",rotation:rot}]); assert.strictEqual(exposed(s,0),4,`1x1 exposure rotation ${rot}`);
  s=shipFor([{x:0,y:0,type:"repairBeam",rotation:rot},{x:0,y:1,type:"repairBeam",rotation:rot}]); if(rot===0||rot===180) assert.strictEqual(edges(s,0,1),2,`2x1 multi-edge rot ${rot}`);
  s=shipFor([{x:0,y:0,type:"engine",rotation:rot},{x:1,y:0,type:"engine",rotation:rot}]); if(rot===0||rot===180) assert.strictEqual(edges(s,0,1),2,`1x2 multi-edge rot ${rot}`);
  const cells = getOccupiedCells(0,0,PARTS.aegisProjector.footprint,rot);
  const rightmost = cells.reduce((best, cell) => cell.x > best.x ? cell : best, cells[0]);
  s=shipFor([{x:0,y:0,type:"aegisProjector",rotation:rot},{x:rightmost.x+1,y:rightmost.y,type:"frame"}]); assert.strictEqual(edges(s,0,1),1,`2x2 single-edge rot ${rot}`);
}
let diag=shipFor([{x:0,y:0,type:"frame"},{x:1,y:1,type:"frame"}]); assert.strictEqual(edges(diag,0,1),0,"diagonal contact must not conduct");
const ring = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]].map(([x,y])=>({x,y,type:"frame"}));
let sealed=shipFor(ring); assert.strictEqual(sealed.componentThermals.reduce((n,t)=>n+t.exposedEdges,0),12,"sealed cavity should not add exposed edges");
let opened=shipFor(ring.filter(m => !(m.x === 0 && m.y === -1))); assert.strictEqual(opened.componentThermals.reduce((n,t)=>n+t.exposedEdges,0),16,"opened cavity should expose inward edges");
let irregular=shipFor([{x:0,y:0,type:"repairBeam"},{x:2,y:0,type:"engine"},{x:2,y:2,type:"aegisProjector"},{x:1,y:3,type:"frame"},{x:0,y:2,type:"heatSink"}]); const irregularAdjacency=createComponentAdjacency(irregular.thermalTopology); assert(irregularAdjacency.every((list,i)=>list.every(e=>edges(irregular,e.index,i)===e.sharedEdges)),"debug adjacency must be symmetric by immutable design index");
const orderTopology = buildThermalTopology(irregular.design);
const orderAdjacency = createComponentAdjacency(orderTopology);
const expectedTransferOrder = [];
for (let i = 0; i < orderAdjacency.length; i += 1) {
  for (const edge of orderAdjacency[i]) if (edge.index > i) expectedTransferOrder.push(edge.edgeId);
}
assert.deepStrictEqual(orderTopology.transferOrder, expectedTransferOrder, "canonical transfer order reproduces deterministic topology traversal");
assert.strictEqual(new Set(orderTopology.transferOrder).size, orderTopology.edgeA.length, "canonical transfer order visits each physical edge exactly once");
for (let rank = 0; rank < orderTopology.transferOrder.length; rank += 1) assert.strictEqual(orderTopology.transferRank[orderTopology.transferOrder[rank]], rank, "canonical transfer ranks are deterministic");
for (let edgeId = 1; edgeId < orderTopology.edgeA.length; edgeId += 1) {
  const previous = edgeId - 1;
  assert(orderTopology.edgeA[previous] < orderTopology.edgeA[edgeId]
    || (orderTopology.edgeA[previous] === orderTopology.edgeA[edgeId] && orderTopology.edgeB[previous] <= orderTopology.edgeB[edgeId]), "physical edges are canonical sorted");
}
assert(isThermalRouteType("frame")&&isThermalRouteType("lightFrame")&&isThermalRouteType("heavyFrame")&&isThermalRouteType("heatPipe")&&!isThermalRouteType("armor"),"thermal route helper recognition");
let route=shipFor([{x:0,y:0,type:"blaster"},{x:1,y:0,type:"heatPipe"},{x:2,y:0,type:"radiator"}]); const builds=route.thermalNetworkBuilds; route.componentHp[0]-=1; assert.strictEqual(route.thermalNetworkBuilds,builds,"ordinary component damage does not rebuild networks unnecessarily"); route.componentHp[1]=0; rebuildThermalNetworks(route); assert.strictEqual(route.thermalNetworks.length,0,"destroyed heat pipe breaks route"); repairShipComponents(null,route,route.componentMaxHp[1],0); assert.strictEqual(route.thermalNetworks.length,1,"repaired heat pipe rebuilds route"); assert(Number.isFinite(route.frameCoolingDistance[1]),"cooling distance updates after repair");
let split=shipFor([{x:0,y:0,type:"frame"},{x:2,y:0,type:"frame"},{x:0,y:1,type:"radiator"},{x:2,y:1,type:"radiator"}]); assert.strictEqual(split.thermalNetworks.length,2,"disconnected networks remain separate");
console.log("Thermal topology verification passed");
