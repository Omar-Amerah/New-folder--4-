// Applies combat targeting, weapon cooldowns, weapon arcs, damage resolution, and support/healing.

const { PARTS } = require("./components");
const { ECONOMY } = require("./config");
const { randomRange, clampNumber, angleDifference, rotateToward } = require("./utils");
const { normalizeRotation } = require("./shipDesign");
const { addBullet, segmentCircleHit } = require("./projectiles");
const { applyHullDamage, repairShipComponents, isComponentAlive, zeroAllComponents } = require("./componentHealth");
const { addComponentHeat, addHeatToType, componentPerformance, systemPerformance } = require("./heat");

const MODULE_SCALE = 13;
const MUZZLE_DISTANCE = Object.freeze({
  blaster: 11,
  missile: 12,
  railgun: 14,
  beam: 13
});

function updateShipSupport(room, ships, dt, now) {
  for (const ship of ships) {
    if (!ship.stats.repair) continue;
    let repairPerformance = 0;
    let repairModules = 0;
    for (let i = 0; i < (ship.design || []).length; i += 1) {
      if (!(PARTS[ship.design[i].type]?.repairRate > 0) || !isComponentAlive(ship, i)) continue;
      repairPerformance += componentPerformance(ship, i);
      repairModules += 1;
    }
    repairPerformance = repairModules ? repairPerformance / repairModules : 0;
    if (repairPerformance <= 0) continue;

    let target = null;
    let worst = 0;
    for (const other of ships) {
      if (!areAllies(room, ship.ownerId, other.ownerId)) continue;
      const missing = other.maxHp - other.hp;
      if (missing <= 0) continue;
      const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
      if (distance > ship.stats.repairRange) continue;
      if (missing > worst) {
        target = other;
        worst = missing;
      }
    }

    if (!target) continue;
    const heal = ship.stats.repairRate * ship.stats.efficiency * repairPerformance * (ship.thermalPowerFactor ?? 1) * dt;
    repairShipComponents(room, target, heal, now);
    for (let i = 0; i < (ship.design || []).length; i += 1) {
      const repairRate = PARTS[ship.design[i].type]?.repairRate || 0;
      if (repairRate > 0 && isComponentAlive(ship, i) && componentPerformance(ship, i) > 0) addComponentHeat(ship, i, (1.5 + repairRate * 0.35) * dt);
    }

    if (now - ship.repairPulseAt > 420) {
      ship.repairPulseAt = now;
      room.effects.push({ type: "repair", x: target.x, y: target.y, at: now, ownerId: ship.ownerId });
    }
  }
}


function findPointDefenseTarget(room, worldX, worldY, shipOwnerId, weapon, ships) {
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
      if (bullet.targetId === shipOwnerId) score += 10000000;
      else score += 5000000;

      const priorityList = weapon.targetPriority || ["missile", "torpedo", "projectile", "ship"];
      const pIndex = priorityList.indexOf(bullet.type);
      if (pIndex !== -1) {
          score -= pIndex * 100000;
      }

      if (score > bestScore) {
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
    if (dist <= weapon.range && dist < bestShipDist && !isLineBlocked(room, worldX, worldY, other.x, other.y, 8)) {
      bestShip = other;
      bestShipDist = dist;
    }
  }

  if (bestShip) return { type: 'ship', entity: bestShip };
  return null;
}


function updateDecoys(room, ship, dt, now) {
  if (!ship.stats.decoyCooldown || !ship.stats.decoyRange) return;

  if (ship.decoyReadyIn === undefined) ship.decoyReadyIn = 0;
  if (ship.decoyReadyIn > 0) {
    ship.decoyReadyIn -= dt;
    return;
  }

  const rangeSq = ship.stats.decoyRange * ship.stats.decoyRange;
  let used = false;

  for (const bullet of room.bullets) {
    if (!bullet.interceptable || bullet.life <= 0 || bullet.targetId !== ship.id) continue;

    const dx = bullet.x - ship.x;
    const dy = bullet.y - ship.y;
    if (dx * dx + dy * dy <= rangeSq) {
      if (Math.random() <= (ship.stats.decoyChance || 0.85)) {
        bullet.trackingDisabledFor = ship.stats.decoyConfuseDuration || 1.2;
      }
      used = true;
    }
  }

  if (used) {
    ship.decoyReadyIn = ship.stats.decoyCooldown;
    room.effects.push({ type: "spark", x: ship.x, y: ship.y, at: now });
  }
}

function isInSafeZone(room, x, y) {
  if (!room.map || !room.map.safeZones) return false;
  for (const zone of room.map.safeZones) {
    if (Math.hypot(x - zone.x, y - zone.y) <= zone.radius) return true;
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

  for (let i = 0; i < ship.weaponCooldowns.length; i += 1) {
    ship.weaponCooldowns[i] = Math.max(0, ship.weaponCooldowns[i] - dt);
  }

  if (isInSafeZone(room, ship.x, ship.y)) {
    ship.combatTargetId = null;
    return; // Cannot fire from spawn
  }

  const target = findTarget(room, ship, ships);
  ship.combatTargetId = target ? target.id : null;

  const scale = 13;
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);

  const fireRateMultiplier = 1 + (ship.stats.fireRateBonus || 0);

  (ship.design || []).forEach((module, i) => {
    const part = PARTS[module.type];
    if (!part?.weapon) return;
    if (!isComponentAlive(ship, i)) return; // destroyed weapons stop firing
    const heatPerformance = componentPerformance(ship, i) * (ship.thermalPowerFactor ?? 1);
    if (heatPerformance <= 0) return;

    const family = part.weapon.type;
    const cooldown = ship.weaponCooldowns[i] || 0;
    if (cooldown > 0) return;

    const arcRadians = (part.weapon.arc || 360) * Math.PI / 180;
    const local = moduleLocalPosition(module);
    const worldX = ship.x + local.x * cos - local.y * sin;
    const worldY = ship.y + local.x * sin + local.y * cos;

    const defaultRelative = moduleRotationToRadians(normalizeRotation(module.rotation));
    let desiredRelative = defaultRelative;
    let isTracking = false;
    let currentPdTarget = null;

    if (family === "pointDefense") {
      currentPdTarget = findPointDefenseTarget(room, worldX, worldY, ship.ownerId, part.weapon, ships);
      if (currentPdTarget) {
        const targetEntity = currentPdTarget.entity;
        const dx = targetEntity.x - worldX;
        const dy = targetEntity.y - worldY;
        const distance = Math.hypot(dx, dy);
        const range = ship.stats[family + "Range"] || part.weapon.range;

        if (distance <= range) {
          const worldAngleToTarget = Math.atan2(dy, dx);
          const relativeAngleToTarget = angleDifference(ship.angle, worldAngleToTarget);
          const diff = angleDifference(defaultRelative, relativeAngleToTarget);
          if (Math.abs(diff) <= arcRadians / 2) {
            desiredRelative = relativeAngleToTarget;
            isTracking = true;
          }
        }
      }
    } else {
      if (target) {
        const dx = target.x - worldX;
        const dy = target.y - worldY;
        const distance = Math.hypot(dx, dy);
        const range = ship.stats[family + "Range"] || part.weapon.range;

        if (distance <= range) {
          const worldAngleToTarget = Math.atan2(dy, dx);
          const relativeAngleToTarget = angleDifference(ship.angle, worldAngleToTarget);
          const diff = angleDifference(defaultRelative, relativeAngleToTarget);
          if (Math.abs(diff) <= arcRadians / 2) {
            desiredRelative = relativeAngleToTarget;
            isTracking = true;
          }
        }
      }
    }

    const turnRate = getWeaponTurnRate(part.weapon);
    const currentRelative = ship.weaponAngles[i] !== undefined ? ship.weaponAngles[i] : defaultRelative;
    ship.weaponAngles[i] = rotateToward(currentRelative, desiredRelative, turnRate * dt);

    if (family === "pointDefense") {
      if (!currentPdTarget || !isTracking) return;
    } else {
      if (!target || !isTracking) return;
    }

    const worldWeaponAngle = ship.angle + ship.weaponAngles[i];
    const targetEntity = family === "pointDefense" ? currentPdTarget.entity : target;
    const worldAngleToTarget = Math.atan2(targetEntity.y - worldY, targetEntity.x - worldX);
    const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));
    if (family !== "beam" && angleErr > 0.26) return;

    const targetingPerformance = systemPerformance(ship, (candidate, placed) => placed.type === "targetingComputer" || placed.type === "sensorArray" || candidate.utilityEffect === "accuracy");
    const accuracy = clampNumber(((part.weapon.accuracy || 0.8) + (ship.stats.accuracyBonus || 0)) * targetingPerformance, 0.1, 1);
    const spreadScale = (1 - accuracy) * (family === "missile" ? 0.35 : 0.22);
    const spread = randomRange(-spreadScale, spreadScale);
    const shotAngle = worldWeaponAngle + spread;

    const muzzle = weaponMuzzleWorldPosition(ship, module, worldWeaponAngle, family);

    if (family === "blaster") {
      const speed = part.weapon.projectileSpeed || 620;
      const rangeVal = ship.stats?.blasterRange || part.weapon.range;
      const life = rangeVal / speed;
      addBullet(room, {
        type: "bolt",
        ownerId: ship.ownerId,
        targetId: target.id,
        x: muzzle.x,
        y: muzzle.y,
        vx: Math.cos(shotAngle) * speed + ship.vx * 0.25,
        vy: Math.sin(shotAngle) * speed + ship.vy * 0.25,
        damage: part.weapon.damage * ship.stats.efficiency,
        shieldDamageMultiplier: part.weapon.shieldDamageMultiplier ?? 1,
        hullDamageMultiplier: part.weapon.hullDamageMultiplier ?? 1,
        life: life,
        bornAt: now
      });
      const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier * heatPerformance);
      ship.weaponCooldowns[i] = Math.max(0.05, reload);
      addComponentHeat(ship, i, Math.max(5, Math.sqrt(part.weapon.damage || 1) * 1.5));
    } else if (family === "missile") {
      const speed = part.weapon.projectileSpeed || 330;
      const rangeVal = ship.stats?.missileRange || part.weapon.range;
      const life = rangeVal / speed;
      addBullet(room, {
        type: "missile",
        subtype: module.type,
        interceptable: true,
        hp: part.weapon.missileHp || 20,
        ownerId: ship.ownerId,
        targetId: target.id,
        x: muzzle.x,
        y: muzzle.y,
        vx: Math.cos(shotAngle) * speed + ship.vx * 0.15,
        vy: Math.sin(shotAngle) * speed + ship.vy * 0.15,
        damage: part.weapon.damage * ship.stats.efficiency,
        shieldDamageMultiplier: part.weapon.shieldDamageMultiplier ?? 1,
        hullDamageMultiplier: part.weapon.hullDamageMultiplier ?? 1,
        tracking: part.weapon.tracking || 0.75,
        trackRemaining: part.weapon.trackTime || 1.4,
        trackingDelay: part.weapon.trackingDelay || 0.25,
        maxSpeed: speed * 1.45,
        life: life,
        bornAt: now,
        age: 0
      });
      const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier * heatPerformance);
      ship.weaponCooldowns[i] = Math.max(0.05, reload);
      addComponentHeat(ship, i, Math.max(5, Math.sqrt(part.weapon.damage || 1) * 1.5));
    } else if (family === "beam") {
      const rangeVal = ship.stats?.beamRange || part.weapon.range;
      const beamRadius = part.weapon.radius || 28;
      const beamEnd = beamImpactPoint(room, muzzle.x, muzzle.y, worldWeaponAngle, rangeVal, beamRadius);
      damageBeamTargets(room, ship, ships, muzzle.x, muzzle.y, beamEnd.x, beamEnd.y, beamRadius, part.weapon.damage * ship.stats.efficiency * dt, now, {
        shieldDamageMultiplier: part.weapon.shieldDamageMultiplier ?? 1,
        hullDamageMultiplier: part.weapon.hullDamageMultiplier ?? 1
      });
      addComponentHeat(ship, i, Math.max(3, Math.sqrt(part.weapon.damage || 1)) * dt);
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
         const speed = part.weapon.projectileSpeed || 1000;
         const life = part.weapon.range / speed;
         const targetEnt = currentPdTarget.entity;
         const shotAngle = Math.atan2(targetEnt.y - muzzle.y, targetEnt.x - muzzle.x) + randomRange(-0.05, 0.05);

         addBullet(room, {
            type: "pdShot",
            subtype: module.type,
            ownerId: ship.ownerId,
            targetId: currentPdTarget.type === "ship" ? targetEnt.id : targetEnt.id,
            x: muzzle.x,
            y: muzzle.y,
            vx: Math.cos(shotAngle) * speed + ship.vx * 0.25,
            vy: Math.sin(shotAngle) * speed + ship.vy * 0.25,
            damage: part.weapon.damage * ship.stats.efficiency * (currentPdTarget.type === "ship" ? (part.weapon.shipDamageMultiplier || 0.1) : 1),
            shieldDamageMultiplier: part.weapon.shieldDamageMultiplier ?? 1,
            hullDamageMultiplier: part.weapon.hullDamageMultiplier ?? 1,
            pdTargetType: currentPdTarget.type,
            pdTargetId: targetEnt.id,
            life: life,
            bornAt: now
         });
         const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier * heatPerformance);
         ship.weaponCooldowns[i] = Math.max(0.05, reload);
         addComponentHeat(ship, i, 4);

         const pdCount = (ship.design || []).filter(m => PARTS[m.type]?.weapon?.type === "pointDefense").length || 1;
         if (pdCount > 1) {
           const stagger = reload / pdCount;
           (ship.design || []).forEach((otherModule, j) => {
             if (i === j) return;
             const otherPart = PARTS[otherModule.type];
             if (otherPart?.weapon?.type === "pointDefense") {
               if (ship.weaponCooldowns[j] < stagger) {
                 ship.weaponCooldowns[j] = stagger;
               }
             }
           });
         }
      }
    } else if (family === "railgun") {
      const speed = part.weapon.projectileSpeed || 1080;
      const rangeVal = ship.stats?.railgunRange || part.weapon.range;
      const life = rangeVal / speed;
      addBullet(room, {
        type: "rail",
        ownerId: ship.ownerId,
        targetId: target.id,
        x: muzzle.x,
        y: muzzle.y,
        vx: Math.cos(shotAngle) * speed + ship.vx * 0.12,
        vy: Math.sin(shotAngle) * speed + ship.vy * 0.12,
        damage: part.weapon.damage * ship.stats.efficiency,
        shieldDamageMultiplier: part.weapon.shieldDamageMultiplier ?? 1,
        hullDamageMultiplier: part.weapon.hullDamageMultiplier ?? 1,
        life: life,
        bornAt: now
      });
      const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier * heatPerformance);
      ship.weaponCooldowns[i] = Math.max(0.05, reload);
      addComponentHeat(ship, i, Math.max(8, Math.sqrt(part.weapon.damage || 1) * 1.8));
    }
  });
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

function weaponFacingAngle(ship, module) {
  return ship.angle + moduleRotationToRadians(normalizeRotation(module.rotation));
}

function weaponModuleWorldPosition(ship, module) {
  const local = moduleLocalPosition(module);
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);
  return {
    x: ship.x + local.x * cos - local.y * sin,
    y: ship.y + local.x * sin + local.y * cos
  };
}

function weaponMuzzleWorldPosition(ship, module, angle, family) {
  const origin = weaponModuleWorldPosition(ship, module);
  const distance = MUZZLE_DISTANCE[family] || 11;
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
      if (hit) {
        hitPoint = hit;
        break;
      }
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
  if (isInSafeZone(room, ship.x, ship.y)) return; // Invincible in spawn

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
      addHeatToType(ship, (part) => part.shield > 0, blockedShieldDamage * 0.12);
      pushDamageEffect(room, ship, now, blockedShieldDamage, true);
    }
  }

  if (hullDamage > 0) {
    // Route hull damage into the component under the impact point (armour on
    // that side first). Only the damage actually absorbed by components is
    // shown as a floating number — armour flat reduction eats the rest.
    const impactX = sourceX !== undefined ? sourceX : ship.x;
    const impactY = sourceY !== undefined ? sourceY : ship.y;
    const applied = applyHullDamage(room, ship, hullDamage, now, impactX, impactY);
    if (applied > 0) pushDamageEffect(room, ship, now, applied, false);
  }

  if (ship.hp > 0.001 && !ship.coreDestroyed) return;
  destroyShip(room, ship, attackerId, now);
}

function destroyShip(room, ship, attackerId, now) {
  ship.alive = false;
  ship.removeAt = now + 3200;
  ship.hp = 0;
  zeroAllComponents(ship);
  ship.shield = 0;
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
  const idSet = Array.isArray(shipIds) && shipIds.length ? new Set(shipIds.map((id) => String(id))) : null;
  let count = 0;
  for (const ship of player.ships) {
    if (!ship.alive || ship.removed || ship.selfDestructAt) continue;
    if (idSet && !idSet.has(ship.id)) continue;
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
  ship.selfDestructAt = 0;
  ship.alive = false;
  ship.hp = 0;
  zeroAllComponents(ship);
  ship.shield = 0;
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
}

function updateDestroyedShips(room, now) {
  for (const player of room.players.values()) {
    let removedAny = false;
    for (const ship of player.ships) {
      if (!ship.alive && !ship.removed && ship.removeAt && now >= ship.removeAt) {
        ship.removed = true;
        room.ships.delete(ship.id);
        removedAny = true;
      }
    }
    if (removedAny) {
      player.ships = player.ships.filter((ship) => !ship.removed);
    }
  }
}

function findTarget(room, ship, ships) {
  let best = null;
  let bestDistance = Infinity;
  const range = Math.max(ship.stats.blasterRange, ship.stats.missileRange, ship.stats.beamRange || 0, 420);

  if (ship.focusTargetId) {
    const focused = ships.find((other) => other.id === ship.focusTargetId && areEnemies(room, ship.ownerId, other.ownerId));
    if (focused) {
      const focusedDistance = Math.hypot(focused.x - ship.x, focused.y - ship.y);
      if (focusedDistance <= Math.max(range, ship.stats.railgunRange, ship.stats.beamRange || 0) * 1.12 && !isLineBlocked(room, ship.x, ship.y, focused.x, focused.y, 8)) return focused;
    }
  }

  for (const other of ships) {
    if (!other.alive || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
    if (distance < bestDistance && distance <= Math.max(range, ship.stats.railgunRange, ship.stats.beamRange || 0) && !isLineBlocked(room, ship.x, ship.y, other.x, other.y, 8)) {
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
  if (!weapon) return 8.0;
  if (Number.isFinite(weapon.aimSpeed)) return weapon.aimSpeed;
  if (Number.isFinite(weapon.turretTurnRate)) return weapon.turretTurnRate;
  
  const family = typeof weapon === "string" ? weapon : (weapon.type || weapon.family);
  if (family === "blaster") return 12.0;
  if (family === "missile") return 8.0;
  if (family === "railgun") return 4.5;
  if (family === "beam") return 1.65;
  return 8.0;
}

module.exports = {
  updateShipSupport,
  updateShipWeapons,
  weaponModulesInArc,
  moduleRotationToRadians,
  moduleLocalPosition,
  isTargetInWeaponArc,
  damageShip,
  updateDestroyedShips,
  requestSelfDestruct,
  updateSelfDestructingShips,
  findTarget,
  isLineBlocked,
  areAllies,
  areEnemies
};
