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

- **R1 — Generated `public/client.js` vs the ES-module frontend.**
  `public/index.html` loads `/src/main.js` as native ES modules; `netlify-build.js`
  *also* concatenates all modules into `public/client.js` via regex import/export
  stripping. Production serves the ES modules; the bundle is only exercised by the
  VM-harness tests. Two builds of the same app can drift, and the regex bundler is
  fragile (e.g. multi-line named imports/exports). The browser tests run the real
  ES-module path; the bundle tests do not test what production runs.
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
- **R9 — Static vs delta snapshot reconstruction.** Dynamic snapshots omit designs,
  map, rules and stats; the client re-attaches them from caches keyed by ship id.
  A missed static snapshot (e.g. join race) leaves ships without designs; tests
  cover the happy path only.
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
