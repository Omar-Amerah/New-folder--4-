#!/usr/bin/env node
"use strict";
const assert = require("assert");
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
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#buildGrid", { timeout: 15000 });
    await page.click("#openBlueprintDesignerButton");
    await page.click("#blueprintWiringTab");
    await page.click("#wiringModeData");
    const report = await page.evaluate(async () => {
      const [{ state }, { PART_STATS }, storage, wiringUi, presentation] = await Promise.all([
        import("/src/state.js"), import("/src/design/parts.js"), import("/src/design/blueprintStorage.js"), import("/src/ui/wiringUi.js"), import("/src/design/dataSupportPresentation.js")
      ]);
      const m = (type,x,y) => ({ type,x,y,rotation:0 });
      const R = globalThis.WiringRules;
      state.design = [m("reactor",0,1),m("fireControl",0,0),m("sensorArray",1,0),m("railgun",2,0),m("pointDefense",2,1),m("frame",1,1)];
      let w = R.emptyWiring();
      w = R.addPath(w,"power",[{x:0,y:1},{x:0,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"power",[{x:0,y:1},{x:1,y:1},{x:1,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:0,y:0},{x:1,y:0},{x:2,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:1,y:0},{x:1,y:1},{x:2,y:1}],state.design,PART_STATS);
      state.wiring = storage.normalizeWiring(w, state.design); state.blueprintView = "wiring"; state.wiringUi.mode = "data"; state.thermalLoadMode = "idle";
      wiringUi.refreshWiringPresentation();
      const panel = document.querySelector("#wiringStatusPanel");
      const overviewVisible = panel && !panel.hidden && /physical Data networks|active sources|supported weapons/.test(panel.textContent);
      const scenario = panel.querySelector("[data-wiring-action='data-scenario']");
      const hasScenarioLabels = [...scenario.options].map(o=>o.textContent.trim()).join("|");
      state.wiringUi.selectedIndex = 1; wiringUi.refreshWiringPresentation(); const fireText = panel.textContent;
      state.wiringUi.selectedIndex = 2; wiringUi.refreshWiringPresentation(); const sensorText = panel.textContent;
      state.wiringUi.selectedIndex = 3; wiringUi.refreshWiringPresentation(); const weaponText = panel.textContent;
      state.wiringUi.selectedIndex = null; state.wiringUi.selectedDataNetworkId = globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(state.design,state.wiring,PART_STATS,{thermalLoadMode:state.thermalLoadMode}).networks[0].id; wiringUi.refreshWiringPresentation();
      const dimmedCount = document.querySelectorAll(".wire-data.data-dimmed").length;
      state.wiringUi.selectedSectionId = state.wiring.data.sections[0].id; state.wiringUi.selectedDataNetworkId = null; wiringUi.refreshWiringPresentation(); const sectionText = panel.textContent;
      state.wiringUi.selectedSectionId = null; state.wiringUi.selectedIndex = 5; wiringUi.refreshWiringPresentation(); const hostText = panel.textContent;
      scenario.value = "full"; scenario.dispatchEvent(new Event("change", { bubbles:true })); const stillSelected = state.wiringUi.selectedIndex === 5 && state.thermalLoadMode === "full";
      document.querySelector("#wiringModePower").click(); const powerWorks = /Physical power wiring/i.test(panel.textContent);
      document.querySelector("#blueprintHeatTab").click(); const dataOverlayGoneInHeat = !document.querySelector(".wire-comp-data-source-active,.wire-comp-data-weapon-supported");
      document.querySelector("#blueprintBuildTab").click(); const noStaleDataPanel = panel.hidden || !/Data-support inspection/.test(panel.textContent);
      return { overviewVisible, hasScenarioLabels, fireText, sensorText, weaponText, dimmedCount, sectionText, hostText, stillSelected, powerWorks, dataOverlayGoneInHeat, noStaleDataPanel,
        rangeFormat: presentation.formatDataSupportValue({ bonusField:"rangeBonus", amount:40 }), pctFormat: presentation.formatDataSupportValue({ bonusField:"fireRateBonus", amount:.075 }) };
    });
    assert(report.overviewVisible, "Data network overview is visible");
    assert.equal(report.hasScenarioLabels, "Idle|Typical Combat|Maximum Sustained Load");
    assert(/Fire Control/.test(report.fireText) && /7\.5%/.test(report.fireText) && /Failure impact/.test(report.fireText));
    assert(/Sensor Array/.test(report.sensorText) && /40 m|20 m/.test(report.sensorText) && !/4000%/.test(report.sensorText));
    assert(/Railgun/.test(report.weaponText) && /Range:/.test(report.weaponText) && /Fire rate:/.test(report.weaponText) && /Reload:/.test(report.weaponText));
    assert(report.dimmedCount >= 0, "overlay dimming query is semantic and non-throwing");
    assert(/Selected Data section/.test(report.sectionText) && /Lost support/.test(report.sectionText));
    assert(/Hosts Data cable sections|Frame/.test(report.hostText) && /Failure impact/.test(report.hostText));
    assert(report.stillSelected, "selection remains stable after scenario change");
    assert(report.powerWorks, "Power inspection still works");
    assert(report.dataOverlayGoneInHeat, "Data overlay classes removed in Heat view");
    assert(report.noStaleDataPanel, "no stale Data panel after returning to Blueprint");
    assert.equal(report.rangeFormat, "+40 m"); assert.equal(report.pctFormat, "+7.5%");
    assert.deepEqual({ errors, consoleErrors }, { errors: [], consoleErrors: [] });
    console.log("Data-support designer browser verification passed.");
  } finally { await browser?.close?.(); server.kill("SIGTERM"); }
})().catch((error) => { console.error(error); process.exit(1); });
