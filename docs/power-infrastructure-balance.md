# Section 7H — Power infrastructure balance rationale

Final balance record for the physical Power infrastructure system built across
Sections 7A–7G. Every number in this document is either the authoritative
value from `component-balance.json` or a measured result of
`node tools/report-power-infrastructure-balance.js` against the reference
fixtures in `test-fixtures/powerInfrastructureReferenceShips.js`. Nothing here
is a provisional guess; regression assertions for each claim live in
`verify-power-infrastructure-balance.js`, `verify-power-infrastructure-reference.js`
and `verify-power-infrastructure-resilience.js`.

## Final authoritative values (unchanged in 7H)

Section 7H validated the system against the reference fixtures and **changed
no balance values**. The provisional Section 7A–7G values met every intended
target, so they are now frozen as final:

| Tier | Sustained | Peak | Cost/cell | Displacement/cell | Heat coeff | Heat exp | Thickness |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Light | 4 MW | 7 MW | 1 | 2 | 0.35 | 2.2 | 1 |
| Standard | 10 MW | 16 MW | 2 | 4 | 0.55 | 2.2 | 2 |
| Heavy | 24 MW | 36 MW | 5 | 8 | 0.9 | 2.2 | 4 |

Data wiring: one tier, 0.25 cost / 1 displacement per unique cell, no
capacity, Heat, overload or breaker mechanics.

Switchgear component: cost 18, mass 4, 35 HP, 2×1 footprint, rating tiers
matching the three cable tiers; its synthetic internal edge participates in
Power flow and overload protection but never in cable-cell Heat.

Runtime protection (`powerProtection` block, Section 7G provisional values now
final): overloadStartRatio 1.0, recoveryStartRatio 0.95, tripStressThreshold
1.0, baseStressPerSecond 0.12, additionalStressPerSecondAtPeak 0.38,
recoveryPerSecond 0.25, criticalStressRatio 0.75, tripCooldownSeconds 4,
retryIntervalSeconds 2, safeRecloseSustainedRatio 0.9,
maxAutomaticRetrySubsets 1024, maximumProtectionDeltaSeconds 0.25.

Measured protection timings (identical for every tier by construction):
stress reaches critical in 1.5 s and trips a conducting Switchgear in
**2.0 s at peak flow**; a slight (+5%) overload takes ~8.1–8.2 s to trip;
recovery below 95% of sustained drains full stress in 4 s.

## Intended use of each tier (measured)

- **Light** — short low-demand final branches. The interceptor runs entirely
  on Light for 2.3% of ship cost and 8 displacement. Heavy-everywhere on the
  same hull costs 5× the wiring and 4× the displacement for identical
  delivered Power (pure waste).
- **Standard** — the normal general-purpose tier. The conventional frigate
  (Standard trunk + Light branches) spends **5.0%** of total ship cost on
  wiring, inside the intended 5–10% conventional band.
- **Heavy** — high-throughput trunks only. The heavy combat ship carries a
  19.2 MW trunk export that Standard cannot sustain; wiring is 7.1% of cost.
  Light-everywhere on this hull leaves >5 MW of demand unmet; the intended
  Heavy trunk serves 100%.
- Upgrading downstream of a Light bottleneck never fixes it: with a Heavy
  final section behind a Light route, delivery stays capped at the Light peak
  (7 MW).

## Intended use of each architecture (measured reference results)

| Fixture | Wiring % of cost | Displacement | Networks | Key resilience result |
| --- | --- | --- | --- | --- |
| A Light interceptor | 2.3% | 8 | 1 | generator loss sheds both consumers |
| B Standard frigate | 5.0% | 48 | 1 | trunk-host loss degrades 5 of 6 consumers; branch loss stays local |
| C Heavy combat | 7.1% | 84 | 1 | heavy-trunk loss degrades 6 of 7 consumers; branch loss stays local |
| D Distributed grids | 3.1% | 20 | 2 | island damage never touches the other island; needs 7.1 MW duplicated/spare generation |
| E Ring bus | 6.4% | 60 | 1 (1 alternate path) | one ring break: zero loss; two strategic breaks split the ring (5 shed) |
| F Hybrid Switchgear | 5.1% (+36 Switchgear = 14.9% combined) | 38 | 2 grids, tie merges to 1 | tie shares exactly the 3.3 MW receiver deficit; donor demand never sacrificed |
| G Cheap bus | 2.7% | 10 | 1 | one trunk-host loss sheds every consumer |

No family dominates: the ring pays a 1.26× cost and 1.25× displacement premium
over the frigate for its single-failure immunity; distributed grids avoid
trunk cost but strand 7.1 MW of spare generation; the hybrid tie's combined
infrastructure (14.9% with Switchgear) buys spare-sharing plus isolation; the
cheap bus is the cheapest and dies to one hosted section.

A genuine measured finding: at equal load the ring's **dynamic** cable Heat is
lower than the frigate's (3.6 vs 5.3 H/s) because parallel routes halve
per-section utilisation under the nonlinear Heat curve. The Heat price of
redundancy is paid in static Heat-capacity displacement (60 vs 48), which the
regression suite asserts instead.

## Values changed in Section 7H

**None.** The tuning-discipline pass (report → targets → smallest change)
found no failing trade-off, so no before/after comparison exists. The only
fixture-side calibration was choosing a realistically sized frigate (8-cell
Standard trunk, 6 Light branches, 4 Data cells) as the canonical 5–10%
conventional reference.

## Known future expansion points (out of scope, deliberately not built)

- Section 7H tuning hooks for cable fires, cable HP, armoured conduit or
  partial-health cable degradation were explicitly rejected — overload is a
  time/stress/trip system only.
- Data remains a single tier with no bandwidth, overload, Heat or breakers.
- No voltage, transformers or material simulation.
- No per-component priority controls, battle rewiring or in-battle manual
  Switchgear toggles.
- Any future Section 8 mechanics must not repurpose the protection stress
  records as a damage channel.
