#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { mkdirSync } = require("fs");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");
const port = uniquePort(); const base = `http://127.0.0.1:${port}`; const { server } = startServer(port); let browser;
(async () => {
  const errors = []; const consoleErrors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
    page.on("pageerror", (e) => errors.push(String(e.message || e)));
    page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.evaluate(async () => {
      const [{ state }, designerUi, wiringUi] = await Promise.all([
        import("/src/state.js"), import("/src/ui/designerUi.js"), import("/src/ui/wiringUi.js")
      ]);
      const mainMenu = document.querySelector("#mainMenuScreen");
      const designerScreen = document.querySelector("#blueprintDesignerScreen");
      if (!mainMenu || !designerScreen) throw new Error("Required Blueprint Designer screens were not found");
      mainMenu.hidden = true;
      designerScreen.hidden = false;
      state.blueprintView = "wiring";
      wiringUi.resetWiringEditorState?.();
      designerUi.renderBuildGrid?.();
      designerUi.setBlueprintView?.("wiring");
    });
    try {
      await page.locator("#buildGrid").waitFor({ state: "visible", timeout: 15000 });
      await page.locator("#blueprintWiringTab").waitFor({ state: "visible", timeout: 15000 });
      await page.locator("#wiringModeData").click({ timeout: 15000 });
    } catch (setupError) {
      mkdirSync("test-artifacts/data-support-browser", { recursive: true });
      const screenshotPath = "test-artifacts/data-support-browser/setup-failure.png";
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const diagnostics = await page.evaluate(async () => {
        const { state } = await import("/src/state.js");
        return {
          mainMenuHidden: document.querySelector("#mainMenuScreen")?.hidden ?? null,
          designerScreenHidden: document.querySelector("#blueprintDesignerScreen")?.hidden ?? null,
          buildGridHidden: document.querySelector("#buildGrid")?.hidden ?? null,
          blueprintView: state.blueprintView,
          wiringMode: state.wiringUi?.mode ?? null,
          currentUrl: location.href
        };
      });
      setupError.message = `${setupError.message}; setup diagnostics: ${JSON.stringify({ ...diagnostics, screenshotPath })}`;
      throw setupError;
    }
    await page.evaluate(async () => {
      const [{ state }, { PART_STATS }, storage, wiringUi] = await Promise.all([
        import("/src/state.js"), import("/src/design/parts.js"), import("/src/design/blueprintStorage.js"), import("/src/ui/wiringUi.js")
      ]);
      const m = (type,x,y) => ({ type,x,y,rotation:0 });
      const R = globalThis.WiringRules;
      state.design = [m("auxGenerator",0,1),m("fireControl",0,0),m("sensorArray",1,0),m("railgun",2,0),m("pointDefense",6,0),m("auxGenerator",5,1),m("targetingComputer",5,0),m("frame",1,1),m("frame",2,1)];
      let w = R.emptyWiring();
      w = R.addPath(w,"power",[{x:0,y:1},{x:0,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"power",[{x:0,y:1},{x:1,y:1},{x:1,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"power",[{x:5,y:1},{x:5,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:0,y:0},{x:1,y:0},{x:2,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:5,y:0},{x:6,y:0}],state.design,PART_STATS);
      state.wiring = storage.normalizeWiring(w, state.design); state.blueprintView = "wiring"; state.wiringUi.mode = "data"; state.thermalLoadMode = "idle";
      wiringUi.refreshWiringPresentation();
    });
    const panel = page.locator("#wiringStatusPanel");
    await assert.doesNotReject(() => panel.waitFor({ state: "visible" }));
    const overviewText = await panel.textContent();
    assert(/2 physical Data networks|physical Data networks/.test(overviewText) && /active sources|supported weapons/.test(overviewText), "Data overview is visible");
    const scenario = page.locator('[data-wiring-action="data-scenario"]');
    assert.equal((await scenario.locator("option").evaluateAll((opts) => opts.map((o) => o.textContent.trim()).join("|"))), "Idle|Typical Combat|Maximum Sustained Load");

    const networkButtons = page.locator('[data-wiring-action="select-network"]');
    await page.evaluate(async () => { const [{ state }, wiringUi] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]); state.wiringUi.selectedIndex = null; state.wiringUi.selectedDataNetworkId = null; state.wiringUi.selectedSectionId = null; wiringUi.refreshWiringPresentation(); });
    await networkButtons.nth(0).click();
    let report = await page.evaluate(() => ({
      selected: document.querySelectorAll(".wire-data.wire-net-selected").length,
      dimmed: document.querySelectorAll(".wire-data.data-dimmed").length,
      selectedDimmed: document.querySelectorAll(".wire-data.wire-net-selected.data-dimmed").length
    }));
    assert(report.selected > 0, "Network A sections are selected/emphasized");
    assert(report.dimmed > 0, "Network B sections are dimmed when Network A is selected");
    assert.equal(report.selectedDimmed, 0, "Network A sections are not dimmed");
    await networkButtons.nth(1).click();
    const reversed = await page.evaluate(() => ({ selected: document.querySelectorAll(".wire-data.wire-net-selected").length, dimmed: document.querySelectorAll(".wire-data.data-dimmed").length, selectedDimmed: document.querySelectorAll(".wire-data.wire-net-selected.data-dimmed").length }));
    assert(reversed.selected > 0 && reversed.dimmed > 0 && reversed.selectedDimmed === 0, "switching to Network B reverses selected/dimmed state");

    await page.locator('[data-wiring-action="inspect-component"][data-index="6"]').click();
    assert(await page.locator(".wire-comp-data-source-selected").count() === 1, "selected source class is applied");
    assert(await page.locator(".wire-comp-data-recipient-active").count() > 0, "source recipients have active-recipient class");
    assert.equal(await page.locator(".wire-comp-data-recipient-active[aria-label*='Railgun']").count(), 0, "unrelated weapon is not an active recipient");
    assert(/Point Defence|Point Defense/.test(await panel.textContent()), "panel lists selected source recipients");

    await page.evaluate(async () => { const [{ state }, wiringUi] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]); state.wiringUi.selectedIndex = null; state.wiringUi.selectedDataNetworkId = null; state.wiringUi.selectedSectionId = null; wiringUi.refreshWiringPresentation(); });
    await networkButtons.nth(0).click();
    await page.locator('[data-wiring-action="inspect-component"][data-index="1"]').click();
    assert(await page.locator(".wire-comp-data-source-selected").count() === 1, "Fire Control selected-source styling is applied");
    assert(await page.locator(".wire-comp-data-recipient-active[aria-label*='Railgun']").count() === 1, "Fire Control marks Railgun as active recipient");
    let fireText = await panel.textContent();
    assert(/Fire Control/.test(fireText) && !/\+\+/.test(fireText), "source panel has no duplicate signs");

    await page.locator('[data-wiring-action="inspect-component"][data-index="3"]').click();
    assert(await page.locator(".wire-comp-data-weapon-selected[aria-label*='Railgun']").count() === 1, "Railgun selected-weapon styling is applied");
    assert(await page.locator(".wire-comp-data-contributor-active[aria-label*='Fire Control']").count() === 1, "Fire Control is an active contributor");
    assert(await page.locator(".wire-comp-data-contributor-active[aria-label*='Sensor Array']").count() === 1, "Sensor Array is an active contributor");
    assert(await page.locator(".wire-comp-data-unrelated[aria-label*='Targeting Computer']").count() === 1, "other-network source is deemphasized");
    const weaponText = await panel.textContent();
    assert(/Railgun/.test(weaponText) && /Fire Control/.test(weaponText) && /Sensor Array/.test(weaponText) && !/\+\+|4000%/.test(weaponText), "weapon panel lists contributing sources with sane units");

    const vulnReport = await page.evaluate(() => ({ critical: document.querySelectorAll(".wire-data.data-critical-section").length, redundant: document.querySelectorAll(".wire-data.data-redundant-section").length, aria: [...document.querySelectorAll(".wire-hit")].map((el) => el.getAttribute("aria-label") || "") }));
    assert(vulnReport.critical > 0, "critical cable sections receive a visible class");
    assert(vulnReport.aria.some((text) => /Vulnerability: critical/.test(text)), "critical cable hit target exposes severity in ARIA");
    assert(vulnReport.aria.every((text) => /Vulnerability:/.test(text)), "Data cable hit targets include vulnerability text");
    await page.locator(".wire-hit").first().click({ force: true });
    assert(/Selected Data section/.test(await panel.textContent()) && /Lost support/.test(await panel.textContent()), "selecting a physical cable shows lost support details");

    await scenario.selectOption("full");
    const freshPanel = page.locator("#wiringStatusPanel");
    assert(/Maximum Sustained Load|Data-support inspection/.test(await freshPanel.textContent()), "scenario select works after panel rerender without stale handles");
    await page.locator("#wiringModePower").click(); assert(/Physical power wiring/i.test(await panel.textContent()), "Power inspection still works");
    await page.locator("#blueprintHeatTab").click(); assert(await page.locator(".wire-comp-data-source-active,.wire-comp-data-weapon-supported").count() === 0, "Data overlay classes removed in Heat view");
    await page.locator("#blueprintBuildTab").click(); assert(await page.locator("#wiringStatusPanel").evaluate((el) => el.hidden || !/Data-support inspection/.test(el.textContent)), "no stale Data panel after returning to Blueprint");
    assert.deepEqual({ errors, consoleErrors }, { errors: [], consoleErrors: [] }, `Unexpected browser diagnostics: ${JSON.stringify({ errors, consoleErrors }, null, 2)}`);
    console.log("Data-support designer browser verification passed.");
  } finally { await browser?.close?.(); server.kill("SIGTERM"); }
})().catch((error) => { console.error(error); process.exit(1); });
