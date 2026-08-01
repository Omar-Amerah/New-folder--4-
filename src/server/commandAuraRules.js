// Shared authoritative Command Aura rules.
//
// The legacy full rebuild and the incremental Phase 6D runtime both use these
// helpers.  Keeping the balance, operational and deterministic-priority rules
// here makes the optimized path a storage/invalidations refactor rather than a
// second implementation of aura gameplay.

"use strict";

const { PARTS } = require("./components");
const { BALANCE } = require("./balanceConfig");
const { areAllies } = require("./relationships");
const { getShipComponentIndexes } = require("./componentIndexes");
const HeatRules = require("../../public/src/shared/heatRules");

const AURA_TYPES = new Set([
  "command",
  "fireControl",
  "fleetDefence",
  "shield",
  "engineering",
  "propulsion",
  "ewar"
]);

const AURA_STAT_KEYS = new Set([
  "weaponAccuracyMultiplier",
  "weaponTrackingMultiplier",
  "turretAimSpeedMultiplier",
  "targetAcquisitionMultiplier",
  "pointDefenceTrackingMultiplier",
  "flakTrackingMultiplier",
  "interceptionReactionMultiplier",
  "shieldRegenMultiplier",
  "shieldRestartDelayMultiplier",
  "repairRateMultiplier",
  "heatDissipationMultiplier",
  "overheatRecoveryMultiplier",
  "accelerationMultiplier",
  "turnRateMultiplier",
  "sensorRangeMultiplier",
  "missileTrackingResistanceMultiplier",
  "componentAimRetentionMultiplier"
]);

const AURA_UPDATE_INTERVAL_MS = 150;

function getCommandAuraRange() {
  return Number(BALANCE?.commandAura?.range) || 500;
}

function commandAuraSelfAllowed() {
  return BALANCE?.commandAura?.selfAura === true;
}

function auraForComponent(ship, index) {
  const part = PARTS[ship?.design?.[index]?.type];
  const aura = part?.aura;
  return aura && AURA_TYPES.has(aura.type) ? aura : null;
}

// Design-derived and revision-guarded. Runtime Power/Heat values deliberately
// do not live in this cache.
function getAuraComponentIndices(ship) {
  const indexes = getShipComponentIndexes(ship);
  if (ship?._commandAuraComponentIndexSource === indexes
    && Array.isArray(ship._commandAuraComponentIndices)) {
    return ship._commandAuraComponentIndices;
  }
  const auraIndices = [];
  for (const index of indexes.commandAuraIndices || []) {
    if (auraForComponent(ship, index)) auraIndices.push(index);
  }
  ship._commandAuraComponentIndexSource = indexes;
  ship._commandAuraComponentIndices = auraIndices;
  return auraIndices;
}

function isAuraComponentOperational(ship, index) {
  if (!ship?.alive) return false;
  if ((ship.componentHp?.[index] ?? 1) <= 0) return false;
  const powerRecord = ship.componentPower?.byComponentIndex?.[index];
  if (!powerRecord || powerRecord.operationalMultiplier <= 0) return false;
  const heatState = ship.componentHeatState?.[index];
  if (heatState !== undefined && heatState !== null) {
    const output = HeatRules.activeOutputForState(heatState);
    if (output <= 0) return false;
  }
  return true;
}

function auraComponentEffectiveness(ship, index) {
  if (!ship?.alive) return 0;
  if ((ship.componentHp?.[index] ?? 1) <= 0) return 0;
  const powerRecord = ship.componentPower?.byComponentIndex?.[index];
  const powerMult = Number(powerRecord?.operationalMultiplier) || 0;
  if (powerMult <= 0) return 0;
  const heatState = ship.componentHeatState?.[index];
  const heatOutput = heatState !== undefined && heatState !== null
    ? HeatRules.activeOutputForState(heatState)
    : 1;
  const effectiveness = powerMult * heatOutput;
  if (effectiveness <= 0) return 0;
  return Math.max(0, Math.min(1, effectiveness));
}

function scaleAuraMultiplier(configuredValue, effectiveness) {
  if (!Number.isFinite(configuredValue)) return 1;
  if (configuredValue === 1) return 1;
  const eff = Math.max(0, Math.min(1, effectiveness));
  if (configuredValue > 1) return 1 + (configuredValue - 1) * eff;
  return 1 - (1 - configuredValue) * eff;
}

function auraMultipliersFrom(aura) {
  const multipliers = {};
  for (const key of AURA_STAT_KEYS) {
    const value = Number(aura?.[key]);
    if (Number.isFinite(value)) multipliers[key] = value;
  }
  return multipliers;
}

function auraMultipliersScaled(aura, effectiveness) {
  const multipliers = {};
  for (const key of AURA_STAT_KEYS) {
    const value = Number(aura?.[key]);
    if (Number.isFinite(value)) multipliers[key] = scaleAuraMultiplier(value, effectiveness);
  }
  return multipliers;
}

function auraStrength(type, multipliers) {
  // `type` is retained in the signature for compatibility with the original
  // helper and to make the priority rule's source category explicit.
  void type;
  let max = 0;
  for (const value of Object.values(multipliers || {})) if (value > max) max = value;
  return max;
}

function buildAuraSourceValues(ship, componentIndex) {
  const aura = auraForComponent(ship, componentIndex);
  if (!aura || !isAuraComponentOperational(ship, componentIndex)) return null;
  const effectiveness = auraComponentEffectiveness(ship, componentIndex);
  if (effectiveness <= 0) return null;
  const multipliers = auraMultipliersScaled(aura, effectiveness);
  return {
    type: aura.type,
    multipliers,
    strength: auraStrength(aura.type, multipliers),
    effectiveness
  };
}

function collectAuraSources(ship) {
  const sources = [];
  for (const componentIndex of getAuraComponentIndices(ship)) {
    const values = buildAuraSourceValues(ship, componentIndex);
    if (!values) continue;
    sources.push({ ship, componentIndex, ...values });
  }
  return sources;
}

function shipSequenceNumber(id) {
  if (typeof id !== "string") return Number.MAX_SAFE_INTEGER;
  const numeric = Number.parseInt(id.replace(/^[^0-9-]*-?/, ""), 10);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

function sourcePriorityKey(source, recipientX, recipientY) {
  const dx = source.ship.x - recipientX;
  const dy = source.ship.y - recipientY;
  return {
    strength: source.strength,
    distanceSquared: dx * dx + dy * dy,
    shipSequence: source.sourceShipSequence ?? shipSequenceNumber(source.ship.id),
    componentIndex: source.componentIndex
  };
}

// Compare two priority keys. Returns negative if a wins, positive if b wins.
function compareSourcePriority(a, b) {
  if (a.strength !== b.strength) return b.strength - a.strength;
  if (a.distanceSquared !== b.distanceSquared) return a.distanceSquared - b.distanceSquared;
  if (a.shipSequence !== b.shipSequence) return a.shipSequence - b.shipSequence;
  return a.componentIndex - b.componentIndex;
}

// Direct primitive comparison used by Phase 6D. It intentionally has the same
// ordering as compareSourcePriority without allocating a priority object.
function compareSourceForRecipient(candidate, current, recipientX, recipientY) {
  if (candidate.strength !== current.strength) return current.strength - candidate.strength;
  const candidateDx = candidate.x - recipientX;
  const candidateDy = candidate.y - recipientY;
  const currentDx = current.x - recipientX;
  const currentDy = current.y - recipientY;
  const candidateDistance = candidateDx * candidateDx + candidateDy * candidateDy;
  const currentDistance = currentDx * currentDx + currentDy * currentDy;
  if (candidateDistance !== currentDistance) return candidateDistance - currentDistance;
  if (candidate.sourceShipSequence !== current.sourceShipSequence) {
    return candidate.sourceShipSequence - current.sourceShipSequence;
  }
  if (candidate.componentIndex !== current.componentIndex) {
    return candidate.componentIndex - current.componentIndex;
  }
  // The balance rules end at component index. This final stable identity tie
  // only handles malformed fixtures that reuse a numeric ship sequence.
  return String(candidate.shipId ?? candidate.ship?.id ?? candidate.key)
    .localeCompare(String(current.shipId ?? current.ship?.id ?? current.key));
}

function formatAuraReceivedEntry(source, suppressedCount) {
  const sourceShip = source.ship;
  return {
    type: source.type,
    sourceShipId: sourceShip.id,
    sourceComponentIndex: source.componentIndex,
    sourcePlayerId: sourceShip.ownerId,
    multipliers: { ...source.multipliers },
    suppressedCount
  };
}

function addAuraMultipliers(target, multipliers) {
  for (const [key, value] of Object.entries(multipliers || {})) {
    if (!AURA_STAT_KEYS.has(key)) continue;
    target[key] = (target[key] || 1) * value;
  }
}

function isAlliedAuraTarget(room, source, target, selfAllowed, rangeSquared) {
  if (!target?.alive || target.removed) return false;
  if (!selfAllowed && target === source) return false;
  if (!areAllies(room, source.ownerId, target.ownerId)) return false;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  return dx * dx + dy * dy <= rangeSquared;
}

module.exports = {
  AURA_TYPES,
  AURA_STAT_KEYS,
  AURA_UPDATE_INTERVAL_MS,
  getCommandAuraRange,
  commandAuraSelfAllowed,
  auraForComponent,
  getAuraComponentIndices,
  isAuraComponentOperational,
  auraComponentEffectiveness,
  scaleAuraMultiplier,
  auraMultipliersFrom,
  auraMultipliersScaled,
  auraStrength,
  buildAuraSourceValues,
  collectAuraSources,
  shipSequenceNumber,
  sourcePriorityKey,
  compareSourcePriority,
  compareSourceForRecipient,
  formatAuraReceivedEntry,
  addAuraMultipliers,
  isAlliedAuraTarget
};
