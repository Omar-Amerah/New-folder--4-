#!/usr/bin/env node
import assert from "node:assert/strict";

globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
globalThis.window = globalThis;
globalThis.EngineExhaustRules = (await import("./public/src/shared/engineExhaust.js")).default || (await import("./public/src/shared/engineExhaust.js"));
const storageMod = await import("./public/src/design/blueprintStorage.js");
const constants = await import("./public/src/constants.js");
const {
  BLUEPRINT_STORAGE_VERSION, MAX_LOADOUTS, MAX_SAVED_DESIGNS, defaultDesign, designEnvelope, loadDesign, loadLoadouts,
  loadSavedDesigns, loadoutsEnvelope, migrateDesignStorage, migrateLoadoutsStorage, migrateSavedDesignsStorage,
  normalizeDesign, persistDesign, persistLoadouts, persistSavedDesigns, savedDesignsEnvelope
} = storageMod;
const { LOCAL_DESIGN_KEY, LOCAL_LOADOUTS_KEY, LOCAL_SAVED_DESIGNS_KEY } = constants;

class MemoryStorage {
  constructor({ quotaFail = false } = {}) { this.map = new Map(); this.quotaFail = quotaFail; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { if (this.quotaFail) throw new Error("QuotaExceededError"); this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}
function installStorage(s) { Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true }); }
const legacy7 = [
  { x: 3, y: 3, type: "core" },
  { x: 3, y: 4, type: "engine", rotation: 999 },
  { x: 2, y: 3, type: "blaster", rotation: 90 }
];
const current = defaultDesign();

installStorage(new MemoryStorage());
assert.equal(migrateDesignStorage(legacy7).modules[0].x, 7, "old 7x7 centered design migrates to 15x15 center");
assert.equal(migrateDesignStorage({ modules: legacy7, combatStyle: "circle" }).combatStyle, "circle", "legacy object preserves valid combat style");
assert.equal(migrateDesignStorage(designEnvelope(current, "hold")).combatStyle, "hold", "current envelope round trips combat style");
assert.equal(migrateDesignStorage({ schemaVersion: BLUEPRINT_STORAGE_VERSION + 10, kind: "current-design", payload: { modules: [] } }).unknownVersion, true, "future current-design version is rejected safely");

const malformedList = [
  { id: "ok", name: "Kept", blueprint: current, combatStyle: "charge" },
  null,
  "bad",
  { id: "empty", blueprint: [] }
];
const migratedSaved = migrateSavedDesignsStorage(malformedList);
assert.equal(migratedSaved.length, 1, "partial saved-design corruption is quarantined");
assert.equal(migratedSaved[0].name, "Kept", "valid saved-design name is preserved");
assert.equal(migrateSavedDesignsStorage(savedDesignsEnvelope(malformedList)).length, 1, "saved-design migration is idempotent");
assert.equal(migrateSavedDesignsStorage(Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, blueprint: current }))).length, MAX_SAVED_DESIGNS, "saved designs are capped consistently");

const loadouts = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, name: `Loadout ${i}`, designIds: ["a", 2, 3] }));
assert.equal(migrateLoadoutsStorage(loadouts).length, MAX_LOADOUTS, "loadouts are capped consistently");
assert.deepEqual(migrateLoadoutsStorage(loadoutsEnvelope(loadouts))[0].designIds, ["a", "2", "3"], "loadout envelope round trips and normalizes ids");

localStorage.setItem(LOCAL_DESIGN_KEY, "not-json");
assert.equal(loadDesign().combatStyle, "sentry", "corrupt current-design JSON recovers with default");
localStorage.setItem(LOCAL_SAVED_DESIGNS_KEY, JSON.stringify({ wrong: true }));
assert.deepEqual(loadSavedDesigns(), [], "wrong saved-design top-level type is rejected");
localStorage.setItem(LOCAL_LOADOUTS_KEY, JSON.stringify({ schemaVersion: 999, kind: "loadouts", payload: loadouts }));
assert.deepEqual(loadLoadouts(), [], "unknown loadout version is rejected safely");
localStorage.setItem(LOCAL_SAVED_DESIGNS_KEY, JSON.stringify(malformedList));
assert.equal(loadSavedDesigns().length, 1, "partial corruption during load preserves valid entries");

assert.equal(persistDesign(current, "sentry"), true, "current design persists");
assert.equal(loadDesign().modules.length, current.length, "current version round trip preserves modules");
assert.equal(persistSavedDesigns(malformedList), true, "saved designs persist in envelope");
assert.equal(loadSavedDesigns().length, 1, "saved design envelope loads");
assert.equal(persistLoadouts(loadouts), true, "loadouts persist in envelope");
assert.equal(loadLoadouts().length, MAX_LOADOUTS, "loadout envelope loads capped");

installStorage(undefined);
assert.doesNotThrow(() => loadDesign(), "unavailable localStorage does not throw on read");
assert.equal(persistDesign(current, "charge"), false, "unavailable localStorage write fails safely");

installStorage(new MemoryStorage({ quotaFail: true }));
const inMemory = normalizeDesign(current);
assert.equal(persistDesign(inMemory, "hold"), false, "quota failure is reported");
assert.equal(inMemory.length, current.length, "quota failure cannot erase caller in-memory design");

const once = migrateSavedDesignsStorage(malformedList);
const twice = migrateSavedDesignsStorage(savedDesignsEnvelope(once));
assert.deepEqual(twice.map(d => d.id), once.map(d => d.id), "repeated migration is idempotent");
console.log("Blueprint storage verification passed");
