#!/usr/bin/env node
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const serverShipDesign = require("../src/server/shipDesign");

globalThis.document = {
  getElementById: () => null,
  createElement: () => ({})
};
globalThis.DataSupportRules = { normalizeDataLinks: () => [] };
const engineExhaust = await import("../public/src/shared/engineExhaust.js");
globalThis.EngineExhaustRules = engineExhaust.default || engineExhaust;

const design = [
  { x: 7, y: 7, type: "core" },
  { x: 7, y: 8, type: "engine" }
];
const legacySensorDesign = [
  { x: 7, y: 7, type: "core" },
  { x: 7, y: 8, type: "engine" },
  { x: 8, y: 7, type: "sensorArray", rotation: 0 },
  { x: 8, y: 9, type: "directedSensor", rotation: 90 }
];

const storage = await import("../public/src/design/blueprintStorage.js");

const migratedSensors = storage.normalizeDesignDetailed(legacySensorDesign, { allowEmpty: true });
assert.deepEqual(migratedSensors.issues, [], "legacy sensors migrate without creating placement errors when space is available");
assert.deepEqual(
  migratedSensors.modules.map((part) => part.type),
  ["core", "engine", "largeSensor", "largeDirectedSensor"],
  "legacy sensor identifiers become their current catalogue variants"
);
assert.deepEqual(
  migratedSensors.modules.slice(2).map((part) => ({ x: part.x, y: part.y, rotation: part.rotation })),
  [{ x: 8, y: 7, rotation: 0 }, { x: 8, y: 9, rotation: 90 }],
  "sensor migration preserves position and rotation when the expanded footprint fits"
);
assert.equal(migratedSensors.changed, true, "sensor migration is marked as a storage change");

const migratedCurrent = storage.migrateDesignStorage({
  schemaVersion: 3,
  kind: "current-design",
  payload: { modules: legacySensorDesign, dataLinks: [], combatStyle: "hold" }
});
assert.equal(migratedCurrent.migrated, true, "current saved designs with legacy sensors are marked for persistence");
assert.deepEqual(migratedCurrent.modules.map((part) => part.type), migratedSensors.modules.map((part) => part.type));

const serverLegacyValidation = serverShipDesign.validateDesign(legacySensorDesign);
assert.equal(serverLegacyValidation.ok, true, "server accepts a legacy sensor blueprint when its replacement footprint fits");
assert.deepEqual(serverLegacyValidation.modules.map((part) => part.type), migratedSensors.modules.map((part) => part.type));
assert.deepEqual(
  serverShipDesign.normalizeShipDesignSnapshot(legacySensorDesign).map((part) => part.type),
  migratedSensors.modules.map((part) => part.type),
  "server snapshot normalization uses the same legacy sensor replacements"
);

const packedLegacy = [];
for (let y = 0; y <= 14; y += 1) {
  for (let x = 0; x <= 14; x += 1) {
    packedLegacy.push(x === 7 && y === 7
      ? { x, y, type: "sensorArray" }
      : { x, y, type: x === 0 && y === 0 ? "core" : "frame" });
  }
}
const blockedMigration = storage.normalizeDesignDetailed(packedLegacy, { allowEmpty: true });
assert.equal(blockedMigration.issues[0]?.code, "legacy-component-migration",
  "an impossible footprint expansion is reported explicitly");
assert.equal(blockedMigration.modules.some((part) => part.type === "largeSensor"), false,
  "an unmigratable legacy sensor is not left overlapping the packed design");

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

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
