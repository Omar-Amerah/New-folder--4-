// PixiJS (WebGL) arena renderer backend. Initialized on demand by renderController.
// Drives the same interpolation/camera/state logic as the Canvas 2D renderer,
// but renders through a GPU scene graph with baked textures and pooled sprites.

import { dom } from "../../ui/dom.js";
import { state } from "../../state.js";
import { updateCamera } from "../camera.js";
import { interpolateShips, getViewportWorldBounds } from "../renderer.js";
import { getRenderQuality, getRenderQualityDprCap } from "../renderSettings.js";
import { setDebugFrameStats, updateDebugOverlay } from "../debugOverlay.js";
import { playerMap } from "../../ui/scoreboardUi.js";
import { pixiFlushBakedTextures } from "./pixiBake.js";
import { updatePixiWorld } from "./pixiWorld.js";
import { updatePixiShips } from "./pixiShips.js";
import { updatePixiScreenUi } from "./pixiScreenUi.js";

let pixiEnv = null;
let pixiFrameCount = 0;
let pixiLastFpsTime = 0;
let pixiCurrentFps = 0;

function computePixiResolution() {
  return Math.max(1, Math.min(getRenderQualityDprCap(), window.devicePixelRatio || 1));
}

// Baked art must stay crisp at max zoom (1.45) times the DPR cap.
function pixiBakeScaleForQuality(quality) {
  if (quality === "low") return 1.5;
  if (quality === "medium") return 2.0;
  return 2.5;
}

export function getPixiEnv() {
  return pixiEnv;
}

export async function initPixiRenderer() {
  if (pixiEnv) return pixiEnv;
  const PIXI = await import("pixi.js");
  const rect = dom.canvas.getBoundingClientRect();
  const quality = getRenderQuality();

  const app = new PIXI.Application();
  await app.init({
    canvas: dom.canvas,
    preference: "webgl",
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height)),
    resolution: computePixiResolution(),
    autoDensity: false,
    antialias: quality !== "low",
    background: "#040710"
  });

  // Layer order mirrors the Canvas renderer's draw order.
  const backdropRoot = new PIXI.Container();
  const worldRoot = new PIXI.Container();
  const layers = {
    backdropRoot,
    worldRoot,
    grid: new PIXI.Graphics(),
    map: new PIXI.Container(),
    relays: new PIXI.Container(),
    command: new PIXI.Graphics(),
    engineSmoke: new PIXI.Graphics(),
    ships: new PIXI.Container(),
    bullets: new PIXI.Container(),
    effects: new PIXI.Container(),
    effectText: new PIXI.Container(),
    overlay: new PIXI.Graphics(),
    screenUiRoot: new PIXI.Container()
  };
  worldRoot.addChild(layers.grid);
  worldRoot.addChild(layers.map);
  worldRoot.addChild(layers.relays);
  worldRoot.addChild(layers.command);
  worldRoot.addChild(layers.engineSmoke);
  worldRoot.addChild(layers.ships);
  worldRoot.addChild(layers.bullets);
  worldRoot.addChild(layers.effects);
  worldRoot.addChild(layers.effectText);
  worldRoot.addChild(layers.overlay);
  app.stage.addChild(backdropRoot);
  app.stage.addChild(worldRoot);
  app.stage.addChild(layers.screenUiRoot);

  pixiEnv = {
    PIXI,
    app,
    layers,
    quality,
    bakeScale: pixiBakeScaleForQuality(quality)
  };

  app.ticker.add(pixiFrame);
  return pixiEnv;
}

function pixiFrame() {
  if (!pixiEnv) return;
  const start = performance.now();
  const now = start;
  const dt = Math.min(0.05, Math.max(0.001, (now - state.lastFrameAt) / 1000));
  state.lastFrameAt = now;
  state.dt = dt;
  state.debugStats = { drawnShips: 0, totalShips: 0, drawnBullets: 0, totalBullets: 0, drawnAsteroids: 0, totalAsteroids: 0, drawnEffects: 0, totalEffects: 0 };

  interpolateShips(dt, now);
  updateCamera(dt);

  const app = pixiEnv.app;
  const rect = { width: app.screen.width, height: app.screen.height };
  const worldRoot = pixiEnv.layers.worldRoot;
  worldRoot.position.set(rect.width / 2, rect.height / 2);
  worldRoot.scale.set(state.camera.zoom);
  worldRoot.pivot.set(state.camera.x, state.camera.y);

  const bounds = getViewportWorldBounds(rect);
  const players = state.snapshot ? playerMap() : new Map();
  pixiEnv.layers.overlay.clear();
  updatePixiWorld(pixiEnv, now, players, bounds, rect);
  updatePixiShips(pixiEnv, now, players, bounds);
  updatePixiScreenUi(pixiEnv, now, players, rect);

  pixiFrameCount += 1;
  if (now - pixiLastFpsTime > 1000) {
    pixiCurrentFps = Math.round((pixiFrameCount * 1000) / (now - pixiLastFpsTime));
    pixiFrameCount = 0;
    pixiLastFpsTime = now;
  }
  setDebugFrameStats(pixiCurrentFps, performance.now() - start, "pixi");
  updateDebugOverlay(now);
}

export function resizePixiRenderer() {
  if (!pixiEnv) return;
  const rect = dom.canvas.getBoundingClientRect();
  const app = pixiEnv.app;
  app.renderer.resolution = computePixiResolution();
  app.renderer.resize(Math.max(1, rect.width), Math.max(1, rect.height));

  const quality = getRenderQuality();
  if (quality !== pixiEnv.quality) {
    pixiEnv.quality = quality;
    pixiEnv.bakeScale = pixiBakeScaleForQuality(quality);
    pixiFlushBakedTextures();
  }
}

export function destroyPixiRenderer() {
  if (!pixiEnv) return;
  pixiEnv.app.ticker.remove(pixiFrame);
  pixiFlushBakedTextures();
  pixiEnv.app.destroy({ removeView: false }, { children: true, texture: true });
  pixiEnv = null;
}
