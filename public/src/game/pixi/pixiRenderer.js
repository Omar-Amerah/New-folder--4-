// PixiJS (WebGL) arena renderer — the one and only arena backend. Initialized on
// demand by renderController. Drives interpolation/camera/state each frame and
// renders through a GPU scene graph with baked textures and pooled sprites.

import { dom, replaceArenaCanvas } from "../../ui/dom.js";
import { state } from "../../state.js";
import { updateCamera } from "../camera.js";
import { bindArenaPointerListeners } from "../input.js";
import { interpolateShips } from "../renderInterpolation.js";
import { getViewportWorldBounds } from "../viewportCulling.js";
import { getRenderQuality, getRenderQualityDprCap } from "../renderSettings.js";
import { setDebugFrameStats, updateDebugOverlay } from "../debugOverlay.js";
import { playerMap } from "../../ui/scoreboardUi.js";
import { advancePixiBakeGeneration, flushAllPixiTextureCaches } from "./pixiBake.js";
import { updatePixiWorld, destroyPixiWorld } from "./pixiWorld.js";
import { updatePixiShips, destroyPixiShipPool } from "./pixiShips.js";
import { updatePixiScreenUi, destroyPixiScreenUi } from "./pixiScreenUi.js";

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

// Tracks canvas elements that have already hosted a Pixi WebGL context. A GL
// context cannot be recreated on such a canvas, so a re-init swaps in a fresh
// one.
const usedArenaCanvases = new WeakSet();

export async function initPixiRenderer() {
  if (pixiEnv) return pixiEnv;
  const PIXI = await import("pixi.js");

  // On a re-initialization, the previous WebGL context is gone but its canvas
  // remains; give the new application a fresh canvas and re-bind pointer input.
  if (usedArenaCanvases.has(dom.canvas)) {
    const fresh = replaceArenaCanvas();
    bindArenaPointerListeners(fresh);
  }
  usedArenaCanvases.add(dom.canvas);

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

  // Layer order defines the arena draw order (back to front).
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
    enemyBullets: new PIXI.Container(),
    ships: new PIXI.Container(),
    friendlyBullets: new PIXI.Container(),
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
  worldRoot.addChild(layers.enemyBullets);
  worldRoot.addChild(layers.ships);
  worldRoot.addChild(layers.friendlyBullets);
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
    // Advance the bake generation so new-generation textures are baked and
    // referenced; old-generation textures are destroyed only after their final
    // lease releases (no in-use texture is destroyed).
    advancePixiBakeGeneration();
  }
}

// Full teardown. Order matters: release every texture lease (via pool/view
// destruction) BEFORE flushing the caches, so each cache-owned texture is
// destroyed exactly once; then destroy the Application WITHOUT letting it
// destroy sprite textures (they are cache-owned and already handled).
export function destroyPixiRenderer() {
  if (!pixiEnv) return;
  const env = pixiEnv;
  // 1. Stop the render loop.
  env.app.ticker.remove(pixiFrame);
  // 2-6. Destroy pools/views (releases every texture lease; resets globals).
  destroyPixiShipPool();
  destroyPixiWorld();
  destroyPixiScreenUi(env);
  // 7. Now that no lease remains, destroy every cache-owned texture exactly once.
  flushAllPixiTextureCaches();
  // 8. Destroy the Application. texture:false — textures are cache-owned and
  // already destroyed above; letting Pixi destroy shared sprite textures would
  // double-destroy them.
  env.app.destroy({ removeView: false }, { children: true, texture: false, textureSource: false });
  // 9. Clear module-global references.
  pixiEnv = null;
  pixiFrameCount = 0;
  pixiLastFpsTime = 0;
  pixiCurrentFps = 0;
}
