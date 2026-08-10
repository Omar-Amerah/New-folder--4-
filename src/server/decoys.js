"use strict";

const { PARTS } = require("./components");
const { getShipComponentCellWorldCoords } = require("./componentGeometry");
const { compareIdStrings } = require("./utils");
const HeatRules = require("../../public/src/shared/heatRules");

const PREDICTION_CAP_SECONDS = 6;
const MIN_CLOSING_SPEED = 0;

function ensureDecoyRuntime(room) {
  if (!room.decoys) room.decoys = new Map();
  return room.decoys;
}

function resetDecoyRuntime(room) {
  room.decoys = new Map();
}

function initializeDecoyLaunchers(room, ship, now) {
  ship.decoyLaunchers = [];
  for (let componentIndex = 0; componentIndex < (ship.design || []).length; componentIndex += 1) {
    const module = ship.design[componentIndex];
    const config = PARTS[module?.type]?.decoyConfig;
    if (!config) continue;
    const capacity = Math.max(1, Math.floor(Number(config.capacity) || 1));
    const stock = Math.max(0, Math.min(capacity, Math.floor(Number(config.initialStock) || 0)));
    ship.decoyLaunchers.push({
      componentIndex,
      stock,
      capacity,
      productionProgress: stock < capacity ? 0 : 1,
      nextLaunchAt: now,
      nextThreatCheckAt: now,
      pendingLaunch: false
    });
  }
  ensureDecoyRuntime(room);
  return ship.decoyLaunchers;
}

function isGuidedProjectile(projectile) {
  return projectile?.type === "missile"
    && (Number(projectile.tracking) || 0) > 0
    && (projectile.trackRemaining === undefined || projectile.trackRemaining > 0)
    && projectile.life > 0;
}

function evaluateThreatMetrics(ship, projectile, dangerRadius) {
  const result = { credible: false, tca: Infinity, currentDistSq: Infinity, predictedDistSq: Infinity };
  if (!isGuidedProjectile(projectile) || projectile.targetId !== ship.id) return result;
  const dx = projectile.x - ship.x;
  const dy = projectile.y - ship.y;
  const dvx = (projectile.vx || 0) - (ship.vx || 0);
  const dvy = (projectile.vy || 0) - (ship.vy || 0);
  result.currentDistSq = dx * dx + dy * dy;
  const rangeSq = dangerRadius * dangerRadius;
  // Fast rejection for threats well outside the configured danger radius.
  if (result.currentDistSq > rangeSq * 4) return result;
  const dot = dx * dvx + dy * dvy;
  const vSq = dvx * dvx + dvy * dvy;
  if (vSq > 0.0001) {
    result.tca = -dot / vSq;
  } else {
    result.tca = Infinity;
  }
  if (Number.isFinite(result.tca) && result.tca >= 0) {
    const predictionHorizon = Math.min(
      Number.isFinite(projectile.life) ? projectile.life : Infinity,
      PREDICTION_CAP_SECONDS
    );
    const closingRate = result.currentDistSq > 0 ? -dot / Math.sqrt(result.currentDistSq) : 0;
    result.predictedDistSq = (dx + dvx * result.tca) ** 2 + (dy + dvy * result.tca) ** 2;
    result.credible = closingRate > MIN_CLOSING_SPEED && result.tca <= predictionHorizon && result.predictedDistSq <= rangeSq;
  }
  return result;
}

function isCredibleThreat(room, ship, projectile, dangerRadius) {
  if (!isGuidedProjectile(projectile) || projectile.targetId !== ship.id) return false;
  if (!areEnemies(room, projectile.ownerId, ship.ownerId)) return false;
  const decoy = room.decoys?.get?.(projectile.targetId);
  if (decoy && decoy.parentShipId === ship.id) return false;
  return evaluateThreatMetrics(ship, projectile, dangerRadius).credible;
}

function stableThreatFor(room, ship, range) {
  let best = null;
  let bestMetrics = null;
  const candidates = room.spatialIndex
    ? room.spatialIndex.queryRangeUnordered(
        "interceptableProjectiles",
        ship.x,
        ship.y,
        range,
        ship._decoyThreatScratch || (ship._decoyThreatScratch = [])
      )
    : (room.bullets || []);
  for (const projectile of candidates) {
    if (!isCredibleThreat(room, ship, projectile, range)) continue;
    const metrics = evaluateThreatMetrics(ship, projectile, range);
    if (!bestMetrics || metrics.tca < bestMetrics.tca || (metrics.tca === bestMetrics.tca && metrics.currentDistSq < bestMetrics.currentDistSq)) {
      best = projectile;
      bestMetrics = metrics;
    }
  }
  return best;
}

function collectStableThreats(room, ship, range, output) {
  output.length = 0;
  const candidates = room.spatialIndex
    ? room.spatialIndex.queryRangeUnordered(
        "interceptableProjectiles",
        ship.x,
        ship.y,
        range,
        ship._decoySpatialScratch || (ship._decoySpatialScratch = [])
      )
    : (room.bullets || []);
  for (const projectile of candidates) {
    if (!isCredibleThreat(room, ship, projectile, range)) continue;
    output.push(projectile);
  }
  // Sort by time-to-closest-approach (most imminent first), then predicted distance
  // at closest approach, then current distance, then authoritative sequence.
  output.sort((a, b) => {
    const ma = evaluateThreatMetrics(ship, a, range);
    const mb = evaluateThreatMetrics(ship, b, range);
    if (ma.tca !== mb.tca) return ma.tca - mb.tca;
    if (ma.predictedDistSq !== mb.predictedDistSq) return ma.predictedDistSq - mb.predictedDistSq;
    if (ma.currentDistSq !== mb.currentDistSq) return ma.currentDistSq - mb.currentDistSq;
    const seqA = Number.isFinite(a.authoritativeSequence) ? a.authoritativeSequence : 0;
    const seqB = Number.isFinite(b.authoritativeSequence) ? b.authoritativeSequence : 0;
    if (seqA !== seqB) return seqA - seqB;
    return compareIdStrings(a.id || "", b.id || "");
  });
  return output;
}

function launcherWorldPosition(ship, componentIndex) {
  const cells = getShipComponentCellWorldCoords(ship)?.[componentIndex] || [];
  if (!cells.length) return ship;
  let x = 0;
  let y = 0;
  for (const cell of cells) {
    x += cell.x;
    y += cell.y;
  }
  return { x: x / cells.length, y: y / cells.length };
}

function launchDecoy(room, ship, launcher, config, threat, now) {
  const origin = launcherWorldPosition(ship, launcher.componentIndex);
  const sequence = room.nextEntityId++;
  const side = sequence % 2 ? 1 : -1;
  // Launch into the ship's forward arc. The small alternating spread keeps
  // consecutive flares visually distinct without wasting their attraction
  // radius off either side of the ship.
  const angle = (ship.angle || 0) + side * Math.PI / 30;
  const speed = Math.max(0, Number(config.driftSpeed) || 0);
  const decoy = {
    id: `x${sequence}`,
    ownerId: ship.ownerId,
    parentShipId: ship.id,
    launcherComponentIndex: launcher.componentIndex,
    x: origin.x,
    y: origin.y,
    vx: (ship.vx || 0) + Math.cos(angle) * speed,
    vy: (ship.vy || 0) + Math.sin(angle) * speed,
    radius: Math.max(1, Number(config.collisionRadius) || 12),
    spawnedAt: now,
    expiresAt: now + Math.max(0.1, Number(config.lifetimeSeconds) || 1) * 1000,
    attractionRange: Math.max(0, Number(config.attractionRange) || 0),
    attractionChance: Math.max(0, Math.min(1, Number(config.attractionChance) || 0))
  };
  ensureDecoyRuntime(room).set(decoy.id, decoy);
  launcher.stock -= 1;
  launcher.productionProgress = 0;
  launcher.nextLaunchAt = now + Math.max(0, Number(config.launchCooldownSeconds) || 0) * 1000;
  room.effects.push({ type: "decoylaunch", ownerId: ship.ownerId, x: decoy.x, y: decoy.y, x2: threat.x, y2: threat.y, at: now });
  return decoy;
}

function tryAttractProjectiles(room, decoy, now) {
  const rangeSq = decoy.attractionRange * decoy.attractionRange;
  const random = typeof room.combatRandom === "function" ? room.combatRandom : Math.random;
  // Use spatial index for guided missile queries instead of full projectile scan
  const candidates = room.spatialIndex
    ? room.spatialIndex.queryRangeUnordered(
        "interceptableProjectiles",
        decoy.x,
        decoy.y,
        decoy.attractionRange,
        decoy._attractionScratch || (decoy._attractionScratch = [])
      )
    : (room.bullets || []);
  for (const projectile of candidates) {
    if (!isGuidedProjectile(projectile) || projectile.targetId !== decoy.parentShipId) continue;
    if (!areEnemies(room, projectile.ownerId, decoy.ownerId)) continue;
    const tested = projectile.decoyTests || (projectile.decoyTests = new Set());
    if (tested.has(decoy.id)) continue;
    const dx = projectile.x - decoy.x;
    const dy = projectile.y - decoy.y;
    if (dx * dx + dy * dy > rangeSq) continue;
    tested.add(decoy.id);
    if (random() >= decoy.attractionChance) continue;
    projectile.decoyReturnTargetId = projectile.targetId;
    projectile.decoyReturnComponentIndex = projectile.targetComponentIndex;
    projectile.targetId = decoy.id;
    projectile.targetComponentIndex = -1;
    projectile.decoyTargetId = decoy.id;
    room.effects.push({ type: "decoyattract", ownerId: decoy.ownerId, x: decoy.x, y: decoy.y, x2: projectile.x, y2: projectile.y, at: now });
  }
}

function areEnemies(room, ownerA, ownerB) {
  if (ownerA === ownerB) return false;
  if (room.rules?.gameMode === "solo") return Boolean(room.players?.has?.(ownerA) && room.players?.has?.(ownerB));
  const a = room.players?.get?.(ownerA);
  const b = room.players?.get?.(ownerB);
  return Boolean(a && b && a.team !== b.team);
}

function removeDecoy(room, decoy, now, reason = "expired") {
  if (!decoy || room.decoys?.get?.(decoy.id) !== decoy) return false;
  room.decoys.delete(decoy.id);
  if (reason === "expired") {
    const parent = room.ships?.get?.(decoy.parentShipId);
    if (parent?.alive) {
      for (const projectile of room.bullets || []) {
        if (projectile.targetId !== decoy.id || projectile.decoyTargetId !== decoy.id) continue;
        if (!isGuidedProjectile(projectile) || !areEnemies(room, projectile.ownerId, parent.ownerId)) continue;
        projectile.targetId = projectile.decoyReturnTargetId || parent.id;
        projectile.targetComponentIndex = Number.isInteger(projectile.decoyReturnComponentIndex)
          ? projectile.decoyReturnComponentIndex
          : -1;
        projectile.decoyTargetId = null;
        projectile.decoyReturnTargetId = null;
        projectile.decoyReturnComponentIndex = null;
      }
    }
  }
  if (reason !== "expired") room.effects.push({ type: "decoyburst", reason, ownerId: decoy.ownerId, x: decoy.x, y: decoy.y, at: now });
  return true;
}

function updateDecoyLaunchers(room, ships, dt, now) {
  const decoys = ensureDecoyRuntime(room);
  // Map iterators remain valid when deleting the current entry, so expiry does
  // not need a temporary copy of every live decoy each tick.
  for (const decoy of decoys.values()) {
    const parent = room.ships?.get?.(decoy.parentShipId);
    if (!parent?.alive || now >= decoy.expiresAt) {
      removeDecoy(room, decoy, now);
      continue;
    }
    decoy.x += decoy.vx * dt;
    decoy.y += decoy.vy * dt;
  }

  const { getComponentPowerMultiplier } = require("./componentPower");
  for (const ship of ships || []) {
    if (ship.launchPhase) continue;
    if (!ship.decoyLaunchers) initializeDecoyLaunchers(room, ship, now);
    const launchers = ship.decoyLaunchers;
    const ready = ship._decoyLauncherReady || (ship._decoyLauncherReady = []);
    ready.length = launchers.length;
    ready.fill(false);
    const powerMultipliers = new Array(launchers.length).fill(0);
    let maximumTriggerRange = 0;

    for (let launcherIndex = 0; launcherIndex < launchers.length; launcherIndex += 1) {
      const launcher = launchers[launcherIndex];
      const part = PARTS[ship.design?.[launcher.componentIndex]?.type];
      const config = part?.decoyConfig;
      if (!config) continue;
      const alive = (ship.componentHp?.[launcher.componentIndex] ?? 0) > 0;
      const power = alive ? getComponentPowerMultiplier(ship, launcher.componentIndex) : 0;
      powerMultipliers[launcherIndex] = power;
      const overheated = (ship.componentHeatState?.[launcher.componentIndex] || HeatRules.STATE.NORMAL) >= HeatRules.STATE.OVERHEATED;
      const operational = alive && power > 0 && !overheated;
      if (operational && launcher.stock < launcher.capacity) {
        const productionSeconds = Math.max(0.001, Number(config.productionSeconds) || 1);
        launcher.productionProgress = Math.min(1, launcher.productionProgress + dt * power / productionSeconds);
        if (launcher.productionProgress >= 1) {
          launcher.stock += 1;
          launcher.productionProgress = launcher.stock < launcher.capacity ? 0 : 1;
        }
      }

      const launchReady = alive && !overheated && launcher.stock > 0 && now >= launcher.nextLaunchAt;

      if (launcher.pendingLaunch) {
        if (launchReady && power > 0) {
          const triggerRange = Math.max(0, Number(config.triggerRange) || 0);
          const threat = triggerRange > 0 ? stableThreatFor(room, ship, triggerRange) : null;
          if (threat) launchDecoy(room, ship, launcher, config, threat, now);
          launcher.pendingLaunch = false;
        }
        // If not powered or not cooled yet, keep the intent for a future tick.
        continue;
      }

      if (launchReady) {
        ready[launcherIndex] = true;
        maximumTriggerRange = Math.max(maximumTriggerRange, Math.max(0, Number(config.triggerRange) || 0));
      }
    }

    if (maximumTriggerRange <= 0) {
      ship._decoyThreatActive = false;
      continue;
    }
    const threats = collectStableThreats(
      room,
      ship,
      maximumTriggerRange,
      ship._decoyThreatScratch || (ship._decoyThreatScratch = [])
    );
    ship._decoyThreatActive = threats.length > 0;
    let cursor = Math.max(0, Math.floor(Number(ship._nextDecoyLauncherIndex) || 0)) % Math.max(1, launchers.length);
    for (const threat of threats) {
      let selected = -1;
      for (let offset = 0; offset < launchers.length; offset += 1) {
        const launcherIndex = (cursor + offset) % launchers.length;
        if (!ready[launcherIndex]) continue;
        const launcher = launchers[launcherIndex];
        const config = PARTS[ship.design?.[launcher.componentIndex]?.type]?.decoyConfig;
        const triggerRange = Math.max(0, Number(config?.triggerRange) || 0);
        const dx = threat.x - ship.x;
        const dy = threat.y - ship.y;
        if (dx * dx + dy * dy > triggerRange * triggerRange) continue;
        selected = launcherIndex;
        break;
      }
      if (selected < 0) continue;
      const launcher = launchers[selected];
      const config = PARTS[ship.design?.[launcher.componentIndex]?.type]?.decoyConfig;
      // If the launcher already has enough power allocated, fire now; otherwise
      // queue a pending intent so power demand can rise before launch.
       if (powerMultipliers[selected] > 0) {
        launchDecoy(room, ship, launcher, config, threat, now);
      } else {
        launcher.pendingLaunch = true;
      }
      ready[selected] = false;
      cursor = (selected + 1) % launchers.length;
    }
    ship._nextDecoyLauncherIndex = cursor;
  }

  for (const decoy of decoys.values()) tryAttractProjectiles(room, decoy, now);
}

function buildDecoySnapshots(room, now) {
  return [...ensureDecoyRuntime(room).values()].map((decoy) => ({
    id: decoy.id,
    ownerId: decoy.ownerId,
    parentShipId: decoy.parentShipId,
    x: Math.round(decoy.x * 100) / 100,
    y: Math.round(decoy.y * 100) / 100,
    vx: Math.round(decoy.vx * 100) / 100,
    vy: Math.round(decoy.vy * 100) / 100,
    radius: decoy.radius,
    remainingSeconds: Math.max(0, Math.round((decoy.expiresAt - now) / 10) / 100)
  }));
}

function buildLauncherSnapshots(ship) {
  return (ship.decoyLaunchers || []).map((launcher) => ({
    componentIndex: launcher.componentIndex,
    stock: launcher.stock,
    capacity: launcher.capacity,
    productionProgress: Math.round(Math.max(0, Math.min(1, launcher.productionProgress)) * 1000) / 1000,
    nextLaunchAt: launcher.nextLaunchAt
  }));
}

module.exports = {
  ensureDecoyRuntime,
  resetDecoyRuntime,
  initializeDecoyLaunchers,
  isGuidedProjectile,
  updateDecoyLaunchers,
  removeDecoy,
  buildDecoySnapshots,
  buildLauncherSnapshots,
  _test: { stableThreatFor, collectStableThreats, launchDecoy, tryAttractProjectiles }
};
