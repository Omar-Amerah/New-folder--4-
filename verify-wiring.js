#!/usr/bin/env node
"use strict";
const assert = require("assert");
const W = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");
const { DEFAULT_WIRING } = require("./src/server/config");
const ship = [
  { x: 5, y: 5, type: "reactor" }, { x: 6, y: 5, type: "frame" }, { x: 7, y: 5, type: "armor" }, { x: 8, y: 5, type: "shield" },
  { x: 5, y: 6, type: "fireControl" }, { x: 6, y: 6, type: "beamEmitter" }, { x: 7, y: 6, type: "frame" }, { x: 8, y: 6, type: "railgun" },
  { x: 5, y: 7, type: "sensorArray" }
];
let wiring = W.emptyWiring();
wiring = W.addConnection(wiring, "power", 0, 3, [{x:5,y:5},{x:6,y:5},{x:7,y:5},{x:8,y:5}], ship, PARTS);
wiring = W.addConnection(wiring, "data", 4, 7, [{x:5,y:6},{x:6,y:6},{x:7,y:6},{x:8,y:6}], ship, PARTS);
wiring = W.addConnection(wiring, "data", 8, 7, [{x:5,y:7},{x:5,y:6},{x:6,y:6},{x:7,y:6},{x:8,y:6}], ship, PARTS);
assert.equal(W.WIRING_VERSION, 3);
assert.ok(wiring.power.sections.every(section => section.tier === "standard"), "new sections use standard tier");
assert.equal(wiring.data.sections.length, 4, "shared physical sections are canonical and deduplicated");
assert.equal(wiring.data.connections.length, 2, "logical routes independently reference shared sections");
const shared = wiring.data.sections.find(section => section.id === "6,6:7,6");
assert.ok(shared && wiring.data.connections.every(connection => connection.sectionIds.includes(shared.id)), "both routes reference one shared section");
const dirty = W.cloneWiring(wiring); dirty.data.sections.find(section => section.id === shared.id).tier = "heavy";
const normalized = W.normalizeWiring(dirty, ship, PARTS).wiring;
assert.equal(normalized.data.sections.find(section => section.id === shared.id).tier, "standard", "unknown tiers normalize to standard");
const analysis = W.analyzeWiring(ship, normalized, PARTS);
assert.deepEqual(analysis.power.networks[0].componentIndices.sort((a,b)=>a-b), [0,3], "transit components are not terminals");
assert.deepEqual(analysis.data.supports.find(s=>s.index===4).connectedWeaponIndices, [5,7], "Data connects every compatible target touched by its physical network");
assert.deepEqual(analysis.data.weapons.find(w=>w.index===5).supportIndices, [4,8], "crossed weapon automatically joins all sources in the network");
assert.equal(W.isCompatibleWeapon("fireControl", "beamEmitter", PARTS), true, "Fire Control supports beams");
const firstKey = W.connectionKey(normalized.data.connections[0]);
const removed = W.removeConnection(normalized, "data", firstKey, ship, PARTS);
assert.equal(removed.data.connections.length, 1, "one logical connection removed");
assert.ok(removed.data.sections.some(section => section.id === shared.id), "shared section remains while referenced");
assert.deepEqual(W.normalizeWiring({version:1,power:[],data:[]}, ship, PARTS).wiring, W.emptyWiring(), "v1 wiring is cleared");
assert.ok(DEFAULT_WIRING.power.sections.length > 0, "default wiring has physical Power sections");
assert.deepEqual(DEFAULT_WIRING.data, W.emptyWiring().data, "default wiring keeps Data empty");

const physicalDesign = [
  { x: 1, y: 1, type: "reactor" }, { x: 2, y: 1, type: "frame" }, { x: 3, y: 1, type: "shield" },
  { x: 2, y: 2, type: "armor" }, { x: 2, y: 3, type: "engine" }
];
let physical = W.emptyWiring();
physical = W.addPath(physical, "power", [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }], physicalDesign, PARTS);
physical = W.addPath(physical, "power", [{ x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }], physicalDesign, PARTS);
assert.equal(W.countUniqueSections(physical, "power"), 4, "shared trunk sections count exactly once");
assert.equal(W.additionalLengthForPath(physical, "power", [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }]), 0, "reused trunk preview has no additional length");
const physicalAnalysis = W.analyzeWiring(physicalDesign, physical, PARTS);
assert.deepEqual(physicalAnalysis.power.networks[0].consumerIndices, [2, 4], "branch consumers join one physical network while passive hosts add no demand");
const split = W.removeSection(physical, "power", "1,1:2,1", physicalDesign, PARTS);
assert.equal(W.analyzeWiring(physicalDesign, split, PARTS).power.networks.length, 1, "removing a leaf preserves the shared downstream network");
assert.equal(physical.power.connections.length, 0, "new physical branches require no logical route records");

const graph = W.buildSectionGraph(physical.power);
assert.deepEqual(W.nearestSectionEndpoint(physical.power.sections[0], { x: 1.55, y: 1.5 }), { x: 1, y: 1 }, "nearest endpoint chooses the canonical start near A");
assert.deepEqual(W.nearestSectionEndpoint(physical.power.sections[0], { x: 2.45, y: 1.5 }), { x: 2, y: 1 }, "nearest endpoint chooses the canonical end near B");
assert.equal(graph.nodes.get("2,1").sectionIds.length, 3, "section graph derives a T-junction from physical endpoints");
assert.deepEqual(W.junctionCells(physical.power).map(({x,y,degree}) => ({x,y,degree})), [{ x: 2, y: 1, degree: 3 }], "T-junction has one physical marker");
assert.deepEqual(W.sectionEndpointDegrees(physical.power).get("2,1:2,2"), [3, 2], "endpoint degrees are physical and ordered canonically");
const leafBranch = W.findLeafBranchSections(physical.power, "2,1:2,2");
assert.deepEqual(leafBranch.sectionIds, ["2,1:2,2", "2,2:2,3"], "leaf branch stops at its nearest junction");
const branchRemoved = W.removeBranch(physical, "power", "2,1:2,2", null, physicalDesign, PARTS);
assert.deepEqual(branchRemoved.removedSectionIds, ["2,1:2,2", "2,2:2,3"]);
assert.deepEqual(branchRemoved.wiring.power.sections.map((section) => section.id), ["1,1:2,1", "2,1:3,1"], "branch removal preserves the trunk");

const orderedAgain = W.cloneWiring(physical); orderedAgain.power.sections.reverse();
assert.deepEqual([...W.sectionEndpointDegrees(orderedAgain.power)], [...W.sectionEndpointDegrees(physical.power)], "topology helpers ignore insertion order");
const withoutLegacy = W.cloneWiring(normalized); withoutLegacy.power.connections = []; withoutLegacy.data.connections = [];
const withLegacyAnalysis = W.analyzeWiring(ship, normalized, PARTS); const withoutLegacyAnalysis = W.analyzeWiring(ship, withoutLegacy, PARTS);
const physicalSummary = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === "connections" || key === "routes" ? undefined : item));
assert.deepEqual(physicalSummary(withoutLegacyAnalysis.power.networks), physicalSummary(withLegacyAnalysis.power.networks), "Power analysis does not require legacy metadata");
assert.deepEqual(physicalSummary(withoutLegacyAnalysis.data.networks), physicalSummary(withLegacyAnalysis.data.networks), "Data analysis does not require legacy metadata");

const loopDesign = [{x:1,y:1,type:"frame"},{x:2,y:1,type:"frame"},{x:2,y:2,type:"frame"},{x:1,y:2,type:"frame"}];
let loop = W.emptyWiring(); loop = W.addPath(loop, "power", [{x:1,y:1},{x:2,y:1},{x:2,y:2},{x:1,y:2},{x:1,y:1}], loopDesign, PARTS);
assert.equal(W.findLeafBranchSections(loop.power, "1,1:2,1").reason, "not-leaf-branch", "closed loops are never guessed destructively");
assert.deepEqual(W.findLeafBranchSections(loop.power, "1,1:2,1").sectionIds, ["1,1:2,1"], "ambiguous removal falls back to the selected section");
// Intra-component (internal) cable rejection. A component's compatible terminals
// are already connected inside it, so a cable drawn between two cells of the same
// component instance is refused instead of adding a meaningless route. A route
// that also reaches another component is a real connection and keeps every
// segment (an internal transit leg stays load-bearing for connectivity).
const internalShip = [{ x: 5, y: 5, type: "reactor" }, { x: 7, y: 5, type: "shield" }]; // reactor occupies (5,5)&(6,5)
const selfCable = W.applyPathWithTier(W.emptyWiring(), "power", [{ x: 5, y: 5 }, { x: 6, y: 5 }], internalShip, PARTS, "standard");
assert.equal(selfCable.changed, false, "a cable between one component's own terminals is rejected");
assert.equal(selfCable.reason, "internal-terminal", "rejection identifies the internal-terminal case");
assert.equal(selfCable.wiring.power.sections.length, 0, "no meaningless internal section is stored");
const realCable = W.applyPathWithTier(W.emptyWiring(), "power", [{ x: 6, y: 5 }, { x: 7, y: 5 }], internalShip, PARTS, "standard");
assert.equal(realCable.changed, true, "a cable from a terminal to another component is accepted");
assert.equal(realCable.wiring.power.sections.length, 1, "the external section is stored");
const throughCable = W.applyPathWithTier(W.emptyWiring(), "power", [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }], internalShip, PARTS, "standard");
assert.equal(throughCable.changed, true, "a route crossing a component to reach another is accepted");
assert.equal(throughCable.wiring.power.sections.length, 2, "an internal transit segment is retained for connectivity");

console.log("Wiring v2 physical-section verification passed");
