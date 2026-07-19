// Applies combat targeting, weapon cooldowns, weapon arcs, damage resolution, and support/healing.

const { PARTS } = require("./components");
const { ECONOMY } = require("./config");
const { rngRange, clampNumber, angleDifference, rotateToward } = require("./utils");
const { normalizeRotation } = require("./shipDesign");
const { getOccupiedCells } = require("./footprint");
const { addBullet, segmentCircleHit } = require("./projectiles");
const { applyHullDamage, repairShipComponents, isComponentAlive, zeroAllComponents } = require("./componentHealth");
const { addComponentHeat, distributeComponentHeatByWeight, componentPerformance } = require("./heat");
const TurretRules = require("../../public/src/shared/turretRules");
const { getComponentPowerMultiplier, effectiveShieldCapacityContributions } = require("./componentPower");
const { getEffectiveWeaponStats, getEffectiveWeaponStatsInternal, getMaxEffectiveWeaponRange } = require("./componentData");

const MODULE_SCALE = 13;


const COMPONENT_RETARGET_MIN_MS = 2500;
const COMPONENT_RETARGET_SPAN_MS = 1500;
const STRUCTURAL_COMPONENT_TYPES = new Set(["armor", "compositeArmor", "bulkhead", "frame", "weaponMount"]);
const SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE = 0.12;
const PRIORITY_COMPONENT_TYPES = new Set(["engine", "maneuverThruster", "reactor", "auxGenerator", "battery", "capacitor", "shield", "aegisProjector", "repair", "repairBeam", "fireControl"]);

function componentAimLocalPosition(ship, index) {
  const module = ship?.design?.[index];
  if (!module) return null;
  return moduleFootprintLocalPosition(module);
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

function nextComponentRetargetAt(room, now) {
  return now + COMPONENT_RETARGET_MIN_MS + Math.floor(roomCombatRandom(room)() * COMPONENT_RETARGET_SPAN_MS);
}

function clearWeaponComponentAim(ship, weaponIndex) {
  if (ship?.weaponComponentTargetIds) ship.weaponComponentTargetIds[weaponIndex] = null;
  if (ship?.weaponComponentTargetIndices) ship.weaponComponentTargetIndices[weaponIndex] = -1;
  if (ship?.weaponComponentRetargetAt) ship.weaponComponentRetargetAt[weaponIndex] = 0;
}

function weaponComponentAimPoint(room, ship, weaponIndex, target, now) {
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
    ship.weaponComponentRetargetAt[weaponIndex] = nextComponentRetargetAt(room, now);
  }
  const point = currentIndex >= 0 ? componentAimWorldPosition(target, currentIndex) : null;
  return point ? { ...point, componentIndex: currentIndex } : { x: target.x, y: target.y, componentIndex: -1 };
}

function shipRepairNeed(ship) {
  if (!ship || !ship.alive) return 0;
  let need = Math.max(0, (ship.maxHp || 0) - (ship.hp || 0));
  const hp = ship.componentHp || [];
  const max = ship.componentMaxHp || [];
  for (let i = 0; i < hp.length; i += 1) {
    need += Math.max(0, (max[i] || 0) - (hp[i] || 0));
  }
  return need;
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
    if (!ship.stats.repair) continue;

    const activeRepairModules = [];
    const activeRepairBeams = [];
    for (let i = 0; i < (ship.design || []).length; i += 1) {
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
        && Math.hypot(assigned.x - ship.x, assigned.y - ship.y) <= ship.stats.repairRange) {
        target = assigned;
      }
    }

    if (!target) {
      for (const other of ships) {
        if (other.id === ship.id) continue;
        if (!areAllies(room, ship.ownerId, other.ownerId)) continue;
        const missing = shipRepairNeed(other);
        if (missing <= 0) continue;
        const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
        if (distance > ship.stats.repairRange) continue;
        const urgency = missing / Math.max(1, distance * 0.08);
        if (urgency > worst) {
          target = other;
          worst = urgency;
        }
      }
    }

    if (!target) continue;
    const delivered = repairShipComponents(room, target, beamRepairRate * dt, now);
    allocateRepairHeat(ship, activeRepairBeams, delivered);

    const emitterEntry = activeRepairBeams[0];
    const emitterIndex = emitterEntry.index;
    const emitter = emitterEntry.module;
    const origin = weaponModuleWorldPosition(ship, emitter);

    // Rotate the emitter turret toward the repair target at the shared beam
    // traverse rate (instead of snapping) so it visibly tracks, and emit the
    // beam from wherever the barrel is actually pointing this tick.
    if (!ship.weaponAngles) ship.weaponAngles = (ship.design || []).map((m) => moduleRotationToRadians(normalizeRotation(m.rotation)));
    const worldAngleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
    const desiredRelative = angleDifference(ship.angle, worldAngleToTarget);
    const currentRelative = ship.weaponAngles[emitterIndex] ?? moduleRotationToRadians(normalizeRotation(emitter.rotation));
    ship.weaponAngles[emitterIndex] = rotateToward(currentRelative, desiredRelative, TurretRules.turnRateFor("beam") * dt);
    const muzzle = weaponMuzzleWorldPosition(ship, emitter, ship.angle + ship.weaponAngles[emitterIndex], "beam");

    // Emit a continuous repair beam from the emitter muzzle to the one target.
    if (now - (ship.repairPulseAt || 0) > 90) {
      ship.repairPulseAt = now;
      room.effects.push({ type: "repairbeam", x: muzzle.x, y: muzzle.y, x2: target.x, y2: target.y, at: now, ownerId: ship.ownerId });
    }
  }
}


function stableId(value) {
  return String(value?.id ?? value ?? "");
}

function isStableIdBefore(a, b) {
  return stableId(a).localeCompare(stableId(b)) < 0;
}

function roomCombatRandom(room) {
  return typeof room?.combatRandom === "function" ? room.combatRandom : Math.random;
}

function weaponSpreadRadians(weapon, family) {
  const accuracy = clampNumber(Number(weapon?.accuracy) || 0.8, 0.1, 0.99);
  const scale = family === "missile" ? 0.35 : (family === "pointDefense" ? 0.05 : 0.22);
  return (1 - accuracy) * scale;
}

function findPointDefenseTarget(room, worldX, worldY, shipOwnerId, weapon, ships, protectedShipId = null) {
  let best = null;
  let bestScore = -Infinity;
  const rangeSq = weapon.range * weapon.range;

  for (const bullet of room.bullets) {
    if (!bullet.interceptable || bullet.life <= 0 || !areEnemies(room, shipOwnerId, bullet.ownerId)) continue;

    const dx = bullet.x - worldX;
    const dy = bullet.y - worldY;
    const distSq = dx * dx + dy * dy;

    if (distSq <= rangeSq && !isLineBlocked(room, worldX, worldY, bullet.x, bullet.y, 4)) {
      let score = -distSq;
      if (protectedShipId && bullet.targetId === protectedShipId) score += 10000000;
      else if (ships.some((ally) => ally?.alive && ally.id === bullet.targetId && areAllies(room, shipOwnerId, ally.ownerId))) score += 5000000;

      const priorityList = weapon.targetPriority || ["missile", "torpedo", "projectile", "ship"];
      const pIndex = priorityList.indexOf(bullet.type);
      if (pIndex !== -1) {
          score -= pIndex * 100000;
      }

      if (score > bestScore || (score === bestScore && (!best || isStableIdBefore(bullet, best.entity)))) {
        bestScore = score;
        best = { type: 'projectile', entity: bullet };
      }
    }
  }

  if (best) return best;

  let bestShip = null;
  let bestShipDist = Infinity;

  for (const other of ships) {
    if (!other.alive || !areEnemies(room, shipOwnerId, other.ownerId)) continue;
    const dx = other.x - worldX;
    const dy = other.y - worldY;
    const dist = Math.hypot(dx, dy);
    if (dist <= weapon.range && !isLineBlocked(room, worldX, worldY, other.x, other.y, 8)
      && (dist < bestShipDist || (dist === bestShipDist && (!bestShip || isStableIdBefore(other, bestShip))))) {
      bestShip = other;
      bestShipDist = dist;
    }
  }

  if (bestShip) return { type: 'ship', entity: bestShip };
  return null;
}


function isInSafeZone(room, x, y, shipOrPlayer = null) {
  if (!room.map || !room.map.safeZones) return false;
  const player = shipOrPlayer?.ownerId ? room.players?.get(shipOrPlayer.ownerId) : shipOrPlayer;
  for (const zone of room.map.safeZones) {
    if (Math.hypot(x - zone.x, y - zone.y) > zone.radius) continue;
    if (zone.ownerId) return Boolean(player && player.id === zone.ownerId);
    if (zone.team) return Boolean(player && player.team === zone.team);
    return true;
  }
  return false;
}

function updateShipWeapons(room, ship, ships, dt, now) {
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

  for (let i = 0; i < ship.weaponCooldowns.length; i += 1) {
    ship.weaponCooldowns[i] = Math.max(0, ship.weaponCooldowns[i] - dt);
  }

  // Safe zones block FIRING only — never aiming. Target acquisition and
  // turret traverse continue so protected ships visibly track threats instead
  // of freezing at the blueprint angle in spawn.
  const firingBlockedBySafeZone = isInSafeZone(room, ship.x, ship.y, ship);

  const target = findTarget(room, ship, ships);
  ship.combatTargetId = target ? target.id : null;

  (ship.design || []).forEach((module, i) => {
    const part = PARTS[module.type];
    if (!part?.weapon) return;
    if (!isComponentAlive(ship, i)) {
      // Destroyed weapons neither aim nor fire; the client freezes their art.
      ship.weaponAimTargetIds[i] = null;
      ship.weaponFireTargetIds[i] = null;
      clearWeaponComponentAim(ship, i);
      return;
    }
    const powerMultiplier = getComponentPowerMultiplier(ship, i);
    // Weapon traverse motors require Power; unpowered weapons cannot acquire
    // targets or rotate toward them.
    if (powerMultiplier <= 0) {
      ship.weaponAimTargetIds[i] = null;
      ship.weaponFireTargetIds[i] = null;
      clearWeaponComponentAim(ship, i);
      return;
    }

    const effectiveWeapon = getEffectiveWeaponStatsInternal(ship, i) || part.weapon;
    const family = effectiveWeapon.type || part.weapon.type;
    const cooldown = ship.weaponCooldowns[i] || 0;

    const arcRadians = (effectiveWeapon.arc || 360) * Math.PI / 180;
    const weaponOrigin = weaponModuleWorldPosition(ship, module);
    const worldX = weaponOrigin.x;
    const worldY = weaponOrigin.y;
    const range = effectiveWeapon.range || 0;

    const defaultRelative = moduleRotationToRadians(normalizeRotation(module.rotation));

    // Aiming and firing use separate targets. fireTarget must satisfy the
    // existing rules (inside this weapon's range, line of sight); aimTarget is
    // what the turret visually tracks — the fire target when one exists,
    // otherwise the ship's assigned/combat target so the barrel orients toward
    // the enemy before it enters firing range. Point defence only ever tracks
    // a plausible PD target (findPointDefenseTarget's own rules, which already
    // include its ship fallback).
    let currentPdTarget = null;
    let weaponTarget = null;
    let aimEntity = null;
    let aimPoint = null;
    let fireAimPoint = null;

    if (family === "pointDefense") {
      currentPdTarget = findPointDefenseTarget(room, worldX, worldY, ship.ownerId, effectiveWeapon, ships, ship.id);
      aimEntity = currentPdTarget ? currentPdTarget.entity : null;
      clearWeaponComponentAim(ship, i);
    } else {
      // Keep the ship's assigned target when this weapon can reach it, otherwise
      // fall back to any valid enemy already in this weapon's range so it does
      // not idle while the primary target is out of reach. The assigned target
      // itself is retained at the ship level and resumed once it is attackable.
      weaponTarget = pickWeaponFireTarget(room, ship, ships, worldX, worldY, target, range);
      aimEntity = weaponTarget || (target && target.alive ? target : null);
      if (aimEntity) {
        aimPoint = weaponComponentAimPoint(room, ship, i, aimEntity, now);
        if (weaponTarget && aimEntity === weaponTarget) fireAimPoint = aimPoint;
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
      const worldAngleToTarget = Math.atan2(aimY - worldY, aimX - worldX);
      const relativeAngleToTarget = angleDifference(ship.angle, worldAngleToTarget);
      const diff = angleDifference(defaultRelative, relativeAngleToTarget);
      if (Math.abs(diff) <= arcRadians / 2) {
        desiredRelative = relativeAngleToTarget;
        isTracking = true;
      }
    }

    const turnRate = getWeaponTurnRate(effectiveWeapon);
    const currentRelative = ship.weaponAngles[i] !== undefined ? ship.weaponAngles[i] : defaultRelative;
    ship.weaponAngles[i] = rotateToward(currentRelative, desiredRelative, turnRate * dt);

    // Development/diagnostic trace of the aim decision (cheap flat writes; read
    // by buildShipTurretDiagnostics and the dev debug endpoint).
    ship.weaponDesiredAngles[i] = desiredRelative;
    ship.weaponAimTargetIds[i] = isTracking && aimEntity ? aimEntity.id ?? null : null;
    ship.weaponFireTargetIds[i] = family === "pointDefense"
      ? (currentPdTarget ? currentPdTarget.entity.id ?? null : null)
      : (weaponTarget ? weaponTarget.id ?? null : null);

    // ---- Firing permission (independent of aiming) ----
    // Protected ships never fire: no projectile, no beam damage, no firing
    // heat, and the cooldown is not consumed as though a shot fired.
    if (firingBlockedBySafeZone) return;

    // Unpowered weapons cannot traverse or fire and clear their targeting state.
    // Powered but thermally disabled weapons may keep tracking, but cannot fire.
    const heatMultiplier = componentPerformance(ship, i);
    const activityMultiplier = powerMultiplier * heatMultiplier;
    if (activityMultiplier <= 0) return;

    // Tracking is continuous while reloading. Only firing is cooldown-gated;
    // otherwise the visible turret freezes between shots and snaps at fire time.
    if (cooldown > 0) return;

    // Fire only at an in-range target the turret is actually tracking in-arc.
    if (family === "pointDefense") {
      if (!currentPdTarget || !isTracking) return;
    } else {
      if (!weaponTarget || !isTracking || aimEntity !== weaponTarget) return;
    }

    const worldWeaponAngle = ship.angle + ship.weaponAngles[i];
    const targetEntity = family === "pointDefense" ? currentPdTarget.entity : weaponTarget;
    const targetAimX = fireAimPoint ? fireAimPoint.x : targetEntity.x;
    const targetAimY = fireAimPoint ? fireAimPoint.y : targetEntity.y;
    const worldAngleToTarget = Math.atan2(targetAimY - worldY, targetAimX - worldX);
    const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));
    if (family !== "beam" && angleErr > 0.26) return;

    const spreadScale = weaponSpreadRadians(effectiveWeapon, family);
    const spread = rngRange(roomCombatRandom(room), -spreadScale, spreadScale);
    const shotAngle = worldWeaponAngle + spread;

    const muzzle = weaponMuzzleWorldPosition(ship, module, worldWeaponAngle, family);

    if (family === "blaster") {
      const speed = effectiveWeapon.projectileSpeed || 620;
      const rangeVal = effectiveWeapon.range;
      const life = rangeVal / speed;
      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);
      addBullet(room, {
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
      ship.weaponCooldowns[i] = reload;
      addComponentHeat(ship, i, Math.max(5, Math.sqrt(effectiveWeapon.damage || 1) * 1.5));
    } else if (family === "missile") {
      const speed = effectiveWeapon.projectileSpeed || 330;
      const rangeVal = effectiveWeapon.range;
      const life = rangeVal / speed;
      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);
      addBullet(room, {
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
        tracking: effectiveWeapon.tracking || 0.75,
        trackRemaining: effectiveWeapon.trackTime || 1.4,
        trackingDelay: effectiveWeapon.trackingDelay || 0.25,
        maxSpeed: speed * 1.45,
        life: life,
        bornAt: now,
        age: 0,
        armorInteractionSeconds: Math.min(1, reload)
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
      damageBeamTargets(room, ship, ships, muzzle.x, muzzle.y, beamEnd.x, beamEnd.y, beamRadius, effectiveWeapon.damage * dataFireRateFactor * beamPerformance * dt, now, {
        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,
        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,
        armorInteractionSeconds: dt
      });
      addComponentHeat(ship, i, Math.max(3, Math.sqrt(effectiveWeapon.damage || 1)) * dataFireRateFactor * beamPerformance * dt);
      if (now - (ship.beamEffectsAt[i] || 0) > 55) {
        ship.beamEffectsAt[i] = now;
        room.effects.push({
          type: "beam",
          ownerId: ship.ownerId,
          x: muzzle.x,
          y: muzzle.y,
          x2: beamEnd.x,
          y2: beamEnd.y,
          radius: beamRadius,
          at: now
        });
      }
    } else if (family === "pointDefense") {
      if (currentPdTarget) {
         const speed = effectiveWeapon.projectileSpeed || 1000;
         const life = (effectiveWeapon.range || 0) / speed;
         const targetEnt = currentPdTarget.entity;
         const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);
         const pdSpreadScale = weaponSpreadRadians(effectiveWeapon, family);
         const shotAngle = Math.atan2(targetEnt.y - muzzle.y, targetEnt.x - muzzle.x) + rngRange(roomCombatRandom(room), -pdSpreadScale, pdSpreadScale);

         addBullet(room, {
            type: "pdShot",
            subtype: module.type,
            ownerId: ship.ownerId,
            targetId: targetEnt.id,
            x: muzzle.x,
            y: muzzle.y,
            vx: Math.cos(shotAngle) * speed + ship.vx * 0.25,
            vy: Math.sin(shotAngle) * speed + ship.vy * 0.25,
            damage: effectiveWeapon.damage * (currentPdTarget.type === "ship" ? (effectiveWeapon.shipDamageMultiplier || 0.1) : 1),
            shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,
            hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,
            pdTargetType: currentPdTarget.type,
            pdTargetId: targetEnt.id,
            life: life,
            bornAt: now,
            armorInteractionSeconds: currentPdTarget.type === "ship" ? Math.min(1, reload) : undefined
         });
         ship.weaponCooldowns[i] = reload;
         addComponentHeat(ship, i, 4);

         const pdCount = (ship.design || []).filter(m => PARTS[m.type]?.weapon?.type === "pointDefense").length || 1;
         if (pdCount > 1) {
           const stagger = reload / pdCount;
           (ship.design || []).forEach((otherModule, j) => {
             if (i === j) return;
             const otherPart = PARTS[otherModule.type];
             if (otherPart?.weapon?.type === "pointDefense") {
               ship.weaponCooldowns[j] = Math.max(ship.weaponCooldowns[j], stagger);
             }
           });
         }
      }
    } else if (family === "railgun") {
      const speed = effectiveWeapon.projectileSpeed || 1080;
      const rangeVal = effectiveWeapon.range;
      const life = rangeVal / speed;
      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);
      addBullet(room, {
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

function weaponModulesInArc(ship, target, family) {
  let count = 0;
  const design = ship.design || [];
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const part = PARTS[module.type];
    if (!part?.weapon || part.weapon.type !== family) continue;
    if (!isComponentAlive(ship, i)) continue;
    if (isTargetInWeaponArc(ship, module, target, (part.weapon.arc || 360) * Math.PI / 180)) count += 1;
  }
  return count;
}

function moduleRotationToRadians(rotation) {
  if (rotation === 90) return Math.PI / 2;
  if (rotation === 180) return Math.PI;
  if (rotation === 270) return -Math.PI / 2;
  return 0;
}

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

  for (const asteroid of room.map?.asteroids || []) {
    const hit = segmentCircleHit(x, y, maxX, maxY, asteroid.x, asteroid.y, asteroid.radius + beamRadius);
    if (hit && hit.t < end.t) end = { x: hit.x, y: hit.y, t: hit.t };
  }

  return end;
}

function damageBeamTargets(room, ship, ships, x1, y1, x2, y2, beamRadius, damage, now, options = {}) {
  const { getShipModuleWorldCoords } = require("./ships");
  for (const target of ships) {
    if (!target.alive || !areEnemies(room, ship.ownerId, target.ownerId)) continue;

    // Broad-phase: check if the beam line segment is anywhere near the ship's bounding circle
    const broadHit = segmentCircleHit(x1, y1, x2, y2, target.x, target.y, target.radius + beamRadius);
    if (!broadHit) continue;

    // Narrow-phase: check segment-circle intersection against precomputed individual hull module world positions
    let hitPoint = null;
    const coords = getShipModuleWorldCoords(target);

    for (let i = 0; i < coords.length; i++) {
      if (!isComponentAlive(target, i)) continue; // destroyed modules no longer block
      const m = coords[i];
      const hit = segmentCircleHit(x1, y1, x2, y2, m.x, m.y, 8.5 + beamRadius);
      // Components are stored in blueprint order, which is not guaranteed to
      // match the beam entry order. Use the closest intersection along the beam
      // so continuous beams damage the front component instead of sometimes
      // skipping through to a later-listed rear module.
      if (hit && (!hitPoint || hit.t < hitPoint.t)) hitPoint = hit;
    }

    if (hitPoint) {
      damageShip(room, target, damage, ship.ownerId, now, hitPoint.x, hitPoint.y, options);
    }
  }
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
  const angleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
  return Math.abs(angleDifference(weaponFacing, angleToTarget)) <= arcRadians / 2;
}

function damageShip(room, ship, damage, attackerId, now, sourceX, sourceY, options = {}) {
  if (isInSafeZone(room, ship.x, ship.y, ship)) return; // Invincible in own/team spawn

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

  const shieldMultiplier = Number(options.shieldDamageMultiplier ?? 1);
  const hullMultiplier = Number(options.hullDamageMultiplier ?? 1);

  let hullDamage = damage * hullMultiplier;

  if (ship.shield > 0) {
    const shieldDamage = damage * shieldMultiplier;
    const blockedShieldDamage = Math.min(ship.shield, shieldDamage);
    ship.shield -= blockedShieldDamage;

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
    // Route hull damage into the component under the impact point (armour on
    // that side first). Only the damage actually absorbed by components is
    // shown as a floating number — armour flat reduction eats the rest.
    const impactX = sourceX !== undefined ? sourceX : ship.x;
    const impactY = sourceY !== undefined ? sourceY : ship.y;
    const applied = applyHullDamage(room, ship, hullDamage, now, impactX, impactY, {
      armorInteractionSeconds: options.armorInteractionSeconds
    });
    if (applied > 0) pushDamageEffect(room, ship, now, applied, false);
  }

  if (ship.hp > 0.001 && !ship.coreDestroyed) return;
  destroyShip(room, ship, attackerId, now);
}

function destroyShip(room, ship, attackerId, now) {
  if (!ship || ship.destroyFinalizedAt || ship.removed) return false;
  ship.destroyFinalizedAt = now;
  ship.alive = false;
  ship.removeAt = now + 3200;
  ship.hp = 0;
  zeroAllComponents(ship);
  ship.shield = 0;
  ship.weaponComponentTargetIds = null;
  ship.weaponComponentTargetIndices = null;
  ship.weaponComponentRetargetAt = null;
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
    attacker.score += 30 + Math.round(bounty * 0.4);
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
  ship.hp = 0;
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
      if (!ship.alive && !ship.removed && ship.removeAt && now >= ship.removeAt) {
        ship.removed = true;
        ship.weaponComponentTargetIds = null;
        ship.weaponComponentTargetIndices = null;
        ship.weaponComponentRetargetAt = null;
        room.ships.delete(ship.id);
        removedAny = true;
      }
    }
    if (removedAny) {
      player.ships = player.ships.filter((ship) => !ship.removed);
    }
  }
}

function maxShipWeaponAcquisitionRange(ship) {
  return getMaxEffectiveWeaponRange(ship);
}

function findTarget(room, ship, ships) {
  let best = null;
  let bestDistance = Infinity;
  const range = maxShipWeaponAcquisitionRange(ship);

  if (ship.focusTargetId) {
    const focused = ships.find((other) => other.id === ship.focusTargetId && areEnemies(room, ship.ownerId, other.ownerId));
    if (focused && focused.alive) {
      const focusedDistance = Math.hypot(focused.x - ship.x, focused.y - ship.y);
      if (focusedDistance <= range * 1.12 && !isLineBlocked(room, ship.x, ship.y, focused.x, focused.y, 8)) return focused;
    }
  }

  for (const other of ships) {
    if (!other.alive || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
    if (distance <= range && !isLineBlocked(room, ship.x, ship.y, other.x, other.y, 8)
      && (distance < bestDistance || (distance === bestDistance && (!best || isStableIdBefore(other, best))))) {
      best = other;
      bestDistance = distance;
    }
  }

  return best;
}

// Per-weapon firing target: prefer the ship's assigned/primary target when this
// weapon can actually reach it (range + line of sight), otherwise the nearest
// valid enemy already in this weapon's range so the weapon never idles while the
// primary target is out of reach. The assigned target is not changed here.
function pickWeaponFireTarget(room, ship, ships, worldX, worldY, primary, range) {
  if (primary && primary.alive) {
    const distance = Math.hypot(primary.x - worldX, primary.y - worldY);
    if (distance <= range && !isLineBlocked(room, worldX, worldY, primary.x, primary.y, 8)) return primary;
  }

  let best = null;
  let bestDistance = Infinity;
  for (const other of ships) {
    if (!other.alive || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const distance = Math.hypot(other.x - worldX, other.y - worldY);
    if (distance <= range && !isLineBlocked(room, worldX, worldY, other.x, other.y, 8)
      && (distance < bestDistance || (distance === bestDistance && (!best || isStableIdBefore(other, best))))) {
      best = other;
      bestDistance = distance;
    }
  }
  return best;
}

function isLineBlocked(room, x1, y1, x2, y2, margin = 0) {
  for (const asteroid of room.map?.asteroids || []) {
    if (segmentCircleHit(x1, y1, x2, y2, asteroid.x, asteroid.y, asteroid.radius + margin)) return true;
  }
  return false;
}

function areAllies(room, ownerA, ownerB) {
  if (ownerA === ownerB) return true;
  if (room.rules?.gameMode === "solo") return false;
  const a = room.players.get(ownerA);
  const b = room.players.get(ownerB);
  return Boolean(a && b && a.team === b.team);
}

function areEnemies(room, ownerA, ownerB) {
  if (ownerA === ownerB) return false;
  if (room.rules?.gameMode === "solo") return Boolean(room.players.has(ownerA) && room.players.has(ownerB));
  const a = room.players.get(ownerA);
  const b = room.players.get(ownerB);
  return Boolean(a && b && a.team !== b.team);
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
    const targetShip = aimTargetId ? room.ships?.get?.(aimTargetId) || null : null;
    let targetDistance = null;
    let inFiringRange = null;
    let inFixedArc = null;
    if (targetShip) {
      targetDistance = Math.hypot(targetShip.x - origin.x, targetShip.y - origin.y);
      inFiringRange = targetDistance <= range;
      inFixedArc = isTargetInWeaponArc(ship, module, targetShip, arcRadians);
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

module.exports = {
  updateShipSupport,
  shipRepairNeed,
  updateShipWeapons,
  weaponModulesInArc,
  weaponReloadSeconds,
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
  pickWeaponFireTarget,
  componentAimWorldPosition,
  selectComponentAimIndex,
  buildShipTurretDiagnostics,
  isInSafeZone,
  isLineBlocked,
  areAllies,
  areEnemies,
  PRIORITY_COMPONENT_TYPES
};
