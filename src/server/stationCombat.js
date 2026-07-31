// Authoritative combat hooks for stations. Kept separate from ship combat so
// the larger station module scale and disabled state are handled cleanly.
"use strict";

const { PARTS } = require("./components");
const { BALANCE } = require("./balanceConfig");
const { getShipComponentIndexes } = require("./componentIndexes");
const { getComponentPowerMultiplier } = require("./componentPower");
const { isComponentAlive, markComponentDamageChanged } = require("./componentHealth");
const { addBullet } = require("./projectiles");
const { angleDifference, fastHypot, rngRange, rotateToward } = require("./utils");
const TurretRules = require("../../public/src/shared/turretRules");
const RotationRules = require("../../public/src/shared/rotationRules");
const { moduleCentreToLocal, STATION_MODULE_SCALE } = require("./stationTemplates");
const { isInSafeZone, areEnemies, weaponReloadSeconds, findPointDefenseTarget } = require("./combat");
const { canTeamTargetEntity } = require("./visibility");
const PerformanceFlags = require("./performanceFlags");
const Targeting = require("./targetingEligibility");
const TargetingCadence = require("./targetingCadence");
const TargetingTelemetry = require("./targetingTelemetry");

const SHIELD_ABSORPTION = 0.95;

// The shared browser/server rule. A local reimplementation here previously
// halved every angle (`deg * PI / 180 * 0.5`), so a station battery rotated 90
// degrees rested at 45 while the client drew it at 90 — harmless only because
// every authored station module happened to be at rotation 0.
function moduleRotationToRadians(rotation) {
  return RotationRules.moduleRotationToRadians(RotationRules.normalizeRotation(rotation));
}

function initStationCombatRuntime(station) {
  const len = station.design ? station.design.length : 0;
  if (!station.weaponCooldowns) station.weaponCooldowns = new Array(len).fill(0);
  if (!station.weaponAngles) station.weaponAngles = station.design.map((m) => moduleRotationToRadians(m.rotation || 0));
  if (!station.weaponAimTargetIds) station.weaponAimTargetIds = new Array(len).fill(null);
  if (!station.weaponFireTargetIds) station.weaponFireTargetIds = new Array(len).fill(null);
  if (!station.weaponComponentTargetIds) station.weaponComponentTargetIds = new Array(len).fill(-1);
  if (!station.weaponComponentTargetIndices) station.weaponComponentTargetIndices = new Array(len).fill(-1);
  if (!station.weaponComponentRetargetAt) station.weaponComponentRetargetAt = new Array(len).fill(0);
  if (!station.weaponDesiredAngles) station.weaponDesiredAngles = new Array(len).fill(null);
  if (!station.weaponBeamContacts) station.weaponBeamContacts = new Array(len).fill(null);
  if (!station.beamEffectsAt) station.beamEffectsAt = new Array(len).fill(0);
  if (!station.moduleScale) station.moduleScale = STATION_MODULE_SCALE;
  if (!station._derivedComponentIndexes) getShipComponentIndexes(station);
}

function liveStations(room) {
  return (room.stations || []).filter((s) => s.alive !== false && s.state !== "disabled");
}

// A station's allegiance is its TEAM. `ownerId` is only populated when a player
// personally captured a relay; a home station is built from a map safe zone,
// which carries a team and no owner at all.
//
// The shared relationship rules are keyed on player ids and return "neither ally
// nor enemy" when an id is not in room.players, so a null-owner station was
// hostile to nobody: it never acquired a target, never fired, and any round it
// did somehow launch carried ownerId null and passed straight through its
// target. Resolving the station to a live player on its own team fixes
// targeting, projectile hostility and kill attribution together.
function stationCombatIdentity(room, station) {
  const players = room?.players;
  if (!players) return station.ownerId || null;
  if (station.ownerId && players.has(station.ownerId)) {
    const owner = players.get(station.ownerId);
    if (!owner.removed) return station.ownerId;
  }
  if (station.team) {
    for (const player of players.values()) {
      if (!player.removed && player.team === station.team) return player.id;
    }
  }
  return station.ownerId || null;
}

function stationModuleWorldPosition(station, index) {
  const hardpoint = station.hardpoints?.[index];
  if (hardpoint) {
    const cos = Math.cos(station.angle || 0);
    const sin = Math.sin(station.angle || 0);
    return {
      x: station.x + hardpoint.x * cos - hardpoint.y * sin,
      y: station.y + hardpoint.x * sin + hardpoint.y * cos
    };
  }
  const module = station.design[index];
  if (!module) return { x: station.x, y: station.y };
  // Same cell -> local mapping the hardpoints and the renderer use. Writing it
  // out by hand here had the axes transposed (+x is FORWARD, and it comes from
  // the cell's y), so this fallback used to place a module on the wrong side of
  // the structure entirely.
  const scale = station.moduleScale || STATION_MODULE_SCALE;
  const { x: localX, y: localY } = moduleCentreToLocal(module, scale, PARTS[module.type]?.footprint);
  const cos = Math.cos(station.angle || 0);
  const sin = Math.sin(station.angle || 0);
  return {
    x: station.x + localX * cos - localY * sin,
    y: station.y + localX * sin + localY * cos
  };
}

function weaponFacingAngle(station, index) {
  const module = station.design[index];
  return (station.angle || 0) + moduleRotationToRadians((module && module.rotation) || 0);
}

function isTargetInWeaponArc(station, index, target) {
  const module = station.design[index];
  const part = PARTS[module.type] || PARTS.frame;
  const weapon = part.weapon || { arc: 360 };
  const arc = (weapon.arc || 360) * Math.PI / 180;
  if (arc >= Math.PI * 2) return true;
  const origin = stationModuleWorldPosition(station, index);
  const angleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
  return Math.abs(angleDifference(weaponFacingAngle(station, index), angleToTarget)) <= arc / 2;
}

function findStationWeaponTarget(room, station, index, targets, identity, now) {
  const module = station.design[index];
  const part = PARTS[module.type] || PARTS.frame;
  const weapon = part.weapon;
  if (!weapon) return null;
  const origin = stationModuleWorldPosition(station, index);
  const range = weapon.range || 0;
  const rangeSq = range * range;
  let best = null;
  let bestDist = Infinity;
  for (const target of targets || []) {
    if (!target || target.id === station.id) continue;
    if (target.alive === false || target.state === "disabled") continue;
    if (!areEnemies(room, identity, target.ownerId)) continue;
    if (!canTeamTargetEntity(room, identity, target, now)) continue;
    if (isInSafeZone(room, target.x, target.y, target)) continue;
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) continue;
    if (!isTargetInWeaponArc(station, index, target)) continue;
    if (distSq < bestDist) {
      best = target;
      bestDist = distSq;
    }
  }
  return best;
}

function applyComponentDamage(station, amount) {
  let left = amount;
  let applied = 0;
  const order = [];
  for (let i = 0; i < station.componentHp.length; i += 1) {
    if (station.componentHp[i] > 0) order.push(i);
  }
  for (const i of order) {
    if (left <= 0) break;
    const hp = station.componentHp[i];
    const dealt = Math.min(hp, left);
    station.componentHp[i] -= dealt;
    station.hp -= dealt;
    markComponentDamageChanged(station, i);
    applied += dealt;
    left -= dealt;
  }
  station.healthRevision = (station.healthRevision || 0) + 1;
  return applied;
}

function damageStation(room, station, damage, attackerId, now, sourceX, sourceY, options = {}) {
  if (damage <= 0 || station.alive === false) return 0;
  const shieldMultiplier = Number.isFinite(Number(options.shieldDamageMultiplier)) ? options.shieldDamageMultiplier : 1;
  const hullMultiplier = Number.isFinite(Number(options.hullDamageMultiplier)) ? options.hullDamageMultiplier : 1;

  let hullDamage = damage * hullMultiplier;
  if (station.shield > 0) {
    const shieldDamage = damage * shieldMultiplier;
    const blockedShieldDamage = Math.min(station.shield, shieldDamage);
    station.shield = Math.max(0, station.shield - blockedShieldDamage);
    const absorbedRatio = shieldDamage > 0 ? blockedShieldDamage / shieldDamage : 0;
    const absorbedHullDamage = hullDamage * absorbedRatio;
    const overflowHullDamage = hullDamage - absorbedHullDamage;
    const bleedThroughDamage = absorbedHullDamage * (1 - SHIELD_ABSORPTION);
    hullDamage = bleedThroughDamage + overflowHullDamage;
  }

  const applied = applyComponentDamage(station, hullDamage);
  if (applied > 0) {
    station.lastDamagedBy = attackerId || station.lastDamagedBy;
    station.lastDamagedAt = now;
  }

  const infra = BALANCE.infrastructure || {};
  const cfg = station.stationType === "home" ? infra.homeStation : infra.relayStation;
  const homeComponentsDestroyed = station.stationType === "home" && !station.componentHp.some((hp) => hp > 0);
  if (station.stationType === "home" && station.state !== "destroyed" && (station.hp <= 0.001 || homeComponentsDestroyed)) {
    station.hp = 0;
    station.state = "destroyed";
    station.alive = false;
    station.disabledAt = now;
    station.stateRevision = (station.stateRevision || 0) + 1;
    require("./objectives").finalizeHomeStationDestruction(room, station, attackerId, now);
  } else if (station.stationType !== "home" && station.hp <= 0.001 && station.state !== "destroyed") {
    // A damaged relay goes disabled and becomes capturable; the actual
    // handover is handled by updateStationCapture so the timed ring means
    // the same thing for both neutral and enemy-held relays.
    station.state = "disabled";
    station.alive = true;
    station.captureProgress = 0;
    station.captureTeam = null;
    station.captureRevision = (station.captureRevision || 0) + 1;
    station.stateRevision = (station.stateRevision || 0) + 1;
    station.healthRevision = (station.healthRevision || 0) + 1;
  }

  return applied;
}

function _updateStationTargetState(station, i, target, now, kind) {
  if (!station._weaponTargetState) station._weaponTargetState = [];
  let state = station._weaponTargetState[i];
  if (!state) {
    state = station._weaponTargetState[i] = { id: null, category: "ship", nextSearchAt: 0, lastSearchAt: 0 };
  }
  state.id = target?.id ?? null;
  state.category = "ship";
  state.lastSearchAt = now;
  TargetingCadence.markAcquisitionCompleted(station, kind, i, now);
  state.nextSearchAt = TargetingCadence.nextAcquisitionAt(station, kind, i, now);
}

function getCadencedStationWeaponTarget(room, station, i, targets, identity, now) {
  TargetingTelemetry.bump(room, "stationTargetValidationAttempts");
  if (!station._weaponTargetState) station._weaponTargetState = [];
  let state = station._weaponTargetState[i];
  if (!state) {
    state = station._weaponTargetState[i] = { id: null, category: "ship", nextSearchAt: 0, lastSearchAt: 0 };
  }

  const module = station.design[i];
  const part = PARTS[module.type] || PARTS.frame;
  const weapon = part.weapon;
  if (!weapon) return null;

  const origin = stationModuleWorldPosition(station, i);
  const range = weapon.range || 0;
  const arcRadians = (weapon.arc || 360) * Math.PI / 180;
  const weaponAngle = weaponFacingAngle(station, i);

  const hadCachedTarget = state.id !== null;
  const cached = hadCachedTarget ? (targets || []).find((t) => t && t.id === state.id) : null;
  let currentValid = false;
  if (cached) {
    currentValid = Targeting.isStationWeaponTargetValid(room, station, cached, identity, now, range, {
      originX: origin.x,
      originY: origin.y,
      arcRadians,
      weaponAngle
    });
    if (currentValid && isInSafeZone(room, cached.x, cached.y, cached)) currentValid = false;
    if (!currentValid) TargetingTelemetry.bump(room, "ordinaryTargetValidationFailures");
  }

  const due = TargetingCadence.isAcquisitionDue(station, "stationOrdinary", i, now);
  const force = hadCachedTarget && !currentValid;

  if (hadCachedTarget && !cached) {
    state.id = null;
    TargetingTelemetry.bump(room, "targetInvalidations");
    TargetingTelemetry.bump(room, "ordinaryTargetImmediateReacquisitions");
  } else if (force) {
    state.id = null;
    TargetingTelemetry.bump(room, "targetInvalidations");
    TargetingTelemetry.bump(room, "ordinaryTargetImmediateReacquisitions");
  }

  if (currentValid && !due && !force) {
    TargetingTelemetry.bump(room, "stationTargetSearchDeferred");
    return cached;
  }

  if (!currentValid && !due && !force) {
    TargetingTelemetry.bump(room, "stationTargetSearchDeferred");
    return null;
  }

  TargetingTelemetry.bump(room, "stationTargetSearches");
  const picked = TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledStationAcquisitionDuration", () =>
    findStationWeaponTarget(room, station, i, targets, identity, now)
  );
  _updateStationTargetState(station, i, picked, now, "stationOrdinary");
  if (picked) {
    TargetingTelemetry.bump(room, "stationTargetCandidates");
    picked._targetCategoryCache = "ship";
  }
  return picked;
}

function updateStationWeapons(room, stations, ships, dt, now) {
  if (!Array.isArray(stations) || stations.length === 0) return;
  const targets = (ships || []).filter((s) => s && s.alive !== false);
  // Point-defence overkill reservations are per-firing-entity and the ship pass
  // has already run for this tick, so the stations start from a clean map.
  if (!room._pdReservations) room._pdReservations = new Map();
  room._pdReservations.clear();
  for (const station of stations) {
    if (station.state !== "operational" || station.alive === false) continue;
    initStationCombatRuntime(station);
    // Resolved once per station per tick: targeting, point defence and every
    // round the station fires all key off the same identity.
    const identity = stationCombatIdentity(room, station);
    const indexes = getShipComponentIndexes(station);
    for (const i of indexes.weaponIndices) {
      station.weaponCooldowns[i] = Math.max(0, (station.weaponCooldowns[i] || 0) - dt);
      if (!isComponentAlive(station, i)) {
        station.weaponAimTargetIds[i] = null;
        station.weaponFireTargetIds[i] = null;
        station.weaponAngles[i] = station.weaponAngles[i] ?? moduleRotationToRadians(0);
        continue;
      }
      const powerMultiplier = getComponentPowerMultiplier(station, i);
      if (powerMultiplier <= 0) {
        station.weaponAimTargetIds[i] = null;
        station.weaponFireTargetIds[i] = null;
        station.weaponAngles[i] = station.weaponAngles[i] ?? moduleRotationToRadians(0);
        continue;
      }
      const module = station.design[i];
      const part = PARTS[module.type] || PARTS.frame;
      const weapon = part.weapon;
      if (!weapon) continue;

      const origin = stationModuleWorldPosition(station, i);
      // Point defence on a station defends the station: it engages incoming
      // missiles, torpedoes and drones through exactly the shared selector
      // ships use (priorities, line-of-sight and the per-tick overkill
      // reservations included), and only falls back to shooting at hulls when
      // nothing fragile is inbound. Before this it could see ships alone, so
      // eight point-defence mounts watched missiles fly past into the hull.
      const isPointDefense = (weapon.type || "") === "pointDefense";
      const pdTarget = isPointDefense
        ? findPointDefenseTarget(room, origin.x, origin.y, identity, weapon, targets, station.id, now)
        : null;
      const target = pdTarget ? pdTarget.entity
        : (PerformanceFlags.WEAPON_TARGET_ACQUISITION_CADENCE()
            ? getCadencedStationWeaponTarget(room, station, i, targets, identity, now)
            : findStationWeaponTarget(room, station, i, targets, identity, now));
      const defaultRelative = moduleRotationToRadians(module.rotation || 0);
      let desiredRelative = defaultRelative;
      let isTracking = false;

      if (target) {
        const worldAngleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
        const relativeAngleToTarget = angleDifference(station.angle || 0, worldAngleToTarget);
        const arc = (weapon.arc || 360) * Math.PI / 180;
        if (Math.abs(angleDifference(defaultRelative, relativeAngleToTarget)) <= arc / 2) {
          desiredRelative = relativeAngleToTarget;
          isTracking = true;
        }
      }

      const turnRate = TurretRules.turnRateFor(weapon);
      const currentRelative = Number.isFinite(station.weaponAngles[i]) ? station.weaponAngles[i] : defaultRelative;
      station.weaponAngles[i] = rotateToward(currentRelative, desiredRelative, turnRate * dt);
      station.weaponDesiredAngles[i] = desiredRelative;
      station.weaponAimTargetIds[i] = isTracking && target ? target.id : null;
      station.weaponFireTargetIds[i] = null;

      if (!isTracking || station.weaponCooldowns[i] > 0) continue;

      const family = weapon.type || "blaster";
      const worldWeaponAngle = (station.angle || 0) + station.weaponAngles[i];
      const worldAngleToTarget = Math.atan2(target.y - origin.y, target.x - origin.x);
      const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));
      const alignmentThreshold = module.type === "pointDefense" ? 0.035 : 0.26;
      if (family !== "beam" && angleErr > alignmentThreshold) continue;

      const footprint = part.footprint || { width: 1, height: 1 };
      const longTiles = Math.max(footprint.width || 1, footprint.height || 1);
      const muzzleDist = TurretRules.muzzleTiles(module.type, family, longTiles) * (station.moduleScale || STATION_MODULE_SCALE);
      const muzzleX = origin.x + Math.cos(worldWeaponAngle) * muzzleDist;
      const muzzleY = origin.y + Math.sin(worldWeaponAngle) * muzzleDist;

      const spread = rngRange(() => Math.random(), -0.02, 0.02);
      const shotAngle = worldWeaponAngle + spread;
      const speed = weapon.projectileSpeed || 620;
      const range = weapon.range || 0;
      // `weapon.reload` is MILLISECONDS in the balance data (1000 / fireRate).
      // Assigning it straight to a cooldown that is decremented in seconds gave
      // every station battery a reload a thousand times too long — a station
      // blaster fired once every ten minutes. Use the same seconds conversion
      // the ship weapons use.
      const reload = weaponReloadSeconds(weapon, 1);
      station.weaponFireTargetIds[i] = target.id;

      if (pdTarget) {
        // Reserve the damage so the next battery this tick picks a different
        // missile instead of piling onto one that is already dead.
        const entity = pdTarget.entity;
        const pool = pdTarget.type === "projectile"
          ? (entity.hp !== undefined ? entity.hp : (entity.damage || 20))
          : pdTarget.type === "drone" ? (entity.hull || 0)
          : pdTarget.type === "decoy" ? 1
          : Infinity;
        const reserved = room._pdReservations?.get(entity.id) || 0;
        if (pool - reserved <= 0.001) continue;
        room._pdReservations?.set(entity.id, reserved + (weapon.damage || 0));
        const flightTime = fastHypot(entity.x - muzzleX, entity.y - muzzleY) / Math.max(1, speed);
        const leadAngle = Math.atan2(
          entity.y + (entity.vy || 0) * flightTime - muzzleY,
          entity.x + (entity.vx || 0) * flightTime - muzzleX
        ) + spread;
        addBullet(room, {
          type: "pdShot",
          subtype: module.type,
          ownerId: identity,
          targetId: entity.id,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(leadAngle) * speed,
          vy: Math.sin(leadAngle) * speed,
          damage: weapon.damage || 3,
          shipDamageMultiplier: weapon.shipDamageMultiplier ?? 0.05,
          shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
          hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
          pdTargetType: pdTarget.type,
          pdTargetId: entity.id,
          life: range / speed,
          bornAt: now,
          armorInteractionSeconds: pdTarget.type === "ship" ? Math.min(1, reload) : undefined
        });
        station.weaponCooldowns[i] = reload;
        continue;
      }

      if (family === "blaster" || family === "bolt") {
        addBullet(room, {
          type: "bolt",
          ownerId: identity,
          targetId: target.id,
          targetComponentIndex: -1,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(shotAngle) * speed,
          vy: Math.sin(shotAngle) * speed,
          damage: weapon.damage || 10,
          shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
          hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
          life: range / speed,
          bornAt: now,
          armorInteractionSeconds: Math.min(1, reload)
        });
      } else if (family === "missile") {
        addBullet(room, {
          type: "missile",
          subtype: module.type,
          interceptable: true,
          hp: weapon.missileHp || 20,
          ownerId: identity,
          targetId: target.id,
          targetComponentIndex: -1,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(shotAngle) * speed,
          vy: Math.sin(shotAngle) * speed,
          damage: weapon.damage || 20,
          shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
          hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
          tracking: weapon.tracking ?? 0.75,
          trackRemaining: weapon.trackTime ?? 1.4,
          trackingDelay: weapon.trackingDelay ?? 0.25,
          maxSpeed: speed * 1.45,
          life: range / speed,
          bornAt: now,
          age: 0,
          armorInteractionSeconds: Math.min(1, reload)
        });
      } else if (family === "flak") {
        addBullet(room, {
          type: "flak",
          ownerId: identity,
          targetId: target.id,
          targetComponentIndex: -1,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(shotAngle) * speed,
          vy: Math.sin(shotAngle) * speed,
          damage: weapon.damage || 15,
          blastRadius: weapon.blastRadius || 45,
          blastDamage: weapon.blastDamage || 12,
          innerFullDamageRadius: weapon.innerFullDamageRadius || 0,
          falloffExponent: weapon.falloffExponent || 1,
          proximityFuseRadius: weapon.proximityFuseRadius || 40,
          shieldDamageMultiplier: weapon.shieldDamageMultiplier ?? 1,
          hullDamageMultiplier: weapon.hullDamageMultiplier ?? 1,
          life: range / speed,
          bornAt: now,
          armorInteractionSeconds: Math.min(1, reload)
        });
      } else {
        continue;
      }
      station.weaponCooldowns[i] = reload;
    }
  }
}

module.exports = {
  initStationCombatRuntime,
  liveStations,
  updateStationWeapons,
  damageStation,
  stationModuleWorldPosition,
  STATION_MODULE_SCALE
};
