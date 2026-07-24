#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { BALANCE } = require("./src/server/balanceConfig");
const { PARTS } = require("./src/server/components");
const { validateDesign, normalizeShipDesignSnapshot } = require("./src/server/shipDesign");
const DroneBayRules = require("./public/src/shared/droneBayRules");

const baseDesign = (droneType = "fighter") => [
  { x: 7, y: 7, type: "core", rotation: 0 },
  { x: 7, y: 8, type: "engine", rotation: 0 },
  { x: 5, y: 6, type: "droneBay", rotation: 0, droneType }
];

assert.deepEqual(PARTS.droneBay.footprint, { width: 2, height: 2 }, "Drone Bay occupies four cells");
assert.equal(PARTS.droneBay.rotatable, false, "Drone Bay is non-rotatable");
assert.equal(PARTS.droneBay.cost, 150);
assert.equal(PARTS.droneBay.mass, 32);
assert.equal(PARTS.droneBay.powerUse, BALANCE.drones.activePowerMw, "component and runtime active Power share balance authority");
assert.deepEqual(PARTS.droneBay.droneConfig, BALANCE.drones, "runtime component metadata mirrors the authoritative drone block");
assert.equal(BALANCE.drones.squadSize, 3);
assert.equal(BALANCE.drones.maxBaysPerShip, 4);
assert.ok(BALANCE.drones.types.fighter.evasionLookaheadSeconds > 0);
assert.ok(BALANCE.drones.types.fighter.evasionClearance > 0);
assert.ok(BALANCE.drones.types.fighter.evasionStrength > 0);
assert.deepEqual(DroneBayRules.DRONE_TYPES, ["fighter", "defence", "repair"]);

for (const type of DroneBayRules.DRONE_TYPES) {
  const result = validateDesign(baseDesign(type));
  assert.equal(result.ok, true, `${type} configuration validates: ${result.reason || ""}`);
  assert.equal(result.stats.droneCapacity, 3, `${type} contributes three drone slots to the ship summary`);
  assert.equal(result.stats.dronesByType[type], 3, `${type} contributes three configured drones`);
  const restored = normalizeShipDesignSnapshot(JSON.parse(JSON.stringify(result.modules)));
  const bay = restored.find((part) => part.type === "droneBay");
  assert.equal(bay.droneType, type, `${type} survives save/load normalization`);
  assert.equal(bay.rotation, 0, `${type} remains fixed at zero rotation`);
}

const missingType = validateDesign(baseDesign(null));
assert.equal(missingType.ok, false);
assert.equal(missingType.issue.code, "drone-bay-unconfigured");

const catalogue = { droneBay: { footprint: { width: 2, height: 2 } }, frame: { footprint: { width: 1, height: 1 } } };
const enclosed = [
  { x: 5, y: 5, type: "droneBay", droneType: "fighter" },
  { x: 5, y: 4, type: "frame" }, { x: 6, y: 4, type: "frame" },
  { x: 7, y: 5, type: "frame" }, { x: 7, y: 6, type: "frame" },
  { x: 5, y: 7, type: "frame" }, { x: 6, y: 7, type: "frame" },
  { x: 4, y: 5, type: "frame" }, { x: 4, y: 6, type: "frame" }
];
const blocked = DroneBayRules.validateDroneBays(enclosed, catalogue);
assert.equal(blocked.ok, false);
assert.equal(blocked.errors.find((error) => error.code === "drone-bay-blocked")?.message, "Drone Bay requires an exposed two-cell launch edge.");

const ordered = baseDesign("defence");
const reordered = [ordered[2], ordered[0], ordered[1]];
const first = DroneBayRules.validateDroneBays(ordered, PARTS).bays[0];
const second = DroneBayRules.validateDroneBays(reordered, PARTS).bays[0];
assert.equal(first.componentId, second.componentId, "bay ID is stable when component order changes");
assert.equal(first.launchEdge.side, second.launchEdge.side, "launch side is stable when component order changes");
assert.deepEqual(
  { x: first.launchEdge.centerX, y: first.launchEdge.centerY },
  { x: second.launchEdge.centerX, y: second.launchEdge.centerY },
  "launch pose is stable when component order changes"
);

const oldBlueprint = validateDesign([
  { x: 7, y: 7, type: "core", rotation: 0 },
  { x: 7, y: 8, type: "engine", rotation: 0 }
]);
assert.equal(oldBlueprint.ok, true, "existing Blueprints without Drone Bays remain valid");

console.log("Drone Bay component and Blueprint verification passed");
