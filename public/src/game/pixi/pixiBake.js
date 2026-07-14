// Texture baking and pooling helpers for the PixiJS arena renderer.
// Baking reuses the existing Canvas 2D draw functions by pointing the shared
// ctx at an offscreen canvas, then wrapping the result in a Pixi texture.

import { withCanvasContext } from "../../ui/dom.js";

// Every cache registers itself here so quality changes can flush all baked art.
const pixiBakedCaches = new Set();

// Bumped on every flush; views bake it into their texture keys so sprites that
// still hold a destroyed texture get reassigned on the next frame.
let pixiBakeGeneration = 0;

export function getPixiBakeGeneration() {
  return pixiBakeGeneration;
}

export function registerPixiTextureCache(cache) {
  pixiBakedCaches.add(cache);
  return cache;
}

export function pixiFlushBakedTextures() {
  pixiBakeGeneration += 1;
  for (const cache of pixiBakedCaches) {
    for (const entry of cache.values()) {
      const texture = entry && entry.texture ? entry.texture : entry;
      if (texture && typeof texture.destroy === "function") texture.destroy(true);
    }
    cache.clear();
  }
}

// Bakes a world-space drawing (centered on the origin) into a texture.
// worldW/worldH are the world-unit extents; env.bakeScale sets pixel density.
export function pixiBakeTexture(env, worldW, worldH, drawFn) {
  const s = env.bakeScale;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(worldW * s));
  canvas.height = Math.max(1, Math.ceil(worldH * s));
  const bakeCtx = canvas.getContext("2d");
  bakeCtx.setTransform(s, 0, 0, s, canvas.width / 2, canvas.height / 2);
  withCanvasContext(bakeCtx, () => drawFn(bakeCtx));
  return env.PIXI.Texture.from(canvas);
}

// Bakes a screen-space drawing with the origin at the top-left (no centering).
export function pixiBakeScreenTexture(env, pxW, pxH, drawFn) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(pxW));
  canvas.height = Math.max(1, Math.ceil(pxH));
  const bakeCtx = canvas.getContext("2d");
  withCanvasContext(bakeCtx, () => drawFn(bakeCtx));
  return env.PIXI.Texture.from(canvas);
}

// Keyed mark-and-sweep pool: acquire(key) each frame keeps a view alive;
// frameEnd() hides and recycles everything that was not acquired.
// create() must return an object with a `root` display object.
export function createPixiKeyedPool(container, create) {
  const active = new Map();
  const free = [];
  let stamp = 0;
  return {
    frameStart() {
      stamp += 1;
    },
    acquire(key) {
      let entry = active.get(key);
      if (!entry) {
        entry = free.pop();
        if (!entry) {
          entry = { view: create(), key: null, stamp: 0 };
          container.addChild(entry.view.root);
        }
        entry.key = key;
        active.set(key, entry);
        entry.view.root.visible = true;
        entry.view.fresh = true;
      } else {
        entry.view.fresh = false;
      }
      entry.stamp = stamp;
      return entry.view;
    },
    frameEnd() {
      for (const [key, entry] of active) {
        if (entry.stamp !== stamp) {
          active.delete(key);
          entry.view.root.visible = false;
          if (typeof entry.view.release === "function") entry.view.release();
          free.push(entry);
        }
      }
    },
    // Returns the live view currently bound to key, or null. Read-only; used by
    // diagnostics/tests to inspect a ship's display objects without scraping
    // pixels.
    peek(key) {
      const entry = active.get(key);
      return entry ? entry.view : null;
    },
    activeCount() {
      return active.size;
    }
  };
}
