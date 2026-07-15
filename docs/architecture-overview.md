# Architecture overview (as-built)

Baseline commit: `1cbe39dad0a139b6c58476be60a124ef93ead972`.

This documents the architecture **as it exists today**, not a redesign. Modular
Fleet Arena is an authoritative-server multiplayer browser game: a dependency-light
Node server simulates everything; browsers render interpolated snapshots with PixiJS.

Runtime dependencies are deliberately minimal: `@msgpack/msgpack` and `pixi.js`
(both vendored into `public/vendor/` at build time); `playwright` is dev-only.

## A. Runtime topology

```
Netlify (static)                       Long-running Node host (Render/Railway/VPS/…)
┌──────────────────────────┐           ┌─────────────────────────────────────────┐
│ public/ (index.html,     │  wss://   │ server.js                               │
│ ES modules, vendored     │──────────▶│  • HTTP static file server (same public/)│
│ pixi + msgpack bundles)  │  /socket  │  • hand-rolled RFC 6455 WebSocket server │
└──────────────────────────┘           │  • 30 Hz simulation tick                 │
                                       │  • 15 Hz MessagePack snapshot broadcast  │
                                       └─────────────────────────────────────────┘
```

- **Two deployment modes.** (1) Single host: `node server.js` serves `public/`
  *and* the WebSocket endpoint. (2) Split: Netlify serves the static frontend and
  the browser connects to a separately deployed backend via
  `?server=wss://…` (persisted to localStorage). `netlify.toml` publishes
  `public/` with an SPA redirect.
- **Authoritative server.** All game state lives in server memory (`rooms` Map).
  Clients send *intents* (join, deploy, command, buyShip…); the server validates
  and mutates rooms; clients never simulate authoritatively.
- **Client rendering role.** The client stores the latest snapshot, interpolates
  visual ship poses between snapshots (`visualShips`, `renderInterpolation.js`),
  and renders with Pixi at display refresh rate, independent of the 15 Hz
  snapshot rate.
- **Tick independence.** Server tick (30 Hz, `TICK_HZ`) and snapshot broadcast
  (15 Hz, `SNAPSHOT_HZ`) are separate `setInterval` loops in `server.js`; both are
  `unref()`ed. Rooms idle-expire after 15 min empty.

## B. Server modules (`src/server/`)

| Module | Responsibility |
|---|---|
| `server.js` (root) | HTTP static serving with in-memory gzip cache, `/component-balance.json`, `/debug/turrets` (dev-only diagnostics), WebSocket upgrade handshake, tick + snapshot + room-cleanup loops, per-room `tickRoom` orchestration |
| `config.js` | Ports, world sizes, tick rates, economy constants, default rules, default design, MIME map |
| `websocketServer.js` | RFC 6455 frame parse/serialize (masked client frames, 16/64-bit lengths), client registry, heartbeat pong, close frames, 64 KiB message cap |
| `wsCodec.js` | MessagePack encode/decode for the wire (binary opcode 0x2; JSON text frames tolerated inbound) |
| `messages.js` | Outbound send/broadcast (encode-once fan-out, per-team snapshot payload caching) and the **inbound message router** (`handleMessage`): join/deploy/buyShip/command/setTeam/setRules/kick/restart/… |
| `rooms.js` | Room creation, room-code generation, closed-code TTL, seeded map generation (asteroids, capture points, safe zones, clouds), rules updates |
| `players.js` | Join/leave/reconnect (10 s grace), name/team sanitisation, admin promotion, kick, phase transitions (lobby ↔ design ↔ active ↔ end) |
| `shipDesign.js` / `validation.js` | Blueprint validation (single core, connectivity, engines, cost) and message field sanitisers |
| `shipStats.js` | Derived ship stats from a blueprint (mass, thrust, power, cost, DPS…) |
| `ships.js` | Ship spawning, bot players and bot behaviour, rally points |
| `movement.js` | Ship movement integration, separation, fleet/map collision, `commandShips` order routing |
| `combat.js` | Weapon targeting/fire control, turret traverse, beams, repair, self-destruct, destroyed-ship cleanup, turret diagnostics |
| `projectiles.js` | Bullet simulation and hits |
| `heat.js` | Component heat generation, conduction network, dissipation, overheat states |
| `componentHealth.js` | Per-component HP, penetration, meltdown, engine exhaust state |
| `economy.js` | Income ticks, purchase validation, `buyShip`, fleet cost |
| `objectives.js` | Capture points, scoring, control-victory countdown |
| `snapshots.js` | Snapshot assembly: shared-per-room arrays + per-team economy visibility; static vs dynamic fields; component HP/heat delta encoding |
| `components.js` | `PARTS` catalogue; merges `component-balance.json` overrides |
| `buildInfo.js` | `SERVER_BUILD_SHA` + `PROTOCOL_VERSION` (from shared `protocolVersion.js`) |

## C. Client modules (`public/src/`)

- **Bootstrap** — `main.js`: binds DOM listeners, loads `component-balance.json`,
  initialises renderer, auto-rejoins room from URL/localStorage, 3 s ping loop.
  Exposes `window.__mfaState` / `window.__mfaNetSend` **for tests only**.
- **Global state** — `state.js`: one big mutable `state` object (socket, snapshot,
  design, selection, camera, UI flags…). Everything imports it.
- **Network** — `network.js`: WebSocket connect/close/error, MessagePack
  encode/decode (vendored UMD global, JSON fallback), server-URL resolution.
- **Message handling** — `messages.js`: routes `hello`/`joined`/`state`/`notice`/
  `purchaseResult`/…; merges snapshots (re-attaching static fields the server
  omitted from dynamic snapshots: designs, map, rules, stats; applying `chpD`
  component-HP and `componentHeatD` heat deltas); protocol/build skew reporting.
- **Lobby/UI** — `ui/*.js`: dom registry (`dom.js`), lobby management, rules,
  scoreboard, purchase bar, side panel, toasts, end-game screen, ship damage/heat
  panels, saved blueprints, loadouts.
- **Designer** — `design/*.js` + `ui/designerUi.js` + `ui/designerScreenUi.js`:
  blueprint grid editing, rotation, footprints, validation, cost, thermal analysis
  preview, localStorage blueprint persistence.
- **Game input** — `game/input.js` (pointer/keys: right-click orders, marquee
  select, Space/middle-drag pan, wheel zoom), `game/commands.js`,
  `game/selection.js` (selecting ships re-enables camera follow).
- **Camera** — `game/camera.js`: WASD/arrow pan, fleet-follow easing, world/screen
  mapping, minimap hit-testing.
- **Renderer** — `game/renderController.js` boots the Pixi backend
  (`game/pixi/*`): `pixiRenderer.js` (app/ticker/diagnostics), `pixiWorld.js`
  (map art), `pixiShips.js`/`pixiShipView.js` (pooled ship views, turret sprites),
  `pixiBake.js` (offscreen-canvas texture baking with reference counting),
  `pixiScreenUi.js`. Interpolation helpers in `game/renderInterpolation.js`,
  `game/interpolation.js`, culling in `game/viewportCulling.js`.
- **Component art/geometry** — `game/componentArt.js`,
  `game/staticComponentComposition.js`, `game/shipGeometry.js`,
  `design/footprint.js` (client) mirroring `src/server/footprint.js` (server).

## D. Shared rules (`public/src/shared/`)

Shared modules use UMD-style wrappers so both the browser (`<script>`/ESM) and the
server (`require`) consume the same logic:

- `protocolVersion.js` — **protocol version 2** (authoritative per-design-index
  `ship.weaponAngles` + build identification). Client rejects newer-than-supported
  protocols; build-SHA skew is reported but non-blocking.
- `turretRules.js` — turret traverse rates/limits shared by server fire control and
  client rendering.
- `heatRules.js` — heat state thresholds/curves shared by server heat sim and client
  heat display; `componentHeatSnapshot.js` — the `[heat,state,ratio,capacity]`
  tuple + delta stride format used on the wire by both ends.
- `engineExhaust.js` — exhaust geometry/state shared by stats and rendering.
- `math.js`, `movementStats.js`, `formatting.js`, `ids.js`, `heatDisplay.js`.
- `component-balance.json` (repo root) — the component stat source of truth;
  served by the backend at `/component-balance.json`, loaded by the server via
  `components.js` and by the client at boot (silent fallback to built-in defaults
  if unreachable).
- **Duplicated (not shared) geometry**: blueprint footprint/rotation logic exists
  both in `src/server/footprint.js`/`shipDesign.js` and
  `public/src/design/footprint.js`/`rotation.js`; component drawing geometry lives
  client-side only. Divergence here shows up as render-vs-hitbox mismatches
  (risk R5 below).

## E. Main data flow

```
user input (pointer/keys/UI)
  → client intent message            game/input.js, ui/*, network.js send()
  → WebSocket frame (MessagePack)    binary opcode 0x2; JSON tolerated
  → server framing + decode          websocketServer.js, wsCodec.js
  → message router                   messages.js handleMessage()
  → validation/sanitisation          validation.js, shipDesign.js, economy.js
  → authoritative room mutation      players.js / movement.js / economy.js / …
  → simulation tick (30 Hz)          server.js tickRoom(): bots, economy,
                                     movement, separation, collisions, support,
                                     weapons, heat, bullets, capture, scoring
  → snapshot build (15 Hz)           snapshots.js: shared arrays once per room,
                                     static fields only on "static" snapshots,
                                     component HP/heat deltas otherwise
  → MessagePack broadcast            messages.js broadcastSnapshot(), one encode
                                     per team (economy visibility)
  → client decode + merge            network.js wsDecode → messages.js: re-attach
                                     cached designs/map/rules, apply chpD/heatD
  → interpolation + render           renderInterpolation.js eases visualShips;
                                     Pixi renders at rAF; UI panels update
```

Phase flow: `lobby` (join/teams/rules/bots) → `design` (blueprint editing,
deploy = ready) → `active` (simulation + purchases) → `end` (rewards, restart or
close) — driven by `players.js` and `maybeStartMatch`.

## F. Current architectural risks (documented, deliberately not fixed here)

- **R1 — Frontend execution path (resolved in Section 1).**
  `public/index.html` loads `/src/main.js` as the single production ES-module entry.
  `netlify-build.js` no longer creates `public/client.js`; required tests no longer
  execute a regex-stripped global bundle. `verify-module-boundaries.js`,
  `verify-module-imports.js`, and `verify-production-path.js` protect this path.
- **R2 — Global mutable client state.** Every client module imports and freely
  mutates the single `state` object; there is no change tracking, making UI/render
  interactions hard to reason about and test in isolation.
- **R3 — Large message-routing modules.** `src/server/messages.js:handleMessage`
  is a single long if-chain handling every message type; `public/src/messages.js`
  mirrors this inbound. Adding message types touches shared hot files.
- **R4 — Late/circular requires.** Server modules resolve circular dependencies by
  `require()`ing inside functions (`messages.js` ⇄ `websocketServer.js` ⇄
  `players.js` ⇄ `rooms.js`). It works, but import order is load-bearing and easy
  to break.
- **R5 — Server/client duplication.** Blueprint footprint/rotation/validation and
  some movement/geometry logic exist in parallel implementations; only part is in
  `shared/`. Component geometry consistency between server hitboxes/turret barrel
  positions and client art is asserted indirectly by browser tests only.
- **R6 — Split deployments + protocol skew.** Frontend (Netlify) and backend deploy
  independently; a stale backend is a real failure mode. Mitigated by
  `protocolVersion.js` + build-SHA reporting, but only protocol *newness* blocks.
- **R7 — In-memory room persistence.** A server restart drops all rooms/matches;
  closed-room codes and reconnect grace live in process memory only.
- **R8 — Name-based reconnect identity.** Reconnection matches players by
  case-insensitive name within a room (`players.js`); a joiner with the same name
  can adopt a disconnected player's fleet — spoofable identity, no tokens.
- **R9 — Static vs delta snapshot reconstruction (partly mitigated in Section 1).** Dynamic snapshots omit designs,
  map, rules and stats; the client re-attaches them from caches keyed by ship id.
  The merge logic now lives in pure `public/src/snapshotMerge.js` helpers with
  deterministic tests for malformed and incomplete deltas. Broader reconnect race
  coverage remains deferred.
- **R10 — Browser tests depend on Playwright binaries.** All five browser tests
  need a Chromium install (portable resolution in `verify-pixi-browser-support.js`:
  `PW_CHROME` → `/opt/pw-browsers/*` → Playwright default). Without a browser the
  suite fails with an environment error — visible, but easily misread as an app
  failure. CI installs Chromium explicitly.
- **R11 — Hand-rolled WebSocket framing.** `websocketServer.js` implements RFC 6455
  by hand (no fragmentation/continuation-frame support, 64 KiB cap). Fine for the
  game's message sizes, but a protocol edge case (fragmented client frames from a
  proxy) would be silently dropped.

These are review inputs for later sections; none are addressed in this PR beyond
what test determinism strictly required.

## Section 6: movement and commands

Movement commands now have an explicit server contract in [movement-command-architecture.md](movement-command-architecture.md). The server preserves omitted-`shipIds` all-owned command behaviour, treats an explicit empty selection as no-op, rejects malformed/oversized selections safely, and plans deterministic line/wedge/clump formation slots before authoritative movement integration. Movement ticks ignore invalid `dt`, clamp/subdivide unusually large `dt`, sanitize finite pose/target state, and run stable living-ship separation after per-ship integration.

## Section 4: maps and active-match progression

Map generation is deterministic once a per-room `mapSeed` has been created. The generated seed is included in static map data so production reports can be replayed by tests. Map validation runs immediately after generation; development/test builds fail with the seed while production falls back to a minimal safe arena.

## Section 7 combat authority update

Combat remains server-authoritative. Active ticks execute bot decisions, economy,
self-destruct countdowns, destroyed-ship removal, movement, separation, map
collisions, support/repair, weapon aiming/firing, heat, projectiles, capture and
scoring in that order. Target acquisition, per-weapon fallback, point defence,
projectile impacts and destruction now use explicit deterministic tie-breaks and
idempotent finalization; see [combat-targeting-weapons.md](combat-targeting-weapons.md).

## Catch-up Part 1 architecture updates

Blueprint persistence is isolated in `public/src/design/blueprintStorage.js` with versioned envelopes and safe read/write helpers. Active-match editor saves are isolated from deployed ships: server `deploy` during active play updates only future purchase state, while `setCombatStyle` remains the explicit deployed-ship mutation command.

## Catch-up Part 2 architecture notes

Selected-fleet command authorization is centralized in `src/server/selection.js`, keeping command, style, destruct, focus, repair, and rally-adjacent movement semantics consistent. Bot decisions derive deterministic random streams from map seed, bot ID, and decision sequence so one bot's random consumption does not perturb another bot. Economy mutations remain server-authoritative through the atomic purchase executor and reward finalizer.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.

## Deterministic spawn planner

Server spawning is planned by `src/server/spawnPlanner.js`. The planner sorts stable player IDs, groups players by solo sector or team side, reserves a radius large enough for the starter fleet, and performs a bounded deterministic fallback search when a preferred slot intersects another reservation, an asteroid, a relay, or world bounds. Blue and red teams use mirrored side treatment; solo players are distributed around deterministic sectors. Failures include the map seed, player IDs, team layout, and attempted positions.

## Spawn/safe-zone plan ownership

`spawnPlanner.js` owns the deterministic spawn-region plan. `rooms.js` applies that plan to `room.map.safeZones` when rules change, players or bots alter the layout, the arena is prepared, or a rematch resets the match. `ships.js` reads planned spawns from the same cache for human and bot fleets. `combat.js` checks the generated zones with explicit `team` or `ownerId` ownership, and `snapshots.js` publishes the same `room.map.safeZones` list to clients. This removes the previous split between planner spawns and fixed legacy safe-zone layouts.

## Section 8C heat snapshots and parity

Heat is authoritative on the server and component-index aligned with immutable ship designs. Runtime snapshots expose aggregate stored heat/capacity plus full or delta component heat tuples; clients merge those tuples without reusing removed-ship arrays. Designer heat output is labelled as prediction and shares rules with runtime where applicable. See [Heat, Power and Component Health](heat-power-component-health.md).

### Section 8D thermal invariants

Runtime heat keeps immutable design indexes and physical adjacency, but effective component capacity is recalculated from living adjacent heat sinks after sink destruction or repair. Whole-ship aggregates include living components only; destroyed components may retain tuple heat for display/history. Internal transfer is debugged separately from cooling/radiation so conservation checks use generated heat minus actual heat leaving the ship. Thermal updates retain normal stalled elapsed time through bounded substeps and clamp excessive backlog at 1.6 seconds.

## Section 9A networking architecture update
The transport contract is now explicit: `/socket` upgrades to raw WebSocket, application data is production MessagePack only, client traffic is schema-validated before dispatch, and protocol version 4 join negotiation gates gameplay. The hand-rolled parser was hardened rather than replaced so deployment remains dependency-light and existing `/socket` MessagePack behavior is preserved.

## Section 10A renderer interaction model

Camera math now lives in `public/src/game/camera.js`; input, selection, Pixi, and culling call those helpers rather than recomputing coordinate conversions. The Pixi world root uses the same camera centre and zoom that pointer hit testing uses. Rendering consumes accepted snapshot timestamps through bounded render history and derives temporary visual ship transforms without mutating the authoritative snapshot.

## Section 10B1 renderer performance notes

Renderer internals now use bounded pools, conservative pure-geometry culling, lease-owned texture caches, deterministic structural revision keys, and explicit Low/Medium/High quality profiles. Static Pixi map resources rebuild only for epoch/static-revision/quality/resize causes, while compact snapshots, HP/heat deltas, weapon-angle changes, and selection changes remain dynamic updates. Detailed browser performance scenarios, long-running soak, visibility/background-tab behaviour, context-loss recovery, and CI performance artifacts remain deferred to Section 10B2; see `docs/renderer-performance.md`.

## Section 10B2 Chromium renderer verification

Section 10B2 adds real Chromium/WebGL diagnostics and CI coverage for renderer performance, DPR/viewport/quality matrices, resize stability, visibility handling, WebGL context lifecycle, fatal-frame diagnostics, and bounded renderer soak artifacts. Performance acceptance is CI-safe: tests require WebGL initialization, continued frame production, finite camera/viewport transforms, one ticker/application, bounded texture and pool counters, stable scene counts, and no fatal frame/page/console errors; they do not claim universal 60 FPS on shared GitHub runners.

The browser diagnostics exposed as `window.__mfaRenderer.diagnostics()` are read-only, bounded, serializable summaries and intentionally omit resume credentials, private tokens, and full private snapshots. Frame measurements are split into startup, warm-up, steady, transition, and cleanup phases so texture-bake startup frames are not used as steady-state performance.

CI now runs `npm run test:renderer-performance` and `npm run test:webgl-context` with the normal browser group, and runs `npm run test:renderer-soak` in a separate real-Chromium job. Failure artifacts are written under `test-artifacts/` with screenshots, diagnostics, reports, server logs, viewport, DPR, quality, pool, texture, scene and console data where available.


## G. Test runner dependency boundaries

The required suites now preserve runtime boundaries. Integration tests are browser-free module/lifecycle tests and do not launch Playwright. Server soak is also browser-free and covers deterministic simulation, heat, snapshot and network pressure checks. The browser group owns ordinary real-Chromium/WebGL/Pixi coverage. The renderer-soak group owns the long real-Chromium production renderer soak. `npm run test:all` is the complete umbrella and requires Chromium; `npm run test:all-non-browser` is the complete non-browser umbrella for clean server-only environments.
