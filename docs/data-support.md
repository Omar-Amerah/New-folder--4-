# Data support — Section 6A

Section 6A provides the shared, deterministic allocation engine for Blueprint Data networks. It calculates derived support records only: **it is not yet the live combat authority**. Weapons remain fully functional at their catalogue base stats when unsupported.

## Sources and budgets

The recognised sources are Fire Control (`fireRateBonus`), Sensor Array and Signal Amplifier (`rangeBonus`), and Targeting Computer and Stabilizer Node (`accuracyBonus`). Their descriptor table lives in `public/src/shared/dataSupportRules.js`; numerical budgets are always read from the authoritative component catalogue and are not copied into rule code.

For each eligible source, `effectiveBudget = nominalBudget × sourceMultiplier`, followed by `bonusPerWeapon = effectiveBudget ÷ eligibleConnectedWeaponCount`. Multipliers default to 1, preserve finite values from 0 through 1, clamp values above 1, and normalize negative, non-numeric, NaN, and infinite values to 0. A disabled source retains its recipient diagnostics with zero output.

Each source splits independently, so contributions from multiple sources stack additively while range, accuracy, and fire-rate fields remain independent. There is no load weighting, family-specific compatibility, or duplicate-source diminishing return.

## Physical allocation domains

Physical Wiring v2 Data sections are the sole network-membership authority; legacy logical `connections` do not select recipients. Every catalogue component with weapon metadata—including Point Defence and all weapon families—is compatible. Multi-cell sources and weapons count once by design index.

Allocation domains contain recognised source indices, weapon indices, and physical section IDs. Domains that repeat a recognised source or weapon are merged deterministically, their membership is combined, a diagnostic is returned, and each source budget is allocated exactly once. Passive host components never merge domains. A domain is derived analysis and is never persisted into Blueprint wiring.

## Deferred work

Section 6B will make the allocation engine authoritative for live combat. Power, Heat, damage, and component lifecycle behavior are deferred to Section 6C. Designer presentation is deferred to Section 6D. None of those deferred mechanics are active in Section 6A.

## Section 6B runtime authority

Section 6B makes server combat authoritative for physical Wiring v2 Data support on a per-weapon-component basis. The server derives runtime state in `src/server/componentData.js` from the immutable `ship.design` and the ship's Wiring v2 blueprint/runtime wiring projection. This derived state is stored on the runtime ship only as `ship.runtimeDataSupport`; it is not written back into saved blueprints or catalogue data.

The runtime flow is:

1. Analyze the physical Wiring v2 topology with `WiringRules.analyzeWiring(ship.design, ship.wiring, PARTS)` or the current operational runtime wiring projection.
2. Consume the resulting physical Data networks through the shared Section 6A allocation engine in `public/src/shared/dataSupportRules.js`.
3. Store deterministic lookup arrays by design/component index: `sourceAllocationByIndex` and `weaponBonusByIndex`.
4. Resolve each firing weapon's base catalogue profile from `PARTS` and combine it with only that weapon index's support record through `DataSupportRules.effectiveWeaponProfile(...)`.
5. Use the resulting effective profile for target acquisition, range checks, accuracy/spread, projectile lifetime, beam endpoint range and cooldown/reload.

Support is applied exactly once: catalogue base weapon stats remain base values, `shipStats.computeStats()` reports base weapon-family summaries, and runtime combat obtains effective per-weapon profiles from `componentData.js`. Range, accuracy and fire-rate support are no longer ship-wide weapon authorities. A disconnected source, a source on a different Data network, or a weapon with no support contribution cannot affect unrelated weapons.

Unsupported weapons remain fully operational. A weapon with no Data cable, no connected support source, or no contribution record receives a zero-support record and fires with its base catalogue range, accuracy and fire rate.

Section 6B intentionally defers Section 6C behaviour: dynamic source Power multipliers, dynamic thermal multipliers, destruction/repair-driven topology redistribution, dirty flags for cable-host damage, and support-source activity Heat are not implemented here.

## Section 6C lifecycle integration

Data-support allocation remains delegated to the shared Section 6A rules. At runtime each source now contributes an effective budget equal to its catalogue budget multiplied by the source component's own Power multiplier, its own Heat performance multiplier, and its operational lifecycle multiplier. Living sources use an operational multiplier of `1`; destroyed sources remain in diagnostics with multiplier and effective budget `0`.

Recipient eligibility is lifecycle-aware. Destroyed weapons stay addressable by immutable component index for diagnostics, but they do not consume source budget and receive no active contribution. When a weapon is repaired above the alive boundary it rejoins the eligible recipient set and the shared allocation engine redistributes the same source budget across the current living weapons.

Runtime state separates physical topology from allocation. `runtimeDataSupport.topologyRevision` changes only when surviving Data connectivity or source/weapon eligibility topology changes, such as cable-host destruction or repair. `allocationRevision` changes when effective source budgets or weapon bonuses change. Power-only and Heat-tier-only changes use a lightweight allocation refresh against cached network membership so the Wiring graph is not rebuilt every tick.

Data topology is always derived from the damage-aware Wiring v2 runtime projection. Destroying a component that hosts a cable section removes that section from the surviving projection, which can split networks and disconnect sources from weapons. Repairing the host can restore sections and merge networks. Redundant physical routes are treated as one connected Data network while any route survives; duplicate paths do not duplicate source budget.

Section 6D UI panels, cable highlighting, vulnerability displays, and designer contribution inspection remain deferred.
