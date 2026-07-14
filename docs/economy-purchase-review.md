# Section 5 — Economy, purchases, fleet limits, rewards, and UI review

## Authoritative field ownership

| Field | Meaning / unit | Mutated by | Reset | Snapshot visibility | Gameplay vs display |
|---|---|---|---|---|---|
| `money` | Server-authoritative current match currency; fractional dollars are retained internally. | income ticks, capture rewards, kill bounties, committed purchases, match rewards, match/lobby resets. | Match/design/lobby reset to room starting money. | Floored for owner/team during active match; enemies receive `null`; all players see final summaries after match end. | Gameplay affordability and display. |
| `bank` | Display carry-over mirror of post-match money; no persistent progression is created. | join/reset and match reward finalization. | New room/rules/lobby reset. | Not currently snapshotted. | Display/history only. |
| `income` | Current authoritative dollars per second. | `updateEconomy`. | Base income on match reset; zero for unready or ended players. | Owner/team only during active match. | HUD display and income accounting. |
| `earned` | Lifetime within current round of starting money plus income and rewards that were credited before max-money clamping exceptions. | join/reset, income, capture, bounty, match reward. | Match/design/lobby reset to starting money. | Owner/team during active match; everyone after end. | Accounting display. |
| `spent` | Sum of committed purchase costs for the current round, including starter ship. | purchase transaction and starter spawn. | Match/design/lobby reset. | Owner/team during active match; everyone after end. | Accounting display/reward inputs. |
| `maxMoney` | Currency cap in dollars. | join/rules setup. | Rules/lobby reset. | Not directly snapshotted. | Gameplay clamp. |
| `shipCap` | Maximum living owned ships. | join/setup only. | New player/bot setup. | Public. | Gameplay and UI cap display. |
| `shipsBuilt` | Count of successfully committed ships in current round, including starter. | successful spawn/purchase. | Round reset. | Public. | End-game display. |
| `deployedFleetCost` | Sum of committed ship costs deployed during the round, including ships later destroyed. | successful starter/purchase transaction. | Round reset. | Owner/team during active match; everyone after end. | Reward inputs and display. |
| `destroyedEnemyCost` | Sum of authoritative costs of enemy ships credited to this player. | `destroyShip` kill-credit flow. | Round reset. | Public currently, because combat results are visible and final reward calculations use it. | Reward input and end-game display. |
| `lostFleetCost` | Sum of authoritative costs of this player's ships destroyed or self-destructed. | destruction/self-destruction flows. | Round reset. | Public currently. | End-game display/reward context. |
| `lastReward` | Last finalized match reward breakdown. | idempotent match-finalization path. | New round/lobby reset. | Included in snapshots; meaningful after match end. | End-game display. |
| `lastBuildError` | Last server build/purchase validation error. | failed validation; cleared by reset/success. | Round reset and successful purchase. | Not snapshotted. | Server diagnostics / future UI hook. |
| `purchaseRequests` | Per-player bounded idempotency cache for completed buy requests. | purchase executor. | Round reset/player removal/room close by object disposal. | Never snapshotted. | Protocol safety only. |

## Precision strategy

The server retains fractional `money` and `earned` values for time-based income. Affordability compares the exact authoritative floating value against exact integer ship totals, so a player with exactly the required amount can buy and a player below the required amount cannot buy because the UI rounded up. Snapshots floor current money for display so the HUD never shows more money than the server will spend. Income subdivision is expected to be equivalent within normal floating-point tolerance.

All valid transactions clamp current money to finite non-negative values and `maxMoney` clamps income and rewards. Accounting fields are cumulative round fields, not a strict `startingMoney + earned - spent = money` identity, because money can be capped by `maxMoney` and `earned` intentionally records credited sources.

## Purchase protocol and atomicity

`buyShip` requests are server-authoritative. The client sends an immutable blueprint snapshot, quantity, combat style, and request ID; the server validates the design, recomputes stats and cost, checks active phase, readiness, exact funds, and living fleet slots. Quantity purchases are all-or-nothing.

Completed request IDs are remembered per player for 2 minutes or the latest 64 entries, whichever is smaller. Replaying the same ID with an identical payload returns the original result without charging or spawning. Reusing the ID with different payload is rejected as `duplicate-request-conflict`. Empty/malformed IDs are rejected as `invalid-request`. The cache is scoped by the player object in the room and is cleared on round reset or discarded when the player/room is removed.

Successful `purchaseResult` messages include `requestId`, `ok`, `code`, `count`, `unitCost`, `totalCost`, `shipIds`, resulting floored `money`, `activeShips`, and `shipCap`. Failures include `requestId`, stable `code`, and a player-safe message. Room-wide purchase notices announce construction without exposing exact enemy purchase cost.

## Fleet-cap semantics

The fleet cap counts living owned ships (`ship.alive === true`). Destroyed ships free their slot immediately when they are marked not alive, even if their wreck remains visible until removal. Removed ships, failed spawns, and stale pending requests do not count. Starter ships and bot ships use the same living-ship rule for their owning player.

## Starter ships and active blueprints

Readiness validates that the selected starter design is valid and affordable, but does not deduct money. When all active players are ready and the match starts, each ready player is reset to starting money and charged exactly once for the spawned starter ship. The intended model is therefore: `starting money - starter ship cost` after successful starter deployment. Editing or saving an active-match blueprint remains free; money is deducted only by a successful buy request using the immutable design supplied in that request.

## Rewards and income flow

Income is calculated on the server from base income plus fully owned relays. Team mode keys relay income by team; solo mode keys it by player-owned team IDs. Disconnected grace-period players remain in `room.players`, keep their ships, and continue receiving active-match income until permanently removed. Permanently removed players are deleted from the room and receive no further income.

Capture rewards are awarded once when relay ownership flips; all players on the capturing team receive the configured capture bonus. Kill bounties are awarded once in `destroyShip` to the credited attacker when attacker and victim owners differ. Self-destruction and environmental/no-attacker destruction do not pay a bounty. Match rewards are finalized once by the winner finalizer and are display-only within the current room; they do not create long-term progression.

## Catch-up Part 2 completion notes

The purchase executor now snapshots and restores all persistent transaction state if spawning fails: created ships are removed from the room map and player array, entity IDs and effects are rewound, accounting fields (`money`, `spent`, `deployedFleetCost`, `shipsBuilt`) and `lastBuildError` are restored, and failed spawn requests do not enter the successful idempotency path. Request IDs remain bounded and replay-safe: identical successful replays return the original result without charging or spawning again, while conflicting reuse is rejected.

Reward finalization is guarded in the reward layer so repeated calls for the same winner team do not add money/earned twice or replace reward history with a second calculation.
