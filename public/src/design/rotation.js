// Handles modular part rotation math, degrees normalization, and radians translation.

export function normalizeRotation(value, allowedRotations = null, legacyX = null) {
  const allowed = Array.isArray(allowedRotations) && allowedRotations.length ? allowedRotations.map(Number) : [0, 90, 180, 270];
  const rotation = Number(value);
  if (allowed.includes(rotation)) return rotation;
  if (allowed.includes(90) && allowed.includes(270) && allowed.length === 2) return legacySideRotation(legacyX);
  return allowed.includes(0) ? 0 : allowed[0];
}

export function nextRotation(current, allowedRotations = null) {
  const allowed = Array.isArray(allowedRotations) && allowedRotations.length ? allowedRotations.map(Number) : [0, 90, 180, 270];
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

export function legacySideRotation(x, gridCenter = 7) {
  const column = Number(x);
  if (column > gridCenter) return 270;
  return 90;
}

export const maneuverThrusterAutoRotation = legacySideRotation;
