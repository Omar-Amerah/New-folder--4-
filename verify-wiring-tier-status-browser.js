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
    designer.renderLocalStats();
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
async function inspectCircleSafety(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector("svg.wiring-overlay");
    const overlayRect = overlay?.getBoundingClientRect();
    const cellWidth = (overlayRect?.width || 0) / 15;
    const cellHeight = (overlayRect?.height || 0) / 15;
    return [...document.querySelectorAll("svg.wiring-overlay circle")].map((circle) => {
      const rect = circle.getBoundingClientRect();
      return {
        className: circle.getAttribute("class") || "",
        radius: Number(circle.getAttribute("r")),
        widthCells: cellWidth ? rect.width / cellWidth : Infinity,
        heightCells: cellHeight ? rect.height / cellHeight : Infinity
      };
    });
  });
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
    assert.match(light.stroke, /rgb\(\s*255,\s*243,\s*163\s*\)/i, "Light cable is pale yellow");
    assert.match(standard.stroke, /rgb\(\s*255,\s*152,\s*0\s*\)/i, "Standard cable is vivid orange");
    assert.match(heavy.stroke, /rgb\(\s*196,\s*60,\s*47\s*\)/i, "Heavy cable is deep copper-red");

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

    // 4. Inspect may preserve prior selection; any selected terminal markers stay
    // bounded. The focus fix must not rely on clearing selection or wiring.
    await page.locator('[data-wiring-tool="draw"]').click();
    await page.locator("#buildGrid .build-cell").evaluateAll((cells) => {
      cells.find((cell) => cell.dataset.partIndex === "0")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    const stalePowerSelection = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return {
        selectedIndex: state.wiringUi.selectedIndex,
        selectedConnectionKey: state.wiringUi.selectedConnectionKey,
        wiring: JSON.stringify(state.wiring)
      };
    });
    assert.strictEqual(stalePowerSelection.selectedIndex, 0, "Power Draw fixture creates stale component selection before Inspect");
    await page.locator('[data-wiring-tool="inspect"]').click();
    const powerInspectState = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return {
        selectedIndex: state.wiringUi.selectedIndex,
        selectedConnectionKey: state.wiringUi.selectedConnectionKey,
        selectedSectionId: state.wiringUi.selectedSectionId,
        selectedDataNetworkId: state.wiringUi.selectedDataNetworkId,
        wiring: JSON.stringify(state.wiring)
      };
    });
    assert.strictEqual(powerInspectState.selectedIndex, stalePowerSelection.selectedIndex,
      "Power Inspect focus fix does not clear component selection");
    assert.strictEqual(powerInspectState.selectedConnectionKey, stalePowerSelection.selectedConnectionKey,
      "Power Inspect focus fix does not clear connection/network selection");
    assert.strictEqual(powerInspectState.wiring, stalePowerSelection.wiring, "entering Power Inspect does not mutate wiring");
    assert.ok(await page.locator(".wire-terminal-selected").count() > 0,
      "selected terminal markers remain rendered and bounded; they are not hidden as a workaround");
    const powerCircles = await inspectCircleSafety(page);
    assert.ok(powerCircles.length > 0, "Power Inspect renders bounded overlay circle markers");
    assert.ok(powerCircles.every((circle) => Number.isFinite(circle.radius) && circle.radius <= 0.18),
      `every Power overlay circle has radius <= 0.18 (${JSON.stringify(powerCircles)})`);
    assert.ok(powerCircles.every((circle) => circle.widthCells <= 2 && circle.heightCells <= 2),
      `no Power overlay circle spans more than two grid cells (${JSON.stringify(powerCircles)})`);

    // Inspect is hover-led: the exact section is emphasized temporarily, while
    // clicking updates the panel without adding a persistent grid effect.
    const inspectHit = page.locator('.wire-hit[data-section-id="0,0:1,0"]').first();
    await inspectHit.dispatchEvent("mouseover");
    const hoverPresentation = await page.evaluate(() => {
      const hovered = document.querySelector('.wire-visible-layer [data-section-id="0,0:1,0"]');
      const unrelated = document.querySelector('.wire-visible-layer [data-section-id="0,2:1,2"]');
      return {
        hostActive: document.querySelector("#wiringOverlayHost").classList.contains("wiring-inspect-hover-active"),
        hoveredClass: hovered.classList.contains("wire-section-hover"),
        hoveredOpacity: getComputedStyle(hovered).opacity,
        hoveredFilter: getComputedStyle(hovered).filter,
        unrelatedOpacity: getComputedStyle(unrelated).opacity
      };
    });
    assert.strictEqual(hoverPresentation.hostActive, true, "Inspect hover activates section focus");
    assert.strictEqual(hoverPresentation.hoveredClass, true, "hover marks only the pointed section");
    assert.strictEqual(hoverPresentation.hoveredOpacity, "1", "hovered section remains fully visible");
    assert.notStrictEqual(hoverPresentation.hoveredFilter, "none", "hovered section receives a transient glow");
    assert.strictEqual(hoverPresentation.unrelatedOpacity, "0.2", "unrelated sections recede during Inspect hover");
    const hoverCard = page.locator("#wiringHoverCard");
    await hoverCard.waitFor({ state: "visible" });
    const hoverCardText = await hoverCard.innerText();
    assert.match(hoverCardText, /\d+(?:\.\d+)? MW/, "hover card reports solved section flow in MW");
    assert.match(hoverCardText, /Sustained load\s+\d+%/, "hover card reports sustained utilisation");
    assert.doesNotMatch(hoverCardText, /Direction|From/, "direction and source labels stay off the compact hover card");
    const energyCue = await page.evaluate(() => {
      const pulse = document.querySelector('.wire-energy-pulse[data-section-id="0,0:1,0"]');
      const source = document.querySelector('.wire-energy-source[data-source-index="0"]');
      return {
        pulseActive: pulse?.classList.contains("active"),
        pulseAnimation: pulse ? getComputedStyle(pulse).animationName : "none",
        sourceActive: source?.classList.contains("active"),
        sourceAnimation: source ? getComputedStyle(source).animationName : "none"
      };
    });
    assert.strictEqual(energyCue.pulseActive, true, "hover activates energy packets on the powered cable");
    assert.notStrictEqual(energyCue.pulseAnimation, "none", "energy packets visibly travel along the cable");
    assert.strictEqual(energyCue.sourceActive, true, "the supplying component pulses");
    assert.notStrictEqual(energyCue.sourceAnimation, "none", "the supplying component has a visible pulse");
    await inspectHit.dispatchEvent("mouseout");
    assert.strictEqual(await page.locator("#wiringOverlayHost").evaluate((host) => host.classList.contains("wiring-inspect-hover-active")), false,
      "Inspect focus clears on pointer exit");
    assert.strictEqual(await hoverCard.isHidden(), true, "Power-flow hover card clears on pointer exit");
    assert.strictEqual(await page.locator(".wire-energy-pulse.active, .wire-energy-source.active").count(), 0,
      "energy animation clears on pointer exit");

    await inspectHit.dispatchEvent("click");
    await page.waitForTimeout(30);
    const selLight = await visibleStyle(page, "0,0:1,0");
    assert.match(selLight.className, /wire-tier-light/, "inspected section keeps its normal tier identity");
    assert.doesNotMatch(selLight.className, /wire-section-hover/, "click does not retain the hover effect");
    assert.strictEqual(await page.locator('.wire-glow-layer .wire-status-selected').count(), 0, "click creates no selection halo");
    assert.strictEqual(await page.locator("#wiringOverlayHost").evaluate((host) => host.classList.contains("wiring-inspect-hover-active")), false,
      "click leaves no persistent grid focus");
    const legacySelectionDisplay = await page.evaluate(() => {
      const svg = document.querySelector("svg.wiring-overlay");
      const legacy = document.createElementNS("http://www.w3.org/2000/svg", "line");
      legacy.setAttribute("class", "wire-status-halo wire-status-selected");
      svg.appendChild(legacy);
      const display = getComputedStyle(legacy).display;
      legacy.remove();
      return display;
    });
    assert.strictEqual(legacySelectionDisplay, "none", "cached legacy selection halos are suppressed");

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

    // Repeat the stale-selection transition in Data mode. Hover remains the only
    // grid emphasis and opens the compact Data inspection card.
    await page.locator('[data-wiring-tool="draw"]').click();
    await page.locator("#buildGrid .build-cell").evaluateAll((cells) => {
      cells.find((cell) => cell.dataset.partIndex === "10")?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    const staleDataSelection = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return {
        selectedIndex: state.wiringUi.selectedIndex,
        selectedConnectionKey: state.wiringUi.selectedConnectionKey,
        wiring: JSON.stringify(state.wiring)
      };
    });
    assert.strictEqual(staleDataSelection.selectedIndex, 10, "Data Draw fixture creates stale component selection before Inspect");
    await page.locator('[data-wiring-tool="inspect"]').click();
    const dataInspectState = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return {
        selectedIndex: state.wiringUi.selectedIndex,
        selectedConnectionKey: state.wiringUi.selectedConnectionKey,
        selectedSectionId: state.wiringUi.selectedSectionId,
        selectedDataNetworkId: state.wiringUi.selectedDataNetworkId,
        wiring: JSON.stringify(state.wiring)
      };
    });
    assert.strictEqual(dataInspectState.selectedIndex, staleDataSelection.selectedIndex,
      "Data Inspect focus fix does not clear component selection");
    assert.strictEqual(dataInspectState.selectedConnectionKey, staleDataSelection.selectedConnectionKey,
      "Data Inspect focus fix does not clear connection/network selection");
    assert.strictEqual(dataInspectState.wiring, staleDataSelection.wiring, "entering Data Inspect does not mutate wiring");
    assert.ok(await page.locator(".wire-terminal-selected").count() > 0,
      "Data selected terminal markers remain rendered and bounded");
    const dataCircles = await inspectCircleSafety(page);
    assert.ok(dataCircles.length > 0, "Data Inspect renders bounded overlay circle markers");
    assert.ok(dataCircles.every((circle) => Number.isFinite(circle.radius) && circle.radius <= 0.18),
      `every Data overlay circle has radius <= 0.18 (${JSON.stringify(dataCircles)})`);
    assert.ok(dataCircles.every((circle) => circle.widthCells <= 2 && circle.heightCells <= 2),
      `no Data overlay circle spans more than two grid cells (${JSON.stringify(dataCircles)})`);
    const dataInspectHit = page.locator('.wire-hit[data-section-id="0,8:1,8"]').first();
    await dataInspectHit.dispatchEvent("mouseover");
    assert.strictEqual(await page.locator(".wire-visible-layer .wire-section-hover").count(), 1,
      "Data Inspect hover highlights exactly one section");
    assert.strictEqual(await page.locator('.wire-visible-layer .wire-section-hover').getAttribute("data-section-id"), "0,8:1,8",
      "Data Inspect hover highlights only the pointed section");
    await hoverCard.waitFor({ state: "visible" });
    assert.match(await hoverCard.innerText(), /Data cable[\s\S]*Signal link/i, "Data Inspect hover displays its inspection card");
    await dataInspectHit.dispatchEvent("mouseout");
    assert.strictEqual(await hoverCard.isHidden(), true, "Data inspection card clears on pointer exit");
    assert.strictEqual(await page.locator(".wire-section-hover").count(), 0, "Data hover highlight clears on pointer exit");
    await page.locator("#wiringModePower").click();
    await page.waitForTimeout(30);

    // 6. Compact tier buttons show both capacity and authoritative per-cell cost.
    const tierText = await page.locator("#wiringTierRow").innerText();
    assert.match(tierText, /4\s*\/\s*7 MW/, "Light button shows sustained/peak capacity");
    assert.match(tierText, /10\s*\/\s*16 MW/, "Standard capacity");
    assert.match(tierText, /24\s*\/\s*36 MW/, "Heavy capacity");
    assert.match(tierText, /\$1\/cell/, "Light button shows its per-cell cost");
    assert.match(tierText, /\$2\/cell/, "Standard button shows its per-cell cost");
    assert.match(tierText, /\$5\/cell/, "Heavy button shows its per-cell cost");
    assert.match(await page.locator("#wiringModeData").innerText(), /\$0\.25\/cell/, "Data mode shows its per-cell cost");
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

    // 8. Committing a wiring edit refreshes every live cost surface from the
    // authoritative wiring-aware component stats.
    const costBefore = await page.evaluate(async () => {
      const [{ state }, { computeStats }] = await Promise.all([import("/src/state.js"), import("/src/design/componentStats.js")]);
      return computeStats(state.design, { wiring: state.wiring }).unitCost;
    });
    await page.locator('[data-wiring-tool="erase"]').click();
    await page.locator('.wire-hit[data-section-id="0,4:1,4"]').dispatchEvent("click");
    await page.waitForTimeout(40);
    const costSync = await page.evaluate(async () => {
      const [{ state }, { computeStats }] = await Promise.all([import("/src/state.js"), import("/src/design/componentStats.js")]);
      const stats = computeStats(state.design, { wiring: state.wiring });
      return {
        authoritative: stats.unitCost,
        powerWiring: stats.costBreakdown.powerWiring,
        banner: document.querySelector("#blueprintCostLabel")?.textContent || "",
        stats: document.querySelector("#statsGrid")?.textContent || "",
        breakdown: document.querySelector("#blueprintCostBreakdown")?.textContent || "",
        purchase: document.querySelector('.purchase-option[data-option-id="current"] .purchase-cost')?.textContent || ""
      };
    });
    assert.ok(costSync.authoritative < costBefore, "removing Heavy wiring reduces the authoritative build cost");
    assert.strictEqual(costSync.banner, `$${costSync.authoritative.toLocaleString()}`, "Build cost banner refreshes");
    assert.match(costSync.stats, new RegExp(`Build cost\\s*\\$${costSync.authoritative}`), "ship summary Build cost refreshes");
    assert.match(costSync.breakdown, new RegExp(`Power wiring\\s*\\$${costSync.powerWiring}`), "cost breakdown Power wiring refreshes");
    assert.match(costSync.breakdown, new RegExp(`Total ship cost\\s*\\$${costSync.authoritative}`), "cost breakdown total refreshes");
    assert.strictEqual(costSync.purchase, `$${costSync.authoritative}`, "current-design purchase cost refreshes");

    // 9. Reduced motion keeps a static status cue (glow filter) without animation.
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
