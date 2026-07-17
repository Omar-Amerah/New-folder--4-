#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { mkdirSync, readFileSync } = require("fs");
const { isDeepStrictEqual } = require("util");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

async function editorState(page) {
  return page.evaluate(async () => {
    const { state } = await import("/src/state.js");
    return { wiring: structuredClone(state.wiring), ui: structuredClone(state.wiringUi) };
  });
}

async function svgLineScreenPoint(locator, fraction = 0.5) {
  return locator.evaluate((element, t) => {
    const svg = element.ownerSVGElement;
    const matrix = element.getScreenCTM();
    if (!svg || !matrix) throw new Error("SVG line has no screen transformation matrix");
    const x1 = Number(element.getAttribute("x1")); const y1 = Number(element.getAttribute("y1"));
    const x2 = Number(element.getAttribute("x2")); const y2 = Number(element.getAttribute("y2"));
    const point = svg.createSVGPoint(); point.x = x1 + (x2 - x1) * t; point.y = y1 + (y2 - y1) * t;
    const screen = point.matrixTransform(matrix);
    return { x: screen.x, y: screen.y, svgX: point.x, svgY: point.y };
  }, fraction);
}

async function wiringGridPointToScreen(svgLocator, gridX, gridY) {
  return svgLocator.evaluate((svg, point) => {
    if (!(svg instanceof SVGSVGElement)) throw new Error("Expected the Wiring overlay SVG");
    const matrix = svg.getScreenCTM();
    if (!matrix) throw new Error("Wiring SVG has no screen transformation matrix");
    const svgPoint = svg.createSVGPoint(); svgPoint.x = point.gridX + .5; svgPoint.y = point.gridY + .5;
    const screen = svgPoint.matrixTransform(matrix);
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) throw new Error("Calculated non-finite Wiring screen coordinates");
    return { x: screen.x, y: screen.y };
  }, { gridX, gridY });
}

async function hitAt(page, point) {
  return page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y); const section = element?.closest?.("[data-section-id]");
    const port = element?.closest?.("[data-wiring-port-kind]"); const group = element?.closest?.("svg > g");
    return { tagName: element?.tagName || null, className: element?.getAttribute?.("class") || null,
      sectionId: section?.dataset?.sectionId || null,
      wiringPortKind: port?.dataset?.wiringPortKind || null,
      wiringComponentIndex: port?.dataset?.wiringComponentIndex || null,
      parentGroupClass: group?.getAttribute?.("class") || null,
      pointerEvents: element ? getComputedStyle(element).pointerEvents : null,
      componentIndex: element?.closest?.("[data-part-index]")?.dataset?.partIndex || null,
      insideGrid: Boolean(element?.closest?.("#buildGrid, .build-grid")),
      insideWiringOverlay: Boolean(element?.closest?.("#wiringOverlayHost")),
      insideStatusPanel: Boolean(element?.closest?.("#wiringStatusPanel")),
      insideModal: Boolean(element?.closest?.('[role="dialog"], .modal')) };
  }, point);
}

async function assertPointInsideSvg(svgLocator, point) {
  const bounds = await svgLocator.boundingBox();
  assert.ok(bounds, "Wiring SVG has no bounding box");
  assert.ok(point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height,
    `Point ${JSON.stringify(point)} is outside Wiring SVG bounds ${JSON.stringify(bounds)}`);
  return bounds;
}

async function wiringDiagnostics(page, svgLocator, grid, point, screenshotName) {
  mkdirSync("test-artifacts/wiring-browser", { recursive: true });
  const screenshotPath = `test-artifacts/wiring-browser/${screenshotName}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const [bounds, svgGeometry, hit, state, fixture] = await Promise.all([
    svgLocator.boundingBox(),
    svgLocator.evaluate((svg) => ({ viewBox: svg.getAttribute("viewBox"),
      svgChildOrder: [...svg.children].map((child) => child.getAttribute("class")),
      matrix: (() => { const m = svg.getScreenCTM(); return m && { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f }; })() })),
    hitAt(page, point), editorState(page),
    page.evaluate(async () => structuredClone((await import("/src/state.js")).state.design))
  ]);
  return { intendedGridCoordinate: grid, viewportCoordinate: point, svgBounds: bounds, ...svgGeometry, hit,
    activeMode: state.ui.mode, activePath: state.ui.path,
    physicalSectionIds: state.wiring[state.ui.mode].sections.map((section) => section.id),
    fixtureComponentPositions: fixture.map(({ x, y, type, rotation }) => ({ x, y, type, rotation })), screenshotPath };
}

async function assertPortHit(page, svgLocator, grid, kind, componentIndex, screenshotName) {
  const point = await wiringGridPointToScreen(svgLocator, grid.x, grid.y);
  const hit = await hitAt(page, point);
  if (hit.wiringPortKind !== kind || Number(hit.wiringComponentIndex) !== componentIndex) {
    const diagnostic = await wiringDiagnostics(page, svgLocator, grid, point, screenshotName);
    assert.fail(`Source port did not win cable overlap hit testing: ${JSON.stringify(diagnostic)}`);
  }
  assert.equal(hit.parentGroupClass, "wire-port-layer", "source port belongs to the final SVG layer");
  return { point, hit };
}

async function assertFixturePort(page, grid, kind, componentIndex) {
  const selector = `[data-wiring-port-kind="${kind}"][data-wiring-cell-x="${grid.x}"][data-wiring-cell-y="${grid.y}"]`;
  const port = page.locator(selector);
  await port.waitFor({ state: "attached", timeout: 3_000 });
  assert.equal(await port.count(), 1, `fixture has exactly one ${kind} port at ${grid.x},${grid.y}`);
  const details = await port.evaluate((element) => ({
    parentClass: element.parentElement?.getAttribute("class"),
    pointerEvents: getComputedStyle(element).pointerEvents,
    componentIndex: element.dataset.wiringComponentIndex
  }));
  assert.equal(details.parentClass, "wire-port-layer", `fixture ${kind} port belongs to .wire-port-layer`);
  assert.notEqual(details.pointerEvents, "none", `fixture ${kind} port permits pointer interaction`);
  assert.equal(Number(details.componentIndex), componentIndex, `fixture ${kind} port belongs to component ${componentIndex}`);
  return port;
}

async function assertGridTargetActionable(page, svgLocator, grid, point) {
  await assertPointInsideSvg(svgLocator, point);
  const hit = await hitAt(page, point);
  const actionable = hit.insideGrid || hit.insideWiringOverlay;
  if (!actionable || hit.insideModal || hit.insideStatusPanel) {
    const diagnostic = await wiringDiagnostics(page, svgLocator, grid, point, `grid-hit-failure-${grid.x}-${grid.y}`);
    assert.fail(`Wiring grid coordinate has no actionable hit target: ${JSON.stringify(diagnostic)}`);
  }
  return hit;
}

async function clickWiringGridPoint(page, svgLocator, x, y) {
  const point = await wiringGridPointToScreen(svgLocator, x, y);
  await assertGridTargetActionable(page, svgLocator, { x, y }, point);
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  return point;
}

async function assertActivePath(page, svgLocator, grid, point, expected, message) {
  const actual = (await editorState(page)).ui.path;
  if (!isDeepStrictEqual(actual, expected)) {
    const diagnostic = await wiringDiagnostics(page, svgLocator, grid, point, `path-failure-${grid.x}-${grid.y}`);
    assert.deepEqual(actual, expected, `${message}: ${JSON.stringify(diagnostic)}`);
  }
}

async function assertSectionHit(page, locator, expectedSectionId, fraction = 0.5) {
  const point = await svgLineScreenPoint(locator, fraction);
  const [hit, geometry] = await Promise.all([hitAt(page, point), locator.evaluate((element) => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      pointerEvents: style.pointerEvents, stroke: style.stroke, strokeWidth: style.strokeWidth, fill: style.fill };
  })]);
  if (hit.sectionId !== expectedSectionId) {
    mkdirSync("test-artifacts/wiring-browser", { recursive: true });
    const screenshotPath = `test-artifacts/wiring-browser/hit-failure-${expectedSectionId.replaceAll(",", "_").replace(":", "-")}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const state = await editorState(page);
    assert.equal(hit.sectionId, expectedSectionId, `SVG cable hit-test failed: ${JSON.stringify({ expectedSectionId,
      svgCoordinates: { x: point.svgX, y: point.svgY }, viewportCoordinates: { x: point.x, y: point.y }, geometry, hit, state, screenshotPath })}`);
  }
  return { point, hit, geometry };
}

(async () => {
  try {
    const source = readFileSync(__filename, "utf8");
    const staleSelectorPrefix = ".build-cell[data-" + "x=";
    assert.equal(source.includes(staleSelectorPrefix), false, "browser verification must not use build-cell coordinate selectors");
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, hasTouch: true });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const [{ state }, designer, wiring] = await Promise.all([
        import("/src/state.js"), import("/src/ui/designerUi.js"), import("/src/ui/wiringUi.js")
      ]);
      document.querySelector("#blueprintDesignerScreen").hidden = false;
      state.design = [
        { x: 5, y: 5, type: "auxGenerator", rotation: 0 },
        { x: 6, y: 5, type: "frame", rotation: 0 },
        { x: 7, y: 5, type: "shield", rotation: 0 },
        { x: 6, y: 6, type: "frame", rotation: 0 },
        { x: 6, y: 7, type: "engine", rotation: 0 }
      ];
      state.design.push(
        { x: 9, y: 5, type: "sensorArray", rotation: 0 },
        { x: 10, y: 5, type: "frame", rotation: 0 }
      );
      state.wiring = WiringRules.addPath(WiringRules.emptyWiring(), "power", [
        { x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }
      ], state.design, (await import("/src/design/parts.js")).PART_STATS);
      state.wiring = WiringRules.addPath(state.wiring, "data", [
        { x: 9, y: 5 }, { x: 10, y: 5 }
      ], state.design, (await import("/src/design/parts.js")).PART_STATS);
      wiring.resetWiringEditorState();
      designer.renderBuildGrid();
      designer.setBlueprintView("wiring");
    });

    const svg = page.locator(".wiring-overlay-host svg.wiring-overlay");
    await svg.waitFor({ state: "visible", timeout: 5_000 });
    assert.equal(await svg.count(), 1, "fixture renders exactly one Wiring overlay SVG");
    assert.deepEqual(await svg.locator(":scope > g").evaluateAll((groups) => groups.map((group) => group.getAttribute("class"))),
      ["wire-visible-layer", "wire-hit-layer", "wire-marker-layer", "wire-indicator-layer", "wire-port-layer"],
      "overlay recreates the explicit paint and hit-test layer order");
    await page.evaluate(async () => {
      const [{ state }, { PART_STATS }] = await Promise.all([import("/src/state.js"), import("/src/design/parts.js")]);
      const fail = (condition, message) => { if (!condition) throw new Error(`Wiring fixture error: ${message}`); };
      const powerSource = state.design[0];
      const dataSource = state.design[5];
      state.design.forEach((component, index) => fail(Object.prototype.hasOwnProperty.call(PART_STATS, component.type),
        `component ${index} type ${component.type} does not exist in the active component catalogue`));
      fail(WiringRules.isPowerSourceType(powerSource.type), `${powerSource.type} is not a recognised Power source`);
      fail(WiringRules.isDataSourceType(dataSource.type), `${dataSource.type} is not a recognised Data source`);
      const occupied = new Map();
      state.design.forEach((component, index) => WiringRules.moduleCells(component, PART_STATS).forEach((cell) => {
        const key = WiringRules.cellKey(cell.x, cell.y);
        fail(!occupied.has(key), `components ${occupied.get(key)} and ${index} overlap at ${key}`);
        occupied.set(key, index);
      }));
      const physicalSections = new Set(state.wiring.power.sections.map((section) => section.id));
      ["5,5:6,5", "6,5:7,5"].forEach((id) => fail(physicalSections.has(id), `expected physical Power cable section ${id} is missing`));
    });
    await assertFixturePort(page, { x: 5, y: 5 }, "power", 0);
    await assertFixturePort(page, { x: 9, y: 5 }, "data", 5);
    const fixture = await page.evaluate(async () => structuredClone((await import("/src/state.js")).state.design));
    const targetModule = fixture[1];
    assert.deepEqual({ x: targetModule.x, y: targetModule.y }, { x: 6, y: 5 }, "fixture target remains the intended occupied cell");
    assert.ok(targetModule.x >= 0 && targetModule.x < 15 && targetModule.y >= 0 && targetModule.y < 15, "fixture target is inside the 15x15 grid");
    assert.equal(Math.abs(targetModule.x - fixture[0].x) + Math.abs(targetModule.y - fixture[0].y), 1,
      "fixture target is orthogonally adjacent to the source");
    assert.equal(await page.evaluate(async ({ index, x, y }) => {
      const [{ state }, { PART_STATS }] = await Promise.all([import("/src/state.js"), import("/src/design/parts.js")]);
      return WiringRules.moduleCells(state.design[index], PART_STATS).some((cell) => cell.x === x && cell.y === y);
    }, { index: 1, x: targetModule.x, y: targetModule.y }), true, "fixture target is occupied under authoritative footprint rules");
    const hit = page.locator('.wire-hit[data-section-id="5,5:6,5"]');
    const horizontal = await assertSectionHit(page, hit, "5,5:6,5");
    assert.equal(horizontal.geometry.rect.height, 0, "horizontal SVG line exposes the zero-height box that locator actionability rejects");
    assert.equal(horizontal.geometry.pointerEvents, "stroke", "the widened line receives pointer events");
    assert.ok(Number.parseFloat(horizontal.geometry.strokeWidth) >= .4, "the hit stroke is wide enough for real pointer input");
    await page.mouse.click(horizontal.point.x, horizontal.point.y);
    let snapshot = await editorState(page);
    assert.equal(snapshot.ui.selectedSectionId, "5,5:6,5", "click selects the physical section");
    assert.equal(snapshot.ui.sourceIndex, null, "click does not enter branch drawing");
    assert.equal(await page.locator('[data-wiring-action="remove-section"]').count(), 1, "section controls are visible");

    const junction = page.locator(".wire-junction");
    assert.equal(await junction.count(), 0, "straight fixture initially has no junction");
    const emptyPoint = await wiringGridPointToScreen(svg, 1, 1); const emptyTarget = await assertGridTargetActionable(page, svg, { x: 1, y: 1 }, emptyPoint);
    assert.equal(emptyTarget.sectionId, null, "empty grid space does not resolve to a cable hit target");
    assert.ok(emptyTarget.insideGrid, "empty overlay space reaches the designer grid surface");
    await page.mouse.move(emptyPoint.x, emptyPoint.y); await page.mouse.click(emptyPoint.x, emptyPoint.y);
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.selectedSectionId, null, "empty overlay space reaches the underlying grid");

    const { point: portPoint, hit: portTarget } = await assertPortHit(page, svg, { x: 5, y: 5 }, "power", 0, "power-port-overlap-failure");
    assert.match(portTarget.className, /\bwire-port-power\b/, "source ports win hit testing where they overlap a cable");
    await page.mouse.move(portPoint.x, portPoint.y); await page.mouse.click(portPoint.x, portPoint.y);
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.sourceIndex, 0, "real pointer activation of a source port starts drawing");
    assert.deepEqual(snapshot.ui.path, [{ x: 5, y: 5 }], "Power source click starts the canonical click-step path");
    const sharedEndpointPoint = await wiringGridPointToScreen(svg, targetModule.x, targetModule.y);
    const sharedEndpointHit = await hitAt(page, sharedEndpointPoint);
    assert.ok(["5,5:6,5", "6,5:7,5"].includes(sharedEndpointHit.sectionId),
      "the regression click intentionally lands on either cable hit target sharing the canonical endpoint");
    const horizontalDestination = await clickWiringGridPoint(page, svg, targetModule.x, targetModule.y);
    await assertActivePath(page, svg, { x: targetModule.x, y: targetModule.y }, horizontalDestination,
      [{ x: 5, y: 5 }, { x: 6, y: 5 }], "horizontal click-step extends through the fixture target");
    await clickWiringGridPoint(page, svg, fixture[2].x, fixture[2].y);
    await clickWiringGridPoint(page, svg, fixture[2].x, fixture[2].y);
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.sourceIndex, null, "clicking the existing destination endpoint again completes the Power path");

    await page.mouse.click(portPoint.x, portPoint.y);
    await clickWiringGridPoint(page, svg, targetModule.x, targetModule.y);
    const verticalDestination = await clickWiringGridPoint(page, svg, fixture[3].x, fixture[3].y);
    await assertActivePath(page, svg, { x: fixture[3].x, y: fixture[3].y }, verticalDestination,
      [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 6, y: 6 }], "vertical click-step extends the active cable preview");
    assert.equal(await page.locator('[data-wiring-action="cancel-drawing"]').count(), 1, "active paths expose Cancel drawing");
    const savedBeforeCancel = (await editorState(page)).wiring.power.sections.length;
    await page.locator('[data-wiring-action="cancel-drawing"]').click();
    snapshot = await editorState(page);
    assert.equal(snapshot.wiring.power.sections.length, savedBeforeCancel, "cancel leaves saved sections unchanged");
    assert.equal(snapshot.ui.sourceIndex, null); assert.deepEqual(snapshot.ui.path, []); assert.equal(snapshot.ui.activeOrigin, null);

    const nearPort = await assertSectionHit(page, page.locator('.wire-hit[data-section-id="5,5:6,5"]'), "5,5:6,5", .14);
    await page.mouse.click(nearPort.point.x, nearPort.point.y);
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.selectedSectionId, "5,5:6,5", "cable remains selectable immediately outside the port radius");

    await page.locator("#wiringModeData").click();
    const dataOverlap = await assertPortHit(page, svg, { x: 9, y: 5 }, "data", 5, "data-port-overlap-failure");
    assert.match(dataOverlap.hit.className, /\bwire-port-data\b/, "Data source ports also win cable overlaps");
    await page.touchscreen.tap(dataOverlap.point.x, dataOverlap.point.y);
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.sourceIndex, 5, "touch tapping an overlapping Data port starts drawing");
    assert.equal(snapshot.ui.selectedSectionId, null, "the Data cable under the port is not selected");
    await page.locator('[data-wiring-action="cancel-drawing"]').click();
    await page.locator("#wiringModePower").click();

    // Mouse drag starts only after the threshold and uses the nearest canonical endpoint.
    const dragHit = page.locator('.wire-hit[data-section-id="6,5:7,5"]');
    const from = (await assertSectionHit(page, dragHit, "6,5:7,5", 0.08)).point;
    const to = await wiringGridPointToScreen(svg, fixture[3].x, fixture[3].y);
    await assertGridTargetActionable(page, svg, { x: fixture[3].x, y: fixture[3].y }, to);
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
    snapshot = await editorState(page);
    assert.ok(snapshot.wiring.power.sections.some((section) => section.id === "6,5:6,6"), "drag commits a branch section");
    assert.equal(new Set(snapshot.wiring.power.sections.map((section) => section.id)).size, snapshot.wiring.power.sections.length, "drag does not duplicate shared sections");
    assert.ok(snapshot.wiring.power.sections.some((section) => section.id === "6,5:7,5"), "original trunk remains");
    assert.equal(await page.locator(".wire-junction").evaluate((node) => getComputedStyle(node).pointerEvents), "none", "junction cannot steal selection");
    const junctionPoint = await wiringGridPointToScreen(svg, 6, 5); const junctionTarget = await hitAt(page, junctionPoint);
    assert.doesNotMatch(junctionTarget.className, /\bwire-junction\b/, "junction marker does not steal the intended actionable element");
    assert.ok(junctionTarget.sectionId || /\bwire-port\b/.test(junctionTarget.className), "junction centre reaches an actionable cable or port");

    const branchHit = page.locator('.wire-hit[data-section-id="6,5:6,6"]');
    const vertical = await assertSectionHit(page, branchHit, "6,5:6,6");
    assert.equal(vertical.geometry.rect.width, 0, "vertical SVG line exposes the zero-width box that locator actionability rejects");
    await page.mouse.click(vertical.point.x, vertical.point.y);
    const countBeforeRemove = snapshot.wiring.power.sections.length;
    await page.locator('[data-wiring-action="remove-branch"]').click();
    snapshot = await editorState(page);
    assert.equal(snapshot.wiring.power.sections.length, countBeforeRemove - 1, "Remove branch removes only the leaf");
    assert.ok(snapshot.wiring.power.sections.some((section) => section.id === "6,5:7,5"));
    await page.locator("#wiringUndoButton").click();
    assert.equal((await editorState(page)).wiring.power.sections.length, countBeforeRemove, "Undo restores the branch");

    const restoredBranch = page.locator('.wire-hit[data-section-id="6,5:6,6"]');
    const restoredPoint = (await assertSectionHit(page, restoredBranch, "6,5:6,6")).point;
    await page.mouse.click(restoredPoint.x, restoredPoint.y, { button: "right" });
    snapshot = await editorState(page);
    assert.equal(snapshot.wiring.power.sections.length, countBeforeRemove - 1, "right click removes exactly one section");
    await page.locator("#wiringUndoButton").click();
    assert.equal((await editorState(page)).wiring.power.sections.length, countBeforeRemove, "Undo restores a right-click removal");

    // Touch/click-step equivalent: select, branch visibly, then cancel without hover or drag.
    const rerenderedTrunk = page.locator('.wire-hit[data-section-id="5,5:6,5"]');
    const rerenderedPoint = (await assertSectionHit(page, rerenderedTrunk, "5,5:6,5")).point;
    await page.mouse.click(rerenderedPoint.x, rerenderedPoint.y);
    await page.locator('[data-wiring-action="branch-a"]').click();
    assert.notEqual((await editorState(page)).ui.sourceIndex, null, "Branch from A supports tap/click-step input");
    await page.locator('[data-wiring-action="cancel-drawing"]').click();
    assert.equal((await editorState(page)).ui.sourceIndex, null);
    const rerenderedOverlap = await assertPortHit(page, svg, { x: 5, y: 5 }, "power", 0, "rerendered-port-overlap-failure");
    assert.match(rerenderedOverlap.hit.className, /\bwire-port-power\b/, "port remains topmost after selection, drawing, branch, and undo rerenders");
    mkdirSync("test-artifacts/wiring-browser", { recursive: true });
    await page.screenshot({ path: "test-artifacts/wiring-browser/final.png", fullPage: true });
    console.log("Wiring editor browser interaction verification passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
