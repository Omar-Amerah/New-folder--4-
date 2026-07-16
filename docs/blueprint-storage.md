# Blueprint storage

The client stores blueprint editor data in explicit versioned envelopes in `localStorage`.
The current schema version is `2` and every stored value has this shape:

```json
{
  "schemaVersion": 2,
  "kind": "current-design | saved-designs | loadouts",
  "payload": {},
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

## Keys and payloads

- `modular-fleet-design-v3` stores the current editor design payload:
  `{ "modules": [...], "wiring": { "version": 1, "power": [...], "data": [...] }, "combatStyle": "sentry|charge|circle|hold" }`.
- `modular-fleet-saved-designs-v2` stores up to 12 saved blueprint records; each
  record keeps an independent copy of its `blueprint` modules and `wiring`.
- `modular-fleet-loadouts-v2` stores up to 8 custom loadout records. The implicit
  `All` loadout is not persisted.
- `modular-fleet-design-last-good-v2` keeps the last valid current-design
  envelope for corruption recovery.

Wire segments are unit-length orthogonal grid edges `{ "x1": 7, "y1": 6, "x2": 8, "y2": 6 }`
on the 15×15 blueprint's grid points (0–15). Power and Data are separate segment
lists that may share edges. Networks, connectivity, and bonus previews are never
stored — they are derived from the segments by the shared engine in
`public/src/shared/wiringRules.js` (see `docs/ship-wiring.md`).

## Version-break and safety rules

Schema v2 is a deliberate hard break: pre-wiring keys
(`modular-fleet-design-v2`, `modular-fleet-saved-designs-v1`,
`modular-fleet-loadouts-v1`, `modular-fleet-design-last-good-v1`) are never
read, and v1 or future envelopes found under the new keys are discarded. A user
with old data simply receives the current default ship with its default Power
wiring; there is no migration path. Blueprint export files from schema v1 are
rejected on import (`incompatibleVersion`).

Component rotations are normalized through the same editor placement rules used
for new parts, multi-cell footprints are rechecked, and invalid
overlapping/out-of-bounds entries are quarantined. Wiring is re-normalized
against the stored modules on every load and save, so floating, duplicate, or
malformed segments never persist.

Malformed saved-design entries are skipped independently so one bad entry does
not erase the valid list. Corrupt JSON, wrong top-level types, unavailable
`localStorage`, and unknown future schema versions all fall back safely without
throwing. Persistence functions return `false` for unavailable storage, quota
errors, or other write failures; they do not mutate or clear the caller's
in-memory design when the write fails.

## Verification

Run the dedicated storage suite with:

```sh
npm run test:blueprint-storage
```

This executes `verify-blueprint-storage.js`, covering the v2 hard break from
pre-wiring storage, modules+wiring round trips, independent wiring copies,
export/import with wiring, corrupt JSON, partial corruption, unknown versions,
unavailable storage, and quota/write failure. The shared wiring engine itself
is covered by `npm run test:wiring` (`verify-wiring.js`).

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.
