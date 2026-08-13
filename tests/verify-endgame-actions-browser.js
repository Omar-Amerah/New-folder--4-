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
        rules: { ...state.snapshot?.rules, gameMode: "teams" },
        winner: { id: "red-one", name: "Red wing", team: "red" },
        players: [
          {
            id: "blue-one",
            name: "Blue Pilot",
            team: "blue",
            teamName: "Blue wing",
            color: "#64b5ff",
            kills: 1,
            damageDealt: 11,
            shieldDamageDealt: 22,
            componentsDestroyed: 3,
            missilesIntercepted: 4,
            hullRepaired: 55,
            shieldRestored: 66,
            shipsBuilt: 2,
            losses: 1,
            lostFleetCost: 777
          },
          {
            id: "red-one",
            name: "Red Pilot",
            team: "red",
            teamName: "Red wing",
            color: "#ff7390",
            kills: 2,
            damageDealt: 1234,
            shieldDamageDealt: 567,
            componentsDestroyed: 8,
            missilesIntercepted: 9,
            hullRepaired: 101,
            shieldRestored: 202,
            shipsBuilt: 3,
            losses: 4,
            lostFleetCost: 5678
          }
        ]
      };
      state.adminId = state.myId;
      state.pendingEndGameAction = null;
      updateWinnerBanner();

      const readBackgroundAlpha = (color) => {
        const colorMixAlpha = color.match(/\/\s*([0-9.]+)\s*\)$/);
        if (colorMixAlpha) return Number(colorMixAlpha[1]);
        const rgbaAlpha = color.match(/rgba?\([^)]*,\s*([0-9.]+)\s*\)$/);
        return rgbaAlpha ? Number(rgbaAlpha[1]) : null;
      };

      const teamPresentation = [...document.querySelectorAll("[data-report-team]")].map((group) => ({
        team: group.dataset.reportTeam,
        heading: group.querySelector(".report-team-heading")?.textContent.replace(/\s+/g, " ").trim(),
        player: group.querySelector(".report-player-row td")?.textContent,
        winner: group.classList.contains("report-team-winner"),
        accent: getComputedStyle(group.querySelector(".report-team-heading th")).borderLeftColor,
        rowAlpha: readBackgroundAlpha(getComputedStyle(group.querySelector(".report-player-row")).backgroundColor)
      }));

      const readDetails = (detail) => Object.fromEntries(
        [...detail.querySelectorAll("dt")].map((label) => [label.textContent, label.nextElementSibling.textContent])
      );
      const redRow = document.querySelector('[data-report-team="red"] .report-player-row');
      const redDetail = redRow.nextElementSibling;
      const redCollapsedInitially = redDetail.hidden;
      redRow.click();
      const redExpanded = {
        hidden: redDetail.hidden,
        values: readDetails(redDetail)
      };
      redRow.click();
      const redCollapsedAgain = redDetail.hidden;

      const blueRow = document.querySelector('[data-report-team="blue"] .report-player-row');
      const blueDetail = blueRow.nextElementSibling;
      blueRow.click();
      const blueExpanded = {
        hidden: blueDetail.hidden,
        values: readDetails(blueDetail)
      };
      blueRow.click();
      const blueCollapsedAgain = blueDetail.hidden;

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
        teamPresentation,
        reportDetails: {
          redCollapsedInitially,
          redExpanded,
          redCollapsedAgain,
          blueExpanded,
          blueCollapsedAgain
        },
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

    assert.deepStrictEqual(result.teamPresentation, [
      { team: "red", heading: "Red wing Winner", player: "Red Pilot", winner: true, accent: "rgb(255, 95, 126)", rowAlpha: 0.12 },
      { team: "blue", heading: "Blue wing 1 pilot", player: "Blue Pilot", winner: false, accent: "rgb(56, 213, 255)", rowAlpha: 0.09 }
    ]);
    assert.deepStrictEqual(result.reportDetails, {
      redCollapsedInitially: true,
      redExpanded: {
        hidden: false,
        values: {
          "Damage dealt": "1,234",
          "Shield damage": "567",
          "Components destroyed": "8",
          "Missiles intercepted": "9",
          "Hull repaired": "101",
          "Shield restored": "202",
          "Ships deployed": "3",
          "Ships lost": "4",
          "Fleet value lost": "$5,678"
        }
      },
      redCollapsedAgain: true,
      blueExpanded: {
        hidden: false,
        values: {
          "Damage dealt": "11",
          "Shield damage": "22",
          "Components destroyed": "3",
          "Missiles intercepted": "4",
          "Hull repaired": "55",
          "Shield restored": "66",
          "Ships deployed": "2",
          "Ships lost": "1",
          "Fleet value lost": "$777"
        }
      },
      blueCollapsedAgain: true
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
