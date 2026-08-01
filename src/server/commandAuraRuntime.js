// Phase 6D incremental authoritative Command Aura runtime.
//
// This module owns only room-local cache state. Aura formulas and deterministic
// priority rules live in commandAuraRules.js and are shared with the legacy
// commandAuras.js rebuild.

"use strict";

const { performanceNow } = require("./utils");
const { areAllies } = require("./relationships");
const { BALANCE_REVISION } = require("./balanceConfig");
const { shipBroadPhaseRadius } = require("./spatialIndex");
const { bump, setCounter, recordDuration } = require("./roomTelemetry");
const {
  AURA_TYPES,
  getCommandAuraRange,
  commandAuraSelfAllowed,
  getAuraComponentIndices,
  auraForComponent,
  buildAuraSourceValues,
  compareSourceForRecipient,
  formatAuraReceivedEntry,
  addAuraMultipliers,
  shipSequenceNumber
} = require("./commandAuraRules");

const RECONCILIATION_INTERVAL = 32;
const MOVEMENT_EPSILON = 0.001;
const MEMBERSHIP_SEPARATOR = "\u0000";

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function telemetry(room) {
  const current = room?._commandAuraTelemetry || (room._commandAuraTelemetry = {});
  const fields = [
    "activeSources", "activeSourceShips", "receivingShips", "candidatesExamined", "recalculations", "lastUpdateUs", "additions", "removals",
    "sourceCacheHits", "sourceRebuilds", "sourceActivations", "sourceDeactivations", "membershipQueries", "membershipCacheHits", "membershipAdds", "membershipRemoves",
    "candidatesVisited", "recipientMovesProcessed", "sourceMovesProcessed", "recipientsDirty", "recipientsPublished", "recipientsUnchanged", "winnerChanges", "winnerRescans",
    "priorityComparisons", "sortsPerformed", "fullScanFallbacks", "reconciliations", "reconciliationRepairs", "staleSourcesRemoved", "staleRecipientsRemoved",
    "fallbackUs", "sourceMaintenanceUs", "membershipUs", "winnerResolutionUs", "recipientPublishUs", "reconciliationUs"
  ];
  for (const field of fields) if (!Number.isFinite(current[field])) current[field] = 0;
  return current;
}

function resetTelemetry(room) {
  const current = telemetry(room);
  for (const field of Object.keys(current)) current[field] = 0;
  return current;
}

function createRuntime(room) {
  const range = getCommandAuraRange();
  return {
    stateEpoch: Number(room?.stateEpoch) || 1,
    sourcesByShipId: new Map(),
    sourcesByAuraType: new Map([...AURA_TYPES].map((type) => [type, new Map()])),
    sourceRecordsByKey: new Map(),
    sourceGroupsByShipId: new Map(),
    recipientsBySourceKey: new Map(),
    sourcesByRecipientId: new Map(),
    recipientShipsById: new Map(),
    winnerByRecipientAndType: new Map(),
    dirtySourceShips: new Set(),
    dirtyRecipientShips: new Set(),
    dirtyWinnerKeys: new Set(),
    removedSourceKeys: [],
    sourceRevision: 0,
    membershipRevision: 0,
    resultRevision: 0,
    spatialGeneration: -1,
    relationshipRevision: Number(room?.relationshipRevision) || 0,
    configKey: `${BALANCE_REVISION}:${range}:${commandAuraSelfAllowed() ? 1 : 0}`,
    lastProcessedAt: 0,
    generation: 0,
    reconciliationGeneration: 0,
    bootstrapped: false,
    fullInvalidation: false,
    candidateScratch: [],
    membershipCandidateIds: new Set(),
    nearbySourceGroupIds: new Set(),
    knownSourceGroupIds: new Set(),
    currentLiveIds: new Set(),
    movedRecipientIds: new Set(),
    explicitMovedIds: new Set(),
    sourceKeyScratch: new Set(),
    liveShips: null,
    metrics: null
  };
}

function clearStateReferences(state) {
  if (!state) return;
  for (const group of state.sourceGroupsByShipId.values()) {
    group.ship = null;
    group.members.clear();
    group.sourceKeys.clear();
    group.activeKeys.clear();
  }
  for (const source of state.sourceRecordsByKey.values()) source.ship = null;
  for (const ship of state.recipientShipsById.values()) {
    // The public result is cleared by clearCommandAuraRuntime before this
    // function is called. This loop only releases the runtime's references.
    void ship;
  }
  state.sourcesByShipId.clear();
  state.sourcesByAuraType.clear();
  state.sourceRecordsByKey.clear();
  state.sourceGroupsByShipId.clear();
  state.recipientsBySourceKey.clear();
  state.sourcesByRecipientId.clear();
  state.recipientShipsById.clear();
  state.winnerByRecipientAndType.clear();
  state.dirtySourceShips.clear();
  state.dirtyRecipientShips.clear();
  state.dirtyWinnerKeys.clear();
  state.removedSourceKeys.length = 0;
  state.candidateScratch.length = 0;
  state.membershipCandidateIds.clear();
  state.nearbySourceGroupIds.clear();
  state.knownSourceGroupIds.clear();
  state.currentLiveIds.clear();
  state.movedRecipientIds.clear();
  state.explicitMovedIds.clear();
  state.sourceKeyScratch.clear();
  state.transformsByShipId?.clear?.();
  state.liveShips = null;
}

function ensureRuntime(room) {
  if (!room) return null;
  const epoch = Number(room.stateEpoch) || 1;
  let state = room._commandAuraRuntime;
  if (state && state.stateEpoch === epoch) return state;
  if (state) {
    // A caller may advance stateEpoch directly (the normal room reset path
    // calls clearCommandAuraRuntime first). Do not leave the previous epoch's
    // public result visible until the replacement cache publishes.
    for (const ship of room.ships?.values?.() || []) clearPublishedResult(ship);
    clearStateReferences(state);
  }
  state = createRuntime(room);
  room._commandAuraRuntime = state;
  return state;
}

function sourceGroupFor(state, shipId) {
  return state.sourceGroupsByShipId.get(String(shipId));
}

function winnerKey(recipientId, type) {
  return `${String(recipientId)}${MEMBERSHIP_SEPARATOR}${type}`;
}

function ensureWinnerEntry(state, recipientId, type) {
  const key = winnerKey(recipientId, type);
  let entry = state.winnerByRecipientAndType.get(key);
  if (!entry) {
    entry = {
      key,
      recipientId: String(recipientId),
      type,
      winnerSourceKey: null,
      winnerPriority: null,
      sourceCount: 0,
      dirty: false
    };
    state.winnerByRecipientAndType.set(key, entry);
  }
  return entry;
}

function markRecipientDirty(state, recipientId) {
  const id = String(recipientId);
  if (!state.dirtyRecipientShips.has(id)) {
    state.dirtyRecipientShips.add(id);
    state.metrics.recipientsDirty += 1;
  }
}

function updateWinnerPriority(entry, source, recipient) {
  if (!entry || !source || !recipient) return;
  const dx = source.x - finite(recipient.x);
  const dy = source.y - finite(recipient.y);
  if (!entry.winnerPriority) entry.winnerPriority = {};
  entry.winnerPriority.strength = source.strength;
  entry.winnerPriority.distanceSquared = dx * dx + dy * dy;
  entry.winnerPriority.shipSequence = source.sourceShipSequence;
  entry.winnerPriority.componentIndex = source.componentIndex;
}

function markWinnerDirty(state, recipientId, type) {
  const entry = ensureWinnerEntry(state, recipientId, type);
  entry.dirty = true;
  state.dirtyWinnerKeys.add(entry.key);
  markRecipientDirty(state, recipientId);
  return entry;
}

function noteWinnerChange(state, entry, nextKey) {
  if (entry.winnerSourceKey !== nextKey) {
    state.metrics.winnerChanges += 1;
    entry.winnerSourceKey = nextKey;
  }
}

function addMembership(state, group, recipient) {
  if (!group || !recipient || group.members.has(recipient.id)) return;
  group.members.add(recipient.id);
  state.membershipRevision += 1;
  state.metrics.membershipAdds += 1;
  for (const sourceKey of group.activeKeys) {
    const source = state.sourceRecordsByKey.get(sourceKey);
    if (!source?.active) continue;
    state.recipientsBySourceKey.set(sourceKey, group.members);
    let reverse = state.sourcesByRecipientId.get(recipient.id);
    if (!reverse) {
      reverse = new Set();
      state.sourcesByRecipientId.set(recipient.id, reverse);
    }
    if (reverse.has(sourceKey)) continue;
    reverse.add(sourceKey);
    const entry = ensureWinnerEntry(state, recipient.id, source.type);
    entry.sourceCount += 1;
    const current = entry.winnerSourceKey ? state.sourceRecordsByKey.get(entry.winnerSourceKey) : null;
    if (!current || compareCandidate(state, source, current, recipient) < 0) {
      noteWinnerChange(state, entry, sourceKey);
      updateWinnerPriority(entry, source, recipient);
    }
    entry.dirty = false;
    markRecipientDirty(state, recipient.id);
  }
}

function removeMembership(state, group, recipientId) {
  if (!group || !group.members.has(recipientId)) return;
  group.members.delete(recipientId);
  state.membershipRevision += 1;
  state.metrics.membershipRemoves += 1;
  const reverse = state.sourcesByRecipientId.get(recipientId);
  for (const sourceKey of group.activeKeys) {
    const source = state.sourceRecordsByKey.get(sourceKey);
    if (!source) continue;
    reverse?.delete(sourceKey);
    const entry = ensureWinnerEntry(state, recipientId, source.type);
    entry.sourceCount = Math.max(0, entry.sourceCount - 1);
    if (entry.winnerSourceKey === sourceKey) {
      entry.winnerSourceKey = null;
      entry.winnerPriority = null;
      markWinnerDirty(state, recipientId, source.type);
    } else {
      markRecipientDirty(state, recipientId);
    }
  }
  if (reverse && reverse.size === 0) state.sourcesByRecipientId.delete(recipientId);
}

function compareCandidate(state, candidate, current, recipient) {
  state.metrics.priorityComparisons += 1;
  return compareSourceForRecipient(candidate, current, finite(recipient.x), finite(recipient.y));
}

function registerActiveSource(state, source) {
  if (!source.active) return;
  state.sourcesByAuraType.get(source.type)?.set(source.key, source);
  const group = sourceGroupFor(state, source.shipId);
  if (!group) return;
  group.activeKeys.add(source.key);
  state.recipientsBySourceKey.set(source.key, group.members);
  for (const recipientId of group.members) {
    const recipient = state.recipientShipsById.get(recipientId);
    if (recipient) {
      // Add the newly active component to an already valid source-ship
      // membership without issuing another spatial query.
      const reverse = state.sourcesByRecipientId.get(recipientId) || new Set();
      state.sourcesByRecipientId.set(recipientId, reverse);
      if (reverse.has(source.key)) continue;
      reverse.add(source.key);
      const entry = ensureWinnerEntry(state, recipientId, source.type);
      entry.sourceCount += 1;
      const current = entry.winnerSourceKey ? state.sourceRecordsByKey.get(entry.winnerSourceKey) : null;
      if (!current || compareCandidate(state, source, current, recipient) < 0) {
        noteWinnerChange(state, entry, source.key);
        updateWinnerPriority(entry, source, recipient);
      }
      markRecipientDirty(state, recipientId);
    }
  }
}

function unregisterActiveSource(state, source) {
  if (!source.active) return;
  const group = sourceGroupFor(state, source.shipId);
  state.sourcesByAuraType.get(source.type)?.delete(source.key);
  for (const recipientId of [...(group?.members || [])]) {
    const reverse = state.sourcesByRecipientId.get(recipientId);
    reverse?.delete(source.key);
    const entry = ensureWinnerEntry(state, recipientId, source.type);
    entry.sourceCount = Math.max(0, entry.sourceCount - 1);
    if (entry.winnerSourceKey === source.key) {
      entry.winnerSourceKey = null;
      entry.winnerPriority = null;
      markWinnerDirty(state, recipientId, source.type);
    } else {
      markRecipientDirty(state, recipientId);
    }
    if (reverse && reverse.size === 0) state.sourcesByRecipientId.delete(recipientId);
  }
  state.recipientsBySourceKey.delete(source.key);
  group?.activeKeys.delete(source.key);
}

function removeSourceRecord(state, source) {
  if (!source) return;
  if (source.active) unregisterActiveSource(state, source);
  const group = sourceGroupFor(state, source.shipId);
  group?.sourceKeys.delete(source.key);
  state.sourceRecordsByKey.delete(source.key);
  state.sourcesByShipId.get(source.shipId)?.delete(source.key);
  state.removedSourceKeys.push(source.key);
  state.metrics.staleSourcesRemoved += 1;
  state.sourceRevision += 1;
}

function sourceCapabilityKey(ship, componentIndex, type) {
  const power = ship.componentPower?.byComponentIndex?.[componentIndex];
  const heatState = ship.componentHeatState?.[componentIndex];
  const hpAlive = (ship.componentHp?.[componentIndex] ?? 1) > 0 ? 1 : 0;
  return [
    type,
    ship.alive ? 1 : 0,
    hpAlive,
    Number(ship.componentAliveRevision) || 0,
    Number(ship.componentDamageRevision) || 0,
    Number(ship.powerRevision) || 0,
    Number(ship.powerFlowRevision) || 0,
    Number(ship.heatStateRevision) || 0,
    Number(ship.heatRevision) || 0,
    Number(ship.designRevision) || 1,
    Number(power?.operationalMultiplier) || 0,
    power?.state || "",
    heatState || "",
    BALANCE_REVISION
  ].join(":");
}

function makeSourceRecord(state, ship, componentIndex, type, capabilityRevision) {
  const key = `${ship.id}:${componentIndex}:${type}`;
  const values = buildAuraSourceValues(ship, componentIndex);
  return {
    key,
    ship,
    shipId: String(ship.id),
    componentIndex,
    type,
    multipliers: values?.multipliers || {},
    strength: values?.strength || 0,
    effectiveness: values?.effectiveness || 0,
    x: finite(ship.x),
    y: finite(ship.y),
    range: getCommandAuraRange(),
    rangeSquared: getCommandAuraRange() ** 2,
    sourceShipSequence: shipSequenceNumber(ship.id),
    capabilityRevision,
    transformRevision: 0,
    allegianceRevision: 0,
    active: Boolean(values),
    _registered: false
  };
}

function updateSourceCapability(state, source, ship, capabilityRevision) {
  const previousActive = source.active;
  const previousStrength = source.strength;
  const values = buildAuraSourceValues(ship, source.componentIndex);
  source.ship = ship;
  source.x = finite(ship.x);
  source.y = finite(ship.y);
  source.range = getCommandAuraRange();
  source.rangeSquared = source.range * source.range;
  source.capabilityRevision = capabilityRevision;
  source.multipliers = values?.multipliers || {};
  source.strength = values?.strength || 0;
  source.effectiveness = values?.effectiveness || 0;
  source.active = Boolean(values);
  state.sourceRevision += 1;
  state.metrics.sourceRebuilds += 1;

  if (previousActive !== source.active) {
    if (source.active) {
      state.metrics.sourceActivations += 1;
      registerActiveSource(state, source);
    } else {
      state.metrics.sourceDeactivations += 1;
      unregisterActiveSource(state, { ...source, active: true });
      // unregisterActiveSource receives a short-lived wrapper only to remove
      // the old active membership before the stable record becomes inactive.
      state.sourcesByAuraType.get(source.type)?.delete(source.key);
      state.recipientsBySourceKey.delete(source.key);
      sourceGroupFor(state, source.shipId)?.activeKeys.delete(source.key);
    }
  }

  const group = sourceGroupFor(state, source.shipId);
  if (previousActive && source.active) {
    // Capability-only changes never re-query spatial membership. The affected
    // recipients do receive a local winner refresh/publication pass.
    for (const recipientId of group?.members || []) {
      markWinnerDirty(state, recipientId, source.type);
      markRecipientDirty(state, recipientId);
    }
  }
  if (previousStrength !== source.strength && source.active && group?.members.size) {
    for (const recipientId of group.members) markWinnerDirty(state, recipientId, source.type);
  }
}

function createOrGetGroup(state, ship) {
  const id = String(ship.id);
  let group = state.sourceGroupsByShipId.get(id);
  if (!group || group.ship !== ship) {
    if (group) removeSourceGroup(state, group);
    group = {
      ship,
      shipId: id,
      sourceKeys: new Set(),
      activeKeys: new Set(),
      members: new Set(),
      x: finite(ship.x),
      y: finite(ship.y),
      ownerId: ship.ownerId,
      transformRevision: 0,
      dirty: true,
      transformDirty: true,
      allegianceDirty: true
    };
    state.sourceGroupsByShipId.set(id, group);
    state.sourcesByShipId.set(id, new Map());
  }
  return group;
}

function removeSourceGroup(state, group) {
  if (!group) return;
  for (const key of [...group.sourceKeys]) {
    const source = state.sourceRecordsByKey.get(key);
    if (source) removeSourceRecord(state, source);
  }
  for (const recipientId of [...group.members]) {
    const recipient = state.recipientShipsById.get(recipientId);
    if (recipient) removeMembership(state, group, recipientId);
  }
  group.ship && (group.ship.commandAuraActive = false);
  group.ship = null;
  state.sourceGroupsByShipId.delete(group.shipId);
  state.sourcesByShipId.delete(group.shipId);
}

function maintainSourcesAndRecipients(room, state, ships) {
  state.currentLiveIds.clear();
  state.movedRecipientIds.clear();
  state.liveShips = ships;
  const previousTransforms = state.transformsByShipId || (state.transformsByShipId = new Map());
  const currentRelationshipRevision = Number(room.relationshipRevision) || 0;

  for (const ship of ships || []) {
    if (!ship?.alive || ship.removed) continue;
    const id = String(ship.id);
    const wasKnownRecipient = state.recipientShipsById.has(id);
    state.currentLiveIds.add(id);
    const previous = previousTransforms.get(id);
    const explicitMove = state.explicitMovedIds.has(id);
    const moved = explicitMove || !previous || previous.ship !== ship
      || Math.abs(finite(previous.x) - finite(ship.x)) > MOVEMENT_EPSILON
      || Math.abs(finite(previous.y) - finite(ship.y)) > MOVEMENT_EPSILON;
    const allegianceChanged = !previous || previous.ownerId !== ship.ownerId;
    if (moved || !wasKnownRecipient) {
      state.movedRecipientIds.add(id);
      state.dirtyRecipientShips.add(id);
    }
    if (allegianceChanged) {
      state.dirtyRecipientShips.add(id);
      // A recipient owner change can alter its relationship to every cached
      // source group, including groups outside its previous membership. The
      // change is rare, so invalidate only the source-group membership layer
      // rather than throwing away source capability records and winners.
      for (const [sourceId, group] of state.sourceGroupsByShipId) {
        if (!group.activeKeys.size) continue;
        group.dirty = true;
        state.dirtySourceShips.add(sourceId);
      }
    }
    state.recipientShipsById.set(id, ship);
    previousTransforms.set(id, {
      ship,
      x: finite(ship.x),
      y: finite(ship.y),
      ownerId: ship.ownerId
    });

    const auraIndices = getAuraComponentIndices(ship);
    let group = state.sourceGroupsByShipId.get(id);
    if (!auraIndices.length) {
      if (group) removeSourceGroup(state, group);
      ship.commandAuraActive = false;
      continue;
    }
    const hadStableMembership = Boolean(group && !group.dirty && !group.transformDirty && group.activeKeys.size);
    group = createOrGetGroup(state, ship);
    const transformChanged = group.x !== finite(ship.x) || group.y !== finite(ship.y);
    if (transformChanged || explicitMove) {
      group.transformDirty = true;
      group.dirty = true;
      group.transformRevision += 1;
      state.dirtySourceShips.add(id);
    }
    if (group.ownerId !== ship.ownerId) {
      group.ownerId = ship.ownerId;
      group.allegianceDirty = true;
      group.dirty = true;
      state.dirtySourceShips.add(id);
    }
    group.ship = ship;
    group.x = finite(ship.x);
    group.y = finite(ship.y);
    state.sourceKeyScratch.clear();
    for (const componentIndex of auraIndices) {
      const aura = auraForComponent(ship, componentIndex);
      if (!aura) continue;
      const type = aura.type;
      const key = `${ship.id}:${componentIndex}:${type}`;
      state.sourceKeyScratch.add(key);
      const capabilityRevision = sourceCapabilityKey(ship, componentIndex, type);
      const sourcesForShip = state.sourcesByShipId.get(id);
      let source = sourcesForShip.get(key);
      if (!source) {
        source = makeSourceRecord(state, ship, componentIndex, type, capabilityRevision);
        sourcesForShip.set(key, source);
        state.sourceRecordsByKey.set(key, source);
        group.sourceKeys.add(key);
        if (source.active) {
          registerActiveSource(state, source);
          state.metrics.sourceActivations += 1;
          group.dirty = true;
          state.dirtySourceShips.add(id);
        }
        state.sourceRevision += 1;
        state.metrics.sourceRebuilds += 1;
      } else if (source.capabilityRevision === capabilityRevision) {
        state.metrics.sourceCacheHits += 1;
        source.ship = ship;
        source.x = finite(ship.x);
        source.y = finite(ship.y);
      } else {
        const wasActive = group.activeKeys.has(key);
        updateSourceCapability(state, source, ship, capabilityRevision);
        // Capability-only changes reuse the existing source-ship membership.
        // Only an operational-state transition needs a membership pass: an
        // activation may add a source to nearby recipients, while a
        // deactivation only removes already-known edges.
        if (source.active !== wasActive) {
          group.dirty = true;
          state.dirtySourceShips.add(id);
        }
      }
      source.x = finite(ship.x);
      source.y = finite(ship.y);
      source.transformRevision = group.transformRevision;
      source.allegianceRevision = currentRelationshipRevision;
    }

    for (const key of [...group.sourceKeys]) {
      if (state.sourceKeyScratch.has(key)) continue;
      const source = state.sourceRecordsByKey.get(key);
      if (source) removeSourceRecord(state, source);
    }
    ship.commandAuraActive = group.activeKeys.size > 0;
    if (hadStableMembership && group.activeKeys.size) state.metrics.membershipCacheHits += 1;
    if (group.dirty || group.transformDirty) state.dirtySourceShips.add(id);
  }

  for (const [id, group] of [...state.sourceGroupsByShipId]) {
    if (state.currentLiveIds.has(id)) continue;
    if (group.ship) group.ship.commandAuraActive = false;
    removeSourceGroup(state, group);
  }

  for (const [id, ship] of [...state.recipientShipsById]) {
    if (state.currentLiveIds.has(id)) continue;
    detachRecipient(state, id, ship);
    previousTransforms.delete(id);
    state.metrics.staleRecipientsRemoved += 1;
  }
}

function detachRecipient(state, recipientId, ship = null) {
  const id = String(recipientId);
  const reverse = state.sourcesByRecipientId.get(id);
  if (reverse) {
    for (const sourceKey of [...reverse]) {
      const source = state.sourceRecordsByKey.get(sourceKey);
      const group = sourceGroupFor(state, source?.shipId);
      if (group) removeMembership(state, group, id);
    }
  }
  state.sourcesByRecipientId.delete(id);
  state.recipientShipsById.delete(id);
  for (const type of AURA_TYPES) state.winnerByRecipientAndType.delete(winnerKey(id, type));
  state.dirtyRecipientShips.delete(id);
  if (ship) clearPublishedResult(ship);
}

function isSpatialIndexUsable(room) {
  const index = room?.spatialIndex;
  return Boolean(index?.queryRangeUnordered && index.dynamicValid !== false);
}

function consumeMovementNotifications(room, state) {
  state.explicitMovedIds.clear();
  const moved = room?._commandAuraMovedShipIds;
  if (moved instanceof Set) {
    for (const id of moved) state.explicitMovedIds.add(String(id));
    moved.clear();
  } else if (Array.isArray(moved)) {
    for (const id of moved) state.explicitMovedIds.add(String(id));
    moved.length = 0;
  }
}

function refreshMovedSpatialRecords(room, state) {
  const index = room?.spatialIndex;
  if (!isSpatialIndexUsable(room) || typeof index.update !== "function") return;
  for (const id of state.explicitMovedIds) {
    const ship = state.recipientShipsById.get(id) || room.ships?.get?.(id);
    if (ship?.alive && !ship.removed) index.update("ships", ship, shipBroadPhaseRadius(ship));
  }
  for (const id of state.movedRecipientIds) {
    if (state.explicitMovedIds.has(id)) continue;
    const ship = state.recipientShipsById.get(id);
    if (ship?.alive && !ship.removed) index.update("ships", ship, shipBroadPhaseRadius(ship));
  }
}

function queryCandidateShips(room, state, x, y, range) {
  const startedAt = performanceNow();
  const out = state.candidateScratch;
  out.length = 0;
  if (isSpatialIndexUsable(room)) {
    room.spatialIndex.queryRangeUnordered("ships", x, y, range, out);
  } else {
    if (state.metrics.fullScanFallbacks === 0) state.metrics.fallbackUs = 0;
    state.metrics.fullScanFallbacks += 1;
    for (const ship of state.liveShips || []) out.push(ship);
  }
  state.metrics.membershipQueries += 1;
  state.metrics.candidatesVisited += out.length;
  state.metrics.candidatesExamined += out.length;
  if (!isSpatialIndexUsable(room)) state.metrics.fallbackUs += performanceNow() - startedAt;
  return out;
}

function candidateBelongsToSourceGroup(room, sourceGroup, recipient, selfAllowed, rangeSquared) {
  if (!recipient?.alive || recipient.removed) return false;
  if (!selfAllowed && recipient.id === sourceGroup.shipId) return false;
  if (!areAllies(room, sourceGroup.ship.ownerId, recipient.ownerId)) return false;
  const dx = finite(recipient.x) - sourceGroup.x;
  const dy = finite(recipient.y) - sourceGroup.y;
  return dx * dx + dy * dy <= rangeSquared;
}

function refreshSourceGroupMembership(room, state, group, processedSourceGroups) {
  if (!group?.activeKeys.size) {
    for (const recipientId of [...group.members]) removeMembership(state, group, recipientId);
    group.dirty = false;
    group.transformDirty = false;
    return;
  }
  const range = getCommandAuraRange();
  const rangeSquared = range * range;
  const selfAllowed = commandAuraSelfAllowed();
  const desired = state.membershipCandidateIds;
  desired.clear();
  const candidates = queryCandidateShips(room, state, group.x, group.y, range);
  for (const target of candidates) {
    if (!candidateBelongsToSourceGroup(room, group, target, selfAllowed, rangeSquared)) continue;
    desired.add(String(target.id));
  }
  for (const recipientId of group.members) {
    if (desired.has(recipientId)) continue;
    const recipient = state.recipientShipsById.get(recipientId);
    if (recipient) removeMembership(state, group, recipientId);
  }
  for (const recipientId of desired) {
    if (group.members.has(recipientId)) continue;
    const recipient = state.recipientShipsById.get(recipientId);
    if (recipient) addMembership(state, group, recipient);
  }
  if (group.transformDirty || group.allegianceDirty) {
    for (const recipientId of group.members) {
      const recipient = state.recipientShipsById.get(recipientId);
      if (!recipient) continue;
      markRecipientDirty(state, recipientId);
      for (const sourceKey of group.activeKeys) {
        const source = state.sourceRecordsByKey.get(sourceKey);
        if (source) markWinnerDirty(state, recipientId, source.type);
      }
    }
    if (group.transformDirty) state.metrics.sourceMovesProcessed += 1;
  }
  state.metrics.membershipCacheHits += 0;
  group.dirty = false;
  group.transformDirty = false;
  group.allegianceDirty = false;
  processedSourceGroups.add(group.shipId);
}

function processDirtySourceGroups(room, state) {
  const processed = new Set();
  for (const sourceId of state.dirtySourceShips) {
    const group = sourceGroupFor(state, sourceId);
    if (!group) continue;
    // The set also carries capability invalidations so maintenance can rebuild
    // a source record. Those changes do not imply a spatial membership query
    // unless the group itself was marked dirty by movement, allegiance or an
    // operational-state transition.
    if (!group.dirty && !group.transformDirty) continue;
    refreshSourceGroupMembership(room, state, group, processed);
  }
  state.dirtySourceShips.clear();
  return processed;
}

function processMovedRecipients(room, state, processedSourceGroups) {
  const range = getCommandAuraRange();
  const rangeSquared = range * range;
  const selfAllowed = commandAuraSelfAllowed();
  for (const recipientId of state.movedRecipientIds) {
    const recipient = state.recipientShipsById.get(recipientId);
    if (!recipient) continue;
    state.metrics.recipientMovesProcessed += 1;
    const nearby = state.nearbySourceGroupIds;
    nearby.clear();
    const candidates = queryCandidateShips(room, state, finite(recipient.x), finite(recipient.y), range);
    for (const sourceShip of candidates) {
      const group = sourceGroupFor(state, sourceShip?.id);
      if (!group?.activeKeys.size || processedSourceGroups.has(group.shipId)) continue;
      if (!candidateBelongsToSourceGroup(room, group, recipient, selfAllowed, rangeSquared)) continue;
      nearby.add(group.shipId);
    }

    const known = state.knownSourceGroupIds;
    known.clear();
    for (const sourceKey of state.sourcesByRecipientId.get(recipientId) || []) {
      const source = state.sourceRecordsByKey.get(sourceKey);
      if (source) known.add(source.shipId);
    }
    for (const sourceId of known) {
      if (processedSourceGroups.has(sourceId) || nearby.has(sourceId)) continue;
      const group = sourceGroupFor(state, sourceId);
      if (group) removeMembership(state, group, recipientId);
    }
    for (const sourceId of nearby) {
      if (known.has(sourceId)) continue;
      const group = sourceGroupFor(state, sourceId);
      if (group) addMembership(state, group, recipient);
    }
    markRecipientDirty(state, recipientId);
    for (const type of AURA_TYPES) markWinnerDirty(state, recipientId, type);
  }
  state.movedRecipientIds.clear();
}

function resolveDirtyWinners(state) {
  const startedAt = performanceNow();
  for (const key of state.dirtyWinnerKeys) {
    const separator = key.indexOf(MEMBERSHIP_SEPARATOR);
    const recipientId = key.slice(0, separator);
    const type = key.slice(separator + 1);
    const entry = state.winnerByRecipientAndType.get(key);
    const reverse = state.sourcesByRecipientId.get(recipientId);
    let winner = null;
    let sourceCount = 0;
    for (const sourceKey of reverse || []) {
      const source = state.sourceRecordsByKey.get(sourceKey);
      if (!source?.active || source.type !== type) continue;
      const group = sourceGroupFor(state, source.shipId);
      if (!group?.members.has(recipientId)) continue;
      sourceCount += 1;
      const recipient = state.recipientShipsById.get(recipientId);
      if (!recipient) continue;
      if (!winner || compareCandidate(state, source, winner, recipient) < 0) winner = source;
    }
    if (!entry) continue;
    state.metrics.winnerRescans += 1;
    const nextKey = winner?.key || null;
    noteWinnerChange(state, entry, nextKey);
    entry.sourceCount = sourceCount;
    entry.dirty = false;
    const recipient = state.recipientShipsById.get(recipientId);
    if (winner && recipient) updateWinnerPriority(entry, winner, recipient);
    else entry.winnerPriority = null;
    if (!sourceCount) state.winnerByRecipientAndType.delete(key);
  }
  state.dirtyWinnerKeys.clear();
  return performanceNow() - startedAt;
}

function sameMultiplierObject(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) if (a[key] !== b[key]) return false;
  return true;
}

function sameReceivedObject(a, b) {
  const aKeys = Object.keys(a || {});
  const bKeys = Object.keys(b || {});
  if (aKeys.length !== bKeys.length) return false;
  for (const type of aKeys) {
    const left = a[type];
    const right = b[type];
    if (!right || left.type !== right.type || left.sourceShipId !== right.sourceShipId
      || left.sourceComponentIndex !== right.sourceComponentIndex
      || left.sourcePlayerId !== right.sourcePlayerId
      || left.suppressedCount !== right.suppressedCount
      || !sameMultiplierObject(left.multipliers, right.multipliers)) return false;
  }
  return true;
}

function clearPublishedResult(ship) {
  if (!ship) return;
  const changed = Boolean(ship.commandAuraReceived)
    || Object.keys(ship.commandAurasReceived || {}).length > 0
    || Object.keys(ship.commandAuraMultipliers || {}).length > 0;
  ship.commandAurasReceived = {};
  ship.commandAuraMultipliers = {};
  ship.commandAuraReceived = false;
  if (ship.commandAuraRevision === undefined) ship.commandAuraRevision = 0;
  if (changed) ship.commandAuraRevision += 1;
}

function publishDirtyRecipients(state) {
  const startedAt = performanceNow();
  for (const recipientId of state.dirtyRecipientShips) {
    const ship = state.recipientShipsById.get(recipientId);
    if (!ship || !ship.alive || ship.removed) {
      clearPublishedResult(ship);
      continue;
    }
    const received = {};
    const finalMultipliers = {};
    for (const type of AURA_TYPES) {
      const entryState = state.winnerByRecipientAndType.get(winnerKey(recipientId, type));
      const source = entryState?.winnerSourceKey
        ? state.sourceRecordsByKey.get(entryState.winnerSourceKey)
        : null;
      if (!source?.active) continue;
      const group = sourceGroupFor(state, source.shipId);
      if (!group?.members.has(recipientId)) continue;
      const entry = formatAuraReceivedEntry(source, Math.max(0, (entryState.sourceCount || 0) - 1));
      received[type] = entry;
      addAuraMultipliers(finalMultipliers, entry.multipliers);
    }
    const receivedFlag = Object.keys(finalMultipliers).length > 0;
    if (ship.commandAuraRevision === undefined) ship.commandAuraRevision = 0;
    const changed = !sameReceivedObject(ship.commandAurasReceived, received)
      || !sameMultiplierObject(ship.commandAuraMultipliers, finalMultipliers)
      || Boolean(ship.commandAuraReceived) !== receivedFlag;
    if (changed) {
      ship.commandAurasReceived = received;
      ship.commandAuraMultipliers = finalMultipliers;
      ship.commandAuraReceived = receivedFlag;
      ship.commandAuraRevision += 1;
      state.resultRevision += 1;
      state.metrics.recipientsPublished += 1;
    } else {
      state.metrics.recipientsUnchanged += 1;
    }
  }
  state.dirtyRecipientShips.clear();
  return performanceNow() - startedAt;
}

function markAllDirty(state) {
  for (const [id, group] of state.sourceGroupsByShipId) {
    group.dirty = true;
    state.dirtySourceShips.add(id);
  }
  for (const id of state.recipientShipsById.keys()) markRecipientDirty(state, id);
}

function reconcileBidirectionalConsistency(state) {
  let repairs = 0;
  for (const [sourceKey, members] of state.recipientsBySourceKey) {
    const source = state.sourceRecordsByKey.get(sourceKey);
    const group = sourceGroupFor(state, source?.shipId);
    if (!source?.active || !group) {
      state.recipientsBySourceKey.delete(sourceKey);
      repairs += 1;
      continue;
    }
    for (const recipientId of [...members]) {
      if (!group.members.has(recipientId)) {
        members.delete(recipientId);
        repairs += 1;
        continue;
      }
      const reverse = state.sourcesByRecipientId.get(recipientId);
      if (!reverse?.has(sourceKey)) {
        const next = reverse || new Set();
        next.add(sourceKey);
        state.sourcesByRecipientId.set(recipientId, next);
        markRecipientDirty(state, recipientId);
        markWinnerDirty(state, recipientId, source.type);
        repairs += 1;
      }
    }
  }
  for (const [recipientId, sourceKeys] of [...state.sourcesByRecipientId]) {
    if (!state.recipientShipsById.has(recipientId)) {
      state.sourcesByRecipientId.delete(recipientId);
      repairs += 1;
      continue;
    }
    for (const sourceKey of [...sourceKeys]) {
      const source = state.sourceRecordsByKey.get(sourceKey);
      const group = sourceGroupFor(state, source?.shipId);
      if (!source?.active || !group?.members.has(recipientId)) {
        sourceKeys.delete(sourceKey);
        repairs += 1;
      }
    }
    if (!sourceKeys.size) state.sourcesByRecipientId.delete(recipientId);
  }
  return repairs;
}

function assertCommandAuraConsistency(room) {
  const state = room?._commandAuraRuntime;
  const issues = [];
  if (!state) return { ok: true, issues };
  for (const [sourceKey, members] of state.recipientsBySourceKey) {
    const source = state.sourceRecordsByKey.get(sourceKey);
    const group = sourceGroupFor(state, source?.shipId);
    if (!source?.active || !group) issues.push(`stale source membership ${sourceKey}`);
    for (const recipientId of members) {
      if (!state.sourcesByRecipientId.get(recipientId)?.has(sourceKey)) issues.push(`missing reverse ${sourceKey}:${recipientId}`);
    }
  }
  for (const [recipientId, sourceKeys] of state.sourcesByRecipientId) {
    for (const sourceKey of sourceKeys) {
      if (!state.recipientsBySourceKey.get(sourceKey)?.has(recipientId)) issues.push(`missing forward ${sourceKey}:${recipientId}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

function reconcileRuntime(room, state) {
  const startedAt = performanceNow();
  state.metrics.reconciliations += 1;
  const repairs = reconcileBidirectionalConsistency(state);
  // Reconcile the edge set as well as the two reverse maps. This is bounded
  // and deliberately infrequent: it repairs missed lifecycle/movement
  // notifications without putting a full candidate scan back on every tick.
  const processedSourceGroups = new Set();
  for (const group of state.sourceGroupsByShipId.values()) {
    if (!group.activeKeys.size) continue;
    refreshSourceGroupMembership(room, state, group, processedSourceGroups);
  }
  if (repairs > 0) {
    // A repaired reverse edge can leave a winner entry stale even when the
    // public source ID happened to remain the same. Re-resolve the bounded
    // winner set on the following publication boundary.
    for (const entry of state.winnerByRecipientAndType.values()) {
      markWinnerDirty(state, entry.recipientId, entry.type);
    }
  }
  state.metrics.reconciliationRepairs += repairs;
  state.metrics.reconciliationUs += performanceNow() - startedAt;
  return repairs;
}

function syncSharedTelemetry(room, state, elapsedMs) {
  const t = telemetry(room);
  const metrics = state.metrics;
  t.activeSources = 0;
  t.activeSourceShips = 0;
  for (const source of state.sourceRecordsByKey.values()) if (source.active) t.activeSources += 1;
  for (const group of state.sourceGroupsByShipId.values()) {
    if (group.activeKeys.size) t.activeSourceShips += 1;
  }
  t.receivingShips = 0;
  for (const ship of state.recipientShipsById.values()) if (ship.commandAuraReceived) t.receivingShips += 1;
  t.recalculations = 1;
  t.lastUpdateUs = Math.max(0, elapsedMs * 1000);
  for (const key of Object.keys(metrics)) t[key] = metrics[key];
  t.activeSources = t.activeSources;
  t.activeSourceShips = t.activeSourceShips;
  t.receivingShips = t.receivingShips;

  const counters = {
    commandAuraShipsConsidered: state.currentLiveIds.size,
    commandAuraActiveSourceShips: t.activeSourceShips,
    commandAuraActiveComponents: t.activeSources,
    commandAuraSourceCacheHits: metrics.sourceCacheHits,
    commandAuraSourceRebuilds: metrics.sourceRebuilds,
    commandAuraSourceActivations: metrics.sourceActivations,
    commandAuraSourceDeactivations: metrics.sourceDeactivations,
    commandAuraMembershipQueries: metrics.membershipQueries,
    commandAuraMembershipCacheHits: metrics.membershipCacheHits,
    commandAuraMembershipAdds: metrics.membershipAdds,
    commandAuraMembershipRemoves: metrics.membershipRemoves,
    commandAuraCandidatesVisited: metrics.candidatesVisited,
    commandAuraRecipientMovesProcessed: metrics.recipientMovesProcessed,
    commandAuraSourceMovesProcessed: metrics.sourceMovesProcessed,
    commandAuraRecipientsDirty: metrics.recipientsDirty,
    commandAuraRecipientsPublished: metrics.recipientsPublished,
    commandAuraRecipientsUnchanged: metrics.recipientsUnchanged,
    commandAuraWinnerChanges: metrics.winnerChanges,
    commandAuraWinnerRescans: metrics.winnerRescans,
    commandAuraPriorityComparisons: metrics.priorityComparisons,
    commandAuraSortsPerformed: metrics.sortsPerformed,
    commandAuraFullScanFallbacks: metrics.fullScanFallbacks,
    commandAuraReconciliations: metrics.reconciliations,
    commandAuraReconciliationRepairs: metrics.reconciliationRepairs,
    commandAuraStaleSourcesRemoved: metrics.staleSourcesRemoved,
    commandAuraStaleRecipientsRemoved: metrics.staleRecipientsRemoved
  };
  for (const [name, value] of Object.entries(counters)) setCounter(room, name, value);
  if (room._roomTelemetry) {
    room._roomTelemetry.commandAuraRuntimeMs += elapsedMs;
    room._roomTelemetry.commandAuraFallbackMs += metrics.fallbackUs;
  }
}

function ensureStateTransformsMap(state) {
  if (!(state.transformsByShipId instanceof Map)) state.transformsByShipId = new Map();
  return state.transformsByShipId;
}

function updateCommandAuraRuntime(room, ships, now) {
  const state = ensureRuntime(room);
  const wasBootstrapped = state.bootstrapped;
  const startedAt = performanceNow();
  state.metrics = resetTelemetry(room);
  // This is a per-update diagnostic scratch list, not a history of every
  // destroyed source in the room's lifetime.
  state.removedSourceKeys.length = 0;
  ensureStateTransformsMap(state);
  consumeMovementNotifications(room, state);
  state.liveShips = ships;

  const indexGeneration = Number(room.spatialIndex?.dynamicGeneration) || 0;
  if (state.spatialGeneration !== indexGeneration) {
    state.spatialGeneration = indexGeneration;
  }
  const currentConfigKey = `${BALANCE_REVISION}:${getCommandAuraRange()}:${commandAuraSelfAllowed() ? 1 : 0}`;
  if (state.configKey !== currentConfigKey) {
    state.configKey = currentConfigKey;
    state.fullInvalidation = true;
  }
  const relationshipRevision = Number(room.relationshipRevision) || 0;
  if (state.relationshipRevision !== relationshipRevision) {
    state.relationshipRevision = relationshipRevision;
    state.fullInvalidation = true;
  }
  if (!isSpatialIndexUsable(room) && state.bootstrapped) {
    // The fallback is intentionally scoped to this update. It does not poison
    // the normal spatial-index path for later generations.
    state.fullInvalidation = true;
  }

  const maintenanceStart = performanceNow();
  maintainSourcesAndRecipients(room, state, ships || []);
  const maintenanceElapsed = performanceNow() - maintenanceStart;
  state.metrics.sourceMaintenanceUs = maintenanceElapsed;
  recordDuration(room, "commandAuraSourceMaintenanceMs", maintenanceStart);

  if (!state.bootstrapped) {
    markAllDirty(state);
    state.bootstrapped = true;
    state.fullInvalidation = false;
  } else if (state.fullInvalidation) {
    markAllDirty(state);
    state.fullInvalidation = false;
  }

  refreshMovedSpatialRecords(room, state);
  const membershipStart = performanceNow();
  const processedSourceGroups = processDirtySourceGroups(room, state);
  if (wasBootstrapped) processMovedRecipients(room, state, processedSourceGroups);
  state.metrics.membershipUs = performanceNow() - membershipStart;
  recordDuration(room, "commandAuraMembershipMs", membershipStart);

  const winnerStart = performanceNow();
  const winnerElapsed = resolveDirtyWinners(state);
  state.metrics.winnerResolutionUs = winnerElapsed;
  recordDuration(room, "commandAuraWinnerResolutionMs", winnerStart);

  const publicationStart = performanceNow();
  publishDirtyRecipients(state);
  state.metrics.recipientPublishUs = performanceNow() - publicationStart;
  recordDuration(room, "commandAuraRecipientPublishMs", publicationStart);

  state.generation += 1;
  state.reconciliationGeneration += 1;
  if (state.reconciliationGeneration >= RECONCILIATION_INTERVAL) {
    state.reconciliationGeneration = 0;
    const reconciliationStart = performanceNow();
    reconcileRuntime(room, state);
    recordDuration(room, "commandAuraReconciliationMs", reconciliationStart);
  }
  const elapsed = performanceNow() - startedAt;
  state.lastProcessedAt = finite(now, state.lastProcessedAt);
  syncSharedTelemetry(room, state, elapsed);
  room._commandAuraLastMetrics = {
    generation: state.generation,
    activeSourceShips: [...state.sourceGroupsByShipId.values()].filter((group) => group.activeKeys.size > 0).length,
    activeComponents: [...state.sourceRecordsByKey.values()].filter((source) => source.active).length,
    recipients: state.recipientShipsById.size,
    membershipEdges: [...state.recipientsBySourceKey.values()].reduce((sum, members) => sum + members.size, 0),
    winnerEntries: state.winnerByRecipientAndType.size
  };
  if (process.env.NODE_ENV !== "production" && process.env.MFA_ASSERT_COMMAND_AURA === "1") {
    const integrity = assertCommandAuraConsistency(room);
    if (!integrity.ok) throw new Error(`Command Aura cache inconsistency: ${integrity.issues.join(", ")}`);
  }
}

function invalidateCommandAuraSource(room, ship) {
  if (!room || !ship) return;
  ship._commandAuraCapabilityDirty = true;
  const state = room._commandAuraRuntime;
  if (!state) return;
  state.dirtySourceShips.add(String(ship.id));
  state.dirtyRecipientShips.add(String(ship.id));
}

function invalidateCommandAuraRecipient(room, ship) {
  if (!room || !ship) return;
  const state = room._commandAuraRuntime;
  if (!state) return;
  state.dirtyRecipientShips.add(String(ship.id));
}

function invalidateCommandAuraMovement(room, movedShipIds) {
  if (!room) return;
  const moved = room._commandAuraMovedShipIds || (room._commandAuraMovedShipIds = new Set());
  const state = room._commandAuraRuntime;
  for (const value of movedShipIds || []) {
    const id = String(value?.id ?? value);
    moved.add(id);
    if (!state) continue;
    state.explicitMovedIds.add(id);
    state.dirtySourceShips.add(id);
    state.dirtyRecipientShips.add(id);
    state.movedRecipientIds.add(id);
  }
}

function invalidateCommandAuraAllegiance(room) {
  if (!room) return;
  const state = room._commandAuraRuntime;
  if (!state) return;
  state.fullInvalidation = true;
  state.relationshipRevision = -1;
}

function invalidateAllCommandAuras(room) {
  if (!room) return;
  const state = room._commandAuraRuntime;
  if (!state) return;
  state.fullInvalidation = true;
  markAllDirty(state);
}

function clearCommandAuraRuntime(room, ships = null) {
  if (!room) return;
  const state = room._commandAuraRuntime;
  const targets = new Set([
    ...(ships || []),
    ...(state?.recipientShipsById?.values?.() || []),
    ...(room.ships?.values?.() || [])
  ]);
  for (const ship of targets) clearPublishedResult(ship);
  if (state) clearStateReferences(state);
  room._commandAuraRuntime = null;
  room._commandAuraMovedShipIds?.clear?.();
  room._commandAuraLastMetrics = null;
  room._commandAuraTelemetry = null;
}

module.exports = {
  updateCommandAuraRuntime,
  invalidateCommandAuraSource,
  invalidateCommandAuraRecipient,
  invalidateCommandAuraMovement,
  invalidateCommandAuraAllegiance,
  invalidateAllCommandAuras,
  clearCommandAuraRuntime,
  reconcileCommandAuraRuntime: reconcileRuntime,
  assertCommandAuraConsistency,
  compareSourceForRecipient
};
