// Applies combat targeting, weapon cooldowns, weapon arcs, damage resolution, and support/healing.

const { PARTS } = require("./components");
const { ECONOMY } = require("./config");
const { randomRange, clampNumber, angleDifference } = require("./utils");
const { normalizeRotation } = require("./shipDesign");

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
  const target = findTarget(room, ship, ships);
  ship.blasterCooldown = Math.max(0, ship.blasterCooldown - dt);
  ship.missileCooldown = Math.max(0, ship.missileCooldown - dt);
  ship.railgunCooldown = Math.max(0, ship.railgunCooldown - dt);
  if (!target) return;

  const dx = target.x - ship.x;
  const dy = target.y - ship.y;
  const distance = Math.hypot(dx, dy);
  const aim = Math.atan2(dy, dx);

  const { addBullet } = require("./projectiles");

  const blasterArcCount = weaponModulesInArc(ship, target, "blaster");
  if (blasterArcCount > 0 && distance <= ship.stats.blasterRange && ship.blasterCooldown <= 0) {
    const shots = Math.min(3, blasterArcCount);
    const accuracy = clampNumber(ship.stats.blasterAccuracy || 0.85, 0.1, 1);
    const spreadScale = (1 - accuracy) * 0.26;
    for (let i = 0; i < shots; i += 1) {
      const spread = (i - (shots - 1) / 2) * 0.055 + randomRange(-spreadScale, spreadScale);
      const speed = ship.stats.blasterProjectileSpeed || 620;
      addBullet(room, {
        type: "bolt",
        ownerId: ship.ownerId,
        targetId: target.id,
        x: ship.x + Math.cos(aim) * (ship.radius + 8),
        y: ship.y + Math.sin(aim) * (ship.radius + 8),
        vx: Math.cos(aim + spread) * speed + ship.vx * 0.25,
        vy: Math.sin(aim + spread) * speed + ship.vy * 0.25,
        damage: ship.stats.blasterDamage / Math.max(1, ship.stats.blaster) * ship.stats.efficiency,
        life: 1.25,
        bornAt: now
      });
    }
    ship.blasterCooldown = Math.max(0.16, ship.stats.blasterReload / Math.sqrt(Math.max(1, blasterArcCount)));
  }

  const missileArcCount = weaponModulesInArc(ship, target, "missile");
  if (missileArcCount > 0 && distance <= ship.stats.missileRange && ship.missileCooldown <= 0) {
    const missileAccuracy = clampNumber(ship.stats.missileAccuracy || 0.7, 0.1, 1);
    const spread = randomRange(-(1 - missileAccuracy) * 0.22, (1 - missileAccuracy) * 0.22);
    const speed = ship.stats.missileProjectileSpeed || 330;
    addBullet(room, {
      type: "missile",
      ownerId: ship.ownerId,
      targetId: target.id,
      x: ship.x + Math.cos(aim) * (ship.radius + 12),
      y: ship.y + Math.sin(aim) * (ship.radius + 12),
      vx: Math.cos(aim + spread) * speed + ship.vx * 0.15,
      vy: Math.sin(aim + spread) * speed + ship.vy * 0.15,
      damage: ship.stats.missileDamage / Math.max(1, ship.stats.missile) * ship.stats.efficiency,
      tracking: ship.stats.missileTracking || 0.75,
      maxSpeed: speed * 1.45,
      life: 2.8,
      bornAt: now
    });
    ship.missileCooldown = Math.max(1.2, ship.stats.missileReload / Math.sqrt(Math.max(1, missileArcCount)));
  }

  const railgunArcCount = weaponModulesInArc(ship, target, "railgun");
  if (railgunArcCount > 0 && distance <= ship.stats.railgunRange && ship.railgunCooldown <= 0) {
    const accuracy = clampNumber(ship.stats.railgunAccuracy || 0.95, 0.1, 1);
    const spread = randomRange(-(1 - accuracy) * 0.11, (1 - accuracy) * 0.11);
    const speed = ship.stats.railgunProjectileSpeed || 1080;
    addBullet(room, {
      type: "rail",
      ownerId: ship.ownerId,
      targetId: target.id,
      x: ship.x + Math.cos(aim) * (ship.radius + 15),
      y: ship.y + Math.sin(aim) * (ship.radius + 15),
      vx: Math.cos(aim + spread) * speed + ship.vx * 0.12,
      vy: Math.sin(aim + spread) * speed + ship.vy * 0.12,
      damage: ship.stats.railgunDamage * ship.stats.efficiency,
      life: 1.15,
      bornAt: now
    });
    ship.railgunCooldown = Math.max(1.65, ship.stats.railgunReload / Math.sqrt(Math.max(1, railgunArcCount)));
  }
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

function isTargetInWeaponArc(ship, module, target, arcRadians) {
  if (arcRadians >= Math.PI * 2) return true;
  const weaponFacing = ship.angle + moduleRotationToRadians(normalizeRotation(module.rotation));
  const angleToTarget = Math.atan2(target.y - ship.y, target.x - ship.x);
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
  const range = Math.max(ship.stats.blasterRange, ship.stats.missileRange, 420);

  if (ship.focusTargetId) {
    const focused = ships.find((other) => other.id === ship.focusTargetId && areEnemies(room, ship.ownerId, other.ownerId));
    if (focused) {
      const focusedDistance = Math.hypot(focused.x - ship.x, focused.y - ship.y);
      if (focusedDistance <= Math.max(range, ship.stats.railgunRange) * 1.12 && !isLineBlocked(room, ship.x, ship.y, focused.x, focused.y, 8)) return focused;
    }
  }

  for (const other of ships) {
    if (!other.alive || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const distance = Math.hypot(other.x - ship.x, other.y - ship.y);
    if (distance < bestDistance && distance <= Math.max(range, ship.stats.railgunRange) && !isLineBlocked(room, ship.x, ship.y, other.x, other.y, 8)) {
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

module.exports = {
  updateShipSupport,
  updateShipWeapons,
  weaponModulesInArc,
  moduleRotationToRadians,
  isTargetInWeaponArc,
  damageShip,
  updateDestroyedShips,
  findTarget,
  isLineBlocked,
  areAllies,
  areEnemies
};
