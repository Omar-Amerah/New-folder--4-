# Section 0 — Baseline architecture & test-infrastructure review

- **Baseline commit reviewed:** `1cbe39dad0a139b6c58476be60a124ef93ead972`
  (`main`, merge of PR #122).
- **Environment:** Linux, Node v22.22.2, npm 10.9.7, Playwright Chromium available.
- Companion documents: [architecture-overview.md](architecture-overview.md),
  [testing-inventory.md](testing-inventory.md).

## 1. Baseline results (unmodified main)

`npm ci` and `npm run build` pass. Every test script was then executed
individually. Durations are from this machine; browser tests dominate.

| Command | Result on main | Duration | Classification |
|---|---|---|---|
| `node verify-movement.js` | pass | 0.09 s | executed, passed |
| `node verify-targeting.js` | pass | 0.07 s | executed, passed |
| `node verify-turrets.js` | pass | 0.09 s | executed, passed |
| `node verify-heat.js` | pass | 0.18 s | executed, passed |
| `node verify-heat-thermo.js` | pass | 0.07 s | executed, passed |
| `node verify-heat-effects.js` | pass | 0.07 s | executed, passed |
| `node verify-core-reactor.js` | pass | 0.08 s | executed, passed |
| `node verify-combat-review.js` | pass | 0.10 s | executed, passed |
| `node verify-repair-target.js` | pass | 0.08 s | executed, passed |
| `node verify-engine-exhaust.js` | pass | 0.08 s | executed, passed |
| `node verify-reconnect.js` | pass | 0.05 s | executed, passed |
| `node verify-lobby-refresh-reconnect.js` | pass | 0.12 s | executed, passed |
| `node verify-canvas-removal.js` | pass | 0.07 s | executed, passed (static scan) |
| `node verify-client-ui.js` | pass | 0.36 s | executed, passed |
| `node verify-heat-panel.js` | pass | 0.16 s | executed, passed |
| `node verify-turret-client.js` | pass | 0.15 s | executed, passed |
| `node verify-runtime.js` | pass | 0.47 s | executed, passed |
| `node verify-pixi-lifecycle.js` | pass | 40.2 s | executed, passed |
| `node verify-live-turrets.js` | pass | 34.2 s | executed, passed |
| `node verify-turret-render.js` | **FAIL 10/14** | 39.7 s | failed — **test-harness defect** (see F1) |
| `node verify-match-start-render.js` | **FAIL** | 26.7 s | failed — **environment-sensitive harness defect** (see F2) |
| `node verify-blueprint-mobile-scroll.js` | **FAIL** | 32.0 s | failed — **test written broken + never wired to a script** (see F3) |
| `npm run check` | **FAIL** (exit 1) | 39 s | fails at verify-turret-render |
| `npm run verify` | **FAIL** (exit 1) | 38 s | fails at verify-turret-render |

No test was silently skipped; nothing was blocked by missing dependencies in this
environment (Playwright Chromium was pre-installed — on machines without it, all
five browser tests fail with an explicit launch error rather than skipping).

**The headline baseline fact: `npm run check` and `npm run verify` exit non-zero on
unmodified `main`.** All game-logic tests pass; the failures are in test harnesses.

## 2. Findings

Severity legend — Critical: can allow broken main/deployment; High: major system
lacks realistic regression coverage; Medium: confusing/duplicated tests; Low:
naming/documentation.

### Critical

- **F1 — `verify-turret-render.js` was self-breaking, turning `check`/`verify` red
  on main.** Check 1b (added later) replaces the injected snapshot wholesale with a
  different ship; checks 2–5 still address the original `ship-blaster`, so 4 of 14
  checks fail deterministically (`Cannot read properties of undefined
  ('weaponAngles')`). With the main verification commands permanently red, real
  regressions could land unnoticed. **Fixed in this PR** (test-only): the blaster
  snapshot is re-injected before check 2. All 14 checks now pass.
- **F4 — No CI existed.** Nothing ran any test on push/PR; the broken-on-main
  `check` proves the cost. **Fixed in this PR**: `.github/workflows/verify.yml`.

### High

- **F2 — `verify-match-start-render.js` false-failed on a WebGL read, then hid
  never-run assertions.** Its black-arena probe copied the WebGL canvas with
  `drawImage`, which reads a cleared buffer once the frame is presented
  (`preserveDrawingBuffer:false`) — reporting `litRatio: 0` while the Playwright
  screenshot of the same moment shows a fully rendered arena. Because the test
  aborted there, its later camera-input assertions had never executed; once
  reachable, the "left drag must not pan" check failed because a centre-screen
  marquee selects the player's ship, and selection *intentionally* re-enables
  camera-follow (`selection.js`). **Fixed in this PR** (test-only): lit-pixel
  measurement now decodes a compositor screenshot, and the marquee drags over
  empty arena. No gameplay behaviour changed.
- **F5 — The fastest, most deterministic tests were excluded from normal
  verification.** All ten unit tests plus `verify-reconnect.js` (combat, movement,
  targeting, heat ×3, core/reactor, repair, exhaust, reconnect grace) ran only via
  individual `test:*` aliases nobody was required to run. **Fixed in this PR**:
  `test:unit` / `test:all` include them; CI runs them on every push/PR.
- **F6 — High-risk untested areas** (documented, deferred):
  - the **ES-module production frontend build path** has no dedicated test for
    module-graph integrity (browser tests exercise it implicitly; a broken import
    surfaces only as a browser-test failure);
  - **snapshot delta reconstruction** (`chpD`, `componentHeatD`, design re-attach)
    has no protocol-level test for the join-race/missed-static-snapshot path;
  - **name-based reconnect identity** (spoofable adoption of a disconnected
    player's fleet) has no adversarial test;
  - **economy edge cases** (max money, cap taxes, kill bounties) and **end-of-match
    rewards** are untested;
  - hand-rolled **WebSocket framing** has no protocol-conformance test
    (fragmentation, length edge cases).

### Medium

- **F3 — `verify-blueprint-mobile-scroll.js` could never pass and was wired to no
  npm script.** Three independent defects: (a) it clicked the designer button
  while the boot main-menu overlay intercepts pointer events (and the dismissal
  races the async bootstrap's late `openMainMenu()`); (b) it read
  `overlay.scrollLeft` *after* clicking Close — a `display:none` element reports 0;
  (c) it resolved Chromium only from `/opt/pw-browsers` or an env var, so it could
  not run on standard Playwright installs, and it defaulted to the production port
  5544. **Fixed in this PR** (test-only) and added to `test:browser`.
- **F7 — `npm run check` conflated syntax parsing with execution.** Ten files got
  `node --check` only — easily misread as "tests ran". The reorganised `check` is
  explicitly build + static/syntax validation; behavioural suites are `test:*`.
- **F8 — `verify-runtime.js` had a vacuous income assertion.** Its "money
  increased" wait scanned message history and matched an *earlier lobby-phase*
  state (starting money > active-phase money) with an empty ships array. The
  predicate now requires a later active-phase snapshot; a finite-ship-state
  assertion (required baseline smoke step) was added at the same spot.
- **F9 — Duplicated wiring/overlap.** `test:pixi-browser` duplicates two individual
  aliases; `test:heat` mixes a unit test with a build-dependent VM test. Documented
  in the inventory; aliases retained for compatibility.

### Low

- **F10 — Dead files.** `_heatcheck.js` (puppeteer-core + hardcoded Windows Chrome
  path — cannot run in this repo) and the formerly generated `public/blueprint-fix.js`
  placeholder. Section 1 removed the placeholder with the obsolete build path.
- **F11 — Naming.** `verify-canvas-removal.js` is a source grep, not a behaviour
  test; VM-harness tests test the generated bundle rather than the ES modules
  production loads (see architecture risk R1). Documentation only.

## 3. Coverage strengths

- Server combat/heat/movement logic has thorough, fast unit coverage.
- The protocol smoke (`verify-runtime.js`) exercises a genuinely real path:
  spawned server, two real WebSocket clients, MessagePack, invalid-design
  rejections, kick rejection, economy ticks.
- Browser coverage is unusually deep for a project this size: real Chromium,
  real server, pixel-level assertions, texture lifecycle diagnostics, and a
  no-injection full-stack turret test.

## 4. Changes made in this PR (and why they are safe)

All changes are tests, scripts, CI, or documentation. **No gameplay, balance,
protocol, UI, renderer, or server-logic files were modified.**

1. `verify-turret-render.js` — re-inject the blaster snapshot before check 2 (F1).
2. `verify-match-start-render.js` — screenshot-based lit-pixel probe; marquee over
   empty arena (F2).
3. `verify-blueprint-mobile-scroll.js` — wait-then-dismiss boot menu; read
   scrollLeft before closing; shared portable Chromium launcher; TEST_PORT 5621 (F3).
4. `verify-runtime.js` — later-active-snapshot predicate for the income check;
   finite ship-state assertion (F8; completes the required baseline smoke flow —
   no new duplicate smoke test was added since this file already covers the flow).
5. `package.json` — new `test:unit`/`test:integration`/`test:protocol`/
   `test:smoke`/`test:browser`/`test:all`; `check` narrowed to build+static;
   `verify` now aliases `test:all`; every legacy `test:*` alias retained;
   `engines.node >= 22` documented (`verify-runtime.js` needs the global
   `WebSocket`).
6. `tools/run-tests.js` — deterministic grouped runner: inherited stdio (nothing
   swallowed), child exit codes preserved, per-script durations, final summary,
   no retries, failures never downgraded.
7. `.github/workflows/verify.yml` — three jobs (static+unit; integration+protocol;
   browser with `npx playwright install --with-deps chromium`, screenshot/log
   artifact upload on failure, per-job timeouts, no `continue-on-error`).

## 5. Recommended order for later review sections

1. **Protocol & snapshots** (R6/R9 + F6): versioning, delta reconstruction,
   join-race behaviour — everything else is validated through this layer.
2. **Rooms/players lifecycle & reconnect identity** (R7/R8): correctness and
   abuse-resistance of join/leave/kick/reconnect.
3. **Simulation systems** in tick order: movement → combat/projectiles → heat →
   economy → objectives (each already has unit anchors to extend).
4. **Client state & renderer** (R1/R2): ES-module vs bundle unification, state
   management, Pixi lifecycle.
5. **Server internals** (R3/R4/R11): message router decomposition, require cycles,
   WebSocket framing hardening.

## 6. Deliberately deferred

- All architecture risks R1–R11 (see architecture-overview.md §F).
- Deleting `_heatcheck.js` and unused aliases.
- Any consolidation of duplicate/overlapping tests.
- Coverage for the F6 gaps (new tests belong to their system's review section).


## Section 1 reclassification

- The dual frontend path risk is resolved: `public/client.js` is no longer generated or required, and production remains `public/index.html` -> `/src/main.js`.
- Missing import detection is now required by `npm run check` through `verify-module-boundaries.js` and `verify-module-imports.js`.
- Snapshot merge risk is reduced by pure helpers and direct tests; reconnect race coverage remains deferred.
- Browser-suite execution still depends on a Playwright Chromium binary; in this environment `npx playwright install chromium` returned HTTP 403, so browser tests remain environment-limited here.
