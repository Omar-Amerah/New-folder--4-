import { COMPONENT_HEAT_VALUE, normalizeComponentHeatTuple } from "../shared/componentHeatSnapshot.js";

const ALPHA = 0.35;
const ENTER = 0.5;
const EXIT = 0.25;
const MAX_GAP_MS = 3000;
let contextKey = "";
let entries = new Map();
let lastSignature = "";

function dirFor(rate, previous = "unknown") {
  if (previous === "warming" && rate > EXIT) return "warming";
  if (previous === "cooling" && rate < -EXIT) return "cooling";
  if (rate > ENTER) return "warming";
  if (rate < -ENTER) return "cooling";
  return "stable";
}

export function resetComponentHeatTrends() { entries = new Map(); lastSignature = ""; contextKey = ""; }

export function updateComponentHeatTrends(ship, snapshotTime, room = "") {
  const designLen = ship?.design?.length || 0;
  const key = `${room}|${ship?.id || ""}|${designLen}`;
  const signature = `${key}|${snapshotTime}`;
  if (!ship || !Array.isArray(ship.componentHeat) || !Number.isFinite(snapshotTime)) return entries;
  if (key !== contextKey) { entries = new Map(); contextKey = key; }
  if (signature === lastSignature) return entries;
  lastSignature = signature;
  for (let i = 0; i < designLen; i += 1) {
    const tuple = normalizeComponentHeatTuple(ship.componentHeat[i]);
    const heat = Math.max(0, Number(tuple?.[COMPONENT_HEAT_VALUE]) || 0);
    const prev = entries.get(i);
    if (!prev || snapshotTime <= prev.previousSnapshotTime || snapshotTime - prev.previousSnapshotTime > MAX_GAP_MS) {
      entries.set(i, { previousHeat: heat, previousSnapshotTime: snapshotTime, rawRate: 0, smoothedRate: 0, direction: "unknown" });
      continue;
    }
    const elapsedSeconds = (snapshotTime - prev.previousSnapshotTime) / 1000;
    const rawRate = elapsedSeconds > 0 ? (heat - prev.previousHeat) / elapsedSeconds : 0;
    const safeRaw = Number.isFinite(rawRate) && Math.abs(rawRate) < 10000 ? rawRate : 0;
    const smoothedRate = prev.smoothedRate + ALPHA * (safeRaw - prev.smoothedRate);
    entries.set(i, { previousHeat: heat, previousSnapshotTime: snapshotTime, rawRate: safeRaw, smoothedRate, direction: dirFor(smoothedRate, prev.direction) });
  }
  for (const idx of [...entries.keys()]) if (idx >= designLen) entries.delete(idx);
  return entries;
}

export function componentHeatTrend(index) { return entries.get(index) || { rawRate: 0, smoothedRate: 0, direction: "unknown" }; }
export function heatTrendThreshold() { return ENTER; }
