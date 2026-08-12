"use strict";

const { fastHypot, angleDifference, compareIdStrings } = require("../utils");
const { gameplayNow } = require("../gameplayTime");
const { canTeamTargetEntity, usesSensorVisibility } = require("../visibility");
const { isComponentAlive } = require("../componentHealth");
const { getMaxEffectiveWeaponRange } = require("../componentData");
const { getCommandAuraMultiplier } = require("../commandAuras");
const { PRIORITY_COMPONENT_TYPES } = require("../repairCache");
const Relationships = require("../relationships");
const TargetingTelemetry = require("../targetingTelemetry");
const TargetingCadence = require("../targetingCadence");
const Targeting = require("../targetingEligibility");
const { sanitizeCombatStyle } = require("../validation");
const { targetAttackPoint } = require("./componentTargeting");

function createTargetingRuntime({
  isLineBlocked,
  isTargetInWeaponArc,
  getWeaponTurnRate
}) {
  function stableId(value) {
    return String(value?.id ?? value ?? "");
  }

  function isStableIdBefore(a, b) {
    return compareIdStrings(stableId(a), stableId(b)) < 0;
  }

  function areEnemies(room, ownerA, ownerB) {
    return Relationships.areEnemies(room, ownerA, ownerB);
  }

  
  const ACQUISITION_MULTIPLIER = 1.05;
  
  // Once a target is chosen it is kept until it is substantially outside that
  // envelope. Dropping it the instant it steps past the edge means re-scanning
  // every tick and swapping between two enemies a few pixels apart, which reads as
  // a ship that cannot make up its mind and, under Hold, as one that keeps
  // starting and abandoning approaches.
  const TARGET_RETENTION_MULTIPLIER = 1.3;
  
  function maxShipWeaponAcquisitionRange(ship) {
  
    const base = getMaxEffectiveWeaponRange(ship) * ACQUISITION_MULTIPLIER;
  
    const sensorMult = getCommandAuraMultiplier(ship, "sensorRangeMultiplier");
  
    return sensorMult !== 1 ? base * sensorMult : base;
  
  }
  
  
  
  function enemyShipThreatScore(defendedShip, enemy, distance, acquisitionRange) {
  
    const proximity = acquisitionRange > 0
  
      ? Math.max(0, 1 - distance / acquisitionRange) * 80
  
      : 0;
  
    const weaponDps = Math.max(0, Number(enemy.stats?.weaponDps) || 0);
  
    const weaponThreat = Math.min(120, Math.sqrt(weaponDps) * 10);
  
    const attackingThisShip = enemy.focusTargetId === defendedShip.id
  
      || enemy.combatTargetId === defendedShip.id;
  
    return proximity + weaponThreat + (attackingThisShip ? 80 : 0);
  
  }
  
  function targetIsAheadOfShip(ship, point) {
  
    const dx = point.x - ship.x;
  
    const dy = point.y - ship.y;
  
    if (dx * dx + dy * dy < 1e-6) return true;
  
    const bearing = Math.atan2(dy, dx);
  
    return Math.abs(angleDifference(ship.angle || 0, bearing)) <= Math.PI / 2;
  
  }
  
  
  
  function findTarget(room, ship, ships) {
  
    let best = null;
  
    let bestDistance = Infinity;
  
    let bestScore = -Infinity;
  
    let bestFacingRank = -1;
  
    const range = maxShipWeaponAcquisitionRange(ship);
    let holdFallback = null;
    let holdRearFallback = null;
    const now = gameplayNow(room);
    const owner = room.players?.get?.(ship.ownerId);
    const viewerTeam = owner?.team || ship.team;
  
    const stations = (room.stations || []).filter((s) => s && s.alive !== false && s.state !== "destroyed");
    const targets = (ships || []).concat(stations);
    const preferForwardTarget = !ship.focusTargetId
      && sanitizeCombatStyle(ship.combatStyle) === "hold";
  
  
  
    if (ship.focusTargetId) {
  
      const focused = targets.find((other) => other.id === ship.focusTargetId && Relationships.areEntityEnemies(room, ship.ownerId, other) && canTeamTargetEntity(room, viewerTeam, other, now));
  
      if (focused && focused.alive) {
        if (focused.entityType === "station") return focused;
  
        const focusedDistance = fastHypot(focused.x - ship.x, focused.y - ship.y);
  
        if (focusedDistance <= range * 1.12
          && !TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, ship.x, ship.y, focused.x, focused.y, 8))) return focused;
  
      }
  
    }
  
    // Automatic stance movement owns one current target at a time. Charge, Orbit,
    // and Kite retain it until it ceases to be a living enemy. Hold may replace an
    // automatic target that is no longer locally engageable with another nearby
    // visible enemy, avoiding an unnecessary move away from its firing position.
    // An explicit focus target always remains authoritative while alive.
    if (ship.combatTargetId) {
  
      const current = targets.find((other) =>
        other.id === ship.combatTargetId
        && Relationships.areEntityEnemies(room, ship.ownerId, other)
        && canTeamTargetEntity(room, viewerTeam, other, now));
  
      if (current && current.alive) {
        const explicitFocus = ship.focusTargetId === current.id;
        if (explicitFocus || sanitizeCombatStyle(ship.combatStyle) !== "hold") return current;
        const currentPoint = targetAttackPoint(ship.x, ship.y, current);
        const currentDistance = fastHypot(currentPoint.x - ship.x, currentPoint.y - ship.y);
        // Keep the target while it is anywhere near the envelope, not only while
        // it is inside it. The retention margin is what stops a ship swapping
        // between two enemies straddling the range edge on alternate ticks.
        //
        // Past that margin the target is genuinely gone and is released, so the
        // ship acquires something it can actually reach -- or nothing. The
        // fallback below covers only the near-but-obstructed case: an enemy still
        // well inside the envelope with an asteroid briefly in the way is worth
        // keeping, an enemy that has left is not.
        if (currentDistance <= range * TARGET_RETENTION_MULTIPLIER) {
          if (!TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, ship.x, ship.y, currentPoint.x, currentPoint.y, 8))) {
            if (!preferForwardTarget || targetIsAheadOfShip(ship, currentPoint)) return current;
            // A rear target remains sticky unless a valid forward target exists.
            // This lets Hold keep firing when surrounded without turning its back
            // on an enemy already in front of the hull.
            holdRearFallback = current;
          }
          holdFallback = current;
        }
      }
  
    }
  
  
  
    const spatial = room.spatialIndex?.dynamicValid ? room.spatialIndex : null;
    const scratch = room._findTargetScratch || (room._findTargetScratch = { ships: [], stations: [], drones: [] });
  
    function evaluateCandidate(other) {
      if (!other.alive || !Relationships.areEntityEnemies(room, ship.ownerId, other)) return;
      if (usesSensorVisibility(room) && !canTeamTargetEntity(room, viewerTeam, other, now)) return;
      const point = targetAttackPoint(ship.x, ship.y, other);
      const distance = fastHypot(point.x - ship.x, point.y - ship.y);
      if (distance > range || TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, ship.x, ship.y, point.x, point.y, 8))) return;
      const score = enemyShipThreatScore(ship, other, distance, range);
      const facingRank = preferForwardTarget && targetIsAheadOfShip(ship, point) ? 1 : 0;
      if (facingRank > bestFacingRank
        || (facingRank === bestFacingRank
          && (score > bestScore || (score === bestScore && (distance < bestDistance || (distance === bestDistance && (!best || isStableIdBefore(other, best)))))))) {
        best = other;
        bestDistance = distance;
        bestScore = score;
        bestFacingRank = facingRank;
      }
    }
  
    if (spatial) {
      const shipCandidates = spatial.queryRangeUnordered("ships", ship.x, ship.y, range, scratch.ships);
      for (const other of shipCandidates) evaluateCandidate(other);
      const stationCandidates = spatial.queryRangeUnordered("stations", ship.x, ship.y, range, scratch.stations);
      for (const other of stationCandidates) evaluateCandidate(other);
    } else {
      for (const other of targets) evaluateCandidate(other);
    }
  
    if (holdRearFallback && bestFacingRank <= 0) best = holdRearFallback;
    if (!best && holdFallback) best = holdFallback;
  
  
  
    // Ordinary weapons retain their ship-first behaviour, but can defend
  
    // themselves against hostile drones when no enemy ship is currently valid.
  
    if (!best) {
      const droneCandidates = spatial ? spatial.queryRangeUnordered("drones", ship.x, ship.y, range, scratch.drones) : (room.drones?.values?.() || []);
      for (const drone of droneCandidates) {
        if (drone.destroyed || !areEnemies(room, ship.ownerId, drone.ownerId)) continue;
        const distance = fastHypot(drone.x - ship.x, drone.y - ship.y);
        if (distance <= range && !TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, ship.x, ship.y, drone.x, drone.y, 3))
          && (distance < bestDistance || (distance === bestDistance && (!best || isStableIdBefore(drone, best))))) {
          best = drone;
          bestDistance = distance;
        }
      }
    }
  
  
  
    return best;
  
  }
  
  
  
  const DRONE_THREAT_OVERRIDE_SCORE = 100;
  
  
  
  function canWeaponDefensivelyTargetDrones(weapon) {
  
    if (!weapon || weapon.type === "pointDefense") return false;
  
    // Use the effective live weapon profile: rapid, agile blasters may peel off
  
    // to defend the ship. Slow/high-impact families remain committed to ships.
  
    return weapon.type === "blaster"
  
      && (Number(weapon.fireRate) || 0) >= 3
  
      && getWeaponTurnRate(weapon) >= 3;
  
  }
  
  
  
  function droneThreatCloseRange(ship, weaponRange) {
  
    return Math.min(
  
      Math.max(0, Number(weaponRange) || 0),
  
      Math.max(140, (Number(ship.radius) || 0) * 4)
  
    );
  
  }
  
  
  
  function countNearbyArmedDrones(room, ship, swarmRange) {
  
    if (swarmRange <= 0) return 0;
  
    let count = 0;
  
    const droneTypes = require("../drones").CONFIG.types;
  
    for (const other of room.drones?.values?.() || []) {
  
      if (other.destroyed || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
  
      const otherConfig = droneTypes[other.type] || {};
  
      const armed = (Number(otherConfig.damage) || 0) > 0 && (Number(otherConfig.fireRate) || 0) > 0;
  
      if ((armed || other.targetId === ship.id)
  
        && fastHypot(other.x - ship.x, other.y - ship.y) <= swarmRange) {
  
        count += 1;
  
      }
  
    }
  
    return count;
  
  }
  
  
  
  function droneThreatScore(room, ship, drone, weaponRange, context = {}) {
  
    if (!drone || drone.destroyed) return -Infinity;
  
    const distance = fastHypot(drone.x - ship.x, drone.y - ship.y);
  
    const closeRange = droneThreatCloseRange(ship, weaponRange);
  
    const droneConfig = require("../drones").CONFIG.types[drone.type] || {};
  
    const weaponDps = Math.max(0, (Number(droneConfig.damage) || 0) * (Number(droneConfig.fireRate) || 0));
  
    const attackingShip = drone.targetId === ship.id;
  
    let score = 0;
  
  
  
    if (attackingShip) score += 70;
  
    if (weaponDps > 0) score += 20 + Math.min(20, weaponDps * 3);
  
    if (closeRange > 0 && distance <= closeRange) {
  
      score += 35 + 35 * (1 - distance / closeRange);
  
    }
  
  
  
    const targetIndex = Number.isInteger(drone.targetComponentIndex) ? drone.targetComponentIndex : -1;
  
    if (attackingShip && targetIndex >= 0 && isComponentAlive(ship, targetIndex)) {
  
      const hp = Number(ship.componentHp?.[targetIndex]) || 0;
  
      const maxHp = Math.max(1, Number(ship.componentMaxHp?.[targetIndex]) || hp);
  
      const type = ship.design?.[targetIndex]?.type;
  
      if (hp / maxHp <= 0.4 || PRIORITY_COMPONENT_TYPES.has(type)) score += 55;
  
    }
  
  
  
    const swarmRange = closeRange * 1.5;
  
    if (swarmRange > 0) {
  
      const nearbyHostiles = Number.isInteger(context.nearbyArmedCount)
  
        ? context.nearbyArmedCount
  
        : countNearbyArmedDrones(room, ship, swarmRange);
  
      if (nearbyHostiles >= 3) score += 20 + Math.min(32, (nearbyHostiles - 3) * 8);
  
    }
  
  
  
    return score;
  
  }
  
  
  
  function bestDroneFireTarget(room, ship, worldX, worldY, range, module = null, weapon = null) {
  
    let best = null;
  
    let bestScore = -Infinity;
  
    let bestDistance = Infinity;
  
    const closeRange = droneThreatCloseRange(ship, range);
  
    const nearbyArmedCount = countNearbyArmedDrones(room, ship, closeRange * 1.5);
  
    const now = gameplayNow(room);
    const owner = room.players?.get?.(ship.ownerId);
    const viewerTeam = owner?.team || ship.team;
  
    for (const drone of room.drones?.values?.() || []) {
  
      if (drone.destroyed || !areEnemies(room, ship.ownerId, drone.ownerId)) continue;
      if (usesSensorVisibility(room) && !canTeamTargetEntity(room, viewerTeam, drone, now)) continue;
  
      const distance = fastHypot(drone.x - worldX, drone.y - worldY);
  
      if (distance > range || TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, drone.x, drone.y, 3))) continue;
  
      const arcRadians = (Number(weapon?.arc) || 360) * Math.PI / 180;
  
      if (module && !isTargetInWeaponArc(ship, module, drone, arcRadians)) continue;
  
      const score = droneThreatScore(room, ship, drone, range, { nearbyArmedCount });
  
      if (score > bestScore
  
        || (score === bestScore && (distance < bestDistance
  
          || (distance === bestDistance && (!best || isStableIdBefore(drone, best)))))) {
  
        best = drone;
  
        bestScore = score;
  
        bestDistance = distance;
  
      }
  
    }
  
    return best ? { target: best, score: bestScore } : null;
  
  }
  
  
  
  // Targeting remains per weapon. Heavy/main weapons keep the assigned enemy
  
  // ship; only suitable defensive weapons may override it for a sufficiently
  
  // threatening drone. No per-weapon diversion changes ship.combatTargetId.
  
  function pickWeaponFireTarget(room, ship, ships, worldX, worldY, primary, range, options = {}) {
  
    let shipTarget = null;
    const now = gameplayNow(room);
    const owner = room.players?.get?.(ship.ownerId);
    const viewerTeam = owner?.team || ship.team;
  
    // A player-ordered focus is exclusive: no weapon may quietly peel off it for
    // a drone, however threatening that drone looks.
    let focusLocked = false;
  
    if (primary?.alive && !room.drones?.has?.(primary.id) && canTeamTargetEntity(room, viewerTeam, primary, now)) {
  
      focusLocked = ship.focusTargetId === primary.id
        && Relationships.areEntityEnemies(room, ship.ownerId, primary);
  
      // An explicit hostile station focus is exclusive for offensive weapons.
      // Keep the weapon tracking/waiting on the station until its surface is in
      // range instead of silently redirecting fire to a ship or drone.
      if (focusLocked && primary.entityType === "station") return primary;
  
      const primaryPoint = targetAttackPoint(worldX, worldY, primary);
      const distance = fastHypot(primaryPoint.x - worldX, primaryPoint.y - worldY);
  
      if (distance <= range && !TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, primaryPoint.x, primaryPoint.y, 8))) shipTarget = primary;
  
    }
  
  
  
    let bestDistance = Infinity;
  
    let bestShipScore = -Infinity;
  
    if (!shipTarget) {
  
      const spatial = room.spatialIndex?.dynamicValid ? room.spatialIndex : null;
  
      function evaluateCandidate(other) {
  
        if (!other.alive || !Relationships.areEntityEnemies(room, ship.ownerId, other)) return;
  
        if (usesSensorVisibility(room) && !canTeamTargetEntity(room, viewerTeam, other, now)) return;
  
        const point = targetAttackPoint(worldX, worldY, other);
        const distance = fastHypot(point.x - worldX, point.y - worldY);
  
        if (distance > range || TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, point.x, point.y, 8))) return;
  
        const score = enemyShipThreatScore(ship, other, distance, range);
  
        if (score > bestShipScore
  
          || (score === bestShipScore && (distance < bestDistance
  
            || (distance === bestDistance && (!shipTarget || isStableIdBefore(other, shipTarget)))))) {
  
          shipTarget = other;
  
          bestDistance = distance;
  
          bestShipScore = score;
  
        }
  
      }
  
      if (spatial) {
  
        const scratch = room._pickWeaponSpatialScratch || (room._pickWeaponSpatialScratch = { ships: [], stations: [] });
  
        const shipCandidates = spatial.queryRangeUnordered("ships", worldX, worldY, range, scratch.ships);
  
        for (const other of shipCandidates) evaluateCandidate(other);
  
        const stationCandidates = spatial.queryRangeUnordered("stations", worldX, worldY, range, scratch.stations);
  
        for (const other of stationCandidates) evaluateCandidate(other);
  
      } else {
  
        const stationTargets = (room.stations || []).filter((s) => s && s.alive !== false && s.state !== "destroyed");
  
        for (const other of (ships || []).concat(stationTargets)) evaluateCandidate(other);
  
      }
  
    }
  
  
  
    const canDivert = canWeaponDefensivelyTargetDrones(options.weapon);
  
    if (shipTarget && (!canDivert || (focusLocked && shipTarget === primary))) return shipTarget;
  
    const droneChoice = bestDroneFireTarget(room, ship, worldX, worldY, range, options.module, options.weapon);
  
    if (!shipTarget) return droneChoice?.target || null;
  
    if (droneChoice?.score >= DRONE_THREAT_OVERRIDE_SCORE) {
  
      return droneChoice.target;
  
    }
  
    return shipTarget;
  
  }
  
  function _targetCategory(room, target) {
    if (!target) return null;
    if (target.id == null) return null;
    if (room?.drones?.get?.(target.id) === target) return "drone";
    if (room?.ships?.get?.(target.id) === target) return "ship";
    if (room?.stations && room.stations.some((s) => s === target)) return "station";
    if (room?.drones?.get?.(target.id)) return "drone";
    if (room?.ships?.get?.(target.id)) return "ship";
    return null;
  }
  
  function _getCachedTargetEntity(room, id, category) {
    if (category === "drone") return room?.drones?.get?.(id) || null;
    if (category === "station") return (room?.stations || []).find((s) => s.id === id) || null;
    if (category === "ship") return room?.ships?.get?.(id) || null;
    const ship = room?.ships?.get?.(id);
    if (ship) return ship;
    const drone = room?.drones?.get?.(id);
    if (drone) return drone;
    const station = (room?.stations || []).find((s) => s.id === id);
    if (station) return station;
    return null;
  }
  
  function _updateWeaponTargetState(ship, i, weaponTarget, now, kind) {
    if (!ship._weaponTargetState) ship._weaponTargetState = [];
    let state = ship._weaponTargetState[i];
    if (!state) {
      state = ship._weaponTargetState[i] = { id: null, category: null, nextSearchAt: 0, lastSearchAt: 0, profileRevision: 0, manualRevision: 0, lastPrimaryId: null };
    }
    if (weaponTarget) {
      state.id = weaponTarget.id ?? null;
      state.category = weaponTarget._targetCategoryCache || "ship";
      state.lastSearchAt = now;
    } else {
      state.id = null;
      state.category = null;
    }
    TargetingCadence.markAcquisitionCompleted(ship, kind, i, now);
    state.nextSearchAt = TargetingCadence.nextAcquisitionAt(ship, kind, i, now);
  }
  
  function getCadencedWeaponTarget(room, ship, ships, worldX, worldY, primary, range, options, i, now, kind) {
    TargetingTelemetry.bump(room, "ordinaryTargetValidationAttempts");
    if (!ship._weaponTargetState) ship._weaponTargetState = [];
    let state = ship._weaponTargetState[i];
    if (!state) {
      state = ship._weaponTargetState[i] = { id: null, category: null, nextSearchAt: 0, lastSearchAt: 0, profileRevision: 0, manualRevision: 0, lastPrimaryId: null };
    }
  
    const hadCachedTarget = state.id !== null;
    const cached = hadCachedTarget ? _getCachedTargetEntity(room, state.id, state.category) : null;
    let currentValid = false;
    if (cached) {
      currentValid = Targeting.isOrdinaryWeaponTargetValid(room, ship, cached, now, range, {
        originX: worldX,
        originY: worldY,
        ignoreDrones: !canWeaponDefensivelyTargetDrones(options.weapon)
      });
      const cachedPoint = targetAttackPoint(worldX, worldY, cached);
      if (currentValid && TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, cachedPoint.x, cachedPoint.y, 8))) {
        currentValid = false;
      }
      if (!currentValid) TargetingTelemetry.bump(room, "ordinaryTargetValidationFailures");
    }
  
    const primaryId = primary?.id ?? null;
    const primaryChanged = primaryId !== state.lastPrimaryId;
    state.lastPrimaryId = primaryId;
    const force = primaryChanged || (hadCachedTarget && (!cached || !currentValid));
  
    if (hadCachedTarget && (!cached || !currentValid)) {
      state.id = null;
      state.category = null;
      TargetingTelemetry.bump(room, "targetInvalidations");
      TargetingTelemetry.bump(room, "ordinaryTargetImmediateReacquisitions");
    } else if (primaryChanged) {
      TargetingTelemetry.bump(room, "ordinaryTargetImmediateReacquisitions");
    }
  
    const due = TargetingCadence.isAcquisitionDue(ship, kind, i, now);
  
    if (currentValid && !force && !due) {
      TargetingTelemetry.bump(room, "ordinaryTargetSearchCacheHits");
      TargetingTelemetry.bump(room, "ordinaryTargetSearchDeferred");
      return cached;
    }
  
    if (!currentValid && !force && !due) {
      TargetingTelemetry.bump(room, "ordinaryTargetSearchDeferred");
      return null;
    }
  
    TargetingTelemetry.bump(room, "ordinaryTargetSearches");
    const picked = TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledOrdinaryAcquisitionDuration", () =>
      pickWeaponFireTarget(room, ship, ships, worldX, worldY, primary, range, options)
    );
    if (picked) {
      picked._targetCategoryCache = _targetCategory(room, picked);
    }
    _updateWeaponTargetState(ship, i, picked, now, kind);
    if (picked) TargetingTelemetry.bump(room, "ordinaryTargetSearchCandidates", 1);
    return picked;
  }

  return {
    maxShipWeaponAcquisitionRange,
    enemyShipThreatScore,
    findTarget,
    canWeaponDefensivelyTargetDrones,
    droneThreatScore,
    pickWeaponFireTarget,
    getCadencedWeaponTarget
  };
}

module.exports = { createTargetingRuntime };
