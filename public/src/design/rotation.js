// Thin client wrapper around the shared browser/server rotation rules.
import "../shared/rotationRules.js";

const RotationRules = globalThis.RotationRules;

export const { normalizeRotation, legacySideRotation, maneuverThrusterAutoRotation, moduleRotationToRadians } = RotationRules;

export function nextRotation(current, allowedRotations = null) {
  const allowed = Array.isArray(allowedRotations) && allowedRotations.length ? allowedRotations.map(Number) : RotationRules.DEFAULT_ROTATIONS.slice();
  const normalized = normalizeRotation(current, allowed);
  const index = allowed.indexOf(normalized);
  return allowed[(index + 1) % allowed.length];
}

