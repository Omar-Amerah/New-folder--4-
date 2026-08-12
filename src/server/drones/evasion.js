"use strict";

const { fastHypot } = require("../utils");
const { areEnemies } = require("../relationships");
const { nearbyCandidates } = require("./targeting");
const { stableDodgeSide, steerDrone } = require("./movement");

// Predictive projectile evasion for combat drones. Any drone type whose balance
// defines an evasion envelope (lookahead + clearance) uses it; Repair Drones,
// which define none, are naturally excluded.
function fighterProjectileEvasion(room, drone, config, context = null) {
  const lookahead = Math.max(0, Number(config.evasionLookaheadSeconds) || 0);
  const clearance = Math.max(0, Number(config.evasionClearance) || 0);
  if (lookahead <= 0 || clearance <= 0) return null;

  let dodgeX = 0;
  let dodgeY = 0;
  let totalWeight = 0;
  let mostUrgent = null;
  let mostUrgentWeight = 0;
  let mostUrgentDodgeX = 0;
  let mostUrgentDodgeY = 0;

  const maximumThreatRange = ((room.spatialIndex?.maxProjectileSpeed || 0) + (Number(config.speed) || 0)) * lookahead + clearance;
  const projectiles = context?.hostileProjectiles || nearbyCandidates(
    room,
    drone,
    "projectiles",
    drone.x,
    drone.y,
    maximumThreatRange,
    room.bullets || []
  );
  const clearanceSq = clearance * clearance;
  for (const projectile of projectiles) {
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
    const closestDistanceSq = closestX * closestX + closestY * closestY;
    const currentDistanceSq = rx * rx + ry * ry;
    if (closestDistanceSq >= clearanceSq) continue;
    if (rawClosestTime < 0 && currentDistanceSq >= clearanceSq) continue;
    const closestDistance = Math.sqrt(closestDistanceSq);
    const currentDistance = Math.sqrt(currentDistanceSq);

    const relativeSpeed = Math.sqrt(relativeSpeedSq);
    const perpendicularX = -rvy / relativeSpeed;
    const perpendicularY = rvx / relativeSpeed;
    const sideProjection = closestX * perpendicularX + closestY * perpendicularY;
    const side = Math.abs(sideProjection) > 0.001
      ? (sideProjection > 0 ? -1 : 1)
      : stableDodgeSide(drone.id);
    let dirX = perpendicularX * side;
    let dirY = perpendicularY * side;
    if (currentDistance > 0.001 && currentDistance < clearance) {
      const breakaway = (clearance - currentDistance) / clearance;
      dirX += (-rx / currentDistance) * breakaway;
      dirY += (-ry / currentDistance) * breakaway;
    }
    const dirMagnitude = fastHypot(dirX, dirY) || 1;
    dirX /= dirMagnitude;
    dirY /= dirMagnitude;

    const clearanceUrgency = 1 - closestDistance / clearance;
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
  let magnitude = fastHypot(dodgeX, dodgeY);
  if (magnitude <= 0.35 * totalWeight) {
    dodgeX = mostUrgentDodgeX;
    dodgeY = mostUrgentDodgeY;
    magnitude = fastHypot(dodgeX, dodgeY);
  }
  if (magnitude <= 0.0001) return null;
  return {
    x: dodgeX / magnitude,
    y: dodgeY / magnitude,
    weight: Math.min(1, totalWeight),
    ...mostUrgent
  };
}

function steerFighterDrone(room, drone, targetX, targetY, config, dt, now, cachedEvasion = undefined) {
  const evasion = cachedEvasion === undefined ? fighterProjectileEvasion(room, drone, config) : cachedEvasion;
  if (!evasion) {
    drone.evasionProjectileId = null;
    steerDrone(drone, targetX, targetY, config.speed, config.turnRate, dt);
    return;
  }

  const targetDx = targetX - drone.x;
  const targetDy = targetY - drone.y;
  const targetDistance = Math.max(0.0001, fastHypot(targetDx, targetDy));
  const strength = Math.max(0, Number(config.evasionStrength) || 0) * evasion.weight;
  const desiredX = targetDx / targetDistance + evasion.x * strength;
  const desiredY = targetDy / targetDistance + evasion.y * strength;
  drone.evasionProjectileId = evasion.projectileId;
  drone.lastEvasionAt = now;
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

module.exports = { fighterProjectileEvasion, steerFighterDrone };
