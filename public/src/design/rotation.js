// Handles modular part rotation math, degrees normalization, and radians translation.

export function normalizeRotation(value) {
  const rotation = Number(value);
  return [0, 90, 180, 270].includes(rotation) ? rotation : 0;
}

export function moduleRotationToRadians(rotation) {
  if (rotation === 90) return Math.PI / 2;
  if (rotation === 180) return Math.PI;
  if (rotation === 270) return -Math.PI / 2;
  return 0;
}

// Maneuver thrusters are not user-rotatable. Their direction is derived from
// which side of the 15x15 blueprint they occupy: the left-side nozzle/exhaust
// points left, the right-side nozzle/exhaust points right, and a centreline
// thruster retains its forward orientation.
export function maneuverThrusterAutoRotation(x, gridCenter = 7) {
  const column = Number(x);
  if (column < gridCenter) return 90;
  if (column > gridCenter) return 270;
  return 0;
}
