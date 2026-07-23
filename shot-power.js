#!/usr/bin/env node
"use strict";
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const d = await import("/src/ui/designerUi.js");
      document.querySelector("#blueprintDesignerScreen").hidden = false;
      d.renderBuildGrid();
    });
    await page.locator("#blueprintWiringTab").click();

    // A ship that generates less than it demands, so Propulsion is load-shed.
    await page.evaluate(async () => {
      const [{ state }, designer, wiring, { PART_STATS }] = await Promise.all([
        import("/src/state.js"), import("/src/ui/designerUi.js"), import("/src/ui/wiringUi.js"), import("/src/design/parts.js")
      ]);
      state.design = [
        { x: 5, y: 5, type: "reactor", rotation: 0 },
        { x: 7, y: 5, type: "shield", rotation: 0 },
        { x: 8, y: 5, type: "shield", rotation: 0 },
        { x: 6, y: 6, type: "engine", rotation: 0 },
        { x: 7, y: 6, type: "engine", rotation: 0 },
        { x: 8, y: 6, type: "blaster", rotation: 0 },
        { x: 9, y: 5, type: "heatSink", rotation: 0 }
      ];
      let w = window.WiringRules.emptyWiring();
      const cells = [{ x: 6, y: 5 }, { x: 7, y: 5 }, { x: 8, y: 5 }, { x: 9, y: 5 }];
      w = window.WiringRules.addPathWithTier(w, "power", cells, state.design, PART_STATS, "heavy");
      w = window.WiringRules.addPathWithTier(w, "power", [{ x: 7, y: 5 }, { x: 7, y: 6 }, { x: 6, y: 6 }], state.design, PART_STATS, "standard");
      w = window.WiringRules.addPathWithTier(w, "power", [{ x: 8, y: 5 }, { x: 8, y: 6 }], state.design, PART_STATS, "standard");
      state.wiring = w;
      wiring.resetWiringEditorState();
      designer.renderBuildGrid();
      designer.setBlueprintView("wiring");
      designer.renderLocalStats();
    });
    await page.locator("#designerAnalysisTab").click();
    await page.locator("#analysisPowerTab").click();
    await page.locator('[data-wiring-panel="power-allocation"]').waitFor({ state: "visible", timeout: 5000 });
    await page.locator('[data-wiring-panel="power-allocation"]').scrollIntoViewIfNeeded();
    const panel = page.locator('[data-wiring-panel="power-allocation"]');
    console.log(await panel.innerText());
    require("fs").mkdirSync("test-artifacts/power-alloc", { recursive: true });
    await panel.screenshot({ path: "test-artifacts/power-alloc/panel.png" });
    // Overflow check: the panel must not scroll horizontally at a narrow width.
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('[data-wiring-panel="power-allocation"]');
      return { scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    console.log("overflow:", JSON.stringify(overflow));
    console.log(JSON.stringify(await page.evaluate(() => {
      const root = document.querySelector('[data-wiring-panel="power-allocation"]');
      const rb = root.getBoundingClientRect();
      const out = [];
      for (const el of root.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right > rb.right + 0.5 || r.width > rb.width + 0.5) out.push({ cls: el.getAttribute('class'), w: Math.round(r.width), over: Math.round(r.right - rb.right) });
      }
      return { rootW: Math.round(rb.width), out: out.slice(0, 12) };
    }), null, 1));
    await page.setViewportSize({ width: 900, height: 1000 });
    await panel.screenshot({ path: "test-artifacts/power-alloc/panel-narrow.png" });
    console.log("narrow overflow:", JSON.stringify(await page.evaluate(() => {
      const el = document.querySelector('[data-wiring-panel="power-allocation"]');
      return { scrollW: el.scrollWidth, clientW: el.clientWidth };
    })));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})();
