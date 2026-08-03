// Authoritative Command Aura system.
//
// The authoritative runtime caches source capability, spatial membership and
// per-recipient winners while preserving the established aura rules.

"use strict";

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
const commandAuraRuntime = require("./commandAuraRuntime");

// Room-scoped telemetry for the authoritative aura runtime.
function telemetry(room) {
  return room._commandAuraTelemetry || (room._commandAuraTelemetry = {
    activeSources: 0,
    activeSourceShips: 0,
    receivingShips: 0,
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

function updateCommandAuras(room, ships, now) {
  if (room.phase !== "active") {
    clearCommandAuras(room, ships);
    return;
  }
  const nextUpdate = room._commandAuraNextUpdate || 0;
  if (now < nextUpdate) return;
  room._commandAuraNextUpdate = now + AURA_UPDATE_INTERVAL_MS;
  commandAuraRuntime.updateCommandAuraRuntime(room, ships, now);
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
