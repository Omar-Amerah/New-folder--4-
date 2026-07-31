// Client-side authoritative projectile lifecycle store.
//
// This store consumes the lifecycle event stream produced by
// src/server/projectileReplication.js and presents a derived `bullets` array
// that the existing renderer can consume unchanged.

const VERSION = 1;

const MAX_TOMBSTONES = 4096;
const TOMBSTONE_WINDOW = 2048;
const TERMINAL_LIFETIME_MS = 300;

let store = {
  version: VERSION,
  stateEpoch: 0,
  projectileStateEpoch: 0,
  eventSeq: 0,
  correctionSeq: 0,
  hasBaseline: false,
  projectiles: new Map(),
  tombstones: new Map(),
  terminals: new Map()
};

function resetStore(stateEpoch, projectileStateEpoch) {
  store = {
    version: VERSION,
    stateEpoch: Number(stateEpoch) || 0,
    projectileStateEpoch: Number(projectileStateEpoch) || 0,
    eventSeq: 0,
    correctionSeq: 0,
    hasBaseline: false,
    projectiles: new Map(),
    tombstones: new Map(),
    terminals: new Map()
  };
}

function pruneTombstones() {
  if (store.tombstones.size <= MAX_TOMBSTONES) return;
  const floor = Math.max(0, store.eventSeq - TOMBSTONE_WINDOW);
  for (const [id, entry] of store.tombstones) {
    if (entry.seq < floor) store.tombstones.delete(id);
  }
}

function ensureEpoch(message) {
  const stateEpoch = Number(message?.stateEpoch) || 0;
  const projectileStateEpoch = Number(message?.projectileStateEpoch) || 0;
  if (stateEpoch !== store.stateEpoch || projectileStateEpoch !== store.projectileStateEpoch) {
    resetStore(stateEpoch, projectileStateEpoch);
  }
}

function isTombstoned(id, seq) {
  const t = store.tombstones.get(id);
  return t && (seq === undefined || seq <= t.seq);
}

function installProjectile(data, simulationTimeMs) {
  if (!data || !data.id) return;
  const existing = store.projectiles.get(data.id);
  const next = {
    id: data.id,
    type: data.type,
    subtype: data.subtype,
    ownerId: data.ownerId,
    x: data.x,
    y: data.y,
    vx: data.vx,
    vy: data.vy,
    age: data.age,
    remainingLife: data.remainingLife,
    angle: data.angle,
    simulationTimeMs: simulationTimeMs,
    correctionSeq: existing?.correctionSeq ?? 0
  };
  store.projectiles.set(data.id, next);
}

function applyEvent(event, message) {
  if (!event || event.stateEpoch !== store.projectileStateEpoch) return;
  const simMs = Number(event.simulationTimeMs) || Number(message.projectileSimulationTimeMs) || Number(message.simulationTimeMs) || 0;

  if (event.type === "projectileSpawn") {
    if (!isTombstoned(event.projectile?.id)) {
      installProjectile(event.projectile, simMs);
    }
  } else if (event.type === "projectileRemove") {
    const existing = store.projectiles.get(event.projectileId);
    if (existing) {
      const terminal = {
        id: existing.id,
        type: existing.type,
        subtype: existing.subtype,
        ownerId: existing.ownerId,
        angle: existing.angle,
        finalX: event.x,
        finalY: event.y,
        removeReason: event.reason,
        removedSimulationTimeMs: simMs
      };
      store.terminals.set(event.projectileId, terminal);
    }
    store.projectiles.delete(event.projectileId);
    const seq = Number(event.projectileEventSeq) || 0;
    const tombstone = store.tombstones.get(event.projectileId);
    if (!tombstone || seq > tombstone.seq) {
      store.tombstones.set(event.projectileId, { seq, simulationTimeMs: simMs });
    }
  } else if (event.type === "projectileHide") {
    store.projectiles.delete(event.projectileId);
  } else if (event.type === "projectileCorrection") {
    if (event.correctionSeq === undefined) return;
    const existing = store.projectiles.get(event.projectileId);
    if (!existing || isTombstoned(event.projectileId)) return;
    if (event.correctionSeq < existing.correctionSeq) return;
    if (event.stateEpoch !== store.projectileStateEpoch) return;
    existing.x = event.x;
    existing.y = event.y;
    existing.vx = event.vx;
    existing.vy = event.vy;
    existing.age = event.age;
    existing.remainingLife = event.remainingLife;
    existing.correctionSeq = event.correctionSeq;
    existing.simulationTimeMs = simMs;
  }
}

function applyBaseline(message) {
  const bullets = message.bullets || [];
  store.projectiles = new Map();
  store.tombstones = new Map();
  store.terminals = new Map();
  for (const b of bullets) {
    installProjectile(b, Number(message.projectileSimulationTimeMs) || Number(message.simulationTimeMs) || 0);
  }
  store.eventSeq = Number(message.projectileEventSeq) || 0;
  store.correctionSeq = Number(message.projectileCorrectionSeq) || 0;
  store.hasBaseline = true;
}

function applyEvents(message) {
  const events = message.projectileEvents || [];
  if (!Array.isArray(events)) return { ok: false, reason: "projectile-sequence-gap" };

  // The server tells us the range of event sequences this frame covers.
  // If it does not start exactly where we left off, we have missed events
  // and must wait for a full baseline instead of applying a partial batch.
  const base = Number(message.projectileEventBaseSeq) || 0;
  const end = Number(message.projectileEventSeq) || 0;
  const baseCorrection = Number(message.projectileCorrectionBaseSeq) || 0;
  const endCorrection = Number(message.projectileCorrectionSeq) || 0;

  if (base !== store.eventSeq) {
    // Sequence gap: drop the partial batch and request a reset via the next full.
    store.hasBaseline = false;
    return { ok: false, reason: "projectile-sequence-gap" };
  }
  if (endCorrection > 0 && baseCorrection !== store.correctionSeq) {
    store.hasBaseline = false;
    return { ok: false, reason: "projectile-sequence-gap" };
  }

  for (const ev of events) {
    applyEvent(ev, message);
    if (ev.projectileEventSeq !== undefined) store.eventSeq = Math.max(store.eventSeq, ev.projectileEventSeq);
  }
  store.eventSeq = Math.max(store.eventSeq, end);
  store.correctionSeq = Math.max(store.correctionSeq, endCorrection);
  pruneTombstones();
  return { ok: true };
}

export function applySnapshotToProjectiles(message) {
  if (!message || message.type !== "state") return { ok: true };
  ensureEpoch(message);

  if (message.snapshotKind === "full" || message.projectileBaseline) {
    applyBaseline(message);
    return { ok: true };
  } else if (message.projectileEvents !== undefined) {
    if (!store.hasBaseline) return { ok: false, reason: "projectile-sequence-gap" };
    const result = applyEvents(message);
    if (!result.ok) store.hasBaseline = false;
    return result;
  } else {
    // Fallback: compact snapshot still carries the complete bullet list.
    applyBaseline(message);
    return { ok: true };
  }
}

export function getProjectilesForRender(now = null) {
  const out = [];
  const useNow = Number.isFinite(now);
  for (const p of store.projectiles.values()) {
    const render = {
      id: p.id,
      type: p.type,
      subtype: p.subtype,
      ownerId: p.ownerId,
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      age: p.age,
      remainingLife: p.remainingLife,
      simulationTimeMs: p.simulationTimeMs
    };
    if (p.angle !== undefined) render.angle = p.angle;
    out.push(render);
  }

  const expired = [];
  for (const [id, t] of store.terminals) {
    const removed = Number(t.removedSimulationTimeMs) || 0;
    if (useNow && now > removed + TERMINAL_LIFETIME_MS) {
      expired.push(id);
      continue;
    }
    out.push({
      id: t.id,
      terminal: true,
      type: t.type,
      subtype: t.subtype,
      ownerId: t.ownerId,
      x: t.finalX,
      y: t.finalY,
      vx: 0,
      vy: 0,
      age: 0,
      remainingLife: 0,
      removeReason: t.removeReason,
      simulationTimeMs: removed
    });
  }
  for (const id of expired) store.terminals.delete(id);

  return out;
}

export function getProjectileStoreState() {
  return {
    stateEpoch: store.stateEpoch,
    projectileStateEpoch: store.projectileStateEpoch,
    eventSeq: store.eventSeq,
    correctionSeq: store.correctionSeq,
    hasBaseline: store.hasBaseline,
    count: store.projectiles.size,
    tombstones: store.tombstones.size,
    terminals: store.terminals.size
  };
}
