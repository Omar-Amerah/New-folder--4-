#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, waitForBrowserReady, uniquePort, uniqueRoom } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const room = uniqueRoom("start");
const { server } = startServer(port);
let browser;

(async () => {
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

    await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
    const startup = await waitForBrowserReady(page, room, {}, 20_000);

    const diagnostics = await page.evaluate(async () => {
      const beforeCalculations = Boolean(globalThis.WiringRules);
      const componentStats = await import("/src/design/componentStats.js");
      const [{ state }, { PART_STATS }, storage] = await Promise.all([
        import("/src/state.js"),
        import("/src/design/parts.js"),
        import("/src/design/blueprintStorage.js")
      ]);
      const design = [
        { type: "reactor", x: 0, y: 0, rotation: 0 },
        { type: "shield", x: 1, y: 0, rotation: 0 }
      ];
      const wiring = globalThis.WiringRules.addConnection(
        globalThis.WiringRules.emptyWiring(),
        "power",
        0,
        1,
        [{ x: 0, y: 0 }, { x: 1, y: 0 }],
        design,
        PART_STATS
      );
      const wired = componentStats.computeStats(design, { wiring });
      const disconnected = componentStats.computeStats(design, { wiring: globalThis.WiringRules.emptyWiring() });
      return {
        componentStatsLoaded: Boolean(componentStats.computeStats),
        wiringRulesBeforeCalculations: beforeCalculations,
        wiredShield: wired.maxShield,
        disconnectedShield: disconnected.maxShield,
        expectedShield: PART_STATS.shield.shield,
        mainModuleLoaded: Boolean(globalThis.__mfaMainLoaded),
        stateExists: Boolean(state && globalThis.__mfaState === state),
        websocketCreated: Boolean(globalThis.__mfaNetworkDiagnostics?.websocketCreated || state.socket),
        room: state.room,
        defaultWiringSections: storage.defaultWiring().power.sections.length
      };
    });

    assert.equal(diagnostics.componentStatsLoaded, true, "componentStats.js loads successfully");
    assert.equal(diagnostics.wiringRulesBeforeCalculations, true, "globalThis.WiringRules exists before componentStats calculations run");
    assert.equal(diagnostics.wiredShield, diagnostics.expectedShield, "Blueprint Designer calculates wiring-aware shield stats when powered");
    assert.equal(diagnostics.disconnectedShield, 0, "Blueprint Designer wiring-aware shield stats drop disconnected shields");
    assert.equal(diagnostics.mainModuleLoaded, true, "mainModuleLoaded becomes true");
    assert.equal(diagnostics.stateExists, true, "application state is created");
    assert.equal(diagnostics.websocketCreated, true, "WebSocket creation begins");
    assert.ok(diagnostics.defaultWiringSections > 0, "default browser wiring is available");

    const allErrors = [...pageErrors, ...consoleErrors].join("\n");
    assert.equal(/does not provide an export named ['\"]default['\"]/.test(allErrors), false, "no invalid WiringRules default export error");
    assert.equal(pageErrors.length, 0, `no page errors during startup: ${pageErrors.join("\n")}`);
    assert.equal(startup.mainModuleLoaded, true, "browser readiness reports main module loaded");
    console.log("Browser startup module-linking verification passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
})().catch((err) => {
  console.error(err);
  server.kill();
  process.exit(1);
});
