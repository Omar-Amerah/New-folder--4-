#!/usr/bin/env node
"use strict";

// The engagement-order rows in the selection panel.
//
// These are standing orders whose effects only show up in narrow situations --
// autoEngage when nobody ordered the target, pursue only after the ship has
// already established its firing position -- so the panel has to say what it is
// doing. A control that explains nothing and never confirms anything reads as
// broken even while the behaviour behind it works, which is exactly what the
// two bare checkboxes here used to be.
//
// What is checked: the explanation is on the page rather than hidden in a
// tooltip, the whole row is the click target, and the readout distinguishes
// On / Off / Mixed, flips straight to the new value, and puts a rejected
// change back.

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
const artifactDir = path.join("test-artifacts", "movement-toggles-browser");
const { server } = startServer(port);
let browser;

// A live match with three of the player's own ships, a socket that records what
// the panel sends instead of a real connection, and no selection yet.
async function setup(page) {
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);
  await page.evaluate(async () => {
    const [{ state }, { renderSideControls }, { buildSnapshotIndex }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/sidePanelUi.js"),
      import("/src/snapshotPresentation.js")
    ]);
    // The panel reads the derived index, not the raw snapshot, so the fixture
    // has to refresh it the same way a real snapshot would.
    window.__resync = () => {
      state.snapshotIndex = buildSnapshotIndex(state.snapshot, state.myId, state.selectedShipIds);
      renderSideControls();
    };
    for (const id of ["mainMenuScreen", "lobbyManagementScreen", "settingsScreen", "lobbyScreen", "blueprintDesignerScreen"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    state.myId = "toggle-test";
    state.phase = "active";
    state.mine = { id: "toggle-test", team: "blue", money: 1000, income: 0, activeShips: 3, shipCap: 30 };
    state.snapshot = {
      players: [{ id: "toggle-test", team: "blue" }],
      ships: [
        { id: "s1", ownerId: "toggle-test", alive: true, x: 0, y: 0, combatStyle: "hold", movementToggles: { autoEngage: true, pursue: true } },
        { id: "s2", ownerId: "toggle-test", alive: true, x: 20, y: 0, combatStyle: "hold", movementToggles: { autoEngage: true, pursue: true } },
        { id: "s3", ownerId: "toggle-test", alive: true, x: 40, y: 0, combatStyle: "hold", movementToggles: { autoEngage: true, pursue: false } }
      ],
      points: []
    };
    window.__sent = [];
    state.socket = {
      readyState: WebSocket.OPEN,
      send: (frame) => window.__sent.push(globalThis.MessagePack.decode(new Uint8Array(frame)))
    };
    state.selectedShipIds = new Set(["s1", "s2"]);
    window.__resync();
  });
}

const rowState = (page, key) => page.evaluate((k) => {
  const row = document.querySelector(`[data-movement-toggle="${k}"]`);
  return {
    checked: row.getAttribute("aria-checked"),
    readout: row.querySelector("[data-movement-toggle-state]").textContent,
    pending: row.dataset.pending || null,
    disabled: row.disabled
  };
}, key);

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

    // --- The panel names itself and says what it is acting on ----------------
    assert.equal(await page.locator("#movementToggleHeading").textContent(), "Engagement Orders");
    assert.equal(await page.locator("#movementToggleScope").textContent(), "2 ships");
    assert.equal(await page.locator('[data-movement-toggle="autoEngage"] .movement-toggle-name').textContent(),
      "Automatic engagement", "the longer name is what separates it from pursuit");
    assert.equal(await page.locator('[data-movement-toggle="pursue"] .movement-toggle-name').textContent(),
      "Continue pursuit");
    assert.equal(await page.locator('[data-movement-toggle="autoTurn"] .movement-toggle-name').textContent(),
      "Turn to engage");

    // The explanation is on the page. A title attribute is not an explanation:
    // it needs a hover the player has no reason to try.
    for (const key of ["autoEngage", "pursue", "autoTurn"]) {
      const desc = page.locator(`[data-movement-toggle="${key}"] .movement-toggle-desc`);
      await desc.waitFor({ state: "visible" });
      const text = await desc.textContent();
      assert(text.trim().length > 25, `${key} carries a permanently visible description`);
      assert(text.trim().length < 90, `${key} keeps that description short enough to scan`);
    }
    // ...and it says which targets it governs, since a player-issued attack
    // order overrides autoEngage entirely.
    const autoDesc = await page.locator('[data-movement-toggle="autoEngage"] .movement-toggle-desc').textContent();
    assert(/attack order/i.test(autoDesc), "autoEngage says player-issued attack orders are unaffected");
    const pursueDesc = await page.locator('[data-movement-toggle="pursue"] .movement-toggle-desc').textContent();
    assert(/after/i.test(pursueDesc), "pursue says it only applies after the ship has engaged");

    assert.deepEqual(await rowState(page, "autoEngage"), { checked: "true", readout: "On", pending: null, disabled: false });
    assert.deepEqual(await rowState(page, "pursue"), { checked: "true", readout: "On", pending: null, disabled: false });

    // --- The whole row is the control ----------------------------------------
    // Clicking the explanation, not a 13px checkbox, is what a player will do.
    await page.locator('[data-movement-toggle="pursue"] .movement-toggle-desc').click();
    const sent = await page.evaluate(() => window.__sent);
    assert.equal(sent.length, 1, "clicking the row sends one command");
    assert.equal(sent[0].type, "setMovementToggles");
    assert.deepEqual(sent[0].toggles, { pursue: false }, "only the changed key travels");
    assert.deepEqual(sent[0].shipIds, ["s1", "s2"], "it names the selection");
    assert(sent[0].requestId, "and carries a request id to acknowledge");

    // Optimistic and final-looking: the row goes straight to its new value with
    // no intermediate "Applying…" step, which only ever read as a flicker.
    const inFlight = await rowState(page, "pursue");
    assert.equal(inFlight.checked, "false", "the row answers immediately");
    assert.equal(inFlight.readout, "Off", "...with the new value, not an in-flight state");
    assert.equal(inFlight.pending, null, "and no pending marker to flicker away");

    mkdirSync(artifactDir, { recursive: true });
    await page.locator("#movementToggleControls").screenshot({ path: path.join(artifactDir, "in-flight.png") });

    // --- Success settles it ---------------------------------------------------
    await page.evaluate(async (requestId) => {
      const { onMovementTogglesResult } = await import("/src/ui/sidePanelUi.js");
      onMovementTogglesResult({ type: "movementTogglesResult", requestId, ok: true, updatedCount: 2, toggles: { autoEngage: true, pursue: false } });
    }, sent[0].requestId);
    assert.deepEqual(await rowState(page, "pursue"), { checked: "false", readout: "Off", pending: null, disabled: false });

    // --- Rejection puts it back and says so ----------------------------------
    await page.locator('[data-movement-toggle="autoEngage"]').click();
    const rejected = await page.evaluate(() => window.__sent[window.__sent.length - 1]);
    assert.deepEqual(rejected.toggles, { autoEngage: false });
    await page.evaluate(async (requestId) => {
      const { onMovementTogglesResult } = await import("/src/ui/sidePanelUi.js");
      onMovementTogglesResult({ type: "movementTogglesResult", requestId, ok: false, code: "wrong-phase", message: "Nope." });
    }, rejected.requestId);
    const restored = await rowState(page, "autoEngage");
    assert.equal(restored.checked, "true", "a rejected change is rolled back rather than left showing as applied");
    assert.equal(restored.readout, "On");
    assert.equal(restored.pending, null);
    const toast = await page.locator(".toast, #toastHost .toast").last().textContent().catch(() => "");
    assert(/nope/i.test(toast || ""), `the failure is shown to the player (saw ${JSON.stringify(toast)})`);

    // --- A selection that disagrees says Mixed --------------------------------
    // s3 has pursue off; s1 and s2 have it on after the rollback above only for
    // autoEngage, so select across the disagreement and check the readout.
    await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      for (const ship of state.snapshot.ships) ship.movementToggles = { autoEngage: true, pursue: ship.id !== "s3" };
      state.selectedShipIds = new Set(["s1", "s2", "s3"]);
      window.__resync();
    });
    assert.equal(await page.locator("#movementToggleScope").textContent(), "3 ships");
    const mixed = await rowState(page, "pursue");
    assert.equal(mixed.checked, "mixed");
    assert.equal(mixed.readout, "Mixed", "a disagreeing selection is named, not left as a faint tick");
    await page.locator("#movementToggleControls").screenshot({ path: path.join(artifactDir, "mixed.png") });

    // Mixed reads as "not all on", so the next click turns it on for all of them.
    await page.evaluate(() => { window.__sent.length = 0; });
    await page.locator('[data-movement-toggle="pursue"]').click();
    assert.deepEqual(await page.evaluate(() => window.__sent[0].toggles), { pursue: true },
      "clicking a mixed row brings the selection together on");

    // --- Nothing selected -----------------------------------------------------
    await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      state.selectedShipIds = new Set();
      window.__resync();
    });
    assert.equal(await page.locator("#movementToggleScope").textContent(), "No selection");
    assert.equal((await rowState(page, "pursue")).disabled, true, "the rows are inert with nothing selected");

    // --- Layout ---------------------------------------------------------------
    for (const [width, height] of [[1920, 1080], [1280, 720], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      const overflow = await page.locator("#movementToggleControls").evaluate((el) => el.scrollWidth - el.clientWidth);
      assert(overflow <= 1, `${width}x${height}: the engagement orders do not overflow the panel`);
    }

    assert.deepEqual(errors, [], `no page errors: ${errors.join("; ")}`);
    console.log("verify-movement-toggles-browser passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})();
