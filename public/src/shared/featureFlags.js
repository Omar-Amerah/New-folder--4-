(function initMfaFeatureFlags(root, factory) {
  const flags = factory();
  if (typeof module === "object" && module.exports) module.exports = flags;
  root.MfaFeatureFlags = flags;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeMfaFeatureFlags() {
  return Object.freeze({
    // Temporary performance switch. Set to true to restore the existing Wiring
    // editor, analysis, infrastructure costs, and authoritative runtime solver.
    WIRING_ENABLED: false,
    // Set to true to use the current split movement modules instead of the
    // legacy monolithic movement implementation.
    MODERN_MOVEMENT: true
  });
}));
