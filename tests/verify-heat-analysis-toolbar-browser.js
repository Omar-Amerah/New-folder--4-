"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { launchChromium } = require("./verify-pixi-browser-support.js");

const publicRoot = path.join(__dirname, "..", "public");
let server;
let base;
let browser;

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png"
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function startStaticServer() {
  server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (pathname === "/heat-test.html") {
      const source = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8")
        .replace(/\s*<script type="module" src="\/src\/main\.js[^"]*"><\/script>/, "");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(source);
      return;
    }
    const filePath = path.resolve(publicRoot, `.${pathname}`);
    if (filePath !== publicRoot && !filePath.startsWith(`${publicRoot}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": contentType(filePath) }).end(fs.readFileSync(filePath));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function run() {
  await startStaticServer();
  browser = await launchChromium(chromium);
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(`${base}/heat-test.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    for (const id of ["mainMenuScreen", "lobbyManagementScreen", "settingsScreen"]) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
    const [{ state }, screen, designer, inspector, domModule] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerScreenUi.js"),
      import("/src/ui/designerUi.js"),
      import("/src/ui/designerInspectorUi.js"),
      import("/src/ui/dom.js")
    ]);
    screen.openBlueprintDesigner();
    designer.setBlueprintView("heat");
    designer.renderBuildGrid();
    // Keep this focused regression on Heat while the unrelated in-progress
    // Combat markup edit has a missing movementStatusMarkup variable.
    domModule.dom.analysisMovementPanel = null;
    designer.renderLocalStats();
    inspector.activateDesignerInspectorTab("analysis");
    inspector.activateDesignerAnalysisTab("heat");
    state.thermalDetailsOpen = false;
  });
  await page.waitForSelector("#blueprintDesignerScreen:not([hidden])");
  await page.waitForFunction(() => {
    const panel = document.getElementById("analysisHeatPanel");
    const card = document.getElementById("fullLoadThermalPanel");
    return panel && !panel.hidden && card && !card.hidden;
  });

  const controls = await page.evaluate(() => [...document.querySelectorAll("#thermalLoadModes [data-thermal-load]")].map((button) => ({
    mode: button.dataset.thermalLoad,
    text: button.textContent.trim(),
    pressed: button.getAttribute("aria-pressed")
  })));
  assert.deepEqual(controls.map(({ mode }) => mode), ["idle", "combat", "full"]);
  assert.deepEqual(controls.map(({ text }) => text), ["Idle", "Typical Combat", "Max Load"]);
  assert.equal(controls.find(({ mode }) => mode === "combat").pressed, "true");
  assert.equal(await page.locator("#heatFlowViewControls").count(), 0, "the permanent Overlay row should be gone");
  assert.equal(await page.locator("#heatFlowHint").count(), 0, "hover guidance should not occupy the toolbar");
  assert.equal(await page.locator(".heat-flow-status").count(), 0, "the permanent overlay status should be gone");
  const legendButton = page.locator("#blueprintHeatLegendButton");
  assert.equal(await legendButton.textContent(), "Legend");
  assert.equal(await legendButton.getAttribute("aria-haspopup"), "dialog");
  assert.equal(await legendButton.getAttribute("aria-controls"), "blueprintHeatLegend");
  assert.equal(await legendButton.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator("#blueprintHeatLegend").isHidden(), true, "Heat legend should start closed");

  const baseline = await page.evaluate(async () => {
    const { getScenarioHeatAnalysis } = await import("/src/ui/designerUi.js");
    const result = getScenarioHeatAnalysis("combat");
    const analysis = result.analysis;
    return {
      mode: result.mode || analysis.mode,
      generation: analysis.generation,
      cooling: analysis.cooling,
      actualCooling: analysis.actualCooling,
      net: analysis.net,
      peakPredictedHeat: analysis.peakPredictedHeat,
      firstOverheatTime: analysis.firstOverheatTime,
      firstMeltdownTime: analysis.firstMeltdownTime,
      reserve: analysis.reserve
    };
  });

  await page.locator('#thermalLoadModes [data-thermal-load="idle"]').click();
  await page.waitForFunction(async () => (await import("/src/state.js")).state.thermalLoadMode === "idle");
  assert.match(await page.locator("#fullLoadThermalPanel").textContent(), /Idle/);
  assert.equal(await page.locator('#thermalLoadModes [data-thermal-load="idle"]').getAttribute("aria-pressed"), "true");

  await page.locator('#thermalLoadModes [data-thermal-load="combat"]').click();
  await page.waitForFunction(async () => (await import("/src/state.js")).state.thermalLoadMode === "combat");
  const returned = await page.evaluate(async () => {
    const { getScenarioHeatAnalysis } = await import("/src/ui/designerUi.js");
    const result = getScenarioHeatAnalysis("combat");
    const analysis = result.analysis;
    return {
      mode: result.mode || analysis.mode,
      generation: analysis.generation,
      cooling: analysis.cooling,
      actualCooling: analysis.actualCooling,
      net: analysis.net,
      peakPredictedHeat: analysis.peakPredictedHeat,
      firstOverheatTime: analysis.firstOverheatTime,
      firstMeltdownTime: analysis.firstMeltdownTime,
      reserve: analysis.reserve
    };
  });
  assert.deepEqual(returned, baseline, "scenario controls must continue using the existing Heat analysis result");

  const cardTopBeforeLegend = await page.locator("#fullLoadThermalPanel").evaluate((element) => element.getBoundingClientRect().top);
  await legendButton.click();
  await page.waitForFunction(() => document.getElementById("blueprintHeatLegend")?.hidden === false);
  assert.equal(await legendButton.getAttribute("aria-expanded"), "true");
  const cardTopAfterLegend = await page.locator("#fullLoadThermalPanel").evaluate((element) => element.getBoundingClientRect().top);
  assert.ok(Math.abs(cardTopAfterLegend - cardTopBeforeLegend) <= 1, "opening the legend must not move the Heat Analysis card");
  const desktopPopover = await page.locator("#blueprintHeatLegend").boundingBox();
  const desktopButton = await legendButton.boundingBox();
  const desktopPlacement = await page.evaluate(() => {
    const button = document.getElementById("blueprintHeatLegendButton");
    const legend = document.getElementById("blueprintHeatLegend");
    return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, style: { left: legend.style.left, top: legend.style.top }, button: button.getBoundingClientRect(), legend: legend.getBoundingClientRect() };
  });
  assert.ok(desktopPopover && desktopButton && desktopPopover.y >= desktopButton.y + desktopButton.height - 1, `legend should open below the Legend button on desktop: ${JSON.stringify({ desktopPopover, desktopButton, desktopPlacement })}`);
  const legendText = await page.locator("#heatLegendContent").textContent();
  for (const phrase of [
    "Heat States", "Overlay", "Cool / Warm", "100% output", "Warm at 42%",
    "Hot", "Starts at 68%", "70% output", "Critical", "Starts at 86%", "40% output",
    "Overheated", "Starts at 100%", "0% output", "Restart <62%",
    "Arrow", "Heat movement", "Thickness", "Transfer amount", "Dashed",
    "Frame / Heat Pipe route", "Cyan arrow", "External cooling", "%", "Heat capacity used",
    "Hover a component to inspect its H/s values."
  ]) assert.ok(legendText.includes(phrase), `legend is missing: ${phrase}`);

  await legendButton.click();
  await page.waitForFunction(() => document.getElementById("blueprintHeatLegend")?.hidden === true);
  assert.equal(await legendButton.getAttribute("aria-expanded"), "false", "clicking Legend again should close the legend");

  await legendButton.click();
  await page.waitForFunction(() => document.getElementById("blueprintHeatLegend")?.hidden === false);
  await page.mouse.click(12, 12);
  await page.waitForFunction(() => document.getElementById("blueprintHeatLegend")?.hidden === true);
  assert.equal(await legendButton.getAttribute("aria-expanded"), "false", "clicking outside should close the legend");

  await legendButton.click();
  await page.waitForFunction(() => document.getElementById("blueprintHeatLegend")?.hidden === false);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.getElementById("blueprintHeatLegend")?.hidden === true);
  assert.equal(await legendButton.getAttribute("aria-expanded"), "false", "Escape should close the legend");

  const collapsedGeometry = await page.evaluate(() => {
    const panel = document.getElementById("analysisHeatPanel");
    const toolbar = document.getElementById("heatToolbar");
    const card = document.getElementById("fullLoadThermalPanel");
    const panelStyle = getComputedStyle(panel);
    const contentWidth = panel.clientWidth - parseFloat(panelStyle.paddingLeft) - parseFloat(panelStyle.paddingRight);
    const toolbarRect = toolbar.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      toolbarHeight: toolbarRect.height,
      toolbarWidth: toolbarRect.width,
      card: { left: cardRect.left, right: cardRect.right, width: cardRect.width },
      contentWidth,
      horizontalOverflow: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, panel.scrollWidth - panel.clientWidth)
    };
  });
  assert.ok(collapsedGeometry.toolbarHeight <= 100, `collapsed toolbar is too tall: ${collapsedGeometry.toolbarHeight}`);
  assert.ok(collapsedGeometry.card.width >= collapsedGeometry.toolbarWidth - 2, `Heat Analysis card should fill its content width: ${JSON.stringify(collapsedGeometry)}`);
  assert.ok(collapsedGeometry.horizontalOverflow <= 1, "collapsed Heat analysis should not introduce horizontal scrolling");

  const detailed = page.locator("#fullLoadThermalPanel .thermal-detailed-analysis");
  assert.equal(await detailed.getAttribute("open"), null, "Detailed Analysis should remain collapsible");
  await detailed.locator("summary").click();
  await page.waitForFunction(() => document.querySelector("#fullLoadThermalPanel .thermal-detailed-analysis")?.open === true);
  assert.ok(await detailed.locator(".thermal-analysis-rows > *").count() > 0, "Detailed Analysis rows should remain available");
  await detailed.locator("summary").click();
  await page.waitForFunction(() => document.querySelector("#fullLoadThermalPanel .thermal-detailed-analysis")?.open === false);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const mobileCardTopBeforeLegend = await page.locator("#fullLoadThermalPanel").evaluate((element) => element.getBoundingClientRect().top);
  await legendButton.click();
  await page.waitForFunction(() => document.getElementById("blueprintHeatLegend")?.hidden === false);
  const mobileGeometry = await page.evaluate(() => {
    const panel = document.getElementById("analysisHeatPanel");
    const groups = [...document.querySelectorAll("#heatLegendContent .heat-legend-group")].map((group) => group.getBoundingClientRect());
    const panelRect = panel.getBoundingClientRect();
    const popover = document.getElementById("blueprintHeatLegend").getBoundingClientRect();
    const card = document.getElementById("fullLoadThermalPanel").getBoundingClientRect();
    const buttons = [...document.querySelectorAll("#thermalLoadModes button")].map((button) => button.getBoundingClientRect());
    return {
      panelRight: panelRect.right,
      panelLeft: panelRect.left,
      groups,
      popover,
      cardTop: card.top,
      buttons,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelOverflow: panel.scrollWidth - panel.clientWidth
    };
  });
  assert.ok(mobileGeometry.documentOverflow <= 1, `mobile document has horizontal overflow: ${mobileGeometry.documentOverflow}`);
  assert.ok(mobileGeometry.panelOverflow <= 1, `mobile Heat panel has horizontal overflow: ${mobileGeometry.panelOverflow}`);
  assert.ok(mobileGeometry.groups[1].top >= mobileGeometry.groups[0].bottom - 1, "mobile legend groups should stack");
  assert.ok(mobileGeometry.popover.left >= 8 && mobileGeometry.popover.right <= 382, "mobile legend should stay inside the viewport");
  assert.ok(Math.abs(mobileGeometry.cardTop - mobileCardTopBeforeLegend) <= 1, "mobile legend must not move the Heat Analysis card");
  for (const button of mobileGeometry.buttons) {
    assert.ok(button.width > 0 && button.left >= mobileGeometry.panelLeft - 1 && button.right <= mobileGeometry.panelRight + 1, "mobile scenario controls should fit");
  }

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(" | ")}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
  console.log("Heat analysis toolbar browser verification passed");
}

run()
  .catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close?.();
    await new Promise((resolve) => server?.close(resolve));
  });
