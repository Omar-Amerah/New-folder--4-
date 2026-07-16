
import { loadPreferences, persistPreferences } from "../localPreferences.js";

export const RENDER_QUALITY_PROFILES = Object.freeze({
  low: Object.freeze({ name: "low", dprCap: 1.25, bakeScale: 1.5, effectDensity: 0.4, trailDensity: 0.35, particleDensity: 0.35 }),
  medium: Object.freeze({ name: "medium", dprCap: 1.5, bakeScale: 2.0, effectDensity: 0.72, trailDensity: 0.7, particleDensity: 0.7 }),
  high: Object.freeze({ name: "high", dprCap: 2.0, bakeScale: 2.5, effectDensity: 1, trailDensity: 1, particleDensity: 1 })
});
export function renderQualityProfile(name = getRenderQuality()) { return RENDER_QUALITY_PROFILES[name] || RENDER_QUALITY_PROFILES.medium; }
function storageGet(key) { return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null; }
function storageSet(key, value) { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); }
let cachedRenderQuality = null;

export function getRenderQuality() {
  if (cachedRenderQuality !== null) return cachedRenderQuality;
  const stored = loadPreferences().preferences.renderQuality || storageGet("mfa.renderQuality");
  if (["low", "medium", "high"].includes(stored)) {
    cachedRenderQuality = stored;
  } else {
    cachedRenderQuality = "high";
  }
  return cachedRenderQuality;
}

export function setRenderQuality(quality) {
  if (["low", "medium", "high"].includes(quality)) {
    persistPreferences({ ...loadPreferences().preferences, renderQuality: quality });
    storageSet("mfa.renderQuality", quality);
    cachedRenderQuality = quality;
  }
}

export function qualityShadowBlur(value) {
  const q = getRenderQuality();
  if (q === "low") return 0;
  if (q === "medium") return value * 0.45;
  return value;
}

export function getRenderQualityDprCap() {
  const q = getRenderQuality();
  return renderQualityProfile(q).dprCap;
}

// Multiplier for non-essential particle density (engine smoke, trails, sparks,
// heat pulses). Essential feedback — projectiles, warnings, selection, damage
// numbers — is never gated by this. Low graphics thins particles heavily.
export function getEffectDensity() {
  const q = getRenderQuality();
  return renderQualityProfile(q).effectDensity;
}

// These flags are read every frame in the render loop, so cache them instead of
// hitting the synchronous localStorage API each time.
let cachedCombatEffects = null;
let cachedDebugRenderer = null;

export function getCombatEffectsEnabled() {
  if (cachedCombatEffects === null) {
    cachedCombatEffects = loadPreferences().preferences.combatEffectsEnabled;
  }
  return cachedCombatEffects;
}

export function setCombatEffectsEnabled(enabled) {
  cachedCombatEffects = Boolean(enabled);
  persistPreferences({ ...loadPreferences().preferences, combatEffectsEnabled: cachedCombatEffects });
  storageSet("mfa.combatEffects", String(cachedCombatEffects));
}

export function getDebugRendererEnabled() {
  if (cachedDebugRenderer === null) {
    cachedDebugRenderer = storageGet("mfa.debugRenderer") === "true";
  }
  return cachedDebugRenderer;
}

export function setDebugRendererEnabled(enabled) {
  cachedDebugRenderer = Boolean(enabled);
  storageSet("mfa.debugRenderer", cachedDebugRenderer);
}


let cachedMobileTestingMode = null;

export function getMobileTestingModeEnabled() {
  if (cachedMobileTestingMode === null) {
    cachedMobileTestingMode = storageGet("mfa.mobileTestingMode") === "true";
  }
  return cachedMobileTestingMode;
}

export function setMobileTestingModeEnabled(enabled) {
  cachedMobileTestingMode = Boolean(enabled);
  storageSet("mfa.mobileTestingMode", cachedMobileTestingMode);
}
