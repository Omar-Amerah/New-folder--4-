# Modular Fleet Arena

A dependency-free browser multiplayer space combat game. Players join a room, build ships from modules, deploy a fleet, capture randomly generated relay maps, and fight with automatic weapons.

## Run

```powershell
node server.js
```

Open `http://localhost:3000`. Friends on the same network can use the LAN URL printed by the server and the same room code. Friends over the internet need the port exposed through your router or a tunnel.

## Testing

```bash
npm run check                 # build + static/syntax checks
npm run test:unit             # fast deterministic module/static tests
npm run test:integration      # browser-free module/lifecycle integration
npm run test:protocol         # real server + WebSocket/MessagePack protocol checks
npm run test:smoke            # production HTTP asset smoke
npm run test:soak             # browser-free deterministic server/simulation soak
npm run test:all-non-browser  # complete non-browser umbrella; does not launch Chromium
npm run test:browser          # real Chromium/WebGL/Pixi browser coverage
npm run test:renderer-soak    # dedicated long real Chromium/WebGL/Pixi renderer soak
npm run test:all              # complete umbrella; requires Chromium
```

CI keeps the same dependency split: the server-integration job does not install Chromium and runs integration/protocol/smoke/server-soak only; the browser job installs Playwright Chromium and runs `test:browser`; the renderer-soak job installs Playwright Chromium and runs only `test:renderer-soak`. Browser tests fail strictly if Chromium, WebGL or Pixi cannot initialize; they are not skipped or downgraded.

## Deploy

The production deployment is split-origin: Netlify serves the static frontend, while Render runs the persistent Node/WebSocket multiplayer backend. Netlify cannot run the long-lived multiplayer server process.

### Render multiplayer backend

Use the included `render.yaml` Blueprint or configure the service manually with these settings:

- Service type: Web Service
- Runtime: Node
- Build command: `npm ci`
- Start command: `node server.js`
- Health check path: `/health`
- Port: use Render's provided `PORT` environment variable; do not hardcode a port
- Environment variables:
  - `NODE_ENV=production`
  - `WS_ALLOWED_ORIGINS=https://fastidious-raindrop-a14031.netlify.app`

`WS_ALLOWED_ORIGINS` must contain exact frontend origins with no trailing slash. For multiple frontend domains, use comma-separated exact origins, for example `https://main.example,https://preview.example`. Do not use wildcard origins in production. Render free services may sleep, so the first multiplayer connection after inactivity can take about a minute while the service wakes.

The backend exposes a safe readiness endpoint at `/health`. Verify a backend deploy by opening:

```text
https://new-folder-4-65uk.onrender.com/health
```

Then verify the full deployment by creating a real room from the Netlify frontend.

### Netlify static frontend

Netlify should publish the browser files from `public/`.

Build settings:

- Base directory: leave blank
- Package directory: leave blank
- Build command: `npm run build`
- Publish directory: `public`
- Functions directory: leave blank

The included `netlify.toml` sets these values automatically for Git deploys. The production URL format for the current deployment is:

```text
https://fastidious-raindrop-a14031.netlify.app/?server=wss%3A%2F%2Fnew-folder-4-65uk.onrender.com
```

The `server` URL parameter is saved in the browser's local settings and reused for invites. If the Render hostname changes, update the saved server setting in the game settings or open the Netlify site with a fresh `?server=wss%3A%2F%2F...` URL.

## Controls

- Create a game, then share the generated room code. The first player in the room is the admin.
- Friends join using the same room code. The admin can add bots, kick players, start ship design, and close the lobby.
- Choose Blue wing or Red wing for teams, or Solo for free-for-all before ship design starts.
- When the admin starts ship design, the server picks the map size from the current player count and generates the arena.
- Edit the blueprint grid, then press Ready ship. Right-click a blueprint part to remove it.
- When everyone is ready, the match starts. Spend money to build ships. Relays increase income.
- At match end, an end screen appears. The admin can restart into a fresh ship design phase or close the lobby.
- Left-click or drag-select your ships.
- Right-click the arena to move selected ships. Right-click an enemy to focus fire.
- Use the formation selector before issuing an order.
- Use the minimap to jump the camera. Mouse wheel zooms; WASD or arrow keys pan; `F` follows your fleet; `Q` selects all live ships.
- Add bots from the lobby controls for practice or fuller team matches.
- Hold relays and destroy enemy ships to score. First side to the match score wins, then the admin chooses restart or close.


## Frontend build path

The production frontend has one authoritative execution path: `public/index.html` loads `public/src/main.js` as a native ES module. `npm run build` vendors PixiJS and MessagePack into `public/vendor/` and emits `public/build-sha.js`; it does not generate `public/client.js` or strip imports/exports. Architecture checks in `npm run check` verify relative imports, source-root boundaries, and the absence of the obsolete generated bundle.

## Combat targeting summary

The server is authoritative for combat. Attack focus commands select an enemy
ship-level target, but each weapon still checks its own range, line of sight,
firing arc, cooldown, component health and safe-zone restrictions before firing.
Turrets may visibly track while reloading or while a safe zone blocks fire.
Repair beams target damaged allies, while ordinary weapons and point defence do
not damage allies under the current rules.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.

### Spawn fairness and test taxonomy

Matches use deterministic server-side spawn planning based on stable player IDs, team/solo layout, map seed, world bounds, and map hazards. Starter fleets reserve non-overlapping space without increasing map size. Dedicated npm commands describe the coverage they actually execute; see `docs/testing-inventory.md` for current details and deferred Section 8-13 items.

### Spawn protection policy

Spawn protection is generated from the server's deterministic spawn plan. Team zones protect only ships on that team; enemies entering the same circle are not protected. Solo zones protect only their owning player. A protected ship cannot fire from the zone, and targets protected by their own/team zone ignore incoming damage. Clients render the authoritative `map.safeZones` snapshot, but the server is the only authority for protection decisions.

## Networking protocol notes
The browser and server use raw WebSockets at `/socket` with MessagePack binary frames in production. Protocol version 4 requires clients to send compatibility fields and the `messagepack` capability in `join`. Reconnect preserves the stable room `playerId` through a private room-scoped resume credential while each transport receives a new `connectionId`.

Useful networking checks:

```bash
npm run test:websocket-frames
npm run test:protocol-schema
npm run test:network-connections
npm run test:network-protocol
npm run test:network-browser
```

### Snapshot resynchronization

The multiplayer protocol uses MessagePack state snapshots with explicit room epochs and per-epoch sequence numbers. Clients recover from missed compact state by requesting one viewer-filtered full snapshot without leaving the room; reconnects also require a fresh full baseline before compact updates resume.

### Arena controls

- Mouse wheel zooms around the cursor; middle drag or Space + left drag pans.
- `F` follows the selected living ships or, with no selection, your living fleet.
- `0` resets zoom to fit; `C` centres the selected ships or your fleet.
- Click selects owned living ships, Shift-click toggles, drag selects intersecting ships, Shift-drag adds, `Q` selects all owned living ships, and Escape clears selection.

## Section 10B1 renderer performance notes

Renderer internals now use bounded pools, conservative pure-geometry culling, lease-owned texture caches, deterministic structural revision keys, and explicit Low/Medium/High quality profiles. Static Pixi map resources rebuild only for epoch/static-revision/quality/resize causes, while compact snapshots, HP/heat deltas, weapon-angle changes, and selection changes remain dynamic updates. Detailed browser performance scenarios, long-running soak, visibility/background-tab behaviour, context-loss recovery, and CI performance artifacts remain deferred to Section 10B2; see `docs/renderer-performance.md`.

## Section 10B2 Chromium renderer verification

Section 10B2 adds real Chromium/WebGL diagnostics and CI coverage for renderer performance, DPR/viewport/quality matrices, resize stability, visibility handling, WebGL context lifecycle, fatal-frame diagnostics, and bounded renderer soak artifacts. Performance acceptance is CI-safe: tests require WebGL initialization, continued frame production, finite camera/viewport transforms, one ticker/application, bounded texture and pool counters, stable scene counts, and no fatal frame/page/console errors; they do not claim universal 60 FPS on shared GitHub runners.

The browser diagnostics exposed as `window.__mfaRenderer.diagnostics()` are read-only, bounded, serializable summaries and intentionally omit resume credentials, private tokens, and full private snapshots. Frame measurements are split into startup, warm-up, steady, transition, and cleanup phases so texture-bake startup frames are not used as steady-state performance.

CI now runs `npm run test:renderer-performance` and `npm run test:webgl-context` with the normal browser group, and runs `npm run test:renderer-soak` in a separate real-Chromium job. Failure artifacts are written under `test-artifacts/` with screenshots, diagnostics, reports, server logs, viewport, DPR, quality, pool, texture, scene and console data where available.



## Section 11A server composition notes

Server startup is now exposed through `createGameServer(options)` in `server.js`, while production CLI behaviour remains `node server.js`. Inbound route metadata lives in `src/server/routeRegistry.js`; outbound queues live in `src/server/outbound.js`; snapshot delivery lives in `src/server/snapshotDelivery.js`; deterministic tick ordering lives in `src/server/simulation.js`. Section 11B still owns WebSocket fragmentation and low-level RFC 6455 parser hardening.

## Section 11B WebSocket transport notes

WebSocket transport hardening is documented in `docs/websocket-transport.md`. The server now validates the RFC 6455 version-13 upgrade before sending `101`, supports exact allowlisted origins for split frontend/backend deployments, rejects production text frames, reconstructs fragmented binary messages before MessagePack decode, accepts interleaved control frames, validates close payloads and UTF-8 close reasons, and bounds unread and aggregate message buffers. New transport checks cover handshake, fragmentation, lifecycle, fuzz, and soak behaviour through the `test:websocket-*` scripts.
