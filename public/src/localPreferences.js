import { LOCAL_NAME_KEY, LOCAL_TEAM_KEY, LOCAL_FORMATION_KEY, LOCAL_SERVER_KEY } from "./constants.js";

export const LOCAL_PREFERENCES_KEY = "modular-fleet-preferences-v1";
export const PREFERENCES_SCHEMA_VERSION = 1;
export const DEFAULT_PREFERENCES = Object.freeze({
  schemaVersion: PREFERENCES_SCHEMA_VERSION,
  pilotName: "",
  preferredTeam: "blue",
  formation: "line",
  renderQuality: "high",
  combatEffectsEnabled: true,
  serverUrl: "",
  reducedMotion: false,
  interfaceScale: 1
});

const teams = new Set(["blue", "red"]);
const formations = new Set(["line", "wedge", "clump"]);
const qualities = new Set(["low", "medium", "high"]);
const scales = new Set([0.9, 1, 1.1, 1.2]);

export function getStorage() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return null;
    const test = `${LOCAL_PREFERENCES_KEY}:test`;
    localStorage.setItem(test, "1");
    localStorage.removeItem(test);
    return localStorage;
  } catch { return null; }
}

function safeGet(storage, key) { try { return storage?.getItem(key) ?? null; } catch { return null; } }
function safeSet(storage, key, value) { try { storage?.setItem(key, value); return true; } catch { return false; } }
function bool(value, fallback) { return typeof value === "boolean" ? value : value === "true" ? true : value === "false" ? false : fallback; }
function cleanName(value) { return String(value || "").trim().slice(0, 18); }
function cleanServer(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try { const url = new URL(raw); if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) return ""; url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString().replace(/\/$/, ""); } catch { return ""; }
}

export function validatePreferences(input = {}, storage = getStorage()) {
  const p = { ...DEFAULT_PREFERENCES };
  if (input && typeof input === "object" && !Array.isArray(input)) {
    p.pilotName = cleanName(input.pilotName);
    p.preferredTeam = teams.has(input.preferredTeam) ? input.preferredTeam : DEFAULT_PREFERENCES.preferredTeam;
    p.formation = formations.has(input.formation) ? input.formation : DEFAULT_PREFERENCES.formation;
    p.renderQuality = qualities.has(input.renderQuality) ? input.renderQuality : DEFAULT_PREFERENCES.renderQuality;
    p.combatEffectsEnabled = bool(input.combatEffectsEnabled, DEFAULT_PREFERENCES.combatEffectsEnabled);
    p.serverUrl = cleanServer(input.serverUrl);
    p.reducedMotion = bool(input.reducedMotion, DEFAULT_PREFERENCES.reducedMotion);
    const scale = Number(input.interfaceScale);
    p.interfaceScale = scales.has(scale) ? scale : DEFAULT_PREFERENCES.interfaceScale;
  }
  if (!p.pilotName) p.pilotName = cleanName(safeGet(storage, LOCAL_NAME_KEY));
  return p;
}

export function migratePreferences(raw, storage = getStorage()) {
  let parsed = null;
  let recovered = false;
  if (raw) {
    try { parsed = JSON.parse(raw); } catch { recovered = true; }
  }
  if (parsed?.schemaVersion > PREFERENCES_SCHEMA_VERSION) return { preferences: { ...DEFAULT_PREFERENCES }, recovered: true, futureVersion: true };
  const legacy = {
    pilotName: safeGet(storage, LOCAL_NAME_KEY),
    preferredTeam: safeGet(storage, LOCAL_TEAM_KEY),
    formation: safeGet(storage, LOCAL_FORMATION_KEY),
    renderQuality: safeGet(storage, "mfa.renderQuality"),
    combatEffectsEnabled: safeGet(storage, "mfa.combatEffects"),
    serverUrl: safeGet(storage, LOCAL_SERVER_KEY)
  };
  return { preferences: validatePreferences({ ...legacy, ...(parsed || {}) }, storage), recovered };
}

export function loadPreferences() {
  const storage = getStorage();
  if (!storage) return { preferences: { ...DEFAULT_PREFERENCES }, ok: false, unavailable: true, recovered: false };
  const result = migratePreferences(safeGet(storage, LOCAL_PREFERENCES_KEY), storage);
  persistPreferences(result.preferences, storage);
  return { ...result, ok: true };
}

export function persistPreferences(preferences, storage = getStorage()) {
  if (!storage) return false;
  const p = validatePreferences(preferences, storage);
  const ok = safeSet(storage, LOCAL_PREFERENCES_KEY, JSON.stringify(p));
  safeSet(storage, LOCAL_NAME_KEY, p.pilotName);
  safeSet(storage, LOCAL_TEAM_KEY, p.preferredTeam);
  safeSet(storage, LOCAL_FORMATION_KEY, p.formation);
  safeSet(storage, "mfa.renderQuality", p.renderQuality);
  safeSet(storage, "mfa.combatEffects", String(p.combatEffectsEnabled));
  if (p.serverUrl) safeSet(storage, LOCAL_SERVER_KEY, p.serverUrl); else { try { storage.removeItem(LOCAL_SERVER_KEY); } catch {} }
  return ok;
}

export function resetPreferences() { return persistPreferences({ ...DEFAULT_PREFERENCES }); }
export function applyInterfacePreferences(preferences) {
  if (typeof document === "undefined") return;
  const p = validatePreferences(preferences);
  document.documentElement.style.setProperty("--interface-scale", String(p.interfaceScale));
  document.documentElement.classList.toggle("reduced-motion", p.reducedMotion);
}
