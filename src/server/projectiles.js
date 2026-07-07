// Projectile creation, velocity updates, tracking missile adjustments, obstacle collisions, and damage delivery.

const { clampNumber, rotateToward } = require("./utils");

function addBullet(room, bullet) {
  bullet.id = `b${room.nextEntityId++}`;
  room.bullets.push(bullet);
}

function projectileMapImpact(room, x1, y1, bullet) {
  const margin = bullet.type === "missile" ? 8 : bullet.type === "rail" ? 3 : 5;
  let hit = null;
  for (const asteroid of room.map?.asteroids || []) {
    const impact = segmentCircleHit(x1, y1, bullet.x, bullet.y, asteroid.x, asteroid.y, asteroid.radius + margin);
    if (!impact) continue;
    if (!hit || impact.t < hit.t) hit = impact;
  }
  return hit;
}

function segmentCircleHit(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq <= 0.0001) {
    return Math.hypot(x1 - cx, y1 - cy) <= radius ? { x: x1, y: y1, t: 0 } : null;
  }

  const t = clampNumber(((cx - x1) * dx + (cy - y1) * dy) / lengthSq, 0, 1);
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  if (Math.hypot(px - cx, py - cy) > radius) return null;
  return { x: px, y: py, t };
}

function updateBullets(room, dt, now) {
  const { getLiveShips } = require("./ships");
  const { areEnemies, damageShip } = require("./combat");

  const liveShips = getLiveShips(room);
  const byId = new Map(liveShips.map((ship) => [ship.id, ship]));
  const kept = [];

  for (const bullet of room.bullets) {
    bullet.life -= dt;
    if (bullet.life <= 0) continue;
    const previousX = bullet.x;
    const previousY = bullet.y;

    if (bullet.type === "missile") {
      const target = byId.get(bullet.targetId);
      const canTrack = bullet.trackRemaining === undefined || bullet.trackRemaining > 0;
      if (target && canTrack && areEnemies(room, bullet.ownerId, target.ownerId)) {
        const desired = Math.atan2(target.y - bullet.y, target.x - bullet.x);
        const current = Math.atan2(bullet.vy, bullet.vx);
        const next = rotateToward(current, desired, (1.6 + (bullet.tracking || 0.75) * 1.8) * dt);
        const speed = Math.min(bullet.maxSpeed || 460, Math.hypot(bullet.vx, bullet.vy) + 95 * dt);
        bullet.vx = Math.cos(next) * speed;
        bullet.vy = Math.sin(next) * speed;
      }
      if (bullet.trackRemaining !== undefined) bullet.trackRemaining = Math.max(0, bullet.trackRemaining - dt);
    }

    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;

    if (bullet.x < -80 || bullet.x > room.world.width + 80 || bullet.y < -80 || bullet.y > room.world.height + 80) {
      continue;
    }

    const rockHit = projectileMapImpact(room, previousX, previousY, bullet);
    if (rockHit) {
      room.effects.push({ type: "rockhit", x: rockHit.x, y: rockHit.y, at: now });
      continue;
    }

    let hit = false;
    for (const ship of liveShips) {
      if (!areEnemies(room, bullet.ownerId, ship.ownerId)) continue;
      const hitRadius = bullet.type === "missile" ? 14 : bullet.type === "rail" ? 9 : 6;
      const dx = ship.x - bullet.x;
      const dy = ship.y - bullet.y;
      const r = ship.radius + hitRadius;
      if (dx * dx + dy * dy <= r * r) {
        damageShip(room, ship, bullet.damage, bullet.ownerId, now);
        room.effects.push({ type: bullet.type === "missile" ? "burst" : bullet.type === "rail" ? "railhit" : "spark", x: bullet.x, y: bullet.y, at: now });
        hit = true;
        break;
      }
    }

    if (!hit) kept.push(bullet);
  }

  room.bullets = kept;
  room.effects = room.effects.filter((effect) => now - effect.at < (effect.type === "beam" ? 140 : 900));
}

module.exports = {
  addBullet,
  projectileMapImpact,
  segmentCircleHit,
  updateBullets
};
