"use strict";

// Authoritative sensor capability calculation.
//
// Small and Large Sensors occupy one diminishing stack. Large Sensors are
// ordered first even if damaged, so adding a Small Sensor can never consume the
// best multiplier ahead of an operational Large Sensor. Directed Sensors use a
// separate bonus-sorted stack, so Large Directed Sensors take priority over
// Small Directed Sensors. Components aimed along the same bearing combine their
// diminished bonuses wherever their facing cones overlap.

const { BALANCE } = require("./balanceConfig");
const { PARTS } = require("./components");
const { getCommandAuraMultiplier } = require("./commandAuras");
const RotationRules = require("../../public/src/shared/rotationRules");

const SENSOR_BALANCE = BALANCE.visibility || {};
const EMPTY_DIRECTED_COVERAGE = Object.freeze([]);

const HULL_BASE_RANGES = Object.freeze({
  light: Number(SENSOR_BALANCE.hullBaseSensorRange?.light) || 520,
  medium: Number(SENSOR_BALANCE.hullBaseSensorRange?.medium) || 460,
  heavy: Number(SENSOR_BALANCE.hullBaseSensorRange?.heavy) || 400,
  capital: Number(SENSOR_BALANCE.hullBaseSensorRange?.capital) || 480
});

const DIMINISHING_STACKING = Object.freeze({
  first: 1.0,
  second: 0.65,
  third: 0.45,
  rest: 0.25
});

function stackingMultiplier(index) {
  if (index <= 0) return DIMINISHING_STACKING.first;
  if (index === 1) return DIMINISHING_STACKING.second;
  if (index === 2) return DIMINISHING_STACKING.third;
  return DIMINISHING_STACKING.rest;
}

function normalizedSensorRole(part) {
  if (part?.sensorRole === "directed") return "directed";
  if (part?.sensorRole === "omniSmall") return "omniSmall";
  // The old sensorArray did not carry a role. Treat any legacy range component
  // as Large so saved designs preserve their former priority and capability.
  return "omniLarge";
}

function sensorRolePriority(role) {
  return role === "omniSmall" ? 1 : 0;
}

function compareOmniBonuses(a, b) {
  const priority = sensorRolePriority(a.role) - sensorRolePriority(b.role);
  if (priority) return priority;
  return (Number(b.bonus) || 0) - (Number(a.bonus) || 0)
    || (Number(a.index) || 0) - (Number(b.index) || 0);
}

function compareDirectedBonuses(a, b) {
  return (Number(b.bonus) || 0) - (Number(a.bonus) || 0)
    || (Number(a.index) || 0) - (Number(b.index) || 0);
}

function isOperationalSensorSource(entity) {
  if (!entity || entity.alive === false || entity.removed) return false;
  if (entity.type === "ship" || entity.entityType === "ship" || entity.design?.length > 0) {
    return entity.hp > 0 && entity.alive !== false;
  }
  if (entity.stationType === "home" || entity.stationType === "relay") {
    return entity.state !== "disabled" && entity.state !== "destroyed";
  }
  return true;
}

function componentOperationalBonus(ship, index, part) {
  const hpValue = ship.componentHp?.[index];
  const hp = hpValue === undefined ? Number(part.hp) || 1 : Number(hpValue);
  const max = Number(ship.componentMaxHp?.[index]) || Number(part.hp) || 1;
  if (!(hp > 0)) return 0;
  const powerRecord = ship.componentPower?.byComponentIndex?.[index];
  if (powerRecord && powerRecord.operationalMultiplier <= 0) return 0;
  const healthFactor = Math.min(1, Math.max(0, hp / max));
  const operationalFactor = powerRecord
    ? Math.min(1, Math.max(0, Number(powerRecord.operationalMultiplier) || 0))
    : 1;
  return (Number(part.sensorRangeBonus) || 0) * operationalFactor * (0.5 + 0.5 * healthFactor);
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
  bonuses.sort(compareOmniBonuses);
  let total = 0;
  for (let index = 0; index < bonuses.length; index += 1) {
    total += (Number(bonuses[index].bonus) || 0) * stackingMultiplier(index);
  }
  return total;
}

function stackedDirectedSensorCoverage(bonuses, baseRange, auraMultiplier = 1) {
  const stacked = [...bonuses]
    .sort(compareDirectedBonuses)
    .map((entry, stackIndex) => ({
      ...entry,
      effectiveBonus: (Number(entry.bonus) || 0) * stackingMultiplier(stackIndex)
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

function getHullBaseSensorRange(massClass) {
  return HULL_BASE_RANGES[String(massClass).toLowerCase()] || HULL_BASE_RANGES.medium;
}

function designSensorProfile(design, massClass = "medium") {
  const baseRange = getHullBaseSensorRange(massClass);
  const ship = {
    alive: true,
    hp: 1,
    design: Array.isArray(design) ? design : [],
    stats: { massClass }
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

  const base = getHullBaseSensorRange(entity.stats?.massClass || "medium");
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
  HULL_BASE_RANGES,
  DIMINISHING_STACKING,
  stackingMultiplier,
  normalizedSensorRole
};
