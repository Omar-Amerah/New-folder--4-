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


function rectanglesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function toolbarDiagnostics(page, screenshotName = "toolbar-overlap.png") {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const screenshotPath = `${ARTIFACT_DIR}/${screenshotName}`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return page.evaluate((screenshotPath) => {
    const ids = ["undoBlueprintEditButton", "resetButton", "clearGridButton", "blueprintCostBanner"];
    const describe = (id) => {
      const el = document.getElementById(id);
      if (!el) return { id, missing: true };
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        id,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
        center: { x, y },
        hit: hit ? { id: hit.id || null, tagName: hit.tagName, className: String(hit.className || ""), text: hit.textContent?.trim?.().slice(0, 80) || "" } : null,
        hitOwned: Boolean(hit && (hit === el || el.contains(hit))),
        style: { position: style.position, display: style.display, width: style.width, zIndex: style.zIndex, overflow: style.overflow, pointerEvents: style.pointerEvents }
      };
    };
    return { viewport: { width: innerWidth, height: innerHeight }, screenshotPath, controls: Object.fromEntries(ids.map((id) => [id, describe(id)])) };
  }, screenshotPath);
}

async function assertToolbarGeometry(page, label) {
  const data = await toolbarDiagnostics(page, `toolbar-overlap-${label}.png`);
  const controls = data.controls;
  for (const id of ["undoBlueprintEditButton", "resetButton", "clearGridButton", "blueprintCostBanner"]) {
    assert.ok(!controls[id].missing, `${id} exists; diagnostics: ${JSON.stringify(data)}`);
    assert.ok(controls[id].rect.width > 0 && controls[id].rect.height > 0, `${id} is visible; diagnostics: ${JSON.stringify(data)}`);
  }
  const pairs = [["undoBlueprintEditButton", "resetButton"], ["resetButton", "clearGridButton"], ["undoBlueprintEditButton", "blueprintCostBanner"], ["resetButton", "blueprintCostBanner"], ["clearGridButton", "blueprintCostBanner"]];
  for (const [a, b] of pairs) {
    assert.equal(rectanglesOverlap(controls[a].rect, controls[b].rect), false, `${a} must not overlap ${b}; diagnostics: ${JSON.stringify(data)}`);
  }
  for (const id of ["undoBlueprintEditButton", "resetButton", "clearGridButton"]) {
    assert.equal(controls[id].hitOwned, true, `${id} center must hit itself or a descendant; diagnostics: ${JSON.stringify(data)}`);
  }
}

async function assertToolbarGeometryForViewports(page) {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 1180, height: 760 }, { width: 1600, height: 900 }]) {
    await page.setViewportSize(viewport);
    await assertToolbarGeometry(page, `${viewport.width}x${viewport.height}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}


async function heatRotationDiagnostics(page, screenshotName = "heat-rotation-failure.png") {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const screenshotPath = `${ARTIFACT_DIR}/${screenshotName}`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return page.evaluate(async (screenshotPath) => {
    const { state } = await import("/src/state.js");
    const { PART_STATS } = await import("/src/design/parts.js");
    const { normalizeRotation } = await import("/src/design/rotation.js");
    const indicator = document.querySelector("#rotationIndicator");
    const style = indicator ? getComputedStyle(indicator) : null;
    const active = document.querySelector("#partPalette .part-button.active .part-name");
    const allowed = PART_STATS[state.selectedPart]?.allowedRotations || null;
    return {
      screenshotPath,
      view: state.blueprintView,
      selectedPart: state.selectedPart,
      selectedCategory: state.selectedPartCategory,
      previewRotation: state.previewRotation,
      allowedRotations: allowed,
      expected: normalizeRotation(state.previewRotation, allowed),
      indicatorText: indicator?.textContent || null,
      indicatorHidden: indicator?.hidden ?? null,
      indicatorDisplay: style?.display || null,
      indicatorVisibility: style?.visibility || null,
      activePaletteButtonText: active?.textContent?.trim?.() || null
    };
  }, screenshotPath);
}

async function assertHeatRotationUpdates(page) {
  const before = await page.evaluate(() => ({
    rotation: window.__mfaState.previewRotation,
    text: document.querySelector("#rotationIndicator")?.textContent || null
  }));
  await page.keyboard.press("R");
  try {
    await page.waitForFunction((prior) => window.__mfaState.previewRotation !== prior, before.rotation, { timeout: 8000 });
    const result = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const { PART_STATS } = await import("/src/design/parts.js");
      const { normalizeRotation } = await import("/src/design/rotation.js");
      const expected = normalizeRotation(state.previewRotation, PART_STATS[state.selectedPart]?.allowedRotations);
      const indicator = document.querySelector("#rotationIndicator");
      return { view: state.blueprintView, selectedPart: state.selectedPart, previewRotation: state.previewRotation, expected, text: indicator?.textContent || "", hidden: indicator?.hidden ?? null };
    });
    assert.equal(result.view, "heat", `Heat rotation should stay in Heat: ${JSON.stringify(await heatRotationDiagnostics(page))}`);
    assert.equal(result.selectedPart, "blaster", `Heat rotation should keep Blaster selected: ${JSON.stringify(await heatRotationDiagnostics(page))}`);
    assert.equal(result.hidden, false, `Heat rotation indicator should remain visible: ${JSON.stringify(await heatRotationDiagnostics(page))}`);
    assert.match(result.text, new RegExp(`Rotation:\\s*${result.expected}°`), `Heat rotation indicator should show normalized expected rotation: ${JSON.stringify(await heatRotationDiagnostics(page))}`);
    assert.notEqual(result.previewRotation, before.rotation, `Heat previewRotation should change from ${before.rotation}: ${JSON.stringify(await heatRotationDiagnostics(page))}`);
  } catch (error) {
    error.message = `${error.message}; heat rotation diagnostics: ${JSON.stringify(await heatRotationDiagnostics(page))}`;
    throw error;
  }
}

async function rightClickRemovalDiagnostics(page, screenshotName = "right-click-removal-failure.png") {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const screenshotPath = `${ARTIFACT_DIR}/${screenshotName}`;
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return page.evaluate(async (screenshotPath) => {
    const { state } = await import("/src/state.js");
    const { validateBlueprint } = await import("/src/design/blueprintValidation.js");
    const history = await import("/src/design/blueprintEditHistory.js");
    const targetIndex = state.design.findIndex((part) => part.type === "blaster" && part.x === 9 && part.y === 8);
    const target = targetIndex >= 0 ? state.design[targetIndex] : null;
    const next = targetIndex >= 0 ? state.design.filter((_, index) => index !== targetIndex) : state.design;
    const validation = targetIndex >= 0 ? validateBlueprint(next, { requireThrust: false }) : null;
    const componentAt = (x, y) => state.design.find((part) => part.x === x && part.y === y) || null;
    return {
      screenshotPath,
      blueprintView: state.blueprintView,
      design: structuredClone(state.design),
      componentAt9x8: structuredClone(componentAt(9, 8)),
      componentAt9x7: structuredClone(componentAt(9, 7)),
      selectedPart: state.selectedPart,
      previewRotation: state.previewRotation,
      designLength: state.design.length,
      physicalHistorySize: history.blueprintEditHistorySize(),
      removalValidation: validation ? { ok: validation.ok, errors: structuredClone(validation.errors || []) } : { ok: false, reason: "target-missing" },
      shipStatusText: document.querySelector("#shipStatusText")?.textContent || null
    };
  }, screenshotPath);
}

async function assertRightClickRemovesPlacedBlaster(page) {
  try {
    const removalPrecondition = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const { validateBlueprint } = await import("/src/design/blueprintValidation.js");
      const targetIndex = state.design.findIndex((part) => part.type === "blaster" && part.x === 9 && part.y === 8);
      if (targetIndex < 0) return { ok: false, reason: "target-missing", design: structuredClone(state.design) };
      const target = state.design[targetIndex];
      const next = state.design.filter((_, index) => index !== targetIndex);
      const validation = validateBlueprint(next, { requireThrust: false });
      return { ok: validation.ok, target: structuredClone(target), errors: structuredClone(validation.errors || []), design: structuredClone(state.design) };
    });
    assert.equal(removalPrecondition.ok, true, `right-click target must be removable: ${JSON.stringify(removalPrecondition)}`);

    const before = await page.evaluate(async () => {
      const history = await import("/src/design/blueprintEditHistory.js");
      const target = window.__mfaState.design.find((part) => part.type === "blaster" && part.x === 9 && part.y === 8);
      if (!target) throw new Error(`Expected test Blaster at (9,8), design=${JSON.stringify(window.__mfaState.design)}`);
      return {
        design: structuredClone(window.__mfaState.design),
        wiring: structuredClone(window.__mfaState.wiring),
        loadedEditorBlueprintId: window.__mfaState.loadedEditorBlueprintId,
        selectedPart: window.__mfaState.selectedPart,
        previewRotation: window.__mfaState.previewRotation,
        physicalHistorySize: history.blueprintEditHistorySize(),
        target: structuredClone(target),
        supportFrame: structuredClone(window.__mfaState.design.find((part) => part.type === "frame" && part.x === 9 && part.y === 7) || null)
      };
    });
    const beforeRightClick = await snapshot(page);
    const beforeRightLength = before.design.length;

    await page.locator('.build-cell[data-x="9"][data-y="8"]').click({ button: "right" });
    await page.waitForFunction((previousLength) => window.__mfaState.design.length === previousLength - 1, beforeRightLength, { timeout: 8000 });

    const after = await page.evaluate(async () => {
      const history = await import("/src/design/blueprintEditHistory.js");
      return {
        design: structuredClone(window.__mfaState.design),
        wiring: structuredClone(window.__mfaState.wiring),
        loadedEditorBlueprintId: window.__mfaState.loadedEditorBlueprintId,
        selectedPart: window.__mfaState.selectedPart,
        previewRotation: window.__mfaState.previewRotation,
        physicalHistorySize: history.blueprintEditHistorySize(),
        remainingTarget: window.__mfaState.design.find((part) => part.type === "blaster" && part.x === 9 && part.y === 8) || null,
        replacementAtTarget: window.__mfaState.design.find((part) => part.x === 9 && part.y === 8) || null,
        supportFrame: structuredClone(window.__mfaState.design.find((part) => part.type === "frame" && part.x === 9 && part.y === 7) || null)
      };
    });

    assert.equal(after.remainingTarget, null, "right-click removes the targeted Blaster");
    assert.equal(after.design.length, beforeRightLength - 1, "right-click removes exactly one component");
    assert.equal(after.replacementAtTarget, null, "right-click does not also place or replace at the target cell");
    assert.deepEqual(after.supportFrame, before.supportFrame, "right-clicking the Blaster does not remove or rotate the supporting Frame");
    assert.equal(after.selectedPart, before.selectedPart, "right-click does not change selected palette part");
    assert.equal(after.previewRotation, before.previewRotation, "right-click does not run the primary rotation path");
    assert.equal(after.physicalHistorySize, before.physicalHistorySize + 1, "right-click removal creates exactly one physical Undo history entry");
    assert.notEqual(await snapshot(page), beforeRightClick, "right-click changes design through removal only");
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "Undo enables after right-click removal");
    assert.equal(await page.locator("#confirmModal").isVisible(), false, "right-click removal does not open confirmation");

    await page.click("#undoBlueprintEditButton");
    await page.waitForFunction((expected) => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring, loadedEditorBlueprintId: window.__mfaState.loadedEditorBlueprintId }) === expected, beforeRightClick, { timeout: 8000 });
    assert.equal(await snapshot(page), beforeRightClick, "Undo restores exact design/Wiring after right-click removal");
    const restoredTarget = await page.evaluate(() => window.__mfaState.design.find((part) => part.type === "blaster" && part.x === 9 && part.y === 8) || null);
    assert.deepEqual(restoredTarget, before.target, "Undo restores the targeted Blaster at its original anchor");
    assert.equal(await page.locator("#confirmModal").isVisible(), false, "Undo after right-click removal does not open confirmation");
  } catch (error) {
    error.message = `${error.message}; right-click removal diagnostics: ${JSON.stringify(await rightClickRemovalDiagnostics(page))}`;
    throw error;
  }
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

async function selectPalettePart(page, { category, type, name, rotatable }) {
  const currentCategory = await page.evaluate(() => window.__mfaState.selectedPartCategory);
  if (currentCategory !== category) {
    const categoryButton = page.locator("#partPalette .part-category-tabs button").filter({ hasText: category });
    await categoryButton.click();
    await page.waitForFunction((expected) => window.__mfaState.selectedPartCategory === expected, category);
  }

  const partButton = page.locator("#partPalette").getByRole("button", { name, exact: true });
  await partButton.waitFor({ state: "visible" });
  const isActive = await partButton.evaluate((button) => button.classList.contains("active"));
  if (!isActive) await partButton.click();

  await page.waitForFunction((expected) => window.__mfaState.selectedPart === expected, type);
  await page.waitForFunction(({ rotatable }) => {
    const indicator = document.querySelector("#rotationIndicator");
    return Boolean(indicator) && (rotatable ? !indicator.hidden : indicator.hidden);
  }, { rotatable });
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
    await assertToolbarGeometryForViewports(page);

    const guide = page.locator("#buildInteractionGuide");
    await assert.equal(await guide.isVisible(), true, "Build interaction guide is visible");
    const buildGuide = await guide.textContent();
    assert.match(buildGuide, /left-click/i);
    assert.match(buildGuide, /Rotate/i);
    assert.match(buildGuide, /right-click/i);
    await assert.equal(await page.locator("#resetButton").innerText(), "Reset Ship", "Reset has visible label");
    await assert.equal(await page.locator("#clearGridButton").innerText(), "Clear Ship", "Clear has visible label");

    const indicator = page.locator("#rotationIndicator");
    const beforeRotation = await indicator.textContent();
    await page.keyboard.press("R");
    await page.waitForFunction((prior) => document.querySelector("#rotationIndicator")?.textContent !== prior, beforeRotation);
    assert.match(await indicator.textContent(), /Rotation: \d+°/);

    const beforeBuildPlace = await snapshot(page);
    await page.locator('.build-cell[data-x="9"][data-y="8"]').click();
    assert.notEqual(await snapshot(page), beforeBuildPlace, "Build placement changes design");
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "Undo enables after Build edit");
    await assertToolbarGeometry(page, "after-undo-enabled");
    const gridStableBefore = await page.locator("#buildGrid").boundingBox();
    const cellStableBefore = await page.locator('.build-cell[data-x="7"][data-y="7"]').boundingBox();
    await page.click("#resetButton");
    assert.match(await page.locator("#confirmModalTitle").textContent(), /Reset/i, "Reset click opens Reset confirmation, not Clear");
    await page.click("#confirmCancelButton");
    await page.click("#clearGridButton");
    assert.match(await page.locator("#confirmModalTitle").textContent(), /Clear/i, "Clear click opens Clear confirmation, not Reset");
    await page.click("#confirmCancelButton");
    for (const id of ["#undoBlueprintEditButton", "#resetButton", "#clearGridButton"]) await page.focus(id);
    const gridStableAfter = await page.locator("#buildGrid").boundingBox();
    const cellStableAfter = await page.locator('.build-cell[data-x="7"][data-y="7"]').boundingBox();
    assert.ok(Math.abs(gridStableBefore.x - gridStableAfter.x) < 1 && Math.abs(gridStableBefore.y - gridStableAfter.y) < 1, "toolbar focus/confirmation does not move grid");
    assert.ok(Math.abs(cellStableBefore.x - cellStableAfter.x) < 1 && Math.abs(cellStableBefore.y - cellStableAfter.y) < 1, "toolbar focus/confirmation does not move cells");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await page.locator("#confirmModal").isVisible(), false, "Undo click does not open Reset/Clear confirmation");
    assert.equal(await snapshot(page), beforeBuildPlace, "Undo click routes to Undo after toolbar hit-test checks");
    await page.locator('.build-cell[data-x="9"][data-y="8"]').click();

    await setMode(page, "heat");
    assert.equal(await page.locator("#partPalette .part-button").first().isVisible(), true, "palette remains visible in Heat");
    const heatGuide = await guide.textContent();
    assert.match(heatGuide, /left-click/i);
    assert.match(heatGuide, /Hover to inspect Heat/i);
    assert.doesNotMatch(heatGuide, /right-click removal|right-click to remove/i);
    assert.equal(await indicator.isVisible(), true, "rotation indicator is visible in Heat");
    await selectPalettePart(page, { category: "Structure", type: "armor", name: "Armor", rotatable: false });
    const beforeHeatPlace = await snapshot(page);
    await clearHistory(page);
    await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
    assert.notEqual(await snapshot(page), beforeHeatPlace, "Heat placement changes physical design");
    assert.equal(await page.evaluate(() => window.__mfaState.blueprintView), "heat", "view remains Heat after edit");
    assert.equal(await page.locator("#heatToolbar").isVisible(), true, "Heat UI remains rendered");
    assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "Undo enables after Heat edit");
    await page.click("#undoBlueprintEditButton");
    assert.equal(await snapshot(page), beforeHeatPlace, "Undo restores exact design/Wiring after Heat edit");

    await selectPalettePart(page, { category: "Weapons", type: "blaster", name: "Blaster", rotatable: true });
    await assertHeatRotationUpdates(page);

    await setMode(page, "wiring");
    const beforeWiringClick = await snapshot(page);
    const wiringSelectedPart = await page.evaluate(() => window.__mfaState.selectedPart);
    const wiringCategory = await page.evaluate(() => window.__mfaState.selectedPartCategory);
    await page.locator("#blueprintPaletteLockedNotice").waitFor({ state: "visible" });
    assert.match(await page.locator("#blueprintPaletteLockedNotice").textContent(), /Component placement paused in Wiring mode/);
    assert.equal(await page.locator("#partPalette .part-category-tabs button").first().isDisabled(), true, "Wiring locks palette categories");
    assert.equal(await page.locator("#partPalette .part-button").first().isDisabled(), true, "Wiring locks palette parts");
    await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
    assert.equal(await snapshot(page), beforeWiringClick, "Wiring click does not place physical component");
    assert.equal(await page.evaluate(() => window.__mfaState.selectedPart), wiringSelectedPart, "Wiring preserves selected physical component");
    assert.equal(await page.evaluate(() => window.__mfaState.selectedPartCategory), wiringCategory, "Wiring preserves selected category");
    assert.equal(await guide.isVisible(), false, "physical guide hidden in Wiring");
    assert.equal(await indicator.isVisible(), false, "rotation indicator hidden in Wiring");

    await setMode(page, "build");
    await selectPalettePart(page, { category: "Structure", type: "frame", name: "Frame", rotatable: false });
    await assertRightClickRemovesPlacedBlaster(page);

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
