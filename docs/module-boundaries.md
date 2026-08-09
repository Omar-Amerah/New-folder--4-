# Module boundaries and ownership

Section 1 makes the native ES-module frontend the only production frontend path and adds `verify-module-boundaries.js` as a lightweight guard for missing relative imports, source-root escapes, generated-bundle regressions, omitted frontend files, and static cycles.

## Server dependency groups

- **Transport:** `server.js` owns HTTP/static serving and upgrade handling; `src/server/websocketServer.js` owns frame parsing/writing and client lifecycle; `src/server/wsCodec.js` owns MessagePack encoding/decoding. Outbound `send`, `sendPlayer`, `broadcastRoom`, and `broadcastSnapshot` still live in `src/server/messages.js` and are treated as transport-adjacent helpers until a later router split.
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
- **UI:** `ui/*.js` owns DOM rendering, lobby screens, purchase UI, HUD, match status, toasts, and end-game panels.
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

## Resolved and current boundaries

- Resolved: the regex-stripped `public/client.js` build path was removed; `netlify-build.js` now vendors assets and emits build SHA only.
- Resolved: snapshot static/delta merge logic is isolated in `public/src/snapshotMerge.js` and directly tested.
- Guarded: missing imports fail `npm run check` through `verify-module-boundaries.js` and the temporary-fixture regression in `verify-module-imports.js`.
- Current boundary: broad UI/client cycles, server router extraction, and transport-neutral send/broadcast extraction remain intentionally separate from the current ownership model because changing them safely requires larger protocol/lifecycle test coverage.

## Section 4 map/objective boundaries

`src/server/rooms.js` owns room lifecycle decisions and map seed creation. `src/server/mapValidation.js` owns pure generated-map schema and invariant checks. `src/server/objectives.js` is the score and victory authority for relay capture, periodic relay score, control victory, and idempotent winner finalization.

## Section 7 combat boundaries

`src/server/combat.js` owns allegiance, ship-level targeting, per-weapon fire
target selection, support/repair, turret diagnostics, damage and destruction.
`src/server/projectiles.js` owns projectile movement and swept collision ordering.
Shared turret geometry remains in `public/src/shared/turretRules.js` and is
consumed by both server muzzle rules and client rendering.

## Networking ownership
`protocol.js` owns compatibility policy; `clientSchemas.js` owns accepted client-message shapes and limits; `websocketServer.js` owns frame compliance and connection buffers; `messages.js` owns schema-gated dispatch; `players.js` owns stable player identity and attachment generation. Snapshot epoch/resync ownership is shared by `snapshotDelivery.js`, `snapshotEntityDelta.js`, `snapshots.js`, and client `snapshotMerge.js`.

## Renderer/camera/input ownership

Networking owns accepted snapshots, epochs, sequences, and simulation timestamps. `renderInterpolation` owns temporary visual transforms and bounded sample history. `camera` owns world/screen/minimap conversions and viewport-aware bounds. `input` translates arena gestures into camera actions, selection, or commands. `selection` owns selectable-entity filtering and visual-position hit tests. Pixi owns only scene graph, pools, and texture leases.

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
