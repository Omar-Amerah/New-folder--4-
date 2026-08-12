"use strict";

const { fastHypot, compareIdStrings, performanceNow } = require("../utils");
const { segmentCircleHit } = require("../projectiles");
const { droneBroadPhaseRadius } = require("../spatialIndex");
const { recordDuration } = require("../roomTelemetry");

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

function resolveDroneMapCollision(room, drone, previousX = drone.x, previousY = drone.y) {
  if (!drone || drone.removed || drone.destroyed) return;
  const radius = Math.max(1, Number(drone.radius) || 10);
  const width = Number(room.world?.width);
  const height = Number(room.world?.height);
  if (Number.isFinite(width) && width > radius * 2) {
    const clampedX = Math.max(radius, Math.min(width - radius, drone.x));
    if (clampedX !== drone.x && ((clampedX === radius && drone.vx < 0) || (clampedX === width - radius && drone.vx > 0))) drone.vx = 0;
    drone.x = clampedX;
  }
  if (Number.isFinite(height) && height > radius * 2) {
    const clampedY = Math.max(radius, Math.min(height - radius, drone.y));
    if (clampedY !== drone.y && ((clampedY === radius && drone.vy < 0) || (clampedY === height - radius && drone.vy > 0))) drone.vy = 0;
    drone.y = clampedY;
  }

  const asteroidCandidates = room.spatialIndex
    ? room.spatialIndex.querySweptAabbUnordered(
        "asteroids",
        previousX,
        previousY,
        drone.x,
        drone.y,
        radius + 2,
        drone._asteroidCollisionScratch || (drone._asteroidCollisionScratch = [])
      )
    : (room.map?.asteroids || []);

  let sweptHit = null;
  for (let candidateIndex = 0; candidateIndex < asteroidCandidates.length; candidateIndex += 1) {
    const asteroid = asteroidCandidates[candidateIndex];
    if (!asteroid) continue;
    const minimum = Math.max(0, Number(asteroid.radius) || 0) + radius + 2;
    const startDx = previousX - asteroid.x;
    const startDy = previousY - asteroid.y;
    if (startDx * startDx + startDy * startDy < minimum * minimum) continue;
    const hit = segmentCircleHit(previousX, previousY, drone.x, drone.y, asteroid.x, asteroid.y, minimum);
    if (!hit) continue;
    const asteroidIndex = room.map?.asteroids?.indexOf?.(asteroid) ?? candidateIndex;
    if (!sweptHit || hit.t < sweptHit.hit.t || (hit.t === sweptHit.hit.t && asteroidIndex < sweptHit.asteroidIndex)) {
      sweptHit = { asteroid, asteroidIndex, minimum, hit };
    }
  }
  if (sweptHit) {
    let nx = sweptHit.hit.x - sweptHit.asteroid.x;
    let ny = sweptHit.hit.y - sweptHit.asteroid.y;
    let distance = fastHypot(nx, ny);
    if (distance < 0.001) {
      nx = previousX - sweptHit.asteroid.x;
      ny = previousY - sweptHit.asteroid.y;
      distance = fastHypot(nx, ny);
    }
    if (distance < 0.001) {
      nx = stableDodgeSide(drone.id);
      ny = 0;
      distance = 1;
    }
    nx /= distance;
    ny /= distance;
    drone.x = sweptHit.asteroid.x + nx * sweptHit.minimum;
    drone.y = sweptHit.asteroid.y + ny * sweptHit.minimum;
    const velocityIntoRock = drone.vx * nx + drone.vy * ny;
    if (velocityIntoRock < 0) {
      drone.vx -= velocityIntoRock * nx;
      drone.vy -= velocityIntoRock * ny;
    }
  }

  for (let pass = 0; pass < 3; pass += 1) {
    let adjusted = false;
    for (const asteroid of asteroidCandidates) {
      if (!asteroid) continue;
      let dx = drone.x - asteroid.x;
      let dy = drone.y - asteroid.y;
      let distance = fastHypot(dx, dy);
      const minimum = Math.max(0, Number(asteroid.radius) || 0) + radius + 2;
      if (distance >= minimum) continue;
      if (distance < 0.001) {
        dx = stableDodgeSide(drone.id);
        dy = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const ny = dy / distance;
      drone.x = asteroid.x + nx * minimum;
      drone.y = asteroid.y + ny * minimum;
      const velocityIntoRock = drone.vx * nx + drone.vy * ny;
      if (velocityIntoRock < 0) {
        drone.vx -= velocityIntoRock * nx;
        drone.vy -= velocityIntoRock * ny;
      }
      adjusted = true;
    }
    if (!adjusted) break;
  }

  if (Number.isFinite(width) && width > radius * 2) drone.x = Math.max(radius, Math.min(width - radius, drone.x));
  if (Number.isFinite(height) && height > radius * 2) drone.y = Math.max(radius, Math.min(height - radius, drone.y));
}

function resolveDroneSeparation(drones, ordered = [], spatialIndex = null, movementPadding = 0) {
  ordered.length = 0;
  for (const drone of drones || []) {
    if (drone && !drone.removed && !drone.destroyed && !["docking", "refueling"].includes(drone.state)) ordered.push(drone);
  }
  ordered.sort((a, b) => {
    const seqA = Number.isFinite(a.authoritativeSequence) ? a.authoritativeSequence : 0;
    const seqB = Number.isFinite(b.authoritativeSequence) ? b.authoritativeSequence : 0;
    return seqA - seqB || compareIdStrings(a.id, b.id);
  });
  let maximumRadius = 10;
  for (let index = 0; index < ordered.length; index += 1) {
    const drone = ordered[index];
    drone._separationOrder = index;
    maximumRadius = Math.max(maximumRadius, Math.max(1, Number(drone.radius) || 10));
  }
  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i];
    const candidates = spatialIndex
      ? spatialIndex.queryRangeUnordered(
        "drones",
        a.x,
        a.y,
        maximumRadius * 2 + Math.max(0, Number(movementPadding) || 0) * 2 + 2,
        a._separationScratch || (a._separationScratch = [])
      )
      : ordered;
    for (const b of candidates) {
      if (a === b || b.removed || b.destroyed || ["docking", "refueling"].includes(b.state)) continue;
      if (b._separationOrder <= a._separationOrder) continue;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distance = fastHypot(dx, dy);
      const minimum = Math.max(1, Number(a.radius) || 10) + Math.max(1, Number(b.radius) || 10) + 2;
      if (distance >= minimum) continue;
      let nx;
      let ny;
      if (distance < 0.001) {
        const seqA = Number.isFinite(a.authoritativeSequence) ? a.authoritativeSequence : a._separationOrder;
        const seqB = Number.isFinite(b.authoritativeSequence) ? b.authoritativeSequence : b._separationOrder;
        const hash = (seqA + seqB) & 1;
        nx = hash === 0 ? 1 : -1;
        ny = 0;
        distance = 0;
      } else {
        nx = dx / distance;
        ny = dy / distance;
      }
      const push = (minimum - distance) * 0.5;
      a.x -= nx * push;
      a.y -= ny * push;
      b.x += nx * push;
      b.y += ny * push;
      const relativeInto = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (relativeInto < 0) {
        const impulse = relativeInto * 0.25;
        a.vx += nx * impulse;
        a.vy += ny * impulse;
        b.vx -= nx * impulse;
        b.vy -= ny * impulse;
      }
    }
  }
}

function publishDroneSpatialRecords(room, now) {
  if (!room.spatialIndex?.updateLiveEntities) return;
  const startedAt = performanceNow();
  room.spatialIndex.updateLiveEntities("drones", room.drones.values(), droneBroadPhaseRadius);
  recordDuration(room, "droneSpatialPublicationMs", startedAt);
}

module.exports = {
  steerDrone,
  stableDodgeSide,
  resolveDroneMapCollision,
  resolveDroneSeparation,
  publishDroneSpatialRecords
};
