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
