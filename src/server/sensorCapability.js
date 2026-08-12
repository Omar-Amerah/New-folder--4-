"use strict";

// Authoritative sensor capability calculation.
//
// Every live hull has the same base detection range. Sensor components add their
// authored bonus linearly within their coverage family. General and Directed
// Sensors remain separate, and components aimed along the same bearing combine
// their bonuses wherever their facing cones overlap.

const { BALANCE } = require("./balanceConfig");
const { PARTS } = require("./components");
const { getCommandAuraMultiplier } = require("./commandAuras");
const RotationRules = require("../../public/src/shared/rotationRules");

const SENSOR_BALANCE = BALANCE.visibility || {};
const EMPTY_DIRECTED_COVERAGE = Object.freeze([]);

const BASE_SENSOR_RANGE = Number(SENSOR_BALANCE.baseSensorRange) || 460;

function normalizedSensorRole(part) {
  if (part?.sensorRole === "directed") return "directed";
  if (part?.sensorRole === "omniSmall") return "omniSmall";
  return "omniLarge";
}

function compareOmniBonuses(a, b) {
  return (Number(b.bonus) || 0) - (Number(a.bonus) || 0)
    || (Number(a.index) || 0) - (Number(b.index) || 0);
}

function compareDirectedBonuses(a, b) {
  return (Number(b.bonus) || 0) - (Number(a.bonus) || 0)
    || (Number(a.index) || 0) - (Number(b.index) || 0);
}

function isOperationalSensorSource(entity) {
  if (!entity || entity.alive === false || entity.removed) return false;
  if (entity.stationType === "home" || entity.stationType === "relay") {
    return entity.state === "operational";
  }
  if (entity.type === "ship" || entity.entityType === "ship" || entity.design?.length > 0) {
    return entity.hp > 0 && entity.alive !== false;
  }
  return true;
}

function componentOperationalBonus(ship, index, part) {
  const hpValue = ship.componentHp?.[index];
  const hp = hpValue === undefined ? Number(part.hp) || 1 : Number(hpValue);
  if (!(hp > 0)) return 0;
  const powerRecord = ship.componentPower?.byComponentIndex?.[index];
  if (powerRecord && powerRecord.operationalMultiplier <= 0) return 0;
  const operationalFactor = powerRecord
    ? Math.min(1, Math.max(0, Number(powerRecord.operationalMultiplier) || 0))
    : 1;
  return (Number(part.sensorRangeBonus) || 0) * operationalFactor;
}

function sensorComponentBonuses(ship) {
  const bonuses = [];
  if (!ship?.design?.length) return bonuses;
  for (let index = 0; index < ship.design.length; index += 1) {
    const module = ship.design[index];
    const part = PARTS[module?.type];
    if (!(Number(part?.sensorRangeBonus) > 0)) continue;
    const bonus = componentOperationalBonus(ship, index, part);
    if (!(bonus > 0)) continue;
    const role = normalizedSensorRole(part);
    const rotation = RotationRules.normalizeRotation(module.rotation, part.allowedRotations, module.x);
    bonuses.push({
      index,
      bonus,
      role,
      type: module.type,
      relativeAngle: RotationRules.directionalFootprintToShipRadians(rotation, part.footprint),
      arcRadians: Math.max(0, Number(part.sensorArc) || 0) * Math.PI / 180
    });
  }
  return bonuses;
}

function stackedSensorRangeBonus(bonuses) {
  return [...bonuses]
    .sort(compareOmniBonuses)
    .reduce((total, entry) => total + (Number(entry.bonus) || 0), 0);
}

function stackedDirectedSensorCoverage(bonuses, baseRange, auraMultiplier = 1) {
  const stacked = [...bonuses]
    .sort(compareDirectedBonuses)
    .map((entry) => ({
      ...entry,
      effectiveBonus: Number(entry.bonus) || 0
    }));
  const aura = Math.max(0, Number(auraMultiplier) || 0);
  return stacked.map((entry) => {
    let overlappingBonus = 0;
    for (const candidate of stacked) {
      const sameBearing = Math.abs(
        RotationRules.angleDifference(entry.relativeAngle, candidate.relativeAngle)
      ) < 1e-9;
      if (sameBearing && candidate.arcRadians + 1e-9 >= entry.arcRadians) {
        overlappingBonus += candidate.effectiveBonus;
      }
    }
    return {
      componentIndex: entry.index,
      relativeAngle: entry.relativeAngle,
      arcRadians: entry.arcRadians,
      halfAngle: entry.arcRadians * 0.5,
      range: Math.max(0, (baseRange + overlappingBonus) * aura)
    };
  });
}

function getHullBaseSensorRange() {
  return BASE_SENSOR_RANGE;
}

function designSensorProfile(design) {
  const baseRange = getHullBaseSensorRange();
  const ship = {
    alive: true,
    hp: 1,
    design: Array.isArray(design) ? design : []
  };
  const bonuses = sensorComponentBonuses(ship);
  const omni = bonuses.filter((entry) => entry.role !== "directed");
  const directed = bonuses.filter((entry) => entry.role === "directed").sort(compareDirectedBonuses);
  const directedCoverage = stackedDirectedSensorCoverage(directed, baseRange);
  const strongestDirected = directedCoverage.reduce(
    (strongest, entry) => !strongest || entry.range > strongest.range ? entry : strongest,
    null
  );
  return {
    baseRange,
    omniRange: baseRange + stackedSensorRangeBonus(omni),
    directedRange: strongestDirected?.range || 0,
    directedArc: strongestDirected?.arcRadians || 0,
    sensorComponentCount: bonuses.length,
    directedSensorCount: directed.length
  };
}

function cacheGenerationFor(room) {
  const mode = room?.rules?.visibilityMode;
  if (mode !== "sensors" && mode !== "dark") return 0;
  return Number(room._visibilityGeneration) || 1;
}

function staticProfile(range) {
  return {
    omniRange: Math.max(0, Number(range) || 0),
    directed: EMPTY_DIRECTED_COVERAGE
  };
}

function effectiveSensorProfile(entity, room = null) {
  if (!entity || !isOperationalSensorSource(entity)) return staticProfile(0);
  const cacheGeneration = cacheGenerationFor(room);
  if (cacheGeneration > 0 && entity._sensorProfileCacheGeneration === cacheGeneration) {
    return entity._sensorProfileCacheValue;
  }

  if (entity.stationType === "home") {
    return staticProfile(Number(SENSOR_BALANCE.homeStationSensorRange) || 1400);
  }
  if (entity.stationType === "relay") {
    return staticProfile(Number(SENSOR_BALANCE.relayStationSensorRange) || 950);
  }
  if (entity.type === "drone" || entity.entityType === "drone") {
    return staticProfile(Number(entity.sensorRange) || 220);
  }

  const base = getHullBaseSensorRange();
  const bonuses = sensorComponentBonuses(entity);
  const auraMultiplier = Math.max(0, getCommandAuraMultiplier(entity, "sensorRangeMultiplier"));
  if (bonuses.length === 0) {
    const profile = {
      omniRange: Math.max(0, base * auraMultiplier),
      directed: EMPTY_DIRECTED_COVERAGE
    };
    if (cacheGeneration > 0) {
      entity._sensorProfileCacheGeneration = cacheGeneration;
      entity._sensorProfileCacheValue = profile;
    }
    return profile;
  }
  const omni = [];
  const directedBonuses = [];
  for (const entry of bonuses) {
    if (entry.role === "directed") directedBonuses.push(entry);
    else omni.push(entry);
  }
  const directed = stackedDirectedSensorCoverage(directedBonuses, base, auraMultiplier);
  const profile = {
    omniRange: Math.max(0, (base + stackedSensorRangeBonus(omni)) * auraMultiplier),
    directed
  };
  if (cacheGeneration > 0) {
    entity._sensorProfileCacheGeneration = cacheGeneration;
    entity._sensorProfileCacheValue = profile;
  }
  return profile;
}

function effectiveSensorRange(entity, room = null) {
  return effectiveSensorProfile(entity, room).omniRange;
}

function getSensorCapability(entity, room = null) {
  const profile = effectiveSensorProfile(entity, room);
  return {
    range: profile.omniRange,
    directed: profile.directed,
    strength: 1,
    enabled: profile.omniRange > 0 || profile.directed.some((entry) => entry.range > 0)
  };
}

module.exports = {
  getSensorCapability,
  effectiveSensorProfile,
  effectiveSensorRange,
  sensorComponentBonuses,
  stackedSensorRangeBonus,
  stackedDirectedSensorCoverage,
  designSensorProfile,
  isOperationalSensorSource,
  getHullBaseSensorRange,
  BASE_SENSOR_RANGE,
  normalizedSensorRole
};
