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
