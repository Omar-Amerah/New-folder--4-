const sharedFlags = globalThis.MfaFeatureFlags;

if (!sharedFlags) {
  throw new Error("MfaFeatureFlags must load before featureFlags.js");
}

export const WIRING_ENABLED = sharedFlags.WIRING_ENABLED === true;
export const MODERN_MOVEMENT = sharedFlags.MODERN_MOVEMENT === true;

export function applyFeatureFlagPresentation() {
  for (const element of document.querySelectorAll("[data-feature-wiring]")) {
    element.hidden = !WIRING_ENABLED;
  }
  for (const element of document.querySelectorAll("[data-feature-no-wiring]")) {
    element.hidden = WIRING_ENABLED;
  }

  if (!WIRING_ENABLED) {
    const reset = document.getElementById("resetButton");
    const clear = document.getElementById("clearGridButton");
    reset?.setAttribute("title", "Reset to starter ship");
    reset?.setAttribute("aria-label", "Reset to starter ship");
    clear?.setAttribute("title", "Remove all components except the core");
    clear?.setAttribute("aria-label", "Remove all components except the core");
  }
}
