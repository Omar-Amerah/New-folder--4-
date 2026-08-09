#!/usr/bin/env node
"use strict";
// Regression coverage for the Blueprint-analysis cache and the purchase-bar
// static/dynamic split. Simulates 24 large saved blueprints and 100 active
// match snapshots, asserting that no expensive analysis runs after the initial
// catalogue build unless the underlying Blueprint genuinely changes.

const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, waitForBrowserReady, uniquePort, uniqueRoom, PAGE_HELPERS, DISMISS_MENUS, design } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const room = uniqueRoom("cache");
const { server } = startServer(port);
let browser;

function largeDesign(seed) {
  // 60-component design: a core with radiating reactors, shields and weapons.
  const parts = [];
  const used = new Set();
  const centre = 7;
  used.add(`${centre},${centre}`);
  parts.push({ x: centre, y: centre, type: "core", rotation: 0 });
  const arms = ["reactor", "shield", "blaster", "missile", "railgun", "beam"];
  for (let i = 1; i <= 10; i += 1) {
    for (let j = 0; j < 6; j += 1) {
      const x = Math.max(0, Math.min(14, centre + i * (j % 2 === 0 ? 1 : -1)));
      const y = Math.max(0, Math.min(14, centre + (j % 2 === 0 ? j : -j)));
      const key = `${x},${y}`;
      if (used.has(key)) continue;
      used.add(key);
      parts.push({ x, y, type: arms[j % arms.length], rotation: (i * 90 + seed) % 360 });
    }
  }
  return parts;
}

function manySavedDesigns(count) {
  const list = [];
  for (let i = 0; i < count; i += 1) {
    list.push({
      id: `saved-${i}`,
      name: `Ship ${i + 1}`,
      blueprint: largeDesign(i),
      dataLinks: [],
      combatStyle: "hold",
      updatedAt: Date.now() + i
    });
  }
  return list;
}

(async () => {
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

    await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
    await waitForBrowserReady(page, room, {}, 20_000);
    await page.addScriptTag({ content: PAGE_HELPERS });
    await page.evaluate(DISMISS_MENUS);

    // Inject 24 large saved designs and set the match state to active/ready.
    await page.evaluate((designs) => {
      const s = window.__mfaState;
      s.savedDesigns = designs;
      s.phase = "active";
      s.combatStyle = "hold";
      s.activeLoadoutId = "all";
      s.design = designs[0].blueprint.slice();
      s.dataLinks = designs[0].dataLinks;
      s.mine = { ready: true, money: 100_000, activeShips: 0, shipCap: 100, team: "blue", income: 50 };
    }, manySavedDesigns(24));

    // Build the catalogue once and record the expensive-call baseline.
    const baseline = await page.evaluate(async () => {
      const cache = await import("/src/design/blueprintAnalysisCache.js");
      const purchase = await import("/src/ui/purchaseUi.js");
      cache.resetBlueprintAnalysisCounters();
      purchase.rebuildPurchaseCatalogue();
      return { ...cache.counters };
    });
    const catalogueCost = baseline.computeStats + baseline.normalizeDesign + baseline.normalizeDataLinks + baseline.validateBlueprint;
    assert.ok(catalogueCost > 0, "initial catalogue must perform analysis");

    // Warm-up done: 100 snapshots should not trigger any further expensive work.
    const snapshot = await page.evaluate(async () => {
      const purchase = await import("/src/ui/purchaseUi.js");
      const cache = await import("/src/design/blueprintAnalysisCache.js");
      for (let i = 0; i < 100; i += 1) {
        window.__mfaState.mine.money = 5000 + i;
        window.__mfaState.mine.income = 10 + (i % 5);
        window.__mfaState.mine.activeShips = i % 20;
        window.__mfaState.mine.shipCap = 50 + (i % 10);
        purchase.updateEconomyUi({ refreshCatalogue: false });
      }
      return { ...cache.counters };
    });
    assert.strictEqual(snapshot.computeStats, baseline.computeStats, "computeStats must not run during snapshots");
    assert.strictEqual(snapshot.normalizeDesign, baseline.normalizeDesign, "normalizeDesign must not run during snapshots");
    assert.strictEqual(snapshot.normalizeDataLinks, baseline.normalizeDataLinks, "normalizeDataLinks must not run during snapshots");
    assert.strictEqual(snapshot.validateBlueprint, baseline.validateBlueprint, "validateBlueprint must not run during snapshots");
    assert.ok(snapshot.availabilityUpdate >= 100, "availability updates ran for each snapshot");

    // Editing the current Blueprint should invalidate only the current analysis.
    const afterEditCurrent = await page.evaluate(async () => {
      const cache = await import("/src/design/blueprintAnalysisCache.js");
      const before = { ...cache.counters };
      const s = window.__mfaState;
      s.design = s.savedDesigns[1].blueprint.slice();
      s.dataLinks = s.savedDesigns[1].dataLinks;
      const purchase = await import("/src/ui/purchaseUi.js");
      purchase.rebuildPurchaseCatalogue();
      return { before, after: { ...cache.counters } };
    });
    const currentExtra = afterEditCurrent.after.computeStats - afterEditCurrent.before.computeStats;
    assert.strictEqual(currentExtra, 1, "editing the current Blueprint recomputes exactly one analysis");

    // Editing a single saved Blueprint should only recompute that one design.
    const afterEditSaved = await page.evaluate(async (now) => {
      const cache = await import("/src/design/blueprintAnalysisCache.js");
      const before = { ...cache.counters };
      const s = window.__mfaState;
      const edited = s.savedDesigns[5];
      s.savedDesigns[5] = {
        ...edited,
        // A new array reference plus updatedAt is enough to invalidate the saved-design entry.
        blueprint: edited.blueprint.slice(),
        updatedAt: now
      };
      const purchase = await import("/src/ui/purchaseUi.js");
      purchase.rebuildPurchaseCatalogue();
      return { before, after: { ...cache.counters } };
    }, Date.now());
    const savedExtra = afterEditSaved.after.computeStats - afterEditSaved.before.computeStats;
    assert.strictEqual(savedExtra, 1, "editing one saved Blueprint recomputes exactly one analysis");

    // Changing only money/availability should not recompute anything.
    const afterMoney = await page.evaluate(async () => {
      const cache = await import("/src/design/blueprintAnalysisCache.js");
      const before = { ...cache.counters };
      const s = window.__mfaState;
      s.mine.money = 42;
      const purchase = await import("/src/ui/purchaseUi.js");
      purchase.updateEconomyUi({ refreshCatalogue: false });
      return { before, after: { ...cache.counters } };
    });
    assert.strictEqual(afterMoney.after.computeStats, afterMoney.before.computeStats, "money-only update must not recompute stats");

    await page.close();
    console.log("Purchase catalogue cache regression passed");
  } catch (error) {
    console.error(error.message);
    console.error("Page errors:", pageErrors);
    console.error("Console errors:", consoleErrors);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
})();
