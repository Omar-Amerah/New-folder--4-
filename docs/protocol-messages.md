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
