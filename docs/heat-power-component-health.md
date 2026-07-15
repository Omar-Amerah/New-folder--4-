# Heat, Power and Component Health

This document records the Section 8C thermal implementation. It is descriptive: it documents the shipped rules and tests, not a rebalance or Heat UI redesign.

## Thermal tick order

Each active server tick applies gameplay systems first, then heat is integrated for each living ship. Weapons, movement, shields and support add component-local heat inputs. `updateShipHeat` applies pending inputs, steady activity assumptions, transfer, cooling, state thresholding, aggregate summaries, power degradation and reactor meltdown timers.

## Topology and networks

Component thermal identity is keyed by immutable design index. Full snapshots carry one heat tuple per design entry, and compact deltas carry explicit component indexes so a delta for one component cannot update another component. Frames, light/heavy frames, wing frames and heat pipes are thermal route components; destroyed route components rebuild networks and can split routes.

## Exposure

Exposure is derived from blueprint placement and runtime topology. Radiators use exposed surfaces for cooling. Enclosed radiators still retain passive cooling, but exposed radiators are the authoritative high-cooling route. Destroyed components are excluded from aggregate capacity and counts while retaining stored heat by policy.

## Generation

Heat generation is component-local. Firing weapons, engine activity, shield regeneration and repair/support activity add heat to their own component indexes. Shield heat tracks actual shield restored rather than nominal overfill. Overheated active components lose output and do not continue producing active firing heat.

## Capacity, transfer and cooling

Capacity comes from shared thermal profiles, including sinks and adjacent sink bonuses. Heat pressure uses `currentHeat / maxHeat` with both values computed over the same included living components. Transfer moves heat from hotter normalized ratios toward cooler connected neighbors without allowing negative stored heat. Cooling removes no more heat than exists, and radiator/sink/network summaries avoid double-counting removed heat.

## State thresholds and effects

Thermal states are runtime states, distinct from designer presentation bands. Runtime thresholds come from shared heat rules. Hot and critical states progressively reduce active output and passive protection; overheated active components provide no active output, overheated radiators fall back to passive cooling, and overheated structures take increased damage.

## Aggregate power

`thermalPowerFactor` is finite and bounded. It is a nominal-generation-weighted ratio of available generator output after thermal state penalties. This prevents a small cool generator from hiding a major overheated reactor.

## Battery and capacitor current behaviour

Battery and capacitor behaviour remains current-runtime behaviour. They contribute through existing stats and power paths; Section 8C does not rebalance stored electrical energy, instantaneous current, discharge curves or recovery curves.

## Destruction and repair

Damage and repair are component-index based. Destroyed components retain stored heat, are excluded from aggregate heat capacity/counts, and dirty their health/heat indexes for snapshot broadcast. Repair restores health, recalculates effective stats and rebuilds thermal routes when route components such as frames or heat pipes return.

## Stored-heat policy

Stored heat is never implicitly cleared because a component was damaged or destroyed. Full snapshots replace stale client arrays, reconnects reconstruct current heat from the server, removed ships are not reused as cache entries, and replacement ships start with fresh component heat arrays.

## Meltdown

Reactors and other power generators are meltdown-eligible when they remain overheated for the configured meltdown delay. Recovery below overheated reduces the timer. Same-tick meltdowns are deterministic, destroyed generators do not detonate twice, and meltdown effects are bounded.

## Snapshots

Full component heat tuples are `[heat, state, ratio, capacity]`. Compact deltas are flat `[index, heat, state, ratio, capacity, ...]` with stride 5. All decoded values must be finite; malformed or out-of-range deltas are ignored. Aggregate fields (`heatNow`, `heatMax`, `heat`, `hot`, `overheated`) are summaries of the same included component set.

## Designer predictions

The designer uses shared heat rules for capacity, conductivity, exposure, sinks, radiators, heat pipes, thresholds where applicable, meltdown constants and activity assumptions. UI copy labels these as predictions. Designer bands describe predicted pressure and flow; they are not live runtime thermal states.

## Live UI

The live Heat panel distinguishes whole-ship stored heat from selected component heat. Percentages are derived from the displayed stored/capacity values, so `3.5 / 1100 H` displays approximately `0.3%` and true zero displays `0%`. Selection is keyed by ship ID and component index, not object identity, so replacement snapshots update the readout without pointer movement and ship switches clear stale component text.

## Tests

Focused commands:

- `npm run test:heat-protocol` verifies server snapshots, MessagePack round-trip decoding, delta merging, aggregate reconciliation, reconnect/reset and meltdown assertions.
- `npm run test:heat-browser` verifies the Heat panel VM/browser-facing UI assertions including fractional percentages, mobile taps, stale-readout clearing and no battlefield commands from panel interaction.
- `npm run test:heat-soak` runs the deterministic soak with many ships and asserts bounded bullets/effects/state, finite values, clean reset and shutdown metrics.

The broader suites (`test:unit`, `test:integration`, `test:protocol`, `test:browser`, `test:soak`) continue to cover shared parity, runtime protocol, production Chromium and long-running simulation behaviour.

## Deferred wiring

Section 8C does not redesign the Heat interface, rebalance heat, change HUD layout, alter arrow rendering or introduce production test-only controls. Future work may add deeper electrical storage modelling, richer telemetry dashboards or additional production browser scenarios without changing these snapshot and parity contracts.
