# Section 6 — Movement, commands, collisions, rally and bots

This document records the authoritative movement contract after the Section 6 review. It is intentionally an as-built contract, not a pathfinding or combat-AI redesign.

## Units and tick safety

- Positions, targets, rally points, asteroid centres and weapon ranges are world units.
- Velocity is world units per second; acceleration is world units per second squared.
- Angles and turn rates are radians and radians per second.
- Ship radius, collision radius, arrival distance and avoidance clearance are world units.
- `dt` is seconds. The server ignores non-finite, zero or negative movement `dt`, clamps unusually large movement ticks to 0.25 seconds, and subdivides movement integration into 30 Hz-sized substeps so snapshot frequency and browser frame rate cannot affect authoritative movement.
- Movement state is sanitized after integration: position, velocity, angle and targets are kept finite and in bounds.

## Movement state ownership

| Field | Owner and lifecycle |
|---|---|
| `x`, `y`, `vx`, `vy`, `angle` | Server movement owns authoritative pose. Spawn initializes them; movement, map/station collision and separation mutate them; snapshots expose pose/velocity/angle to clients for interpolation. |
| `targetX`, `targetY`, `arrived`, `isManualMove`, `commandMode` | Server command and movement own destination state. Commands and rally-spawn movement set targets, `commandMode` and clear stale arrival; arrival/braking and combat-style movement update them. |
| `combatStyle`, `focusTargetId`, `combatTargetId`, `repairTargetId` | Server command/combat own intent. Commands set focus/repair targets; combat may set `combatTargetId`; movement clears dead target/orbit state. |
| `orbitDirection` | Ship-owned and persistent: `1` clockwise, `-1` anticlockwise. Survives stance changes, so re-selecting Orbit resumes the way round the ship was already going. `movement.orbitDirection` mirrors it for the steering to read; the hull's copy is authoritative. |
| `movement.holdFacing`, `movement.holdCoverageRange`, `movement.orbitReversing`, `movement.orbitSteering`, `movement.orbitSpeedLimit`, `movement.orbitAvoidance` | Movement-only stance memory. Reset when the relevant target, command or stance changes — but a direction-only change resets the orbit steering and nothing else. `orbitSteering` is a separate flag from `orbitSpeedLimit` because a legitimate ceiling of zero and "not orbiting" must not share a sentinel. |
| `rallyPoint` | Player-owned authoritative rally target. It is validated and adjusted server-side; new purchased ships spawn-to-rally without commanding existing ships. |
| `validEngineIndices`, `blockedEngineIndices`, component Power state | Component-health/heat/power derived state consumed by movement stats. Destroyed, blocked, overheated or underpowered propulsion contributes reduced or zero movement. |
| `hullAngleWeapons` | Movement/combat-facing cache for hull-rotation candidate ranking; derived from immutable spawned design and not client-authored. |

## Command selection semantics

The active server connection for the stable player identity is the only connection that can issue commands. Commands outside the active phase are ignored. Client coordinates are clamped/adjusted server-side and movement rates are never accepted from the client.

- Omitted `shipIds`: intentional legacy "all owned live ships" command.
- Explicit empty `shipIds: []`: command no ships.
- One or more valid IDs: command only those owned, living ships.
- Mixed valid/invalid/enemy/removed IDs: command only owned, living matches; enemy ships are never mutated.
- Duplicate IDs: collapsed to one command target.
- Malformed ID arrays or more than 64 IDs: rejected safely and never interpreted as "all ships".

## Ground move destination

A plain right-click assigns each selected owned ship a deterministic, non-overlapping slot around the click. Each destination is clamped to world bounds and adjusted for obstacles with `nearestClearPoint`; stable ship ordering keeps slot assignment repeatable.

## Integration and collision order

Each movement substep runs in this order:

1. Ensure/sanitize target and pose state.
2. Resolve active combat movement target and combat style.
3. Choose desired heading, including local asteroid avoidance.
4. Rotate toward the desired heading using radians-per-second turn rate.
5. Apply forward thrust along the current hull angle and add engine heat only for live, valid engines.
6. Apply `dt`-aware damping.
7. Enforce maximum speed, including zeroing velocity when propulsion is unavailable.
8. Integrate position and clamp to world bounds.
9. Resolve asteroid, station-solid and world-edge collision as a safety net.

Shield regeneration is a separate combat-system stage, not part of movement integration. The room tick runs deterministic pairwise ship separation over living ships sorted by stable ID, followed by a final shared map/station-collision pass. Exact ship overlaps use a deterministic separation direction; separation applies between all living ships, allied or enemy, and remains simple O(n²) because fleet caps are intentionally small.

## Combat-style movement scope

Movement uses the spawned design's current effective ship-level weapon range (`blaster`, `missile`, `railgun`, `beam`) as an engagement-distance rule. Charge, Hold, Orbit, Kite and Static consume the same authoritative target but produce distinct movement intents. A ship with no operational conventional weapon stops safely, except an armed demolition-only Charge ship, which continues closing for contact.

## Orbit

Orbit is a travelling stance and shares none of Hold's geometry. It branches in `refreshEngagement` before any of the Hold range gate, standoff search or `holdEngaged` latch, because all of those are about arriving somewhere and stopping, and an orbiting ship never arrives.

Each tick, per ship:

1. The radial unit vector from the target to the hull, and the tangent for that ship's own direction. Screen y increases downward, so clockwise is the positive rotation — `orbitTangent` is the single place that sign becomes a heading.
2. A radial correction proportional to the error between the current range and the orbit radius, clamped and tapered over `ORBIT_CORRECTION_BAND`. Combining it with the tangent gives one desired direction: mostly tangent on the radius, part inward outside it, part outward inside it.
3. A virtual aim point `ORBIT_LOOKAHEAD_DISTANCE` along that direction. It is regenerated from wherever the hull has got to and is never reached, which is what makes the approach a continuous spiral rather than a sequence of go-there-and-stop hops. Because it is a bearing and not a place, arrival braking and the goal-turn speed limit are deliberately not applied to it.
4. A speed ceiling of `turnRate × radius × ORBIT_TURN_MARGIN`. A circle cannot be flown faster than the hull can turn through it, so an agile ship orbits quickly, a sluggish or gyro-damaged one orbits slowly instead of overshooting the circle forever.

The orbit radius comes from `mainBatteryOrbitRange` in `combat.js`, not from `getMaxEffectiveWeaponRange`. It is the main battery's reach charged the full mount offset of its worst member, so it holds at any hull heading — which matters because an orbiting hull's heading changes continuously. Secondaries much shorter than the longest gun get no vote, by the same rule Hold uses. A contact floor keeps a short-ranged brawler orbiting around its target rather than through it.

### Orbit obstacle avoidance

Avoidance is a committed manoeuvre with three states, and the middle one is the point of it:

| State | Steering | Leaves when |
|---|---|---|
| `direct` | live tangent + radial field, aim point | the predicted path is blocked |
| `detour` | routed by `searchPathWorld` to a fixed rejoin point on the circle | there is a clear run, at full navigation clearance, to that rejoin point |
| `rejoin` | live field again, so the return is a curve rather than an arrival | the path ahead is clear **and** the ship is back on its radius and tangent |

The first version was reactive and got ships killed on the geometry it was supposed to avoid. It tested only the 180px aim point, so a ship whose braking distance exceeded that had no room left by the time it noticed; and it cleared the detour as soon as that short segment looked clear, which happened a few degrees into the turn — live steering then pulled straight back toward the target and into the side of the rock. Nothing in `detour` consults the aim point, and only the clear run to the committed rejoin point ends it.

Four separate mechanisms keep the hull off the geometry, and they are not interchangeable:

- **Detection horizon** (`orbitAvoidanceLookahead`): braking distance + reaction + envelope, times `ORBIT_AVOIDANCE_MARGIN`. This buys *orbiting*, not safety — seeing the obstacle early makes the response a course correction instead of one large deviation per lap.
- **Braking ceiling** (`orbitBrakingCeiling`): every tick, in every state, along the ship's *actual velocity* rather than its intended heading. This is the safety guarantee: the ship can always stop before what is directly ahead. Momentum, not planning, is what puts a hull into a rock its route went around.
- **Pinch escape**: a hull inside its own clearance envelope reads "zero distance until blocked", which as a speed ceiling is a trap — it cancels the velocity that would carry the ship out, and the ship sits against the rock permanently. It brakes to a standstill, then gets a crawl, and the crawl is withheld while the bare hull itself is about to make contact.
- **Detour route padding** (`ORBIT_AVOIDANCE_ROUTE_PAD`): a detour is planned wider than ordinary navigation, because it is flown under momentum around the outside of a corner. A route drawn along the edge of the ordinary envelope leaves a hull tracking it a few pixels wide of the line in contact.

Rejoin points are probed at increasing arcs ahead (`ORBIT_REJOIN_ARCS`) in the ship's own direction — avoidance never reverses a player's C/AC choice — and the first reachable one wins, so a large station simply pushes the choice further round. Detection is cadenced (`ORBIT_AVOIDANCE_SCAN_MS` when clear, `ORBIT_AVOIDANCE_REPLAN_MS` once committed) because the geometry is static; the orbit itself is never represented as a circular A\* path.

`verify-movement-orbit.js` covers this against the ship's *physical* collision radius and against real rotated station pieces. Measuring hull centre against asteroid radius alone — as an earlier version did — reports a comfortable margin for a ship that is flat against the rock.

Hull facing follows the flight path, because the aim point is the destination and the ordinary steering points the nose at it. Hold's stationary weapon-facing decision is not applied — that one picks an orientation for a ship that has stopped. Weapons track and fire independently throughout, including while the ship is still closing on its radius, which is what makes the C/AC choice tactical for a broadside hull: it decides which side of the ship faces inward.

Nothing above is fleet-level. Every ship orbits from the angular position it already had, so the spacing a group arrives with is preserved without a formation controller being involved, and no two ships share a waypoint.

Reversing direction is a manoeuvre. `applyOrbitDirection` sets `orbitReversing`; the desired direction is already the new tangent, so the hull turns onto it while the speed ceiling drops to `ORBIT_REVERSAL_SPEED` and braking sheds the old tangential momentum. It completes when that momentum is gone or the hull has come round far enough. Velocity is never flipped, and the reversal costs the ship nothing else — see `setOrbitDirection` in `docs/protocol-messages.md`.

## Rally and bot movement

Rally points are clamped to the world and adjusted away from asteroids on the server. Setting a rally point does not command existing ships; newly purchased ships receive the current authoritative rally target. Bots use the same `commandShips` path as players, so bot target validation and obstacle adjustment remain server-authoritative and deterministic.

## Catch-up Part 2 selection attachment rules

Movement uses the shared selected-ship normalizer. Omitted `shipIds` is the intentional all-owned-live fleet shortcut for movement, while explicit empty arrays command zero ships. Focus and repair targets are applied only to the normalized owned living selection; enemy IDs in `shipIds` cannot be commanded and allied/enemy target IDs are validated by relationship before being attached.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.
