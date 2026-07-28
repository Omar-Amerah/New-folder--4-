#!/usr/bin/env node
"use strict";

const assert = require("assert");
const { chromium } = require("playwright");
const {
  launchChromium,
  startServer,
  waitForServer,
  waitForBrowserReady,
  uniquePort,
  uniqueRoom
} = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const room = uniqueRoom("endgame-actions");
const { server } = startServer(port);
let browser;

(async () => {
  const pageErrors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
    await waitForBrowserReady(page, room, {}, 20_000);

    const result = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const lobby = await import("/src/ui/lobbyUi.js");
      const { updateWinnerBanner } = await import("/src/ui/endGameUi.js");
      const { synchronizePhasePresentation } = await import("/src/messages.js");
      const sent = [];
      const realSocket = state.socket;
      state.socket = {
        readyState: WebSocket.OPEN,
        send(payload) { sent.push(payload); }
      };
      state.phase = "ended";
      state.snapshot = {
        ...state.snapshot,
        phase: "ended",
        winner: { id: state.myId, name: state.mine?.name || "Winner", team: state.mine?.team || "blue" }
      };
      state.adminId = state.myId;
      state.pendingEndGameAction = null;
      updateWinnerBanner();

      const readAction = (buttonId, expectedPending) => {
        const before = (window.__mfaNetworkDiagnostics?.sentTypes || []).length;
        document.getElementById(buttonId).click();
        const sentTypes = window.__mfaNetworkDiagnostics?.sentTypes || [];
        const type = sentTypes.slice(before).at(-1)?.type || null;
        const disabled = document.getElementById(buttonId).disabled;
        const pending = state.pendingEndGameAction;
        lobby.clearPendingEndGameAction();
        state.reconnectAllowed = true;
        return { type, disabled, pending };
      };

      const rematch = readAction("restartButton", "rematch");
      const returnToLobby = readAction("returnToLobbyButton", "return-to-lobby");
      const closeLobby = readAction("endCloseButton", "close-lobby");
      const mainMenu = readAction("endLeaveButton", "leave-lobby");

      document.getElementById("minimizeEndGameButton").click();
      const minimized = {
        panelHidden: document.getElementById("endGameScreen").hidden,
        restoreHidden: document.getElementById("showEndGameButton").hidden
      };
      document.getElementById("showEndGameButton").click();
      const restored = {
        panelHidden: document.getElementById("endGameScreen").hidden,
        restoreHidden: document.getElementById("showEndGameButton").hidden
      };

      state.socket = { readyState: WebSocket.CLOSED, send() {} };
      document.getElementById("restartButton").click();
      const offlineFailure = {
        pending: state.pendingEndGameAction,
        disabled: document.getElementById("restartButton").disabled
      };

      state.socket = realSocket;
      state.phase = "lobby";
      state.snapshot = { ...state.snapshot, phase: "lobby", winner: null };
      synchronizePhasePresentation("ended", "lobby");
      const lobbyTransition = {
        panelHidden: document.getElementById("endGameScreen").hidden,
        restoreHidden: document.getElementById("showEndGameButton").hidden,
        lobbyVisible: !document.getElementById("lobbyManagementScreen").hidden,
        pending: state.pendingEndGameAction
      };
      return {
        rematch,
        returnToLobby,
        closeLobby,
        mainMenu,
        minimized,
        restored,
        offlineFailure,
        lobbyTransition
      };
    });

    assert.deepStrictEqual(result.rematch, { type: "returnToLobby", disabled: true, pending: "rematch" });
    assert.deepStrictEqual(result.returnToLobby, { type: "returnToLobby", disabled: true, pending: "return-to-lobby" });
    assert.deepStrictEqual(result.closeLobby, { type: "closeLobby", disabled: true, pending: "close-lobby" });
    assert.deepStrictEqual(result.mainMenu, { type: "leaveLobby", disabled: true, pending: "leave-lobby" });
    assert.deepStrictEqual(result.minimized, { panelHidden: true, restoreHidden: false });
    assert.deepStrictEqual(result.restored, { panelHidden: false, restoreHidden: true });
    assert.deepStrictEqual(result.offlineFailure, { pending: null, disabled: false });
    assert.deepStrictEqual(result.lobbyTransition, {
      panelHidden: true,
      restoreHidden: true,
      lobbyVisible: true,
      pending: null
    });
    assert.deepStrictEqual(pageErrors, []);
    console.log("End-game action browser verification passed", JSON.stringify(result));
  } catch (error) {
    console.error(error);
    console.error("Page errors:", pageErrors);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
})();
