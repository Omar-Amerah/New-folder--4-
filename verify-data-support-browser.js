#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { mkdirSync } = require("fs");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");
const referenceFixtures = require("./test-fixtures/dataSupportReferenceShips");
const port = uniquePort(); const base = `http://127.0.0.1:${port}`; const { server } = startServer(port); let browser;

async function svgLineScreenPoint(locator, fraction = 0.5) {
  return locator.evaluate((element, t) => {
    const svg = element.ownerSVGElement;
    const matrix = element.getScreenCTM();

    if (!svg || !matrix) {
      throw new Error("SVG cable line has no screen transformation matrix");
    }

    const x1 = Number(element.getAttribute("x1"));
    const y1 = Number(element.getAttribute("y1"));
    const x2 = Number(element.getAttribute("x2"));
    const y2 = Number(element.getAttribute("y2"));

    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      throw new Error("SVG cable line has invalid coordinates");
    }

    const point = svg.createSVGPoint();

    point.x = x1 + ((x2 - x1) * t);
    point.y = y1 + ((y2 - y1) * t);

    const screen = point.matrixTransform(matrix);

    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y)) {
      throw new Error("SVG cable line produced non-finite screen coordinates");
    }

    return {
      x: screen.x,
      y: screen.y,
      svgX: point.x,
      svgY: point.y
    };
  }, fraction);
}

async function svgSectionDiagnostics(page, locator, expectedSectionId, point, elementFromPointResult) {
  const [lineDetails, selectedSectionId, renderedSectionIds] = await Promise.all([
    locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const svg = element.ownerSVGElement;
      const matrix = element.getScreenCTM();
      return {
        lineAttributes: {
          x1: element.getAttribute("x1"),
          y1: element.getAttribute("y1"),
          x2: element.getAttribute("x2"),
          y2: element.getAttribute("y2")
        },
        boundingRect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          left: rect.left
        },
        computedStyle: {
          pointerEvents: style.pointerEvents,
          strokeWidth: style.strokeWidth,
          stroke: style.stroke
        },
        svgViewBox: svg?.getAttribute("viewBox") || null,
        screenMatrix: matrix ? {
          a: matrix.a,
          b: matrix.b,
          c: matrix.c,
          d: matrix.d,
          e: matrix.e,
          f: matrix.f
        } : null
      };
    }),
    page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return state.wiringUi.selectedSectionId;
    }),
    page.locator(".wire-hit[data-section-id]").evaluateAll((elements) =>
      elements.map((element) => element.dataset.sectionId)
    )
  ]);

  return {
    expectedSectionId,
    point,
    elementFromPointResult,
    ...lineDetails,
    selectedSectionId,
    renderedSectionIds
  };
}

async function clickSvgSection(page, locator, expectedSectionId, label) {
  assert.equal(await locator.count(), 1, `${label} has exactly one SVG hit line`);

  const point = await svgLineScreenPoint(locator);

  const hit = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    const section = element?.closest?.("[data-section-id]");

    return {
      tagName: element?.tagName || null,
      className: element?.getAttribute?.("class") || null,
      sectionId: section?.dataset?.sectionId || null,
      parentLayer: section?.parentElement?.getAttribute?.("class") || null,
      pointerEvents: element ? getComputedStyle(element).pointerEvents : null
    };
  }, point);

  if (hit.sectionId !== expectedSectionId) {
    const diagnostics = await svgSectionDiagnostics(page, locator, expectedSectionId, point, hit);
    assert.equal(
      hit.sectionId,
      expectedSectionId,
      `${label} midpoint reaches its intended hit target; diagnostics: ${JSON.stringify(diagnostics)}`
    );
  }

  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);

  return { point, hit };
}

async function collectVulnerabilityDiagnostics(page) {
  return page.evaluate(async () => {
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
      selectedSectionId: state.wiringUi?.selectedSectionId ?? null,
      wiringMode: state.wiringUi?.mode ?? null,
      blueprintView: state.blueprintView
    };
  });
}
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
    await page.locator("#designerAnalysisTab").click();
    const panel = page.locator("#wiringStatusPanel");
    const dataAdvanced = page.locator('[data-wiring-details="advanced"]');
    if ((await dataAdvanced.getAttribute("open")) === null) await dataAdvanced.locator(":scope > summary").click();

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
    const redundantRecord = authoritative.sectionVulnerabilities.find((item) => item.id === authoritative.redundantSectionId);
    assert(redundantRecord, "authoritative redundant vulnerability record exists");
    assert.equal(redundantRecord.severity, "redundant", "selected redundant section has redundant severity");
    assert.equal(Number(redundantRecord.lostRangeBonus), 0, "redundant section loses no range support");
    assert.equal(Number(redundantRecord.lostAccuracyBonus), 0, "redundant section loses no accuracy support");
    assert.equal(Number(redundantRecord.lostFireRateBonus), 0, "redundant section loses no fire-rate support");
    assert(authoritative.hasTwoWeaponCritical, `critical fixture section removes all support from at least two weapons; diagnostics: ${JSON.stringify(authoritative)}`);
    const criticalVisible = page.locator(`.wire-data.data-critical-section[data-section-id="${authoritative.criticalSectionId}"]`);
    const redundantVisible = page.locator(`.wire-data.data-redundant-section[data-section-id="${authoritative.redundantSectionId}"]`);
    assert.equal(await criticalVisible.count(), 1, "authoritative critical section has exactly one visible critical line");
    assert.equal(await redundantVisible.count(), 1, "authoritative redundant section has exactly one visible redundant line");
    const criticalHit = page.locator(`.wire-hit[data-section-id="${authoritative.criticalSectionId}"]`);
    assert.match(await criticalHit.getAttribute("aria-label"), /Vulnerability: critical/i, "critical cable hit target exposes severity in ARIA");
    assert((await page.locator(".wire-hit").evaluateAll((els) => els.every((el) => /Vulnerability:/.test(el.getAttribute("aria-label") || "")))), "Data cable hit targets include vulnerability text");
    await clickSvgSection(page, criticalHit, authoritative.criticalSectionId, "critical Data cable section");
    const selectedCriticalId = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return state.wiringUi.selectedSectionId;
    });
    assert.equal(selectedCriticalId, authoritative.criticalSectionId, "critical Data cable becomes the selected section");
    let sectionPanelText = await panel.textContent();
    assert(/Selected Data section/.test(sectionPanelText) && /critical/i.test(sectionPanelText) && /Lost support/i.test(sectionPanelText) && (/Railgun/.test(sectionPanelText) && /Missile/.test(sectionPanelText) || /2[^0-9]+weapon/i.test(sectionPanelText)), "critical section inspector details agree with vulnerability analysis");

    const redundantHit = page.locator(`.wire-hit[data-section-id="${authoritative.redundantSectionId}"]`);
    assert.match(await redundantHit.getAttribute("aria-label"), /Vulnerability: redundant/i, "redundant cable hit target exposes severity in ARIA");
    await clickSvgSection(page, redundantHit, authoritative.redundantSectionId, "redundant Data cable section");
    const selectedRedundantId = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return state.wiringUi.selectedSectionId;
    });
    assert.equal(selectedRedundantId, authoritative.redundantSectionId, "redundant Data cable becomes the selected section");
    const redundantInspector = panel.locator('[data-data-inspector="section-vulnerability"]');
    assert.equal(await redundantInspector.count(), 1, "redundant section inspector appears exactly once");
    const redundantPanelText = await redundantInspector.textContent();
    const pointDefenseAfterRedundant = await page.evaluate(async (sectionId) => {
      const [{ state }, { PART_STATS }] = await Promise.all([import("/src/state.js"), import("/src/design/parts.js")]);
      const R = globalThis.WiringRules;
      const next = R.cloneWiring(state.wiring);
      next.data.sections = next.data.sections.filter((section) => R.segmentKey(section) !== sectionId);
      const normalized = R.normalizeWiring(next, state.design, PART_STATS).wiring;
      return globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(state.design, normalized, PART_STATS, { thermalLoadMode: state.thermalLoadMode }).weaponBonusByIndex[15];
    }, authoritative.redundantSectionId);
    const redundantDiagnostics = JSON.stringify({
      redundantSectionId: authoritative.redundantSectionId,
      redundantRecord,
      redundantPanelText,
      pointDefenseBefore: authoritative.pointDefenseBefore,
      pointDefenseAfterRedundant,
      selectedSectionId: selectedRedundantId
    });
    assert.match(redundantPanelText, /Selected Data section/i, `redundant section inspector is visible; diagnostics: ${redundantDiagnostics}`);
    assert.match(redundantPanelText, /redundant/i, `redundant section inspector reports authoritative severity; diagnostics: ${redundantDiagnostics}`);
    assert.match(redundantPanelText, /Lost support:\s*No predicted support loss\./i, `redundant section inspector reports no predicted support loss; diagnostics: ${redundantDiagnostics}`);
    const before = authoritative.pointDefenseBefore;
    const after = pointDefenseAfterRedundant;
    assert.deepEqual(
      {
        rangeBonus: Number(after.rangeBonus || 0),
        accuracyBonus: Number(after.accuracyBonus || 0),
        fireRateBonus: Number(after.fireRateBonus || 0)
      },
      {
        rangeBonus: Number(before.rangeBonus || 0),
        accuracyBonus: Number(before.accuracyBonus || 0),
        fireRateBonus: Number(before.fireRateBonus || 0)
      },
      "redundant route preserves effective support for Point Defence"
    );
    } catch (vulnerabilityError) {
      mkdirSync("test-artifacts/data-support-browser", { recursive: true });
      const screenshotPath = "test-artifacts/data-support-browser/vulnerability-failure.png";
      await page.screenshot({ path: screenshotPath, fullPage: true });
      let diagnostics = { screenshotPath };
      try {
        const browserDiagnostics = await collectVulnerabilityDiagnostics(page);
        diagnostics = { ...diagnostics, ...browserDiagnostics };
      } catch (diagnosticError) {
        diagnostics.diagnosticCollectionError = String(diagnosticError?.stack || diagnosticError);
      }
      vulnerabilityError.message = `${vulnerabilityError.message}; vulnerability diagnostics: ${JSON.stringify(diagnostics)}`;
      throw vulnerabilityError;
    }


    const browserReferenceParity = await page.evaluate(async (fixtures) => {
      const [{ PART_STATS }, storage] = await Promise.all([import("/src/design/parts.js"), import("/src/design/blueprintStorage.js")]);
      const R = globalThis.WiringRules;
      return fixtures.map((fixture) => {
        const normalized = storage.normalizeWiring(fixture.wiring, fixture.design);
        if (JSON.stringify(normalized) !== JSON.stringify(fixture.wiring)) throw new Error(`${fixture.name} browser-normalized wiring differs from reference fixture`);
        const analysis = globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(fixture.design, fixture.wiring, PART_STATS, { thermalLoadMode: "idle" });
        const vulnerabilities = globalThis.DesignDataSupportAnalysis.getCachedDataVulnerabilities(fixture.design, fixture.wiring, PART_STATS, analysis);
        if (!Array.isArray(analysis.sources)) {
          throw new Error(`${fixture.name} designer analysis is missing sources`);
        }
        if (!Array.isArray(analysis.weapons)) {
          throw new Error(`${fixture.name} designer analysis is missing weapons`);
        }
        if (!Array.isArray(analysis.networks)) {
          throw new Error(`${fixture.name} designer analysis is missing networks`);
        }
        if (!Array.isArray(vulnerabilities)) {
          throw new Error(`${fixture.name} vulnerability analysis is not an array`);
        }

        const expectedSources = [...fixture.expected.sources].sort((a, b) => a - b);
        const actualSources = analysis.sources.map((entry) => entry.sourceIndex).sort((a, b) => a - b);
        const expectedWeapons = [...fixture.expected.weapons].sort((a, b) => a - b);
        const actualWeapons = analysis.weapons.map((entry) => entry.weaponIndex).sort((a, b) => a - b);
        const duplicateSources = actualSources.filter((sourceIndex, index) => index > 0 && sourceIndex === actualSources[index - 1]);
        const duplicateWeapons = actualWeapons.filter((weaponIndex, index) => index > 0 && weaponIndex === actualWeapons[index - 1]);
        const invalidSources = analysis.sources.filter((entry) => !Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0);
        const invalidWeapons = analysis.weapons.filter((entry) => !Number.isInteger(entry.weaponIndex) || entry.weaponIndex < 0);

        if (JSON.stringify(actualSources) !== JSON.stringify(expectedSources)) throw new Error(`${fixture.name} browser source indices ${JSON.stringify(actualSources)} !== ${JSON.stringify(expectedSources)}`);
        if (JSON.stringify(actualWeapons) !== JSON.stringify(expectedWeapons)) throw new Error(`${fixture.name} browser weapon indices ${JSON.stringify(actualWeapons)} !== ${JSON.stringify(expectedWeapons)}`);
        if (analysis.networks.length !== fixture.expectedNetworkCount) throw new Error(`${fixture.name} browser network count ${analysis.networks.length} !== ${fixture.expectedNetworkCount}`);
        if (duplicateSources.length) throw new Error(`${fixture.name} browser source indices contain duplicates: ${JSON.stringify(duplicateSources)}`);
        if (duplicateWeapons.length) throw new Error(`${fixture.name} browser weapon indices contain duplicates: ${JSON.stringify(duplicateWeapons)}`);
        if (invalidSources.length) throw new Error(`${fixture.name} browser sources have invalid sourceIndex values: ${JSON.stringify(invalidSources)}`);
        if (invalidWeapons.length) throw new Error(`${fixture.name} browser weapons have invalid weaponIndex values: ${JSON.stringify(invalidWeapons)}`);
        for (const section of fixture.wiring.data.sections) {
          const id = R.segmentKey(section);
          if (!vulnerabilities.some((item) => item.kind === "section" && item.id === id)) throw new Error(`${fixture.name} browser missing section vulnerability ${id}`);
        }
        return { key: fixture.key, networks: analysis.networks.length, sources: actualSources, weapons: actualWeapons, sectionsWithCoverage: fixture.wiring.data.sections.length };
      });
    }, referenceFixtures.allReferenceShips());
    assert.equal(browserReferenceParity.length, 5, `browser validates all five Section 6E reference fixtures: ${JSON.stringify(browserReferenceParity)}`);

    const advancedDetails = page.locator('[data-wiring-details="advanced"]');
    if ((await advancedDetails.getAttribute("open")) === null) await advancedDetails.locator(":scope > summary").click();
    await scenario.selectOption("full");
    const freshPanel = page.locator("#wiringStatusPanel");
    assert(/Maximum Sustained Load|Data-support inspection/.test(await freshPanel.textContent()), "scenario select works after panel rerender without stale handles");
    await page.locator("#wiringModePower").click(); assert(/Summary[\s\S]*Selected tier[\s\S]*Issues/i.test(await panel.textContent()), "Power inspection still works");
    await page.locator("#blueprintHeatTab").click(); assert(await page.locator(".wire-comp-data-source-active,.wire-comp-data-weapon-supported").count() === 0, "Data overlay classes removed in Heat view");
    await page.locator("#blueprintBuildTab").click(); assert(await page.locator("#wiringStatusPanel").evaluate((el) => el.hidden || !/Data-support inspection/.test(el.textContent)), "no stale Data panel after returning to Blueprint");
    assert.deepEqual({ errors, consoleErrors }, { errors: [], consoleErrors: [] }, `Unexpected browser diagnostics: ${JSON.stringify({ errors, consoleErrors }, null, 2)}`);
    console.log("Data-support designer browser verification passed.");
  } finally { await browser?.close?.(); server.kill("SIGTERM"); }
})().catch((error) => { console.error(error); process.exit(1); });
