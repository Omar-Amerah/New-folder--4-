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

  function moduleRotationToRadians(rotation) {
    if (rotation === 90) return Math.PI / 2;
    if (rotation === 180) return Math.PI;
    if (rotation === 270) return -Math.PI / 2;
    return 0;
  }

  // Signed shortest angular distance from a to b, in (-PI, PI].
  function angleDifference(a, b) {
    let diff = b - a;
    while (diff < -Math.PI) diff += Math.PI * 2;
    while (diff > Math.PI) diff -= Math.PI * 2;
    return diff;
  }

  // Shortest-angle interpolation: steps current toward target by at most
  // maxDelta radians, snapping exactly onto target once within range.
  function approachAngle(current, target, maxDelta) {
    const diff = angleDifference(current, target);
    if (Math.abs(diff) <= maxDelta) return target;
    return current + Math.sign(diff) * maxDelta;
  }

  return Object.freeze({
    DEFAULT_ROTATIONS,
    legacySideRotation,
    maneuverThrusterAutoRotation,
    normalizeRotation,
    moduleRotationToRadians,
    angleDifference,
    approachAngle
  });
});
