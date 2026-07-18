# Section 6 — Movement, commands, formations, collisions, rally and bots

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
| `x`, `y`, `vx`, `vy`, `angle` | Server movement owns authoritative pose. Spawn initializes them; movement, asteroid collision and separation mutate them; snapshots expose pose/velocity/angle to clients for interpolation. |
| `targetX`, `targetY`, `arrived`, `isManualMove` | Server command and movement own destination state. Commands and rally-spawn movement set targets and clear stale arrival; arrival/braking and combat-style movement update them. |
| `combatStyle`, `focusTargetId`, `combatTargetId`, `repairTargetId` | Server command/combat own intent. Commands set focus/repair targets; combat may set `combatTargetId`; movement clears dead target/orbit state. |
| `orbitDir`, `lastOrbitTargetId` | Movement-only cache for circle style; reset when target/style changes or target dies. |
| `formationX`, `formationY` | Command-owned metadata describing the assigned formation-relative slot offset. |
| `rallyPoint` | Player-owned authoritative rally target. It is validated and adjusted server-side; new purchased ships spawn-to-rally without commanding existing ships. |
| `validEngineIndices`, `blockedEngineIndices`, component Power state | Component-health/heat/power derived state consumed by movement stats. Destroyed, blocked, overheated or underpowered propulsion contributes reduced or zero movement. |
| `hullAngleWeapons` | Movement/combat-facing cache for hull rotation scoring; derived from immutable spawned design and not client-authored. |

## Command selection semantics

The active server connection for the stable player identity is the only connection that can issue commands. Commands outside the active phase are ignored. Client coordinates are clamped/adjusted server-side and movement rates are never accepted from the client.

- Omitted `shipIds`: intentional legacy "all owned live ships" command.
- Explicit empty `shipIds: []`: command no ships.
- One or more valid IDs: command only those owned, living ships.
- Mixed valid/invalid/enemy/removed IDs: command only owned, living matches; enemy ships are never mutated.
- Duplicate IDs: collapsed to one command target.
- Malformed ID arrays or more than 64 IDs: rejected safely and never interpreted as "all ships".

## Formation planner

The pure server planner supports the existing `line`, `wedge` and `clump` shapes. It sorts ships by stable ship ID before assigning slots, so repeated identical commands and reversed client selection order produce stable assignments. Slot spacing is based on the largest selected radius with a per-ship minimum, keeping mixed-size fleets from overlapping. Formation direction currently defaults to fixed world axes to preserve existing controls; callers may pass a direction for future oriented commands.

The planner first adjusts the destination to a nearest clear point, then adjusts each slot independently with the same bounded clear-point helper. This keeps slots inside world bounds, clears asteroid constraints when possible, and avoids collapsing the whole fleet to an identical target when the requested destination is near an obstacle.

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
9. Resolve asteroid collision as a safety net and damp velocity into rocks.
10. Regenerate shields.

The room tick then runs deterministic pairwise ship separation over living ships sorted by stable ID, followed by a final asteroid-collision pass. Exact ship overlaps use a deterministic separation direction; separation applies between all living ships, allied or enemy, and remains simple O(n²) because fleet caps are intentionally small.

## Combat-style movement scope

Movement uses the spawned design's maximum ship-level weapon range (`blaster`, `missile`, `railgun`, `beam`) as an engagement-distance rule. It does not duplicate the full weapon-targeting system and does not account for temporary turret state. Ships with no movement range close directly to an existing valid target. `charge`, `hold`, `sentry` and `circle` retain their existing ratios and hysteresis; circle keeps a stable orbit direction per target and clears it on target death/change.

## Rally and bot movement

Rally points are clamped to the world and adjusted away from asteroids on the server. Setting a rally point does not command existing ships; newly purchased ships receive the current authoritative rally target. Bots use the same `commandShips` path as players, so bot target validation, formation planning and obstacle adjustment remain server-authoritative and deterministic.

## Catch-up Part 2 selection attachment rules

Movement uses the shared selected-ship normalizer. Omitted `shipIds` is the intentional all-owned-live fleet shortcut for movement, while explicit empty arrays command zero ships. Focus and repair targets are applied only to the normalized owned living selection; enemy IDs in `shipIds` cannot be commanded and allied/enemy target IDs are validated by relationship before being attached.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.
