"use strict";

const { PARTS } = require("../components");
const { rngRange, clampNumber } = require("../utils");
const { segmentCircleHit, shieldCollisionRadius, SHIELD_HIT_MIN } = require("../projectiles");
const { isComponentAlive } = require("../componentHealth");
const { addComponentHeat, componentPerformance } = require("../heat");
const HeatRules = require("../../../public/src/shared/heatRules");
const { getComponentPowerMultiplier } = require("../componentPower");
const Relationships = require("../relationships");
const { segmentStationHullHit } = require("../stationCollision");
const {
  componentAimWorldPosition,
  targetCoreAimWorldPosition,
  findBeamRayIntersections
} = require("./componentTargeting");

function createInductionRuntime({
  asteroidBroadPhase,
  roomScratch,
  roomCombatRandom,
  isInSafeZone,
  areEnemies
}) {
  function isInductionBeam(weapon) {
    return weapon && typeof weapon === "object" && Number.isFinite(weapon.inductionHeatBasePerSecond) && Number.isFinite(weapon.inductionHeatMaxPerSecond);
  }
  
  function inductionComponentWeight(target, index) {
    const module = target.design?.[index];
    if (!module) return 0;
    const part = PARTS[module.type] || PARTS.frame;
    if (module.type === "core") return 0;
    const powerMult = getComponentPowerMultiplier(target, index);
    const thermalPerformance = componentPerformance(target, index);
    if (part.powerGeneration > 0 && powerMult > 0) return 3;
    if (part.weapon || part.thrust > 0 || part.shieldRegen > 0 || part.aura) return 2;
    if ((part.heatCooling > 0 || part.heatPassiveCooling > 0) && thermalPerformance > 0) return 1.5;
    if (part.repairRate > 0) return 1.5;
    return 1;
  }
  
  function selectInductionComponentIndex(room, target, ship, weaponIndex, now) {
    if (!target?.alive || !target.design?.length) return -1;
    const powerGenerators = [];
    for (let i = 0; i < target.design.length; i += 1) {
      if (!isComponentAlive(target, i)) continue;
      const module = target.design[i];
      const part = PARTS[module.type] || PARTS.frame;
      if (module.type === "core") continue;
      if (part.category === "Structure") continue;
      if (part.powerGeneration > 0) powerGenerators.push(i);
    }
    if (powerGenerators.length > 0) {
      return powerGenerators[Math.floor(roomCombatRandom(room)() * powerGenerators.length)];
    }
    const candidates = [];
    const weights = [];
    let total = 0;
    for (let i = 0; i < target.design.length; i += 1) {
      if (!isComponentAlive(target, i)) continue;
      const module = target.design[i];
      const part = PARTS[module.type] || PARTS.frame;
      if (module.type === "core") continue;
      if (part.category === "Structure") continue;
      const w = inductionComponentWeight(target, i);
      if (w <= 0) continue;
      candidates.push(i);
      weights.push(w);
      total += w;
    }
    if (!candidates.length) {
      for (let i = 0; i < target.design.length; i += 1) {
        if (!isComponentAlive(target, i)) continue;
        if (target.design[i].type === "core") continue;
        candidates.push(i);
        weights.push(1);
        total += 1;
      }
    }
    if (!candidates.length) {
      for (let i = 0; i < target.design.length; i += 1) {
        if (!isComponentAlive(target, i)) continue;
        return i;
      }
      return -1;
    }
    const roll = rngRange(roomCombatRandom(room), 0, total);
    let acc = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      acc += weights[i];
      if (roll < acc || i === candidates.length - 1) return candidates[i];
    }
    return candidates[candidates.length - 1];
  }
  
  function getInductionAimPoint(room, ship, weaponIndex, target, now, originX, originY, weapon) {
    if (!ship.weaponInductionContacts) {
      ship.weaponInductionContacts = new Array(ship.design ? ship.design.length : 0).fill(null);
    }
    if (!target || target.alive === false || target.destroyed) {
      ship.weaponInductionContacts[weaponIndex] = null;
      return null;
    }
    if (!target.design || !target.componentHp) {
      const fallback = targetCoreAimWorldPosition(target, originX, originY);
      return fallback ? { ...fallback, componentIndex: -1 } : null;
    }
    const contact = ship.weaponInductionContacts[weaponIndex];
    let componentIndex = -1;
    if (!contact || contact.targetShipId !== target.id || !isComponentAlive(target, contact.componentIndex)) {
      componentIndex = selectInductionComponentIndex(room, target, ship, weaponIndex, now);
      if (componentIndex >= 0) {
        ship.weaponInductionContacts[weaponIndex] = {
          targetShipId: target.id,
          componentIndex,
          contactDuration: 0,
          lastContactAt: now,
          shieldAttenuated: false,
          contactAngle: 0
        };
      } else {
        ship.weaponInductionContacts[weaponIndex] = null;
      }
    } else {
      componentIndex = contact.componentIndex;
    }
    if (componentIndex < 0) {
      const fallback = targetCoreAimWorldPosition(target, originX, originY);
      return fallback ? { ...fallback, componentIndex: -1 } : null;
    }
    const pos = componentAimWorldPosition(target, componentIndex);
    return pos ? { ...pos, componentIndex } : null;
  }
  
  function inductionEdgeWeight(topology, edgeId) {
    if (!topology) return 0;
    const shared = Number(topology.edgeSharedEdges[edgeId]) || 0;
    const capped = Math.min(shared, 2);
    // Induction heat spreads along physical conduction only: the base edge
    // conductivity already carries the material difference between frames,
    // armour and systems.
    const conductivity = Number(topology.edgeBaseConductivity[edgeId]) || 0;
    return Math.max(0, conductivity * capped);
  }
  
  function distributeInductionHeat(target, selectedIndex, totalInductionHeat, weapon) {
    if (!target?._thermalRuntime || !target.thermalTopology) return 0;
    const topology = target.thermalTopology;
    if (selectedIndex < 0 || selectedIndex >= topology.componentCount) return 0;
  
    const directFraction = Math.max(0, Number(weapon.inductionDirectFraction) || 0.6);
    const adjacentFraction = Math.max(0, Number(weapon.inductionAdjacentFraction) || 0.3);
    const secondHopFraction = Math.max(0, Number(weapon.inductionSecondHopFraction) || 0.1);
    const fractions = [directFraction, adjacentFraction, secondHopFraction];
    const sum = fractions.reduce((a, b) => a + b, 0);
    if (!Number.isFinite(sum) || sum <= 0) return 0;
  
    const directAmount = totalInductionHeat * (directFraction / sum);
    const directRecipients = [selectedIndex];
    const directWeights = [1];
  
    const firstHopSet = new Set();
    const firstHopWeights = new Map();
    const startOff = topology.incidentEdgeOffsets[selectedIndex];
    const endOff = topology.incidentEdgeOffsets[selectedIndex + 1];
    for (let o = startOff; o < endOff; o += 1) {
      const edgeId = topology.incidentEdgeIds[o];
      const other = topology.edgeA[edgeId] === selectedIndex ? topology.edgeB[edgeId] : topology.edgeA[edgeId];
      if (other === selectedIndex || !isComponentAlive(target, other)) continue;
      firstHopSet.add(other);
      const w = inductionEdgeWeight(topology, edgeId);
      firstHopWeights.set(other, (firstHopWeights.get(other) || 0) + w);
    }
    const firstHop = [...firstHopSet];
    const firstHopTotalWeight = firstHop.reduce((s, idx) => s + (firstHopWeights.get(idx) || 0), 0);
    const firstHopAmount = totalInductionHeat * (adjacentFraction / sum);
  
    const secondHopSet = new Set();
    const secondHopWeights = new Map();
    for (const firstIdx of firstHop) {
      const fStart = topology.incidentEdgeOffsets[firstIdx];
      const fEnd = topology.incidentEdgeOffsets[firstIdx + 1];
      for (let o = fStart; o < fEnd; o += 1) {
        const edgeId = topology.incidentEdgeIds[o];
        const second = topology.edgeA[edgeId] === firstIdx ? topology.edgeB[edgeId] : topology.edgeA[edgeId];
        if (second === selectedIndex || firstHopSet.has(second) || !isComponentAlive(target, second)) continue;
        const firstEdgeW = firstHopWeights.get(firstIdx) || 1;
        const secondEdgeW = inductionEdgeWeight(topology, edgeId);
        const pathW = firstEdgeW * secondEdgeW;
        secondHopSet.add(second);
        secondHopWeights.set(second, (secondHopWeights.get(second) || 0) + pathW);
      }
    }
    const secondHop = [...secondHopSet];
    const secondHopTotalWeight = secondHop.reduce((s, idx) => s + (secondHopWeights.get(idx) || 0), 0);
    const secondHopAmount = totalInductionHeat * (secondHopFraction / sum);
  
    const allocations = [];
    let allocated = 0;
  
    function addRecipient(index, amount) {
      amount = Math.max(0, Number.isFinite(amount) ? amount : 0);
      if (amount <= 0) return;
      addComponentHeat(target, index, amount);
      allocations.push({ index, amount });
      allocated += amount;
    }
  
    addRecipient(selectedIndex, directAmount);
  
    if (firstHop.length && firstHopTotalWeight > 0) {
      const perWeight = firstHopAmount / firstHopTotalWeight;
      let firstAllocated = 0;
      for (let i = 0; i < firstHop.length; i += 1) {
        const idx = firstHop[i];
        const weight = firstHopWeights.get(idx) || 0;
        const amount = (i === firstHop.length - 1) ? Math.max(0, firstHopAmount - firstAllocated) : perWeight * weight;
        addRecipient(idx, amount);
        firstAllocated += amount;
      }
    } else {
      addRecipient(selectedIndex, firstHopAmount);
    }
  
    if (secondHop.length && secondHopTotalWeight > 0) {
      const perWeight = secondHopAmount / secondHopTotalWeight;
      let secondAllocated = 0;
      for (let i = 0; i < secondHop.length; i += 1) {
        const idx = secondHop[i];
        const weight = secondHopWeights.get(idx) || 0;
        const amount = (i === secondHop.length - 1) ? Math.max(0, secondHopAmount - secondAllocated) : perWeight * weight;
        addRecipient(idx, amount);
        secondAllocated += amount;
      }
    } else {
      addRecipient(selectedIndex, secondHopAmount);
    }
  
    return allocated;
  }
  
  function isInductionBeamBlockedBefore(room, x1, y1, x2, y2, beamRadius, intendedShip) {
    const asteroids = asteroidBroadPhase(room, x1, y1, x2, y2, beamRadius, roomScratch(room, "inductionAsteroids"));
    for (const asteroid of asteroids) {
      if (!asteroid) continue;
      if (segmentCircleHit(x1, y1, x2, y2, asteroid.x, asteroid.y, asteroid.radius + beamRadius)) return true;
    }
  
    const index = room.spatialIndex;
    const useIndex = Boolean(index?.dynamicValid);
    const shipCandidates = useIndex
      ? index.querySweptAabbUnordered("ships", x1, y1, x2, y2, beamRadius, roomScratch(room, "inductionShips"))
      : (room.ships?.values?.() || []);
    for (const other of shipCandidates) {
      if (!other?.alive || other === intendedShip) continue;
      if (!areEnemies(room, intendedShip?.ownerId || other?.ownerId, other)) continue;
      const broad = segmentCircleHit(x1, y1, x2, y2, other.x, other.y, other.radius + beamRadius);
      if (!broad) continue;
      if (other.shield >= SHIELD_HIT_MIN) {
        const ringR = shieldCollisionRadius(other) + beamRadius;
        if (segmentCircleHit(x1, y1, x2, y2, other.x, other.y, ringR)) return true;
        continue;
      }
      const physical = segmentCircleHit(x1, y1, x2, y2, other.x, other.y, other.radius + beamRadius);
      if (physical) return true;
    }
  
    const stationCandidates = useIndex
      ? index.querySweptAabbUnordered("stations", x1, y1, x2, y2, beamRadius, roomScratch(room, "inductionStations"))
      : (room.stations || []);
    for (const station of stationCandidates) {
      if (!station || station.alive === false || station.state === "destroyed" || station === intendedShip) continue;
      if (!Relationships.areEntityEnemies(room, intendedShip?.ownerId, station)) continue;
      if (station.shield >= SHIELD_HIT_MIN) {
        const ringR = shieldCollisionRadius(station) + beamRadius;
        if (segmentCircleHit(x1, y1, x2, y2, station.x, station.y, ringR)) return true;
        continue;
      }
      const hull = segmentStationHullHit(station, x1, y1, x2, y2, beamRadius);
      if (hull) return true;
    }
  
    const droneCandidates = useIndex
      ? index.querySweptAabbUnordered("drones", x1, y1, x2, y2, beamRadius, roomScratch(room, "inductionDrones"))
      : (room.drones?.values?.() || []);
    for (const drone of droneCandidates) {
      if (!drone || drone.destroyed || drone === intendedShip) continue;
      if (!areEnemies(room, intendedShip?.ownerId, drone.ownerId)) continue;
      if (segmentCircleHit(x1, y1, x2, y2, drone.x, drone.y, (Number(drone.radius) || 10) + beamRadius)) return true;
    }
  
    return false;
  }
  
  // Refractory Armour stops an induction lance outright. An induction beam does no
  // damage â€” it reaches past the hull and couples Heat straight into an internal
  // subsystem â€” so the only way to answer it is to put material in the way that
  // will not conduct. If a live heat-shielded component sits on the beam line in
  // front of the component the lance has coupled to, no Heat crosses at all. This
  // is a full block rather than an attenuation, which makes the counter a
  // placement decision (armour the approach the lance is using) instead of a stat
  // check the attacker can simply out-scale.
  function isInductionBlockedByHeatShield(target, componentIndex, x1, y1, x2, y2, beamRadius) {
    if (!target?.design?.length) return false;
    const intersections = findBeamRayIntersections(target, x1, y1, x2, y2, beamRadius);
    for (const entry of intersections) {
      if (entry.index === componentIndex) return false;
      if (PARTS[target.design[entry.index]?.type]?.heatBeamShield) return true;
    }
    return false;
  }
  
  function fireInductionLance(room, ship, weaponIndex, weaponTarget, muzzle, worldWeaponAngle, effectiveWeapon, part, dt, now, activityMultiplier, powerMultiplier) {
    const range = Number(effectiveWeapon.range) || 0;
    const contact = ship.weaponInductionContacts?.[weaponIndex];
    const componentIndex = contact?.componentIndex ?? -1;
  
    if (!weaponTarget || !weaponTarget.alive || weaponTarget.destroyed || componentIndex < 0) {
      if (ship.weaponInductionContacts) ship.weaponInductionContacts[weaponIndex] = null;
      return;
    }
  
    const targetPos = componentAimWorldPosition(weaponTarget, componentIndex);
    if (!targetPos) {
      if (ship.weaponInductionContacts) ship.weaponInductionContacts[weaponIndex] = null;
      return;
    }
  
    const dx = targetPos.x - muzzle.x;
    const dy = targetPos.y - muzzle.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance > range) {
      if (ship.weaponInductionContacts) ship.weaponInductionContacts[weaponIndex] = null;
      return;
    }
  
    const beamRadius = Number(effectiveWeapon.radius) || 8;
    const blocked = isInductionBeamBlockedBefore(room, muzzle.x, muzzle.y, targetPos.x, targetPos.y, beamRadius, weaponTarget)
      || isInductionBlockedByHeatShield(weaponTarget, componentIndex, muzzle.x, muzzle.y, targetPos.x, targetPos.y, beamRadius);
    if (blocked) {
      const graceMs = Math.max(0, Number(effectiveWeapon.inductionContactGraceSeconds) || 0.25) * 1000;
      if (contact && now - contact.lastContactAt > graceMs) {
        ship.weaponInductionContacts[weaponIndex] = null;
      }
      return;
    }
  
    const rampSeconds = Math.max(0, Number(effectiveWeapon.inductionRampSeconds) || 1);
    let progress = rampSeconds > 0 ? clampNumber(contact.contactDuration / rampSeconds, 0, 1) : 1;
    progress = clampNumber(progress, 0, 1);
  
    const baseRate = Number(effectiveWeapon.inductionHeatBasePerSecond) || 0;
    const maxRate = Number(effectiveWeapon.inductionHeatMaxPerSecond) || baseRate;
    const rampedRate = baseRate + (maxRate - baseRate) * progress;
  
    const shieldAttenuated = Number(weaponTarget.shield) >= Number(SHIELD_HIT_MIN);
    const shieldMultiplier = shieldAttenuated ? (Number(effectiveWeapon.inductionShieldMultiplier) || 0.4) : 1;
  
    const totalInductionHeat = rampedRate * activityMultiplier * shieldMultiplier * dt;
  
    if (totalInductionHeat > 0 && !isInSafeZone(room, weaponTarget.x, weaponTarget.y, weaponTarget)) {
      const distributed = distributeInductionHeat(weaponTarget, componentIndex, totalInductionHeat, effectiveWeapon);
      if (distributed > 0) {
        contact.contactDuration = clampNumber(contact.contactDuration + dt, 0, 1e9);
        contact.lastContactAt = now;
        contact.shieldAttenuated = shieldAttenuated;
        contact.contactAngle = worldWeaponAngle;
      }
    }
  
    addComponentHeat(ship, weaponIndex, HeatRules.activityHeat("thermalInductionLance", part) * activityMultiplier * dt);
  
    if (now - (ship.beamEffectsAt[weaponIndex] || 0) > 55) {
      ship.beamEffectsAt[weaponIndex] = now;
      room.effects.push({
        type: "beam",
        beamStyle: effectiveWeapon.beamStyle || "induction",
        // beamStyle is not part of the replicated effect schema; subtype is, and
        // it is what the renderer reads to draw the induction lance's violet
        // coupling beam instead of the beam emitter's cyan cutting beam.
        subtype: effectiveWeapon.beamStyle || "induction",
        ownerId: ship.ownerId,
        x: muzzle.x,
        y: muzzle.y,
        x2: targetPos.x,
        y2: targetPos.y,
        radius: beamRadius,
        rampProgress: progress,
        // Replicated ramp: `charge` is the effect schema's carried scalar, so the
        // renderer can brighten the coupling bloom as the lance spins up.
        charge: progress,
        shieldAttenuated,
        at: now
      });
    }
  }

  return {
    isInductionBeam,
    getInductionAimPoint,
    isInductionBlockedByHeatShield,
    fireInductionLance
  };
}

module.exports = { createInductionRuntime };
