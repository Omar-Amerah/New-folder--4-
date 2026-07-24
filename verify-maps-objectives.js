"use strict";

const assert = require("assert");
const { WORLD_SIZES, ASTEROID_DENSITY, SCORE_PER_CONTROLLED_POINT } = require("./src/server/config");
const { generateMap, chooseWorldSize } = require("./src/server/rooms");
const { validateGeneratedMap } = require("./src/server/mapValidation");
const { updateCapturePoints, updateScoring, getTeamWithFullControl, getPlayerWithFullControl, sideScore } = require("./src/server/objectives");

function assertMap(seed, world, mode, density) {
  const input = { seed, world: world.label, mode, density };
  let first;
  let second;
  try {
    first = generateMap("TEST", world, mode, density, { seed });
    second = generateMap("TEST", world, mode, density, { seed });
  } catch (error) {
    error.message = `map generation failed ${JSON.stringify(input)}: ${error.message}`;
    throw error;
  }
  assert.deepStrictEqual(first, second, `map generation is not deterministic ${JSON.stringify(input)}`);
  const validation = validateGeneratedMap(first, world, { seed });
  assert.strictEqual(validation.ok, true, `invalid map ${JSON.stringify(input)}: ${validation.errors.join("; ")}`);
  assertAsteroidClearance(first, input);
  assert.strictEqual(first.seed, seed >>> 0, `seed was not preserved ${JSON.stringify(input)}`);
  if (density === "none") assert.strictEqual(first.asteroids.length, 0, `none density created asteroids ${JSON.stringify(input)}`);
  return first;
}

function assertAsteroidClearance(map, input) {
  for (let i = 0; i < map.asteroids.length; i += 1) {
    const a = map.asteroids[i];
    for (let j = i + 1; j < map.asteroids.length; j += 1) {
      const b = map.asteroids[j];
      assert.ok(
        Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius + 220,
        `asteroid ${a.id} overlaps asteroid ${b.id} after rounding ${JSON.stringify(input)}`
      );
    }
  }
}

function testDeterministicMapRegressionSeeds() {
  const world = WORLD_SIZES.find((candidate) => candidate.label === "Duel");
  for (const seed of [2204914662, 105750278, 2591174599]) {
    assertMap(seed, world, "teams", "high");
  }
}

function testRoundedRelayClearanceRegression() {
  const seed = 2591174599;
  const world = WORLD_SIZES.find((candidate) => candidate.label === "Duel");
  const first = assertMap(seed, world, "teams", "high");
  const second = generateMap("TEST", world, "teams", "high", { seed });
  assert.deepStrictEqual(first.relays, second.relays, "relay placement changed for the same seed");
  for (const relay of first.relays) {
    assert(Number.isInteger(relay.x) && Number.isInteger(relay.y) && Number.isInteger(relay.radius),
      `relay ${relay.id} was not stored with rounded geometry`);
    for (const [index, zone] of first.safeZones.entries()) {
      assert(Math.hypot(relay.x - zone.x, relay.y - zone.y) >= relay.radius + zone.radius + 500,
        `relay ${relay.id} overlaps safe zone ${index} after rounding`);
    }
  }
}

function testDeterministicMapSeedSweep() {
  const worlds = WORLD_SIZES.filter((world) => world.label === "Grand battle");
  const modes = ["teams"];
  const densities = Object.keys(ASTEROID_DENSITY).filter((density) => density !== "none");
  const combinations = worlds.flatMap((world) => modes.flatMap((mode) => densities.map((density) => ({ world, mode, density }))));
  const seedCount = 10000;
  for (let index = 0; index < seedCount; index += 1) {
    const { world, mode, density } = combinations[index % combinations.length];
    const seed = index >>> 0;
    assertMap(seed, world, mode, density);
  }
}

function testMapInvariants() {
  const seeds = [0, 1, 7, 42, 12345, 0xdeadbeef, 0xffffffff];
  for (const world of WORLD_SIZES) {
    for (const mode of ["teams", "solo"]) {
      for (const density of Object.keys(ASTEROID_DENSITY)) {
        for (const seed of seeds) assertMap(seed, world, mode, density);
      }
    }
  }
  assert.deepStrictEqual(chooseWorldSize(1).label, "Duel");
  assert.deepStrictEqual(chooseWorldSize(4).label, "Skirmish");
  assert.deepStrictEqual(chooseWorldSize(12).label, "Grand battle");
}

function makeRoom(mode = "teams") {
  const players = new Map([
    ["p1", { id: "p1", name: "One", team: mode === "solo" ? "p1" : "blue", captures: 0, score: 0, money: 0, earned: 0, maxMoney: 9999, ready: true, ships: [] }],
    ["p2", { id: "p2", name: "Two", team: mode === "solo" ? "p2" : "red", captures: 0, score: 0, money: 0, earned: 0, maxMoney: 9999, ready: true, ships: [] }]
  ]);
  return {
    code: "TEST",
    clients: new Set(),
    phase: "active",
    rules: { gameMode: mode },
    players,
    points: [{ id: "A", x: 100, y: 100, radius: 80, ownerId: null, ownerTeam: null, progress: 0, contested: false }],
    winner: null,
    winnerAt: 0,
    controlVictory: { team: null, playerId: null, startedAt: null, remaining: null, requiredSeconds: 20 },
    lastScoreAt: 0,
    maxScore: 900
  };
}

function testObjectives() {
  let room = makeRoom("teams");
  updateCapturePoints(room, [{ x: 100, y: 100, ownerId: "p1", alive: true, stats: {}, design: [] }], 10);
  assert.strictEqual(room.points[0].ownerTeam, "blue", "team capture should set ownerTeam");
  assert.strictEqual(room.points[0].ownerId, "p1", "team capture should keep credit ownerId");
  assert.strictEqual(room.players.get("p1").captures, 1, "capture credit once to capturing team member");
  // Objective score now belongs to the team, not to individual players, so a
  // larger team cannot earn it faster. Personal player.score carries only
  // personal combat score (none here).
  assert.strictEqual(room.players.get("p1").score, 0, "team objective score does not land on personal player.score");
  assert.strictEqual(sideScore(room, "blue"), 14, "capture score accrues once to the team");
  room.points[0].progress = 1;
  room.lastScoreAt = 0;
  updateScoring(room, 1000);
  assert.strictEqual(sideScore(room, "blue"), 14 + SCORE_PER_CONTROLLED_POINT, "controlled relay score should accrue to owning team");
  assert.strictEqual(getTeamWithFullControl(room), "blue", "full team control should be detected");

  room = makeRoom("teams");
  updateCapturePoints(room, [
    { x: 100, y: 100, ownerId: "p1", alive: true, stats: {}, design: [] },
    { x: 100, y: 100, ownerId: "p2", alive: true, stats: {}, design: [] }
  ], 10);
  assert.strictEqual(room.points[0].contested, true, "equal enemies should contest relay");
  assert.strictEqual(room.points[0].ownerTeam, null, "contested neutral relay should not change owner");

  room = makeRoom("solo");
  updateCapturePoints(room, [{ x: 100, y: 100, ownerId: "p1", alive: true, stats: {}, design: [] }], 10);
  assert.strictEqual(room.points[0].ownerTeam, "p1", "solo ownerTeam stores player ownership key for compatibility");
  assert.strictEqual(room.points[0].ownerId, "p1", "solo capture should set ownerId to player");
  room.points[0].progress = 1;
  assert.strictEqual(getPlayerWithFullControl(room), "p1", "solo full control should use player id");
}

testMapInvariants();
testDeterministicMapRegressionSeeds();
testRoundedRelayClearanceRegression();
testDeterministicMapSeedSweep();
testObjectives();
console.log("Map generation and objective invariant checks passed");
