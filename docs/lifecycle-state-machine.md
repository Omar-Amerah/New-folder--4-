# Lifecycle state machine

This document covers lobby, room, player identity, reconnect, admin and match lifecycle behavior. The resume credential described here is an in-memory reconnect capability for a room slot, not account authentication.

## Entities

- **Room**: authoritative server object keyed by room code. It owns phase, rules, players, sockets, map, objectives, ships, bullets, effects, admin and cleanup timers.
- **Player slot**: stable human or bot participant record in a room. Human slots keep the same `player.id` for the room lifetime, including refresh/reconnect.
- **WebSocket connection**: temporary transport object with a connection id. It may be replaced without changing player ownership.
- **Bot**: server-controlled player slot. Bots do not receive resume credentials and cannot be admin.
- **Resume credential**: cryptographically random opaque token scoped to one room/player slot. It is sent only to that player, stored only by that browser for reconnect, never broadcast, and invalidated on leave, kick, grace expiry and room closure.
- **Ship/fleet**: room-owned combat objects whose `ownerId` references stable player ids.
- **Admin role**: `room.adminId`, either `null` or one eligible human player id.

## Identity model

| Identifier | Meaning | Visibility | Authority |
| --- | --- | --- | --- |
| Connection id | One socket transport | hello/debug only | Never grants gameplay authority |
| Stable player id | One room player slot | joined message and snapshots | Owns ships, bullets, score, objectives and admin role |
| Display name | Presentation label | snapshots/UI | Never authorizes reconnect |
| Resume credential | Room-scoped reconnect capability | private joined message only | May reclaim exactly its player slot |
| Room code | Room lookup key | UI/invite links | Does not grant control |

## Player states

| State | Description | Exit |
| --- | --- | --- |
| Connected | One current active socket is attached to the slot. | Transport disconnect, explicit leave, kick, room close. |
| Disconnected within grace | Slot, ships, readiness and admin may be retained while a reconnect timer is pending. | Valid credential resumes; timer expires; admin kicks; room closes. |
| Permanently removed | Slot is deleted, credential invalidated, ships/bullets/objective ownership cleaned. | None. Name may be reused. |
| Explicitly left | Client requested leave; removal happens immediately and credential is cleared. | None. |
| Kicked | Admin removed slot; credential invalidated and client is notified. | None for that slot. |

## Room phases

- **lobby**: players join, rename, choose teams, change rules, add/kick bots, start design or close.
- **design**: players submit deployments/readiness; connected and grace-period slots keep readiness state.
- **active**: authoritative match simulation runs; reconnect preserves ships and ownership.
- **ended**: final score state; admin may rematch to design or return to lobby.
- **closed/deleted**: room removed from lookup, clients detached, credentials invalidated, timers cancelled.

## Transition table

| From -> To | Trigger | Actor | Guards | Mutations | Messages / snapshots | Cleanup |
| --- | --- | --- | --- | --- | --- | --- |
| none -> lobby | Join without existing room code | Any socket | Valid sanitized name; room code not closed | Create room, stable player id, resume credential, admin if first human | Private `joined`; public snapshot | None |
| lobby -> lobby | New join | Any socket | Unique normalized display name; room not full | Add slot and attach socket | Private `joined`; notice; snapshot | None |
| any -> same phase | Reconnect | Holder of valid credential | Credential matches non-removed slot in same room | Attach new socket, detach/close previous socket, cancel grace timer | Private `joined`; snapshot | Stale socket close is ignored |
| lobby/design/active/ended -> grace | Transport close | Current attached socket | Not explicit leave/kick/close | Mark disconnected, clear attachment, start grace timer | Notice/snapshot when clients remain | Ships/fleet retained |
| grace -> same phase | Reconnect before timer | Credential holder | Timer has not permanently removed slot | Mark connected, cancel timer | Private `joined`; snapshot | None |
| grace -> removed | Timer expiry | Server | Slot still disconnected and unattached | Delete slot, invalidate credential, remove ships/bullets/objective ownership, maybe promote admin | Snapshot if room has clients | Empty-lobby cleanup may start |
| lobby -> design | `startDesign` | Admin human | Phase is lobby; current attachment | Prepare arena, reset round stats, clear ships/bullets, bots ready | Notice; static snapshot | Empty lobby timer cancelled |
| design -> active | Valid deploy/readiness | Players/server | All required present slots ready | Spawn starter fleet exactly once for ready participants, set match times | Notice; static snapshot | None |
| active -> ended | Victory/scoring condition | Server | Match rules satisfied | Freeze winner/final scoring | Snapshot/banner | None |
| ended -> design | `restart` | Admin human | Phase is ended; current attachment | Prepare arena, reset round stats and readiness | Notice; static snapshot | Old combat state removed |
| design/active/ended -> lobby | `returnToLobby`/`restartLobby` | Admin human | Phase after design started; current attachment | Reset phase/rules-derived money/readiness as lobby state | Notice; static snapshot | Ships, bullets, effects removed |
| lobby/ended -> closed | `closeLobby` or inactivity | Admin/server | Admin if manual | Invalidate credentials, detach clients, delete room | `closed` to clients | Cancel pending timers, remove room lookup |
| lobby/design -> removed | `kick` | Admin human | Target exists, not requester | Remove target and invalidate credential | `kicked` to target; notice; snapshot | Cleanup ships/bullets/objectives |
| any -> removed | `leaveLobby` | Current player | Current attachment | Immediate permanent removal | `leftLobby` to requester; snapshot | Delete empty lobby room |

## Reset matrix

| Field | Start design | Active start | Rematch to design | Return to lobby | Close/delete |
| --- | --- | --- | --- | --- | --- |
| Stable player id | Preserved | Preserved | Preserved | Preserved for remaining slots | Removed |
| Resume credential | Preserved | Preserved | Preserved | Preserved for remaining slots | Invalidated |
| Display name/color/team | Preserved | Preserved | Preserved | Preserved | Removed |
| Readiness | Reset; bots ready | Preserved as ready | Reset; bots ready | Reset; bots ready | Removed |
| Ships/bullets/effects | Removed | Starter ships generated | Removed | Removed | Removed |
| Scores/kills/losses/captures | Reset | Accumulate | Reset | Reset | Removed |
| Money/economy counters | Reset to rules | Accumulate | Reset to rules | Reset to lobby defaults | Removed |
| Map/points | Prepared/regenerated from rules where applicable | Preserved | Prepared/regenerated | Neutral/reset | Removed |
| Admin | Preserved if eligible | Preserved | Preserved if eligible | Preserved/promoted if needed | Removed |

## Invariants

- One player slot has at most one active connection.
- One connection controls at most one player slot.
- Player IDs are unique and stable within a room.
- Display names cannot authorize reconnection.
- Normalized display names are unique among active and grace-period slots.
- Every ship owner references a current or grace-period player.
- `adminId` is `null` or references one eligible human player.
- Bots cannot be admin.
- Closed rooms cannot accept reconnects.
- Kicked or explicitly removed slots cannot be resumed.
- A stale socket cannot mutate a reclaimed player slot.

## Section 4 rematch and reset note

Lobby rule changes and design/rematch generation create a new map seed and reset objective ownership. Returning to lobby clears active match state but preserves the displayed map until rules change or the next design phase regenerates it. Winner finalization is idempotent and stops later score/control ticks from overwriting match end state.

## Section 7 destruction lifecycle note

Lethal combat damage and self-destruction now finalize a ship at most once. The
first finalization records the destruction timestamp, zeroes components, emits the
wreck/explosion effect and awards loss/kill/bounty accounting where applicable;
later duplicate calls are no-ops until normal wreck removal deletes the ship from
active room maps.

## Catch-up Part 1 lifecycle test status

Deterministic lifecycle coverage remains concentrated in `verify-lifecycle.js`, `verify-reconnect.js`, and `verify-lobby-refresh-reconnect.js`. These scripts are wired into `npm run test:integration` and the direct `npm run test:lifecycle` alias. They use controlled timers or short deterministic reconnect windows rather than long manual waits.

## Catch-up Part 2 stale attachment and rematch rules

Inbound gameplay commands are accepted only from the current socket attachment for a player. Replaced/stale sockets receive an error before selection, purchase, destruct, combat-style, rally, or movement state can change. Rematch/reset clears purchase idempotency caches, rally points, reward-finalization guards, and round accounting before starter deployment is evaluated.
