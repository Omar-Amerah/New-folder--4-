#!/usr/bin/env node
"use strict";

// The blueprint designer is a local editor over localStorage blueprints, so it
// needs no match to be useful. This drives a real browser through create-room ->
// design -> ready to prove a player can build while the room is still in Lobby,
// and that the work survives the host starting the design phase.

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
const artifactDir = path.join("test-artifacts", "lobby-designer-browser");
const { server } = startServer(port);
let browser;

async function shot(page, name) {
  await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
}

// An edited blueprint raises the unsaved-changes prompt on close. "Continue
// Anyway" resolves it whatever the blueprint's validity, so the close path is
// deterministic regardless of what the test just drew.
async function closeDesigner(page) {
  await page.click("#closeBlueprintDesignerButton");
  // requestCloseBlueprintDesigner is async (it dynamic-imports the editor state),
  // so the prompt lands a tick or two after the click.
  await page.waitForFunction(() => {
    const designer = document.getElementById("blueprintDesignerScreen");
    const modal = document.getElementById("confirmModal");
    return designer?.hidden === true || modal?.hidden === false;
  }, null, { timeout: 5000 });
  if (await page.locator("#confirmModal").isVisible().catch(() => false)) {
    await page.click("#confirmDiscardButton");
  }
  await page.waitForSelector("#blueprintDesignerScreen", { state: "hidden", timeout: 5000 });
}

async function run() {
  mkdirSync(artifactDir, { recursive: true });
  await waitForServer(base);
  browser = await launchChromium(chromium);
  const page = await browser.newPage();
  page.on("pageerror", (error) => { throw error; });

  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);

  // Create a room. The host lands in the Lobby phase with the lobby panel open.
  await page.fill("#pilotName", "Designer");
  await page.click("#createButton");
  await page.waitForFunction(async () => {
    const { state } = await import("/src/state.js");
    return state.phase === "lobby" && Boolean(state.room);
  }, null, { timeout: 15000 });
  await shot(page, "01-lobby");

  // 1. The lobby panel offers a way into the designer, and it is usable.
  const lobbyButton = page.locator("#lobbyOpenDesignerButton");
  assert.equal(await lobbyButton.isVisible(), true,
    "the lobby panel should offer a route into the designer");
  assert.equal(await lobbyButton.isDisabled(), false,
    "the lobby designer button should be enabled during the lobby phase");

  // 2. It opens the designer, and replaces the lobby panel rather than stacking
  //    under it -- every menu screen shares one z-index.
  await lobbyButton.click();
  await page.waitForSelector("#blueprintDesignerScreen:not([hidden])", { timeout: 5000 });
  assert.equal(await page.locator("#lobbyManagementScreen").isVisible(), false,
    "opening the designer from the lobby should replace the lobby panel");
  await shot(page, "02-designer-open-in-lobby");

  // 3. The designer is genuinely functional with no match running: the palette
  //    and build grid render, and blueprint analysis (cost/stats/validation)
  //    computes against the current design.
  const editor = await page.evaluate(async () => {
    const [{ state }, { analyseBlueprintOnce }] = await Promise.all([
      import("/src/state.js"),
      import("/src/design/blueprintAnalysisCache.js")
    ]);
    const analysis = analyseBlueprintOnce({
      blueprint: state.design,
      wiring: state.wiring,
      combatStyle: state.combatStyle || "hold"
    });
    return {
      paletteParts: document.querySelectorAll("#partPalette .part-button").length,
      gridCells: document.querySelectorAll("#buildGrid .build-cell").length,
      occupiedCells: document.querySelectorAll("#buildGrid .build-cell.occupied").length,
      designParts: state.design.length,
      validationOk: analysis.validation.ok,
      unitCost: analysis.stats.unitCost
    };
  });
  assert.ok(editor.paletteParts > 0, "the part palette should render in the lobby");
  assert.ok(editor.gridCells > 0, "the build grid should render in the lobby");
  assert.ok(editor.occupiedCells > 0,
    "the current blueprint should be drawn onto the grid in the lobby");
  assert.equal(editor.validationOk, true,
    "blueprint validation should run against the starting design in the lobby");
  assert.ok(editor.unitCost > 0, "blueprint costing should compute in the lobby");

  // 4. Saving a blueprint works with no match in progress -- the saved library
  //    is local storage, not match state.
  const savedCount = await page.evaluate(async () => {
    const [{ state }, { saveCurrentDesignAsCopy }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/savedBlueprintsUi.js")
    ]);
    const before = state.savedDesigns.length;
    const ok = await saveCurrentDesignAsCopy({ skipWiringWarning: true });
    return { before, after: state.savedDesigns.length, ok };
  });
  assert.equal(savedCount.ok, true, "saving a blueprint from the lobby should succeed");
  assert.equal(savedCount.after, savedCount.before + 1,
    "the blueprint saved in the lobby should land in the saved library");

  // 5. Edits made in the lobby are held in the live design.
  const placed = await page.evaluate(async () => {
    const [{ state }, { renderBuildGrid }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerUi.js")
    ]);
    const before = state.design.length;
    state.design = [...state.design, { x: 9, y: 7, type: "armor" }];
    renderBuildGrid();
    return { before, after: state.design.length };
  });
  assert.equal(placed.after, placed.before + 1,
    "editing the blueprint in the lobby should update the live design");

  // 6. Closing returns to the lobby panel the player came from. An edited
  //    blueprint raises the unsaved-changes prompt first; saving from the lobby
  //    must work with no match in progress.
  await closeDesigner(page);
  await page.waitForSelector("#lobbyManagementScreen:not([hidden])", { timeout: 5000 });
  assert.equal(await page.locator("#blueprintDesignerScreen").isVisible(), false,
    "closing the designer should hide it");
  await shot(page, "03-back-to-lobby");

  // 7. Starting the design phase must not slam the designer shut on a player who
  //    is mid-build -- that is the same task the phase is asking them to do.
  await lobbyButton.click();
  await page.waitForSelector("#blueprintDesignerScreen:not([hidden])", { timeout: 5000 });
  // The lobby panel is behind the designer, so drive the phase change the way a
  // remote host would: the player is building when the phase moves under them.
  await page.evaluate(async () => {
    const { startDesign } = await import("/src/ui/lobbyUi.js");
    startDesign();
  });
  await page.waitForFunction(async () => {
    const { state } = await import("/src/state.js");
    return state.phase === "design";
  }, null, { timeout: 15000 });
  assert.equal(await page.locator("#blueprintDesignerScreen").isVisible(), true,
    "the designer should stay open across the lobby -> design transition");
  await shot(page, "04-designer-survives-phase-change");

  // 8. The side-panel entry point is enabled too, and the design still readies.
  const designLength = await page.evaluate(async () => {
    const { state } = await import("/src/state.js");
    return state.design.length;
  });
  assert.equal(designLength, placed.after,
    "the blueprint built in the lobby should carry into the design phase");

  await closeDesigner(page);
  await page.waitForTimeout(300);
  assert.equal(await page.locator("#openBlueprintDesignerButton").isDisabled(), false,
    "the side-panel designer button should be enabled in the design phase");
  await shot(page, "05-design-phase");

  console.log("Lobby designer verification passed");
  console.log(`  screenshots: ${artifactDir}`);
}

run()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await browser?.close?.();
    server.kill();
  });
