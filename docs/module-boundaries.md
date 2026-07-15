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

## Section 4 map/objective boundaries

`src/server/rooms.js` owns room lifecycle decisions and map seed creation. `src/server/mapValidation.js` owns pure generated-map schema and invariant checks. `src/server/objectives.js` is the score and victory authority for relay capture, periodic relay score, control victory, and idempotent winner finalization.

## Section 7 combat boundaries

`src/server/combat.js` owns allegiance, ship-level targeting, per-weapon fire
target selection, support/repair, turret diagnostics, damage and destruction.
`src/server/projectiles.js` owns projectile movement and swept collision ordering.
Shared turret geometry remains in `public/src/shared/turretRules.js` and is
consumed by both server muzzle rules and client rendering.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.

## Section 9A networking ownership
`protocol.js` owns compatibility policy; `clientSchemas.js` owns accepted client-message shapes and limits; `websocketServer.js` owns frame compliance and connection buffers; `messages.js` owns schema-gated dispatch; `players.js` owns stable player identity and attachment generation. Snapshot epoch/resync ownership is reserved for Section 9B.

## Renderer/camera/input ownership

Networking owns accepted snapshots, epochs, sequences, and simulation timestamps. `renderInterpolation` owns temporary visual transforms and bounded sample history. `camera` owns world/screen/minimap conversions and viewport-aware bounds. `input` translates arena gestures into camera actions, selection, or commands. `selection` owns selectable-entity filtering and visual-position hit tests. Pixi owns only scene graph, pools, and texture leases.
