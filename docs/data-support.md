# Data Links

Data support is a logical source-to-weapon mechanic. It has no route or graph
state.

Each support component contributes a budget. A Data Link names one source
component and one weapon component:

```text
support component -> explicit Data Link -> weapon
```

The source budget is divided evenly across that source's linked weapons. One
linked weapon receives the full budget; four linked weapons each receive one
quarter. A source contributes less when its Power multiplier is reduced and
contributes nothing when it is destroyed, unpowered, or overheated. Multiple
sources stack independently on the same weapon.

## Authority

`public/src/shared/dataSupportRules.js` owns link normalization and the shared
allocation formulas. `src/server/componentData.js` applies those formulas to
authoritative component Power, Heat, and lifecycle state. Combat consumes the
resulting per-weapon effective profile; ship-wide weapon summaries remain base
catalogue values.

`public/src/design/dataSupportAnalysis.js` runs the same direct-link formulas for
designer previews. It can apply a temporary source-state override to show
failure vulnerability, but it does not mutate the blueprint or invent runtime
state.

Data Links are persisted in blueprint envelopes as `{ sourceIndex, targetIndex }`
pairs. Snapshots expose only the derived runtime support data appropriate to the
viewer; no route representation is serialized.

## Verification

Focused checks cover whole-budget and split-budget allocation, stacked sources,
malformed links, deterministic normalization, Power/Heat/lifecycle reductions,
designer parity, and report generation:

```sh
npm run test:data-support
npm run test:data-support-designer
npm run test:data-support-balance
npm run balance:data-support
```
