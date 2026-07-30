// Authoritative projectile lifecycle replication for PROJECTILE_EVENT_REPLICATION.
//
// This module owns the server-side lifecycle log, per-client delivery cursors and
// visible projectile sets.  It does not perform gameplay collision or damage; it
// only records authoritative spawn/remove/correction state and builds the
// per-client, per-snapshot payload when the feature is enabled.
//
// Delivery discipline:
//   - buildClientBatch() NEVER mutates client._projectile.
//   - It returns a delivery descriptor that carries the desired end state.
//   - applyClientProjectiles() writes only to the snapshot; it stores the
//     delivery descriptor in client._projectile.pendingDelivery.
//   - snapshotDelivery calls markProjectilesWritten() only when the socket
//     actually writes the frame.  That is the only place client state advances.

"use strict";

const { round, performanceNow } = require("./utils");
const { PROJECTILE_EVENT_REPLICATION } = require("./performanceFlags");
const {
  usesSensorVisibility,
  ensureTeamVisibility,
  canTeamSeeEntity,
  isPointVisibleToTeam,
  normalizedTeamId,
  teamOfEntity
} = require("./visibility");

const PROJECTILE_EVENTS_CAPABILITY = "projectileEventsV1";

const DEFAULTS = Object.freeze({
  maxLifecycleLog: 8192,
  maxPerClientBacklog: 4096,
  maxEventBatch: 512,
  maxPermittedSeqGap: 1024,
  missileCorrectionIntervalMs: 100,
  guidedCorrectionIntervalMs: 100,
  maxVisibleProjectileCacheMs: 100
});

const LIFECYCLE_EVENT_TYPES = Object.freeze([
  "projectileSpawn",
  "projectileRemove",
  "projectileHide",
  "projectileCorrection"
]);

const REMOVE_REASONS = Object.freeze([
  "impact",
  "intercepted",
  "expired",
  "boundary",
  "despawn",
  "ownerRemoved",
  "roomReset"
]);

function isEventReplicationEnabled() {
  return PROJECTILE_EVENT_REPLICATION();
}

function clientSupportsProjectileEvents(client) {
  return PROJECTILE_EVENT_REPLICATION()
    && Array.isArray(client?.protocol?.capabilities)
    && client.protocol.capabilities.includes(PROJECTILE_EVENTS_CAPABILITY);
}

function ensureReplication(room) {
  if (room && room.projectileReplication) return room.projectileReplication;
  if (!room) return null;
  const rep = {
    initialized: true,
    stateEpoch: room.stateEpoch || 1,
    nextEventSeq: 0,
    nextCorrectionSeq: 0,
    log: [],
    corrections: new Map(),
    _correctionsPreparedAt: -1,
    _visibleByTeam: new Map(),
    _visibleAt: -1,
    diagnostics: {
      projectileLifecycleEventsCreated: 0,
      projectileSpawnEventsCreated: 0,
      projectileRemoveEventsCreated: 0,
      projectileHideEventsCreated: 0,
      projectileCorrectionRecordsCreated: 0,
      projectileEventBatchesWritten: 0,
      projectileEventBytesWritten: 0,
      projectileCorrectionBytesWritten: 0,
      projectileFullBaselineBytes: 0,
      projectileFallbackSnapshotBytes: 0,
      lifecycleLogSize: 0,
      lifecycleLogHighWaterMark: 0,
      maximumClientProjectileBacklog: 0,
      lifecycleEventsRepeatedBeforeWrite: 0,
      lifecycleEventsPruned: 0,
      projectileBaselinePromotions: 0,
      staleProjectileEventsIgnored: 0,
      staleProjectileCorrectionsIgnored: 0,
      unknownProjectileCorrections: 0,
      projectileResurrectionPrevented: 0,
      projectileVisibilitySpawns: 0,
      projectileVisibilityHides: 0
    }
  };
  room.projectileReplication = rep;
  room.projectileEventsV1 = { enabled: isEventReplicationEnabled() };
  return rep;
}

function initializeClient(client, room, fullBaseline = false) {
  if (!client || !room) return;
  const rep = ensureReplication(room);
  client._projectile = {
    stateEpoch: rep.stateEpoch,
    eventCursor: rep.nextEventSeq,
    correctionCursor: 0,
    knownVisible: new Set(),
    pendingDelivery: null,
    needsFullBaseline: fullBaseline
  };
}

function resetProjectileReplication(room, newEpoch) {
  if (!room) return;
  const rep = ensureReplication(room);
  rep.stateEpoch = Number.isInteger(newEpoch) ? newEpoch : (room.stateEpoch || 1);
  rep.nextEventSeq = 0;
  rep.nextCorrectionSeq = 0;
  rep.log.length = 0;
  rep.corrections = new Map();
  rep._correctionsPreparedAt = -1;
  rep._visibleByTeam = new Map();
  rep._visibleAt = -1;
  rep.diagnostics.lifecycleLogSize = 0;
  rep.diagnostics.lifecycleLogHighWaterMark = 0;
  if (room.clients) {
    for (const client of room.clients) {
      initializeClient(client, room, true);
    }
  }
}

function closeProjectileReplication(room) {
  if (!room) return;
  if (room.projectileReplication) {
    room.projectileReplication.log.length = 0;
    room.projectileReplication = null;
  }
  if (room.clients) {
    for (const client of room.clients) {
      if (client._projectile) client._projectile = null;
    }
  }
}

function promoteAllClientsForLog(room, reason, firstSeqToKeep) {
  if (!room?.clients) return;
  for (const client of room.clients) {
    if (!client._projectile) continue;
    if (!clientSupportsProjectileEvents(client)) continue;
    if (client._projectile.eventCursor < (firstSeqToKeep ?? Infinity)) {
      client._projectile.needsFullBaseline = true;
      client._projectile.eventCursor = room.projectileReplication?.nextEventSeq ?? 0;
      room.projectileReplication.diagnostics.projectileBaselinePromotions += 1;
    }
  }
}

function pruneLogIfNeeded(room) {
  const rep = room?.projectileReplication;
  if (!rep) return;
  const max = DEFAULTS.maxLifecycleLog;
  const over = rep.log.length - max;
  if (over <= 0) {
    rep.diagnostics.lifecycleLogSize = rep.log.length;
    return;
  }

  // Conservative pass: drop only records every connected capable client has
  // already passed.
  let minCursor = Infinity;
  if (room.clients) {
    for (const client of room.clients) {
      if (!clientSupportsProjectileEvents(client)) continue;
      const cursor = client._projectile?.eventCursor ?? rep.nextEventSeq;
      if (cursor < minCursor) minCursor = cursor;
    }
  }
  if (!Number.isFinite(minCursor)) minCursor = rep.nextEventSeq;

  let pruned = 0;
  while (rep.log.length > 0 && rep.log[0].projectileEventSeq < minCursor) {
    rep.log.shift();
    pruned += 1;
    if (rep.log.length <= max) break;
  }

  // If the log is still above the hard cap, promote lagging clients to a full
  // baseline BEFORE any records are lost.
  if (rep.log.length > max) {
    const first = rep.log[0]?.projectileEventSeq ?? rep.nextEventSeq;
    promoteAllClientsForLog(room, "log-prune", first);
  }

  // Last-resort hard cap: only after all clients have been promoted can we
  // splice.  If they are still lagging, the promotion above set their cursor
  // past the prune window.
  if (rep.log.length > max * 2) {
    const first = rep.log[0]?.projectileEventSeq ?? 0;
    promoteAllClientsForLog(room, "hard-cap", first);
    const toDrop = rep.log.length - max;
    rep.log.splice(0, toDrop);
    rep.diagnostics.lifecycleEventsPruned += toDrop;
    rep.diagnostics.lifecycleLogHighWaterMark = Math.max(rep.diagnostics.lifecycleLogHighWaterMark, rep.log.length);
  } else {
    rep.diagnostics.lifecycleEventsPruned += pruned;
    rep.diagnostics.lifecycleLogHighWaterMark = Math.max(rep.diagnostics.lifecycleLogHighWaterMark, rep.log.length);
  }
  rep.diagnostics.lifecycleLogSize = rep.log.length;
}

function recordProjectileSpawn(room, bullet, now) {
  if (!isEventReplicationEnabled() || !room || !bullet) return;
  const rep = ensureReplication(room);
  if (bullet._replicationSpawned) return;
  if (rep.stateEpoch !== (room.stateEpoch || 1)) {
    resetProjectileReplication(room, room.stateEpoch || 1);
  }
  rep.nextEventSeq += 1;
  const seq = rep.nextEventSeq;
  const simMs = Math.floor(Number.isFinite(now) ? now : performanceNow());
  const age = Number.isFinite(bullet.bornAt) ? Math.max(0, (simMs - bullet.bornAt) / 1000) : 0;
  const remaining = Number.isFinite(bullet.life) ? round(bullet.life) : 0;
  const event = {
    type: "projectileSpawn",
    stateEpoch: rep.stateEpoch,
    projectileEventSeq: seq,
    simulationTimeMs: simMs,
    _visibleTeams: computeVisibleTeams(room, bullet, simMs),
    projectile: {
      id: bullet.id,
      ownerId: bullet.ownerId || null,
      type: bullet.type,
      subtype: bullet.subtype,
      x: round(bullet.x),
      y: round(bullet.y),
      vx: round(bullet.vx),
      vy: round(bullet.vy),
      age: round(age),
      remainingLife: remaining
    }
  };
  if (Number.isFinite(bullet.angle)) event.projectile.angle = round(bullet.angle);
  rep.log.push(event);
  rep.diagnostics.projectileLifecycleEventsCreated += 1;
  rep.diagnostics.projectileSpawnEventsCreated += 1;
  bullet._replicationSpawned = true;
  bullet._replicationRemoveSeq = null;
  bullet._replicationSpawnSeq = seq;
  bullet._lastCorrectionAt = simMs;
  pruneLogIfNeeded(room);
}

function validateRemoveReason(reason) {
  if (REMOVE_REASONS.includes(reason)) return reason;
  return "despawn";
}

function activeTeamIds(room) {
  const ids = new Set();
  if (room?.players) {
    for (const player of room.players.values()) {
      ids.add(normalizedTeamId(room, player.team ?? player.id));
    }
  }
  if (room?.teams) {
    for (const team of room.teams) {
      ids.add(normalizedTeamId(room, team));
    }
  }
  return ids;
}

function computeVisibleTeams(room, bullet, now) {
  const visible = new Set();
  if (!bullet) return visible;
  const ownTeam = teamOfEntity(room, bullet);
  if (ownTeam) visible.add(ownTeam);
  if (!usesSensorVisibility(room)) {
    for (const teamId of activeTeamIds(room)) visible.add(teamId);
    return visible;
  }
  const padding = Number(bullet.radius) || 0;
  for (const teamId of activeTeamIds(room)) {
    if (teamId === ownTeam) continue;
    if (isPointVisibleToTeam(room, teamId, bullet.x, bullet.y, now, padding)) {
      visible.add(teamId);
    }
  }
  return visible;
}

function recordProjectileRemove(room, bullet, reason, now, finalX, finalY) {
  if (!isEventReplicationEnabled() || !room || !bullet) return;
  const rep = ensureReplication(room);
  if (bullet._replicationRemoveSeq) return;
  if (!bullet._replicationSpawned) return;
  if (rep.stateEpoch !== (room.stateEpoch || 1)) {
    resetProjectileReplication(room, room.stateEpoch || 1);
    return;
  }
  rep.nextEventSeq += 1;
  bullet.life = 0;
  const seq = rep.nextEventSeq;
  const simMs = Math.floor(Number.isFinite(now) ? now : performanceNow());
  const x = Number.isFinite(finalX) ? round(finalX) : round(bullet.x);
  const y = Number.isFinite(finalY) ? round(finalY) : round(bullet.y);
  const pointBullet = { ...bullet, x, y };
  rep.log.push({
    type: "projectileRemove",
    stateEpoch: rep.stateEpoch,
    projectileEventSeq: seq,
    simulationTimeMs: simMs,
    _visibleTeams: computeVisibleTeams(room, pointBullet, simMs),
    projectileId: bullet.id,
    reason: validateRemoveReason(reason),
    x,
    y
  });
  rep.diagnostics.projectileLifecycleEventsCreated += 1;
  rep.diagnostics.projectileRemoveEventsCreated += 1;
  bullet._replicationRemoveSeq = seq;
  pruneLogIfNeeded(room);
}

function recordProjectileReason(bullet, reason, finalX, finalY) {
  if (!bullet) return;
  bullet._removeReason = reason;
  if (Number.isFinite(finalX)) bullet._removeX = finalX;
  if (Number.isFinite(finalY)) bullet._removeY = finalY;
}

function getClientProjectileState(client, room) {
  if (!client || !room) return null;
  if (!client._projectile) initializeClient(client, room, true);
  return client._projectile;
}

function viewerTeamId(room, client) {
  if (!client?.player) return null;
  return normalizedTeamId(room, client.player.team ?? client.player.id);
}

function getTeamVisibleProjectiles(room, teamId, now) {
  const rep = ensureReplication(room);
  if (rep._visibleAt !== now) {
    rep._visibleAt = now;
    rep._visibleByTeam.clear();
  }
  if (rep._visibleByTeam.has(teamId)) {
    return rep._visibleByTeam.get(teamId);
  }

  if (!usesSensorVisibility(room)) {
    const visible = new Set();
    for (const bullet of room.bullets || []) {
      if (bullet?.life > 0 && bullet?.id) visible.add(bullet.id);
    }
    rep._visibleByTeam.set(teamId, visible);
    return visible;
  }

  ensureTeamVisibility(room, teamId, now);
  const visible = new Set();
  for (const bullet of room.bullets || []) {
    if (bullet?.life <= 0 || !bullet?.id) continue;
    if (canTeamSeeEntity(room, teamId, bullet, now)) {
      visible.add(bullet.id);
    }
  }
  rep._visibleByTeam.set(teamId, visible);
  return visible;
}

function visibleProjectilesForClient(room, client, now) {
  const teamId = viewerTeamId(room, client);
  if (!teamId) return new Set();
  return getTeamVisibleProjectiles(room, teamId, now);
}

function buildVisibleBaseline(room, client, now, visible = null) {
  const vis = visible || visibleProjectilesForClient(room, client, now);
  const simMs = Math.floor(Number.isFinite(now) ? now : performanceNow());
  const bullets = [];
  const lookup = room.projectileById;
  for (const id of vis) {
    const bullet = lookup?.get?.(id);
    if (!bullet || bullet.life <= 0) continue;
    const age = Number.isFinite(bullet.bornAt) ? Math.max(0, (simMs - bullet.bornAt) / 1000) : 0;
    const entry = {
      id,
      ownerId: bullet.ownerId || null,
      type: bullet.type,
      subtype: bullet.subtype,
      x: round(bullet.x),
      y: round(bullet.y),
      vx: round(bullet.vx),
      vy: round(bullet.vy),
      age: round(age),
      remainingLife: round(bullet.life)
    };
    if (Number.isFinite(bullet.angle)) entry.angle = round(bullet.angle);
    bullets.push(entry);
  }
  return bullets;
}

function bulletSnapshot(projectileId, room, now) {
  const bullet = room.projectileById?.get?.(projectileId);
  if (!bullet || bullet.life <= 0) return null;
  const simMs = Math.floor(Number.isFinite(now) ? now : performanceNow());
  const age = Number.isFinite(bullet.bornAt) ? Math.max(0, (simMs - bullet.bornAt) / 1000) : 0;
  const entry = {
    id: projectileId,
    ownerId: bullet.ownerId || null,
    type: bullet.type,
    subtype: bullet.subtype,
    x: round(bullet.x),
    y: round(bullet.y),
    vx: round(bullet.vx),
    vy: round(bullet.vy),
    age: round(age),
    remainingLife: round(bullet.life)
  };
  if (Number.isFinite(bullet.angle)) entry.angle = round(bullet.angle);
  return entry;
}

function buildCorrectionFor(bullet, rep, simMs) {
  const age = Number.isFinite(bullet.bornAt) ? Math.max(0, (simMs - bullet.bornAt) / 1000) : 0;
  rep.nextCorrectionSeq += 1;
  return {
    type: "projectileCorrection",
    stateEpoch: rep.stateEpoch,
    correctionSeq: rep.nextCorrectionSeq,
    simulationTimeMs: simMs,
    projectileId: bullet.id,
    x: round(bullet.x),
    y: round(bullet.y),
    vx: round(bullet.vx),
    vy: round(bullet.vy),
    age: round(age),
    remainingLife: round(bullet.life)
  };
}

function shouldCorrect(bullet, now) {
  if (!bullet) return false;
  if (bullet.type === "missile" || bullet.type === "torpedo") {
    return now - (bullet._lastCorrectionAt || 0) >= DEFAULTS.missileCorrectionIntervalMs;
  }
  if (bullet.type === "flak" || bullet.type === "pdShot" || bullet.type === "bolt" || bullet.type === "rail") {
    return false;
  }
  return now - (bullet._lastCorrectionAt || 0) >= DEFAULTS.guidedCorrectionIntervalMs;
}

function prepareRoomCorrections(room, now) {
  const rep = ensureReplication(room);
  if (rep._correctionsPreparedAt === now) return;
  rep._correctionsPreparedAt = now;
  rep.corrections = new Map();
  const simMs = Math.floor(now);
  for (const bullet of room.bullets || []) {
    if (!bullet || bullet.life <= 0) continue;
    if (shouldCorrect(bullet, now)) {
      bullet._lastCorrectionAt = now;
      rep.corrections.set(bullet.id, buildCorrectionFor(bullet, rep, simMs));
      rep.diagnostics.projectileCorrectionRecordsCreated += 1;
    }
  }
}

function buildClientBatch(room, client, now, fullBaseline) {
  if (!room || !client) {
    return { events: [], knownVisible: new Set(), bullets: [], delivery: null };
  }
  const rep = ensureReplication(room);
  const ps = getClientProjectileState(client, room);
  const baseEventSeq = ps.eventCursor;
  const baseCorrectionSeq = ps.correctionCursor;
  const baseKnown = ps.knownVisible;

  if (ps.stateEpoch !== rep.stateEpoch) {
    // State changed; a full baseline is required.  Do not mutate client state.
    return {
      events: [],
      knownVisible: new Set(),
      bullets: [],
      delivery: null,
      needsFullBaseline: true,
      baseEventSeq,
      baseCorrectionSeq
    };
  }

  if (fullBaseline) {
    const visible = visibleProjectilesForClient(room, client, now);
    const bullets = buildVisibleBaseline(room, client, now, visible);
    const known = new Set(visible);
    const delivery = {
      stateEpoch: rep.stateEpoch,
      eventSeq: rep.nextEventSeq,
      correctionSeq: rep.nextCorrectionSeq,
      knownVisible: known,
      needsFullBaseline: false
    };
    rep.diagnostics.projectileFullBaselineBytes += JSON.stringify(bullets).length;
    return {
      events: [],
      knownVisible: known,
      bullets,
      delivery,
      baseEventSeq: 0,
      newEventSeq: rep.nextEventSeq,
      baseCorrectionSeq: 0,
      newCorrectionSeq: rep.nextCorrectionSeq
    };
  }

  const visible = visibleProjectilesForClient(room, client, now);
  const teamId = viewerTeamId(room, client);
  const simMs = Math.floor(now);
  const events = [];
  const projectedKnown = new Set(baseKnown);
  let scannedEventSeq = baseEventSeq;
  let newEventSeq = baseEventSeq;
  let newCorrectionSeq = baseCorrectionSeq;

  function pushWire(event) {
    const wire = { ...event };
    delete wire._visibleTeams;
    events.push(wire);
  }

  // Replay lifecycle records the client has not yet acknowledged.
  if (baseEventSeq < rep.nextEventSeq) {
    for (const event of rep.log) {
      if (event.projectileEventSeq <= baseEventSeq) continue;
      if (event.projectileEventSeq > rep.nextEventSeq) break;
      if (event.stateEpoch !== rep.stateEpoch) continue;
      scannedEventSeq = event.projectileEventSeq;
      if (event.type === "projectileSpawn") {
        const id = event.projectile?.id;
        if (id && !projectedKnown.has(id) && event._visibleTeams?.has(teamId)) {
          pushWire(event);
          projectedKnown.add(id);
          newEventSeq = Math.max(newEventSeq, event.projectileEventSeq);
        }
      } else if (event.type === "projectileRemove") {
        if (projectedKnown.has(event.projectileId)) {
          pushWire(event);
          projectedKnown.delete(event.projectileId);
          newEventSeq = Math.max(newEventSeq, event.projectileEventSeq);
        }
      }
    }
  }

  // Synthesise visibility transitions from the projected known set.
  const gained = [];
  const lost = [];
  for (const id of visible) {
    if (!projectedKnown.has(id)) gained.push(id);
  }
  for (const id of projectedKnown) {
    if (!visible.has(id)) {
      const bullet = room.projectileById?.get?.(id);
      if (bullet && bullet.life > 0) lost.push(id);
    }
  }

  for (const id of gained) {
    const current = bulletSnapshot(id, room, now);
    if (!current) continue;
    rep.nextEventSeq += 1;
    const seq = rep.nextEventSeq;
    events.push({
      type: "projectileSpawn",
      stateEpoch: rep.stateEpoch,
      projectileEventSeq: seq,
      simulationTimeMs: simMs,
      projectile: current
    });
    projectedKnown.add(id);
    newEventSeq = Math.max(newEventSeq, seq);
    rep.diagnostics.projectileVisibilitySpawns += 1;
    rep.diagnostics.projectileLifecycleEventsCreated += 1;
    rep.diagnostics.projectileSpawnEventsCreated += 1;
  }

  for (const id of lost) {
    if (!projectedKnown.has(id)) continue;
    rep.nextEventSeq += 1;
    const seq = rep.nextEventSeq;
    events.push({
      type: "projectileHide",
      stateEpoch: rep.stateEpoch,
      projectileEventSeq: seq,
      simulationTimeMs: simMs,
      projectileId: id
    });
    projectedKnown.delete(id);
    newEventSeq = Math.max(newEventSeq, seq);
    rep.diagnostics.projectileVisibilityHides += 1;
    rep.diagnostics.projectileLifecycleEventsCreated += 1;
    rep.diagnostics.projectileHideEventsCreated += 1;
  }

  // Append corrections that are relevant to this client.  They were generated
  // once per room update in prepareRoomCorrections().
  for (const id of visible) {
    if (!projectedKnown.has(id)) continue;
    const c = rep.corrections.get(id);
    if (!c) continue;
    events.push(c);
    newCorrectionSeq = Math.max(newCorrectionSeq, c.correctionSeq);
  }

  // The client must advance through every sequence that has been examined,
  // even when none of the records are relevant to this viewer.
  newEventSeq = Math.max(newEventSeq, scannedEventSeq);

  const newKnown = projectedKnown;

  // If the backlog is too large for one frame, promote to a full baseline
  // rather than silently truncating events.  A full baseline carries the
  // complete current visible set and resets the client cursor.
  if (events.length > DEFAULTS.maxEventBatch) {
    return {
      events: [],
      knownVisible: newKnown,
      bullets: [],
      delivery: null,
      needsFullBaseline: true,
      baseEventSeq,
      baseCorrectionSeq
    };
  }

  const delivery = {
    stateEpoch: rep.stateEpoch,
    eventSeq: newEventSeq,
    correctionSeq: newCorrectionSeq,
    knownVisible: newKnown,
    needsFullBaseline: false
  };

  return {
    events,
    knownVisible: newKnown,
    bullets: [],
    delivery,
    baseEventSeq,
    newEventSeq,
    baseCorrectionSeq,
    newCorrectionSeq
  };
}

function applyClientProjectiles(room, client, now, sendStatic, snapshot) {
  if (!room || !client || !snapshot) return null;
  if (!isEventReplicationEnabled() || !clientSupportsProjectileEvents(client)) return null;
  const rep = ensureReplication(room);
  const ps = getClientProjectileState(client, room);

  // If a previous pending delivery never wrote, the client is still at the
  // old cursors.  We replace the stale pending descriptor with this one.
  ps.pendingDelivery = null;

  prepareRoomCorrections(room, now);

  let fullBaseline = ps.needsFullBaseline || sendStatic;
  let batch = buildClientBatch(room, client, now, fullBaseline);

  if (batch.needsFullBaseline) {
    fullBaseline = true;
    ps.needsFullBaseline = true;
    batch = buildClientBatch(room, client, now, true);
    // Do not clear needsFullBaseline here; markProjectilesWritten() will
    // update it once the full-baseline frame has actually been delivered.
  }

  snapshot.projectileStateEpoch = rep.stateEpoch;
  snapshot.projectileSimulationTimeMs = Math.floor(now);
  snapshot.projectileEventBaseSeq = fullBaseline ? 0 : batch.baseEventSeq;
  snapshot.projectileEventSeq = fullBaseline ? rep.nextEventSeq : batch.newEventSeq;
  snapshot.projectileCorrectionBaseSeq = fullBaseline ? 0 : batch.baseCorrectionSeq;
  snapshot.projectileCorrectionSeq = fullBaseline ? rep.nextCorrectionSeq : batch.newCorrectionSeq;

  if (fullBaseline) {
    snapshot.bullets = batch.bullets;
    snapshot.projectileEvents = [];
    rep.diagnostics.projectileFullBaselineBytes += JSON.stringify(batch.bullets).length;
  } else {
    snapshot.bullets = [];
    snapshot.projectileEvents = batch.events;
    rep.diagnostics.projectileEventBatchesWritten += 1;
    for (const ev of batch.events) {
      rep.diagnostics.projectileEventBytesWritten += JSON.stringify(ev).length;
      if (ev.type === "projectileCorrection") {
        rep.diagnostics.projectileCorrectionBytesWritten += JSON.stringify(ev).length;
      }
    }
  }

  if (batch.delivery) {
    setPendingDelivery(client, room, batch.delivery);
  }

  return batch.delivery;
}

function markProjectilesWritten(client, room, delivery) {
  if (!client || !delivery || !room) return;
  const ps = client._projectile;
  if (!ps) return;
  ps.stateEpoch = delivery.stateEpoch;
  ps.eventCursor = delivery.eventSeq;
  ps.correctionCursor = delivery.correctionSeq;
  if (delivery.knownVisible instanceof Set) ps.knownVisible = delivery.knownVisible;
  ps.needsFullBaseline = delivery.needsFullBaseline || false;
  ps.pendingDelivery = null;
}

function markProjectilesReplaced(client) {
  if (!client?._projectile) return;
  client._projectile.pendingDelivery = null;
  // Do not advance cursors; a replaced frame is equivalent to never having
  // been sent.  If the pending delivery was a full-baseline recovery request,
  // leave needsFullBaseline true.
}

function setPendingDelivery(client, room, delivery) {
  if (!client || !delivery) return;
  if (!client._projectile) initializeClient(client, room, false);
  client._projectile.pendingDelivery = delivery;
}

function getProjectileReplicationDiagnostics(room) {
  const rep = room?.projectileReplication;
  return rep ? { ...rep.diagnostics } : {};
}

function getLogSize(room) {
  return room?.projectileReplication?.log?.length || 0;
}

function getClientProjectileSignature(client) {
  if (!client?._projectile) return "none";
  const ps = client._projectile;
  const known = [...(ps.knownVisible || new Set())].sort().join(",");
  return `${ps.stateEpoch}:${ps.eventCursor}:${ps.correctionCursor}:${ps.needsFullBaseline ? 1 : 0}:${known}`;
}

module.exports = {
  PROJECTILE_EVENTS_CAPABILITY,
  LIFECYCLE_EVENT_TYPES,
  REMOVE_REASONS,
  DEFAULTS,
  isEventReplicationEnabled,
  clientSupportsProjectileEvents,
  ensureReplication,
  initializeClient,
  resetProjectileReplication,
  closeProjectileReplication,
  recordProjectileSpawn,
  recordProjectileRemove,
  recordProjectileReason,
  applyClientProjectiles,
  buildClientBatch,
  buildVisibleBaseline,
  visibleProjectilesForClient,
  markProjectilesWritten,
  markProjectilesReplaced,
  setPendingDelivery,
  getClientProjectileState,
  getProjectileReplicationDiagnostics,
  getLogSize,
  prepareRoomCorrections,
  getTeamVisibleProjectiles,
  getClientProjectileSignature
};
