"use strict";

const { PARTS } = require("./components");
const { INFRASTRUCTURE } = require("./config");
const { angleDifference, clampNumber, rotateToward } = require("./utils");
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
// section. The hangar corridors are deliberately not among them, so they are the
// navigable paths through the station's front.
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
  for (const doorRect of geometry.doorRects || (geometry.doorRect ? [geometry.doorRect] : [])) {
    pieces.push(toPiece(doorRect, true));
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
    // A hull under launch control ignores its own station entirely — hull,
    // bay walls and blast doors alike. Bays are narrower than the largest hull
    // a player can design, and launches never wait for a clear corridor, so the
    // launching ship is pinned to its bay centreline (see updateStationLaunches)
    // and pushes straight out instead of grinding along the structure. Every
    // other ship, including this one the moment it is released, collides
    // normally, so the bays remain one-way doors.
    const launching = Boolean(ship.launchPhase) && ship.launchPhase.stationId === station.id;
    if (launching) continue;
    for (const piece of station.collisionPieces) {
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

// World-space geometry for one of a placed home station's launch bays. All of it
// is derived from the authored template, transformed by the station's pose.
function buildBayGeometry(station, bay) {
  const envelope = maximumShipEnvelope();
  return {
    index: bay.index,
    angle: station.angle,
    // Lateral offset of this bay's centreline from the station's nose axis, in
    // structure-local units. Launch control measures ACROSS against it.
    centreY: bay.centreY,
    interiorSpawn: stationLocalToWorld(station, bay.interiorSpawn.x, bay.centreY),
    mouth: stationLocalToWorld(station, bay.mouthX, bay.centreY),
    rearWall: stationLocalToWorld(station, bay.rearWallX, bay.centreY),
    exitPoint: stationLocalToWorld(station, bay.releasePlaneX, bay.centreY),
    // Distance along the station's nose at which a launching ship is clear.
    releaseDistance: bay.releasePlaneX,
    // Distance along the nose at which a hull sits fully inside the bay.
    interiorSpawnDistance: bay.interiorSpawn.x,
    corridorHalfWidth: bay.halfWidth,
    corridorLength: bay.length,
    apertureHalfWidth: bay.halfWidth,
    maximumShipWidth: envelope.width,
    maximumShipHeight: envelope.height,
    clearance: bay.halfWidth - envelope.width / 2
  };
}

// Every bay on a placed home station, front to back in cell order. `hangars[i]`
// and the authored `homeStationGeometry.bays[i]` are the same bay.
function buildHangarGeometry(station) {
  return homeStationGeometry.bays.map((bay) => buildBayGeometry(station, bay));
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
    hangars: null,
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
    station.hangars = buildHangarGeometry(station);
    // `hangar` stays the centre bay so anything addressing "the" hangar — the
    // station panel, the snapshot contract, older tooling — keeps working.
    station.hangar = station.hangars[Math.floor(station.hangars.length / 2)];
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

// How long a hull sits in the hangar: nothing. Production used to run a
// size-scaled build timer and hold the hull on the pad until its corridor was
// clear, which made the station a throughput bottleneck a player could neither
// see nor plan around. A purchase now materialises in its owner's bay on the
// tick it is bought. The field survives because the purchase reply and the
// station panel both report it, and both read zero as "already launching".
function stationBuildSeconds() {
  return 0;
}

// Which bay a player launches from. One player on the team gets the centre bay,
// two get the outer pair, three or more are spread across all of them in a
// stable order, so a given player always launches from the same side of the
// station for the whole match.
const BAY_ASSIGNMENT_ORDER = Object.freeze({ 1: [1], 2: [0, 2], 3: [0, 1, 2] });

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

// Nose-to-tail gap between hulls queued into the same bay on the same tick.
const LAUNCH_QUEUE_GAP = 12;

// How far along the station's nose a new hull starts. Normally that is the bay's
// interior spawn point, but a bay never refuses a launch: if hulls are already
// streaming out of it, the next one is stacked BEHIND the rearmost of them —
// deeper into the station, and past the rear bulkhead if it comes to that.
// Launching ships ignore their own station's collision, so a stacked hull simply
// follows the one in front out of the mouth instead of waiting for a clear
// corridor.
function bayLaunchDistance(room, station, hangar, physicalRadius) {
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  let rearmost = Infinity;
  for (const launch of station.activeLaunches) {
    if (launch.bayIndex !== hangar.index) continue;
    const other = room.ships.get(launch.shipId);
    if (!other?.alive || !other.launchPhase) continue;
    const along = (other.x - station.x) * cos + (other.y - station.y) * sin;
    rearmost = Math.min(rearmost, along - (Number(other.physicalRadius) || 0));
  }
  if (!Number.isFinite(rearmost)) return hangar.interiorSpawnDistance;
  return Math.min(hangar.interiorSpawnDistance, rearmost - physicalRadius - LAUNCH_QUEUE_GAP);
}

function spawnQueuedShip(room, station, queueItem, now) {
  const player = room.players.get(queueItem.playerId);
  if (!player || !player.ready) return null;
  const active = player.ships.filter((s) => s.alive).length;
  if (active >= player.shipCap) return null;
  const hangar = hangarBayForPlayer(room, station, queueItem.playerId);
  if (!hangar) return null;
  bumpCounter(room, "stationLaunchAttemptCount");
  const physicalRadius = computeDesignCollisionRadius(queueItem.template.design, queueItem.template.stats);
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  const lateralX = -sin;
  const lateralY = cos;
  const along = bayLaunchDistance(room, station, hangar, physicalRadius);
  const spawn = {
    x: station.x + cos * along + lateralX * hangar.centreY,
    y: station.y + sin * along + lateralY * hangar.centreY
  };
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
  ship.vx = cos * speed;
  ship.vy = sin * speed;
  // Launch phase: the ship is under station control until its whole hull clears
  // the release plane. Ordinary stance, orders and weapons stay inert so it
  // cannot manoeuvre or shoot through the structure it is still inside.
  ship.launchPhase = {
    stationId: station.id,
    bayIndex: hangar.index,
    startedAt: now,
    angle: station.angle,
    centreY: hangar.centreY,
    releaseDistance: hangar.releaseDistance + physicalRadius
  };
  station.activeLaunches.push({ shipId: ship.id, bayIndex: hangar.index, releasedAt: null, releasePlane: hangar.exitPoint });
  bumpCounter(room, "stationLaunchSuccessCount");
  // No launch notice: the ship flying out of its bay already says it, and a
  // toast per hull is noise when a player is queueing several at once.
  return ship;
}

// Development counters (section 24). Kept on the room so they reset with it and
// cost nothing in Classic, where no station code runs at all.
function bumpCounter(room, name) {
  const counters = room.stationCounters || (room.stationCounters = {});
  counters[name] = (counters[name] || 0) + 1;
}

// There is no build timer and no launch clearance test any more, so the queue is
// drained completely every tick: each purchase is on its owner's pad and moving
// the moment it is bought. The only thing that can still hold an item back is
// the player's own fleet cap, which is not the station's business to hurry.
//
// Every item is walked, not just the head of the queue: two players sharing a
// station launch from different bays, so one player's fleet cap must never stall
// the other's purchase behind it.
function processStationProduction(room, station, dt, now) {
  if (station.state !== "operational" || !station.productionQueue.length) return;
  let launched = false;
  for (let i = station.productionQueue.length - 1; i >= 0; i -= 1) {
    const item = station.productionQueue[i];
    item.state = "complete-waiting-launch";
    while (item.quantityRemaining > 0 && spawnQueuedShip(room, station, item, now)) {
      item.quantityRemaining -= 1;
      launched = true;
    }
    if (item.quantityRemaining <= 0) station.productionQueue.splice(i, 1);
  }
  if (launched) station.productionRevision += 1;
}

// A launch record exists only while a freshly built ship is still clearing the
// hangar corridor. Without this sweep the list grows for the whole match, since
// nothing else ever removes an entry.
function updateStationLaunches(room, station, dt, now) {
  const launches = station.activeLaunches;
  if (!launches || launches.length === 0) return;
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  const lateralX = -sin;
  const lateralY = cos;
  for (let i = launches.length - 1; i >= 0; i -= 1) {
    const launch = launches[i];
    const ship = room.ships.get(launch.shipId);
    if (!ship || !ship.alive || !ship.launchPhase) {
      launches.splice(i, 1);
      continue;
    }
    const phase = ship.launchPhase;
    // Hold the ship on its bay's centreline at a controlled speed. It is not
    // steering yet, and any lateral shove it took from traffic in front of the
    // bay is undone here, so a launch always leaves in a straight line and
    // pushes whatever is loitering in the mouth out of the way rather than
    // being deflected into the structure.
    const speed = INFRASTRUCTURE.homeStation.launchSpeed;
    ship.angle = phase.angle;
    ship.vx = cos * speed;
    ship.vy = sin * speed;
    const dx = ship.x - station.x;
    const dy = ship.y - station.y;
    const along = dx * cos + dy * sin;
    const across = dx * lateralX + dy * lateralY;
    const drift = (Number(phase.centreY) || 0) - across;
    if (drift !== 0) {
      ship.x += lateralX * drift;
      ship.y += lateralY * drift;
    }
    if (along >= phase.releaseDistance) {
      // Fully clear: ordinary movement, orders and weapons resume, and the ship
      // heads for the player's rally point.
      ship.launchPhase = null;
      launch.releasedAt = now;
      launches.splice(i, 1);
      const player = room.players.get(ship.ownerId);
      if (player) applyRallySlots(room, player, [ship]);
    }
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
  const duration = cfg.captureDurationSeconds || 5;
  const decayPerSecond = Number(cfg.captureDecayPerSecond) || 0;

  // `captureTeam` is who the bar currently belongs to, so the client can draw
  // the progress sweep in the capturing side's colour instead of a generic
  // amber. It is cleared with the progress it describes.
  function setProgress(value, team = null) {
    const next = Math.max(0, Math.min(1, value));
    if (Math.round(next * 100) !== Math.round((station.captureProgress || 0) * 100)) station.captureRevision += 1;
    station.captureProgress = next;
    const nextTeam = next > 0 ? team : null;
    if (station.captureTeam !== nextTeam) {
      station.captureTeam = nextTeam;
      station.captureRevision += 1;
    }
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
  if (station.captureContested) return;

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
  }

  // Taking an unclaimed relay runs the same clock as taking one off an enemy,
  // so the capture ring and the objective HUD percentage mean the same thing in
  // both cases. It used to flip owner on the first tick a hull was in range.
  if (station.state === "neutral") {
    setProgress((station.captureProgress || 0) + dt / duration, leaderTeam);
    if (station.captureProgress >= 1) captureStation(leader.ownerId, leaderTeam);
    return;
  }

  // An active owned relay must be disabled (HP below threshold) before it can change hands.
  if (station.state === "operational") return;

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
    updateStationRepairBeams(room, station, dt, now);
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
