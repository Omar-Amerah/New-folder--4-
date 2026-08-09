"use strict";

const { PARTS } = require("./components");
const { INFRASTRUCTURE } = require("./config");
const { angleDifference, clampNumber, rotateToward, performanceNow } = require("./utils");
const { areEntityAllies } = require("./relationships");
const { computeStats } = require("./shipStats");
const { initComponentState, isComponentAlive, repairShipComponents } = require("./componentHealth");
const { initializeComponentPower, effectiveShieldStats } = require("./componentPower");
const { initShipHeat } = require("./heat");
const {
  computeDesignCollisionRadius,
  computeDesignAxisExtents,
  shipHullCircles
} = require("./componentGeometry");
const { spawnShip, applyRallyPoint } = require("./ships");
const { usesStationInfrastructure } = require("./rooms");
const {
  initStationCombatRuntime,
  stationModuleWorldPosition,
  transferRelayControl,
  repairStationComponents,
  relayRecoveryThresholdRatio
} = require("./stationCombat");
const TurretRules = require("../../public/src/shared/turretRules");
const { getShipComponentIndexes } = require("./componentIndexes");
const { computeStationShieldCollisionRadius } = require("./stationCollision");
const { stationBroadPhaseRadius } = require("./spatialIndex");
const { bump, recordDuration, detailedProfileActive } = require("./roomTelemetry");

const {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  MAX_SHIP_EXTENT,
  HULL_CELL_PADDING,
  stationModuleScale,
  moduleCentreToLocal,
  buildHomeStationDesign,
  buildRelayStationDesign,
  buildHomeStationGeometry,
  buildRelayStationGeometry
} = require("./stationTemplates");

function buildStationTemplate(design) {
  const stats = computeStats(design);
  return Object.freeze({ design: design.map((m) => Object.freeze({ ...m })), dataLinks: [], stats });
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
const HOME_DURABILITY_PER_ENEMY_PLAYER = 8000;

// The maximum ship a player can design, in world units. Every hangar
// dimension derives from this so the two can never drift apart.
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
// section plus one-way mouth doors for each authored launch corridor. The
// three hangar openings are deliberately not among the hull pieces, so ships
// can travel through genuine gaps in the station.
function stationCollisionPieces(station) {
  const geometry = station.stationType === "home" ? homeStationGeometry : relayStationGeometry;
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  const toPiece = (rect, door, bayIndex = null) => {
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
      door: Boolean(door),
      bayIndex: door ? bayIndex : undefined
    };
  };
  const pieces = geometry.collisionRects.map((rect) => toPiece(rect, false));
  if (Array.isArray(geometry.doorRects)) {
    geometry.doorRects.forEach((rect, index) => pieces.push(toPiece(rect, true, index)));
  } else if (geometry.doorRect) {
    pieces.push(toPiece(geometry.doorRect, true, null));
  }
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

function resolveStationCollision(
  room,
  ship,
  shipRadius,
  onContact = null,
  maxCorrection = Number.POSITIVE_INFINITY
) {
  if (!room?.stations?.length) return false;
  const staticContactEpsilon = 0.5;
  const shipX = ship.x || 0;
  const shipY = ship.y || 0;
  let hit = false;
  const contacts = [];
  for (let stationIndex = 0; stationIndex < room.stations.length; stationIndex += 1) {
    const station = room.stations[stationIndex];
    if (!station?.collisionPieces?.length) continue;
    // station.radius already bounds every solid piece. Almost every ship on the
    // map is nowhere near a given structure, and this runs for each of them on
    // each separation iteration, so reject the whole station in one test before
    // walking its pieces.
    const reach = (Number(station.radius) || 0) + shipRadius;
    const stationDx = shipX - station.x;
    const stationDy = shipY - station.y;
    if (stationDx * stationDx + stationDy * stationDy > reach * reach) continue;
    // Only the hull this station is currently launching gets an own-station
    // collision exemption, and only while it is still clearing its corridor.
    // Every other ship — including the launched ship the moment it is released
    // — collides with the solid hull and the one-way mouth doors normally.
    const launching = Boolean(ship.launchPhase) && ship.launchPhase.stationId === station.id;
    // During the controlled launch window the ship is allowed to overlap its
    // own station geometry. This is what lets the historical three-cell bays
    // release a maximum-size hull without trapping it in a divider or rear
    // bulkhead. The exemption ends exactly at the recorded release plane.
    if (launching) continue;
    const circles = Array.isArray(ship.design) && ship.design.length
      ? shipHullCircles(ship)
      : [{ x: ship.x || 0, y: ship.y || 0, radius: shipRadius }];
    for (const circle of circles) {
      for (let pieceIndex = 0; pieceIndex < station.collisionPieces.length; pieceIndex += 1) {
        const piece = station.collisionPieces[pieceIndex];
      const cos = piece.cos !== undefined ? piece.cos : Math.cos(-piece.angle);
      const sin = piece.sin !== undefined ? -piece.sin : Math.sin(-piece.angle);
      const local = rotatePoint(circle.x - piece.x, circle.y - piece.y, cos, sin);
      const halfW = piece.halfWidth;
      const halfH = piece.halfHeight;
      const circleRadius = Number(circle.radius) || shipRadius;
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
        penetration = minDist + circleRadius;
        if (minDist === left) { nx = -1; ny = 0; }
        else if (minDist === right) { nx = 1; ny = 0; }
        else if (minDist === top) { nx = 0; ny = -1; }
        else { nx = 0; ny = 1; }
      } else {
        const dist = Math.sqrt(dist2);
        if (dist > circleRadius + staticContactEpsilon) continue;
        penetration = Math.max(0, circleRadius - dist);
        const inv = 1 / dist;
        nx = lx * inv;
        ny = ly * inv;
      }
      const worldCos = piece.cos !== undefined ? piece.cos : Math.cos(piece.angle);
      const worldSin = piece.sin !== undefined ? piece.sin : Math.sin(piece.angle);
      const worldN = rotatePoint(nx, ny, worldCos, worldSin);
      const inwardSpeed = (ship.vx || 0) * worldN.x + (ship.vy || 0) * worldN.y;
      if (inwardSpeed < 0) {
        ship.vx -= inwardSpeed * worldN.x;
        ship.vy -= inwardSpeed * worldN.y;
      }
      contacts.push({
        obstacleId: `station:${String(station.id ?? stationIndex)}:${String(piece.id ?? pieceIndex)}`,
        normalX: worldN.x,
        normalY: worldN.y,
        penetration
      });
      hit = true;
      }
    }
  }

  // A compound ship can expose many hull cells to the same station wall. The
  // old loop translated the ship once per cell, so three touching cells could
  // turn one shallow wall contact into three sequential displacements. Keep
  // the deepest contact for aligned normals, and combine only independent
  // directions such as a genuine corner contact. Opposing normals are
  // incompatible (the hull is trapped between faces), so retain the deepest
  // side and let the next authoritative step continue the recovery.
  const normalGroups = [];
  for (const contact of contacts) {
    if (!(Number(contact.penetration) > 0)) continue;
    const nx = Number(contact.normalX) || 0;
    const ny = Number(contact.normalY) || 0;
    const group = normalGroups.find((candidate) => (
      candidate.normalX * nx + candidate.normalY * ny >= 0.98
    ));
    if (!group) {
      normalGroups.push({ ...contact, normalX: nx, normalY: ny });
    } else if (contact.penetration > group.penetration) {
      group.penetration = contact.penetration;
    }
  }
  normalGroups.sort((a, b) => b.penetration - a.penetration);
  let correctionX = 0;
  let correctionY = 0;
  for (const group of normalGroups) {
    const candidateX = group.normalX * group.penetration;
    const candidateY = group.normalY * group.penetration;
    const existingLength = Math.hypot(correctionX, correctionY);
    const candidateLength = Math.hypot(candidateX, candidateY);
    if (existingLength > 0.001
      && correctionX * candidateX + correctionY * candidateY
        < -0.25 * existingLength * candidateLength) continue;
    correctionX += candidateX;
    correctionY += candidateY;
  }
  if (correctionX !== 0 || correctionY !== 0) {
    const correctionLength = Math.hypot(correctionX, correctionY);
    const correctionLimit = Math.max(0, Number(maxCorrection));
    if (Number.isFinite(correctionLimit) && correctionLength > correctionLimit && correctionLength > 0) {
      const scale = correctionLimit / correctionLength;
      correctionX *= scale;
      correctionY *= scale;
    }
    ship.x += correctionX;
    ship.y += correctionY;
    ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + correctionX;
    ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + correctionY;
  }
  if (typeof onContact === "function") {
    for (const contact of contacts) onContact(contact);
  }
  return hit;
}

// World-space geometry for every home hangar. The authored local records are
// the authority; this only adds the station pose for launch and snapshots.
function buildHangarGeometry(station) {
  const envelope = maximumShipEnvelope();
  const toWorld = (point) => stationLocalToWorld(station, point.x, point.y);
  return homeStationGeometry.hangars.map((authored) => ({
    ...authored,
    localNormal: { ...authored.localNormal },
    localCentre: { ...authored.localCentre },
    worldCentre: toWorld(authored.localCentre),
    interiorSpawn: toWorld(authored.interiorSpawn),
    mouth: toWorld(authored.mouth),
    innerWall: toWorld(authored.innerWall),
    releasePlane: toWorld(authored.releasePlane),
    collisionOpening: { ...authored.collisionOpening },
    doorRect: { ...authored.doorRect },
    maximumShipWidth: envelope.width,
    maximumShipHeight: envelope.height,
    angle: station.angle,
    rearWall: toWorld(authored.innerWall),
    exitPoint: toWorld(authored.releasePlane),
    corridorHalfWidth: authored.corridor.halfWidth,
    corridorLength: authored.corridor.length,
    apertureHalfWidth: authored.aperture.halfWidth
  }));
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

function normalizeHomeStationDurability(station, target) {
  const source = station.componentMaxHp.map((value) => Math.max(0, Number(value) || 0));
  const total = source.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) {
    station.componentMaxHp = source;
    station.componentHp = source.slice();
    station.maxHp = target;
    station.hp = target;
    return;
  }
  const preferred = station.design.findIndex((module) => module?.type === "core");
  const anchor = preferred >= 0
    ? preferred
    : source.findIndex((value) => value > 0);
  let scaledSum = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (i === anchor) continue;
    const value = source[i] * target / total;
    station.componentMaxHp[i] = value;
    station.componentHp[i] = value;
    scaledSum += value;
  }
  const anchorValue = Math.max(0, target - scaledSum);
  station.componentMaxHp[anchor] = anchorValue;
  station.componentHp[anchor] = anchorValue;
  station.maxHp = target;
  station.hp = target;
}

function createStationEntity(room, template, x, y, angle, stationType, team, ownerId, now) {
  const design = template.design.map((m) => ({ ...m }));
  const dataLinks = template.dataLinks || [];
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
    dataLinks,
    stats,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    shield: 0,
    maxShield: 0,
    state: stationType === "neutral" ? "neutral" : "operational",
    lastDamagedAt: 0,
    productionQueue: [],
    activeLaunches: [],
    hangars: null,
    launchReservations: [],
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
  const shield = effectiveShieldStats(station);
  if (stationType === "home") {
    // Home durability is a match-start contract: exactly 8,000 shield and
    // 8,000 hull per opposing player. It is intentionally independent of the
    // balance sheet's old scale knobs and is never recomputed after creation.
    const targetDurability = HOME_DURABILITY_PER_ENEMY_PLAYER * enemyPlayerCount;
    station.maxShield = targetDurability;
    station.shield = targetDurability;
    normalizeHomeStationDurability(station, targetDurability);
  } else {
    const configuredShieldScale = Number(stationConfig?.shieldScale);
    const shieldScale = Number.isFinite(configuredShieldScale) && configuredShieldScale >= 0
      ? configuredShieldScale
      : 1;
    station.maxShield = Math.max(0, shield.capacity * shieldScale);
    station.shield = station.maxShield;
  }
  initShipHeat(station);
  // Optional hull scale from the balance sheet. A station's component sheet
  // can add up to a structure far too tough to contest inside a match,
  // so it is scaled down here rather than by hand-editing every module's HP —
  // the design stays a normal component structure, it is just built lighter.
  // Scaling the per-component arrays (not just the totals) keeps component
  // damage, destruction and the HP total consistent with each other.
  if (stationType !== "home") {
    const configuredHullScale = Number(stationConfig?.hullScale);
    const hullScale = Number.isFinite(configuredHullScale) && configuredHullScale > 0
      ? configuredHullScale
      : 1;
    if (Number.isFinite(hullScale) && hullScale > 0 && hullScale !== 1) {
      for (let i = 0; i < station.componentMaxHp.length; i += 1) {
        station.componentMaxHp[i] *= hullScale;
        station.componentHp[i] *= hullScale;
      }
    }
    station.hp = station.componentHp.reduce((sum, hp) => sum + hp, 0);
    station.maxHp = station.componentMaxHp.reduce((sum, hp) => sum + hp, 0);
  }
  station.enemyPlayerCount = enemyPlayerCount;
  // Stations are laid out on the ship grid but drawn and collided at their own
  // larger module scale; the client needs it to size the structure correctly.
  station.moduleScale = stationModuleScale(stationType);
  if (stationType === "home") {
    station.hangars = buildHangarGeometry(station);
    station.launchReservations = new Array(station.hangars.length).fill(null);
  }
  station.collisionPieces = stationCollisionPieces(station);
  station.shieldRadius = computeStationShieldCollisionRadius(station);
  // Broad-phase radius covering every solid piece, for spatial-index queries.
  station.radius = station.collisionPieces.reduce(
    (max, piece) => Math.max(max, Math.hypot(piece.x - station.x, piece.y - station.y) + piece.radius),
    0
  );
  station.hardpoints = computeStationHardpoints(station);
  station.alive = station.state !== "destroyed";
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

// Stable seat-to-corridor assignment from the historical three-hangar station:
// one player uses the centre, two use the outer pair, and three use all three.
// The assignment is a launch choice only; production queues and fleet limits
// remain unchanged.
const BAY_ASSIGNMENT_ORDER = Object.freeze({
  1: Object.freeze([1]),
  2: Object.freeze([0, 2]),
  3: Object.freeze([0, 1, 2])
});

function stationCrew(room, station) {
  const players = [...(room?.players?.values?.() || [])].filter((player) => !player.removed);
  const crew = room?.rules?.gameMode === "solo"
    ? players.filter((player) => player.id === station.ownerId)
    : players.filter((player) => player.team && player.team === station.team);
  return crew.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

function hangarBayForPlayer(room, station, playerId) {
  const hangars = station.hangars || [];
  if (hangars.length === 0) return null;
  const crew = stationCrew(room, station);
  const seat = crew.findIndex((player) => player.id === playerId);
  const active = Math.max(1, Math.min(hangars.length, crew.length || 1));
  const order = BAY_ASSIGNMENT_ORDER[active] || BAY_ASSIGNMENT_ORDER[hangars.length];
  const bayIndex = order[(seat < 0 ? 0 : seat) % order.length];
  return hangars[bayIndex] || hangars[0];
}

// How long a hull sits in the production queue.
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
  return Math.max(0.2, (base + modules * perModule) / 2);
}

function enqueueStationProduction(room, player, item, now) {
  const station = findTeamHomeStation(room, player.team);
  if (!station) {
    return { type: "purchaseResult", ok: false, requestId: item.request.requestId, code: "no-home-station", message: "No home station available" };
  }
  if (station.state !== "operational") {
    return { type: "purchaseResult", ok: false, requestId: item.request.requestId, code: "station-unavailable", message: "Your home station is not operational and cannot build ships" };
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
  // hull is queued and roughly how long production will hold it.
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
  const stats = player.stats || computeStats(player.design);
  if (!(stats.unitCost > 0) || player.money < stats.unitCost) return null;
  const { canonicalBlueprintSignature, getOrCreateTemplate } = require("./shipTemplates");
  const signature = canonicalBlueprintSignature(player.design, player.dataLinks);
  const template = getOrCreateTemplate(player.id, player.design, player.dataLinks, stats, signature);
  const result = enqueueStationProduction(room, player, {
    template,
    request: { requestId: `bot:${player.id}:${room.nextEntityId}`, combatStyle: player.combatStyle || "hold" },
    validation: { count: 1, totalCost: stats.unitCost }
  }, now);
  return result.ok ? result : null;
}

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
  // Only the corridor INTERIOR has to be clear — from the rear bulkhead to the
  // mouth. It used to extend all the way out to the release plane, which meant
  // anything drifting past the front of the station, friendly or hostile,
  // halted production for as long as it loitered there. Nothing can get inside
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
    // to veto the launch lets enemies blockade production without entering the
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

function processStationProduction(room, station, dt, now) {
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
    if (item.state === "queued") {
      item.state = "complete-waiting-launch";
      station.productionRevision += 1;
    }
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
// immediately ahead are asked to step ASIDE -- never forwards, so a launch can
// never shunt a parked line across the map or shove anyone into a rock.
//
// Only allies are nudged. A hostile hull is not ours to move: the launching ship
// is immovable to separation, so an enemy that parks in the mouth is pushed out
// by the ordinary collision pass instead, and until it is the launch simply
// waits.
//
// Returns true when the lane immediately ahead is clear enough to advance.
const LAUNCH_LANE_LOOKAHEAD = 96;
const LAUNCH_YIELD_SPEED = 220;

function launchYieldPointClear(room, ship, x, y, radius) {
  const { isStaticObstacleLineClear } = require("./movementNavigation");
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
  const step = LAUNCH_YIELD_SPEED * Math.max(0, Number(dt) || 0);
  let blocked = false;

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

    // Out the nearer side first, then the other, a bounded amount per tick, and
    // only ever to somewhere the hull can actually sit.
    const nearerSide = candidateAcross >= hangar.centreY ? 1 : -1;
    const move = Math.min(step, overlap);
    if (!(move > 0)) continue;
    let yielded = false;
    for (const side of [nearerSide, -nearerSide]) {
      const nextX = candidate.x + lateral.x * side * move;
      const nextY = candidate.y + lateral.y * side * move;
      if (!launchYieldPointClear(room, candidate, nextX, nextY, candidateRadius)) continue;
      candidate.x = nextX;
      candidate.y = nextY;
      candidate._collisionCorrectionX = (candidate._collisionCorrectionX || 0) + lateral.x * side * move;
      candidate._collisionCorrectionY = (candidate._collisionCorrectionY || 0) + lateral.y * side * move;
      // Take out the component of its velocity heading further into the lane, so
      // it stops fighting the nudge, and leave the rest alone.
      const inwardSpeed = ((candidate.vx || 0) * lateral.x + (candidate.vy || 0) * lateral.y) * side;
      if (inwardSpeed < 0) {
        candidate.vx -= inwardSpeed * lateral.x * side;
        candidate.vy -= inwardSpeed * lateral.y * side;
      }
      bumpCounter(room, "stationLaunchBlockersYielded");
      yielded = true;
      break;
    }
    // Pinned: solid geometry on both sides. Nothing may be forced through a
    // rock or a station wall, so the launch waits for it to move on its own.
    if (!yielded) blocked = true;
  }

  return !blocked;
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
    // Open the lane before committing to the step. If it cannot be opened, the
    // launch holds where it is: the hull is never driven through anything, and
    // nothing in front of it is ever pushed forwards to make room.
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
    setProgress(0);
    transferRelayControl(room, station, newOwnerId, now, { captureMethod: "neutral" });
    if (detailed) bump(room, "stationCapturesCompleted");
  }

  // Owned relays are transferred at destruction time. Only neutral relays use
  // the timed presence capture path below.
  if (station.state !== "neutral") return;

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

  // Taking an unclaimed relay runs the same clock as the old capture path, so
  // the capture ring and objective HUD percentage retain their meaning.
  setProgress((station.captureProgress || 0) + dt / duration, leaderTeam);
  if (station.captureProgress >= 1) captureStation(leader.ownerId, leaderTeam);
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
    // team shares one actual station. Creating a home station for every one of
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
  const oldStations = Array.isArray(room.stations) ? room.stations : [];
  for (const ship of room.ships?.values?.() || []) {
    if (!ship?.launchPhase) continue;
    const station = oldStations.find((entry) => entry?.id === ship.launchPhase.stationId) || null;
    const hangar = station?.hangars?.[Number(ship.launchPhase.bayIndex)] || null;
    recoverLaunchPhase(room, ship, ship.launchPhase, station, hangar, room.simulationTimeMs || 0, "station-destroyed");
  }
  if (!room.stations) return;
  if (room._visibilityRuntime) {
    const visibilityRuntime = require("./visibilityRuntime");
    for (const station of room.stations) visibilityRuntime.unregisterEntity(room, station, "station");
  }
  room.stations = [];
  room.stationsById = null;
  room.stationRevision = (room.stationRevision || 0) + 1;
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
      if (room._visibilityRuntime) require("./visibilityRuntime").registerSensorSource(room, station, "station");
      require("./visibility").invalidateVisibility(room, {
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

// These stage helpers deliberately accept one station. updateStations keeps the
// historical per-station ordering (capture -> self repair -> launch
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

function updateStationRepairSystems(room, station, dt, now, phase = "all") {
  const startedAt = performanceNow();
  try {
    if (phase === "self" || phase === "all") updateStationSelfRepair(room, station, dt);
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

// Called at the movement boundary. A launch must be advanced before ordinary
// movement, separation or combat consumes the room; otherwise those systems can
// displace a new hull and station control only repairs the result one tick late.
function updateStationLaunchControl(room, dt, now) {
  if (!usesStationInfrastructure(room) || !room.stations) return;
  reconcileStationLaunchState(room, now);
  for (const station of room.stations) updateStationLaunches(room, station, dt, now);
}

function updateStations(room, dt, now, options = null) {
  if (!usesStationInfrastructure(room) || !room.stations) return;
  const skipLaunchControl = options?.skipLaunchControl === true;
  const startedAt = performanceNow();
  try {
    if (!skipLaunchControl) reconcileStationLaunchState(room, now);
    for (const station of room.stations) {
      updateStationCaptureSystems(room, station, dt, now);
      updateStationRepairSystems(room, station, dt, now, "self");
      if (!skipLaunchControl) updateStationHangarSystems(room, station, dt, now, "launches");
      updateStationRepairSystems(room, station, dt, now, "active");
      updateStationHangarSystems(room, station, dt, now, "production");
    }
    if (room.spatialIndex?.updateLiveEntities) {
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
  updateStationRepairSystems,
  updateStationHangarSystems,
  updateStationLaunchControl,
  enqueueStationProduction,
  enqueueBotProduction,
  queuedShipCount,
  findTeamHomeStation,
  usesStationInfrastructure,
  resolveStationCollision
};
