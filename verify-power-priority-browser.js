#!/usr/bin/env node
"use strict";
// Section 7C-4 — Blueprint Designer Power Priority controls, exercised in a real
// browser: panel visibility, preset choices, six separate category labels, tied
// named-preset display, Custom reordering with Up/Down disabled states, the
// authoritative policy update path, Blueprint Undo, and no-op handling.
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
async function panelHtml(page) { return page.locator('[data-wiring-panel="power-priority"]').innerHTML(); }

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const designer = await import("/src/ui/designerUi.js");
      document.querySelector("#blueprintDesignerScreen").hidden = false;
      designer.renderBuildGrid();
    });
    await page.locator("#blueprintWiringTab").click();
    const panel = page.locator('[data-wiring-panel="power-priority"]');
    await panel.waitFor({ state: "attached", timeout: 5000 });
    assert.equal(await panel.count(), 1, "Power Priority panel is present in the Power Wiring view");

    // All five preset choices, six separate category labels.
    for (const preset of ["balanced", "defensive", "offensive", "mobility", "custom"]) {
      assert.equal(await page.locator(`[data-wiring-action="power-preset"][data-preset="${preset}"]`).count(), 1, `${preset} preset control present`);
    }
    let html = await panelHtml(page);
    for (const label of ["Command &amp; Control", "Propulsion", "Shields", "Point Defence", "Weapons", "Cooling &amp; Support"]) {
      assert.ok(html.includes(label), `label ${label} shown`);
    }
    assert.ok(!/>\s*Defence\s*</.test(html), "no combined Defence label");

    // Default Balanced ties Shields and Point Defence at the same priority number.
    let s = await policyState(page);
    assert.equal(s.preset, "balanced", "new Blueprint starts Balanced");
    assert.ok(/data-priority-band="3" data-category="shields"/.test(html), "shields at priority 3");
    assert.ok(/data-priority-band="3" data-category="pointDefence"/.test(html), "point defence at priority 3");
    assert.ok(html.includes("power-priority-tied"), "tie indicated");
    assert.ok(html.includes("data-power-priority-diagnostics"), "solver diagnostics rendered");

    // Selecting a named preset commits one Blueprint edit and switches the preset.
    await page.locator('[data-wiring-action="power-preset"][data-preset="defensive"]').click();
    s = await policyState(page);
    assert.equal(s.preset, "defensive", "clicking Defensive switches the preset");
    assert.equal(s.undoDepth, 1, "one Blueprint Undo entry created");

    await page.locator('[data-wiring-action="power-preset"][data-preset="offensive"]').click();
    s = await policyState(page);
    assert.equal(s.preset, "offensive", "clicking Offensive switches the preset");
    assert.equal(s.undoDepth, 2, "second Blueprint Undo entry");
    html = await panelHtml(page);
    // Offensive must not tie Point Defence with Weapons.
    assert.ok(!/data-priority-band="(\d+)" data-category="pointDefence"[\s\S]*?data-priority-band="\1" data-category="weapons"/.test(html)
      && !/data-priority-band="(\d+)" data-category="weapons"[\s\S]*?data-priority-band="\1" data-category="pointDefence"/.test(html),
      "Offensive shows Point Defence and Weapons at different priorities");

    // Switch to Custom: six independently ordered rows with Up/Down controls.
    await page.locator('[data-wiring-action="power-preset"][data-preset="custom"]').click();
    s = await policyState(page);
    assert.equal(s.preset, "custom", "Custom preset activates");
    assert.equal(await page.locator("[data-custom-row]").count(), 6, "six independently ordered custom rows");
    assert.equal(await page.locator('[data-wiring-action="power-priority-move"]').count(), 12, "two move controls per row");
    const firstCat = s.customOrder[0]; const lastCat = s.customOrder[s.customOrder.length - 1];
    assert.equal(await page.locator(`[data-wiring-action="power-priority-move"][data-category="${firstCat}"][data-direction="up"]`).isDisabled(), true, "Up disabled on first row");
    assert.equal(await page.locator(`[data-wiring-action="power-priority-move"][data-category="${lastCat}"][data-direction="down"]`).isDisabled(), true, "Down disabled on last row");

    // Move Shields up independently of Point Defence.
    const shieldsIndexBefore = s.customOrder.indexOf("shields");
    const pdIndexBefore = s.customOrder.indexOf("pointDefence");
    await page.locator('[data-wiring-action="power-priority-move"][data-category="shields"][data-direction="up"]').click();
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
    await page.locator('[data-wiring-action="power-preset"][data-preset="custom"]').click();
    assert.equal((await policyState(page)).undoDepth, beforeNoop, "re-selecting the active preset creates no Undo entry");

    // The policy persists on the Blueprint wiring and survives a reload.
    await page.locator('[data-wiring-action="power-preset"][data-preset="mobility"]').click();
    assert.equal((await policyState(page)).preset, "mobility", "Mobility applied");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.evaluate(async () => { document.querySelector("#blueprintDesignerScreen").hidden = false; (await import("/src/ui/designerUi.js")).renderBuildGrid(); });
    await page.locator("#blueprintWiringTab").click();
    await page.locator('[data-wiring-panel="power-priority"]').waitFor({ state: "attached", timeout: 5000 });
    assert.equal((await policyState(page)).preset, "mobility", "saved policy persists across reload");

    console.log("Power priority browser interaction verification passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
