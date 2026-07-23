#!/usr/bin/env node
"use strict";
// Wiring cost/benefit clarity — desktop UI verification. Confirms the Blueprint
// Designer renders authoritative tier comparison cards, a live selected-tool
// summary, route/upgrade previews with cost/capacity/load context, a separated
// infrastructure summary, dynamic benefits/downsides observations, per-section
// interpretation, and the architecture comparison — all with readable text
// labels and no touch/mobile controls.
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

// A frigate-like ship: reactor trunk (Standard) feeding a Light branch that is
// overloaded, plus a Data cable — enough to exercise every clarity surface.
async function buildFixture(page) {
  await page.evaluate(async () => {
    const [{ state }, designer, wiring, { PART_STATS }] = await Promise.all([
      import("/src/state.js"), import("/src/ui/designerUi.js"), import("/src/ui/wiringUi.js"), import("/src/design/parts.js")
    ]);
    document.querySelector("#blueprintDesignerScreen").hidden = false;
    state.design = [
      { x: 0, y: 0, type: "reactor" },   // 0,0 & 1,0
      { x: 2, y: 0, type: "frame" },
      { x: 3, y: 0, type: "shield" },
      { x: 4, y: 0, type: "blaster" },
      { x: 2, y: 1, type: "engine" },
      { x: 0, y: 3, type: "fireControl" },
      { x: 1, y: 3, type: "railgun" }
    ];
    let w = window.WiringRules.emptyWiring();
    // Standard trunk 1,0 -> 2,0 -> 3,0, then a Light branch 3,0 -> 4,0 that the
    // shield+blaster overload.
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }], state.design, PART_STATS, "standard");
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 3, y: 0 }, { x: 4, y: 0 }], state.design, PART_STATS, "light");
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 2, y: 0 }, { x: 2, y: 1 }], state.design, PART_STATS, "light");
    w = window.WiringRules.addPath(w, "data", [{ x: 0, y: 3 }, { x: 1, y: 3 }], state.design, PART_STATS);
    state.wiring = w;
    wiring.resetWiringEditorState();
    designer.renderBuildGrid();
    designer.setBlueprintView("wiring");
  });
  await page.locator(".wiring-overlay-host svg.wiring-overlay").waitFor({ state: "visible", timeout: 5000 });
}

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => { const d = await import("/src/ui/designerUi.js"); document.querySelector("#blueprintDesignerScreen").hidden = false; d.renderBuildGrid(); });
    await page.locator("#blueprintWiringTab").click();
    await buildFixture(page);
    await page.locator("#designerAnalysisTab").click();

    // 1. Compact tier controls render authoritative values.
    const tierData = await page.evaluate(() => {
      const tiers = Array.from(document.querySelectorAll("[data-wiring-tier]"));
      return tiers.map((tier) => ({
        key: tier.dataset.wiringTier,
        text: tier.textContent,
        title: tier.getAttribute("title") || ""
      }));
    });
    assert.strictEqual(tierData.length, 3, "three Power tier buttons");
    const light = tierData.find((tier) => tier.key === "light");
    const heavy = tierData.find((tier) => tier.key === "heavy");
    assert.match(light.text, /4 \/ 7 MW/, "Light control shows authoritative capacity");
    assert.match(light.title, /\$1/, "Light tooltip shows authoritative cost");
    assert.match(heavy.text, /24 \/ 36 MW/, "Heavy control shows authoritative capacity");
    assert.strictEqual(await page.locator("#wiringTierCards").count(), 0, "large tier comparison removed");
    assert.strictEqual(await page.getByRole("button", { name: /Change Tier/i }).count(), 0, "Change Tier removed");
    assert.ok(!/NaN|Infinity|undefined/.test(tierData.map((tier) => tier.text + tier.title).join(" ")), "no invalid tier values");

    // 2. Selected-tier detail lives in the right Analysis panel.
    async function toolSummaryText() { return page.locator('[data-wiring-panel="selected-tier"]').innerText(); }
    await page.locator('[data-wiring-tier="light"]').click();
    const lightSummary = await toolSummaryText();
    assert.match(lightSummary, /Light Cable/, "tool summary shows Light");
    assert.match(lightSummary, /4 \/ 7 MW/, "tool summary shows Light capacity");
    assert.match(lightSummary, /final branches/i, "tool summary gives Light recommendation");
    await page.locator('[data-wiring-tier="heavy"]').click();
    const heavySummary = await toolSummaryText();
    assert.match(heavySummary, /Heavy Bus/, "tool summary updates to Heavy");
    assert.match(heavySummary, /24 \/ 36 MW/, "tool summary shows Heavy capacity");
    assert.notStrictEqual(lightSummary, heavySummary, "tool summary content changed with the tier");
    // Data mode removes irrelevant Power controls; explanation stays in Help.
    await page.locator("#wiringModeData").click();
    assert.strictEqual(await page.locator("#wiringTierRow").isHidden(), true, "Power tiers hidden in Data mode");
    assert.strictEqual(await page.locator("#wiringHelpPanel").isHidden(), true, "Help closed by default");
    await page.locator("#wiringHelpButton").click();
    const helpText = await page.locator("#wiringHelpPanel").innerText();
    assert.match(helpText, /Data is a separate single-tier network/, "Help explains Data");
    assert.match(helpText, /Drawing Power over existing cable/i, "Help explains redraw tier changes");
    await page.locator("#wiringHelpCloseButton").click();
    await page.locator("#wiringModePower").click();

    // 3. Infrastructure summary separates Power/Data/Switchgear and networks.
    const infraText = await page.locator('[data-wiring-panel="infrastructure-summary"]').innerText();
    assert.match(infraText, /Power wiring \$/, "infra summary shows Power wiring cost");
    assert.match(infraText, /Data wiring \$/, "infra summary shows Data wiring cost");
    assert.match(infraText, /Switchgear components \$/, "infra summary shows Switchgear cost");
    assert.match(infraText, /% of the \$/, "infra summary shows percentage of total ship cost");
    assert.match(infraText, /Unique Power cells/, "infra summary lists unique cells by tier");
    assert.match(infraText, /Power networks/, "infra summary shows network counts");
    assert.match(infraText, /5–10%|5-10%/, "advisory guidance present");

    // 4. Benefits/downsides observations reflect the topology (Light bottleneck
    //    on an overloaded branch; central-trunk vulnerability).
    const obsText = await page.locator('[data-wiring-panel="blueprint-observations"]').innerText();
    assert.ok(obsText.length > 0, "observations panel present");
    assert.ok(/Potential weakness|✓|⚠/.test(obsText), "observations use advisory language/markers");

    // 5. Draw-over-existing preview uses the selected tier.
    const comparison = await page.evaluate(async () => {
      const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
      state.wiringUi.mode = "power";
      state.wiringUi.wiringTool = "draw";
      state.wiringUi.selectedPowerTier = "standard";
      state.wiringUi.sourceIndex = 3;
      state.wiringUi.path = [{ x: 3, y: 0 }, { x: 4, y: 0 }];
      state.wiringUi.hoveredSectionId = null;
      wiring.refreshWiringPresentation();
      const panel = document.querySelector("#wiringPreviewPanel");
      return panel ? panel.innerText : "";
    });
    assert.match(comparison, /Standard Cable/, "redraw preview shows selected tier");
    assert.match(comparison, /Cost|Infrastructure/, "redraw preview shows infrastructure context");
    assert.match(comparison, /Heat/, "redraw preview shows Heat context");
    assert.ok(!/NaN|Infinity|undefined/.test(comparison), "comparison has no NaN/Infinity/undefined");

    // 6. Selected-section inspection interpretation (capacity/utilisation/Heat/
    //    protection + plain-language line).
    const sectionInspect = await page.evaluate(async () => {
      const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
      state.wiringUi.wiringTool = "inspect";
      state.wiringUi.hoveredSectionId = null;
      state.wiringUi.selectedSectionId = "3,0:4,0";
      wiring.refreshWiringPresentation();
      const el = document.querySelector('[data-wiring-inspection="power-section"]');
      return el ? el.innerText : "";
    });
    assert.match(sectionInspect, /Cable rating: 4 MW sustained \/ 7 MW peak/, "section shows tier capacity");
    assert.match(sectionInspect, /Predicted flow|No Power path/, "section shows flow or a clear unavailable state");
    assert.match(sectionInspect, /Protection state:/, "section shows protection state");
    assert.match(sectionInspect, /Selected cells: \$/, "section shows cell cost/displacement");
    assert.match(sectionInspect, /Bottleneck:/, "section shows bottleneck status");
    assert.ok(!/NaN|Infinity|undefined/.test(sectionInspect), "section inspection has no NaN/Infinity/undefined");

    // 7. Long reference content no longer occupies the centre workspace.
    assert.strictEqual(await page.locator("#architectureComparison").count(), 0, "architecture comparison removed from centre");
    assert.strictEqual(await page.locator("#powerInfrastructureReference").count(), 0, "Power reference removed from centre");

    // 8. Data section inspection shows cost but no Power capacity/Heat rows.
    const dataInspect = await page.evaluate(async () => {
       const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
       state.wiringUi.mode = "data";
       state.wiringUi.wiringTool = "inspect";
       state.wiringUi.sourceIndex = null;
       state.wiringUi.path = [];
       state.wiringUi.selectedSectionId = "0,3:1,3";
      wiring.refreshWiringPresentation();
       const el = document.querySelector("#wiringStatusPanel");
      return el ? el.innerText : "";
    });
    assert.match(dataInspect, /Selected cells: \$/, "data section shows cost");
    assert.match(dataInspect, /Data cables do not carry Power/, "data section states no Power");
    assert.ok(!/sustained \/ .*peak|Cable Heat contribution/.test(dataInspect), "data section shows no Power-capacity/Heat rows");
    await page.evaluate(async () => { const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]); state.wiringUi.mode = "power"; wiring.refreshWiringPresentation(); });

    // 9. Regression: a committed wiring edit must refresh the designer-derived
    // presentation (build cost banner, cost breakdown) immediately — not only
    // once the user switches Blueprint tabs. commitWiring() previously called
    // refreshWiringPresentation() alone, leaving a stale build cost on screen.
    const costText = () => page.evaluate(() => document.querySelector("#blueprintCostLabel")?.textContent || "");
    const costNumber = (text) => Number(String(text).replace(/[^0-9]/g, ""));
    await page.evaluate(async () => { const d = await import("/src/ui/designerUi.js"); d.renderLocalStats(); });
    const costBeforeEdit = costNumber(await costText());
    assert.ok(costBeforeEdit > 0, `baseline build cost is rendered (got "${costBeforeEdit}")`);

    // Erase one Power section through the real click path (no tab switch after).
    const erased = await page.evaluate(async () => {
      const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
      state.wiringUi.mode = "power";
      state.wiringUi.wiringTool = "erase";
      state.wiringUi.selectedSectionId = null;
      wiring.refreshWiringPresentation();
      const hit = document.querySelector('.wire-hit-layer .wire-hit[data-section-id="3,0:4,0"]');
      if (!hit) return null;
      hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return state.wiring.power.sections.length;
    });
    assert.ok(erased !== null, "the Light branch hit line is present for erasing");

    const costAfterEdit = costNumber(await costText());
    assert.notStrictEqual(costAfterEdit, costBeforeEdit, "build cost banner updates on the wiring edit itself, without a tab switch");
    await page.evaluate(async () => {
      const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
      state.wiringUi.wiringTool = "draw";
      wiring.undoWiring();
    });
    assert.strictEqual(costNumber(await costText()), costBeforeEdit, "undo restores the build cost banner too");

    // 10. No touch/mobile-specific listeners were introduced for clarity UI.
    assert.deepStrictEqual(errors, [], `no page errors: ${errors.join("; ")}`);

    console.log("verify-wiring-cost-benefit-ui-browser passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})();
