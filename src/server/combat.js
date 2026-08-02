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

const Relationships = require("./relationships");
const { segmentStationHullHit, nearestStationHullPoint, isSegmentStationClear, stationAttackPoint } = require("./stationCollision");

const TargetingTelemetry = require("./targetingTelemetry");
const PointDefenceThreats = require("./pointDefenceThreats");
const TargetingCadence = require("./targetingCadence");
const Targeting = require("./targetingEligibility");
const PerformanceFlags = require("./performanceFlags");

const { getShipComponentIndexes } = require("./componentIndexes");
const { sanitizeCombatStyle } = require("./validation");



const MODULE_SCALE = 13;





const COMPONENT_RETARGET_MIN_MS = 2500;

const COMPONENT_RETARGET_SPAN_MS = 1500;

const STRUCTURAL_COMPONENT_TYPES = new Set(["armor", "compositeArmor", "bulkhead", "frame", "weaponMount"]);

const SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE = 0.12;



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

function allocateRepairHeat(ship, entries, actualRestored) {

  const delivered = Math.max(0, Number(actualRestored) || 0);

  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.output || 0), 0);

  if (delivered <= 0 || total <= 0) return;

  for (const entry of entries) {

    const work = delivered * Math.max(0, entry.output || 0) / total;

    addComponentHeat(ship, entry.index, work * (1.5 + entry.repairRate * 0.35) / Math.max(entry.repairRate, 0.0001));

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

    const selfRepairRate = activeRepairModules

      .filter((entry) => entry.module.type !== "repairBeam")

      .reduce((sum, entry) => sum + entry.output, 0);

    if (selfRepairRate > 0 && shipRepairNeed(ship) > 0) {

      const delivered = repairShipComponents(room, ship, selfRepairRate * dt, now);

      allocateRepairHeat(ship, activeRepairModules.filter((entry) => entry.module.type !== "repairBeam"), delivered);

      ship._repairIntentAt = now; // Section 7D-2: repair systems have a valid action this cycle.

    }



    // Dedicated repair beams are the only repair parts that can project healing

    // onto another ship. They still use normal repair output and heat, but they

    // also traverse like beam weapons and emit a green beam from their muzzle.

    const beamRepairRate = activeRepairBeams.reduce((sum, entry) => sum + entry.output, 0);

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



function weaponSpreadRadians(weapon, family, targetEvasionFactor) {

  const accuracy = clampNumber(Number(weapon?.accuracy) || 0.8, 0.1, 0.99);

  const scale = family === "missile" ? 0.35 : (family === "pointDefense" ? 0.05 : (family === "flak" ? 0.16 : 0.22));

  let spread = (1 - accuracy) * scale;

  const evasion = Number(targetEvasionFactor) || 0;
  if (evasion > 0) {
    const evasionConfig = BALANCE?.movement?.evasion;
    const maxPenalty = evasionConfig?.maxAccuracyPenalty ?? 0.75;
    const exponent = evasionConfig?.evasionExponent ?? 1.4;
    const trackingBase = evasionConfig?.trackingBase ?? 200;
    const evasionPenalty = Math.min(maxPenalty, Math.pow(evasion / trackingBase, exponent));
    spread += evasionPenalty * scale;
  }

  return spread;

}

function computeTransversalVelocity(ship, target) {
  if (!target || !ship) return 0;
  const point = targetAttackPoint(ship.x || 0, ship.y || 0, target);
  const dx = point.x - (ship.x || 0);
  const dy = point.y - (ship.y || 0);
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 0.001) return 0;
  const dirX = dx / dist;
  const dirY = dy / dist;
  const relVx = (target.vx || 0) - (ship.vx || 0);
  const relVy = (target.vy || 0) - (ship.vy || 0);
  const radial = relVx * dirX + relVy * dirY;
  const transverseX = relVx - radial * dirX;
  const transverseY = relVy - radial * dirY;
  return Math.sqrt(transverseX * transverseX + transverseY * transverseY);
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

  const defender = room?.ships?.get?.(protectedShipId) || (room?.stations || []).find((s) => s.id === protectedShipId);

  if (PerformanceFlags.POINT_DEFENCE_SHARED_THREATS()) {
    if (defender) {
      const threatSet = PointDefenceThreats.ensurePointDefenceThreatSet(room, defender, shipOwnerId, now);
      const canSee = (cand) => TargetingTelemetry.withSampledDuration(room, now, defender, 0, "sampledLineOfSightDuration", () => {
        const margin = cand.type === "ship" ? 8 : cand.type === "drone" ? 3 : 4;
        return !isLineBlocked(room, worldX, worldY, cand.entity.x, cand.entity.y, margin);
      });
      const selected = TargetingTelemetry.withSampledDuration(room, now, defender, 0, "sampledPDSelectionDuration", () =>
        PointDefenceThreats.selectPointDefenceTarget(room, worldX, worldY, shipOwnerId, weapon, protectedShipId, now, threatSet, canSee, room._pdReservations)
      );
      if (selected) TargetingTelemetry.bump(room, "pointDefenceSharedSetHits");
      else TargetingTelemetry.bump(room, "pointDefenceSharedSetMisses");
      TargetingTelemetry.bump(room, "pointDefenceLegacyScansAvoided");
      return selected;
    }
    TargetingTelemetry.bump(room, "pointDefenceSharedFallbacks");
    TargetingTelemetry.bump(room, "pointDefenceSharedFallbackNoDefender");
  }

  const rangeSq = weapon.range * weapon.range;

  const priorityList = weapon.targetPriority || ["missile", "torpedo", "projectile", "droneFighter", "droneOther", "drone", "ship"];

  const nowTs = gameplayNow(room, now || performanceNow());
  const viewerPlayer = room.players?.get?.(shipOwnerId);
  const viewerTeam = viewerPlayer?.team;

  // Per-tick reservation map: multiple defensive weapons on the same ship can
  // see what damage has already been committed to each fragile target so they
  // avoid overkilling the same projectile/drone/decoy.
  const reservations = room._pdReservations || new Map();
  function isReserved(entity, type) {
    const reserved = reservations.get(entity.id) || 0;
    if (type === "projectile") return (entity.hp !== undefined ? entity.hp : (entity.damage || 20)) - reserved <= 0.001;
    if (type === "drone") return (entity.hull || 0) - reserved <= 0.001;
    if (type === "decoy") return 1 - reserved <= 0.001;
    return false;
  }

  let best = null;

  let bestDistSq = Infinity;

  const scratch = room._pointDefenseSpatialScratch || (room._pointDefenseSpatialScratch = {

    projectiles: [], drones: [], ships: []

  });

  const projectileCandidates = room.spatialIndex

    ? room.spatialIndex.queryRangeUnordered("interceptableProjectiles", worldX, worldY, weapon.range, scratch.projectiles)

    : (room.bullets || []);



  for (const bullet of projectileCandidates) {

    if (!bullet.interceptable || bullet.life <= 0 || !areEnemies(room, shipOwnerId, bullet.ownerId)) continue;

    const dx = bullet.x - worldX;

    const dy = bullet.y - worldY;

    const distSq = dx * dx + dy * dy;

    if (distSq > rangeSq || TargetingTelemetry.withSampledDuration(room, nowTs, defender, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, bullet.x, bullet.y, 4))) continue;



    const cand = { type: "projectile", entity: bullet };

    const pIdx = getCandidatePriorityIndex(cand, priorityList);

    if (pIdx === -1) continue;

    if (isReserved(bullet, "projectile")) continue;



    if (isCandidateBetter(cand, distSq, best, bestDistSq, priorityList, protectedShipId, room, shipOwnerId)) {

      best = cand;

      bestDistSq = distSq;

    }

  }



  const droneCandidates = room.spatialIndex

    ? room.spatialIndex.queryRangeUnordered("drones", worldX, worldY, weapon.range + (Number(room.droneSpatialPadding) || 0), scratch.drones)

    : (room.drones?.values?.() || []);

  for (const drone of droneCandidates) {

    if (drone.destroyed || drone.removed || room.drones?.get?.(drone.id) !== drone || !areEnemies(room, shipOwnerId, drone.ownerId)) continue;
    if (usesSensorVisibility(room) && viewerTeam && !canTeamTargetEntity(room, viewerTeam, drone, nowTs)) continue;

    const dx = drone.x - worldX;

    const dy = drone.y - worldY;

    const distSq = dx * dx + dy * dy;

    if (distSq > rangeSq || TargetingTelemetry.withSampledDuration(room, nowTs, defender, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, drone.x, drone.y, 3))) continue;



    const cand = { type: "drone", entity: drone };

    const pIdx = getCandidatePriorityIndex(cand, priorityList);

    if (pIdx === -1) continue;

    if (isReserved(drone, "drone")) continue;



    if (isCandidateBetter(cand, distSq, best, bestDistSq, priorityList, protectedShipId, room, shipOwnerId)) {

      best = cand;

      bestDistSq = distSq;

    }

  }



  const shipCandidates = room.spatialIndex

    ? room.spatialIndex.queryRangeUnordered("ships", worldX, worldY, weapon.range, scratch.ships)

    : (ships || []);

  for (const other of shipCandidates) {

    if (!other.alive || !areEnemies(room, shipOwnerId, other.ownerId)) continue;
    if (usesSensorVisibility(room) && viewerTeam && !canTeamTargetEntity(room, viewerTeam, other, nowTs)) continue;

    const dx = other.x - worldX;

    const dy = other.y - worldY;

    const distSq = dx * dx + dy * dy;

    if (distSq > rangeSq || TargetingTelemetry.withSampledDuration(room, nowTs, defender, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, other.x, other.y, 8))) continue;



    const cand = { type: "ship", entity: other };

    const pIdx = getCandidatePriorityIndex(cand, priorityList);

    if (pIdx === -1) continue;

    if (isReserved(other, "ship")) continue;



    if (isCandidateBetter(cand, distSq, best, bestDistSq, priorityList, protectedShipId, room, shipOwnerId)) {

      best = cand;

      bestDistSq = distSq;

    }

  }



  const decoyCandidates = room.decoys?.values?.() || [];

  for (const decoy of decoyCandidates) {

    if (now >= decoy.expiresAt || !areEnemies(room, shipOwnerId, decoy.ownerId)) continue;

    const dx = decoy.x - worldX;

    const dy = decoy.y - worldY;

    const distSq = dx * dx + dy * dy;

    if (distSq > rangeSq || TargetingTelemetry.withSampledDuration(room, nowTs, defender, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, decoy.x, decoy.y, 4))) continue;



    const cand = { type: "decoy", entity: decoy };

    const pIdx = getCandidatePriorityIndex(cand, priorityList);

    if (pIdx === -1) continue;

    if (isReserved(decoy, "decoy")) continue;



    if (isCandidateBetter(cand, distSq, best, bestDistSq, priorityList, protectedShipId, room, shipOwnerId)) {

      best = cand;

      bestDistSq = distSq;

    }

  }



  TargetingTelemetry.bump(room, "pointDefenceMountSelections");
  return best;

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
  if (!PerformanceFlags.WEAPON_TARGET_ACQUISITION_CADENCE()) {
    const t = findTarget(room, ship, ships);
    ship.combatTargetId = t ? t.id : null;
    return t;
  }

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
      ship.combatTargetId = focused.id;
      return focused;
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

function updateShipWeapons(room, ship, ships, dt, now) {

  if (ship.launchPhase) {
    ship.combatTargetId = null;
    if (ship.weaponAimTargetIds) ship.weaponAimTargetIds.fill(null);
    if (ship.weaponFireTargetIds) ship.weaponFireTargetIds.fill(null);
    if (ship.weaponComponentTargetIds) ship.weaponComponentTargetIds.fill(null);
    return;
  }

  if (!ship.weaponCooldowns) {

    ship.weaponCooldowns = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponAngles) {

    ship.weaponAngles = (ship.design || []).map(module => moduleRotationToRadians(normalizeRotation(module.rotation)));

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



  // Per-tick map of how much damage has already been committed to each fragile
  // target by point-defense weapons on this ship. It resets every tick so
  // multiple defensive weapons can coordinate without overkilling the same
  // missile. Stored on the room because it is shared across ships in the room.
  if (!room._pdReservations) room._pdReservations = new Map();
  room._pdReservations.clear();

  const weaponIndices = getShipComponentIndexes(ship).weaponIndices;

  if (PerformanceFlags.WEAPON_PROFILE_REVISION_CACHE()) {
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
      if (ship.weaponAcquiredTargetIds) ship.weaponAcquiredTargetIds[i] = null;
      if (ship.weaponPendingTargetIds) ship.weaponPendingTargetIds[i] = null;
      if (ship.weaponAcquireCompleteAt) ship.weaponAcquireCompleteAt[i] = 0;
      if (ship.pdAcquiredTargetIds) ship.pdAcquiredTargetIds[i] = null;
      if (ship.pdPendingTargetIds) ship.pdPendingTargetIds[i] = null;
      if (ship.pdAcquireCompleteAt) ship.pdAcquireCompleteAt[i] = 0;
      if (ship.pdReactionReadyAt) ship.pdReactionReadyAt[i] = 0;

      clearWeaponComponentAim(ship, i);

      if (ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      return;

    }

    const powerMultiplier = getComponentPowerMultiplier(ship, i);

    // Weapon traverse motors require Power; unpowered weapons cannot acquire

    // targets or rotate toward them.

    if (powerMultiplier <= 0) {

      ship.weaponAimTargetIds[i] = null;

      ship.weaponFireTargetIds[i] = null;
      if (ship.weaponAcquiredTargetIds) ship.weaponAcquiredTargetIds[i] = null;
      if (ship.weaponPendingTargetIds) ship.weaponPendingTargetIds[i] = null;
      if (ship.weaponAcquireCompleteAt) ship.weaponAcquireCompleteAt[i] = 0;
      if (ship.pdAcquiredTargetIds) ship.pdAcquiredTargetIds[i] = null;
      if (ship.pdPendingTargetIds) ship.pdPendingTargetIds[i] = null;
      if (ship.pdAcquireCompleteAt) ship.pdAcquireCompleteAt[i] = 0;
      if (ship.pdReactionReadyAt) ship.pdReactionReadyAt[i] = 0;

      clearWeaponComponentAim(ship, i);

      if (ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      return;

    }



    const effectiveWeapon = isRepairBeam

      ? { type: "beam", arc: 360, range: ship.stats?.repairRange || 400, aimSpeed: TurretRules.turnRateFor("beam") }

      : (PerformanceFlags.WEAPON_PROFILE_REVISION_CACHE()
        ? (getEffectiveWeaponStatsCached(ship, i) || part.weapon)
        : (getEffectiveWeaponStatsInternal(ship, i) || part.weapon));

    const family = effectiveWeapon.type || part.weapon?.type || "beam";

    const cooldown = ship.weaponCooldowns[i] || 0;



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

      // Fleet Defence Coordinator: interception reacquisition delay.
      // Each defensive weapon separately tracks its acquired target, pending
      // target, and the simulation timestamp when the pending acquisition
      // completes. When no threats exist, no timer is scheduled — the weapon
      // simply scans each tick. A new threat can never inherit a previous
      // threat's timer.
      const pdLen = ship.design ? ship.design.length : 0;
      if (!ship.pdAcquiredTargetIds) ship.pdAcquiredTargetIds = new Array(pdLen).fill(null);
      if (!ship.pdPendingTargetIds) ship.pdPendingTargetIds = new Array(pdLen).fill(null);
      if (!ship.pdAcquireCompleteAt) ship.pdAcquireCompleteAt = new Array(pdLen).fill(0);
      if (!ship.pdReactionReadyAt) ship.pdReactionReadyAt = new Array(pdLen).fill(0);

      const worldWeaponAngle = (ship.angle || 0) + (ship.weaponAngles[i] || 0);
      const pdArcRadians = arcRadians;
      const pdBaseWeapon = part.weapon || effectiveWeapon;
      const pdCachedId = ship.pdAcquiredTargetIds[i] ?? null;
      const pdCached = pdCachedId ? _lookupPointDefenceEntity(room, pdCachedId) : null;
      let pdCurrentValid = false;
      if (pdCached) {
        pdCurrentValid = Targeting.isPointDefenceTargetValid(room, ship.ownerId, pdCached, effectiveWeapon.range || 0, now, {
          originX: worldX,
          originY: worldY,
          arcRadians: pdArcRadians,
          weaponAngle: worldWeaponAngle,
          reservations: room._pdReservations,
          priorityList: pdBaseWeapon.targetPriority,
          team: ship.team
        });
        if (pdCurrentValid && TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledLineOfSightDuration", () => isLineBlocked(room, worldX, worldY, pdCached.entity.x, pdCached.entity.y, 4))) pdCurrentValid = false;
        if (!pdCurrentValid) TargetingTelemetry.bump(room, "pointDefenceImmediateReacquisitions");
      }

      const pdDue = TargetingCadence.isAcquisitionDue(ship, "pointDefence", i, now);
      const pdForce = pdCachedId !== null && !pdCurrentValid;
      if (pdCurrentValid && !pdDue) {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
        currentPdTarget = pdCached;
      } else if (!pdDue && !pdForce) {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
        currentPdTarget = null;
      } else {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearches");
        currentPdTarget = findPointDefenseTarget(room, worldX, worldY, ship.ownerId, effectiveWeapon, ships, ship.id, now);
        TargetingCadence.markAcquisitionCompleted(ship, "pointDefence", i, now);
      }

      const newPdId = currentPdTarget ? (currentPdTarget.entity.id ?? null) : null;
      const pdAcquiredId = ship.pdAcquiredTargetIds[i] ?? null;
      const pdPendingId = ship.pdPendingTargetIds[i] ?? null;
      const pdReactionReady = ship.pdReactionReadyAt[i] || 0;

      if (!newPdId) {
        // No threat: if we had an acquired target, start a reaction period
        // so a new threat arriving after a gap still respects the delay.
        if (pdAcquiredId) {
          const reactMult = getCommandAuraMultiplier(ship, "interceptionReactionMultiplier");
          const baseDelay = Number(BALANCE?.fleetDefence?.baseReacquisitionDelayMs) || 600;
          ship.pdReactionReadyAt[i] = now + Math.round(baseDelay / Math.max(0.01, reactMult));
        }
        ship.pdPendingTargetIds[i] = null;
        ship.pdAcquireCompleteAt[i] = 0;
        ship.pdAcquiredTargetIds[i] = null;
        currentPdTarget = null;
        aimEntity = null;
        clearWeaponComponentAim(ship, i);
      } else if (newPdId === pdAcquiredId) {
        // Threat matches acquired target: fire normally, no timer.
        ship.pdPendingTargetIds[i] = null;
        ship.pdAcquireCompleteAt[i] = 0;
        ship.pdReactionReadyAt[i] = 0;
        aimEntity = currentPdTarget.entity;
      } else {
        // Threat differs from acquired target.
        if (newPdId !== pdPendingId) {
          ship.pdPendingTargetIds[i] = newPdId;
          // Only start a new reaction delay if there was no pending target.
          // If a different target appears while we are already reacting,
          // we keep the existing timer so the turret does not get stuck
          // cycling through nearby threats.
          if (!pdPendingId) {
            const reactMult = getCommandAuraMultiplier(ship, "interceptionReactionMultiplier");
            const baseDelay = Number(BALANCE?.fleetDefence?.baseReacquisitionDelayMs) || 600;
            const delay = Math.round(baseDelay / Math.max(0.01, reactMult));
            ship.pdAcquireCompleteAt[i] = Math.max(now + delay, pdReactionReady);
          }
        }
        // While reaction delay is pending, the turret may track the threat
        // visually but must not fire. Check if timer has completed.
        // First-ever target on this weapon fires immediately (no previous
        // acquisition and no reaction ready time from a prior loss).
        const isFirstEver = !pdAcquiredId && pdReactionReady <= 0;
        if (isFirstEver || now >= ship.pdAcquireCompleteAt[i]) {
          // Reaction complete: promote pending to acquired.
          ship.pdAcquiredTargetIds[i] = newPdId;
          ship.pdPendingTargetIds[i] = null;
          ship.pdAcquireCompleteAt[i] = 0;
          ship.pdReactionReadyAt[i] = 0;
          // currentPdTarget stays as-is; aimEntity set below.
          aimEntity = currentPdTarget.entity;
        } else {
          // Still reacting: turret may track but not fire.
          // Set aimEntity so the turret rotates toward the threat.
          aimEntity = currentPdTarget.entity;
          // Null currentPdTarget so the firing check at line ~1664 fails.
          currentPdTarget = null;
        }
        clearWeaponComponentAim(ship, i);
      }

    } else {

      // Keep the ship's assigned target when this weapon can reach it, otherwise

      // fall back to any valid enemy already in this weapon's range so it does

      // not idle while the primary target is out of reach. The assigned target

      // itself is retained at the ship level and resumed once it is attackable.

      // Fire-Control Command Centre: offensive reacquisition delay.
      // Each weapon separately tracks its acquired target, pending target,
      // and the simulation timestamp when the pending acquisition completes.
      // A new target can never inherit a previous target's timer.
      const wLen = ship.design ? ship.design.length : 0;
      if (!ship.weaponAcquiredTargetIds) ship.weaponAcquiredTargetIds = new Array(wLen).fill(null);
      if (!ship.weaponPendingTargetIds) ship.weaponPendingTargetIds = new Array(wLen).fill(null);
      if (!ship.weaponAcquireCompleteAt) ship.weaponAcquireCompleteAt = new Array(wLen).fill(0);

      weaponTarget = PerformanceFlags.WEAPON_TARGET_ACQUISITION_CADENCE()
        ? getCadencedWeaponTarget(room, ship, ships, worldX, worldY, target, range, { weapon: effectiveWeapon, module }, i, now, "ordinaryShip")
        : pickWeaponFireTarget(room, ship, ships, worldX, worldY, target, range, { weapon: effectiveWeapon, module });

      const newTargetId = weaponTarget ? (weaponTarget.id ?? null) : null;
      const acquiredId = ship.weaponAcquiredTargetIds[i] ?? null;
      const pendingId = ship.weaponPendingTargetIds[i] ?? null;
      let pendingAimEntity = null;

      if (!newTargetId) {
        // No target available: clear pending state. Clear acquired if it
        // is no longer the selected target (it may still be valid and
        // will be resumed without a new timer if reselected).
        ship.weaponPendingTargetIds[i] = null;
        ship.weaponAcquireCompleteAt[i] = 0;
        // Do not clear acquiredId here — if the same target reappears
        // next tick we want to resume firing immediately.
      } else if (newTargetId === acquiredId) {
        // Target matches acquired target: fire normally, no timer.
        ship.weaponPendingTargetIds[i] = null;
        ship.weaponAcquireCompleteAt[i] = 0;
      } else {
        // Target differs from acquired target.
        if (newTargetId !== pendingId) {
          // Fresh target: start a new acquisition timer.
          const acqMult = getCommandAuraMultiplier(ship, "targetAcquisitionMultiplier");
          const baseDelay = Number(BALANCE?.fireControl?.baseReacquisitionDelayMs) || 400;
          ship.weaponPendingTargetIds[i] = newTargetId;
          ship.weaponAcquireCompleteAt[i] = now + Math.round(baseDelay / Math.max(0.01, acqMult));
        }
        // While acquisition is pending, the weapon may track (aimEntity
        // is set below) but must not fire. Check if timer has completed.
        
        if (now >= ship.weaponAcquireCompleteAt[i]) {
          // Acquisition complete: promote pending to acquired.
          ship.weaponAcquiredTargetIds[i] = newTargetId;
          ship.weaponPendingTargetIds[i] = null;
          ship.weaponAcquireCompleteAt[i] = 0;
        } else {
          // Still acquiring: weapon may aim but not fire.
          pendingAimEntity = weaponTarget;
          weaponTarget = null;
        }
      }

      aimEntity = weaponTarget || pendingAimEntity || (target && target.alive !== false && !target.destroyed ? target : null);

      if (aimEntity) {

        if (family === "beam") {

          aimPoint = targetCoreAimWorldPosition(aimEntity, worldX, worldY);

          if (aimPoint && effectiveWeapon.accuracy < 1) {

            const acc = clampNumber(Number(effectiveWeapon.accuracy) || 0.99, 0.1, 0.99);

            const maxErrorRad = (1 - acc) * 0.15;

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



    const turnRate = getWeaponTurnRate(effectiveWeapon);

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

      return;

    }



    // Tracking is continuous while reloading. Only firing is cooldown-gated;

    // otherwise the visible turret freezes between shots and snaps at fire time.

    if (cooldown > 0) {

      if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      return;

    }



    // Fire only at an in-range target the turret is actually tracking in-arc.

    if (family === "pointDefense" || family === "flak") {

      if (!currentPdTarget || !isTracking) return;

    } else {

      if (!weaponTarget || !isTracking || aimEntity !== weaponTarget) {

        if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

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
      return;
    }

    const worldAngleToTarget = Math.atan2(targetAimY - worldY, targetAimX - worldX);

    // Alignment tolerance is tighter for Laser PD than for ballistic
    // interceptor pods; flak keeps the legacy wider cone.
    const alignmentThreshold = module.type === "pointDefense" ? 0.035 : (module.type === "interceptorPod" ? 0.2 : 0.26);

    const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));

    if (family !== "beam" && angleErr > alignmentThreshold) return;



    const targetEvasion = (family !== "pointDefense" && family !== "flak") ? computeTransversalVelocity(ship, targetEntity) : 0;

    const spreadScale = weaponSpreadRadians(effectiveWeapon, family, targetEvasion);

    const spread = rngRange(roomCombatRandom(room), -spreadScale, spreadScale);

    const shotAngle = worldWeaponAngle + spread;



    const muzzle = weaponMuzzleWorldPosition(ship, module, worldWeaponAngle, family);



    if (family === "blaster") {

      const speed = effectiveWeapon.projectileSpeed || 620;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

        type: "bolt",

        ownerId: ship.ownerId,

        targetId: weaponTarget.id,

        targetComponentIndex: fireAimPoint?.componentIndex ?? -1,

        x: muzzle.x,

        y: muzzle.y,

        vx: Math.cos(shotAngle) * speed + ship.vx * 0.25,

        vy: Math.sin(shotAngle) * speed + ship.vy * 0.25,

        damage: effectiveWeapon.damage,

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        life: life,

        bornAt: now,

        armorInteractionSeconds: Math.min(1, reload)

      });

    });

      ship.weaponCooldowns[i] = reload;

      addComponentHeat(ship, i, Math.max(5, Math.sqrt(effectiveWeapon.damage || 1) * 1.5));

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

        vx: Math.cos(shotAngle) * speed + ship.vx * 0.15,

        vy: Math.sin(shotAngle) * speed + ship.vy * 0.15,

        damage: effectiveWeapon.damage,

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        tracking: effectiveWeapon.tracking ?? 0.75,

        trackRemaining: effectiveWeapon.trackTime ?? 1.4,

        trackingDelay: effectiveWeapon.trackingDelay ?? 0.25,

        maxSpeed: speed * 1.45,

        life: life,

        bornAt: now,

        age: 0,

        armorInteractionSeconds: Math.min(1, reload)

      });

    });

      ship.weaponCooldowns[i] = reload;

      addComponentHeat(ship, i, Math.max(5, Math.sqrt(effectiveWeapon.damage || 1) * 1.5));

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

        armorInteractionSeconds: dt,

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



      addComponentHeat(ship, i, Math.max(3, Math.sqrt(effectiveWeapon.damage || 1)) * dataFireRateFactor * beamPerformance * dt);

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

          armorInteractionSeconds: Math.min(1, effectiveWeapon.armourPenetration ?? 1),

          life: life,

          bornAt: now

        });

        });

        ship.weaponCooldowns[i] = reload;

        addComponentHeat(ship, i, 4);

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

                  damageShip(room, targetEnt, damage * mult, ship.ownerId, now, muzzle.x, muzzle.y, {

                     armorInteractionSeconds: Math.min(1, reload)

                  });

               }



               room.effects.push({ type: "laserPdPulse", x: muzzle.x, y: muzzle.y, x2: targetEnt.x, y2: targetEnt.y, at: now });

               room.effects.push({ type: "spark", x: targetEnt.x, y: targetEnt.y, at: now });



               ship.weaponCooldowns[i] = reload;

               addComponentHeat(ship, i, 4);

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

            const pdSpreadScale = weaponSpreadRadians(effectiveWeapon, family);

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

               bornAt: now,

               armorInteractionSeconds: currentPdTarget.type === "ship" ? Math.min(1, reload) : undefined

            });

            });

            ship.weaponCooldowns[i] = reload;

            addComponentHeat(ship, i, 4);

         }

      }

    } else if (family === "railgun") {

      const speed = effectiveWeapon.projectileSpeed || 1080;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

        type: "rail",

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

        life: life,

        bornAt: now,

        armorInteractionSeconds: Math.min(1, reload)

      });

    });

      ship.weaponCooldowns[i] = reload;

      addComponentHeat(ship, i, Math.max(8, Math.sqrt(effectiveWeapon.damage || 1) * 1.8));

    }

  });

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



function weaponFacingAngle(ship, module) {

  return ship.angle + moduleRotationToRadians(normalizeRotation(module.rotation));

}



function weaponModuleWorldPosition(ship, module) {

  // Multi-cell turret artwork pivots around the footprint centre, not the

  // blueprint anchor tile. Keep server targeting/projectiles on that same pivot.

  const local = moduleFootprintLocalPosition(module);

  const cos = Math.cos(ship.angle);

  const sin = Math.sin(ship.angle);

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



function weaponMuzzleWorldPosition(ship, module, angle, family) {

  const origin = weaponModuleWorldPosition(ship, module);

  const distance = weaponMuzzleDistance(module, family);

  return {

    x: origin.x + Math.cos(angle) * distance,

    y: origin.y + Math.sin(angle) * distance

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



function normalizedArmorInteractionSeconds(value) {

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) return 1;

  return Math.max(0, Math.min(1, parsed));

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

    const interactionSeconds = normalizedArmorInteractionSeconds(options.armorInteractionSeconds);

    const reduction = part1.armorFlatReduction * protection * interactionSeconds;

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

          const interactionSeconds2 = normalizedArmorInteractionSeconds(options.armorInteractionSeconds);

          const reduction2 = part2.armorFlatReduction * protection2 * interactionSeconds2;

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



function applyDirectComponentDamage(room, ship, index, damage, attackerId, now, options = {}) {

  if (isInSafeZone(room, ship.x, ship.y, ship) || damage <= 0) return 0;

  ship.lastDamagedBy = attackerId;

  if (!ship.componentHp || !isComponentAlive(ship, index)) return 0;



  const part = PARTS[ship.design[index].type] || PARTS.frame;

  let effectiveDamage = damage;

  if (part.armorFlatReduction > 0) {

    const protection = HeatRules.passiveProtectionForState(ship.componentHeatState?.[index] || HeatRules.STATE.NORMAL);

    const interactionSeconds = normalizedArmorInteractionSeconds(options.armorInteractionSeconds);

    const reduction = part.armorFlatReduction * protection * interactionSeconds;

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



function isTargetInWeaponArc(ship, module, target, arcRadians) {

  if (arcRadians >= Math.PI * 2) return true;

  const origin = weaponModuleWorldPosition(ship, module);

  const weaponFacing = weaponFacingAngle(ship, module);

  const point = targetAttackPoint(origin.x, origin.y, target);
  const angleToTarget = Math.atan2(point.y - origin.y, point.x - origin.x);

  return Math.abs(angleDifference(weaponFacing, angleToTarget)) <= arcRadians / 2;

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

        armorInteractionSeconds: options.armorInteractionSeconds

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

  ship.pdAcquiredTargetIds = null;
  ship.pdPendingTargetIds = null;
  ship.pdAcquireCompleteAt = null;
  ship.pdReactionReadyAt = null;
  ship.weaponAcquiredTargetIds = null;
  ship.weaponPendingTargetIds = null;
  ship.weaponAcquireCompleteAt = null;
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

  ship.pdAcquiredTargetIds = null;
  ship.pdPendingTargetIds = null;
  ship.pdAcquireCompleteAt = null;
  ship.pdReactionReadyAt = null;
  ship.weaponAcquiredTargetIds = null;
  ship.weaponPendingTargetIds = null;
  ship.weaponAcquireCompleteAt = null;

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

        ship.pdAcquiredTargetIds = null;
        ship.pdPendingTargetIds = null;
        ship.pdAcquireCompleteAt = null;
        ship.pdReactionReadyAt = null;
        ship.weaponAcquiredTargetIds = null;
        ship.weaponPendingTargetIds = null;
        ship.weaponAcquireCompleteAt = null;

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

  if (primary?.alive && !room.drones?.has?.(primary.id) && canTeamTargetEntity(room, viewerTeam, primary, now)) {

    // An explicit hostile station focus is exclusive for offensive weapons.
    // Keep the weapon tracking/waiting on the station until its surface is in
    // range instead of silently redirecting fire to a ship or drone.
    if (primary.entityType === "station"
      && ship.focusTargetId === primary.id
      && Relationships.areEntityEnemies(room, ship.ownerId, primary)) return primary;

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

  if (shipTarget && !canDivert) return shipTarget;

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
      const dealt = applyDirectComponentDamage(room, target, c.index, dmg, attackerId, now, {});
      totalRemoved += dealt;
    }
  }

  if (target.hp <= 0.001) destroyShip(room, target, attackerId, now);
  return totalRemoved;
}



const CHARGE_DIMINISHING_RETURNS = [1.0, 0.5, 0.25, 0.1, 0.1, 0.1, 0.1];



function calculateCombinedChargeMultiplier(armedCount) {

  let sum = 0;

  for (let i = 0; i < armedCount; i += 1) {

    sum += CHARGE_DIMINISHING_RETURNS[Math.min(i, CHARGE_DIMINISHING_RETURNS.length - 1)];

  }

  return sum;

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

  const damageMultiplier = calculateCombinedChargeMultiplier(armedIndexes.length);

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

  computeTransversalVelocity,

  weaponSpreadRadians

};















