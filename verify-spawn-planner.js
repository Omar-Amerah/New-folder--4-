"use strict";
const assert = require("assert");
const { planSpawnRegions, getSpawnRegionPlan, invalidateSpawnPlan } = require("./src/server/spawnPlanner");
const { isInSafeZone } = require("./src/server/combat");
const { validateGeneratedMap } = require("./src/server/mapValidation");
const { WORLD_SIZES } = require("./src/server/config");

function room(players, mode = "solo", extra = {}) {
  const world = extra.world || WORLD_SIZES[4];
  return {
    world,
    mapSeed: extra.seed || 123456,
    rules: { gameMode: mode },
    map: extra.map || { seed: extra.seed || 123456, name: "test", asteroids: [], relays: [{ id: "A", x: world.width / 2, y: world.height / 2, radius: 160 }], clouds: [], safeZones: [] },
    players: new Map(players.map((p) => [p.id, { shipCap: 3, stats: { radius: 52, fleetCount: p.shipCap || 3 }, ...p }]))
  };
}
function assertPlan(r) {
  const plan = planSpawnRegions(r);
  r.map.safeZones = plan.safeZones;
  assert.strictEqual(plan.spawns.length, r.players.size);
  assert.deepStrictEqual(plan, planSpawnRegions(r), "deterministic replay mismatch");
  const seen = new Set();
  for (const s of plan.spawns) {
    assert(!seen.has(`${s.x},${s.y}`), "duplicate base spawn"); seen.add(`${s.x},${s.y}`);
    assert(s.x >= s.reservedRadius && s.x <= r.world.width - s.reservedRadius, "spawn x in bounds");
    assert(s.y >= s.reservedRadius && s.y <= r.world.height - s.reservedRadius, "spawn y in bounds");
    const p = r.players.get(s.playerId);
    const zone = plan.safeZones.find((z) => z.spawnPlayerIds.includes(s.playerId));
    assert(zone, `matching safe zone exists for ${s.playerId}`);
    assert(Math.hypot(s.x - zone.x, s.y - zone.y) + s.reservedRadius <= zone.radius + 0.01, "reservation fits safe zone");
    assert(isInSafeZone(r, s.x, s.y, p), "combat policy protects owner/team spawn");
    if (r.rules.gameMode === "solo") assert.strictEqual(zone.ownerId, s.playerId, "solo zone owner");
    else assert.strictEqual(zone.team, p.team, "team zone owner");
    assert(zone.x - zone.radius >= 0 && zone.x + zone.radius <= r.world.width && zone.y - zone.radius >= 0 && zone.y + zone.radius <= r.world.height, "zone in bounds");
    for (const a of r.map.asteroids || []) assert(Math.hypot(s.x - a.x, s.y - a.y) >= s.reservedRadius + a.radius + 24, "spawn avoids asteroid");
    for (const relay of r.map.relays || []) assert(Math.hypot(zone.x - relay.x, zone.y - relay.y) >= zone.radius + relay.radius, "zone avoids relay");
    const enemy = [...r.players.values()].find((q) => q.id !== p.id && q.team !== p.team) || null;
    if (enemy) assert(!isInSafeZone(r, s.x, s.y, enemy), "enemy does not receive foreign spawn protection");
  }
  for (let i = 0; i < plan.spawns.length; i++) for (let j = i + 1; j < plan.spawns.length; j++) assert(Math.hypot(plan.spawns[i].x - plan.spawns[j].x, plan.spawns[i].y - plan.spawns[j].y) >= plan.spawns[i].reservedRadius + plan.spawns[j].reservedRadius, "starter fleet reservations overlap");
  const validation = validateGeneratedMap(r.map, r.world, { seed: r.mapSeed });
  assert(validation.ok, validation.errors.join("; "));
  return plan;
}
for (const n of [1, 2, 3, 4, 5, 8, 12]) assertPlan(room(Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, team: `p${i + 1}` })), "solo"));
assertPlan(room([{ id: "a", team: "blue" }, { id: "b", team: "red" }], "teams"));
assertPlan(room(Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, team: i < 4 ? "blue" : "red" })), "teams"));
assertPlan(room(Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, team: i < 7 ? "blue" : "red" })), "teams"));
assertPlan(room(Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, team: i < 10 ? "blue" : "red" })), "teams"));
assertPlan(room([{ id: "human", team: "blue" }, { id: "bot1", team: "red", isBot: true }, { id: "bot2", team: "red", isBot: true }], "teams"));
assertPlan(room(Array.from({ length: 4 }, (_, i) => ({ id: `big${i}`, team: `big${i}`, shipCap: 30, stats: { radius: 90, fleetCount: 30 } })), "solo"));
const obstructed = room([{ id: "a", team: "blue" }, { id: "b", team: "red" }], "teams");
obstructed.map.asteroids.push({ id: "block-blue", x: 230, y: obstructed.world.height / 2, radius: 80 });
assert(assertPlan(obstructed).spawns.some((s) => s.adjusted), "obstructed preferred position should be adjusted");
const policy = room([{ id: "blue1", team: "blue" }, { id: "blue2", team: "blue" }, { id: "red1", team: "red" }], "teams");
const pp = assertPlan(policy); const blueZone = pp.safeZones.find((z) => z.team === "blue"); const redZone = pp.safeZones.find((z) => z.team === "red");
assert(isInSafeZone(policy, blueZone.x, blueZone.y, policy.players.get("blue1")), "blue in blue zone");
assert(isInSafeZone(policy, blueZone.x, blueZone.y, policy.players.get("blue2")), "blue ally in blue zone");
assert(!isInSafeZone(policy, blueZone.x, blueZone.y, policy.players.get("red1")), "red in blue zone denied");
assert(isInSafeZone(policy, redZone.x, redZone.y, policy.players.get("red1")), "red zone symmetric");
const soloPolicy = room(Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, team: `s${i}` })), "solo");
const sp = assertPlan(soloPolicy); const z0 = sp.safeZones[0];
assert(isInSafeZone(soloPolicy, z0.x, z0.y, soloPolicy.players.get(z0.ownerId)), "solo owner protected");
assert(!isInSafeZone(soloPolicy, z0.x, z0.y, [...soloPolicy.players.values()].find((p) => p.id !== z0.ownerId)), "solo foreign player denied");
const cached = room([{ id: "a", team: "blue" }, { id: "b", team: "red" }], "teams"); getSpawnRegionPlan(cached); const oldKey = cached.__spawnPlanKey; cached.players.set("c", { id: "c", team: "blue", shipCap: 3, stats: { radius: 52, fleetCount: 3 } }); invalidateSpawnPlan(cached); getSpawnRegionPlan(cached); assert.notStrictEqual(cached.__spawnPlanKey, oldKey, "layout changes invalidate cached plan");
assert.throws(() => planSpawnRegions(room([{ id: "a", team: "blue" }, { id: "b", team: "red" }], "teams", { world: { width: 500, height: 500, label: "Tiny" }, map: { seed: 1, name: "bad", asteroids: [{ x: 250, y: 250, radius: 500 }], relays: [], clouds: [], safeZones: [] } })), /Unable to plan legal spawn/);
console.log("Spawn planner and safe-zone verification passed");
