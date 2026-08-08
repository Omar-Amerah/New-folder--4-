#!/usr/bin/env node
"use strict";

// The Orbit button, in a real browser, against the real side panel.
//
// Orbit is the one stance whose button is also a readout: it has to say which
// way round the selection is going, and clicking it while it is already
// selected has to change the direction WITHOUT reissuing the stance. The
// difference is invisible in the DOM and entirely visible on the wire, so this
// verifier watches what the panel actually sends.

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

// Put the panel into an active match with three of our own ships selected, and
// replace the socket with one that records rather than transmits.
async function setup(page) {
  await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);
  await page.evaluate(async () => {
    const [{ state }, sidePanel] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/sidePanelUi.js")
    ]);
    for (const id of ["mainMenuScreen", "lobbyManagementScreen", "settingsScreen", "lobbyScreen", "blueprintDesignerScreen"]) {
      const element = document.getElementById(id);
      if (element) element.hidden = true;
    }
    void sidePanel;
    window.__sent = [];
    state.myId = "orbit-test";
    state.phase = "active";
    state.mine = { id: "orbit-test", team: "blue", money: 1000, activeShips: 3, shipCap: 30 };
    // The panel calls send(), which MessagePack-encodes the message and hands
    // the frame to the socket. Intercepting there and decoding with the same
    // vendored codec means these assertions are about the bytes that would
    // actually have gone out, not about an intermediate object.
    state.socket = {
      readyState: WebSocket.OPEN,
      send(frame) {
        window.__sent.push(globalThis.MessagePack.decode(new Uint8Array(frame)));
      }
    };
  });
}

async function applyShips(page, ships, selectedIds) {
  return page.evaluate(async ({ ships: shipRows, selectedIds: selected }) => {
    const [{ state }, { renderSideControls }, { buildSnapshotIndex }] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/sidePanelUi.js"),
      import("/src/snapshotPresentation.js")
    ]);
    state.snapshot = {
      players: [{ id: "orbit-test", team: "blue" }],
      ships: shipRows.map((row, index) => ({
        id: row.id,
        ownerId: "orbit-test",
        alive: true,
        x: index * 40,
        y: 0,
        combatStyle: row.combatStyle,
        orbitDirection: row.orbitDirection
      })),
      points: []
    };
    state.selectedShipIds = new Set(selected);
    // The panel reads the derived index, not the raw snapshot, so an update
    // that skipped it would leave every control disabled.
    state.snapshotIndex = buildSnapshotIndex(state.snapshot, state.myId, state.selectedShipIds);
    renderSideControls();
    return null;
  }, { ships, selectedIds });
}

function orbitButton(page) {
  return page.locator('[data-combat-style="orbit"]');
}

async function sent(page) {
  return page.evaluate(() => window.__sent.slice());
}

async function clearSent(page) {
  await page.evaluate(() => { window.__sent.length = 0; });
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

    // --- unselected: the button is just the stance ------------------------
    await applyShips(page, [
      { id: "s1", combatStyle: "hold", orbitDirection: 1 },
      { id: "s2", combatStyle: "hold", orbitDirection: 1 },
      { id: "s3", combatStyle: "hold", orbitDirection: 1 }
    ], ["s1", "s2"]);
    assert.equal(await orbitButton(page).textContent(), "Orbit",
      "an unselected Orbit button shows no direction");
    assert.equal(await orbitButton(page).evaluate((el) => el.classList.contains("active")), false);

    // --- clicking it selects the stance, and does NOT dictate a direction --
    await clearSent(page);
    await orbitButton(page).click();
    let messages = await sent(page);
    assert.equal(messages.length, 1, "one message per click");
    assert.equal(messages[0].type, "setCombatStyle", "selecting the stance is a style change");
    assert.equal(messages[0].combatStyle, "orbit");
    assert.equal(messages[0].orbitDirection, undefined,
      "selecting Orbit must not overwrite each ship's own last-used direction");

    // --- selected clockwise: the button reports the direction --------------
    await applyShips(page, [
      { id: "s1", combatStyle: "orbit", orbitDirection: 1 },
      { id: "s2", combatStyle: "orbit", orbitDirection: 1 },
      { id: "s3", combatStyle: "hold", orbitDirection: 1 }
    ], ["s1", "s2"]);
    assert.equal(await orbitButton(page).textContent(), "Orbit C");
    assert.equal(await orbitButton(page).evaluate((el) => el.classList.contains("active")), true);
    assert.equal(await orbitButton(page).getAttribute("title"), "Orbit Clockwise: click to reverse",
      "the full direction is spelled out in the tooltip, not just the abbreviation");

    // --- clicking it again is a DIRECTION change, not a stance change ------
    await clearSent(page);
    await orbitButton(page).click();
    messages = await sent(page);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "setOrbitDirection",
      "toggling direction must not reissue the stance, which would drop the target");
    assert.equal(messages[0].orbitDirection, -1, "C toggles to AC");
    assert.deepEqual(messages[0].shipIds, ["s1", "s2"]);
    // Optimistic, so the button answers on the click rather than a round trip.
    assert.equal(await orbitButton(page).textContent(), "Orbit AC");
    assert.equal(await orbitButton(page).getAttribute("title"), "Orbit Anticlockwise: click to reverse");

    // --- and back again ---------------------------------------------------
    await applyShips(page, [
      { id: "s1", combatStyle: "orbit", orbitDirection: -1 },
      { id: "s2", combatStyle: "orbit", orbitDirection: -1 },
      { id: "s3", combatStyle: "hold", orbitDirection: 1 }
    ], ["s1", "s2"]);
    assert.equal(await orbitButton(page).textContent(), "Orbit AC");
    await clearSent(page);
    await orbitButton(page).click();
    messages = await sent(page);
    assert.equal(messages[0].type, "setOrbitDirection");
    assert.equal(messages[0].orbitDirection, 1, "AC toggles back to C");

    // --- a selection that disagrees ---------------------------------------
    await applyShips(page, [
      { id: "s1", combatStyle: "orbit", orbitDirection: 1 },
      { id: "s2", combatStyle: "orbit", orbitDirection: -1 },
      { id: "s3", combatStyle: "hold", orbitDirection: 1 }
    ], ["s1", "s2"]);
    assert.equal(await orbitButton(page).textContent(), "Orbit",
      "a mixed selection says so rather than picking a side");
    await clearSent(page);
    await orbitButton(page).click();
    messages = await sent(page);
    assert.equal(messages[0].type, "setOrbitDirection");
    assert.equal(typeof messages[0].orbitDirection, "number");
    assert.equal(await orbitButton(page).textContent(), "Orbit C",
      "the first click on a mixed selection brings them onto one direction...");
    await clearSent(page);
    await orbitButton(page).click();
    messages = await sent(page);
    assert.equal(messages[0].orbitDirection, -1, "...and the next one toggles them together");

    // --- another stance leaves the Orbit button unadorned ------------------
    await applyShips(page, [
      { id: "s1", combatStyle: "charge", orbitDirection: -1 },
      { id: "s2", combatStyle: "charge", orbitDirection: -1 },
      { id: "s3", combatStyle: "hold", orbitDirection: 1 }
    ], ["s1", "s2"]);
    assert.equal(await orbitButton(page).textContent(), "Orbit",
      "the direction readout belongs to the selected stance, not to the button");
    await clearSent(page);
    await orbitButton(page).click();
    messages = await sent(page);
    assert.equal(messages[0].type, "setCombatStyle",
      "from another stance, clicking Orbit selects Orbit rather than toggling a direction");

    assert.deepEqual(errors, [], `no page errors: ${errors.join("; ")}`);
    console.log("verify-movement-orbit-browser passed");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})();
