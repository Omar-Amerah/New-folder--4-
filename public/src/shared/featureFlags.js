(function initMfaFeatureFlags(root, factory) {
  const flags = factory();
  if (typeof module === "object" && module.exports) module.exports = flags;
  root.MfaFeatureFlags = flags;
}(typeof globalThis !== "undefined" ? globalThis : this, function makeMfaFeatureFlags() {
  return Object.freeze({
    // Temporary performance switch. Set to true to restore the existing Wiring
    // editor, analysis, infrastructure costs, and authoritative runtime solver.
    WIRING_ENABLED: true,
    // Set to true to use the current split movement modules instead of the
    // legacy monolithic movement implementation.
    MODERN_MOVEMENT: true,
    // Circular ship-to-ship separation path. Initially false to preserve the
    // detailed hull-cell fallback while tests are developed.
    CIRCULAR_SHIP_SEPARATION: false,
    // Fleet-wide map-collision pass after ship separation. Can be disabled once
    // parity is demonstrated to avoid the redundant full pass.
    REDUNDANT_FLEET_MAP_COLLISION_PASS: true
  });
}));
