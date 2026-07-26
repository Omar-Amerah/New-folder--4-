"use strict";
const { updateBots, getLiveShips } = require("./ships");
const { updateEconomy } = require("./economy");
const { updateDestroyedShips, updateShipSupport, updateShipWeapons, updateSelfDestructingShips } = require("./combat");
const { updateShipMovement, updateShipSeparation, resolveFleetMapCollisions } = require("./movement");
const { updateBullets } = require("./projectiles");
const { updateCapturePoints, updateControlVictory } = require("./objectives");
const { updateShipHeat } = require("./heat");
const { updateShipPowerDemand } = require("./componentPower");
const { updateShipPowerProtection } = require("./powerProtection");
const { assertComponentHpConsistency } = require("./componentHealth");
const { updateDroneBays } = require("./drones");
const { buildRoomSpatialIndex } = require("./spatialIndex");
const { recordRoomTick } = require("./performanceTelemetry");
const { performanceNow } = require("./utils");
function tickRoom(room, dt, now) {
  if (room.phase !== "active") { room.effects = room.effects.filter((effect) => now - effect.at < 900); return; }
  const durations = {};
  let startedAt = performanceNow();
  updateBots(room, now); updateEconomy(room, dt); updateSelfDestructingShips(room, now); updateDestroyedShips(room, now);
  durations.botsEconomyLifecycle = performanceNow() - startedAt;
  const ships = getLiveShips(room);
  // Section 7D-2: refresh activity-driven Power demand once per ship, before any
  // gameplay system consumes this cycle's operational multipliers / section flow.
  startedAt = performanceNow();
  for (const ship of ships) updateShipPowerDemand(ship, room, now);
  // Section 7G: runtime Power overload protection reads the freshly solved
  // section flows; only trip/retry connectivity transitions re-solve Power.
  for (const ship of ships) updateShipPowerProtection(ship, dt);
  durations.powerDemandProtection = performanceNow() - startedAt;
  startedAt = performanceNow();
  for (const ship of ships) updateShipMovement(room, ship, dt);
  updateShipSeparation(room, ships, dt); resolveFleetMapCollisions(room, ships);
  durations.movementSeparationMap = performanceNow() - startedAt;
  startedAt = performanceNow();
  buildRoomSpatialIndex(room, ships, now);
  durations.spatialIndex = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateShipSupport(room, ships, dt, now);
  durations.support = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateDroneBays(room, ships, dt, now);
  durations.drones = performanceNow() - startedAt;
  let weaponsMs = 0;
  let heatMs = 0;
  for (const ship of ships) {
    startedAt = performanceNow();
    updateShipWeapons(room, ship, ships, dt, now);
    weaponsMs += performanceNow() - startedAt;
    startedAt = performanceNow();
    updateShipHeat(ship, dt, room, now);
    heatMs += performanceNow() - startedAt;
  }
  durations.weapons = weaponsMs;
  durations.heat = heatMs;
  startedAt = performanceNow();
  updateBullets(room, dt, now);
  durations.projectiles = performanceNow() - startedAt;
  startedAt = performanceNow();
  updateCapturePoints(room, ships, dt); updateControlVictory(room, now);
  durations.objectives = performanceNow() - startedAt;
  recordRoomTick({ durations });
  if (process.env.NODE_ENV !== "production") {
    for (const ship of room.ships.values()) {
      if (!ship?.componentHp || !ship?.design) continue;
      assertComponentHpConsistency(ship);
    }
  }
}
module.exports = { tickRoom };
