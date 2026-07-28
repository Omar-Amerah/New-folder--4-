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

const MODULE_SCALE = 13;
const GRID_CELLS = 15;

function choosePart(x, y, w, h, cx, cy) {
  if (x === cx && y === cy) return "core";
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.max(Math.abs(dx), Math.abs(dy));
  if (dist <= 1) return (x + y) % 2 === 0 ? "auxGenerator" : "shield";
  if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
    if (dy === 1 && (x === 2 || x === w - 3)) return "pointDefense";
    if (dy === 1 && (x === 4 || x === w - 5)) return "flakCannon";
    if (dy === 1 && (x === 6 || x === w - 7)) return "blaster";
    if (dy === 1 && (x === 8 || x === w - 9)) return "missile";
    return "armor";
  }
  if (x % 4 === 0 && y % 4 === 0) return (x + y) % 3 === 0 ? "radiator" : "heatSink";
  if (dist === 3 && (dx === 0 || dy === 0)) return "auxGenerator";
  if (dist <= 4 && (x + y) % 5 === 0) return "repair";
  if (dist <= 4 && (x + y) % 5 === 1) return "repair";
  return "frame";
}

function buildHomeStationDesign(width = 15, height = 15) {
  const design = [];
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      design.push({ x, y, type: choosePart(x, y, width, height, cx, cy), rotation: 0 });
    }
  }
  return design;
}

function buildRelayStationDesign(width = 9, height = 9) {
  const design = [];
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let type = "frame";
      if (x === cx && y === cy) type = "core";
      else if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) === 1) type = (x + y) % 2 === 0 ? "auxGenerator" : "shield";
      else if (x === 0 || x === width - 1 || y === 0 || y === height - 1) type = "armor";
      else if (x === cx || y === cy) type = "auxGenerator";
      else if ((x + y) % 4 === 0) type = "repair";
      else if ((x + y) % 4 === 1) type = "pointDefense";
      design.push({ x, y, type, rotation: 0 });
    }
  }
  return design;
}

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

function computeMaxShipDimensions() {
  const maxCell = GRID_CELLS - 1;
  const cellsAcross = maxCell;
  const halfCell = MODULE_SCALE / 2;
  const fullWidth = cellsAcross * MODULE_SCALE + 2 * halfCell;
  const clearance = INFRASTRUCTURE.homeStation.hangarClearanceCells * MODULE_SCALE;
  return {
    width: fullWidth + 2 * clearance,
    height: fullWidth + 2 * clearance
  };
}

function buildHangarGeometry(x, y, angle) {
  const dims = computeMaxShipDimensions();
  const halfW = Math.max(dims.width, dims.height) / 2;
  const corridorLen = INFRASTRUCTURE.homeStation.hangarCorridorLength;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const interiorSpawn = { x: x - cos * corridorLen * 0.35, y: y - sin * corridorLen * 0.35 };
  const exitPoint = { x: x + cos * corridorLen * 0.65, y: y + sin * corridorLen * 0.65 };
  return {
    x, y, angle,
    interiorSpawn,
    exitPoint,
    releaseDistance: INFRASTRUCTURE.homeStation.releaseDistance,
    corridorHalfWidth: halfW,
    corridorLength: corridorLen,
    maximumShipWidth: dims.width,
    maximumShipHeight: dims.height,
    clearance: INFRASTRUCTURE.homeStation.hangarClearanceCells * MODULE_SCALE
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
    captureRevision: 1
  };
  initComponentState(station);
  initializeComponentPower(station);
  const shield = effectiveShieldStats(station);
  station.maxShield = Math.max(0, shield.capacity);
  station.shield = station.maxShield;
  initShipHeat(station);
  station.hp = station.componentHp.reduce((sum, hp) => sum + hp, 0);
  station.maxHp = station.componentMaxHp.reduce((sum, hp) => sum + hp, 0);
  if (stationType === "home") {
    station.hangar = buildHangarGeometry(x, y, angle);
  }
  return station;
}

function findTeamHomeStation(room, team) {
  return room.stations?.find((s) => s.stationType === "home" && s.team === team) || null;
}

function enqueueStationProduction(room, player, item, now) {
  const station = findTeamHomeStation(room, player.team);
  if (!station) {
    return { type: "purchaseResult", ok: false, requestId: item.request.requestId, code: "no-home-station", message: "No home station available" };
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
    queued: true
  };
}

function spawnQueuedShip(room, station, queueItem, now) {
  const player = room.players.get(queueItem.playerId);
  if (!player || !player.ready) return null;
  const active = player.ships.filter((s) => s.alive).length;
  if (active >= player.shipCap) return null;
  const spawn = station.hangar?.interiorSpawn;
  if (!spawn) return null;
  const ship = spawnShip(room, player, now, active, {
    template: queueItem.template,
    combatStyle: queueItem.combatStyle,
    spawnPoint: { x: spawn.x, y: spawn.y, ok: true, angle: station.angle },
    requestId: queueItem.requestId
  });
  if (!ship) return null;
  const speed = INFRASTRUCTURE.homeStation.launchSpeed;
  ship.vx = Math.cos(station.angle) * speed;
  ship.vy = Math.sin(station.angle) * speed;
  ship.x = spawn.x;
  ship.y = spawn.y;
  ship.angle = station.angle;
  applyRallySlots(room, player, [ship]);
  station.activeLaunches.push({ shipId: ship.id, releasedAt: null, releasePlane: station.hangar.exitPoint });
  return ship;
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
  const repair = (cfg.disabledRepairRatePerSecond || 0) * dt;
  station.hp = Math.min(station.maxHp, station.hp + repair);
  const threshold = station.maxHp * (cfg.reactivationHpRatio || 1);
  if (station.hp >= threshold) {
    station.state = "operational";
    station.stateRevision += 1;
    station.disabledAt = 0;
  }
  station.healthRevision += 1;
}

function updateStationCapture(room, station, dt, now) {
  if (station.stationType !== "relay") return;
  // Presence-based capture with the existing capture balance constants.
  // Full relay state machine: neutral operational can be captured; owned
  // operational cannot be captured until disabled.
  // This is intentionally conservative and will be expanded as station combat
  // and damage integration land.
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
  if (contenders.length === 0) return;
  if (contenders.length > 1 && contenders[0][1].count === contenders[1][1].count) return;
  const [leaderTeam, leader] = contenders[0];
  if (station.state === "neutral") {
    if (station.ownerId !== leaderTeam) {
      station.ownerId = leader.ownerId;
      station.team = leaderTeam;
      station.state = "operational";
      station.hp = station.maxHp * cfg.captureRestoreHpRatio;
      station.captureRevision += 1;
      station.stateRevision += 1;
      station.healthRevision += 1;
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

function updateStations(room, dt, now) {
  if (!usesStationInfrastructure(room) || !room.stations) return;
  for (const station of room.stations) {
    updateStationRecovery(station, dt, now);
    updateStationRepair(room, station, dt, now);
    processStationProduction(room, station, dt, now);
    updateStationCapture(room, station, dt, now);
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
  usesStationInfrastructure
};
