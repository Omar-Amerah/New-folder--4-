#!/usr/bin/env node
import assert from "node:assert/strict";

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({})
};
globalThis.DataSupportRules = { normalizeDataLinks: () => [] };
const engineExhaust = await import("../public/src/shared/engineExhaust.js");
globalThis.EngineExhaustRules = engineExhaust.default || engineExhaust;

const storage = await import("../public/src/design/blueprintStorage.js");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

const design = [
  { x: 7, y: 7, type: "core" },
  { x: 7, y: 8, type: "engine" }
];
const oldWiring = {
  version: 3,
  power: { sections: [], connections: [] },
  data: { sections: [], connections: [] }
};

const legacySaved = {
  schemaVersion: 2,
  kind: "saved-designs",
  payload: [{
    id: "legacy-design",
    name: "Legacy Design",
    blueprint: design,
    wiring: oldWiring,
    dataLinks: [],
    combatStyle: "charge"
  }]
};
const legacyLoadouts = {
  schemaVersion: 2,
  kind: "loadouts",
  payload: [{ id: "legacy-loadout", name: "Legacy Fleet", designIds: ["legacy-design"] }]
};

const migratedDesigns = storage.migrateSavedDesignsStorage(legacySaved);
assert.equal(migratedDesigns.length, 1, "v2 saved designs remain visible after Wiring removal");
assert.equal(migratedDesigns[0].id, "legacy-design");
assert.deepEqual(migratedDesigns[0].blueprint, storage.normalizeDesign(design));
assert.equal(migratedDesigns[0].combatStyle, "charge");
assert.equal(Object.hasOwn(migratedDesigns[0], "wiring"), false, "removed Wiring is not reintroduced into client state");

const migratedLoadouts = storage.migrateLoadoutsStorage(legacyLoadouts);
assert.deepEqual(migratedLoadouts, legacyLoadouts.payload, "v2 loadouts remain available");

const v2Export = storage.exportBlueprints(migratedDesigns, migratedLoadouts);
v2Export.schemaVersion = 2;
const imported = storage.importBlueprints(v2Export);
assert.equal(imported.incompatibleVersion, undefined, "v2 blueprint exports remain importable");
assert.equal(imported.acceptedDesigns, 1, "v2 blueprint export design is accepted");
assert.equal(imported.acceptedLoadouts, 1, "v2 blueprint export loadout is accepted");

assert.deepEqual(
  storage.migrateSavedDesignsStorage({ schemaVersion: 1, kind: "saved-designs", payload: legacySaved.payload }),
  [],
  "pre-Wiring saved-design formats remain rejected"
);
assert.deepEqual(
  storage.migrateLoadoutsStorage({ schemaVersion: 4, kind: "loadouts", payload: legacyLoadouts.payload }),
  [],
  "future loadout formats remain rejected"
);

const local = new MemoryStorage();
Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
local.setItem("modular-fleet-saved-designs-v2", JSON.stringify(legacySaved));
assert.equal(storage.loadSavedDesigns().length, 1, "loadSavedDesigns reads the existing v2 localStorage envelope");

console.log("Blueprint storage migration verification passed");
