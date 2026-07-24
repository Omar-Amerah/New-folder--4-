# Drone Bay first pass

The Drone Bay is a server-authoritative 2x2 carrier component. A Blueprint stores
one fixed `fighter`, `defence`, or `repair` type on each bay. Every bay owns three
independent squad slots, launches through a deterministic exterior edge, and
rebuilds at most one destroyed slot at a time.

Runtime drones are transient combat entities, not ships. They do not consume
fleet slots, carry player Blueprints, appear in the main target cycle, or accept
individual orders. The server owns their movement, targeting, repair, damage,
destruction, production, Power, Heat, and snapshot state. The client renders
snapshots and may only request the parent bay's Deploy/Recall mode.

Authoritative limits and tuning live in `component-balance.json`. The initial
safety limits are four bays and twelve active drones per ship, with a
forty-eight-active-drone cap per player.

## Weapon targeting

Targeting decisions stay per weapon; a drone never redirects the whole parent
ship's combat target. Point Defence handles incoming interceptable projectiles,
then hostile drones. Main and heavy weapons remain ship-first and only fire at
a drone when no enemy ship is available to that weapon. Rapid, agile blasters
may temporarily divert to a drone when its server-side threat score is high
enough. That score considers attacks against the ship, carried weapon output,
proximity, vulnerable-module intent, and nearby armed swarm size.

Fighter movement also evaluates hostile projectile trajectories every server
tick. It predicts closest approach over the authoritative look-ahead window and
blends a deterministic perpendicular dodge into the normal pursuit/orbit path
when a bullet, rail shot, torpedo, or missile will breach its clearance radius.
Friendly and safely receding projectiles do not cause evasive weaving.

## Deliberately deferred

- Player-designed or separately purchased drones
- Mixed types or shared production across bays
- Individual drone selection, orders, formations, or upgrades
- Capture and boarding drones
- More advanced Defence-drone missile assignment beyond the current local
  interceptable-projectile priority
