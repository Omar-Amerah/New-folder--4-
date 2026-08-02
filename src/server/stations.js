"use strict";

const { PARTS } = require("./components");
const { INFRASTRUCTURE } = require("./config");
const { angleDifference, clampNumber, rotateToward, performanceNow } = require("./utils");
const { computeStats } = require("./shipStats");
const { createGeneratedPowerWiring } = require("./shipDesign");
const { initComponentState, isComponentAlive, repairShipComponents } = require("./componentHealth");
const { initializeComponentPower, effectiveShieldStats } = require("./componentPower");
const { initShipHeat } = require("./heat");
const { computeDesignFootprintRadius, computeDesignCollisionRadius } = require("./componentGeometry");
const { spawnShip, applyRallySlots } = require("./ships");
const { usesStationInfrastructure } = require("./rooms");
const { initStationCombatRuntime, stationModuleWorldPosition } = require("./stationCombat");
const TurretRules = require("../../public/src/shared/turretRules");
const { getShipComponentIndexes } = require("./componentIndexes");
const { computeStationShieldCollisionRadius } = require("./stationCollision");
const { stationBroadPhaseRadius } = require("./spatialIndex");
const { INCREMENTAL_SPATIAL_INDEX } = require("./performanceFlags");
const { bump, recordDuration, detailedProfileActive } = require("./roomTelemetry");

const {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  MAX_SHIP_EXTENT,
  HOME_STATION_CELLS,
  stationModuleScale,
  moduleCentreToLocal,
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

function enemyPlayerCountForHomeStation(room, team, ownerId) {
  const players = [...(room?.players?.values?.() || [])].filter((player) => !player.removed);
  if (room?.rules?.gameMode === "solo") {
    return Math.max(1, players.filter((player) => player.id !== ownerId).length);
  }
  return Math.max(1, players.filter((player) => player.team && player.team !== team).length);
}

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
  const toPiece = (rect, door) => {
    const cx = (rect.minX + rect.maxX) / 2;
    const cy = (rect.minY + rect.maxY) / 2;
    const centre = rotatePoint(cx, cy, cos, sin);
    return {
      x: station.x + centre.x,
      y: station.y + centre.y,
      halfWidth: (rect.maxX - rect.minX) / 2,
      halfHeight: (rect.maxY - rect.minY) / 2,
      angle: station.angle,
      // Stations never move, so the rotation into and out of the piece's local
      // frame is fixed. Collision resolution runs per ship per separation
      // iteration; deriving these trigonometrically each time was pure waste.
      cos: cos,
      sin: sin,
      // Broad-phase circle so spatial queries can reject quickly.
      radius: Math.hypot(rect.maxX - rect.minX, rect.maxY - rect.minY) / 2,
      door: Boolean(door)
    };
  };
  const pieces = geometry.collisionRects.map((rect) => toPiece(rect, false));
  if (geometry.doorRect) pieces.push(toPiece(geometry.doorRect, true));
  return pieces;
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
  const shipX = ship.x || 0;
  const shipY = ship.y || 0;
  let hit = false;
  for (const station of room.stations) {
    if (!station?.collisionPieces?.length) continue;
    // station.radius already bounds every solid piece. Almost every ship on the
    // map is nowhere near a given structure, and this runs for each of them on
    // each separation iteration, so reject the whole station in one test before
    // walking its pieces.
    const reach = (Number(station.radius) || 0) + shipRadius;
    const stationDx = shipX - station.x;
    const stationDy = shipY - station.y;
    if (stationDx * stationDx + stationDy * stationDy > reach * reach) continue;
    // The blast door stands open only for the hull this station is currently
    // launching, and only while it is still clearing the corridor. Everything
    // else — including the launched ship the moment it is released — bounces
    // off it, so the hangar is a one-way door.
    const launching = Boolean(ship.launchPhase) && ship.launchPhase.stationId === station.id;
    for (const piece of station.collisionPieces) {
      if (piece.door && launching) continue;
      const cos = piece.cos !== undefined ? piece.cos : Math.cos(-piece.angle);
      const sin = piece.sin !== undefined ? -piece.sin : Math.sin(-piece.angle);
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
        // The hull must travel from its centre to the nearest face, then one
        // full radius farther so the circle clears the solid piece.
        penetration = minDist + shipRadius;
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
      const worldCos = piece.cos !== undefined ? piece.cos : Math.cos(piece.angle);
      const worldSin = piece.sin !== undefined ? piece.sin : Math.sin(piece.angle);
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
// from the authored template, transformed by the station's pose. Every member
// of a team uses the same central launch path.
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
    clearance: geometry.clearance
  };
}

// Where each weapon module physically sits, in structure-local space.
//
// These used to be a hand-authored cosmetic ring of twelve slots that the
// weapon list was cycled through with a modulo, which meant an eighteen-gun
// home station stacked six turrets on top of six others and every one of them
// fired from a point unrelated to the module it belonged to. They are now the
// module centres themselves, so the turret art, the muzzle, the firing arc and
// the component that takes the damage are all the same place on the structure.
function computeStationHardpoints(station) {
  const design = station.design || [];
  const indexes = getShipComponentIndexes(station).weaponIndices;
  const scale = station.moduleScale || stationModuleScale(station.stationType);
  const result = new Array(design.length).fill(null);
  for (const index of indexes) {
    const module = design[index];
    if (!module) continue;
    result[index] = moduleCentreToLocal(module, scale, PARTS[module.type]?.footprint);
  }
  return result;
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
  const stationConfig = stationType === "home" ? INFRASTRUCTURE.homeStation : INFRASTRUCTURE.relayStation;
  const enemyPlayerCount = stationType === "home"
    ? enemyPlayerCountForHomeStation(room, team, ownerId)
    : 1;
  const configuredShieldScale = Number(stationConfig?.shieldScale);
  const shieldScale = (Number.isFinite(configuredShieldScale) && configuredShieldScale >= 0
    ? configuredShieldScale
    : 1) * enemyPlayerCount;
  const shield = effectiveShieldStats(station);
  station.maxShield = Math.max(0, shield.capacity * shieldScale);
  station.shield = station.maxShield;
  initShipHeat(station);
  // Optional hull scale from the balance sheet. A station's component sheet
  // can add up to a structure far too tough to contest inside a match,
  // so it is scaled down here rather than by hand-editing every module's HP —
  // the design stays a normal component structure, it is just built lighter.
  // Scaling the per-component arrays (not just the totals) keeps component
  // damage, destruction and the HP total consistent with each other.
  const configuredHullScale = Number(stationConfig?.hullScale);
  const hullScale = (Number.isFinite(configuredHullScale) && configuredHullScale > 0
    ? configuredHullScale
    : 1) * enemyPlayerCount;
  if (Number.isFinite(hullScale) && hullScale > 0 && hullScale !== 1) {
    for (let i = 0; i < station.componentMaxHp.length; i += 1) {
      station.componentMaxHp[i] *= hullScale;
      station.componentHp[i] *= hullScale;
    }
  }
  station.hp = station.componentHp.reduce((sum, hp) => sum + hp, 0);
  station.maxHp = station.componentMaxHp.reduce((sum, hp) => sum + hp, 0);
  station.enemyPlayerCount = enemyPlayerCount;
  // Stations are laid out on the ship grid but drawn and collided at their own
  // larger module scale; the client needs it to size the structure correctly.
  station.moduleScale = stationModuleScale(stationType);
  if (stationType === "home") {
    station.hangar = buildHangarGeometry(station);
  }
  station.collisionPieces = stationCollisionPieces(station);
  station.shieldRadius = computeStationShieldCollisionRadius(station);
  // Broad-phase radius covering every solid piece, for spatial-index queries.
  station.radius = station.collisionPieces.reduce(
    (max, piece) => Math.max(max, Math.hypot(piece.x - station.x, piece.y - station.y) + piece.radius),
    0
  );
  station.hardpoints = computeStationHardpoints(station);
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

// How long a hull sits in the hangar.
//
// This used to be driven almost entirely by cost, which barely moved the number
// at all — every hull from a two-module scout to a maximum capital took between
// 1.2 and 2.0 seconds, so the hangar was a formality rather than a throughput
// constraint. It now scales with the SIZE of the ship, measured in modules,
// which is the thing a player is actually trading against build time. The
// complete curve is divided once at the end to make production exactly 2x
// faster without changing the relative small-vs-capital timing.
function stationBuildSeconds(template) {
  const cfg = INFRASTRUCTURE.homeStation;
  const modules = Array.isArray(template?.design) ? template.design.length : 0;
  const perModule = Number(cfg.productionSecondsPerModule) || 0;
  const base = Number(cfg.productionBaseSeconds) || 0;
  const costTerm = (Number(template?.stats?.unitCost) || 0) * (Number(cfg.productionCostSecondsMultiplier) || 0);
  return Math.max(0.2, (base + modules * perModule + costTerm) / 2);
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
    buildDurationSeconds: stationBuildSeconds(item.template),
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
  const detailed = detailedProfileActive(room);
  const startedAt = detailed ? performanceNow() : 0;
  try {
  const hangar = station.hangar;
  if (!hangar) return false;
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  const from = hangar.rearWall;
  // Only the corridor INTERIOR has to be clear — from the rear bulkhead to the
  // mouth. It used to extend all the way out to the release plane, which meant
  // anything drifting past the front of the station, friendly or hostile,
  // halted production for as long as it loitered there. Nothing can get inside
  // the corridor any more (see the blast door in stationCollisionPieces), so
  // the only thing this can now catch is a hull that has not finished leaving.
  // Outside the mouth is open space: the launching ship handles it the way any
  // other ship handles traffic, through ordinary collision.
  const length = homeStationGeometry.corridor.length;
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
    // The mouth is a hard boundary for launch clearance. A hostile hull outside
    // may overlap this band with its collision radius, but allowing that radius
    // to veto the launch lets enemies blockade production without entering the
    // one-way door. Normal separation handles contact with the launched hull.
    if (along < -shipRadius || along > length) continue;
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
  const hangar = station.hangar;
  if (!hangar) {
    if (detailed) bump(room, "stationSpawnMissingHangarBlocks");
    return null;
  }
  bumpCounter(room, "stationLaunchAttemptCount");
  const startedAt = detailed ? performanceNow() : 0;
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
  if (detailed) recordDuration(room, "stationSpawnAttemptMs", startedAt);
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
  station.activeLaunches.push({ shipId: ship.id, releasedAt: null, releasePlane: hangar.exitPoint });
  bumpCounter(room, "stationLaunchSuccessCount");
  // No launch notice: the hangar's build bar and the ship itself flying out of
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

function processStationProduction(room, station, dt, now) {
  if (station.stationType !== "home") return;
  const detailed = detailedProfileActive(room);
  if (detailed) bump(room, "stationQueuesVisited");
  if (station.state !== "operational" || !station.productionQueue.length) {
    if (detailed && !station.productionQueue.length) bump(room, "stationEmptyQueueSkips");
    return;
  }
  while (station.productionQueue.length > 0) {
    const item = station.productionQueue[0];
    if (detailed) bump(room, "stationQueueItemsVisited");
    const queueStart = detailed ? performanceNow() : 0;
    if (item.state === "queued") {
      item.state = "complete-waiting-launch";
      station.productionRevision += 1;
    }
    if (detailed) recordDuration(room, "stationProductionQueueMs", queueStart);
    const ship = spawnQueuedShip(room, station, item, now);
    if (!ship) break; // blocked by fleet cap or spawn failure; retry next tick
    const completionStart = detailed ? performanceNow() : 0;
    item.quantityRemaining -= 1;
    station.productionRevision += 1;
    if (item.quantityRemaining <= 0) station.productionQueue.shift();
    if (detailed) recordDuration(room, "stationProductionQueueMs", completionStart);
  }
}

// A launch record exists only while a freshly built ship is still clearing the
// hangar corridor. Without this sweep the list grows for the whole match, since
// nothing else ever removes an entry.
function updateStationLaunches(room, station, dt, now) {
  const detailed = detailedProfileActive(room);
  const startedAt = detailed ? performanceNow() : 0;
  try {
  const launches = station.activeLaunches;
  if (!launches || launches.length === 0) {
    if (detailed && station.stationType === "home") bump(room, "stationEmptyLaunchSkips");
    return;
  }
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
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
      const releaseStartedAt = detailed ? performanceNow() : 0;
      ship.launchPhase = null;
      launch.releasedAt = now;
      releaseLaunch(station, launch.shipId);
      launches.splice(i, 1);
      const player = room.players.get(ship.ownerId);
      if (player) applyRallySlots(room, player, [ship]);
      if (detailed) bump(room, "stationLaunchesReleased");
      if (detailed) recordDuration(room, "stationLaunchReleaseMs", releaseStartedAt);
    }
  }
  } finally {
    if (detailed) recordDuration(room, "stationLaunchControlMs", startedAt);
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

// Long-range repair emitters. The close-in aura above only reaches ships that
// are already docked-in-all-but-name; these are the station reaching out to a
// damaged hull well beyond it, and unlike the aura they are visible — each
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
  const detailed = detailedProfileActive(room);
  if (detailed) bump(room, "stationRelaysProcessed");

  const cfg = INFRASTRUCTURE.relayStation;
  const radiusSq = cfg.captureRadius * cfg.captureRadius;
  const counts = new Map();
  const candidateStartedAt = detailed ? performanceNow() : 0;
  let candidatesVisited = 0;
  let eligibleShips = 0;
  if (detailed) bump(room, "stationCaptureFullShipScans");
  for (const ship of room.ships?.values() || []) {
    if (detailed) candidatesVisited += 1;
    if (!ship.alive) continue;
    const dx = ship.x - station.x;
    const dy = ship.y - station.y;
    if (dx * dx + dy * dy > radiusSq) continue;
    const player = room.players.get(ship.ownerId);
    if (!player) continue;
    const entry = counts.get(player.team) || { count: 0, ownerId: ship.ownerId };
    entry.count += 1;
    counts.set(player.team, entry);
    if (detailed) eligibleShips += 1;
  }
  if (detailed) {
    bump(room, "stationCaptureCandidatesVisited", candidatesVisited);
    bump(room, "stationCaptureEligibleShips", eligibleShips);
    recordDuration(room, "stationCaptureCandidateCollectionMs", candidateStartedAt);
  }

  const aggregationStartedAt = detailed ? performanceNow() : 0;
  const contenders = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  if (detailed) {
    recordDuration(room, "stationCaptureAggregationMs", aggregationStartedAt);
    bump(room, "stationCaptureTeamsPresent", counts.size);
  }
  const transitionStartedAt = detailed ? performanceNow() : 0;
  try {
  const duration = cfg.captureDurationSeconds || 5;
  const decayPerSecond = Number(cfg.captureDecayPerSecond) || 0;

  // `captureTeam` is who the bar currently belongs to, so the client can draw
  // the progress sweep in the capturing side's colour instead of a generic
  // amber. It is cleared with the progress it describes.
  function setProgress(value, team = null) {
    const previous = station.captureProgress || 0;
    const previousTeam = station.captureTeam;
    const next = Math.max(0, Math.min(1, value));
    if (Math.round(next * 100) !== Math.round((station.captureProgress || 0) * 100)) station.captureRevision += 1;
    station.captureProgress = next;
    const nextTeam = next > 0 ? team : null;
    if (station.captureTeam !== nextTeam) {
      station.captureTeam = nextTeam;
      station.captureRevision += 1;
    }
    if (detailed && (next !== previous || nextTeam !== previousTeam)) bump(room, "stationCaptureProgressChanges");
  }

  // Progress bleeds away whenever nobody capturable is standing on the relay.
  // Without this an attacker could bank 4.9 seconds of a 5 second capture,
  // withdraw, and come back at any point in the match to finish it instantly.
  if (contenders.length === 0) {
    station.captureContested = false;
    setProgress((station.captureProgress || 0) - decayPerSecond * dt, station.captureTeam);
    return;
  }

  station.captureContested = contenders.length > 1 && contenders[0][1].count === contenders[1][1].count;
  if (station.captureContested) {
    if (detailed) bump(room, "stationCaptureContestedTicks");
    return;
  }

  const [leaderTeam, leader] = contenders[0];

  function captureStation(newOwnerId, newTeam) {
    station.ownerId = newOwnerId;
    station.team = newTeam;
    station.state = "operational";
    station.alive = true;
    // A relay taken while wrecked comes back as a wreck. Handing the captor a
    // fully repaired fortress the instant they finish the capture is what
    // `captureRestoreHpRatio` exists to prevent — it had simply never been
    // read. An intact neutral relay keeps the HP it already had.
    const restore = Number(cfg.captureRestoreHpRatio);
    const floor = Number.isFinite(restore) && restore > 0 ? station.maxHp * restore : station.maxHp;
    station.hp = Math.min(station.maxHp, Math.max(station.hp, floor));
    setProgress(0);
    station.captureRevision += 1;
    station.stateRevision += 1;
    station.healthRevision += 1;
    if (detailed) bump(room, "stationCapturesCompleted");
  }

  // An active owned relay must be disabled (HP below threshold) before it can change hands.
  if (station.state === "operational") return;

  // A new leader must first erase the previous team's capture bar. Otherwise
  // changing `captureTeam` would let the new side inherit the old progress.
  if (
    station.captureProgress > 0 &&
    station.captureTeam &&
    station.captureTeam !== leaderTeam
  ) {
    setProgress(
      Math.max(0, station.captureProgress - dt / duration),
      station.captureTeam
    );
    return;
  }

  // Taking an unclaimed relay runs the same clock as taking one off an enemy,
  // so the capture ring and the objective HUD percentage mean the same thing in
  // both cases. It used to flip owner on the first tick a hull was in range.
  if (station.state === "neutral") {
    setProgress((station.captureProgress || 0) + dt / duration, leaderTeam);
    if (station.captureProgress >= 1) captureStation(leader.ownerId, leaderTeam);
    return;
  }

  if (station.state === "disabled") {
    if (leaderTeam === station.team) {
      // Friendly presence halts enemy capture progress.
      setProgress(0);
      return;
    }
    setProgress((station.captureProgress || 0) + dt / duration, leaderTeam);
    if (station.captureProgress >= 1) {
      captureStation(leader.ownerId, leaderTeam);
    }
  }
  } finally {
    if (detailed) recordDuration(room, "stationCaptureStateTransitionMs", transitionStartedAt);
  }
}

function createStationsForRoom(room, now) {
  if (!usesStationInfrastructure(room)) return;
  destroyStationsForRoom(room);
  room.stations = [];
  room.stationsById = new Map();
  const safeZones = room.map?.safeZones || [];
  const teamHomes = new Set();
  for (const zone of safeZones) {
    // Team spawn planning keeps a protected region for every player, but the
    // team shares one actual hangar. Creating a home station for every one of
    // those regions rendered several identical stations and left all but the
    // first one idle because production already resolves through
    // findTeamHomeStation(). Solo players still receive their own station.
    const sharedTeam = room.rules?.gameMode !== "solo" ? zone.team : null;
    if (sharedTeam && teamHomes.has(sharedTeam)) continue;
    if (sharedTeam) teamHomes.add(sharedTeam);
    const x = Number(zone.x) || room.world.width / 2;
    const y = Number(zone.y) || room.world.height / 2;
    const toCenter = Math.atan2(room.world.height / 2 - y, room.world.width / 2 - x);
    const angle = toCenter;
    const station = createStationEntity(room, homeStationTemplate, x, y, angle, "home", zone.team || zone.ownerId, zone.ownerId, now);
    room.stations.push(station);
    room.stationsById.set(station.id, station);
    if (room._visibilityRuntime) {
      const visibilityRuntime = require("./visibilityRuntime");
      visibilityRuntime.registerEntityMembership(room, room._visibilityRuntime, station, "station");
      visibilityRuntime.registerSensorSource(room, station, "station");
    }
  }
  const relays = room.map?.relays || [];
  for (const relay of relays) {
    const station = createStationEntity(room, relayStationTemplate, relay.x, relay.y, 0, "relay", null, null, now);
    station.state = "neutral";
    // The map's objective letter (A, B, C...). The HUD, the objective badges and
    // the victory notices all name relays by it, so the structure that replaced
    // the abstract capture point has to carry it.
    station.relayId = relay.id;
    room.stations.push(station);
    room.stationsById.set(station.id, station);
    if (room._visibilityRuntime) {
      const visibilityRuntime = require("./visibilityRuntime");
      visibilityRuntime.registerEntityMembership(room, room._visibilityRuntime, station, "station");
      visibilityRuntime.registerSensorSource(room, station, "station");
    }
  }
  room.stationRevision = (room.stationRevision || 0) + 1;
}

function destroyStationsForRoom(room) {
  if (!room.stations) return;
  if (room._visibilityRuntime) {
    const visibilityRuntime = require("./visibilityRuntime");
    for (const station of room.stations) visibilityRuntime.unregisterEntity(room, station, "station");
  }
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

// These stage helpers deliberately accept one station. updateStations keeps the
// historical per-station ordering (capture -> recovery -> self repair -> launch
// control -> repair -> production) while exposing independent timing buckets.
// Splitting into room-wide loops here would make a later station's state visible
// to an earlier station in a different order than the starting runtime.
function updateStationCaptureSystems(room, station, dt, now) {
  const startedAt = performanceNow();
  try {
    updateStationCapture(room, station, dt, now);
  } finally {
    recordDuration(room, "stationObjectiveRuntimeMs", startedAt);
  }
}

function updateStationRecoverySystems(room, station, dt, now) {
  const startedAt = performanceNow();
  try {
    updateStationRecovery(station, dt, now);
  } finally {
    recordDuration(room, "stationRecoveryRuntimeMs", startedAt);
  }
}

function updateStationRepairSystems(room, station, dt, now, phase = "all") {
  const startedAt = performanceNow();
  try {
    if (phase === "self" || phase === "all") updateStationSelfRepair(station, dt);
    if (phase === "active" || phase === "all") {
      updateStationRepair(room, station, dt, now);
      updateStationRepairBeams(room, station, dt, now);
    }
  } finally {
    recordDuration(room, "stationRepairRuntimeMs", startedAt);
  }
}

function updateStationHangarSystems(room, station, dt, now, phase = "all") {
  const startedAt = performanceNow();
  try {
    if (detailedProfileActive(room) && station.stationType === "home" && (phase === "launches" || phase === "all")) {
      bump(room, "stationHomeStationsProcessed");
    }
    if (phase === "launches" || phase === "all") updateStationLaunches(room, station, dt, now);
    if (phase === "production" || phase === "all") processStationProduction(room, station, dt, now);
  } finally {
    recordDuration(room, "stationHangarRuntimeMs", startedAt);
  }
}

function updateStations(room, dt, now) {
  if (!usesStationInfrastructure(room) || !room.stations) return;
  const startedAt = performanceNow();
  try {
    for (const station of room.stations) {
      updateStationCaptureSystems(room, station, dt, now);
      updateStationRecoverySystems(room, station, dt, now);
      updateStationRepairSystems(room, station, dt, now, "self");
      updateStationHangarSystems(room, station, dt, now, "launches");
      updateStationRepairSystems(room, station, dt, now, "active");
      updateStationHangarSystems(room, station, dt, now, "production");
    }
    if (room.spatialIndex?.updateLiveEntities && INCREMENTAL_SPATIAL_INDEX()) {
      room.spatialIndex.updateLiveEntities("stations", room.stations, stationBroadPhaseRadius);
    }
  } finally {
    recordDuration(room, "stationRuntimeMs", startedAt);
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
  updateStationCaptureSystems,
  updateStationRecoverySystems,
  updateStationRepairSystems,
  updateStationHangarSystems,
  enqueueStationProduction,
  enqueueBotProduction,
  queuedShipCount,
  findTeamHomeStation,
  usesStationInfrastructure,
  resolveStationCollision
};
