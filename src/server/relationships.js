"use strict";

const MAX_RELATIONSHIP_ENTRIES = 4096;

function invalidateRelationshipCache(room) {
  if (!room) return;
  room.relationshipRevision = (Number(room.relationshipRevision) || 0) + 1;
  room._relationshipCache?.clear?.();
}

function relationship(room, ownerA, ownerB) {
  if (ownerA === ownerB) return { allies: true, enemies: false };
  const players = room?.players;
  if (!players) return { allies: false, enemies: false };
  const mode = room.rules?.gameMode === "solo" ? "solo" : "teams";
  const a = players.get(ownerA);
  const b = players.get(ownerB);
  if (!a || !b) return { allies: false, enemies: false };

  const cache = room._relationshipCache || (room._relationshipCache = new Map());
  if (cache.size > MAX_RELATIONSHIP_ENTRIES) cache.clear();
  const first = String(ownerA) <= String(ownerB) ? ownerA : ownerB;
  const second = first === ownerA ? ownerB : ownerA;
  let row = cache.get(first);
  if (!row) {
    row = new Map();
    cache.set(first, row);
  }
  const revision = Number(room.relationshipRevision) || 0;
  const cached = row.get(second);
  if (cached
    && cached.revision === revision
    && cached.mode === mode
    && cached.a === a
    && cached.b === b
    && cached.teamA === a.team
    && cached.teamB === b.team
    && cached.removedA === Boolean(a.removed)
    && cached.removedB === Boolean(b.removed)) {
    return cached.result;
  }

  const active = !a.removed && !b.removed;
  const result = mode === "solo"
    ? { allies: false, enemies: active }
    : { allies: active && a.team === b.team, enemies: active && a.team !== b.team };
  row.set(second, {
    revision,
    mode,
    a,
    b,
    teamA: a.team,
    teamB: b.team,
    removedA: Boolean(a.removed),
    removedB: Boolean(b.removed),
    result
  });
  return result;
}

function areAllies(room, ownerA, ownerB) {
  return relationship(room, ownerA, ownerB).allies;
}

function areEnemies(room, ownerA, ownerB) {
  return relationship(room, ownerA, ownerB).enemies;
}

module.exports = { invalidateRelationshipCache, relationship, areAllies, areEnemies };
