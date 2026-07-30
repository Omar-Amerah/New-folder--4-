// Client-side authoritative projectile lifecycle store.
//
// This store consumes the lifecycle event stream produced by
// src/server/projectileReplication.js and presents a derived `bullets` array
// that the existing renderer can consume unchanged.

const VERSION = 1;

let store = {
  version: VERSION,
  stateEpoch: 0,
  projectileStateEpoch: 0,
  eventSeq: 0,
  correctionSeq: 0,
  hasBaseline: false,
  projectiles: new Map(),
  tombstones: new Map()
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
    tombstones: new Map()
  };
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
    store.projectiles.delete(event.projectileId);
    const seq = Number(event.projectileEventSeq) || 0;
    const existing = store.tombstones.get(event.projectileId);
    if (!existing || seq > existing.seq) {
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
  for (const b of bullets) {
    installProjectile(b, Number(message.projectileSimulationTimeMs) || Number(message.simulationTimeMs) || 0);
  }
  store.eventSeq = Number(message.projectileEventSeq) || 0;
  store.correctionSeq = Number(message.projectileCorrectionSeq) || 0;
  store.hasBaseline = true;
}

function applyEvents(message) {
  const events = message.projectileEvents;
  if (!Array.isArray(events) || events.length === 0) return;
  for (const ev of events) {
    if (ev.projectileEventSeq !== undefined && ev.projectileEventSeq <= store.eventSeq) continue;
    applyEvent(ev, message);
    if (ev.projectileEventSeq !== undefined) store.eventSeq = Math.max(store.eventSeq, ev.projectileEventSeq);
  }
  if (message.projectileCorrectionSeq !== undefined) {
    store.correctionSeq = Math.max(store.correctionSeq, Number(message.projectileCorrectionSeq));
  }
}

export function applySnapshotToProjectiles(message) {
  if (!message || message.type !== "state") return;
  ensureEpoch(message);

  if (message.snapshotKind === "full") {
    applyBaseline(message);
  } else if (message.projectileEvents !== undefined) {
    if (!store.hasBaseline) return; // Ignore events until a full baseline arrives.
    applyEvents(message);
  } else {
    // Fallback: compact snapshot still carries the complete bullet list.
    applyBaseline(message);
  }
}

export function getProjectilesForRender() {
  const out = [];
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
      remainingLife: p.remainingLife
    };
    if (p.angle !== undefined) render.angle = p.angle;
    out.push(render);
  }
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
    tombstones: store.tombstones.size
  };
}
