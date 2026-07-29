import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import {
  launchChromium,
  startServer,
  uniquePort,
  uniqueRoom,
  waitForBrowserReady,
  waitForServer
} from "./verify-pixi-browser-support.js";
import {
  CANONICAL_ACTIVE_MATCH_DESIGN,
  normalizeRendererDiagnostics,
  waitOutcome,
  writeFailureArtifacts
} from "./verify-active-match-browser-support.js";

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const room = uniqueRoom("fog");
const artifactDir = "test-artifacts/sensor-fog";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(artifactDir, { recursive: true });

const { server, getLog } = startServer(port);
let browser;

try {
  await waitForServer(base);
  browser = await launchChromium(chromium);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/WebGL context lost/.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });

  try {
    await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
    await waitForBrowserReady(page, room, {}, 20_000);
    await waitOutcome(page, (status) => status.myId && status.myId === status.adminId, 10_000, "sensor fog admin");
    const visibilityOptions = await page.locator("#visibilityModeSelect option").evaluateAll((options) =>
      options.map((option) => ({ value: option.value, text: option.textContent }))
    );
    assert.ok(visibilityOptions.some((option) => option.value === "dark" && option.text === "Full Dark"),
      "lobby exposes the Full Dark game option");
    assert.equal(await page.locator("#infrastructureModeSelect").inputValue(), "stations",
      "new rooms select Stations infrastructure by default");
    assert.equal(await page.locator("#visibilityModeSelect").inputValue(), "sensors",
      "new rooms select Sensor Fog by default");
    await page.evaluate(() => window.__mfaNetSend({
      type: "setRules",
      rules: {
        asteroidDensity: "low",
        startingMoney: 14000,
        visibilityMode: "dark",
        infrastructureMode: "stations"
      }
    }));
    for (let index = 0; index < 3; index += 1) {
      await page.evaluate(() => window.__mfaNetSend({ type: "addBot" }));
    }
    await page.evaluate(() => window.__mfaNetSend({ type: "startDesign" }));
    await waitOutcome(page, (status) => status.phase === "design" && status.players.length >= 4, 10_000, "sensor fog design");
    await page.locator("#openBlueprintDesignerButton").click();
    await page.locator("#partPalette").waitFor({ state: "visible" });
    await page.locator("#partPalette .part-category-tabs button", { hasText: "Support" }).click();
    const supportParts = await page.locator("#partPalette .part-name").allTextContents();
    assert.ok(supportParts.includes("Small Sensor"), "Small Sensor is visible in the Support palette");
    assert.ok(supportParts.includes("Large Sensor"), "Large Sensor is visible in the Support palette");
    assert.ok(supportParts.includes("Small Directed Sensor"), "Small Directed Sensor is visible in the Support palette");
    assert.ok(supportParts.includes("Large Directed Sensor"), "Large Directed Sensor is visible in the Support palette");
    assert.ok(!supportParts.includes("Long-Range Sensor Array"), "legacy Sensor Array stays hidden from new designs");
    assert.ok(!supportParts.includes("Directed Sensor"), "legacy Directed Sensor stays hidden from new designs");
    const directedIcons = await page.evaluate(async () => {
      const { componentIconDataUrl } = await import("/src/ui/componentIcon.js");
      return {
        forward: componentIconDataUrl("largeDirectedSensor", 270),
        rearward: componentIconDataUrl("largeDirectedSensor", 90)
      };
    });
    assert.ok(directedIcons.forward.startsWith("data:image/png"), "forward Directed Sensor icon renders");
    assert.ok(directedIcons.rearward.startsWith("data:image/png"), "rearward Directed Sensor icon renders");
    assert.notStrictEqual(
      directedIcons.forward,
      directedIcons.rearward,
      "opposite Large Directed Sensor rotations render with opposite facings"
    );
    const browserDirectedStack = await page.evaluate(async () => {
      const { state } = await import("/src/state.js");
      const designerUi = await import("/src/ui/designerUi.js");
      const { computeStats } = await import("/src/design/componentStats.js");
      const { PART_STATS } = await import("/src/design/parts.js");
      state.design = [
        ...state.design,
        { x: 1, y: 1, type: "smallSensor", rotation: 0 },
        { x: 3, y: 1, type: "largeSensor", rotation: 0 },
        { x: 6, y: 1, type: "smallDirectedSensor", rotation: 0 },
        { x: 8, y: 2, type: "largeDirectedSensor", rotation: 270 }
      ];
      designerUi.renderBuildGrid();
      designerUi.renderLocalStats();
      const stats = computeStats(state.design);
      return {
        actual: stats.directedSensorRange,
        expected: stats.baseSensorRange
          + PART_STATS.largeDirectedSensor.sensorRangeBonus
          + PART_STATS.smallDirectedSensor.sensorRangeBonus * 0.65
      };
    });
    assert.strictEqual(
      browserDirectedStack.actual,
      browserDirectedStack.expected,
      "browser designer stacks aligned Directed Sensor range with diminishing returns"
    );
    await page.locator("#designerAnalysisTab").click();
    await page.locator("#analysisMovementTab").click();
    assert.strictEqual(await page.locator("#analysisMovementTab").textContent(), "Combat",
      "the former Movement analysis subtab is labelled Combat");
    assert.strictEqual(
      await page.locator("#analysisMovementPanel .combat-movement-card h3").textContent(),
      "Combat movement"
    );
    assert.strictEqual(await page.locator("#analysisMovementPanel .sensor-coverage-plot").isVisible(), true,
      "Combat analysis renders the sensor coverage graphic below movement");
    assert.strictEqual(await page.locator("#analysisMovementPanel .sensor-coverage-cone").count(), 2,
      "each Directed Sensor renders its own facing cone");
    assert.deepStrictEqual(
      await page.locator("#analysisMovementPanel .sensor-stack-entry-head b").allTextContents(),
      ["100%", "65%", "100%", "65%"],
      "General and Directional stacks expose diminishing returns independently"
    );
    assert.match(
      await page.locator("#analysisMovementPanel .sensor-coverage-readouts").textContent(),
      /General range[\s\S]*Directional maximum/
    );
    await page.screenshot({ path: `${artifactDir}/combat-sensor-analysis.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileCombatGeometry = await page.evaluate(() => {
      const panel = document.querySelector("#analysisMovementPanel");
      const card = document.querySelector(".sensor-coverage-card");
      const plot = document.querySelector(".sensor-coverage-plot");
      return {
        panelOverflow: panel.scrollWidth > panel.clientWidth + 1,
        cardOverflow: card.scrollWidth > card.clientWidth + 1,
        plotFitsCard: plot.getBoundingClientRect().width <= card.getBoundingClientRect().width + 1
      };
    });
    assert.deepStrictEqual(
      mobileCombatGeometry,
      { panelOverflow: false, cardOverflow: false, plotFitsCard: true },
      "Combat sensor analysis fits a 390px mobile viewport"
    );
    await page.screenshot({ path: `${artifactDir}/combat-sensor-analysis-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate((design) => window.__mfaNetSend({
      type: "deploy",
      design,
      combatStyle: "sentry"
    }), CANONICAL_ACTIVE_MATCH_DESIGN);
    await waitOutcome(page, (status) => status.phase === "active", 20_000, "sensor fog active");
    await page.evaluate((design) => window.__mfaNetSend({
      type: "buyShip",
      design,
      count: 1,
      requestId: `sensor-fog-${Date.now()}`,
      combatStyle: "sentry"
    }), CANONICAL_ACTIVE_MATCH_DESIGN);
    await waitOutcome(page, (status) => status.shipCount > 0, 20_000, "sensor fog purchased ship");
    await waitOutcome(
      page,
      (status) => normalizeRendererDiagnostics(status.renderer).contextState === "active"
        && normalizeRendererDiagnostics(status.renderer).authoritativeShips > 0
        && (status.renderer?.sceneChildCounts?.fog || 0) > 0,
      15_000,
      "sensor fog Pixi views"
    );
    await sleep(800);

    const initial = await page.evaluate(() => {
      const state = window.__mfaState;
      const mine = state.mine;
      const own = (state.snapshot?.ships || []).filter((ship) => ship.ownerId === state.myId);
      return {
        mode: state.rules?.visibilityMode,
        infrastructureMode: state.rules?.infrastructureMode,
        team: mine?.team,
        stationCount: state.snapshot?.stations?.length || 0,
        stations: (state.snapshot?.stations || []).map((station) => ({
          id: station.id,
          stationType: station.stationType,
          x: station.x,
          y: station.y,
          designLength: station.design?.length || 0
        })),
        own: own.map((ship) => ({
          id: ship.id,
          team: ship.team,
          sensorRange: ship.sensorRange
        })),
        contacts: state.snapshot?.contacts?.length || 0,
        renderer: window.__mfaRenderer.diagnostics(),
        network: window.__mfaNetworkDiagnostics
      };
    });
    assert.equal(initial.mode, "dark", "browser accepted Full Dark mode");
    assert.equal(initial.infrastructureMode, "stations", "browser exercises station infrastructure with fog");
    assert.ok(initial.stationCount > 0, "station-plus-fog snapshot renders live stations");
    assert.ok(
      initial.stations.every((station) =>
        ["home", "relay"].includes(station.stationType)
        && Number.isFinite(station.x)
        && Number.isFinite(station.y)
        && station.designLength > 0
      ),
      `every compact station retains its full baseline geometry (${JSON.stringify(initial.stations)})`
    );
    assert.ok(initial.stations.some((station) => station.stationType === "relay"), "relay stations survive compact snapshot merging");
    assert.ok(initial.own.length > 0, "at least one allied sensor source is rendered");
    assert.ok(initial.own.every((ship) => ship.team === initial.team), "ship snapshots carry the derived owner team");
    assert.ok(initial.own.every((ship) => ship.sensorRange > 0), "ship snapshots carry an effective sensor range");
    assert.equal(initial.renderer.fatalFrameError, null, "fog texture renders without a Pixi frame failure");

    const relayId = initial.stations.find((station) => station.stationType === "relay").id;
    await page.evaluate((id) => {
      const relay = window.__mfaState.snapshot.stations.find((station) => station.id === id);
      window.__mfaState.camera.follow = false;
      window.__mfaState.camera.x = relay.x;
      window.__mfaState.camera.y = relay.y;
    }, relayId);
    await sleep(250);
    const relayRender = await page.evaluate(async (id) => {
      const { peekPixiStationView } = await import("/src/game/pixi/pixiStations.js");
      const relay = window.__mfaState.snapshot.stations.find((station) => station.id === id);
      const view = peekPixiStationView(id);
      return {
        exists: Boolean(view),
        shellSignature: view?.shellSignature || "",
        x: view?.root?.position?.x,
        y: view?.root?.position?.y,
        expectedX: relay?.x,
        expectedY: relay?.y
      };
    }, relayId);
    assert.ok(relayRender.exists && relayRender.shellSignature, "station mode renders a relay body, not only its classic objective badge");
    assert.equal(relayRender.x, relayRender.expectedX, "relay body renders at its authoritative x position");
    assert.equal(relayRender.y, relayRender.expectedY, "relay body renders at its authoritative y position");

    await page.evaluate(() => {
      const state = window.__mfaState;
      const own = (state.snapshot?.ships || []).find((ship) => ship.ownerId === state.myId);
      if (own) {
        state.camera.x = own.x;
        state.camera.y = own.y;
      }
    });
    const world = await page.evaluate(() => window.__mfaState.world);
    await page.evaluate(({ x, y }) => window.__mfaNetSend({ type: "command", x, y }), {
      x: world.width / 2,
      y: world.height / 2
    });

    for (const quality of ["low", "high", "medium"]) {
      await page.evaluate((nextQuality) => {
        localStorage.setItem("mfa.renderQuality", nextQuality);
        window.dispatchEvent(new Event("storage"));
        window.dispatchEvent(new Event("resize"));
      }, quality);
      await sleep(350);
      const diagnostics = await page.evaluate(() => window.__mfaRenderer.diagnostics());
      assert.equal(diagnostics.fatalFrameError, null, `fog surface survives ${quality} quality`);
      assert.equal(diagnostics.tickerStarted, true, `renderer remains live at ${quality} quality`);
    }

    await page.screenshot({ path: `${artifactDir}/sensor-fog.png`, fullPage: true });
    assert.deepEqual(pageErrors, [], `no browser page errors: ${pageErrors.join("; ")}`);
    assert.deepEqual(consoleErrors, [], `no browser console errors: ${consoleErrors.join("; ")}`);
    console.log("Sensor fog browser verification passed");
  } catch (error) {
    await writeFailureArtifacts(page, artifactDir, {
      error: error.stack,
      serverLog: getLog(),
      pageErrors,
      consoleErrors
    });
    throw error;
  }
} finally {
  await browser?.close().catch(() => {});
  server.kill("SIGTERM");
}
