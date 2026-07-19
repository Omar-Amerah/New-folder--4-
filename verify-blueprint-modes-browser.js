"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const ARTIFACT_DIR = "test-artifacts/blueprint-modes-browser";
const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

async function setupDesigner(page) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);
  await page.evaluate(async () => {
    const [{ state }, { openBlueprintDesigner }, designer, storage, wiringUi, { renderPalette }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerScreenUi.js"),
      import("/src/ui/designerUi.js"),
      import("/src/design/blueprintStorage.js"),
      import("/src/ui/wiringUi.js"),
      import("/src/ui/partPaletteUi.js")
    ]);
    state.design = storage.defaultDesign();
    state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design);
    state.selectedPart = "frame";
    state.selectedPartCategory = "Structure";
    state.previewRotation = 0;
    state.blueprintView = "build";
    wiringUi.resetWiringEditorState?.();
    const mainMenu = document.querySelector("#mainMenuScreen");
    const designerScreen = document.querySelector("#blueprintDesignerScreen");
    if (!mainMenu || !designerScreen) {
      throw new Error("Required screen elements are missing");
    }
    mainMenu.hidden = true;
    openBlueprintDesigner();
    designer.setBlueprintView("build");
    renderPalette();
    designer.renderBuildGrid();
    designer.renderLocalStats();
  });
  await page.locator("#blueprintDesignerScreen:not([hidden]) #buildGrid").waitFor({ state: "visible" });
}

async function gridRect(page) {
  return page.locator("#buildGrid").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cell = document.querySelector('.build-cell[data-x="7"][data-y="7"]')?.getBoundingClientRect();
    return {
      grid: { x: r.x, y: r.y, width: r.width, height: r.height },
      cell: cell ? { x: cell.x, y: cell.y, width: cell.width, height: cell.height } : null
    };
  });
}

function assertStable(before, after, label) {
  for (const key of ["grid", "cell"]) {
    for (const prop of ["x", "y", "width", "height"]) {
      assert.ok(Math.abs(before[key][prop] - after[key][prop]) <= 1, `${label} ${key}.${prop} stable`);
    }
  }
}

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });

    for (const viewport of [{ width: 1180, height: 760 }, { width: 1280, height: 900 }, { width: 1600, height: 900 }]) {
      await page.setViewportSize(viewport);
      await setupDesigner(page);
      assert.deepEqual(await page.$$eval('.blueprint-view-tabs [role="tab"]', tabs => tabs.map(t => t.textContent.trim())), ["Build", "Heat", "Wiring"]);
      assert.equal(await page.locator("#blueprintBuildTab").getAttribute("aria-selected"), "true");
      assert.match(await page.locator("#blueprintModeContext").textContent(), /Build/);
      const build = await gridRect(page);
      await page.click("#blueprintHeatTab");
      assert.equal(await page.locator("#blueprintHeatTab").getAttribute("aria-selected"), "true");
      assert.match(await page.locator("#blueprintModeContext").textContent(), /Build while viewing predicted component Heat/);
      assertStable(build, await gridRect(page), `${viewport.width}x${viewport.height} Heat`);
      await page.click("#blueprintWiringTab");
      assert.equal(await page.locator("#blueprintWiringTab").getAttribute("aria-selected"), "true");
      assert.match(await page.locator("#blueprintModeContext").textContent(), /Component placement is paused/);
      assert.match(await page.locator("#partPalette").textContent(), /Component placement paused in Wiring mode/);
      assert.equal(await page.locator("#partPalette .part-button").first().isDisabled(), true);
      assertStable(build, await gridRect(page), `${viewport.width}x${viewport.height} Wiring`);
      await page.keyboard.press("Home");
      assert.equal(await page.locator("#blueprintBuildTab").getAttribute("aria-selected"), "true");
      await page.keyboard.press("End");
      assert.equal(await page.locator("#blueprintWiringTab").getAttribute("aria-selected"), "true");
    }
    assert.deepEqual(errors, []);
    console.log("Blueprint modes browser verification passed");
  } catch (error) {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    if (browser) {
      const pages = browser.contexts()[0]?.pages?.() || [];
      await pages[0]?.screenshot({ path: `${ARTIFACT_DIR}/failure.png`, fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    server.kill("SIGTERM");
  }
})();
