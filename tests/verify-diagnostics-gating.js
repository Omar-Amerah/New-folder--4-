// Contract coverage for production gating of development/test-only globals.
//
// __mfaState, __mfaNetSend and the renderer failure-injection helpers must be
// exposed only when diagnostics are enabled (local dev hosts or explicit
// opt-in), never in a normal production build. This is a static/source contract
// test plus a behavioural check of the DIAGNOSTICS_ENABLED gate itself; the full
// browser assertion runs in the browser test group when Chromium is available.

const assert = require("assert");
const fs = require("fs");

// 1. Source contract: the dangerous handles are behind a DIAGNOSTICS_ENABLED gate.
(function sourceGating() {
  const main = fs.readFileSync("public/src/main.js", "utf8");
  assert.ok(/if\s*\(\s*DIAGNOSTICS_ENABLED\s*\)\s*{[\s\S]*__mfaState[\s\S]*__mfaNetSend[\s\S]*}/.test(main),
    "__mfaState and __mfaNetSend are exposed only inside a DIAGNOSTICS_ENABLED block");
  assert.ok(/import\s*{[^}]*DIAGNOSTICS_ENABLED[^}]*}\s*from\s*"\.\/constants\.js"/.test(main),
    "main.js imports the DIAGNOSTICS_ENABLED gate");

  const renderer = fs.readFileSync("public/src/game/pixi/pixiRenderer.js", "utf8");
  assert.ok(/DIAGNOSTICS_ENABLED\s*\)\s*{[\s\S]*__mfaInjectPixiFrameFailure/.test(renderer),
    "renderer failure-injection helper is behind the DIAGNOSTICS_ENABLED gate");
  console.log("PASS: dev-only globals are gated behind DIAGNOSTICS_ENABLED in source");
})();

// 2. Behavioural: the gate is true on local/dev and explicit opt-in, false on a
//    production host.
async function evalGate(locationLike) {
  const prevWindow = globalThis.window;
  globalThis.window = { location: locationLike, __mfaEnableDiagnostics: locationLike.__optIn === true };
  try {
    const mod = await import(`./public/src/constants.js?diaggate=${Math.random()}`);
    return mod.DIAGNOSTICS_ENABLED;
  } finally {
    globalThis.window = prevWindow;
  }
}

(async () => {
  assert.strictEqual(await evalGate({ hostname: "127.0.0.1", search: "" }), true, "127.0.0.1 enables diagnostics (browser tests)");
  assert.strictEqual(await evalGate({ hostname: "localhost", search: "" }), true, "localhost enables diagnostics");
  assert.strictEqual(await evalGate({ hostname: "play.example.com", search: "" }), false, "a production host does NOT expose diagnostics");
  assert.strictEqual(await evalGate({ hostname: "play.example.com", search: "?diagnostics=1" }), true, "explicit ?diagnostics=1 opt-in enables diagnostics");
  assert.strictEqual(await evalGate({ hostname: "play.example.com", search: "", __optIn: true }), true, "explicit window flag enables diagnostics");
  console.log("PASS: DIAGNOSTICS_ENABLED is true for dev/opt-in and false for production hosts");
  console.log("\nDIAGNOSTICS GATING CONTRACT TESTS PASSED");
})().catch((e) => { console.error(e); process.exit(1); });
