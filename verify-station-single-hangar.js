"use strict";

// Guard the selective rollback. Ship drone bays and component hangars live in
// unrelated systems, so this scan is limited to home-station production paths.

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
  ["plural station field", /station\.hangars\b|\bhangars\b/gi],
  ["multi-bay count", /\bHANGAR_BAY_COUNT\b|\bHANGAR_BAY_CELLS\b/],
  ["bay assignment order", /\bBAY_ASSIGNMENT_ORDER\b/],
  ["player bay resolver", /\bhangarBayForPlayer\b/],
  ["client bay renderer", /\bstationHangarBaysLocal\b|\bstationBaySignature\b|\bbayWallGap\b/],
  ["station launch bay index", /\bbayIndex\b/],
  ["multi-bay player comment", /one bay per (?:player|team member)|three station bays/i],
  ["old home frontage", /(?:home[- ]station|station)\D{0,40}840\s*(?:world )?units|840\s*(?:world )?units\D{0,40}(?:home[- ]station|station)/i]
];

function run() {
  console.log("verify-station-single-hangar");
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
  assert(!/moduleScale\)\s*\|\|\s*56\b/.test(renderer), "home renderer has no scale-56 fallback");
  assert(!/Number\(station\.moduleScale\)\s*\|\|\s*56\b/.test(renderer), "station renderer never falls back to scale 56");
  assert.deepStrictEqual(failures, [], `multi-hangar station remnants found: ${failures.join(", ")}`);
  console.log("  no multi-hangar station symbols found in production paths");
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
