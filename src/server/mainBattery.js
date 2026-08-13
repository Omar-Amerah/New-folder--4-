"use strict";

// Main battery and hold-facing calculations shared between combat and movement.
// This module sits below combat.js in the dependency graph so movement can
// consume weapon-profile logic without importing combat.js.

const { PARTS } = require("./components");
const { angleDifference, fastHypot } = require("./utils");
const { normalizeRotation } = require("./shipDesign");
const {
  moduleFootprintLocalPosition,
  moduleRotationToRadians,
  weaponFacingAngle,
  weaponModuleWorldPosition
} = require("./combat/weaponGeometry");
const {
  ensureEffectiveWeaponProfileCache,
  getEffectiveWeaponStatsInternal
} = require("./componentData");
const { getShipComponentIndexes } = require("./componentIndexes");
const { isComponentAlive } = require("./componentHealth");
const { getComponentPowerMultiplier } = require("./componentPower");
const { componentPerformance } = require("./heat");
const { targetAttackPoint } = require("./combat/componentTargeting");
const TurretRules = require("../../public/src/shared/turretRules");
const { segmentCircleHit } = require("./projectiles");
const { isSegmentStationClear } = require("./stationCollision");

function isInductionBeam(weapon) {
  return weapon && typeof weapon === "object"
    && Number.isFinite(Number(weapon.inductionHeatBasePerSecond))
    && Number.isFinite(Number(weapon.inductionHeatMaxPerSecond));
}

function asteroidBroadPhase(room, x1, y1, x2, y2, padding, scratch) {
  const asteroids = room.map?.asteroids || [];
  const index = room.spatialIndex;
  if (!index || typeof index.querySweptAabbUnordered !== "function") return asteroids;
  if (index.count("asteroids") !== asteroids.length) return asteroids;
  return index.querySweptAabbUnordered("asteroids", x1, y1, x2, y2, padding, scratch);
}

function roomScratch(room, key) {
  const bag = room._combatScratch || (room._combatScratch = {});
  return bag[key] || (bag[key] = []);
}

function isLineBlocked(room, x1, y1, x2, y2, margin = 0) {
  const candidates = asteroidBroadPhase(room, x1, y1, x2, y2, margin, roomScratch(room, "lineBlock"));
  for (let i = 0; i < candidates.length; i += 1) {
    const asteroid = candidates[i];
    if (!asteroid) continue;
    if (segmentCircleHit(x1, y1, x2, y2, asteroid.x, asteroid.y, asteroid.radius + margin)) return true;
  }

  return !isSegmentStationClear(room, x1, y1, x2, y2, margin, {
    ignoreStationContainingEndpoint: true,
    ignoreDoors: true
  });
}

function getWeaponTurnRate(weapon) {
  return TurretRules.turnRateFor(weapon);
}

function holdFacingAngle(angle) {
  let normalized = Number(angle) || 0;
  normalized %= Math.PI * 2;
  if (normalized <= -Math.PI) normalized += Math.PI * 2;
  if (normalized > Math.PI) normalized -= Math.PI * 2;
  return normalized;
}

function isTargetInWeaponArc(ship, module, target, arcRadians, hullAngle = ship.angle) {
  if (arcRadians >= Math.PI * 2) return true;

  const origin = weaponModuleWorldPosition(ship, module, hullAngle);
  const weaponFacing = weaponFacingAngle(ship, module, hullAngle);

  const point = targetAttackPoint(origin.x, origin.y, target);
  const angleToTarget = Math.atan2(point.y - origin.y, point.x - origin.x);

  return Math.abs(angleDifference(weaponFacing, angleToTarget)) <= arcRadians / 2;
}

// This signature intentionally contains no weapon cooldowns. Cooldown affects
// the next shot, not which hull orientation gives the best sustained coverage.
function getHoldWeaponFacingSignature(ship) {
  const cache = ensureEffectiveWeaponProfileCache(ship);
  const indexes = getShipComponentIndexes(ship).weaponIndices;
  const states = indexes.map((index) => [
    index,
    isComponentAlive(ship, index) ? 1 : 0,
    Math.round((Number(getComponentPowerMultiplier(ship, index)) || 0) * 1000),
    Math.round((Number(componentPerformance(ship, index)) || 0) * 1000)
  ].join(":"));
  return [
    cache?.revision || 0,
    ship?.designRevision || 0,
    ship?.componentAliveRevision || 0,
    ship?.powerRevision || 0,
    ship?.heatStateRevision || 0,
    states.join(",")
  ].join("|");
}

function holdFacingWeapons(ship) {
  const weapons = [];
  for (const index of getShipComponentIndexes(ship).weaponIndices) {
    const module = ship.design?.[index];
    const part = module ? PARTS[module.type] : null;
    if (!module || !part?.weapon || module.type === "repairBeam") continue;
    if (!isComponentAlive(ship, index)) continue;

    const power = Math.max(0, Number(getComponentPowerMultiplier(ship, index)) || 0);
    const thermal = Math.max(0, Number(componentPerformance(ship, index)) || 0);
    const activity = power * thermal;
    if (!(activity > 0)) continue;

    const effectiveWeapon = getEffectiveWeaponStatsInternal(ship, index) || part.weapon;
    const family = effectiveWeapon.type || part.weapon.type || "beam";
    if (family === "pointDefense" || family === "flak") continue;

    const range = Number(effectiveWeapon.range) || 0;
    const dps = Number.isFinite(Number(effectiveWeapon.combatDps))
      ? Math.max(0, Number(effectiveWeapon.combatDps))
      : (Number(effectiveWeapon.dps)
        || ((Number(effectiveWeapon.damage) || 0) * (Number(effectiveWeapon.fireRate) || 0)));
    const induction = isInductionBeam(effectiveWeapon) ? (Number(effectiveWeapon.inductionHeatMaxPerSecond) || 0) : 0;
    const tacticalOutput = isInductionBeam(effectiveWeapon) ? induction : dps;
    if (!(range > 0) || !(tacticalOutput > 0)) continue;

    const local = moduleFootprintLocalPosition(module);
    weapons.push({
      index,
      module,
      range,
      mountOffset: fastHypot(local.x, local.y),
      mountOffsetAngle: Math.atan2(local.y, local.x),
      arcRadians: Math.max(0, Math.min(Math.PI * 2, (Number(effectiveWeapon.arc) || 360) * Math.PI / 180)),
      mountAngle: moduleRotationToRadians(normalizeRotation(module.rotation)),
      expectedDps: tacticalOutput * activity
    });
  }
  return weapons;
}

const Targeting = require("./targetingEligibility");

function evaluateHoldFacing(room, ship, target, weapons, heading, now, groupRange = Infinity, reachMargin = 0) {
  let score = 0;
  let weaponCount = 0;
  let shortfall = 0;
  let shortfallCount = 0;

  for (const weapon of weapons) {
    const origin = weaponModuleWorldPosition(ship, weapon.module, heading);
    const point = targetAttackPoint(origin.x, origin.y, target);
    const distance = fastHypot(point.x - origin.x, point.y - origin.y);
    const excess = distance - weapon.range;
    const inGroup = weapon.range >= groupRange;
    if (excess > 0 && !inGroup) continue;

    if (!Targeting.isOrdinaryWeaponTargetValid(room, ship, target, now, excess > 0 ? distance : weapon.range, {
      originX: origin.x,
      originY: origin.y,
      arcRadians: weapon.arcRadians,
      weaponAngle: heading + weapon.mountAngle
    })) continue;
    if (isLineBlocked(room, origin.x, origin.y, point.x, point.y, 8)) continue;

    if (inGroup && distance > weapon.range - reachMargin) {
      shortfall = Math.max(shortfall, distance - (weapon.range - reachMargin));
      shortfallCount += 1;
    }
    if (excess > 0) continue;

    score += weapon.expectedDps;
    weaponCount += 1;
  }

  return { score, weaponCount, shortfall, shortfallCount };
}

const HOLD_COVERAGE_RANGE_GROUP_RATIO = 0.9;
const HOLD_COVERAGE_REACH_MARGIN = 12;

function evaluateHoldWeaponCoverage(room, ship, target, heading, now) {
  const weapons = holdFacingWeapons(ship);
  let longest = 0;
  for (const weapon of weapons) longest = Math.max(longest, weapon.range);
  const evaluated = evaluateHoldFacing(
    room,
    ship,
    target,
    weapons,
    holdFacingAngle(heading),
    now,
    longest * HOLD_COVERAGE_RANGE_GROUP_RATIO,
    HOLD_COVERAGE_REACH_MARGIN
  );
  return {
    usableDps: evaluated.score,
    usableWeaponCount: evaluated.weaponCount,
    shortfall: evaluated.shortfall,
    shortfallWeaponCount: evaluated.shortfallCount
  };
}

function mainBatterySignature(ship) {
  return [
    ensureEffectiveWeaponProfileCache(ship)?.revision || 0,
    ship?.designRevision || 0,
    ship?.componentAliveRevision || 0,
    ship?.powerRevision || 0,
    ship?.heatStateRevision || 0
  ].join("|");
}

const EMPTY_MAIN_BATTERY = Object.freeze({
  weapons: Object.freeze([]),
  longestRange: 0,
  groupRange: 0,
  standoffRange: 0,
  output: 0
});

function mainBatteryProfile(ship) {
  if (!ship || typeof ship !== "object") return EMPTY_MAIN_BATTERY;
  const signature = mainBatterySignature(ship);
  const cached = ship._mainBatteryProfile;
  if (cached && cached.signature === signature) return cached.profile;

  const all = holdFacingWeapons(ship);
  let profile = EMPTY_MAIN_BATTERY;
  if (all.length) {
    let longestRange = 0;
    for (const weapon of all) longestRange = Math.max(longestRange, weapon.range);
    const groupRange = longestRange * HOLD_COVERAGE_RANGE_GROUP_RATIO;
    const weapons = all.filter((weapon) => weapon.range >= groupRange);
    let reach = Infinity;
    let output = 0;
    for (const weapon of weapons) {
      reach = Math.min(reach, weapon.range - weapon.mountOffset);
      output += weapon.expectedDps;
    }
    profile = {
      weapons,
      longestRange,
      groupRange,
      standoffRange: Number.isFinite(reach) ? Math.max(0, reach) : 0,
      output
    };
  }
  ship._mainBatteryProfile = { signature, profile };
  return profile;
}

function mainBatteryOrbitRange(ship) {
  return mainBatteryProfile(ship).standoffRange;
}

function evaluateMainBatteryFacing(room, ship, target, heading, now) {
  const profile = mainBatteryProfile(ship);
  if (!profile.weapons.length) {
    return { output: 0, weaponCount: 0, totalOutput: 0 };
  }
  const evaluated = evaluateHoldFacing(
    room,
    ship,
    target,
    profile.weapons,
    holdFacingAngle(heading),
    now
  );
  return {
    output: evaluated.score,
    weaponCount: evaluated.weaponCount,
    totalOutput: profile.output
  };
}

function chooseHoldWeaponFacing(room, ship, target, now, previousHeading = null) {
  const weapons = holdFacingWeapons(ship);
  const currentHeading = holdFacingAngle(ship.angle || 0);
  const preferredHeading = Number.isFinite(Number(previousHeading))
    ? holdFacingAngle(previousHeading)
    : currentHeading;
  const targetPoint = targetAttackPoint(ship.x || 0, ship.y || 0, target);
  const targetBearing = Math.atan2(targetPoint.y - (ship.y || 0), targetPoint.x - (ship.x || 0));
  const candidates = [];
  const addCandidate = (angle) => {
    const candidate = holdFacingAngle(angle);
    if (candidates.some((existing) => Math.abs(angleDifference(existing, candidate)) < 1e-6)) return;
    candidates.push(candidate);
  };

  addCandidate(currentHeading);
  addCandidate(preferredHeading);
  addCandidate(targetBearing);
  for (const weapon of weapons) {
    if (weapon.arcRadians >= Math.PI * 2 - 1e-6) {
      if (weapon.mountOffset > 1e-6) addCandidate(targetBearing - weapon.mountOffsetAngle);
      continue;
    }
    const centre = targetBearing - weapon.mountAngle;
    addCandidate(centre);
    addCandidate(centre - weapon.arcRadians / 2);
    addCandidate(centre + weapon.arcRadians / 2);
  }

  const current = evaluateHoldFacing(room, ship, target, weapons, preferredHeading, now);
  let best = null;
  for (const heading of candidates) {
    const evaluated = evaluateHoldFacing(room, ship, target, weapons, heading, now);
    const turn = Math.min(
      Math.abs(angleDifference(currentHeading, heading)),
      Math.abs(angleDifference(preferredHeading, heading))
    );
    const candidate = { heading, ...evaluated, turn };
    const better = !best
      || candidate.score > best.score + 1e-6
      || (Math.abs(candidate.score - best.score) <= 1e-6 && candidate.weaponCount > best.weaponCount)
      || (Math.abs(candidate.score - best.score) <= 1e-6
        && candidate.weaponCount === best.weaponCount
        && (candidate.turn < best.turn - 1e-6
          || (Math.abs(candidate.turn - best.turn) <= 1e-6
            && candidate.heading < best.heading)));
    if (better) best = candidate;
  }

  return {
    heading: best?.heading ?? preferredHeading,
    score: best?.score || 0,
    weaponCount: best?.weaponCount || 0,
    currentScore: current.score,
    currentWeaponCount: current.weaponCount,
    signature: getHoldWeaponFacingSignature(ship)
  };
}

module.exports = {
  asteroidBroadPhase,
  roomScratch,
  isLineBlocked,
  isTargetInWeaponArc,
  getWeaponTurnRate,
  holdFacingAngle,
  getHoldWeaponFacingSignature,
  chooseHoldWeaponFacing,
  evaluateHoldWeaponCoverage,
  evaluateMainBatteryFacing,
  mainBatteryOrbitRange,
  mainBatteryProfile
};
