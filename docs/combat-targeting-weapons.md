# Section 7 — Combat, targeting, weapons and destruction

This document records the current server-authoritative combat contract after the
Section 7 review. It is intentionally an as-built contract with targeted safety
fixes, not a combat rebalance.

## Authoritative combat update order

`server.js` runs active-room combat in this order: bot decisions, economy,
self-destruct countdowns, destroyed-ship removal, live-ship movement, ship
separation, map collision resolution, repair/support, weapon aiming/firing,
ship heat, projectile simulation, capture updates, and scoring. Non-active rooms
only age effects. Combat systems operate on the live-ship list captured after
self-destruction and removal, so dead ships do not receive movement, support or
weapon updates later in that tick.

## Allegiance and ownership

Ship, projectile, repair and point-defence ownership is keyed by stable player
id. In teams mode equal team ids are allied and unequal team ids are enemies; the
team labels are not assumed to be only blue/red. In solo mode every distinct
present player is an enemy while a player's own ships remain allied. Unknown or
removed owners are not valid enemies, but existing projectile owner ids are kept
for attribution while the projectile exists.

## Targeting semantics

Ship-level acquisition considers only living enemies, requires line of sight, and
prefers a valid focused target within the existing acquisition envelope. Automatic
acquisition uses nearest distance with stable ship id as the tie-break, so equal
candidates do not depend on array or map insertion order. Per-weapon firing is
separate from the ship-level target: a weapon prefers the assigned target when
that target is in that weapon's own range and line of sight, otherwise it may use
a valid in-range fallback enemy without overwriting `combatTargetId` or
`focusTargetId`.

## Turrets, arcs and muzzle geometry

Turrets use design-index-aligned arrays for cooldowns, current angles, desired
angles, aim target ids and fire target ids. Destroyed weapons clear aim/fire
targets and do not fire. Turrets may keep aiming while reloading or while safe
zone rules block firing. Multi-cell weapon pivots use the footprint centre; muzzle
distance comes from shared turret rules so server projectile/effect origins match
client rendering.

## Line of sight and collision precedence

Target acquisition, per-weapon fallback, beams and point defence use asteroid
line-of-sight checks. Projectile movement uses swept collision from the previous
position to the new position. The earliest collision on the segment wins across
asteroids, shield bubbles and live hull modules; equal collision times use stable
entity id or component index tie-breaks. Asteroid impacts therefore prevent later
ship impacts on the same segment, and one projectile produces one primary impact.

## Weapon-family behaviour

Blasters and railguns fire unguided projectiles; their target id is attribution
metadata and does not home the shot. Missiles track only living enemy targets,
respect tracking delay/time and remain interceptable. Beams apply continuous
damage scaled by `dt` and stop at the nearest blocking asteroid endpoint; visual
beam throttling does not throttle damage. Point defence selects only enemy
interceptable projectiles, prioritizing projectiles targeting the protected ship,
then allied ships, then other valid enemy projectiles, with configured type
priority and stable id tie-breaks before falling back to ships where configured.
Decoys affect only enemy interceptable guided projectiles targeting the ship and
use room-injectable combat RNG for deterministic tests.

## Safe zones, damage, repair and destruction

Safe zones block firing and damage against protected ships; aiming continues and
blocked shots consume no cooldown or firing heat. Shields absorb damage before
hull overflow according to the existing shield multiplier and absorption rules.
Hull/component damage uses footprint-aware component geometry and destroyed
components no longer act. Local repair modules repair self only; repair beams can
repair damaged living allies in range, with assigned repair targets preferred
while valid. Ship destruction and self-destruction finalization are idempotent:
losses, kills, bounty, component zeroing and explosion effects are recorded once.

## Deterministic combat RNG and invariants

Production combat remains varied by defaulting to `Math.random`, but tests can
set `room.combatRandom` to an injected deterministic generator. Authoritative
weapon spread and decoy rolls use that room-scoped stream. The combat unit tests
cover allegiance matrices, stable targeting tie-breaks, point-defence priority,
asteroid-first projectile collision and destruction idempotency with seed `1234`.

## Snapshot and client rendering notes

Normal snapshots expose combat state through aligned component HP, shield/HP,
alive state, weapon angles, target ids, projectiles and effects. Turret diagnostic
fields remain dev/test diagnostics and are not part of normal production
snapshots. The client renders authoritative weapon angles and uses fallback angles
only before server values arrive.

## Deferred risks

This section did not rebalance weapons or redesign combat AI. Deeper heat,
power, shutdown and meltdown transitions remain Section 8 work. Broader
full-stack browser combat scenarios and maximum-fleet performance soak should be
expanded once additional production-safe test hooks exist.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.
