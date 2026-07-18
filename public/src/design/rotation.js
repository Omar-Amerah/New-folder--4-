// Thin client wrapper around the shared browser/server rotation rules.
import "../shared/rotationRules.js";

const RotationRules = globalThis.RotationRules;

export const { normalizeRotation, legacySideRotation, maneuverThrusterAutoRotation } = RotationRules;

export function nextRotation(current, allowedRotations = null) {
  const allowed = Array.isArray(allowedRotations) && allowedRotations.length ? allowedRotations.map(Number) : RotationRules.DEFAULT_ROTATIONS.slice();
  const normalized = normalizeRotation(current, allowed);
  const index = allowed.indexOf(normalized);
  return allowed[(index + 1) % allowed.length];
}

export function moduleRotationToRadians(rotation) {
  if (rotation === 90) return Math.PI / 2;
  if (rotation === 180) return Math.PI;
  if (rotation === 270) return -Math.PI / 2;
  return 0;
}
