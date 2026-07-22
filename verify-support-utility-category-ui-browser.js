#!/usr/bin/env node
"use strict";

// Browser companion for the Support -> Utility palette category merge.
// Launches the production frontend in real Chromium and asserts the live
// Blueprint Designer palette DOM reflects the merge:
//   - the category tab row shows "Utility" exactly once and "Support" zero times
//   - the Utility category lists all eight moved components plus the three
//     pre-existing Utility components, once each, with no empty container
//   - category navigation is keyboard-accessible (focus + Enter activates a tab)
//   - each moved component is discoverable under Utility (its palette button
//     title metadata reads "| Utility |", the search/hover affordance)
//
// Chromium/WebGL being unavailable is a hard failure for this browser-group
// verifier, distinct from an assertion failure about the merge itself.

const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { chromium } = require("playwright");
const { launchChromium, startServer, uniquePort } = require("./verify-pixi-browser-support.js");

const ARTIFACT_DIR = "test-artifacts/support-utility-category-ui-browser";
const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server, getLog } = startServer(port);

const MOVED = ["Heat Pipe", "Heat Sink", "Radiator", "Repair", "Repair Beam", "Sensor Array", "Targeting Computer", "Fire Control"];
const EXISTING = ["Capture Module", "Signal Amplifier", "Stabilizer Node"];

let browser;

async function setupDesigner(page) {
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);
  await page.evaluate(async () => {
    const [{ state }, { openBlueprintDesigner }, designerUi, storage, { renderPalette }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerScreenUi.js"),
      import("/src/ui/designerUi.js"),
      import("/src/design/blueprintStorage.js"),
      import("/src/ui/partPaletteUi.js")
    ]);
    const mainMenu = document.querySelector("#mainMenuScreen");
    if (!mainMenu || !document.querySelector("#blueprintDesignerScreen") || !document.querySelector("#buildGrid")) throw new Error("Required Blueprint Designer DOM is missing");
    mainMenu.hidden = true;
    openBlueprintDesigner();
    state.design = storage.defaultDesign();
    state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design);
    state.loadedEditorBlueprintId = null;
    state.selectedPartCategory = "Structure";
    state.selectedPart = null;
    state.blueprintView = "build";
    designerUi.setBlueprintView("build");
    renderPalette();
  });
  await page.locator("#blueprintDesignerScreen:not([hidden]) #partPalette").waitFor({ state: "visible", timeout: 15000 });
}

async function categoryTabTexts(page) {
  return page.$$eval("#partPalette .part-category-tabs button", (buttons) => buttons.map((b) => b.textContent.trim()));
}

async function run() {
  browser = await launchChromium(chromium);
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));

  try {
    await setupDesigner(page);

    // 1. Category tab row: Utility exactly once, Support zero times.
    const tabs = await categoryTabTexts(page);
    assert.equal(tabs.filter((t) => t === "Utility").length, 1, `expected exactly one Utility tab, got tabs=${JSON.stringify(tabs)}`);
    assert.equal(tabs.filter((t) => t === "Support").length, 0, `expected no Support tab, got tabs=${JSON.stringify(tabs)}`);

    // 2. Keyboard accessibility: focus the Utility tab and activate with Enter.
    const utilityTab = page.locator("#partPalette .part-category-tabs button", { hasText: "Utility" });
    await utilityTab.focus();
    const focused = await page.evaluate(() => document.activeElement && document.activeElement.textContent.trim());
    assert.equal(focused, "Utility", "Utility category tab is keyboard-focusable");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => window.__mfaState.selectedPartCategory === "Utility");

    // 3. The Utility list renders all moved + existing components, once each,
    //    and the container is not empty.
    const partNames = await page.$$eval("#partPalette .part-category-list .part-button .part-name", (spans) => spans.map((s) => s.textContent.trim()));
    assert.ok(partNames.length > 0, "Utility palette list is not empty");
    for (const name of [...MOVED, ...EXISTING]) {
      assert.equal(partNames.filter((n) => n === name).length, 1, `Utility lists "${name}" exactly once (got ${JSON.stringify(partNames)})`);
    }
    assert.equal(partNames.length, MOVED.length + EXISTING.length, `Utility lists exactly ${MOVED.length + EXISTING.length} components (got ${JSON.stringify(partNames)})`);

    // 4. The list renders in the deterministic, sensible sequence, with every
    //    moved component grouped before the pre-existing Utility modules.
    const EXPECTED_ORDER = ["Heat Pipe", "Heat Sink", "Radiator", "Repair", "Repair Beam", "Sensor Array", "Targeting Computer", "Fire Control", "Capture Module", "Signal Amplifier", "Stabilizer Node"];
    assert.deepEqual(partNames, EXPECTED_ORDER, `Utility palette renders the deterministic sensible order (got ${JSON.stringify(partNames)})`);
    const lastMoved = Math.max(...MOVED.map((n) => partNames.indexOf(n)));
    const firstExisting = Math.min(...EXISTING.map((n) => partNames.indexOf(n)));
    assert.ok(lastMoved < firstExisting, `moved components precede existing Utility components (order=${JSON.stringify(partNames)})`);

    // 5. Discoverability: each moved component's palette button metadata
    //    (title) surfaces it under the Utility category, and never "Support".
    const titles = await page.$$eval("#partPalette .part-category-list .part-button", (buttons) => buttons.map((b) => b.title));
    for (const name of MOVED) {
      const title = titles.find((t) => t.startsWith(`${name} |`));
      assert.ok(title, `moved component "${name}" has a palette button`);
      assert.ok(title.includes("| Utility |"), `"${name}" is discoverable under Utility (title=${title})`);
      assert.ok(!title.includes("Support"), `"${name}" title makes no Support palette claim (title=${title})`);
    }

    // 6. No Support tab can be selected: cycling through every category tab and
    //    back leaves a populated, non-Support selection.
    for (const category of tabs) {
      const tab = page.locator("#partPalette .part-category-tabs button", { hasText: new RegExp(`^${category}$`) });
      await tab.first().click();
      await page.waitForFunction((expected) => window.__mfaState.selectedPartCategory === expected, category);
      assert.notEqual(category, "Support", "no Support category is ever selectable");
    }

    assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join("\n")}`);
    console.log("verify-support-utility-category-ui-browser passed");
  } catch (error) {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const screenshotPath = `${ARTIFACT_DIR}/failure.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    error.message = `${error.message}; screenshot: ${screenshotPath}; server log tail: ${getLog().slice(-1200)}`;
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    server.kill("SIGTERM");
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
