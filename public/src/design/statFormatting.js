// Unit suffix builders and text formatting wrappers for ship inspector statistics.

export function round2(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(2));
}

export function formatMass(value) {
  return `${round2(value)} T`;
}

export function formatHull(value) {
  return `${round2(value)} HP`;
}

export function formatShield(value) {
  return `${round2(value)} SP`;
}

export function formatThrust(value) {
  return `${round2(value)} kN`;
}

export function formatEnergy(value) {
  return `${round2(value)} MJ`;
}

export function formatRepair(value) {
  return `${round2(value)} HP/s`;
}

export function formatPowerUse(value) {
  return `${round2(value)} MW`;
}

export function formatPowerGeneration(value) {
  return `+${round2(value)} MW`;
}

export function formatDistance(value) {
  return `${round2(value)} m`;
}

export function formatSpeed(value) {
  return `${round2(value)} m/s`;
}

export function formatDamage(value) {
  return `${round2(value)} dmg`;
}

export function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}
