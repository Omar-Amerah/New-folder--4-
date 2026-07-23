#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { uniquePort, startServer, waitForServer, launchChromium } = require("./verify-pixi-browser-support.js");

const artifactDir = path.join("test-artifacts", "wiring-workspace");
const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 768, height: 1024 },
  { width: 430, height: 932 },
  { width: 390, height: 844 }
];

async function openFixture(page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);
  await page.evaluate(async () => {
    document.querySelector("#mainMenuScreen").hidden = true;
    const [{ state }, designer, screen, wiring, { PART_STATS }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerUi.js"),
      import("/src/ui/designerScreenUi.js"),
      import("/src/ui/wiringUi.js"),
      import("/src/design/parts.js")
    ]);
    screen.openBlueprintDesigner();
    state.design = [
      { x: 0, y: 0, type: "reactor" },
      { x: 2, y: 0, type: "frame" },
      { x: 3, y: 0, type: "shield" },
      { x: 4, y: 0, type: "blaster" },
      { x: 2, y: 1, type: "engine" },
      { x: 4, y: 1, type: "frame" },
      { x: 0, y: 3, type: "fireControl" },
      { x: 1, y: 3, type: "railgun" }
    ];
    let configured = window.WiringRules.emptyWiring();
    configured = window.WiringRules.addPathWithTier(configured, "power", [
      { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }
    ], state.design, PART_STATS, "standard");
    configured = window.WiringRules.addPathWithTier(configured, "power", [
      { x: 3, y: 0 }, { x: 4, y: 0 }
    ], state.design, PART_STATS, "light");
    configured = window.WiringRules.addPathWithTier(configured, "power", [
      { x: 2, y: 0 }, { x: 2, y: 1 }
    ], state.design, PART_STATS, "light");
    configured = window.WiringRules.addPath(configured, "data", [
      { x: 0, y: 3 }, { x: 1, y: 3 }
    ], state.design, PART_STATS);
    state.wiring = configured;
    wiring.resetWiringEditorState();
    designer.renderBuildGrid();
    designer.setBlueprintView("wiring");
  });
  await page.locator("#blueprintDesignerScreen:not([hidden])").waitFor({ state: "visible" });
  await page.locator(".wiring-overlay-host svg.wiring-overlay").waitFor({ state: "visible" });
  await page.locator("#designerAnalysisTab").click();
}

async function preparePath(page, tier, cells) {
  await page.evaluate(async ({ tier, cells }) => {
    const [{ state }, wiring] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/wiringUi.js")
    ]);
    state.wiringUi.mode = "power";
    state.wiringUi.wiringTool = "draw";
    state.wiringUi.selectedPowerTier = tier;
    state.wiringUi.sourceIndex = state.design.findIndex(part => part.x === cells[0].x && part.y === cells[0].y);
    state.wiringUi.path = cells;
    state.wiringUi.selectedSectionId = null;
    wiring.refreshWiringPresentation();
  }, { tier, cells });
}

async function sectionTier(page, id) {
  return page.evaluate(sectionId => window.__mfaState.wiring.power.sections.find(section => section.id === sectionId)?.tier, id);
}

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const port = uniquePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server, getLog } = startServer(port);
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, baseURL: baseUrl });
    const errors = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
    await openFixture(page);

    const tools = await page.locator(".wiring-tool-row [data-wiring-tool]").allTextContents();
    assert.deepEqual(tools.map(text => text.trim()), ["Draw", "Erase", "Inspect"]);
    assert.equal(await page.getByRole("button", { name: /Change Tier/i }).count(), 0);
    assert.equal(await page.locator('[role="group"][aria-label="Wiring network type"]').count(), 1);
    assert.equal(await page.locator(".wiring-tool-row").getAttribute("aria-label"), "Wiring tool");
    assert.equal(await page.locator("#wiringTierRow").getAttribute("aria-label"), "Power cable tier");
    assert.equal(await page.locator('[data-wiring-tool="draw"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".wiring-control-label").count(), 0, "visible group labels removed");
    assert.doesNotMatch(await page.locator("#wiringToolbar").innerText(), /\b(?:NETWORK|TOOL|TIER)\b/);
    assert.equal(await page.locator("#wiringToolbar #wiringUndoButton").count(), 1);
    assert.equal(await page.locator("#wiringToolbar #wiringClearNetworkButton").count(), 1);
    assert.equal(await page.locator("#wiringToolbar #wiringHelpButton").count(), 1);
    const selectedPresentation = await page.locator('#wiringToolbar button[aria-pressed="true"]').evaluateAll(buttons => ({
      text: buttons.map(button => button.textContent).join(" "),
      before: buttons.map(button => getComputedStyle(button, "::before").content)
    }));
    assert.doesNotMatch(selectedPresentation.text, /✓|✔/, "selected controls contain no checkmark characters");
    assert.ok(selectedPresentation.before.every(content => content === "none" || content === "normal"), "selected controls add no checkmark pseudo-content");
    assert.equal(await page.locator("#wiringHelpPanel").isHidden(), true);
    assert.equal(await page.locator("#analysisWiringTab").getAttribute("aria-selected"), "true");
    assert.match(await page.locator('[data-wiring-panel="selected-tier"]').innerText(), /Standard Cable/);

    for (const target of [
      { width: 1920, height: 1080, maxRows: 1, file: "wiring-1920x1080.png" },
      { width: 1280, height: 720, maxRows: 2, file: "wiring-1280x720.png" }
    ]) {
      await page.setViewportSize(target);
      const desktopGeometry = await page.evaluate(() => {
        const toolbar = document.querySelector("#blueprintModeContext").getBoundingClientRect();
        const grid = document.querySelector("#buildGridStage").getBoundingClientRect();
        const forward = document.querySelector(".forward-marker").getBoundingClientRect();
        const groups = [...document.querySelectorAll("#wiringToolbar > .wiring-control-row")];
        const groupTops = groups.map(group => Math.round(group.getBoundingClientRect().top)).sort((a, b) => a - b);
        const groupRows = groupTops.reduce((rows, top) => !rows.length || top - rows.at(-1) > 10 ? [...rows, top] : rows, []);
        const controlsInside = [...document.querySelectorAll("#wiringToolbar button")].every(button => {
          if (button.closest("[hidden]")) return true;
          const rect = button.getBoundingClientRect();
          return rect.left >= toolbar.left - 1 && rect.right <= toolbar.right + 1;
        });
        return {
          toolbarHeight: Math.round(toolbar.height),
          markerGap: Math.round(grid.top - forward.bottom),
          gridVisible: grid.top < innerHeight && grid.bottom > 0,
          groupRows: groupRows.length,
          toolbarWidth: Math.round(toolbar.width),
          groupWidths: groups.map(group => Math.round(group.getBoundingClientRect().width)),
          controlsInside
        };
      });
      assert.ok(desktopGeometry.toolbarHeight <= 100, `${target.width}px toolbar is ${desktopGeometry.toolbarHeight}px tall`);
      assert.ok(desktopGeometry.markerGap >= -8 && desktopGeometry.markerGap <= 8, `Forward marker gap is ${desktopGeometry.markerGap}px`);
      assert.equal(desktopGeometry.gridVisible, true, `grid visible at ${target.width}x${target.height}`);
      assert.ok(desktopGeometry.groupRows <= target.maxRows, `${target.width}px toolbar layout: ${JSON.stringify(desktopGeometry)}`);
      assert.equal(desktopGeometry.controlsInside, true, "toolbar controls are not clipped");
      console.log(`${target.width}x${target.height}: toolbar ${desktopGeometry.toolbarHeight}px, ${desktopGeometry.groupRows} row(s), Forward gap ${desktopGeometry.markerGap}px`);
      await page.screenshot({ path: path.join(artifactDir, target.file) });
    }
    await page.screenshot({ path: path.join(artifactDir, "desktop-wiring.png") });

    await page.locator("#wiringModeData").click();
    assert.equal(await page.locator("#wiringTierRow").isHidden(), true);
    await page.locator("#wiringModePower").click();
    assert.equal(await page.locator("#wiringTierRow").isVisible(), true);

    // Mixed redraw: one existing Standard edge, one Light edge, and one empty
    // edge become Heavy in one undoable transaction. The unrelated branch stays Light.
    const beforeCost = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const { PART_STATS } = await import("/src/design/parts.js");
      const { WIRING_INFRASTRUCTURE } = await import("/src/constants.js");
      const accounting = window.WiringInfrastructureRules.accountInfrastructure(
        state.design, state.wiring, PART_STATS, WIRING_INFRASTRUCTURE
      );
      return accounting.power.cost + accounting.data.cost;
    });
    await preparePath(page, "heavy", [{ x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }]);
    await page.locator('[data-wiring-action="finish"]').click();
    assert.equal(await sectionTier(page, "2,0:3,0"), "heavy");
    assert.equal(await sectionTier(page, "3,0:4,0"), "heavy");
    assert.equal(await sectionTier(page, "4,0:4,1"), "heavy");
    assert.equal(await sectionTier(page, "2,0:2,1"), "light", "unrelated branch preserved");
    const afterCost = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const { PART_STATS } = await import("/src/design/parts.js");
      const { WIRING_INFRASTRUCTURE } = await import("/src/constants.js");
      const accounting = window.WiringInfrastructureRules.accountInfrastructure(
        state.design, state.wiring, PART_STATS, WIRING_INFRASTRUCTURE
      );
      return accounting.power.cost + accounting.data.cost;
    });
    assert.ok(afterCost > beforeCost, "redraw updates authoritative infrastructure cost");
    await page.locator("#wiringUndoButton").click();
    assert.equal(await sectionTier(page, "2,0:3,0"), "standard");
    assert.equal(await sectionTier(page, "3,0:4,0"), "light");
    assert.equal(await sectionTier(page, "4,0:4,1"), undefined);

    // Same-tier redraw is a no-op: no new revision and no new Undo entry.
    await preparePath(page, "standard", [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
    const noOpBefore = await page.evaluate(() => ({
      wiring: JSON.stringify(window.__mfaState.wiring),
      undo: window.__mfaState.wiringUi.undoStack.length
    }));
    await page.locator('[data-wiring-action="finish"]').click();
    const noOpAfter = await page.evaluate(() => ({
      wiring: JSON.stringify(window.__mfaState.wiring),
      undo: window.__mfaState.wiringUi.undoStack.length
    }));
    assert.deepEqual(noOpAfter, noOpBefore, "same-tier redraw does not mutate or add Undo history");

    // Inspect is non-mutating and exposes selected-section details.
    const beforeInspect = await page.evaluate(() => JSON.stringify(window.__mfaState.wiring));
    await page.locator('[data-wiring-tool="inspect"]').click();
    await page.locator('.wire-hit[data-section-id="3,0:4,0"]').click({ force: true });
    assert.equal(await page.evaluate(() => JSON.stringify(window.__mfaState.wiring)), beforeInspect);
    assert.match(await page.locator('[data-wiring-inspection="power-section"]').innerText(), /Cable rating:/);
    assert.match(await page.locator('[data-wiring-inspection="power-section"]').innerText(), /Network ID:/);
    await page.screenshot({ path: path.join(artifactDir, "desktop-inspect.png") });

    // Erase remains a one-step edit and Undo restores the exact section.
    await page.locator('[data-wiring-tool="erase"]').click();
    assert.equal(await page.evaluate(() => window.__mfaState.wiringUi.wiringTool), "erase");
    await page.locator('.wire-hit[data-section-id="3,0:4,0"]').dispatchEvent("click");
    assert.equal(await sectionTier(page, "3,0:4,0"), undefined);
    await page.locator("#wiringUndoButton").click();
    assert.equal(await sectionTier(page, "3,0:4,0"), "light");

    await page.locator('[data-wiring-tool="inspect"]').click();
    await page.locator('.wire-hit[data-section-id="3,0:4,0"]').dispatchEvent("click");
    assert.equal(await page.locator("#wiringClearNetworkButton").isEnabled(), true);
    await page.locator("#wiringClearNetworkButton").click();
    assert.equal(await page.locator("#confirmModal").isVisible(), true, "Clear Network retains confirmation");
    await page.locator("#confirmCancelButton").click();

    await page.locator("#wiringHelpButton").click();
    assert.equal(await page.locator("#wiringHelpButton").getAttribute("aria-expanded"), "true");
    await page.screenshot({ path: path.join(artifactDir, "desktop-help.png") });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#wiringHelpPanel").isHidden(), true);
    assert.equal(await page.locator("#wiringHelpButton").getAttribute("aria-expanded"), "false");

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => {
        const grid = document.querySelector("#buildGridStage").getBoundingClientRect();
        const toolbar = document.querySelector("#blueprintModeContext").getBoundingClientRect();
        const center = document.querySelector(".designer-center-col").getBoundingClientRect();
        const analysis = document.querySelector(".designer-right-col").getBoundingClientRect();
        const toolbarRect = document.querySelector("#wiringToolbar").getBoundingClientRect();
        const controlsInside = [...document.querySelectorAll("#wiringToolbar button")].every(button => {
          if (button.closest("[hidden]")) return true;
          const rect = button.getBoundingClientRect();
          return rect.left >= toolbarRect.left - 1 && rect.right <= toolbarRect.right + 1;
        });
        const groupTops = [...document.querySelectorAll("#wiringToolbar > .wiring-control-row")]
          .map(group => Math.round(group.getBoundingClientRect().top));
        return {
          documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          toolbarOverflow: document.querySelector("#wiringToolbar").scrollWidth > document.querySelector("#wiringToolbar").clientWidth + 1,
          gridAfterToolbar: grid.top >= toolbar.bottom - 1,
          gridVisible: grid.top < innerHeight,
          mobileGridFirst: innerWidth > 900 || center.top < analysis.top,
          controlsInside,
          mobileGroupOrder: innerWidth > 430 || groupTops.every((top, index) => index === 0 || top > groupTops[index - 1])
        };
      });
      assert.deepEqual(geometry, {
        documentOverflow: false,
        toolbarOverflow: false,
        gridAfterToolbar: true,
        gridVisible: true,
        mobileGridFirst: true,
        controlsInside: true,
        mobileGroupOrder: true
      }, `responsive Wiring geometry at ${viewport.width}x${viewport.height}`);
      if (viewport.width === 768 || viewport.width === 390) {
        await page.screenshot({ path: path.join(artifactDir, `wiring-${viewport.width}x${viewport.height}.png`) });
      }
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.querySelector(".blueprint-designer-panel").scrollTop = 0;
      document.querySelector(".designer-center-col").scrollTop = 0;
    });
    await page.screenshot({ path: path.join(artifactDir, "mobile-wiring.png") });
    await page.locator("#wiringHelpButton").click();
    await page.screenshot({ path: path.join(artifactDir, "mobile-help.png") });
    await page.keyboard.press("Escape");

    assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join("\n")}`);
    console.log(`Wiring workspace browser verification passed; screenshots: ${artifactDir}`);
  } catch (error) {
    await fs.promises.writeFile(path.join(artifactDir, "server.log"), getLog()).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
