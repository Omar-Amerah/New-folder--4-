"use strict";

const { INFRASTRUCTURE } = require("../config");
const { angleDifference, rotateToward } = require("../utils");
const { isComponentAlive, repairShipComponents } = require("../componentHealth");
const {
  stationModuleWorldPosition,
  repairStationComponents,
  relayRecoveryThresholdRatio
} = require("../stationCombat");
const TurretRules = require("../../../public/src/shared/turretRules");
const { getShipComponentIndexes } = require("../componentIndexes");

function updateStationRepair(room, station, dt, now) {
  if (station.state !== "operational" || station.stationType !== "home") return;
  const cfg = INFRASTRUCTURE.homeStation;
  if (!room.spatialIndex || !station.stats.repairRate) return;
  const scratch = room._stationRepairScratch || (room._stationRepairScratch = []);
  const candidates = room.spatialIndex.queryRange("ships", station.x, station.y, cfg.repairRadius, scratch);
  const radiusSq = cfg.repairRadius * cfg.repairRadius;
  let remaining = station.stats.repairRate;
  for (const ship of candidates) {
    if (!ship.alive || ship.team !== station.team) continue;
    const dx = ship.x - station.x;
    const dy = ship.y - station.y;
    if (dx * dx + dy * dy > radiusSq) continue;
    if (ship.hp >= ship.maxHp) continue;
    const rate = Math.min(remaining, cfg.repairRatePerSecond);
    const delivered = repairShipComponents(room, ship, rate * dt, now, station);
    remaining -= delivered;
    if (remaining <= 0) break;
  }
}

// Long-range repair emitters. The close-in aura above only reaches ships that
// are already docked-in-all-but-name; these are the station reaching out to a
// damaged hull well beyond it, and unlike the aura they are visible - each
// emitter traverses onto its target and draws a beam, exactly like a support
// ship's repairBeam, so a player can see the station working.
function updateStationRepairBeams(room, station, dt, now) {
  if (station.state !== "operational" || station.stationType !== "home") return;
  const emitters = getShipComponentIndexes(station).weaponIndices
    .filter((index) => station.design[index]?.type === "repairBeam" && isComponentAlive(station, index));
  if (emitters.length === 0) return;

  const cfg = INFRASTRUCTURE.homeStation;
  const range = Number(cfg.repairBeamRange) || 0;
  const ratePerEmitter = Number(cfg.repairBeamRatePerSecond) || 0;
  if (!(range > 0) || !(ratePerEmitter > 0)) return;
  const rangeSq = range * range;

  const scratch = room._stationBeamScratch || (room._stationBeamScratch = []);
  const candidates = room.spatialIndex
    ? room.spatialIndex.queryRange("ships", station.x, station.y, range, scratch)
    : [...room.ships.values()];

  // One target per emitter, worst-hurt first, so six beams spread across a
  // damaged wing instead of all piling onto the same hull.
  const wounded = [];
  for (const ship of candidates) {
    if (!ship.alive || ship.team !== station.team) continue;
    if (ship.hp >= ship.maxHp) continue;
    const dx = ship.x - station.x;
    const dy = ship.y - station.y;
    if (dx * dx + dy * dy > rangeSq) continue;
    wounded.push(ship);
  }
  if (wounded.length === 0) return;
  wounded.sort((a, b) => (b.maxHp - b.hp) - (a.maxHp - a.hp));

  const pulse = now - (station.repairPulseAt || 0) > 90;
  if (pulse) station.repairPulseAt = now;

  for (let i = 0; i < emitters.length; i += 1) {
    const index = emitters[i];
    const target = wounded[i % wounded.length];
    repairShipComponents(room, target, ratePerEmitter * dt, now, station);
    // Traverse the emitter onto its target; the client renders the same
    // weaponAngles array for the station's turret sprites.
    const origin = stationModuleWorldPosition(station, index);
    const desired = angleDifference(station.angle || 0, Math.atan2(target.y - origin.y, target.x - origin.x));
    const current = Number.isFinite(station.weaponAngles?.[index]) ? station.weaponAngles[index] : 0;
    station.weaponAngles[index] = rotateToward(current, desired, TurretRules.turnRateFor("beam") * dt);
    if (pulse) {
      room.effects.push({
        type: "repairbeam",
        x: origin.x,
        y: origin.y,
        x2: target.x,
        y2: target.y,
        at: now,
        ownerId: station.ownerId
      });
    }
  }
}

function updateStationSelfRepair(room, station, dt) {
  if (station.stationType === "relay" && station.state === "recovering") {
    const cfg = INFRASTRUCTURE.relayStation;
    const configured = Number(cfg?.selfRepairRatePerSecond);
    const rate = Number.isFinite(configured) ? Math.max(0, configured) : 12;
    const healed = repairStationComponents(station, rate * dt);
    const threshold = station.maxHp * relayRecoveryThresholdRatio(cfg);
    if (station.hp >= threshold && station.hp > 0) {
      station.state = "operational";
      station.stateRevision = (station.stateRevision || 0) + 1;
      room.stationRevision = (room.stationRevision || 0) + 1;
      if (room._visibilityRuntime) require("../visibilityRuntime").registerSensorSource(room, station, "station");
      require("../visibility").invalidateVisibility(room, {
        reason: "relay-recovered",
        entityIds: [station.id]
      });
    }
    return healed;
  }
  if (station.state !== "operational" || station.hp >= station.maxHp) return 0;
  const cfg = station.stationType === "home" ? INFRASTRUCTURE.homeStation : INFRASTRUCTURE.relayStation;
  const configured = Number(cfg?.selfRepairRatePerSecond);
  const rate = Number.isFinite(configured) ? Math.max(0, configured) : 12;
  return repairStationComponents(station, rate * dt);
}

module.exports = {
  updateStationRepair,
  updateStationRepairBeams,
  updateStationSelfRepair
};
