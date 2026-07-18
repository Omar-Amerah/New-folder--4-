# Section 6E Data-support balance validation

Section 6E is complete for deterministic runtime, lifecycle, designer-parity and reporting validation. The reference ships in `test-fixtures/dataSupportReferenceShips.js` exercise real Wiring v2 Data sections, generated physical Power wiring, shared allocation, server runtime Data allocation, Power/Heat multipliers, component damage/repair lifecycle, stable component indexes, designer predictions and measured report consumers. The balance report is generated with `npm run balance:data-support`.

## Proven correctness

- Reference fixtures validate component types, non-overlapping footprints, hosted one-cell Power/Data sections, canonical section IDs, generated Power wiring, connected baseline Power consumers, exact Data network counts, deterministic construction and independently mutable clones.
- Runtime allocation matches shared allocation by immutable component index for source budgets, recipient sets, per-recipient amounts, weapon support fields and effective weapon profiles.
- Designer predictions match shared/runtime records without persisting derived Data-support state into the saved blueprint.
- Source effective budget is validated from authoritative runtime records as nominal budget × Power multiplier × Heat multiplier × operational multiplier.
- Component damage and repair flows rebuild runtime wiring/topology without mutating the fixture blueprint; repaired components rejoin allocation once and duplicate routes do not duplicate budgets.
- Isolated physical Data networks prove zero leakage between unrelated sources and weapons.

## Deterministic mechanical findings

- **Reference A — Precision build:** Sensor Array and Targeting Computer allocate their full budgets to one Railgun. Runtime stats show increased range and capped accuracy, and disabling Data support returns the Railgun to base catalogue stats.
- **Reference B — Broadside build:** one Fire Control budget is split across four Blasters. Runtime reload/cooldown derives from each Blaster's own effective fire rate, partial Power proportionally reduces source output, and disconnected support returns all four weapons to base fire rate.
- **Reference C — Mixed support network:** Railgun, Blaster and Point Defence each receive independent range, accuracy and fire-rate fields from the three sources. Runtime records remain per weapon index and contain no NaN or Infinity values.
- **Reference D — Redundant network:** one tested route loss preserves support through the alternate route; loss of the paired route disconnects support; repair restores deterministic allocation without duplicated contributions.
- **Reference E — Isolated networks:** Railgun receives Sensor Array range support only, while Blaster receives Fire Control fire-rate support only. Damage and repair in one network leave the other network's allocation values unchanged.

## Design judgement

The measured deterministic records support keeping the current catalogue values for this validation pass: Data support creates visible mechanical changes, budgets are conserved, unsupported/base fallback remains intact, and no evidence in these reference scenarios requires a numerical catalogue change. This is a design judgement from fixed reference builds, not proof of long-term competitive balance.

## Unknown without telemetry

Real-player fleet composition, player skill, maps, objective pressure, team coordination, counter-build prevalence and long-term metagame adaptation remain unknown without production telemetry or dedicated playtest data. Claims such as broadside dominance being fully prevented, support being universally non-mandatory, Point Defence never needing exceptions, or no future balance changes being needed should not be treated as proven by Section 6E alone.
