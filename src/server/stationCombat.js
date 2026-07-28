// Authoritative combat hooks for stations. Kept separate from ship combat so
// the larger station module scale and disabled state are handled cleanly.
"use strict";

const { PARTS } = require("./components");
const { BALANCE } = require("./balanceConfig");
const { getShipComponentIndexes } = require("./componentIndexes");
const { getComponentPowerMultiplier } = require("./componentPower");
const { isComponentAlive, markComponentDamageChanged } = require("./componentHealth");
const { addBullet } = require("./projectiles");
const { angleDifference, fastHypot, rngRange, rotateToward } = require("./utils");
const TurretRules = require("../../public/src/shared/turretRules");
const { normalizeRotation } = require("./shipDesign");
const { isInSafeZone, areEnemies } = require("./combat");

const STATION_MODULE_SCALE = 36;
const GRID_CENTER = 7;
const SHIELD_ABSORPTION = 0.95;

function moduleRotationToRadians(rotation) {
  return normalizeRotation(rotation) * Math.PI / 180 * 0.5;
}

function initStationCombatRuntime(station) {
  const len = station.design ? station.design.length : 0;
  if (!station.weaponCooldowns) station.weaponCooldowns = new Array(len).fill(0);
  if (!station.weaponAngles) station.weaponAngles = station.design.map((m) => moduleRotationToRadians(m.rotation || 0));
  if (!station.weaponAimTargetIds) station.weaponAimTargetIds = new Array(len).fill(null);
  if (!station.weaponFireTargetIds) station.weaponFireTargetIds = new Array(len).fill(null);
  if (!station.weaponComponentTargetIds) station.weaponComponentTargetIds = new Array(len).fill(-1);
  if (!station.weaponComponentTargetIndices) station.weaponComponentTargetIndices = new Array(len).fill(-1);
  if (!station.weaponComponentRetargetAt) station.weaponComponentRetargetAt = new Array(len).fill(0);
  if (!station.weaponDesiredAngles) station.weaponDesiredAngles = new Array(len).fill(null);
  if (!station.weaponBeamContacts) station.weaponBeamContacts = new Array(len).fill(null);
  if (!station.beamEffectsAt) station.beamEffectsAt = new Array(len).fill(0);
  if (!station.moduleScale) station.moduleScale = STATION_MODULE_SCALE;
  if (!station._derivedComponentIndexes) getShipComponentIndexes(station);
}

function liveStations(room) {
  return (room.stations || []).filter((s) => s.alive !== false && s.state !== "disabled");
}

function stationModuleWorldPosition(station, index) {
  const module = station.design[index];
  if (!module) return { x: station.x, y: station.y };
  const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };
  const w = footprint.width || 1;
  const h = footprint.height || 1;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const scale = station.moduleScale || STATION_MODULE_SCALE;
  const localX = (module.x + cx - GRID_CENTER) * scale;
  const localY = (module.y + cy - GRID_CENTER) * scale;
  const cos = Math.cos(station.angle || 0);
  const sin = Math.sin(station.angle || 0);
  return {
    x: station.x + localX * cos - localY * sin,
    y: station.y + localX * sin + localY * cos
  };
}

function weaponFacingAngle(station, index) {
  const module = station.design[index];
  return (station.angle || 0) + moduleRotationToRadians((module && module.rotation) || 0);
}

function isTargetInWeaponArc(station, index, target) {
  const module = station.design[index];
  const part = PARTS[module.type] || PARTS.frame;
  const weapon = part.weapon || { arc: 360 };
  const arc = (weapon.arc || 360) * Math.PI / 180;
  if (arc >= Math.PI * 2) return true;
  const origin = stationModuleWorldPosition(station, index);
  const angleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
  return Math.abs(angleDifference(weaponFacingAngle(station, index), angleToTarget)) <= arc / 2;
}

function findStationWeaponTarget(room, station, index, targets) {
  const module = station.design[index];
  const part = PARTS[module.type] || PARTS.frame;
  const weapon = part.weapon;
  if (!weapon) return null;
  const origin = stationModuleWorldPosition(station, index);
  const range = weapon.range || 0;
  const rangeSq = range * range;
  let best = null;
  let bestDist = Infinity;
  for (const target of targets || []) {
    if (!target || target.id === station.id) continue;
    if (target.alive === false || target.state === "disabled") continue;
    if (!areEnemies(room, station.ownerId, target.ownerId)) continue;
    if (isInSafeZone(room, target.x, target.y, target)) continue;
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;
    if (!isTargetInWeaponArc(station, index, target)) continue;
    if (distSq < bestDist) {
      best = target;
      bestDist = distSq;
    }
  }
  return best;
}

function applyComponentDamage(station, amount) {
  let left = amount;
  let applied = 0;
  const order = [];
  for (let i = 0; i < station.componentHp.length; i += 1) {
    if (station.componentHp[i] > 0) order.push(i);
  }
  for (const i of order) {
    if (left <= 0) break;
    const hp = station.componentHp[i];
    const dealt = Math.min(hp, left);
    station.componentHp[i] -= dealt;
    station.hp -= dealt;
    markComponentDamageChanged(station, i);
    applied += dealt;
    left -= dealt;
  }
  station.healthRevision = (station.healthRevision || 0) + 1;
  return applied;
}

function damageStation(room, station, damage, attackerId, now, sourceX, sourceY, options = {}) {
  if (damage <= 0 || station.alive === false) return 0;
  const shieldMultiplier = Number.isFinite(Number(options.shieldDamageMultiplier)) ? options.shieldDamageMultiplier : 1;
  const hullMultiplier = Number.isFinite(Number(options.hullDamageMultiplier)) ? options.hullDamageMultiplier : 1;

  let hullDamage = damage * hullMultiplier;
  if (station.shield > 0) {
    const shieldDamage = damage * shieldMultiplier;
    const blockedShieldDamage = Math.min(station.shield, shieldDamage);
    station.shield = Math.max(0, station.shield - blockedShieldDamage);
    const absorbedRatio = shieldDamage > 0 ? blockedShieldDamage / shieldDamage : 0;
    const absorbedHullDamage = hullDamage * absorbedRatio;
    const overflowHullDamage = hullDamage - absorbedHullDamage;
    const bleedThroughDamage = absorbedHullDamage * (1 - SHIELD_ABSORPTION);
    hullDamage = bleedThroughDamage + overflowHullDamage;
  }

  const applied = applyComponentDamage(station, hullDamage);
  if (applied > 0) {
    station.lastDamagedBy = attackerId || station.lastDamagedBy;
    station.lastDamagedAt = now;
  }

  const infra = BALANCE.infrastructure || {};
  const cfg = station.stationType === "home" ? infra.homeStation : infra.relayStation;
  const threshold = (station.maxHp || 1) * (cfg?.disabledHpRatio || 0.1);
  if (station.hp <= threshold && station.state !== "disabled") {
    station.state = "disabled";
    station.alive = false;
    station.disabledAt = now;
    station.stateRevision = (station.stateRevision || 0) + 1;
  }

  return applied;
}

function updateStationWeapons(room, stations, ships, dt, now) {
  if (!Array.isArray(stations) || stations.length === 0) return;
  const targets = (ships || []).filter((s) => s && s.alive !== false);
  for (const station of stations) {
    if (station.state !== "operational" || station.alive === false) continue;
    initStationCombatRuntime(station);
    const indexes = getShipComponentIndexes(station);
    for (const i of indexes.weaponIndices) {
      station.weaponCooldowns[i] = Math.max(0, (station.weaponCooldowns[i] || 0) - dt);
      if (!isComponentAlive(station, i)) {
        station.weaponAimTargetIds[i] = null;
        station.weaponFireTargetIds[i] = null;
        station.weaponAngles[i] = station.weaponAngles[i] ?? moduleRotationToRadians(0);
        continue;
      }
      const powerMultiplier = getComponentPowerMultiplier(station, i);
      if (powerMultiplier <= 0) {
        station.weaponAimTargetIds[i] = null;
        station.weaponFireTargetIds[i] = null;
        station.weaponAngles[i] = station.weaponAngles[i] ?? moduleRotationToRadians(0);
        continue;
      }
      const module = station.design[i];
      const part = PARTS[module.type] || PARTS.frame;
      const weapon = part.weapon;
      if (!weapon) continue;

      const target = findStationWeaponTarget(room, station, i, targets);
      const origin = stationModuleWorldPosition(station, i);
      const defaultRelative = moduleRotationToRadians(module.rotation || 0);
      let desiredRelative = defaultRelative;
      let isTracking = false;

      if (target) {
        const worldAngleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
        const relativeAngleToTarget = angleDifference(station.angle || 0, worldAngleToTarget);
        const arc = (weapon.arc || 360) * Math.PI / 180;
        if (Math.abs(angleDifference(defaultRelative, relativeAngleToTarget)) <= arc / 2) {
          desiredRelative = relativeAngleToTarget;
          isTracking = true;
        }
      }

      const turnRate = TurretRules.turnRateFor(weapon);
      const currentRelative = Number.isFinite(station.weaponAngles[i]) ? station.weaponAngles[i] : defaultRelative;
      station.weaponAngles[i] = rotateToward(currentRelative, desiredRelative, turnRate * dt);
      station.weaponDesiredAngles[i] = desiredRelative;
      station.weaponAimTargetIds[i] = isTracking && target ? target.id : null;
      station.weaponFireTargetIds[i] = null;

      if (!isTracking || station.weaponCooldowns[i] > 0) continue;

      const family = weapon.type || "blaster";
      const worldWeaponAngle = (station.angle || 0) + station.weaponAngles[i];
      const worldAngleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
      const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));
      const alignmentThreshold = module.type === "pointDefense" ? 0.035 : 0.26;
      if (family !== "beam" && angleErr > alignmentThreshold) continue;

      const footprint = part.footprint || { width: 1, height: 1 };
      const longTiles = Math.max(footprint.width || 1, footprint.height || 1);
      const muzzleDist = TurretRules.muzzleTiles(module.type, family, longTiles) * (station.moduleScale || STATION_MODULE_SCALE);
      const muzzleX = origin.x + Math.cos(worldWeaponAngle) * muzzleDist;
      const muzzleY = origin.y + Math.sin(worldWeaponAngle) * muzzleDist;

      const spread = rngRange(() => Math.random(), -0.02, 0.02);
      const shotAngle = worldWeaponAngle + spread;
      const speed = weapon.projectileSpeed || 620;
      const range = weapon.range || 0;
      station.weaponFireTargetIds[i] = target.id;

      if (family === "blaster" || family === "bolt") {
        addBullet(room, {
          type: "bolt",
          ownerId: station.ownerId,
          targetId: target.id,
          targetComponentIndex: -1,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(shotAngle) * speed,
          vy: Math.sin(shotAngle) * speed,
          damage: weapon.damage || 10,
          shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
          hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
          life: range / speed,
          bornAt: now,
          armorInteractionSeconds: Math.min(1, weapon.reload || 1)
        });
      } else if (family === "missile") {
        addBullet(room, {
          type: "missile",
          subtype: module.type,
          interceptable: true,
          hp: weapon.missileHp || 20,
          ownerId: station.ownerId,
          targetId: target.id,
          targetComponentIndex: -1,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(shotAngle) * speed,
          vy: Math.sin(shotAngle) * speed,
          damage: weapon.damage || 20,
          shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
          hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
          tracking: weapon.tracking ?? 0.75,
          trackRemaining: weapon.trackTime ?? 1.4,
          trackingDelay: weapon.trackingDelay ?? 0.25,
          maxSpeed: speed * 1.45,
          life: range / speed,
          bornAt: now,
          age: 0,
          armorInteractionSeconds: Math.min(1, weapon.reload || 1)
        });
      } else if (family === "flak") {
        addBullet(room, {
          type: "flak",
          ownerId: station.ownerId,
          targetId: target.id,
          targetComponentIndex: -1,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(shotAngle) * speed,
          vy: Math.sin(shotAngle) * speed,
          damage: weapon.damage || 15,
          blastRadius: weapon.blastRadius || 45,
          blastDamage: weapon.blastDamage || 12,
          innerFullDamageRadius: weapon.innerFullDamageRadius || 0,
          falloffExponent: weapon.falloffExponent || 1,
          proximityFuseRadius: weapon.proximityFuseRadius || 40,
          shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
          hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
          life: range / speed,
          bornAt: now,
          armorInteractionSeconds: Math.min(1, weapon.reload || 1)
        });
      } else {
        continue;
      }
      station.weaponCooldowns[i] = weapon.reload || 1;
    }
  }
}

module.exports = {
  initStationCombatRuntime,
  liveStations,
  updateStationWeapons,
  damageStation,
  stationModuleWorldPosition,
  STATION_MODULE_SCALE
};
