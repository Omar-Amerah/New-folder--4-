"use strict";

const { removeProjectileRuntime } = require("../projectiles");
const { repairShipComponents } = require("../componentHealth");
const { damageDrone } = require("./lifecycle");

function performDroneAction(room, drone, effectiveTarget, config, runtimeConfig, now) {
  const targetDx = effectiveTarget ? effectiveTarget.x - drone.x : Infinity;
  const targetDy = effectiveTarget ? effectiveTarget.y - drone.y : Infinity;
  const distanceSq = effectiveTarget ? targetDx * targetDx + targetDy * targetDy : Infinity;
  if (now < drone.nextActionAt) return;
  if (drone.type === "repair" && effectiveTarget?.componentHp && distanceSq <= runtimeConfig.repairRangeSquared) {
    const amount = config.repairPerSecond / 5;
    repairShipComponents(room, effectiveTarget, amount, now);
    drone.nextActionAt = now + 200;
    room.effects.push({ type: "dronerepair", ownerId: drone.ownerId, x: drone.x, y: drone.y, x2: effectiveTarget.x, y2: effectiveTarget.y, at: now });
  } else if (drone.type !== "repair" && effectiveTarget && distanceSq <= runtimeConfig.weaponRangeSquared) {
    if (room.drones.get(effectiveTarget.id) === effectiveTarget) {
      damageDrone(room, effectiveTarget, config.damage, drone.ownerId, now);
    } else if (room.ships.get(effectiveTarget.id) === effectiveTarget) {
      // Defer the combat-facade lookup until an action actually hits a ship.
      // This keeps the drone facade load-order independent while preserving the
      // authoritative ship-damage path and its RNG/collision ordering.
      require("../combat").damageShip(room, effectiveTarget, config.damage, drone.ownerId, now, drone.x, drone.y);
    } else if (effectiveTarget.interceptable) {
      effectiveTarget.hp = Math.max(0, (Number(effectiveTarget.hp) || 0) - config.damage);
      if (effectiveTarget.hp <= 0) {
        removeProjectileRuntime(room, effectiveTarget, "intercepted", effectiveTarget.x, effectiveTarget.y);
        room.effects.push({ type: "burst", x: effectiveTarget.x, y: effectiveTarget.y, at: now });
      }
    }
    drone.nextActionAt = now + 1000 / config.fireRate;
    room.effects.push({ type: "droneshot", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, x2: effectiveTarget.x, y2: effectiveTarget.y, at: now });
  }
}

module.exports = { performDroneAction };
