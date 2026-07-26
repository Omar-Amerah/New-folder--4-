"use strict";

const { PARTS } = require("./components");
const { getShipComponentCellWorldCoords } = require("./componentGeometry");
const HeatRules = require("../../public/src/shared/heatRules");

const MIN_OPERATING_POWER = 0.05;

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
      nextLaunchAt: now
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

function stableThreatFor(room, ship, range) {
  const rangeSq = range * range;
  let best = null;
  let bestDistanceSq = Infinity;
  for (const projectile of room.bullets || []) {
    if (!isGuidedProjectile(projectile) || projectile.targetId !== ship.id) continue;
    if (!areEnemies(room, projectile.ownerId, ship.ownerId)) continue;
    const dx = projectile.x - ship.x;
    const dy = projectile.y - ship.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > rangeSq) continue;
    if (distanceSq < bestDistanceSq
      || (distanceSq === bestDistanceSq && String(projectile.id || "").localeCompare(String(best?.id || "")) < 0)) {
      best = projectile;
      bestDistanceSq = distanceSq;
    }
  }
  return best;
}

function collectStableThreats(room, ship, range, output) {
  output.length = 0;
  const rangeSq = range * range;
  for (const projectile of room.bullets || []) {
    if (!isGuidedProjectile(projectile) || projectile.targetId !== ship.id) continue;
    if (!areEnemies(room, projectile.ownerId, ship.ownerId)) continue;
    const dx = projectile.x - ship.x;
    const dy = projectile.y - ship.y;
    if (dx * dx + dy * dy <= rangeSq) output.push(projectile);
  }
  output.sort((a, b) => {
    const adx = a.x - ship.x;
    const ady = a.y - ship.y;
    const bdx = b.x - ship.x;
    const bdy = b.y - ship.y;
    return (adx * adx + ady * ady) - (bdx * bdx + bdy * bdy)
      || String(a.id || "").localeCompare(String(b.id || ""));
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
  for (const projectile of room.bullets || []) {
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
    if (!ship.decoyLaunchers) initializeDecoyLaunchers(room, ship, now);
    const launchers = ship.decoyLaunchers;
    const ready = ship._decoyLauncherReady || (ship._decoyLauncherReady = []);
    ready.length = launchers.length;
    ready.fill(false);
    let maximumTriggerRange = 0;

    for (let launcherIndex = 0; launcherIndex < launchers.length; launcherIndex += 1) {
      const launcher = launchers[launcherIndex];
      const config = PARTS[ship.design?.[launcher.componentIndex]?.type]?.decoyConfig;
      if (!config) continue;
      const alive = (ship.componentHp?.[launcher.componentIndex] ?? 0) > 0;
      const power = alive ? getComponentPowerMultiplier(ship, launcher.componentIndex) : 0;
      const overheated = (ship.componentHeatState?.[launcher.componentIndex] || HeatRules.STATE.NORMAL) >= HeatRules.STATE.OVERHEATED;
      const operational = alive && power > MIN_OPERATING_POWER && !overheated;
      if (operational && launcher.stock < launcher.capacity) {
        const productionSeconds = Math.max(0.001, Number(config.productionSeconds) || 1);
        launcher.productionProgress = Math.min(1, launcher.productionProgress + dt * power / productionSeconds);
        if (launcher.productionProgress >= 1) {
          launcher.stock += 1;
          launcher.productionProgress = launcher.stock < launcher.capacity ? 0 : 1;
        }
      }
      if (!operational || launcher.stock <= 0 || now < launcher.nextLaunchAt) continue;
      ready[launcherIndex] = true;
      maximumTriggerRange = Math.max(maximumTriggerRange, Math.max(0, Number(config.triggerRange) || 0));
    }

    if (maximumTriggerRange <= 0) continue;
    const threats = collectStableThreats(
      room,
      ship,
      maximumTriggerRange,
      ship._decoyThreatScratch || (ship._decoyThreatScratch = [])
    );
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
      launchDecoy(room, ship, launcher, config, threat, now);
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
