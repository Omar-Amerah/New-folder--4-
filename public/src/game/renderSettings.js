
let cachedRenderQuality = null;

export function getRenderQuality() {
  if (cachedRenderQuality !== null) return cachedRenderQuality;
  const stored = localStorage.getItem("mfa.renderQuality");
  if (["low", "medium", "high"].includes(stored)) {
    cachedRenderQuality = stored;
  } else {
    cachedRenderQuality = "high";
  }
  return cachedRenderQuality;
}

export function setRenderQuality(quality) {
  if (["low", "medium", "high"].includes(quality)) {
    localStorage.setItem("mfa.renderQuality", quality);
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
  if (q === "low") return 1.25;
  if (q === "medium") return 1.5;
  return 2.0;
}

// Multiplier for non-essential particle density (engine smoke, trails, sparks,
// heat pulses). Essential feedback — projectiles, warnings, selection, damage
// numbers — is never gated by this. Low graphics thins particles heavily.
export function getEffectDensity() {
  const q = getRenderQuality();
  if (q === "low") return 0.4;
  if (q === "medium") return 0.72;
  return 1;
}

// These flags are read every frame in the render loop, so cache them instead of
// hitting the synchronous localStorage API each time.
let cachedCombatEffects = null;
let cachedDebugRenderer = null;

export function getCombatEffectsEnabled() {
  if (cachedCombatEffects === null) {
    cachedCombatEffects = localStorage.getItem("mfa.combatEffects") !== "false";
  }
  return cachedCombatEffects;
}

export function setCombatEffectsEnabled(enabled) {
  cachedCombatEffects = Boolean(enabled);
  localStorage.setItem("mfa.combatEffects", cachedCombatEffects);
}

export function getDebugRendererEnabled() {
  if (cachedDebugRenderer === null) {
    cachedDebugRenderer = localStorage.getItem("mfa.debugRenderer") === "true";
  }
  return cachedDebugRenderer;
}

export function setDebugRendererEnabled(enabled) {
  cachedDebugRenderer = Boolean(enabled);
  localStorage.setItem("mfa.debugRenderer", cachedDebugRenderer);
}


let cachedMobileTestingMode = null;

export function getMobileTestingModeEnabled() {
  if (cachedMobileTestingMode === null) {
    cachedMobileTestingMode = localStorage.getItem("mfa.mobileTestingMode") === "true";
  }
  return cachedMobileTestingMode;
}

export function setMobileTestingModeEnabled(enabled) {
  cachedMobileTestingMode = Boolean(enabled);
  localStorage.setItem("mfa.mobileTestingMode", cachedMobileTestingMode);
}
