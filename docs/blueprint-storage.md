# Blueprint storage

The client stores blueprint editor data in explicit versioned envelopes in `localStorage`.
The current schema version is `1` and every stored value has this shape:

```json
{
  "schemaVersion": 1,
  "kind": "current-design | saved-designs | loadouts",
  "payload": {},
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp"
}
```

## Keys and payloads

- `modular-fleet-design-v2` stores the current editor design payload:
  `{ "modules": [...], "combatStyle": "sentry|charge|circle|hold" }`.
- `modular-fleet-saved-designs-v1` stores up to 12 saved blueprint records.
- `modular-fleet-loadouts-v1` stores up to 8 custom loadout records. The implicit
  `All` loadout is not persisted.

## Migration and safety rules

The loader migrates all legacy shapes still supported by the app: a raw module
array, the old `{ modules, combatStyle }` current-design object, raw saved-design
arrays, and raw loadout arrays. Old 7x7-centred blueprints with the core at
`3,3` are shifted to the 15x15 editor centre at `7,7`. Component rotations are
normalized through the same editor placement rules used for new parts, and
multi-cell footprints are rechecked while invalid overlapping/out-of-bounds
entries are quarantined.

Malformed saved-design entries are skipped independently so one bad entry does
not erase the valid list. Corrupt JSON, wrong top-level types, unavailable
`localStorage`, and unknown future schema versions all fall back safely without
throwing. Persistence functions return `false` for unavailable storage, quota
errors, or other write failures; they do not mutate or clear the caller's
in-memory design when the write fails.

## Verification

Run the dedicated storage migration suite with:

```sh
npm run test:blueprint-storage
```

This executes `verify-blueprint-storage.js`, covering legacy formats, current
version round trip, corrupt JSON, partial corruption, unknown versions,
unavailable storage, quota/write failure, and repeated idempotent migration.

## Completed Catch-up Parts 1–3

Catch-up Parts 1–3 are now represented by required, behavior-named suites instead of aliases that overstate coverage. Production-path HTTP checks remain smoke coverage; protocol coverage uses the real `server.js` process, real WebSockets, and MessagePack; browser coverage launches Playwright Chromium against the production frontend; soak coverage runs a sustained deterministic high-entity server simulation with bounded-state and performance assertions. The Part 3 combat catch-up adds deterministic coverage for focus targeting, weapon-specific fallback, turret/muzzle geometry invariants, projectile lifetime and swept collision safety, point-defence priority, repair conservation, damage/reward idempotency, safe-zone firing blocks, and cleanup bounds without changing weapon balance values.

## Deliberately deferred to Sections 8–13

The catch-up does not start the Section 8 heat/power redesign or any later redesign topics. Deferred work remains limited to future review sections for deeper heat/power policy, AI difficulty, economy or movement rebalancing, map redesign, renderer or camera redesign, major HUD work, persistent accounts, and database-backed persistence. Existing player-facing rules are clarified as current policy rather than rebalanced.
