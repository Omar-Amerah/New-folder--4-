# Architecture overview (as-built)

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
                                       │  • 20 Hz MessagePack snapshot broadcast  │
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
  and renders with Pixi at display refresh rate, independent of the 20 Hz
  snapshot rate.
- **Tick cadence.** Simulation (`TICK_HZ`) and snapshot broadcast (`SNAPSHOT_HZ`)
  run as separate timers. `TICK_HZ` is 30 Hz and `SNAPSHOT_HZ` is 20 Hz.
  This keeps the simulation steady and prevents snapshot build/encode from
  stalling the tick loop. Timers are `unref()`ed. Rooms idle-expire after 15 min empty.

## B. Server modules (`src/server/`)

| Module | Responsibility |
|---|---|
| `server.js` (root) | HTTP static serving with in-memory gzip cache, `/component-balance.generated.json`, `/debug/turrets` (dev-only diagnostics), WebSocket upgrade handshake, tick + snapshot + room-cleanup loops, per-room `tickRoom` orchestration |
| `config.js` | Ports, world sizes, tick rates, economy constants, default rules, default design, MIME map |
| `websocketServer.js` | RFC 6455 frame parse/serialize (masked client frames, 16/64-bit lengths), client registry, heartbeat pong, close frames, 64 KiB message cap |
| `wsCodec.js` | MessagePack encode/decode for the wire (binary opcode 0x2; production text frames are rejected by the transport) |
| `messages.js` | Compatibility exports for outbound sends and snapshot broadcast; it does not own inbound dispatch |
| `routeRegistry.js` / `messageRouter.js` | Complete inbound route inventory plus centralized rate, joined-client, current-attachment, phase, and admin enforcement before route handlers run |
| `outbound.js` / `snapshotDelivery.js` | Bounded per-client outbound queues and canonical full/entity-delta snapshot delivery with per-connection baselines |
| `simulation.js` | Deterministic authoritative tick ordering shared by production and focused tests |
| `rooms.js` | Room creation, room-code generation, closed-code TTL, seeded map generation (asteroids, capture points, safe zones, clouds), rules updates |
| `players.js` | Join/leave/reconnect (10 s grace), name/team sanitisation, admin promotion, kick, phase transitions (lobby ↔ design ↔ active ↔ end) |
| `shipDesign.js` / `validation.js` | Blueprint validation (single core, connectivity, engines, cost) and message field sanitisers |
| `shipStats.js` | Derived ship stats from a blueprint (mass, thrust, power, cost, DPS…) |
| `ships.js` | Ship spawning, bot players and bot behaviour, rally points |
| `movement.js` / `movementV2.js` | Command routing plus authoritative movement integration, launch-control handoff, physical separation, and map/fleet collision |
| `combat.js` | Weapon targeting/fire control, turret traverse, beams, repair, self-destruct, destroyed-ship cleanup, turret diagnostics |
| `projectiles.js` | Bullet simulation and hits |
| `heat.js` | Component heat generation, conduction network, dissipation, overheat states |
| `componentHealth.js` | Per-component HP, penetration, meltdown, engine exhaust state |
| `componentData.js` | Derived explicit Data Link allocation; reads authoritative per-component Power and Heat runtime state, treats inactive sources as zero output, and never persists runtime support into blueprints |
| `componentPower.js` | Damage-aware per-component Power allocation used by movement, shields, Heat and Data-support lifecycle refreshes |
| `economy.js` | Income ticks, purchase validation, `buyShip`, fleet cost |
| `objectives.js` | Relay capture, capture bonuses, and the full-control victory countdown |
| `snapshots.js` | Snapshot assembly: shared-per-room arrays + per-team economy visibility; static vs dynamic fields; component HP/heat delta encoding |
| `components.js` | `PARTS` catalogue; merges `component-balance.json` overrides |
| `buildInfo.js` | `SERVER_BUILD_SHA` + `PROTOCOL_VERSION` (from shared `protocolVersion.js`) |

## C. Client modules (`public/src/`)

- **Bootstrap** — `main.js`: binds DOM listeners, loads `component-balance.generated.json`,
  initialises renderer, auto-rejoins room from URL/localStorage, 3 s ping loop.
  Exposes `window.__mfaState` / `window.__mfaNetSend` **for tests only**.
- **Global state** — `state.js`: one big mutable `state` object (socket, snapshot,
  design, selection, camera, UI flags…). Everything imports it.
- **Network** — `network.js`: WebSocket connect/close/error, MessagePack
  encode/decode (vendored UMD global; missing MessagePack is fatal), server-URL resolution.
- **Message handling** — `messages.js`: routes `hello`/`joined`/`state`/`notice`/
  `purchaseResult`/…; merges snapshots (re-attaching static fields the server
  omitted from dynamic snapshots: designs, map, rules, stats; applying `chpD`
  component-HP and `componentHeatD` heat deltas); protocol/build skew reporting.
- **Lobby/UI** — `ui/*.js`: dom registry (`dom.js`), lobby management, rules,
  match status, purchase bar, side panel, toasts, end-game screen, ship damage/heat
  panels, saved blueprints, loadouts.
- **Designer** — `design/*.js` + `ui/designerUi.js` + `ui/designerScreenUi.js`:
  blueprint grid editing, rotation, footprints, validation, cost, thermal analysis
  preview, localStorage blueprint persistence. `defaultDesign()` restores the standard ship and Data Links are stored as explicit source-to-weapon pairs.
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

- `protocolVersion.js` — **protocol version 6** (canonical entity-delta snapshots,
  authoritative per-design-index `ship.weaponAngles`, and build identification).
  Client and server accept only protocol range `6..6`; `messagepack` and
  `entityDeltaSnapshotsV1` are required capabilities. Build-SHA skew is reported
  but non-blocking.
- `turretRules.js` — turret traverse rates/limits shared by server fire control and
  client rendering.
- `dataSupportRules.js` — Shared allocation engine used by server runtime Data support, designer analysis and verifiers; lifecycle tests cover real Power, Heat, damage and repair paths, and the Section 6D Data Links presentation is implemented in the client designer.
- `heatRules.js` — heat state thresholds/curves shared by server heat sim and client
  heat display; `componentHeatSnapshot.js` — the `[heat,state,ratio,capacity]`
  tuple + delta stride format used on the wire by both ends.
- `engineExhaust.js` — exhaust geometry/state shared by stats and rendering.
- `math.js`, `movementStats.js`, `formatting.js`, `ids.js`, `heatDisplay.js`.
- `component-balance.json` (repo root) — the component stat source of truth;
  served by the backend at `/component-balance.generated.json`, loaded by the server via
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
  → WebSocket frame (MessagePack)    binary opcode 0x2; production binary only
  → server framing + decode          websocketServer.js, wsCodec.js
  → route policy + message router    routeRegistry.js, messageRouter.js
  → validation/sanitisation          validation.js, shipDesign.js, economy.js
  → authoritative room mutation      players.js / movement.js / economy.js / …
  → simulation tick (30 Hz)          server.js tickRoom(): bots, economy,
                                     movement, separation, collisions, support,
                                     weapons, heat, bullets, capture, control victory
  → snapshot build (20 Hz)           snapshots.js: shared arrays once per room,
                                     static fields only on "static" snapshots,
                                     component HP/heat deltas otherwise
  → MessagePack delivery             snapshotDelivery.js + outbound.js, with
                                     per-client privacy and entity-delta baselines
  → client decode + merge            network.js wsDecode → messages.js: re-attach
                                     cached designs/map/rules, apply chpD/heatD
  → interpolation + render           renderInterpolation.js eases visualShips;
                                     Pixi renders at rAF; UI panels update
```

Phase flow: `lobby` (join/teams/rules/bots) → `design` (blueprint editing and
validation-free readiness) → `active` (simulation + purchases) → `end` (statistics,
restart or close) — driven by `players.js` and `maybeStartMatch`.

## F. Current architectural risks (documented, deliberately not fixed here)

- **R1 — Frontend execution path (resolved in Section 1).**
  `public/index.html` loads `/src/main.js` as the single production ES-module entry.
  `netlify-build.js` no longer creates `public/client.js`; required tests no longer
  execute a regex-stripped global bundle. `verify-module-boundaries.js`,
  `verify-module-imports.js`, and `verify-production-path.js` protect this path.
- **R2 — Global mutable client state.** Every client module imports and freely
  mutates the single `state` object; there is no change tracking, making UI/render
  interactions hard to reason about and test in isolation.
- **R3 — Route-policy inventory (resolved in Section 11A).** Every inbound type is
  registered once in `routeRegistry.js`. `messageRouter.js` enforces the registry's
  rate, attachment, phase, and admin policy centrally before invoking the handler;
  registration tests fail when a route is missing or classified more than once.
- **R4 — Late/circular requires.** Server modules resolve circular dependencies by
  `require()`ing inside functions (`messages.js` ⇄ `websocketServer.js` ⇄
  `players.js` ⇄ `rooms.js`). It works, but import order is load-bearing and easy
  to break.
- **R5 — Server/client duplication.** Blueprint footprint/rotation/validation and
  some movement/geometry logic exist in parallel implementations; only part is in
  `shared/`. Component geometry consistency between server hitboxes/turret barrel
  positions and client art is asserted indirectly by browser tests only.
- **R6 — Split deployments + protocol skew.** Frontend (Netlify) and backend deploy
  independently; a stale backend is a real failure mode. Protocol negotiation now
  requires exact range `6..6` plus the required MessagePack/entity-delta
  capabilities. Build-SHA differences are diagnostic; incompatible protocol or
  balance revisions are not silently accepted.
- **R7 — In-memory room persistence.** A server restart drops all rooms/matches;
  closed-room codes and reconnect grace live in process memory only.
- **R8 — Reconnect credentials.** Stable room player IDs and private, room-scoped
  resume credentials are authoritative. Display names never authorize reconnect;
  stale or replaced sockets cannot mutate the reclaimed slot.
- **R9 — Snapshot delivery complexity.** Protocol-6 full and compact entity-delta
  snapshots use per-connection epochs, sequences, baselines and privacy filtering.
  The client applies them through pure atomic merge helpers; changes to this path
  require protocol, privacy and reconnect regression coverage.
- **R10 — Browser tests depend on Playwright binaries.** Real browser tests
  need a Chromium install (portable resolution in `verify-pixi-browser-support.js`:
  `PW_CHROME` → `/opt/pw-browsers/*` → Playwright default). Without a browser the
  suite fails with an environment error — visible, but easily misread as an app
  failure. CI installs Chromium explicitly.
- **R11 — Hand-rolled WebSocket framing.** `websocketServer.js` implements RFC 6455
  by hand with fragmentation support and bounded frame/message buffers. Parser
  changes still require the focused handshake, fragmentation, fuzz and lifecycle
  checks.

These are current maintenance constraints. Verify them against the owning modules
and focused tests before changing a boundary.

## Section 6: movement and commands

Movement commands now have an explicit server contract in [movement-command-architecture.md](movement-command-architecture.md). The server preserves omitted-`shipIds` all-owned command behaviour, treats an explicit empty selection as no-op, rejects malformed/oversized selections safely, and computes simple relative-offset ground-move destinations for selected ships. Movement ticks ignore invalid `dt`, clamp/subdivide unusually large `dt`, sanitize finite pose/target state, and run stable living-ship separation after per-ship integration.

## Section 4: maps and active-match progression

Map generation is deterministic once a per-room `mapSeed` has been created. The generated seed is included in static map data so production reports can be replayed by tests. Map validation runs immediately after generation; development/test builds fail with the seed while production falls back to a minimal safe arena.

## Section 7 combat authority update

Combat remains server-authoritative. `simulation.js` owns the exact active-tick
sequence, including economy, lifecycle cleanup, station launch control, movement,
component runtime state, combat, projectiles, visibility, and objectives. Tests call
that same composition boundary instead of maintaining a parallel tick description.
Target acquisition, per-weapon fallback, point defence,
projectile impacts and destruction now use explicit deterministic tie-breaks and
idempotent finalization; see [combat-targeting-weapons.md](combat-targeting-weapons.md).

## Deterministic spawn planner

Server spawning is planned by `src/server/spawnPlanner.js`. The planner sorts stable player IDs, groups players by solo sector or team side, reserves a radius large enough for the starter fleet, and performs a bounded deterministic fallback search when a preferred slot intersects another reservation, an asteroid, a relay, or world bounds. Blue and red teams use mirrored side treatment; solo players are distributed around deterministic sectors. Failures include the map seed, player IDs, team layout, and attempted positions.

## Spawn/safe-zone plan ownership

`spawnPlanner.js` owns the deterministic spawn-region plan. `rooms.js` applies that plan to `room.map.safeZones` when rules change, players or bots alter the layout, the arena is prepared, or a rematch resets the match. `ships.js` reads planned spawns from the same cache for human and bot fleets. `combat.js` checks the generated zones with explicit `team` or `ownerId` ownership, and `snapshots.js` publishes the same `room.map.safeZones` list to clients. This removes the previous split between planner spawns and fixed legacy safe-zone layouts.

## Section 8C heat snapshots and parity

Heat is authoritative on the server and component-index aligned with immutable ship designs. Runtime snapshots expose aggregate stored heat/capacity plus full or delta component heat tuples; clients merge those tuples without reusing removed-ship arrays. Designer heat output is labelled as prediction and shares rules with runtime where applicable. See [Heat, Power and Component Health](heat-power-component-health.md).

### Section 8D thermal invariants

Runtime heat keeps immutable design indexes and physical adjacency. A Heat Sink's thermal mass belongs to the Heat Sink itself — neighbours inherit none of it, so heat has to actually reach a sink by conduction or through a Heat Pipe coolant network; a damaged sink loses its own capacity in proportion to its health, and that is the only capacity recalculated after sink destruction or repair. Whole-ship aggregates include living components only; destroyed components may retain tuple heat for display/history. Internal transfer is debugged separately from cooling/radiation so conservation checks use generated heat minus actual heat leaving the ship. Thermal updates retain normal stalled elapsed time through bounded substeps and clamp excessive backlog at 1.6 seconds.

## Networking architecture
The transport contract is explicit: `/socket` upgrades to raw WebSocket, application data is production MessagePack only, and `routeRegistry.js` policy is enforced before inbound dispatch. Exact protocol-6 join negotiation gates gameplay. Full and compact entity-delta snapshots are canonical; the hand-rolled parser supports bounded fragmentation and remains dependency-light.

## Section 10A renderer interaction model

Camera math now lives in `public/src/game/camera.js`; input, selection, Pixi, and culling call those helpers rather than recomputing coordinate conversions. The Pixi world root uses the same camera centre and zoom that pointer hit testing uses. Rendering consumes accepted snapshot timestamps through bounded render history and derives temporary visual ship transforms without mutating the authoritative snapshot.

## Section 10B1 renderer performance notes

Renderer internals use bounded pools, conservative pure-geometry culling, lease-owned texture caches, deterministic structural revision keys, and explicit Low/Medium/High quality profiles. Static Pixi map resources rebuild only for epoch/static-revision/quality/resize causes, while compact snapshots, HP/heat deltas, weapon-angle changes, and selection changes remain dynamic updates. Detailed browser performance scenarios and CI artifacts are documented in `docs/renderer-performance.md`.

## Section 10B2 Chromium renderer verification

Section 10B2 adds real Chromium/WebGL diagnostics and CI coverage for renderer performance, DPR/viewport/quality matrices, resize stability, visibility handling, WebGL context lifecycle, fatal-frame diagnostics, and bounded renderer soak artifacts. Performance acceptance is CI-safe: tests require WebGL initialization, continued frame production, finite camera/viewport transforms, one ticker/application, bounded texture and pool counters, stable scene counts, and no fatal frame/page/console errors; they do not claim universal 60 FPS on shared GitHub runners.

The browser diagnostics exposed as `window.__mfaRenderer.diagnostics()` are read-only, bounded, serializable summaries and intentionally omit resume credentials, private tokens, and full private snapshots. Frame measurements are split into startup, warm-up, steady, transition, and cleanup phases so texture-bake startup frames are not used as steady-state performance.

CI now runs `npm run test:renderer-performance` and `npm run test:webgl-context` with the normal browser group, and runs `npm run test:renderer-soak` in a separate real-Chromium job. Failure artifacts are written under `test-artifacts/` with screenshots, diagnostics, reports, server logs, viewport, DPR, quality, pool, texture, scene and console data where available.


## G. Test runner dependency boundaries

`tools/test-manifest.js` classifies every `tests/verify-*.js` file exactly once as unit, integration, protocol, browser, server-soak, renderer-soak, or helper. `verify-test-manifest.js` is the registration gate, so an unclassified new verifier fails immediately. Integration and server-soak groups are browser-free; browser and renderer-soak own the real-Chromium/WebGL/Pixi checks. `npm run test:all` is the complete executable manifest and requires Chromium; `npm run test:all-non-browser` is the complete non-browser subset.


## Section 11A server composition notes

Server startup is now exposed through `createGameServer(options)` in `server.js`, while production CLI behaviour remains `node server.js`. Inbound route metadata lives in `src/server/routeRegistry.js`; outbound queues live in `src/server/outbound.js`; snapshot delivery lives in `src/server/snapshotDelivery.js`; deterministic tick ordering lives in `src/server/simulation.js`. Section 11B still owns WebSocket fragmentation and low-level RFC 6455 parser hardening.

## Section 11B WebSocket transport notes

WebSocket transport hardening is documented in `docs/websocket-transport.md`. The server now validates the RFC 6455 version-13 upgrade before sending `101`, supports exact allowlisted origins for split frontend/backend deployments, rejects production text frames, reconstructs fragmented binary messages before MessagePack decode, accepts interleaved control frames, validates close payloads and UTF-8 close reasons, and bounds unread and aggregate message buffers. New transport checks cover handshake, fragmentation, lifecycle, fuzz, and soak behaviour through the `test:websocket-*` scripts.

### Runtime Data-support flow

Explicit Data Links feed server combat through `src/server/componentData.js`. Each support source has a budget; every linked weapon receives the source budget divided by the number of linked weapons. `shipStats.computeStats()` keeps weapon-family summaries base-only, preventing global support leakage or double application.

### Section 6C Data-support lifecycle ordering

The server updates Data support after authoritative component Power and Heat state are current. This lets support sources use `componentPower.byComponentIndex[sourceIndex].operationalMultiplier` rather than ship-wide or recipient Power state.

`src/server/componentData.js` owns derived `runtimeDataSupport` state with link and allocation revisions. Refreshes handle source Power multiplier changes, Heat performance tier changes, and component lifecycle changes. Derived Data-support state is runtime-only and is not persisted into blueprints.

### Section 6D Blueprint Designer Data-support inspection

Section 6D is implemented in the client designer without changing runtime allocation or lifecycle semantics. `public/src/design/dataSupportAnalysis.js` derives designer Data predictions from explicit Data Links, shared Power analysis, and one shared Heat prediction per design/link/scenario. `public/src/design/dataSupportPresentation.js` provides client-side unit-aware formatting for range metres and percentage accuracy/fire-rate support.

The Data Links inspector in `public/src/ui/dataLinksUi.js` reuses `state.thermalLoadMode`, so Heat and Data scenario controls stay synchronized. It uses separate cached base and vulnerability analyses keyed by deterministic design, link, catalogue, and scenario signatures; changing selection or hover state does not recompute Power, Heat, allocation, or failure analysis.

Designer source-destruction vulnerability is represented by an operational multiplier override for the selected source. Vulnerability comparisons use deterministic source-to-weapon allocation signatures, and severity is category based so metre and percentage losses are not summed together.

The Data overlay adds non-colour-only classes, outlines, dashed states, and ARIA descriptions for selected sources, selected weapons, vulnerability states, source status, and weapon support states. Browser verification exercises the production frontend rather than only module import smoke checks. Section 6E is complete; Section 7 combat authority is documented in `combat-targeting-weapons.md`.

### Section 6E Data-support balance validation

Section 6E ships canonical Data-support reference fixtures, browser-free balance invariants, deterministic reporting, and final competitive conclusions while preserving the existing Section 6A–6D authorities. No physical Wiring or route-graph assumptions belong in this Data-support contract.
