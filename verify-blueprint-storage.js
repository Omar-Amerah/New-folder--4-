#!/usr/bin/env node
// Verifies blueprint storage schema v2: { modules, wiring } persistence, the
// hard break from pre-wiring storage (old keys/versions are discarded, users
// fall back to the default ship + default wiring), and wiring copies staying
// independent across save/duplicate/export/import.
import assert from "node:assert/strict";

globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
globalThis.window = globalThis;
globalThis.EngineExhaustRules = (await import("./public/src/shared/engineExhaust.js")).default || (await import("./public/src/shared/engineExhaust.js"));
await import("./public/src/shared/wiringRules.js"); // attaches globalThis.WiringRules
const storageMod = await import("./public/src/design/blueprintStorage.js");
const constants = await import("./public/src/constants.js");
const {
  BLUEPRINT_STORAGE_VERSION, MAX_LOADOUTS, MAX_SAVED_DESIGNS, defaultDesign, defaultWiring, normalizeWiring, designEnvelope,
  loadDesign, loadLoadouts, loadSavedDesigns, loadoutsEnvelope, migrateDesignStorage, migrateLoadoutsStorage,
  migrateSavedDesignsStorage, normalizeDesign, persistDesign, persistLoadouts, persistSavedDesigns, savedDesignsEnvelope,
  exportBlueprints, importBlueprints
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

const current = defaultDesign();
const wiring = defaultWiring();

// ---- Storage version / key break: old data is discarded, not migrated ----
assert.equal(BLUEPRINT_STORAGE_VERSION, 2, "wiring storage bumps the schema version");
assert.equal(LOCAL_DESIGN_KEY, "modular-fleet-design-v3", "current design moved to a new key");
assert.equal(LOCAL_SAVED_DESIGNS_KEY, "modular-fleet-saved-designs-v2", "saved designs moved to a new key");
assert.equal(LOCAL_LOADOUTS_KEY, "modular-fleet-loadouts-v2", "loadouts moved to a new key");

installStorage(new MemoryStorage());
const fresh = loadDesign();
assert.deepEqual(fresh.modules, current, "empty storage yields the default ship");
assert.deepEqual(fresh.wiring, normalizeWiring(wiring, current), "empty storage yields the default wiring");
assert.ok(fresh.wiring.power.length > 0, "default wiring is not empty");
assert.deepEqual(fresh.wiring.data, [], "default ship has no data wiring");

const legacyArray = [{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }];
assert.deepEqual(migrateDesignStorage(legacyArray).modules, current, "legacy raw arrays are discarded to the default ship");
assert.deepEqual(migrateDesignStorage({ modules: legacyArray, combatStyle: "circle" }).modules, current, "legacy v1 objects are discarded");
assert.deepEqual(migrateDesignStorage({ schemaVersion: 1, kind: "current-design", payload: { modules: legacyArray } }).modules, current, "v1 envelopes are discarded");
assert.deepEqual(migrateDesignStorage({ schemaVersion: BLUEPRINT_STORAGE_VERSION + 1, kind: "current-design", payload: { modules: legacyArray } }).modules, current, "future envelopes are discarded safely");
assert.deepEqual(migrateDesignStorage(legacyArray).wiring, normalizeWiring(wiring, current), "discarded data receives default wiring");

// ---- v2 round trip keeps modules + wiring + combat style ----
const envelope2 = designEnvelope(current, wiring, "hold");
assert.equal(envelope2.schemaVersion, 2);
const roundTrip = migrateDesignStorage(envelope2);
assert.equal(roundTrip.combatStyle, "hold", "combat style round trips");
assert.deepEqual(roundTrip.modules, normalizeDesign(current), "modules round trip");
assert.deepEqual(roundTrip.wiring.power, normalizeWiring(wiring, current).power, "wiring round trips");

installStorage(new MemoryStorage());
assert.equal(persistDesign(current, wiring, "sentry"), true, "current design persists with wiring");
const persisted = loadDesign();
assert.equal(persisted.modules.length, current.length, "round trip preserves modules");
assert.equal(persisted.wiring.power.length, wiring.power.length, "round trip preserves wiring segments");
assert.ok(JSON.parse(localStorage.getItem(LOCAL_DESIGN_KEY)).payload.wiring, "stored payload includes wiring");

// Floating wiring is dropped against the persisted modules.
const dirtyWiring = { version: 1, power: [...wiring.power, { x1: 0, y1: 0, x2: 1, y2: 0 }], data: [] };
persistDesign(current, dirtyWiring, "sentry");
assert.equal(loadDesign().wiring.power.length, wiring.power.length, "floating segments never persist");

// ---- Saved designs store independent module + wiring copies ----
const savedList = [{ id: "ok", name: "Kept", blueprint: current, wiring, combatStyle: "charge" }, null, "bad", { id: "empty", blueprint: [] }];
assert.equal(persistSavedDesigns(savedList), true, "saved designs persist in envelope");
const loadedSaved = loadSavedDesigns();
assert.equal(loadedSaved.length, 1, "malformed saved entries are quarantined");
assert.equal(loadedSaved[0].name, "Kept");
assert.deepEqual(loadedSaved[0].wiring.power, normalizeWiring(wiring, current).power, "saved designs keep their wiring");
loadedSaved[0].wiring.power.push({ x1: 9, y1: 7, x2: 9, y2: 8 });
assert.equal(loadSavedDesigns()[0].wiring.power.length, wiring.power.length, "loaded wiring copies are independent");
assert.equal(migrateSavedDesignsStorage(savedList).length, 0, "raw (pre-envelope) saved lists are discarded");
assert.equal(migrateSavedDesignsStorage({ schemaVersion: 1, kind: "saved-designs", payload: savedList }).length, 0, "v1 saved-design envelopes are discarded");
assert.equal(migrateSavedDesignsStorage(savedDesignsEnvelope(Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, blueprint: current })))).length, MAX_SAVED_DESIGNS, "saved designs are capped consistently");

const loadouts = Array.from({ length: 12 }, (_, i) => ({ id: `l${i}`, name: `Loadout ${i}`, designIds: ["a", 2, 3] }));
assert.equal(migrateLoadoutsStorage(loadoutsEnvelope(loadouts)).length, MAX_LOADOUTS, "loadouts are capped consistently");
assert.deepEqual(migrateLoadoutsStorage(loadoutsEnvelope(loadouts))[0].designIds, ["a", "2", "3"], "loadout envelope round trips and normalizes ids");
assert.deepEqual(migrateLoadoutsStorage(loadouts), [], "raw legacy loadout lists are discarded");

localStorage.setItem(LOCAL_DESIGN_KEY, "not-json");
localStorage.removeItem(LOCAL_DESIGN_BACKUP_KEY);
assert.equal(loadDesign().combatStyle, "sentry", "corrupt current-design JSON recovers with default");
localStorage.setItem(LOCAL_SAVED_DESIGNS_KEY, JSON.stringify({ wrong: true }));
assert.deepEqual(loadSavedDesigns(), [], "wrong saved-design top-level type is rejected");
localStorage.setItem(LOCAL_LOADOUTS_KEY, JSON.stringify({ schemaVersion: 999, kind: "loadouts", payload: loadouts }));
assert.deepEqual(loadLoadouts(), [], "unknown loadout version is rejected safely");

assert.equal(persistLoadouts(loadouts), true, "loadouts persist in envelope");
assert.equal(loadLoadouts().length, MAX_LOADOUTS, "loadout envelope loads capped");

installStorage(undefined);
assert.doesNotThrow(() => loadDesign(), "unavailable localStorage does not throw on read");
assert.equal(persistDesign(current, wiring, "charge"), false, "unavailable localStorage write fails safely");

installStorage(new MemoryStorage({ quotaFail: true }));
const inMemory = normalizeDesign(current);
assert.equal(persistDesign(inMemory, wiring, "hold"), false, "quota failure is reported");
assert.equal(inMemory.length, current.length, "quota failure cannot erase caller in-memory design");

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
const goodEnvelope = designEnvelope(current, wiring, "hold");
localStorage.setItem(LOCAL_DESIGN_BACKUP_KEY, JSON.stringify(goodEnvelope));
localStorage.setItem(LOCAL_DESIGN_KEY, "not-json");
const recovered = loadDesign();
assert.equal(recovered.combatStyle, "hold", "last-known-good current blueprint restores after corruption");
assert.equal(recovered.wiring.power.length, wiring.power.length, "backup restores wiring too");

// ---- Export / import carries wiring ----
const exported = exportBlueprints([{ id: "ok", name: "Ok", blueprint: current, wiring }], []);
assert.equal(exported.schemaVersion, 2, "export uses the current schema version");
assert.ok(exported.payload.designs[0].wiring.power.length > 0, "export includes wiring");
const imp = importBlueprints(exported, [{ id: "ok", name: "Existing", blueprint: current, wiring }], []);
assert.equal(imp.accepted, 1, "valid import accepted");
assert.equal(new Set(imp.designs.map((d) => d.id)).size, imp.designs.length, "duplicate imported IDs are renamed safely");
const importedCopy = imp.designs.find((d) => d.id !== "ok");
assert.deepEqual(importedCopy.wiring.power, normalizeWiring(wiring, current).power, "import restores wiring");
importedCopy.wiring.power.pop();
assert.equal(exported.payload.designs[0].wiring.power.length, wiring.power.length, "imported wiring is an independent copy");
const badImp = importBlueprints({ designs: [{ id: "bad", blueprint: [{ x: 999, y: 999, type: "nope" }] }] }, [], []);
assert.equal(badImp.accepted, 0, "invalid imports are rejected");
assert.equal(importBlueprints({ schemaVersion: 1, kind: "blueprint-export", payload: { designs: [{ blueprint: current }] } }, [], []).incompatibleVersion, true, "pre-wiring export schema is rejected");
assert.equal(importBlueprints({ schemaVersion: BLUEPRINT_STORAGE_VERSION + 1, kind: "blueprint-export", payload: { designs: [{ blueprint: current }] } }, [], []).incompatibleVersion, true, "future import schema is rejected");
assert.equal(importBlueprints({ designs: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, blueprint: current })) }, [], []).designs.length, MAX_SAVED_DESIGNS, "import enforces saved-design limit");

console.log("Blueprint storage verification passed");
