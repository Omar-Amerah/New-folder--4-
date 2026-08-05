"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { PARTS } = require("../src/server/components");
const { effectiveSensorProfile } = require("../src/server/sensorCapability");
const { createRoom } = require("../src/server/rooms");
const {
  ensureTeamVisibility,
  invalidateVisibility,
  canTeamSeeEntity,
  canTeamTargetEntity,
  isPointVisibleToTeam
} = require("../src/server/visibility");
const { getTeamVisibleProjectiles } = require("../src/server/projectileReplication");
const {
  filterSnapshotForPlayer,
  auditSnapshotForInformationLeaks
} = require("../src/server/visibilitySnapshots");
const { RoomSpatialIndex } = require("../src/server/spatialIndex");

const QUICK = process.argv.includes("--quick") || !process.argv.includes("--full");
const REPEATS = QUICK ? 1 : 2;
const WARMUP_FRAMES = QUICK ? 5 : 8;
const MEASURED_FRAMES = QUICK ? 30 : 30;
const SMALL_REGRESSION_THRESHOLD = Object.freeze({ ratio: 0.15, absoluteMs: 0.5 });

// Every scenario is executed against freshly-built deterministic rooms twice.
// A scenario's mutation profile is deliberately explicit so a stationary cache
// hit cannot be confused with a source-transform benchmark.
const SCENARIOS = QUICK
  ? [
    { name: "Small", teams: 2, ships: 20, sensors: "mostly-omni", clientsPerTeam: 2, drones: 0, stations: 2, movementProfile: "none" },
    { name: "Target-only movement", teams: 2, ships: 50, sensors: "mixed", clientsPerTeam: 3, drones: 25, stations: 4, movementProfile: "target-only" },
    { name: "Source movement", teams: 4, ships: 90, sensors: "multiple-cones", clientsPerTeam: 2, drones: 45, stations: 8, movementProfile: "source-and-rotation" },
    { name: "Damage churn", teams: 4, ships: 120, sensors: "multiple-cones", clientsPerTeam: 3, drones: 50, stations: 8, movementProfile: "capability" },
    { name: "Lifecycle churn", teams: 3, ships: 90, sensors: "mixed", clientsPerTeam: 2, drones: 50, stations: 8, movementProfile: "lifecycle" },
    { name: "Snapshot-heavy", teams: 4, ships: 70, sensors: "mixed", clientsPerTeam: 4, drones: 40, stations: 8, effects: true, movementProfile: "none" }
  ]
  : [
    { name: "Small", teams: 2, ships: 50, sensors: "mostly-omni", clientsPerTeam: 2, drones: 0, stations: 4, movementProfile: "none" },
    { name: "Medium", teams: 2, ships: 150, sensors: "mixed", clientsPerTeam: 4, drones: 80, stations: 8, movementProfile: "target-only" },
    { name: "Large", teams: 4, ships: 300, sensors: "mixed", clientsPerTeam: 4, drones: 140, stations: 12, movementProfile: "source-and-target" },
    { name: "Sensor-heavy", teams: 4, ships: 500, sensors: "multiple-cones", clientsPerTeam: 4, drones: 220, stations: 16, movementProfile: "source-and-rotation" },
    { name: "Drone-heavy", teams: 2, ships: 200, sensors: "mixed", clientsPerTeam: 4, drones: 300, stations: 8, movementProfile: "target-only" },
    { name: "Station-heavy", teams: 4, ships: 250, sensors: "mixed", clientsPerTeam: 3, drones: 100, stations: 28, movementProfile: "none" },
    { name: "Mostly stationary", teams: 4, ships: 500, sensors: "mixed", clientsPerTeam: 4, drones: 180, stations: 16, movementProfile: "none" },
    { name: "High movement", teams: 4, ships: 500, sensors: "mixed", clientsPerTeam: 4, drones: 180, stations: 16, movementProfile: "source-and-target" },
    { name: "Damage churn", teams: 4, ships: 300, sensors: "multiple-cones", clientsPerTeam: 4, drones: 120, stations: 12, movementProfile: "capability" },
    { name: "Lifecycle churn", teams: 4, ships: 300, sensors: "mixed", clientsPerTeam: 4, drones: 140, stations: 16, movementProfile: "lifecycle" },
    { name: "Snapshot-heavy", teams: 4, ships: 300, sensors: "mixed", clientsPerTeam: 8, drones: 140, stations: 12, effects: true, movementProfile: "none" }
  ];

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function teamName(index, count) {
  if (count === 2) return index === 0 ? "blue" : "red";
  return `team-${index}`;
}

function addPlayer(room, id, team) {
  const player = { id, team, name: id, connected: true };
  room.players.set(id, player);
  return player;
}

function makeDesign(kind, index) {
  const design = [{ x: 7, y: 7, type: "core", rotation: 0 }];
  if (kind === "mostly-omni") {
    // This fixture must contain real sensor components.  Hull-only sources
    // would make the scenario look sensor-heavy while never exercising the
    // intended effective-profile path.
    design.push({ x: 8, y: 7, type: index % 4 === 0 ? "largeSensor" : "smallSensor", rotation: 0 });
    return design;
  }
  if (kind === "multiple-cones" || index % 3 === 0) {
    design.push({ x: 8, y: 7, type: "largeDirectedSensor", rotation: 270 });
    if (kind === "multiple-cones" && index % 2 === 0) {
      design.push({ x: 10, y: 8, type: "smallDirectedSensor", rotation: 90 });
    }
    return design;
  }
  design.push({ x: 8, y: 7, type: index % 2 ? "largeSensor" : "smallSensor", rotation: 0 });
  return design;
}

function designSensorCounts(design) {
  let components = 0;
  let directed = 0;
  for (const part of design || []) {
    const stats = PARTS[part?.type];
    if (!(Number(stats?.sensorRangeBonus) > 0)) continue;
    components += 1;
    if (stats.sensorRole === "directed") directed += 1;
  }
  return { components, directed };
}

function buildRoom(config, repeatIndex = 0) {
  const room = createRoom(`benchmark-6c-${config.name}-${config.ships}-${config.teams}-${repeatIndex}`, { seed: 606060 });
  room.rules.visibilityMode = "sensors";
  room.rules.infrastructureMode = "stations";
  room.players = new Map();
  room.ships = new Map();
  room.drones = new Map();
  room.stations = [];
  room.stationsById = new Map();
  room.points = [];
  room.effects = [];
  room.bullets = [];
  room.projectileById = new Map();

  const sensorStats = { shipsWithSensorDesign: 0, sensorComponents: 0, directedComponents: 0 };
  for (let teamIndex = 0; teamIndex < config.teams; teamIndex += 1) {
    const team = teamName(teamIndex, config.teams);
    for (let clientIndex = 0; clientIndex < config.clientsPerTeam; clientIndex += 1) {
      addPlayer(room, `p-${teamIndex}-${clientIndex}`, team);
    }
  }
  for (let index = 0; index < config.ships; index += 1) {
    const teamIndex = index % config.teams;
    const team = teamName(teamIndex, config.teams);
    const design = makeDesign(config.sensors, index);
    const counts = designSensorCounts(design);
    if (counts.components) sensorStats.shipsWithSensorDesign += 1;
    sensorStats.sensorComponents += counts.components;
    sensorStats.directedComponents += counts.directed;
    const ship = {
      id: `s${index}`,
      type: "ship",
      entityType: "ship",
      ownerId: `p-${teamIndex}-0`,
      team,
      alive: true,
      removed: false,
      hp: 100,
      maxHp: 100,
      x: 240 + ((index * 557) % 9000),
      y: 240 + ((index * 733) % 6200),
      vx: 0,
      vy: 0,
      angle: (index % 16) * Math.PI / 8,
      radius: 24,
      physicalRadius: 24,
      design,
      componentHp: design.map(() => 100),
      componentMaxHp: design.map(() => 100),
      componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1, state: "powered" })) },
      stats: { massClass: index % 5 === 0 ? "heavy" : "medium" }
    };
    room.ships.set(ship.id, ship);
  }
  for (let index = 0; index < config.drones; index += 1) {
    const teamIndex = index % config.teams;
    const team = teamName(teamIndex, config.teams);
    room.drones.set(`d${index}`, {
      id: `d${index}`,
      type: "drone",
      entityType: "drone",
      ownerId: `p-${teamIndex}-0`,
      teamId: team,
      x: 180 + ((index * 389) % 9000),
      y: 180 + ((index * 613) % 6200),
      vx: 0,
      vy: 0,
      radius: 10,
      hull: 20,
      maxHull: 20,
      destroyed: false,
      removed: false
    });
  }
  for (let index = 0; index < config.stations; index += 1) {
    const team = index % config.teams === 0 ? teamName(index % config.teams, config.teams) : null;
    const station = {
      id: `st${index}`,
      entityType: "station",
      stationType: index % 3 === 0 ? "home" : "relay",
      team,
      ownerId: null,
      state: team ? "operational" : "neutral",
      alive: true,
      x: 500 + ((index * 1097) % 8500),
      y: 500 + ((index * 1429) % 5700),
      angle: 0,
      radius: index % 3 === 0 ? 300 : 120,
      hp: 100,
      maxHp: 100,
      revision: 1,
      componentDamageRevision: 1,
      componentAliveRevision: 1,
      healthRevision: 1
    };
    room.stations.push(station);
    room.stationsById.set(station.id, station);
  }

  const bulletCount = config.effects ? 700 : 0;
  for (let index = 0; index < bulletCount; index += 1) {
    const ownerTeamIndex = index % config.teams;
    const bullet = {
      id: `b${index}`,
      type: "bolt",
      subtype: null,
      entityType: "projectile",
      ownerId: `p-${ownerTeamIndex}-0`,
      x: (index * 431) % 9000,
      y: (index * 719) % 6200,
      vx: 0,
      vy: 0,
      radius: 2,
      bornAt: 1000,
      life: 10
    };
    room.bullets.push(bullet);
    room.projectileById.set(bullet.id, bullet);
  }
  const effectCount = config.effects ? 300 : 0;
  for (let index = 0; index < effectCount; index += 1) {
    room.effects.push({
      id: `e${index}`,
      x: (index * 617) % 9000,
      y: (index * 283) % 6200,
      at: 1000,
      subtype: index % 2 ? "impact" : "beam"
    });
  }

  room.spatialIndex = new RoomSpatialIndex(320);
  room.spatialIndex.rebuild(room, [...room.ships.values()], 0);
  room.spatialIndex.updateLiveEntities("drones", room.drones.values(), (drone) => drone.radius);
  room.spatialIndex.updateLiveEntities("stations", room.stations, (station) => station.radius);
  room._phase6cFixtureStats = sensorStats;
  return room;
}

function teamsFor(config) {
  return Array.from({ length: config.teams }, (_, index) => teamName(index, config.teams));
}

function updateSpatialIndex(room) {
  if (!room.spatialIndex) return;
  room.spatialIndex.updateLiveEntities("ships", room.ships.values(), (ship) => ship.radius);
  room.spatialIndex.updateLiveEntities("drones", room.drones.values(), (drone) => drone.radius);
  room.spatialIndex.updateLiveEntities("stations", room.stations, (station) => station.radius);
}

function mutateRoom(room, config, frame, teams) {
  const sourceIds = [];
  const targetIds = [];
  const sourceTeams = new Set();
  const targetTeams = new Set(teams);
  const profile = config.movementProfile;

  if (profile === "source-and-rotation" || profile === "source-and-target") {
    for (const [index, ship] of [...room.ships.values()].entries()) {
      ship.x += Math.sin(frame * 0.17 + index) * 2.5;
      ship.y += Math.cos(frame * 0.13 + index) * 1.7;
      ship.angle += 0.01;
      sourceIds.push(ship.id);
      sourceTeams.add(ship.team);
    }
  } else if (profile === "target-only") {
    for (const [index, ship] of [...room.ships.values()].entries()) {
      if (index % Math.max(2, config.teams) !== 0) continue;
      ship.x += Math.sin(frame * 0.13 + index) * 2.5;
      ship.y += Math.cos(frame * 0.19 + index) * 1.7;
      targetIds.push(ship.id);
    }
  }

  if (profile === "source-and-rotation") {
    for (const [index, ship] of [...room.ships.values()].entries()) {
      if (index % 2 === 0) ship.angle += 0.015;
    }
  }

  if (profile === "capability" && frame % 3 === 0) {
    const source = room.ships.get(`s${frame % Math.max(1, room.ships.size)}`);
    if (source && source.design.length > 1) {
      const componentIndex = 1;
      const damaged = source.componentHp[componentIndex] > 0;
      source.componentHp[componentIndex] = damaged ? 0 : source.componentMaxHp[componentIndex];
      source.componentDamageRevision = (source.componentDamageRevision || 0) + 1;
      source.componentAliveRevision = (source.componentAliveRevision || 0) + 1;
      source.powerRevision = (source.powerRevision || 0) + 1;
      source.heatStateRevision = (source.heatStateRevision || 0) + 1;
      sourceTeams.add(source.team);
      sourceIds.push(source.id);
    }
  }

  let lifecycleChanged = false;
  if (profile === "lifecycle") {
    if (frame % 6 === 0) {
      const index = frame / 6;
      const teamIndex = (index + 1) % config.teams;
      const team = teamName(teamIndex, config.teams);
      const id = `life-d${index}`;
      room.drones.set(id, {
        id,
        type: "drone",
        entityType: "drone",
        ownerId: `p-${teamIndex}-0`,
        teamId: team,
        x: 2400 + index * 30,
        y: 1800 + index * 17,
        radius: 10,
        hull: 20,
        maxHull: 20,
        destroyed: false,
        removed: false
      });
      lifecycleChanged = true;
    }
    if (frame % 6 === 3) {
      const id = `life-d${Math.floor(frame / 6)}`;
      if (room.drones.delete(id)) lifecycleChanged = true;
    }
    if (frame % 10 === 5) {
      const index = Math.floor(frame / 10);
      const id = `life-st${index}`;
      const station = {
        id,
        entityType: "station",
        stationType: "relay",
        team: teamName((index + 1) % config.teams, config.teams),
        ownerId: null,
        state: "operational",
        alive: true,
        x: 3200 + index * 40,
        y: 2200 + index * 23,
        angle: 0,
        radius: 120,
        hp: 100,
        maxHp: 100,
        revision: 1,
        componentDamageRevision: 1,
        componentAliveRevision: 1,
        healthRevision: 1
      };
      room.stations.push(station);
      room.stationsById.set(id, station);
      lifecycleChanged = true;
    }
    if (frame % 10 === 8) {
      const id = `life-st${Math.floor(frame / 10)}`;
      const station = room.stationsById.get(id);
      if (station) {
        room.stations = room.stations.filter((entry) => entry !== station);
        room.stationsById.delete(id);
        lifecycleChanged = true;
      }
    }
  }

  if (profile !== "none") updateSpatialIndex(room);
  if (lifecycleChanged) {
    return { class: "full-lifecycle", invalidation: { reason: "benchmark-lifecycle", allegianceChanged: true } };
  }
  if (sourceIds.length && targetIds.length) {
    return {
      class: "source-and-target-movement",
      invalidation: { reason: "benchmark-source-and-target", sourceTeams, targetTeams, sourceIds, entityIds: targetIds }
    };
  }
  if (sourceIds.length) {
    return {
      class: profile === "capability" ? "capability-change" : "source-movement-and-rotation",
      invalidation: { reason: profile === "capability" ? "benchmark-capability" : "benchmark-source-transform", sourceTeams, sourceIds }
    };
  }
  if (targetIds.length) {
    return { class: "target-only-movement", invalidation: { reason: "benchmark-target-movement", targetTeams, entityIds: targetIds } };
  }
  if (profile === "none") return { class: "no-change", invalidation: null };
  return { class: "no-change", invalidation: null };
}

function snapshotForRoom(room, config, now, frame) {
  const ships = [...room.ships.values()].map((ship) => ({
    id: ship.id,
    team: ship.team,
    x: ship.x,
    y: ship.y,
    radius: ship.radius,
    privatePower: `${ship.team}-private-${ship.id}`
  }));
  const drones = [...room.drones.values()].map((drone) => ({
    id: drone.id,
    ownerId: drone.ownerId,
    team: drone.teamId,
    x: drone.x,
    y: drone.y,
    radius: drone.radius
  }));
  const stations = room.stations.map((station) => ({
    id: station.id,
    stationType: station.stationType,
    team: station.team,
    ownerId: station.ownerId,
    state: station.state,
    x: station.x,
    y: station.y,
    radius: station.radius,
    hp: station.hp,
    maxHp: station.maxHp,
    design: []
  }));
  const bullets = room.bullets.map((bullet) => ({
    id: bullet.id,
    ownerId: bullet.ownerId,
    x: bullet.x,
    y: bullet.y,
    radius: bullet.radius
  }));
  const effects = room.effects.map((effect) => ({ ...effect }));
  const snapshotEntityMeta = {
    shipsById: new Map(ships.map((entry) => [entry.id, entry])),
    dronesById: new Map(drones.map((entry) => [entry.id, entry])),
    stationsById: new Map(stations.map((entry) => [entry.id, entry])),
    entityTeamById: new Map()
  };
  for (const ship of ships) snapshotEntityMeta.entityTeamById.set(ship.id, ship.team);
  for (const drone of drones) snapshotEntityMeta.entityTeamById.set(drone.id, drone.team);
  for (const station of stations) snapshotEntityMeta.entityTeamById.set(station.id, station.team);
  for (const bullet of bullets) snapshotEntityMeta.entityTeamById.set(
    bullet.id,
    room.players.get(bullet.ownerId)?.team || null
  );
  const snapshot = {
    stateEpoch: room.stateEpoch || 1,
    snapshotSeq: frame + 1,
    staticRevision: room.staticRevision || 1,
    baseSnapshotSeq: Math.max(0, frame),
    ships,
    drones,
    decoys: [],
    bullets,
    effects,
    stations,
    time: now
  };
  Object.defineProperty(snapshot, "snapshotEntityMeta", {
    value: snapshotEntityMeta,
    enumerable: false,
    configurable: true
  });
  return snapshot;
}

function canonicalState(state) {
  return {
    visible: [...(state?.visibleEntityIds || [])].sort(),
    remembered: [...(state?.remembered?.values?.() || [])]
      .map((contact) => ({
        id: contact.id,
        entityType: contact.entityType,
        sourceEntityType: contact.sourceEntityType,
        contactClass: contact.contactClass,
        lastKnownX: round(contact.lastKnownX),
        lastKnownY: round(contact.lastKnownY),
        lastKnownAngle: round(contact.lastKnownAngle),
        lastSeenAt: round(contact.lastSeenAt)
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    coverage: (state?.coverage || [])
      .map((entry) => ({
        sourceId: entry.sourceId ?? entry.id,
        x: round(entry.x),
        y: round(entry.y),
        range: round(entry.range),
        rangeSquared: round(entry.rangeSquared ?? ((Number(entry.range) || 0) ** 2)),
        shape: entry.shape,
        angle: round(entry.angle),
        halfAngle: round(entry.halfAngle),
        cosHalfAngle: round(entry.cosHalfAngle ?? Math.cos(Number(entry.halfAngle) || 0))
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  };
}

function canonicalFiltered(snapshot) {
  return {
    ships: (snapshot.ships || []).map((ship) => ({ id: ship.id, privatePower: ship.privatePower })).sort((a, b) => a.id.localeCompare(b.id)),
    drones: (snapshot.drones || []).map((drone) => drone.id).sort(),
    bullets: (snapshot.bullets || []).map((bullet) => bullet.id).sort(),
    effects: (snapshot.effects || []).map((effect) => effect.id).sort(),
    stations: (snapshot.stations || []).map((station) => ({
      id: station.id,
      state: station.state,
      conditionKnown: station.conditionKnown,
      mapKnown: station.mapKnown,
      hasHp: station.hp !== undefined || station.maxHp !== undefined
    })).sort((a, b) => a.id.localeCompare(b.id)),
    contacts: (snapshot.contacts || []).map((contact) => ({
      id: contact.id,
      lastKnownX: round(contact.lastKnownX),
      lastKnownY: round(contact.lastKnownY),
      lastKnownAngle: round(contact.lastKnownAngle),
      hasLiveVelocity: contact.vx !== undefined || contact.vy !== undefined
    })).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function fixtureSummary(room, config) {
  const stats = room._phase6cFixtureStats || {};
  const effectiveProfiles = [...room.ships.values()].map((ship) => effectiveSensorProfile(ship, room));
  const effectiveDirected = effectiveProfiles.reduce((sum, profile) => sum + (profile.directed?.length || 0), 0);
  const sourceCount = new Set([...room._visibilityRuntime?.sourcesByTeam?.values?.() || []].flat().map((record) => record.key)).size;
  const sourceRegistryCount = room._visibilityRuntime?.sourceByEntityId?.size || 0;
  assert(stats.shipsWithSensorDesign > 0, `${config.name}: fixture has no sensor-component ships`);
  if (config.sensors === "mostly-omni") {
    assert.equal(stats.shipsWithSensorDesign, config.ships, `${config.name}: mostly-omni fixture lost its sensor components`);
    assert(effectiveProfiles.every((profile) => profile.omniRange > 0), `${config.name}: mostly-omni effective profiles are empty`);
  }
  if (config.sensors === "multiple-cones") {
    assert(stats.directedComponents > 0 && effectiveDirected > 0, `${config.name}: directed fixture has no effective cones`);
  }
  assert(sourceCount >= config.ships, `${config.name}: active source count ${sourceCount} is below the ship population ${config.ships}`);
  return {
    shipsWithSensorDesign: stats.shipsWithSensorDesign,
    sensorComponents: stats.sensorComponents,
    directedComponents: stats.directedComponents,
    effectiveDirectedCones: effectiveDirected,
    effectiveSourceCount: sourceCount,
    sourceRegistryCount
  };
}

function frameObservation(room, teams, viewers, filteredByViewer, now) {
  const teamStates = {};
  for (const team of teams) teamStates[team] = canonicalState(ensureTeamVisibility(room, team, now));
  const filtered = {};
  for (const { viewer, result } of filteredByViewer) filtered[viewer.id] = canonicalFiltered(result);
  const entities = [
    ...(room.ships?.values?.() || []),
    ...(room.drones?.values?.() || []),
    ...(room.stations || [])
  ].sort((a, b) => String(a?.id).localeCompare(String(b?.id)));
  const relationships = {};
  for (const team of teams) {
    relationships[team] = {
      entities: entities.map((entity) => ({
        id: entity.id,
        see: canTeamSeeEntity(room, team, entity, now),
        target: canTeamTargetEntity(room, team, entity, now)
      })),
      points: [
        [0, 0],
        [500, 500],
        [4500, 3100]
      ].map(([x, y]) => isPointVisibleToTeam(room, team, x, y, now))
    };
  }
  const projectileVisibility = Object.fromEntries(teams.map((team) => [
    team,
    [...getTeamVisibleProjectiles(room, team, now)].sort()
  ]));
  return { teamStates, filtered, relationships, projectileVisibility };
}

function runFrame(room, config, teams, viewers, frame, phase, bootstrap = false) {
  const now = 1000 + frame * 33;
  room.simulationTimeMs = now;
  const before = {
    generation: room._visibilityGeneration || 1,
    computes: room._visibilityComputeCount || 0,
    invalidations: room._visibilityInvalidationCount || 0,
    duplicates: room._roomTelemetry?.visibilityDuplicateInvalidations || 0,
    afterFinalization: room._roomTelemetry?.visibilityComputesAfterFinalization || 0
  };
  const mutation = bootstrap
    ? { class: "bootstrap", invalidation: { reason: "benchmark-bootstrap", geometryChanged: true } }
    : mutateRoom(room, config, frame, teams);
  if (mutation.invalidation) invalidateVisibility(room, mutation.invalidation);

  const frameStart = performance.now();
  const snapshot = snapshotForRoom(room, config, now, frame);
  const visibilityStart = performance.now();
  for (const team of teams) ensureTeamVisibility(room, team, now);
  const visibilityMs = performance.now() - visibilityStart;
  const filterStart = performance.now();
  const filteredByViewer = [];
  for (const viewer of viewers) {
    filteredByViewer.push({ viewer, result: filterSnapshotForPlayer(room, viewer, snapshot, now) });
  }
  const filterMs = performance.now() - filterStart;
  const totalMs = performance.now() - frameStart;
  const auditStart = performance.now();
  for (const { viewer, result } of filteredByViewer) auditSnapshotForInformationLeaks(room, viewer, result, now);
  const auditMs = performance.now() - auditStart;
  const observation = frameObservation(room, teams, viewers, filteredByViewer, now);
  room._visibilityFinalizedAt = now;
  const telemetry = room._roomTelemetry || {};
  const after = {
    generation: room._visibilityGeneration || 1,
    computes: room._visibilityComputeCount || 0,
    invalidations: room._visibilityInvalidationCount || 0,
    duplicates: telemetry.visibilityDuplicateInvalidations || 0,
    afterFinalization: telemetry.visibilityComputesAfterFinalization || 0
  };
  return {
    observation,
    observationJson: JSON.stringify(observation),
    class: mutation.class,
    phase,
    timings: {
      visibility: visibilityMs,
      filter: filterMs,
      audit: auditMs,
      total: totalMs
    },
    counters: {
      generationAdvances: after.generation - before.generation,
      computations: after.computes - before.computes,
      invalidations: after.invalidations - before.invalidations,
      duplicateInvalidations: after.duplicates - before.duplicates,
      computesAfterFinalization: after.afterFinalization - before.afterFinalization
    }
  };
}

function roomMemory() {
  if (typeof global.gc === "function") global.gc();
  return process.memoryUsage().heapUsed;
}

function runCanonicalMode(config, repeatIndex) {
  const room = buildRoom(config, repeatIndex);
  const teams = teamsFor(config);
  const viewers = [...room.players.values()];
  const memoryBefore = roomMemory();
  const frames = [];
  frames.push(runFrame(room, config, teams, viewers, 0, "cold", true));
  for (let frame = 1; frame <= WARMUP_FRAMES; frame += 1) {
    frames.push(runFrame(room, config, teams, viewers, frame, "warmup"));
  }
  const measured = [];
  for (let index = 0; index < MEASURED_FRAMES; index += 1) {
    const frame = WARMUP_FRAMES + 1 + index;
    const result = runFrame(room, config, teams, viewers, frame, "measured");
    frames.push(result);
    measured.push(result);
  }
  const memoryAfter = roomMemory();
  const runtime = room._visibilityRuntime;
  const telemetry = room._roomTelemetry || {};
  const fixture = fixtureSummary(room, config);
  const finalSourceCount = new Set([...runtime?.sourcesByTeam?.values?.() || []].flat().map((record) => record.key)).size;
  return {
    mode: "canonical",
    fixture,
    room,
    frames,
    measured,
    firstBuild: frames[0].timings,
    memory: { heapBefore: memoryBefore, heapAfter: memoryAfter, heapDelta: memoryAfter - memoryBefore },
    sourceCountInitial: fixture.effectiveSourceCount,
    sourceCountFinal: finalSourceCount,
    telemetry: { ...telemetry },
    runtimeSizes: {
      sources: runtime?.sourceByEntityId?.size || 0,
      sourceTeams: runtime?.sourcesByTeam?.size || 0,
      entityTeams: runtime?.teamEntityIds?.size || 0,
      teamStates: runtime?.teamStates?.size || 0
    },
    sequenceChecksum: digest(frames.map((frame) => frame.observation))
  };
}

function summarizeTiming(runs, key) {
  const measured = runs.flatMap((run) => run.measured.map((frame) => frame.timings[key]));
  const cold = runs.map((run) => run.firstBuild[key]);
  return {
    p50: round(percentile(measured, 0.5), 4),
    p95: round(percentile(measured, 0.95), 4),
    mean: round(mean(measured), 4),
    coldP50: round(percentile(cold, 0.5), 4),
    coldP95: round(percentile(cold, 0.95), 4)
  };
}

function summarizeCounters(runs) {
  const telemetryFields = [
    "visibilityShipQueries", "visibilityDroneQueries", "visibilityStationQueries",
    "visibilityShipCandidates", "visibilityDroneCandidates", "visibilityStationCandidates",
    "visibilitySourcesUpdated", "visibilityTransformOnlyUpdates", "visibilityCapabilityCacheHits",
    "visibilityTeamCacheHits", "visibilitySnapshotFilterCacheHits", "visibilityFullCollectionFallbacks",
    "visibilitySnapshotFilterBuilds", "visibilitySnapshotShipsConsidered", "visibilitySnapshotDronesConsidered",
    "visibilitySnapshotBulletsConsidered", "visibilitySnapshotEffectsConsidered", "visibilityInvalidations",
    "visibilityGenerationAdvances", "visibilityDuplicateInvalidations", "visibilityComputesAfterFinalization",
    "visibilityReconciliations"
  ];
  const counters = {};
  for (const field of telemetryFields) counters[field] = round(mean(runs.map((run) => Number(run.telemetry[field]) || 0)), 4);
  counters.sourcesRecomputed = Math.max(0, counters.visibilitySourcesUpdated - counters.visibilityTransformOnlyUpdates);
  counters.fallbackScans = counters.visibilityFullCollectionFallbacks;
  return counters;
}

function summarizeSteps(runs) {
  const byClass = new Map();
  for (const run of runs) {
    for (const frame of run.measured) {
      const list = byClass.get(frame.class) || [];
      list.push(frame.counters);
      byClass.set(frame.class, list);
    }
  }
  return Object.fromEntries([...byClass.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, {
    steps: values.length,
    generationAdvances: round(mean(values.map((value) => value.generationAdvances)), 4),
    computations: round(mean(values.map((value) => value.computations)), 4),
    invalidations: round(mean(values.map((value) => value.invalidations)), 4),
    duplicateInvalidations: round(mean(values.map((value) => value.duplicateInvalidations)), 4),
    computesAfterFinalization: round(mean(values.map((value) => value.computesAfterFinalization)), 4)
  }]));
}

function compareRuns(config, canonicalRuns, repeatRuns) {
  for (let repeat = 0; repeat < canonicalRuns.length; repeat += 1) {
    const canonicalFrames = canonicalRuns[repeat].frames;
    const repeatFrames = repeatRuns[repeat].frames;
    assert.equal(repeatFrames.length, canonicalFrames.length, `${config.name}: frame count parity`);
    for (let frame = 0; frame < canonicalFrames.length; frame += 1) {
      assert.equal(
        repeatFrames[frame].observationJson,
        canonicalFrames[frame].observationJson,
        `${config.name}: canonical repeat parity failed at repeat ${repeat}, ${canonicalFrames[frame].phase} frame ${frame}`
      );
    }
    assert.equal(repeatRuns[repeat].sequenceChecksum, canonicalRuns[repeat].sequenceChecksum, `${config.name}: sequence checksum parity`);
    assert.equal(repeatRuns[repeat].fixture.effectiveSourceCount, canonicalRuns[repeat].fixture.effectiveSourceCount, `${config.name}: source count parity`);
  }

  const metric = (key) => ({
    absoluteMs: round(repeatSummary[key].p50 - canonicalSummary[key].p50, 4),
    percentageReduction: canonicalSummary[key].p50 > 0
      ? round(((canonicalSummary[key].p50 - repeatSummary[key].p50) / canonicalSummary[key].p50) * 100, 2)
      : 0
  });
  const canonicalSummary = {
    visibility: summarizeTiming(canonicalRuns, "visibility"),
    filter: summarizeTiming(canonicalRuns, "filter"),
    total: summarizeTiming(canonicalRuns, "total")
  };
  const repeatSummary = {
    visibility: summarizeTiming(repeatRuns, "visibility"),
    filter: summarizeTiming(repeatRuns, "filter"),
    total: summarizeTiming(repeatRuns, "total")
  };
  const smallRegression = config.name === "Small"
    ? ["p50", "p95"].filter((stat) => repeatSummary.total[stat] > canonicalSummary.total[stat] * (1 + SMALL_REGRESSION_THRESHOLD.ratio)
      && repeatSummary.total[stat] - canonicalSummary.total[stat] > SMALL_REGRESSION_THRESHOLD.absoluteMs)
    : [];
  assert.equal(smallRegression.length, 0, `${config.name}: repeated canonical total timing exceeded the small-fixture threshold (${SMALL_REGRESSION_THRESHOLD.ratio * 100}% and ${SMALL_REGRESSION_THRESHOLD.absoluteMs}ms) for ${smallRegression.join(", ")}`);
  const fallbackScans = repeatRuns.reduce(
    (sum, run) => sum + (Number(run.telemetry.visibilityFullCollectionFallbacks) || 0),
    0
  );
  assert.equal(fallbackScans, 0, `${config.name}: indexed benchmark used a full-collection fallback`);
  return {
    checksumsEqual: true,
    canonical: canonicalSummary,
    repeat: repeatSummary,
    difference: { visibility: metric("visibility"), snapshotFiltering: metric("filter"), total: metric("total") },
    smallRegressionThreshold: config.name === "Small" ? SMALL_REGRESSION_THRESHOLD : null,
    regressionGate: { passed: smallRegression.length === 0, exceededMetrics: smallRegression.map((stat) => `total.${stat}`) }
  };
}

function summarizeMode(runs) {
  return {
    visibilityStageMs: summarizeTiming(runs, "visibility"),
    snapshotFilteringMs: summarizeTiming(runs, "filter"),
    visibilityAuditMs: summarizeTiming(runs, "audit"),
    totalFrameMs: summarizeTiming(runs, "total"),
    counters: summarizeCounters(runs),
    invalidationSteps: summarizeSteps(runs),
    memory: {
      heapDeltaBytes: round(mean(runs.map((run) => run.memory.heapDelta)), 0),
      heapBeforeBytes: round(mean(runs.map((run) => run.memory.heapBefore)), 0),
      heapAfterBytes: round(mean(runs.map((run) => run.memory.heapAfter)), 0)
    },
    sourceCountInitial: runs[0].sourceCountInitial,
    sourceCountFinal: runs[runs.length - 1].sourceCountFinal,
    runtimeSizes: runs[runs.length - 1].runtimeSizes,
    finalVisibilityChecksum: runs[runs.length - 1].sequenceChecksum,
    informationLeakAudit: "passed"
  };
}

function runScenario(config) {
  const canonicalRuns = [];
  const repeatRuns = [];
  for (let repeat = 0; repeat < REPEATS; repeat += 1) {
    canonicalRuns.push(runCanonicalMode(config, repeat));
    repeatRuns.push(runCanonicalMode(config, repeat));
  }
  const comparison = compareRuns(config, canonicalRuns, repeatRuns);
  return {
    scenario: config.name,
    teams: config.teams,
    ships: config.ships,
    drones: config.drones,
    stations: config.stations,
    clients: config.teams * config.clientsPerTeam,
    warmupFrames: WARMUP_FRAMES,
    measuredFrames: MEASURED_FRAMES,
    repeats: REPEATS,
    fixture: canonicalRuns[0].fixture,
    canonical: summarizeMode(canonicalRuns),
    repeat: summarizeMode(repeatRuns),
    comparison
  };
}

function main() {
  const results = [];
  for (const scenario of SCENARIOS) results.push(runScenario(scenario));
  console.log(JSON.stringify({
    status: "passed",
    mode: QUICK ? "quick" : "full",
    warmupFrames: WARMUP_FRAMES,
    measuredFrames: MEASURED_FRAMES,
    repeats: REPEATS,
    smallRegressionThreshold: SMALL_REGRESSION_THRESHOLD,
    results
  }, null, 2));
}

main();
