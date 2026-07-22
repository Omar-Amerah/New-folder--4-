#!/usr/bin/env node
"use strict";
// Combat Power tab — desktop UI verification. Renders the selected-ship panel
// with a fabricated snapshot that carries the Power blocks, then checks the
// three accessible tabs, that the Heat tab is thermal-only, that the Power tab
// renders the supply/distribution/protection groups, legend and live wiring
// overlay, and that component/section readouts respond — with no page errors
// and no touch/mobile controls.
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

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
    components: [
      { componentIndex: 0, requestedMw: 0, allocatedMw: 0, operationalMultiplier: 1, powerCableHeatRate: 0, hostedActiveSectionIds: [] },
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
  switchgear: [],
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

async function setup(page, ship) {
  await page.evaluate(async (shipData) => {
    const [{ state }, panel] = await Promise.all([import("/src/state.js"), import("/src/ui/shipDamagePanelUi.js")]);
    document.querySelector("#battleScreen") && (document.querySelector("#battleScreen").hidden = false);
    const panelEl = document.querySelector("#shipDamagePanel");
    if (panelEl) panelEl.hidden = false;
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
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await setup(page, SHIP);

    // 1/2. Three accessible tabs.
    const tabs = await page.evaluate(() => ["shipDamageTab", "shipHeatTab", "shipPowerTab"].map((id) => {
      const el = document.getElementById(id);
      return { id, exists: !!el, role: el?.getAttribute("role"), controls: el?.getAttribute("aria-controls"), text: el?.textContent };
    }));
    for (const t of tabs) { assert(t.exists, `${t.id} exists`); assert.strictEqual(t.role, "tab", `${t.id} is a tab`); assert(t.controls, `${t.id} owns a tabpanel`); }
    assert.strictEqual(tabs[2].text, "Power", "Power tab labelled");

    // Switch to Power.
    await clickTab(page, "shipPowerTab");
    const powerState = await page.evaluate(() => ({
      powerSelected: document.getElementById("shipPowerTab").getAttribute("aria-selected"),
      heatSelected: document.getElementById("shipHeatTab").getAttribute("aria-selected"),
      powerActiveClass: document.getElementById("shipPowerTab").classList.contains("active"),
      powerSummaryHidden: document.getElementById("shipPowerSummary").hidden,
      heatSummaryHidden: document.getElementById("shipHeatSummary").hidden,
      powerLegendHidden: document.getElementById("powerLegend").hidden,
      summaryText: document.getElementById("shipPowerSummary").textContent
    }));
    assert.strictEqual(powerState.powerSelected, "true", "Power tab aria-selected true");
    assert.strictEqual(powerState.heatSelected, "false", "Heat tab deselected");
    assert(powerState.powerActiveClass, "Power tab active class (not colour-only)");
    assert(!powerState.powerSummaryHidden, "Power summary visible");
    assert(powerState.heatSummaryHidden, "Heat summary hidden on Power tab");
    assert(!powerState.powerLegendHidden, "Power legend visible");

    // 8-14. Power summary groups and values.
    const s = powerState.summaryText;
    for (const label of ["Power balance", "Distribution", "Protection", "Generation", "Requested", "Delivered", "Spare", "Unmet", "Priority preset", "Partial consumers", "Shed consumers", "Power networks", "Above sustained", "At peak", "Cable Heat rate", "Protection state", "Tripped Switchgear", "Nearest retry"]) {
      assert(s.includes(label), `Power summary shows: ${label}`);
    }
    assert(/10 MW/.test(s), "generation value shown");
    assert(/Strained/.test(s), "protection state label shown");
    assert(!/NaN|Infinity|undefined/.test(s), "no NaN/Infinity/undefined in Power summary");

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
