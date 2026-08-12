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

  // Refreshing replaces the browser socket and rejoins the existing lobby slot.
  // The room-scoped, tab-scoped screen intent should put the player back in the
  // Blueprint Designer instead of dropping them onto Lobby Management.
  const beforeRefresh = await page.evaluate(async () => {
    const { state } = await import("/src/state.js");
    return { room: state.room, playerId: state.myId };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(({ room, playerId }) => {
    const state = window.__mfaState;
    return window.__mfaMainLoaded === true
      && state?.room === room
      && state?.myId === playerId
      && state?.phase === "lobby"
      && state?.snapshot?.players?.length === 1;
  }, beforeRefresh, { timeout: 15000 });
  await page.waitForSelector("#blueprintDesignerScreen:not([hidden])", { timeout: 5000 });
  assert.equal(await page.locator("#lobbyManagementScreen").isVisible(), false,
    "refreshing in the lobby designer should not reopen Lobby Management over it");
  await shot(page, "03-designer-restored-after-refresh");

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
      dataLinks: state.dataLinks,
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

  // Persistent blueprint validation stays in Ship Summary. The transient
  // disconnected notice belongs to the designer shell, never the grid.
  const validationNotice = await page.evaluate(async () => {
    const [{ state }, { renderBuildGrid, renderLocalStats, editCell }, { saveCurrentDesign }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/designerUi.js"),
      import("/src/ui/savedBlueprintsUi.js")
    ]);
    const original = state.design.map((part) => ({ ...part }));
    const grid = document.querySelector("#buildGridStage");
    const beforeRect = grid?.getBoundingClientRect();
    const toastCountBeforeRender = document.querySelectorAll("#toastStack .toast").length;
    state.selectedPart = "frame";
    state.previewRotation = 0;
    state.previewFlipped = false;
    state.selectedCell = null;
    editCell(14, 14);
    renderLocalStats();
    const notice = document.querySelector("#blueprintDesignerNotice");
    const summary = document.querySelector("#statsGrid");
    const beforeSaveNotice = {
      hidden: notice?.hidden,
      text: notice?.textContent || ""
    };
    const firstSaveResult = await saveCurrentDesign();
    const firstNoticeSequence = notice?.dataset.noticeSequence || "";
    const firstNotice = {
      hidden: notice?.hidden,
      text: notice?.textContent || "",
      position: notice ? getComputedStyle(notice).position : "",
      parentClass: notice?.parentElement?.className || "",
      parentId: notice?.parentElement?.id || "",
      summaryText: summary?.textContent || "",
      saveResult: firstSaveResult,
      beforeSaveNotice,
      toastCountBeforeRender,
      toastCountAfterSave: document.querySelectorAll("#toastStack .toast").length,
      firstNoticeSequence
    };
    const secondSaveResult = await saveCurrentDesign();
    const secondNoticeSequence = notice?.dataset.noticeSequence || "";

    await new Promise((resolve) => setTimeout(resolve, 4000));
    const dismissed = {
      hidden: notice?.hidden,
      text: notice?.textContent || ""
    };

    state.design = original.filter((part) => part.type === "core").map((part) => ({ ...part }));
    renderBuildGrid();
    renderLocalStats();
    const engineSaveResult = await saveCurrentDesign();
    const changedNotice = {
      hidden: notice?.hidden,
      text: notice?.textContent || "",
      sequence: notice?.dataset.noticeSequence || "",
      saveResult: engineSaveResult
    };
    const afterRect = grid?.getBoundingClientRect();
    const noticeRect = notice?.getBoundingClientRect();
    const actionsRect = document.querySelector(".designer-actions")?.getBoundingClientRect();

    state.design = original;
    state.selectedPart = null;
    renderBuildGrid();
    renderLocalStats();
    return {
      firstNotice,
      secondSaveResult,
      secondNoticeSequence,
      dismissed,
      changedNotice,
      grid: {
        beforeWidth: beforeRect?.width || 0,
        afterWidth: afterRect?.width || 0,
        beforeHeight: beforeRect?.height || 0,
        afterHeight: afterRect?.height || 0,
        actionRightDelta: noticeRect && actionsRect ? noticeRect.right - actionsRect.right : Infinity,
        actionBottomGap: noticeRect && actionsRect ? noticeRect.top - actionsRect.bottom : -Infinity
      },
      toastStackCount: document.querySelectorAll("#toastStack .toast").length,
      oldBannerCount: document.querySelectorAll("#buildStatus").length
    };
  });
  await shot(page, "02-designer-notice-position");
  await page.evaluate(async () => {
    const { resetDesignerNoticeForTests } = await import("/src/ui/designerNoticeUi.js");
    resetDesignerNoticeForTests();
  });
  assert.equal(validationNotice.firstNotice.beforeSaveNotice.hidden, true,
    "editing into a disconnected state should not show the notice");
  assert.equal(validationNotice.firstNotice.beforeSaveNotice.text, "",
    "editing should leave no save-validation notice copy behind");
  assert.equal(validationNotice.firstNotice.hidden, false,
    "an invalid save should show the designer notice");
  assert.equal(validationNotice.firstNotice.text, "1 disconnected component: Frame at (14, 14)",
    "the designer notice should use the specific single-component message");
  assert.doesNotMatch(validationNotice.firstNotice.text, /Invalid design: disconnected parts\./,
    "the old generic disconnected toast copy should not be shown");
  assert.equal(validationNotice.firstNotice.position, "absolute",
    "the designer notice should be positioned as an overlay");
  assert.match(validationNotice.firstNotice.parentClass, /designer-center-col/,
    "the notice should belong to the designer shell");
  assert.notEqual(validationNotice.firstNotice.parentId, "buildGridStage",
    "the notice should not be mounted inside the grid stage");
  assert.match(validationNotice.firstNotice.summaryText, /Frame at \(14, 14\) has no structural path to the Core/,
    "Ship Summary should retain the detailed disconnected-component validation row");
  assert.equal(validationNotice.firstNotice.toastCountAfterSave, validationNotice.firstNotice.toastCountBeforeRender,
    "the disconnected designer notice should not create the generic toast");
  assert.equal(validationNotice.firstNotice.saveResult, false,
    "an invalid blueprint should still be rejected by the save action");
  assert.equal(validationNotice.secondSaveResult, false,
    "a repeated invalid save should remain rejected");
  assert.equal(validationNotice.secondNoticeSequence, validationNotice.firstNotice.firstNoticeSequence,
    "repeated invalid saves should not spam the same notice");
  assert.equal(validationNotice.dismissed.hidden, true,
    "the transient designer notice should auto-dismiss");
  assert.equal(validationNotice.dismissed.text, "",
    "auto-dismiss should clear the transient notice copy");
  assert.equal(validationNotice.changedNotice.text, "Invalid design: add at least one engine.",
    "the same notice should present non-connectivity save errors");
  assert.equal(validationNotice.changedNotice.saveResult, false,
    "a design without an engine should be rejected on save");
  assert.ok(Number(validationNotice.changedNotice.sequence) > Number(validationNotice.firstNotice.firstNoticeSequence),
    "a changed save validation error should re-trigger the notice");
  assert.ok(Math.abs(validationNotice.grid.actionRightDelta) <= 1,
    `the designer notice should align with the right edge of the Undo / Reset / Clear controls (delta=${validationNotice.grid.actionRightDelta})`);
  assert.ok(validationNotice.grid.actionBottomGap >= 5 && validationNotice.grid.actionBottomGap <= 7,
    `the designer notice should sit directly below the Undo / Reset / Clear controls (gap=${validationNotice.grid.actionBottomGap})`);
  assert.ok(Math.abs(validationNotice.grid.beforeWidth - validationNotice.grid.afterWidth) < 1,
    "showing the notice should not change grid width");
  assert.ok(Math.abs(validationNotice.grid.beforeHeight - validationNotice.grid.afterHeight) < 1,
    "showing the notice should not change grid height");
  assert.equal(validationNotice.toastStackCount, 0,
    "invalid saves should use the designer notice instead of the global toast stack");
  assert.equal(validationNotice.oldBannerCount, 0,
    "the old in-flow build status banner should be gone");

  // 4. Saving a blueprint works with no match in progress -- the saved library
  //    is local storage, not match state.
  const savedCount = await page.evaluate(async () => {
    const [{ state }, { saveCurrentDesignAsCopy }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/savedBlueprintsUi.js")
    ]);
    const before = state.savedDesigns.length;
    const ok = await saveCurrentDesignAsCopy();
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
  await shot(page, "04-back-to-lobby");
  assert.equal(await page.evaluate(() => sessionStorage.getItem("modular-fleet-blueprint-screen-room-v1")), null,
    "closing the designer should clear its refresh-restoration intent");

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
  await shot(page, "05-designer-survives-phase-change");

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
  await shot(page, "06-design-phase");

  console.log("Lobby designer verification passed");
  console.log(`  screenshots: ${artifactDir}`);
}

run()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    await browser?.close?.();
    server.kill();
  });
