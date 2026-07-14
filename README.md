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
