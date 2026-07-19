#!/usr/bin/env node
"use strict";
// Browser smoke coverage for physical Blueprint Designer undo UX.
const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

function assertNoClientErrors(errors) { assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join("\n")}`); }

const ARTIFACT_DIR = "test-artifacts/blueprint-undo-browser";
const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

async function collectDesignerSetupDiagnostics(page) {
  return page.evaluate(async () => {
    const { state } = await import("/src/state.js");
    const buildGrid = document.querySelector("#buildGrid");
    return {
      mainMenuHidden: document.querySelector("#mainMenuScreen")?.hidden ?? null,
      designerScreenHidden: document.querySelector("#blueprintDesignerScreen")?.hidden ?? null,
      buildGridExists: Boolean(buildGrid),
      buildGridVisible: Boolean(buildGrid && buildGrid.offsetParent !== null && getComputedStyle(buildGrid).visibility !== "hidden"),
      blueprintView: state.blueprintView,
      currentUrl: location.href
    };
  });
}

async function openDesignerForUndoTest(page) {
  try {
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);
    await page.evaluate(async () => {
      const [
        { state },
        { openBlueprintDesigner },
        designerUi,
        storage,
        wiringUi,
        history
      ] = await Promise.all([
        import("/src/state.js"),
        import("/src/ui/designerScreenUi.js"),
        import("/src/ui/designerUi.js"),
        import("/src/design/blueprintStorage.js"),
        import("/src/ui/wiringUi.js"),
        import("/src/design/blueprintEditHistory.js")
      ]);

      const mainMenu = document.querySelector("#mainMenuScreen");
      const designerScreen = document.querySelector("#blueprintDesignerScreen");
      if (!mainMenu || !designerScreen) throw new Error("Required Blueprint Designer screens were not found");

      mainMenu.hidden = true;
      openBlueprintDesigner();

      state.design = storage.defaultDesign();
      state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design);
      state.loadedEditorBlueprintId = null;
      state.selectedPart = "frame";
      state.blueprintView = "build";
      wiringUi.resetWiringEditorState?.();
      history.clearBlueprintEditHistory?.();
      designerUi.clearPhysicalBlueprintHistory?.();
      designerUi.setBlueprintView?.("build");
      designerUi.renderBuildGrid?.();
      designerUi.refreshBlueprintUndoControl?.();
    });
    await page.locator("#blueprintDesignerScreen:not([hidden]) #buildGrid").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#blueprintDesignerScreen:not([hidden]) #undoBlueprintEditButton").waitFor({ state: "visible", timeout: 15000 });
  } catch (setupError) {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const screenshotPath = `${ARTIFACT_DIR}/setup-failure.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const diagnostics = await collectDesignerSetupDiagnostics(page).catch((error) => ({ diagnosticsError: error.message }));
    setupError.message = `${setupError.message}; setup diagnostics: ${JSON.stringify({ ...diagnostics, screenshotPath })}`;
    throw setupError;
  }
}

async function main() {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const clientErrors = [];
    page.on("pageerror", (error) => clientErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") clientErrors.push(`console.error: ${message.text()}`); });

    await openDesignerForUndoTest(page);
    assert.equal(await page.locator("#undoBlueprintEditButton").getAttribute("title"), "Undo last blueprint edit (Ctrl+Z)");
    assert.equal(await page.locator("#undoBlueprintEditButton").getAttribute("aria-label"), "Undo last blueprint edit");
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), true, "undo starts disabled");


    const noOpResetPreserved = await page.evaluate(async () => {
      const wiringUi = await import("/src/ui/wiringUi.js");
      window.__mfaState.loadedEditorBlueprintId = null;
      window.__mfaState.wiringUi.undoStack = [window.WiringRules.emptyWiring()];
      return wiringUi.canUndoWiring();
    });
    assert.equal(noOpResetPreserved, true, "browser setup has Wiring Undo before no-op Reset");
    await page.click("#resetButton");
    assert.equal(await page.evaluate(async () => (await import("/src/ui/wiringUi.js")).canUndoWiring()), true, "no-op Reset preserves Wiring Undo availability in browser");

    await page.evaluate(() => { window.__mfaState.selectedPart = "frame"; window.__mfaState.blueprintView = "build"; });
    await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
    const afterPlace = await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring }));
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "undo enables after first visible edit");

    await page.locator('.build-cell[data-x="9"][data-y="7"]').click({ button: "right" });
    assert.notEqual(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "second visible edit changes design");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "Undo restores previous design and Wiring after remove");


    await page.evaluate(() => { window.__mfaState.wiringUi.undoStack = [window.WiringRules.emptyWiring()]; });
    await page.click("#resetButton");
    assert.equal(await page.evaluate(async () => (await import("/src/ui/wiringUi.js")).canUndoWiring()), false, "genuine Reset clears stale Wiring Undo in browser");
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "genuine Reset leaves physical Undo available in browser");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "Undo restores ship after genuine Reset in browser");

    await page.click("#clearGridButton");
    assert.equal(await page.evaluate(() => window.__mfaState.design.length), 0, "Clear empties the current design");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "Undo restores entire ship after Clear");

    await page.evaluate(() => { window.__mfaState.selectedPart = "armor"; });
    await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
    const beforeKeyboardUndo = afterPlace;
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
    assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), beforeKeyboardUndo, "keyboard Undo restores actual design state");

    const wiredBefore = await page.evaluate(async () => {
      const storage = await import("/src/design/blueprintStorage.js");
      window.__mfaState.design = storage.defaultDesign();
      window.__mfaState.wiring = storage.normalizeWiring(storage.defaultWiring(), window.__mfaState.design);
      window.__mfaState.selectedPart = "frame";
      const designer = await import("/src/ui/designerUi.js");
      designer.renderBuildGrid();
      return JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring });
    });
    await page.locator('.build-cell[data-x="6"][data-y="6"]').click();
    await page.click("#undoBlueprintEditButton");
    assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), wiredBefore, "Undo restores known wired design snapshot");

    await page.setViewportSize({ width: 390, height: 740 });
    const box = await page.locator("#undoBlueprintEditButton").boundingBox();
    assert.ok(box && box.width >= 44 && box.height >= 24, "touch viewport keeps undo button accessible");
    assertNoClientErrors(clientErrors);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
}

main().then(() => console.log("Blueprint undo browser verification passed"));
