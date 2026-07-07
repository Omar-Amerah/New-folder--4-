const fs = require('fs');
let content = fs.readFileSync('src/server/combat.js', 'utf8');

const pdHelpers = `
function findPointDefenseTarget(room, ship, weapon, ships) {
  let best = null;
  let bestScore = -Infinity;
  const rangeSq = weapon.range * weapon.range;

  for (const bullet of room.bullets) {
    if (!bullet.interceptable || bullet.life <= 0 || !areEnemies(room, ship.ownerId, bullet.ownerId)) continue;

    const dx = bullet.x - ship.x;
    const dy = bullet.y - ship.y;
    const distSq = dx * dx + dy * dy;

    if (distSq <= rangeSq && !isLineBlocked(room, ship.x, ship.y, bullet.x, bullet.y, 4)) {
      let score = -distSq;
      if (bullet.targetId === ship.id) score += 10000000;
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
    if (!other.alive || !areEnemies(room, ship.ownerId, other.ownerId)) continue;
    const dx = other.x - ship.x;
    const dy = other.y - ship.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= weapon.range && dist < bestShipDist && !isLineBlocked(room, ship.x, ship.y, other.x, other.y, 8)) {
      bestShip = other;
      bestShipDist = dist;
    }
  }

  if (bestShip) return { type: 'ship', entity: bestShip };
  return null;
}
`;

content = content.replace(
  /function updateShipWeapons/,
  pdHelpers + '\nfunction updateShipWeapons'
);

content = content.replace(
  /\} else if \(family === "railgun"\) \{/,
  `} else if (family === "pointDefense") {
      const pdTarget = findPointDefenseTarget(room, ship, part.weapon, ships);
      if (pdTarget) {
         const speed = part.weapon.projectileSpeed || 1000;
         const life = part.weapon.range / speed;
         const target = pdTarget.entity;
         const shotAngle = Math.atan2(target.y - muzzle.y, target.x - muzzle.x) + randomRange(-0.05, 0.05);

         addBullet(room, {
            type: "pdShot",
            ownerId: ship.ownerId,
            targetId: pdTarget.type === "ship" ? target.id : target.id,
            x: muzzle.x,
            y: muzzle.y,
            vx: Math.cos(shotAngle) * speed + ship.vx * 0.25,
            vy: Math.sin(shotAngle) * speed + ship.vy * 0.25,
            damage: part.weapon.damage * ship.stats.efficiency * (pdTarget.type === "ship" ? (part.weapon.shipDamageMultiplier || 0.1) : 1),
            pdTargetType: pdTarget.type,
            pdTargetId: target.id,
            life: life,
            bornAt: now
         });
         const reload = (1 / part.weapon.fireRate) / Math.max(0.1, fireRateMultiplier);
         ship.weaponCooldowns[i] = Math.max(0.05, reload);
      }
    } else if (family === "railgun") {`
);

// We need to inject missileHP and interceptable logic in updateShipWeapons when it shoots missiles
content = content.replace(
  /type: "missile",\n\s+ownerId: ship\.ownerId,/,
  `type: "missile",
        interceptable: true,
        hp: part.weapon.missileHp || 20,
        ownerId: ship.ownerId,`
);

fs.writeFileSync('src/server/combat.js', content);
