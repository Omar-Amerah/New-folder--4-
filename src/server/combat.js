// Applies combat targeting, weapon cooldowns, weapon arcs, damage resolution, and support/healing.



const { PARTS } = require("./components");

const { ECONOMY } = require("./config");
const { BALANCE } = require("./balanceConfig");

const { rngRange, clampNumber, angleDifference, rotateToward, fastHypot, performanceNow, compareIdStrings } = require("./utils");
const { gameplayNow } = require("./gameplayTime");

const { normalizeRotation } = require("./shipDesign");

const { getOccupiedCells } = require("./footprint");

const {

  getShipCollisionGeometry,

  getShipComponentCellWorldCoords,

  invalidateShipCollisionGeometry,

  COMPONENT_CELL_COLLISION_RADIUS

} = require("./componentGeometry");

const { addBullet, removeProjectileRuntime, segmentCircleHit, shieldCollisionRadius, SHIELD_HIT_MIN } = require("./projectiles");

const { canTeamTargetEntity, usesSensorVisibility } = require("./visibility");

const { applyHullDamage, repairShipComponents, isComponentAlive, zeroAllComponents, onComponentDestroyed, markComponentDamageChanged } = require("./componentHealth");

const { addComponentHeat, distributeComponentHeatByWeight, componentPerformance } = require("./heat");

const TurretRules = require("../../public/src/shared/turretRules");
const HeatRules = require("../../public/src/shared/heatRules");
const ShieldRules = require("../../public/src/shared/shieldRules");

const { getComponentPowerMultiplier, effectiveShieldCapacityContributions } = require("./componentPower");

const {
  getEffectiveWeaponStats,
  getEffectiveWeaponStatsInternal,
  getEffectiveWeaponStatsCached,
  ensureEffectiveWeaponProfileCache,
  getMaxEffectiveWeaponRange
} = require("./componentData");

const { getCommandAuraMultiplier } = require("./commandAuras");

const { PRIORITY_COMPONENT_TYPES, getShipRepairCache, markShipRepairCacheDirty } = require("./repairCache");
const RepairRules = require("../../public/src/shared/repairRules.js");

const Relationships = require("./relationships");
const { segmentStationHullHit, nearestStationHullPoint, isSegmentStationClear, stationAttackPoint } = require("./stationCollision");

const TargetingTelemetry = require("./targetingTelemetry");
const PointDefenceThreats = require("./pointDefenceThreats");
const TargetingCadence = require("./targetingCadence");
const Targeting = require("./targetingEligibility");

const { getShipComponentIndexes } = require("./componentIndexes");
const { sanitizeCombatStyle } = require("./validation");



const MODULE_SCALE = 13;





const COMPONENT_RETARGET_MIN_MS = 2500;

const COMPONENT_RETARGET_SPAN_MS = 1500;

const STRUCTURAL_COMPONENT_TYPES = new Set(["armor", "compositeArmor", "bulkhead", "frame", "weaponMount"]);

const SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE = ShieldRules.IMPACT_HEAT_PER_BLOCKED_DAMAGE;

// Accuracy has one universal angular interpretation for weapon fire. The
// authored percentage is the same stat for every weapon family; family-specific
// spread coefficients make the displayed value mean different things.
const ACCURACY_SPREAD_SCALE = 0.22;



function componentAimLocalPosition(ship, index) {

  const module = ship?.design?.[index];

  if (!module) return null;

  return moduleFootprintLocalPosition(module, ship?.moduleScale || MODULE_SCALE);

}



function componentAimWorldPosition(ship, index) {

  const local = componentAimLocalPosition(ship, index);

  if (!local) return null;

  const cos = Math.cos(ship.angle || 0);

  const sin = Math.sin(ship.angle || 0);

  return {

    x: ship.x + local.x * cos - local.y * sin,

    y: ship.y + local.x * sin + local.y * cos

  };

}



function targetAttackPoint(originX, originY, target) {
  if (target?.entityType === "station") return stationAttackPoint(originX, originY, target);
  return { x: target?.x ?? 0, y: target?.y ?? 0 };
}

function targetCoreAimWorldPosition(target, originX = 0, originY = 0) {

  if (target?.entityType === "station") return stationAttackPoint(originX, originY, target);

  if (!target?.alive || !target.design?.length) return null;



  for (let i = 0; i < target.design.length; i += 1) {

    if (target.design[i].type === "core" && isComponentAlive(target, i)) {

      const pos = componentAimWorldPosition(target, i);

      if (pos) return { ...pos, componentIndex: i };

    }

  }



  for (let i = 0; i < target.design.length; i += 1) {

    const type = target.design[i].type;

    if ((type === "backupCore" || type === "emergencyCore" || type === "commandCore" || type === "emergencyCommandCore") && isComponentAlive(target, i)) {

      const pos = componentAimWorldPosition(target, i);

      if (pos) return { ...pos, componentIndex: i };

    }

  }



  const livingCells = [];

  for (let i = 0; i < target.design.length; i += 1) {

    if (!isComponentAlive(target, i)) continue;

    const module = target.design[i];

    const part = PARTS[module.type] || PARTS.frame;

    const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, normalizeRotation(module.rotation));

    livingCells.push(...cells);

  }



  if (!livingCells.length) return null;



  let sumX = 0;

  let sumY = 0;

  for (const cell of livingCells) {

    const local = moduleLocalPosition(cell);

    sumX += local.x;

    sumY += local.y;

  }

  const avgLocal = { x: sumX / livingCells.length, y: sumY / livingCells.length };

  const cos = Math.cos(target.angle || 0);

  const sin = Math.sin(target.angle || 0);

  return {

    x: target.x + avgLocal.x * cos - avgLocal.y * sin,

    y: target.y + avgLocal.x * sin + avgLocal.y * cos,

    componentIndex: -1

  };

}



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
// damage — it reaches past the hull and couples Heat straight into an internal
// subsystem — so the only way to answer it is to put material in the way that
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

function findBeamRayIntersections(target, x1, y1, x2, y2, beamRadius = 0) {

  if (!target?.alive || !target.design?.length) return [];



  // Footprint-aware, shared with projectile collision so beam and bullet

  // geometry can never drift apart. Every occupied cell is tested; the earliest

  // cell hit represents the component.

  const geometry = getShipCollisionGeometry(target);

  const cellCoords = geometry.worldCells;

  const hitMap = new Map();

  for (const i of geometry.liveComponentIndices) {

    if (!isComponentAlive(target, i)) continue;

    const cells = cellCoords[i] || [];

    for (const cell of cells) {

      const hit = segmentCircleHit(x1, y1, x2, y2, cell.x, cell.y, COMPONENT_CELL_COLLISION_RADIUS + beamRadius);

      if (hit) {

        const existing = hitMap.get(i);

        if (!existing || hit.t < existing.t) {

          hitMap.set(i, { index: i, hit, t: hit.t });

        }

      }

    }

  }



  const intersections = Array.from(hitMap.values());

  intersections.sort((a, b) => {

    if (Math.abs(a.t - b.t) > 1e-6) return a.t - b.t;

    const ay = a.hit?.y ?? 0;

    const by = b.hit?.y ?? 0;

    if (Math.abs(ay - by) > 1e-6) return by - ay;

    return a.index - b.index;

  });



  return intersections;

}



function isComponentExposed(ship, index) {

  const module = ship?.design?.[index];

  if (!module) return false;

  const part = PARTS[module.type] || PARTS.frame;

  const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, normalizeRotation(module.rotation));

  const cellIndex = ship.componentCellIndex;

  if (!cellIndex) return true;

  for (const cell of cells) {

    const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (const [dx, dy] of neighbors) {

      const x = cell.x + dx;

      const y = cell.y + dy;

      if (x < 0 || y < 0 || x >= 15 || y >= 15) return true;

      const neighborIndex = cellIndex.get(x * 15 + y);

      if (neighborIndex === undefined || !isComponentAlive(ship, neighborIndex)) return true;

    }

  }

  return false;

}



function componentAimWeight(ship, index, previousIndex = null) {
  const module = ship?.design?.[index];
  if (!module || !isComponentAlive(ship, index)) return 0;
  const type = module.type;
  let weight = 1;
  if (isComponentExposed(ship, index)) weight += 4;
  if (PRIORITY_COMPONENT_TYPES.has(type) || PARTS[type]?.weapon) weight += 3;
  if (STRUCTURAL_COMPONENT_TYPES.has(type)) weight += 1.2;
  if (type === "core") weight *= 0.25;
  if (previousIndex !== null && index === previousIndex) weight *= 0.2;
  return weight;
}

function selectComponentAimIndex(room, target, previousIndex = null) {
  if (!target?.alive || !target.design?.length || !target.componentHp) return -1;
  const living = [];
  const livingNonCore = [];
  for (let i = 0; i < target.design.length; i += 1) {
    if (!isComponentAlive(target, i)) continue;
    if (!componentAimLocalPosition(target, i)) continue;
    living.push(i);
    if (target.design[i].type !== "core") livingNonCore.push(i);
  }
  let candidates = livingNonCore.length ? livingNonCore : living;
  if (candidates.length > 1 && previousIndex !== null) {
    const different = candidates.filter((idx) => idx !== previousIndex);
    if (different.length) candidates = different;
  }
  if (!candidates.length) return -1;
  let total = 0;
  const weighted = candidates.map((idx) => {
    const weight = Math.max(0.01, componentAimWeight(target, idx, previousIndex));
    total += weight;
    return { idx, weight };
  });
  let roll = roomCombatRandom(room)() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll <= 0) return entry.idx;
  }
  return weighted[weighted.length - 1].idx;
}



function nextComponentRetargetAt(room, ship, now) {

  const retentionMult = getCommandAuraMultiplier(ship, "componentAimRetentionMultiplier");

  const base = COMPONENT_RETARGET_MIN_MS + Math.floor(roomCombatRandom(room)() * COMPONENT_RETARGET_SPAN_MS);

  return now + (retentionMult !== 1 ? Math.round(base * retentionMult) : base);

}



function clearWeaponComponentAim(ship, weaponIndex) {

  if (ship?.weaponComponentTargetIds) ship.weaponComponentTargetIds[weaponIndex] = null;

  if (ship?.weaponComponentTargetIndices) ship.weaponComponentTargetIndices[weaponIndex] = -1;

  if (ship?.weaponComponentRetargetAt) ship.weaponComponentRetargetAt[weaponIndex] = 0;

}



function weaponComponentAimPoint(room, ship, weaponIndex, target, now) {

  // Stations are compound structures, never ship component targets. Keep the
  // station id as the selected target but aim at the live shield circumference
  // or nearest solid hull point from this weapon's actual muzzle origin.
  if (target?.entityType === "station") {
    clearWeaponComponentAim(ship, weaponIndex);
    const origin = weaponModuleWorldPosition(ship, ship.design?.[weaponIndex]);
    return { ...stationAttackPoint(origin.x, origin.y, target), componentIndex: -1 };
  }

  if (!target?.alive) {

    clearWeaponComponentAim(ship, weaponIndex);

    return target ? { x: target.x, y: target.y, componentIndex: -1 } : null;

  }

  if (!ship.weaponComponentTargetIds) ship.weaponComponentTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  if (!ship.weaponComponentTargetIndices) ship.weaponComponentTargetIndices = new Array(ship.design ? ship.design.length : 0).fill(-1);

  if (!ship.weaponComponentRetargetAt) ship.weaponComponentRetargetAt = new Array(ship.design ? ship.design.length : 0).fill(0);



  const currentTargetId = ship.weaponComponentTargetIds[weaponIndex];

  let currentIndex = ship.weaponComponentTargetIndices[weaponIndex];

  const targetChanged = currentTargetId !== target.id;

  const invalid = currentIndex === undefined || currentIndex < 0 || !isComponentAlive(target, currentIndex);

  const expired = now >= (ship.weaponComponentRetargetAt[weaponIndex] || 0);

  if (targetChanged || invalid || expired) {

    const previous = targetChanged ? null : currentIndex;
    currentIndex = selectComponentAimIndex(room, target, previous);

    ship.weaponComponentTargetIds[weaponIndex] = target.id;

    ship.weaponComponentTargetIndices[weaponIndex] = currentIndex;

    ship.weaponComponentRetargetAt[weaponIndex] = nextComponentRetargetAt(room, ship, now);

  }

  const point = currentIndex >= 0 ? componentAimWorldPosition(target, currentIndex) : null;

  return point ? { ...point, componentIndex: currentIndex } : { x: target.x, y: target.y, componentIndex: -1 };

}



function shipRepairNeed(ship) {

  return getShipRepairCache(ship).need;

}



// Charge emitters only for repair work the target actually accepted.  Using

// delivered output as the allocation weight makes local and projected repair

// deterministic and prevents spare nominal capacity from producing heat.

function allocateRepairHeat(ship, entries, actualRestored, { useRepairStack = false } = {}) {

  const delivered = Math.max(0, Number(actualRestored) || 0);

  const contributions = useRepairStack
    ? RepairRules.effectiveRepairContributions(entries, BALANCE, (entry) => entry.output)
    : entries.map((entry, index) => ({ item: entry, index, effectiveRate: Math.max(0, Number(entry.output) || 0) }));
  const total = contributions.reduce((sum, contribution) => sum + contribution.effectiveRate, 0);

  if (delivered <= 0 || total <= 0) return;

  for (const contribution of contributions) {

    const entry = contribution.item;

    const work = delivered * contribution.effectiveRate / total;

    addComponentHeat(
      ship,
      entry.index,
      work * HeatRules.activityHeat(entry.module.type, PARTS[entry.module.type] || {}) / Math.max(entry.repairRate, 0.0001)
    );

  }

}



function updateShipSupport(room, ships, dt, now) {

  for (const ship of ships) {

    if (ship.launchPhase) continue;
    if (!ship.stats.repair) continue;



    const activeRepairModules = [];

    const activeRepairBeams = [];

    for (const i of getShipComponentIndexes(ship).repairIndices) {

      const module = ship.design[i];

      const repairRate = PARTS[module.type]?.repairRate || 0;

      if (repairRate <= 0 || !isComponentAlive(ship, i)) continue;

      const heatMultiplier = componentPerformance(ship, i);

      const powerMultiplier = getComponentPowerMultiplier(ship, i);

      const activityMultiplier = heatMultiplier * powerMultiplier;

      if (activityMultiplier <= 0) continue;

      const entry = { index: i, module, repairRate, activityMultiplier, output: repairRate * activityMultiplier };

      activeRepairModules.push(entry);

      if (module.type === "repairBeam") activeRepairBeams.push(entry);

    }

    if (activeRepairModules.length === 0) continue;



    // Local repair modules are self-maintenance only. They must never choose an

    // allied ship the way repair beams do, otherwise a cheap repair module acts

    // like a ranged support beam without the intended turret/targeting cost.

    const localRepairModules = activeRepairModules

      .filter((entry) => entry.module.type !== "repairBeam");
    const selfRepairRate = RepairRules.getEffectiveRepairRate(localRepairModules, BALANCE, (entry) => entry.output);

    if (selfRepairRate > 0 && shipRepairNeed(ship) > 0) {

      const delivered = repairShipComponents(room, ship, selfRepairRate * dt, now);

      allocateRepairHeat(ship, localRepairModules, delivered, { useRepairStack: true });

      ship._repairIntentAt = now; // Section 7D-2: repair systems have a valid action this cycle.

    }



    // Dedicated repair beams are the only repair parts that can project healing

    // onto another ship. They still use normal repair output and heat, but they

    // also traverse like beam weapons and emit a green beam from their muzzle.

    const beamRepairRate = RepairRules.sumRepairRates(activeRepairBeams.map((entry) => entry.output));

    if (beamRepairRate <= 0) continue;



    let target = null;

    let worst = 0;



    // A player-assigned repair target takes priority while it is a valid,

    // damaged ally in range; it is cleared once destroyed.

    if (ship.repairTargetId) {

      const assigned = room.ships.get(ship.repairTargetId);

      if (!assigned || !assigned.alive) {

        ship.repairTargetId = null;

      } else if (assigned.id === ship.id) {

        ship.repairTargetId = null;

      } else if (areAllies(room, ship.ownerId, assigned.ownerId)

        && shipRepairNeed(assigned) > 0

        && (assigned.x - ship.x) ** 2 + (assigned.y - ship.y) ** 2 <= ship.stats.repairRange ** 2) {

        target = assigned;

      }

    }



    if (!target) {

      const candidates = room.spatialIndex

        ? room.spatialIndex.queryRange(

          "ships",

          ship.x,

          ship.y,

          ship.stats.repairRange,

          room._supportSpatialScratch || (room._supportSpatialScratch = [])

        )

        : ships;

      const repairRangeSq = ship.stats.repairRange * ship.stats.repairRange;

      for (const other of candidates) {

        if (other.id === ship.id) continue;

        if (!areAllies(room, ship.ownerId, other.ownerId)) continue;

        const missing = shipRepairNeed(other);

        if (missing <= 0) continue;

        const dx = other.x - ship.x;

        const dy = other.y - ship.y;

        const distanceSq = dx * dx + dy * dy;

        if (distanceSq > repairRangeSq) continue;

        const distance = Math.sqrt(distanceSq);

        const urgency = missing / Math.max(1, distance * 0.08);

        if (urgency > worst) {

          target = other;

          worst = urgency;

        }

      }

    }



    if (!target) continue;

    const delivered = repairShipComponents(room, target, beamRepairRate * dt, now, ship);

    allocateRepairHeat(ship, activeRepairBeams, delivered);

    ship._repairIntentAt = now; // Section 7D-2: a repair beam has a valid target this cycle.



    if (!ship.weaponAngles) ship.weaponAngles = (ship.design || []).map((m) => moduleRotationToRadians(normalizeRotation(m.rotation)));



    for (const entry of activeRepairBeams) {

      const emitter = entry.module;

      const emitterIndex = entry.index;

      const origin = weaponModuleWorldPosition(ship, emitter);

      const worldAngleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);

      const desiredRelative = angleDifference(ship.angle, worldAngleToTarget);

      const currentRelative = ship.weaponAngles[emitterIndex] ?? moduleRotationToRadians(normalizeRotation(emitter.rotation));

      ship.weaponAngles[emitterIndex] = rotateToward(currentRelative, desiredRelative, TurretRules.turnRateFor("beam") * dt);

    }



    // Emit a continuous repair beam from each active repair beam emitter muzzle.

    if (now - (ship.repairPulseAt || 0) > 90) {

      ship.repairPulseAt = now;

      for (const entry of activeRepairBeams) {

        const emitter = entry.module;

        const emitterIndex = entry.index;

        const currentAngle = ship.weaponAngles?.[emitterIndex] ?? moduleRotationToRadians(normalizeRotation(emitter.rotation));

        const muzzle = weaponMuzzleWorldPosition(ship, emitter, ship.angle + currentAngle, "beam");

        room.effects.push({ type: "repairbeam", x: muzzle.x, y: muzzle.y, x2: target.x, y2: target.y, at: now, ownerId: ship.ownerId });

      }

    }

  }

}





function stableId(value) {

  return String(value?.id ?? value ?? "");

}



function isStableIdBefore(a, b) {

  return compareIdStrings(stableId(a), stableId(b)) < 0;

}



function roomCombatRandom(room) {

  return typeof room?.combatRandom === "function" ? room.combatRandom : Math.random;

}



// Broad-phase helpers -------------------------------------------------------

//

// Line-of-sight and beam resolution used to scan every asteroid/ship/drone in

// the room on every call, from inside per-weapon and per-candidate loops. Both

// go through the room broad phase instead, exactly like projectile and

// movement collision already do.

//

// Padding note: an entity is inserted into the index using its own broad-phase

// radius R, and the narrow test accepts it at (entityRadius + extra). Because

// R >= entityRadius for every kind, padding the query by `extra` alone makes

// the returned set a conservative superset of the true hits.

//

// The index is only consulted once the asteroid kind actually mirrors the map;

// callers reached outside the tick loop (and unit tests that build rooms by

// hand) still fall back to the authoritative array so no rock is ever missed.

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



function weaponSpreadRadians(weapon) {

  const accuracy = clampNumber(Number(weapon?.accuracy) || 0.8, 0.1, 0.99);

  return (1 - accuracy) * ACCURACY_SPREAD_SCALE;
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





function isInSafeZone(room, x, y, shipOrPlayer = null) {

  if (!room.map || !room.map.safeZones) return false;

  const player = shipOrPlayer?.ownerId ? room.players?.get(shipOrPlayer.ownerId) : shipOrPlayer;

  for (const zone of room.map.safeZones) {

    if (fastHypot(x - zone.x, y - zone.y) > zone.radius) continue;

    if (zone.ownerId) return Boolean(player && player.id === zone.ownerId);

    if (zone.team) return Boolean(player && player.team === zone.team);

    return true;

  }

  return false;

}



function getCadencedShipCombatTarget(room, ship, ships, now) {
  if (!ship._combatTargetState) ship._combatTargetState = { id: null, focusId: null, nextSearchAt: 0 };
  const state = ship._combatTargetState;
  const focusId = ship.focusTargetId || null;
  const focusChanged = state.focusId !== focusId;
  state.focusId = focusId;

  const maxRange = maxShipWeaponAcquisitionRange(ship);
  const allTargets = (ships || []).concat((room?.stations || []).filter((s) => s && s.alive !== false && s.state !== "destroyed"));

  let current = null;
  let currentValid = false;
  const cachedId = ship.combatTargetId || null;
  if (cachedId) {
    current = allTargets.find((e) => e && e.id === cachedId) || room.ships?.get?.(cachedId) || null;
    if (current) {
      currentValid = Targeting.isOrdinaryWeaponTargetValid(room, ship, current, now, maxRange, {
        originX: ship.x,
        originY: ship.y
      });
      const currentPoint = targetAttackPoint(ship.x, ship.y, current);
      if (currentValid && TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, ship.x, ship.y, currentPoint.x, currentPoint.y, 8))) currentValid = false;
      if (!currentValid) TargetingTelemetry.bump(room, "shipCombatTargetInvalidations");
    }
  }

  if (focusId) {
    const focused = allTargets.find((e) => e && e.id === focusId);
    if (focused && focused.entityType === "station"
      && focused.alive !== false
      && Relationships.areEntityEnemies(room, ship.ownerId, focused)
      && canTeamTargetEntity(room, ship.team, focused, now)) {
      ship.combatTargetId = focused.id;
      return focused;
    }
    if (focused && Targeting.isOrdinaryWeaponTargetValid(room, ship, focused, now, maxRange, { originX: ship.x, originY: ship.y })) {
      const focusedPoint = targetAttackPoint(ship.x, ship.y, focused);
      const focusedBlocked = TargetingTelemetry.withSampledDuration(
        room,
        now,
        ship,
        0,
        "sampledLineOfSightDuration",
        () => isLineBlocked(room, ship.x, ship.y, focusedPoint.x, focusedPoint.y, 8)
      );
      if (!focusedBlocked) {
        ship.combatTargetId = focused.id;
        return focused;
      }
    }
  }

  const hadCachedTarget = cachedId !== null;
  const force = focusChanged || (hadCachedTarget && !currentValid);
  const due = TargetingCadence.isAcquisitionDue(ship, "shipCombat", 0, now);

  if (currentValid && !force && !due) {
    TargetingTelemetry.bump(room, "shipCombatTargetCacheHits");
    return current;
  }

  if (!currentValid && !force && !due) {
    TargetingTelemetry.bump(room, "shipCombatTargetSearchDeferred");
    ship.combatTargetId = null;
    return null;
  }

  TargetingTelemetry.bump(room, "shipCombatTargetSearches");
  const target = findTarget(room, ship, ships);
  ship.combatTargetId = target ? target.id : null;
  TargetingCadence.markAcquisitionCompleted(ship, "shipCombat", 0, now);
  return target;
}

// --- Spinal charge cycle ------------------------------------------------------
//
// A spinal mount does not fire on cooldown alone: it has to hold a firing
// solution for `chargeSeconds` first, and the charge is visible on the hull the
// whole time. Losing the solution does not instantly waste that work — the
// charge survives `chargeHoldSeconds` and only then bleeds away, so a target
// sidestepping for half a second does not reset ten seconds of aiming. Progress
// is 0..1 and is the exact value replicated to the client as the glow travelling
// up the barrel; nothing else may derive it.

function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function spinalChargeProgress(ship, index, config) {
  const seconds = Math.max(0.05, finiteOr(config?.chargeSeconds, 10));
  return clampNumber((ship.weaponCharge?.[index] || 0) / seconds, 0, 1);
}

// Run once per tick for every spinal mount, before the firing branch decides
// whether it may add to the charge. Keeping the decay unconditional here means
// every early return in the weapon loop (out of arc, out of range, reloading,
// no target, blocked line of fire) bleeds the charge without each one having to
// remember to.
function decaySpinalCharge(ship, index, config, dt) {
  const idle = (ship.weaponChargeIdle[index] || 0) + dt;
  ship.weaponChargeIdle[index] = idle;
  const hold = Math.max(0, finiteOr(config.chargeHoldSeconds, 0));
  if (idle > hold && (ship.weaponCharge[index] || 0) > 0) {
    ship.weaponCharge[index] = Math.max(0, ship.weaponCharge[index] - dt * Math.max(0, finiteOr(config.chargeDecayMultiplier, 1)));
  }
  return spinalChargeProgress(ship, index, config);
}

function clearSpinalCharge(ship, index) {
  if (ship.weaponCharge) ship.weaponCharge[index] = 0;
  if (ship.weaponChargeIdle) ship.weaponChargeIdle[index] = 0;
}

// Traverse authority falls away as the charge nears full: past
// committedAimStartProgress the mount slows toward committedAimTraverseFloor, so
// the shot has to be aimed where the target will be rather than where it is.
function spinalTraverseScale(config, progress) {
  const start = clampNumber(finiteOr(config.committedAimStartProgress, 0.5), 0, 1);
  const floor = clampNumber(finiteOr(config.committedAimTraverseFloor, 0.05), 0, 1);
  if (progress <= start) return 1;
  const t = clampNumber((progress - start) / Math.max(1e-6, 1 - start), 0, 1);
  return 1 + (floor - 1) * t;
}

// In the final stage the hull itself is part of the aim and turns sluggishly.
function spinalHullTurnScale(config, progress) {
  const start = clampNumber(finiteOr(config.hullTurnPenaltyStartProgress, 0.8), 0, 1);
  if (progress < start) return 1;
  return clampNumber(finiteOr(config.hullTurnPenaltyMultiplier, 1), 0.05, 1);
}

function updateShipWeapons(room, ship, ships, dt, now) {

  if (ship.launchPhase) {
    ship.combatTargetId = null;
    if (ship.weaponAimTargetIds) ship.weaponAimTargetIds.fill(null);
    if (ship.weaponFireTargetIds) ship.weaponFireTargetIds.fill(null);
    if (ship.weaponComponentTargetIds) ship.weaponComponentTargetIds.fill(null);
    if (ship.weaponCharge) ship.weaponCharge.fill(0);
    if (ship.weaponChargeIdle) ship.weaponChargeIdle.fill(0);
    ship.spinalTurnPenalty = 1;
    return;
  }

  if (!ship.weaponCooldowns) {

    ship.weaponCooldowns = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponAngles) {

    ship.weaponAngles = (ship.design || []).map(module => moduleRotationToRadians(normalizeRotation(module.rotation)));

  }

  // Which barrel each multi-barrel weapon fires next. Purely cosmetic: the
  // shot count, damage and cadence are unchanged, the rounds just alternate
  // between the visible tubes.

  if (!ship.weaponBarrelIndex) {

    ship.weaponBarrelIndex = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.beamEffectsAt) {

    ship.beamEffectsAt = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponDesiredAngles) {

    ship.weaponDesiredAngles = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponAimTargetIds) {

    ship.weaponAimTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponFireTargetIds) {

    ship.weaponFireTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponComponentTargetIds) {

    ship.weaponComponentTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponComponentTargetIndices) {

    ship.weaponComponentTargetIndices = new Array(ship.design ? ship.design.length : 0).fill(-1);

  }

  if (!ship.weaponComponentRetargetAt) {

    ship.weaponComponentRetargetAt = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponBeamContacts) {

    ship.weaponBeamContacts = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponInductionContacts) {

    ship.weaponInductionContacts = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  // Spinal charge state: seconds of charge accumulated, and seconds since the
  // mount last had a firing solution. Both are per weapon slot and are the only
  // authority for the charge glow the client renders.
  if (!ship.weaponCharge) {

    ship.weaponCharge = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponChargeIdle) {

    ship.weaponChargeIdle = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  // Rebuilt from scratch each tick by the charging weapons themselves, so a
  // destroyed, unpowered or discharged mount stops penalising the hull.
  let spinalTurnPenalty = 1;



  // Per-tick map of how much damage has already been committed to each fragile
  // target by point-defense weapons on this ship. It resets every tick so
  // multiple defensive weapons can coordinate without overkilling the same
  // missile. Stored on the room because it is shared across ships in the room.
  if (!room._pdReservations) room._pdReservations = new Map();
  room._pdReservations.clear();

  const weaponIndices = getShipComponentIndexes(ship).weaponIndices;

  const cache = TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledProfileBuildDuration", () =>
    ensureEffectiveWeaponProfileCache(ship)
  );
  if (cache) {
    const prev = ship._effectiveWeaponProfileCacheRevision;
    if (prev !== cache.revision) {
      TargetingTelemetry.bump(room, "effectiveWeaponProfileCacheMisses");
      TargetingTelemetry.bump(room, "effectiveWeaponProfileBuilds");
      ship._effectiveWeaponProfileCacheRevision = cache.revision;
    } else {
      TargetingTelemetry.bump(room, "effectiveWeaponProfileCacheHits");
    }
  } else {
    TargetingTelemetry.bump(room, "effectiveWeaponProfileInvalidations");
  }

  for (const i of weaponIndices) {

    ship.weaponCooldowns[i] = Math.max(0, ship.weaponCooldowns[i] - dt);

  }



  // Safe zones block FIRING only — never aiming. Target acquisition and

  // turret traverse continue so protected ships visibly track threats instead

  // of freezing at the blueprint angle in spawn.

  const firingBlockedBySafeZone = isInSafeZone(room, ship.x, ship.y, ship);



  const target = getCadencedShipCombatTarget(room, ship, ships, now);



  weaponIndices.forEach((i) => {

    const module = ship.design[i];

    const part = PARTS[module.type];

    const isRepairBeam = module.type === "repairBeam";

    if (!part?.weapon && !isRepairBeam) return;

    if (!isComponentAlive(ship, i)) {

      // Destroyed weapons neither aim nor fire; the client freezes their art.

      ship.weaponAimTargetIds[i] = null;

      ship.weaponFireTargetIds[i] = null;

      clearWeaponComponentAim(ship, i);

      clearSpinalCharge(ship, i);

      if (ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      return;

    }

    const powerMultiplier = getComponentPowerMultiplier(ship, i);

    // Weapon traverse motors require Power; unpowered weapons cannot acquire

    // targets or rotate toward them.

    if (powerMultiplier <= 0) {

      ship.weaponAimTargetIds[i] = null;

      ship.weaponFireTargetIds[i] = null;

      clearWeaponComponentAim(ship, i);

      clearSpinalCharge(ship, i);

      if (ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      return;

    }



    const effectiveWeapon = isRepairBeam

      ? { type: "beam", arc: 360, range: ship.stats?.repairRange || 400, aimSpeed: TurretRules.turnRateFor("beam") }

      : (getEffectiveWeaponStatsCached(ship, i) || part.weapon);

    const family = effectiveWeapon.type || part.weapon?.type || "beam";

    const cooldown = ship.weaponCooldowns[i] || 0;

    // Spinal mounts bleed charge every tick they are not actively charging; the
    // firing branch below is the only thing that adds to it.
    const spinalConfig = effectiveWeapon.spinalCharge || null;

    const spinalProgress = spinalConfig ? decaySpinalCharge(ship, i, spinalConfig, dt) : 0;
    let spinalActivityHeatApplied = false;

    if (spinalConfig && spinalProgress > 0) {
      spinalTurnPenalty = Math.min(spinalTurnPenalty, spinalHullTurnScale(spinalConfig, spinalProgress));
    }



    const arcRadians = (effectiveWeapon.arc || 360) * Math.PI / 180;

    const weaponOrigin = weaponModuleWorldPosition(ship, module);

    const worldX = weaponOrigin.x;

    const worldY = weaponOrigin.y;

    const range = effectiveWeapon.range || 0;



    const defaultRelative = moduleRotationToRadians(normalizeRotation(module.rotation));



    let currentPdTarget = null;

    let weaponTarget = null;

    let aimEntity = null;

    let aimPoint = null;

    let fireAimPoint = null;



    if (isRepairBeam) {

      let repairTarget = null;

      if (ship.repairTargetId) {

        const assigned = room.ships.get(ship.repairTargetId);

        if (assigned && assigned.alive && assigned.id !== ship.id && areAllies(room, ship.ownerId, assigned.ownerId)

          && (assigned.x - worldX) ** 2 + (assigned.y - worldY) ** 2 <= range * range) {

          repairTarget = assigned;

        }

      }

      if (!repairTarget) {

        let worst = 0;

        const candidates = room.spatialIndex

          ? room.spatialIndex.queryRange(

            "ships",

            worldX,

            worldY,

            range,

            room._weaponSupportSpatialScratch || (room._weaponSupportSpatialScratch = [])

          )

          : ships;

        const rangeSq = range * range;

        for (const other of candidates) {

          if (other.id === ship.id || !other.alive) continue;

          if (!areAllies(room, ship.ownerId, other.ownerId)) continue;

          const missing = shipRepairNeed(other);

          if (missing <= 0) continue;

          const dx = other.x - worldX;

          const dy = other.y - worldY;

          const distanceSq = dx * dx + dy * dy;

          if (distanceSq > rangeSq) continue;

          const distance = Math.sqrt(distanceSq);

          const urgency = missing / Math.max(1, distance * 0.08);

          if (urgency > worst) {

            repairTarget = other;

            worst = urgency;

          }

        }

      }

      aimEntity = repairTarget;

      if (aimEntity) aimPoint = { x: aimEntity.x, y: aimEntity.y };

    } else if (family === "flak" || family === "pointDefense") {

      // Defensive target selection uses the shared search cadence. A valid
      // tracked threat remains selected between searches; invalidation forces
      // a search immediately, with no separate reaction or switch timer.
      const worldWeaponAngle = (ship.angle || 0) + (ship.weaponAngles[i] || 0);
      const pdArcRadians = arcRadians;
      const pdBaseWeapon = part.weapon || effectiveWeapon;
      const pdTrackedId = ship.weaponFireTargetIds[i] ?? null;
      const pdTracked = pdTrackedId ? _lookupPointDefenceEntity(room, pdTrackedId) : null;
      const isPdCandidateValid = (candidate) => {
        if (!candidate) return false;
        const valid = Targeting.isPointDefenceTargetValid(room, ship.ownerId, candidate, effectiveWeapon.range || 0, now, {
          originX: worldX,
          originY: worldY,
          arcRadians: pdArcRadians,
          weaponAngle: worldWeaponAngle,
          reservations: room._pdReservations,
          priorityList: pdBaseWeapon.targetPriority,
          team: ship.team
        });
        if (!valid) return false;
        return !TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledLineOfSightDuration", () =>
          isLineBlocked(room, worldX, worldY, candidate.entity.x, candidate.entity.y, 4)
        );
      };
      let pdCurrentValid = false;
      if (pdTracked) {
        pdCurrentValid = isPdCandidateValid(pdTracked);
        if (!pdCurrentValid) TargetingTelemetry.bump(room, "pointDefenceImmediateReacquisitions");
      }

      const pdDue = TargetingCadence.isAcquisitionDue(ship, "pointDefence", i, now);
      const pdForce = pdTrackedId !== null && !pdCurrentValid;
      if (pdCurrentValid && !pdDue) {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
        currentPdTarget = pdTracked;
      } else if (!pdDue && !pdForce) {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
        currentPdTarget = null;
      } else {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearches");
        currentPdTarget = findPointDefenseTarget(room, worldX, worldY, ship.ownerId, effectiveWeapon, ships, ship.id, now);
        TargetingCadence.markAcquisitionCompleted(ship, "pointDefence", i, now);
      }

      aimEntity = currentPdTarget ? currentPdTarget.entity : null;
      if (!aimEntity) clearWeaponComponentAim(ship, i);

    } else {

      // Keep the ship's assigned target when this weapon can reach it, otherwise

      // fall back to any valid enemy already in this weapon's range so it does

      // not idle while the primary target is out of reach. The assigned target

      // itself is retained at the ship level and resumed once it is attackable.

      // Fire-Control target selection remains cadence-limited, but a newly
      // selected valid target can be fired at immediately once other weapon
      // requirements are satisfied.
      weaponTarget = getCadencedWeaponTarget(room, ship, ships, worldX, worldY, target, range, { weapon: effectiveWeapon, module }, i, now, "ordinaryShip");
      aimEntity = weaponTarget || (target && target.alive !== false && !target.destroyed ? target : null);

      if (aimEntity) {

        if (family === "beam") {

          if (isInductionBeam(effectiveWeapon)) {

            aimPoint = getInductionAimPoint(room, ship, i, aimEntity, now, worldX, worldY, effectiveWeapon);

          } else {

            aimPoint = targetCoreAimWorldPosition(aimEntity, worldX, worldY);

          }

          if (aimPoint && effectiveWeapon.accuracy < 1 && !isInductionBeam(effectiveWeapon)) {

            const maxErrorRad = weaponSpreadRadians(effectiveWeapon);

            const seed = (((String(ship.id).split("").reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)) & 0x7fffffff) + i * 37) % 1000;

            const smoothError = maxErrorRad * Math.sin(seed + now * 0.0015);

            aimPoint = {

              ...aimPoint,

              smoothError

            };

          }

          if (!aimPoint) {

            aimEntity = null;

            clearWeaponComponentAim(ship, i);

          } else if (weaponTarget && aimEntity === weaponTarget) {

            fireAimPoint = aimPoint;

          }

        } else {

          aimPoint = weaponComponentAimPoint(room, ship, i, aimEntity, now);

          if (weaponTarget && aimEntity === weaponTarget) fireAimPoint = aimPoint;

        }

      } else {

        clearWeaponComponentAim(ship, i);

      }

    }



    // The desired angle is clamped by the weapon's fixed blueprint arc: targets

    // outside the arc are not tracked. With no valid aim target the turret

    // sweeps back toward its blueprint facing (rotateToward keeps this smooth —

    // it never snaps).

    let desiredRelative = defaultRelative;

    let isTracking = false;

    if (aimEntity) {

      const aimX = aimPoint ? aimPoint.x : aimEntity.x;

      const aimY = aimPoint ? aimPoint.y : aimEntity.y;

      let worldAngleToTarget = Math.atan2(aimY - worldY, aimX - worldX);

      if (aimPoint?.smoothError) {

        worldAngleToTarget += aimPoint.smoothError;

      }

      const relativeAngleToTarget = angleDifference(ship.angle, worldAngleToTarget);

      const diff = angleDifference(defaultRelative, relativeAngleToTarget);

      if (Math.abs(diff) <= arcRadians / 2) {

        desiredRelative = relativeAngleToTarget;

        isTracking = true;

      }

    }



    const turnRate = getWeaponTurnRate(effectiveWeapon)
      * (spinalConfig ? spinalTraverseScale(spinalConfig, spinalProgress) : 1);

    const currentRelative = ship.weaponAngles[i] !== undefined ? ship.weaponAngles[i] : defaultRelative;

    ship.weaponAngles[i] = TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponAimDuration", () =>
      rotateToward(currentRelative, desiredRelative, turnRate * dt)
    );



    // Development/diagnostic trace of the aim decision (cheap flat writes; read

    // by buildShipTurretDiagnostics and the dev debug endpoint).

    ship.weaponDesiredAngles[i] = desiredRelative;

    ship.weaponAimTargetIds[i] = isTracking && aimEntity ? aimEntity.id ?? null : null;

    ship.weaponFireTargetIds[i] = isRepairBeam ? (isTracking && aimEntity ? aimEntity.id ?? null : null)

      : (family === "pointDefense" || family === "flak"

        ? (currentPdTarget ? currentPdTarget.entity.id ?? null : null)

        : (weaponTarget ? weaponTarget.id ?? null : null));



    if (isRepairBeam) return;



    // ---- Firing permission (independent of aiming) ----

    // Protected ships never fire: no projectile, no beam damage, no firing

    // heat, and the cooldown is not consumed as though a shot fired.

    if (firingBlockedBySafeZone) return;



    // Unpowered weapons cannot traverse or fire and clear their targeting state.

    // Powered but thermally disabled weapons may keep tracking, but cannot fire.

    const heatMultiplier = componentPerformance(ship, i);

    const activityMultiplier = powerMultiplier * heatMultiplier;

    if (activityMultiplier <= 0) {

      if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;

      return;

    }

    if (spinalConfig
      && spinalProgress > 0
      && (ship.weaponChargeIdle[i] || 0) <= Math.max(0, finiteOr(spinalConfig.chargeHoldSeconds, 0))) {
      addComponentHeat(ship, i, HeatRules.activityHeat(module.type, part) * activityMultiplier * dt);
      spinalActivityHeatApplied = true;
    }



    // Tracking is continuous while reloading. Only firing is cooldown-gated;

    // otherwise the visible turret freezes between shots and snaps at fire time.

    if (cooldown > 0) {

      if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;

      return;

    }



    // Fire only at an in-range target the turret is actually tracking in-arc.

    if (family === "pointDefense" || family === "flak") {

      if (!currentPdTarget || !isTracking) return;

    } else {

      if (!weaponTarget || !isTracking || aimEntity !== weaponTarget) {

        if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;

        return;

      }

    }



    const worldWeaponAngle = ship.angle + ship.weaponAngles[i];

    const targetEntity = family === "pointDefense" || family === "flak" ? currentPdTarget.entity : weaponTarget;

    const targetAimX = fireAimPoint ? fireAimPoint.x : targetEntity.x;

    const targetAimY = fireAimPoint ? fireAimPoint.y : targetEntity.y;

    const targetDistance = fastHypot(targetAimX - worldX, targetAimY - worldY);
    if (targetDistance > range) {
      if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;
      return;
    }

    const worldAngleToTarget = Math.atan2(targetAimY - worldY, targetAimX - worldX);

    // Alignment tolerance is tighter for Laser PD than for ballistic
    // interceptor pods; flak keeps the legacy wider cone.
    const alignmentThreshold = module.type === "pointDefense" ? 0.035 : (module.type === "interceptorPod" ? 0.2 : 0.26);

    const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));

    if (family !== "beam" && angleErr > alignmentThreshold) return;



    const spreadScale = weaponSpreadRadians(effectiveWeapon);

    const spread = rngRange(roomCombatRandom(room), -spreadScale, spreadScale);

    const shotAngle = worldWeaponAngle + spread;



    const barrelIndex = ship.weaponBarrelIndex?.[i] || 0;

    const muzzle = weaponMuzzleWorldPosition(ship, module, worldWeaponAngle, family, barrelIndex);



    if (family === "blaster") {

      const speed = effectiveWeapon.projectileSpeed || 620;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      // One trigger pull, one or more projectiles. `damage` is per pellet, so a
      // Scatter Cannon pays the armour flat reduction on every pellet — that is
      // the whole point of the weapon and must not be collapsed into one shot.
      const pellets = pelletShotCount(effectiveWeapon);

      const pelletCone = pellets > 1
        ? Math.max(0, Number(effectiveWeapon.pelletSpreadDegrees) || 0) * Math.PI / 180
        : 0;

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => {

        for (let pellet = 0; pellet < pellets; pellet += 1) {

          const pelletAngle = pelletCone > 0
            ? shotAngle + rngRange(roomCombatRandom(room), -pelletCone, pelletCone)
            : shotAngle;

          addBullet(room, {

            type: "bolt",

            // Presentation only: lets the client size the tracer by weapon.
            subtype: module.type,

            ownerId: ship.ownerId,

            targetId: weaponTarget.id,

            targetComponentIndex: fireAimPoint?.componentIndex ?? -1,

            x: muzzle.x,

            y: muzzle.y,

            vx: Math.cos(pelletAngle) * speed + ship.vx * 0.25,

            vy: Math.sin(pelletAngle) * speed + ship.vy * 0.25,

            damage: effectiveWeapon.damage,

            shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

            hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

            ...impactPayload(effectiveWeapon),

            life: life,

            bornAt: now

          });

        }

      });

      ship.weaponCooldowns[i] = reload;

      // Cosmetic only: hand the next round to the other tube of a twin mount.

      if (ship.weaponBarrelIndex) {

        ship.weaponBarrelIndex[i] = (barrelIndex + 1) % TurretRules.barrelCount(module.type);

      }

      addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

    } else if (family === "missile") {

      const speed = effectiveWeapon.projectileSpeed || 330;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

        type: "missile",

        subtype: module.type,

        interceptable: true,

        hp: effectiveWeapon.missileHp || 20,

        ownerId: ship.ownerId,

        targetId: weaponTarget.id,

        targetComponentIndex: fireAimPoint?.componentIndex ?? -1,

        x: muzzle.x,

        y: muzzle.y,

        vx: Math.cos(shotAngle) * speed,

        vy: Math.sin(shotAngle) * speed,

        damage: effectiveWeapon.damage,

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        tracking: effectiveWeapon.tracking ?? 0.75,

        trackRemaining: effectiveWeapon.trackTime ?? 1.4,

        trackingDelay: effectiveWeapon.trackingDelay ?? 0.25,

        projectileSpeed: speed,

        life: life,

        bornAt: now,

        age: 0

      });

    });

      ship.weaponCooldowns[i] = reload;

      addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

    } else if (family === "beam" && isInductionBeam(effectiveWeapon)) {

      fireInductionLance(room, ship, i, weaponTarget, muzzle, worldWeaponAngle, effectiveWeapon, part, dt, now, activityMultiplier, powerMultiplier);

    } else if (family === "beam") {

      const rangeVal = effectiveWeapon.range;

      const beamRadius = effectiveWeapon.radius || 28;

      const beamEnd = beamImpactPoint(room, muzzle.x, muzzle.y, worldWeaponAngle, rangeVal, beamRadius);

      const beamPerformance = activityMultiplier;

      const baseFireRate = Number(part.weapon.fireRate) || 0;

      const effectiveFireRate = Number(effectiveWeapon.fireRate) || baseFireRate;

      // Continuous beams do not spend cooldowns; Fire Control's per-weapon

      // fire-rate allocation is interpreted exactly once as sustained output.

      const dataFireRateFactor = baseFireRate > 0 ? effectiveFireRate / baseFireRate : 1;

      const prevContact = ship.weaponBeamContacts[i];

      const charge = beamContactCharge(prevContact, weaponTarget?.id, worldWeaponAngle, effectiveWeapon);

      const beamResult = TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledBeamProcessingDuration", () =>
        damageBeamTargets(room, ship, ships, muzzle.x, muzzle.y, beamEnd.x, beamEnd.y, beamRadius, effectiveWeapon.damage * dataFireRateFactor * beamPerformance * charge.multiplier * dt, now, {

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        burnThroughCarryMultiplier: effectiveWeapon.burnThroughCarryMultiplier,

        impactHeatPerDamage: effectiveWeapon.impactHeatPerDamage,

        beamDeltaSeconds: dt,

        weaponIndex: i

      })

    );



      const firstHitIndex = beamResult?.firstHitIndex ?? -1;

      // A physical component contact sustains the weapon's aimed-target lock.

      // In tightly overlapping formations the nearest-entity resolver may name

      // a neighbouring blocker, but resetting the aimed beam here makes charge

      // flicker and breaks the established targeting contract.

      const hitIntendedTarget = Boolean(

        weaponTarget

        && (beamResult?.hitTargetShipId === weaponTarget.id || firstHitIndex >= 0)

      );

      const targetChanged = !hitIntendedTarget || (prevContact && prevContact.targetShipId !== weaponTarget.id);

      const angleShifted = prevContact && Math.abs(angleDifference(prevContact.contactAngle, worldWeaponAngle)) > 0.05;



      if (!prevContact || targetChanged || angleShifted) {

        ship.weaponBeamContacts[i] = hitIntendedTarget ? {

          targetShipId: weaponTarget.id,

          firstHitComponentIndex: firstHitIndex,

          contactAngle: worldWeaponAngle,

          contactDuration: dt

        } : null;

      } else if (prevContact) {

        prevContact.contactDuration += dt;

        prevContact.contactAngle = worldWeaponAngle;

        prevContact.firstHitComponentIndex = firstHitIndex;

      }



      const effectX2 = beamResult?.hitX ?? beamEnd.x;

      const effectY2 = beamResult?.hitY ?? beamEnd.y;



      addComponentHeat(ship, i, HeatRules.activityHeat(module.type, part) * activityMultiplier * dt);

      if (now - (ship.beamEffectsAt[i] || 0) > 55) {

        ship.beamEffectsAt[i] = now;

        room.effects.push({

          type: "beam",

          ownerId: ship.ownerId,

          x: muzzle.x,

          y: muzzle.y,

          x2: effectX2,

          y2: effectY2,

          radius: beamRadius,

          charge: charge.progress,

          at: now

        });

      }

    } else if (family === "flak") {

      if (currentPdTarget) {

        const speed = effectiveWeapon.projectileSpeed || 850;

        const life = (effectiveWeapon.projectileLifetime || 0) > 0

          ? effectiveWeapon.projectileLifetime

          : (effectiveWeapon.range || 0) / speed;

        const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

        const targetEnt = currentPdTarget.entity;
        const targetType = currentPdTarget.type;
        const reserved = room._pdReservations.get(targetEnt.id) || 0;
        const baseHp = targetType === "projectile" ? (targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20))
                       : targetType === "drone" ? (targetEnt.hull || 0)
                       : targetType === "decoy" ? 1
                       : Infinity;
        if (baseHp - reserved <= 0.001) {
          currentPdTarget = null;
          return;
        }
        const blastDamage = effectiveWeapon.blastDamage ?? effectiveWeapon.damage ?? 0;
        const expectedDamage = Number.isFinite(baseHp) ? Math.min(blastDamage, Math.max(0, baseHp - reserved)) : 0;
        if (expectedDamage > 0) room._pdReservations.set(targetEnt.id, reserved + expectedDamage);

        TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

          type: "flak",

          subtype: module.type,

          ownerId: ship.ownerId,

          targetId: targetEnt.id,

          x: muzzle.x,

          y: muzzle.y,

          vx: Math.cos(shotAngle) * speed + ship.vx * 0.2,

          vy: Math.sin(shotAngle) * speed + ship.vy * 0.2,

          damage: effectiveWeapon.directDamage ?? effectiveWeapon.damage ?? 0,

          blastDamage: effectiveWeapon.blastDamage ?? 0,

          blastRadius: effectiveWeapon.blastRadius ?? 0,

          proximityFuseRadius: effectiveWeapon.proximityFuseRadius ?? 0,

          innerFullDamageRadius: effectiveWeapon.innerFullDamageRadius ?? 0,

          falloffExponent: effectiveWeapon.falloffExponent ?? 1,

          shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

          hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

          life: life,

          bornAt: now

        });

        });

        ship.weaponCooldowns[i] = reload;

        addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

      }

    } else if (family === "pointDefense") {

      if (currentPdTarget) {

         const isHitscanLaserPd = module.type === "pointDefense" || (Number(effectiveWeapon.projectileSpeed) || 0) === 0;

         if (isHitscanLaserPd) {

            const targetEnt = currentPdTarget.entity;

            if (!TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledLineOfSightDuration", () => isLineBlocked(room, muzzle.x, muzzle.y, targetEnt.x, targetEnt.y, 4))) {

               const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

               const damage = effectiveWeapon.damage;

               const targetType = currentPdTarget.type;
               const reserved = room._pdReservations.get(targetEnt.id) || 0;
               const baseHp = targetType === "projectile" ? (targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20))
                              : targetType === "drone" ? (targetEnt.hull || 0)
                              : targetType === "decoy" ? 1
                              : Infinity;
               if (baseHp - reserved <= 0.001) {
                  currentPdTarget = null;
                  return;
               }
               room._pdReservations.set(targetEnt.id, reserved + damage);

               if (currentPdTarget.type === "drone") {

                  require("./drones").damageDrone(room, targetEnt, damage, ship.ownerId, now);

               } else if (currentPdTarget.type === "projectile") {

                  const projHp = targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20);

                  targetEnt.hp = projHp - damage;

                  if (targetEnt.hp <= 0.001) {

                     removeProjectileRuntime(room, targetEnt, "intercepted", targetEnt.x, targetEnt.y);

                     room.effects.push({ type: "pdIntercept", x: targetEnt.x, y: targetEnt.y, at: now });

                  }

               } else if (currentPdTarget.type === "ship") {

                  const mult = Number(effectiveWeapon.shipDamageMultiplier ?? 0.04);

                  damageShip(room, targetEnt, damage * mult, ship.ownerId, now, muzzle.x, muzzle.y);

               }



               room.effects.push({ type: "laserPdPulse", x: muzzle.x, y: muzzle.y, x2: targetEnt.x, y2: targetEnt.y, at: now });

               room.effects.push({ type: "spark", x: targetEnt.x, y: targetEnt.y, at: now });



               ship.weaponCooldowns[i] = reload;

                addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

            }

         } else {

            const speed = effectiveWeapon.projectileSpeed || 1000;

            const life = (effectiveWeapon.range || 0) / speed;

            const targetEnt = currentPdTarget.entity;

            const targetType = currentPdTarget.type;
            const reserved = room._pdReservations.get(targetEnt.id) || 0;
            const baseHp = targetType === "projectile" ? (targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20))
                           : targetType === "drone" ? (targetEnt.hull || 0)
                           : targetType === "decoy" ? 1
                           : Infinity;
            if (baseHp - reserved <= 0.001) {
               currentPdTarget = null;
               return;
            }
            const pdDamage = effectiveWeapon.damage;
            room._pdReservations.set(targetEnt.id, reserved + pdDamage);

            const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

            const pdSpreadScale = weaponSpreadRadians(effectiveWeapon);

            const pdDx = targetEnt.x - muzzle.x;

            const pdDy = targetEnt.y - muzzle.y;

            const pdDist = fastHypot(pdDx, pdDy);

            const pdFlightTime = pdDist / Math.max(1, speed);

            const pdAimX = targetEnt.x + (targetEnt.vx || 0) * pdFlightTime;

            const pdAimY = targetEnt.y + (targetEnt.vy || 0) * pdFlightTime;

            const shotAngle = Math.atan2(pdAimY - muzzle.y, pdAimX - muzzle.x) + rngRange(roomCombatRandom(room), -pdSpreadScale, pdSpreadScale);



            TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

               type: "pdShot",

               subtype: module.type,

               ownerId: ship.ownerId,

               targetId: targetEnt.id,

               x: muzzle.x,

               y: muzzle.y,

               vx: Math.cos(shotAngle) * speed + ship.vx * 0.25,

               vy: Math.sin(shotAngle) * speed + ship.vy * 0.25,

               damage: pdDamage,

               shipDamageMultiplier: effectiveWeapon.shipDamageMultiplier ?? 0.05,

               shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

               hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

               pdTargetType: currentPdTarget.type,

               pdTargetId: targetEnt.id,

               life: life,

               bornAt: now

            });

            });

            ship.weaponCooldowns[i] = reload;

             addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

         }

      }

    } else if (family === "railgun") {

      // A spinal mount spends this tick charging instead of firing until the
      // accumulator is full. It only reaches here with a live, tracked, in-arc,
      // in-range firing solution, which is exactly the condition the charge is
      // meant to require.
      if (spinalConfig) {

        ship.weaponChargeIdle[i] = 0;

        const chargeSeconds = Math.max(0.05, finiteOr(spinalConfig.chargeSeconds, 10));

        ship.weaponCharge[i] = Math.min(chargeSeconds, (ship.weaponCharge[i] || 0) + dt);

        const progress = clampNumber(ship.weaponCharge[i] / chargeSeconds, 0, 1);

        if (!spinalActivityHeatApplied) {
          addComponentHeat(ship, i, HeatRules.activityHeat(module.type, part) * activityMultiplier * dt);
          spinalActivityHeatApplied = true;
        }

        if (progress < 1) {

          spinalTurnPenalty = Math.min(spinalTurnPenalty, spinalHullTurnScale(spinalConfig, progress));

          return;

        }

      }

      const speed = effectiveWeapon.projectileSpeed || 1080;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      const penetrationProfile = spinalConfig?.penetrationProfile;

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

        type: "rail",

        subtype: module.type,

        ownerId: ship.ownerId,

        targetId: weaponTarget.id,

        targetComponentIndex: fireAimPoint?.componentIndex ?? -1,

        x: muzzle.x,

        y: muzzle.y,

        vx: Math.cos(shotAngle) * speed + ship.vx * 0.12,

        vy: Math.sin(shotAngle) * speed + ship.vy * 0.12,

        damage: effectiveWeapon.damage,

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        ...impactPayload(effectiveWeapon),

        ...(penetrationProfile ? { penetrationProfile } : {}),

        life: life,

        bornAt: now

      });

    });

      ship.weaponCooldowns[i] = reload;

      if (spinalConfig) {

        clearSpinalCharge(ship, i);

        addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

        room.effects.push({ type: "railhit", subtype: "spinal", x: muzzle.x, y: muzzle.y, at: now });

      } else {

        addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

      }

    }

  });

  // Published for movementCapability: the hull's turn rate this tick is scaled
  // by the most committed spinal mount aboard. 1 means no mount is charging.
  ship.spinalTurnPenalty = spinalTurnPenalty;

}



// Projectiles per trigger pull. Anything below two is a single shot, so the
// ordinary firing path never has to know about multi-pellet weapons.
function pelletShotCount(weapon) {
  const count = Math.round(Number(weapon?.pelletCount) || 0);
  return Number.isFinite(count) && count >= 2 ? count : 1;
}

// Delivery properties a projectile carries beyond raw damage: Heat coupled into
// whatever it strikes (Plasma Cannon) and an impact burst around the hit point
// (Fragmentation Cannon). Returned as a spreadable payload so each firing branch
// stays a flat bullet literal.
function impactPayload(weapon) {
  const payload = {};
  const impactHeat = Number(weapon?.impactHeatPerDamage) || 0;
  if (impactHeat > 0) payload.impactHeatPerDamage = impactHeat;
  const blastRadius = Number(weapon?.blastRadius) || 0;
  const blastDamage = Number(weapon?.blastDamage) || 0;
  if (blastRadius > 0 && blastDamage > 0) {
    payload.blastDamage = blastDamage;
    payload.blastRadius = blastRadius;
    payload.innerFullDamageRadius = Number(weapon.innerFullDamageRadius) || 0;
    payload.falloffExponent = Number(weapon.falloffExponent) || 1;
    payload.maximumExplosionTargets = Number(weapon.maximumExplosionTargets) || 0;
  }
  return payload;
}

function weaponReloadSeconds(effectiveWeapon, activityMultiplier) {

  const fireRate = Math.max(

    0.0001,

    Number(effectiveWeapon.fireRate) || 0

  );



  return Math.max(

    0.05,

    (1 / fireRate)

      / Math.max(0.0001, activityMultiplier)

  );

}



const moduleRotationToRadians = require("../../public/src/shared/rotationRules").moduleRotationToRadians;



function moduleLocalPosition(module, scale = MODULE_SCALE) {

  // 7 = center of the 15x15 build grid (core position), keeping module world

  // coordinates centered on the ship origin.

  return {

    x: (7 - module.y) * scale,

    y: (module.x - 7) * scale

  };

}



function moduleFootprintLocalPosition(module, scale = MODULE_SCALE) {

  const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };

  const cells = getOccupiedCells(module.x, module.y, footprint, normalizeRotation(module.rotation));

  if (cells.length <= 1) return moduleLocalPosition(module, scale);

  let x = 0;

  let y = 0;

  for (const cell of cells) {

    const local = moduleLocalPosition(cell, scale);

    x += local.x;

    y += local.y;

  }

  return { x: x / cells.length, y: y / cells.length };

}



function weaponFacingAngle(ship, module, hullAngle = ship.angle) {

  return hullAngle + moduleRotationToRadians(normalizeRotation(module.rotation));

}



function weaponModuleWorldPosition(ship, module, hullAngle = ship.angle) {

  // Multi-cell turret artwork pivots around the footprint centre, not the

  // blueprint anchor tile. Keep server targeting/projectiles on that same pivot.

  const local = moduleFootprintLocalPosition(module);

  const cos = Math.cos(hullAngle);

  const sin = Math.sin(hullAngle);

  return {

    x: ship.x + local.x * cos - local.y * sin,

    y: ship.y + local.x * sin + local.y * cos

  };

}



function weaponMuzzleDistance(module, family, scale = MODULE_SCALE) {

  // Barrel-tip distances live in the shared TurretRules so projectiles spawn

  // exactly where the client draws the muzzle.

  const footprint = PARTS[module.type]?.footprint || { width: 1, height: 1 };

  const longTiles = Math.max(footprint.width || 1, footprint.height || 1);

  return TurretRules.muzzleTiles(module.type, family, longTiles) * scale;

}



function weaponMuzzleWorldPosition(ship, module, angle, family, barrelIndex = 0) {

  const origin = weaponModuleWorldPosition(ship, module);

  const distance = weaponMuzzleDistance(module, family);

  // Multi-barrel weapons (autocannon) stagger their shots across the tubes, so
  // the round leaves the barrel that fired it rather than the pivot between
  // them. Zero for every single-barrel weapon.

  const lateral = TurretRules.barrelLateralTiles(module.type, barrelIndex) * MODULE_SCALE;

  return {

    x: origin.x + Math.cos(angle) * distance - Math.sin(angle) * lateral,

    y: origin.y + Math.sin(angle) * distance + Math.cos(angle) * lateral

  };

}



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

    if (ship.design[idx1].type === "heatSink") require("./heat").recalculateEffectiveThermalCapacities(ship, idx1);

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

            if (ship.design[idx2].type === "heatSink") require("./heat").recalculateEffectiveThermalCapacities(ship, idx2);

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



// A beam ray damages only the nearest blocking entity. All candidate blockers —

// asteroids, active shield bubbles, living ship components, and living drones —

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

    require("./stationCombat").damageStation(room, station, damage, ship.ownerId, now, hitX, hitY, options);

    if (shieldHit) {

      room.effects.push({ type: "shieldhit", x: hitX, y: hitY, nx: Math.cos(ang), ny: Math.sin(ang), at: now });

    } else {

      room.effects.push({ type: "spark", x: hitX, y: hitY, at: now });

    }

    return { hitX, hitY, t: nearest.t, firstHitIndex: -1, hitTargetShipId: station.id, hitTargetEntityId: station.id };

  }



  if (nearest.kind === "drone") {

    require("./drones").damageDrone(room, nearest.drone, damage, ship.ownerId, now);

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



function applyDirectComponentDamage(room, ship, index, damage, attackerId, now) {

  if (isInSafeZone(room, ship.x, ship.y, ship) || damage <= 0) return 0;

  ship.lastDamagedBy = attackerId;

  if (!ship.componentHp || !isComponentAlive(ship, index)) return 0;



  const part = PARTS[ship.design[index].type] || PARTS.frame;

  let effectiveDamage = damage;

  if (part.armorFlatReduction > 0) {

    const protection = HeatRules.passiveProtectionForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL);

    const reduction = part.armorFlatReduction * protection;

    effectiveDamage = Math.max(0, effectiveDamage - Math.max(0, reduction));

  }

  if (effectiveDamage <= 0) return 0;



  if (ship.design[index].type === "core") {

    const dealt = Math.min(ship.componentHp[index], effectiveDamage);

    if (dealt > 0) {

      ship.componentHp[index] -= dealt;

      markComponentDamageChanged(ship, index);

      if (ship.componentHp[index] <= 0.0001) {

        ship.componentHp[index] = 0;

        onComponentDestroyed(room, ship, index, now);

      }

      pushDamageEffect(room, ship, now, dealt, false);

    }

    if (ship.hp <= 0.001) destroyShip(room, ship, attackerId, now);

    else evaluateShipCommandState(room, ship, now, attackerId);

    if (dealt > 0) markShipRepairCacheDirty(ship);

    return dealt;

  }



  const passiveStructure = HeatRules.isPassiveStructure(ship.design[index].type, part);

  const mult = passiveStructure ? HeatRules.structuralDamageMultiplierForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL) : 1;

  const incomingToHp = effectiveDamage * mult;

  const dealt = Math.min(ship.componentHp[index], incomingToHp);



  if (dealt > 0) {

    ship.componentHp[index] -= dealt;

    if (ship.design[index].type === "heatSink") require("./heat").recalculateEffectiveThermalCapacities(ship, index);

    ship.hp -= dealt;

    markComponentDamageChanged(ship, index);

    if (ship.componentHp[index] <= 0.0001) {

      ship.componentHp[index] = 0;

      onComponentDestroyed(room, ship, index, now);

    }

    pushDamageEffect(room, ship, now, dealt, false);

  }



  if (ship.hp <= 0.001) {

    destroyShip(room, ship, attackerId, now);

  } else {

    evaluateShipCommandState(room, ship, now, attackerId);

  }



  if (dealt > 0) markShipRepairCacheDirty(ship);

  return dealt;

}



function isDamageFromFront(ship, sourceX, sourceY, frontArcDegrees) {

  const angleToSource = Math.atan2(sourceY - ship.y, sourceX - ship.x);

  const diff = Math.abs(angleDifference(ship.angle, angleToSource));

  return diff <= (frontArcDegrees * Math.PI / 180) / 2;

}



function isTargetInWeaponArc(ship, module, target, arcRadians, hullAngle = ship.angle) {

  if (arcRadians >= Math.PI * 2) return true;

  const origin = weaponModuleWorldPosition(ship, module, hullAngle);

  const weaponFacing = weaponFacingAngle(ship, module, hullAngle);

  const point = targetAttackPoint(origin.x, origin.y, target);
  const angleToTarget = Math.atan2(point.y - origin.y, point.x - origin.x);

  return Math.abs(angleDifference(weaponFacing, angleToTarget)) <= arcRadians / 2;

}

function holdFacingAngle(angle) {
  let normalized = Number(angle) || 0;
  normalized %= Math.PI * 2;
  if (normalized <= -Math.PI) normalized += Math.PI * 2;
  if (normalized > Math.PI) normalized -= Math.PI * 2;
  return normalized;
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
    // These weapons are defensive/interception systems in the firing path and
    // should not pull an offensive Hold hull toward a defensive bearing.
    if (family === "pointDefense" || family === "flak") continue;

    const range = Number(effectiveWeapon.range) || 0;
    const dps = Number.isFinite(Number(effectiveWeapon.combatDps))
      ? Math.max(0, Number(effectiveWeapon.combatDps))
      : (Number(effectiveWeapon.dps)
        || ((Number(effectiveWeapon.damage) || 0) * (Number(effectiveWeapon.fireRate) || 0)));
    const induction = isInductionBeam(effectiveWeapon) ? (Number(effectiveWeapon.inductionHeatMaxPerSecond) || 0) : 0;
    const tacticalOutput = isInductionBeam(effectiveWeapon) ? induction : dps;
    if (!(range > 0) || !(tacticalOutput > 0)) continue;

    // Where the mount sits relative to the hull centre. Rotating the hull swings
    // it, so this is what decides whether a given heading puts the gun on the
    // near or the far side of the ship -- a difference of twice this distance in
    // how far the gun has to shoot.
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

// `groupRange` opts in to measuring the guns that this heading brings to bear
// but that are still short of the target. Left at Infinity nothing qualifies and
// an out-of-range weapon is dropped as cheaply as it always was; movement passes
// a real threshold when it needs to know how much further the hull has to come.
function evaluateHoldFacing(room, ship, target, weapons, heading, now, groupRange = Infinity, reachMargin = 0) {
  let score = 0;
  let weaponCount = 0;
  // The furthest any bearing gun of the main battery is from reaching, and how
  // many of them are in that state. This is a distance the hull can close, so it
  // is reported separately from the coverage the heading already has.
  let shortfall = 0;
  let shortfallCount = 0;

  for (const weapon of weapons) {
    const origin = weaponModuleWorldPosition(ship, weapon.module, heading);
    const point = targetAttackPoint(origin.x, origin.y, target);
    const distance = fastHypot(point.x - origin.x, point.y - origin.y);
    const excess = distance - weapon.range;
    const inGroup = weapon.range >= groupRange;
    if (excess > 0 && !inGroup) continue;

    // This is the same ordinary-weapon eligibility predicate used by firing,
    // parameterized with the candidate hull heading. It owns relationship,
    // visibility, range and fixed-arc details; movement only supplies LOS.
    // Passing `distance` as the range for a gun that is merely short asks the
    // predicate every question except the one movement is trying to answer.
    if (!Targeting.isOrdinaryWeaponTargetValid(room, ship, target, now, excess > 0 ? distance : weapon.range, {
      originX: origin.x,
      originY: origin.y,
      arcRadians: weapon.arcRadians,
      weaponAngle: heading + weapon.mountAngle
    })) continue;
    if (isLineBlocked(room, origin.x, origin.y, point.x, point.y, 8)) continue;

    // A gun sitting exactly on its own range boundary is one nudge from being
    // out of it again, so movement is told to close a little past the boundary
    // rather than onto it. Coverage below is still scored against the real
    // range: this margin decides where to stop, not what can shoot.
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

// Guns of the main offensive battery are the ones the Hold standoff is chosen
// for. A secondary with a much shorter reach is deliberately not allowed to vote
// on where the hull stops -- one point-blank gun should not drag a long-range
// ship into a knife fight to satisfy itself.
const HOLD_COVERAGE_RANGE_GROUP_RATIO = 0.9;

// How far inside its own envelope a gun is asked to end up. Small and absolute:
// enough that ordinary jostling does not push the outermost mount back out of
// range, not so much that it changes how close Hold fights.
const HOLD_COVERAGE_REACH_MARGIN = 12;

// Can the guns actually shoot from where they are standing?
//
// Movement's range gate measures the hull CENTRE against the longest weapon
// envelope, but every gun fires from its own mount, and on a long hull the
// far-side mounts sit most of a hundred pixels behind the centre. A ship that
// stops the instant its centre is in range therefore parks half its battery
// outside its own range, and the hold logic -- which only ever asked about the
// centre -- has nothing left to tell it to close the rest of the way.
//
// `heading` is the orientation the ship intends to hold, because rotating the
// hull moves the mounts: coverage is a property of the heading, not just of the
// position. Returns the coverage that heading already has plus the distance the
// hull still has to close for the whole main battery to reach.
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

// The main offensive battery: which guns a travelling stance is allowed to
// choose its range and its heading for, and the radius at which all of them
// reach.
//
// A travelling stance cannot use the Hold coverage measurement: that one is a
// property of a chosen hull heading, and an orbiting or kiting hull's heading
// changes continuously. What it needs is the radius that works at ANY heading,
// so each gun is charged the full distance its mount can be swung away from the
// target -- the mount offset -- and the group is limited by its worst member.
//
// "Main battery" is the same group Hold stops for, and for the same reason: one
// short-ranged secondary must not drag a long-ranged hull into a knife fight to
// satisfy itself. Point Defence, Flak and repair beams are already excluded by
// holdFacingWeapons, along with anything destroyed, unpowered, overheated or
// with no meaningful tactical output -- including the zero-damage induction
// weapons, which are scored on the heat they can put into a hull instead. That
// measure is for movement and facing only; nothing shows it as DPS.
//
// `standoffRange` is 0 for a ship with no offensive weapon reaching anywhere,
// which is the caller's cue to fall back on the hull's own envelope.
//
// Unlike the Hold coverage measurement, which movement asks for on a cadence,
// this one is wanted by every travelling ship on every tick. Rebuilding the
// weapon list that often is exactly the sort of per-tick allocation that has
// shown up in server profiles before, and the answer only moves when the
// weapons themselves do -- so it is keyed on the revisions that mark that.
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
    // Selected by range alone and in the order the design already gives them,
    // so the same hull produces the same battery however its modules happen to
    // be ordered.
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

// The radius an orbiting ship can hold its target at and still have the whole
// main battery bear on it. Orbit's own name for the shared measurement above.
function mainBatteryOrbitRange(ship) {
  return mainBatteryProfile(ship).standoffRange;
}

// What the main battery could actually do to this target from where the hull is
// standing, if it were pointing `heading`.
//
// This is the same eligibility the firing path uses -- relationship, visibility,
// range, fixed arcs, physical mount position -- parameterized with a candidate
// hull heading, and it is what lets Kite choose a heading that runs away and
// keeps shooting rather than one or the other. Secondaries are deliberately not
// counted: they still fire, they just do not get a vote on where the hull looks.
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

// Choose a hull orientation only. This helper deliberately has no movement
// side effects and does not alter the weapon firing state.
//
// Candidates are the current/previous heading, the heading that looks straight
// at the target, the centres and edges of each fixed weapon arc, and the heading
// that swings each mount round onto the target side. The last two families are
// both needed: coverage changes when a gun's ARC crosses the target, and again
// when its MOUNT crosses the range boundary. An earlier version tested arcs
// only, which left a hull carrying wide-arc turrets with no candidate but the
// heading it already had.
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
      // A full-circle turret has no arc to generate candidates from, so the
      // loop below used to produce nothing for it at all -- a hull carrying
      // only turrets was left with the heading it already had. Its coverage
      // still changes with heading, because rotating the hull swings the mount
      // between the near and the far side of the target. Swing it to the near
      // side: the closest this hull can put that gun to what it is shooting at.
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



function damageShip(room, ship, damage, attackerId, now, sourceX, sourceY, options = {}) {

  if (isInSafeZone(room, ship.x, ship.y, ship)) return; // Invincible in own/team spawn
  if (!Number.isFinite(damage)) return; // Invalid damage values cannot produce meaningful resolution



  if (ship.stats.frontDamageReduction && sourceX !== undefined && sourceY !== undefined) {

    if (isDamageFromFront(ship, sourceX, sourceY, ship.stats.frontArc)) {

      damage *= (1 - ship.stats.frontDamageReduction);

      if (!ship.lastBlockedTextAt || now - ship.lastBlockedTextAt > 350) {

        ship.lastBlockedTextAt = now;

        room.effects.push({ type: "text", text: "BLOCKED", x: ship.x, y: ship.y, at: now });

      }

    }

  }

  ship.lastDamagedBy = attackerId;



  const SHIELD_ABSORPTION = 0.95;



  const shieldMultiplier = Number.isFinite(Number(options.shieldDamageMultiplier ?? 1)) ? Number(options.shieldDamageMultiplier ?? 1) : 1;

  const hullMultiplier = Number.isFinite(Number(options.hullDamageMultiplier ?? 1)) ? Number(options.hullDamageMultiplier ?? 1) : 1;



  let hullDamage = damage * hullMultiplier;



  if (ship.shield > 0) {

    const shieldDamage = damage * shieldMultiplier;

    const safeShield = Number.isFinite(ship.shield) ? Math.max(0, ship.shield) : 0;
    const safeShieldDamage = Number.isFinite(shieldDamage) ? Math.max(0, shieldDamage) : safeShield;
    const blockedShieldDamage = Math.min(safeShield, safeShieldDamage);

    ship.shield = Math.max(0, safeShield - blockedShieldDamage);



    const absorbedRatio = shieldDamage > 0

      ? blockedShieldDamage / shieldDamage

      : 0;



    const absorbedHullDamage = hullDamage * absorbedRatio;

    const overflowHullDamage = hullDamage - absorbedHullDamage;

    const bleedThroughDamage = absorbedHullDamage * (1 - SHIELD_ABSORPTION);



    hullDamage = bleedThroughDamage + overflowHullDamage;



    if (blockedShieldDamage > 0) {

      distributeComponentHeatByWeight(

        ship,

        effectiveShieldCapacityContributions(ship),

        blockedShieldDamage * SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE

      );

      pushDamageEffect(room, ship, now, blockedShieldDamage, true);

    }

  }



  if (hullDamage > 0) {

    let applied = 0;

    if (options.intersections) {

      applied = applyBeamHullDamage(room, ship, hullDamage, now, options.intersections, options);

    } else {

      const impactX = sourceX !== undefined ? sourceX : ship.x;

      const impactY = sourceY !== undefined ? sourceY : ship.y;

      applied = applyHullDamage(room, ship, hullDamage, now, impactX, impactY, {

        beamDeltaSeconds: options.beamDeltaSeconds,

        impactHeatPerDamage: options.impactHeatPerDamage,

        penetrationProfile: options.penetrationProfile

      });

    }

    if (applied > 0) {

      pushDamageEffect(room, ship, now, applied, false);

      markShipRepairCacheDirty(ship);

    }

  }



  if (ship.hp <= 0.001) {

    destroyShip(room, ship, attackerId, now);

  } else {

    evaluateShipCommandState(room, ship, now, attackerId);

  }

}



function evaluateShipCommandState(room, ship, now, attackerId = null) {

  if (!ship || ship.alive === false || ship.destroyFinalizedAt) return false;

  const componentIndexes = getShipComponentIndexes(ship);

  const mainCoreIdx = componentIndexes.mainCoreIndex;

  const mainCoreAlive = mainCoreIdx >= 0 && (ship.componentHp?.[mainCoreIdx] ?? 0) > 0;



  if (mainCoreAlive) {

    ship.coreDestroyed = false;

    ship.commandState = "mainCore";

    ship.emergencyReserveUntil = null;

    return true;

  }

  if (mainCoreIdx < 0) {
    ship.coreDestroyed = false;
    return false;
  }



  // Main Core is destroyed

  ship.coreDestroyed = true;

  const backupCoreIdx = componentIndexes.backupCoreIndex;

  const backupCoreAlive = backupCoreIdx >= 0 && (ship.componentHp?.[backupCoreIdx] ?? 0) > 0;



  if (!backupCoreAlive) {

    ship.commandState = "noCommand";

    destroyShip(room, ship, attackerId || ship.lastDamagedBy, now);

    return false;

  }



  const { getComponentPowerMultiplier, reallocateShipPower } = require("./componentPower");

  reallocateShipPower(ship, "commandState");

  const powerMult = getComponentPowerMultiplier(ship, backupCoreIdx);

  const isBackupPowered = powerMult > 0;



  if (isBackupPowered) {

    const wasBackup = ship.commandState === "backupCore";

    ship.commandState = "backupCore";

    ship.emergencyReserveUntil = null;

    if (!wasBackup && room && room.effects) {

      room.effects.push({

        type: "text",

        text: "BACKUP COMMAND ACTIVE",

        x: ship.x,

        y: ship.y,

        at: now

      });

      room.effects.push({

        type: "burst",

        x: ship.x,

        y: ship.y,

        at: now

      });

    }

    return true;

  }



  // Backup Core is alive but unpowered (Power interruption)

  ship.commandState = "backupCore";

  if (!ship.emergencyReserveUntil) {

    ship.emergencyReserveUntil = now + 2000;

  }



  if (now >= ship.emergencyReserveUntil) {

    destroyShip(room, ship, attackerId || ship.lastDamagedBy, now);

    return false;

  }



  return true;

}



function destroyShip(room, ship, attackerId, now) {

  if (!ship || ship.destroyFinalizedAt || ship.removed) return false;

  ship.destroyFinalizedAt = now;

  ship.removeAt = now + 3200;

  proximityChargeDestroyedShip(room, ship, now);

  ship.alive = false;

  require("./commandAuras").invalidateCommandAuraSource(room, ship, "destroyed");

  ship.hp = 0;

  room.spatialIndex?.remove?.("ships", ship);
  require("./movementContactPairs").removeShipFromMovementContactPairs(room, ship);

  zeroAllComponents(ship);

  ship.shield = 0;

  ship.weaponComponentTargetIds = null;

  ship.weaponComponentTargetIndices = null;

  ship.weaponComponentRetargetAt = null;

  ship._weaponTargetState = null;
  ship._targetAcquisitionSchedule = null;
  ship._targetAcquisitionOffsets = null;
  ship._effectiveWeaponProfileCacheRevision = null;
  ship._pdThreatSet = null;
  ship.effectiveWeaponProfileCache = null;

  ship.vx *= 0.25;

  ship.vy *= 0.25;

  room.effects.push({ type: "boom", x: ship.x, y: ship.y, at: now });



  const victim = room.players.get(ship.ownerId);

  if (victim) {

    victim.losses += 1;

    victim.lostFleetCost += ship.cost || ship.stats?.unitCost || 0;

  }



  const attacker = room.players.get(attackerId);

  if (attacker && attacker.id !== ship.ownerId) {

    const bounty = Math.max(ECONOMY.killBountyMin, Math.round((ship.cost || ship.stats?.unitCost || 100) * ECONOMY.killBountyRatio));

    attacker.kills += 1;

    attacker.destroyedEnemyCost += ship.cost || ship.stats?.unitCost || 0;

    attacker.money = Math.min(attacker.maxMoney || ECONOMY.maxMoney, attacker.money + bounty);

    attacker.earned += bounty;

  }

  return true;

}



// Fast-repeating damage (beams tick 30x/s) accumulates into the most recent

// floating number instead of spawning a new effect per tick, which keeps the

// effects array (and its share of every snapshot) small.

const DMG_EFFECT_MERGE_MS = 160;



function pushDamageEffect(room, ship, now, amount, isShield) {

  const key = isShield ? "lastShieldDmgEffect" : "lastHullDmgEffect";

  const previous = ship[key];

  if (previous && now - previous.at < DMG_EFFECT_MERGE_MS) {

    previous.amount = Math.round((previous.amount + amount) * 10) / 10;

    previous.x = ship.x;

    previous.y = ship.y;

    return;

  }

  const effect = {

    type: "dmg",

    x: ship.x,

    y: ship.y,

    at: now,

    amount: Math.round(amount * 10) / 10,

    isShield

  };

  ship[key] = effect;

  room.effects.push(effect);

}



// Self-destruct: the player scuttles their own ships. Each flagged ship charges

// for SELF_DESTRUCT_MS (emitting charge sparks so the client can animate the

// warning) and then detonates and is removed.

const SELF_DESTRUCT_MS = 1400;



function requestSelfDestruct(room, player, shipIds, now) {
  now = gameplayNow(room, now || performanceNow());

  const { selectOwnedLivingShips } = require("./selection");

  const selected = selectOwnedLivingShips(player, shipIds, { allowOmittedAll: false });

  if (!selected.ok) return 0;

  let count = 0;

  for (const ship of selected.ships) {

    if (ship.selfDestructAt) continue;

    ship.selfDestructStart = now;

    ship.selfDestructAt = now + SELF_DESTRUCT_MS;

    ship.nextDestructSparkAt = 0;

    count += 1;

  }

  return count;

}



function updateSelfDestructingShips(room, now) {

  for (const ship of room.ships.values()) {

    if (!ship.selfDestructAt || !ship.alive) continue;

    if (now >= ship.nextDestructSparkAt) {

      ship.nextDestructSparkAt = now + 120;

      room.effects.push({ type: "destructcharge", x: ship.x, y: ship.y, at: now, radius: ship.radius });

    }

    if (now >= ship.selfDestructAt) detonateSelfDestruct(room, ship, now);

  }

}



function detonateSelfDestruct(room, ship, now) {

  if (!ship || ship.destroyFinalizedAt || ship.removed) return false;

  ship.destroyFinalizedAt = now;

  ship.selfDestructAt = 0;

  ship.alive = false;

  require("./commandAuras").invalidateCommandAuraSource(room, ship, "self-destruct");

  ship.hp = 0;

  room.spatialIndex?.remove?.("ships", ship);
  require("./movementContactPairs").removeShipFromMovementContactPairs(room, ship);

  zeroAllComponents(ship);

  ship.shield = 0;

  ship.weaponComponentTargetIds = null;

  ship.weaponComponentTargetIndices = null;

  ship.weaponComponentRetargetAt = null;

  ship.vx *= 0.2;

  ship.vy *= 0.2;

  ship.removeAt = now + 700;

  room.effects.push({ type: "boom", x: ship.x, y: ship.y, at: now });

  room.effects.push({ type: "selfdestruct", x: ship.x, y: ship.y, at: now, radius: ship.radius });



  const victim = room.players.get(ship.ownerId);

  if (victim) {

    victim.losses += 1;

    victim.lostFleetCost += ship.cost || ship.stats?.unitCost || 0;

  }

  return true;

}



function updateDestroyedShips(room, now) {

  for (const player of room.players.values()) {

    let removedAny = false;

    for (const ship of player.ships) {

      if (ship.alive && !ship.removed && !ship.launchPhase) {

        evaluateShipCommandState(room, ship, now);

      }

      if (!ship.alive && !ship.removed && ship.removeAt && now >= ship.removeAt) {

        ship.removed = true;

        ship.weaponComponentTargetIds = null;

        ship.weaponComponentTargetIndices = null;

        ship.weaponComponentRetargetAt = null;

        invalidateShipCollisionGeometry(ship);

        room.spatialIndex?.remove?.("ships", ship);
        require("./movementContactPairs").removeShipFromMovementContactPairs(room, ship);

        room.ships.delete(ship.id);

        removedAny = true;

      }

    }

    if (removedAny) {

      player.ships = player.ships.filter((ship) => !ship.removed);

      Relationships.revalidateTelemetryFocusForRoom(room);

    }

  }

}



// How far a ship will reach out to pick a target of its own accord: its longest
// operational weapon, plus a small margin so it starts tracking something a
// moment before it can shoot it rather than exactly as it comes into range.
// A ship must never acquire across the map -- what it cannot shoot, it does not
// chase.
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

  const droneTypes = require("./drones").CONFIG.types;

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

  const droneConfig = require("./drones").CONFIG.types[drone.type] || {};

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



// Called from inside the per-weapon and per-candidate targeting loops, so this

// is one of the hottest functions on the tick. `room.points` holds capture

// relays only (built from `map.relays`), never asteroids, so the old second

// loop could not match and has been removed.

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



function areAllies(room, ownerA, ownerB) {

  return Relationships.areAllies(room, ownerA, ownerB);

}



function areEnemies(room, ownerA, ownerB) {

  return Relationships.areEnemies(room, ownerA, ownerB);

}



function getWeaponTurnRate(weapon) {

  // Shared with the client renderer via TurretRules so the visible turret sweep

  // matches the server's aim exactly.

  return TurretRules.turnRateFor(weapon);

}



// Development/test diagnostics for turret aiming: one entry per weapon module

// with the full aim/fire decision state for the ship's latest tick. Used by

// the dev-only /debug/turrets endpoint and the turret verification tests.

// Never included in normal production snapshots.

function buildShipTurretDiagnostics(room, ship) {

  const entries = [];

  const safeZoneFiringBlocked = isInSafeZone(room, ship.x, ship.y, ship);

  (ship.design || []).forEach((module, i) => {

    const part = PARTS[module.type];

    if (!part?.weapon) return;

    const defaultRelativeAngle = moduleRotationToRadians(normalizeRotation(module.rotation));

    const rawCurrent = ship.weaponAngles?.[i];

    const currentRelativeAngle = Number.isFinite(rawCurrent) ? rawCurrent : null;

    const rawDesired = ship.weaponDesiredAngles?.[i];

    const desiredRelativeAngle = Number.isFinite(rawDesired) ? rawDesired : null;

    const aimTargetId = ship.weaponAimTargetIds?.[i] ?? null;

    const fireTargetId = ship.weaponFireTargetIds?.[i] ?? null;

    const effectiveWeapon = getEffectiveWeaponStatsInternal(ship, i) || part.weapon;

    const range = effectiveWeapon.range || 0;

    const arcRadians = (effectiveWeapon.arc || 360) * Math.PI / 180;

    const origin = weaponModuleWorldPosition(ship, module);



    // Distance/range/arc are evaluated against the aim target when it is a

    // ship the room still knows about (PD bullet targets have no ship entry).

    const targetEntity = aimTargetId
      ? room.ships?.get?.(aimTargetId)
        || room.stationsById?.get?.(aimTargetId)
        || room.stations?.find?.((station) => station?.id === aimTargetId)
        || null
      : null;

    let targetDistance = null;

    let inFiringRange = null;

    let inFixedArc = null;

    if (targetEntity) {

      const targetPoint = targetAttackPoint(origin.x, origin.y, targetEntity);
      targetDistance = fastHypot(targetPoint.x - origin.x, targetPoint.y - origin.y);

      inFiringRange = targetDistance <= range;

      inFixedArc = isTargetInWeaponArc(ship, module, targetEntity, arcRadians);

    }



    entries.push({

      shipId: ship.id,

      designIndex: i,

      componentType: module.type,

      defaultRelativeAngle,

      currentRelativeAngle,

      desiredRelativeAngle,

      hullWorldAngle: ship.angle,

      weaponWorldAngle: currentRelativeAngle === null ? null : ship.angle + currentRelativeAngle,

      aimTargetId,

      fireTargetId,

      targetDistance,

      inFiringRange,

      inFixedArc,

      safeZoneFiringBlocked,

      componentAlive: isComponentAlive(ship, i),

      thermalPerformance: componentPerformance(ship, i)

    });

  });

  return entries;

}



// ---------------------------------------------------------------------------

// Proximity demolition charges

// ---------------------------------------------------------------------------



const DEMOLITION_TRIGGER_RANGE = 50;

const DEMOLITION_DIAGNOSTICS = Boolean(process.env.MFA_DEMOLITION_DIAGNOSTICS);



function getProximityChargeConfig(ship, index) {

  const part = PARTS[ship.design?.[index]?.type];

  return part?.proximityCharge || null;

}



function armedProximityChargeRanges(ship) {

  let armed = false;

  let count = 0;

  const indexes = getShipComponentIndexes(ship).proximityChargeIndices;

  for (const i of indexes) {

    if (!isComponentAlive(ship, i)) continue;

    if (ship.proximityChargeDetonated?.[i]) continue;

    if (!getProximityChargeConfig(ship, i)) continue;

    armed = true;

    count += 1;

  }

  return { armed, count, minTrigger: 0 };

}



function shipHasOperationalDemolitionCharge(ship) {

  return armedProximityChargeRanges(ship).armed;

}



function proximityChargeWorldPosition(ship, index) {

  return componentAimWorldPosition(ship, index);

}



function getShipCellPoints(ship) {

  const geometry = getShipCollisionGeometry(ship);

  const cells = [];

  for (const i of geometry.liveComponentIndices) {

    const compCells = geometry.worldCells[i];

    if (!compCells) continue;

    const prevAngle = Number(ship._prevAngle || ship.angle || 0);

    const cos0 = Math.cos(prevAngle);

    const sin0 = Math.sin(prevAngle);

    const prevX = Number(ship._prevX || ship.x || 0);

    const prevY = Number(ship._prevY || ship.y || 0);

    const local = geometry.localCells[i];

    for (let c = 0; c < compCells.length; c += 1) {

      const world = compCells[c];

      const lc = local[c];

      cells.push({

        x: world.x, y: world.y,

        prevX: prevX + lc.x * cos0 - lc.y * sin0,

        prevY: prevY + lc.x * sin0 + lc.y * cos0

      });

    }

  }

  return cells;

}



function aabbOverlap(aMinX, aMinY, aMaxX, aMaxY, bMinX, bMinY, bMaxX, bMaxY) {

  return aMinX <= bMaxX && aMaxX >= bMinX && aMinY <= bMaxY && aMaxY >= bMinY;

}

function stationDemolitionContact(ship, station) {
  if (!station?.collisionPieces?.length) return null;
  const cells = getShipCellPoints(ship);
  if (!cells.length) return null;
  const threshold = COMPONENT_CELL_COLLISION_RADIUS + DEMOLITION_TRIGGER_RANGE;
  let best = null;
  for (const cell of cells) {
    const hit = segmentStationHullHit(
      station,
      cell.prevX,
      cell.prevY,
      cell.x,
      cell.y,
      threshold
    );
    if (hit && (!best || hit.t < best.t)) best = { ...hit, geometry: "station" };
  }
  return best;
}



function segmentPairContact(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y, threshold) {

  const r0x = a0x - b0x;

  const r0y = a0y - b0y;

  const ddx = (a1x - a0x) - (b1x - b0x);

  const ddy = (a1y - a0y) - (b1y - b0y);

  const len2 = ddx * ddx + ddy * ddy;

  if (len2 < 1e-12) {

    if (r0x * r0x + r0y * r0y < threshold * threshold) return 1;

    return -1;

  }

  let raw = -(r0x * ddx + r0y * ddy) / len2;

  if (raw < 0) raw = 0;

  else if (raw > 1) raw = 1;

  const rx = r0x + ddx * raw;

  const ry = r0y + ddy * raw;

  if (rx * rx + ry * ry < threshold * threshold) return raw;

  return -1;

}



function shipsDemolitionContact(a, b) {

  const aCells = getShipCellPoints(a);

  const bCells = getShipCellPoints(b);

  if (!aCells.length || !bCells.length) return null;

  let aMinX = Infinity, aMinY = Infinity, aMaxX = -Infinity, aMaxY = -Infinity;

  for (const c of aCells) {

    if (c.x < aMinX) aMinX = c.x;

    if (c.y < aMinY) aMinY = c.y;

    if (c.x > aMaxX) aMaxX = c.x;

    if (c.y > aMaxY) aMaxY = c.y;

  }

  let bMinX = Infinity, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;

  for (const c of bCells) {

    if (c.x < bMinX) bMinX = c.x;

    if (c.y < bMinY) bMinY = c.y;

    if (c.x > bMaxX) bMaxX = c.x;

    if (c.y > bMaxY) bMaxY = c.y;

  }

  const threshold = COMPONENT_CELL_COLLISION_RADIUS * 2 + DEMOLITION_TRIGGER_RANGE;

  if (!aabbOverlap(aMinX - threshold, aMinY - threshold, aMaxX + threshold, aMaxY + threshold,

                   bMinX - threshold, bMinY - threshold, bMaxX + threshold, bMaxY + threshold)) {

    return null;

  }

  let bestT = Infinity;

  let bestAx = a.x;

  let bestAy = a.y;

  let bestBx = b.x;

  let bestBy = b.y;

  for (const ca of aCells) {

    for (const cb of bCells) {

      const t = segmentPairContact(ca.prevX, ca.prevY, ca.x, ca.y, cb.prevX, cb.prevY, cb.x, cb.y, threshold);

      if (t >= 0 && t < bestT) {

        bestT = t;

        const ta = 1 - t;

        bestAx = ca.prevX * ta + ca.x * t;

        bestAy = ca.prevY * ta + ca.y * t;

        bestBx = cb.prevX * ta + cb.x * t;

        bestBy = cb.prevY * ta + cb.y * t;

      }

    }

  }

  if (bestT === Infinity) return null;

  return {

    t: bestT,

    x: (bestAx + bestBx) * 0.5,

    y: (bestAy + bestBy) * 0.5,

    geometry: "cell"

  };

}



function canDetonateDemolitionCharge(ship) {

  if (!ship || !ship.alive || ship.destroyFinalizedAt) return false;

  const indexes = getShipComponentIndexes(ship).proximityChargeIndices;

  for (const i of indexes) {

    if (!isComponentAlive(ship, i)) continue;

    if (ship.proximityChargeDetonated?.[i]) continue;

    if (getProximityChargeConfig(ship, i)) return true;

  }

  return false;

}



function getFirstOperationalProximityChargeIndex(ship) {

  const indexes = getShipComponentIndexes(ship).proximityChargeIndices;

  for (const i of indexes) {

    if (!isComponentAlive(ship, i)) continue;

    if (ship.proximityChargeDetonated?.[i]) continue;

    if (getProximityChargeConfig(ship, i)) return i;

  }

  return -1;

}



function nearestDemolitionTargetPoint(ship, target) {

  if (!target || !target.alive) return { x: target?.x ?? ship.x, y: target?.y ?? ship.y };

  if (target.entityType === "station") {
    return nearestStationHullPoint(ship.x, ship.y, target);
  }

  const geometry = getShipCollisionGeometry(target);

  let best = null;

  let bestDist = Infinity;

  for (const i of geometry.liveComponentIndices) {

    const cells = geometry.worldCells[i];

    if (!cells) continue;

    for (const c of cells) {

      const dx = c.x - ship.x;

      const dy = c.y - ship.y;

      const distSq = dx * dx + dy * dy;

      if (distSq < bestDist) {

        bestDist = distSq;

        best = c;

      }

    }

  }

  if (best) return { x: best.x, y: best.y };

  return { x: target.x, y: target.y };

}


function shipCoarseRadius(ship) {
  const geom = getShipCollisionGeometry(ship);
  let maxR = 0;
  for (const i of geom.liveComponentIndices) {
    const cells = geom.worldCells[i];
    if (!cells) continue;
    for (const c of cells) {
      const dx = Math.abs(c.x - ship.x);
      const dy = Math.abs(c.y - ship.y);
      const r = Math.max(dx, dy);
      if (r > maxR) maxR = r;
    }
  }
  return maxR;
}


function resolveDemolitionContacts(room, ships, now) {
  if (!room || !Array.isArray(ships)) return;
  const spatial = room.disableSpatialIndex ? null : (room.spatialIndex?.dynamicValid ? room.spatialIndex : null);
  const scratch = room._demolitionScratch || (room._demolitionScratch = []);
  let maxShipRadius = 0;
  for (const ship of ships) {
    if (!ship.alive) continue;
    const r = shipCoarseRadius(ship);
    if (r > maxShipRadius) maxShipRadius = r;
  }
  const processedPairs = new Set();
  for (const a of ships) {
    if (!a.alive || a.launchPhase || !canDetonateDemolitionCharge(a)) continue;
    const aRadius = shipCoarseRadius(a);
    const aMovement = fastHypot((a.x - (a._prevX || a.x)), (a.y - (a._prevY || a.y)));
    const searchR = aRadius + maxShipRadius + aMovement + COMPONENT_CELL_COLLISION_RADIUS * 2 + DEMOLITION_TRIGGER_RANGE;
    let candidates;
    if (spatial) {
      spatial.queryRangeUnordered("ships", a.x, a.y, searchR, scratch);
      candidates = scratch;
    } else {
      candidates = ships;
    }
    for (const b of candidates) {
      if (a === b || !b || !b.alive || b.launchPhase) continue;
      if (!areEnemies(room, a.ownerId, b.ownerId)) continue;
      const ids = [String(a.id), String(b.id)].sort();
      const pairKey = `${ids[0]}|${ids[1]}`;
      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);
      const contact = shipsDemolitionContact(a, b);
      if (!contact) continue;
      if (canDetonateDemolitionCharge(a)) {
        detonateProximityCharge(room, a, getFirstOperationalProximityChargeIndex(a), now, true, b, contact);
      }
      if (b.alive && canDetonateDemolitionCharge(b)) {
        detonateProximityCharge(room, b, getFirstOperationalProximityChargeIndex(b), now, true, a, contact);
      }
    }
    if (!a.alive) continue;
    for (const station of room.stations || []) {
      if (!station || station.alive === false || station.state === "destroyed") continue;
      if (!Relationships.areEntityEnemies(room, a.ownerId, station)) continue;
      const dx = station.x - a.x;
      const dy = station.y - a.y;
      const broadRadius = aRadius + (Number(station.radius) || 0) + aMovement + DEMOLITION_TRIGGER_RANGE;
      if (dx * dx + dy * dy > broadRadius * broadRadius) continue;
      const contact = stationDemolitionContact(a, station);
      if (!contact) continue;
      detonateProximityCharge(room, a, getFirstOperationalProximityChargeIndex(a), now, true, station, contact);
      break;
    }
  }
}



function updateProximityCharges(room, ships, dt, now) {

  resolveDemolitionContacts(room, ships, now);

}



function blastDamageFor(edge, blastR, centre, exp) {

  if (edge >= blastR) return 0;

  const ratio = Math.max(0, 1 - edge / blastR);

  return centre * Math.pow(ratio, exp);

}

function applyBlastDamageToStation(room, station, origin, cfg, damageMultiplier, contactTarget, attackerId, now) {
  if (!station || station.alive === false || station.state === "destroyed") return 0;
  const isContact = contactTarget && station.id === contactTarget.id;
  const nearest = nearestStationHullPoint(origin.x, origin.y, station);
  const distance = fastHypot(nearest.x - origin.x, nearest.y - origin.y);
  const blastR = cfg.blastRadius;
  if (!isContact && distance >= blastR) return 0;
  const centreDamage = cfg.centreDamage ?? cfg.splashCentreDamage ?? 0;
  const directContactMultiplier = cfg.directContactMultiplier ?? 1.5;
  const directContactHullDamage = cfg.directContactHullDamage ?? (centreDamage * directContactMultiplier);
  const falloff = isContact
    ? 1
    : Math.pow(Math.max(0, 1 - distance / blastR), Math.max(0, cfg.falloffExponent));
  const hullDamage = (isContact ? directContactHullDamage : centreDamage) * falloff * damageMultiplier;
  if (hullDamage <= 0) return 0;
  // Demolition charges bypass ship shields, so station shields follow the same
  // rule. Station combat still owns component HP and victory state.
  return require("./stationCombat").damageStation(
    room,
    station,
    hullDamage,
    attackerId,
    now,
    origin.x,
    origin.y,
    { shieldDamageMultiplier: 0 }
  );
}



function applyBlastDamageToShip(room, target, origin, cfg, damageMultiplier, contactTargetShip, attackerId, now) {
  if (!target || !target.alive) return 0;
  const isContact = contactTargetShip && target.id === contactTargetShip.id;
  const blastR = cfg.blastRadius;
  const exp = Math.max(0, cfg.falloffExponent);
  const worldCells = getShipComponentCellWorldCoords(target);
  let nearestDist = Infinity;
  for (let i = 0; i < (target.design || []).length; i += 1) {
    if ((target.componentHp?.[i] ?? 1) <= 0) continue;
    const cells = worldCells[i];
    if (!cells || !cells.length) continue;
    for (const cell of cells) {
      const dx = cell.x - origin.x;
      const dy = cell.y - origin.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < nearestDist) nearestDist = distSq;
    }
  }
  if (nearestDist >= blastR * blastR) return 0;
  const distance = Math.sqrt(nearestDist);

  const centreDamage = cfg.centreDamage ?? cfg.splashCentreDamage ?? 0;
  const directContactMultiplier = cfg.directContactMultiplier ?? 1.5;
  const directContactHullDamage = cfg.directContactHullDamage ?? (centreDamage * directContactMultiplier);
  const contactMaxAffected = cfg.contactMaxAffectedComponents === null
    ? null
    : (cfg.contactMaxAffectedComponents ?? cfg.maxAffectedComponents ?? 6);
  const splashMaxAffected = cfg.splashMaxAffectedComponents === null
    ? null
    : (cfg.splashMaxAffectedComponents ?? cfg.maxAffectedComponents ?? 6);
  const contactInternalReduction = cfg.contactInternalDamageReduction ?? cfg.internalDamageReduction ?? 0.7;
  const splashInternalReduction = cfg.splashInternalDamageReduction ?? cfg.internalDamageReduction ?? 0.7;

  const falloff = isContact ? 1 : Math.pow(Math.max(0, 1 - distance / blastR), exp);
  const base = isContact ? directContactHullDamage : centreDamage;
  const hullBudget = base * falloff * damageMultiplier;
  if (hullBudget <= 0) return 0;

  const maxComponents = isContact ? contactMaxAffected : splashMaxAffected;
  const internalReduction = isContact ? contactInternalReduction : splashInternalReduction;

  const candidates = [];
  for (let i = 0; i < (target.design || []).length; i += 1) {
    if (!isComponentAlive(target, i)) continue;
    const pos = componentAimWorldPosition(target, i);
    if (!pos) continue;
    const cdx = pos.x - origin.x;
    const cdy = pos.y - origin.y;
    const cdist = Math.sqrt(cdx * cdx + cdy * cdy);
    const exposed = isComponentExposed(target, i);
    const part = PARTS[target.design[i].type] || PARTS.frame;
    const isArmour = (part.armorFlatReduction || 0) > 0 || STRUCTURAL_COMPONENT_TYPES.has(target.design[i].type);
    candidates.push({ index: i, distance: cdist, exposed, isArmour });
  }
  if (!candidates.length) return 0;
  candidates.sort((a, b) => {
    if (Math.abs(a.distance - b.distance) > 1e-6) return a.distance - b.distance;
    if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
    if (a.isArmour !== b.isArmour) return a.isArmour ? -1 : 1;
    return a.index - b.index;
  });

  const affected = Number.isFinite(maxComponents)
    ? candidates.slice(0, Math.max(1, Math.round(maxComponents)))
    : candidates;
  let totalRemoved = 0;

  // Ripple: nearest component takes the largest share, each further one takes half as much.
  let fracTotal = 0;
  const fractions = [];
  for (let k = 0; k < affected.length; k += 1) {
    const frac = Math.pow(0.65, k);
    fractions.push(frac);
    fracTotal += frac;
  }

  for (let k = 0; k < affected.length; k += 1) {
    const c = affected[k];
    let dmg = (hullBudget * fractions[k]) / fracTotal;
    if (!c.exposed && !c.isArmour) dmg *= (1 - internalReduction);
    if (dmg > 0) {
      const dealt = applyDirectComponentDamage(room, target, c.index, dmg, attackerId, now);
      totalRemoved += dealt;
    }
  }

  if (target.hp <= 0.001) destroyShip(room, target, attackerId, now);
  return totalRemoved;
}



function calculateLinearChargeMultiplier(armedCount) {
  return Math.max(0, Number(armedCount) || 0);
}



function detonateProximityCharge(room, ship, index, now, markDetonated = true, contactTargetShip = null, contactPoint = null) {

  if (!room || !ship || ship.alive === false || ship.destroyFinalizedAt) return;

  if (index < 0 || !Array.isArray(ship.proximityChargeDetonated)) return;

  const cfg = getProximityChargeConfig(ship, index);

  if (!cfg) return;

  if (ship.proximityChargeDetonated[index]) return;



  const indexes = getShipComponentIndexes(ship).proximityChargeIndices;

  const armedIndexes = [];

  for (const i of indexes) {

    if (ship.proximityChargeDetonated?.[i]) continue;

    armedIndexes.push(i);

  }

  if (armedIndexes.length === 0) return;



  if (markDetonated) {

    for (const i of indexes) ship.proximityChargeDetonated[i] = 1;

  }

  ship.proximityChargeRevision = (ship.proximityChargeRevision || 0) + 1;



  const origin = (contactPoint && Number.isFinite(contactPoint.x) && Number.isFinite(contactPoint.y))

    ? { x: contactPoint.x, y: contactPoint.y }

    : proximityChargeWorldPosition(ship, armedIndexes[0]);

  if (!origin || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return;



  const blastR = cfg.blastRadius;

  const exp = Math.max(0, cfg.falloffExponent);

  const damageMultiplier = calculateLinearChargeMultiplier(armedIndexes.length);

  const attackerId = ship.ownerId;



  const diagnostics = {

    carrierId: ship.id,

    triggerEnemyId: contactTargetShip ? contactTargetShip.id : null,

    contactPoint: { x: origin.x, y: origin.y },

    collisionGeometry: contactPoint ? contactPoint.geometry : "component",

    sweptContact: contactPoint && contactPoint.t !== undefined ? contactPoint.t < 1 : false,

    sweptT: contactPoint ? contactPoint.t : 1,

    chargeCount: armedIndexes.length,

    combinedMultiplier: damageMultiplier,

    directTargetId: contactTargetShip ? contactTargetShip.id : null,

    allocations: [],

    hpRemoved: 0,

    carrierDestroyed: false,

    duplicateReason: null

  };



  room.effects.push({ type: "text", text: "DEMOLITION CHARGE DETONATED", x: origin.x, y: origin.y - 18, at: now });

  room.effects.push({ type: "flakburst", x: origin.x, y: origin.y, at: now, radius: blastR });



  const spatial = room.disableSpatialIndex ? null : (room.spatialIndex?.dynamicValid ? room.spatialIndex : null);

  const scratch = room._demolitionBlastScratch || (room._demolitionBlastScratch = { ships: [], drones: [], projectiles: [] });



  for (const kind of ["ships", "drones", "projectiles"]) {

    const out = scratch[kind];

    out.length = 0;

    if (spatial) {

      const key = kind === "projectiles" ? "interceptableProjectiles" : kind;

      spatial.queryRangeUnordered(key, origin.x, origin.y, blastR, out);

    } else if (kind === "ships") {

      for (const s of room.ships?.values?.() || []) if (s?.alive) out.push(s);

    } else if (kind === "drones") {

      for (const d of room.drones?.values?.() || []) if (d && !d.destroyed && !d.removed) out.push(d);

    } else if (kind === "projectiles") {

      for (const b of room.bullets || []) if (b && b.life > 0 && b.interceptable) out.push(b);

    }

    for (const entity of out) {

      if (entity === ship) continue;

      if (kind === "ships") {

        if (!entity.alive) continue;
        if (cfg.damagesFriendlyShips === false && !areEnemies(room, attackerId, entity.ownerId)) continue;

        const removed = applyBlastDamageToShip(room, entity, origin, cfg, damageMultiplier, contactTargetShip, attackerId, now);

        diagnostics.hpRemoved += removed;

      } else if (kind === "drones") {

        if (entity.destroyed || entity.removed) continue;

        const dx = entity.x - origin.x;

        const dy = entity.y - origin.y;

        const edge = Math.max(0, fastHypot(dx, dy) - (entity.radius || 6));

        if (edge >= blastR) continue;

        const damage = blastDamageFor(edge, blastR, (cfg.centreDamage ?? cfg.splashCentreDamage), exp) * damageMultiplier;

        if (damage > 0) require("./drones").damageDrone(room, entity, damage, attackerId, now);

      } else if (kind === "projectiles") {

        if (entity.life <= 0 || !entity.interceptable) continue;

        const dx = entity.x - origin.x;

        const dy = entity.y - origin.y;

        const edge = Math.max(0, fastHypot(dx, dy) - 2);

        if (edge >= blastR) continue;

        const damage = blastDamageFor(edge, blastR, (cfg.centreDamage ?? cfg.splashCentreDamage), exp) * damageMultiplier;

        if (damage <= 0.001) continue;

        entity.hp = (entity.hp ?? (entity.damage || 20)) - damage;

        if (entity.hp <= 0.001) {

          removeProjectileRuntime(room, entity, "intercepted", entity.x, entity.y);

          room.effects.push({ type: "spark", x: entity.x, y: entity.y, at: now });

        }

      }

    }

  }

  for (const station of room.stations || []) {
    if (!station || station.alive === false || station.state === "destroyed") continue;
    if (cfg.damagesFriendlyShips === false && !Relationships.areEntityEnemies(room, attackerId, station)) continue;
    diagnostics.hpRemoved += applyBlastDamageToStation(
      room,
      station,
      origin,
      cfg,
      damageMultiplier,
      contactTargetShip,
      attackerId,
      now
    );
  }



  ship.shield = 0;

  zeroAllComponents(ship);

  ship.hp = 0;

  ship.focusTargetId = null;

  ship.combatTargetId = null;

  ship.repairTargetId = null;
  const movementRuntime = require("./movementRuntime");
  movementRuntime.setMovementCommand(ship, null);
  movementRuntime.syncMovementTarget(ship);

  ship.commandAuraActive = false;

  ship.commandAuraReceived = false;

  invalidateShipCollisionGeometry(ship);



  diagnostics.carrierDestroyed = true;

  if (DEMOLITION_DIAGNOSTICS) {

    if (!room._demolitionDiagnostics) room._demolitionDiagnostics = [];

    room._demolitionDiagnostics.push(diagnostics);

  }



  destroyShip(room, ship, attackerId, now);

}



function proximityChargeDestroyedShip(room, ship, now) {

  if (!ship || !ship.alive) return;

  const indexes = getShipComponentIndexes(ship).proximityChargeIndices;

  for (const i of indexes) {

    if (!isComponentAlive(ship, i)) continue;

    if (ship.proximityChargeDetonated?.[i]) continue;

    detonateProximityCharge(room, ship, i, now, true);

  }

}



module.exports = {

  evaluateShipCommandState,

  updateShipSupport,

  shipRepairNeed,

  updateShipWeapons,

  weaponReloadSeconds,

  beamContactCharge,

  damageBeamTargets,

  moduleRotationToRadians,

  moduleLocalPosition,

  moduleFootprintLocalPosition,

  weaponModuleWorldPosition,

  weaponMuzzleDistance,

  weaponMuzzleWorldPosition,

  isTargetInWeaponArc,

  getHoldWeaponFacingSignature,

  chooseHoldWeaponFacing,
  evaluateHoldWeaponCoverage,
  evaluateMainBatteryFacing,
  mainBatteryOrbitRange,
  mainBatteryProfile,

  damageShip,

  SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE,

  destroyShip,

  updateDestroyedShips,

  requestSelfDestruct,

  updateSelfDestructingShips,

  findTarget,

  findPointDefenseTarget,

  _lookupPointDefenceEntity,

  pickWeaponFireTarget,

  droneThreatScore,

  canWeaponDefensivelyTargetDrones,

  enemyShipThreatScore,  getCandidatePriorityIndex,

  componentAimWorldPosition,

  targetCoreAimWorldPosition,

  findBeamRayIntersections,
  isInductionBlockedByHeatShield,
  spinalChargeProgress,
  spinalTraverseScale,
  spinalHullTurnScale,

  applyBeamHullDamage,

  applyDirectComponentDamage,

  selectComponentAimIndex,

  buildShipTurretDiagnostics,

  isInSafeZone,

  isLineBlocked,

  areAllies,

  areEnemies,

  armedProximityChargeRanges,

  resolveDemolitionContacts,

  updateProximityCharges,

  detonateProximityCharge,

  proximityChargeDestroyedShip,

  nearestDemolitionTargetPoint,

  shipHasOperationalDemolitionCharge,

  PRIORITY_COMPONENT_TYPES,

  weaponSpreadRadians,
  ACCURACY_SPREAD_SCALE

};















