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
  uniqueRoom,
  DISMISS_MENUS
} = require("./verify-pixi-browser-support.js");

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const room = uniqueRoom("presentation");
const { server } = startServer(port);
let browser;

(async () => {
  const pageErrors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
    await waitForBrowserReady(page, room, {}, 20_000);
    const initialLobby = await page.evaluate(() => {
      const select = document.getElementById("teamSelect");
      const ownRow = document.querySelector(".player-row.mine");
      const rulesGrid = document.getElementById("rulesGrid");
      const rulesReadOnly = document.getElementById("rulesReadOnly");
      const rulesStatus = document.getElementById("rulesStatus");
      return {
        teamValues: Array.from(select?.options || [], (option) => option.value),
        teamText: select?.selectedOptions?.[0]?.textContent || "",
        teamDisabled: Boolean(select?.disabled),
        rulesGridHidden: Boolean(rulesGrid?.hidden),
        rulesReadOnlyHidden: Boolean(rulesReadOnly?.hidden),
        rulesStatus: rulesStatus?.textContent || "",
        ownRowText: ownRow?.innerText || ""
      };
    });
    assert(initialLobby.teamValues.includes("blue"), `initial team choices missing blue: ${JSON.stringify(initialLobby)}`);
    assert(initialLobby.teamValues.includes("red"), `initial team choices missing red: ${JSON.stringify(initialLobby)}`);
    assert(!/loading teams/i.test(initialLobby.teamText), `initial team choice remained loading: ${JSON.stringify(initialLobby)}`);
    assert.equal(initialLobby.teamDisabled, false, `initial team choice remained locked: ${JSON.stringify(initialLobby)}`);
    assert.equal(initialLobby.rulesGridHidden, false, `host rules controls remained hidden: ${JSON.stringify(initialLobby)}`);
    assert.equal(initialLobby.rulesReadOnlyHidden, true, `host rules read-only view remained visible: ${JSON.stringify(initialLobby)}`);
    assert.match(initialLobby.rulesStatus, /host controls/i, `host rules status remained locked: ${JSON.stringify(initialLobby)}`);
    assert(!initialLobby.ownRowText.split(/\r?\n/).some((line) => line.trim() === "|"), `lobby player row contains a stray separator: ${JSON.stringify(initialLobby)}`);

    await page.selectOption("#teamSelect", "red");
    await page.waitForFunction(() => {
      const state = window.__mfaState;
      return state?.mine?.team === "red"
        && document.getElementById("teamSelect")?.value === "red"
        && !document.getElementById("teamSelect")?.disabled;
    });
    await page.fill("#startingMoneyInput", "1250");
    await page.dispatchEvent("#startingMoneyInput", "change");
    await page.waitForFunction(() => {
      const state = window.__mfaState;
      return state?.snapshot?.rules?.startingMoney === 1250
        && document.getElementById("startingMoneyInput")?.value === "1250"
        && !document.getElementById("rulesGrid")?.hidden;
    });
    await page.selectOption("#gameModeSelect", "solo");
    await page.waitForFunction(() => {
      const state = window.__mfaState;
      return state?.snapshot?.rules?.gameMode === "solo"
        && document.getElementById("teamChoiceCard")?.hidden;
    });
    await page.selectOption("#gameModeSelect", "teams");
    await page.waitForFunction(() => {
      const state = window.__mfaState;
      return state?.snapshot?.rules?.gameMode === "teams"
        && !document.getElementById("teamChoiceCard")?.hidden
        && !document.getElementById("teamSelect")?.disabled;
    });
    await page.click("#botButton");
    await page.waitForFunction(() => {
      const state = window.__mfaState;
      return state?.snapshot?.players?.length === 2
        && /2 players/i.test(document.getElementById("phaseDetail")?.textContent || "")
        && !document.getElementById("rulesGrid")?.hidden
        && !document.getElementById("teamSelect")?.disabled;
    });

    const reconnectControls = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const lobby = await import("/src/ui/lobbyUi.js");
      const realSocket = state.socket;
      const read = () => ({
        teamDisabled: document.getElementById("teamSelect")?.disabled,
        rulesHidden: document.getElementById("rulesGrid")?.hidden,
        readOnlyHidden: document.getElementById("rulesReadOnly")?.hidden,
        rulesStatus: document.getElementById("rulesStatus")?.textContent || ""
      });
      state.socket = { readyState: WebSocket.CONNECTING };
      lobby.setConnectionStatus("reconnecting", "Reconnecting");
      const reconnecting = read();
      state.socket = { readyState: WebSocket.OPEN };
      lobby.setConnectionStatus("online", "Connected");
      const restored = read();
      state.socket = realSocket;
      lobby.setConnectionStatus("online", "Connected");
      return { reconnecting, restored };
    });
    assert.equal(reconnectControls.reconnecting.teamDisabled, true);
    assert.equal(reconnectControls.reconnecting.rulesHidden, true);
    assert.equal(reconnectControls.reconnecting.readOnlyHidden, false);
    assert.match(reconnectControls.reconnecting.rulesStatus, /reconnecting/i);
    assert.equal(reconnectControls.restored.teamDisabled, false);
    assert.equal(reconnectControls.restored.rulesHidden, false);
    assert.equal(reconnectControls.restored.readOnlyHidden, true);
    assert.match(reconnectControls.restored.rulesStatus, /host controls/i);
    await page.evaluate(DISMISS_MENUS);

    const report = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const { handleServerMessage } = await import("/src/messages.js");
      const { invalidatePresentation } = await import("/src/presentationInvalidation.js");
      const diagnostics = state.presentationDiagnostics;

      try { state.socket?.close?.(); } catch {}
      state.socket = { readyState: WebSocket.OPEN };
      state.myId = "presentation-player";
      state.selectedShipIds = new Set(["presentation-ship"]);
      state.shipStatusView = "damage";

      const componentCount = 150;
      const design = Array.from({ length: componentCount }, (_, index) => ({
        type: index === 0 ? "core" : "frame",
        x: index % 15,
        y: Math.floor(index / 15),
        rotation: 0
      }));
      const epoch = (state.snapshotNetwork?.stateEpoch || 1) + 100;
      const full = {
        type: "state",
        protocolVersion: state.server?.protocolVersion || 6,
        serverBuildSha: state.server?.buildSha || "browser-test",
        balanceRevision: state.server?.balanceRevision || window.MFA_BALANCE_REVISION || null,
        stateEpoch: epoch,
        snapshotSeq: 1,
        snapshotKind: "full",
        snapshotFormatVersion: 2,
        baseSnapshotSeq: null,
        staticRevision: 1,
        staticRevisions: { componentCatalogue: 1 },
        room: "PRESENTATION",
        phase: "active",
        rules: { gameMode: "teams", shipCap: 12 },
        players: [{
          id: state.myId, name: "Presentation", team: "blue", teamName: "Blue wing",
          ready: true, connected: true, money: 1000, income: 10,
          activeShips: 1, shipCap: 12, activeFleetCost: 100,
          kills: 0, losses: 0, captures: 0,
          rallyPoint: { x: 100, y: 100 }, rallyPointCustom: false
        }],
        ships: [{
          id: "presentation-ship", ownerId: state.myId, team: "blue", alive: true,
          x: 100, y: 100, hp: 1000, maxHp: 1000, shield: 200, maxShield: 200,
          design, designRevision: 1,
          componentAliveRevision: 1, componentDamageRevision: 1,
          chp: Array(componentCount).fill(100),
          heat: 0, heatNow: 0, heatMax: 1000, hot: 0, overheated: 0,
          heatRevision: 1, componentHeatRevision: 1, heatStateRevision: 1, heatTelemetryRevision: 1,
          componentHeat: Array.from({ length: componentCount }, () => [0, 0, 0, 100]),
          componentPower: Array.from({ length: componentCount }, () => ["powered", 1]),
          powerRevision: 1, powerRuntimeRevision: 3,
          powerThermal: {}, combatStyle: "hold"
        }],
        points: [{
          id: "A", x: 400, y: 400, radius: 100,
          ownerId: state.myId, ownerTeam: "blue", contested: false, progress: 1
        }],
        objectiveControl: { total: 1, neutral: 0, contested: 0, teams: { blue: 1 }, players: {} },
        controlVictory: null,
        winner: null,
        bullets: [],
        effects: []
      };
      handleServerMessage(full);
      invalidatePresentation("panel-mode");

      const resetDiagnostics = () => {
        for (const key of Object.keys(diagnostics)) {
          if (typeof diagnostics[key] === "number") diagnostics[key] = 0;
        }
        diagnostics.latest.operations = [];
      };
      const counts = () => ({
        dispatch: diagnostics.presentationDispatchCount,
        economy: diagnostics.economyHudUpdateCount,
        heatHud: diagnostics.heatHudUpdateCount,
        relayHud: diagnostics.relayHudUpdateCount,
        objectiveHud: diagnostics.objectiveHudUpdateCount,
        selectionHud: diagnostics.selectionHudUpdateCount,
        latencyHud: diagnostics.latencyHudUpdateCount,
        hudDomWrites: diagnostics.hudDomWriteCount,
        lobbyRebuild: diagnostics.lobbyPlayerListRebuildCount,
        lobbyPatch: diagnostics.lobbyPlayerRowPatchCount,
        catalogue: diagnostics.purchaseCatalogueBuildCount,
        affordability: diagnostics.purchaseAffordabilityUpdateCount,
        staticGeometry: diagnostics.selectedStaticGeometryBuildCount,
        dynamic: diagnostics.selectedDynamicRedrawCount,
        selectedHeat: diagnostics.selectedHeatUpdateCount,
        selectedDamage: diagnostics.selectedDamageUpdateCount,
        selectedVitals: diagnostics.selectedVitalsUpdateCount,
        rally: diagnostics.rallyUpdateCount || 0,
        relayStatus: diagnostics.relayStatusUpdateCount,
        controlStatus: diagnostics.controlVictoryStatusUpdateCount,
        scoreboard: diagnostics.scoreboardStatusUpdateCount,
        winner: diagnostics.winnerUpdateCount,
        purchasePending: diagnostics.purchasePendingUpdateCount,
        errors: diagnostics.presentationErrorCount,
        phaseSync: diagnostics.phasePresentationSyncCount
      });
      const compact = (mutate = () => {}) => {
        const message = structuredClone(state.snapshot);
        message.type = "state";
        message.snapshotKind = "compact";
        message.snapshotFormatVersion = 2;
        message.stateEpoch = state.snapshotNetwork.stateEpoch;
        message.baseSnapshotSeq = state.snapshotNetwork.snapshotSeq;
        message.snapshotSeq = state.snapshotNetwork.snapshotSeq + 1;
        mutate(message);
        const patch = (entries) => ({
          upsert: Array.isArray(entries) ? entries : [], remove: [], motion: [], state: [],
          private: [], remaining: [], dynamic: [], clearPrivate: [], clearStateFields: [], clearPrivateFields: []
        });
        const wire = {
          ...message,
          roomPatch: Object.fromEntries([
            "phase", "adminId", "winner", "matchStartedAt", "controlVictory", "objectiveControl"
          ].filter((key) => message[key] !== undefined).map((key) => [key, message[key]])),
          playersPatch: patch(message.players),
          shipsPatch: patch(message.ships),
          dronesPatch: patch(message.drones),
          decoysPatch: patch(message.decoys),
          stationsPatch: patch(message.stations),
          pointsPatch: patch(message.points),
          effectsPatch: patch(message.effects)
        };
        delete wire.players;
        delete wire.ships;
        delete wire.drones;
        delete wire.decoys;
        delete wire.stations;
        delete wire.points;
        delete wire.effects;
        handleServerMessage(wire);
      };

      resetDiagnostics();
      const stableStart = performance.now();
      for (let index = 0; index < 100; index += 1) compact();
      const stable = { ...counts(), elapsedMs: performance.now() - stableStart };

      const lobby = await import("/src/ui/lobbyUi.js");
      const lobbyScreen = document.getElementById("lobbyManagementScreen");
      if (lobbyScreen) lobbyScreen.hidden = false;
      lobby.updateLobbyPlayerRows();
      resetDiagnostics();
      compact((message) => { message.players[0].ready = false; });
      const lobbyStatus = counts();
      if (lobbyScreen) lobbyScreen.hidden = true;

      resetDiagnostics();
      compact((message) => { message.ships[0].x += 25; });
      const renderSamples = state.renderHistory?.samples?.get("presentation-ship") || [];
      const position = {
        ...counts(),
        authoritativeX: state.snapshot.ships[0].x,
        rendererX: renderSamples.at(-1)?.x ?? null
      };

      resetDiagnostics();
      handleServerMessage({ type: "pong", at: performance.now() - 42 });
      const latency = counts();

      resetDiagnostics();
      state.selectedShipIds.clear();
      invalidatePresentation("selection");
      const selection = counts();
      state.selectedShipIds.add("presentation-ship");
      invalidatePresentation("selection");

      resetDiagnostics();
      compact((message) => { message.players[0].money += 50; });
      const money = counts();

      resetDiagnostics();
      compact((message) => {
        message.ships[0].hp -= 25;
        message.ships[0].shield -= 10;
      });
      const vitals = counts();

      state.shipStatusView = "damage";
      invalidatePresentation("panel-mode");
      resetDiagnostics();
      compact((message) => {
        const ship = message.ships[0];
        ship.componentDamageRevision += 1;
        ship.chp[0] = 75;
      });
      const damage = { ...counts(), acceptedRevision: state.snapshot.ships[0].componentDamageRevision };

      state.shipStatusView = "heat";
      invalidatePresentation("panel-mode");
      resetDiagnostics();
      compact((message) => {
        const ship = message.ships[0];
        ship.heat = 40;
        ship.heatNow = 400;
        ship.heatRevision += 1;
        ship.componentHeatRevision += 1;
        ship.componentHeat[0] = [40, 1, 0.4, 100];
      });
      const heat = counts();

      resetDiagnostics();
      compact((message) => {
        message.players[0].rallyPoint = { x: 222, y: 333 };
        message.players[0].rallyPointCustom = true;
      });
      const rally = counts();

      resetDiagnostics();
      compact((message) => { message.points[0].progress = 0.8; });
      const objectiveProgress = counts();

      resetDiagnostics();
      compact((message) => { message.players[0].kills += 1; });
      const playerScore = counts();

      resetDiagnostics();
      compact((message) => {
        message.winner = { id: state.myId, name: "Presentation", team: "blue", reason: "test" };
      });
      const winner = counts();
      compact((message) => { message.winner = null; });

      resetDiagnostics();
      invalidatePresentation("purchase-pending");
      const purchasePending = counts();

      resetDiagnostics();
      state.presentationTestHooks = { throwOnUpdater: "updateEconomyHud" };
      compact((message) => {
        message.players[0].money += 1;
        message.points[0].progress = 0.7;
      });
      state.presentationTestHooks = null;
      const updaterIsolation = {
        ...counts(),
        acceptedMoney: state.mine.money,
        acceptedProgress: state.snapshot.points[0].progress
      };

      resetDiagnostics();
      state.presentationTestHooks = { throwOnComparator: true };
      compact((message) => {
        message.phase = "ended";
        message.winner = { id: state.myId, name: "Presentation", team: "blue", reason: "test" };
      });
      state.presentationTestHooks = null;
      const comparatorIsolation = {
        ...counts(),
        phase: state.phase,
        winner: state.snapshot.winner?.name || null
      };

      return {
        stable, lobbyStatus, position, latency, selection, money, vitals, damage,
        heat, rally, objectiveProgress, playerScore, winner,
        purchasePending, updaterIsolation, comparatorIsolation
      };
    });

    assert.equal(report.stable.lobbyRebuild, 0);
    assert.equal(report.stable.lobbyPatch, 0);
    assert.equal(report.stable.catalogue, 0);
    assert.equal(report.stable.staticGeometry, 0);
    assert.equal(report.stable.dynamic, 0);
    assert.equal(report.lobbyStatus.lobbyRebuild, 0);
    assert(report.lobbyStatus.lobbyPatch >= 1);
    assert.equal(report.position.authoritativeX, 125);
    assert.equal(report.position.rendererX, 125);
    assert.equal(report.position.economy, 0);
    assert.equal(report.position.catalogue, 0);
    assert.equal(report.position.dynamic, 0);
    assert.equal(report.position.hudDomWrites, 0);
    assert.equal(report.latency.latencyHud, 1);
    assert.equal(report.latency.selectionHud, 0);
    assert.equal(report.latency.economy, 0);
    assert.equal(report.selection.selectionHud, 1);
    assert.equal(report.selection.catalogue, 0);
    assert.equal(report.selection.lobbyRebuild, 0);
    assert.equal(report.money.economy, 1);
    assert.equal(report.money.affordability, 1);
    assert.equal(report.money.catalogue, 0);
    assert.equal(report.money.lobbyRebuild, 0);
    assert.equal(report.vitals.selectedVitals, 1);
    assert.equal(report.vitals.selectedDamage, 0);
    assert.equal(report.damage.selectedDamage, 1);
    assert.equal(report.damage.dynamic, 1);
    assert.equal(report.damage.staticGeometry, 0);
    assert.equal(report.damage.acceptedRevision, 2);
    assert.equal(report.heat.heatHud, 1);
    assert.equal(report.heat.selectedHeat, 1);
    assert.equal(report.heat.staticGeometry, 0);
    assert.equal(report.rally.rally, 1);
    assert.equal(report.rally.catalogue, 0);
    assert.equal(report.objectiveProgress.relayStatus, 1);
    assert.equal(report.objectiveProgress.controlStatus, 1);
    assert.equal(report.objectiveProgress.scoreboard, 0);
    assert.equal(report.playerScore.scoreboard, 1);
    assert.equal(report.playerScore.lobbyRebuild, 0);
    assert.equal(report.winner.winner, 1);
    assert.equal(report.purchasePending.purchasePending, 1);
    assert.equal(report.purchasePending.catalogue, 0);
    assert.equal(report.updaterIsolation.errors, 1);
    assert.equal(report.updaterIsolation.relayHud, 1);
    assert.equal(report.updaterIsolation.acceptedProgress, 0.7);
    assert.equal(report.comparatorIsolation.phase, "ended");
    assert.equal(report.comparatorIsolation.winner, "Presentation");
    assert(report.comparatorIsolation.errors >= 1);
    assert.equal(report.comparatorIsolation.phaseSync, 1);
    assert.deepStrictEqual(pageErrors, []);

    console.log("Browser presentation dispatch verification passed", JSON.stringify(report));
  } catch (error) {
    console.error(error);
    console.error("Page errors:", pageErrors);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
})();
