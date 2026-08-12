"use strict";

const { compareIdStrings } = require("../utils");
const TargetingTelemetry = require("../targetingTelemetry");
const PointDefenceThreats = require("../pointDefenceThreats");

function createPointDefence({ isLineBlocked }) {
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
  
      // For missiles, check subtype first (torpedo, swarmMissile), then fall back to type
  
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
  
  
  
  function findPointDefenseTarget(room, worldX, worldY, shipOwnerId, weapon, ships, protectedShipId = null, now = 0) {
  
    const defender = room?.ships?.get?.(protectedShipId)
      || (room?.stations || []).find((s) => s.id === protectedShipId)
      || (ships || []).find((s) => s?.id === protectedShipId);
  
    if (!defender) return null;
    const threatSet = PointDefenceThreats.ensurePointDefenceThreatSet(room, defender, shipOwnerId, now);
    const canSee = (cand) => TargetingTelemetry.withSampledDuration(room, now, defender, 0, "sampledLineOfSightDuration", () => {
      const margin = cand.type === "ship" ? 8 : cand.type === "drone" ? 3 : 4;
      return !isLineBlocked(room, worldX, worldY, cand.entity.x, cand.entity.y, margin);
    });
    const selected = TargetingTelemetry.withSampledDuration(room, now, defender, 0, "sampledPDSelectionDuration", () =>
      PointDefenceThreats.selectPointDefenceTarget(room, worldX, worldY, shipOwnerId, weapon, protectedShipId, now, threatSet, canSee, room._pdReservations)
    );
    if (selected) TargetingTelemetry.bump(room, "pointDefenceThreatSetHits");
    else TargetingTelemetry.bump(room, "pointDefenceThreatSetMisses");
    return selected;
  
  
  }
  
  
  
  
  
  function _lookupPointDefenceEntity(room, id) {
    const bullet = (room?.bullets || []).find((b) => b && b.id === id);
    if (bullet) return { type: "projectile", entity: bullet };
    const drone = room?.drones?.get?.(id);
    if (drone) return { type: "drone", entity: drone };
    const ship = room?.ships?.get?.(id);
    if (ship) return { type: "ship", entity: ship };
    const decoy = room?.decoys?.get?.(id);
    if (decoy) return { type: "decoy", entity: decoy };
    return null;
  }

  return {
    findPointDefenseTarget,
    _lookupPointDefenceEntity,
    getCandidatePriorityIndex
  };
}

module.exports = { createPointDefence };
