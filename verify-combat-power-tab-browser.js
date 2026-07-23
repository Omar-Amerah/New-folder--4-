#!/usr/bin/env node
"use strict";
// Combat Power tab — desktop UI verification. Renders the selected-ship panel
// with a fabricated snapshot that carries the Power blocks, then checks the
// three accessible tabs, that the Heat tab is thermal-only, that the Power tab
// renders the supply/distribution/protection groups, legend and live wiring
// overlay, and that component/section readouts respond — with no page errors
// and no touch/mobile controls.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;
const artifactDir = path.join(__dirname, "test-artifacts", "combat-power-tab");
fs.mkdirSync(artifactDir, { recursive: true });

// A fabricated selected-ship snapshot with every Power block the Power tab
// reads. Kept inline so the test does not need a live match.
const SHIP = {
  id: "s1", ownerId: "p1", alive: true,
  design: [
    { type: "reactor", x: 0, y: 0, rotation: 0 },
    { type: "frame", x: 2, y: 0, rotation: 0 },
    { type: "shield", x: 3, y: 0, rotation: 0 },
    { type: "blaster", x: 4, y: 2, rotation: 0 }
  ],
  chp: [100, 40, 30, 25],
  componentHeat: [[10, 0, 0.1, 100], [5, 0, 0.05, 100], [40, 1, 0.4, 100], [20, 0, 0.2, 100]],
  componentPower: [["source", 0, 1], ["passive", 0, 1], ["powered", 0, 1], ["underpowered", 0, 0.6]],
  powerStatus: "underpowered",
  powerThermal: {
    componentHeatRate: 1.2, powerCableHeatRate: 2.4, totalHeatRate: 3.6, cooling: 1, netHeatRate: 2.6,
    hottestComponentIndex: 2, aboveSustainedSectionCount: 1, atPeakSectionCount: 0,
    throttledComponentCount: 1, disabledComponentCount: 0, powerGenerationMw: 10, requestedDemandMw: 9.5,
    deliveredDemandMw: 8, sparePowerMw: 0.5, unmetDemandMw: 1.5, activePriorityPreset: "balanced", hottestSectionId: "2,0:3,0",
    powerCableHeatBySectionId: {
      "1,0:2,0": { baseHeatPerSecond: 0.2, overloadHeatPerSecond: 0, totalHeatPerSecond: 0.2 },
      "2,0:3,0": { baseHeatPerSecond: 0.8, overloadHeatPerSecond: 0, totalHeatPerSecond: 0.8 },
      "3,0:4,0": { baseHeatPerSecond: 1, overloadHeatPerSecond: 1.4, totalHeatPerSecond: 2.4 }
    },
    components: [
      { componentIndex: 0, requestedMw: 0, allocatedMw: 0, operationalMultiplier: 1, powerRole: "source", ratedGenerationMw: 12, availableGenerationMw: 10, deliveredGenerationMw: 8, unusedGenerationMw: 2, reductionReasons: ["curtailed-by-demand"], powerCableHeatRate: 0, hostedActiveSectionIds: [] },
      { componentIndex: 2, requestedMw: 3.5, allocatedMw: 3.5, operationalMultiplier: 1, powerCableHeatRate: 1.2, hostedActiveSectionIds: ["2,0:3,0"] },
      { componentIndex: 3, requestedMw: 6, allocatedMw: 4, operationalMultiplier: 0.6, powerCableHeatRate: 1.2, hostedActiveSectionIds: ["3,0:4,0"] }
    ]
  },
  powerProtection: {
    state: "strained", aboveSustainedSectionCount: 1, atPeakSectionCount: 0, criticalSectionCount: 0,
    mostStressedSectionId: "3,0:4,0", mostStressedStress: 0.3, trippedSwitchgearCount: 0, nextRetrySeconds: 0,
    partialConsumerCount: 1, shedConsumerCount: 0, sections: []
  },
  wiringStatus: { powerNetworks: 1, brokenPowerConnections: 0, disabledPowerSections: 0, dataNetworks: 0 },
  switchgear: [
    { componentIndex: 10, mode: "open", runtimeState: "open", presentationState: "open", conducts: false, reasonNotConducting: "saved-mode-open", ratingTier: "light", classification: "bus-tie", signedTransferMw: 0, sustainedCapacityMw: 4, peakCapacityMw: 7, utilisation: 0, sideANetworkId: "0", sideBNetworkId: "1" },
    { componentIndex: 11, mode: "automatic", runtimeState: "automatic", presentationState: "automatic-idle", conducts: false, reasonNotConducting: "open: no jointly valid priority-safe subset", ratingTier: "light", classification: "bus-tie", signedTransferMw: 0, sustainedCapacityMw: 4, peakCapacityMw: 7, utilisation: 0, sideANetworkId: "0", sideBNetworkId: "1" },
    { componentIndex: 12, mode: "closed", runtimeState: "tripped", state: "tripped", presentationState: "tripped-cooling", conducts: false, reasonNotConducting: "overload", trippedReason: "overload", cooldownRemaining: 2, retryCount: 1, ratingTier: "light", classification: "bus-tie", signedTransferMw: 0, sustainedCapacityMw: 4, peakCapacityMw: 7, utilisation: 0, sideANetworkId: "0", sideBNetworkId: "1" }
  ],
  powerWiring: {
    revision: 1,
    sections: [
      { id: "1,0:2,0", kind: "power-section", x1: 1, y1: 0, x2: 2, y2: 0, tier: "standard", hosts: [0, 1], operational: true },
      { id: "2,0:3,0", kind: "power-section", x1: 2, y1: 0, x2: 3, y2: 0, tier: "light", hosts: [1, 2], operational: true },
      { id: "3,0:4,0", kind: "power-section", x1: 3, y1: 0, x2: 4, y2: 0, tier: "light", hosts: [2, 3], operational: true }
    ]
  },
  powerWiringRevision: 1,
  powerWiringRuntime: {
    mostStressedSectionId: "3,0:4,0", mostStressedStress: 0.3,
    sections: [
      { id: "1,0:2,0", signedFlowMw: 8, absoluteFlowMw: 8, sustainedCapacityMw: 10, peakCapacityMw: 16, sustainedUtilisation: 0.8, peakUtilisation: 0.5, stress: 0, secondsAboveSustained: 0, state: "near-sustained", operational: true, networkId: "power-net-0" },
      { id: "2,0:3,0", signedFlowMw: 3.5, absoluteFlowMw: 3.5, sustainedCapacityMw: 4, peakCapacityMw: 7, sustainedUtilisation: 0.875, peakUtilisation: 0.5, stress: 0, secondsAboveSustained: 0, state: "near-sustained", operational: true, networkId: "power-net-0" },
      { id: "3,0:4,0", signedFlowMw: 5, absoluteFlowMw: 5, sustainedCapacityMw: 4, peakCapacityMw: 7, sustainedUtilisation: 1.25, peakUtilisation: 0.71, stress: 0.3, secondsAboveSustained: 2, state: "overloaded", operational: true, networkId: "power-net-0" }
    ]
  }
};

function cloneShip(ship = SHIP) { return structuredClone(ship); }
function healthyShip() {
  const ship = cloneShip();
  ship.powerStatus = "powered";
  Object.assign(ship.powerThermal, {
    powerCableHeatRate: 0.4,
    totalHeatRate: 1.6,
    netHeatRate: 0.6,
    aboveSustainedSectionCount: 0,
    atPeakSectionCount: 0,
    throttledComponentCount: 0,
    disabledComponentCount: 0,
    powerGenerationMw: 10,
    requestedDemandMw: 7.5,
    deliveredDemandMw: 7.5,
    sparePowerMw: 2.5,
    unmetDemandMw: 0,
    hottestSectionId: "2,0:3,0"
  });
  for (const component of ship.powerThermal.components) {
    component.allocatedMw = component.requestedMw;
    component.operationalMultiplier = 1;
  }
  Object.assign(ship.powerProtection, {
    state: "normal",
    aboveSustainedSectionCount: 0,
    atPeakSectionCount: 0,
    criticalSectionCount: 0,
    mostStressedSectionId: null,
    mostStressedStress: 0,
    trippedSwitchgearCount: 0,
    nextRetrySeconds: 0,
    partialConsumerCount: 0,
    shedConsumerCount: 0
  });
  ship.switchgear = [];
  ship.powerWiringRuntime.sections = ship.powerWiringRuntime.sections.map((section) => ({
    ...section,
    absoluteFlowMw: Math.min(section.absoluteFlowMw, section.sustainedCapacityMw * 0.6),
    sustainedUtilisation: 0.6,
    peakUtilisation: 0.35,
    stress: 0,
    secondsAboveSustained: 0,
    state: "normal"
  }));
  return ship;
}
function protectedRouteShip() {
  const ship = cloneShip();
  ship.powerStatus = "partially-powered";
  Object.assign(ship.powerProtection, {
    state: "protection-trip",
    trippedSwitchgearCount: 1,
    nextRetrySeconds: 2,
    partialConsumerCount: 1
  });
  return ship;
}

async function setup(page, ship) {
  await page.evaluate(async (shipData) => {
    const [{ state }, panel] = await Promise.all([import("/src/state.js"), import("/src/ui/shipDamagePanelUi.js")]);
    if (!document.getElementById("powerPanelTestIsolation")) {
      const style = document.createElement("style");
      style.id = "powerPanelTestIsolation";
      style.textContent = `
        #pixiFatalErrorPanel, .purchase-bar, .top-hud { display: none !important; }
        .score-panel {
          position: fixed !important;
          inset: 0 0 0 auto !important;
          width: min(310px, 100vw) !important;
          height: 100vh !important;
          overflow: auto !important;
          z-index: 4000 !important;
        }
        #scoreList, #eventLog, .screen-buttons { display: none !important; }
        #shipDamagePanel {
          position: relative !important;
          z-index: 5000 !important;
          background: #07101c !important;
        }
      `;
      document.head.appendChild(style);
    }
    document.querySelectorAll(".menu-screen, .confirm-modal").forEach((screen) => { screen.hidden = true; });
    document.querySelector("#battleScreen") && (document.querySelector("#battleScreen").hidden = false);
    const panelEl = document.querySelector("#shipDamagePanel");
    if (panelEl) panelEl.hidden = false;
    document.querySelector(".power-more-issues")?.removeAttribute("open");
    state.snapshot = { ships: [shipData], players: [{ id: "p1", color: "#8fd8ff" }] };
    state.selectedShipIds = new Set([shipData.id]);
    state.shipStatusView = "damage";
    window.__mfaPanel = panel;
    panel.renderShipDamagePanel();
  }, ship);
}
async function clickTab(page, id) {
  await page.evaluate((tabId) => { document.getElementById(tabId).click(); }, id);
}

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    // This is a deterministic panel test, not a live arena-loop test. Prevent
    // the match renderer from replacing the fabricated snapshot between UI
    // assertions and screenshot capture.
    await page.addInitScript(() => {
      globalThis.requestAnimationFrame = () => 0;
      globalThis.cancelAnimationFrame = () => {};
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await setup(page, SHIP);

    // 1/2. Three accessible tabs.
    const tabs = await page.evaluate(() => ["shipDamageTab", "shipHeatTab", "shipPowerTab"].map((id) => {
      const el = document.getElementById(id);
      return { id, exists: !!el, role: el?.getAttribute("role"), controls: el?.getAttribute("aria-controls"), selected: el?.getAttribute("aria-selected"), tabIndex: el?.getAttribute("tabindex"), text: el?.textContent };
    }));
    for (const t of tabs) { assert(t.exists, `${t.id} exists`); assert.strictEqual(t.role, "tab", `${t.id} is a tab`); assert.strictEqual(t.controls, "shipStatusPanelBody", `${t.id} owns the status tabpanel`); }
    assert.strictEqual(tabs[0].selected, "true", "Damage initially selected");
    assert.strictEqual(tabs[0].tabIndex, "0", "active Damage tab focusable");
    assert.strictEqual(tabs[1].tabIndex, "-1", "inactive Heat tab not in tab order");
    assert.strictEqual(tabs[2].text, "Power", "Power tab labelled");
    assert.strictEqual(await page.$eval("#shipStatusPanelBody", (el) => el.getAttribute("role")), "tabpanel", "status body is a tabpanel");
    assert.strictEqual(await page.$eval("#shipStatusPanelBody", (el) => el.getAttribute("aria-labelledby")), "shipDamageTab", "tabpanel labelled by active tab");

    // Switch to Power.
    await clickTab(page, "shipPowerTab");
    const powerState = await page.evaluate(() => ({
      powerSelected: document.getElementById("shipPowerTab").getAttribute("aria-selected"),
      powerTabIndex: document.getElementById("shipPowerTab").getAttribute("tabindex"),
      panelLabelledBy: document.getElementById("shipStatusPanelBody").getAttribute("aria-labelledby"),
      heatSelected: document.getElementById("shipHeatTab").getAttribute("aria-selected"),
      powerActiveClass: document.getElementById("shipPowerTab").classList.contains("active"),
      powerSummaryHidden: document.getElementById("shipPowerSummary").hidden,
      heatSummaryHidden: document.getElementById("shipHeatSummary").hidden,
      powerLegendHidden: document.getElementById("powerLegend").hidden,
      summaryText: document.getElementById("shipPowerSummary").textContent
    }));
    assert.strictEqual(powerState.powerSelected, "true", "Power tab aria-selected true");
    assert.strictEqual(powerState.heatSelected, "false", "Heat tab deselected");
    assert.strictEqual(powerState.powerTabIndex, "0", "active Power tab focusable");
    assert.strictEqual(powerState.panelLabelledBy, "shipPowerTab", "tabpanel labelled by Power tab");
    assert(powerState.powerActiveClass, "Power tab active class (not colour-only)");
    assert(!powerState.powerSummaryHidden, "Power summary visible");
    assert(powerState.heatSummaryHidden, "Heat summary hidden on Power tab");
    assert(!powerState.powerLegendHidden, "Power legend visible");

    // Compact operational hierarchy and authoritative balance values.
    const s = powerState.summaryText;
    for (const label of ["Underpowered", "Power balance", "Issues", "Distribution", "Generation", "Requested", "Delivered", "Spare", "Unmet", "Priority", "Cable Heat"]) {
      assert(s.includes(label), `Power summary shows: ${label}`);
    }
    for (const gone of ["Switchgear", "Advanced Power Diagnostics", "Protection"]) {
      assert(!s.includes(gone), `simplified Power summary omits ${gone}`);
    }
    assert(/10 MW/.test(s), "generation value shown");
    assert(!/NaN|Infinity|undefined/.test(s), "no NaN/Infinity/undefined in Power summary");
    const compactStructure = await page.evaluate(() => {
      const summary = document.getElementById("shipPowerSummary");
      return {
        oldCards: summary.querySelectorAll(".power-summary-group").length,
        directIssues: summary.querySelectorAll(".power-issues-section > .power-issue").length,
        summaryWidth: summary.getBoundingClientRect().width,
        summaryClientWidth: summary.clientWidth,
        summaryScrollWidth: summary.scrollWidth,
        summaryHeight: summary.getBoundingClientRect().height,
        previewWidth: document.getElementById("shipDamageCanvas").getBoundingClientRect().width,
        previewBottom: document.getElementById("shipDamageCanvas").getBoundingClientRect().bottom,
        viewportHeight: innerHeight
      };
    });
    assert.strictEqual(compactStructure.oldCards, 0, "old equal-weight card wall removed");
    assert(compactStructure.directIssues <= 3, "at most three priority issues visible initially");
    assert(compactStructure.summaryScrollWidth <= compactStructure.summaryClientWidth + 1, `summary has no horizontal overflow (${compactStructure.summaryScrollWidth}/${compactStructure.summaryClientWidth})`);
    assert(compactStructure.summaryHeight <= 331, `summary remains compact (${compactStructure.summaryHeight}px)`);
    assert(compactStructure.previewWidth >= 150, `ship preview remains usable (${compactStructure.previewWidth}px)`);
    assert(compactStructure.previewBottom <= compactStructure.viewportHeight + 1, "ship preview remains visible in the status viewport");
    await page.locator("#shipDamagePanel").screenshot({ path: path.join(artifactDir, "power-underpowered-1280x960.png") });

    // Locate selects the exact overloaded section in the preview. It changes
    // only UI selection state, never the snapshot wiring topology.
    const wiringBeforeLocate = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return JSON.stringify(state.snapshot.ships[0].powerWiring);
    });
    const moreIssues = page.locator(".power-more-issues");
    if (await moreIssues.count()) await page.evaluate(() => document.querySelector(".power-more-issues > summary").click());
    const locate = page.locator("[data-power-locate-section=\"3,0:4,0\"]");
    assert(await locate.count(), "overloaded section offers Locate");
    await page.evaluate(() => document.querySelector("[data-power-locate-section=\"3,0:4,0\"]").click());
    const located = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return {
        readout: document.getElementById("shipDamageHover").textContent,
        wiring: JSON.stringify(state.snapshot.ships[0].powerWiring)
      };
    });
    assert(located.readout.includes("3,0:4,0"), `Locate opens exact section readout: ${located.readout}`);
    assert.strictEqual(located.wiring, wiringBeforeLocate, "Locate does not mutate Power wiring");

    // 15. Overlay draws on the canvas in Power view (non-empty pixels).
    const painted = await page.evaluate(() => {
      const canvas = document.getElementById("shipDamageCanvas");
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonEmpty = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) nonEmpty += 1;
      return nonEmpty;
    });
    assert(painted > 500, `Power view draws the diagram + wiring overlay (painted ${painted}px)`);

    // 19. Component hover shows Power-specific details (drive the module readout).
    const generatorReadout = await page.evaluate(() => {
      const canvas = document.getElementById("shipDamageCanvas");
      const diag = window.__mfaPanel.shipDamageComponentClientPoint("s1", 0);
      if (!diag) return null;
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: diag.x, clientY: diag.y, pointerType: "mouse", bubbles: true }));
      return document.getElementById("shipDamageHover").textContent;
    });
    for (const text of ["Rated: 12 MW", "Available: 10 MW", "Delivered: 8 MW", "Unused: 2 MW"]) assert(generatorReadout.includes(text), `generator readout includes ${text}: ${generatorReadout}`);
    const unavailableGenerator = await page.evaluate(async (shipData) => {
      const [{ state }, panel] = await Promise.all([import("/src/state.js"), import("/src/ui/shipDamagePanelUi.js")]);
      const clone = structuredClone(shipData);
      clone.powerThermal.components[0].availableGenerationMw = null;
      clone.powerThermal.components[0].deliveredGenerationMw = null;
      clone.powerThermal.components[0].unusedGenerationMw = null;
      state.snapshot = { ships: [clone], players: [{ id: "p1", color: "#8fd8ff" }] };
      state.selectedShipIds = new Set([clone.id]);
      state.shipStatusView = "power";
      panel.renderShipDamagePanel();
      const canvas = document.getElementById("shipDamageCanvas");
      const diag = panel.shipDamageComponentClientPoint("s1", 0);
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: diag.x, clientY: diag.y, pointerType: "mouse", bubbles: true }));
      return document.getElementById("shipDamageHover").textContent;
    }, SHIP);
    assert(unavailableGenerator.includes("Available: Unavailable"), unavailableGenerator);
    await setup(page, SHIP);
    await clickTab(page, "shipPowerTab");
    const keyboard = await page.evaluate(() => {
      const damage = document.getElementById("shipDamageTab");
      const heat = document.getElementById("shipHeatTab");
      const power = document.getElementById("shipPowerTab");
      damage.focus();
      damage.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      const afterRight = document.activeElement.id;
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
      const afterEnd = document.activeElement.id;
      document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
      const afterHome = document.activeElement.id;
      heat.focus();
      heat.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      return { afterRight, afterEnd, afterHome, heatSelected: heat.getAttribute("aria-selected"), powerTabIndex: power.getAttribute("tabindex") };
    });
    assert.strictEqual(keyboard.afterRight, "shipHeatTab", "Right arrow focuses Heat");
    assert.strictEqual(keyboard.afterEnd, "shipPowerTab", "End focuses Power");
    assert.strictEqual(keyboard.afterHome, "shipDamageTab", "Home focuses Damage");
    assert.strictEqual(keyboard.heatSelected, "true", "Enter activates focused Heat tab");
    assert.strictEqual(keyboard.powerTabIndex, "-1", "inactive Power tab removed from tab order");
    await clickTab(page, "shipPowerTab");
    const consumerReadout = await page.evaluate(() => {
      const canvas = document.getElementById("shipDamageCanvas");
      const rect = canvas.getBoundingClientRect();
      // Hover the blaster (index 3) — dispatch a pointermove over its cell.
      const diag = window.__mfaPanel.shipDamageComponentClientPoint("s1", 3);
      if (!diag) return null;
      canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: diag.x, clientY: diag.y, pointerType: "mouse", bubbles: true }));
      return document.getElementById("shipDamageHover").textContent;
    });
    assert(consumerReadout && /requested|allocated|Power/.test(consumerReadout), `consumer hover shows Power details: ${consumerReadout}`);

    // Healthy snapshots show a single affirmative line rather than zero-value
    // warning cards.
    await setup(page, healthyShip());
    await clickTab(page, "shipPowerTab");
    const healthy = await page.evaluate(() => {
      const summary = document.getElementById("shipPowerSummary");
      return {
        powered: !!summary.querySelector(".power-overall-powered"),
        issueCards: summary.querySelectorAll(".power-issue").length,
        text: summary.textContent
      };
    });
    assert(healthy.powered, "healthy snapshot renders Powered state");
    assert.strictEqual(healthy.issueCards, 0, "healthy snapshot renders no warning cards");
    assert(healthy.text.includes("No Power issues detected"), "healthy state is explicit");

    // Automatic route isolation is explained in plain Power terminology.
    await setup(page, protectedRouteShip());
    await clickTab(page, "shipPowerTab");
    const tripped = await page.evaluate(() => {
      const summary = document.getElementById("shipPowerSummary");
      const more = summary.querySelector(".power-more-issues");
      if (more) more.open = true;
      return {
        critical: !!summary.querySelector(".power-overall-critical"),
        text: summary.textContent
      };
    });
    assert(tripped.critical, "protection trip renders Critical overall state");
    assert(tripped.text.includes("Power route temporarily offline"), "isolated route is a prioritized issue");
    assert(tripped.text.includes("recovery in 2 s"), "recovery timing is visible");
    assert(!tripped.text.includes("Switchgear"), "specialist component terminology is hidden");
    await page.locator("#shipDamagePanel").screenshot({ path: path.join(artifactDir, "power-route-offline-1280x960.png") });

    // The panel remains internally compact and unclipped at the specified
    // desktop/tablet/mobile viewports. Capture each state as regression output.
    for (const [width, height] of [[1920, 1080], [1440, 900], [1280, 720], [768, 1024], [430, 932], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await setup(page, healthyShip());
      await clickTab(page, "shipPowerTab");
      const geometry = await page.evaluate(() => {
        const panel = document.getElementById("shipDamagePanel");
        const summary = document.getElementById("shipPowerSummary");
        const canvas = document.getElementById("shipDamageCanvas");
        const tabs = document.querySelector(".status-view-tabs");
        return {
          panelOverflow: panel.scrollWidth - panel.clientWidth,
          summaryOverflow: summary.scrollWidth - summary.clientWidth,
          summaryHeight: summary.getBoundingClientRect().height,
          canvasWidth: canvas.getBoundingClientRect().width,
          tabsWidth: tabs.getBoundingClientRect().width,
          panelWidth: panel.getBoundingClientRect().width
        };
      });
      assert(geometry.panelOverflow <= 1, `${width}x${height}: panel has no horizontal overflow`);
      assert(geometry.summaryOverflow <= 1, `${width}x${height}: summary has no horizontal overflow`);
      assert(geometry.summaryHeight <= 331, `${width}x${height}: summary stays compact`);
      assert(geometry.canvasWidth >= 150, `${width}x${height}: preview remains usable`);
      assert(geometry.tabsWidth <= geometry.panelWidth, `${width}x${height}: tabs are not clipped`);
      await page.locator("#shipDamagePanel").screenshot({ path: path.join(artifactDir, `power-healthy-${width}x${height}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 960 });
    await setup(page, SHIP);
    await clickTab(page, "shipPowerTab");

    // 3-6. Heat tab is thermal-only.
    await clickTab(page, "shipHeatTab");
    const heatText = await page.evaluate(() => ({
      summary: document.getElementById("shipHeatSummary").textContent,
      powerSummaryHidden: document.getElementById("shipPowerSummary").hidden
    }));
    assert(heatText.powerSummaryHidden, "Power summary hidden on Heat tab");
    for (const gone of ["Power gen", "Power delivered", "Power spare", "Power protection", "Priority preset", "Tripped Switchgear", "Most stressed", "Power cable Heat"]) {
      assert(!heatText.summary.includes(gone), `Heat tab must not show: ${gone}`);
    }
    for (const kept of ["Overall heat", "Component Heat rate", "Cooling", "Heat state"]) {
      assert(heatText.summary.includes(kept), `Heat tab keeps thermal row: ${kept}`);
    }

    // 24. Switching to Damage clears the readout (no stale Power/Heat text).
    await clickTab(page, "shipDamageTab");
    const damageReadout = await page.evaluate(() => document.getElementById("shipDamageHover").textContent);
    assert(!/requested|allocated|cable Heat/i.test(damageReadout), `Damage readout is not stale Power text: ${damageReadout}`);

    assert.deepStrictEqual(errors, [], `no page errors: ${errors.join("; ")}`);
    console.log("verify-combat-power-tab-browser passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})();
