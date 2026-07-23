# PR #291–#293 Power review

## What PR #293 actually introduced

PR #293 introduced the combat Power status tab for the selected-ship status panel. Its implementation added a third Damage/Heat/Power tab, selected-ship Power summary groups, Power-wiring overlay rendering, per-component Power readouts, switchgear diagnostics, and runtime snapshot fields that let the browser present existing server Power-solver results without recalculating allocation or thermal rules on the client.

## Overlap with PR #292

The PR #293 branch appears to have included stale-base or merge-ancestry content from PR #292. In particular, wiring cost/benefit clarity text, tier comparison messaging, bottleneck wording, architecture observations, switchgear cost display, and Power/Data separation prose are PR #292-style changes even when visible in the PR #293 diff.

## Combat Power feature ownership

The combat Power feature owns these categories of changes:

- **Server snapshot:** selected-ship Power thermal/protection/wiring snapshot fields; switchgear runtime state; namespaced Power section identifiers; per-section cable Heat keyed by section id; generator rated/available/delivered/unused fields.
- **Client UI:** Damage/Heat/Power tab accessibility; Power summary cards; Power overlay; Power legend/readouts; generator and switchgear hover/tap text.
- **Tests:** combat Power tab source checks, overlay snapshot checks, browser rendering checks, and regression checks that the UI reads authoritative snapshot data rather than duplicating solver constants.
- **Combat status:** selected-ship live presentation of generation, demand, delivered Power, unmet demand, cable load/Heat, overload stress, switchgear state, and component Power state.

## Likely stale-base issue

The overlap is consistent with PR #293 having been branched from, merged with, or rebased over work that already contained PR #292 wiring-clarity commits. That ancestry means a line-by-line revert or cherry-pick can unintentionally remove PR #292 wording while attempting to modify only the combat Power tab.

## Revert, cherry-pick and backport risks

- Reverting PR #293 as a unit can remove PR #292 wiring-clarity behaviour if the overlapping commits are not separated first.
- Cherry-picking only UI files can strand server snapshot fields or leave the browser interpreting absent data as unavailable.
- Cherry-picking only server snapshot changes can expose unused fields without updating accessible readouts or legends.
- Backporting switchgear state fixes without the snapshot schema version can make older clients collapse distinct states into generic disabled/broken wording.
- Backporting per-section Heat without tests risks double-counting host-component aggregate Heat across multiple sections.
- Any backport must keep the server Power solver authoritative and must not introduce client-side allocation, overload, Heat, priority, generation or switchgear rules.

## Follow-up work intentionally out of PR #294 scope

- **Authoritative route-path analysis:** expose real source-to-consumer flow paths or predecessor trees before making route-specific upgrade claims.
- **Power-network bridge and articulation analysis:** add production topology fields for bridges, articulation points and shared demand before stronger architecture classifications.
- **Consumer-level resilience test expansion:** broaden resilience tests to assert surviving consumer delivery component-by-component for every failure mode.
- **Wiring-preview caching and benchmark:** add a large-blueprint benchmark for hover previews, tier changes and cache invalidation.
- **Broad infrastructure balance sampling:** expand reporting beyond curated reference ships without changing balance constants to fit the report.
