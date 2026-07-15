// Texture baking, an explicit lease-based texture cache, and display-object
// pooling for the PixiJS arena renderer.
//
// Baking reuses the offscreen Canvas artwork routines by pointing the shared
// 2D ctx at an offscreen canvas (withCanvasContext), then wrapping the result
// in a Pixi texture.
//
// TEXTURE OWNERSHIP CONTRACT
// - A texture cache is the sole owner of the textures it creates.
// - Consumers (ship views, sprites, pooled world objects) are NON-owning: they
//   acquire() a lease to use a texture and release() it when done. They must
//   NEVER call texture.destroy() on a cache-owned texture, and must destroy
//   their sprites with { texture:false, textureSource:false }.
// - A cache entry is reference counted. acquire() increments; release() is
//   idempotent and decrements exactly once. A texture is destroyed exactly once
//   — when its refcount reaches zero AND it is stale (older generation), or when
//   the cache is flushed, or when it is evicted past the soft cap.
// - Quality changes advance the bake generation. New generation → new cache
//   keys → new textures; old textures are marked stale and destroyed only after
//   their final lease is released, so no sprite ever references a destroyed
//   texture mid-frame.

import { withCanvasContext } from "../../ui/dom.js";

// Registry of every live texture cache, so the renderer can flush / invalidate /
// diagnose them all at once. Not exposed as mutable objects.
const pixiTextureCaches = new Set();

// Monotonic bake generation. Bumped on quality changes; baked into cache keys.
let pixiBakeGeneration = 0;

// Global lifetime counters for diagnostics.
let createdTextureCount = 0;
let destroyedTextureCount = 0;

// Soft cap on retained refs==0 (idle-but-reusable) entries per cache before the
// oldest are evicted, bounding memory across long sessions with many designs.
export const CACHE_IDLE_CAP = 128;

export function getPixiBakeGeneration() {
  return pixiBakeGeneration;
}

// Advances the bake generation and marks every cache's now-old entries stale.
// Stale entries with no active leases are destroyed immediately; referenced
// ones are destroyed when their last lease releases.
export function advancePixiBakeGeneration() {
  pixiBakeGeneration += 1;
  for (const cache of pixiTextureCaches) cache.invalidateGeneration();
  return pixiBakeGeneration;
}

// Flushes (force-destroys) every cache. Intended for renderer shutdown, AFTER
// all views and sprites have released their leases.
export function flushAllPixiTextureCaches() {
  for (const cache of pixiTextureCaches) cache.flush();
}

export function pixiTextureDiagnostics() {
  const caches = [];
  for (const cache of pixiTextureCaches) caches.push(cache.diagnostics());
  return {
    generation: pixiBakeGeneration,
    createdTextures: createdTextureCount,
    destroyedTextures: destroyedTextureCount,
    caches
  };
}

function destroyCacheTexture(entry) {
  if (entry.destroyed) return;
  entry.destroyed = true;
  destroyedTextureCount += 1;
  const texture = entry.texture;
  if (texture && typeof texture.destroy === "function") {
    // The cache owns the texture AND its source, so destroy both exactly once.
    texture.destroy(true);
  }
}

// Creates a named, reference-counted texture cache with an explicit lease API.
export function createPixiTextureCache(name) {
  // key -> { texture, refs, generation, key, destroyed, stale }
  const entries = new Map();
  let duplicateReleases = 0;

  function maybeEvictIdle() {
    if (entries.size <= CACHE_IDLE_CAP) return;
    // Evict oldest refs==0 entries first (Map preserves insertion order).
    for (const [key, entry] of entries) {
      if (entries.size <= CACHE_IDLE_CAP) break;
      if (entry.refs <= 0) {
        destroyCacheTexture(entry);
        entries.delete(key);
      }
    }
  }

  const cache = {
    name,

    // Returns a lease { texture, release() }. `factory()` bakes the texture and
    // is called only on a cache miss (or when the cached entry was destroyed).
    acquire(key, factory) {
      let entry = entries.get(key);
      if (!entry || entry.destroyed) {
        const texture = factory();
        createdTextureCount += 1;
        entry = { texture, refs: 0, generation: pixiBakeGeneration, key, destroyed: false, stale: false };
        entries.set(key, entry);
      } else if (entry.generation !== pixiBakeGeneration) {
        // Re-acquired at the current generation before it was cleaned up: it is
        // current again.
        entry.generation = pixiBakeGeneration;
        entry.stale = false;
      }
      entry.refs += 1;
      let released = false;
      return {
        texture: entry.texture,
        release() {
          if (released) { duplicateReleases += 1; return false; }
          released = true;
          entry.refs -= 1;
          if (entry.refs <= 0 && (entry.stale || entry.generation !== pixiBakeGeneration)) {
            destroyCacheTexture(entry);
            entries.delete(entry.key);
          } else {
            maybeEvictIdle();
          }
          return true;
        }
      };
    },

    // Marks entries from an older generation stale; destroys the unreferenced
    // ones now, defers the rest until their leases release.
    invalidateGeneration() {
      for (const [key, entry] of entries) {
        if (entry.generation !== pixiBakeGeneration) {
          entry.stale = true;
          if (entry.refs <= 0) {
            destroyCacheTexture(entry);
            entries.delete(key);
          }
        }
      }
    },

    // Force-destroys every entry regardless of refcount. Use only at shutdown.
    flush() {
      for (const entry of entries.values()) destroyCacheTexture(entry);
      entries.clear();
    },

    trimZeroLease(limit = CACHE_IDLE_CAP) {
      for (const [key, entry] of entries) {
        if (entries.size <= limit) break;
        if (entry.refs <= 0) { destroyCacheTexture(entry); entries.delete(key); }
      }
    },

    diagnostics() {
      let live = 0;
      let stale = 0;
      let refs = 0;
      let zeroLease = 0;
      for (const entry of entries.values()) {
        if (!entry.destroyed) live += 1;
        if (entry.stale) stale += 1;
        refs += entry.refs;
        if (entry.refs <= 0) zeroLease += 1;
      }
      return { name, entries: entries.size, live, stale, refs, zeroLease, duplicateReleases };
    }
  };

  pixiTextureCaches.add(cache);
  return cache;
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
// frameEnd() hides and recycles everything that was not acquired (calling the
// view's release() so it can drop texture leases). create() must return an
// object with a `root` display object; it may expose release() and destroy().
export function createPixiKeyedPool(container, create) {
  const active = new Map();
  const free = [];
  let stamp = 0;
  let destroyed = false;

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
          // Release design-specific texture leases so idle pooled views hold no
          // textures; a later acquire rebuilds the view.
          if (typeof entry.view.release === "function") entry.view.release();
          free.push(entry);
        }
      }
    },
    // Returns the live view currently bound to key, or null. Read-only; used by
    // diagnostics/tests to inspect display objects without scraping pixels.
    peek(key) {
      const entry = active.get(key);
      return entry ? entry.view : null;
    },
    activeCount() {
      return active.size;
    },
    freeCount() {
      return free.length;
    },
    // Tears the pool down: release leases, destroy display objects (never their
    // cache-owned textures), detach roots, and drop all references. Safe to call
    // more than once.
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const teardown = (entry) => {
        const view = entry.view;
        if (typeof view.release === "function") view.release();
        if (typeof view.destroy === "function") {
          view.destroy();
        } else if (view.root) {
          if (view.root.parent) view.root.parent.removeChild(view.root);
          view.root.destroy({ children: true, texture: false, textureSource: false });
        }
      };
      for (const entry of active.values()) teardown(entry);
      for (const entry of free) teardown(entry);
      active.clear();
      free.length = 0;
    }
  };
}
