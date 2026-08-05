"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
global.WiringRules = require("../public/src/shared/wiringRules");
global.PowerFlowRules = require("../public/src/shared/powerFlowRules");
global.ShieldRules = require("../public/src/shared/shieldRules");
global.HeatRules = require("../public/src/shared/heatRules");

const { createImmutableShipTemplate } = require("../src/server/shipTemplates");
const { spawnShip } = require("../src/server/ships");
const { computeStats } = require("../src/server/shipStats");
const { PARTS } = require("../src/server/components");
const { addComponentHeat, updateShipHeat } = require("../src/server/heat");
const { RoomSpatialIndex, shipBroadPhaseRadius } = require("../src/server/spatialIndex");
const { updateShipSeparation, resolveFleetMapCollisions } = require("../src/server/movement");
const { _test: snapshotDeliveryTest } = require("../src/server/snapshotDelivery");

function serverFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? serverFiles(full) : entry.name.endsWith(".js") ? [full] : [];
  });
}

for (const file of serverFiles(path.join(path.dirname(__dirname), "src", "server"))) {
  if (path.basename(file) === "heat.js") continue;
  const source = fs.readFileSync(file, "utf8");
  assert(!/componentHeatInput\s*\[[^\]]+\]\s*(?:\+=|=\s*[^=].*\+)/.test(source),
    `${path.relative(path.dirname(__dirname), file)} writes componentHeatInput directly; use addComponentHeat()`);
}

const design = [
  { type: "core", x: 7, y: 7, rotation: 0 },
  { type: "reactor", x: 8, y: 7, rotation: 0 },
  { type: "radiator", x: 6, y: 7, rotation: 0 }
];
const wiring = global.WiringRules.emptyWiring();
const template = createImmutableShipTemplate(design, wiring, computeStats(design, wiring));
const player = { id: "p", team: "blue", ships: [], shipCap: 5, design, wiring, stats: template.stats };
const room = {
  nextEntityId: 1,
  world: { width: 2000, height: 1200 },
  map: { asteroids: [], safeZones: [] },
  players: new Map([["p", player]]),
  ships: new Map(),
  effects: []
};
const first = spawnShip(room, player, 0, 0, { template });
const second = spawnShip(room, player, 0, 1, { template });
assert.strictEqual(first._heatScratch, undefined, "canonical Heat runtime does not allocate a compatibility scratch object");
assert.strictEqual(second._heatScratch, undefined, "canonical Heat runtime does not allocate a compatibility scratch object");
assert.notStrictEqual(first._thermalRuntime, second._thermalRuntime);
assert.notStrictEqual(first._thermalRuntime.delta, second._thermalRuntime.delta);
addComponentHeat(first, 0, 40);
assert.equal(first.hasPendingHeatInput, true);
const heatRevisionBefore = first.heatRevision;
const componentHeatRevisionBefore = first.componentHeatRevision;
const telemetryRevisionBefore = first.heatTelemetryRevision;
updateShipHeat(first, 0.2, room, 200);
assert(first.currentHeat > 0);
assert(first.heatRevision > heatRevisionBefore);
assert(first.componentHeatRevision > componentHeatRevisionBefore);
assert(first.heatTelemetryRevision > telemetryRevisionBefore);
assert.equal(second.currentHeat, 0);
assert(second.componentHeat.every((value) => value === 0));

const spatialRoom = {
  world: { width: 1200, height: 800 },
  map: { asteroids: [] },
  spatialIndex: new RoomSpatialIndex(100)
};
const a = { id: "a", ownerId: "a", alive: true, x: 99, y: 300, vx: 0, vy: 0, radius: 30, physicalRadius: 30, design: [], stats: { mass: 100 } };
const b = { id: "b", ownerId: "b", alive: true, x: 105, y: 300, vx: 0, vy: 0, radius: 30, physicalRadius: 30, design: [], stats: { mass: 100 } };
spatialRoom.spatialIndex.rebuildKind("ships", [a, b], shipBroadPhaseRadius, 0);
updateShipSeparation(spatialRoom, [a, b], 0.05, 50);
resolveFleetMapCollisions(spatialRoom, [a, b]);
spatialRoom.spatialIndex.rebuildKind("ships", [a, b], shipBroadPhaseRadius, 50);
for (const ship of [a, b]) {
  const seen = spatialRoom.spatialIndex.queryRange("ships", ship.x, ship.y, 1);
  assert(seen.includes(ship), `final spatial index missed corrected ship ${ship.id}`);
}

const simulation = fs.readFileSync("src/server/simulation.js", "utf8");
const separationAt = simulation.lastIndexOf("updateShipSeparation(");
const safetyCallAt = simulation.lastIndexOf("runMovementContactSafetyPass(");
const finalRefresh = fs.readFileSync("src/server/movementContactSafety.js", "utf8");
const finalRefreshAt = finalRefresh.indexOf('updateLiveEntities("ships"');
const proximityAt = simulation.indexOf("updateProximityCharges", separationAt);
assert(separationAt >= 0 && safetyCallAt > separationAt && proximityAt > safetyCallAt && finalRefreshAt >= 0,
  "final ship-index refresh must follow correction and precede proximity/support/weapons");

const focusedShip = { id: "focus", heatTelemetryRevision: 4 };
const focusClient = {
  telemetryFocusShipId: focusedShip.id,
  telemetryLastWrittenFocusId: focusedShip.id,
  telemetryLastWrittenAt: 1000,
  knownShipHeatTelemetryRevisions: new Map([[focusedShip.id, 3]]),
  room: { ships: new Map([[focusedShip.id, focusedShip]]) }
};
assert.equal(snapshotDeliveryTest.telemetryFocusForPayload(focusClient, 1001, false), focusedShip.id,
  "changed Heat telemetry bypasses the ordinary focus refresh interval");
focusClient.knownShipHeatTelemetryRevisions.set(focusedShip.id, 4);
assert.equal(snapshotDeliveryTest.telemetryFocusForPayload(focusClient, 1001, false), null,
  "unchanged Heat telemetry remains rate-limited");

console.log("Hot-path Heat ownership, wake-up and final-spatial-refresh verification passed.");
