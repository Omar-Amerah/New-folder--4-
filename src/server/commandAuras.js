// Authoritative Command Aura system.
//
// The legacy implementation remains available as the rollout reference. The
// Phase 6D runtime keeps the same rules but caches source capability, spatial
// membership and per-recipient winners behind one server-side flag.

"use strict";

const { performanceNow } = require("./utils");
const {
  AURA_TYPES,
  AURA_STAT_KEYS,
  AURA_UPDATE_INTERVAL_MS,
  getCommandAuraRange,
  commandAuraSelfAllowed,
  collectAuraSources,
  isAuraComponentOperational,
  auraComponentEffectiveness,
  scaleAuraMultiplier,
  auraMultipliersFrom,
  auraMultipliersScaled,
  auraStrength,
  sourcePriorityKey,
  compareSourcePriority,
  getAuraComponentIndices,
  buildAuraSourceValues,
  compareSourceForRecipient,
  formatAuraReceivedEntry,
  addAuraMultipliers,
  auraForComponent,
  shipSequenceNumber
} = require("./commandAuraRules");
const { OPTIMIZED_COMMAND_AURA_RUNTIME } = require("./performanceFlags");
const commandAuraRuntime = require("./commandAuraRuntime");

// Room-scoped telemetry. The optimized fields are reset with the legacy fields
// so diagnostics always describe the most recent authoritative aura update.
function telemetry(room) {
  return room._commandAuraTelemetry || (room._commandAuraTelemetry = {
    activeSources: 0,
    activeSourceShips: 0,
    receivingShips: 0,
    candidatesExamined: 0,
    recalculations: 0,
    lastUpdateUs: 0,
    additions: 0,
    removals: 0,
    sourceCacheHits: 0,
    sourceRebuilds: 0,
    sourceActivations: 0,
    sourceDeactivations: 0,
    membershipQueries: 0,
    membershipCacheHits: 0,
    membershipAdds: 0,
    membershipRemoves: 0,
    candidatesVisited: 0,
    recipientMovesProcessed: 0,
    sourceMovesProcessed: 0,
    recipientsDirty: 0,
    recipientsPublished: 0,
    recipientsUnchanged: 0,
    winnerChanges: 0,
    winnerRescans: 0,
    priorityComparisons: 0,
    sortsPerformed: 0,
    fullScanFallbacks: 0,
    reconciliations: 0,
    reconciliationRepairs: 0,
    staleSourcesRemoved: 0,
    staleRecipientsRemoved: 0,
    fallbackUs: 0,
    sourceMaintenanceUs: 0,
    membershipUs: 0,
    winnerResolutionUs: 0,
    recipientPublishUs: 0,
    reconciliationUs: 0
  });
}

function resetTelemetry(room) {
  const t = telemetry(room);
  for (const key of Object.keys(t)) t[key] = 0;
  return t;
}

// Legacy full rebuild. This deliberately retains the original candidate-array
// and sort behavior so the disabled flag remains a differential reference.
function recalculateAuras(room, ships) {
  const t = resetTelemetry(room);
  const startedAt = performanceNow();
  const range = getCommandAuraRange();
  const rangeSquared = range * range;
  const selfAllowed = commandAuraSelfAllowed();
  const liveSet = new Set(ships);

  // The simulation passes only live ships. Clear stale public aura state on a
  // hull that was destroyed/removed between cadence boundaries so the legacy
  // reference and the incremental lifecycle path expose the same result.
  for (const ship of room.ships?.values?.() || []) {
    if (liveSet.has(ship)) continue;
    if (!ship.alive || ship.removed) {
      ship.commandAuraActive = false;
      ship.commandAurasReceived = {};
      ship.commandAuraMultipliers = {};
      ship.commandAuraReceived = false;
    }
  }

  const recipients = [];
  for (const ship of ships) {
    if (!ship.alive) continue;
    ship.commandAurasReceived = {};
    ship.commandAuraMultipliers = {};
    ship._commandAuraScratch = ship._commandAuraScratch || {};
    recipients.push(ship);
  }

  const index = room.spatialIndex;
  const candidateBuffer = room._commandAuraCandidateBuffer || (room._commandAuraCandidateBuffer = []);

  for (const source of ships) {
    if (!source.alive) {
      source.commandAuraActive = false;
      continue;
    }
    const sources = collectAuraSources(source);
    source.commandAuraActive = sources.length > 0;
    if (!sources.length) continue;
    t.activeSources += sources.length;
    t.activeSourceShips += 1;

    if (!index) {
      for (const target of recipients) {
        if (!selfAllowed && target === source) continue;
        if (!areAlliesCompat(room, source.ownerId, target.ownerId)) continue;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        if (dx * dx + dy * dy <= rangeSquared) {
          t.candidatesExamined += 1;
          considerTarget(target, source, sources);
        }
      }
      continue;
    }

    candidateBuffer.length = 0;
    index.queryRangeUnordered("ships", source.x, source.y, range, candidateBuffer);
    for (const target of candidateBuffer) {
      if (!target?.alive) continue;
      if (!selfAllowed && target === source) continue;
      if (!areAlliesCompat(room, source.ownerId, target.ownerId)) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      if (dx * dx + dy * dy > rangeSquared) continue;
      t.candidatesExamined += 1;
      considerTarget(target, source, sources);
    }
  }

  for (const ship of recipients) {
    const received = ship.commandAurasReceived;
    const finalMultipliers = {};
    for (const type of AURA_TYPES) {
      const candidates = received[type];
      if (!candidates || !candidates.length) continue;
      candidates.sort((a, b) => compareSourcePriority(a.priority, b.priority));
      t.sortsPerformed += 1;
      const best = candidates[0];
      const entry = formatAuraReceivedEntry(best.source, candidates.length - 1);
      received[type] = entry;
      addAuraMultipliers(finalMultipliers, entry.multipliers);
      t.additions += 1;
    }
    ship.commandAuraMultipliers = finalMultipliers;
    ship.commandAuraReceived = Object.keys(finalMultipliers).length > 0;
    if (ship.commandAuraReceived) t.receivingShips += 1;
  }

  t.lastUpdateUs = Math.max(0, (performanceNow() - startedAt) * 1000);
  t.recalculations += 1;
}

function areAlliesCompat(room, ownerA, ownerB) {
  // Kept local to make the legacy loop's call shape obvious and avoid making
  // the optimized runtime depend on a mutable candidate array.
  const { areAllies } = require("./relationships");
  return areAllies(room, ownerA, ownerB);
}

function considerTarget(target, source, sources) {
  const received = target.commandAurasReceived;
  for (const src of sources) {
    const list = received[src.type] || (received[src.type] = []);
    list.push({
      source: src,
      priority: sourcePriorityKey(src, target.x, target.y)
    });
  }
}

function updateCommandAuras(room, ships, now) {
  if (room.phase !== "active") {
    clearCommandAuras(room, ships);
    return;
  }
  const nextUpdate = room._commandAuraNextUpdate || 0;
  if (now < nextUpdate) return;
  room._commandAuraNextUpdate = now + AURA_UPDATE_INTERVAL_MS;
  if (OPTIMIZED_COMMAND_AURA_RUNTIME()) {
    commandAuraRuntime.updateCommandAuraRuntime(room, ships, now);
  } else {
    recalculateAuras(room, ships);
    // Movement notifications are only meaningful to the optimized runtime.
    room._commandAuraMovedShipIds?.clear?.();
  }
}

// Compatibility wrapper retained for existing callers. Scoped production
// invalidation functions below avoid turning every mutation into a full reset.
function invalidateCommandAuras(room) {
  if (!room) return;
  room._commandAuraNextUpdate = 0;
  commandAuraRuntime.invalidateAllCommandAuras(room, "compatibility");
}

function invalidateCommandAuraSource(room, ship, reason = "source") {
  commandAuraRuntime.invalidateCommandAuraSource(room, ship, reason);
}

function invalidateCommandAuraRecipient(room, ship, reason = "recipient") {
  commandAuraRuntime.invalidateCommandAuraRecipient(room, ship, reason);
}

function invalidateCommandAuraMovement(room, movedShipIds, reason = "movement") {
  commandAuraRuntime.invalidateCommandAuraMovement(room, movedShipIds, reason);
}

function invalidateCommandAuraAllegiance(room, ship, oldTeam, newTeam) {
  commandAuraRuntime.invalidateCommandAuraAllegiance(room, ship, oldTeam, newTeam);
}

function clearCommandAuras(room, ships) {
  if (room) {
    room._commandAuraNextUpdate = 0;
    commandAuraRuntime.clearCommandAuraRuntime(room, ships);
    room._commandAuraCandidateBuffer = null;
  }
  const targets = Array.isArray(ships)
    ? ships
    : [...(room?.ships?.values?.() || [])];
  for (const ship of targets) {
    ship.commandAurasReceived = {};
    ship.commandAuraMultipliers = {};
    ship.commandAuraActive = false;
    ship.commandAuraReceived = false;
    if (ship.commandAuraRevision === undefined) ship.commandAuraRevision = 0;
  }
}

function getCommandAuraMultiplier(ship, stat) {
  if (!ship?.commandAuraMultipliers) return 1;
  const value = ship.commandAuraMultipliers[stat];
  return Number.isFinite(value) ? value : 1;
}

module.exports = {
  AURA_TYPES,
  AURA_STAT_KEYS,
  AURA_UPDATE_INTERVAL_MS,
  getCommandAuraRange,
  commandAuraSelfAllowed,
  updateCommandAuras,
  invalidateCommandAuras,
  invalidateCommandAuraSource,
  invalidateCommandAuraRecipient,
  invalidateCommandAuraMovement,
  invalidateCommandAuraAllegiance,
  invalidateAllCommandAuras: invalidateCommandAuras,
  clearCommandAuras,
  getCommandAuraMultiplier,
  telemetry,
  collectAuraSources,
  getAuraComponentIndices,
  buildAuraSourceValues,
  auraForComponent,
  isAuraComponentOperational,
  auraComponentEffectiveness,
  scaleAuraMultiplier,
  auraMultipliersFrom,
  auraMultipliersScaled,
  auraStrength,
  compareSourceForRecipient,
  shipSequenceNumber
};
