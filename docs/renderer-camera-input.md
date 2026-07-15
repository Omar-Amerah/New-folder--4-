# Renderer, Camera, Input, and Selection

Section 10A keeps the arena renderer Pixi-only and makes one transform chain authoritative:

1. Networking accepts full/compact MessagePack snapshots, state epochs, snapshot sequences, and `simulationTimeMs`.
2. Render interpolation stores a bounded per-ship history of accepted authoritative transform samples only.
3. Pixi consumes temporary visual ship transforms from interpolation; gameplay state is not mutated.
4. Camera owns all world/screen/minimap conversion: world state -> camera centre/zoom -> Pixi world-root pivot/position/scale -> CSS canvas coordinates -> renderer pixels.
5. Input uses CSS canvas coordinates and calls camera helpers instead of duplicating transform math.
6. Selection hit testing uses visual/interpolated positions first and authoritative positions only as fallback.
7. Pixi owns scene-graph objects, pools, texture leases, and selection marker drawing.

## Coordinate spaces

- **Authoritative world**: server snapshot positions in world units.
- **Render history**: accepted samples keyed by epoch, sequence, simulation time, receive time, and ship id.
- **Rendered entity state**: delayed interpolation at `latestSimulationTimeMs - 100ms`, with extrapolation capped at 80ms.
- **Camera**: centre `{x,y}` plus zoom. Bounds clamp by visible half-width/half-height; if the viewport is larger than the world on an axis, that axis is centred.
- **Pixi world root**: `position = screen centre`, `scale = zoom`, `pivot = camera centre`.
- **CSS canvas**: pointer coordinates are client/CSS pixels using `getBoundingClientRect()`.
- **Renderer pixels**: Pixi resolution follows the DPR cap; gameplay input never uses renderer backing pixels.
- **Minimap**: linear map between minimap local CSS coordinates and world dimensions.

## Controls and semantics

- Mouse wheel zoom is cursor-anchored and normalized for wheels and trackpads.
- Middle drag or Space + left drag pans and disables follow.
- `F` re-enables follow for selected living ships, otherwise the owned living fleet.
- `0` resets zoom to automatic fit. `C` centres selected ships or the owned fleet.
- Click selection replaces selection; Shift-click toggles a ship.
- Drag selection replaces selection; Shift-drag is additive-only.
- `Q` selects all owned living ships. Escape clears selection and active gestures.

## Input isolation and lifecycle

Canvas listeners are idempotent and return an unbind function. Canvas replacement unbinds the old canvas and binds the replacement once. Pointer cancel, lost capture, blur, hidden document, teardown, and Escape clear active drags/pans so no delayed command or stuck rectangle remains. Commands are accepted only from events whose target is the arena canvas.

## Deferred Section 10B work

Section 10B should focus on deeper culling, pool sizing, texture-cache pressure, render-quality heuristics, and long-duration performance telemetry after the correctness contracts above remain stable.

## Section 10B1 renderer performance notes

Renderer internals now use bounded pools, conservative pure-geometry culling, lease-owned texture caches, deterministic structural revision keys, and explicit Low/Medium/High quality profiles. Static Pixi map resources rebuild only for epoch/static-revision/quality/resize causes, while compact snapshots, HP/heat deltas, weapon-angle changes, and selection changes remain dynamic updates. Detailed browser performance scenarios, long-running soak, visibility/background-tab behaviour, context-loss recovery, and CI performance artifacts remain deferred to Section 10B2; see `docs/renderer-performance.md`.

## Section 10B2 Chromium renderer verification

Section 10B2 adds real Chromium/WebGL diagnostics and CI coverage for renderer performance, DPR/viewport/quality matrices, resize stability, visibility handling, WebGL context lifecycle, fatal-frame diagnostics, and bounded renderer soak artifacts. Performance acceptance is CI-safe: tests require WebGL initialization, continued frame production, finite camera/viewport transforms, one ticker/application, bounded texture and pool counters, stable scene counts, and no fatal frame/page/console errors; they do not claim universal 60 FPS on shared GitHub runners.

The browser diagnostics exposed as `window.__mfaRenderer.diagnostics()` are read-only, bounded, serializable summaries and intentionally omit resume credentials, private tokens, and full private snapshots. Frame measurements are split into startup, warm-up, steady, transition, and cleanup phases so texture-bake startup frames are not used as steady-state performance.

CI now runs `npm run test:renderer-performance` and `npm run test:webgl-context` with the normal browser group, and runs `npm run test:renderer-soak` in a separate real-Chromium job. Failure artifacts are written under `test-artifacts/` with screenshots, diagnostics, reports, server logs, viewport, DPR, quality, pool, texture, scene and console data where available.

