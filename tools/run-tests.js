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
    "tests/verify-no-performance-rollout-branches.js",
    "tests/verify-module-boundaries.js",
    "tests/verify-module-imports.js",
    "tests/verify-blueprint-storage.js",
    "tests/verify-snapshot-merge.js",
    "tests/verify-snapshot-timeline.js",
    "tests/verify-projectile-snapshot-clock.js",
    "tests/verify-phase-5.js",
    "tests/verify-phase-transition.js",
    "tests/verify-presentation-matrix.js",
    "tests/verify-hot-path-correctness.js",
    "tests/verify-blueprint-parity.js",
    "tests/verify-rotation-parity.js",
    "tests/verify-component-flip.js",
    "tests/verify-component-flip-ux.js",
    "tests/verify-spawn-planner.js",
    "tests/verify-ship-spawn-collision.js",
    "tests/verify-component-indexes.js",
    "tests/verify-movement-simplified.js",
    "tests/verify-movement-formations.js",
    "tests/verify-movement-momentum.js",
    "tests/verify-movement-navigation.js",
    "tests/verify-movement-collision.js",
    "tests/verify-movement-hold-facing.js",
    "tests/verify-movement-orbit.js",
    "tests/verify-movement-kite.js",
    "tests/verify-movement-waypoint-queue.js",
    "tests/verify-propulsion-rebalance.js",
    "tests/verify-targeting.js",
    "tests/verify-turrets.js",
    "tests/verify-beam-emitter.js",
    "tests/verify-beam-nearest-entity.js",
    "tests/verify-projectile-footprint.js",
    "tests/verify-heat.js",
    "tests/verify-thermal-topology.js",
    "tests/verify-heat-transfer.js",
    "tests/verify-heat-cooling.js",
    "tests/verify-heat-thermo.js",
    "tests/verify-heat-pipe-improvements.js",
    "tests/verify-coolant-network.js",
    "tests/verify-coolant-layout.js",
    "tests/verify-heat-effects.js",
    "tests/verify-heat-hover-card.js",
    "tests/verify-thermal-parity.js",
    "tests/verify-phase-6a-heat-runtime.js",
    "tests/verify-phase-6b-drone-runtime.js",
    "tests/verify-phase-6c-visibility-runtime.js",
    "tests/verify-phase-6d-command-aura-runtime.js",
    "tests/verify-phase-6f-stations-objectives.js",
    "tests/verify-shields.js",
    "tests/verify-template-state-isolation.js",
    "tests/verify-power.js",
    "tests/verify-power-analysis.js",
    "tests/verify-data-support.js",
    "tests/verify-data-support-runtime.js",
    "tests/verify-data-support-lifecycle.js",
    "tests/verify-data-support-designer.js",
    "tests/verify-data-support-reference-parity.js",
    "tests/verify-data-support-balance.js",
    "tests/verify-power-runtime.js",
    "tests/verify-power-damage.js",
    "tests/verify-power-hardening.js",
    "tests/verify-component-health.js",
    "tests/verify-penetration-damage.js",
    "tests/verify-meltdown.js",
    "tests/verify-core-reactor.js",
    "tests/verify-combat-review.js",
    "tests/verify-combat-determinism.js",
    "tests/verify-combat-catchup.js",
    "tests/verify-defence-weapons.js",
    "tests/verify-command-runtime.js",
    "tests/verify-repair-target.js",
    "tests/verify-repair-drone-targeting.js",
    "tests/verify-engine-exhaust.js",
    "tests/verify-maps-objectives.js",
    "tests/verify-control-victory.js",
    "tests/verify-snapshot-visibility.js",
    "tests/verify-camera-transforms.js",
    "tests/verify-render-interpolation.js",
    "tests/verify-renderer-pools.js",
    "tests/verify-renderer-culling.js",
    "tests/verify-renderer-textures.js",
    "tests/verify-renderer-quality.js",
    "tests/verify-shield-ring-renderer.js",
    "tests/verify-ship-identification-renderer.js",
    "tests/verify-selection.js",
    "tests/verify-client-selection.js",
    "tests/verify-client-order-queue.js",
    "tests/verify-adaptive-music.js",
    "tests/verify-station-infrastructure.js",
    "tests/verify-relay-transfer-recovery.js",
    "tests/verify-station-single-hangar.js",
    "tests/verify-station-client.js",
    "tests/verify-station-hangar.js",
    "tests/verify-station-snapshot-performance.js",
    "tests/verify-sensor-fog.js",
    "tests/verify-sensor-fog-performance.js",
    "tests/verify-economy.js",
    "tests/verify-economy-sequence.js",
    "tests/verify-purchase-signature.js",
    "tests/verify-bots.js",
    "tests/verify-shared-parity.js",
    "tests/verify-balance-revision.js",
    "tests/verify-canvas-removal.js",
    "tests/verify-components.js",
    "tests/verify-new-components.js",
    "tests/verify-burn-through-schema.js",
    "tests/verify-component-catalogue.js",
    "tests/verify-component-copy.js",
    "tests/verify-component-inspector.js",
    "tests/verify-ship-summary.js",
    "tests/verify-section13b-ui.js",
    "tests/verify-section14-security.js",
    "tests/verify-diagnostics-gating.js",
    "tests/verify-fleet-ledger.js",
    "tests/verify-command-auras.js",
    "tests/verify-command-runtime.js",
    "tests/verify-phase-one-telemetry.js",
    "tests/verify-shield-cache.js",
    "tests/verify-projectile-event-replication.js",
    "tests/verify-phase-3-targeting-pd.js",
    "tests/verify-phase-4a.js",
    "tests/verify-phase-4b.js",
  ],

  // Browser-free module/room/input lifecycle integration. These may use fake
  // sockets or DOM/event doubles, but never Playwright/Chromium/WebGL.
  integration: [
    "tests/verify-reconnect.js",
    "tests/verify-lobby-refresh-reconnect.js",
    "tests/verify-lobby-recovery.js",
    "tests/verify-connection-errors.js",
    "tests/verify-lifecycle.js",
    "tests/verify-input-lifecycle.js",
    "tests/verify-renderer-structural-updates.js",
    "tests/verify-pixi-world-layers.js",
    "tests/verify-shield-cache-live.js"
  ],

  // Real server.js process + real WebSockets + MessagePack snapshots.
  protocol: [
    "tests/verify-runtime.js",
    "tests/verify-heat-protocol.js",
    "tests/verify-websocket-frames.js",
    "tests/verify-protocol-schema.js",
    "tests/verify-network-connections.js",
    "tests/verify-network-protocol.js",
    "tests/verify-websocket-handler-errors.js"
  ],

  // Production-path smoke: real server process and HTTP asset checks only.
  smoke: [
    "tests/verify-production-path.js",
    "tests/verify-deployment-health.js"
  ],

  // Required browser gameplay/renderer coverage: real server, production
  // frontend, Playwright Chromium, WebGL and Pixi. Missing Chromium is a hard failure.
  browser: [
    "tests/verify-endgame-actions-browser.js",
    "tests/verify-deployment-controls-browser.js",
    "tests/verify-blueprint-modes-browser.js",
    "tests/verify-blueprint-information-polish-browser.js",
    "tests/verify-ship-summary-browser.js",
    "tests/verify-movement-orbit-browser.js",
    "tests/verify-movement-toggles-browser.js",
    "tests/verify-data-links-editor.js",
    "tests/verify-live-turrets.js",
    "tests/verify-heat-browser.js",
    "tests/verify-power-thermal-ui-browser.js",
    "tests/verify-renderer-input-browser.js",
    "tests/verify-ship-hull-outline-browser.js",
    "tests/verify-browser-websocket-payloads.js",
    "tests/verify-browser-sequential-rooms.js",
    "tests/verify-sensor-fog-browser.js",
    "tests/verify-pixi-lifecycle.js",
    "tests/verify-renderer-performance-browser.js",
    "tests/verify-webgl-context-browser.js",
    "tests/verify-purchase-bar-layout-browser.js"
  ],

  // Deterministic server/simulation soaks only. This group is browser-free.
  "server-soak": [
    "tests/verify-soak.js",
    "tests/verify-heat-soak.js",
    "tests/verify-resync-reason-contract.js",
    "tests/verify-snapshot-coalescing.js",
    "tests/verify-snapshot-contract.js",
    "tests/verify-snapshot-resync.js",
    "tests/verify-network-backpressure.js",
    "tests/verify-network-soak.js"
  ],

  // Dedicated long renderer soak: real Chromium, real WebGL, real Pixi,
  // production frontend. CI installs Chromium only in the renderer-soak job.
  "renderer-soak": [
    "tests/verify-renderer-soak.js"
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
