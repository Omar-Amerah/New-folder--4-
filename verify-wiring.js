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
assert.equal(W.WIRING_VERSION, 2);
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
assert.deepEqual(DEFAULT_WIRING, W.emptyWiring(), "default wiring starts empty");

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
console.log("Wiring v2 physical-section verification passed");
