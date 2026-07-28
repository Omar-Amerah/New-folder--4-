"use strict";

const { PARTS } = require("./components");
const { INFRASTRUCTURE } = require("./config");
const { clampNumber } = require("./utils");
const { computeStats } = require("./shipStats");
const { createGeneratedPowerWiring } = require("./shipDesign");
const { initComponentState, repairShipComponents } = require("./componentHealth");
const { initializeComponentPower, effectiveShieldStats } = require("./componentPower");
const { initShipHeat } = require("./heat");
const { computeDesignFootprintRadius, computeDesignCollisionRadius } = require("./componentGeometry");
const { spawnShip, applyRallySlots } = require("./ships");
const { usesStationInfrastructure } = require("./rooms");
const { initStationCombatRuntime } = require("./stationCombat");

const {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  MAX_SHIP_EXTENT,
  HOME_STATION_CELLS,
  stationModuleScale,
  buildHomeStationDesign,
  buildRelayStationDesign,
  buildHomeStationGeometry,
  buildRelayStationGeometry
} = require("./stationTemplates");

function buildStationTemplate(design) {
  const wiring = createGeneratedPowerWiring(design);
  const stats = computeStats(design, wiring);
  return Object.freeze({ design: design.map((m) => Object.freeze({ ...m })), wiring, stats });
}

const homeStationTemplate = buildStationTemplate(buildHomeStationDesign());
const relayStationTemplate = buildStationTemplate(buildRelayStationDesign());

function isStation(entity) { return entity?.entityType === "station"; }
function isOperationalStation(entity) { return isStation(entity) && entity.state === "operational"; }
function isDamageableEntity(entity) { return isStation(entity) || Boolean(entity?.alive && entity?.design); }
function isCombatEntity(entity) { return isDamageableEntity(entity) && (entity.alive !== false || isOperationalStation(entity)); }
function isHostileEntity(source, target) {
  if (!isDamageableEntity(source) || !isDamageableEntity(target)) return false;
  if (source.team !== undefined && target.team !== undefined && source.team === target.team) return false;
  if (source.ownerId !== undefined && target.ownerId !== undefined && source.ownerId === target.ownerId) return false;
  return true;
}

// Authored template geometry, measured once at module load rather than per
// station: it depends only on the design, never on where a station stands.
const homeStationGeometry = buildHomeStationGeometry();
const relayStationGeometry = buildRelayStationGeometry();

// The maximum ship a player can design, in world units. Every hangar dimension
// derives from this so the two can never drift apart.
function maximumShipEnvelope() {
  return { width: MAX_SHIP_EXTENT, height: MAX_SHIP_EXTENT, halfDiagonal: Math.hypot(MAX_SHIP_EXTENT, MAX_SHIP_EXTENT) / 2 };
}

function rotatePoint(px, py, cos, sin) {
  return { x: px * cos - py * sin, y: px * sin + py * cos };
}

// Transforms a structure-local point into world space for a placed station.
function stationLocalToWorld(station, px, py) {
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  const rotated = rotatePoint(px, py, cos, sin);
  return { x: station.x + rotated.x, y: station.y + rotated.y };
}

// Compound collision pieces in world space: an oriented box per authored hull
// section. The hangar corridor is deliberately not among them, so it is the one
// navigable path through the station's front.
function stationCollisionPieces(station) {
  const geometry = station.stationType === "home" ? homeStationGeometry : relayStationGeometry;
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  return geometry.collisionRects.map((rect) => {
    const cx = (rect.minX + rect.maxX) / 2;
    const cy = (rect.minY + rect.maxY) / 2;
    const centre = rotatePoint(cx, cy, cos, sin);
    return {
      x: station.x + centre.x,
      y: station.y + centre.y,
      halfWidth: (rect.maxX - rect.minX) / 2,
      halfHeight: (rect.maxY - rect.minY) / 2,
      angle: station.angle,
      // Broad-phase circle so spatial queries can reject quickly.
      radius: Math.hypot(rect.maxX - rect.minX, rect.maxY - rect.minY) / 2
    };
  });
}

// True when a circle of `radius` at world (x, y) overlaps any solid station
// piece. Used by collision, navigation and launch-clearance checks alike.
function stationOverlapsCircle(station, x, y, radius) {
  const cos = Math.cos(-station.angle);
  const sin = Math.sin(-station.angle);
  const dx = x - station.x;
  const dy = y - station.y;
  // Into structure-local space, where every piece is axis aligned.
  const local = rotatePoint(dx, dy, cos, sin);
  const geometry = station.stationType === "home" ? homeStationGeometry : relayStationGeometry;
  for (const rect of geometry.collisionRects) {
    const nearestX = Math.max(rect.minX, Math.min(rect.maxX, local.x));
    const nearestY = Math.max(rect.minY, Math.min(rect.maxY, local.y));
    const ox = local.x - nearestX;
    const oy = local.y - nearestY;
    if (ox * ox + oy * oy <= radius * radius) return true;
  }
  return false;
}

function resolveStationCollision(room, ship, shipRadius) {
  if (!room?.stations?.length) return false;
  let hit = false;
  for (const station of room.stations) {
    if (!station?.collisionPieces?.length) continue;
    for (const piece of station.collisionPieces) {
      const cos = Math.cos(-piece.angle);
      const sin = Math.sin(-piece.angle);
      const local = rotatePoint((ship.x || 0) - piece.x, (ship.y || 0) - piece.y, cos, sin);
      const halfW = piece.halfWidth;
      const halfH = piece.halfHeight;
      const nearestX = Math.max(-halfW, Math.min(halfW, local.x));
      const nearestY = Math.max(-halfH, Math.min(halfH, local.y));
      const lx = local.x - nearestX;
      const ly = local.y - nearestY;
      const dist2 = lx * lx + ly * ly;
      let nx = 0;
      let ny = 0;
      let penetration = 0;
      if (dist2 < 0.0001) {
        // Ship centre is inside the rectangle; exit through the closest face.
        const left = local.x + halfW;
        const right = halfW - local.x;
        const top = local.y + halfH;
        const bottom = halfH - local.y;
        const minDist = Math.min(left, right, top, bottom);
        if (minDist >= shipRadius) continue;
        penetration = shipRadius - minDist;
        if (minDist === left) { nx = -1; ny = 0; }
        else if (minDist === right) { nx = 1; ny = 0; }
        else if (minDist === top) { nx = 0; ny = -1; }
        else { nx = 0; ny = 1; }
      } else {
        const dist = Math.sqrt(dist2);
        if (dist >= shipRadius) continue;
        penetration = shipRadius - dist;
        const inv = 1 / dist;
        nx = lx * inv;
        ny = ly * inv;
      }
      const worldCos = Math.cos(piece.angle);
      const worldSin = Math.sin(piece.angle);
      const worldN = rotatePoint(nx, ny, worldCos, worldSin);
      ship.x += worldN.x * penetration;
      ship.y += worldN.y * penetration;
      ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + worldN.x * penetration;
      ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + worldN.y * penetration;
      const inwardSpeed = (ship.vx || 0) * worldN.x + (ship.vy || 0) * worldN.y;
      if (inwardSpeed < 0) {
        ship.vx -= inwardSpeed * worldN.x;
        ship.vy -= inwardSpeed * worldN.y;
      }
      hit = true;
    }
  }
  return hit;
}

// World-space hangar geometry for a placed home station. All of it is derived
// from the authored template, transformed by the station's pose.
function buildHangarGeometry(station) {
  const geometry = homeStationGeometry;
  const envelope = maximumShipEnvelope();
  const interiorSpawn = stationLocalToWorld(station, geometry.interiorSpawn.x, geometry.interiorSpawn.y);
  const mouth = stationLocalToWorld(station, geometry.aperture.x, 0);
  const rearWall = stationLocalToWorld(station, geometry.corridor.rearWallX, 0);
  const exitPoint = stationLocalToWorld(station, geometry.releasePlaneX, 0);
  return {
    angle: station.angle,
    interiorSpawn,
    mouth,
    rearWall,
    exitPoint,
    // Distance from the station centre at which a launching ship is clear.
    releaseDistance: geometry.releasePlaneX,
    corridorHalfWidth: geometry.corridor.halfWidth,
    corridorLength: geometry.corridor.length,
    apertureHalfWidth: geometry.aperture.halfWidth,
    maximumShipWidth: envelope.width,
    maximumShipHeight: envelope.height,
    clearance: geometry.clearance,
    clearanceCells: geometry.clearanceCells
  };
}

function createStationEntity(room, template, x, y, angle, stationType, team, ownerId, now) {
  const design = template.design.map((m) => ({ ...m }));
  const wiring = template.wiring; // wiring is treated as immutable; component power builds per-entity runtime state
  const stats = template.stats;
  const station = {
    id: `st${room.nextEntityId++}`,
    entityType: "station",
    stationType,
    team,
    ownerId: ownerId || null,
    x,
    y,
    angle,
    design,
    wiring,
    stats,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    shield: 0,
    maxShield: 0,
    state: stationType === "neutral" ? "neutral" : "operational",
    lastDamagedAt: 0,
    disabledAt: 0,
    productionQueue: [],
    activeLaunches: [],
    hangar: null,
    revision: 1,
    healthRevision: 1,
    stateRevision: 1,
    componentRevision: 1,
    productionRevision: 1,
    captureProgress: 0,
    captureRevision: 1
  };
  initComponentState(station);
  initializeComponentPower(station);
  // Stations are always fully powered; the ship-style power solve can leave
  // weapon components unpowered because it prioritises engines and shields.
  station.componentPowerState = new Array(design.length).fill(1);
  station.componentPower = station.componentPower || { byComponentIndex: [] };
  station.componentPower.byComponentIndex = design.map((_, i) => {
    const existing = station.componentPower.byComponentIndex?.[i] || {};
    return { ...existing, operationalMultiplier: 1, state: "powered" };
  });
  const shield = effectiveShieldStats(station);
  station.maxShield = Math.max(0, shield.capacity);
  station.shield = station.maxShield;
  initShipHeat(station);
  station.hp = station.componentHp.reduce((sum, hp) => sum + hp, 0);
  station.maxHp = station.componentMaxHp.reduce((sum, hp) => sum + hp, 0);
  // Stations are laid out on the ship grid but drawn and collided at their own
  // larger module scale; the client needs it to size the structure correctly.
  station.moduleScale = stationModuleScale(stationType);
  if (stationType === "home") station.hangar = buildHangarGeometry(station);
  station.collisionPieces = stationCollisionPieces(station);
  // Broad-phase radius covering every solid piece, for spatial-index queries.
  station.radius = station.collisionPieces.reduce(
    (max, piece) => Math.max(max, Math.hypot(piece.x - station.x, piece.y - station.y) + piece.radius),
    0
  );
  station.alive = station.state !== "disabled";
  initStationCombatRuntime(station);
  return station;
}

function findTeamHomeStation(room, team) {
  return room.stations?.find((s) => s.stationType === "home" && s.team === team) || null;
}

// Ships already paid for but not yet launched still occupy a fleet slot; the
// economy's fleet-cap validator only counts live hulls, so the queue has to be
// counted here or a player could buy an unbounded fleet one build at a time.
function queuedShipCount(room, playerId) {
  let total = 0;
  for (const station of room.stations || []) {
    if (station.stationType !== "home") continue;
    for (const queued of station.productionQueue) {
      if (queued.playerId === playerId) total += Math.max(0, queued.quantityRemaining);
    }
  }
  return total;
}

function enqueueStationProduction(room, player, item, now) {
  const station = findTeamHomeStation(room, player.team);
  if (!station) {
    return { type: "purchaseResult", ok: false, requestId: item.request.requestId, code: "no-home-station", message: "No home station available" };
  }
  if (station.state !== "operational") {
    return { type: "purchaseResult", ok: false, requestId: item.request.requestId, code: "station-disabled", message: "Your home station is disabled and cannot build ships" };
  }
  const active = player.ships.filter((ship) => ship.alive).length;
  const queued = queuedShipCount(room, player.id);
  if (active + queued + item.validation.count > player.shipCap) {
    return {
      type: "purchaseResult",
      ok: false,
      requestId: item.request.requestId,
      code: "fleet-cap",
      message: `Fleet cap reached: ${active} active + ${queued} in production of ${player.shipCap}`
    };
  }
  const cfg = INFRASTRUCTURE.homeStation;
  const queueItem = {
    id: `sq${room.nextEntityId++}`,
    playerId: player.id,
    requestId: item.request.requestId,
    template: item.template,
    combatStyle: item.request.combatStyle,
    unitCost: item.validation.totalCost / item.validation.count,
    quantityRemaining: item.validation.count,
    buildStartedAt: now,
    buildDurationSeconds: cfg.productionBaseSeconds + (item.template.stats.unitCost * cfg.productionCostSecondsMultiplier),
    state: "queued"
  };
  station.productionQueue.push(queueItem);
  station.productionRevision += 1;
  player.money = Math.max(0, player.money - item.validation.totalCost);
  player.spent = (player.spent || 0) + item.validation.totalCost;
  player.deployedFleetCost = (player.deployedFleetCost || 0) + item.validation.totalCost;
  return {
    type: "purchaseResult",
    ok: true,
    requestId: item.request.requestId,
    count: item.validation.count,
    unitCost: item.template.stats.unitCost,
    totalCost: item.validation.totalCost,
    money: Math.floor(player.money),
    activeShips: player.ships.filter((s) => s.alive).length,
    shipCap: player.shipCap,
    // Station mode never spawns on purchase, so the client has to be told the
    // hull is queued and roughly how long the hangar will hold it.
    queued: true,
    queuePosition: station.productionQueue.length,
    buildDurationSeconds: round2(queueItem.buildDurationSeconds)
  };
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

// Bots buy through buyShip() in Classic, which spawns instantly at the safe
// zone. In station mode they must use the same production queue as human
// purchases so a bot fleet is gated by hangar throughput too.
function enqueueBotProduction(room, player, now) {
  const stats = player.stats || computeStats(player.design, player.wiring);
  if (!(stats.unitCost > 0) || player.money < stats.unitCost) return null;
  const { canonicalBlueprintSignature, getOrCreateTemplate } = require("./shipTemplates");
  const signature = canonicalBlueprintSignature(player.design, player.wiring);
  const template = getOrCreateTemplate(player.id, player.design, player.wiring, stats, signature);
  const result = enqueueStationProduction(room, player, {
    template,
    request: { requestId: `bot:${player.id}:${room.nextEntityId}`, combatStyle: player.combatStyle || "hold" },
    validation: { count: 1, totalCost: stats.unitCost }
  }, now);
  return result.ok ? result : null;
}

// The corridor, in world space, as a swept segment from the interior spawn out
// past the release plane. A launch may only begin when nothing occupies it.
function corridorIsClear(room, station, ignoreShipId = null) {
  const hangar = station.hangar;
  if (!hangar) return false;
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  const from = hangar.rearWall;
  const length = homeStationGeometry.releasePlaneX - homeStationGeometry.corridor.rearWallX;
  const halfWidth = hangar.corridorHalfWidth;
  const candidates = room.spatialIndex?.queryRange
    ? room.spatialIndex.queryRange("ships", station.x, station.y, station.radius + length, [])
    : [...room.ships.values()];
  for (const ship of candidates) {
    if (!ship?.alive || ship.id === ignoreShipId) continue;
    // Project the ship into corridor space: along = distance down the corridor,
    // across = lateral offset from its centreline.
    const dx = ship.x - from.x;
    const dy = ship.y - from.y;
    const along = dx * cos + dy * sin;
    const across = -dx * sin + dy * cos;
    const shipRadius = Number(ship.physicalRadius) || Number(ship.radius) || 26;
    if (along < -shipRadius || along > length + shipRadius) continue;
    // The launching ship fits inside halfWidth by construction, so any hull
    // reaching into the band obstructs it.
    if (Math.abs(across) <= halfWidth + shipRadius) return false;
  }
  return true;
}

function spawnQueuedShip(room, station, queueItem, now) {
  const player = room.players.get(queueItem.playerId);
  if (!player || !player.ready) return null;
  const active = player.ships.filter((s) => s.alive).length;
  if (active >= player.shipCap) return null;
  const hangar = station.hangar;
  if (!hangar) return null;
  // One corridor, one launch at a time: two ships completing on the same tick
  // must not occupy it together.
  if (station.launchReservation) {
    bumpCounter(room, "stationLaunchBlockedCount");
    return null;
  }
  bumpCounter(room, "stationLaunchAttemptCount");
  const physicalRadius = computeDesignCollisionRadius(queueItem.template.design, queueItem.template.stats);
  if (!corridorIsClear(room, station)) {
    queueItem.blocked = true;
    station.productionRevision += 1;
    bumpCounter(room, "stationLaunchBlockedCount");
    return null;
  }
  const spawn = hangar.interiorSpawn;
  const ship = spawnShip(room, player, now, active, {
    template: queueItem.template,
    combatStyle: queueItem.combatStyle,
    spawnPoint: { x: spawn.x, y: spawn.y, ok: true, angle: station.angle },
    requestId: queueItem.requestId
  });
  if (!ship) return null;
  queueItem.blocked = false;
  ship.x = spawn.x;
  ship.y = spawn.y;
  ship.angle = station.angle;
  const speed = INFRASTRUCTURE.homeStation.launchSpeed;
  ship.vx = Math.cos(station.angle) * speed;
  ship.vy = Math.sin(station.angle) * speed;
  // Launch phase: the ship is under station control until its whole hull clears
  // the release plane. Ordinary stance, orders and weapons stay inert so it
  // cannot manoeuvre or shoot through the structure it is still inside.
  ship.launchPhase = {
    stationId: station.id,
    startedAt: now,
    angle: station.angle,
    releaseDistance: hangar.releaseDistance + physicalRadius
  };
  station.launchReservation = { shipId: ship.id, startedAt: now };
  station.activeLaunches.push({ shipId: ship.id, releasedAt: null, releasePlane: hangar.exitPoint });
  bumpCounter(room, "stationLaunchSuccessCount");
  // The purchase happened seconds ago and produced nothing visible at the time,
  // so the launch itself is what the buyer needs told about.
  if (!player.isBot) {
    const { sendPlayer } = require("./messages");
    sendPlayer(room, player, { type: "notice", message: "Your home station launched a ship" });
  }
  return ship;
}

// Development counters (section 24). Kept on the room so they reset with it and
// cost nothing in Classic, where no station code runs at all.
function bumpCounter(room, name) {
  const counters = room.stationCounters || (room.stationCounters = {});
  counters[name] = (counters[name] || 0) + 1;
}

function processStationProduction(room, station, dt, now) {
  if (station.state !== "operational" || !station.productionQueue.length) return;
  const item = station.productionQueue[0];
  if (item.state === "queued") {
    item.state = "building";
    item.buildStartedAt = now;
  }
  if (item.state === "building") {
    if (now - item.buildStartedAt >= item.buildDurationSeconds * 1000) {
      item.state = "complete-waiting-launch";
      station.productionRevision += 1;
    }
  }
  if (item.state === "complete-waiting-launch") {
    const ship = spawnQueuedShip(room, station, item, now);
    if (ship) {
      item.quantityRemaining -= 1;
      if (item.quantityRemaining <= 0) station.productionQueue.shift();
      station.productionRevision += 1;
    }
  }
}

// A launch record exists only while a freshly built ship is still clearing the
// hangar corridor. Without this sweep the list grows for the whole match, since
// nothing else ever removes an entry.
function updateStationLaunches(room, station, dt, now) {
  const launches = station.activeLaunches;
  if (!launches || launches.length === 0) return;
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  for (let i = launches.length - 1; i >= 0; i -= 1) {
    const launch = launches[i];
    const ship = room.ships.get(launch.shipId);
    if (!ship || !ship.alive) {
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
    // Hold the ship on the corridor centreline at a controlled speed. It is not
    // steering yet, so nothing can turn it into the structure.
    const speed = INFRASTRUCTURE.homeStation.launchSpeed;
    ship.angle = phase.angle;
    ship.vx = cos * speed;
    ship.vy = sin * speed;
    const along = (ship.x - station.x) * cos + (ship.y - station.y) * sin;
    if (along >= phase.releaseDistance) {
      // Fully clear: ordinary movement, orders and weapons resume, and the ship
      // heads for the player's rally point.
      ship.launchPhase = null;
      launch.releasedAt = now;
      releaseLaunch(station, launch.shipId);
      launches.splice(i, 1);
      const player = room.players.get(ship.ownerId);
      if (player) applyRallySlots(room, player, [ship]);
    }
  }
}

function releaseLaunch(station, shipId) {
  if (station.launchReservation?.shipId === shipId) station.launchReservation = null;
}

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

function updateStationRecovery(station, dt, now) {
  if (station.state !== "disabled") return;
  const cfg = station.stationType === "home" ? INFRASTRUCTURE.homeStation : INFRASTRUCTURE.relayStation;
  if (now - station.lastDamagedAt < cfg.disabledRecoveryDelaySeconds * 1000) return;
  const repair = (cfg.disabledRepairRatePerSecond || 12) * dt;
  station.hp = Math.min(station.maxHp, station.hp + repair);
  const threshold = station.maxHp * (cfg.reactivationHpRatio || 1);
  if (station.hp >= threshold) {
    station.state = "operational";
    station.stateRevision += 1;
    station.disabledAt = 0;
  }
  station.alive = station.state !== "disabled";
  station.healthRevision += 1;
}

function updateStationCapture(room, station, dt, now) {
  if (station.stationType !== "relay") return;

  const cfg = INFRASTRUCTURE.relayStation;
  const radiusSq = cfg.captureRadius * cfg.captureRadius;
  const counts = new Map();
  for (const ship of room.ships?.values() || []) {
    if (!ship.alive) continue;
    const dx = ship.x - station.x;
    const dy = ship.y - station.y;
    if (dx * dx + dy * dy > radiusSq) continue;
    const player = room.players.get(ship.ownerId);
    if (!player) continue;
    const entry = counts.get(player.team) || { count: 0, ownerId: ship.ownerId };
    entry.count += 1;
    counts.set(player.team, entry);
  }

  const contenders = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);

  if (contenders.length === 0) {
    if (station.state === "disabled") {
      const decay = (cfg.captureDecayPerSecond || 0) * dt;
      station.captureProgress = Math.max(0, (station.captureProgress || 0) - decay);
    }
    return;
  }

  station.captureContested = contenders.length > 1 && contenders[0][1].count === contenders[1][1].count;
  if (station.captureContested) return;

  const [leaderTeam, leader] = contenders[0];

  function captureStation(newOwnerId, newTeam) {
    station.ownerId = newOwnerId;
    station.team = newTeam;
    station.state = "operational";
    station.alive = true;
    station.hp = station.maxHp;
    station.captureProgress = 0;
    station.captureRevision += 1;
    station.stateRevision += 1;
    station.healthRevision += 1;
  }

  if (station.state === "neutral") {
    captureStation(leader.ownerId, leaderTeam);
    return;
  }

  // An active owned relay must be disabled (HP below threshold) before it can change hands.
  if (station.state === "operational") return;

  if (station.state === "disabled") {
    if (leaderTeam === station.team) {
      // Friendly presence halts enemy capture progress.
      station.captureProgress = 0;
      return;
    }
    const duration = cfg.captureDurationSeconds || 5;
    station.captureProgress = Math.min(1, (station.captureProgress || 0) + dt / duration);
    if (station.captureProgress >= 1) {
      captureStation(leader.ownerId, leaderTeam);
    }
  }
}

function createStationsForRoom(room, now) {
  if (!usesStationInfrastructure(room)) return;
  destroyStationsForRoom(room);
  room.stations = [];
  room.stationsById = new Map();
  const safeZones = room.map?.safeZones || [];
  for (const zone of safeZones) {
    const x = Number(zone.x) || room.world.width / 2;
    const y = Number(zone.y) || room.world.height / 2;
    const toCenter = Math.atan2(room.world.height / 2 - y, room.world.width / 2 - x);
    const angle = toCenter;
    const station = createStationEntity(room, homeStationTemplate, x, y, angle, "home", zone.team || zone.ownerId, zone.ownerId, now);
    room.stations.push(station);
    room.stationsById.set(station.id, station);
  }
  const relays = room.map?.relays || [];
  for (const relay of relays) {
    const station = createStationEntity(room, relayStationTemplate, relay.x, relay.y, 0, "relay", null, null, now);
    station.state = "neutral";
    room.stations.push(station);
    room.stationsById.set(station.id, station);
  }
  room.stationRevision = (room.stationRevision || 0) + 1;
}

function destroyStationsForRoom(room) {
  if (!room.stations) return;
  room.stations = [];
  room.stationsById = null;
  room.stationRevision = (room.stationRevision || 0) + 1;
}

function updateStationSelfRepair(station, dt) {
  if (station.state !== "operational" || station.hp >= station.maxHp) return;
  const cfg = station.stationType === "home" ? INFRASTRUCTURE.homeStation : INFRASTRUCTURE.relayStation;
  const rate = cfg?.selfRepairRatePerSecond || cfg?.disabledRepairRatePerSecond || 12;
  const before = station.hp;
  station.hp = Math.min(station.maxHp, station.hp + rate * dt);
  if (station.hp !== before) station.healthRevision += 1;
}

function updateStations(room, dt, now) {
  if (!usesStationInfrastructure(room) || !room.stations) return;
  for (const station of room.stations) {
    updateStationCapture(room, station, dt, now);
    updateStationRecovery(station, dt, now);
    updateStationSelfRepair(station, dt);
    updateStationLaunches(room, station, dt, now);
    updateStationRepair(room, station, dt, now);
    processStationProduction(room, station, dt, now);
  }
}

module.exports = {
  homeStationTemplate,
  relayStationTemplate,
  isStation,
  isOperationalStation,
  isDamageableEntity,
  isCombatEntity,
  isHostileEntity,
  createStationsForRoom,
  destroyStationsForRoom,
  updateStations,
  enqueueStationProduction,
  enqueueBotProduction,
  queuedShipCount,
  findTeamHomeStation,
  usesStationInfrastructure,
  resolveStationCollision
};
