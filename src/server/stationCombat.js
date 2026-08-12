// Authoritative combat hooks for stations. Kept separate from ship combat so
// the larger station module scale and relay ownership transitions are handled cleanly.
"use strict";

const { PARTS } = require("./components");
const { BALANCE } = require("./balanceConfig");
const { ECONOMY } = require("./config");
const { getShipComponentIndexes } = require("./componentIndexes");
const { getComponentPowerMultiplier } = require("./componentPower");
const {
  isComponentAlive,
  markComponentDamageChanged,
  bumpComponentAliveRevision
} = require("./componentHealth");
const { addBullet } = require("./projectiles");
const { angleDifference, fastHypot, rngRange, rotateToward, performanceNow } = require("./utils");
const TurretRules = require("../../public/src/shared/turretRules");
const RotationRules = require("../../public/src/shared/rotationRules");
const { moduleCentreToLocal, STATION_MODULE_SCALE } = require("./stationTemplates");
const { isInSafeZone, isLineBlocked, areEnemies, weaponReloadSeconds, findPointDefenseTarget, _lookupPointDefenceEntity } = require("./combat");
const { canTeamTargetEntity, invalidateVisibility } = require("./visibility");
const Targeting = require("./targetingEligibility");
const TargetingCadence = require("./targetingCadence");
const TargetingTelemetry = require("./targetingTelemetry");
const { stationAttackPoint } = require("./stationCollision");
const { bump, recordDuration, detailedProfileActive } = require("./roomTelemetry");

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
  return (room.stations || []).filter((s) => s.alive !== false && s.state !== "destroyed");
}

// Station designs are immutable during a match. Keep the derived weapon data
// beside the station and invalidate it when the authoritative design revision
// changes, so the hot loop does not repeatedly resolve PARTS, footprints and
// turret rules for every mount on every tick.
function getStationWeaponProfiles(station) {
  const design = station.design || [];
  const revision = station.revision || 0;
  const moduleScale = station.moduleScale || STATION_MODULE_SCALE;
  const cached = station._stationWeaponProfileCache;
  if (cached && cached.design === design && cached.revision === revision && cached.moduleScale === moduleScale) {
    return cached.profiles;
  }

  const profiles = new Array(design.length);
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    const part = PARTS[module.type] || PARTS.frame;
    const weapon = part.weapon;
    const family = weapon?.type || "blaster";
    const footprint = part.footprint || { width: 1, height: 1 };
    const longTiles = Math.max(footprint.width || 1, footprint.height || 1);
    profiles[i] = {
      module,
      part,
      weapon,
      defaultRelative: moduleRotationToRadians(module.rotation || 0),
      arcRadians: (weapon?.arc || 360) * Math.PI / 180,
      range: weapon?.range || 0,
      family,
      turnRate: weapon ? TurretRules.turnRateFor(weapon) : 0,
      muzzleDistance: weapon
        ? TurretRules.muzzleTiles(module.type, family, longTiles) * moduleScale
        : 0
    };
  }

  station._stationWeaponProfileCache = { design, revision, moduleScale, profiles };
  return profiles;
}

function prepareStationWeaponTargets(room, ships) {
  if (Array.isArray(ships) && ships === room._liveShipScratch) return ships;
  const source = Array.isArray(ships) ? ships : [];
  const targets = room._stationWeaponTargetScratch || (room._stationWeaponTargetScratch = []);
  targets.length = 0;
  for (const ship of source) {
    if (ship && ship.alive !== false) targets.push(ship);
  }
  return targets;
}

function prepareStationWeaponTargetLookup(room, targets) {
  const lookup = room._stationWeaponTargetLookup || (room._stationWeaponTargetLookup = new Map());
  lookup.clear();
  for (const target of targets || []) {
    if (!target || target.id === undefined || target.id === null || lookup.has(target.id)) continue;
    lookup.set(target.id, target);
  }
  return lookup;
}

function prepareStationWeaponEnemyTargets(room, station, targets, identity, now) {
  const candidates = station._stationWeaponEnemyTargets || (station._stationWeaponEnemyTargets = []);
  candidates.length = 0;
  const detailed = detailedProfileActive(room);
  for (const target of targets || []) {
    if (!target || target.id === station.id || target.alive === false || target.state === "destroyed") continue;
    if (!areEnemies(room, identity, target.ownerId)) continue;
    if (!canTeamTargetEntity(room, identity, target, now)) {
      if (detailed) bump(room, "stationWeaponVisibilityRejects");
      continue;
    }
    if (isInSafeZone(room, target.x, target.y, target)) {
      if (detailed) bump(room, "stationWeaponVisibilityRejects");
      continue;
    }
    candidates.push(target);
  }
  return candidates;
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

function stationModuleWorldPosition(station, index, profile = null) {
  const hardpoint = station.hardpoints?.[index];
  if (hardpoint) {
    const cos = Math.cos(station.angle || 0);
    const sin = Math.sin(station.angle || 0);
    return {
      x: station.x + hardpoint.x * cos - hardpoint.y * sin,
      y: station.y + hardpoint.x * sin + hardpoint.y * cos
    };
  }
  const module = profile?.module || station.design[index];
  if (!module) return { x: station.x, y: station.y };
  // Same cell -> local mapping the hardpoints and the renderer use. Writing it
  // out by hand here had the axes transposed (+x is FORWARD, and it comes from
  // the cell's y), so this fallback used to place a module on the wrong side of
  // the structure entirely.
  const scale = station.moduleScale || STATION_MODULE_SCALE;
  const { x: localX, y: localY } = moduleCentreToLocal(module, scale, profile?.part?.footprint || PARTS[module.type]?.footprint);
  const cos = Math.cos(station.angle || 0);
  const sin = Math.sin(station.angle || 0);
  return {
    x: station.x + localX * cos - localY * sin,
    y: station.y + localX * sin + localY * cos
  };
}

function weaponFacingAngle(station, index, profile = null) {
  const module = profile?.module || station.design[index];
  return (station.angle || 0) + moduleRotationToRadians((module && module.rotation) || 0);
}

function isTargetInWeaponArc(station, index, target, profile = null) {
  const module = profile?.module || station.design[index];
  const part = profile?.part || PARTS[module.type] || PARTS.frame;
  const weapon = profile?.weapon || part.weapon || { arc: 360 };
  const arc = profile?.arcRadians ?? (weapon.arc || 360) * Math.PI / 180;
  if (arc >= Math.PI * 2) return true;
  const origin = stationModuleWorldPosition(station, index, profile);
  const point = target?.entityType === "station"
    ? stationAttackPoint(origin.x, origin.y, target)
    : target;
  const angleToTarget = Math.atan2(point.y - origin.y, point.x - origin.x);
  return Math.abs(angleDifference(weaponFacingAngle(station, index, profile), angleToTarget)) <= arc / 2;
}

function findStationWeaponTarget(room, station, index, targets, identity, now, profile = null, candidateTargets = targets, detailedOverride = null) {
  const module = profile?.module || station.design[index];
  const part = profile?.part || PARTS[module.type] || PARTS.frame;
  const weapon = profile?.weapon || part.weapon;
  if (!weapon) return null;
  const detailed = detailedOverride === null ? detailedProfileActive(room) : detailedOverride;
  const origin = stationModuleWorldPosition(station, index, profile);
  const weaponAngle = weaponFacingAngle(station, index, profile);
  const range = profile?.range ?? (weapon.range || 0);
  const rangeSq = range * range;
  const prevalidated = Boolean(profile && candidateTargets && candidateTargets !== targets);
  const arcRadians = profile?.arcRadians ?? (weapon.arc || 360) * Math.PI / 180;
  let best = null;
  let bestDist = Infinity;
  let candidatesVisited = 0;
  let validations = 0;
  let visibilityRejects = 0;
  let rangeRejects = 0;
  let arcRejects = 0;
  if (detailed) bump(room, "stationWeaponFullTargetScans");
  for (const target of candidateTargets || []) {
    if (detailed) candidatesVisited += 1;
    if (!target || target.id === station.id) continue;
    if (target.alive === false || target.state === "destroyed") continue;
    if (detailed) validations += 1;
    if (!prevalidated) {
      if (!areEnemies(room, identity, target.ownerId)) continue;
      if (!canTeamTargetEntity(room, identity, target, now)) {
        if (detailed) visibilityRejects += 1;
        continue;
      }
      if (isInSafeZone(room, target.x, target.y, target)) {
        if (detailed) visibilityRejects += 1;
        continue;
      }
    }
    const point = target?.entityType === "station"
      ? stationAttackPoint(origin.x, origin.y, target)
      : target;
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const distSq = dx * dx + dy * dy;
    if (distSq > rangeSq) {
      if (detailed) rangeRejects += 1;
      continue;
    }
    if (arcRadians < Math.PI * 2
      && Math.abs(angleDifference(weaponAngle, Math.atan2(dy, dx))) > arcRadians / 2) {
      if (detailed) arcRejects += 1;
      continue;
    }
    if (distSq < bestDist) {
      best = target;
      bestDist = distSq;
    }
  }
  if (detailed) {
    bump(room, "stationWeaponCandidatesVisited", candidatesVisited);
    bump(room, "stationWeaponTargetValidations", validations);
    bump(room, "stationWeaponVisibilityRejects", visibilityRejects);
    bump(room, "stationWeaponRangeRejects", rangeRejects);
    bump(room, "stationWeaponArcRejects", arcRejects);
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
    if (station.componentHp[i] <= 0.0001) station.componentHp[i] = 0;
    markComponentDamageChanged(station, i);
    applied += dealt;
    left -= dealt;
  }
  station.hp = station.componentHp.reduce((sum, hp) => sum + Math.max(0, Number(hp) || 0), 0);
  station.healthRevision = (station.healthRevision || 0) + 1;
  return applied;
}

function relayRestoreRatio(cfg) {
  const configured = Number(cfg?.captureRestoreHpRatio);
  if (!Number.isFinite(configured) || configured <= 0) return 0.35;
  return Math.max(Number.EPSILON, Math.min(1, configured));
}

function relayRecoveryThresholdRatio(cfg) {
  const configured = Number(cfg?.recoveryOperationalHpRatio);
  return Number.isFinite(configured)
    ? Math.max(0, Math.min(1, configured))
    : 0.25;
}

function stationComponentHpTotal(station) {
  return (station.componentHp || []).reduce((sum, hp) => sum + Math.max(0, Number(hp) || 0), 0);
}

function restoreRelayComponentHp(station, ratio) {
  if (!Array.isArray(station?.componentMaxHp) || station.componentMaxHp.length === 0) return false;
  if (!Array.isArray(station.componentHp) || station.componentHp.length !== station.componentMaxHp.length) {
    station.componentHp = station.componentMaxHp.map(() => 0);
  }

  const restoredHull = Math.max(0, Number(station.maxHp) || 0) * ratio;
  const anchor = station.componentMaxHp.findIndex((value) => Number(value) > 0);
  if (anchor < 0 || !(restoredHull > 0)) return false;

  const next = station.componentMaxHp.map((value) => Math.max(0, Number(value) || 0) * ratio);
  const nextSum = next.reduce((sum, value) => sum + value, 0);
  next[anchor] = Math.max(0, next[anchor] + restoredHull - nextSum);

  let revived = false;
  for (let i = 0; i < next.length; i += 1) {
    const previous = Math.max(0, Number(station.componentHp[i]) || 0);
    station.componentHp[i] = next[i];
    if (previous !== next[i]) markComponentDamageChanged(station, i);
    if (!(previous > 0) && next[i] > 0) revived = true;
  }
  if (revived) bumpComponentAliveRevision(station);
  station.hp = stationComponentHpTotal(station);
  station.healthRevision = (station.healthRevision || 0) + 1;
  return station.hp > 0 && station.componentHp.some((hp) => hp > 0);
}

function repairStationComponents(station, amount) {
  let remaining = Math.max(0, Number(amount) || 0);
  if (!(remaining > 0) || !Array.isArray(station?.componentHp)) return 0;

  let healed = 0;
  let revived = false;
  for (let i = 0; i < station.componentHp.length && remaining > 0.0001; i += 1) {
    const current = Math.max(0, Number(station.componentHp[i]) || 0);
    const maximum = Math.max(0, Number(station.componentMaxHp?.[i]) || 0);
    const missing = maximum - current;
    if (!(missing > 0)) continue;
    const restored = Math.min(remaining, missing);
    station.componentHp[i] = current + restored;
    markComponentDamageChanged(station, i);
    if (!(current > 0) && station.componentHp[i] > 0) revived = true;
    healed += restored;
    remaining -= restored;
  }

  if (healed > 0) {
    if (revived) bumpComponentAliveRevision(station);
    station.hp = stationComponentHpTotal(station);
    station.healthRevision = (station.healthRevision || 0) + 1;
  }
  return healed;
}

function clearRelayCombatIdentity(room, station) {
  const arrays = [
    "weaponAimTargetIds",
    "weaponFireTargetIds",
    "weaponComponentTargetIds",
    "weaponComponentTargetIndices",
    "weaponComponentRetargetAt",
    "weaponBeamContacts",
    "weaponDesiredAngles"
  ];
  for (const key of arrays) {
    if (Array.isArray(station[key])) {
      station[key].fill(key === "weaponComponentTargetIds" || key === "weaponComponentTargetIndices" ? -1 : key === "weaponComponentRetargetAt" ? 0 : null);
    }
  }
  station.weaponCooldowns?.fill?.(0);
  delete station._visibilityTeamGeneration;
  delete station._visibilityTeamValue;
  delete station._sensorProfileCacheGeneration;
  delete station._sensorProfileCacheValue;
  station._weaponTargetState = null;
  station._pdThreatSet = null;
  station._pdThreatMetadataCache = null;
  station._pdSelectionState = null;
  station._targetAcquisitionSchedule = null;
  station._targetAcquisitionOffsets = null;
  station._stationWeaponEnemyTargets?.splice?.(0);
  station._snapshotWeaponRangeCache = null;
  station._snapshotComponentHpCache = null;
  clearStationWeaponRuntime(room);

  require("./relationships").invalidateRelationshipCache(room);
  require("./targetingCadence").invalidateAllAcquisitionSchedules(room);
  require("./pointDefenceThreats").invalidateAllPointDefenceThreatSets(room);
}

function relayAttacker(room, attackerId) {
  const attacker = room?.players?.get?.(attackerId);
  if (!attacker || attacker.removed) return null;
  const team = attacker.team || attacker.id;
  if ((typeof team !== "string" && typeof team !== "number") || !String(team).trim() || String(team) === "neutral") return null;
  if (room.rules?.gameMode !== "solo" && !attacker.team) return null;
  return { attacker, team: String(team) };
}

function awardRelayTransfer(room, station, attacker, team, now) {
  const { broadcastRoom } = require("./messages");
  const { teamLabel } = require("./players");
  const reward = Math.max(0, Number(ECONOMY.captureBonus) || 0);
  const recipients = [...(room.players?.values?.() || [])].filter((player) => {
    if (player.removed) return false;
    const playerTeam = player.team || (room.rules?.gameMode === "solo" ? player.id : null);
    return playerTeam === team;
  });
  for (const player of recipients) {
    player.captures = (Number(player.captures) || 0) + 1;
    if (reward > 0) {
      player.money = Math.min(player.maxMoney || ECONOMY.maxMoney, (Number(player.money) || 0) + reward);
      player.earned = (Number(player.earned) || 0) + reward;
    }
  }
  const label = teamLabel(room, team, attacker.name || "A wing");
  broadcastRoom(room, {
    type: "notice",
    message: `${label} captured relay ${station.relayId || station.id}: +$${reward}, +$${ECONOMY.relayIncome}/s`
  });
}

// The only authority that can transfer a relay. Home stations intentionally do
// not enter this path: their zero-hull branch below remains a match-ending
// destruction, not a capture or recovery. A timed capture from neutral is a
// different lifecycle from a destroyed-relay handoff: it restores the relay
// completely and makes it operational immediately, while destruction still
// starts the configured reduced-health recovery state.
function transferRelayControl(room, station, attackerId, now, options = {}) {
  if (!room || !station || station.stationType !== "relay") return false;
  const resolved = relayAttacker(room, attackerId);
  if (!resolved) return false;
  const { attacker, team } = resolved;
  if (station.team && String(station.team) === team) return false;

  const cfg = BALANCE.infrastructure?.relayStation;
  const capturedFromNeutral = options.captureMethod === "neutral";
  const restored = restoreRelayComponentHp(
    station,
    capturedFromNeutral ? 1 : relayRestoreRatio(cfg)
  );
  if (!restored) return false;

  station.ownerId = attacker.id;
  station.team = team;
  station.state = capturedFromNeutral ? "operational" : "recovering";
  station.alive = true;
  station.shield = capturedFromNeutral ? station.maxShield : 0;
  station.captureProgress = 0;
  station.captureTeam = null;
  station.captureContested = false;
  station.lastCapturedBy = attacker.id;
  station.lastCapturedAt = now;
  station.captureRevision = (station.captureRevision || 0) + 1;
  station.stateRevision = (station.stateRevision || 0) + 1;
  room.stationRevision = (room.stationRevision || 0) + 1;

  clearRelayCombatIdentity(room, station);
  invalidateVisibility(room, {
    reason: "relay-transfer",
    entityIds: [station.id],
    allegianceChanged: true
  });
  if (room._visibilityRuntime) {
    require("./visibilityRuntime").registerSensorSource(room, station, "station");
  }
  awardRelayTransfer(room, station, attacker, team, now);
  require("./objectives").updateControlVictory(room, now);
  return true;
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

  const homeComponentsDestroyed = station.stationType === "home" && !station.componentHp.some((hp) => hp > 0);
  if (station.stationType === "home" && station.state !== "destroyed" && (station.hp <= 0.001 || homeComponentsDestroyed)) {
    station.hp = 0;
    station.state = "destroyed";
    station.alive = false;
    room.spatialIndex?.remove?.("stations", station);
    station.stateRevision = (station.stateRevision || 0) + 1;
    require("./objectives").finalizeHomeStationDestruction(room, station, attackerId, now);
  } else if (station.stationType === "relay" && station.hp <= 0.001 && station.state !== "destroyed") {
    transferRelayControl(room, station, attackerId, now);
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

function getCadencedStationWeaponTarget(room, station, i, targets, identity, now, profile = null, targetLookup = null, candidateTargets = targets, detailedOverride = null) {
  const detailed = detailedOverride === null ? detailedProfileActive(room) : detailedOverride;
  TargetingTelemetry.bump(room, "stationTargetValidationAttempts");
  if (!station._weaponTargetState) station._weaponTargetState = [];
  let state = station._weaponTargetState[i];
  if (!state) {
    state = station._weaponTargetState[i] = { id: null, category: "ship", nextSearchAt: 0, lastSearchAt: 0 };
  }

  const module = profile?.module || station.design[i];
  const part = profile?.part || PARTS[module.type] || PARTS.frame;
  const weapon = profile?.weapon || part.weapon;
  if (!weapon) return null;

  const origin = stationModuleWorldPosition(station, i, profile);
  const range = profile?.range ?? (weapon.range || 0);
  const arcRadians = profile?.arcRadians ?? (weapon.arc || 360) * Math.PI / 180;
  const weaponAngle = weaponFacingAngle(station, i, profile);

  const hadCachedTarget = state.id !== null;
  const cached = hadCachedTarget
    ? (targetLookup ? (targetLookup.get(state.id) || null) : (targets || []).find((t) => t && t.id === state.id))
    : null;
  let currentValid = false;
  const validationStartedAt = detailed ? performanceNow() : 0;
  if (cached) {
    if (detailed) bump(room, "stationWeaponTargetValidations");
    currentValid = Targeting.isStationWeaponTargetValid(room, station, cached, identity, now, range, {
      originX: origin.x,
      originY: origin.y,
      arcRadians,
      weaponAngle
    });
    if (currentValid && isInSafeZone(room, cached.x, cached.y, cached)) currentValid = false;
    if (!currentValid) TargetingTelemetry.bump(room, "ordinaryTargetValidationFailures");
  }
  if (detailed) recordDuration(room, "stationWeaponValidationMs", validationStartedAt);

  const due = TargetingCadence.isAcquisitionDue(station, "stationOrdinary", i, now);
  const force = hadCachedTarget && !currentValid;

  if (hadCachedTarget && !cached) {
    state.id = null;
    TargetingTelemetry.bump(room, "targetInvalidations");
    TargetingTelemetry.bump(room, "ordinaryTargetImmediateReacquisitions");
    if (detailed) bump(room, "stationWeaponImmediateReacquisitions");
  } else if (force) {
    state.id = null;
    TargetingTelemetry.bump(room, "targetInvalidations");
    TargetingTelemetry.bump(room, "ordinaryTargetImmediateReacquisitions");
    if (detailed) bump(room, "stationWeaponImmediateReacquisitions");
  }

  if (currentValid && !due && !force) {
    TargetingTelemetry.bump(room, "stationTargetSearchDeferred");
    if (detailed) bump(room, "stationWeaponRetainedTargets");
    return cached;
  }

  if (!currentValid && !due && !force) {
    TargetingTelemetry.bump(room, "stationTargetSearchDeferred");
    return null;
  }

  TargetingTelemetry.bump(room, "stationTargetSearches");
  if (detailed) bump(room, "stationWeaponTargetSearches");
  const picked = TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledStationAcquisitionDuration", () =>
    findStationWeaponTarget(room, station, i, targets, identity, now, profile, candidateTargets, detailed)
  );
  _updateStationTargetState(station, i, picked, now, "stationOrdinary");
  if (picked) {
    TargetingTelemetry.bump(room, "stationTargetCandidates");
    picked._targetCategoryCache = "ship";
  }
  return picked;
}

function updateStationWeapons(room, stations, ships, dt, now) {
  const runtimeStartedAt = performanceNow();
  try {
  if (!Array.isArray(stations) || stations.length === 0) return;
  const detailed = detailedProfileActive(room);
  const preparationStartedAt = detailed ? performanceNow() : 0;
  const targets = prepareStationWeaponTargets(room, ships);
    if (detailed) recordDuration(room, "stationWeaponTargetPreparationMs", preparationStartedAt);
    const targetLookup = prepareStationWeaponTargetLookup(room, targets);
    if (targetLookup && room._stationTargetLookupMeasurementActive === true) {
      room._stationTargetLookupObservedFrames = (room._stationTargetLookupObservedFrames || 0) + 1;
      room._stationTargetLookupMaxSize = Math.max(room._stationTargetLookupMaxSize || 0, targetLookup.size);
    }
  // Point-defence overkill reservations are per-firing-entity and the ship pass
  // has already run for this tick, so the stations start from a clean map.
  if (!room._pdReservations) room._pdReservations = new Map();
  room._pdReservations.clear();
  for (const station of stations) {
    if (station.state !== "operational" || station.alive === false) continue;
    if (detailed) bump(room, "stationsWeaponProcessed");
    initStationCombatRuntime(station);
    const profiles = getStationWeaponProfiles(station);
    // Resolved once per station per tick: targeting, point defence and every
    // round the station fires all key off the same identity.
    const identity = stationCombatIdentity(room, station);
    const ordinaryTargets = prepareStationWeaponEnemyTargets(room, station, targets, identity, now);
    const indexes = getShipComponentIndexes(station);
    for (const i of indexes.weaponIndices) {
      if (detailed) bump(room, "stationWeaponComponentsVisited");
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
      if (detailed) bump(room, "stationWeaponComponentsOperational");
      const profileStartedAt = detailed ? performanceNow() : 0;
      const profile = profiles[i];
      if (!profile) continue;
      const { module, part, weapon } = profile;
      if (detailed) recordDuration(room, "stationWeaponProfileLookupMs", profileStartedAt);
      if (!weapon) continue;

      const origin = stationModuleWorldPosition(station, i, profile);
      // Point defence on a station defends the station: it engages incoming
      // missiles, torpedoes and drones through exactly the shared selector
      // ships use (priorities, line-of-sight and the per-tick overkill
      // reservations included), and only falls back to shooting at hulls when
      // nothing fragile is inbound. Before this it could see ships alone, so
      // eight point-defence mounts watched missiles fly past into the hull.
      const isPointDefense = (weapon.type || "") === "pointDefense";
       if (detailed) {
         if (isPointDefense) bump(room, "stationWeaponPointDefenceMounts");
         else bump(room, "stationWeaponOrdinaryMounts");
       }
      let pdTarget = null;
      if (isPointDefense) {
        const pointDefenceStartedAt = detailed ? performanceNow() : 0;
        const pdCachedId = station.weaponAimTargetIds[i] ?? null;
        const pdCached = pdCachedId ? _lookupPointDefenceEntity(room, pdCachedId) : null;
        const worldWeaponAngle = (station.angle || 0) + (station.weaponAngles[i] || 0);
        const pdArcRadians = profile?.arcRadians ?? (weapon.arc || 360) * Math.PI / 180;
        let pdCurrentValid = false;
        if (pdCached) {
          const validationStartedAt = detailed ? performanceNow() : 0;
          if (detailed) bump(room, "stationWeaponTargetValidations");
          pdCurrentValid = Targeting.isPointDefenceTargetValid(room, identity, pdCached, weapon.range || 0, now, {
            originX: origin.x,
            originY: origin.y,
            arcRadians: pdArcRadians,
            weaponAngle: worldWeaponAngle,
            reservations: room._pdReservations,
            priorityList: weapon.targetPriority,
            team: station.team
          });
          if (detailed) recordDuration(room, "stationWeaponValidationMs", validationStartedAt);
          if (pdCurrentValid && TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledLineOfSightDuration", () => isLineBlocked(room, origin.x, origin.y, pdCached.entity.x, pdCached.entity.y, 4))) pdCurrentValid = false;
          if (!pdCurrentValid) {
            TargetingTelemetry.bump(room, "pointDefenceImmediateReacquisitions");
            if (detailed) bump(room, "stationWeaponImmediateReacquisitions");
          }
        }
        const pdDue = TargetingCadence.isAcquisitionDue(station, "stationPointDefence", i, now);
        const pdForce = pdCachedId !== null && !pdCurrentValid;
        if (detailed && pdCurrentValid && !pdDue) bump(room, "stationWeaponRetainedTargets");
        if (pdCurrentValid && !pdDue) {
          TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
          pdTarget = pdCached;
        } else if (!pdDue && !pdForce) {
          TargetingTelemetry.bump(room, "pointDefenceTargetSearchDeferred");
          pdTarget = null;
        } else {
          TargetingTelemetry.bump(room, "pointDefenceTargetSearches");
          if (detailed) bump(room, "stationWeaponTargetSearches");
          pdTarget = findPointDefenseTarget(room, origin.x, origin.y, identity, weapon, targets, station.id, now);
          TargetingCadence.markAcquisitionCompleted(station, "stationPointDefence", i, now);
        }
        if (detailed) recordDuration(room, "stationWeaponPointDefenceMs", pointDefenceStartedAt);
      }
      let target;
      if (pdTarget) {
        target = pdTarget.entity;
      } else {
        const acquisitionStartedAt = detailed ? performanceNow() : 0;
        target = getCadencedStationWeaponTarget(room, station, i, targets, identity, now, profile, targetLookup, ordinaryTargets, detailed);
        if (detailed) recordDuration(room, "stationWeaponOrdinaryAcquisitionMs", acquisitionStartedAt);
      }
      const defaultRelative = profile?.defaultRelative ?? moduleRotationToRadians(module.rotation || 0);
      let desiredRelative = defaultRelative;
      let isTracking = false;
      const aimStartedAt = detailed ? performanceNow() : 0;

      if (target) {
        const targetPoint = target?.entityType === "station"
          ? stationAttackPoint(origin.x, origin.y, target)
          : target;
        const worldAngleToTarget = Math.atan2(targetPoint.y - origin.y, targetPoint.x - origin.x);
        const relativeAngleToTarget = angleDifference(station.angle || 0, worldAngleToTarget);
        const arc = profile?.arcRadians ?? (weapon.arc || 360) * Math.PI / 180;
        if (Math.abs(angleDifference(defaultRelative, relativeAngleToTarget)) <= arc / 2) {
          desiredRelative = relativeAngleToTarget;
          isTracking = true;
        } else {
          if (detailed) bump(room, "stationWeaponArcRejects");
        }
      }

      const turnRate = profile?.turnRate ?? TurretRules.turnRateFor(weapon);
      const currentRelative = Number.isFinite(station.weaponAngles[i]) ? station.weaponAngles[i] : defaultRelative;
      station.weaponAngles[i] = TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledWeaponAimDuration", () =>
        rotateToward(currentRelative, desiredRelative, turnRate * dt)
      );
      station.weaponDesiredAngles[i] = desiredRelative;
      station.weaponAimTargetIds[i] = isTracking && target ? target.id : null;
      station.weaponFireTargetIds[i] = null;
      if (detailed) recordDuration(room, "stationWeaponAimMs", aimStartedAt);

      if (!isTracking) continue;
      if (station.weaponCooldowns[i] > 0) {
        if (detailed) bump(room, "stationWeaponCooldownSkips");
        continue;
      }

      const family = weapon.type || "blaster";
      const worldWeaponAngle = (station.angle || 0) + station.weaponAngles[i];
      const targetPoint = target?.entityType === "station"
        ? stationAttackPoint(origin.x, origin.y, target)
        : target;
      const worldAngleToTarget = Math.atan2(targetPoint.y - origin.y, targetPoint.x - origin.x);
      const angleErr = Math.abs(angleDifference(worldWeaponAngle, worldAngleToTarget));
      if (family !== "beam" && angleErr > TurretRules.FIRING_ALIGNMENT_TOLERANCE) {
        if (detailed) bump(room, "stationWeaponArcRejects");
        continue;
      }

      const footprint = part.footprint || { width: 1, height: 1 };
      const longTiles = Math.max(footprint.width || 1, footprint.height || 1);
      const muzzleDist = profile?.muzzleDistance
        ?? TurretRules.muzzleTiles(module.type, family, longTiles) * (station.moduleScale || STATION_MODULE_SCALE);
      const muzzleX = origin.x + Math.cos(worldWeaponAngle) * muzzleDist;
      const muzzleY = origin.y + Math.sin(worldWeaponAngle) * muzzleDist;

      const spread = rngRange(() => Math.random(), -0.02, 0.02);
      const shotAngle = worldWeaponAngle + spread;
      const speed = weapon.projectileSpeed || 620;
      const range = profile?.range ?? (weapon.range || 0);
      // `weapon.reload` is MILLISECONDS in the balance data (1000 / fireRate).
      // Assigning it straight to a cooldown that is decremented in seconds gave
      // every station battery a reload a thousand times too long — a station
      // blaster fired once every ten minutes. Use the same seconds conversion
      // the ship weapons use.
      const reload = weaponReloadSeconds(weapon, 1);
      station.weaponFireTargetIds[i] = target.id;
      const fireStartedAt = detailed ? performanceNow() : 0;

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
        if (pool - reserved <= 0.001) {
          if (detailed) recordDuration(room, "stationWeaponFireMs", fireStartedAt);
          continue;
        }
        room._pdReservations?.set(entity.id, reserved + (weapon.damage || 0));
        const flightTime = fastHypot(entity.x - muzzleX, entity.y - muzzleY) / Math.max(1, speed);
        const leadAngle = Math.atan2(
          entity.y + (entity.vy || 0) * flightTime - muzzleY,
          entity.x + (entity.vx || 0) * flightTime - muzzleX
        ) + spread;
        TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledWeaponFiringDuration", () => addBullet(room, {
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
          bornAt: now
        }));
        if (detailed) bump(room, "stationWeaponShotsCreated");
        station.weaponCooldowns[i] = reload;
        if (detailed) recordDuration(room, "stationWeaponFireMs", fireStartedAt);
        continue;
      }

      if (family === "blaster" || family === "bolt") {
        TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledWeaponFiringDuration", () => { addBullet(room, {
          type: "bolt",
          subtype: module.type,
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
          bornAt: now
        });
        });
        if (detailed) bump(room, "stationWeaponShotsCreated");
      } else if (family === "missile") {
        TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledWeaponFiringDuration", () => { addBullet(room, {
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
          projectileSpeed: speed,
          life: range / speed,
          bornAt: now,
          age: 0
        });
        });
        if (detailed) bump(room, "stationWeaponShotsCreated");
      } else if (family === "emp") {
        const empSpeed = weapon.projectileSpeed || 550;
        const empRange = profile?.range ?? (weapon.range || 800);
        TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledWeaponFiringDuration", () => { addBullet(room, {
          type: "emp",
          subtype: module.type,
          ownerId: identity,
          targetId: target.id,
          targetComponentIndex: -1,
          x: muzzleX,
          y: muzzleY,
          vx: Math.cos(shotAngle) * empSpeed,
          vy: Math.sin(shotAngle) * empSpeed,
          projectileSpeed: empSpeed,
          damage: 0,
          radius: weapon.projectileRadius || weapon.radius || 9,
          shieldDisruptionFraction: weapon.shieldDisruptionFraction ?? 0.5,
          life: empRange / empSpeed,
          bornAt: now
        });
        });
        if (detailed) bump(room, "stationWeaponShotsCreated");

      } else if (family === "flak") {
        TargetingTelemetry.withSampledDuration(room, now, station, i, "sampledWeaponFiringDuration", () => { addBullet(room, {
          type: "flak",
          subtype: module.type,
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
          bornAt: now
        });
        });
        if (detailed) bump(room, "stationWeaponShotsCreated");
      } else {
        if (detailed) recordDuration(room, "stationWeaponFireMs", fireStartedAt);
        continue;
      }
      station.weaponCooldowns[i] = reload;
      if (detailed) recordDuration(room, "stationWeaponFireMs", fireStartedAt);
    }
  }
  } finally {
    // The target lookup/scratch are tick-local. Clear them after the station
    // phase as well as on room reset so a ship spawned or removed by the later
    // hangar/projectile stages cannot leave a stale retained reference behind.
    room?._stationWeaponTargetLookup?.clear?.();
    if (Array.isArray(room?._stationWeaponTargetScratch)) room._stationWeaponTargetScratch.length = 0;
    room?._pdReservations?.clear?.();
    for (const station of room?.stations || []) {
      if (Array.isArray(station?._stationWeaponEnemyTargets)) station._stationWeaponEnemyTargets.length = 0;
    }
    recordDuration(room, "stationWeaponRuntimeMs", runtimeStartedAt);
  }
}

function clearStationWeaponRuntime(room) {
  if (!room) return;
  room._stationWeaponTargetLookup?.clear?.();
  if (Array.isArray(room._stationWeaponTargetScratch)) room._stationWeaponTargetScratch.length = 0;
  room._pdReservations?.clear?.();
  for (const station of room.stations || []) {
    if (Array.isArray(station?._stationWeaponEnemyTargets)) station._stationWeaponEnemyTargets.length = 0;
  }
  if (room._stationTargetLookupMeasurementActive !== undefined) room._stationTargetLookupMeasurementActive = false;
  if (room._stationTargetLookupObservedFrames !== undefined) room._stationTargetLookupObservedFrames = 0;
  if (room._stationTargetLookupMaxSize !== undefined) room._stationTargetLookupMaxSize = 0;
}

module.exports = {
  initStationCombatRuntime,
  liveStations,
  updateStationWeapons,
  clearStationWeaponRuntime,
  transferRelayControl,
  repairStationComponents,
  relayRecoveryThresholdRatio,
  damageStation,
  stationModuleWorldPosition,
  STATION_MODULE_SCALE
};
