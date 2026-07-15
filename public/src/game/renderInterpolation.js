// Authoritative snapshot render interpolation. Maintains bounded per-ship samples
// from accepted snapshots only and derives temporary visual transforms for Pixi.

import { state } from "../state.js";
import { angleDifference } from "../shared/math.js";

export const INTERPOLATION_DELAY_MS = 100;
export const EXTRAPOLATION_CAP_MS = 80;
const MAX_SAMPLES_PER_SHIP = 8;
const TELEPORT_DISTANCE = 900;

export function resetRenderHistory() {
  state.renderHistory = { epoch: state.snapshotNetwork?.stateEpoch || 0, latestSeq: 0, latestSimulationTimeMs: null, samples: new Map(), delayMs: INTERPOLATION_DELAY_MS, renderSimulationTimeMs: null };
  state.visualShips = new Map();
}
function history() { if (!state.renderHistory) resetRenderHistory(); return state.renderHistory; }

export function acceptSnapshotForRender(snapshot, receiveTime = performance.now()) {
  if (!snapshot) return;
  const epoch = Number(snapshot.stateEpoch ?? state.snapshotNetwork?.stateEpoch ?? 0);
  const seq = Number(snapshot.snapshotSeq ?? state.snapshotNetwork?.snapshotSeq ?? 0);
  const sim = Number(snapshot.simulationTimeMs ?? snapshot.simTimeMs ?? seq * 50);
  const h = history();
  if (h.epoch !== epoch || seq < h.latestSeq) resetRenderHistory();
  const hh = history(); hh.epoch = epoch; hh.latestSeq = Math.max(hh.latestSeq || 0, seq); hh.latestSimulationTimeMs = sim; hh.receiveTime = receiveTime;
  const liveIds = new Set();
  for (const ship of snapshot.ships || []) {
    liveIds.add(ship.id); if (ship.alive === false) { hh.samples.delete(ship.id); continue; }
    const sample = { stateEpoch: epoch, snapshotSeq: seq, simulationTimeMs: sim, receiveTime, id: ship.id, x: ship.x, y: ship.y, angle: ship.angle || 0, vx: ship.vx || 0, vy: ship.vy || 0 };
    const list = hh.samples.get(ship.id) || []; if (!list.length || seq > list[list.length - 1].snapshotSeq) list.push(sample);
    while (list.length > MAX_SAMPLES_PER_SHIP) list.shift(); hh.samples.set(ship.id, list);
  }
  for (const id of [...hh.samples.keys()]) if (!liveIds.has(id)) hh.samples.delete(id);
}
function lerpSample(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: a.angle + angleDifference(a.angle, b.angle) * t }; }
export function visualForShip(ship, renderTimeMs) {
  const h = history(); const samples = h.samples.get(ship.id); if (!samples?.length || ship.alive === false) return null;
  if (samples.length === 1) return { x: samples[0].x, y: samples[0].y, angle: samples[0].angle };
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (renderTimeMs <= b.simulationTimeMs) {
      if (Math.hypot(b.x - a.x, b.y - a.y) > TELEPORT_DISTANCE) return renderTimeMs < b.simulationTimeMs ? { x: a.x, y: a.y, angle: a.angle } : { x: b.x, y: b.y, angle: b.angle };
      const span = Math.max(1, b.simulationTimeMs - a.simulationTimeMs);
      return lerpSample(a, b, Math.max(0, Math.min(1, (renderTimeMs - a.simulationTimeMs) / span)));
    }
  }
  const latest = samples[samples.length - 1];
  const extra = Math.max(0, Math.min(EXTRAPOLATION_CAP_MS, renderTimeMs - latest.simulationTimeMs));
  return { x: latest.x + latest.vx * extra / 1000, y: latest.y + latest.vy * extra / 1000, angle: latest.angle };
}
export function interpolateShips(dt, now) {
  const snap = state.snapshot; if (!snap) return;
  if (!state.renderHistory) acceptSnapshotForRender(snap, state.snapshotReceivedAt || now);
  const h = history(); const latest = h.latestSimulationTimeMs ?? Number(snap.simulationTimeMs ?? 0);
  const renderTime = latest - (h.delayMs ?? INTERPOLATION_DELAY_MS); h.renderSimulationTimeMs = renderTime;
  const visual = new Map();
  for (const ship of snap.ships || []) { const v = visualForShip(ship, renderTime); if (v) visual.set(ship.id, v); }
  state.visualShips = visual;
}
