"use strict";

const http = require("http");
const { spawn } = require("child_process");
const { chromium } = require("playwright");

const { launchChromium } = require("./verify-pixi-browser-support.js");

// TEST_PORT (not the production PORT default) so this test never collides with
// a locally running game server.
const PORT = Number(process.env.TEST_PORT || 5621);
const BASE = `http://127.0.0.1:${PORT}`;

function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(BASE, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`server did not start at ${BASE}`));
        else setTimeout(attempt, 150);
      });
      req.setTimeout(1000, () => req.destroy());
    };
    attempt();
  });
}

function approx(actual, expected, tolerance = 4) {
  return Math.abs(actual - expected) <= tolerance;
}

// The client opens the main-menu overlay at boot, which covers the side-panel
// Blueprint Designer button and intercepts pointer events. Hide the boot menu
// screens (as the other browser tests do) so the button is clickable.
async function dismissMenus(page) {
  // The client bootstrap is async and calls openMainMenu() late; hiding the
  // overlays before that would race and lose. Wait for the menu to be shown.
  await page.waitForFunction(() => {
    const el = document.getElementById("mainMenuScreen");
    return el && !el.hidden;
  }, null, { timeout: 15000 });
  await page.evaluate(() => {
    for (const id of ["mainMenuScreen", "lobbyManagementScreen", "settingsScreen"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
  });
}

async function inspectMobile(page) {
  await dismissMenus(page);
  await page.click("#openBlueprintDesignerButton");
  await page.waitForSelector("#blueprintDesignerScreen:not([hidden]) .blueprint-designer-panel");

  const before = await page.evaluate(() => {
    const overlay = document.getElementById("blueprintDesignerScreen");
    const panel = document.querySelector(".blueprint-designer-panel");
    const right = document.querySelector(".designer-right-col");
    const header = document.querySelector(".blueprint-designer-panel > .menu-head");
    const tabs = document.getElementById("designerInspectorTabs");
    return {
      overlayScrollWidth: overlay.scrollWidth,
      overlayClientWidth: overlay.clientWidth,
      panelLeft: panel.getBoundingClientRect().left,
      panelRight: panel.getBoundingClientRect().right,
      headerPosition: getComputedStyle(header).position,
      bodyOverflow: getComputedStyle(document.body).overflow,
      rightBefore: right.getBoundingClientRect(),
      tabs: tabs.getBoundingClientRect(),
      rightOverflowX: getComputedStyle(right).overflowX,
      overflowers: [...document.querySelectorAll("#blueprintDesignerScreen *")].map((element) => {
        const rect = element.getBoundingClientRect();
        return { id: element.id, className: String(element.className || ""), left: rect.left, right: rect.right, width: rect.width };
      }).filter(item => item.left < -1 || item.right > window.innerWidth + 1).slice(0, 8)
    };
  });

  if (before.overlayScrollWidth > before.overlayClientWidth + 1) throw new Error(`mobile overlay has horizontal overflow: ${before.overlayScrollWidth}/${before.overlayClientWidth} ${JSON.stringify(before.overflowers)}`);
  if (Math.abs(before.panelLeft) > 2 || Math.abs(before.panelRight - before.overlayClientWidth) > 2) throw new Error(`panel does not fit viewport: ${before.panelLeft}..${before.panelRight}`);
  if (before.headerPosition !== "sticky") throw new Error(`header is not sticky: ${before.headerPosition}`);
  if (before.tabs.left < 0 || before.tabs.right > before.overlayClientWidth) throw new Error("inspector tabs do not fit viewport");

  const after = await page.evaluate(async () => {
    const overlay = document.getElementById("blueprintDesignerScreen");
    const inspector = await import("/src/ui/designerInspectorUi.js");
    inspector.activateDesignerInspectorTab("blueprints");
    const right = document.querySelector(".designer-right-col").getBoundingClientRect();
    const saved = [...document.querySelectorAll(".designer-right-col h2")].find((h) => h.textContent.includes("Saved Blueprints")).getBoundingClientRect();
    const loadouts = [...document.querySelectorAll(".designer-right-col h2")].find((h) => h.textContent.includes("Loadouts")).getBoundingClientRect();
    const activePanel = document.getElementById("designerBlueprintsPanel");
    const activePanelScrollable = activePanel.scrollHeight > activePanel.clientHeight;
    const closeButton = document.getElementById("closeBlueprintDesignerButton");
    const close = closeButton.getBoundingClientRect();
    closeButton.click();
    return {
      right,
      saved,
      loadouts,
      close,
      activePanelScrollable,
      closed: overlay.hidden,
      viewportWidth: window.innerWidth
    };
  });

  if (after.right.left < -2 || after.right.right > after.viewportWidth + 2) throw new Error("right designer column is not fully visible");
  if (after.saved.left < 0 || after.saved.right > after.viewportWidth) throw new Error("Saved Blueprints heading is not reachable");
  if (after.loadouts.left < 0 || after.loadouts.right > after.viewportWidth) throw new Error("Loadouts heading is not reachable");
  if (after.close.left < 0 || after.close.right > after.viewportWidth) throw new Error("Close button is not reachable");
  if (!after.closed) throw new Error("Close button did not close the designer");

  return { before, after };
}

async function inspectDesktop(page) {
  await dismissMenus(page);
  await page.click("#openBlueprintDesignerButton");
  const result = await page.evaluate(() => {
    const overlay = document.getElementById("blueprintDesignerScreen");
    const panel = document.querySelector(".blueprint-designer-panel");
    const rect = panel.getBoundingClientRect();
    const cols = [".designer-left-col", ".designer-center-col", ".designer-right-col"].map((selector) => document.querySelector(selector).getBoundingClientRect());
    return {
      centered: Math.abs(rect.left - (window.innerWidth - rect.width) / 2) <= 2,
      overflowX: getComputedStyle(overlay).overflowX,
      hasHorizontalScroll: overlay.scrollWidth > overlay.clientWidth + 1,
      colsVisible: cols.every((col) => col.left >= 0 && col.right <= window.innerWidth),
      width: rect.width
    };
  });
  if (!result.centered) throw new Error("desktop panel is not centered");
  if (result.hasHorizontalScroll) throw new Error("desktop has unnecessary overlay horizontal scroll");
  if (!result.colsVisible) throw new Error("desktop columns are not all visible");
  if (result.width < 1180) throw new Error("desktop panel width regressed");
  return result;
}

(async () => {
  const server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  try {
    await waitForServer();
    const browser = await launchChromium(chromium);
    try {
      for (const viewport of [{ width: 360, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
        const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true });
        await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
        await inspectMobile(page);
        await page.close();
        console.log(`Blueprint mobile scroll passed at ${viewport.width}x${viewport.height}`);
      }
      const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await desktop.goto(`${BASE}/index.html`, { waitUntil: "load" });
      await inspectDesktop(desktop);
      await desktop.close();
      console.log("Blueprint desktop layout passed at 1440x900");
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
