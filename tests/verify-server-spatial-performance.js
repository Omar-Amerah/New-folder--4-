#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { runServerSpatialPerformanceBenchmark } = require("./support/serverSpatialPerformance");

const ARTIFACT = path.join("test-artifacts", "performance", "server-spatial-performance.json");


const { fixture, baseline, optimized, reductions } = runServerSpatialPerformanceBenchmark();
const report = { fixture, baseline, optimized, reductions };

assert.ok(optimized.droneMs.p50 < baseline.droneMs.p50 * 0.85,
  `drone decision CPU should materially improve: ${JSON.stringify(report)}`);
assert.ok(optimized.projectileMs.p50 < baseline.projectileMs.p50 * 0.7,
  `projectile broad-phase CPU should materially improve: ${JSON.stringify(report)}`);
assert.ok(optimized.totalMs.p95 < baseline.totalMs.p95,
  `high-load p95 should improve after including index construction: ${JSON.stringify(report)}`);
assert.ok(optimized.overruns <= baseline.overruns,
  `tick overruns must not increase: ${JSON.stringify(report)}`);

fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
fs.writeFileSync(ARTIFACT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Server spatial performance verification passed: ${ARTIFACT}`);
