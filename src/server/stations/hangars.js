"use strict";

const { computeStats } = require("../shipStats");
const {
  MAX_SHIP_EXTENT,
  buildHomeStationGeometry
} = require("../stationTemplates");

// Authored template geometry, measured once at module load rather than per
// station: it depends only on the design, never on where a station stands.
const homeStationGeometry = buildHomeStationGeometry();

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

function findTeamHomeStation(room, team) {
  return room.stations?.find((s) => s.stationType === "home" && s.team === team) || null;
}

// Ships already paid for but not yet launched still occupy a fleet slot; the
// economy's fleet-cap validator only counts live hulls, so the queue has to be
// counted here or a player could queue an unbounded fleet one purchase at a time.
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
// The assignment is a launch choice only; hangar queues and fleet limits
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

function enqueueStationProduction(room, player, item, now) {
  const station = findTeamHomeStation(room, player.team);
  if (!station) {
    return { type: "purchaseResult", ok: false, requestId: item.request.requestId, code: "no-home-station", message: "No home station available" };
  }
  if (station.state !== "operational") {
    return { type: "purchaseResult", ok: false, requestId: item.request.requestId, code: "station-unavailable", message: "Your home station is not operational and cannot accept ship purchases" };
  }
  const active = player.ships.filter((ship) => ship.alive).length;
  const queued = queuedShipCount(room, player.id);
  if (active + queued + item.validation.count > player.shipCap) {
    return {
      type: "purchaseResult",
      ok: false,
      requestId: item.request.requestId,
      code: "fleet-cap",
      message: `Fleet cap reached: ${active} active + ${queued} queued for launch of ${player.shipCap}`
    };
  }
  const queueItem = {
    id: `sq${room.nextEntityId++}`,
    playerId: player.id,
    requestId: item.request.requestId,
    template: item.template,
    combatStyle: item.request.combatStyle,
    aiRole: item.aiRole || null,
    aiBlueprintId: item.aiBlueprintId || null,
    unitCost: item.validation.totalCost / item.validation.count,
    quantityRemaining: item.validation.count
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
    // Station mode never spawns on purchase. The hull remains queued until its
    // assigned hangar is available.
    queued: true,
    queuePosition: station.productionQueue.length
  };
}

// Bots buy through buyShip() in Classic, which spawns instantly at the safe
// zone. In station mode they must use the same hangar queue as human purchases
// so a bot fleet is gated by hangar throughput too.
function enqueueBotProduction(room, player, now, options = {}) {
  const design = options.design || player.design;
  const dataLinks = options.dataLinks !== undefined ? options.dataLinks : (player.dataLinks || []);
  const stats = options.stats || computeStats(design);
  if (!(stats.unitCost > 0) || player.money < stats.unitCost) return null;
  const { canonicalBlueprintSignature, getOrCreateTemplate } = require("../shipTemplates");
  const signature = canonicalBlueprintSignature(design, dataLinks);
  const template = getOrCreateTemplate(player.id, design, dataLinks, stats, signature);
  const result = enqueueStationProduction(room, player, {
    template,
    request: { requestId: `bot:${player.id}:${room.nextEntityId}`, combatStyle: options.combatStyle || player.combatStyle || "hold" },
    validation: { count: 1, totalCost: stats.unitCost },
    aiRole: options.aiRole,
    aiBlueprintId: options.aiBlueprintId
  }, now);
  return result.ok ? result : null;
}

module.exports = {
  buildHangarGeometry,
  findTeamHomeStation,
  queuedShipCount,
  hangarBayForPlayer,
  enqueueStationProduction,
  enqueueBotProduction
};
