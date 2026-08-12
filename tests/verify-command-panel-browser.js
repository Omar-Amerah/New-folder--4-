#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdirSync } = require("node:fs");
const { chromium } = require("playwright");
const {
  launchChromium,
  startServer,
  waitForServer,
  uniquePort
} = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const artifactDir = path.join("test-artifacts", "command-panel-browser");
const { server } = startServer(port);
let browser;

async function setup(page) {
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);
  return page.evaluate(async () => {
    const [{ state }, { renderSideControls }, { updateEconomyUi }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/sidePanelUi.js"),
      import("/src/ui/purchaseUi.js")
    ]);
    for (const id of ["mainMenuScreen", "lobbyManagementScreen", "settingsScreen", "lobbyScreen", "blueprintDesignerScreen"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    state.myId = "panel-test";
    state.phase = "design";
    state.mine = {
      id: "panel-test",
      team: "blue",
      money: 1000,
      income: 0,
      ready: false,
      activeShips: 3,
      shipCap: 30
    };
    state.rules = { ...state.rules, shipCap: 30 };
    state.snapshot = {
      players: [{ id: "panel-test", team: "blue" }],
      ships: [
        { id: "s1", ownerId: "panel-test", alive: true, x: 0, y: 0, combatStyle: "charge" },
        { id: "s2", ownerId: "panel-test", alive: true, x: 20, y: 0, combatStyle: "charge" },
        { id: "s3", ownerId: "panel-test", alive: true, x: 40, y: 0, combatStyle: "hold" }
      ],
      points: []
    };
    state.selectedShipIds = new Set(["s1"]);
    state.snapshotIndex = {
      ownLivingShips: state.snapshot.ships,
      selectedLivingShips: [state.snapshot.ships[0]],
      shipById: new Map(state.snapshot.ships.map((ship) => [ship.id, ship]))
    };
    state.activeShipGroup = "group1";
    state.shipGroups = {
      group1: new Set(["s1"]),
      group2: new Set(),
      group3: new Set(),
      group4: new Set(),
      group5: new Set()
    };
    renderSideControls();
    updateEconomyUi();
    return true;
  });
}

async function panelGeometry(page) {
  return page.evaluate(() => {
    const panel = document.querySelector(".side-panel");
    const rows = [...document.querySelectorAll(".ship-group-main")];
    const actions = [...document.querySelectorAll(".ship-group-action")];
    return {
      panelWidth: panel.getBoundingClientRect().width,
      overflow: panel.scrollWidth - panel.clientWidth,
      rowsOverflow: rows.map((row) => row.scrollWidth - row.clientWidth),
      alignedActions: actions.every((action) => {
        const main = action.closest(".ship-group-main");
        const a = action.getBoundingClientRect();
        const m = main.getBoundingClientRect();
        return Math.abs(a.top - m.top) <= 1 && Math.abs(a.bottom - m.bottom) <= 1;
      })
    };
  });
}

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(() => {
      globalThis.requestAnimationFrame = () => 0;
      globalThis.cancelAnimationFrame = () => {};
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await setup(page);

    assert.equal(await page.locator(".control-group h2").textContent(), "Deployment");
    assert.equal(await page.locator(".deploy-action-label").textContent(), "Ready Up");
    assert.equal(await page.locator(".deploy-cost").count(), 0, "Ready Up does not present purchase validation or cost");
    assert.equal(await page.locator("#openBlueprintDesignerButton").textContent(), "Open Blueprint Designer");
    assert.equal(await page.locator("#shipGroupTotal").textContent(), "1 / 30 assigned");

    assert.equal(await page.locator(".ship-group-row").count(), 6, "five groups plus Unassigned");
    assert.equal(await page.locator(".ship-group-main").count(), 6, "each group uses one unified row");
    assert.equal(await page.locator(".ship-group-row > .ship-group-action").count(), 0, "actions are not detached from rows");
    assert.equal(await page.locator(".ship-group-assign").first().textContent(), "+ Add");
    assert.equal(await page.locator(".ship-group-view").textContent(), "View");
    assert.equal(await page.locator(".ship-group-view").getAttribute("data-assign-ship-group"), null);
    assert.equal(await page.locator('[data-ship-group="group1"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator('[data-ship-group="group1"] .ship-group-count').textContent(), "1 ship");
    assert.equal(await page.locator('[data-ship-group="group2"] .ship-group-count').textContent(), "0 ships");
    assert.equal(await page.locator(".ship-group-row").nth(0).evaluate((row) => row.classList.contains("is-selected") && row.classList.contains("has-ships")), true, "selected populated state is explicit");
    assert.equal(await page.locator(".ship-group-row").nth(1).evaluate((row) => row.classList.contains("is-empty")), true, "empty state is explicit");
    const selectedGroupVisual = await page.locator(".ship-group-row").nth(0).evaluate((row) => {
      const name = row.querySelector(".ship-group-name");
      return {
        backgroundColor: getComputedStyle(row).backgroundColor,
        boxShadow: getComputedStyle(row).boxShadow,
        markerContent: getComputedStyle(name, "::before").content
      };
    });
    assert.equal(selectedGroupVisual.boxShadow, "none", "selected groups have no left accent stripe");
    assert.equal(selectedGroupVisual.markerContent, "none", "selected groups have no tick marker");

    const styles = await page.evaluate(() => {
      const primary = getComputedStyle(document.getElementById("deployButton"));
      const secondary = getComputedStyle(document.getElementById("openBlueprintDesignerButton"));
      const status = document.getElementById("connectionStatus");
      status.className = "connection-status online";
      const online = getComputedStyle(status);
      return {
        primaryHeight: parseFloat(primary.height),
        secondaryHeight: parseFloat(secondary.height),
        primaryShadow: primary.boxShadow,
        secondaryShadow: secondary.boxShadow,
        statusRadius: parseFloat(online.borderRadius),
        statusHeight: status.getBoundingClientRect().height
      };
    });
    assert.notEqual(styles.primaryShadow, "none", "Ready remains the clear primary action through its primary treatment");
    assert.equal(styles.secondaryShadow, "none", "secondary action has no bloom");
    assert(styles.statusRadius <= 5 && styles.statusHeight < 24, "room status is a compact chip");

    await page.locator('[data-assign-ship-group="group2"]').click();
    const assigned = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      return {
        group1: [...state.shipGroups.group1],
        group2: [...state.shipGroups.group2],
        active: state.activeShipGroup,
        selected: [...state.selectedShipIds]
      };
    });
    assert.deepEqual(assigned.group1, [], "existing one-group assignment behavior is preserved");
    assert.deepEqual(assigned.group2, ["s1"], "Add assigns the selected ship");
    assert.equal(assigned.active, "group2");
    assert.deepEqual(assigned.selected, ["s1"]);

    await page.locator('[data-ship-group="unassigned"]').first().focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("ship-group-view")), true, "View remains keyboard reachable");
    const focusStyle = await page.locator(".ship-group-view").evaluate((el) => {
      const style = getComputedStyle(el);
      return { outlineStyle: style.outlineStyle, outlineWidth: parseFloat(style.outlineWidth) };
    });
    assert(focusStyle.outlineStyle !== "none" && focusStyle.outlineWidth > 0, "keyboard focus remains visible");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(async () => (await import("/src/state.js")).state.activeShipGroup), "unassigned");
    await page.waitForTimeout(150);
    const selectedUnassignedColor = await page.locator(".ship-group-row.is-unassigned").evaluate((row) => getComputedStyle(row).backgroundColor);
    assert.notEqual(selectedUnassignedColor, selectedGroupVisual.backgroundColor, "selected Unassigned uses its own color");

    mkdirSync(artifactDir, { recursive: true });
    for (const [width, height] of [[1920, 1080], [1280, 720], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const geometry = await panelGeometry(page);
      assert(geometry.panelWidth > 0, `${width}x${height}: panel remains visible`);
      assert(geometry.overflow <= 1, `${width}x${height}: panel has no horizontal overflow`);
      assert(geometry.rowsOverflow.every((overflow) => overflow <= 1), `${width}x${height}: group rows do not clip`);
      assert(geometry.alignedActions, `${width}x${height}: actions stay integrated into their row`);
      await page.locator(".side-panel").screenshot({ path: path.join(artifactDir, `panel-${width}x${height}.png`) });
    }

    assert.deepEqual(errors, [], `no page errors: ${errors.join("; ")}`);
    console.log("verify-command-panel-browser passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})();
