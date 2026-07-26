#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    const before = await page.evaluate(async () => {
      const [{ state }, designer, wiringUi, storage, { PART_STATS }] = await Promise.all([
        import("/src/state.js"),
        import("/src/ui/designerUi.js"),
        import("/src/ui/wiringUi.js"),
        import("/src/design/blueprintStorage.js"),
        import("/src/design/parts.js")
      ]);
      document.querySelector("#blueprintDesignerScreen").hidden = false;
      state.design = [...storage.defaultDesign(), { x: 10, y: 7, type: "fireControl" }, { x: 11, y: 7, type: "railgun" }];
      let next = window.WiringRules.createGeneratedPowerWiring(state.design, PART_STATS);
      next.power.sections = next.power.sections.map((section) => ({ ...section, tier: "heavy" }));
      next = window.WiringRules.addPath(next, "data", [{ x: 10, y: 7 }, { x: 11, y: 7 }], state.design, PART_STATS);
      next.powerPolicy = { preset: "weapons", customOrder: [] };
      state.wiring = window.WiringRules.normalizeWiring(next, state.design, PART_STATS).wiring;
      wiringUi.resetWiringEditorState();
      designer.renderBuildGrid();
      designer.setBlueprintView("wiring");
      wiringUi.refreshWiringPresentation();
      return {
        power: structuredClone(state.wiring.power),
        data: structuredClone(state.wiring.data),
        powerPolicy: structuredClone(state.wiring.powerPolicy)
      };
    });

    const autoWire = page.locator("#wiringAutoWireButton");
    await autoWire.waitFor({ state: "visible" });
    assert.equal(await page.locator('[data-wiring-tool="erase"]').count(), 0, "the Erase toolbar button is removed");
    assert.equal(await autoWire.isDisabled(), false, "Auto-wire is available in Power mode");
    await page.setViewportSize({ width: 320, height: 900 });
    const compactGeometry = await page.evaluate(() => {
      const button = document.querySelector("#wiringAutoWireButton");
      const row = button?.closest(".wiring-action-row");
      const rect = button?.getBoundingClientRect();
      return {
        buttonLeft: rect?.left,
        buttonRight: rect?.right,
        viewportWidth: window.innerWidth,
        buttonClientWidth: button?.clientWidth,
        buttonScrollWidth: button?.scrollWidth,
        rowClientWidth: row?.clientWidth,
        rowScrollWidth: row?.scrollWidth
      };
    });
    assert.ok(compactGeometry.buttonLeft >= 0 && compactGeometry.buttonRight <= compactGeometry.viewportWidth,
      `Auto-wire stays inside the mobile viewport: ${JSON.stringify(compactGeometry)}`);
    assert.ok(compactGeometry.buttonScrollWidth <= compactGeometry.buttonClientWidth + 1,
      `Auto-wire label fits its button: ${JSON.stringify(compactGeometry)}`);
    assert.ok(compactGeometry.rowScrollWidth <= compactGeometry.rowClientWidth + 1,
      `Wiring actions do not overflow their row: ${JSON.stringify(compactGeometry)}`);
    await page.setViewportSize({ width: 1100, height: 900 });
    await autoWire.click();

    const after = await page.evaluate(async () => {
      const [{ state }, { PART_STATS }] = await Promise.all([import("/src/state.js"), import("/src/design/parts.js")]);
      const analysis = window.WiringRules.analyzePowerNetworks(state.design, state.wiring, PART_STATS);
      return {
        tiers: state.wiring.power.sections.map((section) => section.tier),
        data: structuredClone(state.wiring.data),
        powerPolicy: structuredClone(state.wiring.powerPolicy),
        disconnected: analysis.disconnectedConsumerIndices,
        undoDepth: state.wiringUi.undoStack.length
      };
    });
    assert.ok(after.tiers.length > 0, "Auto-wire creates Power cable");
    assert.ok(after.tiers.every((tier) => tier === "standard"), "Auto-wire uses only Standard cable");
    assert.deepStrictEqual(after.disconnected, [], "Auto-wire connects every Power consumer");
    assert.deepStrictEqual(after.data, before.data, "Auto-wire preserves Data wiring");
    assert.deepStrictEqual(after.powerPolicy, before.powerPolicy, "Auto-wire preserves the Power policy");
    assert.equal(after.undoDepth, 1, "Auto-wire creates one undo entry");

    await page.locator("#wiringUndoButton").click();
    const undone = await page.evaluate(async () => structuredClone((await import("/src/state.js")).state.wiring));
    assert.deepStrictEqual(undone.power, before.power, "Undo restores the previous Power wiring");
    assert.deepStrictEqual(undone.data, before.data, "Undo keeps the previous Data wiring");

    await page.locator("#wiringModeData").click();
    assert.equal(await autoWire.isDisabled(), true, "Auto-wire is disabled in Data mode");
    console.log("Auto-wire browser verification passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
