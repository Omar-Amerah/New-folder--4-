"use strict";
// Minimal grouped test runner: executes verify-*.js scripts for named groups
// sequentially, deduplicates requested scripts in first-seen order, records
// durations, and exits non-zero if any child failed.
//
// Usage: node tools/run-tests.js <group> [group...]
// Groups: unit, integration, protocol, smoke, browser, server-soak, soak,
// renderer-soak, all-non-browser, all
//
// Runtime taxonomy:
//   - integration and server-soak are browser-free and must pass without
//     Playwright browser binaries installed.
//   - browser and renderer-soak launch real Chromium/WebGL/Pixi and fail
//     strictly if Chromium or WebGL is unavailable.
//   - all is the complete umbrella and therefore requires Chromium.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function unique(items) {
  const out = [];
  for (const item of items) if (!out.includes(item)) out.push(item);
  return out;
}

const GROUPS = {
  // Fast deterministic module/static tests: no server process, no sockets, no browser.
  unit: [
    "verify-module-boundaries.js",
    "verify-module-imports.js",
    "verify-blueprint-storage.js",
    "verify-snapshot-merge.js",
    "verify-blueprint-parity.js",
    "verify-spawn-planner.js",
    "verify-component-indexes.js",
    "verify-movement.js",
    "verify-targeting.js",
    "verify-turrets.js",
    "verify-heat.js",
    "verify-thermal-topology.js",
    "verify-heat-transfer.js",
    "verify-heat-cooling.js",
    "verify-heat-thermo.js",
    "verify-heat-effects.js",
    "verify-power.js",
    "verify-component-health.js",
    "verify-meltdown.js",
    "verify-core-reactor.js",
    "verify-combat-review.js",
    "verify-combat-determinism.js",
    "verify-combat-catchup.js",
    "verify-repair-target.js",
    "verify-engine-exhaust.js",
    "verify-maps-objectives.js",
    "verify-camera-transforms.js",
    "verify-render-interpolation.js",
    "verify-renderer-pools.js",
    "verify-renderer-culling.js",
    "verify-renderer-textures.js",
    "verify-renderer-quality.js",
    "verify-selection.js",
    "verify-client-selection.js",
    "verify-economy.js",
    "verify-economy-sequence.js",
    "verify-bots.js",
    "verify-shared-parity.js",
    "verify-canvas-removal.js",
    "verify-components.js",
    "verify-component-catalogue.js"
  ],

  // Browser-free module/room/input lifecycle integration. These may use fake
  // sockets or DOM/event doubles, but never Playwright/Chromium/WebGL.
  integration: [
    "verify-reconnect.js",
    "verify-lobby-refresh-reconnect.js",
    "verify-connection-errors.js",
    "verify-lifecycle.js",
    "verify-input-lifecycle.js",
    "verify-renderer-structural-updates.js"
  ],

  // Real server.js process + real WebSockets + MessagePack snapshots.
  protocol: [
    "verify-runtime.js",
    "verify-heat-protocol.js",
    "verify-websocket-frames.js",
    "verify-protocol-schema.js",
    "verify-network-connections.js",
    "verify-network-protocol.js",
    "verify-websocket-handler-errors.js"
  ],

  // Production-path smoke: real server process and HTTP asset checks only.
  smoke: [
    "verify-production-path.js",
    "verify-deployment-health.js"
  ],

  // Required browser gameplay/renderer coverage: real server, production
  // frontend, Playwright Chromium, WebGL and Pixi. Missing Chromium is a hard failure.
  browser: [
    "verify-live-turrets.js",
    "verify-heat-browser.js",
    "verify-renderer-input-browser.js",
    "verify-browser-websocket-payloads.js",
    "verify-browser-sequential-rooms.js",
    "verify-pixi-lifecycle.js",
    "verify-renderer-performance-browser.js",
    "verify-webgl-context-browser.js"
  ],

  // Deterministic server/simulation soaks only. This group is browser-free.
  "server-soak": [
    "verify-soak.js",
    "verify-heat-soak.js",
    "verify-resync-reason-contract.js",
    "verify-snapshot-coalescing.js",
    "verify-snapshot-contract.js",
    "verify-snapshot-resync.js",
    "verify-network-backpressure.js",
    "verify-network-soak.js"
  ],

  // Dedicated long renderer soak: real Chromium, real WebGL, real Pixi,
  // production frontend. CI installs Chromium only in the renderer-soak job.
  "renderer-soak": [
    "verify-renderer-soak.js"
  ]
};

GROUPS.soak = GROUPS["server-soak"];
GROUPS["all-non-browser"] = unique([
  ...GROUPS.unit,
  ...GROUPS.integration,
  ...GROUPS.protocol,
  ...GROUPS.smoke,
  ...GROUPS["server-soak"]
]);
GROUPS.all = unique([
  ...GROUPS["all-non-browser"],
  ...GROUPS.browser,
  ...GROUPS["renderer-soak"]
]);

function runScript(script) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  const durationMs = Date.now() - startedAt;
  return {
    script,
    startTime: new Date(startedAt).toISOString(),
    endTime: new Date(startedAt + durationMs).toISOString(),
    durationMs,
    exitCode: result.status,
    signal: result.signal || null,
    passed: result.status === 0,
    ok: result.status === 0
  };
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function main(argv) {
  const requested = argv.length > 0 ? argv : ["all"];
  const scripts = [];
  for (const name of requested) {
    const group = GROUPS[name];
    if (!group) {
      console.error(`Unknown test group "${name}". Known groups: ${Object.keys(GROUPS).join(", ")}`);
      process.exit(2);
    }
    for (const script of group) if (!scripts.includes(script)) scripts.push(script);
  }

  console.log(`Running ${scripts.length} test script(s) for group(s): ${requested.join(", ")}\n`);
  const results = [];
  for (const script of scripts) {
    console.log(`--- ${script} ---`);
    const result = runScript(script);
    results.push(result);
    const status = result.ok ? "PASS" : `FAIL (exit ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ""})`;
    console.log(`--- ${script}: ${status} in ${formatDuration(result.durationMs)} ---\n`);
  }

  const failed = results.filter((result) => !result.ok);
  console.log("==================== summary ====================");
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    console.log(`${status.padEnd(5)} ${formatDuration(result.durationMs).padStart(8)}  ${result.script}`);
  }
  console.log("=================================================");
  console.log(`${results.length - failed.length}/${results.length} passed`);
  const summary = {
    groups: requested,
    scripts,
    startTime: results[0]?.startTime || new Date().toISOString(),
    endTime: new Date().toISOString(),
    durationMs: results.reduce((sum, result) => sum + result.durationMs, 0),
    results: results.map(({ script, startTime, endTime, durationMs, exitCode, signal, passed }) => ({ script, startTime, endTime, durationMs, exitCode, signal, passed, failed: !passed })),
    firstFailedScript: failed[0]?.script || null,
    totalPassed: results.length - failed.length,
    totalFailed: failed.length,
    passed: failed.length === 0,
    failed: failed.length > 0
  };
  if (process.env.TEST_SUMMARY_PATH) {
    fs.mkdirSync(path.dirname(process.env.TEST_SUMMARY_PATH), { recursive: true });
    fs.writeFileSync(process.env.TEST_SUMMARY_PATH, JSON.stringify(summary, null, 2));
  }
  if (failed.length > 0) {
    console.error("FAILED:");
    for (const result of failed) console.error(`- ${result.script} — exit code ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ""}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
