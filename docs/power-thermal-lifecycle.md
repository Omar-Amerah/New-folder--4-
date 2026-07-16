# Section 8B power, thermal effects, and component lifecycle

Section 8B keeps power aggregate-only. There is no local routing, wiring, cable, circuit, or battery charge simulation.

## Runtime heat policy

Authoritative heat is stored per component by immutable design index. Operational heat is added only when an action actually happens: weapons add firing heat only after passing block, cooldown, target, component-health, and thermal-power checks; beams add heat proportional to `dt`; shield modules add heat proportional to actual shield restored; repair modules add heat proportional to actual repair output; destroyed generators do not create passive load heat.

Destroyed components retain their stored heat instead of dumping or clearing it. Retained heat remains visible in the component array, but destroyed systems do not generate, fire, thrust, cool actively, provide power, provide utility bonuses, or participate as live thermal-route nodes.

## Role-specific thermal effects

Thermal state effects are role-specific:

- active systems use `activeOutputForState`: weapons, propulsion, shield recharge, repair, generators, and utility bonuses;
- armour uses `passiveProtectionForState` for flat damage reduction;
- frames and passive structure use `structuralDamageMultiplierForState` for incoming component damage;
- radiators use `activeCoolingForState` for active cooling, plus a small passive floor that lets them recover from overheat;
- heat pipes transfer heat through topology and are not output-multiplied.

## Aggregate power policy

Power remains a ship-level aggregate. `ship.stats.powerGeneration` and `ship.stats.powerUse` describe nominal live-component totals after destruction or repair recalculation. Static underpower is represented by stats efficiency. Runtime generator thermal degradation is represented separately by `thermalPowerFactor`, which is a nominal-generation-weighted ratio of available generator output to live nominal generator output.

Destroyed generators contribute neither nominal nor available generation. Repaired generators are restored by the normal effective-stat recalculation path. Underpower efficiency and thermal generator degradation are separate factors and must not be double-applied.

## Batteries and capacitors

`energyStorage` is currently an aggregate stat only. It can appear in computed stats and UI data, and destroyed/repaired storage components affect that aggregate stat, but there is no runtime charge/discharge, reserve-power, or capacitor burst simulation. Section 8B intentionally documents this current behaviour rather than inventing battery gameplay.

## Meltdown policy

Only live power generators are meltdown-eligible. A generator must remain in `OVERHEATED` state for the full configured delay. Leaving overheat reduces its timer by the existing recovery rule. Destroyed reactors do not continue ticking. When a meltdown detonates, its timer is reset, the reactor is destroyed, nearby components take footprint-centre component damage, and one boom effect is emitted. Detonation damage is HP damage rather than heat, so it does not cause an instant heat chain reaction.
# Phase 5E runtime ownership

Power topology, nominal live generation, demand, and per-component network
membership are rebuilt only on wiring/component boundary events. Movement and
active utilities may apply the cached multiplier with current thermal
performance each tick; they do not rebuild topology or reapply the legacy
ship-wide deficit penalty.

Radiator cooling is split explicitly: 12% of catalogue cooling is a passive
radiative floor, while the remaining active state-dependent output requires
component Power and scales by its network multiplier. Heat capacity,
conductivity, Heat Pipe routing, and natural dissipation remain passive.

Generator steady heat uses demand/generation from the source's own cached live
network. Nominal source generation does not currently fall with temperature;
existing overheat failure and meltdown behavior remains separate. Coupling
thermal source derating back into network efficiency is deferred to balancing
to avoid an intra-tick feedback loop.
