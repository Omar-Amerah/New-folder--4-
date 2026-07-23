"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { uniquePort, startServer, waitForServer, launchChromium } = require("./verify-pixi-browser-support.js");

const artifactDir = path.join("test-artifacts", "blueprint-information-polish");

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

    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__mfaMainLoaded === true);
      await page.evaluate(async () => {
        const mainMenu = document.querySelector("#mainMenuScreen");
        if (!mainMenu) throw new Error("Missing #mainMenuScreen");
        mainMenu.hidden = true;
        const screenUi = await import("/src/ui/designerScreenUi.js");
        screenUi.openBlueprintDesigner();
        const designerUi = await import("/src/ui/designerUi.js");
        designerUi.renderBuildGrid();
        designerUi.renderLocalStats();
      });
      await page.locator("#blueprintDesignerScreen:not([hidden]) #buildGrid").waitFor({ state: "visible" });
    } catch (error) {
      const diagnostics = await setupDiagnostics(page).catch((diagError) => ({ diagnosticsError: diagError.message }));
      fs.mkdirSync(artifactDir, { recursive: true });
      await page.screenshot({ path: path.join(artifactDir, "setup-failure.png"), fullPage: true }).catch(() => {});
      throw new Error(`Blueprint information setup failed: ${error.message}\n${JSON.stringify(diagnostics, null, 2)}\nServer log:\n${getLog()}`);
    }

    await assertVisible(page, "#saveDesignButton", "Save button visible without page scrolling");
    await page.locator(".designer-right-col").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await assertVisible(page, "#saveDesignButton", "Save button remains visible while right column scrolls");
    const costHeading = await page.locator("#blueprintCostBanner > span").textContent();
    assert.equal(costHeading?.trim(), "Build cost", "cost banner semantic label says Build cost");
    const inspectorHeadings = await page
      .locator("#partInspector .part-detail-heading")
      .evaluateAll(nodes => nodes.map(node => node.textContent?.trim()));
    assert.ok(
      inspectorHeadings.includes("Key stats"),
      `inspector shows semantic Key stats heading: ${JSON.stringify(inspectorHeadings)}`
    );
    const inspectorDisclosures = await page
      .locator("#partInspector details > summary")
      .evaluateAll(nodes => nodes.map(node => node.textContent?.trim()));
    assert.equal(inspectorDisclosures.includes("Power and support details"), false,
      "power and support values are no longer hidden in a disclosure");
    assert.ok(inspectorDisclosures.includes("Heat details"), "component inspector includes Heat details");
    const combatIndex = inspectorDisclosures.indexOf("Combat details");
    const heatIndex = inspectorDisclosures.indexOf("Heat details");
    if (combatIndex >= 0) assert.ok(heatIndex > combatIndex, "Heat details follows Combat details");
    const heatDetails = page.locator("#partInspector .thermal-properties-details");
    await heatDetails.locator("summary").click();
    assert.equal(await heatDetails.getAttribute("open"), "", "Heat details opens from its summary");
    const heatGeometry = await heatDetails.evaluate((details) => {
      const summary = details.querySelector("summary");
      const body = details.querySelector(".heat-details-body");
      const outer = details.getBoundingClientRect();
      const bodyRect = body.getBoundingClientRect();
      const style = getComputedStyle(body);
      return {
        summaryHeight: summary.getBoundingClientRect().height,
        insetLeft: bodyRect.left - outer.left,
        paddingTop: parseFloat(style.paddingTop),
        paddingLeft: parseFloat(style.paddingLeft),
        gap: parseFloat(style.rowGap)
      };
    });
    assert.ok(heatGeometry.summaryHeight >= 40, `Heat summary remains comfortably tappable: ${heatGeometry.summaryHeight}px`);
    assert.ok(heatGeometry.paddingTop >= 10 && heatGeometry.paddingLeft >= 12 && heatGeometry.gap >= 10,
      `opened Heat details has balanced internal spacing: ${JSON.stringify(heatGeometry)}`);
    await page.locator("#blueprintHeatTab").click();
    await page.locator("#designerAnalysisTab").click();
    await page.waitForFunction(() => window.__mfaState?.blueprintView === "heat");
    const heatInspector = await page.evaluate(() => ({
      mode: window.__mfaState?.blueprintView,
      inspectorTab: window.__mfaState?.designerInspectorTab,
      hasSummary: Boolean(document.querySelector("#fullLoadThermalPanel .thermal-analysis-status")),
      text: document.querySelector("#analysisHeatPanel")?.textContent
    }));
    assert.equal(heatInspector.mode, "heat", "Heat tab activates Heat mode");
    assert.equal(heatInspector.inspectorTab, "analysis", "Analysis inspector is selected");
    assert.equal(heatInspector.hasSummary, true, "Analysis shows one ship-wide Heat summary");
    const statusCss = await page.locator(".purchase-status").first().evaluate(el => getComputedStyle(el).whiteSpace).catch(() => "normal");
    assert.equal(statusCss, "normal", "purchase status allows wrapping");

    const stickyChecks = await page.evaluate(async () => {
      const storage = await import("/src/design/blueprintStorage.js");
      const { state } = await import("/src/state.js");
      const savedUi = await import("/src/ui/savedBlueprintsUi.js");
      const base = storage.defaultDesign();
      const wiring = storage.defaultWiring();
      state.savedDesigns = [
        { id: "loaded-design", name: "Alpha", blueprint: base.map(p => ({ ...p })), wiring, combatStyle: "sentry", createdAt: 1, updatedAt: 1 },
        { id: "other-design", name: "Beta", blueprint: base.map(p => ({ ...p })), wiring, combatStyle: "sentry", createdAt: 2, updatedAt: 2 }
      ];
      state.loadedEditorBlueprintId = "loaded-design";
      savedUi.refreshLoadedBlueprintPresentation();
      const before = [document.querySelector("#loadedBlueprintName")?.textContent, document.querySelector("#saveDesignButton")?.textContent];
      savedUi.renameSavedDesign("loaded-design", "Alpha Prime");
      const afterRename = [document.querySelector("#loadedBlueprintName")?.textContent, document.querySelector("#saveDesignButton")?.textContent];
      savedUi.renameSavedDesign("other-design", "Gamma");
      const afterOtherRename = [document.querySelector("#loadedBlueprintName")?.textContent, document.querySelector("#saveDesignButton")?.textContent];
      savedUi.openDeleteDesignModal(state.savedDesigns.find(d => d.id === "loaded-design"));
      savedUi.confirmModalAction();
      const afterDelete = [state.loadedEditorBlueprintId, document.querySelector("#loadedBlueprintName")?.textContent, document.querySelector("#saveDesignButton")?.textContent];
      return { before, afterRename, afterOtherRename, afterDelete };
    });
    assert.deepEqual(stickyChecks.before, ["Alpha", 'Update "Alpha"']);
    assert.deepEqual(stickyChecks.afterRename, ["Alpha Prime", 'Update "Alpha Prime"']);
    assert.deepEqual(stickyChecks.afterOtherRename, stickyChecks.afterRename);
    assert.deepEqual(stickyChecks.afterDelete, [null, "Unsaved design", "Save Blueprint"]);
    assert.deepEqual(errors, [], "no unexpected console or page errors");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGTERM");
  }
  console.log("Blueprint information polish browser verification passed");
})().catch((error) => { console.error(error); process.exit(1); });

async function setupDiagnostics(page) {
  return page.evaluate(() => {
    const mainMenu = document.querySelector("#mainMenuScreen");
    const designer = document.querySelector("#blueprintDesignerScreen");
    const grid = document.querySelector("#buildGrid");
    const save = document.querySelector("#saveDesignButton");
    const visible = (el) => Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none");
    return {
      url: location.href,
      mfaMainLoaded: window.__mfaMainLoaded === true,
      mainMenuHidden: mainMenu ? mainMenu.hidden : null,
      designerScreenHidden: designer ? designer.hidden : null,
      buildGridExists: Boolean(grid),
      buildGridVisible: visible(grid),
      saveDesignButtonExists: Boolean(save),
      saveDesignButtonVisible: visible(save),
      blueprintMode: window.__mfaState?.blueprintView || null
    };
  });
}

async function assertVisible(page, selector, message) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, message);
}
