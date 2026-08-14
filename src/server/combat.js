// Applies combat targeting, weapon cooldowns, weapon arcs, damage resolution, and support/healing.



const { PARTS } = require("./components");

const { ECONOMY } = require("./config");

const { rngRange, clampNumber, angleDifference, rotateToward, fastHypot, performanceNow, compareIdStrings } = require("./utils");
const { gameplayNow } = require("./gameplayTime");

const { normalizeRotation } = require("./shipDesign");

const { invalidateShipCollisionGeometry } = require("./componentGeometry");

const { addBullet, removeProjectileRuntime, segmentCircleHit } = require("./projectiles");

const { canTeamTargetEntity } = require("./visibility");

const { isComponentAlive, zeroAllComponents } = require("./componentHealth");

const { addComponentHeat, componentPerformance } = require("./heat");

const TurretRules = require("../../public/src/shared/turretRules");
const HeatRules = require("../../public/src/shared/heatRules");
const ShieldRules = require("../../public/src/shared/shieldRules");
const DataSupportRules = require("../../public/src/shared/dataSupportRules");

const { getComponentPowerMultiplier } = require("./componentPower");

const {
  getEffectiveWeaponStats,
  getEffectiveWeaponStatsInternal,
  getEffectiveWeaponStatsCached,
  ensureEffectiveWeaponProfileCache,
  getMaxEffectiveWeaponRange
} = require("./componentData");

const { getCommandAuraMultiplier } = require("./commandAuras");

const { PRIORITY_COMPONENT_TYPES } = require("./repairCache");

const Relationships = require("./relationships");
const { isSegmentStationClear } = require("./stationCollision");

const TargetingTelemetry = require("./targetingTelemetry");
const TargetingCadence = require("./targetingCadence");
const Targeting = require("./targetingEligibility");

const { getShipComponentIndexes } = require("./componentIndexes");
const { roomCombatRandom } = require("./combat/random");

const {
  asteroidBroadPhase,
  roomScratch,
  isLineBlocked,
  isTargetInWeaponArc,
  getWeaponTurnRate,
  getHoldWeaponFacingSignature,
  chooseHoldWeaponFacing,
  evaluateHoldWeaponCoverage,
  evaluateMainBatteryFacing,
  mainBatteryOrbitRange,
  mainBatteryProfile
} = require("./mainBattery");



const SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE = ShieldRules.IMPACT_HEAT_PER_BLOCKED_DAMAGE;

// Accuracy has one universal angular interpretation for weapon fire. The
// authored percentage is the same stat for every weapon family; family-specific
// spread coefficients make the displayed value mean different things.
const ACCURACY_SPREAD_SCALE = DataSupportRules.ACCURACY_SPREAD_SCALE;


// componentTargeting owns ordinary weighted targeting state and its
// componentAimRetentionMultiplier retarget cadence; this facade only coordinates it.
const {
  componentAimWorldPosition,
  targetAttackPoint,
  targetCoreAimWorldPosition,
  findBeamRayIntersections,
  isComponentExposed,
  selectComponentAimIndex,
  clearWeaponComponentAim,
  weaponComponentAimPoint
} = require("./combat/componentTargeting");



/* Specialist implementation lives in combat/induction.js. Its explicit
 * function selectInductionComponentIndex first builds powerGenerators using
 * part.powerGeneration > 0; function getInductionAimPoint retains that selector.
 */
const {
  isInductionBeam,
  getInductionAimPoint,
  isInductionBlockedByHeatShield,
  fireInductionLance
} = require("./combat/induction").createInductionRuntime({
  asteroidBroadPhase,
  roomScratch,
  roomCombatRandom,
  isInSafeZone,
  areEnemies
});









// Refractory Armour stops an induction lance outright. An induction beam does no
// damage — it reaches past the hull and couples Heat straight into an internal
// subsystem — so the only way to answer it is to put material in the way that
// will not conduct. If a live heat-shielded component sits on the beam line in
// front of the component the lance has coupled to, no Heat crosses at all. This
// is a full block rather than an attenuation, which makes the counter a
// placement decision (armour the approach the lance is using) instead of a stat
// check the attacker can simply out-scale.



// The facade keeps the public support API while repairSupport owns its runtime.
// Repair Beam emitter contract: repairShipComponents(room, target, beamRepairRate * dt, now, ship)
const { shipRepairNeed, updateShipSupport } = require("./combat/repairSupport");





function stableId(value) {

  return String(value?.id ?? value ?? "");

}



function isStableIdBefore(a, b) {

  return compareIdStrings(stableId(a), stableId(b)) < 0;

}



// Broad-phase helpers -------------------------------------------------------

//

// Line-of-sight and beam resolution used to scan every asteroid/ship/drone in

// the room on every call, from inside per-weapon and per-candidate loops. Both

// go through the room broad phase instead, exactly like projectile and

// movement collision already do.

//

// Padding note: an entity is inserted into the index using its own broad-phase

// radius R, and the narrow test accepts it at (entityRadius + extra). Because

// R >= entityRadius for every kind, padding the query by `extra` alone makes

// the returned set a conservative superset of the true hits.

//

// The index is only consulted once the asteroid kind actually mirrors the map;

// callers reached outside the tick loop (and unit tests that build rooms by

// hand) still fall back to the authoritative array so no rock is ever missed.

// asteroidBroadPhase and roomScratch now live in mainBattery.js.



const {
  weaponSpreadRadians,
  pelletShotCount,
  impactPayload,
  weaponReloadSeconds
} = require("./combat/weaponProfiles");


const {
  findPointDefenseTarget,
  _lookupPointDefenceEntity,
  getCandidatePriorityIndex
} = require("./combat/pointDefence").createPointDefence({ isLineBlocked });





function isInSafeZone(room, x, y, shipOrPlayer = null) {

  if (!room.map || !room.map.safeZones) return false;

  const player = shipOrPlayer?.ownerId ? room.players?.get(shipOrPlayer.ownerId) : shipOrPlayer;

  for (const zone of room.map.safeZones) {

    if (fastHypot(x - zone.x, y - zone.y) > zone.radius) continue;

    if (zone.ownerId) return Boolean(player && player.id === zone.ownerId);

    if (zone.team) return Boolean(player && player.team === zone.team);

    return true;

  }

  return false;

}



function getCadencedShipCombatTarget(room, ship, ships, now) {
  if (!ship._combatTargetState) ship._combatTargetState = { id: null, focusId: null, nextSearchAt: 0 };
  const state = ship._combatTargetState;
  const focusId = ship.focusTargetId || null;
  const focusChanged = state.focusId !== focusId;
  state.focusId = focusId;

  const maxRange = maxShipWeaponAcquisitionRange(ship);
  const allTargets = (ships || []).concat((room?.stations || []).filter((s) => s && s.alive !== false && s.state !== "destroyed"));

  let current = null;
  let currentValid = false;
  const cachedId = ship.combatTargetId || null;
  if (cachedId) {
    current = allTargets.find((e) => e && e.id === cachedId) || room.ships?.get?.(cachedId) || null;
    if (current) {
      currentValid = Targeting.isOrdinaryWeaponTargetValid(room, ship, current, now, maxRange, {
        originX: ship.x,
        originY: ship.y
      });
      const currentPoint = targetAttackPoint(ship.x, ship.y, current);
      if (currentValid && TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledLineOfSightDuration", () => isLineBlocked(room, ship.x, ship.y, currentPoint.x, currentPoint.y, 8))) currentValid = false;
      if (!currentValid) TargetingTelemetry.bump(room, "shipCombatTargetInvalidations");
    }
  }

  if (focusId) {
    const focused = allTargets.find((e) => e && e.id === focusId);
    if (focused && focused.entityType === "station"
      && focused.alive !== false
      && Relationships.areEntityEnemies(room, ship.ownerId, focused)
      && canTeamTargetEntity(room, ship.team, focused, now)) {
      ship.combatTargetId = focused.id;
      return focused;
    }
    if (focused && Targeting.isOrdinaryWeaponTargetValid(room, ship, focused, now, maxRange, { originX: ship.x, originY: ship.y })) {
      const focusedPoint = targetAttackPoint(ship.x, ship.y, focused);
      const focusedBlocked = TargetingTelemetry.withSampledDuration(
        room,
        now,
        ship,
        0,
        "sampledLineOfSightDuration",
        () => isLineBlocked(room, ship.x, ship.y, focusedPoint.x, focusedPoint.y, 8)
      );
      if (!focusedBlocked) {
        ship.combatTargetId = focused.id;
        return focused;
      }
    }
  }

  const hadCachedTarget = cachedId !== null;
  const force = focusChanged || (hadCachedTarget && !currentValid);
  const due = TargetingCadence.isAcquisitionDue(ship, "shipCombat", 0, now);

  if (currentValid && !force && !due) {
    TargetingTelemetry.bump(room, "shipCombatTargetCacheHits");
    return current;
  }

  if (!currentValid && !force && !due) {
    TargetingTelemetry.bump(room, "shipCombatTargetSearchDeferred");
    ship.combatTargetId = null;
    return null;
  }

  TargetingTelemetry.bump(room, "shipCombatTargetSearches");
  const target = findTarget(room, ship, ships);
  ship.combatTargetId = target ? target.id : null;
  TargetingCadence.markAcquisitionCompleted(ship, "shipCombat", 0, now);
  return target;
}

// --- Spinal charge cycle ------------------------------------------------------
//
// A spinal mount does not fire on cooldown alone: it has to hold a firing
// solution for `chargeSeconds` first, and the charge is visible on the hull the
// whole time. Losing the solution does not instantly waste that work — the
// charge survives `chargeHoldSeconds` and only then bleeds away, so a target
// sidestepping for half a second does not reset ten seconds of aiming. Progress
// is 0..1 and is the exact value replicated to the client as the glow travelling
// up the barrel; nothing else may derive it.
const {
  finiteOr,
  spinalChargeProgress,
  decaySpinalCharge,
  clearSpinalCharge,
  spinalTraverseScale
} = require("./combat/spinal");

function updateShipWeapons(room, ship, ships, dt, now) {

  if (ship.launchPhase) {
    ship.combatTargetId = null;
    if (ship.weaponAimTargetIds) ship.weaponAimTargetIds.fill(null);
    if (ship.weaponFireTargetIds) ship.weaponFireTargetIds.fill(null);
    if (ship.weaponComponentTargetIds) ship.weaponComponentTargetIds.fill(null);
    if (ship.weaponCharge) ship.weaponCharge.fill(0);
    if (ship.weaponChargeIdle) ship.weaponChargeIdle.fill(0);
    return;
  }

  if (!ship.weaponCooldowns) {

    ship.weaponCooldowns = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  // Total cooldown committed by the last shot. Reload telegraph art compares
  // the remaining cooldown against this value so reduced Power/thermal output
  // produces a slower, truthful fill instead of a bar that appears stalled.
  if (!ship.weaponReloadDurations) {

    ship.weaponReloadDurations = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponAngles) {

    ship.weaponAngles = (ship.design || []).map(module => moduleRotationToRadians(normalizeRotation(module.rotation)));

  }

  // Which barrel each multi-barrel weapon fires next. Purely cosmetic: the
  // shot count, damage and cadence are unchanged, the rounds just alternate
  // between the visible tubes.

  if (!ship.weaponBarrelIndex) {

    ship.weaponBarrelIndex = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.beamEffectsAt) {

    ship.beamEffectsAt = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponDesiredAngles) {

    ship.weaponDesiredAngles = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponAimTargetIds) {

    ship.weaponAimTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponFireTargetIds) {

    ship.weaponFireTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponComponentTargetIds) {

    ship.weaponComponentTargetIds = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponComponentTargetIndices) {

    ship.weaponComponentTargetIndices = new Array(ship.design ? ship.design.length : 0).fill(-1);

  }

  if (!ship.weaponComponentRetargetAt) {

    ship.weaponComponentRetargetAt = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponBeamContacts) {

    ship.weaponBeamContacts = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  if (!ship.weaponInductionContacts) {

    ship.weaponInductionContacts = new Array(ship.design ? ship.design.length : 0).fill(null);

  }

  // Spinal charge state: seconds of charge accumulated, and seconds since the
  // mount last had a firing solution. Both are per weapon slot and are the only
  // authority for the charge glow the client renders.
  if (!ship.weaponCharge) {

    ship.weaponCharge = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  if (!ship.weaponChargeIdle) {

    ship.weaponChargeIdle = new Array(ship.design ? ship.design.length : 0).fill(0);

  }

  // Per-tick map of how much damage has already been committed to each fragile
  // target by point-defense weapons on this ship. It resets every tick so
  // multiple defensive weapons can coordinate without overkilling the same
  // missile. Stored on the room because it is shared across ships in the room.
  if (!room._pdReservations) room._pdReservations = new Map();
  room._pdReservations.clear();

  const weaponIndices = getShipComponentIndexes(ship).weaponIndices;

  const cache = TargetingTelemetry.withSampledDuration(room, now, ship, 0, "sampledProfileBuildDuration", () =>
    ensureEffectiveWeaponProfileCache(ship)
  );
  if (cache) {
    const prev = ship._effectiveWeaponProfileCacheRevision;
    if (prev !== cache.revision) {
      TargetingTelemetry.bump(room, "effectiveWeaponProfileCacheMisses");
      TargetingTelemetry.bump(room, "effectiveWeaponProfileBuilds");
      ship._effectiveWeaponProfileCacheRevision = cache.revision;
    } else {
      TargetingTelemetry.bump(room, "effectiveWeaponProfileCacheHits");
    }
  } else {
    TargetingTelemetry.bump(room, "effectiveWeaponProfileInvalidations");
  }

  for (const i of weaponIndices) {

    ship.weaponCooldowns[i] = Math.max(0, ship.weaponCooldowns[i] - dt);

  }



  // Safe zones block FIRING only — never aiming. Target acquisition and

  // turret traverse continue so protected ships visibly track threats instead

  // of freezing at the blueprint angle in spawn.

  const firingBlockedBySafeZone = isInSafeZone(room, ship.x, ship.y, ship);



  const target = getCadencedShipCombatTarget(room, ship, ships, now);



  weaponIndices.forEach((i) => {

    const module = ship.design[i];

    const part = PARTS[module.type];

    const isRepairBeam = module.type === "repairBeam";

    if (!part?.weapon && !isRepairBeam) return;

    if (!isComponentAlive(ship, i)) {

      // Destroyed weapons neither aim nor fire; the client freezes their art.

      ship.weaponAimTargetIds[i] = null;

      ship.weaponFireTargetIds[i] = null;

      clearWeaponComponentAim(ship, i);

      clearSpinalCharge(ship, i);

      if (ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      return;

    }

    const powerMultiplier = getComponentPowerMultiplier(ship, i);

    // Weapon traverse motors require Power; unpowered weapons cannot acquire

    // targets or rotate toward them.

    if (powerMultiplier <= 0) {

      ship.weaponAimTargetIds[i] = null;

      ship.weaponFireTargetIds[i] = null;

      clearWeaponComponentAim(ship, i);

      clearSpinalCharge(ship, i);

      if (ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      return;

    }



    const effectiveWeapon = isRepairBeam

      ? { type: "beam", arc: 360, range: ship.stats?.repairRange || 400, aimSpeed: TurretRules.turnRateFor("beam") }

      : (getEffectiveWeaponStatsCached(ship, i) || part.weapon);

    const family = effectiveWeapon.type || part.weapon?.type || "beam";

    const cooldown = ship.weaponCooldowns[i] || 0;

    // Spinal mounts bleed charge every tick they are not actively charging; the
    // firing branch below is the only thing that adds to it.
    const spinalConfig = effectiveWeapon.spinalCharge || null;

    const spinalProgress = spinalConfig ? decaySpinalCharge(ship, i, spinalConfig, dt) : 0;
    let spinalActivityHeatApplied = false;


    const arcRadians = (effectiveWeapon.arc || 360) * Math.PI / 180;

    const weaponOrigin = weaponModuleWorldPosition(ship, module);

    const worldX = weaponOrigin.x;

    const worldY = weaponOrigin.y;

    const range = effectiveWeapon.range || 0;



    const defaultRelative = moduleRotationToRadians(normalizeRotation(module.rotation));



    let currentPdTarget = null;

    let weaponTarget = null;

    let aimEntity = null;

    let aimPoint = null;

    let fireAimPoint = null;



    if (isRepairBeam) {

      let repairTarget = null;

      if (ship.repairTargetId) {

        const assigned = room.ships.get(ship.repairTargetId);

        if (assigned && assigned.alive && assigned.id !== ship.id && areAllies(room, ship.ownerId, assigned.ownerId)

          && (assigned.x - worldX) ** 2 + (assigned.y - worldY) ** 2 <= range * range) {

          repairTarget = assigned;

        }

      }

      if (!repairTarget) {

        let worst = 0;

        const candidates = room.spatialIndex

          ? room.spatialIndex.queryRange(

            "ships",

            worldX,

            worldY,

            range,

            room._weaponSupportSpatialScratch || (room._weaponSupportSpatialScratch = [])

          )

          : ships;

        const rangeSq = range * range;

        for (const other of candidates) {

          if (other.id === ship.id || !other.alive) continue;

          if (!areAllies(room, ship.ownerId, other.ownerId)) continue;

          const missing = shipRepairNeed(other);

          if (missing <= 0) continue;

          const dx = other.x - worldX;

          const dy = other.y - worldY;

          const distanceSq = dx * dx + dy * dy;

          if (distanceSq > rangeSq) continue;

          const distance = Math.sqrt(distanceSq);

          const urgency = missing / Math.max(1, distance * 0.08);

          if (urgency > worst) {

            repairTarget = other;

            worst = urgency;

          }

        }

      }

      aimEntity = repairTarget;

      if (aimEntity) aimPoint = { x: aimEntity.x, y: aimEntity.y };

    } else if (family === "flak" || family === "pointDefense") {

      // Defensive target selection uses the shared search cadence. A valid
      // tracked threat remains selected between searches; invalidation forces
      // a search immediately, with no separate reaction or switch timer.
      const worldWeaponAngle = (ship.angle || 0) + (ship.weaponAngles[i] || 0);
      const pdArcRadians = arcRadians;
      const pdBaseWeapon = part.weapon || effectiveWeapon;
      const pdTrackedId = ship.weaponFireTargetIds[i] ?? null;
      const pdTracked = pdTrackedId ? _lookupPointDefenceEntity(room, pdTrackedId) : null;
      const isPdCandidateValid = (candidate) => {
        if (!candidate) return false;
        const valid = Targeting.isPointDefenceTargetValid(room, ship.ownerId, candidate, effectiveWeapon.range || 0, now, {
          originX: worldX,
          originY: worldY,
          arcRadians: pdArcRadians,
          weaponAngle: worldWeaponAngle,
          reservations: room._pdReservations,
          priorityList: pdBaseWeapon.targetPriority,
          team: ship.team
        });
        if (!valid) return false;
        return !TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledLineOfSightDuration", () =>
          isLineBlocked(room, worldX, worldY, candidate.entity.x, candidate.entity.y, 4)
        );
      };
      let pdCurrentValid = false;
      if (pdTracked) {
        pdCurrentValid = isPdCandidateValid(pdTracked);
        if (!pdCurrentValid) TargetingTelemetry.bump(room, "pointDefenceImmediateReacquisitions");
      }

      const pdDue = TargetingCadence.isAcquisitionDue(ship, "pointDefence", i, now);
      const pdForce = pdTrackedId !== null && !pdCurrentValid;
      if (pdCurrentValid && !pdDue) {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
        currentPdTarget = pdTracked;
      } else if (!pdDue && !pdForce) {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
        currentPdTarget = null;
      } else {
        TargetingTelemetry.bump(room, "pointDefenceTargetSearches");
        currentPdTarget = findPointDefenseTarget(room, worldX, worldY, ship.ownerId, effectiveWeapon, ships, ship.id, now);
        TargetingCadence.markAcquisitionCompleted(ship, "pointDefence", i, now);
      }

      aimEntity = currentPdTarget ? currentPdTarget.entity : null;
      if (!aimEntity) clearWeaponComponentAim(ship, i);

    } else {

      // Keep the ship's assigned target when this weapon can reach it, otherwise

      // fall back to any valid enemy already in this weapon's range so it does

      // not idle while the primary target is out of reach. The assigned target

      // itself is retained at the ship level and resumed once it is attackable.

      // Fire-Control target selection remains cadence-limited, but a newly
      // selected valid target can be fired at immediately once other weapon
      // requirements are satisfied.
      weaponTarget = getCadencedWeaponTarget(room, ship, ships, worldX, worldY, target, range, { weapon: effectiveWeapon, module }, i, now, "ordinaryShip");
      aimEntity = weaponTarget || (target && target.alive !== false && !target.destroyed ? target : null);

      if (aimEntity) {

        if (family === "beam") {

          if (isInductionBeam(effectiveWeapon)) {

            aimPoint = getInductionAimPoint(room, ship, i, aimEntity, now, worldX, worldY, effectiveWeapon);

          } else {

            aimPoint = targetCoreAimWorldPosition(aimEntity, worldX, worldY);

          }

          if (aimPoint && effectiveWeapon.accuracy < 1 && !isInductionBeam(effectiveWeapon)) {

            const maxErrorRad = weaponSpreadRadians(effectiveWeapon);

            const seed = (((String(ship.id).split("").reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)) & 0x7fffffff) + i * 37) % 1000;

            const smoothError = maxErrorRad * Math.sin(seed + now * 0.0015);

            aimPoint = {

              ...aimPoint,

              smoothError

            };

          }

          if (!aimPoint) {

            aimEntity = null;

            clearWeaponComponentAim(ship, i);

          } else if (weaponTarget && aimEntity === weaponTarget) {

            fireAimPoint = aimPoint;

          }

        } else {

          aimPoint = weaponComponentAimPoint(room, ship, i, aimEntity, now);

          if (weaponTarget && aimEntity === weaponTarget) fireAimPoint = aimPoint;

        }

      } else {

        clearWeaponComponentAim(ship, i);

      }

    }



    // The desired angle is clamped by the weapon's fixed blueprint arc: targets

    // outside the arc are not tracked. With no valid aim target the turret

    // sweeps back toward its blueprint facing (rotateToward keeps this smooth —

    // it never snaps).

    let desiredRelative = defaultRelative;

    let isTracking = false;

    if (aimEntity) {

      const aimX = aimPoint ? aimPoint.x : aimEntity.x;

      const aimY = aimPoint ? aimPoint.y : aimEntity.y;

      let worldAngleToTarget = Math.atan2(aimY - worldY, aimX - worldX);

      if (aimPoint?.smoothError) {

        worldAngleToTarget += aimPoint.smoothError;

      }

      const relativeAngleToTarget = angleDifference(ship.angle, worldAngleToTarget);

      const diff = angleDifference(defaultRelative, relativeAngleToTarget);

      if (Math.abs(diff) <= arcRadians / 2) {

        desiredRelative = relativeAngleToTarget;

        isTracking = true;

      }

    }



    const turnRate = getWeaponTurnRate(effectiveWeapon)
      * (spinalConfig ? spinalTraverseScale(spinalConfig, spinalProgress) : 1);

    const currentRelative = ship.weaponAngles[i] !== undefined ? ship.weaponAngles[i] : defaultRelative;

    ship.weaponAngles[i] = TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponAimDuration", () =>
      rotateToward(currentRelative, desiredRelative, turnRate * dt)
    );



    // Development/diagnostic trace of the aim decision (cheap flat writes; read

    // by buildShipTurretDiagnostics and the dev debug endpoint).

    ship.weaponDesiredAngles[i] = desiredRelative;

    ship.weaponAimTargetIds[i] = isTracking && aimEntity ? aimEntity.id ?? null : null;

    ship.weaponFireTargetIds[i] = isRepairBeam ? (isTracking && aimEntity ? aimEntity.id ?? null : null)

      : (family === "pointDefense" || family === "flak"

        ? (currentPdTarget ? currentPdTarget.entity.id ?? null : null)

        : (weaponTarget ? weaponTarget.id ?? null : null));



    if (isRepairBeam) return;



    // ---- Firing permission (independent of aiming) ----

    // Protected ships never fire: no projectile, no beam damage, no firing

    // heat, and the cooldown is not consumed as though a shot fired.

    if (firingBlockedBySafeZone) return;



    // Unpowered weapons cannot traverse or fire and clear their targeting state.

    // Powered but thermally disabled weapons may keep tracking, but cannot fire.

    const heatMultiplier = componentPerformance(ship, i);

    const activityMultiplier = powerMultiplier * heatMultiplier;

    if (activityMultiplier <= 0) {

      if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;

      return;

    }

    if (spinalConfig
      && spinalProgress > 0
      && (ship.weaponChargeIdle[i] || 0) <= Math.max(0, finiteOr(spinalConfig.chargeHoldSeconds, 0))) {
      addComponentHeat(ship, i, HeatRules.activityHeat(module.type, part) * activityMultiplier * dt);
      spinalActivityHeatApplied = true;
    }



    // Tracking is continuous while reloading. Only firing is cooldown-gated;

    // otherwise the visible turret freezes between shots and snaps at fire time.

    if (cooldown > 0) {

      if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;

      return;

    }



    // Fire only at an in-range target the turret is actually tracking in-arc.

    if (family === "pointDefense" || family === "flak") {

      if (!currentPdTarget || !isTracking) return;

    } else {

      if (!weaponTarget || !isTracking || aimEntity !== weaponTarget) {

        if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;

        return;

      }

    }



    const worldWeaponAngle = ship.angle + ship.weaponAngles[i];

    const targetEntity = family === "pointDefense" || family === "flak" ? currentPdTarget.entity : weaponTarget;

    const targetAimX = fireAimPoint ? fireAimPoint.x : targetEntity.x;

    const targetAimY = fireAimPoint ? fireAimPoint.y : targetEntity.y;

    const targetDistance = fastHypot(targetAimX - worldX, targetAimY - worldY);
    if (targetDistance > range) {
      if (family === "beam" && ship.weaponBeamContacts) ship.weaponBeamContacts[i] = null;

      if (ship.weaponInductionContacts) ship.weaponInductionContacts[i] = null;
      return;
    }

    const worldAngleToTarget = Math.atan2(targetAimY - worldY, targetAimX - worldX);

    const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));

    if (family !== "beam" && angleErr > TurretRules.FIRING_ALIGNMENT_TOLERANCE) return;



    const spreadScale = weaponSpreadRadians(effectiveWeapon);

    const spread = rngRange(roomCombatRandom(room), -spreadScale, spreadScale);

    const shotAngle = worldWeaponAngle + spread;



    const barrelIndex = ship.weaponBarrelIndex?.[i] || 0;

    const muzzle = weaponMuzzleWorldPosition(ship, module, worldWeaponAngle, family, barrelIndex);



    if (family === "blaster") {

      const speed = effectiveWeapon.projectileSpeed || 620;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      // One trigger pull, one or more projectiles. `damage` is per pellet, so a
      // Scatter Cannon pays the armour flat reduction on every pellet — that is
      // the whole point of the weapon and must not be collapsed into one shot.
      const pellets = pelletShotCount(effectiveWeapon);

      const pelletCone = pellets > 1
        ? Math.max(0, Number(effectiveWeapon.pelletSpreadDegrees) || 0) * Math.PI / 180
        : 0;

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => {

        for (let pellet = 0; pellet < pellets; pellet += 1) {

          const pelletAngle = pelletCone > 0
            ? shotAngle + rngRange(roomCombatRandom(room), -pelletCone, pelletCone)
            : shotAngle;

          addBullet(room, {

            type: "bolt",

            // Presentation only: lets the client size the tracer by weapon.
            subtype: module.type,

            ownerId: ship.ownerId,

            targetId: weaponTarget.id,

            targetComponentIndex: fireAimPoint?.componentIndex ?? -1,

            x: muzzle.x,

            y: muzzle.y,

            vx: Math.cos(pelletAngle) * speed,

            vy: Math.sin(pelletAngle) * speed,

            damage: effectiveWeapon.damage,

            shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

            hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

            ...impactPayload(effectiveWeapon),

            life: life,

            bornAt: now

          });

        }

      });

      ship.weaponCooldowns[i] = reload;

      // Cosmetic only: hand the next round to the other tube of a twin mount.

      if (ship.weaponBarrelIndex) {

        ship.weaponBarrelIndex[i] = (barrelIndex + 1) % TurretRules.barrelCount(module.type);

      }

      addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

    } else if (family === "missile") {

      const speed = effectiveWeapon.projectileSpeed || 330;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

        type: "missile",

        subtype: module.type,

        interceptable: true,

        hp: effectiveWeapon.missileHp || 20,

        ownerId: ship.ownerId,

        targetId: weaponTarget.id,

        targetComponentIndex: fireAimPoint?.componentIndex ?? -1,

        x: muzzle.x,

        y: muzzle.y,

        vx: Math.cos(shotAngle) * speed,

        vy: Math.sin(shotAngle) * speed,

        damage: effectiveWeapon.damage,

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        tracking: effectiveWeapon.tracking ?? 0.75,

        trackRemaining: effectiveWeapon.trackTime ?? 1.4,

        trackingDelay: effectiveWeapon.trackingDelay ?? 0.25,

        projectileSpeed: speed,

        life: life,

        bornAt: now,

        age: 0

      });

    });

      ship.weaponCooldowns[i] = reload;

      addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

    } else if (family === "beam" && isInductionBeam(effectiveWeapon)) {

      fireInductionLance(room, ship, i, weaponTarget, muzzle, worldWeaponAngle, effectiveWeapon, part, dt, now, activityMultiplier, powerMultiplier);

    } else if (family === "beam") {

      const rangeVal = effectiveWeapon.range;

      const beamRadius = effectiveWeapon.radius || 28;

      const beamEnd = beamImpactPoint(room, muzzle.x, muzzle.y, worldWeaponAngle, rangeVal, beamRadius);

      const beamPerformance = activityMultiplier;

      const baseFireRate = Number(part.weapon.fireRate) || 0;

      const effectiveFireRate = Number(effectiveWeapon.fireRate) || baseFireRate;

      // Continuous beams do not spend cooldowns; Fire Control's per-weapon

      // fire-rate allocation is interpreted exactly once as sustained output.

      const dataFireRateFactor = baseFireRate > 0 ? effectiveFireRate / baseFireRate : 1;

      const prevContact = ship.weaponBeamContacts[i];

      const charge = beamContactCharge(prevContact, weaponTarget?.id, worldWeaponAngle, effectiveWeapon);

      const beamResult = TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledBeamProcessingDuration", () =>
        damageBeamTargets(room, ship, ships, muzzle.x, muzzle.y, beamEnd.x, beamEnd.y, beamRadius, effectiveWeapon.damage * dataFireRateFactor * beamPerformance * charge.multiplier * dt, now, {

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        burnThroughCarryMultiplier: effectiveWeapon.burnThroughCarryMultiplier,

        impactHeatPerDamage: effectiveWeapon.impactHeatPerDamage,

        beamDeltaSeconds: dt,

        weaponIndex: i

      })

    );



      const firstHitIndex = beamResult?.firstHitIndex ?? -1;

      // A physical component contact sustains the weapon's aimed-target lock.

      // In tightly overlapping formations the nearest-entity resolver may name

      // a neighbouring blocker, but resetting the aimed beam here makes charge

      // flicker and breaks the established targeting contract.

      const hitIntendedTarget = Boolean(

        weaponTarget

        && (beamResult?.hitTargetShipId === weaponTarget.id || firstHitIndex >= 0)

      );

      const targetChanged = !hitIntendedTarget || (prevContact && prevContact.targetShipId !== weaponTarget.id);

      const angleShifted = prevContact && Math.abs(angleDifference(prevContact.contactAngle, worldWeaponAngle)) > 0.05;



      if (!prevContact || targetChanged || angleShifted) {

        ship.weaponBeamContacts[i] = hitIntendedTarget ? {

          targetShipId: weaponTarget.id,

          firstHitComponentIndex: firstHitIndex,

          contactAngle: worldWeaponAngle,

          contactDuration: dt

        } : null;

      } else if (prevContact) {

        prevContact.contactDuration += dt;

        prevContact.contactAngle = worldWeaponAngle;

        prevContact.firstHitComponentIndex = firstHitIndex;

      }



      const effectX2 = beamResult?.hitX ?? beamEnd.x;

      const effectY2 = beamResult?.hitY ?? beamEnd.y;



      addComponentHeat(ship, i, HeatRules.activityHeat(module.type, part) * activityMultiplier * dt);

      if (now - (ship.beamEffectsAt[i] || 0) > 55) {

        ship.beamEffectsAt[i] = now;

        room.effects.push({

          type: "beam",

          ownerId: ship.ownerId,

          x: muzzle.x,

          y: muzzle.y,

          x2: effectX2,

          y2: effectY2,

          radius: beamRadius,

          charge: charge.progress,

          at: now

        });

      }

    } else if (family === "flak") {

      if (currentPdTarget) {

        const speed = effectiveWeapon.projectileSpeed || 850;

        const life = (effectiveWeapon.projectileLifetime || 0) > 0

          ? effectiveWeapon.projectileLifetime

          : (effectiveWeapon.range || 0) / speed;

        const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

        const targetEnt = currentPdTarget.entity;
        const targetType = currentPdTarget.type;
        const reserved = room._pdReservations.get(targetEnt.id) || 0;
        const baseHp = targetType === "projectile" ? (targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20))
                       : targetType === "drone" ? (targetEnt.hull || 0)
                       : targetType === "decoy" ? 1
                       : Infinity;
        if (baseHp - reserved <= 0.001) {
          currentPdTarget = null;
          return;
        }
        const blastDamage = effectiveWeapon.blastDamage ?? effectiveWeapon.damage ?? 0;
        const expectedDamage = Number.isFinite(baseHp) ? Math.min(blastDamage, Math.max(0, baseHp - reserved)) : 0;
        if (expectedDamage > 0) room._pdReservations.set(targetEnt.id, reserved + expectedDamage);

        TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

          type: "flak",

          subtype: module.type,

          ownerId: ship.ownerId,

          targetId: targetEnt.id,

          x: muzzle.x,

          y: muzzle.y,

          vx: Math.cos(shotAngle) * speed,

          vy: Math.sin(shotAngle) * speed,

          damage: effectiveWeapon.directDamage ?? effectiveWeapon.damage ?? 0,

          blastDamage: effectiveWeapon.blastDamage ?? 0,

          blastRadius: effectiveWeapon.blastRadius ?? 0,

          proximityFuseRadius: effectiveWeapon.proximityFuseRadius ?? 0,

          innerFullDamageRadius: effectiveWeapon.innerFullDamageRadius ?? 0,

          falloffExponent: effectiveWeapon.falloffExponent ?? 1,

          shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

          hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

          life: life,

          bornAt: now

        });

        });

        ship.weaponCooldowns[i] = reload;

        addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

      }

    } else if (family === "pointDefense") {

      if (currentPdTarget) {

         const isHitscanLaserPd = module.type === "pointDefense" || (Number(effectiveWeapon.projectileSpeed) || 0) === 0;

         if (isHitscanLaserPd) {

            const targetEnt = currentPdTarget.entity;

            if (!TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledLineOfSightDuration", () => isLineBlocked(room, muzzle.x, muzzle.y, targetEnt.x, targetEnt.y, 4))) {

               const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

               const damage = effectiveWeapon.damage;

               const targetType = currentPdTarget.type;
               const reserved = room._pdReservations.get(targetEnt.id) || 0;
               const baseHp = targetType === "projectile" ? (targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20))
                              : targetType === "drone" ? (targetEnt.hull || 0)
                              : targetType === "decoy" ? 1
                              : Infinity;
               if (baseHp - reserved <= 0.001) {
                  currentPdTarget = null;
                  return;
               }
               room._pdReservations.set(targetEnt.id, reserved + damage);

               if (currentPdTarget.type === "drone") {

                  require("./drones").damageDrone(room, targetEnt, damage, ship.ownerId, now);

               } else if (currentPdTarget.type === "projectile") {

                  const projHp = targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20);

                  targetEnt.hp = projHp - damage;

                  if (targetEnt.hp <= 0.001) {

                     removeProjectileRuntime(room, targetEnt, "intercepted", targetEnt.x, targetEnt.y);

                     room.effects.push({ type: "pdIntercept", x: targetEnt.x, y: targetEnt.y, at: now });

                  }

               } else if (currentPdTarget.type === "ship") {

                  const mult = Number(effectiveWeapon.shipDamageMultiplier ?? 0.04);

                  damageShip(room, targetEnt, damage * mult, ship.ownerId, now, muzzle.x, muzzle.y);

               }



               room.effects.push({ type: "laserPdPulse", x: muzzle.x, y: muzzle.y, x2: targetEnt.x, y2: targetEnt.y, at: now });

               room.effects.push({ type: "spark", x: targetEnt.x, y: targetEnt.y, at: now });



               ship.weaponCooldowns[i] = reload;

                addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

            }

         } else {

            const speed = effectiveWeapon.projectileSpeed || 1000;

            const life = (effectiveWeapon.range || 0) / speed;

            const targetEnt = currentPdTarget.entity;

            const targetType = currentPdTarget.type;
            const reserved = room._pdReservations.get(targetEnt.id) || 0;
            const baseHp = targetType === "projectile" ? (targetEnt.hp !== undefined ? targetEnt.hp : (targetEnt.damage || 20))
                           : targetType === "drone" ? (targetEnt.hull || 0)
                           : targetType === "decoy" ? 1
                           : Infinity;
            if (baseHp - reserved <= 0.001) {
               currentPdTarget = null;
               return;
            }
            const pdDamage = effectiveWeapon.damage;
            room._pdReservations.set(targetEnt.id, reserved + pdDamage);

            const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

            const pdSpreadScale = weaponSpreadRadians(effectiveWeapon);

            const pdDx = targetEnt.x - muzzle.x;

            const pdDy = targetEnt.y - muzzle.y;

            const pdDist = fastHypot(pdDx, pdDy);

            const pdFlightTime = pdDist / Math.max(1, speed);

            const pdAimX = targetEnt.x + (targetEnt.vx || 0) * pdFlightTime;

            const pdAimY = targetEnt.y + (targetEnt.vy || 0) * pdFlightTime;

            const shotAngle = Math.atan2(pdAimY - muzzle.y, pdAimX - muzzle.x) + rngRange(roomCombatRandom(room), -pdSpreadScale, pdSpreadScale);



            TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

               type: "pdShot",

               subtype: module.type,

               ownerId: ship.ownerId,

               targetId: targetEnt.id,

               x: muzzle.x,

               y: muzzle.y,

               vx: Math.cos(shotAngle) * speed,

               vy: Math.sin(shotAngle) * speed,

               damage: pdDamage,

               shipDamageMultiplier: effectiveWeapon.shipDamageMultiplier ?? 0.05,

               shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

               hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

               pdTargetType: currentPdTarget.type,

               pdTargetId: targetEnt.id,

               life: life,

               bornAt: now

            });

            });

            ship.weaponCooldowns[i] = reload;

             addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

         }

      }

    } else if (family === "emp") {
      const speed = effectiveWeapon.projectileSpeed || 550;
      const rangeVal = effectiveWeapon.range || 800;
      const life = rangeVal / speed;
      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {
        type: "emp",
        subtype: module.type,
        ownerId: ship.ownerId,
        targetId: weaponTarget.id,
        targetComponentIndex: fireAimPoint?.componentIndex ?? -1,
        x: muzzle.x,
        y: muzzle.y,
        vx: Math.cos(shotAngle) * speed,
        vy: Math.sin(shotAngle) * speed,
        projectileSpeed: speed,
        damage: 0,
        radius: effectiveWeapon.projectileRadius || effectiveWeapon.radius || 9,
        shieldDisruptionFraction: effectiveWeapon.shieldDisruptionFraction ?? 0.5,
        life,
        bornAt: now
      });
      });

      ship.weaponCooldowns[i] = reload;
      ship.weaponReloadDurations[i] = reload;
      addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

    } else if (family === "railgun") {

      // A spinal mount spends this tick charging instead of firing until the
      // accumulator is full. It only reaches here with a live, tracked, in-arc,
      // in-range firing solution, which is exactly the condition the charge is
      // meant to require.
      if (spinalConfig) {

        ship.weaponChargeIdle[i] = 0;

        const chargeSeconds = Math.max(0.05, finiteOr(spinalConfig.chargeSeconds, 10));

        ship.weaponCharge[i] = Math.min(chargeSeconds, (ship.weaponCharge[i] || 0) + dt);

        const progress = clampNumber(ship.weaponCharge[i] / chargeSeconds, 0, 1);

        if (!spinalActivityHeatApplied) {
          addComponentHeat(ship, i, HeatRules.activityHeat(module.type, part) * activityMultiplier * dt);
          spinalActivityHeatApplied = true;
        }

        if (progress < 1) {

          return;

        }

      }

      const speed = effectiveWeapon.projectileSpeed || 1080;

      const rangeVal = effectiveWeapon.range;

      const life = rangeVal / speed;

      const reload = weaponReloadSeconds(effectiveWeapon, activityMultiplier);

      const penetrationProfile = spinalConfig?.penetrationProfile;

      TargetingTelemetry.withSampledDuration(room, now, ship, i, "sampledWeaponFiringDuration", () => { addBullet(room, {

        type: "rail",

        subtype: module.type,

        ownerId: ship.ownerId,

        targetId: weaponTarget.id,

        targetComponentIndex: fireAimPoint?.componentIndex ?? -1,

        x: muzzle.x,

        y: muzzle.y,

        vx: Math.cos(shotAngle) * speed,

        vy: Math.sin(shotAngle) * speed,

        damage: effectiveWeapon.damage,

        shieldDamageMultiplier: effectiveWeapon.shieldDamageMultiplier ?? 1,

        hullDamageMultiplier: effectiveWeapon.hullDamageMultiplier ?? 1,

        ...impactPayload(effectiveWeapon),

        ...(penetrationProfile ? { penetrationProfile } : {}),

        life: life,

        bornAt: now

      });

    });

      ship.weaponCooldowns[i] = reload;
      ship.weaponReloadDurations[i] = reload;

      if (spinalConfig) {

        clearSpinalCharge(ship, i);

        addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

        room.effects.push({ type: "railhit", subtype: "spinal", x: muzzle.x, y: muzzle.y, at: now });

      } else {

        addComponentHeat(ship, i, HeatRules.heatPerShot(module.type, part));

      }

    }

  });

}



// Projectiles per trigger pull. Anything below two is a single shot, so the
// ordinary firing path never has to know about multi-pellet weapons.


// Delivery properties a projectile carries beyond raw damage: Heat coupled into
// whatever it strikes (Plasma Cannon) and an impact burst around the hit point
// (Fragmentation Cannon). Returned as a spreadable payload so each firing branch
// stays a flat bullet literal.





const {
  moduleRotationToRadians,
  moduleLocalPosition,
  moduleFootprintLocalPosition,
  weaponFacingAngle,
  weaponModuleWorldPosition,
  weaponMuzzleDistance,
  weaponMuzzleWorldPosition
} = require("./combat/weaponGeometry");
const {
  beamImpactPoint,
  beamContactCharge,
  applyBeamHullDamage,
  damageBeamTargets
} = require("./combat/beams").createBeamRuntime({
  damageShip: (...args) => damageShip(...args),
  isInSafeZone,
  asteroidBroadPhase,
  roomScratch,
  areEnemies
});














// A beam ray damages only the nearest blocking entity. All candidate blockers —

// asteroids, active shield bubbles, living ship components, and living drones —

// are collected into one ordered list, sorted by ray parameter (with a

// deterministic tie-break), and only the nearest one is resolved. The visible

// beam stops at that same impact point. This guarantees:

//   - a drone in front of a ship absorbs the beam and shields the ship,

//   - an asteroid blocks both damage and the visual beam,

//   - burn-through never continues into a second ship or drone,

//   - a shielded ship in front takes only its shield's damage.

// Burn-through (into at most one further component) is still resolved, but only

// inside the single nearest ship that was hit.

// Tie-break ranks preserve the previous `"a:"` / `"d:"` / `"s:"` string keys

// exactly ('a' < 'd' < 's'), without building a key string per candidate per

// beam per tick. Shield and component hits deliberately share the ship rank,

// as they shared the `s:` prefix before.







const {
  applyDirectComponentDamage,
  damageShip
} = require("./combat/damage").createDamageRuntime({
  isInSafeZone,
  applyBeamHullDamage,
  evaluateShipCommandState,
  destroyShip
});





function isDamageFromFront(ship, sourceX, sourceY, frontArcDegrees) {

  const angleToSource = Math.atan2(sourceY - ship.y, sourceX - ship.x);

  const diff = Math.abs(angleDifference(ship.angle, angleToSource));

  return diff <= (frontArcDegrees * Math.PI / 180) / 2;

}



// isTargetInWeaponArc now lives in mainBattery.js.

// hold-facing helpers now live in mainBattery.js.

// This signature intentionally contains no weapon cooldowns. Cooldown affects
// the next shot, not which hull orientation gives the best sustained coverage.




// `groupRange` opts in to measuring the guns that this heading brings to bear
// but that are still short of the target. Left at Infinity nothing qualifies and
// an out-of-range weapon is dropped as cheaply as it always was; movement passes
// a real threshold when it needs to know how much further the hull has to come.





















function evaluateShipCommandState(room, ship, now, attackerId = null) {

  if (!ship || ship.alive === false || ship.destroyFinalizedAt) return false;

  const componentIndexes = getShipComponentIndexes(ship);

  const mainCoreIdx = componentIndexes.mainCoreIndex;

  const mainCoreAlive = mainCoreIdx >= 0 && (ship.componentHp?.[mainCoreIdx] ?? 0) > 0;



  if (mainCoreAlive) {

    ship.coreDestroyed = false;

    ship.commandState = "mainCore";

    ship.emergencyReserveUntil = null;

    return true;

  }

  if (mainCoreIdx < 0) {
    ship.coreDestroyed = false;
    return false;
  }



  // Main Core is destroyed

  ship.coreDestroyed = true;

  const backupCoreIdx = componentIndexes.backupCoreIndex;

  const backupCoreAlive = backupCoreIdx >= 0 && (ship.componentHp?.[backupCoreIdx] ?? 0) > 0;



  if (!backupCoreAlive) {

    ship.commandState = "noCommand";

    destroyShip(room, ship, attackerId || ship.lastDamagedBy, now);

    return false;

  }



  const { getComponentPowerMultiplier, reallocateShipPower } = require("./componentPower");

  reallocateShipPower(ship, "commandState");

  const powerMult = getComponentPowerMultiplier(ship, backupCoreIdx);

  const isBackupPowered = powerMult > 0;



  if (isBackupPowered) {

    const wasBackup = ship.commandState === "backupCore";

    ship.commandState = "backupCore";

    ship.emergencyReserveUntil = null;

    if (!wasBackup && room && room.effects) {

      room.effects.push({

        type: "text",

        text: "BACKUP COMMAND ACTIVE",

        x: ship.x,

        y: ship.y,

        at: now

      });

      room.effects.push({

        type: "burst",

        x: ship.x,

        y: ship.y,

        at: now

      });

    }

    return true;

  }



  // Backup Core is alive but unpowered (Power interruption)

  ship.commandState = "backupCore";

  if (!ship.emergencyReserveUntil) {

    ship.emergencyReserveUntil = now + 2000;

  }



  if (now >= ship.emergencyReserveUntil) {

    destroyShip(room, ship, attackerId || ship.lastDamagedBy, now);

    return false;

  }



  return true;

}



function destroyShip(room, ship, attackerId, now) {

  if (!ship || ship.destroyFinalizedAt || ship.removed) return false;

  ship.destroyFinalizedAt = now;

  ship.removeAt = now + 3200;

  proximityChargeDestroyedShip(room, ship, now);

  ship.alive = false;

  require("./commandAuras").invalidateCommandAuraSource(room, ship, "destroyed");

  ship.hp = 0;

  room.spatialIndex?.remove?.("ships", ship);
  require("./movementContactPairs").removeShipFromMovementContactPairs(room, ship);

  zeroAllComponents(ship);

  ship.shield = 0;

  ship.weaponComponentTargetIds = null;

  ship.weaponComponentTargetIndices = null;

  ship.weaponComponentRetargetAt = null;

  ship._weaponTargetState = null;
  ship._targetAcquisitionSchedule = null;
  ship._targetAcquisitionOffsets = null;
  ship._effectiveWeaponProfileCacheRevision = null;
  ship._pdThreatSet = null;
  ship.effectiveWeaponProfileCache = null;

  ship.vx *= 0.25;

  ship.vy *= 0.25;

  room.effects.push({ type: "boom", x: ship.x, y: ship.y, at: now });



  const victim = room.players.get(ship.ownerId);

  if (victim) {

    victim.losses += 1;

    victim.lostFleetCost += ship.cost || ship.stats?.unitCost || 0;

  }



  const attacker = room.players.get(attackerId);

  if (attacker && attacker.id !== ship.ownerId) {

    const bounty = Math.max(ECONOMY.killBountyMin, Math.round((ship.cost || ship.stats?.unitCost || 100) * ECONOMY.killBountyRatio));

    attacker.kills += 1;

    attacker.destroyedEnemyCost += ship.cost || ship.stats?.unitCost || 0;

    attacker.money = Math.min(attacker.maxMoney || ECONOMY.maxMoney, attacker.money + bounty);

    attacker.earned += bounty;

  }

  return true;

}



// Fast-repeating damage (beams tick 30x/s) accumulates into the most recent

// floating number instead of spawning a new effect per tick, which keeps the

// effects array (and its share of every snapshot) small.




// Self-destruct: the player scuttles their own ships. Each flagged ship charges

// for SELF_DESTRUCT_MS (emitting charge sparks so the client can animate the

// warning) and then detonates and is removed.

const SELF_DESTRUCT_MS = 1400;



function requestSelfDestruct(room, player, shipIds, now) {
  now = gameplayNow(room, now || performanceNow());

  const { selectOwnedLivingShips } = require("./selection");

  const selected = selectOwnedLivingShips(player, shipIds, { allowOmittedAll: false });

  if (!selected.ok) return 0;

  let count = 0;

  for (const ship of selected.ships) {

    if (ship.selfDestructAt) continue;

    ship.selfDestructStart = now;

    ship.selfDestructAt = now + SELF_DESTRUCT_MS;

    ship.nextDestructSparkAt = 0;

    count += 1;

  }

  return count;

}



function updateSelfDestructingShips(room, now) {

  for (const ship of room.ships.values()) {

    if (!ship.selfDestructAt || !ship.alive) continue;

    if (now >= ship.nextDestructSparkAt) {

      ship.nextDestructSparkAt = now + 120;

      room.effects.push({ type: "destructcharge", x: ship.x, y: ship.y, at: now, radius: ship.radius });

    }

    if (now >= ship.selfDestructAt) detonateSelfDestruct(room, ship, now);

  }

}



function detonateSelfDestruct(room, ship, now) {

  if (!ship || ship.destroyFinalizedAt || ship.removed) return false;

  ship.destroyFinalizedAt = now;

  ship.selfDestructAt = 0;

  ship.alive = false;

  require("./commandAuras").invalidateCommandAuraSource(room, ship, "self-destruct");

  ship.hp = 0;

  room.spatialIndex?.remove?.("ships", ship);
  require("./movementContactPairs").removeShipFromMovementContactPairs(room, ship);

  zeroAllComponents(ship);

  ship.shield = 0;

  ship.weaponComponentTargetIds = null;

  ship.weaponComponentTargetIndices = null;

  ship.weaponComponentRetargetAt = null;

  ship.vx *= 0.2;

  ship.vy *= 0.2;

  ship.removeAt = now + 700;

  room.effects.push({ type: "boom", x: ship.x, y: ship.y, at: now });

  room.effects.push({ type: "selfdestruct", x: ship.x, y: ship.y, at: now, radius: ship.radius });



  const victim = room.players.get(ship.ownerId);

  if (victim) {

    victim.losses += 1;

    victim.lostFleetCost += ship.cost || ship.stats?.unitCost || 0;

  }

  return true;

}



function updateDestroyedShips(room, now) {

  for (const player of room.players.values()) {

    let removedAny = false;

    for (const ship of player.ships) {

      if (ship.alive && !ship.removed && !ship.launchPhase) {

        evaluateShipCommandState(room, ship, now);

      }

      if (!ship.alive && !ship.removed && ship.removeAt && now >= ship.removeAt) {

        ship.removed = true;

        ship.weaponComponentTargetIds = null;

        ship.weaponComponentTargetIndices = null;

        ship.weaponComponentRetargetAt = null;

        invalidateShipCollisionGeometry(ship);

        room.spatialIndex?.remove?.("ships", ship);
        require("./movementContactPairs").removeShipFromMovementContactPairs(room, ship);

        room.ships.delete(ship.id);

        removedAny = true;

      }

    }

    if (removedAny) {

      player.ships = player.ships.filter((ship) => !ship.removed);

      Relationships.revalidateTelemetryFocusForRoom(room);

    }

  }

}



// How far a ship will reach out to pick a target of its own accord: its longest
// operational weapon, plus a small margin so it starts tracking something a
// moment before it can shoot it rather than exactly as it comes into range.
// A ship must never acquire across the map -- what it cannot shoot, it does not
// chase.
const {
  maxShipWeaponAcquisitionRange,
  enemyShipThreatScore,
  findTarget,
  canWeaponDefensivelyTargetDrones,
  droneThreatScore,
  pickWeaponFireTarget,
  getCadencedWeaponTarget
} = require("./combat/targeting").createTargetingRuntime({
  // targeting owns the sensorRangeMultiplier acquisition-range adjustment.
  isLineBlocked,
  isTargetInWeaponArc,
  getWeaponTurnRate
});









































function areAllies(room, ownerA, ownerB) {

  return Relationships.areAllies(room, ownerA, ownerB);

}



function areEnemies(room, ownerA, ownerB) {

  return Relationships.areEnemies(room, ownerA, ownerB);

}





// Development/test diagnostics for turret aiming: one entry per weapon module

// with the full aim/fire decision state for the ship's latest tick. Used by

// the dev-only /debug/turrets endpoint and the turret verification tests.

// Never included in normal production snapshots.

function buildShipTurretDiagnostics(room, ship) {

  const entries = [];

  const safeZoneFiringBlocked = isInSafeZone(room, ship.x, ship.y, ship);

  (ship.design || []).forEach((module, i) => {

    const part = PARTS[module.type];

    if (!part?.weapon) return;

    const defaultRelativeAngle = moduleRotationToRadians(normalizeRotation(module.rotation));

    const rawCurrent = ship.weaponAngles?.[i];

    const currentRelativeAngle = Number.isFinite(rawCurrent) ? rawCurrent : null;

    const rawDesired = ship.weaponDesiredAngles?.[i];

    const desiredRelativeAngle = Number.isFinite(rawDesired) ? rawDesired : null;

    const aimTargetId = ship.weaponAimTargetIds?.[i] ?? null;

    const fireTargetId = ship.weaponFireTargetIds?.[i] ?? null;

    const effectiveWeapon = getEffectiveWeaponStatsInternal(ship, i) || part.weapon;

    const range = effectiveWeapon.range || 0;

    const arcRadians = (effectiveWeapon.arc || 360) * Math.PI / 180;

    const origin = weaponModuleWorldPosition(ship, module);



    // Distance/range/arc are evaluated against the aim target when it is a

    // ship the room still knows about (PD bullet targets have no ship entry).

    const targetEntity = aimTargetId
      ? room.ships?.get?.(aimTargetId)
        || room.stationsById?.get?.(aimTargetId)
        || room.stations?.find?.((station) => station?.id === aimTargetId)
        || null
      : null;

    let targetDistance = null;

    let inFiringRange = null;

    let inFixedArc = null;

    if (targetEntity) {

      const targetPoint = targetAttackPoint(origin.x, origin.y, targetEntity);
      targetDistance = fastHypot(targetPoint.x - origin.x, targetPoint.y - origin.y);

      inFiringRange = targetDistance <= range;

      inFixedArc = isTargetInWeaponArc(ship, module, targetEntity, arcRadians);

    }



    entries.push({

      shipId: ship.id,

      designIndex: i,

      componentType: module.type,

      defaultRelativeAngle,

      currentRelativeAngle,

      desiredRelativeAngle,

      hullWorldAngle: ship.angle,

      weaponWorldAngle: currentRelativeAngle === null ? null : ship.angle + currentRelativeAngle,

      aimTargetId,

      fireTargetId,

      targetDistance,

      inFiringRange,

      inFixedArc,

      safeZoneFiringBlocked,

      componentAlive: isComponentAlive(ship, i),

      thermalPerformance: componentPerformance(ship, i)

    });

  });

  return entries;

}



// ---------------------------------------------------------------------------

// Proximity demolition charges

// ---------------------------------------------------------------------------



const {
  armedProximityChargeRanges,
  resolveDemolitionContacts,
  updateProximityCharges,
  detonateProximityCharge,
  proximityChargeDestroyedShip,
  nearestDemolitionTargetPoint,
  shipHasOperationalDemolitionCharge
} = require("./combat/demolition").createDemolitionRuntime({
  componentAimWorldPosition,
  isComponentExposed,
  applyDirectComponentDamage,
  destroyShip,
  areEnemies
});



























































module.exports = {

  evaluateShipCommandState,

  updateShipSupport,

  shipRepairNeed,

  updateShipWeapons,

  weaponReloadSeconds,

  beamContactCharge,

  damageBeamTargets,

  moduleRotationToRadians,

  moduleLocalPosition,

  moduleFootprintLocalPosition,

  weaponModuleWorldPosition,

  weaponMuzzleDistance,

  weaponMuzzleWorldPosition,

  isTargetInWeaponArc,

  getHoldWeaponFacingSignature,

  chooseHoldWeaponFacing,
  evaluateHoldWeaponCoverage,
  evaluateMainBatteryFacing,
  mainBatteryOrbitRange,
  mainBatteryProfile,

  damageShip,

  SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE,

  destroyShip,

  updateDestroyedShips,

  requestSelfDestruct,

  updateSelfDestructingShips,

  findTarget,

  findPointDefenseTarget,

  _lookupPointDefenceEntity,

  pickWeaponFireTarget,

  droneThreatScore,

  canWeaponDefensivelyTargetDrones,

  enemyShipThreatScore,  getCandidatePriorityIndex,

  componentAimWorldPosition,

  targetCoreAimWorldPosition,

  findBeamRayIntersections,
  isInductionBlockedByHeatShield,
  spinalChargeProgress,
  spinalTraverseScale,

  applyBeamHullDamage,

  applyDirectComponentDamage,

  selectComponentAimIndex,

  buildShipTurretDiagnostics,

  isInSafeZone,

  isLineBlocked,

  areAllies,

  areEnemies,

  armedProximityChargeRanges,

  resolveDemolitionContacts,

  updateProximityCharges,

  detonateProximityCharge,

  proximityChargeDestroyedShip,

  nearestDemolitionTargetPoint,

  shipHasOperationalDemolitionCharge,

  PRIORITY_COMPONENT_TYPES,

  weaponSpreadRadians,
  ACCURACY_SPREAD_SCALE

};













