# Modular Fleet Arena

A dependency-free browser multiplayer space combat game. Players join a room, build ships from modules, deploy a fleet, capture randomly generated relay maps, and fight with automatic weapons.

## Run

```powershell
node server.js
```

Open `http://localhost:3000`. Friends on the same network can use the LAN URL printed by the server and the same room code. Friends over the internet need the port exposed through your router or a tunnel.

## Testing

```powershell
npm ci
npm run check        # build + static/syntax validation (fast)
npm run test:unit    # fast deterministic module tests
npm run test:all     # full suite (unit, integration, protocol, browser)
```

Browser tests need Playwright Chromium (`npx playwright install chromium`).
See `docs/testing-inventory.md` for what each suite covers and
`docs/architecture-overview.md` for how the pieces fit together.

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
