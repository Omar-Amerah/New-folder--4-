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
const { generateBalanceArtifacts } = require("./generate-balance");
const { TEST_MANIFEST, SMOKE_TESTS } = require("./test-manifest");

const ROOT = path.join(__dirname, "..");

function unique(items) {
  const out = [];
  for (const item of items) if (!out.includes(item)) out.push(item);
  return out;
}

const GROUPS = {
  unit: TEST_MANIFEST.unit,
  integration: TEST_MANIFEST.integration,
  protocol: TEST_MANIFEST.protocol,
  smoke: SMOKE_TESTS,
  browser: TEST_MANIFEST.browser,
  "server-soak": TEST_MANIFEST["server-soak"],
  "renderer-soak": TEST_MANIFEST["renderer-soak"]
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

  generateBalanceArtifacts(ROOT);
  console.log("Generated balance artifacts for the test run.");
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
    for (const result of failed) console.error(`- ${result.script} - exit code ${result.exitCode}${result.signal ? `, signal ${result.signal}` : ""}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
