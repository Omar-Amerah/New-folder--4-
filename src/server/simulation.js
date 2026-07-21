"use strict";
const { updateBots, getLiveShips } = require("./ships");
const { updateEconomy } = require("./economy");
const { updateDestroyedShips, updateShipSupport, updateShipWeapons, updateSelfDestructingShips } = require("./combat");
const { updateShipMovement, updateShipSeparation, resolveFleetMapCollisions } = require("./movement");
const { updateBullets } = require("./projectiles");
const { updateCapturePoints, updateScoring } = require("./objectives");
const { updateShipHeat } = require("./heat");
const { updateShipPowerDemand } = require("./componentPower");
const { assertComponentHpConsistency } = require("./componentHealth");
function tickRoom(room, dt, now) {
  if (room.phase !== "active") { room.effects = room.effects.filter((effect) => now - effect.at < 900); return; }
  updateBots(room, now); updateEconomy(room, dt); updateSelfDestructingShips(room, now); updateDestroyedShips(room, now);
  const ships = getLiveShips(room);
  // Section 7D-2: refresh activity-driven Power demand once per ship, before any
  // gameplay system consumes this cycle's operational multipliers / section flow.
  for (const ship of ships) updateShipPowerDemand(ship, room, now);
  for (const ship of ships) updateShipMovement(room, ship, dt);
  updateShipSeparation(room, ships, dt); resolveFleetMapCollisions(room, ships); updateShipSupport(room, ships, dt, now);
  for (const ship of ships) { updateShipWeapons(room, ship, ships, dt, now); updateShipHeat(ship, dt, room, now); }
  updateBullets(room, dt, now); updateCapturePoints(room, ships, dt); updateScoring(room, now);
  if (process.env.NODE_ENV !== "production") {
    for (const ship of room.ships.values()) {
      if (!ship?.componentHp || !ship?.design) continue;
      assertComponentHpConsistency(ship);
    }
  }
}
module.exports = { tickRoom };
