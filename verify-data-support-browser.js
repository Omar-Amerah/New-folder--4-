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
      // Network A: Fire Control + Sensor Array share one upstream trunk before branching to two weapons.
      // Network B: Targeting Computer reaches Point Defence through a deterministic two-route loop.
      state.design = [
        m("auxGenerator",0,2),m("fireControl",0,0),m("sensorArray",0,1),m("frame",1,0),m("frame",1,1),
        m("frame",4,1),m("railgun",2,0),m("missile",3,1),m("auxGenerator",6,2),m("targetingComputer",6,0),
        m("frame",6,1),m("frame",7,0),m("frame",7,1),m("frame",8,0),m("frame",8,1),m("pointDefense",9,0)
      ];
      const occupiedCells = new Map();
      const componentDiagnostics = state.design.map((component, index) => ({
        index,
        type: component.type,
        x: component.x,
        y: component.y,
        rotation: component.rotation,
        occupiedCells: R.moduleCells(component, PART_STATS)
      }));
      state.design.forEach((component, index) => {
        if (!PART_STATS[component.type]) throw new Error(`fixture component ${index} has unknown type ${component.type}`);
        const cells = R.moduleCells(component, PART_STATS);
        for (const cell of cells) {
          const key = `${cell.x},${cell.y}`;
          if (occupiedCells.has(key)) {
            const previousIndex = occupiedCells.get(key);
            throw new Error(
              `fixture component footprints overlap at ${key}: ${previousIndex} and ${index}; ` +
              `component diagnostics: ${JSON.stringify(componentDiagnostics)}`
            );
          }
          occupiedCells.set(key, index);
        }
      });
      let w = R.emptyWiring();
      w = R.addPath(w,"power",[{x:0,y:2},{x:0,y:1},{x:0,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"power",[{x:6,y:2},{x:6,y:1},{x:6,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:2,y:1},{x:2,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:0,y:1},{x:1,y:1},{x:2,y:1},{x:3,y:1}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:6,y:0},{x:7,y:0},{x:8,y:0},{x:9,y:0}],state.design,PART_STATS);
      w = R.addPath(w,"data",[{x:6,y:0},{x:6,y:1},{x:7,y:1},{x:8,y:1},{x:8,y:0},{x:9,y:0}],state.design,PART_STATS);
      state.wiring = storage.normalizeWiring(w, state.design); state.blueprintView = "wiring"; state.wiringUi.mode = "data"; state.thermalLoadMode = "idle";
      const componentIndexAt = (x, y) => state.design.findIndex((component) =>
        R.moduleCells(component, PART_STATS).some((cell) => cell.x === x && cell.y === y)
      );
      for (const wiringType of ["power", "data"]) {
        for (const section of state.wiring[wiringType].sections) {
          const endpointDiagnostics = {
            wiringType,
            section,
            startComponentIndex: componentIndexAt(section.x1, section.y1),
            endComponentIndex: componentIndexAt(section.x2, section.y2),
            componentDiagnostics
          };
          if (endpointDiagnostics.startComponentIndex < 0) throw new Error(`fixture ${wiringType} section start endpoint is not hosted: ${JSON.stringify(endpointDiagnostics)}`);
          if (endpointDiagnostics.endComponentIndex < 0) throw new Error(`fixture ${wiringType} section end endpoint is not hosted: ${JSON.stringify(endpointDiagnostics)}`);
          const distance = Math.abs(section.x1 - section.x2) + Math.abs(section.y1 - section.y2);
          if (distance !== 1) throw new Error(`fixture ${wiringType} section is not one orthogonal cell long: ${JSON.stringify(endpointDiagnostics)}`);
        }
      }
      const analysis = globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, { thermalLoadMode: state.thermalLoadMode });
      const vulnerabilities = globalThis.DesignDataSupportAnalysis.getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, analysis);
      for (const index of [1,2,9]) {
        if (!globalThis.DataSupportRules.isDataSupportSource(state.design[index].type)) throw new Error(`fixture component ${index} is not a recognised Data source`);
        if (!(analysis.sourceAllocationByIndex[index]?.predictedPowerMultiplier > 0)) throw new Error(`fixture Data source ${index} has no predicted Power`);
      }
      if (analysis.networks.length !== 2) throw new Error(`fixture expected 2 physical Data networks, got ${analysis.networks.length}`);
      for (const index of [6,7,15]) {
        if (analysis.weaponBonusByIndex[index]?.status !== "supported") {
          throw new Error(`fixture weapon ${index} is not supported before failure: ${JSON.stringify({ weaponRecords: analysis.weaponBonusByIndex })}`);
        }
      }
      const criticalSections = vulnerabilities.filter((item) => item.kind === "section" && item.severity === "critical");
      const redundantSections = vulnerabilities.filter((item) => item.kind === "section" && item.severity === "redundant" && /^(6|7|8),/.test(item.id));
      if (!criticalSections.length || !redundantSections.length || !criticalSections.some((item) => item.disconnectedWeaponIndices.length >= 2 || item.losses.filter((loss) => loss.allSupportLost).length >= 2)) {
        throw new Error(`invalid Data vulnerability fixture: ${JSON.stringify({ sectionVulnerabilities: vulnerabilities.filter((item) => item.kind === "section").map((item) => ({ id: item.id, severity: item.severity, disconnectedWeaponIndices: item.disconnectedWeaponIndices, lostRangeBonus: item.lostRangeBonus, lostAccuracyBonus: item.lostAccuracyBonus, lostFireRateBonus: item.lostFireRateBonus, summary: item.summary })) })}`);
      }
      wiringUi.refreshWiringPresentation();
    });
    const panel = page.locator("#wiringStatusPanel");

    const resetToDataOverview = async () => {
      await page.evaluate(async () => {
        const [{ state }, wiringUi] = await Promise.all([import("/src/state.js"), import("/src/ui/wiringUi.js")]);
        state.wiringUi.selectedIndex = null;
        state.wiringUi.selectedDataNetworkId = null;
        state.wiringUi.selectedSectionId = null;
        wiringUi.refreshWiringPresentation();
      });
      await assertUnique(panel.locator('[data-data-inspector="overview"]'), "Data overview inspector is visible");
    };
    const inspectDiagnostics = async (locator) => ({
      globalCount: await page.locator('[data-wiring-action="inspect-component"][data-index="6"]').count(),
      scopedCount: await locator.count(),
      panelText: await panel.textContent(),
      matchingButtons: await locator.evaluateAll((buttons) => buttons.map((button) => ({
        text: button.textContent?.trim(),
        index: button.dataset.index,
        role: button.dataset.inspectionRole,
        section: button.closest("[data-data-inspector]")?.dataset.dataInspector
      })))
    });
    const assertUnique = async (locator, message) => {
      const count = await locator.count();
      assert.equal(count, 1, `${message}; diagnostics: ${JSON.stringify(await inspectDiagnostics(locator))}`);
    };
    const scopedComponent = (section, role, index) => panel.locator(
      `[data-data-inspector="${section}"] [data-wiring-action="inspect-component"][data-inspection-role="${role}"][data-index="${index}"]`
    );
    await assert.doesNotReject(() => panel.waitFor({ state: "visible" }));
    const overviewText = await panel.textContent();
    assert(/2 physical Data networks|physical Data networks/.test(overviewText) && /active sources|supported weapons/.test(overviewText), "Data overview is visible");
    const scenario = page.locator('[data-wiring-action="data-scenario"]');
    assert.equal((await scenario.locator("option").evaluateAll((opts) => opts.map((o) => o.textContent.trim()).join("|"))), "Idle|Typical Combat|Maximum Sustained Load");

    await resetToDataOverview();
    let networkButtons = panel.locator('[data-data-inspector="overview"] [data-wiring-action="select-network"]');
    assert.equal(await networkButtons.count(), 2, "overview exposes two Data network selectors");
    const networkIds = await networkButtons.evaluateAll((buttons) => buttons.map((button) => button.dataset.networkId));
    await panel.locator(`[data-wiring-action="select-network"][data-network-id="${networkIds[0]}"]`).click();
    let report = await page.evaluate(() => ({
      selected: document.querySelectorAll(".wire-data.wire-net-selected").length,
      dimmed: document.querySelectorAll(".wire-data.data-dimmed").length,
      selectedDimmed: document.querySelectorAll(".wire-data.wire-net-selected.data-dimmed").length
    }));
    assert(report.selected > 0, "Network A sections are selected/emphasized");
    assert(report.dimmed > 0, "Network B sections are dimmed when Network A is selected");
    assert.equal(report.selectedDimmed, 0, "Network A sections are not dimmed");
    await resetToDataOverview();
    networkButtons = panel.locator('[data-data-inspector="overview"] [data-wiring-action="select-network"]');
    assert.equal(await networkButtons.count(), 2, "overview still exposes two Data network selectors");
    await panel.locator(`[data-wiring-action="select-network"][data-network-id="${networkIds[1]}"]`).click();
    const reversed = await page.evaluate(() => ({ selected: document.querySelectorAll(".wire-data.wire-net-selected").length, dimmed: document.querySelectorAll(".wire-data.data-dimmed").length, selectedDimmed: document.querySelectorAll(".wire-data.wire-net-selected.data-dimmed").length }));
    assert(reversed.selected > 0 && reversed.dimmed > 0 && reversed.selectedDimmed === 0, "switching to Network B reverses selected/dimmed state");

    const targetSource = scopedComponent("network", "network-source", 9);
    await assertUnique(targetSource, "network inspector contains one Targeting Computer source button");
    await targetSource.click();
    assert(await page.locator(".wire-comp-data-source-selected").count() === 1, "selected source class is applied");
    assert(await page.locator(".wire-comp-data-recipient-active").count() > 0, "source recipients have active-recipient class");
    assert.equal(await page.locator(".wire-comp-data-recipient-active[aria-label*='Railgun']").count(), 0, "unrelated weapon is not an active recipient");
    assert(/Point Defence|Point Defense/.test(await panel.textContent()), "panel lists selected source recipients");

    await resetToDataOverview();
    networkButtons = panel.locator('[data-data-inspector="overview"] [data-wiring-action="select-network"]');
    assert.equal(await networkButtons.count(), 2, "overview exposes two Data network selectors before source inspection");
    await panel.locator(`[data-wiring-action="select-network"][data-network-id="${networkIds[0]}"]`).click();
    const fireControlSource = scopedComponent("network", "network-source", 1);
    await assertUnique(fireControlSource, "network inspector contains one Fire Control source button");
    await fireControlSource.click();
    assert(await page.locator(".wire-comp-data-source-selected").count() === 1, "Fire Control selected-source styling is applied");
    assert(await page.locator(".wire-comp-data-recipient-active[aria-label*='Railgun']").count() === 1, "Fire Control marks Railgun as active recipient");
    let fireText = await panel.textContent();
    assert(/Fire Control/.test(fireText) && !/\+\+/.test(fireText), "source panel has no duplicate signs");

    const allRailgunControls = page.locator('[data-wiring-action="inspect-component"][data-index="6"]');
    assert(await allRailgunControls.count() >= 2, "Railgun appears in multiple valid inspector relationships");
    const railgunRecipient = scopedComponent("source", "recipient", 6);
    await assertUnique(railgunRecipient, "source inspector contains one Railgun recipient button");
    await railgunRecipient.click();
    assert(await page.locator(".wire-comp-data-weapon-selected[aria-label*='Railgun']").count() === 1, "Railgun selected-weapon styling is applied");
    assert(await page.locator(".wire-comp-data-contributor-active[aria-label*='Fire Control']").count() === 1, "Fire Control is an active contributor");
    assert(await page.locator(".wire-comp-data-contributor-active[aria-label*='Sensor Array']").count() === 1, "Sensor Array is an active contributor");
    assert(await page.locator(".wire-comp-data-unrelated[aria-label*='Targeting Computer']").count() === 1, "other-network source is deemphasized");
    const weaponText = await panel.textContent();
    assert(/Railgun/.test(weaponText) && /Fire Control/.test(weaponText) && /Sensor Array/.test(weaponText) && !/\+\+|4000%/.test(weaponText), "weapon panel lists contributing sources with sane units");

    try {
    const authoritative = await page.evaluate(async () => {
      const [{ state }, { PART_STATS }] = await Promise.all([import("/src/state.js"), import("/src/design/parts.js")]);
      const analysis = globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, { thermalLoadMode: state.thermalLoadMode });
      const vulnerabilities = globalThis.DesignDataSupportAnalysis.getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, analysis);
      const criticalSections = vulnerabilities.filter((item) => item.kind === "section" && item.severity === "critical");
      const redundantSections = vulnerabilities.filter((item) => item.kind === "section" && item.severity === "redundant" && /^(6|7|8),/.test(item.id));
      return {
        criticalSectionId: criticalSections[0]?.id || null,
        redundantSectionId: redundantSections[0]?.id || null,
        sectionVulnerabilities: vulnerabilities.filter((item) => item.kind === "section").map((item) => ({ id: item.id, severity: item.severity, disconnectedWeaponIndices: item.disconnectedWeaponIndices, lostRangeBonus: item.lostRangeBonus, lostAccuracyBonus: item.lostAccuracyBonus, lostFireRateBonus: item.lostFireRateBonus, summary: item.summary, losses: item.losses })),
        hasTwoWeaponCritical: criticalSections.some((item) => item.disconnectedWeaponIndices.length >= 2 || item.losses.filter((loss) => loss.allSupportLost).length >= 2),
        pointDefenseBefore: analysis.weaponBonusByIndex[15]
      };
    });
    assert(authoritative.criticalSectionId, `fixture contains a genuinely critical Data cable section; diagnostics: ${JSON.stringify(authoritative)}`);
    assert(authoritative.redundantSectionId, `fixture contains a genuinely redundant Data cable section; diagnostics: ${JSON.stringify(authoritative)}`);
    assert(authoritative.hasTwoWeaponCritical, `critical fixture section removes all support from at least two weapons; diagnostics: ${JSON.stringify(authoritative)}`);
    const criticalVisible = page.locator(`.wire-data.data-critical-section[data-section-id="${authoritative.criticalSectionId}"]`);
    const redundantVisible = page.locator(`.wire-data.data-redundant-section[data-section-id="${authoritative.redundantSectionId}"]`);
    assert.equal(await criticalVisible.count(), 1, "authoritative critical section has exactly one visible critical line");
    assert.equal(await redundantVisible.count(), 1, "authoritative redundant section has exactly one visible redundant line");
    const criticalHit = page.locator(`.wire-hit[data-section-id="${authoritative.criticalSectionId}"]`);
    const redundantHit = page.locator(`.wire-hit[data-section-id="${authoritative.redundantSectionId}"]`);
    assert.match(await criticalHit.getAttribute("aria-label"), /Vulnerability: critical/i, "critical cable hit target exposes severity in ARIA");
    assert.match(await redundantHit.getAttribute("aria-label"), /Vulnerability: redundant/i, "redundant cable hit target exposes severity in ARIA");
    assert((await page.locator(".wire-hit").evaluateAll((els) => els.every((el) => /Vulnerability:/.test(el.getAttribute("aria-label") || "")))), "Data cable hit targets include vulnerability text");
    await criticalHit.click();
    let sectionPanelText = await panel.textContent();
    assert(/Selected Data section/.test(sectionPanelText) && /critical/i.test(sectionPanelText) && /Lost support/i.test(sectionPanelText) && (/Railgun/.test(sectionPanelText) && /Missile/.test(sectionPanelText) || /2[^0-9]+weapon/i.test(sectionPanelText)), "critical section inspector details agree with vulnerability analysis");
    await redundantHit.click();
    sectionPanelText = await panel.textContent();
    const pointDefenseAfterRedundant = await page.evaluate(async (sectionId) => {
      const [{ state }, { PART_STATS }] = await Promise.all([import("/src/state.js"), import("/src/design/parts.js")]);
      const R = globalThis.WiringRules;
      const next = R.cloneWiring(state.wiring);
      next.data.sections = next.data.sections.filter((section) => R.segmentKey(section) !== sectionId);
      const normalized = R.normalizeWiring(next, state.design, PART_STATS).wiring;
      return globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(state.design, normalized, PART_STATS, { thermalLoadMode: state.thermalLoadMode }).weaponBonusByIndex[15];
    }, authoritative.redundantSectionId);
    assert(/Selected Data section/.test(sectionPanelText) && /redundant route|redundant/i.test(sectionPanelText) && /Lost support/i.test(sectionPanelText) && /0 m/.test(sectionPanelText), "redundant section inspector reports no predicted support loss");
    assert.deepEqual({ rangeBonus: pointDefenseAfterRedundant.rangeBonus, accuracyBonus: pointDefenseAfterRedundant.accuracyBonus, fireRateBonus: pointDefenseAfterRedundant.fireRateBonus }, { rangeBonus: authoritative.pointDefenseBefore.rangeBonus, accuracyBonus: authoritative.pointDefenseBefore.accuracyBonus, fireRateBonus: authoritative.pointDefenseBefore.fireRateBonus }, "redundant route preserves effective support for Point Defence");
    } catch (vulnerabilityError) {
      mkdirSync("test-artifacts/data-support-browser", { recursive: true });
      const screenshotPath = "test-artifacts/data-support-browser/vulnerability-failure.png";
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const diagnostics = await page.evaluate(async () => {
        const [{ state }, { PART_STATS }] = await Promise.all([import("/src/state.js"), import("/src/design/parts.js")]);
        const analysis = globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, { thermalLoadMode: state.thermalLoadMode });
        const vulnerabilities = globalThis.DesignDataSupportAnalysis.getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, analysis);
        return {
          sectionVulnerabilities: vulnerabilities.filter((item) => item.kind === "section").map((item) => ({ id: item.id, severity: item.severity, disconnectedWeaponIndices: item.disconnectedWeaponIndices, lostRangeBonus: item.lostRangeBonus, lostAccuracyBonus: item.lostAccuracyBonus, lostFireRateBonus: item.lostFireRateBonus, summary: item.summary })),
          visibleCriticalCount: document.querySelectorAll(".wire-data.data-critical-section").length,
          visibleRedundantCount: document.querySelectorAll(".wire-data.data-redundant-section").length,
          renderedSections: [...document.querySelectorAll(".wire-data[data-section-id]")].map((el) => ({ id: el.dataset.sectionId, className: el.getAttribute("class") })),
          ariaLabels: [...document.querySelectorAll(".wire-hit")].map((el) => ({ id: el.dataset.sectionId, label: el.getAttribute("aria-label") || "" })),
          panelText: document.querySelector("#wiringStatusPanel")?.textContent || "",
          screenshotPath
        };
      });
      vulnerabilityError.message = `${vulnerabilityError.message}; vulnerability diagnostics: ${JSON.stringify(diagnostics)}`;
      throw vulnerabilityError;
    }

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
