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

// Angle math lives in the shared rotation rules so the server simulation and
// the client's turret prediction use one implementation and can never drift.
import "./rotationRules.js";
export const angleDifference = globalThis.RotationRules.angleDifference;
export const approachAngle = globalThis.RotationRules.approachAngle;
