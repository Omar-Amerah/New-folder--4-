"use strict";

const { PARTS } = require("../components");
const { BALANCE } = require("../balanceConfig");
const { angleDifference, rotateToward } = require("../utils");
const { normalizeRotation } = require("../shipDesign");
const { isComponentAlive, repairShipComponents } = require("../componentHealth");
const { addComponentHeat, componentPerformance } = require("../heat");
const { getComponentPowerMultiplier } = require("../componentPower");
const { getShipRepairCache } = require("../repairCache");
const { getShipComponentIndexes } = require("../componentIndexes");
const Relationships = require("../relationships");
const RepairRules = require("../../../public/src/shared/repairRules.js");
const HeatRules = require("../../../public/src/shared/heatRules");
const TurretRules = require("../../../public/src/shared/turretRules");
const {
  moduleRotationToRadians,
  weaponModuleWorldPosition,
  weaponMuzzleWorldPosition
} = require("./weaponGeometry");

function areAllies(room, ownerA, ownerB) {
  return Relationships.areAllies(room, ownerA, ownerB);
}


function shipRepairNeed(ship) {

  return getShipRepairCache(ship).need;

}



// Charge emitters only for repair work the target actually accepted.  Using

// delivered output as the allocation weight makes local and projected repair

// deterministic and prevents spare nominal capacity from producing heat.

function allocateRepairHeat(ship, entries, actualRestored, { useRepairStack = false } = {}) {

  const delivered = Math.max(0, Number(actualRestored) || 0);

  const contributions = useRepairStack
    ? RepairRules.effectiveRepairContributions(entries, BALANCE, (entry) => entry.output)
    : entries.map((entry, index) => ({ item: entry, index, effectiveRate: Math.max(0, Number(entry.output) || 0) }));
  const total = contributions.reduce((sum, contribution) => sum + contribution.effectiveRate, 0);

  if (delivered <= 0 || total <= 0) return;

  for (const contribution of contributions) {

    const entry = contribution.item;

    const work = delivered * contribution.effectiveRate / total;

    addComponentHeat(
      ship,
      entry.index,
      work * HeatRules.activityHeat(entry.module.type, PARTS[entry.module.type] || {}) / Math.max(entry.repairRate, 0.0001)
    );

  }

}



function updateShipSupport(room, ships, dt, now) {

  for (const ship of ships) {

    if (ship.launchPhase) continue;
    if (!ship.stats.repair) continue;



    const activeRepairModules = [];

    const activeRepairBeams = [];

    for (const i of getShipComponentIndexes(ship).repairIndices) {

      const module = ship.design[i];

      const repairRate = PARTS[module.type]?.repairRate || 0;

      if (repairRate <= 0 || !isComponentAlive(ship, i)) continue;

      const heatMultiplier = componentPerformance(ship, i);

      const powerMultiplier = getComponentPowerMultiplier(ship, i);

      const activityMultiplier = heatMultiplier * powerMultiplier;

      if (activityMultiplier <= 0) continue;

      const entry = { index: i, module, repairRate, activityMultiplier, output: repairRate * activityMultiplier };

      activeRepairModules.push(entry);

      if (module.type === "repairBeam") activeRepairBeams.push(entry);

    }

    if (activeRepairModules.length === 0) continue;



    // Local repair modules are self-maintenance only. They must never choose an

    // allied ship the way repair beams do, otherwise a cheap repair module acts

    // like a ranged support beam without the intended turret/targeting cost.

    const localRepairModules = activeRepairModules

      .filter((entry) => entry.module.type !== "repairBeam");
    const selfRepairRate = RepairRules.getEffectiveRepairRate(localRepairModules, BALANCE, (entry) => entry.output);

    if (selfRepairRate > 0 && shipRepairNeed(ship) > 0) {

      const delivered = repairShipComponents(room, ship, selfRepairRate * dt, now);

      allocateRepairHeat(ship, localRepairModules, delivered, { useRepairStack: true });
      if (delivered > 0) {
        const owner = room.players.get(ship.ownerId);
        if (owner) owner.hullRepaired = (owner.hullRepaired || 0) + delivered;
      }

      ship._repairIntentAt = now; // Section 7D-2: repair systems have a valid action this cycle.

    }



    // Dedicated repair beams are the only repair parts that can project healing

    // onto another ship. They still use normal repair output and heat, but they

    // also traverse like beam weapons and emit a green beam from their muzzle.

    const beamRepairRate = RepairRules.sumRepairRates(activeRepairBeams.map((entry) => entry.output));

    if (beamRepairRate <= 0) continue;



    let target = null;

    let worst = 0;



    // A player-assigned repair target takes priority while it is a valid,

    // damaged ally in range; it is cleared once destroyed.

    if (ship.repairTargetId) {

      const assigned = room.ships.get(ship.repairTargetId);

      if (!assigned || !assigned.alive) {

        ship.repairTargetId = null;

      } else if (assigned.id === ship.id) {

        ship.repairTargetId = null;

      } else if (areAllies(room, ship.ownerId, assigned.ownerId)

        && shipRepairNeed(assigned) > 0

        && (assigned.x - ship.x) ** 2 + (assigned.y - ship.y) ** 2 <= ship.stats.repairRange ** 2) {

        target = assigned;

      }

    }



    if (!target) {

      const candidates = room.spatialIndex

        ? room.spatialIndex.queryRange(

          "ships",

          ship.x,

          ship.y,

          ship.stats.repairRange,

          room._supportSpatialScratch || (room._supportSpatialScratch = [])

        )

        : ships;

      const repairRangeSq = ship.stats.repairRange * ship.stats.repairRange;

      for (const other of candidates) {

        if (other.id === ship.id) continue;

        if (!areAllies(room, ship.ownerId, other.ownerId)) continue;

        const missing = shipRepairNeed(other);

        if (missing <= 0) continue;

        const dx = other.x - ship.x;

        const dy = other.y - ship.y;

        const distanceSq = dx * dx + dy * dy;

        if (distanceSq > repairRangeSq) continue;

        const distance = Math.sqrt(distanceSq);

        const urgency = missing / Math.max(1, distance * 0.08);

        if (urgency > worst) {

          target = other;

          worst = urgency;

        }

      }

    }



    if (!target) continue;

    const delivered = repairShipComponents(room, target, beamRepairRate * dt, now, ship);

    allocateRepairHeat(ship, activeRepairBeams, delivered);
    if (delivered > 0) {
      const owner = room.players.get(ship.ownerId);
      if (owner) owner.hullRepaired = (owner.hullRepaired || 0) + delivered;
    }

    ship._repairIntentAt = now; // Section 7D-2: a repair beam has a valid target this cycle.



    if (!ship.weaponAngles) ship.weaponAngles = (ship.design || []).map((m) => moduleRotationToRadians(normalizeRotation(m.rotation)));



    for (const entry of activeRepairBeams) {

      const emitter = entry.module;

      const emitterIndex = entry.index;

      const origin = weaponModuleWorldPosition(ship, emitter);

      const worldAngleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);

      const desiredRelative = angleDifference(ship.angle, worldAngleToTarget);

      const currentRelative = ship.weaponAngles[emitterIndex] ?? moduleRotationToRadians(normalizeRotation(emitter.rotation));

      ship.weaponAngles[emitterIndex] = rotateToward(currentRelative, desiredRelative, TurretRules.turnRateFor("beam") * dt);

    }



    // Emit a continuous repair beam from each active repair beam emitter muzzle.

    if (now - (ship.repairPulseAt || 0) > 90) {

      ship.repairPulseAt = now;

      for (const entry of activeRepairBeams) {

        const emitter = entry.module;

        const emitterIndex = entry.index;

        const currentAngle = ship.weaponAngles?.[emitterIndex] ?? moduleRotationToRadians(normalizeRotation(emitter.rotation));

        const muzzle = weaponMuzzleWorldPosition(ship, emitter, ship.angle + currentAngle, "beam");

        room.effects.push({ type: "repairbeam", x: muzzle.x, y: muzzle.y, x2: target.x, y2: target.y, at: now, ownerId: ship.ownerId });

      }

    }

  }

}

module.exports = {
  shipRepairNeed,
  updateShipSupport
};
