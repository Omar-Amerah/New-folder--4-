# Section 6E Data-support balance validation

Section 6E is complete for the deterministic Data-support validation stage. The reference ships in `test-fixtures/dataSupportReferenceShips.js` exercise real Wiring v2 physical Data sections, generated physical Power wiring, shared allocation, server-compatible component indexes, and designer/report consumers. The balance report is generated with `npm run balance:data-support`.

## Reference ships and findings

- **Reference A — Precision build:** Targeting Computer and Sensor Array support one Railgun. The Railgun receives the full +40 m range budget and +0.04 accuracy budget; effective accuracy remains capped at 0.99. This is meaningful for a precision build but does not increase DPS and costs module mass, cost and Power.
- **Reference B — Broadside build:** one Fire Control supports four Blasters. The +0.075 fire-rate budget is split equally into +0.01875 per Blaster, conserving total source budget. Broadside DPS rises modestly, so unsupported Blasters remain valid reference points.
- **Reference C — Mixed support network:** Fire Control, Sensor Array and Targeting Computer share one physical Data network with Railgun, Blaster and Point Defence. Sources split independently by field; contributions remain per weapon and do not become a ship-wide bonus.
- **Reference D — Redundant network:** two physical routes join one Data domain. Redundancy preserves support after one route section is removed, but does not duplicate budgets. Removing both route paths changes expected connectivity.
- **Reference E — Isolated networks:** Sensor Array/Railgun and Fire Control/Blaster are physically separate. Allocation does not leak across networks, and each unsupported/disconnected weapon remains operational at catalogue base stats.

## Competitive conclusions

Correctness conclusions: source budgets are conserved, equal splitting is deterministic, duplicate routes do not duplicate support, component-index lookup remains authoritative, Power/Data wiring are valid physical Wiring v2 payloads, and unsupported weapons retain base catalogue behaviour.

Deterministic model findings: Data support is meaningful in single-recipient precision and isolated fire-rate builds, but support-module opportunity cost plus equal splitting prevent obvious mandatory broadside dominance. Railguns benefit most from accuracy/range quality, but the authoritative accuracy cap prevents guaranteed-hit escalation. Point Defence receives the same capped accuracy and fire-rate mechanics as other weapons; Section 6E found no synthetic evidence requiring a Point Defence exception.

Design judgement: no numerical balance values were changed. The existing catalogue values appear suitable for final Section 6 validation because support creates visible trade-offs without disabling unsupported weapons or adding hidden ship-wide bonuses.

Remaining uncertainty: these are deterministic model and invariant tests, not live multiplayer telemetry. Real-player match data is still required before claiming proven competitive balance across maps, player skill, fleet composition and long-term metagame adaptation.
