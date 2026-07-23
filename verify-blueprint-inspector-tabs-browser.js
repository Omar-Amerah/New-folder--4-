#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { uniquePort, startServer, waitForServer, launchChromium } = require("./verify-pixi-browser-support.js");

const artifactDir = path.join("test-artifacts", "blueprint-inspector-tabs");
const viewports = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 768, height: 1024 },
  { width: 430, height: 932 },
  { width: 390, height: 844 }
];

(async () => {
  fs.mkdirSync(artifactDir, { recursive: true });
  const port = uniquePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const { server, getLog } = startServer(port);
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);
    await page.evaluate(async () => {
      document.querySelector("#mainMenuScreen").hidden = true;
      const storage = await import("/src/design/blueprintStorage.js");
      const { state } = await import("/src/state.js");
      const savedUi = await import("/src/ui/savedBlueprintsUi.js");
      const designerUi = await import("/src/ui/designerUi.js");
      const screenUi = await import("/src/ui/designerScreenUi.js");
      const base = storage.defaultDesign();
      const wiring = storage.defaultWiring();
      state.savedDesigns = [
        { id: "alpha", name: "Design Alpha", blueprint: base.map(part => ({ ...part })), wiring, combatStyle: "sentry", createdAt: 1, updatedAt: 2 },
        { id: "beta", name: "Design Beta", blueprint: base.map(part => ({ ...part })), wiring, combatStyle: "hold", createdAt: 2, updatedAt: 3 }
      ];
      state.loadedEditorBlueprintId = null;
      savedUi.renderSavedDesigns();
      screenUi.openBlueprintDesigner();
      designerUi.renderBuildGrid();
      designerUi.renderLocalStats();
    });
    await page.locator("#blueprintDesignerScreen:not([hidden])").waitFor({ state: "visible" });
    assert.equal(await page.locator("#combatStyleSelect").inputValue(), "hold", "new Blueprints default to Hold movement");
    const thumbnailDirections = await page.evaluate(async () => {
      const { shipThumbnailDataUrl } = await import("/src/ui/shipThumbnail.js");
      async function bounds(type, rotation) {
        const image = new Image();
        image.src = shipThumbnailDataUrl([{ x: 7, y: 7, type, rotation }], "#8fb4ff", 96);
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let minX = canvas.width, minY = canvas.height, maxX = -1, maxY = -1;
        for (let y = 0; y < canvas.height; y += 1) {
          for (let x = 0; x < canvas.width; x += 1) {
            if (pixels[(y * canvas.width + x) * 4 + 3] < 16) continue;
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
          }
        }
        return { width: maxX - minX + 1, height: maxY - minY + 1 };
      }
      return {
        reactor0: await bounds("reactor", 0),
        reactor90: await bounds("reactor", 90),
        repair0: await bounds("repairBeam", 0),
        repair90: await bounds("repairBeam", 90)
      };
    });
    assert.ok(thumbnailDirections.reactor0.width > thumbnailDirections.reactor0.height,
      `0° Reactor thumbnail points across its horizontal footprint (${JSON.stringify(thumbnailDirections.reactor0)})`);
    assert.ok(thumbnailDirections.reactor90.height > thumbnailDirections.reactor90.width,
      `90° Reactor thumbnail points down its vertical footprint (${JSON.stringify(thumbnailDirections.reactor90)})`);
    assert.ok(thumbnailDirections.repair0.width > thumbnailDirections.repair0.height,
      `0° Repair Beam thumbnail points across its horizontal footprint (${JSON.stringify(thumbnailDirections.repair0)})`);
    assert.ok(thumbnailDirections.repair90.height > thumbnailDirections.repair90.width,
      `90° Repair Beam thumbnail points down its vertical footprint (${JSON.stringify(thumbnailDirections.repair90)})`);

    await assertTopTab(page, "design", "designerDesignPanel");
    assert.equal(await page.locator("#loadedBlueprintName").textContent(), "Unsaved design");
    assert.equal(await page.locator("#partInspector").isVisible(), true);
    assert.equal(await page.evaluate(() => {
      const selected = document.querySelector("#selectedComponentHeading")?.closest(".inspector-section");
      const summary = document.querySelector("#shipSummaryHeading")?.closest(".inspector-section");
      return Boolean(selected && summary && (selected.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING));
    }), true, "Selected Component appears before Ship Summary");
    assert.equal(await page.locator(".stat[data-stat-key='power'] strong").evaluate(element => getComputedStyle(element).textOverflow), "clip");
    await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      state.selectedPart = null;
      (await import("/src/ui/partInspectorUi.js")).renderPartInspector();
    });
    assert.match(await page.locator("#partInspector").textContent(), /Select a component on the grid to inspect it/);
    await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      state.selectedPart = "frame";
      (await import("/src/ui/partInspectorUi.js")).renderPartInspector();
    });
    await page.screenshot({ path: path.join(artifactDir, "desktop-design.png") });

    await page.locator("#designerDesignTab").focus();
    await page.keyboard.press("ArrowRight");
    await assertTopTab(page, "analysis", "designerAnalysisPanel");
    await page.keyboard.press("End");
    await assertTopTab(page, "blueprints", "designerBlueprintsPanel");
    await page.keyboard.press("Home");
    await assertTopTab(page, "design", "designerDesignPanel");
    await page.locator("#designerBlueprintsTab").focus();
    await page.keyboard.press("Space");
    await assertTopTab(page, "blueprints", "designerBlueprintsPanel");
    await page.locator("#designerAnalysisTab").click();
    await assertTopTab(page, "analysis", "designerAnalysisPanel");
    await assertViewDrivenAnalysis(page);
    assert.equal(
      await page.locator("#blueprintModeContext").isVisible(),
      false,
      "Heat view should not render the obsolete empty mode context above the grid",
    );
    assert.equal(await page.locator("#thermalLoadModes [data-thermal-load='full']").textContent(), "Max Load");
    await page.locator("#thermalLoadModes [data-thermal-load='combat']").click();
    assert.equal(await page.locator("#thermalLoadModes [data-thermal-load='combat']").getAttribute("aria-pressed"), "true");
    assert.equal(await page.evaluate(() => window.__mfaState.thermalLoadMode), "combat");
    const details = page.locator("#fullLoadThermalPanel .thermal-detailed-analysis");
    await details.locator("summary").click();
    assert.equal(await details.getAttribute("open") !== null, true);
    await details.locator("summary").click();
    assert.equal(await details.getAttribute("open"), null);
    assert.equal(await page.locator("#analysisHeatPanel .thermal-analysis-status").count(), 1);
    await page.screenshot({ path: path.join(artifactDir, "desktop-analysis.png") });

    await page.locator("#designerBlueprintsTab").click();
    await assertTopTab(page, "blueprints", "designerBlueprintsPanel");
    assert.equal(await page.locator("#designerBlueprintsPanel .saved-designs").first().isVisible(), true);
    assert.equal(await page.locator("#loadoutManagerTabs").isVisible(), true);
    assert.equal(await page.locator(".bp-card").count(), 2);
    for (const action of ["load", "edit", "compare"]) {
      assert.equal(await page.locator(`.bp-card[data-saved-id='alpha'] [data-saved-action='${action}']`).first().isVisible(), true);
    }
    const overflow = page.locator(".bp-card[data-saved-id='alpha'] .bp-overflow");
    await overflow.locator("summary").click();
    assert.equal(await overflow.locator("[data-saved-action='duplicate']").isVisible(), true);
    assert.equal(await overflow.locator("[data-saved-action='delete']").isVisible(), true);
    await overflow.locator("summary").click();
    await page.screenshot({ path: path.join(artifactDir, "desktop-blueprints.png") });
    await overflow.locator("summary").click();
    await overflow.locator("[data-saved-action='duplicate']").click();
    assert.equal(await page.locator(".bp-card").count(), 3, "Duplicate creates an independent blueprint card");

    await page.locator(".bp-card[data-saved-id='alpha'] [data-saved-action='compare']").first().click();
    assert.equal(await page.locator(".blueprint-comparison").isVisible(), true);
    await page.locator(".bp-card[data-saved-id='alpha'] [data-saved-action='edit']").first().click();
    await page.waitForFunction(() => window.__mfaState.designerInspectorTab === "design");
    await assertTopTab(page, "design", "designerDesignPanel");
    assert.equal(await page.evaluate(() => window.__mfaState.loadedEditorBlueprintId), "alpha");
    await page.locator("#designerBlueprintsTab").click();
    await page.locator(".bp-card[data-saved-id='beta'] [data-saved-action='load']").click();
    await page.waitForFunction(() => window.__mfaState.designerInspectorTab === "design");
    await assertTopTab(page, "design", "designerDesignPanel");
    assert.equal(await page.evaluate(() => window.__mfaState.loadedEditorBlueprintId), null);

    await page.locator("#designerBlueprintsTab").click();
    const betaOverflow = page.locator(".bp-card[data-saved-id='beta'] .bp-overflow");
    await betaOverflow.locator("summary").click();
    await betaOverflow.locator("[data-saved-action='delete']").click();
    assert.equal(await page.locator("#confirmModal").isVisible(), true);
    await page.locator("#confirmAcceptButton").click();
    assert.equal(await page.locator(".bp-card[data-saved-id='beta']").count(), 0);

    await page.locator("#designerDesignTab").click();
    const warningSetup = await page.evaluate(async () => {
      const storage = await import("/src/design/blueprintStorage.js");
      const designerUi = await import("/src/ui/designerUi.js");
      const wiringUi = await import("/src/ui/wiringUi.js");
      const { state } = await import("/src/state.js");
      state.design = storage.defaultDesign();
      state.wiring = storage.defaultWiring();
      const completePowerWarning = wiringUi.wiringReadinessWarning();
      state.wiring = window.WiringRules.emptyWiring();
      state.loadedEditorBlueprintId = null;
      designerUi.renderBuildGrid();
      designerUi.renderLocalStats();
      return { savedCount: state.savedDesigns.length, completePowerWarning };
    });
    const savedCountBeforeWarning = warningSetup.savedCount;
    assert.equal(warningSetup.completePowerWarning, null,
      "fully powered components do not require optional Data support before closing or saving");
    await page.locator("#saveDesignButton").click();
    await page.locator("#confirmModal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#confirmModal").isVisible(), true, "saving without Wiring opens a blocking warning");
    assert.match(await page.locator("#confirmModalTitle").textContent(), /save blueprint without wiring/i);
    assert.match(await page.locator("#confirmModalMessage").textContent(), /no Power or Data wiring/i);
    assert.equal(await page.locator("#confirmAcceptButton").textContent(), "Save Anyway");
    assert.equal(await page.locator("#confirmModal").getAttribute("data-intent"), "wiring-warning");
    assert.equal(await page.evaluate(() => window.__mfaState.savedDesigns.length), savedCountBeforeWarning,
      "the blueprint is not saved before confirmation");
    await page.locator("#confirmCancelButton").click();
    assert.equal(await page.locator("#confirmModal").isHidden(), true);
    assert.equal(await page.evaluate(() => window.__mfaState.savedDesigns.length), savedCountBeforeWarning,
      "cancelling the warning does not save");

    await page.locator("#saveDesignButton").click();
    await page.locator("#confirmModal").waitFor({ state: "visible" });
    await page.locator("#confirmAcceptButton").click();
    await page.waitForFunction(expected => window.__mfaState.savedDesigns.length === expected, savedCountBeforeWarning + 1);
    assert.equal(await page.locator("#confirmModal").isHidden(), true, "Save Anyway completes the save");

    await page.locator("#closeBlueprintDesignerButton").click();
    await page.locator("#confirmModal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#confirmModal").isVisible(), true, "closing with no Wiring opens a blocking warning");
    assert.match(await page.locator("#confirmModalTitle").textContent(), /close with no wiring/i);
    assert.equal(await page.locator("#confirmAcceptButton").textContent(), "Close Anyway");
    assert.equal(await page.locator("#blueprintDesignerScreen").isVisible(), true,
      "the designer remains open before confirmation");
    await page.locator("#confirmCancelButton").click();
    assert.equal(await page.locator("#blueprintDesignerScreen").isVisible(), true,
      "cancelling the warning keeps the designer open");

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.locator("#designerBlueprintsTab").click();
      const geometry = await page.evaluate(() => {
        const right = document.querySelector(".designer-right-col");
        const cards = [...document.querySelectorAll(".bp-card")];
        const viewportWidth = document.documentElement.clientWidth;
        return {
          documentOverflow: document.documentElement.scrollWidth > viewportWidth,
          rightOverflow: right.scrollWidth > right.clientWidth + 1,
          cardsInside: cards.every(card => {
            const rect = card.getBoundingClientRect();
            return rect.left >= -1 && rect.right <= viewportWidth + 1;
          }),
          tabsVisible: document.querySelector("#designerInspectorTabs").getBoundingClientRect().top >= -1
        };
      });
      assert.deepEqual(geometry, { documentOverflow: false, rightOverflow: false, cardsInside: true, tabsVisible: true }, `responsive geometry at ${viewport.width}x${viewport.height}`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(async () => {
      document.querySelector("#toastStack")?.replaceChildren();
      window.__mfaState.compareSavedBlueprintId = null;
      (await import("/src/ui/savedBlueprintsUi.js")).renderSavedDesigns();
      document.querySelectorAll(".designer-inspector-panel").forEach(panel => { panel.scrollTop = 0; });
    });
    await page.locator("#designerDesignTab").click();
    await resetMobileScroll(page, "designerDesignPanel");
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(artifactDir, "mobile-design.png") });
    await page.locator("#designerAnalysisTab").click();
    await resetMobileScroll(page, "designerAnalysisPanel");
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(artifactDir, "mobile-analysis.png") });
    await page.locator("#designerBlueprintsTab").click();
    await resetMobileScroll(page, "designerBlueprintsPanel");
    const mobileOverflow = page.locator(".bp-card .bp-overflow").first();
    await mobileOverflow.locator("summary").click();
    const menuBox = await mobileOverflow.locator(".bp-overflow-menu").boundingBox();
    assert.ok(menuBox && menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, "mobile overflow menu stays in viewport");
    await mobileOverflow.locator("summary").click();
    await resetMobileScroll(page, "designerBlueprintsPanel");
    await page.mouse.move(1, 1);
    await page.screenshot({ path: path.join(artifactDir, "mobile-blueprints.png") });

    await page.locator("#closeBlueprintDesignerButton").click();
    await page.locator("#confirmModal").waitFor({ state: "visible" });
    await page.locator("#confirmAcceptButton").click();
    assert.equal(await page.locator("#blueprintDesignerScreen").isHidden(), true,
      "Close Anyway closes the designer");

    assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join("\n")}`);
    console.log(`Blueprint inspector tabs browser verification passed; screenshots: ${artifactDir}`);
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

async function assertTopTab(page, expected, panelId) {
  const state = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll("#designerInspectorTabs [role='tab']")];
    const panels = [...document.querySelectorAll(".designer-right-col > [role='tabpanel']")];
    return {
      selected: tabs.filter(tab => tab.getAttribute("aria-selected") === "true").map(tab => tab.textContent.trim().toLowerCase()),
      tabbable: tabs.filter(tab => tab.tabIndex === 0).map(tab => tab.textContent.trim().toLowerCase()),
      visiblePanels: panels.filter(panel => !panel.hidden).map(panel => panel.id)
    };
  });
  assert.deepEqual(state.selected, [expected]);
  assert.deepEqual(state.tabbable, [expected]);
  assert.deepEqual(state.visiblePanels, [panelId]);
}

async function assertViewDrivenAnalysis(page) {
  for (const [view, panel] of [["build", "analysisMovementPanel"], ["heat", "analysisHeatPanel"], ["wiring", "analysisWiringPanel"]]) {
    await page.locator(`#blueprint${view[0].toUpperCase()}${view.slice(1)}Tab`).click();
    await page.waitForFunction(expected => window.__mfaState.blueprintView === expected, view);
    const visible = await page.evaluate(() => [...document.querySelectorAll("#designerAnalysisPanel > .designer-analysis-panel")]
      .filter(panel => !panel.hidden).map(panel => panel.id));
    assert.deepEqual(visible, [panel]);
  }
  assert.match(await page.locator("#analysisWiringPanel").textContent(), /Summary[\s\S]*Selected tier[\s\S]*Issues/i);
  assert.doesNotMatch(await page.locator("#analysisWiringPanel").textContent(), /Power analysis/);
  assert.equal(await page.locator("#analysisWiringTab").getAttribute("aria-selected"), "true");
  await page.locator("#analysisPowerTab").click();
  assert.equal(await page.locator("#analysisPowerTab").getAttribute("aria-selected"), "true");
  assert.match(await page.locator("#analysisPowerPanel").textContent(), /Power analysis/);
  await page.locator("#blueprintHeatTab").click();
  await page.locator("#analysisWiringTab").click();
  assert.equal(await page.evaluate(() => window.__mfaState.blueprintView), "heat",
    "opening Wiring analysis does not switch the active blueprint editing mode");
  assert.equal(await page.locator("#wiringToolbar").isHidden(), true,
    "Wiring editor controls remain hidden outside Wiring mode");
  assert.match(await page.locator("#wiringStatusPanel").textContent(), /Summary[\s\S]*Selected tier[\s\S]*Issues/i,
    "Wiring analysis stays populated when Heat mode is active");
  await page.locator("#analysisHeatTab").click();
}

async function resetMobileScroll(page, panelId) {
  await page.evaluate((id) => {
    window.scrollTo(0, 0);
    const designer = document.querySelector(".blueprint-designer-panel");
    if (designer) designer.scrollTop = 0;
    const panel = document.getElementById(id);
    if (panel) panel.scrollTop = 0;
  }, panelId);
}
