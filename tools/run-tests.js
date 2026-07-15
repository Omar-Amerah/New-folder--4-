"use strict";
// Minimal grouped test runner: executes the verify-*.js scripts for a named
// group sequentially (deterministic order), records durations, prints a
// pass/fail summary, and exits non-zero if any child failed.
//
// Usage: node tools/run-tests.js <group> [group...]
// Groups: unit, integration, protocol, smoke, browser, soak, all
//
// Deliberate behaviour:
//   - child stdout/stderr are inherited (nothing is swallowed);
//   - a non-zero child exit always fails the run (no retries, no warnings);
//   - a missing dependency (e.g. Playwright browsers) surfaces as the child's
//     own failure output and is reported as FAIL, never silently skipped.

const { spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// Ordering inside each group is fixed so runs are deterministic and
// fast tests fail before slow ones.
const GROUPS = {
  // Fast deterministic module tests: import server/shared modules directly,
  // no server process, no sockets, no browser.
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
    "verify-renderer-quality.js"
  ],
  // Module/room-lifecycle integration tests. The obsolete generated
  // public/client.js VM harnesses were removed from required suites so tests
  // cannot pass because ES-module imports were stripped into one global scope.
  integration: [
    "verify-reconnect.js",
    "verify-lobby-refresh-reconnect.js",
    "verify-lifecycle.js",
    "verify-input-lifecycle.js",
    "verify-pixi-lifecycle.js",
    "verify-renderer-structural-updates.js"
  ],
  // Real server.js process + real WebSockets + MessagePack snapshots.
  // Also the baseline lobby-to-active-match smoke flow.
  protocol: [
    "verify-runtime.js",
    "verify-heat-protocol.js"
  ],
  // Production-path smoke: real server process and HTTP asset checks only.
  smoke: [
    "verify-production-path.js"
  ],
  // Required browser gameplay: real server, real production frontend, real
  // Chromium, real browser input, WebSockets and MessagePack snapshots.
  browser: [
    "verify-live-turrets.js",
    "verify-heat-browser.js",
    "verify-renderer-input-browser.js"
  ],
  // Sustained high-entity deterministic server simulation with bounded-state
  // and performance measurements.
  soak: [
    "verify-soak.js",
    "verify-heat-soak.js",
    "verify-renderer-interaction-soak.js"
  ]
};
GROUPS.all = [...GROUPS.unit, ...GROUPS.integration, ...GROUPS.protocol, ...GROUPS.smoke, ...GROUPS.browser, ...GROUPS.soak];

function runScript(script) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  const durationMs = Date.now() - startedAt;
  // status is null when the child was killed by a signal (e.g. a hang killed
  // by CI timeout infrastructure): report the signal and treat it as failure.
  return {
    script,
    durationMs,
    exitCode: result.status,
    signal: result.signal || null,
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
    for (const script of group) {
      if (!scripts.includes(script)) scripts.push(script);
    }
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
  console.log(`=================================================`);
  console.log(`${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((result) => result.script).join(", ")}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
