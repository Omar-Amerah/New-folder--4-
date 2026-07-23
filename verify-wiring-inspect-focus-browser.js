#!/usr/bin/env node
"use strict";

// Regression for native SVG focus outlines on transparent wiring hit lines.
// Runs the same pointer and keyboard inspection contract in Chromium + Firefox.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium, firefox } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
const artifactDir = path.join(__dirname, "test-artifacts", "wiring-inspect-focus");
fs.mkdirSync(artifactDir, { recursive: true });

async function buildFixture(page) {
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    const [{ state }, designer, wiring, { PART_STATS }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerUi.js"),
      import("/src/ui/wiringUi.js"),
      import("/src/design/parts.js")
    ]);
    document.querySelector("#blueprintDesignerScreen").hidden = false;
    state.design = [
      { x: 1, y: 1, type: "core" },
      { x: 2, y: 1, type: "gyroscope" },
      { x: 1, y: 4, type: "fireControl" },
      { x: 2, y: 4, type: "railgun" }
    ];
    let value = window.WiringRules.emptyWiring();
    value = window.WiringRules.addPathWithTier(value, "power", [{ x: 1, y: 1 }, { x: 2, y: 1 }], state.design, PART_STATS, "standard");
    value = window.WiringRules.addPath(value, "data", [{ x: 1, y: 4 }, { x: 2, y: 4 }], state.design, PART_STATS);
    state.wiring = value;
    wiring.resetWiringEditorState();
    designer.renderBuildGrid();
    designer.setBlueprintView("wiring");
  });
  await page.locator("svg.wiring-overlay").waitFor({ state: "visible" });
}

async function wiringJson(page) {
  return page.evaluate(async () => JSON.stringify((await import("/src/state.js")).state.wiring));
}

async function assertNoNativeSvgOutline(page, label) {
  const outlined = await page.evaluate(() => [...document.querySelectorAll("svg.wiring-overlay *")]
    .map((element) => {
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        className: element.getAttribute("class") || "",
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineColor: style.outlineColor
      };
    })
    .filter((item) => item.outlineStyle !== "none" && Number.parseFloat(item.outlineWidth) > 0));
  assert.deepStrictEqual(outlined, [], `${label}: no wiring SVG element has a visible CSS outline`);
}

async function assertBoundedPaint(page, label) {
  const geometry = await page.evaluate(() => {
    const overlay = document.querySelector("svg.wiring-overlay");
    const overlayRect = overlay.getBoundingClientRect();
    const cellWidth = overlayRect.width / 15;
    const cellHeight = overlayRect.height / 15;
    const transparent = (value) => !value || value === "none" || value === "transparent"
      || /rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(value);
    return [...overlay.querySelectorAll("line,circle,rect,path,polyline,polygon")].flatMap((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return [];
      if (transparent(style.stroke) && transparent(style.fill)) return [];
      const rect = element.getBoundingClientRect();
      const className = element.getAttribute("class") || "";
      return [{
        tag: element.tagName,
        className,
        focusSelectionVisual: /focus|selected|wire-section-hover/.test(className) || element.matches(":focus"),
        widthCells: rect.width / cellWidth,
        heightCells: rect.height / cellHeight
      }];
    });
  });
  const oversized = geometry.filter((item) => item.focusSelectionVisual && (item.widthCells > 2.01 || item.heightCells > 2.01));
  assert.deepStrictEqual(oversized, [], `${label}: no painted focus/selection visual exceeds two grid cells`);
}

async function tabToHitLine(page) {
  // The 225-cell grid precedes the SVG in DOM tab order. Start at its final
  // focusable cell, then use real Tab navigation into the cable hit targets.
  await page.locator("#buildGrid .build-cell").last().focus();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement?.matches?.(".wire-hit[data-section-id]"))) return;
  }
  assert.fail("Tab navigation did not reach a focusable wiring hit line");
}

async function runMode(page, browserName, mode) {
  const sectionId = mode === "power" ? "1,1:2,1" : "1,4:2,4";
  await page.locator(mode === "power" ? "#wiringModePower" : "#wiringModeData").click();
  await page.locator('[data-wiring-tool="inspect"]').click();
  const hit = page.locator(`.wire-hit[data-section-id="${sectionId}"]`).first();
  assert.strictEqual(await hit.count(), 1, `${browserName} ${mode}: fixture renders the expected hit line`);

  // Pointer inspection: pointerdown must not transfer focus to the SVG hit line.
  const mouseBefore = await wiringJson(page);
  const hitPoint = await hit.evaluate((line) => {
    const svg = line.ownerSVGElement;
    const point = svg.createSVGPoint();
    point.x = (Number(line.getAttribute("x1")) + Number(line.getAttribute("x2"))) / 2;
    point.y = (Number(line.getAttribute("y1")) + Number(line.getAttribute("y2"))) / 2;
    const screen = point.matrixTransform(svg.getScreenCTM());
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(hitPoint.x, hitPoint.y);
  assert.strictEqual(await page.evaluate(() => document.activeElement?.matches?.(".wire-hit") || false), false,
    `${browserName} ${mode}: pointer inspection does not focus the hit line`);
  await assertNoNativeSvgOutline(page, `${browserName} ${mode} mouse`);
  await assertBoundedPaint(page, `${browserName} ${mode} mouse`);
  assert.strictEqual(await wiringJson(page), mouseBefore, `${browserName} ${mode}: mouse inspection does not mutate wiring`);
  const mouseInspection = await page.evaluate(async (id) => {
    const { state } = await import("/src/state.js");
    return {
      selectedSectionId: state.wiringUi.selectedSectionId,
      panelText: document.querySelector("#wiringStatusPanel")?.textContent || ""
    };
  }, sectionId);
  assert.strictEqual(mouseInspection.selectedSectionId, sectionId, `${browserName} ${mode}: detailed section selection opens`);
  assert.match(mouseInspection.panelText, mode === "power" ? /Cable section/i : /Selected Data section/i,
    `${browserName} ${mode}: detailed section panel is visible`);
  await page.screenshot({ path: path.join(artifactDir, `${browserName}-${mode}-inspect.png`), fullPage: true });

  // Keyboard inspection: Tab focus is retained, but represented on the visible
  // cable by a bounded class instead of a native SVG outline.
  await tabToHitLine(page);
  const keyboardFocus = await page.evaluate(() => {
    const active = document.activeElement;
    const id = active?.dataset?.sectionId || null;
    const visible = [...document.querySelectorAll(".wire-visible-layer [data-section-id]")]
      .find((element) => element.dataset.sectionId === id);
    const overlayRect = document.querySelector("svg.wiring-overlay").getBoundingClientRect();
    const rect = visible?.getBoundingClientRect();
    const style = active ? getComputedStyle(active) : null;
    return {
      id,
      activeIsHit: active?.matches?.(".wire-hit[data-section-id]") || false,
      exactClass: visible?.classList.contains("wire-section-keyboard-focus") || false,
      focusedVisualCount: document.querySelectorAll(".wire-section-keyboard-focus").length,
      outlineStyle: style?.outlineStyle || "",
      outlineWidth: style?.outlineWidth || "",
      widthCells: rect ? rect.width / (overlayRect.width / 15) : Infinity,
      heightCells: rect ? rect.height / (overlayRect.height / 15) : Infinity
    };
  });
  assert.strictEqual(keyboardFocus.activeIsHit, true, `${browserName} ${mode}: wire hit line remains keyboard focusable`);
  assert.strictEqual(keyboardFocus.exactClass, true, `${browserName} ${mode}: exact visible cable gets keyboard focus class`);
  assert.strictEqual(keyboardFocus.focusedVisualCount, 1, `${browserName} ${mode}: only one cable gets keyboard focus styling`);
  assert.ok(keyboardFocus.outlineStyle === "none" || Number.parseFloat(keyboardFocus.outlineWidth) === 0,
    `${browserName} ${mode}: focused SVG hit line keeps native outline disabled`);
  assert.ok(keyboardFocus.widthCells <= 2.01 && keyboardFocus.heightCells <= 2.01,
    `${browserName} ${mode}: keyboard highlight remains locally bounded (${JSON.stringify(keyboardFocus)})`);
  await assertNoNativeSvgOutline(page, `${browserName} ${mode} keyboard`);
  await assertBoundedPaint(page, `${browserName} ${mode} keyboard`);
  const keyboardBefore = await wiringJson(page);
  await page.keyboard.press("Enter");
  assert.strictEqual(await wiringJson(page), keyboardBefore, `${browserName} ${mode}: keyboard inspection does not mutate wiring`);
  assert.strictEqual(await page.evaluate(async () => (await import("/src/state.js")).state.wiringUi.selectedSectionId), keyboardFocus.id,
    `${browserName} ${mode}: Enter opens inspection for the keyboard-focused section`);
}

(async () => {
  const browsers = [];
  try {
    await waitForServer(base);
    browsers.push(["chromium", await launchChromium(chromium)]);
    browsers.push(["firefox", await firefox.launch({ headless: true })]);
    for (const [browserName, browser] of browsers) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await buildFixture(page);
      await runMode(page, browserName, "power");
      await runMode(page, browserName, "data");
      await page.close();
    }
    console.log(`Wiring Inspect focus regression passed in Chromium and Firefox; screenshots: ${path.relative(__dirname, artifactDir)}`);
  } finally {
    await Promise.all(browsers.map(([, browser]) => browser.close().catch(() => {})));
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
