# Module boundaries and ownership

Section 1 makes the native ES-module frontend the only production frontend path and adds `verify-module-boundaries.js` as a lightweight guard for missing relative imports, source-root escapes, generated-bundle regressions, omitted frontend files, and static cycles.

## Server dependency groups

- **Transport:** `server.js` owns HTTP/static serving and upgrade wiring; `src/server/websocketServer.js` owns frame parsing/writing and client lifecycle; `src/server/wsCodec.js` owns MessagePack encoding/decoding. Outbound `send`, `sendPlayer`, `broadcastRoom`, and `broadcastSnapshot` still live in `src/server/messages.js` and are treated as transport-adjacent helpers until a later router split.
- **Application/message handling:** `src/server/messages.js` validates connection state, phase/admin requirements, sanitizes input, and dispatches to domain modules.
- **Room/player lifecycle:** `rooms.js` owns room creation, codes, map/rule updates, and closed-code TTL. `players.js` owns join/reconnect/leave, admin promotion, teams, phase transitions, and match start/restart flow.
- **Simulation domains:** `movement.js`, `combat.js`, `projectiles.js`, `heat.js`, `componentHealth.js`, `economy.js`, `objectives.js`, `ships.js`, `shipStats.js`, and `shipDesign.js` own authoritative gameplay state.
- **Snapshot serialization:** `snapshots.js` owns static/delta snapshot assembly and per-team visibility.
- **Shared configuration/rules:** `config.js`, `components.js`, root `component-balance.json`, and pure shared modules under `public/src/shared/` own constants consumed by both client and server.

## Client dependency groups

- **Bootstrap:** `public/src/main.js` is the production entry point loaded by `public/index.html`.
- **State:** `state.js` owns the stable global state object; tests and modules must mutate fields rather than replace stable Maps/Sets.
- **Networking:** `network.js` owns WebSocket connection, MessagePack decode/encode, and URL resolution.
- **Message/snapshot handling:** `messages.js` routes server messages; pure snapshot reconstruction helpers are in `snapshotMerge.js`.
- **UI:** `ui/*.js` owns DOM rendering, lobby screens, purchase UI, HUD, scoreboard, toasts, and end-game panels.
- **Designer:** `design/*.js` plus designer UI modules own blueprint editing, validation preview, local storage, and thermal preview.
- **Input/commands:** `game/input.js`, `game/commands.js`, and `game/selection.js` own user intent collection and outbound commands.
- **Renderer:** `game/renderController.js` and `game/pixi/*.js` own Pixi resources, render lifecycle, pooling, and visual interpolation.
- **Shared pure logic:** `public/src/shared/*.js` owns deterministic constants/rules that can be consumed by browser and Node.

## Ownership rules

| Concern | Owner |
|---|---|
| Room phase | Server `players.js`; client mirrors from snapshots. |
| Player identity | Server `players.js`; client treats `myId` as assigned data. |
| Ship design validation | Server `shipDesign.js` is authoritative; client designer validation is preview. |
| Economy | Server `economy.js`; client purchase UI only presents and reconciles. |
| Simulation state | Server simulation modules; client snapshots are read-only render input. |
| Camera state | Client `game/camera.js` and `state.camera`. |
| Selection | Client `game/selection.js` and stable `selectedShipIds` Set. |
| Component geometry | Pure footprint/rotation rules; parity covered by `verify-shared-parity.js`. Drawing remains client-only. |
| Renderer resources | Pixi renderer modules only. |
| Snapshot reconstruction | Client `snapshotMerge.js` pure helpers plus `messages.js` side effects. |

## Intended dependency direction

- UI -> client state/services -> networking/message dispatch.
- Renderer -> render models/shared geometry -> state snapshots.
- Network -> protocol decoding -> message dispatch.
- Server transport -> application message routing.
- Application handlers -> domain modules.
- Domain modules -> pure shared/config utilities.

Necessary exceptions remain documented warnings: shared UMD modules under `public/src/shared/` are intentionally required by Node, and several client/server cycles predate this section. The architecture checker reports those cycles without failing while it fails missing imports, source-root escapes, obsolete `public/client.js`, and build-path regressions.

## State ownership catalogue

- Network-owned: `socket`, `connected`, `latency`, `lastPongAt`, `server`.
- Snapshot-owned: `snapshot`, `snapshotReceivedAt`, `mine`, `world`, `map`, `rules`, `phase`, `adminId`.
- UI-owned: menu/lobby flags, notices, pending purchase display, designer panels.
- Renderer-owned: visual interpolation maps, Pixi diagnostics, camera render measurements.
- Persistent/local-owned: saved blueprints, active room key, server URL preference.
- Stable collections: `selectedShipIds` and other Maps/Sets should be cleared/mutated, not replaced, to preserve module references.

## Resolved and deferred risks

- Resolved: the regex-stripped `public/client.js` build path was removed; `netlify-build.js` now vendors assets and emits build SHA only.
- Resolved: snapshot static/delta merge logic is isolated in `public/src/snapshotMerge.js` and directly tested.
- Guarded: missing imports fail `npm run check` through `verify-module-boundaries.js` and the temporary-fixture regression in `verify-module-imports.js`.
- Deferred: broad UI/client cycles, server router extraction, and transport-neutral send/broadcast extraction remain for later sections because changing them safely requires larger protocol/lifecycle test coverage.
