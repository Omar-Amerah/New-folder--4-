#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const artifactDir = path.join("test-artifacts", "data-links-editor");

// Blueprint: one Fire Control + one Signal Amplifier, two weapons.
// Spread wide so link lines cross empty cells: a line passing over another
// component would be covered by that component's hit pad.
const DESIGN = [
  { type: "core", x: 7, y: 7, rotation: 0 },
  { type: "fireControl", x: 2, y: 2, rotation: 0 },
  { type: "blaster", x: 12, y: 2, rotation: 0 },
  { type: "railgun", x: 12, y: 10, rotation: 0 },
  { type: "signalAmplifier", x: 2, y: 11, rotation: 0 }
];
const FIRE_CONTROL = 1, BLASTER = 2, RAILGUN = 3, AMPLIFIER = 4;

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const port = uniquePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server } = startServer(port);
  let browser;
  const out = path.join(artifactDir, "data-links");
  try {
    await waitForServer(baseUrl);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);

    await page.evaluate(async (design) => {
      document.querySelector("#mainMenuScreen").hidden = true;
      const { state } = await import("/src/state.js");
      const screenUi = await import("/src/ui/designerScreenUi.js");
      const designer = await import("/src/ui/designerUi.js");
      const inspector = await import("/src/ui/designerInspectorUi.js");
      screenUi.openBlueprintDesigner();
      state.design = design;
      state.dataLinks = [];
      designer.setBlueprintView("dataLinks");
      designer.renderBuildGrid();
      designer.renderLocalStats();
      // Keep the Data analysis tab open so link edits can be observed there.
      inspector.activateDesignerInspectorTab("analysis");
      inspector.activateDesignerAnalysisTab("data");
    }, DESIGN);
    await page.locator("#blueprintDesignerScreen:not([hidden])").waitFor({ state: "visible" });

    const links = () => page.evaluate(async () => (await import("/src/state.js")).state.dataLinks.map((l) => `${l.sourceIndex}:${l.targetIndex}`).sort());
    const hint = () => page.locator("#dataLinksHint").textContent();

    // Centre of a component's first footprint cell, in page coordinates.
    async function centreOf(index) {
      return page.evaluate(async (i) => {
        const { state } = await import("/src/state.js");
        const { PART_STATS } = await import("/src/design/parts.js");
        const { getOccupiedCells } = await import("/src/design/footprint.js");
        const m = state.design[i];
        const cells = getOccupiedCells(m.x, m.y, PART_STATS[m.type]?.footprint || { width: 1, height: 1 }, m.rotation || 0);
        const svg = document.querySelector(".data-links-overlay");
        const box = svg.getBoundingClientRect();
        const cx = cells.reduce((s, c) => s + c.x + 0.5, 0) / cells.length;
        const cy = cells.reduce((s, c) => s + c.y + 0.5, 0) / cells.length;
        return { x: box.left + (cx / 15) * box.width, y: box.top + (cy / 15) * box.height };
      }, index);
    }
    const clickOn = async (index) => { const p = await centreOf(index); await page.mouse.click(p.x, p.y); };

    assert.match(await hint(), /Click a Data-support component/, "idle hint invites selecting a source");
    await page.locator("#analysisDataPanel").screenshot({ path: `${out}-panel-before.png` });

    // --- click-to-connect ---
    await clickOn(FIRE_CONTROL);
    assert.match(await hint(), /Fire Control selected/, "clicking a source arms it");
    const candidates = await page.locator(".data-link-candidate").count();
    assert.equal(candidates, 2, "both weapons are offered as candidates");
    await page.locator("#buildGridStage").screenshot({ path: `${out}-armed.png` });

    await clickOn(BLASTER);
    assert.deepEqual(await links(), [`${FIRE_CONTROL}:${BLASTER}`], "clicking a weapon links it");

    await clickOn(RAILGUN);
    assert.deepEqual(await links(), [`${FIRE_CONTROL}:${BLASTER}`, `${FIRE_CONTROL}:${RAILGUN}`], "a second weapon links too");
    assert.match(await hint(), /2 weapons linked/, "hint counts the links");

    // Clicking a linked weapon again unlinks it.
    await clickOn(BLASTER);
    assert.deepEqual(await links(), [`${FIRE_CONTROL}:${RAILGUN}`], "clicking a linked weapon unlinks it");

    // --- drag-to-connect ---
    const from = await centreOf(AMPLIFIER);
    const to = await centreOf(BLASTER);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
    await page.mouse.move(to.x, to.y, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await links(), [`${FIRE_CONTROL}:${RAILGUN}`, `${AMPLIFIER}:${BLASTER}`], "dragging a source onto a weapon links it");
    await page.locator("#buildGridStage").screenshot({ path: `${out}-linked.png` });
    await page.locator("#analysisDataPanel").screenshot({ path: `${out}-panel-after.png` });

    // The analysis tab reflects the links.
    const panel = await page.evaluate(() => {
      const host = document.getElementById("dataAnalysisSummary");
      return { text: host.textContent.replace(/\s+/g, " "), lines: host.querySelectorAll(".data-link-line").length };
    });
    assert.match(panel.text, /2 \/ 2 active/, "analysis reports both sources delivering");
    assert.match(panel.text, /2 \/ 2 supported/, "analysis reports both weapons supported");

    // --- link selection + Delete ---
    // Sample 25% along the 1:3 line — the two links cross at their midpoints,
    // so the midpoint is an ambiguous hit target.
    const mid = await page.evaluate(() => {
      const line = document.querySelector('.data-link-hit[data-link-key="1:3"]');
      const svg = document.querySelector(".data-links-overlay");
      const box = svg.getBoundingClientRect();
      const at = (a, b) => a + (b - a) * 0.25;
      const gx = at(Number(line.getAttribute("x1")), Number(line.getAttribute("x2")));
      const gy = at(Number(line.getAttribute("y1")), Number(line.getAttribute("y2")));
      return { x: box.left + (gx / 15) * box.width, y: box.top + (gy / 15) * box.height };
    });
    const atPoint = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      return { tag: el?.tagName, cls: el?.getAttribute?.("class"), key: el?.getAttribute?.("data-link-key") };
    }, mid);
    assert.equal(atPoint.key, "1:3", `expected the 1:3 link under the sample point, got ${JSON.stringify(atPoint)}`);
    await page.mouse.click(mid.x, mid.y);
    assert.equal(await page.locator(".data-link-line.is-selected").count(), 1, "clicking a link selects it");
    await page.keyboard.press("Delete");
    assert.deepEqual(await links(), [`${AMPLIFIER}:${BLASTER}`], "Delete removes the selected link");

    // --- Escape deselects, Clear all wipes ---
    await clickOn(AMPLIFIER);
    assert.match(await hint(), /Signal Amplifier selected/, "amplifier arms");
    await page.keyboard.press("Escape");
    assert.match(await hint(), /Click a Data-support component/, "Escape deselects");

    await page.locator("#dataLinksClearButton").click();
    assert.deepEqual(await links(), [], "Clear all links empties the set");
    assert.equal(await page.locator("#dataLinksClearButton").isDisabled(), true, "Clear disables when there is nothing to clear");

    // --- links survive a save/load round trip ---
    const roundTrip = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const storage = await import("/src/design/blueprintStorage.js");
      state.dataLinks = [{ sourceIndex: 1, targetIndex: 2 }, { sourceIndex: 4, targetIndex: 3 }];
      const saved = storage.normalizeSavedDesignsForTests
        ? null
        : JSON.parse(JSON.stringify([{ id: "a", name: "A", blueprint: state.design, wiring: state.wiring, dataLinks: state.dataLinks, combatStyle: "hold" }]));
      const envelope = storage.savedDesignsEnvelope(saved);
      return envelope.payload[0].dataLinks.map((l) => `${l.sourceIndex}:${l.targetIndex}`).sort();
    });
    assert.deepEqual(roundTrip, ["1:2", "4:3"], "saved designs persist their data links");

    // --- deploy carries dataLinks ---
    const deployPayloads = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const sent = [];
      state.socket = { readyState: 1, send: (raw) => sent.push(raw) };
      state.phase = "active";
      state.dataLinks = [{ sourceIndex: 1, targetIndex: 2 }];
      const net = await import("/src/network.js");
      net.send({ type: "deploy", design: state.design, wiring: state.wiring, dataLinks: state.dataLinks, combatStyle: "hold" });
      return sent.length;
    });
    assert.ok(deployPayloads >= 1, "deploy message is sent");

    // --- switching view via the real tabs ---
    // Regression: the Build tab calls setBlueprintView + renderLocalStats but
    // never renderBuildGrid, so Data Links teardown has to happen in
    // setBlueprintView or the grid stays dimmed and swallows every click.
    const viewState = async () => page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const grid = document.getElementById("buildGrid");
      const host = document.getElementById("dataLinksOverlayHost");
      return {
        view: state.blueprintView,
        gridDimmed: grid.classList.contains("data-links-active"),
        overlayActive: host.classList.contains("is-active"),
        overlayChildren: host.childElementCount,
        pointerEvents: getComputedStyle(host).pointerEvents,
        toolbarHidden: document.getElementById("dataLinksToolbar")?.hidden,
        inspector: state.designerInspectorTab,
        analysis: state.designerAnalysisTab
      };
    });

    // Each view auto-opens the inspector section that reads on it.
    await page.locator("#blueprintDataLinksTab").click();
    let vs = await viewState();
    assert.equal(vs.inspector, "analysis", "Data Links opens the Analysis inspector");
    assert.equal(vs.analysis, "data", "Data Links opens the Data analysis tab");
    assert.equal(vs.overlayActive, true, "Data Links activates its overlay");
    assert.equal(vs.toolbarHidden, false, "Data Links shows its toolbar");

    await page.locator("#blueprintHeatTab").click();
    vs = await viewState();
    assert.equal(vs.inspector, "analysis", "Heat opens the Analysis inspector");
    assert.equal(vs.analysis, "heat", "Heat opens the Heat analysis tab");
    assert.equal(vs.gridDimmed, false, "Heat undims the grid");
    assert.equal(vs.overlayActive, false, "Heat tears down the Data Links overlay");

    await page.locator("#blueprintDataLinksTab").click();
    await page.locator("#blueprintBuildTab").click();
    vs = await viewState();
    assert.equal(vs.inspector, "design", "Build opens the Design inspector");
    assert.equal(vs.gridDimmed, false, "Build undims the grid");
    assert.equal(vs.toolbarHidden, true, "Build hides the Data Links toolbar");

    // Re-clicking the active view tab must not yank a manually chosen section.
    await page.locator("#designerBlueprintsTab").click();
    await page.locator("#blueprintBuildTab").click();
    assert.equal((await viewState()).inspector, "blueprints", "re-clicking the active view keeps the chosen inspector tab");

    const released = await page.evaluate(() => {
      const host = document.getElementById("dataLinksOverlayHost");
      return {
        active: host.classList.contains("is-active"),
        children: host.childElementCount,
        pointerEvents: getComputedStyle(host).pointerEvents
      };
    });
    assert.equal(released.active, false, "overlay deactivates when leaving Data Links");
    assert.equal(released.children, 0, "overlay is emptied when leaving Data Links");
    assert.equal(released.pointerEvents, "none", "overlay stops intercepting grid input");

    const placedOnGrid = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const before = state.design.length;
      const cell = document.querySelector('#buildGrid [data-x="5"][data-y="5"]')
        || document.querySelector("#buildGrid .build-cell");
      const box = cell.getBoundingClientRect();
      return { before, x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    const hit = await page.evaluate((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      return el?.closest?.("#buildGrid") ? "grid" : (el?.getAttribute?.("class") || el?.tagName || "none");
    }, placedOnGrid);
    assert.equal(hit, "grid", "Build-mode clicks reach the grid again");

    assert.deepEqual(errors, [], "no console or page errors");
    console.log("Data Links connect/disconnect verification passed");
  } finally {
    await browser?.close?.();
    server.kill("SIGTERM");
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
