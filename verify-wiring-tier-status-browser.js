#!/usr/bin/env node
"use strict";
// Section 7D-2 UI clarity — Power cable tier and status are readable at the same
// time: each tier keeps a distinct permanent amber/copper colour and thickness,
// status is shown by overlay halos (never by replacing the tier colour), the
// tier buttons explain purpose + capacity, a legend is present, and reduced
// motion still leaves a static status cue.
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

async function buildFixture(page) {
  await page.evaluate(async () => {
    const [{ state }, designer, wiring, { PART_STATS }] = await Promise.all([
      import("/src/state.js"), import("/src/ui/designerUi.js"), import("/src/ui/wiringUi.js"), import("/src/design/parts.js")
    ]);
    document.querySelector("#blueprintDesignerScreen").hidden = false;
    // Three independent Power networks, one per tier, plus a sourceless (broken)
    // network and a Data cable. A reactor+beamEmitter on a Light cable exceeds
    // the Light peak, forcing an at-peak status.
    state.design = [
      { x: 0, y: 0, type: "core" }, { x: 1, y: 0, type: "gyroscope" },        // Light net (loaded)
      { x: 0, y: 2, type: "core" }, { x: 1, y: 2, type: "gyroscope" },        // Standard net (working)
      { x: 0, y: 4, type: "core" }, { x: 1, y: 4, type: "gyroscope" },        // Heavy net (working)
      { x: 5, y: 0, type: "reactor" }, { x: 7, y: 0, type: "beamEmitter" },   // Light net at peak (reactor is 2x1 -> 5,0 & 6,0)
      { x: 10, y: 0, type: "gyroscope" }, { x: 11, y: 0, type: "frame" },     // sourceless (broken) net
      { x: 0, y: 8, type: "fireControl" }, { x: 1, y: 8, type: "railgun" }    // Data cable
    ];
    let w = window.WiringRules.emptyWiring();
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 0, y: 0 }, { x: 1, y: 0 }], state.design, PART_STATS, "light");
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 0, y: 2 }, { x: 1, y: 2 }], state.design, PART_STATS, "standard");
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 0, y: 4 }, { x: 1, y: 4 }], state.design, PART_STATS, "heavy");
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 5, y: 0 }, { x: 6, y: 0 }, { x: 7, y: 0 }], state.design, PART_STATS, "light");
    w = window.WiringRules.addPathWithTier(w, "power", [{ x: 10, y: 0 }, { x: 11, y: 0 }], state.design, PART_STATS, "standard");
    w = window.WiringRules.addPath(w, "data", [{ x: 0, y: 8 }, { x: 1, y: 8 }], state.design, PART_STATS);
    state.wiring = w;
    wiring.resetWiringEditorState();
    designer.renderBuildGrid();
    designer.setBlueprintView("wiring");
  });
  await page.locator(".wiring-overlay-host svg.wiring-overlay").waitFor({ state: "visible", timeout: 5000 });
}
// Computed style of the visible cable line for a section id.
async function visibleStyle(page, sectionId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`.wire-visible-layer line[data-section-id="${id}"]`);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { stroke: cs.stroke, strokeWidth: el.style.strokeWidth || cs.strokeWidth, className: el.getAttribute("class"), powerStatus: el.dataset.powerStatus || null, dashed: (cs.strokeDasharray && cs.strokeDasharray !== "none") };
  }, sectionId);
}
async function haloClasses(page, sectionId) {
  return page.evaluate((id) => Array.from(document.querySelectorAll(`.wire-glow-layer line[data-section-id="${id}"]`)).map((el) => el.getAttribute("class")), sectionId);
}

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => { const d = await import("/src/ui/designerUi.js"); document.querySelector("#blueprintDesignerScreen").hidden = false; d.renderBuildGrid(); });
    await page.locator("#blueprintWiringTab").click();
    await buildFixture(page);

    const light = await visibleStyle(page, "0,0:1,0");
    const standard = await visibleStyle(page, "0,2:1,2");
    const heavy = await visibleStyle(page, "0,4:1,4");
    assert.ok(light && standard && heavy, "all three tier sections rendered a visible cable");

    // 1. Distinct permanent tier classes and colours.
    assert.match(light.className, /wire-tier-light/, "light section keeps its tier class");
    assert.match(standard.className, /wire-tier-standard/, "standard section keeps its tier class");
    assert.match(heavy.className, /wire-tier-heavy/, "heavy section keeps its tier class");
    const colours = new Set([light.stroke, standard.stroke, heavy.stroke]);
    assert.strictEqual(colours.size, 3, `three distinct tier colours (got ${[...colours].join(", ")})`);

    // 2. Distinct thicknesses preserved.
    const widths = [parseFloat(light.strokeWidth), parseFloat(standard.strokeWidth), parseFloat(heavy.strokeWidth)];
    assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `light < standard < heavy thickness (got ${widths.join(", ")})`);

    // 3. Status overlays never remove tier identity. Each tier section still has
    //    its tier class + colour while carrying a status, shown by a halo.
    for (const [id, expectTier] of [["0,0:1,0", "light"], ["0,2:1,2", "standard"], ["0,4:1,4", "heavy"]]) {
      const style = await visibleStyle(page, id);
      assert.match(style.className, new RegExp(`wire-tier-${expectTier}`), `${id} keeps tier class under status`);
      assert.ok(style.powerStatus, `${id} carries a status marker (${style.powerStatus})`);
      const halos = await haloClasses(page, id);
      assert.ok(halos.some((c) => /wire-status-/.test(c)), `${id} has a status halo overlay`);
    }
    // At-peak section (beamEmitter on a Light cable): peak status + tier intact + a marker.
    const peak = await visibleStyle(page, "6,0:7,0");
    assert.strictEqual(peak.powerStatus, "peak", "over-capacity Light section reports at-peak status");
    assert.match(peak.className, /wire-tier-light/, "at-peak section keeps its Light tier identity");
    const peakHalos = await haloClasses(page, "6,0:7,0");
    assert.ok(peakHalos.some((c) => /wire-status-peak/.test(c)), "at-peak halo present");
    assert.ok(await page.locator(".wire-glow-layer .wire-status-peak-marker").count() >= 1, "at-peak shows a static marker");
    // Broken (sourceless) section: broken status + tier intact, dashed halo.
    const broken = await visibleStyle(page, "10,0:11,0");
    assert.strictEqual(broken.powerStatus, "broken", "sourceless section reports broken status");
    assert.match(broken.className, /wire-tier-standard/, "broken section keeps its tier identity");
    const brokenHalo = await page.evaluate(() => { const el = document.querySelector('.wire-glow-layer .wire-status-broken'); return el ? getComputedStyle(el).strokeDasharray : null; });
    assert.ok(brokenHalo && brokenHalo !== "none", "broken status uses a dashed outline");

    // 4. Selection combines with status without removing tier identity.
    await page.locator('.wire-hit[data-section-id="0,0:1,0"]').first().dispatchEvent("click");
    await page.waitForTimeout(30);
    const selLight = await visibleStyle(page, "0,0:1,0");
    assert.match(selLight.className, /wire-tier-light/, "selected section keeps tier identity");
    assert.ok(await page.locator('.wire-glow-layer .wire-status-selected').count() >= 1, "selection shows a blue halo alongside the status halo");

    // 5. Data remains cyan and dashed.
    await page.locator("#wiringModeData").click();
    await page.waitForTimeout(30);
    const data = await visibleStyle(page, "0,8:1,8");
    assert.match(data.className, /wire-data/, "data cable keeps its class (base cyan)");
    assert.ok(data.dashed, "data cable is dashed");
    // The base .wire-data rule is cyan; confirm the Power tier/status work did not
    // touch it. (Existing Data-support severity overlays may recolour a section;
    // the cyan base rule itself is asserted directly below.)
    const dataBaseStroke = await page.evaluate(() => {
      const probe = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      probe.setAttribute("class", "wiring-overlay"); document.body.appendChild(probe);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("class", "wire-data"); probe.appendChild(line);
      const s = getComputedStyle(line); const out = { stroke: s.stroke, dash: s.strokeDasharray };
      probe.remove(); return out;
    });
    assert.match(dataBaseStroke.stroke, /rgb\(\s*56,\s*217,\s*255\s*\)/i, "base Data cable is cyan");
    assert.ok(dataBaseStroke.dash && dataBaseStroke.dash !== "none", "base Data cable is dashed");
    await page.locator("#wiringModePower").click();
    await page.waitForTimeout(30);

    // 6. Compact tier buttons show capacity; purpose/cost stays in tooltips
    // and the selected-tier Analysis summary.
    const tierText = await page.locator("#wiringTierRow").innerText();
    assert.match(tierText, /4\s*\/\s*7 MW/, "Light button shows sustained/peak capacity");
    assert.match(tierText, /10\s*\/\s*16 MW/, "Standard capacity");
    assert.match(tierText, /24\s*\/\s*36 MW/, "Heavy capacity");
    assert.match(await page.locator('[data-wiring-tier="light"]').getAttribute("title"), /branch/i, "Light tooltip explains purpose");
    assert.match(await page.locator('[data-wiring-tier="standard"]').getAttribute("title"), /distribution/i, "Standard tooltip explains purpose");
    assert.match(await page.locator('[data-wiring-tier="heavy"]').getAttribute("title"), /trunk|backbone/i, "Heavy tooltip explains purpose");

    // 7. Legend is available through Help and closed by default.
    const legend = page.locator("#wiringHelpPanel");
    assert.strictEqual(await legend.isHidden(), true, "Help legend is closed by default");
    await page.locator("#wiringHelpButton").click();
    assert.match(await legend.innerText(), /sustained is safe continuous load/i, "Help explains sustained/peak values");
    assert.match(await legend.innerText(), /red dashed disconnected/i, "Help explains status styles");
    await page.locator("#wiringHelpCloseButton").click();

    // 8. Reduced motion keeps a static status cue (glow filter) without animation.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await buildFixture(page);
    const peakMotion = await page.evaluate(() => {
      const el = document.querySelector(".wire-glow-layer .wire-status-peak");
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { animationName: cs.animationName, filter: cs.filter };
    });
    assert.ok(peakMotion, "at-peak halo still rendered under reduced motion");
    assert.ok(peakMotion.animationName === "none", "no pulse animation under reduced motion");
    assert.ok(peakMotion.filter && peakMotion.filter !== "none", "static glow cue remains under reduced motion");

    console.log("Wiring tier/status clarity browser verification passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
