# Client-to-server message inventory

`src/server/messages.js` accepts MessagePack WebSocket packets with a string `type`. JSON text frames are tolerated by the codec, but MessagePack remains the normal transport. Unknown message types are ignored after the join guard.

| Type | Join required | Phase/admin requirements | Handler/domain | Response/broadcast |
|---|---:|---|---|---|
| `ping` | No | Any | router | `pong` to sender |
| `join` | No | Any | `players.joinRoom` | hello/join state from player lifecycle |
| `deploy` | Yes | `design` or `active`; design validation; active saves purchase blueprint | `shipDesign`, `validation`, `players.maybeStartMatch` | error/notice, room notice, static snapshot |
| `buyShip` | Yes | `active`; purchase validation | `economy.validateBuyShip`, `economy.buyShip` | `purchaseResult`, notice, snapshot |
| `setCombatStyle` | Yes | `active` | player ships | snapshot when changed |
| `setRallyPoint` | Yes | `active` | player rally state | snapshot |
| `resetRallyPoint` | Yes | `active` | player rally state | snapshot |
| `command` | Yes | `active` | `movement.commandShips` | no direct response |
| `destruct` | Yes | `active` | `combat.requestSelfDestruct` | no direct response |
| `setTeam` | Yes | lobby/design team balancing | `players.balanceTeam` | snapshot/notice as existing code permits |
| `addBot` | Yes | admin/lobby controls | `ships.addBot` | snapshot/notice |
| `setRules` | Yes | admin, non-active rule update | `rooms.setRoomRules` | snapshot/notice |
| `setName` | Yes | sanitized name | `validation.sanitizeName` | snapshot |
| `startDesign` | Yes | admin/lobby | `players.startDesignPhase` | snapshot/notice |
| `kick` | Yes | admin | `players.kickPlayer` | kicked client + room updates |
| `restart` | Yes | end/admin flow | `players.restartFromEnd` | snapshot/notice |
| `returnToLobby` / `restartLobby` | Yes | admin/end or lobby flow | `players.returnToLobbyPhase` | snapshot/notice |
| `closeLobby` | Yes | admin | `players.closeLobby` | close/kick notifications |
| `leaveLobby` | Yes | any joined player | `players.leaveLobby` | left/room updates |

Message semantics and wire formats were not changed in Section 1. This document is an audit inventory; later router extraction should preserve these rows as acceptance criteria.

## Section 4 static map metadata

Static `state` snapshots include `map.seed`, `map.name`, `map.relays`, `map.asteroids`, `map.clouds`, `map.safeZones`, `world`, and `mapSizeLabel`. Dynamic snapshots update `points`, `objectiveControl`, and `controlVictory` without replacing cached static map data.

## Section 5 purchase-result contract

`buyShip` remains a client intent only. The server recomputes the authoritative
ship stats/cost from the supplied immutable design snapshot and validates phase,
readiness, funds, and living fleet slots before committing an all-or-nothing
transaction.

`purchaseResult` success fields:

- `requestId` — sanitized request ID supplied by the client.
- `ok: true` and `code: "ok"`.
- `count` — number of ships created.
- `unitCost` and `totalCost` — authoritative server costs.
- `shipIds` — created authoritative ship IDs.
- `money` — resulting floored current money.
- `activeShips` and `shipCap` — authoritative cap reconciliation.

`purchaseResult` failure fields:

- `requestId`.
- `ok: false`.
- `code` — one of `invalid-phase`, `invalid-design`, `insufficient-funds`,
  `fleet-cap`, `stale-connection`, `invalid-request`,
  `duplicate-request-conflict`, or `spawn-failed` where applicable.
- `message` — player-safe human-readable text.

Purchase request IDs are idempotent per player/room for a bounded period: 2
minutes or the latest 64 entries. Identical replays return the original result;
conflicting replays are rejected. Public construction notices intentionally omit
exact purchase cost so enemy economy is not leaked during active matches.

## Section 7 combat snapshot note

No client-to-server message shape changed. Combat snapshots continue to carry
existing HP, shield, alive, projectile/effect and design-index-aligned weapon
angle/target fields; Section 7 only tightened server-side validation and ordering.

## Catch-up Part 1 protocol notes

- `deploy` in the design phase remains the ready/save-design command.
- `deploy` in the active phase now saves the player's editor blueprint and future-purchase combat style only. It does **not** mutate deployed ships; deployed-ship style changes must use `setCombatStyle`.
- `buyShip` carries an immutable design and combat-style snapshot in the request. The server validates the submitted snapshot and executes the purchase from that payload rather than rereading later editor state.

## Catch-up Part 2 selected-fleet and purchase safety

Selected-fleet messages (`command`, `setCombatStyle`, `destruct`, and target-bearing movement commands) share one server-side selection contract. Omitted `shipIds` intentionally means all owned, living, non-removed ships only for commands that document all-fleet behavior; explicit `shipIds: []` means no ships; malformed selections are rejected and never fall back to all ships. Duplicate IDs collapse, unknown/enemy/dead/removed IDs are ignored safely, oversized arrays are rejected, and stale replaced sockets are rejected before command handling.

Purchase responses remain authoritative. `purchaseResult` includes accepted request ID, result code, count, unit/total cost, created ship IDs, remaining money, active ship count, and cap. Later snapshots must agree, and enemy snapshots do not expose private economy fields.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.

## Protocol test suite

The required protocol group currently includes `verify-runtime.js`, a combined real-network protocol smoke test using a real server process, real WebSockets, MessagePack-encoded messages/snapshots, safe ports, and non-zero failure exits. The former purchase and movement wrapper commands were removed because they duplicated this scenario without dedicated assertions.

## Safe-zone snapshot fields

Static `state.map.safeZones` is the authoritative server list used by combat. Each entry has stable finite `id`, `x`, `y`, `radius`, `color`, `isSpawn`, and explicit ownership metadata: `team` for team-owned protection or `ownerId` for solo owner protection. `spawnPlayerIds` identifies the planned spawn slots covered by that zone. Clients render these zones from the snapshot for world and minimap display only; all protection and firing blocks remain server-authoritative.

## Heat component snapshots

State messages may include `componentHeat` full tuples as `[heat, state, ratio, capacity]` for every design index, or `componentHeatD` compact deltas as `[index, heat, state, ratio, capacity, ...]`. Deltas are stride 5 and are ignored when malformed, non-finite or out of range. Aggregate fields `heatNow`, `heatMax`, `heat`, `hot` and `overheated` are generated from the same included living components.

## Section 8D heat protocol verification

`npm run test:heat-protocol` starts `server.js`, connects with real WebSockets, sends MessagePack client messages, receives MessagePack snapshots, verifies full `componentHeat` tuples, compact `componentHeatD` deltas, index alignment, reconnect reconstruction and reset/rematch cleanup. Direct snapshot-builder tests are unit coverage only and are not described as the protocol test.

## Section 9A protocol compatibility and schemas
Protocol version 4 makes compatibility negotiation explicit. `join` must include `protocolVersion`, `minProtocolVersion`, `maxProtocolVersion`, `frontendBuildSha` and `capabilities`; the server requires `messagepack` and accepts only compatible range 4..4. Stable error codes include `incompatible-protocol`, `missing-capability`, `invalid-payload`, `invalid-type`, `unknown-type`, `invalid-request`, `invalid-room`, `invalid-design`, `invalid-ship-ids`, `join-required`, `stale-attachment`, `bad-message`, `message-too-large` and `protocol-error`.

The accepted client-message registry is `src/server/clientSchemas.js`: ping, join, deploy, buyShip, setCombatStyle, setRallyPoint, resetRallyPoint, command, destruct, setTeam, addBot, setRules, setName, startDesign, kick, restart, returnToLobby, restartLobby, closeLobby and leaveLobby. Unknown fields are ignored only after generic bounds validation; domain handlers remain authoritative for permission and phase checks.

### requestFullState

Client-to-server recovery message validated by the normal schema path:

```json
{ "type": "requestFullState", "stateEpoch": 3, "lastSnapshotSeq": 42, "reason": "sequence-gap" }
```

Allowed reasons include `missing-baseline`, `sequence-gap`, `epoch-change`, `malformed-delta`, and `static-revision-mismatch`. The server treats the numeric fields as diagnostics only and replies with a requester-only full `state` snapshot using normal viewer privacy filtering.
