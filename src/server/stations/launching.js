"use strict";

const { INFRASTRUCTURE } = require("../config");
const { clampNumber, performanceNow } = require("../utils");
const { areEntityAllies } = require("../relationships");
const {
  computeDesignCollisionRadius,
  computeDesignAxisExtents
} = require("../componentGeometry");
const { spawnShip, applyRallyPoint } = require("../ships");
const { usesStationInfrastructure } = require("../rooms");
const { HULL_CELL_PADDING } = require("../stationTemplates");
const { bump, recordDuration, detailedProfileActive } = require("../roomTelemetry");
const { hangarBayForPlayer } = require("./hangars");

// A single corridor, in world space, as a swept segment from its rear wall to
// its mouth. Independent bays can launch concurrently; a bay may only begin
// when its own path is clear.
function corridorIsClear(room, station, hangar, ignoreShipId = null) {
  const detailed = detailedProfileActive(room);
  const startedAt = detailed ? performanceNow() : 0;
  try {
  if (!hangar) return false;
  const normal = { x: Math.cos(station.angle), y: Math.sin(station.angle) };
  const from = hangar.innerWall;
  const lateral = { x: -normal.y, y: normal.x };
  // Only the corridor INTERIOR has to be clear - from the rear bulkhead to the
  // mouth. It used to extend all the way out to the release plane, which meant
  // anything drifting past the front of the station, friendly or hostile,
  // halted the launch queue for as long as it loitered there. Nothing can get inside
  // the corridor any more (see the blast door in stationCollisionPieces), so
  // the only thing this can now catch is a hull that has not finished leaving.
  // Outside the mouth is open space: the launching ship handles it the way any
  // other ship handles traffic, through ordinary collision.
  const length = hangar.corridorLength;
  const halfWidth = hangar.apertureHalfWidth;
  const candidates = room.spatialIndex?.queryRange
    ? room.spatialIndex.queryRange("ships", station.x, station.y, station.radius + length, [])
    : [...room.ships.values()];
  for (const ship of candidates) {
    if (!ship?.alive || ship.id === ignoreShipId) continue;
    // Project the ship into corridor space: along = distance down the corridor,
    // across = lateral offset from its centreline.
    const dx = ship.x - from.x;
    const dy = ship.y - from.y;
    const along = dx * normal.x + dy * normal.y;
    const across = dx * lateral.x + dy * lateral.y;
    const shipRadius = Number(ship.physicalRadius) || Number(ship.radius) || 26;
    // The mouth is a hard boundary for launch clearance. A hostile hull outside
    // may overlap this band with its collision radius, but allowing that radius
    // to veto the launch lets enemies blockade the hangar without entering the
    // one-way door. Normal separation handles contact with the launched hull.
    // A hull whose centre is at the mouth or beyond is already outside the
    // station's spawn corridor. It must never blockade a new spawn from the
    // open space in front of the hangar.
    if (along < -shipRadius || along >= length) continue;
    // The launching ship fits inside halfWidth by construction, so any hull
    // reaching into the band obstructs it.
    if (Math.abs(across) <= halfWidth + shipRadius) return false;
  }
  return true;
  } finally {
    if (detailed) recordDuration(room, "stationCorridorQueryMs", startedAt);
  }
}

function spawnQueuedShip(room, station, queueItem, now) {
  const detailed = detailedProfileActive(room);
  const player = room.players.get(queueItem.playerId);
  if (!player || !player.ready) {
    if (detailed) bump(room, "stationSpawnMissingPlayerBlocks");
    return null;
  }
  const active = player.ships.filter((s) => s.alive).length;
  if (active >= player.shipCap) {
    if (detailed) bump(room, "stationSpawnFleetCapBlocks");
    return null;
  }
  const hangar = hangarBayForPlayer(room, station, queueItem.playerId);
  if (!hangar || station.launchReservations?.[hangar.index]) {
    if (detailed) bump(room, "stationSpawnOccupiedHangarBlocks");
    return null;
  }
  bumpCounter(room, "stationLaunchAttemptCount");
  const startedAt = detailed ? performanceNow() : 0;
  const physicalRadius = computeDesignCollisionRadius(queueItem.template.design, queueItem.template.stats);
  if (!corridorIsClear(room, station, hangar)) {
    queueItem.blocked = true;
    station.productionRevision += 1;
    bumpCounter(room, "stationLaunchBlockedCount");
    return null;
  }
  const spawn = hangar.interiorSpawn;
  const launchAngle = station.angle;
  const ship = spawnShip(room, player, now, active, {
    template: queueItem.template,
    combatStyle: queueItem.combatStyle,
    aiRole: queueItem.aiRole,
    aiBlueprintId: queueItem.aiBlueprintId,
    spawnPoint: { x: spawn.x, y: spawn.y, ok: true, angle: launchAngle },
    requestId: queueItem.requestId
  });
  if (detailed) recordDuration(room, "stationSpawnAttemptMs", startedAt);
  if (!ship) return null;
  queueItem.blocked = false;
  ship.x = spawn.x;
  ship.y = spawn.y;
  ship.angle = launchAngle;
  const speed = INFRASTRUCTURE.homeStation.launchSpeed;
  ship.vx = Math.cos(launchAngle) * speed;
  ship.vy = Math.sin(launchAngle) * speed;
  const normal = { x: Math.cos(launchAngle), y: Math.sin(launchAngle) };
  const forwardExtents = computeDesignAxisExtents(queueItem.template.design, "x");
  const lateralExtents = computeDesignAxisExtents(queueItem.template.design, "y");
  const startAlong = hangar.corridor.rearWallX + hangar.corridor.length / 2;
  const releaseDistance = hangar.corridor.mouthX + Math.max(
    HULL_CELL_PADDING,
    forwardExtents.negative
  );
  // Launch phase: the ship is under station control until its whole hull clears
  // the mouth. Ordinary stance, orders and weapons stay inert so it cannot
  // manoeuvre or shoot through the structure it is still inside.
  ship.launchPhase = {
    stationId: station.id,
    originX: station.x,
    originY: station.y,
    bayIndex: hangar.index,
    startedAt: now,
    angle: launchAngle,
    normal,
    centreY: hangar.centreY,
    startAlong,
    along: startAlong,
    rearExtent: Math.max(HULL_CELL_PADDING, forwardExtents.negative),
    lateralExtent: Math.max(HULL_CELL_PADDING, Math.max(lateralExtents.negative, lateralExtents.positive)),
    physicalRadius,
    releaseDistance
  };
  if (Array.isArray(station.launchReservations)) {
    station.launchReservations[hangar.index] = { shipId: ship.id, startedAt: now };
  }
  station.activeLaunches.push({
    shipId: ship.id,
    bayIndex: hangar.index,
    bayId: hangar.id,
    releasedAt: null,
    releasePlane: { ...hangar.releasePlane },
    progress: 0,
    doorOpen: true
  });
  bumpCounter(room, "stationLaunchSuccessCount");
  // No launch notice: the build bar and the ship itself flying out of
  // the corridor already say it, and a toast per hull is noise when a player is
  // queueing several at once.
  return ship;
}

// Development counters (section 24). Kept on the room so they reset with it and
// cost nothing in Classic, where no station code runs at all.
function bumpCounter(room, name) {
  const counters = room.stationCounters || (room.stationCounters = {});
  counters[name] = (counters[name] || 0) + 1;
  if (detailedProfileActive(room)) {
    if (name === "stationLaunchAttemptCount") bump(room, "stationSpawnAttempts");
    else if (name === "stationLaunchSuccessCount") bump(room, "stationSpawnSuccesses");
  }
}

function processStationLaunchQueue(room, station, dt, now) {
  if (station.stationType !== "home") return;
  const detailed = detailedProfileActive(room);
  if (detailed) bump(room, "stationQueuesVisited");
  if (station.state !== "operational" || !station.productionQueue.length) {
    if (detailed && !station.productionQueue.length) bump(room, "stationEmptyQueueSkips");
    return;
  }
  // Visit each queued item once. A busy central corridor leaves the item in
  // queue order for a later deterministic retry.
  const visitBudget = station.productionQueue.length;
  let visited = 0;
  let index = 0;
  while (index < station.productionQueue.length && visited < visitBudget) {
    const item = station.productionQueue[index];
    visited += 1;
    if (detailed) bump(room, "stationQueueItemsVisited");
    const queueStart = detailed ? performanceNow() : 0;
    if (detailed) recordDuration(room, "stationProductionQueueMs", queueStart);
    const ship = spawnQueuedShip(room, station, item, now);
    if (!ship) {
      index += 1;
      continue;
    }
    const completionStart = detailed ? performanceNow() : 0;
    item.quantityRemaining -= 1;
    station.productionRevision += 1;
    if (item.quantityRemaining <= 0) station.productionQueue.splice(index, 1);
    else index += 1;
    if (detailed) recordDuration(room, "stationProductionQueueMs", completionStart);
  }
}

// A launching hull is immovable while the station owns it, so the corridor has
// to be opened rather than driven through. Allied ships sitting in the lane
// immediately ahead are advanced outward as a deterministic departure column.
// Keeping their lateral lane prevents several bays from piling parked allies
// into the same narrow side band.
//
// Only allies are nudged. A hostile hull is not ours to move: the launching ship
// is immovable to separation, so an enemy that parks in the mouth is pushed out
// by the ordinary collision pass instead, and until it is the launch simply
// waits.
//
// Returns true when the lane immediately ahead is clear enough to advance.
const LAUNCH_LANE_LOOKAHEAD = 96;
const LAUNCH_DEPARTURE_SPEED_MULTIPLIER = 1.25;

function launchYieldPointClear(room, ship, x, y, radius) {
  const { isStaticObstacleLineClear } = require("../movementNavigation");
  const width = room?.world?.width || 0;
  const height = room?.world?.height || 0;
  if (width > 0 && (x < radius || x > width - radius)) return false;
  if (height > 0 && (y < radius || y > height - radius)) return false;
  return isStaticObstacleLineClear(room, x, y, x, y, radius);
}

function yieldLaunchBlockers(room, station, hangar, ship, phase, along, dt, now) {
  const normal = phase.normal || { x: Math.cos(station.angle), y: Math.sin(station.angle) };
  const lateral = { x: -normal.y, y: normal.x };
  const launchRadius = Number(phase.physicalRadius) || Number(ship.physicalRadius) || 26;
  const laneHalfWidth = Math.max(
    Number(phase.lateralExtent) || 0,
    Number(hangar.apertureHalfWidth) || 0
  );
  const nose = along + launchRadius;
  const launchSpeed = Math.max(0, Number(INFRASTRUCTURE.homeStation.launchSpeed) || 0);
  const step = launchSpeed * LAUNCH_DEPARTURE_SPEED_MULTIPLIER * Math.max(0, Number(dt) || 0);
  const blockers = [];

  for (const candidate of room.ships?.values?.() || []) {
    if (!candidate?.alive || candidate.id === ship.id || candidate.launchPhase) continue;
    const dx = candidate.x - station.x;
    const dy = candidate.y - station.y;
    const candidateAlong = dx * normal.x + dy * normal.y;
    const candidateAcross = dx * lateral.x + dy * lateral.y;
    const candidateRadius = Number(candidate.physicalRadius) || Number(candidate.radius) || 26;
    // Local only. A ship far up the lane is not in the way of this tick's
    // movement and is none of the launch's business.
    if (candidateAlong + candidateRadius < nose) continue;
    if (candidateAlong - candidateRadius > nose + LAUNCH_LANE_LOOKAHEAD) continue;
    const overlap = laneHalfWidth + candidateRadius - Math.abs(candidateAcross - hangar.centreY);
    if (overlap <= 0) continue;

    // Not ours to move. The launching hull is immovable to the collision pass,
    // so a hostile parked in the mouth is pushed out by that instead.
    if (!areEntityAllies(room, ship.ownerId, candidate)) continue;

    blockers.push({ candidate, candidateAlong });
  }

  if (!(step > 0) || blockers.length === 0) return true;
  blockers.sort((a, b) => b.candidateAlong - a.candidateAlong || String(a.candidate.id).localeCompare(String(b.candidate.id)));

  // Validate the whole column before moving any member. A rock or world edge at
  // the front therefore holds the launch instead of compressing the column or
  // partially shifting it into an unrecoverable overlap.
  const plans = blockers.map(({ candidate }) => ({
    candidate,
    nextX: candidate.x + normal.x * step,
    nextY: candidate.y + normal.y * step
  }));
  if (plans.some(({ candidate, nextX, nextY }) => !launchYieldPointClear(
    room,
    candidate,
    nextX,
    nextY,
    Number(candidate.physicalRadius) || Number(candidate.radius) || 26
  ))) return false;

  for (const { candidate, nextX, nextY } of plans) {
    const dx = nextX - candidate.x;
    const dy = nextY - candidate.y;
    candidate.x = nextX;
    candidate.y = nextY;
    candidate._collisionCorrectionX = (candidate._collisionCorrectionX || 0) + dx;
    candidate._collisionCorrectionY = (candidate._collisionCorrectionY || 0) + dy;
    // Remove any inward velocity while retaining lateral or faster outward
    // motion. Ordinary movement remains authoritative after this bounded nudge.
    const outwardSpeed = (candidate.vx || 0) * normal.x + (candidate.vy || 0) * normal.y;
    if (outwardSpeed < 0) {
      candidate.vx -= outwardSpeed * normal.x;
      candidate.vy -= outwardSpeed * normal.y;
    }
    bumpCounter(room, "stationLaunchBlockersYielded");
  }
  return true;
}

function finiteLaunchNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function launchNormalFor(station, phase) {
  const phaseX = finiteLaunchNumber(phase?.normal?.x);
  const phaseY = finiteLaunchNumber(phase?.normal?.y);
  const phaseLength = Math.hypot(phaseX || 0, phaseY || 0);
  if (phaseLength > 0.0001) {
    return { x: phaseX / phaseLength, y: phaseY / phaseLength };
  }
  const angle = finiteLaunchNumber(phase?.angle);
  const fallbackAngle = angle === null ? (finiteLaunchNumber(station?.angle) || 0) : angle;
  return { x: Math.cos(fallbackAngle), y: Math.sin(fallbackAngle) };
}

// A station can be rebuilt while a hull is between the rear bulkhead and the
// release plane. Prefer the current id, but recognize a replacement at the
// recorded origin as the same physical launch authority. This keeps a station
// recreation from turning a live launch into an orphan.
function stationForLaunchPhase(room, phase) {
  const stations = Array.isArray(room?.stations) ? room.stations : [];
  const exact = stations.find((station) => (
    station?.id === phase?.stationId && station.stationType === "home"
  ));
  if (exact?.hangars?.length) return exact;

  const originX = finiteLaunchNumber(phase?.originX);
  const originY = finiteLaunchNumber(phase?.originY);
  if (originX !== null && originY !== null) {
    let closest = null;
    let closestDistance = Infinity;
    for (const station of stations) {
      if (station?.stationType !== "home" || !station.hangars?.length) continue;
      const distance = Math.hypot(station.x - originX, station.y - originY);
      if (distance < closestDistance) {
        closest = station;
        closestDistance = distance;
      }
    }
    if (closest && closestDistance <= 4) return closest;
  }
  return exact || null;
}

function normalizeLaunchPhase(station, hangar, phase) {
  const normal = launchNormalFor(station, phase);
  const angle = Math.atan2(normal.y, normal.x);
  const defaultStartAlong = Number(hangar?.corridor?.rearWallX) + Number(hangar?.corridor?.length) / 2;
  const defaultReleaseDistance = Number(hangar?.releaseDistance);
  const phaseStart = finiteLaunchNumber(phase.startAlong);
  const phaseRelease = finiteLaunchNumber(phase.releaseDistance);
  const startAlong = phaseStart === null || !Number.isFinite(defaultStartAlong)
    ? defaultStartAlong
    : phaseStart;
  const releaseDistance = phaseRelease === null || !Number.isFinite(defaultReleaseDistance)
    ? defaultReleaseDistance
    : Math.max(phaseRelease, defaultReleaseDistance);
  const currentAlong = finiteLaunchNumber(phase.along);
  const originX = finiteLaunchNumber(phase.originX);
  const originY = finiteLaunchNumber(phase.originY);

  phase.stationId = station.id;
  phase.angle = angle;
  phase.normal = normal;
  phase.centreY = finiteLaunchNumber(phase.centreY) === null
    ? Number(hangar?.centreY) || 0
    : Number(phase.centreY);
  phase.originX = originX === null ? station.x : originX;
  phase.originY = originY === null ? station.y : originY;
  phase.startAlong = startAlong;
  phase.releaseDistance = releaseDistance;
  phase.along = currentAlong === null ? startAlong : Math.max(startAlong, currentAlong);
  phase.rearExtent = Math.max(HULL_CELL_PADDING, finiteLaunchNumber(phase.rearExtent) || 0);
  phase.lateralExtent = Math.max(
    HULL_CELL_PADDING,
    finiteLaunchNumber(phase.lateralExtent) || Number(phase.physicalRadius) || 0
  );
  return { normal, startAlong, releaseDistance };
}

function launchRecordFor(station, ship, phase, hangar) {
  const startAlong = finiteLaunchNumber(phase.startAlong) || 0;
  const releaseDistance = finiteLaunchNumber(phase.releaseDistance) || startAlong;
  const along = Math.max(startAlong, finiteLaunchNumber(phase.along) || startAlong);
  return {
    shipId: ship.id,
    bayIndex: hangar.index,
    bayId: hangar.id,
    releasedAt: null,
    releasePlane: { ...hangar.releasePlane },
    progress: clampNumber((along - startAlong) / Math.max(1, releaseDistance - startAlong), 0, 1),
    doorOpen: true
  };
}

function removeLaunchRecordsForShip(room, shipId, keepStation = null, keepLaunch = null) {
  for (const station of room?.stations || []) {
    if (!Array.isArray(station?.activeLaunches)) continue;
    for (let i = station.activeLaunches.length - 1; i >= 0; i -= 1) {
      const launch = station.activeLaunches[i];
      if (launch?.shipId !== shipId) continue;
      if (station === keepStation && launch === keepLaunch) continue;
      releaseLaunch(station, shipId);
      station.activeLaunches.splice(i, 1);
    }
  }
}

// Recovering means moving the hull's centre to a point where its rear extent
// is outside the mouth, then releasing the launch lock. Clearing only
// launchPhase is unsafe: the ordinary movement controller deliberately ignores
// a ship while that field exists, so every recovery path must clear the field
// and place the hull somewhere the normal collision pass can actually use.
function recoverLaunchPhase(room, ship, phase, station = null, hangar = null, now = 0, reason = "orphan") {
  if (!ship?.launchPhase || !phase) return;
  const normal = launchNormalFor(station, phase);
  const lateral = { x: -normal.y, y: normal.x };
  const physicalRadius = Number(phase.physicalRadius) || Number(ship.physicalRadius) || Number(ship.radius) || 26;
  const originX = finiteLaunchNumber(phase.originX);
  const originY = finiteLaunchNumber(phase.originY);
  const fallbackOriginX = originX === null ? finiteLaunchNumber(station?.x) : originX;
  const fallbackOriginY = originY === null ? finiteLaunchNumber(station?.y) : originY;
  let releaseDistance = finiteLaunchNumber(phase.releaseDistance);
  if (hangar && Number.isFinite(Number(hangar.releaseDistance))) {
    releaseDistance = releaseDistance === null
      ? Number(hangar.releaseDistance)
      : Math.max(releaseDistance, Number(hangar.releaseDistance));
  }
  if (releaseDistance === null && station) {
    releaseDistance = Math.max(Number(station.radius) || 0, physicalRadius * 2);
  }
  const centreY = finiteLaunchNumber(phase.centreY) || Number(hangar?.centreY) || 0;

  if (fallbackOriginX !== null && fallbackOriginY !== null && releaseDistance !== null) {
    const currentAlong = (ship.x - fallbackOriginX) * normal.x + (ship.y - fallbackOriginY) * normal.y;
    const targetAlong = Math.max(releaseDistance, Number.isFinite(currentAlong) ? currentAlong : releaseDistance);
    ship.x = fallbackOriginX + normal.x * targetAlong + lateral.x * centreY;
    ship.y = fallbackOriginY + normal.y * targetAlong + lateral.y * centreY;
  }

  const launchSpeed = INFRASTRUCTURE.homeStation.launchSpeed;
  ship.angle = Math.atan2(normal.y, normal.x);
  ship.vx = normal.x * launchSpeed;
  ship.vy = normal.y * launchSpeed;
  ship.launchPhase = null;
  ship._integratedMovementX = 0;
  ship._integratedMovementY = 0;
  ship._collisionCorrectionX = 0;
  ship._collisionCorrectionY = 0;
  ship.turnActivity = 0;
  ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);
  if (station) releaseLaunch(station, ship.id);
  const player = room?.players?.get?.(ship.ownerId);
  if (player) applyRallyPoint(room, player, [ship]);
  bumpCounter(room, "stationLaunchOrphanRecoveryCount");
  if (detailedProfileActive(room)) bump(room, `stationLaunchRecoveries:${reason}`);
}

// Keep station.activeLaunches as a recoverable index of ship.launchPhase, not
// a second authority. A missing/recreated index entry is rebuilt before the
// movement boundary; an invalid station or bay is released to a safe point.
function reconcileStationLaunchState(room, now) {
  const stations = Array.isArray(room?.stations) ? room.stations : [];
  const detailed = detailedProfileActive(room);
  for (const station of stations) {
    if (!Array.isArray(station.activeLaunches)) station.activeLaunches = [];
    if (!Array.isArray(station.launchReservations)) {
      station.launchReservations = new Array(station.hangars?.length || 0).fill(null);
    }
    for (let i = station.launchReservations.length - 1; i >= 0; i -= 1) {
      const reservation = station.launchReservations[i];
      const reservedShip = reservation?.shipId ? room.ships?.get?.(reservation.shipId) : null;
      const reservedPhase = reservedShip?.launchPhase;
      if (!reservedShip?.alive
        || reservedPhase?.stationId !== station.id
        || Number(reservedPhase?.bayIndex) !== i) {
        station.launchReservations[i] = null;
      }
    }
    const seenShips = new Set();
    for (let i = station.activeLaunches.length - 1; i >= 0; i -= 1) {
      const launch = station.activeLaunches[i];
      const ship = room.ships?.get?.(launch?.shipId);
      const phase = ship?.launchPhase;
      const valid = Boolean(
        ship?.alive
        && phase
        && phase.stationId === station.id
        && Number.isInteger(Number(phase.bayIndex))
        && station.hangars?.[Number(phase.bayIndex)]
        && Number(launch?.bayIndex) === Number(phase.bayIndex)
        && !seenShips.has(ship.id)
      );
      if (!valid) {
        if ((!ship || !ship.alive) && detailed) bump(room, "stationLaunchesRemovedMissingShip");
        releaseLaunch(station, launch?.shipId);
        station.activeLaunches.splice(i, 1);
        continue;
      }
      seenShips.add(ship.id);
    }
  }

  for (const ship of room?.ships?.values?.() || []) {
    const phase = ship?.launchPhase;
    if (!ship?.alive || !phase) continue;
    const station = stationForLaunchPhase(room, phase);
    const bayIndex = Number(phase.bayIndex);
    const hangar = station?.hangars?.[bayIndex];
    if (!station || !Number.isInteger(bayIndex) || !hangar) {
      removeLaunchRecordsForShip(room, ship.id);
      recoverLaunchPhase(room, ship, phase, station, hangar, now, "missing-authority");
      continue;
    }

    normalizeLaunchPhase(station, hangar, phase);
    let launch = station.activeLaunches.find((entry) => entry?.shipId === ship.id) || null;
    if (launch) {
      removeLaunchRecordsForShip(room, ship.id, station, launch);
    } else {
      removeLaunchRecordsForShip(room, ship.id);
      launch = launchRecordFor(station, ship, phase, hangar);
      station.activeLaunches.push(launch);
    }
    if (!station.launchReservations[bayIndex]) {
      station.launchReservations[bayIndex] = { shipId: ship.id, startedAt: phase.startedAt || now };
    }
  }
}

// A launch record exists only while a freshly built ship is still clearing the
// launch corridor. Without this sweep the list grows for the whole match, since
// nothing else ever removes an entry.
function updateStationLaunches(room, station, dt, now) {
  const detailed = detailedProfileActive(room);
  const startedAt = detailed ? performanceNow() : 0;
  try {
  const launches = Array.isArray(station.activeLaunches)
    ? station.activeLaunches
    : (station.activeLaunches = []);
  if (!launches || launches.length === 0) {
    if (detailed && station.stationType === "home") bump(room, "stationEmptyLaunchSkips");
    return;
  }
  for (let i = launches.length - 1; i >= 0; i -= 1) {
    const launch = launches[i];
    if (detailed) bump(room, "stationActiveLaunchesVisited");
    const ship = room.ships.get(launch.shipId);
    if (!ship || !ship.alive) {
      if (detailed) bump(room, "stationLaunchesRemovedMissingShip");
      releaseLaunch(station, launch.shipId);
      launches.splice(i, 1);
      continue;
    }
    const hangar = station.hangars?.[launch.bayIndex];
    if (!hangar) {
      if (ship.launchPhase) {
        recoverLaunchPhase(room, ship, ship.launchPhase, station, null, now, "missing-hangar");
      }
      releaseLaunch(station, launch.shipId);
      launches.splice(i, 1);
      continue;
    }
    const phase = ship.launchPhase;
    if (!phase) {
      releaseLaunch(station, launch.shipId);
      launches.splice(i, 1);
      continue;
    }
    // Station launch control owns the hull's position. Movement, avoidance and
    // separation never get a chance to turn it or push it backward between
    // these updates.
    const normal = phase.normal || {
      x: Math.cos(station.angle),
      y: Math.sin(station.angle)
    };
    const lateral = { x: -normal.y, y: normal.x };
    const speed = INFRASTRUCTURE.homeStation.launchSpeed;
    const safeDt = Number.isFinite(Number(dt)) ? Math.max(0, Number(dt)) : 0;
    const startAlong = Number.isFinite(Number(phase.startAlong))
      ? Number(phase.startAlong)
      : hangar.corridor.rearWallX + hangar.corridor.length / 2;
    const releaseDistance = Number.isFinite(Number(phase.releaseDistance))
      ? Number(phase.releaseDistance)
      : hangar.corridor.mouthX + Math.max(HULL_CELL_PADDING, Number(phase.rearExtent) || HULL_CELL_PADDING);
    const previousAlong = Number.isFinite(Number(phase.along))
      ? Math.max(startAlong, Number(phase.along))
      : startAlong;
    // Open the lane before committing to the step. If the outward departure
    // column cannot advance safely, the launch holds where it is; no hull is
    // driven through static geometry.
    const laneClear = yieldLaunchBlockers(room, station, hangar, ship, phase, previousAlong, safeDt, now);
    const along = laneClear
      ? Math.min(releaseDistance, previousAlong + speed * safeDt)
      : previousAlong;
    if (!laneClear) bumpCounter(room, "stationLaunchesHeldForLane");
    ship.angle = phase.angle;
    ship.vx = normal.x * speed;
    ship.vy = normal.y * speed;
    ship.x = station.x + normal.x * along + lateral.x * (Number(phase.centreY) || 0);
    ship.y = station.y + normal.y * along + lateral.y * (Number(phase.centreY) || 0);
    ship._integratedMovementX = 0;
    ship._integratedMovementY = 0;
    ship._collisionCorrectionX = 0;
    ship._collisionCorrectionY = 0;
    ship.turnActivity = 0;
    phase.startAlong = startAlong;
    phase.along = along;
    phase.releaseDistance = releaseDistance;
    launch.progress = clampNumber(
      (along - startAlong) / Math.max(1, releaseDistance - startAlong),
      0,
      1
    );
    launch.doorOpen = true;
    if (along >= releaseDistance) {
      // Fully clear: ordinary movement, orders and weapons resume, and the ship
      // heads for the player's rally point.
      const releaseStartedAt = detailed ? performanceNow() : 0;
      ship.launchPhase = null;
      launch.releasedAt = now;
      releaseLaunch(station, launch.shipId);
      launches.splice(i, 1);
      const player = room.players.get(ship.ownerId);
      if (player) applyRallyPoint(room, player, [ship]);
      if (detailed) bump(room, "stationLaunchesReleased");
      if (detailed) recordDuration(room, "stationLaunchReleaseMs", releaseStartedAt);
    }
  }
  } finally {
    if (detailed) recordDuration(room, "stationLaunchControlMs", startedAt);
  }
}

function releaseLaunch(station, shipId) {
  if (!Array.isArray(station.launchReservations)) return;
  for (let i = 0; i < station.launchReservations.length; i += 1) {
    if (station.launchReservations[i]?.shipId === shipId) station.launchReservations[i] = null;
  }
}

// Called at the movement boundary. A launch must be advanced before ordinary
// movement, separation or combat consumes the room; otherwise those systems can
// displace a new hull and station control only repairs the result one tick late.
function updateStationLaunchControl(room, dt, now) {
  if (!usesStationInfrastructure(room) || !room.stations) return;
  reconcileStationLaunchState(room, now);
  for (const station of room.stations) updateStationLaunches(room, station, dt, now);
}

module.exports = {
  processStationLaunchQueue,
  recoverLaunchPhase,
  reconcileStationLaunchState,
  updateStationLaunches,
  updateStationLaunchControl
};
