#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { RoomSpatialIndex } = require("../src/server/spatialIndex");
const { filterSnapshotForPlayer } = require("../src/server/visibilitySnapshots");
const { ensureTeamVisibility, invalidateVisibility } = require("../src/server/visibility");
const { homeStationTemplate, relayStationTemplate } = require("../src/server/stations");

function percentile(values, ratio) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] || 0;
}

function fixture() {
  const players = new Map();
  const viewers = [];
  for (let index = 0; index < 16; index += 1) {
    const player = {
      id: `player-${index}`,
      team: index < 8 ? "blue" : "red"
    };
    players.set(player.id, player);
    viewers.push(player);
  }

  const ships = new Map();
  for (let index = 0; index < 80; index += 1) {
    const team = index < 40 ? "blue" : "red";
    const ownerId = team === "blue" ? "player-0" : "player-8";
    const ship = {
      id: `ship-${index}`,
      type: "ship",
      entityType: "ship",
      ownerId,
      team,
      alive: true,
      hp: 100,
      x: 300 + (index % 10) * 540,
      y: 300 + Math.floor(index / 10) * 540,
      radius: 28,
      stats: { massClass: "medium" },
      design: []
    };
    ships.set(ship.id, ship);
  }

  const drones = new Map();
  for (let index = 0; index < 240; index += 1) {
    const team = index < 120 ? "blue" : "red";
    const drone = {
      id: `drone-${index}`,
      type: "drone",
      entityType: "drone",
      ownerId: team === "blue" ? "player-0" : "player-8",
      team,
      x: 200 + (index % 20) * 275,
      y: 200 + Math.floor(index / 20) * 360,
      radius: 10
    };
    drones.set(drone.id, drone);
  }

  const bullets = Array.from({ length: 900 }, (_, index) => ({
    id: `bullet-${index}`,
    ownerId: index % 2 === 0 ? "player-0" : "player-8",
    x: 100 + ((index * 977) % 5600),
    y: 100 + ((index * 1597) % 4400)
  }));
  const effects = Array.from({ length: 180 }, (_, index) => ({
    id: `effect-${index}`,
    x: 100 + ((index * 431) % 5600),
    y: 100 + ((index * 719) % 4400)
  }));
  const decoys = new Map();
  for (let index = 0; index < 120; index += 1) {
    const decoy = {
      id: `decoy-${index}`,
      ownerId: index % 2 === 0 ? "player-0" : "player-8",
      x: 100 + ((index * 613) % 5600),
      y: 100 + ((index * 887) % 4400),
      radius: 8
    };
    decoys.set(decoy.id, decoy);
  }

  const stations = Array.from({ length: 15 }, (_, index) => {
    const stationType = index < 8 ? "home" : "relay";
    const template = stationType === "home" ? homeStationTemplate : relayStationTemplate;
    const design = template.design;
    return {
      id: `station-${index}`,
      entityType: "station",
      stationType,
      team: stationType === "home" ? (index < 4 ? "blue" : "red") : null,
      ownerId: null,
      state: stationType === "home" ? "operational" : "neutral",
      alive: true,
      hp: template.stats.maxHp,
      maxHp: template.stats.maxHp,
      shield: 0,
      maxShield: 0,
      x: 500 + (index % 5) * 1200,
      y: 500 + Math.floor(index / 5) * 1700,
      angle: 0,
      radius: stationType === "home" ? 360 : 180,
      moduleScale: stationType === "home" ? 56 : 20,
      design,
      hardpoints: new Array(design.length).fill(null),
      weaponAngles: new Array(design.length).fill(0),
      componentHp: design.map(() => 100),
      productionQueue: [],
      revision: 1,
      healthRevision: 1
    };
  });

  const room = {
    rules: { visibilityMode: "sensors", infrastructureMode: "stations" },
    players,
    ships,
    drones,
    decoys,
    bullets,
    effects,
    stations,
    stationsById: new Map(stations.map((station) => [station.id, station])),
    points: [],
    map: { revision: 1, asteroidRevision: 1, asteroids: [] },
    spatialIndex: new RoomSpatialIndex(320)
  };
  room.spatialIndex.rebuild(room, [...ships.values()], 1);

  const snapshot = {
    ships: [...ships.values()].map(({ id }) => ({ id })),
    drones: [...drones.values()].map(({ id, ownerId, team, x, y, radius }) => ({ id, ownerId, team, x, y, radius })),
    decoys: [...decoys.values()].map((entry) => ({ ...entry })),
    bullets: bullets.map((entry) => ({ ...entry })),
    effects: effects.map((entry) => ({ ...entry })),
    stations: stations.map((station) => ({
      id: station.id,
      stationType: station.stationType,
      team: station.team,
      ownerId: station.ownerId,
      state: station.state,
      x: station.x,
      y: station.y,
      angle: station.angle,
      radius: station.radius,
      moduleScale: station.moduleScale,
      design: station.design,
      hardpoints: station.hardpoints,
      weaponAngles: station.weaponAngles,
      componentHp: station.componentHp,
      productionQueue: station.productionQueue,
      revision: station.revision,
      healthRevision: station.healthRevision
    }))
  };
  return { room, snapshot, viewers };
}

function runFogPass(room, snapshot, viewers, now) {
  const visibilityStartedAt = performance.now();
  invalidateVisibility(room, "benchmark-frame");
  ensureTeamVisibility(room, "blue", now);
  ensureTeamVisibility(room, "red", now);
  const visibilityMs = performance.now() - visibilityStartedAt;
  const filteringStartedAt = performance.now();
  let checksum = 0;
  for (const viewer of viewers) {
    const filtered = filterSnapshotForPlayer(room, viewer, snapshot, now);
    checksum += filtered.ships.length
      + filtered.drones.length
      + filtered.decoys.length
      + filtered.bullets.length
      + filtered.effects.length
      + filtered.stations.length;
  }
  return {
    checksum,
    visibilityMs,
    filteringMs: performance.now() - filteringStartedAt
  };
}

const { room, snapshot, viewers } = fixture();
for (let index = 0; index < 5; index += 1) runFogPass(room, snapshot, viewers, index);
const computesBeforeMeasurement = room._visibilityComputeCount || 0;
const filterBuildsBeforeMeasurement = room._visibilitySnapshotFilterBuilds || 0;
const filterHitsBeforeMeasurement = room._visibilitySnapshotFilterCacheHits || 0;

const samples = [];
const visibilitySamples = [];
const filteringSamples = [];
let checksum = 0;
for (let index = 0; index < 30; index += 1) {
  const startedAt = performance.now();
  const sample = runFogPass(room, snapshot, viewers, index + 100);
  checksum += sample.checksum;
  visibilitySamples.push(sample.visibilityMs);
  filteringSamples.push(sample.filteringMs);
  samples.push(performance.now() - startedAt);
}

const result = {
  fixture: {
    viewers: viewers.length,
    teams: 2,
    ships: snapshot.ships.length,
    drones: snapshot.drones.length,
    decoys: snapshot.decoys.length,
    bullets: snapshot.bullets.length,
    effects: snapshot.effects.length,
    stations: snapshot.stations.length
  },
  averageMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  p50Ms: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  visibilityP50Ms: percentile(visibilitySamples, 0.5),
  filteringP50Ms: percentile(filteringSamples, 0.5),
  visibilityComputes: (room._visibilityComputeCount || 0) - computesBeforeMeasurement,
  teamFilterBuilds: (room._visibilitySnapshotFilterBuilds || 0) - filterBuildsBeforeMeasurement,
  teamFilterCacheHits: (room._visibilitySnapshotFilterCacheHits || 0) - filterHitsBeforeMeasurement,
  checksum
};

assert.ok(checksum > 0);
assert.equal(result.visibilityComputes, 60, "visibility computes once per team per measured frame");
assert.equal(result.teamFilterBuilds, 60, "shared tactical arrays build once per team per measured frame");
assert.equal(result.teamFilterCacheHits, 420, "remaining teammates reuse the team tactical arrays");
console.log(JSON.stringify(result, null, 2));
