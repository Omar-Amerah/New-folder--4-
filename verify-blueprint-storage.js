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
  normalizeDesign, persistDesign, persistLoadouts, persistSavedDesigns, savedDesignsEnvelope, exportBlueprints, importBlueprints
} = storageMod;
const { LOCAL_DESIGN_KEY, LOCAL_LOADOUTS_KEY, LOCAL_SAVED_DESIGNS_KEY, LOCAL_NAME_KEY, LOCAL_TEAM_KEY, LOCAL_FORMATION_KEY, LOCAL_SERVER_KEY, LOCAL_DESIGN_BACKUP_KEY } = constants;

const prefsMod = await import("./public/src/localPreferences.js");
const { DEFAULT_PREFERENCES, LOCAL_PREFERENCES_KEY, loadPreferences, persistPreferences, validatePreferences } = prefsMod;

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
const previousStock = [
  { x: 7, y: 7, type: "core" },
  { x: 7, y: 8, type: "frame" },
  { x: 6, y: 8, type: "engine" },
  { x: 8, y: 8, type: "engine" },
  { x: 6, y: 7, type: "blaster" },
  { x: 8, y: 7, type: "blaster" },
  { x: 5, y: 7, type: "maneuverThruster" },
  { x: 9, y: 7, type: "maneuverThruster" },
  { x: 7, y: 6, type: "shield" },
  { x: 6, y: 6, type: "armor" },
  { x: 8, y: 6, type: "armor" },
  { x: 7, y: 9, type: "battery" }
];

installStorage(new MemoryStorage());
assert.equal(migrateDesignStorage(legacy7).modules[0].x, 7, "old 7x7 centered design migrates to 15x15 center");
assert.equal(migrateDesignStorage({ modules: legacy7, combatStyle: "circle" }).combatStyle, "circle", "legacy object preserves valid combat style");
assert.deepEqual(migrateDesignStorage(previousStock).modules, current, "untouched previous stock default migrates to the new stock default");
const modifiedPreviousStock = previousStock.map((part) => ({ ...part }));
modifiedPreviousStock.push({ x: 4, y: 7, type: "frame" });
assert.notDeepEqual(migrateDesignStorage(modifiedPreviousStock).modules, current, "modified previous stock default is preserved instead of migrated");
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


installStorage(new MemoryStorage());
assert.equal(loadPreferences().preferences.renderQuality, DEFAULT_PREFERENCES.renderQuality, "settings defaults load");
assert.equal(validatePreferences({ preferredTeam: "green", renderQuality: "ultra", interfaceScale: 5 }).preferredTeam, "blue", "invalid settings fall back");
installStorage(new MemoryStorage());
localStorage.setItem(LOCAL_NAME_KEY, "Ace"); localStorage.setItem(LOCAL_TEAM_KEY, "red"); localStorage.setItem(LOCAL_FORMATION_KEY, "wedge"); localStorage.setItem(LOCAL_SERVER_KEY, "https://example.test/path?token=secret"); localStorage.setItem("mfa.renderQuality", "low");
const migratedPrefs = loadPreferences().preferences;
assert.equal(migratedPrefs.pilotName, "Ace", "legacy pilot name migrates");
assert.equal(migratedPrefs.preferredTeam, "red", "legacy team migrates");
assert.equal(migratedPrefs.serverUrl, "https://example.test/path", "server setting sanitizes during migration");
localStorage.setItem(LOCAL_PREFERENCES_KEY, "not json");
assert.equal(loadPreferences().recovered, true, "corrupt settings recovery is reported");
installStorage(undefined);
assert.equal(persistPreferences(DEFAULT_PREFERENCES), false, "unavailable settings storage write fails safely");

installStorage(new MemoryStorage());
const goodEnvelope = designEnvelope(current, "hold");
localStorage.setItem(LOCAL_DESIGN_BACKUP_KEY, JSON.stringify(goodEnvelope));
localStorage.setItem(LOCAL_DESIGN_KEY, "not-json");
assert.equal(loadDesign().combatStyle, "hold", "last-known-good current blueprint restores after corruption");
const exported = exportBlueprints([{ id: "ok", name: "Ok", blueprint: current }], []);
const imp = importBlueprints(exported, [{ id: "ok", name: "Existing", blueprint: current }], []);
assert.equal(imp.accepted, 1, "valid import accepted");
assert.equal(new Set(imp.designs.map((d) => d.id)).size, imp.designs.length, "duplicate imported IDs are renamed safely");
const badImp = importBlueprints({ designs: [{ id: "bad", blueprint: [{ x: 999, y: 999, type: "nope" }] }] }, [], []);
assert.equal(badImp.accepted, 0, "invalid imports are rejected");
assert.equal(importBlueprints({ schemaVersion: BLUEPRINT_STORAGE_VERSION + 1, kind: "blueprint-export", payload: { designs: [{ blueprint: current }] } }, [], []).futureVersion, true, "future import schema is rejected");
assert.equal(importBlueprints({ designs: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, blueprint: current })) }, [], []).designs.length, MAX_SAVED_DESIGNS, "import enforces saved-design limit");

console.log("Blueprint storage verification passed");
