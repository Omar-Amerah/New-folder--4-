"use strict";

const { performance } = require("node:perf_hooks");
const flags = require("./src/server/performanceFlags");
const { createRoom } = require("./src/server/rooms");
const { ensureTeamVisibility, invalidateVisibility } = require("./src/server/visibility");
const {
  filterSnapshotForPlayer,
  auditSnapshotForInformationLeaks
} = require("./src/server/visibilitySnapshots");
const { RoomSpatialIndex } = require("./src/server/spatialIndex");

const QUICK = process.argv.includes("--quick") || !process.argv.includes("--full");

const SCENARIOS = QUICK
  ? [
    { name: "Small", teams: 2, ships: 20, sensors: "mostly-omni", clientsPerTeam: 2, drones: 0, stations: 2, frames: 12 },
    { name: "Medium", teams: 2, ships: 50, sensors: "mixed", clientsPerTeam: 3, drones: 25, stations: 4, frames: 10 },
    { name: "Sensor-heavy", teams: 4, ships: 90, sensors: "multiple-cones", clientsPerTeam: 2, drones: 45, stations: 8, frames: 8 },
    { name: "Snapshot-heavy", teams: 4, ships: 70, sensors: "mixed", clientsPerTeam: 4, drones: 40, stations: 8, frames: 8 }
  ]
  : [
    { name: "Small", teams: 2, ships: 50, sensors: "mostly-omni", clientsPerTeam: 2, drones: 0, stations: 4, frames: 20 },
    { name: "Medium", teams: 2, ships: 150, sensors: "mixed", clientsPerTeam: 4, drones: 80, stations: 8, frames: 16 },
    { name: "Large", teams: 4, ships: 300, sensors: "mixed", clientsPerTeam: 4, drones: 140, stations: 12, frames: 12 },
    { name: "Sensor-heavy", teams: 4, ships: 500, sensors: "multiple-cones", clientsPerTeam: 4, drones: 220, stations: 16, frames: 10 },
    { name: "Drone-heavy", teams: 2, ships: 200, sensors: "mixed", clientsPerTeam: 4, drones: 300, stations: 8, frames: 12 },
    { name: "Station-heavy", teams: 4, ships: 250, sensors: "mixed", clientsPerTeam: 3, drones: 100, stations: 28, frames: 12 },
    { name: "Mostly stationary", teams: 4, ships: 500, sensors: "mixed", clientsPerTeam: 4, drones: 180, stations: 16, frames: 10 },
    { name: "High movement", teams: 4, ships: 500, sensors: "mixed", clientsPerTeam: 4, drones: 180, stations: 16, frames: 10, movement: true },
    { name: "Damage churn", teams: 4, ships: 300, sensors: "multiple-cones", clientsPerTeam: 4, drones: 120, stations: 12, frames: 12, damage: true },
    { name: "Snapshot-heavy", teams: 4, ships: 300, sensors: "mixed", clientsPerTeam: 8, drones: 140, stations: 12, frames: 12, effects: true }
  ];

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
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
  if (kind === "mostly-omni" || index % 3 !== 0) return [];
  const design = [{ x: 7, y: 7, type: "core", rotation: 0 }];
  design.push({ x: 8, y: 7, type: "largeDirectedSensor", rotation: 270 });
  if (kind === "multiple-cones" && index % 2 === 0) {
    design.push({ x: 10, y: 8, type: "smallDirectedSensor", rotation: 90 });
  }
  return design;
}

function buildRoom(config) {
  const room = createRoom(`benchmark-6c-${config.name}-${config.ships}-${config.teams}`, { seed: 606060 });
  room.rules.visibilityMode = "sensors";
  room.rules.infrastructureMode = "stations";
  room.players = new Map();
  room.ships = new Map();
  room.drones = new Map();
  room.stations = [];
  room.stationsById = new Map();
  room.points = [];
  room.effects = [];
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
    const ship = {
      id: `s${index}`,
      type: "ship",
      entityType: "ship",
      ownerId: `p-${teamIndex}-0`,
      team,
      alive: true,
      removed: false,
      hp: 100,
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
  room.spatialIndex = new RoomSpatialIndex(320);
  room.spatialIndex.rebuild(room, [...room.ships.values()], 0);
  return room;
}

function snapshotForRoom(room, config, now) {
  const ships = [...room.ships.values()].map((ship) => ({ id: ship.id, team: ship.team, x: ship.x, y: ship.y, radius: ship.radius }));
  const drones = [...room.drones.values()].map((drone) => ({ id: drone.id, ownerId: drone.ownerId, x: drone.x, y: drone.y, radius: drone.radius }));
  const stations = room.stations.map((station) => ({ id: station.id, stationType: station.stationType, team: station.team, ownerId: station.ownerId, state: station.state, x: station.x, y: station.y, radius: station.radius, design: [] }));
  const bullets = config.effects ? Array.from({ length: 700 }, (_, index) => ({ id: `b${index}`, ownerId: index % 2 ? "p-0-0" : "p-1-0", x: (index * 431) % 9000, y: (index * 719) % 6200 })) : [];
  const effects = config.effects ? Array.from({ length: 300 }, (_, index) => ({ id: `e${index}`, x: (index * 617) % 9000, y: (index * 283) % 6200 })) : [];
  return { ships, drones, decoys: [], bullets, effects, stations, time: now };
}

function moveRoom(room, config, frame) {
  if (config.movement) {
    for (const [index, ship] of [...room.ships.values()].entries()) {
      ship.x += Math.sin(frame * 0.17 + index) * 2.5;
      ship.y += Math.cos(frame * 0.13 + index) * 1.7;
      ship.angle += 0.01;
    }
    for (const [index, drone] of [...room.drones.values()].entries()) {
      drone.x += Math.sin(frame * 0.11 + index) * 2;
      drone.y += Math.cos(frame * 0.19 + index) * 1.4;
    }
    room.spatialIndex.updateLiveEntities("ships", room.ships.values(), (ship) => ship.radius);
    room.spatialIndex.updateLiveEntities("drones", room.drones.values(), (drone) => drone.radius);
    room.spatialIndex.updateLiveEntities("stations", room.stations, (station) => station.radius);
  }
  if (config.damage && frame % 3 === 0) {
    const source = room.ships.get(`s${frame % Math.max(1, room.ships.size)}`);
    if (source?.design?.length) {
      source.componentHp[0] = source.componentHp[0] > 0 ? 0 : 100;
      source.componentDamageRevision = (source.componentDamageRevision || 0) + 1;
      source.componentAliveRevision = (source.componentAliveRevision || 0) + 1;
      source.powerRevision = (source.powerRevision || 0) + 1;
      source.heatStateRevision = (source.heatStateRevision || 0) + 1;
    }
  }
}

function runScenario(config) {
  flags.__setOPTIMIZED_VISIBILITY_RUNTIME(true);
  const room = buildRoom(config);
  const teams = Array.from({ length: config.teams }, (_, index) => teamName(index, config.teams));
  const viewers = [...room.players.values()];
  const wallSamples = [];
  const visibilitySamples = [];
  const filterSamples = [];
  let checksum = 0;
  let sourceCountInitial = 0;
  let informationLeakAudit = "not-run";

  for (let frame = 0; frame < config.frames; frame += 1) {
    const now = 1000 + frame * 33;
    moveRoom(room, config, frame);
    const snapshot = snapshotForRoom(room, config, now);
    const frameStart = performance.now();
    invalidateVisibility(room, { reason: "benchmark-frame", geometryChanged: true });
    const visibilityStart = performance.now();
    for (const team of teams) ensureTeamVisibility(room, team, now);
    if (!sourceCountInitial) sourceCountInitial = room._visibilityRuntime?.sourceByEntityId?.size || 0;
    const visibilityMs = performance.now() - visibilityStart;
    const filterStart = performance.now();
    const finalFiltered = [];
    for (const viewer of viewers) {
      const filtered = filterSnapshotForPlayer(room, viewer, snapshot, now);
      checksum += filtered.ships.length + filtered.drones.length + filtered.bullets.length + filtered.effects.length + filtered.stations.length;
      if (frame === config.frames - 1) finalFiltered.push({ viewer, filtered });
    }
    const filterMs = performance.now() - filterStart;
    if (frame === config.frames - 1) {
      for (const { viewer, filtered } of finalFiltered) {
        auditSnapshotForInformationLeaks(room, viewer, filtered, now);
      }
      informationLeakAudit = "passed";
    }
    wallSamples.push(performance.now() - frameStart);
    visibilitySamples.push(visibilityMs);
    filterSamples.push(filterMs);
  }

  const telemetry = room._roomTelemetry || {};
  const runtime = room._visibilityRuntime;
  return {
    scenario: config.name,
    teams: config.teams,
    ships: config.ships,
    drones: config.drones,
    stations: config.stations,
    clients: viewers.length,
    frames: config.frames,
    visibilityStageMs: { p50: percentile(visibilitySamples, 0.5), p95: percentile(visibilitySamples, 0.95) },
    snapshotFilteringMs: { p50: percentile(filterSamples, 0.5), p95: percentile(filterSamples, 0.95) },
    totalFrameMs: { p50: percentile(wallSamples, 0.5), p95: percentile(wallSamples, 0.95) },
    spatialQueryCount: (telemetry.visibilityShipQueries || 0) + (telemetry.visibilityDroneQueries || 0) + (telemetry.visibilityStationQueries || 0),
    candidates: (telemetry.visibilityShipCandidates || 0) + (telemetry.visibilityDroneCandidates || 0) + (telemetry.visibilityStationCandidates || 0),
    sourcesRecomputed: Math.max(0, (telemetry.visibilitySourcesUpdated || 0) - (telemetry.visibilityTransformOnlyUpdates || 0)),
    transformOnlyUpdates: telemetry.visibilityTransformOnlyUpdates || 0,
    teamCacheHits: telemetry.visibilityTeamCacheHits || 0,
    filterCacheHits: telemetry.visibilitySnapshotFilterCacheHits || 0,
    fallbackScans: telemetry.visibilityFullCollectionFallbacks || 0,
    sourceCountInitial,
    sourceCountFinal: runtime?.sourceByEntityId?.size || 0,
    finalVisibilityChecksum: checksum,
    informationLeakAudit
  };
}

function main() {
  const results = [];
  try {
    for (const scenario of SCENARIOS) results.push(runScenario(scenario));
    console.log(JSON.stringify({ mode: QUICK ? "quick" : "full", results }, null, 2));
  } finally {
    flags.__setOPTIMIZED_VISIBILITY_RUNTIME(false);
  }
}

main();
