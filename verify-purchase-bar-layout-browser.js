#!/usr/bin/env node
"use strict";
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, waitForBrowserReady, uniquePort, uniqueRoom, PAGE_HELPERS, DISMISS_MENUS, design } = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const room = uniqueRoom("purchase");
const { server } = startServer(port);
let browser;

const DESKTOP_W = 1440;
const DESKTOP_H = 900;
const MEDIUM_W = 900;
const MEDIUM_H = 800;
const MOBILE_W = 400;
const MOBILE_H = 700;

// A minimal valid design: reactor + engine + weapon
const TEST_DESIGN = design([0, 0, "reactor"], [1, 0, "engine"], [-1, 0, "blaster"]);

// Many saved designs to force horizontal scrolling in the purchase bar
function makeManyDesigns(count) {
  const designs = [];
  for (let i = 0; i < count; i++) {
    designs.push({
      id: `saved-${i}`,
      name: `Ship ${i + 1}`,
      blueprint: TEST_DESIGN.map((p) => ({ ...p })),
      wiring: { power: { sections: [] } },
      combatStyle: "hold",
      updatedAt: Date.now()
    });
  }
  return designs;
}

(async () => {
  const pageErrors = [];
  const consoleErrors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);

    // ---- Desktop layout: purchase bar contained inside arena, no overlap with panels ----
    {
      const page = await browser.newPage({ viewport: { width: DESKTOP_W, height: DESKTOP_H } });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });

      await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
      await waitForBrowserReady(page, room, {}, 20_000);
      await page.addScriptTag({ content: PAGE_HELPERS });
      await page.evaluate(DISMISS_MENUS);

      // Inject many saved designs so the purchase bar has many cards
      await page.evaluate((designs) => {
        const state = window.__mfaState;
        state.savedDesigns = designs;
        state.phase = "active";
        state.mine = { ready: true, money: 99999, activeShips: 0, shipCap: 20, team: "blue", income: 50 };
        state.design = designs[0].blueprint;
        state.wiring = designs[0].wiring;
      }, makeManyDesigns(15));

      // Re-render the purchase bar by calling the module function
      await page.evaluate(async () => {
        const mod = await import("/src/ui/purchaseUi.js");
        mod.updateEconomyUi();
      });

      // Wait for purchase options to render
      await page.waitForSelector("#purchaseOptions .purchase-option", { timeout: 5000 });

      const desktopLayout = await page.evaluate(() => {
        const bar = document.getElementById("purchaseBar");
        const arena = document.querySelector(".arena-wrap");
        const matchPanel = document.querySelector(".match-panel");
        const sidePanel = document.querySelector(".side-panel");
        const options = document.getElementById("purchaseOptions");
        const firstCard = options?.querySelector(".purchase-option");
        const lastCard = options?.lastElementChild;

        const barRect = bar.getBoundingClientRect();
        const arenaRect = arena.getBoundingClientRect();
        const matchRect = matchPanel.getBoundingClientRect();
        const sideRect = sidePanel.getBoundingClientRect();
        const firstCardRect = firstCard?.getBoundingClientRect();
        const lastCardRect = lastCard?.getBoundingClientRect();

        const barStyle = window.getComputedStyle(bar);
        const optionsStyle = window.getComputedStyle(options);

        return {
          barLeft: barRect.left,
          barRight: barRect.right,
          barWidth: barRect.width,
          arenaLeft: arenaRect.left,
          arenaRight: arenaRect.right,
          arenaWidth: arenaRect.width,
          matchLeft: matchRect.left,
          matchRight: matchRect.right,
          sideRight: sideRect.right,
          barPosition: barStyle.position,
          barBoxSizing: barStyle.boxSizing,
          barMinWidth: barStyle.minWidth,
          barMaxWidth: barStyle.maxWidth,
          barZoom: barStyle.zoom,
          optionsOverflowX: optionsStyle.overflowX,
          optionsOverflowY: optionsStyle.overflowY,
          optionsScrollWidth: options.scrollWidth,
          optionsClientWidth: options.clientWidth,
          cardCount: options.children.length,
          firstCardLeft: firstCardRect?.left,
          lastCardRight: lastCardRect?.right,
          barParentId: bar.parentElement?.id || bar.parentElement?.className || null
        };
      });

      // The purchase bar must be inside .arena-wrap
      assert.ok(desktopLayout.barParentId.includes("arena-wrap"),
        `purchase bar is inside .arena-wrap (parent: ${desktopLayout.barParentId})`);

      // The purchase bar must not extend past the arena's right edge
      assert.ok(desktopLayout.barRight <= desktopLayout.arenaRight + 1,
        `purchase bar right (${desktopLayout.barRight}) must not exceed arena right (${desktopLayout.arenaRight})`);

      // The purchase bar must not extend past the arena's left edge
      assert.ok(desktopLayout.barLeft >= desktopLayout.arenaLeft - 1,
        `purchase bar left (${desktopLayout.barLeft}) must not be before arena left (${desktopLayout.arenaLeft})`);

      // The purchase bar must not overlap the match panel
      assert.ok(desktopLayout.barRight <= desktopLayout.matchLeft + 1,
        `purchase bar right (${desktopLayout.barRight}) must not overlap match panel left (${desktopLayout.matchLeft})`);

      // The purchase bar must not overlap the side panel
      assert.ok(desktopLayout.barLeft >= desktopLayout.sideRight - 1,
        `purchase bar left (${desktopLayout.barLeft}) must not overlap side panel right (${desktopLayout.sideRight})`);

      // CSS properties
      assert.equal(desktopLayout.barPosition, "absolute", "purchase bar uses position: absolute");
      assert.equal(desktopLayout.barBoxSizing, "border-box", "purchase bar uses box-sizing: border-box");
      assert.equal(desktopLayout.barMinWidth, "0px", "purchase bar has min-width: 0");
      assert.equal(desktopLayout.barZoom, "1", "purchase bar does not have CSS zoom applied");

      // Overflow on options
      assert.equal(desktopLayout.optionsOverflowX, "auto", "purchase options has overflow-x: auto");
      assert.equal(desktopLayout.optionsOverflowY, "hidden", "purchase options has overflow-y: hidden");

      // Many cards should cause horizontal scrolling
      assert.ok(desktopLayout.cardCount > 10, `many cards rendered (${desktopLayout.cardCount})`);
      assert.ok(desktopLayout.optionsScrollWidth > desktopLayout.optionsClientWidth,
        `options scrollWidth (${desktopLayout.optionsScrollWidth}) > clientWidth (${desktopLayout.optionsClientWidth}) — horizontal scroll exists`);

      // The last card should be reachable by scrolling
      const scrollResult = await page.evaluate(() => {
        const options = document.getElementById("purchaseOptions");
        const lastCard = options.lastElementChild;
        options.scrollLeft = options.scrollWidth;
        const optsRect = options.getBoundingClientRect();
        const cardRect = lastCard.getBoundingClientRect();
        return {
          scrolledLeft: options.scrollLeft,
          maxScroll: options.scrollWidth - options.clientWidth,
          lastCardVisible: cardRect.right <= optsRect.right + 1 && cardRect.left >= optsRect.left - 1
        };
      });
      assert.ok(scrollResult.lastCardVisible,
        `last card is visible after scrolling (scrollLeft=${scrollResult.scrolledLeft}, maxScroll=${scrollResult.maxScroll})`);

      await page.close();
      console.log("Desktop purchase bar layout verification passed");
    }

    // ---- Browser zoom levels: 100%, 110%, 125% ----
    for (const zoomLevel of [1.0, 1.1, 1.25]) {
      const page = await browser.newPage({ viewport: { width: DESKTOP_W, height: DESKTOP_H } });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
      await waitForBrowserReady(page, room, {}, 20_000);
      await page.addScriptTag({ content: PAGE_HELPERS });
      await page.evaluate(DISMISS_MENUS);

      await page.evaluate((designs) => {
        const state = window.__mfaState;
        state.savedDesigns = designs;
        state.phase = "active";
        state.mine = { ready: true, money: 99999, activeShips: 0, shipCap: 20, team: "blue", income: 50 };
        state.design = designs[0].blueprint;
        state.wiring = designs[0].wiring;
      }, makeManyDesigns(12));

      await page.evaluate(async () => {
        const mod = await import("/src/ui/purchaseUi.js");
        mod.updateEconomyUi();
      });

      await page.waitForSelector("#purchaseOptions .purchase-option", { timeout: 5000 });

      // Set browser zoom via CDP
      const client = await page.context().newCDPSession(page);
      await client.send("Emulation.setPageScaleFactor", { pageScaleFactor: zoomLevel });

      await page.waitForTimeout(200);

      const zoomLayout = await page.evaluate(() => {
        const bar = document.getElementById("purchaseBar");
        const arena = document.querySelector(".arena-wrap");
        const matchPanel = document.querySelector(".match-panel");
        const barRect = bar.getBoundingClientRect();
        const arenaRect = arena.getBoundingClientRect();
        const matchRect = matchPanel.getBoundingClientRect();
        return {
          barRight: barRect.right,
          arenaRight: arenaRect.right,
          matchLeft: matchRect.left,
          barLeft: barRect.left,
          arenaLeft: arenaRect.left
        };
      });

      assert.ok(zoomLayout.barRight <= zoomLayout.arenaRight + 2,
        `zoom ${zoomLevel}: bar right (${zoomLayout.barRight}) <= arena right (${zoomLayout.arenaRight})`);
      assert.ok(zoomLayout.barRight <= zoomLayout.matchLeft + 2,
        `zoom ${zoomLevel}: bar right (${zoomLayout.barRight}) <= match panel left (${zoomLayout.matchLeft})`);
      assert.ok(zoomLayout.barLeft >= zoomLayout.arenaLeft - 2,
        `zoom ${zoomLevel}: bar left (${zoomLayout.barLeft}) >= arena left (${zoomLayout.arenaLeft})`);

      await page.close();
      console.log(`Browser zoom ${zoomLevel * 100}% purchase bar layout verification passed`);
    }

    // ---- Medium screen: match panel is overlay, purchase bar still contained ----
    {
      const page = await browser.newPage({ viewport: { width: MEDIUM_W, height: MEDIUM_H } });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
      await waitForBrowserReady(page, room, {}, 20_000);
      await page.addScriptTag({ content: PAGE_HELPERS });
      await page.evaluate(DISMISS_MENUS);

      await page.evaluate((designs) => {
        const state = window.__mfaState;
        state.savedDesigns = designs;
        state.phase = "active";
        state.mine = { ready: true, money: 99999, activeShips: 0, shipCap: 20, team: "blue", income: 50 };
        state.design = designs[0].blueprint;
        state.wiring = designs[0].wiring;
      }, makeManyDesigns(10));

      await page.evaluate(async () => {
        const mod = await import("/src/ui/purchaseUi.js");
        mod.updateEconomyUi();
      });

      await page.waitForSelector("#purchaseOptions .purchase-option", { timeout: 5000 });

      const mediumLayout = await page.evaluate(() => {
        const bar = document.getElementById("purchaseBar");
        const arena = document.querySelector(".arena-wrap");
        const barRect = bar.getBoundingClientRect();
        const arenaRect = arena.getBoundingClientRect();
        return {
          barRight: barRect.right,
          arenaRight: arenaRect.right,
          barLeft: barRect.left,
          arenaLeft: arenaRect.left,
          barWidth: barRect.width
        };
      });

      assert.ok(mediumLayout.barRight <= mediumLayout.arenaRight + 1,
        `medium: bar right (${mediumLayout.barRight}) <= arena right (${mediumLayout.arenaRight})`);
      assert.ok(mediumLayout.barLeft >= mediumLayout.arenaLeft - 1,
        `medium: bar left (${mediumLayout.barLeft}) >= arena left (${mediumLayout.arenaLeft})`);

      await page.close();
      console.log("Medium screen purchase bar layout verification passed");
    }

    // ---- Mobile screen: stacked layout with vertical scrolling ----
    {
      const page = await browser.newPage({ viewport: { width: MOBILE_W, height: MOBILE_H } });
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
      await waitForBrowserReady(page, room, {}, 20_000);
      await page.addScriptTag({ content: PAGE_HELPERS });
      await page.evaluate(DISMISS_MENUS);

      await page.evaluate((designs) => {
        const state = window.__mfaState;
        state.savedDesigns = designs;
        state.phase = "active";
        state.mine = { ready: true, money: 99999, activeShips: 0, shipCap: 20, team: "blue", income: 50 };
        state.design = designs[0].blueprint;
        state.wiring = designs[0].wiring;
      }, makeManyDesigns(8));

      await page.evaluate(async () => {
        const mod = await import("/src/ui/purchaseUi.js");
        mod.updateEconomyUi();
      });

      await page.waitForSelector("#purchaseOptions .purchase-option", { timeout: 5000 });

      const mobileLayout = await page.evaluate(() => {
        const bar = document.getElementById("purchaseBar");
        const arena = document.querySelector(".arena-wrap");
        const barRect = bar.getBoundingClientRect();
        const arenaRect = arena.getBoundingClientRect();
        const barStyle = window.getComputedStyle(bar);
        return {
          barRight: barRect.right,
          arenaRight: arenaRect.right,
          barLeft: barRect.left,
          arenaLeft: arenaRect.left,
          gridTemplateColumns: barStyle.gridTemplateColumns,
          overflow: barStyle.overflow,
          maxHeight: barStyle.maxHeight
        };
      });

      assert.ok(mobileLayout.barRight <= mobileLayout.arenaRight + 1,
        `mobile: bar right (${mobileLayout.barRight}) <= arena right (${mobileLayout.arenaRight})`);
      assert.ok(mobileLayout.barLeft >= mobileLayout.arenaLeft - 1,
        `mobile: bar left (${mobileLayout.barLeft}) >= arena left (${mobileLayout.arenaLeft})`);
      // Mobile should use single-column grid (computed value resolves 1fr to a pixel value)
      const colCount = mobileLayout.gridTemplateColumns.split(/\s+/).filter(Boolean).length;
      assert.equal(colCount, 1,
        `mobile: grid is single column (${mobileLayout.gridTemplateColumns})`);

      await page.close();
      console.log("Mobile screen purchase bar layout verification passed");
    }

    // ---- Error check ----
    assert.equal(pageErrors.length, 0, `no page errors during tests: ${pageErrors.join("\n")}`);
    console.log("All purchase bar layout browser tests passed");
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
})().catch((err) => {
  console.error(err);
  server.kill();
  process.exit(1);
});
