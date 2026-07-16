# Ship wiring (stages 1–4)

Ships carry two wiring layers alongside the component grid: **Power** (amber)
and **Data** (cyan). This document covers the data format, the shared graph
engine, protocol/storage handling, and the Wiring editor view. Wiring is
currently design-time only: it is created, edited, validated, and summarized,
but it does **not** yet affect live power, weapon bonuses, or combat behaviour.

## Data format

The component array is unchanged. Wiring is stored separately:

```json
{
  "modules": [ ... ],
  "wiring": {
    "version": 1,
    "power": [ { "x1": 7, "y1": 6, "x2": 8, "y2": 6 } ],
    "data": []
  }
}
```

Rules enforced by normalization (client and server):

- Segments are unit-length orthogonal edges between neighbouring grid points
  (0–15 on the 15×15 blueprint); no diagonal or zero-length segments.
- Segment direction does not matter; endpoints are stored in canonical order
  and duplicate/reversed-duplicate segments are removed.
- Power and Data are separate networks but may share a grid edge.
- A segment must stay attached to or immediately beside an occupied ship cell —
  floating wire routes are dropped.
- Per-kind segment counts are capped (`MAX_SEGMENTS_PER_KIND`, 240) to bound
  payload size.
- Network ids, connectivity results, and bonuses are never stored or trusted;
  they are always re-derived from the segments.

## Shared engine

`public/src/shared/wiringRules.js` is a UMD module used by the browser (via a
classic `<script>` tag, `globalThis.WiringRules`) and by the server (via
`require`), exactly like `heatRules.js`. It provides segment
normalization/validation/keys, rotated-footprint connection ports (all
perimeter grid points; multi-cell components are internally connected), network
discovery via union-find (wires that touch different ports of one component
merge through it), component→network membership, source→consumer and
source→weapon reachability, deterministic shortest-route calculation (BFS with
fixed neighbour order, so hover previews and placement are identical), route
add/removal, and network summaries. Ordering is deterministic throughout; Data
networks are labelled `Weapon Network A/B/C…` by their upper-left position so
names stay stable.

Roles and compatibility:

- Power sources: Core, Reactor, Aux Generator. Power consumers: every
  component with `powerUse > 0`.
- Data sources: Fire Control (fire-rate), Sensor Array (range), Signal
  Amplifier (range), Targeting Computer (accuracy), Stabilizer Node
  (accuracy). Data targets: all weapons, including Point Defence, Flak Cannon,
  and Interceptor Pod. Fire Control is incompatible with beam-family weapons;
  the Stabilizer Node's turning bonus is unrelated to Data wiring.
- Bonus previews split equally: `module bonus / connected compatible weapons`
  (Signal Amplifier at 75 m → 37.5 m each across two weapons). Preview only —
  not applied to stats or combat yet.

## Protocol and server validation

`deploy` and `buyShip` accept the modules (`design`) plus an optional `wiring`
payload. `clientSchemas.js` bounds-checks the shape (only
`version/power/data`, integer endpoints 0–15, per-kind caps) and rejects
unknown fields such as precomputed networks; `shipDesign.validateWiring` then
independently re-normalizes the segments against the validated modules. The
server never trusts client network ids, connectivity results,
connected-component lists, calculated bonuses, or powered states. Invalid or
floating segments are dropped rather than rejecting the blueprint —
disconnected components are designer warnings, not blocking errors.

The default ship (`DEFAULT_DESIGN`/`DEFAULT_WIRING` in `src/server/config.js`,
mirrored by `defaultDesign()`/`defaultWiring()` on the client) carries a Power
bus joining Core, Reactor, and Aux Generator to every powered component; its
Data wiring is empty because it has no Data-support module.

## Wiring editor view

The designer has a **Wiring** tab beside Blueprint and Heat, on the same 15×15
grid. Controls: Power/Data mode, Auto Route, Erase, Undo, Clear selected
network, Clear all Power, Clear all Data, and Show all networks. Routing:
select a valid source (Power source or Data-support module), hover a valid
destination (powered consumer or compatible weapon) to see the proposed
shortest route, and click to confirm — the placed route is exactly the
previewed one. Erase removes individual segments. Colours: amber Power, cyan
Data, green connected/working paths, red disconnected components or invalid
routes, yellow warnings, blue selected network. Selecting a component
highlights its ports, its whole network, and its connected sources/targets
while dimming unrelated wiring; support modules list their connected weapons
and vice versa. The status panel reports per-network generation/demand,
connected/disconnected consumers, Weapon Network summaries with the
equal-split bonus preview, and designer warnings (unpowered components,
support modules without compatible weapons, incompatible Data routes, removed
invalid segments, empty networks, unroutable requests).

## Deliberately not implemented yet

Runtime power shutdown, per-network efficiency, actual bonus splitting,
distance loss, diminishing returns, wire damage, network rebuilding after
component destruction, redundancy analysis, power priorities, junctions, cable
capacity/heat, combat visuals, and any thermal-simulation changes. Component
balance, combat, heat, damage, movement, and pricing are unchanged.

## Verification

```sh
npm run test:wiring            # shared engine (verify-wiring.js)
npm run test:blueprint-storage # storage schema v2 with wiring
npm run test:protocol-schema   # deploy/buyShip wiring payload bounds
```
