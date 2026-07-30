#!/usr/bin/env node
"use strict";

const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("../verify-pixi-browser-support.js");

const SCENARIOS = {
  linked: {
    design: [
      { type: "core", x: 7, y: 8, rotation: 0 },
      { type: "fireControl", x: 6, y: 7, rotation: 0 },
      { type: "blaster", x: 7, y: 7, rotation: 0 },
      { type: "railgun", x: 8, y: 7, rotation: 0 },
      { type: "signalAmplifier", x: 6, y: 9, rotation: 0 }
    ],
    dataLinks: [{ sourceIndex: 1, targetIndex: 2 }, { sourceIndex: 1, targetIndex: 3 }, { sourceIndex: 4, targetIndex: 2 }]
  },
  unlinked: {
    design: [
      { type: "core", x: 7, y: 8, rotation: 0 },
      { type: "fireControl", x: 6, y: 7, rotation: 0 },
      { type: "blaster", x: 7, y: 7, rotation: 0 }
    ],
    dataLinks: []
  },
  bare: {
    design: [{ type: "core", x: 7, y: 8, rotation: 0 }],
    dataLinks: []
  }
};

(async () => {
  const port = uniquePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server } = startServer(port);
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);

    await page.evaluate(async () => {
      document.querySelector("#mainMenuScreen").hidden = true;
      const screenUi = await import("/src/ui/designerScreenUi.js");
      screenUi.openBlueprintDesigner();
    });
    await page.locator("#blueprintDesignerScreen:not([hidden])").waitFor({ state: "visible" });

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const info = await page.evaluate(async (payload) => {
        const { state } = await import("/src/state.js");
        const designer = await import("/src/ui/designerUi.js");
        const inspector = await import("/src/ui/designerInspectorUi.js");
        state.design = payload.design;
        state.dataLinks = payload.dataLinks;
        designer.renderBuildGrid();
        designer.renderLocalStats();
        inspector.activateDesignerInspectorTab("analysis");
        inspector.activateDesignerAnalysisTab("data");
        const host = document.getElementById("dataAnalysisSummary");
        const right = host.getBoundingClientRect().right;
        return {
          status: host.querySelector(".data-badge")?.textContent,
          rows: host.querySelectorAll(".data-component-row").length,
          details: [...host.querySelectorAll(".data-component-detail")].map((n) => n.textContent),
          empty: [...host.querySelectorAll(".data-delivered-empty")].map((n) => n.textContent),
          overflow: host.scrollWidth - host.clientWidth,
          overflowing: [...host.querySelectorAll("*")].filter((n) => n.getBoundingClientRect().right > right + 1).length
        };
      }, scenario);
      console.log(name, JSON.stringify(info));
      await page.locator("#analysisDataPanel").screenshot({ path: `${process.argv[2] || "data-tab"}-${name}.png` });
    }

    // The Data Links blueprint view must still render the shared cards.
    const linksView = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const designer = await import("/src/ui/designerUi.js");
      state.design = [
        { type: "core", x: 7, y: 8, rotation: 0 },
        { type: "fireControl", x: 6, y: 7, rotation: 0 },
        { type: "blaster", x: 7, y: 7, rotation: 0 }
      ];
      state.dataLinks = [{ sourceIndex: 1, targetIndex: 2 }];
      designer.setBlueprintView("dataLinks");
      designer.renderBuildGrid();
      designer.renderLocalStats();
      const panel = document.getElementById("wiringStatusPanel");
      return { hidden: panel.hidden, rows: panel.querySelectorAll(".data-component-row").length, cards: panel.querySelectorAll(".data-inspection-card").length };
    });
    console.log("dataLinksView", JSON.stringify(linksView));
    console.log("errors:", errors);
  } finally {
    await browser?.close?.();
    server.kill("SIGTERM");
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
