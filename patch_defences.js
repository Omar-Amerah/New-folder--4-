const fs = require('fs');

// Patch src/server/projectiles.js
let proj = fs.readFileSync('src/server/projectiles.js', 'utf8');

// 1. ECM and Decoy
proj = proj.replace(
  /const canTrack = bullet\.trackRemaining === undefined \|\| bullet\.trackRemaining > 0;/,
  `
      if (bullet.trackingDisabledFor && bullet.trackingDisabledFor > 0) {
        bullet.trackingDisabledFor -= dt;
      }

      const canTrack = (bullet.trackRemaining === undefined || bullet.trackRemaining > 0) && (!bullet.trackingDisabledFor || bullet.trackingDisabledFor <= 0);`
);

proj = proj.replace(
  /const next = rotateToward\(current, desired, \(1\.6 \+ \(bullet\.tracking \|\| 0\.75\) \* 1\.8\) \* dt\);/,
  `
        const ecmMod = Math.max(0, 1 - (target.stats.ecmStrength || 0));
        const next = rotateToward(current, desired, (1.6 + (bullet.tracking || 0.75) * 1.8) * ecmMod * dt);`
);

fs.writeFileSync('src/server/projectiles.js', proj);

// Patch src/server/combat.js
let combat = fs.readFileSync('src/server/combat.js', 'utf8');

// 2. Decoy Update
const decoyHelper = `
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
`;

combat = combat.replace(
  /function updateShipWeapons/,
  decoyHelper + '\nfunction updateShipWeapons'
);

combat = combat.replace(
  /updateShipWeapons\(room, ship, ships, dt, now\);/,
  `updateDecoys(room, ship, dt, now);
    updateShipWeapons(room, ship, ships, dt, now);`
);

// 3. Forward Deflector Update
const deflectorHelper = `
function isDamageFromFront(ship, sourceX, sourceY, frontArcDegrees) {
  const angleToSource = Math.atan2(sourceY - ship.y, sourceX - ship.x);
  const diff = Math.abs(angleDifference(ship.angle, angleToSource));
  return diff <= (frontArcDegrees * Math.PI / 180) / 2;
}
`;

combat = combat.replace(
  /function isTargetInWeaponArc/,
  deflectorHelper + '\nfunction isTargetInWeaponArc'
);

// We need to inject sourceX, sourceY to damageShip.
// Let's modify damageShip signature and all calls.
// damageShip(room, target, damage, ship.ownerId, now) -> damageShip(room, target, damage, ship.ownerId, now, sourceX, sourceY)
combat = combat.replace(
  /function damageShip\(room, ship, damage, attackerId, now\) \{/,
  `function damageShip(room, ship, damage, attackerId, now, sourceX, sourceY) {
  if (ship.stats.frontDamageReduction && sourceX !== undefined && sourceY !== undefined) {
    if (isDamageFromFront(ship, sourceX, sourceY, ship.stats.frontArc)) {
      damage *= (1 - ship.stats.frontDamageReduction);
    }
  }`
);

// update calls to damageShip
combat = combat.replace(
  /damageShip\(room, target, damage, ship\.ownerId, now\);/g,
  `damageShip(room, target, damage, ship.ownerId, now, x1, y1);` // in damageBeamTargets
);

fs.writeFileSync('src/server/combat.js', combat);
