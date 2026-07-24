# Modular Fleet Arena

A dependency-free browser multiplayer space combat game. Players join a room, build ships from modules, deploy a fleet, capture randomly generated relay maps, and fight with automatic weapons.

## Run

```powershell
node server.js
```

Open `http://localhost:3000`. Friends on the same network can use the LAN URL printed by the server and the same room code. Friends over the internet need the port exposed through your router or a tunnel.

## Testing

None of these commands launch a browser unless the command name contains `browser` or `all` — normal local testing never requires Chromium.

```bash
npm test                      # build + unit and browser-free integration tests (no Chromium)
npm run test:unit             # unit tests only — fast deterministic module/static/contract tests
npm run test:integration      # browser-free module/lifecycle integration
npm run test:protocol         # real server + WebSocket/MessagePack protocol checks
npm run test:smoke            # production HTTP asset smoke
npm run test:soak             # browser-free deterministic server/simulation soak
npm run check                 # build + static/syntax/architecture checks (no Chromium)
npm run test:all-non-browser  # complete non-browser umbrella; does not launch Chromium
npm run test:browser          # real Chromium/WebGL/Pixi browser coverage (launches a browser)
npm run test:renderer-soak    # dedicated long real Chromium/WebGL/Pixi renderer soak (launches a browser)
npm run test:all              # complete umbrella; requires Chromium
```

`npm test` is the everyday command: it runs the unit group plus the browser-free
integration group so a green run does not misleadingly imply the browser suite
also passed. Run `npm run test:browser` (or `npm run test:all`) separately when a
browser is available. Tests that only inspect source or DOM contracts (for
example `verify-canvas-removal.js`, `verify-diagnostics-gating.js`,
`verify-section13b-ui.js`) are static/contract tests and live in the unit group;
a test is only named/grouped as a browser test when it actually launches a real
browser (the `*-browser.js` scripts and the `browser` / `renderer-soak` groups).

CI keeps the same dependency split: the server-integration job does not install Chromium and runs integration/protocol/smoke/server-soak only; the browser job installs Playwright Chromium and runs `test:browser`; the renderer-soak job installs Playwright Chromium and runs only `test:renderer-soak`. Browser tests fail strictly if Chromium, WebGL or Pixi cannot initialize; they are not skipped or downgraded.

## Deploy

### Netlify static site

Netlify should publish the browser files from `public/`.

Build settings:

- Base directory: leave blank
- Package directory: leave blank
- Build command: `npm run build`
- Publish directory: `public`
- Functions directory: leave blank

The included `netlify.toml` sets these values automatically for Git deploys.

### Multiplayer server

Netlify static hosting does not run the persistent Node/WebSocket server used by multiplayer rooms. Deploy `server.js` to a service that supports long-running Node servers and WebSockets, such as Render, Railway, Fly.io, or a VPS.

Server settings for those hosts:

- Build command: `npm install` or blank
- Start command: `node server.js`
- Port: use the host-provided `PORT` environment variable

After the server is deployed, open the Netlify site with:

```text
https://your-site.netlify.app/?server=wss://your-game-server.example.com
```

The game remembers that server URL locally and includes it when you copy invites.

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

## Deployment hardening: Render backend + Netlify frontend

### Render backend

Use Render for the persistent Node/WebSocket multiplayer server. Configure:

- **Build command:** `npm ci`
- **Start command:** `node server.js`
- **Health check path:** `/health`
- **Environment variable:** `WS_ALLOWED_ORIGINS=https://fastidious-raindrop-a14031.netlify.app`

Do not add a trailing slash to `WS_ALLOWED_ORIGINS`; it must be the exact frontend origin. Multiple frontend domains are comma-separated exact origins, for example `https://one.example,https://two.example`. Render provides the `PORT` environment variable used by the server. Free Render services may sleep, so the first connection can take about a minute while the service wakes.

The public `/health` endpoint is intentionally readable cross-origin so the frontend can distinguish an online backend with a rejected WebSocket from an offline or waking backend. Public health access does not grant WebSocket access: `/socket` still requires an exact origin from `WS_ALLOWED_ORIGINS` in production.

### Netlify frontend

Use Netlify only for the static browser client:

- **Build command:** `npm run build`
- **Publish directory:** `public`
- **Production URL:** `https://fastidious-raindrop-a14031.netlify.app/?server=wss%3A%2F%2Fnew-folder-4-65uk.onrender.com`

Netlify cannot host the persistent multiplayer server because rooms require a long-running Node process with WebSocket support. If the Render hostname changes, update the saved server address in the client settings or reload the Netlify URL with a new `server=` WebSocket URL.
