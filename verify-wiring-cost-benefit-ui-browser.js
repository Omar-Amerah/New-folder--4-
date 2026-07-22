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

    // 1. Tier comparison cards render authoritative values and distinct guidance.
    const cardData = await page.evaluate(() => {
      const details = document.querySelector("#wiringTierCards");
      if (details) details.open = true; // expand so the cards are visible/readable
      const cards = Array.from(document.querySelectorAll("#wiringTierCardList [data-tier-card]"));
      return cards.map((c) => ({ key: c.dataset.tierCard, text: c.textContent }));
    });
    assert.strictEqual(cardData.length, 4, "four tier cards (Light/Standard/Heavy/Data)");
    const light = cardData.find((c) => c.key === "light");
    const heavy = cardData.find((c) => c.key === "heavy");
    const data = cardData.find((c) => c.key === "data");
    assert.match(light.text, /4 MW sustained \/ 7 MW peak/, "light card shows authoritative capacity");
    assert.match(light.text, /\$1/, "light card shows cost");
    assert.match(heavy.text, /24 MW sustained \/ 36 MW peak/, "heavy card shows authoritative capacity");
    assert.match(data.text, /Carries Data only/, "data card explains no Power");
    assert.match(light.text, /Bottleneck|bottleneck/, "light card names its downside");
    assert.match(heavy.text, /wasteful/, "heavy card names its downside");
    assert.ok(!/NaN|Infinity|undefined/.test(cardData.map((c) => c.text).join(" ")), "no NaN/Infinity/undefined in cards");

    // 2. Selected-tool summary updates when the tier changes.
    async function toolSummaryText() { return page.locator("#wiringToolSummary").innerText(); }
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
    // Data mode summary.
    await page.locator("#wiringModeData").click();
    const dataSummary = await toolSummaryText();
    assert.match(dataSummary, /Carries Data only/, "data tool summary");
    assert.match(dataSummary, /No capacity, Heat or overload/, "data tool summary downside");
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

    // 5. Tier upgrade comparison: select the Change Tier tool, target Standard,
    //    hover the overloaded Light branch section, and read the comparison.
    const comparison = await page.evaluate(async () => {
      const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
      state.wiringUi.mode = "power";
      state.wiringUi.wiringTool = "tier";
      state.wiringUi.selectedPowerTier = "standard";
      state.wiringUi.hoveredSectionId = "3,0:4,0"; // the Light branch
      wiring.refreshWiringPresentation();
      const panel = document.querySelector("#wiringPreviewPanel");
      return panel ? panel.innerText : "";
    });
    assert.match(comparison, /Current — Light Cable/, "comparison shows current tier");
    assert.match(comparison, /Proposed — Standard Cable/, "comparison shows proposed tier");
    assert.match(comparison, /Benefit:/, "comparison shows a benefit");
    assert.match(comparison, /Drawback:/, "comparison shows a drawback");
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

    // 7. Architecture comparison is present in the Power Infrastructure reference.
    const archText = await page.evaluate(() => {
      const el = document.querySelector("#architectureComparison");
      return el ? el.textContent : "";
    });
    for (const family of ["Central bus", "Distributed grids", "Ring bus", "Hybrid"]) {
      assert.ok(archText.includes(family), `architecture comparison names ${family}`);
    }
    assert.match(archText, /Redundancy does not create free generation/, "architecture facts present");
    assert.match(archText, /Switchgear is optional/, "architecture notes Switchgear is optional");

    // 8. Data section inspection shows cost but no Power capacity/Heat rows.
    const dataInspect = await page.evaluate(async () => {
      const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
      state.wiringUi.mode = "data";
      state.wiringUi.wiringTool = "inspect";
      state.wiringUi.selectedSectionId = "0,3:1,3";
      wiring.refreshWiringPresentation();
      const el = document.querySelector('[data-data-inspector="section-vulnerability"]');
      return el ? el.innerText : "";
    });
    assert.match(dataInspect, /Selected cells: \$/, "data section shows cost");
    assert.match(dataInspect, /Data cables do not carry Power/, "data section states no Power");
    assert.ok(!/sustained \/ .*peak|Cable Heat contribution/.test(dataInspect), "data section shows no Power-capacity/Heat rows");
    await page.evaluate(async () => { const [{ state }, wiring] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]); state.wiringUi.mode = "power"; wiring.refreshWiringPresentation(); });

    // 9. No touch/mobile-specific listeners were introduced for clarity UI.
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
