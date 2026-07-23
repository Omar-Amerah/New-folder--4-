#!/usr/bin/env node
"use strict";
// Blueprint Designer Power Priority dropdown, Custom ordering, solver
// diagnostics, the authoritative policy update path, Blueprint Undo and
// persistence, exercised in a real browser.
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

async function policyState(page) {
  return page.evaluate(async () => {
    const [{ state }, history] = await Promise.all([
      import("/src/state.js"),
      import("/src/design/blueprintEditHistory.js")
    ]);
    return {
      preset: state.wiring.powerPolicy?.preset,
      customOrder: structuredClone(state.wiring.powerPolicy?.customOrder || []),
      undoDepth: history.blueprintEditHistorySize(),
      powerSectionCount: state.wiring.power.sections.length
    };
  });
}
async function panelHtml(page) { return page.locator('[data-wiring-panel="power-allocation"]').innerHTML(); }

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const [designer, wiringUi] = await Promise.all([
        import("/src/ui/designerUi.js"),
        import("/src/ui/wiringUi.js")
      ]);
      document.querySelector("#blueprintDesignerScreen").hidden = false;
      wiringUi.bindPowerPriorityControls();
      designer.renderBuildGrid();
      designer.renderLocalStats();
    });
    const select = page.locator("#powerPrioritySelect");
    const movementSelect = page.locator("#combatStyleSelect");
    assert.equal(await select.isVisible(), true, "Power Priority dropdown is visible in the left column");
    const [movementBox, priorityBox] = await Promise.all([movementSelect.boundingBox(), select.boundingBox()]);
    assert.ok(priorityBox.y > movementBox.y + movementBox.height, "Power Priority sits below Combat Movement Style");
    assert.deepEqual(await select.locator("option").evaluateAll((options) => options.map((option) => option.value)), ["balanced", "defensive", "offensive", "mobility", "custom"]);

    await page.locator("#blueprintWiringTab").click();
    const panel = page.locator('[data-wiring-panel="power-allocation"]');
    await panel.waitFor({ state: "attached", timeout: 5000 });
    assert.equal(await panel.count(), 1, "Power Allocation diagnostics remain in the Power Wiring view");
    assert.equal(await page.locator('[data-wiring-action="power-preset"]').count(), 0, "legacy preset button bar is removed");

    // Solver diagnostics still show all six separate category labels.
    let html = await panelHtml(page);
    for (const label of ["Command &amp; Control", "Propulsion", "Shields", "Point Defence", "Weapons", "Cooling &amp; Support"]) {
      assert.ok(html.includes(label), `label ${label} shown`);
    }
    assert.ok(!/>\s*Defence\s*</.test(html), "no combined Defence label");

    let s = await policyState(page);
    assert.equal(s.preset, "balanced", "new Blueprint starts Balanced");
    assert.ok(html.includes("data-power-priority-diagnostics"), "solver diagnostics rendered");

    // Selecting a named preset commits one Blueprint edit and switches the preset.
    await select.selectOption("defensive");
    s = await policyState(page);
    assert.equal(s.preset, "defensive", "selecting Defensive switches the preset");
    assert.equal(s.undoDepth, 1, "one Blueprint Undo entry created");

    await select.selectOption("offensive");
    s = await policyState(page);
    assert.equal(s.preset, "offensive", "selecting Offensive switches the preset");
    assert.equal(s.undoDepth, 2, "second Blueprint Undo entry");

    // Switch to Custom: six independently ordered rows with Up/Down controls.
    await select.selectOption("custom");
    s = await policyState(page);
    assert.equal(s.preset, "custom", "Custom preset activates");
    const customOrder = page.locator("#powerPriorityCustomOrder");
    assert.equal(await customOrder.isVisible(), true, "Custom ordering opens under the dropdown");
    assert.equal(await customOrder.locator("[data-custom-row]").count(), 6, "six independently ordered custom rows");
    assert.equal(await customOrder.locator("[data-power-priority-move]").count(), 12, "two move controls per row");
    const firstCat = s.customOrder[0]; const lastCat = s.customOrder[s.customOrder.length - 1];
    assert.equal(await customOrder.locator(`[data-power-priority-move][data-category="${firstCat}"][data-direction="up"]`).isDisabled(), true, "Up disabled on first row");
    assert.equal(await customOrder.locator(`[data-power-priority-move][data-category="${lastCat}"][data-direction="down"]`).isDisabled(), true, "Down disabled on last row");

    // Move Shields up independently of Point Defence.
    const shieldsIndexBefore = s.customOrder.indexOf("shields");
    const pdIndexBefore = s.customOrder.indexOf("pointDefence");
    await customOrder.locator('[data-power-priority-move][data-category="shields"][data-direction="up"]').click();
    const moved = await policyState(page);
    assert.equal(moved.customOrder.indexOf("shields"), shieldsIndexBefore - 1, "Shields moved up one position");
    assert.equal(moved.customOrder.indexOf("pointDefence"), pdIndexBefore, "Point Defence position unaffected — ordered independently");
    assert.equal(moved.undoDepth, 4, "the reorder is a single additional Blueprint Undo entry");

    // Undo restores the previous Custom order (policy is a Blueprint design edit).
    const undone = await page.evaluate(async () => {
      const designer = await import("/src/ui/designerUi.js");
      designer.undoBlueprintEdit();
      const { state } = await import("/src/state.js");
      return { customOrder: structuredClone(state.wiring.powerPolicy.customOrder) };
    });
    assert.equal(undone.customOrder.indexOf("shields"), shieldsIndexBefore, "Undo restores the Shields position");

    // A no-op preset selection (already Custom) creates no new Undo entry.
    const beforeNoop = (await policyState(page)).undoDepth;
    await select.selectOption("custom");
    assert.equal((await policyState(page)).undoDepth, beforeNoop, "re-selecting the active preset creates no Undo entry");

    // The policy persists on the Blueprint wiring and survives a reload.
    await select.selectOption("mobility");
    assert.equal((await policyState(page)).preset, "mobility", "Mobility applied");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      document.querySelector("#blueprintDesignerScreen").hidden = false;
      const designer = await import("/src/ui/designerUi.js");
      designer.renderBuildGrid();
      designer.renderLocalStats();
    });
    await page.locator("#blueprintWiringTab").click();
    await page.locator('[data-wiring-panel="power-allocation"]').waitFor({ state: "attached", timeout: 5000 });
    assert.equal((await policyState(page)).preset, "mobility", "saved policy persists across reload");
    assert.equal(await page.locator("#powerPrioritySelect").inputValue(), "mobility", "dropdown reflects the saved policy");

    console.log("Power priority browser interaction verification passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
