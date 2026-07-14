// Renderer-neutral ship status math: per-component health ratios, shield
// ratios/radii, and hull-bar colour ramps. No Canvas, no Pixi, no DOM — both
// the Pixi arena renderer imports these.

import { clamp } from "../shared/math.js";
import { PART_STATS } from "../design/parts.js";

// Per-component max hp mirrors the server: each part's base hp scaled so the
// design total matches ship.maxHp. Cached per design array (designs are static
// and their object identity is reused across snapshots).
const designComponentHpCache = new WeakMap();

// Remaining health fraction (0..1) for design[index], or null when unknown
// (no component data yet, e.g. ships from older servers). Mirrors the server's
// scaling: the indestructible core is excluded from the damageable sum.
export function componentHealthRatio(ship, index) {
  const chp = ship?.chp;
  if (!chp || chp[index] === undefined || !ship.design) return null;
  if (ship.design[index]?.type === "core") return 1;
  let raw = designComponentHpCache.get(ship.design);
  if (!raw) {
    const values = ship.design.map((part) => Math.max(1, Number(PART_STATS[part.type]?.hp) || 1));
    const sum = ship.design.reduce((total, part, i) => (part.type === "core" ? total : total + values[i]), 0) || 1;
    raw = { values, sum };
    designComponentHpCache.set(ship.design, raw);
  }
  const maxHp = Number(ship.maxHp) || raw.sum;
  const componentMax = raw.values[index] * (maxHp / raw.sum);
  if (!(componentMax > 0)) return null;
  return clamp(chp[index] / componentMax, 0, 1);
}

export function shieldRatioForShip(ship) {
  const maxShield = Number(ship?.maxShield) || 0;
  if (maxShield <= 0) return 0;
  return clamp((Number(ship.shield) || 0) / maxShield, 0, 1);
}

export function shieldRingRadius(ship) {
  const radius = Number(ship?.radius) || 0;
  return Math.max(30, radius + Math.max(8, radius * 0.18));
}

export function hullColorForRatio(ratio) {
  if (ratio <= 0.25) return { start: "#450a0a", end: "#ef4444" };
  if (ratio <= 0.55) return { start: "#431407", end: "#f97316" };
  return { start: "#062f17", end: "#22c55e" };
}
