# Blueprint and component architecture

Section 3 establishes the ship-design contract used by the catalogue, designer, validation, stats, storage, rendering, heat preview, and spawned ships.

## Component data flow

`component-balance.json` is the balance input. The production server validates it with `src/server/componentSchema.js`, normalizes it in `src/server/components.js`, and sends the normalized catalogue in the WebSocket `hello.parts` message. The client may load `/component-balance.json` early for offline/menu rendering, but after `hello.parts` arrives the server catalogue is authoritative and later HTTP responses are ignored. The flow is:

```text
component-balance.json
  -> component schema validation
  -> server normalization (PARTS)
  -> hello.parts runtime catalogue
  -> client PART_STATS catalogue
  -> designer preview / palette / inspector / stats / thermal preview
  -> server validation and ship stats on deploy or buy
  -> spawned ship design indexes
  -> snapshots with component hp/heat/weapon-angle arrays by design index
  -> renderer, damage panel, heat panel, thumbnails, and Pixi ship views
```

Fallback client/server definitions exist only as resilience for missing local data or tests. They are not allowed to override a connected server catalogue.

## Authority matrix

| Concern | Authority | Notes |
|---|---|---|
| Component schema | `src/server/componentSchema.js` | Server startup and `npm run check:components` reject malformed balance data. |
| Component balance | root `component-balance.json` after server validation/normalization | The server-normalized `PARTS` object is the runtime source of truth. |
| Design validity | server `shipDesign.js` | Client validation is a deterministic preview and must preserve messages where possible. |
| Derived ship stats/cost | server `shipStats.js` | Client `componentStats.js` previews the same fields for UX; parity tests should compare representative designs. |
| Starter affordability | server lifecycle/deploy handling | The client displays starter cost, but the server decides readiness. |
| Purchase affordability | server `economy.js` | Saving an active-match blueprint is local and must not deduct money. |
| Rendering/art | client render modules | Art may exceed logical footprint but must not change occupied cells. |
| Saved local blueprints | client `blueprintStorage.js` / localStorage | Malformed saved entries are isolated during migration/normalization. |
| Thermal preview | client `thermalAnalysis.js` | It is an estimate; live heat remains server-owned. |
| Live heat | server `heat.js` | Snapshot heat arrays are keyed by stable design index. |

## Component identity

- The canonical component ID is the `id` string from `component-balance.json`; IDs must be unique non-empty strings.
- Legacy and art aliases may map visuals to canonical IDs, but they must not create separate gameplay definitions.
- Hidden components can exist in the catalogue but are excluded from the palette by UI rules; saved designs containing known hidden IDs can still normalize before spawn if server validation permits them.
- Unknown component IDs are invalid for placement and authoritative server validation. Saved-blueprint migration should drop or flag unknown IDs rather than preventing the whole designer from loading.

## Coordinate and rotation conventions

- The build grid is 15 cells wide by 15 cells high.
- `x` increases to the right; `y` increases downward.
- A part's `(x, y)` is its anchor cell. Unrotated footprints extend right and down from the anchor.
- Rotation is clockwise in 90 degree steps and is normalized into `0`, `90`, `180`, or `270`. Negative and over-360 values normalize before footprint use.
- Occupied cells are emitted in stable local-row order before rotation: local `(dx, dy)` offsets are rotated around the anchor.
- Designer, validation, heat, component HP, snapshots, damage panels, and Pixi construction must use the same occupied-cell convention.

Example for a 2x1 component anchored at `(5,5)`:

| Rotation | Occupied cells |
|---:|---|
| 0° | `(5,5)`, `(6,5)` |
| 90° | `(5,5)`, `(5,6)` |
| 180° | `(5,5)`, `(4,5)` |
| 270° | `(5,5)`, `(5,4)` |

## Placement candidate lifecycle

The designer uses one pure placement-candidate calculation for hover preview and click commit. It receives grid cell, component type, rotation, current design, and catalogue, then returns normalized part data, occupied cells, overlaps, out-of-bounds cells, replacement information, and a stable reason code/message. A green preview and click placement therefore share the same target anchor, rotation, and validation result.

Pointer-to-grid conversion reads the current grid DOM rectangle at interaction time so browser zoom, CSS scaling, scrolling, and panel changes do not use stale cached coordinates. Informational panels may scroll independently and must not intentionally resize or translate the grid except when the actual available panel/viewport size changes.

## Validation matrix

| Rule | Client preview | Server authority |
|---|---|---|
| Non-empty design | `blueprintValidation.js` | `shipDesign.js` |
| Known component IDs | catalogue lookup | `PARTS` lookup |
| Exactly one core | validation preview | deploy/buy validation |
| Cells inside grid | shared footprint convention | server footprint convention |
| No overlap | shared footprint convention | server footprint convention |
| Connected to core | preview connectivity | authoritative connectivity |
| Heat pipes not sole structural bridge | preview connectivity | authoritative connectivity where applicable |
| Valid rotations | client rotation capability | server sanitization/validation |
| Engine/exhaust validity | preview + stats warnings | authoritative stats/movement |
| Power warnings | advisory preview | authoritative stats/warnings |
| Starter affordability | display only | deploy/ready handling |
| Purchase affordability | purchase UI display | `economy.js` buy handling |
| Component count/payload shape/finite coordinates | UI normalization | server message validation |

## Design lifecycle

1. New or loaded design is normalized before editing.
2. Palette/inspector read the current runtime catalogue.
3. Hover preview calls the placement-candidate function.
4. Click placement commits the same candidate result if valid.
5. Client stats, cost, and thermal analysis update from the normalized design.
6. Saving writes local blueprint data without changing live ships or money.
7. Pre-match deploy sends the exact current design; the server validates starter affordability and creates one starter ship when the match starts.
8. Active-match purchase sends the selected blueprint; the server validates and charges authoritative cost only on successful buy.
9. Spawned ships keep design array order stable for component HP, heat, weapon cooldowns, weapon angles, destroyed-engine indexes, and diagrams.
10. Snapshots and rendering consume those arrays by design index; client display normalization must not reorder live server designs.

## Catch-up Part 1 verification additions

Blueprint persistence is now described in `docs/blueprint-storage.md` and covered by `npm run test:blueprint-storage`. The storage migration path normalizes rotations and multi-cell footprints using the same placement helpers as the designer.

Client/server blueprint parity remains covered by `verify-shared-parity.js` / `npm run test:blueprint-parity`, which compares shared footprint and stat calculations against server-side authoritative modules. The server remains authoritative; the client preview is only a purchase/editor estimate.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.
