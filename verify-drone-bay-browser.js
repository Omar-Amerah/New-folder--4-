#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort } = require("./verify-pixi-browser-support.js");
const droneBalance = require("./component-balance.json").drones;

const artifactDir = path.join(__dirname, "test-artifacts", "drone-bay");
fs.mkdirSync(artifactDir, { recursive: true });
const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const { server, getLog } = startServer(port);
let browser;

async function settle(page, count = 4) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  }, count);
}

async function screenshot(page, name, fullPage = true) {
  await page.screenshot({ path: path.join(artifactDir, name), fullPage });
}

async function showCombatState(page, {
  type = "fighter",
  droneStates = ["active", "active", "active"],
  producing = false,
  paused = false,
  replacement = false
} = {}) {
  await page.evaluate(async ({ type, droneStates, producing, paused, replacement }) => {
    const [{ state }, panel, { GENERATED_BALANCE }, interpolation] = await Promise.all([
      import("/src/state.js"),
      import("/src/ui/shipDamagePanelUi.js"),
      import("/src/generatedBalance.js"),
      import("/src/game/renderInterpolation.js")
    ]);
    document.querySelectorAll(".menu-screen, .confirm-modal").forEach((element) => { element.hidden = true; });
    if (!document.getElementById("droneBrowserIsolation")) {
      const style = document.createElement("style");
      style.id = "droneBrowserIsolation";
      style.textContent = `
        .main-menu-screen, .purchase-bar, .top-hud, .side-panel, #scoreList, #eventLog { display:none !important; }
        .app { grid-template-columns:minmax(0, 1fr) minmax(270px, 320px) !important; }
        .arena-wrap { min-height:100vh !important; }
        .score-panel { display:block !important; overflow:auto !important; max-height:100vh !important; }
      `;
      document.head.appendChild(style);
    }
    const labels = { fighter: "Fighter", defence: "Defence", repair: "Repair" };
    const commandRange = GENERATED_BALANCE.drones.types[type].commandRange;
    const slots = droneStates.map((droneState, index) => ({
      state: droneState,
      droneId: ["active", "launching", "returning"].includes(droneState) ? `${type}-${index}` : null,
      progress: droneState === "producing" ? 0.63 : 1,
      pauseReason: droneState === "producing" && paused ? "insufficient-power" : null
    }));
    if (producing && !slots.some((slot) => slot.state === "producing")) {
      slots[replacement ? 2 : 1] = {
        state: "producing", droneId: null, progress: 0.63,
        pauseReason: paused ? "insufficient-power" : null
      };
    }
    const bay = {
      componentId: "drone-bay:6,6", componentIndex: 1, droneType: type,
      commandRange,
      mode: "deployed", operational: true, runtimePowerMw: producing ? 11 : 7,
      producingSlot: producing ? (replacement ? 2 : 1) : null,
      productionProgress: producing ? 0.63 : null,
      productionPausedReason: paused ? "insufficient-power" : null,
      launchState: droneStates.includes("launching") ? "launching" : "idle",
      x: 500, y: 400, slots
    };
    const ship = {
      id: "carrier", ownerId: "p1", alive: true, x: 500, y: 430, vx: 0, vy: 0, angle: 0,
      targetX: 500, targetY: 430, hp: 340, maxHp: 340, shield: 0, maxShield: 0, radius: 48,
      designRevision: 1, weaponAngles: [],
      design: [
        { x: 7, y: 7, type: "core", rotation: 0 },
        { x: 6, y: 5, type: "droneBay", rotation: 0, droneType: type }
      ],
      chp: [100, 240], componentHeat: [[0, 0, 0, 100], [20, 0, 0.2, 100]],
      componentPower: [["source", 0, 1], ["powered", 0, 1]],
      droneBays: [bay],
      name: `${labels[type]} Carrier`
    };
    const drones = droneStates.flatMap((droneState, index) => {
      if (!["active", "launching", "returning"].includes(droneState)) return [];
      const positions = [[420, 370], [500, 335], [580, 370]];
      return [{
        id: `${type}-${index}`, ownerId: "p1", parentShipId: ship.id,
        bayComponentId: bay.componentId, type, state: droneState,
        x: positions[index][0], y: positions[index][1], vx: 18 + index * 4, vy: 0,
        angle: index * 0.35, hull: type === "repair" ? 32 : 40,
        maxHull: type === "repair" ? 40 : type === "defence" ? 60 : 45,
        stateProgress: droneState === "launching" ? 0.55 : 1
      }];
    });
    state.myId = "p1";
    state.mine = { id: "p1", team: "blue", color: "#5ee7ff" };
    state.phase = "active";
    state.world = { width: 1000, height: 800 };
    state.map = { asteroids: [], safeZones: [] };
    state.camera = { x: 500, y: 400, zoom: 0.72, follow: false, manualZoom: 0.72 };
    state.selectedShipIds = new Set([ship.id]);
    state.shipStatusView = "damage";
    state.visualShips?.clear?.();
    state.snapshot = {
      ships: [ship], drones,
      players: [{ id: "p1", name: "Carrier", color: "#5ee7ff", team: "blue", score: 0 }],
      bullets: [], points: [],
      effects: droneStates.includes("launching")
        ? [{ type: "dronelaunch", subtype: type, ownerId: "p1", x: 500, y: 400, age: 80 }]
        : []
    };
    interpolation.resetRenderHistory();
    interpolation.acceptSnapshotForRender(state.snapshot, performance.now());
    panel.renderShipDamagePanel();
  }, { type, droneStates, producing, paused, replacement });
  await settle(page);
}

(async () => {
  const errors = [];
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") errors.push(`console.error: ${message.text()}`); });
    await page.goto(`${base}/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__mfaMainLoaded === true);

    const placement = await page.evaluate(async () => {
      const [screen, designer, palette, storage, history, { state }] = await Promise.all([
        import("/src/ui/designerScreenUi.js"),
        import("/src/ui/designerUi.js"),
        import("/src/ui/partPaletteUi.js"),
        import("/src/design/blueprintStorage.js"),
        import("/src/design/blueprintEditHistory.js"),
        import("/src/state.js")
      ]);
      screen.openBlueprintDesigner();
      state.design = [
        { x: 7, y: 7, type: "core", rotation: 0 },
        { x: 7, y: 8, type: "engine", rotation: 0 }
      ];
      state.wiring = window.WiringRules.emptyWiring();
      state.blueprintView = "build";
      state.selectedPartCategory = "Support";
      state.selectedPart = "droneBay";
      state.previewRotation = 0;
      state.selectedCell = null;
      history.clearBlueprintEditHistory();
      palette.renderPalette();
      designer.renderBuildGrid();
      designer.renderLocalStats();
      designer.editCell(5, 6);
      const bay = state.design.find((part) => part.type === "droneBay");
      const index = state.design.indexOf(bay);
      const gridCell = document.querySelector(`.build-cell[data-part-index="${index}"]`);
      return {
        bay: structuredClone(bay),
        renderedAnchors: document.querySelectorAll(`.build-cell[data-part-index="${index}"]`).length,
        gridColumn: gridCell?.style.gridColumn || "",
        gridRow: gridCell?.style.gridRow || "",
        history: history.blueprintEditHistorySize()
      };
    });
    assert.equal(placement.renderedAnchors, 1, "multi-cell Drone Bay renders as one accessible component control");
    assert.match(placement.gridColumn, /span 2$/, "Drone Bay preview spans two grid columns");
    assert.match(placement.gridRow, /span 2$/, "Drone Bay preview spans two grid rows");
    assert.equal(placement.bay.droneType, null, "placement does not silently select a type");
    assert.equal(placement.bay.rotation, 0);
    assert.equal(placement.history, 1);
    assert.equal(await page.locator(".drone-bay-config").isVisible(), true, "placing a bay opens its compact type configuration");
    assert.equal(await page.locator(".drone-type-choice").count(), 3);
    assert.equal(await page.locator('[data-component-action="rotate"]').count(), 0, "non-rotatable bay has no Rotate control");
    assert.equal(await page.locator("#rotationIndicator").isHidden(), true);
    await screenshot(page, "drone-bay-placement.png");

    await page.locator('[data-drone-type="fighter"]').click();
    assert.equal(await page.evaluate(() => window.__mfaState.design.find((part) => part.type === "droneBay")?.droneType), "fighter");
    assert.equal(await page.locator('[data-drone-type="fighter"]').getAttribute("aria-pressed"), "true");
    assert.match(await page.locator(".drone-config-stats").textContent(), /Squad\s*3/);
    assert.match(await page.locator(".drone-config-stats").textContent(), /3\s*\/\s*7\s*\/\s*11 MW/);
    assert.equal(await page.locator(".drone-bay-type-badge").textContent(), "F");

    const persisted = await page.evaluate(async () => {
      const storage = await import("/src/design/blueprintStorage.js");
      const { state } = await import("/src/state.js");
      const envelope = storage.designEnvelope(state.design, state.wiring, state.combatStyle);
      const restored = storage.migrateDesignStorage(structuredClone(envelope));
      return restored.modules.find((part) => part.type === "droneBay");
    });
    assert.equal(persisted.droneType, "fighter", "Fighter persists through the real browser storage schema");
    await screenshot(page, "fighter-configuration.png");

    await page.locator('[data-drone-type="repair"]').click();
    assert.equal(await page.evaluate(() => window.__mfaState.design.find((part) => part.type === "droneBay")?.droneType), "repair");
    await page.locator("#undoBlueprintEditButton").click();
    assert.equal(await page.evaluate(() => window.__mfaState.design.find((part) => part.type === "droneBay")?.droneType), "fighter", "Undo restores the previous bay configuration");

    for (const viewport of [{ width: 768, height: 1024 }, { width: 430, height: 932 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.locator(".drone-bay-config").scrollIntoViewIfNeeded();
      const geometry = await page.locator(".drone-bay-config").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const choices = [...element.querySelectorAll(".drone-type-choice")].map((choice) => {
          const box = choice.getBoundingClientRect();
          return { width: box.width, height: box.height, left: box.left, right: box.right };
        });
        return { left: rect.left, right: rect.right, viewport: innerWidth, choices };
      });
      assert.ok(geometry.left >= -1 && geometry.right <= geometry.viewport + 1, `${viewport.width}px config stays within the viewport`);
      assert.ok(geometry.choices.every((choice) => choice.width >= 44 && choice.height >= 44), `${viewport.width}px type choices remain tappable`);
      if (viewport.width === 390) await screenshot(page, "drone-bay-mobile.png");
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await showCombatState(page, { type: "fighter", droneStates: ["active", "producing", "active"], producing: true });
    let diagnostics = await page.evaluate(async () => (await import("/src/game/pixi/pixiDrones.js")).droneRenderDiagnostics());
    assert.equal(diagnostics.entityViews, 2);
    assert.equal(diagnostics.visibleEntityViews, 2, "active drones are visible in the map renderer");
    assert.ok(diagnostics.minimumEntityScale >= 1.2, `drone silhouettes remain readable at normal zoom: ${JSON.stringify(diagnostics)}`);
    assert.equal(diagnostics.productionBars, 1, "selected parent shows one bay-specific production bar");
    assert.deepEqual(
      diagnostics.rangeRings,
      [{
        shipId: "carrier",
        type: "fighter",
        radius: droneBalance.types.fighter.commandRange,
        degrees: 360,
        centerX: 500,
        centerY: 430,
        interpolated: true
      }],
      "selected carrier shows the Fighter's dedicated 360-degree operating radius"
    );
    assert.equal(diagnostics.shipChromeCreated, false, "drone renderer creates no ship name, health, or selection chrome");
    assert.match(
      await page.locator("#shipDroneSummary").textContent(),
      new RegExp(`360° drone range · ${droneBalance.types.fighter.commandRange} m`)
    );
    assert.match(await page.locator("#shipDroneSummary").textContent(), /63% rebuilding/);
    assert.equal(await page.locator("#shipDroneSummary .ship-drone-production").count(), 1, "parent panel shows a compact production progress bar");
    assert.equal(await page.locator("#shipDroneSummary .ship-drone-production").getAttribute("aria-valuenow"), "63");
    await screenshot(page, "production-loading.png", false);

    const movingCenters = await page.evaluate(async () => {
      const [{ state }, interpolation, drones] = await Promise.all([
        import("/src/state.js"),
        import("/src/game/renderInterpolation.js"),
        import("/src/game/pixi/pixiDrones.js")
      ]);
      const next = structuredClone(state.snapshot);
      next.snapshotSeq = 1;
      next.simulationTimeMs = 100;
      const carrier = next.ships.find((ship) => ship.id === "carrier");
      carrier.x = 560;
      carrier.y = 470;
      state.snapshot = next;
      state.snapshotReceivedAt = performance.now();
      interpolation.acceptSnapshotForRender(next, state.snapshotReceivedAt);
      state.renderHistory.delayMs = 0;
      state.renderHistory.clockOffsetMs = 50 - performance.now();
      const samples = [];
      for (let index = 0; index < 5; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const visual = state.visualShips.get("carrier");
        const ring = drones.droneRenderDiagnostics().rangeRings[0];
        samples.push({ visualX: visual?.x, visualY: visual?.y, ringX: ring?.centerX, ringY: ring?.centerY });
      }
      return samples;
    });
    assert.ok(
      movingCenters.every((sample) => Math.abs(sample.visualX - sample.ringX) < 0.001 && Math.abs(sample.visualY - sample.ringY) < 0.001),
      `moving Drone range remains locked to the interpolated ship each frame: ${JSON.stringify(movingCenters)}`
    );
    assert.ok(
      movingCenters.some((sample) => sample.ringX > 500 && sample.ringX < 560),
      `movement test observed an in-between interpolated range center: ${JSON.stringify(movingCenters)}`
    );

    await showCombatState(page, { type: "fighter", droneStates: ["active", "producing", "active"], producing: true, paused: true });
    diagnostics = await page.evaluate(async () => (await import("/src/game/pixi/pixiDrones.js")).droneRenderDiagnostics());
    assert.equal(diagnostics.pausedProductionBars, 1);
    assert.match(await page.locator("#shipDroneSummary").textContent(), /insufficient power/);
    assert.equal(await page.locator("#shipDroneSummary .ship-drone-production").getAttribute("aria-valuenow"), "63", "paused production retains its progress");
    assert.equal(await page.locator("#shipDroneSummary .ship-drone-production").evaluate((element) => element.classList.contains("is-paused")), true);
    await screenshot(page, "production-paused.png", false);

    await showCombatState(page, { type: "fighter", droneStates: ["launching", "launching", "launching"] });
    await screenshot(page, "initial-three-drone-launch.png", false);
    await showCombatState(page, { type: "fighter", droneStates: ["active", "active", "launching"], replacement: true });
    await screenshot(page, "replacement-launch.png", false);
    await showCombatState(page, { type: "fighter", droneStates: ["active", "active", "active"] });
    assert.equal(await page.locator("#shipDroneSummary .ship-drone-pip.is-active").count(), 3, "full squad remains obvious while replacement production is idle");
    assert.match(await page.locator("#shipDroneSummary").textContent(), /squad complete/i);
    await screenshot(page, "fighter-squad-combat.png", false);
    await showCombatState(page, { type: "defence", droneStates: ["active", "active", "active"] });
    diagnostics = await page.evaluate(async () => (await import("/src/game/pixi/pixiDrones.js")).droneRenderDiagnostics());
    assert.equal(diagnostics.rangeRings[0].radius, droneBalance.types.defence.commandRange, "Defence has the shortest drone operating radius");
    await screenshot(page, "defence-squad-intercept.png", false);
    await showCombatState(page, { type: "repair", droneStates: ["active", "active", "active"] });
    diagnostics = await page.evaluate(async () => (await import("/src/game/pixi/pixiDrones.js")).droneRenderDiagnostics());
    assert.equal(diagnostics.rangeRings[0].radius, droneBalance.types.repair.commandRange, "Repair has a medium drone operating radius");
    await screenshot(page, "repair-squad-repairing.png", false);

    assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join("\n")}`);
    console.log(`Drone Bay browser verification passed; screenshots: ${artifactDir}`);
  } catch (error) {
    error.message = `${error.message}\nserver log:\n${getLog()}\nbrowser errors:\n${errors.join("\n")}`;
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
