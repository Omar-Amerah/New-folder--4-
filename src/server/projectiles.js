// Projectile creation, velocity updates, tracking missile adjustments, obstacle collisions, and damage delivery.

const { clampNumber, rotateToward } = require("./utils");

function addBullet(room, bullet) {
  bullet.id = `b${room.nextEntityId++}`;
  room.bullets.push(bullet);
}

// Below this shield charge the shield is treated as "down" for hit visuals only:
// bullets flash on the hull instead of the shield bubble. This is purely cosmetic
// (a trickle of shield regen otherwise keeps a depleted shield fractionally above
// zero); damageShip's shield/hull damage split is unaffected.
const SHIELD_HIT_MIN = 10;

// Shield bubble radius used for projectile collision — must match the client's
// rendered shield ring (renderer.js shieldRingRadius) so bullets visually stop
// exactly at the ring the player sees.
function shieldCollisionRadius(ship) {
  const radius = Number(ship?.radius) || 0;
  return Math.max(30, radius + Math.max(8, radius * 0.18));
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
  const { getLiveShips, getShipModuleWorldCoords } = require("./ships");
  const { areEnemies, damageShip } = require("./combat");

  const liveShips = getLiveShips(room);
  const byId = new Map(liveShips.map((ship) => [ship.id, ship]));
  let bulletsById = null;
  const kept = [];

  for (const bullet of room.bullets) {
    bullet.life -= dt;
    if (bullet.life <= 0) {
      if (bullet.type === "missile" || bullet.type === "pdShot") {
        room.effects.push({ type: "despawn", subtype: bullet.subtype, x: bullet.x, y: bullet.y, at: now });
      }
      continue;
    }
    const previousX = bullet.x;
    const previousY = bullet.y;

    if (bullet.type === "missile") {
      bullet.age = (bullet.age || 0) + dt;
      if (bullet.trackingDisabledFor && bullet.trackingDisabledFor > 0) {
        bullet.trackingDisabledFor -= dt;
      }
      const target = byId.get(bullet.targetId);
      const canTrack = (bullet.trackRemaining === undefined || bullet.trackRemaining > 0) && (!bullet.trackingDisabledFor || bullet.trackingDisabledFor <= 0);
      if (target && canTrack && areEnemies(room, bullet.ownerId, target.ownerId)) {
        let desired = Math.atan2(target.y - bullet.y, target.x - bullet.x);
        let turnRate = 0.1; // Weak tracking during arming delay

        if (bullet.age >= (bullet.trackingDelay || 0)) {
          const tracking = clampNumber(bullet.tracking ?? 0.5, 0, 1);
          const baseTurnRate = bullet.baseTurnRate ?? 0.7;
          const trackingTurnRate = bullet.maxTurnRate ?? (0.45 + tracking * tracking * 4.2);
          turnRate = baseTurnRate + trackingTurnRate;

          // Add slight lead prediction only for high-tracking missiles
          const leadStrength = tracking * 0.35;
          const predictedX = target.x + (target.vx || 0) * leadStrength;
          const predictedY = target.y + (target.vy || 0) * leadStrength;
          desired = Math.atan2(predictedY - bullet.y, predictedX - bullet.x);
        }

        const { effectiveComponentBonus } = require("./heat");
        const ecmMod = Math.max(0, 1 - Math.min(0.55, effectiveComponentBonus(target, "ecmStrength")));
        turnRate *= ecmMod;

        const current = Math.atan2(bullet.vy, bullet.vx);
        const next = rotateToward(current, desired, turnRate * dt);
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


    if (bullet.type === "pdShot") {
       if (bullet.pdTargetType === "projectile") {
          if (!bulletsById) {
            bulletsById = new Map();
            for (const other of room.bullets) bulletsById.set(other.id, other);
          }
          const target = bulletsById.get(bullet.pdTargetId);
          if (target && target.interceptable && target.life > 0) {
             const dx = target.x - bullet.x;
             const dy = target.y - bullet.y;
             if (dx * dx + dy * dy <= 400) { // 20 radius
                target.hp -= bullet.damage;
                bullet.life = 0;
                room.effects.push({ type: "spark", x: bullet.x, y: bullet.y, at: now });
                if (target.hp <= 0) {
                   target.life = 0;
                   room.effects.push({ type: "burst", x: target.x, y: target.y, at: now });
                   room.effects.push({ type: "text", text: "INTERCEPTED", x: target.x, y: target.y, at: now });
                }
                continue;
             }
          }
       }
    }

    const rockHit = projectileMapImpact(room, previousX, previousY, bullet);

    let earliest = null;
    const recordHit = (candidate) => {
      if (!candidate) return;
      if (!earliest || candidate.t < earliest.t || (candidate.t === earliest.t && String(candidate.entityId || "").localeCompare(String(earliest.entityId || "")) < 0)) {
        earliest = candidate;
      }
    };

    if (rockHit) {
      recordHit({ kind: "asteroid", t: rockHit.t, x: rockHit.x, y: rockHit.y, entityId: "asteroid" });
    }

    for (const ship of liveShips) {
      if (!areEnemies(room, bullet.ownerId, ship.ownerId)) continue;
      const hitRadius = bullet.type === "missile" ? 14 : bullet.type === "rail" ? 9 : 6;

      // While the shield holds, it presents a clean swept bubble hitbox. The
      // earliest collision across asteroids and all valid enemy ships wins.
      if (ship.shield >= SHIELD_HIT_MIN) {
        const ringR = shieldCollisionRadius(ship) + hitRadius;
        const shieldHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, ship.x, ship.y, ringR);
        if (!shieldHit) continue;
        recordHit({ kind: "ship", t: shieldHit.t, x: shieldHit.x, y: shieldHit.y, ship, entityId: ship.id, shield: true });
        continue;
      }

      const hullHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, ship.x, ship.y, ship.radius + hitRadius);
      if (!hullHit) continue;

      // Shield down: bullets must strike an actual hull module. Test the swept
      // segment against each live module and choose the earliest module impact,
      // with design index as the deterministic tie-breaker.
      const coords = getShipModuleWorldCoords(ship);
      const componentHp = ship.componentHp;
      let moduleHit = null;
      const collisionR = 8.5 + hitRadius;
      for (let i = 0; i < coords.length; i++) {
        if (componentHp && componentHp[i] <= 0) continue;
        const m = coords[i];
        const hit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, m.x, m.y, collisionR);
        if (hit && (!moduleHit || hit.t < moduleHit.t || (hit.t === moduleHit.t && i < moduleHit.index))) {
          moduleHit = { ...hit, index: i };
        }
      }
      if (moduleHit) {
        recordHit({ kind: "ship", t: moduleHit.t, x: moduleHit.x, y: moduleHit.y, ship, entityId: ship.id, shield: false });
      }
    }

    if (earliest?.kind === "asteroid") {
      room.effects.push({ type: "rockhit", x: earliest.x, y: earliest.y, at: now });
      continue;
    }

    if (earliest?.kind === "ship") {
      const ship = earliest.ship;
      damageShip(room, ship, bullet.damage, bullet.ownerId, now, earliest.x, earliest.y, {
        shieldDamageMultiplier: bullet.shieldDamageMultiplier,
        hullDamageMultiplier: bullet.hullDamageMultiplier
      });
      if (earliest.shield) {
        const ang = Math.atan2(earliest.y - ship.y, earliest.x - ship.x);
        const surfaceR = shieldCollisionRadius(ship);
        room.effects.push({
          type: "shieldhit",
          subtype: bullet.type,
          x: ship.x + Math.cos(ang) * surfaceR,
          y: ship.y + Math.sin(ang) * surfaceR,
          nx: Math.cos(ang),
          ny: Math.sin(ang),
          at: now
        });
      } else {
        room.effects.push({ type: (bullet.type === "missile" || bullet.type === "torpedo") ? "burst" : bullet.type === "rail" ? "railhit" : "spark", x: earliest.x, y: earliest.y, at: now });
      }
      continue;
    }

    kept.push(bullet);
  }

  room.bullets = kept;
  room.effects = room.effects.filter((effect) => {
    const life = effect.type === "beam" ? 140 : effect.type === "shieldhit" ? 340 : 900;
    return now - effect.at < life;
  });
}

module.exports = {
  addBullet,
  projectileMapImpact,
  segmentCircleHit,
  updateBullets
};
