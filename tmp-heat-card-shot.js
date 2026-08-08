"use strict";
// Scratch: render the Heat hover card in the real designer and screenshot it.
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");
const { uniquePort, startServer, waitForServer, launchChromium } = require("./tests/verify-pixi-browser-support.js");

const outDir = process.env.SHOT_DIR || path.join(require("node:os").tmpdir(), "heat-card-shots");

(async () => {
  const port = uniquePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server, getLog } = startServer(port);
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on("pageerror", e => errors.push(`pageerror: ${e.message}`));
    page.on("console", msg => { if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`); });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);
    await page.evaluate(async () => {
      document.querySelector("#mainMenuScreen").hidden = true;
      const screenUi = await import("/src/ui/designerScreenUi.js");
      screenUi.openBlueprintDesigner();
      const designerUi = await import("/src/ui/designerUi.js");
      designerUi.renderBuildGrid();
      designerUi.renderLocalStats();
    });
    await page.locator("#blueprintDesignerScreen:not([hidden]) #buildGrid").waitFor({ state: "visible" });

    fs.mkdirSync(outDir, { recursive: true });
    const shots = [];
    const types = JSON.parse(process.env.SHOT_TYPES || '["reactor","heatSink","radiator","heatPipe","engine","blaster","frame","core"]');
    // Place one of each interesting type at the ship edge so positioning is exercised too.
    const result = await page.evaluate(async ({ types }) => {
      const [{ state }, designerUi] = await Promise.all([import("/src/state.js"), import("/src/ui/designerUi.js")]);
      const free = [];
      for (let y = 0; y < 15 && free.length < 40; y += 1) for (let x = 0; x < 15; x += 1) {
        if (!state.design.some(p => p.x === x && p.y === y)) free.push({ x, y });
      }
      const cells = state.design.map(p => `${p.x},${p.y}`);
      // Grow from the existing hull so placement stays connected.
      const adjacentFree = free.filter(c => cells.some(k => {
        const [x, y] = k.split(",").map(Number);
        return Math.abs(x - c.x) + Math.abs(y - c.y) === 1;
      }));
      const placed = {};
      for (const type of types) {
        if (state.design.some(p => p.type === type)) { placed[type] = state.design.findIndex(p => p.type === type); continue; }
        const cell = adjacentFree.shift();
        if (!cell) continue;
        state.design.push({ x: cell.x, y: cell.y, type, rotation: 0 });
        placed[type] = state.design.length - 1;
      }
      state.blueprintView = "heat";
      designerUi.setBlueprintView("heat");
      designerUi.renderBuildGrid();
      designerUi.renderLocalStats();
      return { placed, design: state.design.map(p => `${p.type}@${p.x},${p.y}`) };
    }, { types });

    for (const [type, index] of Object.entries(result.placed)) {
      const cell = page.locator(`#buildGrid .build-cell[data-part-index="${index}"]`).first();
      if (!(await cell.count())) { shots.push(`${type}: no cell`); continue; }
      await cell.hover();
      await page.waitForTimeout(140);
      const info = await page.evaluate(() => {
        const card = document.getElementById("heatContextCard");
        const stage = document.getElementById("buildGridStage");
        if (!card || card.hidden) return null;
        const c = card.getBoundingClientRect(), s = stage.getBoundingClientRect();
        return {
          text: card.innerText, html: card.innerHTML,
          inside: c.left >= s.left - 1 && c.right <= s.right + 1 && c.top >= s.top - 1 && c.bottom <= s.bottom + 1,
          width: Math.round(c.width), height: Math.round(c.height),
          scrollWidth: card.scrollWidth, clientWidth: card.clientWidth
        };
      });
      shots.push({ type, index, info });
      await page.locator("#buildGridStage").screenshot({ path: path.join(outDir, `card-${type}.png`) }).catch(() => {});
    }
    console.log(JSON.stringify({ design: result.design, shots, errors }, null, 2));
    console.log("shots in", outDir);
  } catch (e) {
    console.error("FAILED", e.message, getLog?.());
    process.exitCode = 1;
  } finally {
    await browser?.close();
    server?.kill?.();
  }
})();
