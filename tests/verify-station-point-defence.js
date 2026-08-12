"use strict";

const assert = require("assert");
const { createRoom, sanitizeRoomRules } = require("../src/server/rooms");
const { createStationsForRoom } = require("../src/server/stations");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState, bumpComponentAliveRevision } = require("../src/server/componentHealth");
const { getShipComponentIndexes } = require("../src/server/componentIndexes");
const { PARTS } = require("../src/server/components");
const TargetingCadence = require("../src/server/targetingCadence");
const { updateStationWeapons, stationModuleWorldPosition } = require("../src/server/stationCombat");
const { updateBullets } = require("../src/server/projectiles");

let scenarioId = 0;

function makePlayer(id, team) {
  return {
    id,
    name: id,
    team,
    ready: true,
    ships: [],
    client: {},
    purchaseRequests: new Map(),
    money: 0,
    earned: 0,
    losses: 0,
    kills: 0,
    lostFleetCost: 0,
    destroyedEnemyCost: 0
  };
}

function makeEnemy(station, pointDefenceIndex, id = "enemy-ship") {
  const origin = stationModuleWorldPosition(station, pointDefenceIndex);
  const angle = (station.angle || 0) + (station.weaponAngles[pointDefenceIndex] || 0);
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 6, y: 7, type: "armor", rotation: 0 }
  ];
  const stats = computeStats(design);
  const enemy = {
    id,
    entityType: "ship",
    ownerId: "p2",
    team: "red",
    x: origin.x + Math.cos(angle) * 260,
    y: origin.y + Math.sin(angle) * 260,
    angle: angle + Math.PI,
    vx: 0,
    vy: 0,
    radius: stats.radius,
    design,
    dataLinks: [],
    stats,
    alive: true,
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    shield: 100,
    maxShield: 100,
    commandState: "mainCore"
  };
  initComponentState(enemy);
  enemy.shield = 100;
  enemy.maxShield = 100;
  return enemy;
}

function makeStationScenario(stationType) {
  const room = createRoom(`STATION-PD-${stationType}-${scenarioId += 1}`, { seed: 112358 + scenarioId });
  room.rules = sanitizeRoomRules({ ...room.rules, infrastructureMode: "stations" }, 2);
  room.phase = "active";
  room.disableSpatialIndex = true;
  room.players.set("p1", makePlayer("p1", "blue"));
  room.players.set("p2", makePlayer("p2", "red"));
  createStationsForRoom(room, 0);

  const station = stationType === "home"
    ? room.stations.find((candidate) => candidate.stationType === "home" && candidate.team === "blue")
    : room.stations.find((candidate) => candidate.stationType === "relay");
  assert(station, `${stationType} station template creates a station`);

  station.team = "blue";
  station.ownerId = "p1";
  station.state = "operational";
  station.alive = true;
  station.x = 2000;
  station.y = 1600;
  station.angle = 0;

  const weaponIndices = getShipComponentIndexes(station).weaponIndices;
  const pointDefenceIndex = weaponIndices.find((index) => station.design[index].type === "pointDefense");
  assert.notStrictEqual(pointDefenceIndex, undefined, `${stationType} station template contains Point Defence`);
  for (const index of weaponIndices) {
    if (index !== pointDefenceIndex) station.componentHp[index] = 0;
  }
  bumpComponentAliveRevision(station);

  room.stations = [station];
  room.stationsById = new Map([[station.id, station]]);
  room.map.asteroids = [];
  room.map.safeZones = [];
  room.bullets = [];
  room.projectileById.clear();
  return { room, station, pointDefenceIndex };
}

function fireThroughOrdinaryFallback(stationType) {
  const { room, station, pointDefenceIndex } = makeStationScenario(stationType);
  const primeNow = 1000;

  // Prime both acquisition cadences while there are no candidates. The hostile
  // ship then appears inside the ordinary station target list before the shared
  // PD threat-set refresh. This is the exact branch that used to align the
  // turret with a hull but fall through the weapon-family firing switch.
  updateStationWeapons(room, [station], [], 1 / 30, primeNow);
  assert.strictEqual(room.bullets.length, 0, "priming without a target creates no projectile");

  const enemy = makeEnemy(station, pointDefenceIndex, `${stationType}-fallback-target`);
  room.ships.set(enemy.id, enemy);
  room.players.get("p2").ships = [enemy];
  TargetingCadence.forceAcquisitionNow(station, "stationOrdinary", pointDefenceIndex);

  updateStationWeapons(room, [station], [enemy], 1 / 30, primeNow + 1);
  const shot = room.bullets.find((bullet) => bullet.type === "pdShot");

  assert.strictEqual(station.weaponAimTargetIds[pointDefenceIndex], enemy.id, `${stationType} PD aligns with the hostile hull fallback`);
  assert(shot, `${stationType} PD fires through the ordinary hostile-hull fallback`);
  assert.strictEqual(shot.subtype, "pointDefense", `${stationType} fallback remains a Point Defence projectile`);
  assert.strictEqual(shot.ownerId, "p1", `${stationType} fallback uses the station combat identity`);
  assert.strictEqual(shot.targetId, enemy.id, `${stationType} fallback projectile targets the hostile ship`);
  assert.strictEqual(shot.damage, PARTS.pointDefense.weapon.damage, `${stationType} fallback carries authored base PD damage`);
  assert.strictEqual(
    shot.shipDamageMultiplier,
    PARTS.pointDefense.weapon.shipDamageMultiplier,
    `${stationType} fallback carries the authored ship damage multiplier`
  );
  assert(station.weaponCooldowns[pointDefenceIndex] > 0, `${stationType} fallback starts the normal cooldown`);

  const shieldBefore = enemy.shield;
  updateBullets(room, 0.5, primeNow + 501);
  const expectedDamage = PARTS.pointDefense.weapon.damage * PARTS.pointDefense.weapon.shipDamageMultiplier;
  assert.ok(
    Math.abs((shieldBefore - enemy.shield) - expectedDamage) < 1e-9,
    `${stationType} PD ship impact applies base damage times authored shipDamageMultiplier exactly once`
  );
}

function verifyThreatPriorityAndRemovalFallback() {
  const { room, station, pointDefenceIndex } = makeStationScenario("home");
  const enemy = makeEnemy(station, pointDefenceIndex, "priority-hull-target");
  room.ships.set(enemy.id, enemy);
  room.players.get("p2").ships = [enemy];

  const origin = stationModuleWorldPosition(station, pointDefenceIndex);
  const angle = (station.angle || 0) + (station.weaponAngles[pointDefenceIndex] || 0);
  const missile = {
    id: "priority-missile",
    type: "missile",
    subtype: "missile",
    ownerId: "p2",
    targetId: station.id,
    x: origin.x + Math.cos(angle) * 170,
    y: origin.y + Math.sin(angle) * 170,
    vx: -Math.cos(angle) * 100,
    vy: -Math.sin(angle) * 100,
    damage: 20,
    hp: 20,
    life: 5,
    interceptable: true
  };
  room.bullets.push(missile);

  updateStationWeapons(room, [station], [enemy], 1 / 30, 2000);
  const interceptShot = room.bullets.find((bullet) => bullet.type === "pdShot");
  assert(interceptShot, "station PD fires at an inbound threat");
  assert.strictEqual(interceptShot.targetId, missile.id, "inbound missile is selected ahead of the hostile ship");
  assert.strictEqual(interceptShot.pdTargetType, "projectile", "threat shot preserves canonical PD metadata");
  assert.strictEqual(
    room.bullets.some((bullet) => bullet.type === "pdShot" && bullet.targetId === enemy.id),
    false,
    "ship fallback is not used while the higher-priority missile is valid"
  );

  room.bullets = [];
  room.projectileById.clear();
  station.weaponCooldowns[pointDefenceIndex] = 0;
  updateStationWeapons(room, [station], [enemy], 1 / 30, 2200);

  const hullShot = room.bullets.find((bullet) => bullet.type === "pdShot");
  assert(hullShot, "station PD fires again after the inbound threat is removed");
  assert.strictEqual(hullShot.targetId, enemy.id, "station PD falls back to the hostile ship after threat removal");
}

console.log("verify-station-point-defence");
fireThroughOrdinaryFallback("home");
console.log("  Home Station Point Defence fallback and damage passed");
fireThroughOrdinaryFallback("relay");
console.log("  Relay Station Point Defence fallback and damage passed");
verifyThreatPriorityAndRemovalFallback();
console.log("  Point Defence threat priority and post-removal fallback passed");
