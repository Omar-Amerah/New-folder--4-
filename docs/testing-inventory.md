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
