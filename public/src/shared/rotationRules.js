// Shared rotation normalization rules for browser designer code and the Node server.
(function initRotationRules(root, factory) {
  const api = factory();
  root.RotationRules = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function rotationRulesFactory() {
  const DEFAULT_ROTATIONS = Object.freeze([0, 90, 180, 270]);

  function allowedList(allowedRotations) {
    return Array.isArray(allowedRotations) && allowedRotations.length
      ? allowedRotations.map(Number)
      : DEFAULT_ROTATIONS.slice();
  }

  function sideFacingRotation(x, gridCenter = 7) {
    const column = Number(x);
    return column < gridCenter ? 90 : 270;
  }

  function legacySideRotation(x, gridCenter = 7) {
    return sideFacingRotation(x, gridCenter);
  }

  function maneuverThrusterAutoRotation(x, gridCenter = 7) {
    return sideFacingRotation(x, gridCenter);
  }

  function normalizeRotation(value, allowedRotations = null, legacyX = null) {
    const allowed = allowedList(allowedRotations);
    const rotation = Number(value);
    if (allowed.includes(rotation)) return rotation;
    if (allowed.length === 2 && allowed.includes(90) && allowed.includes(270)) return sideFacingRotation(legacyX);
    return allowed.includes(0) ? 0 : allowed[0];
  }

  return Object.freeze({
    DEFAULT_ROTATIONS,
    legacySideRotation,
    maneuverThrusterAutoRotation,
    normalizeRotation
  });
});
