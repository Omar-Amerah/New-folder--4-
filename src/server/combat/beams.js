"use strict";

const { PARTS } = require("../components");
const { clampNumber, angleDifference, compareIdStrings } = require("../utils");
const { segmentCircleHit, shieldCollisionRadius, SHIELD_HIT_MIN } = require("../projectiles");
const {
  isComponentAlive,
  onComponentDestroyed,
  markComponentDamageChanged
} = require("../componentHealth");
const { addComponentHeat } = require("../heat");
const HeatRules = require("../../../public/src/shared/heatRules");
const { markShipRepairCacheDirty } = require("../repairCache");
const Relationships = require("../relationships");
const { segmentStationHullHit } = require("../stationCollision");
const { findBeamRayIntersections } = require("./componentTargeting");

function createBeamRuntime({
  damageShip,
  isInSafeZone,
  asteroidBroadPhase,
  roomScratch,
  areEnemies
}) {
  function beamImpactPoint(room, x, y, angle, range, beamRadius = 0) {
  
    const maxX = x + Math.cos(angle) * range;
  
    const maxY = y + Math.sin(angle) * range;
  
    let end = { x: maxX, y: maxY, t: 1 };
  
  
  
    const candidates = asteroidBroadPhase(room, x, y, maxX, maxY, beamRadius, roomScratch(room, "beamImpact"));
  
    for (let i = 0; i < candidates.length; i += 1) {
  
      const asteroid = candidates[i];
  
      if (!asteroid) continue;
  
      const hit = segmentCircleHit(x, y, maxX, maxY, asteroid.x, asteroid.y, asteroid.radius + beamRadius);
  
      if (hit && hit.t < end.t) end = { x: hit.x, y: hit.y, t: hit.t };
  
    }
  
  
  
    return end;
  
  }
  
  
  
  function normalizedBeamDeltaSeconds(value) {
  
    const parsed = Number(value);
  
    if (!Number.isFinite(parsed)) return 1;
  
    return Math.max(0, parsed);
  
  }
  
  
  
  function beamContactCharge(contact, targetShipId, contactAngle, weapon = {}) {
  
    const rampSeconds = Math.max(0, Number(weapon.chargeRampSeconds) || 0);
  
    const maxBonus = clampNumber(Number(weapon.maxChargeDamageBonus) || 0, 0, 1);
  
    const continuous = Boolean(
  
      contact
  
      && targetShipId
  
      && contact.targetShipId === targetShipId
  
      && Math.abs(angleDifference(contact.contactAngle, contactAngle)) <= 0.05
  
    );
  
    const duration = continuous ? Math.max(0, Number(contact.contactDuration) || 0) : 0;
  
    const progress = rampSeconds > 0 ? clampNumber(duration / rampSeconds, 0, 1) : 0;
  
    return { duration, progress, multiplier: 1 + maxBonus * progress };
  
  }
  
  
  
  function applyBeamHullDamage(room, ship, damage, now, intersections, options = {}) {
  
    if (!ship.componentHp || damage <= 0 || !intersections || !intersections.length) {
  
      const applied = Math.max(0, damage);
  
      ship.hp -= applied;
  
      if (applied > 0) markShipRepairCacheDirty(ship);
  
      return applied;
  
    }
  
  
  
    const burnThroughMultiplier = Number(options.burnThroughCarryMultiplier) || 0;
  
    let applied = 0;
  
    const comp1 = intersections[0];
  
    const idx1 = comp1.index;
  
  
  
    const part1 = PARTS[ship.design[idx1].type] || PARTS.frame;
  
    let effectiveDamage1 = damage;
  
    if (part1.armorFlatReduction > 0) {
  
      const protection = HeatRules.passiveProtectionForState(ship.componentHeatState?.[idx1] || HeatRules.STATE.NORMAL);
  
      const beamDeltaSeconds = normalizedBeamDeltaSeconds(options.beamDeltaSeconds);
  
      const reduction = part1.armorFlatReduction * protection * beamDeltaSeconds;
  
      effectiveDamage1 = Math.max(0, damage - Math.max(0, reduction));
  
    }
  
  
  
    if (effectiveDamage1 <= 0) return 0;
  
  
  
    if (ship.design[idx1].type === "core") {
  
      const dealt = Math.min(ship.componentHp[idx1], effectiveDamage1);
  
      if (dealt > 0) {
  
        ship.componentHp[idx1] -= dealt;
  
        applied += dealt;
  
        markComponentDamageChanged(ship, idx1);
  
        if (ship.componentHp[idx1] <= 0.0001) {
  
          ship.componentHp[idx1] = 0;
  
          onComponentDestroyed(room, ship, idx1, now);
  
        }
  
      }
  
      if (applied > 0) markShipRepairCacheDirty(ship);
  
      return applied;
  
    }
  
  
  
    const passiveStructure1 = HeatRules.isPassiveStructure(ship.design[idx1].type, part1);
  
    const mult1 = passiveStructure1 ? HeatRules.structuralDamageMultiplierForState(ship.componentHeatState?.[idx1] || HeatRules.STATE.NORMAL) : 1;
  
    const incomingToHp1 = effectiveDamage1 * mult1;
  
    const currentHp1 = ship.componentHp[idx1];
  
  
  
    if (incomingToHp1 < currentHp1 - 0.0001) {
  
      ship.componentHp[idx1] -= incomingToHp1;
  
      if (ship.design[idx1].type === "heatSink") require("../heat").recalculateEffectiveThermalCapacities(ship, idx1);
  
      ship.hp -= incomingToHp1;
  
      applied += incomingToHp1;
  
      markComponentDamageChanged(ship, idx1);
  
      if (applied > 0) markShipRepairCacheDirty(ship);
  
      return applied;
  
    }
  
  
  
    const hpAbsorbed1 = currentHp1;
  
    const effectiveUsed1 = hpAbsorbed1 / mult1;
  
    const excessEffective1 = Math.max(0, effectiveDamage1 - effectiveUsed1);
  
  
  
    ship.componentHp[idx1] = 0;
  
    ship.hp -= hpAbsorbed1;
  
    applied += hpAbsorbed1;
  
    markComponentDamageChanged(ship, idx1);
  
    onComponentDestroyed(room, ship, idx1, now);
  
  
  
    if (burnThroughMultiplier > 0 && excessEffective1 > 0.0001 && intersections.length > 1) {
  
      const comp2 = intersections[1];
  
      const idx2 = comp2.index;
  
      const carryThroughDamage = excessEffective1 * burnThroughMultiplier;
  
  
  
      if (ship.componentHp[idx2] > 0) {
  
        if (ship.design[idx2].type === "core") {
  
          const dealt2 = Math.min(ship.componentHp[idx2], carryThroughDamage);
  
          if (dealt2 > 0) {
  
            ship.componentHp[idx2] -= dealt2;
  
            applied += dealt2;
  
            markComponentDamageChanged(ship, idx2);
  
            if (ship.componentHp[idx2] <= 0.0001) {
  
              ship.componentHp[idx2] = 0;
  
              onComponentDestroyed(room, ship, idx2, now);
  
            }
  
          }
  
        } else {
  
          const part2 = PARTS[ship.design[idx2].type] || PARTS.frame;
  
          let effectiveDamage2 = carryThroughDamage;
  
          if (part2.armorFlatReduction > 0) {
  
            const protection2 = HeatRules.passiveProtectionForState(ship.componentHeatState?.[idx2] || HeatRules.STATE.NORMAL);
  
            const beamDeltaSeconds2 = normalizedBeamDeltaSeconds(options.beamDeltaSeconds);
  
            const reduction2 = part2.armorFlatReduction * protection2 * beamDeltaSeconds2;
  
            effectiveDamage2 = Math.max(0, carryThroughDamage - Math.max(0, reduction2));
  
          }
  
          if (effectiveDamage2 > 0) {
  
            const passiveStructure2 = HeatRules.isPassiveStructure(ship.design[idx2].type, part2);
  
            const mult2 = passiveStructure2 ? HeatRules.structuralDamageMultiplierForState(ship.componentHeatState?.[idx2] || HeatRules.STATE.NORMAL) : 1;
  
            const incomingToHp2 = effectiveDamage2 * mult2;
  
            const dealt2 = Math.min(ship.componentHp[idx2], incomingToHp2);
  
            if (dealt2 > 0) {
  
              ship.componentHp[idx2] -= dealt2;
  
              if (ship.design[idx2].type === "heatSink") require("../heat").recalculateEffectiveThermalCapacities(ship, idx2);
  
              ship.hp -= dealt2;
  
              applied += dealt2;
  
              markComponentDamageChanged(ship, idx2);
  
              if (ship.componentHp[idx2] <= 0.0001) {
  
                ship.componentHp[idx2] = 0;
  
                onComponentDestroyed(room, ship, idx2, now);
  
              }
  
            }
  
          }
  
        }
  
      }
  
    }
  
  
  
    if (ship.hp < 0) ship.hp = 0;
  
    if (applied > 0) markShipRepairCacheDirty(ship);
  
    return applied;
  
  }
  
  
  
  // A beam ray damages only the nearest blocking entity. All candidate blockers â€”
  
  // asteroids, active shield bubbles, living ship components, and living drones â€”
  
  // are collected into one ordered list, sorted by ray parameter (with a
  
  // deterministic tie-break), and only the nearest one is resolved. The visible
  
  // beam stops at that same impact point. This guarantees:
  
  //   - a drone in front of a ship absorbs the beam and shields the ship,
  
  //   - an asteroid blocks both damage and the visual beam,
  
  //   - burn-through never continues into a second ship or drone,
  
  //   - a shielded ship in front takes only its shield's damage.
  
  // Burn-through (into at most one further component) is still resolved, but only
  
  // inside the single nearest ship that was hit.
  
  // Tie-break ranks preserve the previous `"a:"` / `"d:"` / `"s:"` string keys
  
  // exactly ('a' < 'd' < 's'), without building a key string per candidate per
  
  // beam per tick. Shield and component hits deliberately share the ship rank,
  
  // as they shared the `s:` prefix before.
  
  const BEAM_TIE_ASTEROID = 0;
  
  const BEAM_TIE_DRONE = 1;
  
  const BEAM_TIE_SHIP = 2;
  
  
  
  function damageBeamTargets(room, ship, ships, x1, y1, x2, y2, beamRadius, damage, now, options = {}) {
  
    const candidates = [];
  
  
  
    const mapAsteroids = room.map?.asteroids || [];
  
    const asteroids = asteroidBroadPhase(room, x1, y1, x2, y2, beamRadius, roomScratch(room, "beamAsteroids"));
  
    for (let a = 0; a < asteroids.length; a += 1) {
  
      const asteroid = asteroids[a];
  
      if (!asteroid) continue;
  
      const hit = segmentCircleHit(x1, y1, x2, y2, asteroid.x, asteroid.y, asteroid.radius + beamRadius);
  
      // Generated asteroids always carry an id; the positional fallback stays
  
      // keyed on the map array so a hand-built id-less rock keeps its old order.
  
      if (hit) {
  
        candidates.push({
  
          kind: "asteroid",
  
          t: hit.t,
  
          hit,
  
          tieRank: BEAM_TIE_ASTEROID,
  
          tieId: String(asteroid.id ?? mapAsteroids.indexOf(asteroid))
  
        });
  
      }
  
    }
  
  
  
    const index = room.spatialIndex;
  
    const useIndex = Boolean(index?.dynamicValid);
  
    const shipCandidates = useIndex
  
      ? index.querySweptAabbUnordered("ships", x1, y1, x2, y2, beamRadius, roomScratch(room, "beamShips"))
  
      : ships;
  
    for (const target of shipCandidates) {
  
      if (!target?.alive || !areEnemies(room, ship.ownerId, target.ownerId)) continue;
  
  
  
      const broadHit = segmentCircleHit(x1, y1, x2, y2, target.x, target.y, target.radius + beamRadius);
  
      if (!broadHit) continue;
  
  
  
      // While the shield holds (>= SHIELD_HIT_MIN) the beam stops on the outer
  
      // shield bubble and only the shield can be damaged.
  
      if (target.shield >= SHIELD_HIT_MIN) {
  
        const ringR = shieldCollisionRadius(target) + beamRadius;
  
        const broadShieldHit = segmentCircleHit(x1, y1, x2, y2, target.x, target.y, ringR);
  
        if (broadShieldHit) candidates.push({ kind: "shield", target, t: broadShieldHit.t, tieRank: BEAM_TIE_SHIP, tieId: target.id });
  
        continue;
  
      }
  
  
  
      // Shield depleted/down: the beam reaches physical components.
  
      const intersections = findBeamRayIntersections(target, x1, y1, x2, y2, beamRadius);
  
      if (intersections.length) {
  
        candidates.push({ kind: "component", target, t: intersections[0].hit.t, intersections, tieRank: BEAM_TIE_SHIP, tieId: target.id });
  
      }
  
    }
  
  
  
    const stationCandidates = useIndex
      ? index.querySweptAabbUnordered("stations", x1, y1, x2, y2, beamRadius, roomScratch(room, "beamStations"))
      : (room.stations || []);
    for (const station of stationCandidates) {
      if (!station || station.alive === false || station.state === "destroyed") continue;
      if (!Relationships.areEntityEnemies(room, ship.ownerId, station)) continue;
  
      if (station.shield >= SHIELD_HIT_MIN) {
        const ringR = shieldCollisionRadius(station) + beamRadius;
        const shieldHit = segmentCircleHit(x1, y1, x2, y2, station.x, station.y, ringR);
        if (shieldHit) {
          candidates.push({
            kind: "station-shield",
            station,
            t: shieldHit.t,
            hit: shieldHit,
            tieRank: BEAM_TIE_SHIP,
            tieId: station.id
          });
        }
        continue;
      }
  
      const hullHit = segmentStationHullHit(station, x1, y1, x2, y2, beamRadius);
      if (hullHit) {
        candidates.push({
          kind: "station",
          station,
          t: hullHit.t,
          hit: hullHit,
          tieRank: BEAM_TIE_SHIP,
          tieId: station.id
        });
      }
    }
  
    const droneCandidates = useIndex
  
      ? index.querySweptAabbUnordered("drones", x1, y1, x2, y2, beamRadius, roomScratch(room, "beamDrones"))
  
      : (room.drones?.values?.() || []);
  
    for (const drone of droneCandidates) {
  
      if (!drone || drone.destroyed || !areEnemies(room, ship.ownerId, drone.ownerId)) continue;
  
      const hit = segmentCircleHit(x1, y1, x2, y2, drone.x, drone.y, (Number(drone.radius) || 10) + beamRadius);
  
      if (hit) candidates.push({ kind: "drone", drone, t: hit.t, hit, tieRank: BEAM_TIE_DRONE, tieId: drone.id });
  
    }
  
  
  
    if (!candidates.length) return null;
  
  
  
    candidates.sort((a, b) => {
  
      if (Math.abs(a.t - b.t) > 1e-6) return a.t - b.t;
  
      if (a.tieRank !== b.tieRank) return a.tieRank - b.tieRank;
  
      return compareIdStrings(a.tieId, b.tieId);
  
    });
  
  
  
    const nearest = candidates[0];
  
  
  
    if (nearest.kind === "asteroid") {
  
      // Asteroids block both damage and the visible beam; nothing behind resolves.
  
      return { hitX: nearest.hit.x, hitY: nearest.hit.y, t: nearest.t, firstHitIndex: -1 };
  
    }
  
  
  
    if (nearest.kind === "shield") {
  
      const target = nearest.target;
  
      const ang = Math.atan2(y1 - target.y, x1 - target.x);
  
      const surfaceR = shieldCollisionRadius(target);
  
      const shieldHitX = target.x + Math.cos(ang) * surfaceR;
  
      const shieldHitY = target.y + Math.sin(ang) * surfaceR;
  
      damageShip(room, target, damage, ship.ownerId, now, shieldHitX, shieldHitY, options);
  
      room.effects.push({ type: "shieldhit", x: shieldHitX, y: shieldHitY, nx: Math.cos(ang), ny: Math.sin(ang), at: now });
  
      return { hitX: shieldHitX, hitY: shieldHitY, t: nearest.t, firstHitIndex: -1, hitTargetShipId: target.id };
  
    }
  
  
  
    if (nearest.kind === "station-shield" || nearest.kind === "station") {
  
      const station = nearest.station;
  
      const shieldHit = nearest.kind === "station-shield";
  
      const ang = Math.atan2(nearest.hit.y - station.y, nearest.hit.x - station.x);
  
      const surfaceR = shieldHit ? shieldCollisionRadius(station) : 0;
  
      const hitX = shieldHit ? station.x + Math.cos(ang) * surfaceR : nearest.hit.x;
  
      const hitY = shieldHit ? station.y + Math.sin(ang) * surfaceR : nearest.hit.y;
  
      require("../stationCombat").damageStation(room, station, damage, ship.ownerId, now, hitX, hitY, options);
  
      if (shieldHit) {
  
        room.effects.push({ type: "shieldhit", x: hitX, y: hitY, nx: Math.cos(ang), ny: Math.sin(ang), at: now });
  
      } else {
  
        room.effects.push({ type: "spark", x: hitX, y: hitY, at: now });
  
      }
  
      return { hitX, hitY, t: nearest.t, firstHitIndex: -1, hitTargetShipId: station.id, hitTargetEntityId: station.id };
  
    }
  
  
  
    if (nearest.kind === "drone") {
  
      require("../drones").damageDrone(room, nearest.drone, damage, ship.ownerId, now);
  
      room.effects.push({ type: "spark", x: nearest.hit.x, y: nearest.hit.y, at: now });
  
      return { hitX: nearest.hit.x, hitY: nearest.hit.y, t: nearest.t, firstHitIndex: -1 };
  
    }
  
  
  
    // Unshielded ship: damage the first physical component hit; beam burn-through
  
    // may carry excess into at most one further component inside this same ship.
  
    const target = nearest.target;
  
    const intersections = nearest.intersections;
  
    const comp1 = intersections[0];
  
    const hitPoint1 = comp1.hit;
  
    const burnThroughMult = Number(options.burnThroughCarryMultiplier) || 0;
  
    const impactHeatPerDamage = Math.max(0, Number(options.impactHeatPerDamage) || 0);
  
    const canApplyImpactHeat = impactHeatPerDamage > 0 && !isInSafeZone(room, target.x, target.y, target);
  
  
  
    if (canApplyImpactHeat && isComponentAlive(target, comp1.index)) {
  
      addComponentHeat(target, comp1.index, damage * impactHeatPerDamage);
  
    }
  
  
  
    damageShip(room, target, damage, ship.ownerId, now, hitPoint1.x, hitPoint1.y, {
  
      ...options,
  
      intersections
  
    });
  
  
  
    let contactHitX = hitPoint1.x;
  
    let contactHitY = hitPoint1.y;
  
    if (burnThroughMult > 0 && intersections.length > 1 && !isComponentAlive(target, comp1.index)) {
  
      const comp2 = intersections[1];
  
      if (canApplyImpactHeat && isComponentAlive(target, comp2.index)) {
  
        addComponentHeat(target, comp2.index, damage * burnThroughMult * impactHeatPerDamage);
  
      }
  
      contactHitX = comp2.hit.x;
  
      contactHitY = comp2.hit.y;
  
      room.effects.push({ type: "burst", x: hitPoint1.x, y: hitPoint1.y, at: now });
  
    }
  
  
  
    return { hitX: contactHitX, hitY: contactHitY, t: hitPoint1.t, firstHitIndex: comp1.index, hitTargetShipId: target.id };
  
  }

  return {
    beamImpactPoint,
    beamContactCharge,
    applyBeamHullDamage,
    damageBeamTargets
  };
}

module.exports = { createBeamRuntime };
