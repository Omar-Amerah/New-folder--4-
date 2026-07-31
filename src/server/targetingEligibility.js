"use strict";

// Authoritative target eligibility and selection helpers for Phase Three.
// These helpers mirror the exact predicates used by combat.js and stationCombat.js
// so that cadenced, cached and shared-targeting paths do not drift from the
// legacy paths.

const Relationships = require("./relationships");
const Visibility = require("./visibility");
const { fastHypot, compareIdStrings, angleDifference } = require("./utils");

function stableId(value) {
  return String(value?.id ?? value ?? "");
}

function isStableIdBefore(a, b) {
  return compareIdStrings(stableId(a), stableId(b)) < 0;
}

function getCandidatePriorityIndex(candidate, priorityList) {
  if (!priorityList || !priorityList.length) return -1;
  const type = candidate.type;

  if (type === "drone") {
    const droneType = candidate.entity.type;
    const droneClass = droneType === "fighter" ? "droneFighter" : "droneOther";
    let idx = priorityList.indexOf(droneClass);
    if (idx === -1) idx = priorityList.indexOf("drone");
    return idx;
  }

  if (type === "projectile") {
    if (candidate.entity.type === "missile" && candidate.entity.subtype) {
      let idx = priorityList.indexOf(candidate.entity.subtype);
      if (idx !== -1) return idx;
    }
    let idx = priorityList.indexOf(candidate.entity.type);
    if (idx === -1) idx = priorityList.indexOf("projectile");
    return idx;
  }

  if (type === "ship") {
    return priorityList.indexOf("ship");
  }

  if (type === "decoy") {
    return priorityList.indexOf("decoy");
  }

  return -1;
}

function isCandidateTargetingProtected(candidate, protectedShipId, room, shipOwnerId) {
  if (!protectedShipId) return false;
  const ent = candidate.entity;

  if (candidate.type === "projectile") {
    return ent.targetId === protectedShipId;
  }

  if (candidate.type === "drone") {
    return ent.targetId === protectedShipId || ent.parentShipId === protectedShipId;
  }

  if (candidate.type === "ship") {
    return ent.combatTargetId === protectedShipId || ent.focusTargetId === protectedShipId;
  }

  return false;
}

// Stable tie-breaking for two candidates. Returns true when `candidate` is
// strictly better than `bestCandidate` according to the current rules.
function isCandidateBetter(candidate, candidateDistSq, bestCandidate, bestDistSq, priorityList, protectedShipId, room, shipOwnerId) {
  if (!bestCandidate) return true;

  const pA = getCandidatePriorityIndex(candidate, priorityList);
  const pB = getCandidatePriorityIndex(bestCandidate, priorityList);
  if (pA !== pB) return pA < pB;

  const tA = isCandidateTargetingProtected(candidate, protectedShipId, room, shipOwnerId);
  const tB = isCandidateTargetingProtected(bestCandidate, protectedShipId, room, shipOwnerId);
  if (tA !== tB) return tA;

  if (Math.abs(candidateDistSq - bestDistSq) > 1e-4) return candidateDistSq < bestDistSq;

  return isStableIdBefore(candidate.entity, bestCandidate.entity);
}

function _viewerTeam(room, ownerId, team) {
  if (!ownerId) return team || null;
  const player = room?.players?.get?.(ownerId);
  return player?.team || team || null;
}

function _isLiving(target) {
  if (!target) return false;
  if (target.alive === false) return false;
  if (target.destroyed) return false;
  if (target.state === "disabled") return false;
  if (typeof target.life === "number" && target.life <= 0) return false;
  return true;
}

function _isInArc(originX, originY, weaponAngle, arcRadians, targetX, targetY) {
  if (!Number.isFinite(arcRadians) || arcRadians >= Math.PI * 2) return true;
  const angleToTarget = Math.atan2(targetY - originY, targetX - originX);
  return Math.abs(angleDifference(weaponAngle, angleToTarget)) <= arcRadians / 2;
}

function _targetPosition(target) {
  return { x: target?.x ?? 0, y: target?.y ?? 0 };
}

// Validates a non-projectile target for ordinary/ship weapons.
function isOrdinaryWeaponTargetValid(room, attacker, target, now, range, options = {}) {
  if (!_isLiving(target)) return false;
  if (target.id === attacker?.id) return false;

  const ownerId = attacker?.ownerId;
  if (!Relationships.areEntityEnemies(room, ownerId, target)) return false;

  const viewerTeam = _viewerTeam(room, ownerId, attacker?.team);
  if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, target, now)) {
    return false;
  }

  const pos = _targetPosition(target);
  const distance = fastHypot(pos.x - options.originX, pos.y - options.originY);
  if (distance > range) return false;

  if (options.arcRadians > 0 && !Number.isNaN(options.weaponAngle) && !_isInArc(options.originX, options.originY, options.weaponAngle, options.arcRadians, pos.x, pos.y)) {
    return false;
  }

  if (options.ignoreDrones && target.type === "drone") return false;

  return true;
}

function _isProjectileAlive(bullet) {
  return bullet && bullet.interceptable && bullet.life > 0;
}

// Validates a single Point Defence candidate. `candidate` is { type, entity }.
function isPointDefenceTargetValid(room, ownerId, candidate, range, now, options = {}) {
  if (!candidate || !candidate.entity) return false;
  const ent = candidate.entity;
  const type = candidate.type;

  if (type === "projectile") {
    if (!_isProjectileAlive(ent)) return false;
    if (!Relationships.areEnemies(room, ownerId, ent.ownerId)) return false;
  } else if (type === "drone") {
    if (!_isLiving(ent) || room?.drones?.get?.(ent.id) !== ent) return false;
    if (!Relationships.areEnemies(room, ownerId, ent.ownerId)) return false;
    const viewerTeam = _viewerTeam(room, ownerId, options.team);
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, ent, now)) return false;
  } else if (type === "ship") {
    if (!_isLiving(ent)) return false;
    if (!Relationships.areEnemies(room, ownerId, ent.ownerId)) return false;
    const viewerTeam = _viewerTeam(room, ownerId, options.team);
    if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, ent, now)) return false;
  } else if (type === "decoy") {
    if (now >= ent.expiresAt || !Relationships.areEnemies(room, ownerId, ent.ownerId)) return false;
  } else {
    return false;
  }

  const pos = _targetPosition(ent);
  const distance = fastHypot(pos.x - options.originX, pos.y - options.originY);
  if (distance > range) return false;

  if (options.arcRadians > 0 && !Number.isNaN(options.weaponAngle) && !_isInArc(options.originX, options.originY, options.weaponAngle, options.arcRadians, pos.x, pos.y)) {
    return false;
  }

  if (options.reservations) {
    const reserved = options.reservations.get(ent.id) || 0;
    let pool = Infinity;
    if (type === "projectile") pool = ent.hp !== undefined ? ent.hp : (ent.damage || 20);
    else if (type === "drone") pool = ent.hull || 0;
    else if (type === "decoy") pool = 1;
    if (pool - reserved <= 0.001) return false;
  }

  if (options.priorityList) {
    if (getCandidatePriorityIndex(candidate, options.priorityList) === -1) return false;
  }

  return true;
}

// Validates a station battery target. This mirrors findStationWeaponTarget's
// exact filter excluding line-of-sight and safe-zone checks, which the caller
// must perform if the original algorithm requires them.
function isStationWeaponTargetValid(room, station, target, identity, now, range, options = {}) {
  if (!target || target.id === station?.id) return false;
  if (!_isLiving(target)) return false;
  if (!Relationships.areEnemies(room, identity, target.ownerId)) return false;
  if (Visibility.usesSensorVisibility(room) && identity && !Visibility.canTeamTargetEntity(room, identity, target, now)) return false;

  const pos = _targetPosition(target);
  const dist = fastHypot(pos.x - options.originX, pos.y - options.originY);
  if (dist > range) return false;

  if (options.arcRadians > 0 && !Number.isNaN(options.weaponAngle) && !_isInArc(options.originX, options.originY, options.weaponAngle, options.arcRadians, pos.x, pos.y)) {
    return false;
  }

  return true;
}

// Validates a drone target for defensive-weapon diversion.
function isDroneFireTargetValid(room, ship, drone, now, range, options = {}) {
  if (!drone || drone.destroyed) return false;
  if (!Relationships.areEnemies(room, ship?.ownerId, drone.ownerId)) return false;

  const viewerTeam = _viewerTeam(room, ship?.ownerId, ship?.team);
  if (Visibility.usesSensorVisibility(room) && viewerTeam && !Visibility.canTeamTargetEntity(room, viewerTeam, drone, now)) return false;

  const pos = _targetPosition(drone);
  const distance = fastHypot(pos.x - options.originX, pos.y - options.originY);
  if (distance > range) return false;

  if (options.arcRadians > 0 && !Number.isNaN(options.weaponAngle) && !_isInArc(options.originX, options.originY, options.weaponAngle, options.arcRadians, pos.x, pos.y)) {
    return false;
  }

  return true;
}

module.exports = {
  stableId,
  isStableIdBefore,
  getCandidatePriorityIndex,
  isCandidateTargetingProtected,
  isCandidateBetter,
  isOrdinaryWeaponTargetValid,
  isPointDefenceTargetValid,
  isStationWeaponTargetValid,
  isDroneFireTargetValid
};
