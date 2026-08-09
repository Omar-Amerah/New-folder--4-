# Blueprint storage

The client stores editor data in explicit versioned envelopes in `localStorage`.
The current envelope schema is version 3 and stores normalized modules, explicit
Data Links, and the combat style. Derived Power, Heat, and Data-support state is
never persisted.

Schema v2 saved-design and loadout envelopes remain readable after the Wiring
removal. Their obsolete physical Wiring field is ignored while modules, Data
Links, combat style, and loadout references are normalized into the v3 shape.
Schema v2 blueprint exports are also accepted for the same migration.

The current-design payload has this shape:

```json
{
  "modules": [],
  "dataLinks": [{ "sourceIndex": 1, "targetIndex": 4 }],
  "combatStyle": "hold"
}
```

Saved blueprints and loadouts keep independent copies of their module and link
arrays. Data Links are normalized against the saved module indexes; malformed,
duplicate, out-of-range, and self-links are discarded without creating route or
topology state. Component rotations and footprints are normalized using the
same placement rules as the live editor.

Malformed entries are skipped independently so one bad saved design does not
erase the valid list. Corrupt JSON, unavailable storage, unknown schema versions,
quota errors, and write failures fall back safely and never mutate the caller's
in-memory design.

Blueprint export/import uses the same normalized representation. Import retains
valid explicit Data Links and reports invalid records without reconstructing any
derived runtime state.

## Verification

The focused storage behavior is covered by the Data Links editor and designer
checks:

```sh
npm run test:data-links-editor
npm run test:data-support-designer
```
