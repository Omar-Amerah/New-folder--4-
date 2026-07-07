// Unit suffix builders and text formatting wrappers for ship inspector statistics.

export function formatMass(value) {
  return `${Number(value) || 0} T`;
}

export function formatHull(value) {
  return `${Number(value) || 0} HP`;
}

export function formatShield(value) {
  return `${Number(value) || 0} SP`;
}

export function formatThrust(value) {
  return `${Number(value) || 0} kN`;
}

export function formatEnergy(value) {
  return `${Number(value) || 0} MJ`;
}

export function formatRepair(value) {
  return `${Number(value) || 0} HP/s`;
}

export function formatPowerUse(value) {
  return `${Number(value) || 0} MW`;
}

export function formatPowerGeneration(value) {
  return `+${Number(value) || 0} MW`;
}

export function formatDistance(value) {
  return `${Number(value) || 0} m`;
}

export function formatSpeed(value) {
  return `${Number(value) || 0} m/s`;
}

export function formatDamage(value) {
  return `${Number(value) || 0} dmg`;
}

export function formatPercent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}
