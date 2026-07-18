#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");
const port = uniquePort(); const base = `http://127.0.0.1:${port}`; const { server } = startServer(port); let browser;
(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage();
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#grid, #buildGrid", { timeout: 15000 });
    const result = await page.evaluate(async () => {
      const mod = await import("/src/design/dataSupportAnalysis.js");
      return { hasRules: Boolean(globalThis.DataSupportRules && globalThis.WiringRules && globalThis.HeatRules), hasAnalyze: typeof mod.analyzeDesignDataSupport === "function", hasVulnerability: typeof mod.analyzeDataVulnerabilities === "function" };
    });
    assert.deepEqual(result, { hasRules: true, hasAnalyze: true, hasVulnerability: true });
    console.log("Data-support designer browser verification passed.");
  } finally { await browser?.close?.(); server.kill("SIGTERM"); }
})().catch((error) => { console.error(error); process.exit(1); });
