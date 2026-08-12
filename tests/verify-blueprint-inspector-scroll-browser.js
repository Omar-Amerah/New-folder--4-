"use strict";

const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const {
  launchChromium,
  startServer,
  waitForServer,
  uniquePort
} = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server } = startServer(port);
let browser;

function closeEnough(actual, expected, tolerance = 2) {
  return Math.abs(actual - expected) <= tolerance;
}

async function dismissMenus(page) {
  await page.waitForFunction(() => {
    const menu = document.getElementById("mainMenuScreen");
    return menu && !menu.hidden;
  }, null, { timeout: 15000 });
  await page.evaluate(() => {
    for (const id of ["mainMenuScreen", "lobbyManagementScreen", "settingsScreen"]) {
      const menu = document.getElementById(id);
      if (menu) menu.hidden = true;
    }
  });
}

async function openHeatInspector(page) {
  await dismissMenus(page);
  await page.click("#openBlueprintDesignerButton");
  await page.waitForSelector("#blueprintDesignerScreen:not([hidden]) .designer-right-col", { timeout: 5000 });
  await page.evaluate(async () => {
    const [{ setBlueprintView }, inspector] = await Promise.all([
      import("/src/ui/designerUi.js"),
      import("/src/ui/designerInspectorUi.js")
    ]);
    setBlueprintView("heat");
    inspector.activateDesignerInspectorTab("analysis");
    inspector.activateDesignerAnalysisTab("heat");
  });
  await page.waitForSelector("#analysisHeatPanel:not([hidden]) .thermal-detailed-analysis", { timeout: 5000 });
  await page.waitForFunction(() => {
    const panel = document.getElementById("fullLoadThermalPanel");
    return panel && !panel.hidden && panel.getBoundingClientRect().width > 0;
  }, null, { timeout: 5000 });
}

async function measure(page) {
  return page.evaluate(() => {
    const right = document.querySelector(".designer-right-col");
    const inspector = document.getElementById("designerAnalysisPanel");
    const topTabs = document.getElementById("designerInspectorTabs");
    const analysisTabs = document.getElementById("designerAnalysisSubtabs");
    const card = document.getElementById("fullLoadThermalPanel");
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        center: (rect.left + rect.right) / 2
      };
    };
    const inspectorStyle = getComputedStyle(inspector);
    const webkitScrollbar = getComputedStyle(inspector, "::-webkit-scrollbar");
    return {
      right: box(right),
      inspector: {
        ...box(inspector),
        clientWidth: inspector.clientWidth,
        scrollWidth: inspector.scrollWidth,
        clientHeight: inspector.clientHeight,
        scrollHeight: inspector.scrollHeight,
        scrollTop: inspector.scrollTop
      },
      topTabs: box(topTabs),
      analysisTabs: box(analysisTabs),
      card: box(card),
      topTabsPosition: getComputedStyle(topTabs).position,
      analysisTabsPosition: getComputedStyle(analysisTabs).position,
      rightScrollbarGutter: getComputedStyle(right).scrollbarGutter,
      inspectorScrollbarGutter: inspectorStyle.scrollbarGutter,
      inspectorScrollbarWidth: inspectorStyle.scrollbarWidth,
      webkitScrollbarWidth: webkitScrollbar.width,
      webkitScrollbarHeight: webkitScrollbar.height
    };
  });
}

function assertHorizontalGeometry(label, before, after) {
  for (const key of ["topTabs", "analysisTabs", "card"]) {
    for (const edge of ["left", "right", "width", "center"]) {
      assert.ok(
        closeEnough(before[key][edge], after[key][edge], 1.5),
        `${label} ${key}.${edge} shifted: ${before[key][edge]} -> ${after[key][edge]}`
      );
    }
  }
}

async function run() {
  await waitForServer(base);
  browser = await launchChromium(chromium);
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));

  try {
    await page.goto(`${base}/index.html`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true, null, { timeout: 15000 });
    await openHeatInspector(page);

    const details = page.locator(".thermal-detailed-analysis");
    if (await details.getAttribute("open") !== null) {
      await details.locator("summary").click();
    }
    await page.waitForFunction(() => {
      const panel = document.getElementById("designerAnalysisPanel");
      return panel && panel.scrollTop === 0;
    });

    const short = await measure(page);
    assert.equal(short.rightScrollbarGutter, "auto",
      "the fixed right column must not reserve a stable scrollbar gutter");
    assert.equal(short.inspectorScrollbarGutter, "auto",
      "the inspector must not reserve a stable scrollbar gutter");
    assert.equal(short.topTabsPosition, "sticky",
      "top-level inspector tabs should remain fixed in the right column");
    assert.equal(short.analysisTabsPosition, "sticky",
      "analysis subtabs should remain sticky while the inspector scrolls");
    assert.ok(short.inspectorScrollbarWidth === "none" || short.webkitScrollbarWidth === "0px",
      `the inspector native scrollbar should be hidden: ${JSON.stringify(short)}`);
    assert.equal(short.inspector.scrollWidth, short.inspector.clientWidth,
      "short inspector content should not gain horizontal overflow");
    assert.ok(short.inspector.scrollHeight <= short.inspector.clientHeight,
      `short inspector content unexpectedly overflows: ${short.inspector.scrollHeight}/${short.inspector.clientHeight}`);

    assert.ok(closeEnough(short.topTabs.left, short.right.left, 2),
      "top-level inspector tabs should start at the right column edge");
    assert.ok(closeEnough(short.topTabs.right, short.right.right, 2),
      "top-level inspector tabs should fill the right column edge");
    assert.ok(closeEnough(short.analysisTabs.left, short.inspector.left, 2),
      "analysis subtabs should start at the inspector edge");
    assert.ok(closeEnough(short.analysisTabs.right, short.inspector.right, 2),
      "analysis subtabs should fill the inspector edge");
    assert.ok(closeEnough(short.card.center, short.inspector.center, 2),
      "short Heat Analysis card should be centred in the inspector");
    assert.ok(closeEnough(
      short.card.left - short.inspector.left,
      short.inspector.right - short.card.right,
      2
    ), "short Heat Analysis card should have balanced horizontal spacing");

    await details.locator("summary").click();
    await page.waitForFunction(() => {
      const panel = document.getElementById("designerAnalysisPanel");
      const details = panel?.querySelector(".thermal-detailed-analysis");
      return details?.open === true && panel.scrollHeight > panel.clientHeight;
    }, null, { timeout: 5000 });
    const long = await measure(page);
    assert.ok(long.inspector.scrollHeight > long.inspector.clientHeight,
      "expanded Detailed analysis should make the inspector scrollable");
    assertHorizontalGeometry("short to long", short, long);

    const scrollTop = await page.evaluate(() => {
      const panel = document.getElementById("designerAnalysisPanel");
      panel.scrollTop = panel.scrollHeight;
      return panel.scrollTop;
    });
    assert.ok(scrollTop > 0, "the inspector should keep programmatic vertical scrolling functional");
    const scrolled = await measure(page);
    assert.equal(scrolled.analysisTabsPosition, "sticky",
      "analysis subtabs should remain sticky after inspector scrolling");
    assertHorizontalGeometry("before to after scroll", long, scrolled);

    assert.equal(pageErrors.length, 0, `browser page errors: ${pageErrors.map((error) => error.message).join(" | ")}`);
    console.log("Blueprint inspector scrollbar/layout verification passed");
  } finally {
    await page.close();
  }
}

run()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close?.();
    server.kill();
  });
