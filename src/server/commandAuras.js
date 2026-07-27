// Authoritative command-component aura system.
//
// Command components emit a shared-radius aura that passively buffs nearby
// allied ships.  All auras use one authoritative range so their circles align
// visually and players can instantly judge whether a ship is inside command
// range.  Identical aura types do not stack; only the strongest valid source
// applies for each aura type, with a deterministic priority tie-breaker.

"use strict";

const { PARTS } = require("./components");
const { BALANCE } = require("./balanceConfig");
const { areAllies } = require("./relationships");
const { performanceNow } = require("./utils");

const HeatRules = require("../../public/src/shared/heatRules");

// Types of command aura.  Each type is an independent buff category; different
// categories may operate simultaneously.  Within one category only the single
// strongest valid source applies.
const AURA_TYPES = new Set([
  "command",
  "fireControl",
  "fleetDefence",
  "shield",
  "engineering",
  "propulsion",
  "ewar"
]);

// Canonical stat multipliers that an aura may contribute.  Every stat has a
// neutral value of 1.0 so systems can multiply without branching.
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
  "targetRetentionMultiplier"
]);

// Shared authoritative aura range.  All command components use this exact value.
function getCommandAuraRange() {
  return Number(BALANCE?.commandAura?.range) || 500;
}

function commandAuraSelfAllowed() {
  return BALANCE?.commandAura?.selfAura === true;
}

const AURA_UPDATE_INTERVAL_MS = 150;

// Room-scoped telemetry.  Per-room counters are reset on every full update.
function telemetry(room) {
  return room._commandAuraTelemetry || (room._commandAuraTelemetry = {
    activeSources: 0,
    receivingShips: 0,
    candidatesExamined: 0,
    recalculations: 0,
    lastUpdateUs: 0,
    additions: 0,
    removals: 0
  });
}

function resetTelemetry(room) {
  const t = telemetry(room);
  t.activeSources = 0;
  t.receivingShips = 0;
  t.candidatesExamined = 0;
  t.recalculations = 0;
  t.lastUpdateUs = 0;
  t.additions = 0;
  t.removals = 0;
  return t;
}

// Extract an ordered list of aura sources from a ship.  Each source records the
// component index, aura type, multipliers and a derived strength used for
// source-vs-source priority within the same aura type.
function collectAuraSources(ship) {
  const sources = [];
  const design = ship.design || [];
  for (let i = 0; i < design.length; i += 1) {
    const part = PARTS[design[i]?.type];
    const aura = part?.aura;
    if (!aura || !AURA_TYPES.has(aura.type)) continue;
    if (!isAuraComponentOperational(ship, i)) continue;
    const multipliers = auraMultipliersFrom(aura);
    const strength = auraStrength(aura.type, multipliers);
    sources.push({
      ship,
      componentIndex: i,
      type: aura.type,
      multipliers,
      strength
    });
  }
  return sources;
}

function isAuraComponentOperational(ship, index) {
  if (!ship.alive) return false;
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

function auraMultipliersFrom(aura) {
  const multipliers = {};
  for (const key of AURA_STAT_KEYS) {
    const value = Number(aura[key]);
    if (Number.isFinite(value)) multipliers[key] = value;
  }
  return multipliers;
}

function auraStrength(type, multipliers) {
  // Strongest source is decided by the largest individual positive multiplier
  // this aura type contributes.  Negative or zero multipliers are treated as
  // neutral for priority purposes.
  let max = 0;
  for (const key of Object.keys(multipliers)) {
    const value = multipliers[key];
    if (value > max) max = value;
  }
  return max;
}

function sourcePriorityKey(source, recipientX, recipientY) {
  // Deterministic priority:
  // 1. highest effective modifier (strength) - descending
  // 2. shortest distance - ascending
  // 3. lowest authoritative source ship sequence - ascending
  // 4. lowest component index - ascending
  const dx = source.ship.x - recipientX;
  const dy = source.ship.y - recipientY;
  const distanceSquared = dx * dx + dy * dy;
  const shipSequence = shipSequenceNumber(source.ship.id);
  return {
    strength: source.strength,
    distanceSquared,
    shipSequence,
    componentIndex: source.componentIndex
  };
}

function shipSequenceNumber(id) {
  if (typeof id !== "string") return Number.MAX_SAFE_INTEGER;
  const numeric = Number.parseInt(id.replace(/^[^0-9-]*-?/, ""), 10);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER;
}

// Compare two priority keys.  Returns negative if a wins, positive if b wins.
function compareSourcePriority(a, b) {
  if (a.strength !== b.strength) return b.strength - a.strength;
  if (a.distanceSquared !== b.distanceSquared) return a.distanceSquared - b.distanceSquared;
  if (a.shipSequence !== b.shipSequence) return a.shipSequence - b.shipSequence;
  return a.componentIndex - b.componentIndex;
}

// Recompute aura membership for every live ship.  Uses the spatial index for
// broad-phase candidate collection and reuses scratch buffers.
function recalculateAuras(room, ships) {
  const t = resetTelemetry(room);
  const startedAt = performanceNow();
  const range = getCommandAuraRange();
  const rangeSquared = range * range;
  const selfAllowed = commandAuraSelfAllowed();

  // Reset per-ship received state and flatten recipients.
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
    if (!source.alive) { source.commandAuraActive = false; continue; }
    const sources = collectAuraSources(source);
    source.commandAuraActive = sources.length > 0;
    if (!sources.length) continue;
    t.activeSources += sources.length;

    if (!index) {
      // Fallback for tests or rooms built without a spatial index: full scan.
      for (const target of recipients) {
        if (!selfAllowed && target === source) continue;
        if (!areAllies(room, source.ownerId, target.ownerId)) continue;
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
      if (!areAllies(room, source.ownerId, target.ownerId)) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      if (dx * dx + dy * dy > rangeSquared) continue;
      t.candidatesExamined += 1;
      considerTarget(target, source, sources);
    }
  }

  // Resolve strongest source per aura type for each recipient and flatten final
  // multipliers.  Also populate a readable received-aura list for snapshots/UI.
  for (const ship of recipients) {
    const received = ship.commandAurasReceived;
    const finalMultipliers = {};
    for (const type of AURA_TYPES) {
      const candidates = received[type];
      if (!candidates || !candidates.length) continue;
      candidates.sort((a, b) => compareSourcePriority(a.priority, b.priority));
      const best = candidates[0];
      const sourceShip = best.source.ship;
      const entry = {
        type,
        sourceShipId: sourceShip.id,
        sourceComponentIndex: best.source.componentIndex,
        sourcePlayerId: sourceShip.ownerId,
        multipliers: { ...best.source.multipliers },
        suppressedCount: candidates.length - 1
      };
      received[type] = entry;
      for (const [key, value] of Object.entries(entry.multipliers)) {
        if (!AURA_STAT_KEYS.has(key)) continue;
        finalMultipliers[key] = (finalMultipliers[key] || 1) * value;
      }
      t.additions += 1;
    }
    ship.commandAuraMultipliers = finalMultipliers;
    ship.commandAuraReceived = Object.keys(finalMultipliers).length > 0;
    if (ship.commandAuraReceived) t.receivingShips += 1;
  }

  t.lastUpdateUs = Math.max(0, (performanceNow() - startedAt) * 1000);
  t.recalculations += 1;
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
  recalculateAuras(room, ships);
}

function invalidateCommandAuras(room) {
  if (room) room._commandAuraNextUpdate = 0;
}

function clearCommandAuras(room, ships) {
  if (room) {
    room._commandAuraNextUpdate = 0;
    room._commandAuraTelemetry = null;
    room._commandAuraCandidateBuffer = null;
  }
  if (Array.isArray(ships)) {
    for (const ship of ships) {
      ship.commandAurasReceived = {};
      ship.commandAuraMultipliers = {};
      ship.commandAuraActive = false;
      ship.commandAuraReceived = false;
    }
  }
}

// Quick accessor for gameplay systems.  Returns the multiplier for a given stat,
// defaulting to 1.0 when no aura provides it.
function getCommandAuraMultiplier(ship, stat) {
  if (!ship?.commandAuraMultipliers) return 1;
  const value = ship.commandAuraMultipliers[stat];
  return Number.isFinite(value) ? value : 1;
}

module.exports = {
  AURA_TYPES,
  AURA_STAT_KEYS,
  getCommandAuraRange,
  commandAuraSelfAllowed,
  updateCommandAuras,
  invalidateCommandAuras,
  clearCommandAuras,
  getCommandAuraMultiplier,
  telemetry,
  collectAuraSources,
  isAuraComponentOperational
};
