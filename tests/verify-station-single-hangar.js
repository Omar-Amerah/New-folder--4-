"use strict";

// Guard the selective three-corridor restoration. Ship drone bays and component
// hangars live in unrelated systems, so this scan is limited to home-station
// production paths.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const files = [
  "src/server/stationTemplates.js",
  "src/server/stations.js",
  "src/server/snapshots.js",
  "src/server/visibilitySnapshots.js",
  "src/server/spawnPlanner.js",
  "src/server/stationCollision.js",
  "src/server/projectiles.js",
  "src/server/movementCollision.js",
  "src/server/spatialIndex.js",
  "src/server/snapshotEntityDelta.js",
  "public/src/game/pixi/pixiStations.js",
  "public/src/snapshotMerge.js",
  "public/src/snapshotPresentation.js",
  "public/src/shared/snapshotEntityDelta.js",
  "benchmark-phase-6f.js"
];

const forbidden = [
  ["singular station field", /station\.hangar\b/],
  ["single-bay client renderer", /\bstationHangarLocal\b|\bstationBaySignature\b/],
  ["plural launch-bay compatibility field", /station\.launchBays\b|geometry\.launchBays\b|\bLAUNCH_BAY_/],
  ["old compact home scale", /(?:home[- ]station|station)[^\n]{0,80}(?:36|540)/i],
  ["disabled station state", /state\s*(?:===|!==|=)\s*["']disabled["']|station-disabled/]
];

function run() {
  console.log("verify-station-three-hangar");
  const failures = [];
  for (const relative of files) {
    const filename = path.join(root, relative);
    const source = fs.readFileSync(filename, "utf8");
    for (const [label, pattern] of forbidden) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) failures.push(`${relative}: ${label}`);
    }
  }

  const renderer = fs.readFileSync(path.join(root, "public/src/game/pixi/pixiStations.js"), "utf8");
  assert(renderer.includes("station.stationType === \"home\" ? 56"), "home renderer fallback is the historical scale 56");
  const templates = require("./src/server/stationTemplates");
  const geometry = templates.buildHomeStationGeometry();
  assert.strictEqual(templates.STATION_MODULE_SCALE, 56, "home template scale is 56");
  assert.strictEqual(geometry.shell.maxX - geometry.shell.minX, 840, "home shell is 840 units wide");
  assert.strictEqual(geometry.hangars.length, 3, "home template has three hangars");
  assert.deepStrictEqual(failures, [], `invalid single-hangar remnants found: ${failures.join(", ")}`);
  console.log("  three-hangar station symbols and geometry are present in production paths");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
