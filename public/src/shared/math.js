// Shared pure mathematical helper functions, bounds clamps, and soft caps.

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function softCap(value, cap, softness = 0.35) {
  if (value <= cap) return value;
  return cap + (value - cap) * softness;
}

export function approach(current, target, rate) {
  const t = clamp(rate, 0, 1);
  return current + (target - current) * t;
}

// Signed shortest angular distance from a to b, in (-PI, PI].
export function angleDifference(a, b) {
  let diff = b - a;
  while (diff < -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;
  return diff;
}

// Shortest-angle interpolation: steps current toward target by at most
// maxDelta radians, snapping exactly onto target once within range.
export function approachAngle(current, target, maxDelta) {
  const diff = angleDifference(current, target);
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}
