// Applies combat targeting, weapon cooldowns, weapon arcs, damage resolution, and support/healing.

const { PARTS } = require("./components");
const { ECONOMY } = require("./config");
const { randomRange, clampNumber, angleDifference, rotateToward } = require("./utils");
const { normalizeRotation } = require("./shipDesign");

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
    const heal = ship.stats.repairRate * ship.stats.efficiency * dt;
    target.hp = Math.min(target.maxHp, target.hp + heal);

    if (now - ship.repairPulseAt > 420) {
      ship.repairPulseAt = now;
      room.effects.push({ type: "repair", x: target.x, y: target.y, at: now, ownerId: ship.ownerId });
    }
  }
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

  const target = findTarget(room, ship, ships);
  ship.combatTargetId = target ? target.id : null;

  const { addBullet } = require("./projectiles");
  const scale = 13;
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);

  const fireRateMultiplier = 1 + (ship.stats.fireRateBonus || 0) + (ship.stats.coolingBonus || 0);

  (ship.design || []).forEach((module, i) => {
    const part = PARTS[module.type];
    if (!part?.weapon) return;

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

    const turnRate = getWeaponTurnRate(family);
    const currentRelative = ship.weaponAngles[i] !== undefined ? ship.weaponAngles[i] : defaultRelative;
    ship.weaponAngles[i] = rotateToward(currentRelative, desiredRelative, turnRate * dt);

    if (!target || !isTracking) return;

    const worldWeaponAngle = ship.angle + ship.weaponAngles[i];
    const worldAngleToTarget = Math.atan2(target.y - worldY, target.x - worldX);
    const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));
    if (family !== "beam" && angleErr > 0.26) return;

    const accuracy = clampNumber((part.weapon.accuracy || 0.8) + (ship.stats.accuracyBonus || 0), 0.1, 1);
    const spreadScale = (1 - accuracy) * 0.22;
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
        life: life,
        bornAt: now
      });
      const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier);
      ship.weaponCooldowns[i] = Math.max(0.05, reload);
    } else if (family === "missile") {
      const speed = part.weapon.projectileSpeed || 330;
      const rangeVal = ship.stats?.missileRange || part.weapon.range;
      const life = rangeVal / speed;
      addBullet(room, {
        type: "missile",
        ownerId: ship.ownerId,
        targetId: target.id,
        x: muzzle.x,
        y: muzzle.y,
        vx: Math.cos(shotAngle) * speed + ship.vx * 0.15,
        vy: Math.sin(shotAngle) * speed + ship.vy * 0.15,
        damage: part.weapon.damage * ship.stats.efficiency,
        tracking: part.weapon.tracking || 0.75,
        trackRemaining: part.weapon.trackTime || 1.4,
        maxSpeed: speed * 1.45,
        life: life,
        bornAt: now
      });
      const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier);
      ship.weaponCooldowns[i] = Math.max(0.05, reload);
    } else if (family === "beam") {
      const rangeVal = ship.stats?.beamRange || part.weapon.range;
      const beamRadius = part.weapon.radius || 28;
      const beamEnd = beamImpactPoint(room, muzzle.x, muzzle.y, worldWeaponAngle, rangeVal, beamRadius);
      damageBeamTargets(room, ship, ships, muzzle.x, muzzle.y, beamEnd.x, beamEnd.y, beamRadius, part.weapon.damage * ship.stats.efficiency * dt, now);
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
        life: life,
        bornAt: now
      });
      const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier);
      ship.weaponCooldowns[i] = Math.max(0.05, reload);
    }
  });
}

function weaponModulesInArc(ship, target, family) {
  let count = 0;
  for (const module of ship.design || []) {
    const part = PARTS[module.type];
    if (!part?.weapon || part.weapon.type !== family) continue;
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
  return {
    x: (3 - module.y) * scale,
    y: (module.x - 3) * scale
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
  const { segmentCircleHit } = require("./projectiles");
  let end = { x: maxX, y: maxY, t: 1 };

  for (const asteroid of room.map?.asteroids || []) {
    const hit = segmentCircleHit(x, y, maxX, maxY, asteroid.x, asteroid.y, asteroid.radius + beamRadius);
    if (hit && hit.t < end.t) end = { x: hit.x, y: hit.y, t: hit.t };
  }

  return end;
}

function damageBeamTargets(room, ship, ships, x1, y1, x2, y2, beamRadius, damage, now) {
  const { segmentCircleHit } = require("./projectiles");
  for (const target of ships) {
    if (!target.alive || !areEnemies(room, ship.ownerId, target.ownerId)) continue;
    const hit = segmentCircleHit(x1, y1, x2, y2, target.x, target.y, target.radius + beamRadius);
    if (!hit) continue;
    damageShip(room, target, damage, ship.ownerId, now);
  }
}

function isTargetInWeaponArc(ship, module, target, arcRadians) {
  if (arcRadians >= Math.PI * 2) return true;
  const origin = weaponModuleWorldPosition(ship, module);
  const weaponFacing = weaponFacingAngle(ship, module);
  const angleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
  return Math.abs(angleDifference(weaponFacing, angleToTarget)) <= arcRadians / 2;
}

function damageShip(room, ship, damage, attackerId, now) {
  ship.lastDamagedBy = attackerId;

  if (ship.shield > 0) {
    const blocked = Math.min(ship.shield, damage);
    ship.shield -= blocked;
    damage -= blocked * 0.72;
  }

  ship.hp -= damage;
  if (ship.hp > 0) return;

  ship.alive = false;
  ship.removeAt = now + 3200;
  ship.hp = 0;
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

function updateDestroyedShips(room, now) {
  for (const player of room.players.values()) {
    for (const ship of player.ships) {
      if (!ship.alive && !ship.removed && ship.removeAt && now >= ship.removeAt) {
        ship.removed = true;
        room.ships.delete(ship.id);
      }
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
  const { segmentCircleHit } = require("./projectiles");
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

function getWeaponTurnRate(family) {
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
  findTarget,
  isLineBlocked,
  areAllies,
  areEnemies
};
