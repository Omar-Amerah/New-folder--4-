# Maps, game modes, objectives, scoring, and match progression

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

Teams mode uses team keys (`blue`, `red`) for enemies, relay ownership, relay income, scoring, control victory, scoreboard grouping, victory, and safe zones. If the player who last captured a team relay leaves, the relay remains owned by that team and its credit owner is reassigned to a remaining teammate when possible.

Solo mode uses player IDs as ownership keys. A solo player's `team` is their stable player ID for compatibility with existing ally/enemy checks. Relay `ownerId` is the winning player and `ownerTeam` mirrors the same player ID for older client fields. Removing a solo owner neutralizes their relay.

## Spawn planning

Starter ships and built ships use the same spawn rules for humans and bots. Team players spawn in deterministic lanes inside their side's safe zone. Solo players are assigned deterministic slots around the arena. Per-ship jitter is seeded from the room map seed, player ID, ship index, and entity ID, then clamped through `nearestClearPoint` so ships avoid world edges and collision geometry.

## Relay capture state machine

Ships count when alive, owned by a current player, and inside relay radius. Capture strength is one plus capture bonus component effects. Equal leading opposing strength marks a relay contested and freezes progress. No ships decay progress toward neutral. A clear leader reverses progress; when progress reaches zero, ownership flips, progress is restarted, capture credit is awarded, and the capture reward is paid once for that ownership change. Multiple friendly ships accelerate capture through their summed capture strength.

## Scoring and victory precedence

The score authority is `src/server/objectives.js`. Score sources are capture credit, periodic controlled-relay score, kill/destruction rewards from combat/economy, and final rewards. Periodic relay score uses team ownership in teams mode and player ownership in solo mode; contested or partially captured relays do not score.

Victory finalization is idempotent: once a winner exists or the phase is `ended`, later ticks cannot overwrite it. Score victory is checked after periodic score ticks and before control victory. Ties are resolved deterministically by sorted ownership key. Team control victory starts a single 20-second countdown when one team fully controls every relay; it resets immediately on loss/contest. Solo full control wins immediately, matching the current UI rule.

## Reset matrix

| Transition | Map seed/name/world | Relays/asteroids/clouds/safe zones | Ownership/progress/score/captures/winner/control | Ships/bullets/effects/rally | Money/stats | Rules/teams/bots |
| --- | --- | --- | --- | --- | --- | --- |
| Lobby rule change | Regenerated | Regenerated | Reset | Removed where applicable | Starting money reapplied | Updated rules; teams normalized by mode |
| Lobby -> design | Regenerated | Regenerated | Reset | Removed; no starter ships yet | Round stats reset | Preserved |
| Design -> active | Preserved from design | Preserved | Score/control reset | Starter fleets spawned once | Starting economy active | Preserved |
| Ended -> design rematch | Regenerated | Regenerated | Reset | Removed; no starter ships yet | Round stats reset | Preserved |
| Design/active/ended -> lobby | Preserved until next rule/start generation | Preserved | Reset | Removed | Round stats reset | Preserved |
| Room closure | Removed | Removed | Removed | Removed | Removed | Removed |

## Test strategy and deferred risks

`verify-maps-objectives.js` covers fixed deterministic seeds across all configured world sizes, both modes, and every asteroid density, plus direct relay capture/scoring invariants. Wider browser objective rendering and real-protocol forced victory hooks remain deferred because they require explicit test-only server controls that should not be exposed in production.

## Catch-up Part 1 map/objective test status

Map, spawn-reservation, and objective invariants are exercised by `verify-maps-objectives.js`, exposed as `npm run test:maps`, `npm run test:spawn-planner`, `npm run test:map-invariants`, and `npm run test:objectives`. The checks use focused fixtures and broad invariants rather than brittle full-map snapshots, and failure messages include the seed/input context generated by the verifier.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.

## Objective and victory test expectations

Objective coverage must distinguish capture, scoring, victory finalization, and reset behavior. Capture and scoring rates, countdown duration, and reward values are balance constants and must not be changed by test catch-up work. Broader capture/victory/reset cases beyond the current invariant suite are intentionally deferred to the Section 13 final regression pass.

## Spawn safe-zone authority

Safe zones are now derived from the same deterministic spawn-region plan that places players. The planner keys on map seed, game mode, world size, player IDs, teams, bot flags, fleet cap and ship/fleet reservation statistics; rule, team, bot, player-layout, arena-preparation and rematch changes invalidate the cached plan before new zones are exposed. Each planned spawn has exactly one generated spawn zone containing its starter-fleet reservation radius. Zones are checked against world bounds, relays and asteroids using the same generated `map.safeZones` list consumed by combat and snapshots.

Team mode creates generated team-owned spawn zones (`team: blue` or `team: red`) for the planned spawn slots. A ship standing in a zone matching its team is protected and cannot fire while protected; allies of that team receive the same spawn protection. Enemies entering that geometry are not protected. Projectiles or beams that resolve against a protected target do no damage, and ships that move into their own/team zone after firing are still blocked from further firing while protected.

Solo mode creates generated owner-owned zones (`ownerId`) for each player spawn slot. Only the owner receives protection in that zone; another solo player entering it is treated as an enemy and is not protected. This keeps spawn protection tied to spawning players rather than turning all generated zones into permanent universal shelters.
