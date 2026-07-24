"use strict";

const { BALANCE } = require("./balanceConfig");
const { PARTS } = require("./components");
const DroneBayRules = require("../../public/src/shared/droneBayRules");
const HeatRules = require("../../public/src/shared/heatRules");

const CONFIG = BALANCE.drones;
const MODULE_SCALE = 13;
const GRID_CENTER = 7;
// A drone bay only needs meaningful power to launch and command drones — not a
// near-perfect supply. Below this floor it is treated as effectively unpowered
// (drones fall back / stop launching); above it, partial power just means a
// slower launch cadence rather than a hard stop.
const MIN_BAY_OPERATING_POWER = 0.05;

function initializeDroneBays(room, ship, now) {
  const validation = DroneBayRules.validateDroneBays(ship.design || [], PARTS, { maximum: CONFIG.maxBaysPerShip });
  ship.droneBays = validation.bays.map((source) => ({
    ...source,
    mode: "deployed",
    nextLaunchAt: now,
    slots: Array.from({ length: CONFIG.squadSize }, (_, slot) => ({
      slot,
      state: "ready",
      droneId: null,
      productionProgress: 1,
      pauseReason: null
    }))
  }));
  if (!room.drones) room.drones = new Map();
  return ship.droneBays;
}

function bayPowerRequest(ship, componentIndex) {
  const bay = ship?.droneBays?.find((entry) => entry.componentIndex === componentIndex);
  if (!bay || (ship.componentHp?.[componentIndex] ?? 0) <= 0) return 0;
  if (bay.slots.some((slot) => slot.state === "producing" || slot.state === "destroyed")) return CONFIG.productionPowerMw;
  if (bay.slots.some((slot) => ["launching", "active", "returning"].includes(slot.state))) return CONFIG.activePowerMw;
  // A deployed Ready slot is an imminent launch request. Reserve the active
  // load before spawning so a bay cannot launch on standby-only allocation.
  if (bay.mode === "deployed" && bay.slots.some((slot) => slot.state === "ready")) return CONFIG.activePowerMw;
  return CONFIG.standbyPowerMw;
}

function bayWorldPose(ship, bay) {
  const edge = bay.launchEdge;
  const gx = edge?.centerX ?? ship.design[bay.componentIndex].x + 1;
  const gy = edge?.centerY ?? ship.design[bay.componentIndex].y + 1;
  const gridDx = edge?.dx || 0;
  const gridDy = edge?.dy || -1;
  const lx = (GRID_CENTER - gy) * MODULE_SCALE;
  const ly = (gx - GRID_CENTER) * MODULE_SCALE;
  const localVx = -gridDy;
  const localVy = gridDx;
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);
  return {
    x: ship.x + lx * cos - ly * sin,
    y: ship.y + lx * sin + ly * cos,
    nx: localVx * cos - localVy * sin,
    ny: localVx * sin + localVy * cos
  };
}

function ownerActiveCount(room, ownerId) {
  let count = 0;
  for (const drone of room.drones?.values?.() || []) if (drone.ownerId === ownerId && !drone.destroyed) count += 1;
  return count;
}

function shipActiveCount(room, shipId) {
  let count = 0;
  for (const drone of room.drones?.values?.() || []) if (drone.parentShipId === shipId && !drone.destroyed) count += 1;
  return count;
}

function spawnDrone(room, ship, bay, slot, now) {
  if (shipActiveCount(room, ship.id) >= CONFIG.maxActivePerShip) return null;
  if (ownerActiveCount(room, ship.ownerId) >= CONFIG.maxActivePerPlayer) return null;
  const typeConfig = CONFIG.types[bay.droneType];
  if (!typeConfig) return null;
  const pose = bayWorldPose(ship, bay);
  const drone = {
    id: `d${room.nextEntityId++}`,
    ownerId: ship.ownerId,
    ownerPlayerId: ship.ownerId,
    teamId: ship.team || room.players?.get?.(ship.ownerId)?.team || null,
    parentShipId: ship.id,
    bayComponentId: bay.componentId,
    bayComponentIndex: bay.componentIndex,
    slot: slot.slot,
    squadIndex: slot.slot,
    type: bay.droneType,
    droneType: bay.droneType,
    x: pose.x,
    y: pose.y,
    vx: pose.nx * typeConfig.speed * 0.35,
    vy: pose.ny * typeConfig.speed * 0.35,
    angle: Math.atan2(pose.ny, pose.nx),
    radius: 10,
    hull: typeConfig.hull,
    maxHull: typeConfig.hull,
    state: "launching",
    launchedAt: now,
    stateUntil: now + CONFIG.launchDurationSeconds * 1000,
    commandState: bay.mode,
    nextThinkAt: now + (slot.slot * 37),
    nextActionAt: now + 350,
    targetId: null,
    orphanedAt: null
  };
  room.drones.set(drone.id, drone);
  slot.droneId = drone.id;
  slot.state = "launching";
  slot.productionProgress = 1;
  slot.pauseReason = null;
  room.effects.push({ type: "dronelaunch", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, at: now });
  return drone;
}

function setDroneDestroyed(room, drone, now, reason = "destroyed") {
  if (!drone || drone.destroyed) return false;
  drone.destroyed = true;
  drone.destroyedAt = now;
  room.drones.delete(drone.id);
  const parent = room.ships.get(drone.parentShipId);
  const bay = parent?.droneBays?.find((entry) => entry.componentId === drone.bayComponentId);
  const slot = bay?.slots?.[drone.slot];
  if (slot && slot.droneId === drone.id) {
    slot.droneId = null;
    slot.state = "destroyed";
    slot.productionProgress = 0;
    slot.pauseReason = null;
  }
  room.effects.push({ type: "droneburst", subtype: drone.type, reason, x: drone.x, y: drone.y, at: now });
  return true;
}

function damageDrone(room, drone, amount, attackerId, now) {
  if (!drone || drone.destroyed || !(amount > 0)) return 0;
  const applied = Math.min(drone.hull, amount);
  drone.hull -= applied;
  drone.lastDamagedAt = now;
  drone.lastDamagedBy = attackerId || null;
  if (drone.hull <= 0.001) setDroneDestroyed(room, drone, now);
  return applied;
}

function nearestEnemyDrone(room, drone, maximumRange) {
  const { areEnemies } = require("./combat");
  let best = null;
  let bestDistance = maximumRange;
  for (const other of room.drones.values()) {
    if (other.id === drone.id || other.destroyed || !areEnemies(room, drone.ownerId, other.ownerId)) continue;
    const distance = Math.hypot(other.x - drone.x, other.y - drone.y);
    if (distance < bestDistance || (distance === bestDistance && String(other.id) < String(best?.id))) {
      best = other;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestHostileMissile(room, drone, maximumRange) {
  const { areEnemies } = require("./combat");
  let best = null;
  let bestDistance = maximumRange;
  for (const projectile of room.bullets || []) {
    if (!projectile.interceptable || projectile.life <= 0 || !areEnemies(room, drone.ownerId, projectile.ownerId)) continue;
    const distance = Math.hypot(projectile.x - drone.x, projectile.y - drone.y);
    if (distance < bestDistance || (distance === bestDistance && String(projectile.id) < String(best?.id))) {
      best = projectile;
      bestDistance = distance;
    }
  }
  return best;
}

function nearestEnemyShip(room, drone, maximumRange) {
  const { areEnemies } = require("./combat");
  let best = null;
  let bestDistance = maximumRange;
  for (const ship of room.ships.values()) {
    if (!ship.alive || !areEnemies(room, drone.ownerId, ship.ownerId)) continue;
    const distance = Math.hypot(ship.x - drone.x, ship.y - drone.y);
    if (distance < bestDistance || (distance === bestDistance && String(ship.id) < String(best?.id))) {
      best = ship;
      bestDistance = distance;
    }
  }
  return best;
}

function chooseTarget(room, drone, parent, config) {
  if (drone.type === "repair") {
    if (parent.hp < parent.maxHp - 0.01) return parent;
    const candidates = [...room.ships.values()].filter((ship) => ship !== parent && ship?.alive && require("./combat").areAllies(room, drone.ownerId, ship.ownerId));
    candidates.sort((a, b) => {
      const ar = (a.maxHp - a.hp) / Math.max(1, a.maxHp);
      const br = (b.maxHp - b.hp) / Math.max(1, b.maxHp);
      return br - ar || String(a.id).localeCompare(String(b.id));
    });
    return candidates.find((ship) => ship.hp < ship.maxHp - 0.01 && Math.hypot(ship.x - parent.x, ship.y - parent.y) <= config.commandRange) || parent;
  }
  if (drone.type === "defence") {
    const missile = nearestHostileMissile(room, drone, config.commandRange);
    if (missile) return missile;
  }
  const hostileDrone = nearestEnemyDrone(room, drone, drone.type === "defence" ? config.commandRange : config.weaponRange);
  if (hostileDrone) return hostileDrone;
  if (drone.type === "fighter" && parent.focusTargetId) {
    const focused = room.ships.get(parent.focusTargetId);
    if (focused?.alive && require("./combat").areEnemies(room, drone.ownerId, focused.ownerId)) return focused;
  }
  return nearestEnemyShip(room, drone, config.commandRange);
}

function chooseFallbackTarget(room, drone, parent, config) {
  if (drone.type === "repair") return parent;
  return (drone.type === "defence" ? nearestHostileMissile(room, drone, config.weaponRange) : null)
    || nearestEnemyDrone(room, drone, config.weaponRange)
    || nearestEnemyShip(room, drone, config.weaponRange);
}

function steerDrone(drone, targetX, targetY, speed, turnRate, dt) {
  const desired = Math.atan2(targetY - drone.y, targetX - drone.x);
  let delta = ((desired - drone.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  delta = Math.max(-turnRate * dt, Math.min(turnRate * dt, delta));
  drone.angle += delta;
  const desiredVx = Math.cos(drone.angle) * speed;
  const desiredVy = Math.sin(drone.angle) * speed;
  const blend = Math.min(1, dt * 4);
  drone.vx += (desiredVx - drone.vx) * blend;
  drone.vy += (desiredVy - drone.vy) * blend;
  drone.x += drone.vx * dt;
  drone.y += drone.vy * dt;
}

function stableDodgeSide(id) {
  let hash = 0;
  for (const character of String(id || "fighter")) hash = ((hash * 31) + character.charCodeAt(0)) | 0;
  return (hash & 1) === 0 ? 1 : -1;
}

// Predictive projectile evasion for combat drones. Any drone type whose balance
// defines an evasion envelope (lookahead + clearance) uses it; Repair Drones,
// which define none, are naturally excluded.
function fighterProjectileEvasion(room, drone, config) {
  const lookahead = Math.max(0, Number(config.evasionLookaheadSeconds) || 0);
  const clearance = Math.max(0, Number(config.evasionClearance) || 0);
  if (lookahead <= 0 || clearance <= 0) return null;

  const { areEnemies } = require("./combat");
  let dodgeX = 0;
  let dodgeY = 0;
  let totalWeight = 0;
  let mostUrgent = null;
  let mostUrgentWeight = 0;
  let mostUrgentDodgeX = 0;
  let mostUrgentDodgeY = 0;

  for (const projectile of room.bullets || []) {
    if (!projectile || projectile.life <= 0 || !areEnemies(room, drone.ownerId, projectile.ownerId)) continue;
    if (![projectile.x, projectile.y, projectile.vx, projectile.vy].every(Number.isFinite)) continue;

    const rx = projectile.x - drone.x;
    const ry = projectile.y - drone.y;
    const rvx = projectile.vx - (drone.vx || 0);
    const rvy = projectile.vy - (drone.vy || 0);
    const relativeSpeedSq = rvx * rvx + rvy * rvy;
    if (relativeSpeedSq <= 0.0001) continue;

    const maximumTime = Math.min(lookahead, Math.max(0, Number(projectile.life) || 0));
    const rawClosestTime = -(rx * rvx + ry * rvy) / relativeSpeedSq;
    const closestTime = Math.max(0, Math.min(maximumTime, rawClosestTime));
    const closestX = rx + rvx * closestTime;
    const closestY = ry + rvy * closestTime;
    const closestDistance = Math.hypot(closestX, closestY);
    const currentDistance = Math.hypot(rx, ry);
    if (closestDistance >= clearance) continue;
    // A receding projectile only matters while it is already inside the
    // clearance envelope; otherwise drones should not weave needlessly.
    if (rawClosestTime < 0 && currentDistance >= clearance) continue;

    const relativeSpeed = Math.sqrt(relativeSpeedSq);
    const perpendicularX = -rvy / relativeSpeed;
    const perpendicularY = rvx / relativeSpeed;
    const sideProjection = closestX * perpendicularX + closestY * perpendicularY;
    const side = Math.abs(sideProjection) > 0.001
      ? (sideProjection > 0 ? -1 : 1)
      : stableDodgeSide(drone.id);
    // Primary manoeuvre: slip perpendicular to the projectile's approach line.
    let dirX = perpendicularX * side;
    let dirY = perpendicularY * side;
    // If it is already inside the clearance bubble, add a direct break-away push
    // so the drone opens distance instead of merely sliding along the line.
    if (currentDistance > 0.001 && currentDistance < clearance) {
      const breakaway = (clearance - currentDistance) / clearance;
      dirX += (-rx / currentDistance) * breakaway;
      dirY += (-ry / currentDistance) * breakaway;
    }
    const dirMagnitude = Math.hypot(dirX, dirY) || 1;
    dirX /= dirMagnitude;
    dirY /= dirMagnitude;

    const clearanceUrgency = 1 - closestDistance / clearance;
    // Urgency ramps up sharply as impact nears, so an imminent aimed shot
    // dominates over a distant projectile that merely clips the envelope.
    const timeFactor = 1 - closestTime / lookahead;
    const timeUrgency = 0.2 + 0.8 * timeFactor * timeFactor;
    const projectileUrgency = projectile.targetId === drone.id
      ? 1.5
      : (projectile.type === "missile" || projectile.type === "torpedo")
        ? 1.25
        : projectile.type === "rail"
          ? 1.15
          : 1;
    const weight = clearanceUrgency * timeUrgency * projectileUrgency;
    dodgeX += dirX * weight;
    dodgeY += dirY * weight;
    totalWeight += weight;
    if (weight > mostUrgentWeight) {
      mostUrgentWeight = weight;
      mostUrgentDodgeX = dirX;
      mostUrgentDodgeY = dirY;
      mostUrgent = { projectileId: projectile.id, closestTime, closestDistance };
    }
  }

  if (!mostUrgent) return null;
  let magnitude = Math.hypot(dodgeX, dodgeY);
  // Under crossfire the individual dodges can partly cancel and leave the drone
  // drifting into a threat. If the combined vector collapses, commit fully to
  // the single most dangerous projectile instead of splitting the difference.
  if (magnitude <= 0.35 * totalWeight) {
    dodgeX = mostUrgentDodgeX;
    dodgeY = mostUrgentDodgeY;
    magnitude = Math.hypot(dodgeX, dodgeY);
  }
  if (magnitude <= 0.0001) return null;
  return {
    x: dodgeX / magnitude,
    y: dodgeY / magnitude,
    weight: Math.min(1, totalWeight),
    ...mostUrgent
  };
}

function steerFighterDrone(room, drone, targetX, targetY, config, dt, now) {
  const evasion = fighterProjectileEvasion(room, drone, config);
  if (!evasion) {
    drone.evasionProjectileId = null;
    steerDrone(drone, targetX, targetY, config.speed, config.turnRate, dt);
    return;
  }

  const targetDx = targetX - drone.x;
  const targetDy = targetY - drone.y;
  const targetDistance = Math.max(0.0001, Math.hypot(targetDx, targetDy));
  const strength = Math.max(0, Number(config.evasionStrength) || 0) * evasion.weight;
  const desiredX = targetDx / targetDistance + evasion.x * strength;
  const desiredY = targetDy / targetDistance + evasion.y * strength;
  drone.evasionProjectileId = evasion.projectileId;
  drone.lastEvasionAt = now;
  // Briefly overdrive the engines while committing to a dodge so the drone
  // actually clears the projectile rather than being run down by it.
  const boost = strength > 0
    ? 1 + Math.min(0.6, Math.max(0, Number(config.evasionSpeedBoost) || 0) * evasion.weight)
    : 1;
  steerDrone(
    drone,
    drone.x + desiredX * Math.max(1, config.speed),
    drone.y + desiredY * Math.max(1, config.speed),
    config.speed * boost,
    config.turnRate,
    dt
  );
}

function updateDroneEntity(room, drone, dt, now) {
  const parent = room.ships.get(drone.parentShipId);
  const config = CONFIG.types[drone.type];
  if (!parent?.alive) {
    drone.orphanedAt ||= now;
    drone.state = "orphaned";
    drone.vx *= Math.max(0, 1 - dt * 0.8);
    drone.vy *= Math.max(0, 1 - dt * 0.8);
    drone.x += drone.vx * dt;
    drone.y += drone.vy * dt;
    if (now - drone.orphanedAt >= CONFIG.orphanLifetimeSeconds * 1000) setDroneDestroyed(room, drone, now, "orphaned");
    return;
  }
  const bay = parent.droneBays?.find((entry) => entry.componentId === drone.bayComponentId);
  const bayOperational = bay && (parent.componentHp?.[bay.componentIndex] ?? 0) > 0;
  const bayPowered = bayOperational && require("./componentPower").getComponentPowerMultiplier(parent, bay.componentIndex) > MIN_BAY_OPERATING_POWER;
  const fallback = !bayOperational || !bayPowered;
  drone.commandState = fallback ? "fallback" : bay.mode;
  if (fallback) drone.state = "fallback";
  else if (drone.state === "fallback") drone.state = "active";
  if (drone.state === "launching" && now >= drone.stateUntil) {
    drone.state = "active";
    const slot = bay?.slots?.[drone.slot];
    if (slot) slot.state = "active";
  }
  const pose = bay ? bayWorldPose(parent, bay) : { x: parent.x, y: parent.y };
  if (bayOperational && bay.mode === "recalled") drone.state = "returning";
  if (drone.state === "returning" || drone.state === "docking") {
    steerDrone(drone, pose.x, pose.y, config.speed, config.turnRate, dt);
    if (Math.hypot(drone.x - pose.x, drone.y - pose.y) < 30) {
      drone.state = "docking";
      const dockingSlot = bay.slots[drone.slot];
      if (dockingSlot) dockingSlot.state = "docking";
    }
    if (Math.hypot(drone.x - pose.x, drone.y - pose.y) < 12) {
      room.drones.delete(drone.id);
      const slot = bay.slots[drone.slot];
      slot.droneId = null;
      slot.state = "stored";
    }
    return;
  }
  if (now >= drone.nextThinkAt) {
    const target = fallback
      ? chooseFallbackTarget(room, drone, parent, config)
      : chooseTarget(room, drone, parent, config);
    drone.targetId = target?.id || null;
    drone.nextThinkAt = now + (drone.type === "repair" ? config.targetCommitSeconds * 1000 : 220 + drone.slot * 23);
  }
  const target = room.drones.get(drone.targetId)
    || room.ships.get(drone.targetId)
    || (room.bullets || []).find((projectile) => projectile.id === drone.targetId && projectile.life > 0);
  if (Math.hypot(drone.x - parent.x, drone.y - parent.y) > config.commandRange) drone.targetId = null;
  const effectiveTarget = drone.targetId ? target : null;
  const anchor = effectiveTarget || parent;
  const orbit = config.orbitDistance || 80;
  const phase = ((Number.parseInt(String(drone.id).replace(/\D/g, ""), 10) || drone.slot) * 2.399) + now * 0.00055;
  const pathX = anchor.x + Math.cos(phase) * orbit;
  const pathY = anchor.y + Math.sin(phase) * orbit;
  // Evasion-capable drones (Fighter, Defence) use predictive projectile-dodging
  // steering; others (Repair) simply hold their orbit path.
  const canEvade = (Number(config.evasionLookaheadSeconds) || 0) > 0 && (Number(config.evasionClearance) || 0) > 0;
  if (canEvade) steerFighterDrone(room, drone, pathX, pathY, config, dt, now);
  else steerDrone(drone, pathX, pathY, config.speed, config.turnRate, dt);
  const distance = effectiveTarget ? Math.hypot(effectiveTarget.x - drone.x, effectiveTarget.y - drone.y) : Infinity;
  if (now < drone.nextActionAt) return;
  if (drone.type === "repair" && effectiveTarget?.componentHp && distance <= config.repairRange) {
    const amount = config.repairPerSecond / 5;
    require("./componentHealth").repairShipComponents(room, effectiveTarget, amount, now);
    drone.nextActionAt = now + 200;
    room.effects.push({ type: "dronerepair", ownerId: drone.ownerId, x: drone.x, y: drone.y, x2: effectiveTarget.x, y2: effectiveTarget.y, at: now });
  } else if (drone.type !== "repair" && effectiveTarget && distance <= config.weaponRange) {
    if (room.drones.get(effectiveTarget.id) === effectiveTarget) {
      damageDrone(room, effectiveTarget, config.damage, drone.ownerId, now);
    } else if (room.ships.get(effectiveTarget.id) === effectiveTarget) {
      require("./combat").damageShip(room, effectiveTarget, config.damage, drone.ownerId, now, drone.x, drone.y, { armorInteractionSeconds: 1 / config.fireRate });
    } else if (effectiveTarget.interceptable) {
      effectiveTarget.hp = Math.max(0, (Number(effectiveTarget.hp) || 0) - config.damage);
      if (effectiveTarget.hp <= 0) {
        effectiveTarget.life = 0;
        room.effects.push({ type: "burst", x: effectiveTarget.x, y: effectiveTarget.y, at: now });
      }
    }
    drone.nextActionAt = now + 1000 / config.fireRate;
    room.effects.push({ type: "droneshot", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, x2: effectiveTarget.x, y2: effectiveTarget.y, at: now });
  }
}

function advanceBayProduction(bay, dt, power, overheated, operational = true) {
  let producing = bay.slots.find((slot) => slot.state === "producing");
  if (!producing && operational) {
    producing = bay.slots.find((slot) => slot.state === "destroyed");
    if (producing) producing.state = "producing";
  }
  if (!producing) return null;
  if (!operational) {
    producing.pauseReason = "bay-destroyed";
    return producing;
  }
  if (overheated) {
    producing.pauseReason = "bay-overheated";
    return producing;
  }
  const duration = CONFIG.types[bay.droneType]?.productionSeconds;
  if (!(duration > 0)) {
    producing.pauseReason = "invalid-configuration";
    return producing;
  }
  // Underpowered bays build slowly rather than stalling: production progress
  // already scales with the delivered power fraction (dt * power / duration), so
  // partial power simply means a slower build. Only an essentially unpowered bay
  // (no meaningful allocation) makes no progress at all.
  if (power <= 0.02) {
    producing.pauseReason = "insufficient-power";
    return producing;
  }
  producing.pauseReason = power < 0.98 ? "low-power" : null;
  producing.productionProgress = Math.min(1, producing.productionProgress + dt * power / duration);
  if (producing.productionProgress >= 1) producing.state = bay.mode === "deployed" ? "ready" : "stored";
  return producing;
}

function updateDroneBays(room, ships, dt, now) {
  if (!room.drones) room.drones = new Map();
  const { getComponentPowerMultiplier } = require("./componentPower");
  const { addComponentHeat } = require("./heat");
  for (const ship of ships) {
    if (!ship.droneBays) initializeDroneBays(room, ship, now);
    for (const bay of ship.droneBays) {
      const operational = (ship.componentHp?.[bay.componentIndex] ?? 0) > 0;
      if (!operational) {
        advanceBayProduction(bay, dt, 0, false, false);
        continue;
      }
      const power = getComponentPowerMultiplier(ship, bay.componentIndex);
      const overheated = (ship.componentHeatState?.[bay.componentIndex] || HeatRules.STATE.NORMAL) >= HeatRules.STATE.OVERHEATED;
      advanceBayProduction(bay, dt, power, overheated, true);
      const producing = bay.slots.some((slot) => slot.state === "producing");
      const active = bay.slots.some((slot) => ["launching", "active", "returning"].includes(slot.state));
      const heatPerSecond = producing ? CONFIG.productionHeatPerSecond : active ? CONFIG.activeHeatPerSecond : CONFIG.standbyHeatPerSecond;
      addComponentHeat(ship, bay.componentIndex, heatPerSecond * power * dt);
      if (bay.mode !== "deployed" || now < bay.nextLaunchAt || power <= MIN_BAY_OPERATING_POWER || overheated) continue;
      const ready = bay.slots.find((slot) => slot.state === "ready" || slot.state === "stored");
      if (ready) {
        spawnDrone(room, ship, bay, ready, now);
        // Underpowered bays launch on a longer cadence rather than not at all;
        // the interval stretches as delivered power drops (clamped so a barely
        // powered bay is slow, not frozen).
        bay.nextLaunchAt = now + CONFIG.launchIntervalSeconds * 1000 / Math.max(0.35, power);
      }
    }
  }
  for (const drone of [...room.drones.values()]) updateDroneEntity(room, drone, dt, now);
}

function setDroneBayMode(room, player, shipId, componentId, mode) {
  const ship = room.ships.get(String(shipId || ""));
  if (!ship?.alive || ship.ownerId !== player?.id) return false;
  const bay = ship.droneBays?.find((entry) => entry.componentId === componentId);
  if (!bay || !["deployed", "recalled"].includes(mode)) return false;
  bay.mode = mode;
  if (mode === "deployed") {
    for (const slot of bay.slots) if (slot.state === "stored") slot.state = "ready";
  }
  return true;
}

function buildDroneSnapshots(room, now) {
  return [...(room.drones?.values?.() || [])].map((drone) => ({
    id: drone.id,
      ownerId: drone.ownerId,
      parentShipId: drone.parentShipId,
      bayComponentId: drone.bayComponentId,
    type: drone.type,
    state: drone.state,
    x: Math.round(drone.x * 100) / 100,
    y: Math.round(drone.y * 100) / 100,
    vx: Math.round(drone.vx * 100) / 100,
    vy: Math.round(drone.vy * 100) / 100,
    angle: Math.round(drone.angle * 1000) / 1000,
    radius: Number(drone.radius) || 10,
    hull: Math.max(0, Math.round(drone.hull * 10) / 10),
      maxHull: drone.maxHull,
      targetId: drone.targetId,
      stateProgress: drone.state === "launching" ? Math.max(0, Math.min(1, 1 - (drone.stateUntil - now) / (CONFIG.launchDurationSeconds * 1000))) : 1
  }));
}

function buildBaySnapshots(ship) {
  return (ship.droneBays || []).map((bay) => {
    const pose = bayWorldPose(ship, bay);
    const producing = bay.slots.find((slot) => slot.state === "producing");
    const operational = ship.alive !== false && (ship.componentHp?.[bay.componentIndex] ?? 0) > 0;
    return {
      componentId: bay.componentId,
      componentIndex: bay.componentIndex,
      droneType: bay.droneType,
      commandRange: Number(CONFIG.types[bay.droneType]?.commandRange) || 0,
      squadSize: CONFIG.squadSize,
      activeCount: bay.slots.filter((slot) => ["launching", "active", "returning", "docking"].includes(slot.state)).length,
      storedCount: bay.slots.filter((slot) => ["stored", "ready"].includes(slot.state)).length,
      mode: bay.mode,
      operational,
      runtimePowerMw: bayPowerRequest(ship, bay.componentIndex),
      producingSlot: producing?.slot ?? null,
      productionProgress: producing?.productionProgress ?? null,
      productionPausedReason: producing?.pauseReason ?? (ship.alive === false ? "parent-destroyed" : operational ? null : "bay-destroyed"),
      launchState: bay.slots.some((slot) => slot.state === "launching") ? "launching" : "idle",
      x: Math.round(pose.x * 10) / 10,
      y: Math.round(pose.y * 10) / 10,
      slots: bay.slots.map((slot) => ({
        state: slot.state,
        droneId: slot.droneId,
        progress: Math.round((slot.productionProgress || 0) * 1000) / 1000,
        pauseReason: slot.pauseReason
      }))
    };
  });
}

module.exports = {
  CONFIG,
  initializeDroneBays,
  bayPowerRequest,
  bayWorldPose,
  updateDroneBays,
  damageDrone,
  setDroneDestroyed,
  setDroneBayMode,
  buildDroneSnapshots,
  buildBaySnapshots,
  _test: {
    spawnDrone,
    chooseTarget,
    chooseFallbackTarget,
    nearestHostileMissile,
    fighterProjectileEvasion,
    steerFighterDrone,
    updateDroneEntity,
    advanceBayProduction
  }
};
