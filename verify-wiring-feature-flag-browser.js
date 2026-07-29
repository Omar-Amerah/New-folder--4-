#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

(async () => {
  const port = uniquePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server } = startServer(port);
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${baseUrl}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);

    const result = await page.evaluate(async () => {
      const flags = await import("/src/featureFlags.js");
      const designer = await import("/src/ui/designerUi.js");
      const { state } = await import("/src/state.js");
      const storage = await import("/src/design/blueprintStorage.js");
      const statsModule = await import("/src/design/componentStats.js");
      const design = storage.defaultDesign();
      const withWiring = statsModule.computeStats(design, { wiring: storage.defaultWiring() });
      const withoutWiring = statsModule.computeStats(design, { wiring: window.WiringRules.emptyWiring() });
      designer.setBlueprintView("wiring");
      return {
        enabled: flags.WIRING_ENABLED,
        view: state.blueprintView,
        featureElementsHidden: [...document.querySelectorAll("[data-feature-wiring]")]
          .every((element) => element.hidden),
        noWiringElementsVisible: [...document.querySelectorAll("[data-feature-no-wiring]")]
          .every((element) => !element.hidden),
        costWithWiring: withWiring.unitCost,
        costWithoutWiring: withoutWiring.unitCost,
        infrastructure: withWiring.costBreakdown.totalInfrastructure,
        efficiency: withWiring.powerEfficiency
      };
    });

    if (result.enabled) {
      assert.equal(result.featureElementsHidden, false, "enabled Wiring controls are visible");
      assert.equal(result.view, "wiring", "enabled Wiring view remains accessible");
      assert.notEqual(result.infrastructure, undefined, "enabled Wiring cost is visible");
    } else {
      assert.equal(result.featureElementsHidden, true, "disabled Wiring controls are hidden");
      assert.equal(result.view, "build", "disabled Wiring view cannot be entered programmatically");
      assert.equal(result.costWithWiring, result.costWithoutWiring, "saved cable layout does not change cost");
      assert.equal(result.infrastructure, undefined, "disabled Wiring cost rows are absent");
      assert.equal(result.efficiency, 1, "designer previews universal Power");
      assert.equal(result.noWiringElementsVisible, true, "standalone Data analysis is visible without Wiring");
      const dataTab = await page.evaluate(async () => {
        const inspector = await import("/src/ui/designerInspectorUi.js");
        const designer = await import("/src/ui/designerUi.js");
        const inspectorModel = await import("/src/design/componentInspectorModel.js");
        const { state } = await import("/src/state.js");
        state.design = [
          { type: "fireControl", x: 6, y: 7, rotation: 0 },
          { type: "blaster", x: 7, y: 7, rotation: 0 },
          { type: "railgun", x: 8, y: 7, rotation: 0 }
        ];
        designer.renderLocalStats();
        inspector.activateDesignerInspectorTab("analysis");
        inspector.activateDesignerAnalysisTab("data");
        return {
          panelHidden: document.getElementById("analysisDataPanel").hidden,
          selected: document.getElementById("analysisDataTab").getAttribute("aria-selected"),
          text: document.getElementById("dataAnalysisSummary").textContent,
          dataRequirement: inspectorModel.requirementsFor("fireControl", { fireRateBonus: 0.15 }, {
            includePowerRequirements: false,
            includeDataRequirements: true,
            automaticDataLinks: true
          }).find((entry) => entry.id === "data")
        };
      });
      assert.equal(dataTab.panelHidden, false, "Data analysis opens as its own tab");
      assert.equal(dataTab.selected, "true", "Data analysis tab reports selected state");
      assert.match(dataTab.text, /Automatic Data links/i, "Data analysis explains automatic links");
      assert.match(dataTab.text, /smaller share/i, "Data analysis explains diminishing returns");
      assert.match(dataTab.text, /shared across 2 linked weapons/i, "Data analysis reports the selected recipient count");
      assert.equal(dataTab.dataRequirement.summary, "Automatic links", "Data-support components no longer ask for a cable");
      assert.match(dataTab.dataRequirement.detail, /smaller share/i, "component inspector explains automatic diminishing returns");
    }
    assert.deepEqual(errors, []);
    console.log(`Wiring browser feature-flag verification passed (${result.enabled ? "enabled" : "disabled"})`);
  } finally {
    await browser?.close?.();
    server.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
