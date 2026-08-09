# Maps, game modes, objectives, and match progression

## Data flow and seed lifecycle

Production rooms create a random `mapSeed` once for each generated arena. The seed is stored on the room and passed into the deterministic map generator; static snapshots expose the generated `map.seed` so a failed or unfair arena can be reproduced in tests. Tests may inject a seed through `generateMap(..., { seed })`.

Starting design, changing lobby rules, and rematching regenerate the map with a new production seed. Returning to lobby preserves the currently displayed lobby map until rules or design start regenerates it. Generation validates its own output. Development and tests fail loudly with the seed and input context; production logs the failure and falls back to a single central relay, no asteroids, and mode-appropriate safe zones instead of crashing the process.

## World-size selection

Manual map-size labels select the matching configured world. Invalid labels sanitize to `auto`. Automatic selection uses current room player slots, including bots and disconnected grace-period players that still occupy the room, and chooses the first configured world whose `maxPlayers` admits that count.

## Map schema

A generated map contains:

- `seed`: public deterministic seed.
- `name`: display name.
- `safeZones`: spawn/safety markers. Team mode has blue and red side zones; solo mode has four neutral spawn zones.
- `relays`: authoritative capture objectives.
- `asteroids`: authoritative collision circles plus visual shape metadata.
- `clouds`: visual-only background nebulae.

Stars, clouds, and decorative effects are not authoritative gameplay geometry. Relays and asteroids are gameplay geometry and are sent in static snapshots.

## Teams versus solo semantics

Teams mode uses team keys (`blue`, `red`) for enemies, relay ownership, relay income, player grouping, control victory, and safe zones. If the player who last captured a team relay leaves, the relay remains owned by that team and its credit owner is reassigned to a remaining teammate when possible.

Solo mode uses player IDs as ownership keys. A solo player's `team` is their stable player ID for compatibility with existing ally/enemy checks. Relay `ownerId` is the winning player and `ownerTeam` mirrors the same player ID for older client fields. Removing a solo owner neutralizes their relay.

## Spawn planning

Starter ships and built ships use the same spawn rules for humans and bots. Team players spawn in deterministic lanes inside their side's safe zone. Solo players are assigned deterministic slots around the arena. Per-ship jitter is seeded from the room map seed, player ID, ship index, and entity ID, then clamped through `nearestClearPoint` so ships avoid world edges and collision geometry.

## Relay capture state machine

Ships count when alive, owned by a current player, and inside relay radius. Capture strength is one plus capture bonus component effects. Equal leading opposing strength marks a relay contested and freezes progress. No ships decay progress toward neutral. A clear leader reverses progress; when progress reaches zero, ownership flips, progress is restarted, capture credit is awarded, and the capture reward is paid once for that ownership change. Multiple friendly ships accelerate capture through their summed capture strength.

## Victory rule and economy incentives

There is one win condition: capture every relay and hold full control continuously for 20 seconds. `src/server/objectives.js` starts one authoritative countdown when a team or solo player fully owns every uncontested relay. Losing ownership or contesting any relay immediately resets the countdown; regaining full control starts a fresh 20-second hold. Victory finalization is idempotent, so later ticks cannot overwrite an ended match.

Captures still increment the capture statistic and award `economy.captureBonus`. Fully owned relays still add `economy.relayIncome` to each eligible teammate's income. Kills still award bounties, and post-match rewards and highlights still use combat, fleet, capture, and economy statistics. None of these rewards create a second victory path.

## Reset matrix

| Transition | Map seed/name/world | Relays/asteroids/clouds/safe zones | Ownership/progress/captures/winner/control | Ships/bullets/effects/rally | Money/stats | Rules/teams/bots |
| --- | --- | --- | --- | --- | --- | --- |
| Lobby rule change | Regenerated | Regenerated | Reset | Removed where applicable | Starting money reapplied | Updated rules; teams normalized by mode |
| Lobby -> design | Regenerated | Regenerated | Reset | Removed; no starter ships yet | Round stats reset | Preserved |
| Design -> active | Preserved from design | Preserved | Control reset | Starter fleets spawned once | Starting economy active | Preserved |
| Ended -> design rematch | Regenerated | Regenerated | Reset | Removed; no starter ships yet | Round stats reset | Preserved |
| Design/active/ended -> lobby | Preserved until next rule/start generation | Preserved | Reset | Removed | Round stats reset | Preserved |
| Room closure | Removed | Removed | Removed | Removed | Removed | Removed |

## Test strategy and deferred risks

`verify-maps-objectives.js` covers fixed deterministic seeds across all configured world sizes, both modes, and every asteroid density, plus direct relay-capture invariants. `verify-control-victory.js` covers continuous holds, interruption/reset behavior, solo parity, and retained capture/relay economy rewards. Wider browser objective rendering and real-protocol forced victory hooks remain deferred because they require explicit test-only server controls that should not be exposed in production.

## Map and objective verification

Map, spawn-reservation, and objective invariants are exercised by `verify-maps-objectives.js`, exposed as `npm run test:maps`, `npm run test:spawn-planner`, `npm run test:map-invariants`, and `npm run test:objectives`. The checks use focused fixtures and broad invariants rather than brittle full-map snapshots, and failure messages include the seed/input context generated by the verifier.

## Objective and victory test expectations

Objective coverage distinguishes capture, economy rewards, victory finalization, and reset behavior. Capture rates, countdown duration, and reward values are not changed by these tests. Broader capture/victory/reset cases remain outside this focused invariant suite.

## Spawn safe-zone authority

Safe zones are now derived from the same deterministic spawn-region plan that places players. The planner keys on map seed, game mode, world size, player IDs, teams, bot flags, and ship-radius reservation statistics; rule, team, bot, player-layout, arena-preparation and rematch changes invalidate the cached plan before new zones are exposed. Each planned spawn has exactly one generated spawn zone containing a one-hull launch reservation. Zones are checked against world bounds, relays and asteroids using the same generated `map.safeZones` list consumed by combat and snapshots.

Team mode creates generated team-owned spawn zones (`team: blue` or `team: red`) for the planned spawn slots. A ship standing in a zone matching its team is protected and cannot fire while protected; allies of that team receive the same spawn protection. Enemies entering that geometry are not protected. Projectiles or beams that resolve against a protected target do no damage, and ships that move into their own/team zone after firing are still blocked from further firing while protected.

Solo mode creates generated owner-owned zones (`ownerId`) for each player spawn slot. Only the owner receives protection in that zone; another solo player entering it is treated as an enemy and is not protected. This keeps spawn protection tied to spawning players rather than turning all generated zones into permanent universal shelters.
