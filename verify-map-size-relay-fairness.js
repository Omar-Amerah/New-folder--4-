"use strict";

const assert = require("assert");
const {
  WORLD,
  WORLD_SIZES,
  ASTEROID_DENSITY,
  MAP_CLEARANCES,
  MAP_REFERENCE_AREA,
  resolveMapClearances
} = require("./src/server/config");
const {
  generateMap,
  chooseWorldSize,
  generateSafeZones,
  buildStructuredFallbackMap
} = require("./src/server/rooms");
const { planSpawnRegions } = require("./src/server/spawnPlanner");
const { validateGeneratedMap } = require("./src/server/mapValidation");
const {
  evaluateMapFairness,
  validateRelaySpawnGeometry,
  compactFairnessMetrics
} = require("./src/server/mapFairness");

const EXPECTED_WORLD_SIZES = [
  { maxPlayers: 0, width: 4000, height: 2500, label: "Testing" },
  { maxPlayers: 2, width: 5200, height: 3200, label: "Duel" },
  { maxPlayers: 4, width: 6400, height: 3800, label: "Skirmish" },
  { maxPlayers: 8, width: 8200, height: 4800, label: "Battle" },
  { maxPlayers: Infinity, width: 10000, height: 5800, label: "Grand battle" }
];

let generatedFallbackMaps = 0;

function assertGeneratedMap(map, world, mode, seed, options = {}) {
  const validation = validateGeneratedMap(map, world, { seed, mode });
  assert.strictEqual(validation.ok, true, `${world.label}/${mode}/${seed}: ${validation.errors.join("; ")}`);
  if (world.label !== "Testing") {
    const fairness = evaluateMapFairness(map, world, map.safeZones, { mode });
    assert.strictEqual(fairness.valid, true, `${world.label}/${mode}/${seed} fairness: ${fairness.reasons.map((reason) => reason.message).join("; ")}`);
    assert.ok(Number.isFinite(fairness.score), `${world.label}/${mode}/${seed} fairness score must be finite`);
    assert.deepStrictEqual(compactFairnessMetrics(fairness), map.generation.fairnessMetrics, `${world.label}/${mode}/${seed} compact fairness diagnostics drifted`);
  }
  assert.ok(map.relays.length >= 1 && map.relays.length <= 7, `${world.label}/${mode}/${seed}: relay count outside intended range`);
  const fallback = options.fallback || map.generation.fallbackUsed === true;
  if (map.generation.fallbackUsed === true && !options.fallback) generatedFallbackMaps += 1;
  assert.ok(map.generation.candidatesTested >= 1 && map.generation.candidatesTested <= 32, "candidate bound exceeded");
  if (!fallback) assert.ok(map.generation.candidatesPassed >= 1 && map.generation.candidatesPassed <= map.generation.candidatesTested, "candidate pass count invalid");
  assert.strictEqual(map.generation.areaScale, Math.round((world.width * world.height / MAP_REFERENCE_AREA) * 100) / 100, "area scale drifted");

  const geometryErrors = validateRelaySpawnGeometry(map.relays, map.safeZones, world, resolveMapClearances(world));
  assert.deepStrictEqual(geometryErrors, [], `${world.label}/${mode}/${seed}: spawn-relative relay violation`);
  for (const relay of map.relays) {
    assert.ok(relay.x - relay.radius >= 0 && relay.x + relay.radius <= world.width, "relay outside horizontal world bounds");
    assert.ok(relay.y - relay.radius >= 0 && relay.y + relay.radius <= world.height, "relay outside vertical world bounds");
  }
  for (let i = 0; i < map.relays.length; i += 1) {
    for (let j = i + 1; j < map.relays.length; j += 1) {
      const a = map.relays[i];
      const b = map.relays[j];
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius + resolveMapClearances(world).relayToRelay,
        `${a.id}/${b.id} relay spacing regressed`);
    }
  }
}

function makeSoloRoom(count, seed) {
  const world = chooseWorldSize(count);
  const players = Array.from({ length: count }, (_, index) => ({
    id: `solo-${index + 1}`,
    team: `solo-${index + 1}`,
    shipCap: 1,
    stats: { radius: 52, fleetCount: 1 }
  }));
  const room = {
    world,
    mapSeed: seed,
    rules: { gameMode: "solo", infrastructureMode: "stations" },
    map: { seed, name: "Planning", asteroids: [], relays: [], clouds: [], safeZones: [] },
    players: new Map(players.map((player) => [player.id, player]))
  };
  return { world, safeZones: planSpawnRegions(room).safeZones };
}

function testWorldSizes() {
  assert.deepStrictEqual(WORLD_SIZES, EXPECTED_WORLD_SIZES, "world labels, thresholds, or dimensions changed unexpectedly");
  const old = [
    [3200, 2000],
    [4160, 2560],
    [5120, 3040],
    [6560, 3840],
    [8000, 4640]
  ];
  for (let index = 0; index < WORLD_SIZES.length; index += 1) {
    assert.strictEqual(WORLD_SIZES[index].width, old[index][0] * 1.25, `${WORLD_SIZES[index].label} width is not exactly 1.25x`);
    assert.strictEqual(WORLD_SIZES[index].height, old[index][1] * 1.25, `${WORLD_SIZES[index].label} height is not exactly 1.25x`);
  }
  assert.deepStrictEqual(WORLD, { width: 6400, height: 3800 }, "default WORLD is not the enlarged Skirmish world");
  assert.deepStrictEqual([1, 2, 4, 8, 12].map((count) => chooseWorldSize(count).label), ["Duel", "Duel", "Skirmish", "Battle", "Grand battle"]);
}

function testRepresentativeMaps() {
  for (const world of WORLD_SIZES.slice(1)) {
    for (const mode of ["teams", "solo"]) {
      const first = generateMap("SIZE-FAIRNESS", world, mode, "medium", { seed: 0x12345678 });
      const second = generateMap("SIZE-FAIRNESS", world, mode, "medium", { seed: 0x12345678 });
      assert.deepStrictEqual(first, second, `${world.label}/${mode} is not deterministic`);
      assertGeneratedMap(first, world, mode, 0x12345678);
    }
  }
}

function testDensityBudgets() {
  const samples = [];
  for (const world of WORLD_SIZES.slice(1)) {
    const areaScale = world.width * world.height / MAP_REFERENCE_AREA;
    for (const density of ["low", "medium", "high", "veryHigh"]) {
      const map = generateMap("DENSITY", world, "teams", density, { seed: 1000 + samples.length });
      assertGeneratedMap(map, world, "teams", 1000 + samples.length);
      assert.ok(map.generation.requested.asteroids > 0, `${world.label}/${density} did not request terrain`);
      samples.push({ label: world.label, density, areaScale, requested: map.generation.requested.asteroids, placed: map.asteroids.length });
    }
  }
  const medium = samples.filter((sample) => sample.density === "medium");
  for (let index = 1; index < medium.length; index += 1) {
    assert.ok(medium[index].areaScale > medium[index - 1].areaScale, "map area ordering drifted");
  }
  assert.ok(samples.find((sample) => sample.density === "veryHigh").requested > samples.find((sample) => sample.density === "low").requested,
    "density choices collapsed after area scaling");
  assert.strictEqual(ASTEROID_DENSITY.none, 0, "none density changed");
  console.log("Density samples:", JSON.stringify(samples));
}

function testTeamSeedSweep() {
  const world = WORLD_SIZES.find((candidate) => candidate.label === "Grand battle");
  const start = process.hrtime.bigint();
  for (let seed = 0; seed < 10000; seed += 1) {
    const map = generateMap("TEAM-SWEEP", world, "teams", "none", { seed });
    assertGeneratedMap(map, world, "teams", seed);
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`Team fairness sweep: 10000 seeds, ${elapsedMs.toFixed(1)}ms, ${(elapsedMs / 10000).toFixed(3)}ms/map`);
}

function testSoloRosters() {
  for (const count of [2, 3, 4, 5, 6]) {
    for (let seed = 0; seed < 40; seed += 1) {
      const { world, safeZones } = makeSoloRoom(count, seed);
      const map = generateMap(`SOLO-${count}`, world, "solo", "none", { seed, safeZones });
      assert.strictEqual(map.safeZones.length, count, `solo ${count} did not use actual safe-zone count`);
      assertGeneratedMap(map, world, "solo", seed);
    }
  }
  console.log("Solo fairness passed for 2, 3, 4, 5, and 6-player rosters, including odd rosters.");
}

function testPathFairness() {
  const world = { width: 6400, height: 3800, label: "Fixture" };
  const safeZones = [
    { id: "blue", team: "blue", x: 600, y: 1900, radius: 250, color: "#fff" },
    { id: "red", team: "red", x: 5800, y: 1900, radius: 250, color: "#fff" }
  ];
  const relays = [
    { id: "A", x: 3200, y: 1100, radius: 100 },
    { id: "B", x: 3200, y: 2700, radius: 100 },
    { id: "C", x: 3200, y: 1900, radius: 100 }
  ];
  const symmetric = evaluateMapFairness({ relays, asteroids: [] }, world, safeZones, { mode: "teams", skipGeometry: true });
  assert.strictEqual(symmetric.valid, true, "symmetric open fixture should pass");
  const wallAsteroids = [];
  for (let x = 1400; x <= 2800; x += 180) wallAsteroids.push({ id: `wall-${x}`, x, y: 1900, radius: 130 });
  const asymmetric = evaluateMapFairness({ relays, asteroids: wallAsteroids }, world, safeZones, { mode: "teams", skipGeometry: true });
  assert.strictEqual(asymmetric.valid, false, "path-asymmetric wall should be rejected");
  assert.ok(asymmetric.reasons.some((reason) => reason.code === "team-nearest-imbalance" || reason.code === "team-two-nearest-imbalance"), "path wall did not affect fairness metrics");
}

function testAsymmetricTeamSpawns() {
  const world = WORLD_SIZES.find((candidate) => candidate.label === "Battle");
  const safeZones = [
    { id: "blue", team: "blue", x: 502, y: 2400, radius: 422, color: "#38d5ff" },
    { id: "red", team: "red", x: 7180, y: 2400, radius: 940, color: "#ff5f7e" }
  ];
  const map = generateMap("ASYMMETRIC-TEAM", world, "teams", "none", { seed: 1131418939, safeZones });
  assertGeneratedMap(map, world, "teams", 1131418939);
  assert.ok(map.relays.length >= 1, "asymmetric team spawn map lost all relays");
}

function testFallbackAndDiversity() {
  const world = WORLD_SIZES.find((candidate) => candidate.label === "Grand battle");
  const safeZones = generateSafeZones(world, "teams");
  const fallback = buildStructuredFallbackMap(7, world, "teams", safeZones, resolveMapClearances(world), 0, world.width * world.height / MAP_REFERENCE_AREA, {});
  assertGeneratedMap(fallback, world, "teams", 7, { fallback: true });
  assert.strictEqual(fallback.generation.fallbackUsed, true, "structured fallback was not marked");

  const normalizedLayouts = new Set();
  for (let seed = 0; seed < 100; seed += 1) {
    const map = generateMap("DIVERSITY", world, "teams", "none", { seed });
    const layout = map.relays
      .map((relay) => [relay.x / world.width, relay.y / world.height, relay.radius / Math.max(world.width, world.height)])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map((point) => point.map((value) => value.toFixed(4)).join(","))
      .join(";");
    normalizedLayouts.add(layout);
  }
  assert.ok(normalizedLayouts.size >= 90, `relay layout diversity collapsed to ${normalizedLayouts.size}/100`);
}

function testGenerationTiming() {
  const world = WORLD_SIZES.find((candidate) => candidate.label === "Grand battle");
  const timings = [];
  for (let seed = 0; seed < 100; seed += 1) {
    const start = process.hrtime.bigint();
    generateMap("TIMING", world, "teams", "none", { seed });
    timings.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const sorted = timings.slice().sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const median = percentile(0.5);
  const p95 = percentile(0.95);
  const maximum = sorted[sorted.length - 1];
  // The measured none-density room-setup path is normally single-digit ms on
  // this checkout.  250ms leaves room for a loaded CI worker without turning
  // an accidental unbounded retry into a passing test.
  assert.ok(maximum < 250, `generation max ${maximum.toFixed(1)}ms exceeded 250ms CI ceiling`);
  console.log(`Generation timing (100 Grand battle/team/none maps): median=${median.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${maximum.toFixed(2)}ms`);
}

testWorldSizes();
testRepresentativeMaps();
testDensityBudgets();
testPathFairness();
testAsymmetricTeamSpawns();
testFallbackAndDiversity();
testSoloRosters();
testGenerationTiming();
testTeamSeedSweep();
console.log(`Generated fallback maps encountered: ${generatedFallbackMaps}`);
console.log("Map size, spawn-relative relay, fairness, determinism, diversity, fallback, and timing checks passed");
