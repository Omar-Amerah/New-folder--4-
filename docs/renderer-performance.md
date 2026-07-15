# Renderer performance architecture

PixiJS/WebGL remains the sole arena renderer. The scene graph is created once per renderer generation in deterministic order: backdrop, static grid, map, objectives/relays, command markers, engine visuals, enemy projectiles, ships, friendly projectiles, effects, effect text, overlays, and screen UI. World-space layers share the camera transform; screen UI is outside the scaled world root. Enemy projectiles intentionally render below ships and friendly projectiles above ships to keep player fire readable without changing authoritative state.

## Object classes and counts

* **Authoritative entities** are entities from MessagePack protocol v4 snapshots.
* **Visual entities** are interpolated render records derived from authoritative timestamp history.
* **Allocated views** are Pixi display-object trees currently active or idle in pools.
* **Active visible views** intersect expanded viewport bounds.
* **Active culled views** remain live for expiry and state updates but skip decorative work.
* **Idle pooled views** are reset objects retained within pool limits.
* **Cached textures** are cache-owned texture entries.
* **Leased textures** have positive lease counts and cannot be evicted.
* **Static resource rebuilds** count grid/map/baked resource rebuilds caused by epoch, static revision, resize, or quality generation.

## Budgets and policies

| Resource | Policy |
| --- | --- |
| Active ship views | One per authoritative live ship; supports documented match limits and temporary peaks. |
| Idle ship views | Bounded pool; trim after peak load and never destroy active ships. |
| Projectile views | One active view per projectile id when present; high-churn idle pools are bounded. |
| Effect and text views | Explicit expiry; decorative density follows quality profile; idle pools are bounded. |
| Component textures | Lease-counted cache; zero-lease entries trim with an LRU-like Map order cap. |
| Ship composition textures | Structural key includes design, rotations, trim colour, quality generation, art version. |
| Zero-lease retention | Retained only until cache cap, stale generation invalidation, room cleanup, or teardown. |
| Structural rebuilds | Only structural key changes rebuild; compact, HP, heat, weapon-angle, and selection updates do not. |
| Static map rebuilds | Epoch, static revision, quality generation, or screen-dependent resize only. |
| Diagnostics | Bounded history; no full snapshots or private player details; not serialized every frame. |

## Texture ownership

Texture caches own shared textures. Views borrow leases and release them on pool release or teardown; views destroy sprites with texture destruction disabled. Active leased entries are protected from trimming. Quality changes advance the generation: old generation textures remain while leased and are destroyed after the final release. Duplicate lease releases are detected in diagnostics and never decrement below zero.

## Culling and offscreen policy

Culling uses pure geometry (circles, rectangles, and lines/trails) against expanded viewport bounds. Margins cover ships, shields, selection rings, weapon barrels, projectiles, trails, explosions, floating text, objectives, asteroids, and clouds. Invalid bounds fail visible. Culled is distinct from expired and released: offscreen entities still expire, release promptly, and re-enter with current colour, damage, heat, weapon angle, engine state, and selection.

## Quality profiles

Low caps DPR at 1.25, uses 1.5 bake scale, and reduces decorative particle/trail density while retaining projectiles, selection, ownership, damage, and warnings. Medium caps DPR at 1.5 and uses balanced 2.0 bake scale. High caps DPR at 2.0, uses 2.5 bake scale, and enables the richest bounded effects. Manual switching persists in existing settings storage and advances texture generation without touching networking state.

## Section 10C2 active-match Chromium renderer verification

Section 10C2 replaces menu-only renderer checks with real active-match load. The performance browser test launches `server.js`, the production frontend, real WebSockets/MessagePack, Chromium and Pixi/WebGL, then drives deterministic startup, warm-up, normal-load, heavy-load, culling and cleanup/transition phases. A scenario is invalid unless authoritative ships, visual ships, active ship views, visible entities and texture entries are non-zero after warm-up.

Frame diagnostics distinguish `rendererWorkMs` (time spent executing the Pixi update) from `callbackIntervalMs` and `callbackHz` (ticker/requestAnimationFrame cadence), so tests never infer displayed FPS from renderer work duration. Bounded phase buckets cover startup, warm-up, steady, transition and cleanup.

The WebGL context check now loses and restores context during an active match, verifies networking and authoritative state survive while unsafe rendering stops, and exercises the bounded fatal-frame diagnostic path. The dedicated renderer soak runs at least three complete active gameplay cycles with entity churn, camera/selection/minimap-style input, viewport resizing, quality changes, full-state recovery, epoch/lobby transitions and resource measurements at load and cleanup.

## Section 10B2 Chromium renderer verification

Section 10B2 adds real Chromium/WebGL diagnostics and CI coverage for renderer performance, DPR/viewport/quality matrices, resize stability, visibility handling, WebGL context lifecycle, fatal-frame diagnostics, and bounded renderer soak artifacts. Performance acceptance is CI-safe: tests require WebGL initialization, continued frame production, finite camera/viewport transforms, one ticker/application, bounded texture and pool counters, stable scene counts, and no fatal frame/page/console errors; they do not claim universal 60 FPS on shared GitHub runners.

The browser diagnostics exposed as `window.__mfaRenderer.diagnostics()` are read-only, bounded, serializable summaries and intentionally omit resume credentials, private tokens, and full private snapshots. Frame measurements are split into startup, warm-up, steady, transition, and cleanup phases so texture-bake startup frames are not used as steady-state performance.

CI runs `verify-renderer-performance-browser.js` and `verify-webgl-context-browser.js` with the normal browser group, and runs `npm run test:renderer-soak` in a separate real-Chromium job. Failure artifacts are written under `test-artifacts/` with screenshots, diagnostics, reports, server logs, viewport, DPR, quality, pool, texture, scene and console data where available.


## Test taxonomy and CI ownership

Renderer tests are split by runtime dependency. Deterministic renderer structure, pool, culling, texture and quality checks run in non-browser suites and in `npm run test:all-non-browser`. Browser renderer checks (`verify-renderer-input-browser.js`, `verify-renderer-performance-browser.js`, `verify-webgl-context-browser.js`, `verify-pixi-lifecycle.js`, and the short `verify-renderer-interaction-soak.js`) run under `npm run test:browser` and require Playwright Chromium plus WebGL. The long production renderer soak is isolated behind `npm run test:renderer-soak`; it is not included in the server soak group and is owned by the dedicated renderer-soak CI job.
