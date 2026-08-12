"use strict";

const { PARTS } = require("../components");
const { INFRASTRUCTURE } = require("../config");
const { computeStats } = require("../shipStats");
const { initComponentState } = require("../componentHealth");
const { initializeComponentPower, effectiveShieldStats } = require("../componentPower");
const { initShipHeat } = require("../heat");
const { usesStationInfrastructure } = require("../rooms");
const { initStationCombatRuntime } = require("../stationCombat");
const { getShipComponentIndexes } = require("../componentIndexes");
const { computeStationShieldCollisionRadius } = require("../stationCollision");
const {
  stationModuleScale,
  moduleCentreToLocal,
  buildHomeStationDesign,
  buildRelayStationDesign
} = require("../stationTemplates");
const { buildHangarGeometry } = require("./hangars");
const { stationCollisionPieces } = require("./collision");
const { recoverLaunchPhase } = require("./launching");

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

const HOME_DURABILITY_PER_ENEMY_PLAYER = 8000;

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
  // so it is scaled down here rather than by hand-editing every module's HP -
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
    // first one idle because queued launches already resolve through
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
      const visibilityRuntime = require("../visibilityRuntime");
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
      const visibilityRuntime = require("../visibilityRuntime");
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
    const visibilityRuntime = require("../visibilityRuntime");
    for (const station of room.stations) visibilityRuntime.unregisterEntity(room, station, "station");
  }
  room.stations = [];
  room.stationsById = null;
  room.stationRevision = (room.stationRevision || 0) + 1;
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
  destroyStationsForRoom
};
