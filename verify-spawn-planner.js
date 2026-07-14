"use strict";
const assert = require("assert");
const { planSpawns } = require("./src/server/spawnPlanner");
const { WORLD_SIZES } = require("./src/server/config");

function room(players, mode="solo", extra={}) {
  return { world: extra.world || WORLD_SIZES[4], mapSeed: 123456, rules: { gameMode: mode }, map: extra.map || { asteroids: [], relays: [{ id:"A", x:(extra.world||WORLD_SIZES[4]).width/2, y:(extra.world||WORLD_SIZES[4]).height/2, radius:160 }] }, players: new Map(players.map(p => [p.id, { shipCap: 3, stats: { radius: 52 }, ...p }])) };
}
function assertPlan(r) {
  const plan = planSpawns(r);
  assert.strictEqual(plan.length, r.players.size);
  const seen = new Set();
  for (const s of plan) {
    assert(!seen.has(`${s.x},${s.y}`), "duplicate base spawn"); seen.add(`${s.x},${s.y}`);
    assert(s.x >= s.reservedRadius && s.x <= r.world.width - s.reservedRadius);
    assert(s.y >= s.reservedRadius && s.y <= r.world.height - s.reservedRadius);
    const p = r.players.get(s.playerId);
    if (r.rules.gameMode !== "solo" && p.team === "blue") assert(s.x <= r.world.width * 0.42);
    if (r.rules.gameMode !== "solo" && p.team === "red") assert(s.x >= r.world.width * 0.58);
    for (const a of r.map.asteroids || []) assert(Math.hypot(s.x-a.x, s.y-a.y) >= s.reservedRadius + a.radius + 24);
    for (const relay of r.map.relays || []) assert(Math.hypot(s.x-relay.x, s.y-relay.y) >= s.reservedRadius + relay.radius + 32);
  }
  for (let i=0;i<plan.length;i++) for (let j=i+1;j<plan.length;j++) assert(Math.hypot(plan[i].x-plan[j].x, plan[i].y-plan[j].y) >= plan[i].reservedRadius + plan[j].reservedRadius, "starter fleet reservations overlap");
  assert.deepStrictEqual(plan, planSpawns(r), "deterministic replay mismatch");
  return plan;
}
for (const n of [1,2,3,4,5,8,12]) assertPlan(room(Array.from({length:n}, (_,i)=>({id:`p${i+1}`, team:`p${i+1}`})), "solo"));
assertPlan(room([{id:"a", team:"blue"},{id:"b", team:"red"}], "teams"));
assertPlan(room(Array.from({length:8}, (_,i)=>({id:`p${i}`, team:i<4?"blue":"red"})), "teams"));
assertPlan(room(Array.from({length:8}, (_,i)=>({id:`p${i}`, team:i<7?"blue":"red"})), "teams"));
assertPlan(room(Array.from({length:12}, (_,i)=>({id:`p${i}`, team:i<10?"blue":"red"})), "teams"));
assertPlan(room([{id:"human", team:"blue"},{id:"bot1", team:"red", isBot:true},{id:"bot2", team:"red", isBot:true}], "teams"));
assertPlan(room(Array.from({length:4}, (_,i)=>({id:`big${i}`, team:`big${i}`, shipCap:30, stats:{radius:90}})), "solo"));
const obstructed = room([{id:"a", team:"blue"},{id:"b", team:"red"}], "teams");
obstructed.map.asteroids.push({x:170, y:obstructed.world.height/2, radius:300});
const op = assertPlan(obstructed);
assert(op.some(s => s.adjusted), "obstructed preferred position should be adjusted");
assert.throws(() => planSpawns(room([{id:"a", team:"blue"},{id:"b", team:"red"}], "teams", { world:{width:500,height:500,label:"Tiny"}, map:{asteroids:[{x:250,y:250,radius:500}], relays:[]} })), /Unable to plan legal spawn/);
console.log("Spawn planner verification passed");
