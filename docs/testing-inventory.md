# Test inventory

Baseline commit: `1cbe39dad0a139b6c58476be60a124ef93ead972` (main, 2026-07-14).

Every automated test in this repository is a standalone `verify-*.js` Node script in
the repo root (no test framework). This document inventories all of them, what they
actually exercise, what they depend on, and how they are (or were not) wired into
npm scripts.

Test levels used below:

- **unit** — pure/module logic, imports `src/server/*` or `public/src/shared/*`
  modules directly; no server process, no sockets, no DOM.
- **module integration** — several server modules driven together in-process
  (rooms/players lifecycle with fake sockets), or the *bundled* client
  (removed in Section 1) previously executed `public/client.js` in a Node `vm` sandbox with a fake DOM.
- **server integration / protocol** — spawns the real `server.js` process and talks
  to it over real WebSockets with MessagePack.
- **browser e2e / visual** — Playwright headless Chromium loading the real frontend
  from the real server, often asserting on rendered pixels or Pixi scene state.

## Inventory

| File | Level | Purpose | Systems covered | server.js | Real WS | MessagePack | PixiJS | Playwright | DOM |
|---|---|---|---|---|---|---|---|---|---|
| `verify-movement.js` | unit | Engine stacking/thrust monotonicity; unpowered ships cannot move | ship stats, movement | – | – | – | – | – | – |
| `verify-targeting.js` | unit | Per-weapon fallback targeting keeps assigned target, fires at reachable enemies | combat targeting | – | – | – | – | – | – |
| `verify-turrets.js` | unit | Turret traverse rate, hold-fire-until-aligned, barrel-tip projectile spawn (also greps `snapshots.js` source for weaponAngles field) | combat/turrets, shared turretRules | – | – | – | – | – | – |
| `verify-heat.js` | unit | Component heat adjacency transfer, isolation across gaps, order independence | heat | – | – | – | – | – | – |
| `verify-heat-thermo.js` | unit | Hotter components shed faster; heat routes through frames to sinks | heat | – | – | – | – | – | – |
| `verify-heat-effects.js` | unit | Heat state effects on components | heat, componentHealth | – | – | – | – | – | – |
| `verify-core-reactor.js` | unit | Core destroyable, penetration front-to-back, reactor meltdown AoE | combat, componentHealth | – | – | – | – | – | – |
| `verify-combat-review.js` | unit | Core repair hull accounting; beam picks closest component on path | combat, componentHealth | – | – | – | – | – | – |
| `verify-repair-target.js` | unit | Click classification: enemy=attack focus, ally=repair target | movement/commands | – | – | – | – | – | – |
| `verify-engine-exhaust.js` | unit | Engine exhaust state from component state | shared engineExhaust, componentHealth | – | – | – | – | – | – |
| `verify-reconnect.js` | module integration | Brief disconnect keeps ships for grace period | players, rooms | – | – | – | – | – | – |
| `verify-lobby-refresh-reconnect.js` | module integration | Lobby refresh/rejoin flow with fake sockets | players, rooms | – | – | – | – | – | – |
| `verify-module-boundaries.js` | architecture | Static import/require graph and production frontend path | client/server modules | ✔ | – | – | ✔ | – | – |
| `verify-heat-panel.js` | module integration (bundle/VM) | Selected-ship Heat panel display logic against bundled client | heat display, snapshot merge | – | fake | – | import swallowed | – | fake |
| `verify-module-imports.js` | architecture regression | Temporary missing-import fixture proves checker fails unresolved imports | client ES modules | ✔ | – | – | ✔ | – | – |
| `verify-canvas-removal.js` | static source scan | Greps client sources: the removed Canvas-2D arena backend must not resurface | render architecture guard | – | – | – | – | – | – |
| `verify-runtime.js` | server integration / protocol (**baseline smoke**) | Two real WS clients: join, admin, bots, rules, design phase, invalid-design rejections, deploy, active match, economy, kick rejection, finite ship state | rooms, players, lobby rules, shipDesign, economy, snapshots, protocol | ✔ spawned | ✔ | ✔ | – | – | – |
| `verify-turret-render.js` | browser e2e / visual | Pixi turret sprites track authoritative weapon angles; screenshot pixel diffs | Pixi renderer, turret art, weaponAim | ✔ spawned | – (synthetic snapshots) | – | ✔ | ✔ | ✔ |
| `verify-pixi-lifecycle.js` | browser e2e | Pixi texture reference-counting, pool recycling, teardown/reinit via live diagnostics | Pixi renderer lifecycle | ✔ (via helper) | – (synthetic snapshots) | – | ✔ | ✔ | ✔ |
| `verify-live-turrets.js` | browser e2e (full stack) | Real Chromium client + real Node WS enemy over the live protocol; turret tracking with **no** injected angles | server combat, snapshots, protocol, Pixi rendering | ✔ spawned | ✔ | ✔ | ✔ | ✔ | ✔ |
| `verify-match-start-render.js` | browser e2e (full stack) | Lobby → design → active over the real protocol; arena visibly renders; camera input semantics; WebGL context health | full match flow, renderer, input/camera | ✔ spawned | ✔ | ✔ | ✔ | ✔ | ✔ |
| `verify-blueprint-mobile-scroll.js` | browser e2e (layout) | Blueprint designer overlay scroll/layout at 3 mobile viewports + desktop | designer UI layout | ✔ spawned | – | – | – | ✔ | ✔ |
| `verify-pixi-browser-support.js` | shared helper (not a test) | Portable Chromium resolution, throwaway server, in-page snapshot-injection helpers | – | spawns for callers | – | – | – | – | – |
| `_heatcheck.js` | dead script | One-off local debug probe; hardcodes a Windows Chrome path and requires `puppeteer-core`, which is **not a dependency** — cannot run in this repo | – | – | – | – | – | – |

## npm script coverage (before this change)

| File | `npm run check` | `npm run verify` | other npm script | none |
|---|---|---|---|---|
| verify-canvas-removal.js | executed | executed | `test:canvas-removal` | |
| verify-lobby-refresh-reconnect.js | executed | – | `test:reconnect` | |
| verify-runtime.js | syntax-check only | executed | – | |
| verify-client-ui.js | syntax-check only | executed | – | |
| verify-heat-panel.js | syntax-check only | executed | `test:heat`, `test:heat-panel` | |
| verify-turret-client.js | retired bundle/VM harness | not in required suites | – | replaced by ES-module architecture checks |
| verify-turret-render.js | executed (via `test:pixi-browser`) | executed | `test:turret-render`, `test:pixi-browser` | |
| verify-pixi-lifecycle.js | executed (via `test:pixi-browser`) | executed | `test:pixi-lifecycle`, `test:pixi-browser` | |
| verify-live-turrets.js | syntax-check only | executed | `test:live-turrets` | |
| verify-match-start-render.js | – | executed | `test:match-start-render` | |
| verify-movement.js | – | – | `test:movement` | |
| verify-targeting.js | – | – | `test:targeting` | |
| verify-turrets.js | – | – | `test:turrets` | |
| verify-heat.js | – | – | `test:heat` | |
| verify-heat-thermo.js | – | – | `test:heat-thermo` | |
| verify-heat-effects.js | – | – | `test:heat-effects` | |
| verify-core-reactor.js | – | – | `test:core-reactor` | |
| verify-combat-review.js | – | – | `test:combat-review` | |
| verify-repair-target.js | – | – | `test:repair-target` | |
| verify-engine-exhaust.js | – | – | `test:engine-exhaust` | |
| verify-reconnect.js | – | – | `test:reconnect` | |
| verify-blueprint-mobile-scroll.js | – | – | – | ✔ never invoked |
| _heatcheck.js | – | – | – | ✔ never invoked (cannot run) |

Key observations:

- **All ten unit tests (movement, targeting, turrets, heat×3, core-reactor,
  combat-review, repair-target, engine-exhaust) and `verify-reconnect.js` were not
  part of `check` or `verify`** — the fastest, most deterministic tests in the repo
  were the ones normal verification skipped.
- `npm run check` gave several test files **syntax checking only** (`node --check`),
  which proves nothing about behaviour. A reader of the old `check` script could
  easily believe `verify-runtime.js` was being executed; it was only parsed.
- `verify-blueprint-mobile-scroll.js` was wired to no script at all, and had two
  bugs that meant it could never pass (see baseline review).
- `_heatcheck.js` is dead: it needs `puppeteer-core` (not in `package.json`) and a
  hardcoded `C:/Program Files/...` Chrome path. Left in place, documented here;
  candidate for deletion in a later cleanup PR.

## Duplicates and near-duplicates

- `test:pixi-browser` = `verify-turret-render.js` + `verify-pixi-lifecycle.js`;
  both also have individual aliases. Not duplicate coverage, only duplicate wiring.
- `verify-turret-render.js` (synthetic snapshots, injected angles) vs
  `verify-live-turrets.js` (real protocol, no injection): deliberately complementary,
  not duplicates — the files themselves document this split.
- `verify-runtime.js` covers the lobby→active flow at protocol level;
  `verify-match-start-render.js` covers the same flow through a real browser with
  rendering assertions. Complementary levels of the same journey.
- `verify-heat.js` and `verify-heat-thermo.js` overlap on heat transfer basics but
  assert different properties (adjacency/ordering vs temperature-gradient routing).

## Misleading names / traps

- The old `check` mixed three different kinds of work (build, syntax parse, one
  static scan, one integration test, and a ~80s browser suite). It has been narrowed
  to build + static/syntax validation; behavioural suites live under `test:*`.
- `test:heat` runs `verify-heat.js` **and** `verify-heat-panel.js` (a bundle/VM UI
  test that requires `npm run build` first) — the name suggests unit heat logic only.
- `verify-canvas-removal.js` is not a behavioural test; it is a source grep guard.
- The bundle/VM tests (`verify-client-ui.js`, `verify-heat-panel.js`,
  retired VM harnesses fail confusingly if re-run without the obsolete generated bundle or
  missing; they test the *generated bundle*, not the ES modules that
  `public/index.html` actually loads in production (see architecture risks).

## New grouping (this PR)

`tools/run-tests.js` defines the canonical groups; package.json wires them:

- `npm run test:unit` — the ten unit tests above.
- `npm run test:integration` — reconnect ×2 + the three bundle/VM tests (builds first).
- `npm run test:protocol` / `npm run test:smoke` — `verify-runtime.js`.
- `npm run test:browser` — the five Playwright tests (builds first).
- `npm run test:all` — `check` + unit + integration + protocol + browser.
- `npm run check` — build + `node --check` syntax validation + the static
  canvas-removal scan only.
- All previous `test:*` aliases are retained unchanged.


## Section 1 additions

- `npm run test:architecture` runs `verify-module-boundaries.js`.
- `npm run test:module-imports` proves missing client imports fail a required check.
- `npm run test:snapshot-merge` covers pure static-field and delta reconstruction helpers.
- `npm run test:shared-parity` compares client/server deterministic footprint rules and shared heat tuple constants.
- `npm run test:production-path` builds, starts the real server, requests `public/index.html`, verifies `/src/main.js`, and asserts obsolete `public/client.js` is absent.

## Section 4 map/objective tests

- `npm run test:maps` / `node verify-maps-objectives.js`: deterministic map generation, generated-map validation, asteroid-density coverage, team/solo capture, contested capture, relay score, and full-control ownership checks.

## Section 6 movement additions

`node verify-movement.js` now covers command selection semantics, enemy-ID rejection, deterministic formation planning, obstacle-adjusted slots, movement `dt` safety/sanitization, exact-overlap ship separation, and clear-point metadata in addition to the pre-existing engine/stat and route-clearance checks.

## Section 7 combat tests

`verify-combat-determinism.js` was added to the fast unit suite and to the new
combat npm aliases. It covers allegiance matrices, ship-level and per-weapon
stable target tie-breaking, point-defence protected-ship priority, destruction
idempotency and swept projectile asteroid-first precedence with deterministic seed
`1234`.

## Catch-up Part 1 additions

| Command | Purpose |
|---|---|
| `npm run test:blueprint-storage` | Versioned blueprint-storage envelopes, legacy migrations, corrupt JSON, unknown versions, unavailable storage, quota failures, and idempotence. |
| `npm run test:blueprint-parity` | Client/server shared blueprint parity checks. |
| `npm run test:component-indexes` | Snapshot merge/static reconstruction component-index alignment checks. |
| `npm run test:lifecycle` | Deterministic reconnect/lifecycle coverage. |
| `npm run test:spawn-planner` | Spawn/map invariant verifier entry point. |
| `npm run test:map-invariants` | Map invariant verifier entry point. |
| `npm run test:objectives` | Objective/scoring verifier entry point. |

Only the commands above that are wired to executable verifier scripts are documented here.

## Catch-up Part 2 focused commands

- `npm run test:selection` covers selected-fleet normalization, explicit empty selections, malformed destruct, duplicate collapse, mixed enemy/owned IDs, and self-destruct idempotency.
- `npm run test:economy-sequence` runs a seeded economy sequence with income, purchase success/failures, replay/conflict, reward idempotency, and orphan checks.
- `npm run test:bots` covers deterministic bot think intervals, movement offsets, safe empty objectives, winner stop, and failed bot purchases.
- `npm run test:movement` covers movement command normalization and deterministic movement scenarios.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.

## Section 8 catch-up truthful taxonomy

- `npm run test:spawn-planner` now runs `verify-spawn-planner.js`, a dedicated deterministic planner suite for solo counts 1, 2, 3, 4, 5, 8 and 12; 1v1; balanced teams; 7v1; 10v2; mixed human/bot rooms; large starter reservations; obstructed preferred positions; deterministic replay; and no-legal-placement failure reporting.
- `npm run test:blueprint-parity` now runs `verify-blueprint-parity.js`. It loads the server-normalized component catalogue into the client preview and compares authoritative design-time stats with explicit tolerances: exact for integer/stat fields, 1 unit for rounded acceleration/effective thrust, and 0.01 for rounded speed/turn displays. Client warnings remain display-only copy and are not an exact authoritative parity field.
- `npm run test:component-indexes` now runs `verify-component-indexes.js`, covering design creation, spawn, full and dynamic snapshots, component damage/destruction/repair deltas, heat deltas, reconnect reconstruction, ship removal, and new-ship cache isolation.
- `npm run test:protocol` now executes only `verify-runtime.js`, the combined real-network protocol smoke test. Dedicated purchase and movement protocol wrappers were removed because they did not add focused assertions.
- `npm run test:objectives` and `npm run test:match-progression` still point at `verify-maps-objectives.js`; this remains a focused map/objective invariant suite and broader objective/victory coverage is deferred to the Section 13 final regression pass rather than overstated here.

## Spawn/protocol correction before Section 8

`npm run test:spawn-planner` now exercises the real deterministic spawn/safe-zone plan for 1, 2, 3, 4, 5, 8 and 12 solo players; 1v1, balanced, 7v1 and 10v2 teams; mixed humans and bots; large ships; large starter quantities; obstructed preferred positions; deterministic replay; rematch/layout cache invalidation; impossible-layout diagnostics; and direct combat safe-zone policy checks.

The duplicate protocol wrapper commands `test:purchases-protocol` and `test:movement-protocol` were removed because they only required `verify-runtime.js` and did not provide dedicated purchase or movement protocol assertions. `npm run test:protocol` now truthfully runs the single real-network protocol smoke test, `verify-runtime.js`, once. Focused purchase and movement protocol scenarios remain deferred until genuine harness-backed tests are added; broader final regression belongs to Section 13, while Section 8 is heat, power and component health.

## Section 8C focused heat commands

- `npm run test:heat-protocol` — real server snapshot builders plus MessagePack round trip, component heat delta merge, reconnect/reset and deterministic meltdown assertions.
- `npm run test:heat-browser` — focused live Heat panel assertions for fractional percentages, component selection, mobile taps and stale-readout prevention.
- `npm run test:heat-soak` — deterministic high-entity soak covering mixed thermal gameplay with bounded state and performance telemetry.

## Section 8D required heat test taxonomy

- Unit/runtime: `verify-thermal-topology.js`, `verify-heat-transfer.js`, `verify-heat-cooling.js`, `verify-heat-effects.js`, `verify-power.js`, `verify-component-health.js`, `verify-meltdown.js` run in `npm run test:unit` and therefore `npm run test:all`.
- Protocol/integration: `verify-heat-protocol.js` runs in `npm run test:protocol` against real `server.js`, WebSockets and MessagePack.
- Browser: `verify-heat-browser.js` runs in `npm run test:browser` against the production frontend in Playwright Chromium; missing Chromium is a hard failure.
- Soak: `verify-heat-soak.js` runs in `npm run test:soak` with dedicated thermal assertions rather than aliasing the generic soak.

## Browser verifier repair notes (Section 8 follow-up)

The Section 8 browser job failure was isolated to the required Playwright group (`npm run test:browser`), which runs `verify-live-turrets.js` followed by `verify-heat-browser.js` after a production build. Static, unit, integration, protocol, smoke, and soak checks had already passed, and the CI browser-install step completed, so the repair stayed focused on browser verifier determinism and diagnostics rather than networking or gameplay redesign.

Root cause: the browser verifiers still had brittle shared-state assumptions. `verify-live-turrets.js` used a fixed port (`5603`) and fixed room (`TRRTE2E`), while `verify-heat-browser.js` used a fixed port (`32188`) plus a terse one-line harness with fixed waits. Those choices made failures hard to diagnose and left the heat browser assertions exposed to stale client state immediately after heat changed. The heat verifier now waits for a full authoritative snapshot containing the selected ship, design, and component heat before opening the Heat tab, waits for the browser snapshot to contain the same heated ship before asserting UI text, and sends its movement command for the selected ship explicitly.

Current required browser coverage:

- `verify-live-turrets.js` starts a real Node server, opens the production frontend in Playwright Chromium, joins an opposing real WebSocket/MessagePack client, starts a real match, verifies rendered ships, movement to engagement positions, target acquisition, authoritative turret rotation, and projectile direction. It now uses a unique room and safely allocated per-process port by default and records room, port, player IDs, ship IDs, screenshots, server output, page errors, console errors, failed requests, WebSocket errors, and snapshot summaries on failure.
- `verify-heat-browser.js` starts its own real Node server, opens the production frontend in Playwright Chromium, joins a real WebSocket/MessagePack bot, starts a real match, verifies authoritative heat data, Heat panel rendering, fractional heat percentages, component selection, and that Heat panel interaction does not issue an unintended battlefield movement command. It now uses a unique room and safely allocated per-process port by default and writes `failure.png`, `diagnostics.json`, and `server.log` under the browser artifact directory on failure.

Chromium setup remains a hard requirement for CI. The browser job runs `npm ci`, then `npx --no-install playwright install --with-deps chromium` so the downloaded Chromium revision matches the Playwright package version from `package-lock.json`, then runs the real browser group. Failure artifacts are uploaded from `test-artifacts/` and `/tmp/mfa-*` only after a failed job step; artifact upload does not mask the browser command exit code.

## Section 9A networking tests
- `npm run test:websocket-frames` covers raw frame boundaries, masking, RSV/opcode rejection, fragmentation policy, control-frame limits, coalescing and maximum payloads.
- `npm run test:protocol-schema` covers the accepted message registry and logical bounds.
- `npm run test:network-connections` covers protocol compatibility decisions.
- `npm run test:network-protocol` covers real MessagePack encode/decode policy.
- `npm run test:network-browser` statically verifies production client stale-socket generation and no JSON send fallback.

## Section 9B snapshot tests

- `npm run test:snapshot-contract` exercises pure full/compact merge contracts, epoch/sequence rejection, static-revision mismatch, malformed deltas, removed/new ships, replacement entity IDs, privacy-compatible immutable state, and duplicate/stale/gap handling.
- `npm run test:snapshot-resync` covers client rejection reasons that request a full state.
- `npm run test:network-backpressure` covers deterministic transport write backpressure framing behavior.
- `npm run test:network-soak` maps to the existing soak runner for sustained network/gameplay coverage.

## Section 10A tests

- `npm run test:camera` covers pure camera transforms, viewport clamps, cursor zoom, and minimap parity.
- `npm run test:input` covers idempotent binding, canvas replacement, cancellation, and anchored wheel zoom with DOM doubles.
- `npm run test:interpolation` covers timestamped render history, interpolation, bounded extrapolation, epoch reset, and snapshot immutability.
- `npm run test:renderer-browser` runs a real Chromium/WebGL smoke matrix at 900x700, 1280x900, and 1600x900.
- `npm run test:renderer-soak` runs a bounded Chromium interaction soak.

## Section 10B1 renderer performance notes

Renderer internals now use bounded pools, conservative pure-geometry culling, lease-owned texture caches, deterministic structural revision keys, and explicit Low/Medium/High quality profiles. Static Pixi map resources rebuild only for epoch/static-revision/quality/resize causes, while compact snapshots, HP/heat deltas, weapon-angle changes, and selection changes remain dynamic updates. Detailed browser performance scenarios, long-running soak, visibility/background-tab behaviour, context-loss recovery, and CI performance artifacts remain deferred to Section 10B2; see `docs/renderer-performance.md`.

## Section 10B2 Chromium renderer verification

Section 10B2 adds real Chromium/WebGL diagnostics and CI coverage for renderer performance, DPR/viewport/quality matrices, resize stability, visibility handling, WebGL context lifecycle, fatal-frame diagnostics, and bounded renderer soak artifacts. Performance acceptance is CI-safe: tests require WebGL initialization, continued frame production, finite camera/viewport transforms, one ticker/application, bounded texture and pool counters, stable scene counts, and no fatal frame/page/console errors; they do not claim universal 60 FPS on shared GitHub runners.

The browser diagnostics exposed as `window.__mfaRenderer.diagnostics()` are read-only, bounded, serializable summaries and intentionally omit resume credentials, private tokens, and full private snapshots. Frame measurements are split into startup, warm-up, steady, transition, and cleanup phases so texture-bake startup frames are not used as steady-state performance.

CI now runs `npm run test:renderer-performance` and `npm run test:webgl-context` with the normal browser group, and runs `npm run test:renderer-soak` in a separate real-Chromium job. Failure artifacts are written under `test-artifacts/` with screenshots, diagnostics, reports, server logs, viewport, DPR, quality, pool, texture, scene and console data where available.


## Section 10 test taxonomy correction

The grouped runner now treats browser/runtime dependencies as the source of truth, not verifier filenames. `npm run test:integration` is browser-free: it runs reconnect, lobby refresh/reconnect, lifecycle, input lifecycle and deterministic renderer structural update checks only. `verify-pixi-lifecycle.js` was moved out because it imports Playwright, launches Chromium, and validates real WebGL/Pixi lifecycle behavior.

`npm run test:soak` is now the deterministic server-soak suite (`verify-soak.js`, `verify-heat-soak.js`, snapshot contract/resync, and network backpressure/soak checks). It no longer runs `verify-renderer-interaction-soak.js` or `verify-renderer-soak.js`, both of which launch Chromium.

Chromium ownership is split deliberately:

- `npm run test:browser` owns normal browser coverage: live turrets, heat browser, renderer input browser, Pixi lifecycle, renderer performance, WebGL context, and the retained short renderer interaction stress test.
- `npm run test:renderer-soak` owns only the long renderer soak (`verify-renderer-soak.js`) and requires real Chromium, WebGL, Pixi and the production frontend.
- `npm run test:all` is the complete umbrella and therefore requires Chromium.
- `npm run test:all-non-browser` is the complete non-browser umbrella: `check`, unit, integration, protocol, smoke, deterministic server soak, snapshot/network checks, and deterministic renderer pool/culling/texture/quality/structure tests. It must not launch Playwright Chromium.

The short `verify-renderer-interaction-soak.js` is retained in the browser group as a one-pass browser interaction stress diagnostic. It is not part of server soak, and the long `verify-renderer-soak.js` remains isolated in the renderer-soak group so CI does not execute it twice.


## Section 11A server composition notes

Server startup is now exposed through `createGameServer(options)` in `server.js`, while production CLI behaviour remains `node server.js`. Inbound route metadata lives in `src/server/routeRegistry.js`; outbound queues live in `src/server/outbound.js`; snapshot delivery lives in `src/server/snapshotDelivery.js`; deterministic tick ordering lives in `src/server/simulation.js`. Section 11B still owns WebSocket fragmentation and low-level RFC 6455 parser hardening.

## Section 11B WebSocket transport notes

WebSocket transport hardening is documented in `docs/websocket-transport.md`. The server now validates the RFC 6455 version-13 upgrade before sending `101`, supports exact allowlisted origins for split frontend/backend deployments, rejects production text frames, reconstructs fragmented binary messages before MessagePack decode, accepts interleaved control frames, validates close payloads and UTF-8 close reasons, and bounds unread and aggregate message buffers. New transport checks cover handshake, fragmentation, lifecycle, fuzz, and soak behaviour through the `test:websocket-*` scripts.

## Section 6E Data-support balance validation

- `verify-data-support-balance.js` validates canonical reference ships, Data allocation invariants, redundancy, isolated networks, and deterministic fixture construction.
- `tools/data-support-balance-report.js` provides deterministic informational balance output through `npm run balance:data-support` and optional `--json`.
- `tools/run-tests.js unit` includes the Section 6E verifier in the browser-free unit group.
