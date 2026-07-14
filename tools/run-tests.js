"use strict";
// Minimal grouped test runner: executes the verify-*.js scripts for a named
// group sequentially (deterministic order), records durations, prints a
// pass/fail summary, and exits non-zero if any child failed.
//
// Usage: node tools/run-tests.js <group> [group...]
// Groups: unit, integration, protocol, browser, all
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
    "verify-movement.js",
    "verify-targeting.js",
    "verify-turrets.js",
    "verify-heat.js",
    "verify-heat-thermo.js",
    "verify-heat-effects.js",
    "verify-core-reactor.js",
    "verify-combat-review.js",
    "verify-repair-target.js",
    "verify-engine-exhaust.js"
  ],
  // Module/room-lifecycle integration and bundled-client VM harness tests.
  // The VM harness tests need public/client.js: run `npm run build` first
  // (the npm scripts do this automatically).
  integration: [
    "verify-reconnect.js",
    "verify-lobby-refresh-reconnect.js",
    "verify-client-ui.js",
    "verify-heat-panel.js",
    "verify-turret-client.js"
  ],
  // Real server.js process + real WebSockets + MessagePack snapshots.
  // Also the baseline lobby-to-active-match smoke flow.
  protocol: [
    "verify-runtime.js"
  ],
  // Playwright/Chromium against the real server and real frontend.
  browser: [
    "verify-turret-render.js",
    "verify-pixi-lifecycle.js",
    "verify-live-turrets.js",
    "verify-match-start-render.js",
    "verify-blueprint-mobile-scroll.js"
  ]
};
GROUPS.all = [...GROUPS.unit, ...GROUPS.integration, ...GROUPS.protocol, ...GROUPS.browser];

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
