// Renderer-neutral ship status math: per-component health ratios, shield
// ratios/radii, and hull-bar colour ramps. No Canvas, no Pixi, no DOM — both
// the Pixi arena renderer imports these.

import { clamp } from "../shared/math.js";
import { PART_STATS } from "../design/parts.js";
import { GENERATED_BALANCE } from "../generatedBalance.js";
import { shipLocalBounds } from "./shipGeometry.js";

// Per-component max hp mirrors the server: each part's base hp scaled so the
// design total matches ship.maxHp. Cached per design array (designs are static
// and their object identity is reused across snapshots).
const designComponentHpCache = new WeakMap();

// Remaining health fraction (0..1) for design[index], or null when unknown
// (no component data yet, e.g. ships from older servers). Mirrors the server's
// scaling: the indestructible core is excluded from the damageable sum.
export function componentHealthRatio(ship, index) {
  const chp = ship?.chp;
  if ((!chp || chp[index] === undefined) && Array.isArray(ship?.chpVisual) && ship.chpVisual[index] !== undefined) {
    return clamp(Number(ship.chpVisual[index]) / 10, 0, 1);
  }
  if (!chp || chp[index] === undefined || !ship.design) return null;
  if (ship.design[index]?.type === "core") {
    const hasBackupCore = ship.design.some((part) => part.type === "backupCore");
    if (!hasBackupCore) return 1;
    const coreMax = Math.max(1, Number(PART_STATS.core?.hp) || 340);
    return clamp(chp[index] / coreMax, 0, 1);
  }
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

export function shieldRingRadius(ship, design = ship?.design, scale = 13) {
  const collision = GENERATED_BALANCE?.projectiles?.shieldCollision || {};
  const footprintRadius = shipLocalBounds(design, scale).radius;
  const physicalRadius = Number(ship?.physicalRadius) || 0;
  const gameplayRadius = Number(ship?.radius) || 0;
  const hullRadius = footprintRadius > 0
    ? Math.max(18, footprintRadius)
    : Math.max(18, physicalRadius || gameplayRadius);
  const flatPadding = Number(collision.flatPadding) || 0;
  const proportionalPadding = hullRadius * (Number(collision.radiusMultiplier) || 0);
  return Math.max(
    Number(collision.minimumRadius) || 0,
    hullRadius + Math.max(flatPadding, proportionalPadding)
  );
}

// Shield ring palette, shared by the ship and station renderers so a station's
// shield reads as the same system as a hull's: cyan at full, amber under
// pressure, red about to fail.
function blendShieldColor(a, b, t) {
  const mix = clamp(t, 0, 1);
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * mix) << 16)
    | (Math.round(ag + (bg - ag) * mix) << 8)
    | Math.round(ab + (bb - ab) * mix)
  );
}

export function shieldColorForRatio(ratio) {
  const cyan = 0x38d5ff;
  const amber = 0xfbbf24;
  const red = 0xef4444;
  if (ratio > 0.5) return blendShieldColor(amber, cyan, (ratio - 0.5) / 0.5);
  return blendShieldColor(red, amber, ratio / 0.5);
}

export function brightenShieldColor(color, amount = 0.52) {
  return blendShieldColor(color, 0xffffff, amount);
}

export function hullColorForRatio(ratio) {
  if (ratio <= 0.25) return { start: "#450a0a", end: "#ef4444" };
  if (ratio <= 0.55) return { start: "#431407", end: "#f97316" };
  return { start: "#062f17", end: "#22c55e" };
}
