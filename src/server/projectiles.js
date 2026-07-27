// Projectile creation, velocity updates, tracking missile adjustments, obstacle collisions, and damage delivery.

const { clampNumber, rotateToward, fastHypot } = require("./utils");
const { getShipCollisionGeometry, COMPONENT_CELL_COLLISION_RADIUS } = require("./componentGeometry");
const { getLiveShips } = require("./ships");
const { buildRoomSpatialIndex } = require("./spatialIndex");
const { BALANCE } = require("./balanceConfig");
const PROJECTILES = BALANCE.projectiles;
const MISSILE_GUIDANCE = BALANCE.missileGuidance;
const MAXIMUM_DRONE_SPEED = Math.max(
  0,
  ...Object.values(BALANCE.drones?.types || {}).map((entry) => Number(entry?.speed) || 0)
);

function ensureProjectileLookup(room) {
  if (!room.projectileById) {
    room.projectileById = new Map();
  }
  if (!room._projectileLookupInitialized) {
    room.projectileById.clear();
    for (const projectile of room.bullets || []) {
      if (projectile?.id && projectile.life > 0) room.projectileById.set(projectile.id, projectile);
    }
    room._projectileLookupInitialized = true;
  }
  return room.projectileById;
}

function rebuildProjectileLookup(room) {
  const lookup = room.projectileById || new Map();
  lookup.clear();
  for (const projectile of room.bullets || []) if (projectile?.id) lookup.set(projectile.id, projectile);
  room.projectileById = lookup;
  room._projectileLookupInitialized = true;
  return lookup;
}

function resetProjectileRuntime(room) {
  if (Array.isArray(room.bullets)) room.bullets.length = 0;
  else room.bullets = [];
  room._projectileSpare?.splice?.(0);
  room._projectileLiveShipScratch?.splice?.(0);
  room._effectSpare?.splice?.(0);
  if (room.projectileById instanceof Map) room.projectileById.clear();
  else room.projectileById = new Map();
  room._projectileLookupInitialized = true;
}

function removeProjectilesByOwner(room, ownerId) {
  const source = room.bullets || [];
  const kept = room._projectileSpare && room._projectileSpare !== source ? room._projectileSpare : [];
  kept.length = 0;
  const lookup = ensureProjectileLookup(room);
  for (const projectile of source) {
    if (projectile.ownerId === ownerId) {
      if (projectile.id) lookup.delete(projectile.id);
      room.spatialIndex?.remove?.("projectiles", projectile);
      room.spatialIndex?.remove?.("interceptableProjectiles", projectile);
    } else {
      kept.push(projectile);
    }
  }
  source.length = 0;
  room.bullets = kept;
  room._projectileSpare = source;
}

function addBullet(room, bullet) {
  bullet.id = `b${room.nextEntityId++}`;
  room.bullets.push(bullet);
  ensureProjectileLookup(room).set(bullet.id, bullet);
  const spatialIndex = room.spatialIndex;
  if (spatialIndex?.dynamicValid && typeof spatialIndex.append === "function" && bullet.life > 0) {
    spatialIndex.append("projectiles", bullet, 0);
    if (bullet.interceptable) spatialIndex.append("interceptableProjectiles", bullet, 0);
    const vx = Number(bullet.vx);
    const vy = Number(bullet.vy);
    const speed = fastHypot(Number.isFinite(vx) ? vx : 0, Number.isFinite(vy) ? vy : 0);
    if (speed > spatialIndex.maxProjectileSpeed) spatialIndex.maxProjectileSpeed = speed;
  }
}

function discardBullet(room, lookup, bullet) {
  if (bullet?.id) lookup.delete(bullet.id);
  room.spatialIndex?.remove?.("projectiles", bullet);
  if (bullet?.interceptable) room.spatialIndex?.remove?.("interceptableProjectiles", bullet);
}

function removeProjectileRuntime(room, projectile) {
  if (!room || !projectile) return false;
  projectile.life = 0;
  discardBullet(room, ensureProjectileLookup(room), projectile);
  return true;
}

function assertProjectileLookupConsistency(room) {
  const lookup = ensureProjectileLookup(room);
  const live = new Map();
  for (const projectile of room.bullets || []) {
    if (projectile?.id && projectile.life > 0) live.set(projectile.id, projectile);
  }
  if (lookup.size !== live.size) {
    throw new Error(`projectileById size mismatch: lookup=${lookup.size}, live=${live.size}`);
  }
  for (const [id, projectile] of live) {
    if (lookup.get(id) !== projectile) throw new Error(`projectileById stale or missing record: ${id}`);
  }
  return true;
}

// Below this shield charge the shield is treated as "down" for hit visuals only:
// bullets flash on the hull instead of the shield bubble. This is purely cosmetic
// (a trickle of shield regen otherwise keeps a depleted shield fractionally above
// zero); damageShip's shield/hull damage split is unaffected.
const SHIELD_HIT_MIN = PROJECTILES.shieldHitMinimum;

// Shield bubble radius used for projectile collision — must match the client's
// rendered shield ring (renderer.js shieldRingRadius) so bullets visually stop
// exactly at the ring the player sees.
function shieldCollisionRadius(ship) {
  return getShipCollisionGeometry(ship).shieldRadius;
}

function projectileMapImpact(room, x1, y1, bullet, spatialIndex = room.spatialIndex, scratch = []) {
  const margin = bullet.type === "missile" ? PROJECTILES.mapImpactMargins.missile : bullet.type === "rail" ? PROJECTILES.mapImpactMargins.rail : PROJECTILES.mapImpactMargins.default;
  let hit = null;
  const asteroids = spatialIndex
    ? spatialIndex.querySweptAabbUnordered("asteroids", x1, y1, bullet.x, bullet.y, margin, scratch)
    : (room.map?.asteroids || []);
  for (const asteroid of asteroids) {
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
    const ox = x1 - cx;
    const oy = y1 - cy;
    return ox * ox + oy * oy <= radius * radius ? { x: x1, y: y1, t: 0 } : null;
  }

  const t = clampNumber(((cx - x1) * dx + (cy - y1) * dy) / lengthSq, 0, 1);
  const px = x1 + dx * t;
  const py = y1 + dy * t;
  const ox = px - cx;
  const oy = py - cy;
  if (ox * ox + oy * oy > radius * radius) return null;
  return { x: px, y: py, t };
}

function missileEcmModifier(room, target, cache) {
  if (room.drones?.get?.(target.id) === target) return 1;
  let mod = cache.get(target.id);
  if (mod === undefined) {
    const { effectiveComponentBonus } = require("./heat");
    const ecm = Math.max(0, 1 - Math.min(MISSILE_GUIDANCE.ecmCap, effectiveComponentBonus(target, "ecmStrength")));
    const { getCommandAuraMultiplier } = require("./commandAuras");
    const resistance = getCommandAuraMultiplier(target, "missileTrackingResistanceMultiplier");
    mod = Math.max(0, ecm / resistance);
    cache.set(target.id, mod);
  }
  return mod;
}

function updateBullets(room, dt, now) {
  const { areEnemies, damageShip } = require("./combat");
  const { recordFlakMetrics } = require("./performanceTelemetry");

  const liveShips = getLiveShips(
    room,
    room._projectileLiveShipScratch || (room._projectileLiveShipScratch = [])
  );
  const spatialIndex = room.disableSpatialIndex
    ? null
    : (room.spatialIndex?.dynamicValid
      ? room.spatialIndex
      : buildRoomSpatialIndex(room, liveShips, now));
  const bulletsById = ensureProjectileLookup(room);
  const sourceBullets = room.bullets || [];
  const kept = room._projectileSpare && room._projectileSpare !== sourceBullets ? room._projectileSpare : [];
  kept.length = 0;
  const scratch = room._projectileSpatialScratch || (room._projectileSpatialScratch = {
    asteroids: [], ships: [], drones: [], interceptableProjectiles: []
  });
  const asteroidCandidates = scratch.asteroids;
  const shipCandidates = scratch.ships;
  const droneCandidates = scratch.drones;
  const nominalDroneMovementPadding = MAXIMUM_DRONE_SPEED * Math.max(0, Number(dt) || 0) * 1.75 + 2;
  const measuredDroneMovementPadding = Number(room.droneSpatialPadding);
  const droneMovementPadding = Math.max(
    nominalDroneMovementPadding,
    Number.isFinite(measuredDroneMovementPadding) ? Math.max(0, measuredDroneMovementPadding) : 0
  );
  let interceptedPreviouslyKept = false;

  // Most projectile ticks contain no actively tracking missiles. Allocate the
  // per-target ECM cache only when guidance actually needs it.
  let ecmModCache = null;
  const flakMetrics = { active: 0, proximityCandidates: 0, detonations: 0, explosionEntities: 0, droneHits: 0, missileHits: 0, processingNs: 0n };
  const flakStart = process.hrtime.bigint();

  function flakRadiusFor(entity, kind) {
    if (kind === "ship") {
      return (entity && entity.shield >= SHIELD_HIT_MIN) ? shieldCollisionRadius(entity) : (entity?.radius || 0);
    }
    if (kind === "drone") return Number(entity.radius) || 10;
    return Number(entity.radius) || ((entity.type === "missile" || entity.type === "torpedo") ? PROJECTILES.hitRadius.missile : (entity.type === "rail" ? PROJECTILES.hitRadius.rail : PROJECTILES.hitRadius.default));
  }

  function findFlakEvent(bullet, previousX, previousY, spatial, scratch) {
    const events = [];
    const fuseR = Math.max(0, Number(bullet.proximityFuseRadius) || 0);
    function pushEvent(entity, kind, direct) {
      if (entity === bullet) return;
      if (!entity || (kind === "ship" && (!entity.alive || entity.destroyed))) return;
      if (kind === "drone" && (entity.destroyed || entity.removed || room.drones?.get?.(entity.id) !== entity)) return;
      if (kind === "projectile" && (entity.life <= 0 || !entity.interceptable)) return;
      if (kind !== "asteroid" && !areEnemies(room, bullet.ownerId, entity.ownerId)) return;
      const radius = flakRadiusFor(entity, kind);
      const hitR = direct ? radius : radius + fuseR;
      const hit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, entity.x, entity.y, hitR);
      if (!hit) return;
      events.push({ t: hit.t, x: hit.x, y: hit.y, kind, entity, direct });
    }
    const asteroid = projectileMapImpact(room, previousX, previousY, bullet, spatial, scratch.asteroids);
    if (asteroid) events.push({ t: asteroid.t, x: asteroid.x, y: asteroid.y, kind: "asteroid", entity: null, direct: true });
    const pList = spatial
      ? spatial.querySweptAabbUnordered("interceptableProjectiles", previousX, previousY, bullet.x, bullet.y, fuseR, scratch.interceptableProjectiles)
      : (room.bullets || []).filter((p) => p.interceptable && p.life > 0);
    for (const p of pList) pushEvent(p, "projectile", true);
    for (const p of pList) pushEvent(p, "projectile", false);
    const dList = spatial
      ? spatial.querySweptAabbUnordered("drones", previousX, previousY, bullet.x, bullet.y, fuseR, scratch.drones)
      : (room.drones?.values?.() || []);
    for (const d of dList) pushEvent(d, "drone", true);
    for (const d of dList) pushEvent(d, "drone", false);
    const sList = spatial
      ? spatial.querySweptAabbUnordered("ships", previousX, previousY, bullet.x, bullet.y, fuseR, scratch.ships)
      : liveShips;
    for (const s of sList) pushEvent(s, "ship", true);
    for (const s of sList) pushEvent(s, "ship", false);
    events.push({ t: 1, x: bullet.x, y: bullet.y, kind: null, entity: null, direct: false });
    events.sort((a, b) => {
      if (a.t !== b.t) return a.t - b.t;
      if (a.direct !== b.direct) return a.direct ? -1 : 1;
      const idA = String(a.entity?.id || a.kind || "");
      const idB = String(b.entity?.id || b.kind || "");
      return idA.localeCompare(idB);
    });
    const best = events[0];
    const candidates = events.reduce((sum, e) => sum + (!e.direct && e.kind && e.t < 1 ? 1 : 0), 0);
    return { ...best, candidates };
  }

  function detonateFlakShell(bullet, detonateX, detonateY, triggerKind, triggerEntity, now, isDirect = false) {
    const blastR = Math.max(0, Number(bullet.blastRadius) || 0);
    if (blastR <= 0) return;
    room.effects.push({ type: "flakburst", x: detonateX, y: detonateY, at: now, radius: blastR });
    flakMetrics.detonations += 1;
    const blastDamage = Number(bullet.blastDamage) || 0;
    const innerR = Math.max(0, Number(bullet.innerFullDamageRadius) || 0);
    const exp = Math.max(0.1, Number(bullet.falloffExponent) || 1);
    const maxTargets = Number(bullet.maximumExplosionTargets) || 0;
    let processed = 0;

    function damageFor(edgeDistance) {
      if (edgeDistance >= blastR) return 0;
      if (edgeDistance <= innerR) return blastDamage;
      const ratio = (edgeDistance - innerR) / (blastR - innerR);
      return blastDamage * Math.max(0, 1 - Math.pow(ratio, exp));
    }

    function damageEntity(entity, kind) {
      if (entity === bullet) return;
      if (!entity || !areEnemies(room, bullet.ownerId, entity.ownerId)) return;
      if (kind === "ship" && (!entity.alive || entity.destroyed)) return;
      if (kind === "drone" && (entity.destroyed || entity.removed || room.drones?.get?.(entity.id) !== entity)) return;
      if (kind === "projectile" && (entity.life <= 0 || !entity.interceptable)) return;
      const radius = flakRadiusFor(entity, kind);
      const dx = entity.x - detonateX;
      const dy = entity.y - detonateY;
      const edge = Math.max(0, fastHypot(dx, dy) - radius);
      if (edge > blastR) return;
      processed += 1;
      if (maxTargets > 0 && processed > maxTargets) return;
      const damage = damageFor(edge);
      if (damage <= 0.001) return;

      if (kind === "ship") {
        damageShip(room, entity, damage, bullet.ownerId, now, detonateX, detonateY, {
          shieldDamageMultiplier: bullet.shieldDamageMultiplier,
          hullDamageMultiplier: bullet.hullDamageMultiplier,
          armorInteractionSeconds: bullet.armorInteractionSeconds
        });
      } else if (kind === "drone") {
        require("./drones").damageDrone(room, entity, damage, bullet.ownerId, now);
        flakMetrics.droneHits += 1;
      } else if (kind === "projectile") {
        const hp = entity.hp !== undefined ? entity.hp : (entity.damage || 20);
        entity.hp = hp - damage;
        if (entity.hp <= 0.001) {
          removeProjectileRuntime(room, entity);
          room.effects.push({ type: "spark", x: entity.x, y: entity.y, at: now });
        }
        flakMetrics.missileHits += 1;
      }
    }

    const spatial = room.disableSpatialIndex ? null : (room.spatialIndex?.dynamicValid ? room.spatialIndex : null);
    const exScratch = room._flakExplosionScratch || (room._flakExplosionScratch = { interceptableProjectiles: [], drones: [], ships: [] });
    if (spatial) {
      for (const kind of ["interceptableProjectiles", "drones", "ships"]) {
        const out = exScratch[kind] || (exScratch[kind] = []);
        const candidates = spatial.queryRangeUnordered(kind, detonateX, detonateY, blastR, out);
        const normalized = kind === "interceptableProjectiles" ? "projectile" : kind;
        for (const candidate of candidates) damageEntity(candidate, normalized);
      }
    } else {
      for (const p of room.bullets || []) damageEntity(p, "projectile");
      for (const d of room.drones?.values?.() || []) damageEntity(d, "drone");
      for (const s of room.ships?.values?.() || []) damageEntity(s, "ship");
    }
    flakMetrics.explosionEntities += processed;
  }

  for (const bullet of sourceBullets) {
    if (!Number.isFinite(bullet.x) || !Number.isFinite(bullet.y)
      || !Number.isFinite(bullet.vx) || !Number.isFinite(bullet.vy)
      || !Number.isFinite(bullet.life) || !Number.isFinite(bullet.damage || 0)) {
      discardBullet(room, bulletsById, bullet);
      continue;
    }
    bullet.life -= dt;
    let flakExpired = false;
    if (bullet.life <= 0) {
      if (bullet.type === "missile" || bullet.type === "pdShot") {
        room.effects.push({ type: "despawn", subtype: bullet.subtype, x: bullet.x, y: bullet.y, at: now });
      }
      if (bullet.type === "flak") {
        flakExpired = true;
      } else {
        discardBullet(room, bulletsById, bullet);
        continue;
      }
    }
    const previousX = bullet.x;
    const previousY = bullet.y;

    if (bullet.type === "missile") {
      bullet.age = (bullet.age || 0) + dt;
      if (bullet.trackingDisabledFor && bullet.trackingDisabledFor > 0) {
        bullet.trackingDisabledFor -= dt;
      }
      const target = room.ships.get(bullet.targetId) || room.drones?.get?.(bullet.targetId) || room.decoys?.get?.(bullet.targetId);
      const canTrack = (Number(bullet.tracking) || 0) > 0
        && (bullet.trackRemaining === undefined || bullet.trackRemaining > 0)
        && (!bullet.trackingDisabledFor || bullet.trackingDisabledFor <= 0);
      if (target && canTrack && areEnemies(room, bullet.ownerId, target.ownerId)) {
        const { componentAimWorldPosition, selectComponentAimIndex } = require("./combat");
        if (bullet.targetComponentIndex === undefined) bullet.targetComponentIndex = -1;
        if (bullet.targetComponentIndex >= 0 && (!target.componentHp || target.componentHp[bullet.targetComponentIndex] <= 0)) {
          bullet.targetComponentIndex = selectComponentAimIndex(room, target, bullet.targetComponentIndex);
        }
        const targetPoint = bullet.targetComponentIndex >= 0 ? componentAimWorldPosition(target, bullet.targetComponentIndex) : null;
        const targetX = targetPoint ? targetPoint.x : target.x;
        const targetY = targetPoint ? targetPoint.y : target.y;
        let desired = Math.atan2(targetY - bullet.y, targetX - bullet.x);
        let turnRate = MISSILE_GUIDANCE.armingTurnRate; // Weak tracking during arming delay

        if (bullet.age >= (bullet.trackingDelay || 0)) {
          const tracking = clampNumber(bullet.tracking ?? MISSILE_GUIDANCE.defaultTracking, 0, 1);
          const baseTurnRate = bullet.baseTurnRate ?? MISSILE_GUIDANCE.baseTurnRate;
          const trackingTurnRate = bullet.maxTurnRate ?? (MISSILE_GUIDANCE.turnRateBase + tracking * tracking * MISSILE_GUIDANCE.turnRateTrackingSquaredMultiplier);
          turnRate = baseTurnRate + trackingTurnRate;

          // Add slight lead prediction only for high-tracking missiles
          const leadStrength = tracking * MISSILE_GUIDANCE.leadStrengthMultiplier;
          const predictedX = targetX + (target.vx || 0) * leadStrength;
          const predictedY = targetY + (target.vy || 0) * leadStrength;
          desired = Math.atan2(predictedY - bullet.y, predictedX - bullet.x);
        }

        turnRate *= missileEcmModifier(room, target, ecmModCache || (ecmModCache = new Map()));

        const current = Math.atan2(bullet.vy, bullet.vx);
        const next = rotateToward(current, desired, turnRate * dt);
        const speed = Math.min(bullet.maxSpeed || MISSILE_GUIDANCE.defaultMaxSpeed, fastHypot(bullet.vx, bullet.vy) + MISSILE_GUIDANCE.acceleration * dt);
        bullet.vx = Math.cos(next) * speed;
        bullet.vy = Math.sin(next) * speed;
      }
      if (bullet.trackRemaining !== undefined) bullet.trackRemaining = Math.max(0, bullet.trackRemaining - dt);
    }

    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;

    if (bullet.x < -PROJECTILES.worldPadding || bullet.x > room.world.width + PROJECTILES.worldPadding || bullet.y < -PROJECTILES.worldPadding || bullet.y > room.world.height + PROJECTILES.worldPadding) {
      discardBullet(room, bulletsById, bullet);
      continue;
    }


    if (bullet.type === "pdShot") {
      const pList = spatialIndex
        ? spatialIndex.querySweptAabbUnordered("interceptableProjectiles", previousX, previousY, bullet.x, bullet.y, PROJECTILES.interceptRadius, scratch.interceptableProjectiles)
        : (room.bullets || []).filter((p) => p.interceptable && p.life > 0);
      let bestHit = null;
      for (const p of pList) {
        if (p === bullet) continue;
        if (!areEnemies(room, bullet.ownerId, p.ownerId)) continue;
        const hit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, p.x, p.y, PROJECTILES.interceptRadius);
        if (!hit) continue;
        if (!bestHit || hit.t < bestHit.t || (hit.t === bestHit.t && String(p.id).localeCompare(String(bestHit.target.id)) < 0)) {
          bestHit = { target: p, t: hit.t, x: hit.x, y: hit.y };
        }
      }
      if (bestHit) {
        const target = bestHit.target;
        const targetHp = target.hp !== undefined ? target.hp : (target.damage || 20);
        target.hp = targetHp - bullet.damage;
        bullet.life = 0;
        room.effects.push({ type: "spark", x: bestHit.x, y: bestHit.y, at: now });
        if (target.hp <= 0.001) {
          target.life = 0;
          discardBullet(room, bulletsById, target);
          interceptedPreviouslyKept = true;
          room.effects.push({ type: "burst", x: bestHit.x, y: bestHit.y, at: now });
          room.effects.push({ type: "text", text: "INTERCEPTED", x: bestHit.x, y: bestHit.y, at: now });
        }
        discardBullet(room, bulletsById, bullet);
        continue;
      }
      // No projectile intercept: fall through to generic ship/drone/asteroid handling
      // using the stored shipDamageMultiplier for hull hits.
    }

    if (bullet.type === "flak") {
      flakMetrics.active += 1;
      const eventScratch = room._flakEventScratch || (room._flakEventScratch = { interceptableProjectiles: scratch.interceptableProjectiles, drones: scratch.drones, ships: scratch.ships, asteroids: asteroidCandidates });
      const event = findFlakEvent(bullet, previousX, previousY, spatialIndex, eventScratch);
      flakMetrics.proximityCandidates += event.candidates || 0;
      if (event.kind || flakExpired) {
        detonateFlakShell(bullet, event.x, event.y, event.kind, event.entity || null, now, event.direct);
        discardBullet(room, bulletsById, bullet);
        continue;
      }
      kept.push(bullet);
      continue;
    }

    const rockHit = projectileMapImpact(room, previousX, previousY, bullet, spatialIndex, asteroidCandidates);

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

    // Decoys are false targets only for guided missiles. Unguided bolts, rails
    // and other projectiles neither acquire nor collide with them.
    if (bullet.type === "missile" && bullet.decoyTargetId && bullet.targetId === bullet.decoyTargetId) {
      const decoy = room.decoys?.get?.(bullet.decoyTargetId);
      if (decoy) {
        const decoyHit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, decoy.x, decoy.y, (Number(decoy.radius) || 12) + PROJECTILES.hitRadius.missile);
        if (decoyHit) recordHit({ kind: "decoy", t: decoyHit.t, x: decoyHit.x, y: decoyHit.y, decoy, entityId: decoy.id });
      }
    }

    const possibleShips = spatialIndex
      ? spatialIndex.querySweptAabbUnordered("ships", previousX, previousY, bullet.x, bullet.y, 0, shipCandidates)
      : liveShips;
    for (const ship of possibleShips) {
      if (!areEnemies(room, bullet.ownerId, ship.ownerId)) continue;
      const hitRadius = bullet.type === "missile" ? PROJECTILES.hitRadius.missile : bullet.type === "rail" ? PROJECTILES.hitRadius.rail : PROJECTILES.hitRadius.default;

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
      // segment against every occupied grid cell of each live component (shared
      // footprint-aware geometry, so a rotated or multi-cell component collides
      // on any of its cells), and choose the earliest component impact, with
      // component index as the deterministic tie-breaker. A multi-cell component
      // is recorded once (by index), so it takes a single damage event even when
      // several of its cells are crossed. Destroyed components are skipped via
      // componentHp and so no longer block later projectiles.
      const geometry = getShipCollisionGeometry(ship);
      const cellCoords = geometry.worldCells;
      const componentHp = ship.componentHp;
      let moduleHit = null;
      const collisionR = COMPONENT_CELL_COLLISION_RADIUS + hitRadius;
      for (const i of geometry.liveComponentIndices) {
        if (componentHp && componentHp[i] <= 0) continue;
        const cells = cellCoords[i];
        for (let c = 0; c < cells.length; c++) {
          const cell = cells[c];
          const hit = segmentCircleHit(previousX, previousY, bullet.x, bullet.y, cell.x, cell.y, collisionR);
          if (hit && (!moduleHit || hit.t < moduleHit.t || (hit.t === moduleHit.t && i < moduleHit.index))) {
            moduleHit = { ...hit, index: i };
          }
        }
      }
      if (moduleHit) {
        recordHit({ kind: "ship", t: moduleHit.t, x: moduleHit.x, y: moduleHit.y, ship, entityId: ship.id, shield: false });
      }
    }

    const possibleDrones = spatialIndex
      ? spatialIndex.querySweptAabbUnordered("drones", previousX, previousY, bullet.x, bullet.y, droneMovementPadding, droneCandidates)
      : (room.drones?.values?.() || []);
    for (const drone of possibleDrones) {
      if (drone.destroyed || drone.removed || room.drones?.get?.(drone.id) !== drone || !areEnemies(room, bullet.ownerId, drone.ownerId)) continue;
      const hitRadius = bullet.type === "missile"
        ? PROJECTILES.hitRadius.missile
        : bullet.type === "rail"
          ? PROJECTILES.hitRadius.rail
          : PROJECTILES.hitRadius.default;
      const hit = segmentCircleHit(
        previousX,
        previousY,
        bullet.x,
        bullet.y,
        drone.x,
        drone.y,
        (Number(drone.radius) || 10) + hitRadius
      );
      if (hit) recordHit({ kind: "drone", t: hit.t, x: hit.x, y: hit.y, drone, entityId: drone.id });
    }

    if (earliest?.kind === "asteroid") {
      room.effects.push({ type: "rockhit", x: earliest.x, y: earliest.y, at: now });
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "decoy") {
      require("./decoys").removeDecoy(room, earliest.decoy, now, "hit");
      room.effects.push({ type: "burst", subtype: "decoy", x: earliest.x, y: earliest.y, at: now });
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "ship") {
      const ship = earliest.ship;
      const shipDamage = Number.isFinite(bullet.shipDamageMultiplier) ? bullet.damage * bullet.shipDamageMultiplier : bullet.damage;
      damageShip(room, ship, shipDamage, bullet.ownerId, now, earliest.x, earliest.y, {
        shieldDamageMultiplier: bullet.shieldDamageMultiplier,
        hullDamageMultiplier: bullet.hullDamageMultiplier,
        armorInteractionSeconds: bullet.armorInteractionSeconds
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
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    if (earliest?.kind === "drone") {
      require("./drones").damageDrone(room, earliest.drone, bullet.damage, bullet.ownerId, now);
      room.effects.push({
        type: (bullet.type === "missile" || bullet.type === "torpedo") ? "burst" : bullet.type === "rail" ? "railhit" : "spark",
        x: earliest.x,
        y: earliest.y,
        at: now
      });
      discardBullet(room, bulletsById, bullet);
      continue;
    }

    kept.push(bullet);
  }

  if (interceptedPreviouslyKept) {
    let write = 0;
    for (let read = 0; read < kept.length; read += 1) {
      if (kept[read]?.life > 0) kept[write++] = kept[read];
    }
    kept.length = write;
  }
  sourceBullets.length = 0;
  room.bullets = kept;
  room._projectileSpare = sourceBullets;

  const sourceEffects = room.effects || [];
  const keptEffects = room._effectSpare && room._effectSpare !== sourceEffects ? room._effectSpare : [];
  keptEffects.length = 0;
  for (const effect of sourceEffects) {
    const life = effect.type === "beam" ? 140 : effect.type === "shieldhit" ? 340 : 900;
    if (now - effect.at < life) keptEffects.push(effect);
  }
  sourceEffects.length = 0;
  room.effects = keptEffects;
  room._effectSpare = sourceEffects;

  if (flakMetrics.active > 0) {
    flakMetrics.processingNs = process.hrtime.bigint() - flakStart;
    recordFlakMetrics({
      active: flakMetrics.active,
      proximityCandidates: flakMetrics.proximityCandidates,
      detonations: flakMetrics.detonations,
      explosionEntities: flakMetrics.explosionEntities,
      droneHits: flakMetrics.droneHits,
      missileHits: flakMetrics.missileHits,
      processingUs: Number(flakMetrics.processingNs) / 1000
    });
  }

  // Projectile positions and membership have now advanced beyond the index's
  // build epoch. No later subsystem in this tick consumes it; clearing prevents
  // accidental stale queries and the next authoritative tick rebuilds once.
  room.spatialIndex?.invalidateDynamic?.();
  if (room.assertProjectileLookup || process.env.MFA_ASSERT_RUNTIME_CACHES === "1" || process.env.NODE_ENV === "test") {
    assertProjectileLookupConsistency(room);
  }
}

module.exports = {
  addBullet,
  ensureProjectileLookup,
  rebuildProjectileLookup,
  assertProjectileLookupConsistency,
  resetProjectileRuntime,
  removeProjectilesByOwner,
  removeProjectileRuntime,
  projectileMapImpact,
  segmentCircleHit,
  updateBullets,
  shieldCollisionRadius,
  SHIELD_HIT_MIN
};
