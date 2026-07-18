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

Power-network allocation is authoritative per physical network. `ship.stats.powerGeneration` and `ship.stats.powerUse` describe nominal live-component totals after destruction or repair recalculation, while each runtime network computes effective source output: NORMAL, WARM, HOT and CRITICAL generators supply full nominal MW; OVERHEATED or destroyed generators supply zero MW. Cooling below the OVERHEATED recovery boundary restores nominal generation without rebuilding Wiring topology.

Destroyed generators contribute neither nominal nor available generation. Repaired generators are restored by the normal effective-stat recalculation path. Underpower efficiency and OVERHEATED source shutdown are separate factors and must not be double-applied.

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
network. Nominal source generation does not fall with temperature below OVERHEATED;
existing OVERHEATED failure and meltdown behavior remains separate. Gradual
thermal source derating below OVERHEATED is intentionally not part of this
lifecycle to avoid an intra-tick feedback loop.

## Heat hardening lifecycle

Heat Sinks are passive, zero-Power thermal mass. Their own capacity and the
35-unit bonus they grant each adjacent component scale continuously with current
HP; capacity loss never deletes retained heat, and a zero-capacity hot wreck is
reported as saturated. Radiators remain Power consumers: their active cooling
uses their component-local Power multiplier, while the passive radiative floor
remains available when disconnected.

Component HP mutation precedes boundary handling. An alive/destroyed transition
then refreshes runtime hull exposure, thermal routes and hosted Wiring v2 before
Power-dependent effective stats. Generator OVERHEATED boundary changes reuse the live
wiring projection and reallocate only that generator's network. WARM, HOT and
CRITICAL generators continue to provide nominal live generation to Power
allocation. Generator load heat is the capped demand/nominal-live-generation
ratio of its own network. Meltdown progress is cleared on generator destruction; a repaired hot
generator begins a new timer without losing retained heat.

Destroyed components retain stored heat but are excluded from live aggregate
capacity, pressure, generation, output and active cooling. Wrecks cannot act as
frame or Heat Pipe routes. They exchange heat only across direct physical edges
using the shared reduced wreck conductivity, which preserves bounded internal
transfer without bridging separated routed networks.
