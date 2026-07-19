#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { mkdirSync } = require("node:fs");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const ARTIFACT_DIR = "test-artifacts/blueprint-discoverability-browser";
const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server, getLog } = startServer(port);
let browser;

function snapshotExpr() { return 'JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring, loadedEditorBlueprintId: window.__mfaState.loadedEditorBlueprintId })'; }
async function snapshot(page) { return page.evaluate(new Function(`return ${snapshotExpr()};`)); }
async function designLength(page) { return page.evaluate(() => window.__mfaState.design.length); }
async function assertNoClientErrors(errors) { assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join("\n")}`); }

async function diagnostics(page) {
  return page.evaluate(() => {
    const grid = document.querySelector("#buildGrid");
    const mainMenu = document.querySelector("#mainMenuScreen");
    const designer = document.querySelector("#blueprintDesignerScreen");
    return {
      currentUrl: location.href,
      mainMenuHidden: mainMenu?.hidden ?? null,
      mainMenuDisplay: mainMenu ? getComputedStyle(mainMenu).display : null,
      designerHidden: designer?.hidden ?? null,
      designerDisplay: designer ? getComputedStyle(designer).display : null,
      gridExists: Boolean(grid),
      gridVisible: Boolean(grid && grid.offsetParent !== null && getComputedStyle(grid).visibility !== "hidden"),
      blueprintView: window.__mfaState?.blueprintView ?? null,
      selectedPart: window.__mfaState?.selectedPart ?? null,
      designLength: window.__mfaState?.design?.length ?? null
    };
  });
}

async function setupDesigner(page) {
  try {
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);
    await page.evaluate(async () => {
      const [{ state }, { openBlueprintDesigner }, designerUi, storage, wiringUi, history, { renderPalette }] = await Promise.all([
        import("/src/state.js"),
        import("/src/ui/designerScreenUi.js"),
        import("/src/ui/designerUi.js"),
        import("/src/design/blueprintStorage.js"),
        import("/src/ui/wiringUi.js"),
        import("/src/design/blueprintEditHistory.js"),
        import("/src/ui/partPaletteUi.js")
      ]);
      const mainMenu = document.querySelector("#mainMenuScreen");
      if (!mainMenu || !document.querySelector("#blueprintDesignerScreen") || !document.querySelector("#buildGrid")) throw new Error("Required Blueprint Designer DOM is missing");
      mainMenu.hidden = true;
      openBlueprintDesigner();
      state.design = storage.defaultDesign();
      state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design);
      state.loadedEditorBlueprintId = null;
      state.selectedPartCategory = "Weapons";
      state.selectedPart = "blaster";
      state.previewRotation = 0;
      state.hoveredCell = null;
      state.selectedCell = null;
      state.blueprintView = "build";
      wiringUi.resetWiringEditorState?.();
      history.clearBlueprintEditHistory?.();
      designerUi.clearPhysicalBlueprintHistory?.();
      designerUi.setBlueprintView("build");
      renderPalette();
      designerUi.renderBuildGrid();
      designerUi.renderLocalStats();
      designerUi.refreshBlueprintUndoControl();
    });
    await page.locator("#blueprintDesignerScreen:not([hidden]) #buildGrid").waitFor({ state: "visible", timeout: 15000 });
    await page.locator("#blueprintDesignerScreen:not([hidden]) #partPalette").waitFor({ state: "visible", timeout: 15000 });
  } catch (error) {
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const screenshotPath = `${ARTIFACT_DIR}/setup-failure.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    const data = await diagnostics(page).catch((diagnosticError) => ({ diagnosticError: diagnosticError.message }));
    error.message = `${error.message}; setup diagnostics: ${JSON.stringify({ ...data, screenshotPath })}; server log: ${getLog().slice(-1200)}`;
    throw error;
  }
}

async function setMode(page, mode) {
  if (mode === "build") await page.click("#blueprintBuildTab");
  if (mode === "heat") await page.click("#blueprintHeatTab");
  if (mode === "wiring") await page.click("#blueprintWiringTab");
  await page.waitForFunction((expected) => window.__mfaState.blueprintView === expected, mode);
}

async function setSelectedPart(page, type, category = "Weapons") {
  await page.evaluate(({ type, category }) => {
    window.__mfaState.selectedPartCategory = category;
    window.__mfaState.selectedPart = type;
    window.__mfaState.previewRotation = 0;
  }, { type, category });
}

async function clearHistory(page) {
  await page.evaluate(async () => {
    const history = await import("/src/design/blueprintEditHistory.js");
    const designer = await import("/src/ui/designerUi.js");
    history.clearBlueprintEditHistory();
    designer.refreshBlueprintUndoControl();
  });
}

async function main() {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const clientErrors = [];
    page.on("pageerror", (error) => clientErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") clientErrors.push(`console.error: ${message.text()}`); });

    await setupDesigner(page);

    const guide = page.locator("#buildInteractionGuide");
    await assert.equal(await guide.isVisible(), true, "Build interaction guide is visible");
    const buildGuide = await guide.textContent();
    assert.match(buildGuide, /left-click/i);
    assert.match(buildGuide, /Rotate/i);
    assert.match(buildGuide, /right-click/i);
    await assert.equal(await page.locator("#resetButton").innerText(), "Reset to Starter Ship", "Reset has visible label");
    await assert.equal(await page.locator("#clearGridButton").innerText(), "Clear All Components", "Clear has visible label");

    const indicator = page.locator("#rotationIndicator");
    const beforeRotation = await indicator.textContent();
    await page.keyboard.press("R");
    await page.waitForFunction((prior) => document.querySelector("#rotationIndicator")?.textContent !== prior, beforeRotation);
    assert.match(await indicator.textContent(), /Rotation: \d+°/);

    const beforeBuildPlace = await snapshot(page);
    await page.locator('.build-cell[data-x="9"][data-y="8"]').click();
    assert.notEqual(await snapshot(page), beforeBuildPlace, "Build placement changes design");
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "Undo enables after Build edit");

    await setMode(page, "heat");
    assert.equal(await page.locator("#partPalette .part-button").first().isVisible(), true, "palette remains visible in Heat");
    const heatGuide = await guide.textContent();
    assert.match(heatGuide, /left-click/i);
    assert.match(heatGuide, /Hover to inspect Heat/i);
    assert.doesNotMatch(heatGuide, /right-click removal|right-click to remove/i);
    assert.equal(await indicator.isVisible(), true, "rotation indicator is visible in Heat");
    await setSelectedPart(page, "armor", "Defence");
    const beforeHeatPlace = await snapshot(page);
    await clearHistory(page);
    await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
    assert.notEqual(await snapshot(page), beforeHeatPlace, "Heat placement changes physical design");
    assert.equal(await page.evaluate(() => window.__mfaState.blueprintView), "heat", "view remains Heat after edit");
    assert.equal(await page.locator("#heatToolbar").isVisible(), true, "Heat UI remains rendered");
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "Undo enables after Heat edit");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await snapshot(page), beforeHeatPlace, "Undo restores exact design/Wiring after Heat edit");

    await setSelectedPart(page, "blaster", "Weapons");
    const beforeHeatRotate = await indicator.textContent();
    await page.keyboard.press("R");
    await page.waitForFunction((prior) => document.querySelector("#rotationIndicator")?.textContent !== prior, beforeHeatRotate);
    assert.equal(await page.evaluate(() => window.__mfaState.blueprintView), "heat", "R rotation stays in Heat");

    await setMode(page, "wiring");
    const beforeWiringClick = await snapshot(page);
    await setSelectedPart(page, "armor", "Defence");
    await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
    assert.equal(await snapshot(page), beforeWiringClick, "Wiring click does not place physical component");
    assert.equal(await guide.isVisible(), false, "physical guide hidden in Wiring");
    assert.equal(await indicator.isVisible(), false, "rotation indicator hidden in Wiring");

    await setMode(page, "build");
    await setSelectedPart(page, "frame", "Structure");
    const beforeRightClick = await snapshot(page);
    const beforeRightLength = await designLength(page);
    await page.locator('.build-cell[data-x="9"][data-y="7"]').click({ button: "right" });
    assert.equal(await designLength(page), beforeRightLength - 1, "right-click removes exactly one component");
    assert.notEqual(await snapshot(page), beforeRightClick, "right-click changes design through removal only");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await snapshot(page), beforeRightClick, "Undo restores exact design/Wiring after right-click removal");

    const genuine = await snapshot(page);
    await page.click("#resetButton");
    assert.equal(await page.locator("#confirmModal").isVisible(), true, "genuine Reset opens confirmation");
    await page.click("#confirmCancelButton");
    assert.equal(await snapshot(page), genuine, "Reset cancel changes nothing");
    await page.click("#clearGridButton");
    assert.equal(await page.locator("#confirmModal").isVisible(), true, "genuine Clear opens confirmation");
    await page.click("#confirmCancelButton");
    assert.equal(await snapshot(page), genuine, "Clear cancel changes nothing");
    await page.click("#clearGridButton");
    await page.click("#confirmAcceptButton");
    assert.equal(await designLength(page), 0, "accepted Clear empties design");
    assert.equal(await page.locator("#emptyGridInstruction").isVisible(), true, "empty instruction visible after Clear in Build");
    await setMode(page, "heat");
    assert.match(await page.locator("#emptyGridInstruction").textContent(), /predicted Heat/i, "Heat empty instruction is mode-appropriate");
    await setMode(page, "wiring");
    assert.equal(await page.locator("#emptyGridInstruction").isVisible(), false, "empty instruction hidden in Wiring");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await snapshot(page), genuine, "Undo restores full ship and Wiring after Clear");
    await setMode(page, "build");
    assert.equal(await page.locator("#emptyGridInstruction").isVisible(), false, "empty instruction disappears after Undo");

    await page.evaluate(async () => {
      const storage = await import("/src/design/blueprintStorage.js");
      const designer = await import("/src/ui/designerUi.js");
      window.__mfaState.design = storage.defaultDesign();
      window.__mfaState.wiring = storage.normalizeWiring(storage.defaultWiring(), window.__mfaState.design);
      window.__mfaState.loadedEditorBlueprintId = null;
      designer.renderBuildGrid(); designer.renderLocalStats(); designer.refreshBlueprintUndoControl();
    });
    await page.click("#resetButton");
    assert.equal(await page.locator("#confirmModal").isVisible(), false, "semantic no-op Reset does not open modal");

    const status = page.locator("#shipStatusChip");
    assert.equal(await status.getAttribute("aria-expanded"), "false", "status starts collapsed");
    const gridBox = await page.locator("#buildGrid").boundingBox();
    const cellBox = await page.locator('.build-cell[data-x="7"][data-y="7"]').boundingBox();
    await status.click();
    assert.equal(await status.getAttribute("aria-expanded"), "true", "status click opens details");
    await page.keyboard.press("Escape");
    assert.equal(await status.getAttribute("aria-expanded"), "false", "Escape closes status details");
    await status.click();
    await status.click();
    const gridBox2 = await page.locator("#buildGrid").boundingBox();
    const cellBox2 = await page.locator('.build-cell[data-x="7"][data-y="7"]').boundingBox();
    assert.ok(Math.abs(gridBox.width - gridBox2.width) < 0.5 && Math.abs(gridBox.height - gridBox2.height) < 0.5, "status details do not resize grid");
    assert.ok(Math.abs(cellBox.x - cellBox2.x) < 1 && Math.abs(cellBox.y - cellBox2.y) < 1, "status details do not move cell");

    await page.evaluate(async () => {
      const designer = await import("/src/ui/designerUi.js");
      window.__mfaState.design = [];
      designer.renderBuildGrid(); designer.renderLocalStats();
    });
    await page.waitForFunction(() => document.querySelector("#shipStatusChip")?.getAttribute("aria-expanded") === "true");
    await status.click();
    assert.equal(await status.getAttribute("aria-expanded"), "false", "manual close respected for current error");
    await page.evaluate(async () => { const designer = await import("/src/ui/designerUi.js"); designer.renderLocalStats(); });
    assert.equal(await status.getAttribute("aria-expanded"), "false", "same error rerender does not reopen");
    await page.evaluate(async () => {
      const designer = await import("/src/ui/designerUi.js");
      window.__mfaState.design = [{ type: "core", x: 7, y: 7, rotation: 0 }];
      designer.renderBuildGrid(); designer.renderLocalStats();
    });
    await page.waitForFunction(() => document.querySelector("#shipStatusChip")?.getAttribute("aria-expanded") === "true");

    await assertNoClientErrors(clientErrors);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
}

main().then(() => console.log("Blueprint discoverability browser verification passed"));
