import { COMPONENT_HEAT_DELTA_STRIDE, componentHeatTupleFromDelta, normalizeComponentHeatTuple } from "./shared/componentHeatSnapshot.js";

export const SNAPSHOT_REJECTION = Object.freeze({
  STALE_EPOCH: "stale-epoch",
  STALE_SEQUENCE: "stale-sequence",
  DUPLICATE_SEQUENCE: "duplicate-sequence",
  MISSING_BASELINE: "missing-baseline",
  SEQUENCE_GAP: "sequence-gap",
  WRONG_BASE: "wrong-base",
  STATIC_REVISION_MISMATCH: "static-revision-mismatch",
  MALFORMED_DELTA: "malformed-delta",
  INCOMPATIBLE_SNAPSHOT: "incompatible-snapshot"
});

function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function isNullish(value) { return value === undefined || value === null; }

export function mergeStaticPlayerFields(previousPlayers, nextPlayers) {
  if (!Array.isArray(previousPlayers) || !Array.isArray(nextPlayers)) return nextPlayers;
  const oldPlayers = new Map(previousPlayers.map((p) => [p.id, p]));
  return nextPlayers.map((player) => {
    const oldPlayer = oldPlayers.get(player.id);
    if (!oldPlayer) return player;
    const merged = { ...oldPlayer, ...player };
    for (const key of ["design", "stats", "name", "team", "colour", "color"]) {
      if (isNullish(merged[key])) merged[key] = oldPlayer[key];
    }
    return merged;
  });
}

export function validateComponentHpDelta(previousHp, delta) {
  if (!Array.isArray(previousHp)) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE };
  if (!Array.isArray(delta) || delta.length === 0) return { ok: true };
  if (delta.length % 2 !== 0) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
  let last = -1;
  const seen = new Set();
  for (let k = 0; k < delta.length; k += 2) {
    const index = Number(delta[k]);
    const hp = Number(delta[k + 1]);
    if (!Number.isInteger(index) || index < 0 || index >= previousHp.length || !Number.isFinite(hp)) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    if (seen.has(index) || index <= last) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    seen.add(index); last = index;
  }
  return { ok: true };
}

export function applyComponentHpDelta(previousHp, delta) {
  const valid = validateComponentHpDelta(previousHp, delta);
  if (!valid.ok) return undefined;
  if (!Array.isArray(delta) || delta.length === 0) return previousHp;
  const merged = previousHp.slice();
  for (let k = 0; k < delta.length; k += 2) merged[Number(delta[k])] = Number(delta[k + 1]);
  return merged;
}

export function normalizeComponentHeatSnapshot(componentHeat) {
  if (!Array.isArray(componentHeat)) return componentHeat;
  return componentHeat.map((entry) => normalizeComponentHeatTuple(entry) || [0, 0, 0, 0]);
}

export function validateComponentHeatDelta(previousHeat, delta) {
  if (!Array.isArray(previousHeat)) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE };
  if (!Array.isArray(delta) || delta.length === 0) return { ok: true };
  if (delta.length % COMPONENT_HEAT_DELTA_STRIDE !== 0) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
  let last = -1;
  const seen = new Set();
  for (let k = 0; k < delta.length; k += COMPONENT_HEAT_DELTA_STRIDE) {
    const update = componentHeatTupleFromDelta(delta, k);
    if (!update || update.index >= previousHeat.length) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    if (seen.has(update.index) || update.index <= last) return { ok: false, reason: SNAPSHOT_REJECTION.MALFORMED_DELTA };
    seen.add(update.index); last = update.index;
  }
  return { ok: true };
}

export function applyComponentHeatDelta(previousHeat, delta) {
  const valid = validateComponentHeatDelta(previousHeat, delta);
  if (!valid.ok) return undefined;
  if (!Array.isArray(delta) || delta.length === 0) return previousHeat;
  const merged = previousHeat.map((value) => Array.isArray(value) ? value.slice() : value);
  for (let k = 0; k < delta.length; k += COMPONENT_HEAT_DELTA_STRIDE) {
    const update = componentHeatTupleFromDelta(delta, k);
    merged[update.index] = update.tuple;
  }
  return merged;
}

export function mergeCachedShipFields(previousShips, nextShips) {
  if (!Array.isArray(previousShips) || !Array.isArray(nextShips)) return nextShips;
  const oldShips = new Map(previousShips.map((ship) => [ship.id, ship]));
  return nextShips.map((ship) => {
    const oldShip = oldShips.get(ship.id);
    if (!oldShip) return { ...ship, componentHeat: normalizeComponentHeatSnapshot(ship.componentHeat) };
    const merged = { ...ship };
    if (isNullish(merged.design)) merged.design = oldShip.design;
    for (const key of ["componentPower", "powerStatus", "powerRevision", "wiringRevision", "wiringStatus"]) {
      if (isNullish(merged[key])) merged[key] = clone(oldShip[key]);
    }
    if (isNullish(merged.chp)) {
      const hp = applyComponentHpDelta(oldShip.chp, merged.chpD);
      if (hp !== undefined) merged.chp = hp;
    }
    if (!isNullish(merged.componentHeat)) merged.componentHeat = normalizeComponentHeatSnapshot(merged.componentHeat);
    else {
      const heat = applyComponentHeatDelta(oldShip.componentHeat, merged.componentHeatD);
      if (heat !== undefined) merged.componentHeat = heat;
    }
    return merged;
  });
}

export function inspectSnapshotEnvelope(networkState, message) {
  const diagnostic = {
    snapshotSeq: message?.snapshotSeq,
    baseSnapshotSeq: message?.baseSnapshotSeq,
    snapshotKind: message?.snapshotKind,
    shipId: null,
    designMissing: false,
    componentHpBaselineMissing: false,
    componentHeatBaselineMissing: false
  };
  if (!message || message.type !== "state") return { ok: false, reason: SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, ...diagnostic };
  const epoch = Number(message.stateEpoch), seq = Number(message.snapshotSeq);
  if (!Number.isInteger(epoch) || epoch < 1 || !Number.isInteger(seq) || seq < 1) return { ok: false, reason: SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, ...diagnostic };
  const currentEpoch = Number(networkState?.stateEpoch) || 0;
  const currentSeq = Number(networkState?.snapshotSeq) || 0;
  if (epoch < currentEpoch) return { ok: false, reason: SNAPSHOT_REJECTION.STALE_EPOCH, ...diagnostic };
  if (epoch === currentEpoch && seq < currentSeq) return { ok: false, reason: SNAPSHOT_REJECTION.STALE_SEQUENCE, ...diagnostic };
  if (epoch === currentEpoch && seq === currentSeq) return { ok: false, reason: SNAPSHOT_REJECTION.DUPLICATE_SEQUENCE, ...diagnostic };
  if (message.snapshotKind === "full") return { ok: true, kind: "full" };
  if (message.snapshotKind !== "compact") return { ok: false, reason: SNAPSHOT_REJECTION.INCOMPATIBLE_SNAPSHOT, ...diagnostic };
  if (epoch > currentEpoch || !networkState?.hasFullBaseline) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE, ...diagnostic };
  if (seq !== currentSeq + 1) return { ok: false, reason: SNAPSHOT_REJECTION.SEQUENCE_GAP, ...diagnostic };
  if (Number(message.baseSnapshotSeq) !== currentSeq) return { ok: false, reason: SNAPSHOT_REJECTION.WRONG_BASE, ...diagnostic };
  if (message.staticRevision !== undefined && networkState.staticRevision !== undefined && Number(message.staticRevision) !== Number(networkState.staticRevision)) return { ok: false, reason: SNAPSHOT_REJECTION.STATIC_REVISION_MISMATCH, ...diagnostic };
  return { ok: true, kind: "compact" };
}

function validateShipDeltas(previous, message) {
  const oldShips = new Map((previous?.ships || []).map((ship) => [ship.id, ship]));
  for (const ship of message.ships || []) {
    const old = oldShips.get(ship.id);
    if (!old && (ship.chpD || ship.componentHeatD || isNullish(ship.design))) return { ok: false, reason: SNAPSHOT_REJECTION.MISSING_BASELINE, snapshotSeq: message.snapshotSeq, baseSnapshotSeq: message.baseSnapshotSeq, snapshotKind: message.snapshotKind, shipId: ship.id, designMissing: isNullish(ship.design), componentHpBaselineMissing: Boolean(ship.chpD), componentHeatBaselineMissing: Boolean(ship.componentHeatD) };
    if (ship.chpD) { const r = validateComponentHpDelta(old?.chp, ship.chpD); if (!r.ok) return { ...r, snapshotSeq: message.snapshotSeq, baseSnapshotSeq: message.baseSnapshotSeq, snapshotKind: message.snapshotKind, shipId: ship.id, designMissing: false, componentHpBaselineMissing: !Array.isArray(old?.chp), componentHeatBaselineMissing: false }; }
    if (ship.componentHeatD) { const r = validateComponentHeatDelta(old?.componentHeat, ship.componentHeatD); if (!r.ok) return { ...r, snapshotSeq: message.snapshotSeq, baseSnapshotSeq: message.baseSnapshotSeq, snapshotKind: message.snapshotKind, shipId: ship.id, designMissing: false, componentHpBaselineMissing: false, componentHeatBaselineMissing: !Array.isArray(old?.componentHeat) }; }
  }
  return { ok: true };
}

export function mergeFullSnapshot(message) {
  const full = clone(message);
  full.players = Array.isArray(full.players) ? full.players : [];
  full.ships = Array.isArray(full.ships) ? full.ships.map((s) => ({ ...s, componentHeat: normalizeComponentHeatSnapshot(s.componentHeat) })) : [];
  return { ok: true, snapshot: full, networkState: { stateEpoch: full.stateEpoch, snapshotSeq: full.snapshotSeq, staticRevision: full.staticRevision, hasFullBaseline: true } };
}

export function mergeCompactSnapshot(previous, message) {
  const validation = validateShipDeltas(previous, message);
  if (!validation.ok) return validation;
  const next = clone(message);
  next.players = mergeStaticPlayerFields(previous.players, next.players || []);
  next.ships = mergeCachedShipFields(previous.ships, next.ships || []);
  for (const key of ["world", "map", "rules", "mapSizeLabel"]) if (isNullish(next[key])) next[key] = clone(previous[key]);
  return { ok: true, snapshot: next, networkState: { stateEpoch: next.stateEpoch, snapshotSeq: next.snapshotSeq, staticRevision: next.staticRevision, hasFullBaseline: true } };
}

export function mergeSnapshotTransaction(previous, networkState, message) {
  const envelope = inspectSnapshotEnvelope(networkState, message);
  if (!envelope.ok) return envelope;
  return envelope.kind === "full" ? mergeFullSnapshot(message) : mergeCompactSnapshot(previous, message);
}
