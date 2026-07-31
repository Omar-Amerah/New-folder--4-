// Client-side authoritative projectile lifecycle store.
//
// This store consumes the lifecycle event stream produced by
// src/server/projectileReplication.js and presents a derived `bullets` array
// that the existing renderer can consume unchanged.

const VERSION = 1;

const MAX_TOMBSTONES = 4096;
const TOMBSTONE_WINDOW = 2048;
const TERMINAL_TRAVEL_MIN_MS = 25;
const TERMINAL_TRAVEL_MAX_MS = 120;
const TERMINAL_BULLET_FADE_MS = 180;
const TERMINAL_MISSILE_FADE_MS = 300;
const CORRECTION_BLEND_TIME = 0.05; // seconds
const CORRECTION_SNAP_DISTANCE = 500;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

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
  const isMissile = data.type === "missile";
  let visual = null;
  let visualUpdatedAt = simulationTimeMs;
  if (existing && existing.type === "missile" && existing.visual) {
    visual = existing.visual;
    visualUpdatedAt = existing.visualUpdatedAt ?? simulationTimeMs;
  } else if (isMissile) {
    visual = {
      x: data.x,
      y: data.y,
      vx: data.vx,
      vy: data.vy,
      targetX: data.x,
      targetY: data.y,
      targetVx: data.vx,
      targetVy: data.vy
    };
  }
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
  if (isMissile) {
    next.visual = visual;
    next.visualUpdatedAt = visualUpdatedAt;
  }
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
      const isMissile = existing.type === "missile";
      const fromX = (isMissile && existing.visual) ? existing.visual.x : existing.x;
      const fromY = (isMissile && existing.visual) ? existing.visual.y : existing.y;
      const terminal = {
        id: existing.id,
        type: existing.type,
        subtype: existing.subtype,
        ownerId: existing.ownerId,
        angle: existing.angle,
        fromX,
        fromY,
        speed: Math.hypot(existing.vx, existing.vy),
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
    if (existing.type === "missile" && existing.visual) {
      existing.visual.targetX = event.x;
      existing.visual.targetY = event.y;
      existing.visual.targetVx = event.vx;
      existing.visual.targetVy = event.vy;
    }
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
    const dt = (useNow && Number.isFinite(p.simulationTimeMs)) ? Math.max(0, (now - p.simulationTimeMs) / 1000) : 0;
    const isMissile = p.type === "missile";
    let x = p.x;
    let y = p.y;
    let vx = p.vx;
    let vy = p.vy;
    if (isMissile && p.visual) {
      const v = p.visual;
      const vdt = (useNow && Number.isFinite(p.visualUpdatedAt)) ? Math.max(0, (now - p.visualUpdatedAt) / 1000) : 0;
      if (vdt > 0) {
        const error = Math.hypot(v.targetX - v.x, v.targetY - v.y);
        if (error > CORRECTION_SNAP_DISTANCE) {
          v.x = v.targetX;
          v.y = v.targetY;
          v.vx = v.targetVx;
          v.vy = v.targetVy;
        } else {
          const blend = 1 - Math.exp(-vdt / CORRECTION_BLEND_TIME);
          v.x += v.vx * vdt;
          v.y += v.vy * vdt;
          v.x += (v.targetX - v.x) * blend;
          v.y += (v.targetY - v.y) * blend;
          v.vx += (v.targetVx - v.vx) * blend;
          v.vy += (v.targetVy - v.vy) * blend;
        }
        p.visualUpdatedAt = now;
      }
      x = v.x;
      y = v.y;
      vx = v.vx;
      vy = v.vy;
    } else {
      x += p.vx * dt;
      y += p.vy * dt;
    }
    const render = {
      id: p.id,
      type: p.type,
      subtype: p.subtype,
      ownerId: p.ownerId,
      x,
      y,
      vx,
      vy,
      age: p.age + dt,
      remainingLife: Math.max(0, p.remainingLife - dt),
      simulationTimeMs: p.simulationTimeMs
    };
    if (!isMissile && p.angle !== undefined) render.angle = p.angle;
    out.push(render);
  }

  const expired = [];
  for (const [id, t] of store.terminals) {
    const removed = Number(t.removedSimulationTimeMs) || 0;
    const age = useNow ? Math.max(0, now - removed) : 0;
    const dx = t.finalX - t.fromX;
    const dy = t.finalY - t.fromY;
    const distance = Math.hypot(dx, dy);
    const speed = Math.max(0.001, t.speed);
    const travelDurationMs = clamp((distance / speed) * 1000, TERMINAL_TRAVEL_MIN_MS, TERMINAL_TRAVEL_MAX_MS);
    const fadeDurationMs = t.type === "missile" ? TERMINAL_MISSILE_FADE_MS : TERMINAL_BULLET_FADE_MS;
    const totalMs = travelDurationMs + fadeDurationMs;
    if (useNow && age > totalMs) {
      expired.push(id);
      continue;
    }
    if (age < travelDurationMs) {
      const progress = travelDurationMs > 0 ? age / travelDurationMs : 1;
      const x = t.fromX + dx * progress;
      const y = t.fromY + dy * progress;
      const terminalVx = travelDurationMs > 0 ? dx / (travelDurationMs / 1000) : 0;
      const terminalVy = travelDurationMs > 0 ? dy / (travelDurationMs / 1000) : 0;
      const body = {
        id: t.id,
        terminal: true,
        phase: 1,
        type: t.type,
        subtype: t.subtype,
        ownerId: t.ownerId,
        x,
        y,
        vx: terminalVx,
        vy: terminalVy,
        age: age / 1000,
        remainingLife: 0,
        removeReason: t.removeReason,
        simulationTimeMs: removed
      };
      if (t.type !== "missile" && t.angle !== undefined) body.angle = t.angle;
      out.push(body);
    } else {
      const fade = age - travelDurationMs;
      const impactFade = Math.max(0, 1 - fade / fadeDurationMs);
      const flash = {
        id: t.id,
        terminal: true,
        phase: 2,
        type: t.type,
        subtype: t.subtype,
        ownerId: t.ownerId,
        x: t.finalX,
        y: t.finalY,
        vx: 0,
        vy: 0,
        age: age / 1000,
        remainingLife: 0,
        removeReason: t.removeReason,
        impactFade,
        simulationTimeMs: removed
      };
      out.push(flash);
    }
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
