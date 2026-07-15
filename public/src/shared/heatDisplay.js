// Display helpers for whole-ship heat readouts. The detailed combat panels
// derive the percentage from the same stored/capacity numbers shown beside it
// (ship.heatNow / ship.heatMax) so the panel can never show "0%" next to a
// non-zero stored amount. The server's ship.heat stays available as a compact
// convenience value only.

import { COMPONENT_HEAT_VALUE } from "./componentHeatSnapshot.js";

// Overheated ships can store slightly more than capacity; cap the derived
// percentage so runaway values cannot stretch progress bars indefinitely.
export const SHIP_HEAT_PERCENT_CAP = 125;

export function shipHeatPercent(ship) {
  const stored = Math.max(0, Number(ship?.heatNow) || 0);
  const capacity = Math.max(0, Number(ship?.heatMax) || 0);
  if (capacity <= 0) return 0;
  return Math.min(SHIP_HEAT_PERCENT_CAP, (stored / capacity) * 100);
}

// 0 -> "0%", 0.04 -> "<0.1%", 0.32 -> "0.3%", 3.46 -> "3.5%", 42.1 -> "42%".
// Small non-zero heat is never rounded down to a fake "0%", and no fake
// minimum such as "1%" is ever invented.
export function formatHeatPercent(value) {
  const percent = Math.max(0, Number(value) || 0);
  if (percent === 0) return "0%";
  if (percent < 0.1) return "<0.1%";
  if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(percent)}%`;
}

// Development diagnostic: the per-component heat tuples and the whole-ship
// stored total come from the same server simulation, so they must agree within
// network rounding tolerance. A larger gap means a display-staleness bug (old
// component tuples shown against a new summary) or a snapshot bug. This only
// reports — it never overwrites the authoritative snapshot data.
const consistencyWarnedAt = new Map();
const CONSISTENCY_WARN_INTERVAL_MS = 5000;

export function checkShipHeatConsistency(ship, warn = true) {
  const tuples = Array.isArray(ship?.componentHeat) ? ship.componentHeat : [];
  const componentCount = tuples.length;
  const hp = Array.isArray(ship?.chp) ? ship.chp : Array.isArray(ship?.componentHp) ? ship.componentHp : null;
  if (!hp && componentCount > 0) {
    return {
      ok: true,
      insufficientData: true,
      shipId: ship?.id,
      summaryTotal: Math.max(0, Number(ship?.heatNow) || 0),
      componentTotal: null,
      tolerance: null,
      difference: null,
      componentCount
    };
  }
  const summaryTotal = Math.max(0, Number(ship?.heatNow) || 0);
  let componentTotal = 0;
  let includedCount = 0;
  for (let i = 0; i < tuples.length; i += 1) {
    if (hp && !(Number(hp[i]) > 0)) continue;
    const tuple = tuples[i];
    componentTotal += Math.max(0, Number(tuple?.[COMPONENT_HEAT_VALUE]) || 0);
    includedCount += 1;
  }
  // Each component heat value is rounded to the nearest integer for network
  // transmission, so allow up to ~0.55 H of drift per component.
  const tolerance = Math.max(1, includedCount * 0.55);
  const difference = Math.abs(componentTotal - summaryTotal);
  const ok = componentCount === 0 || difference <= tolerance;
  if (!ok && warn) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const lastWarn = consistencyWarnedAt.get(ship?.id) || -Infinity;
    if (now - lastWarn >= CONSISTENCY_WARN_INTERVAL_MS) {
      consistencyWarnedAt.set(ship?.id, now);
      console.warn(
        `[heat] ship ${ship?.id}: summary stored heat ${summaryTotal} H does not match component total ` +
        `${componentTotal} H (tolerance ${tolerance} H) — heat readout may be stale`
      );
    }
  }
  return { ok, insufficientData: false, shipId: ship?.id, summaryTotal, componentTotal, tolerance, difference, componentCount, includedCount };
}
