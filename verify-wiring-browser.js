#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { mkdirSync } = require("fs");
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

(async () => {
  try {
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
        { x: 5, y: 5, type: "reactor", rotation: 0 },
        { x: 6, y: 5, type: "frame", rotation: 0 },
        { x: 7, y: 5, type: "shield", rotation: 0 },
        { x: 6, y: 6, type: "frame", rotation: 0 },
        { x: 6, y: 7, type: "engine", rotation: 0 }
      ];
      state.wiring = WiringRules.addPath(WiringRules.emptyWiring(), "power", [
        { x: 5, y: 5 }, { x: 6, y: 5 }, { x: 7, y: 5 }
      ], state.design, (await import("/src/design/parts.js")).PART_STATS);
      wiring.resetWiringEditorState();
      designer.renderBuildGrid();
      designer.setBlueprintView("wiring");
    });

    const hit = page.locator('.wire-hit[data-section-id="5,5:6,5"]');
    await hit.click({ position: { x: 8, y: 2 } });
    let snapshot = await editorState(page);
    assert.equal(snapshot.ui.selectedSectionId, "5,5:6,5", "click selects the physical section");
    assert.equal(snapshot.ui.sourceIndex, null, "click does not enter branch drawing");
    assert.equal(await page.locator('[data-wiring-action="remove-section"]').count(), 1, "section controls are visible");
    assert.equal(await hit.evaluate((node) => getComputedStyle(node).pointerEvents), "stroke", "the widened line receives pointer events");
    assert.ok(Number(await hit.getAttribute("stroke-width")) || await hit.evaluate((node) => Number.parseFloat(getComputedStyle(node).strokeWidth)) >= .4);

    const junction = page.locator(".wire-junction");
    assert.equal(await junction.count(), 0, "straight fixture initially has no junction");
    const empty = page.locator('.build-cell[data-x="1"][data-y="1"]');
    await empty.click();
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.selectedSectionId, null, "empty overlay space reaches the underlying grid");

    const reactorBody = page.locator('.build-cell[data-x="5"][data-y="5"]');
    await reactorBody.click({ position: { x: 3, y: 3 } });
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.selectedIndex, 0, "component body remains inspectable");
    assert.equal(snapshot.ui.sourceIndex, null, "component inspection does not start wiring");
    const portButton = page.locator('.wire-port-power[data-wiring-component-index="0"]').first();
    await portButton.focus(); await page.keyboard.press("Enter");
    snapshot = await editorState(page);
    assert.equal(snapshot.ui.sourceIndex, 0, "keyboard activation of a source port starts drawing");
    await page.locator('.build-cell[data-x="6"][data-y="5"]').click();
    assert.equal(await page.locator('[data-wiring-action="cancel-drawing"]').count(), 1, "active paths expose Cancel drawing");
    const savedBeforeCancel = (await editorState(page)).wiring.power.sections.length;
    await page.locator('[data-wiring-action="cancel-drawing"]').click();
    snapshot = await editorState(page);
    assert.equal(snapshot.wiring.power.sections.length, savedBeforeCancel, "cancel leaves saved sections unchanged");
    assert.equal(snapshot.ui.sourceIndex, null); assert.deepEqual(snapshot.ui.path, []); assert.equal(snapshot.ui.activeOrigin, null);

    // Mouse drag starts only after the threshold and uses the nearest canonical endpoint.
    const dragHit = page.locator('.wire-hit[data-section-id="6,5:7,5"]');
    const from = await dragHit.evaluate((node) => { const svg = node.ownerSVGElement; const p = svg.createSVGPoint(); p.x = 6.5; p.y = 5.5; const q = p.matrixTransform(svg.getScreenCTM()); return { x: q.x, y: q.y }; });
    const to = await dragHit.evaluate((node) => { const svg = node.ownerSVGElement; const p = svg.createSVGPoint(); p.x = 6.5; p.y = 6.5; const q = p.matrixTransform(svg.getScreenCTM()); return { x: q.x, y: q.y }; });
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 3 }); await page.mouse.up();
    snapshot = await editorState(page);
    assert.ok(snapshot.wiring.power.sections.some((section) => section.id === "6,5:6,6"), "drag commits a branch section");
    assert.equal(new Set(snapshot.wiring.power.sections.map((section) => section.id)).size, snapshot.wiring.power.sections.length, "drag does not duplicate shared sections");
    assert.ok(snapshot.wiring.power.sections.some((section) => section.id === "6,5:7,5"), "original trunk remains");
    assert.equal(await page.locator(".wire-junction").evaluate((node) => getComputedStyle(node).pointerEvents), "none", "junction cannot steal selection");

    const branchHit = page.locator('.wire-hit[data-section-id="6,5:6,6"]');
    await branchHit.click();
    const countBeforeRemove = snapshot.wiring.power.sections.length;
    await page.locator('[data-wiring-action="remove-branch"]').click();
    snapshot = await editorState(page);
    assert.equal(snapshot.wiring.power.sections.length, countBeforeRemove - 1, "Remove branch removes only the leaf");
    assert.ok(snapshot.wiring.power.sections.some((section) => section.id === "6,5:7,5"));
    await page.locator("#wiringUndoButton").click();
    assert.equal((await editorState(page)).wiring.power.sections.length, countBeforeRemove, "Undo restores the branch");

    await page.locator('.wire-hit[data-section-id="6,5:6,6"]').click({ button: "right" });
    snapshot = await editorState(page);
    assert.equal(snapshot.wiring.power.sections.length, countBeforeRemove - 1, "right click removes exactly one section");
    await page.locator("#wiringUndoButton").click();
    assert.equal((await editorState(page)).wiring.power.sections.length, countBeforeRemove, "Undo restores a right-click removal");

    // Touch/click-step equivalent: select, branch visibly, then cancel without hover or drag.
    await page.locator('.wire-hit[data-section-id="5,5:6,5"]').tap();
    await page.locator('[data-wiring-action="branch-a"]').click();
    assert.notEqual((await editorState(page)).ui.sourceIndex, null, "Branch from A supports tap/click-step input");
    await page.locator('[data-wiring-action="cancel-drawing"]').click();
    assert.equal((await editorState(page)).ui.sourceIndex, null);
    mkdirSync("test-artifacts/wiring-browser", { recursive: true });
    await page.screenshot({ path: "test-artifacts/wiring-browser/final.png", fullPage: true });
    console.log("Wiring editor browser interaction verification passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
