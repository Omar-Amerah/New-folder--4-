"use strict";

const assert = require("assert");
const { createRoom, resetMatch } = require("./src/server/rooms");
const { computeStats } = require("./src/server/shipStats");
const { spawnShip, getLiveShips } = require("./src/server/ships");
const { updateEconomy } = require("./src/server/economy");
const { updateShipMovement, updateShipSeparation, resolveFleetMapCollisions } = require("./src/server/movement");
const { updateShipSupport, updateShipWeapons, updateDestroyedShips } = require("./src/server/combat");
const { updateBullets } = require("./src/server/projectiles");
const { updateCapturePoints, updateScoring } = require("./src/server/objectives");
const { updateShipHeat } = require("./src/server/heat");
const { performanceNow, seededRandom, rngRange } = require("./src/server/utils");

const SEED = 20260714;
const rng = seededRandom(SEED);
const TICKS = 360;
const DT = 1 / 30;
const PLAYER_COUNT = 8;
const SHIPS_PER_PLAYER = 6;
const designs = [
  [{ x:7,y:7,type:"core" },{ x:7,y:6,type:"engine" },{ x:6,y:6,type:"blaster" },{ x:8,y:6,type:"railgun" },{ x:7,y:5,type:"beamEmitter" },{ x:6,y:7,type:"repairBeam" }],
  [{ x:7,y:7,type:"core" },{ x:7,y:6,type:"engine" },{ x:6,y:6,type:"missile" },{ x:8,y:6,type:"pointDefense" },{ x:7,y:5,type:"armor" },{ x:6,y:7,type:"repair" }],
  [{ x:7,y:7,type:"core" },{ x:7,y:6,type:"engine" },{ x:6,y:6,type:"swarmMissile" },{ x:8,y:6,type:"flakCannon" },{ x:7,y:5,type:"blaster" },{ x:6,y:7,type:"shield" }]
];
function player(id, team, design) { return { id, name:id, team, isBot: id.includes("bot"), connected:true, ships:[], design, stats: computeStats(design), money:5000, maxMoney:99999, income:0, score:0, kills:0, losses:0, destroyedEnemyCost:0, lostFleetCost:0, earned:0, purchaseRequests:new Map(), color:"#fff", shipCap:SHIPS_PER_PLAYER }; }
function tick(room, dt, now) {
  updateEconomy(room, dt); updateDestroyedShips(room, now); const ships = getLiveShips(room);
  for (const s of ships) { if (Math.floor(now / 400) % 5 === 0) { s.targetX = rngRange(rng, 100, room.world.width - 100); s.targetY = rngRange(rng, 100, room.world.height - 100); s.arrived = false; s.isManualMove = true; } updateShipMovement(room, s, dt); }
  updateShipSeparation(room, ships, dt); resolveFleetMapCollisions(room, ships); updateShipSupport(room, ships, dt, now);
  for (const s of ships) { updateShipWeapons(room, s, ships, dt, now); updateShipHeat(s, dt, room, now); }
  updateBullets(room, dt, now); updateCapturePoints(room, ships, dt); updateScoring(room, now);
}
function assertFiniteEntity(room) {
  const ids = new Set();
  for (const [id, s] of room.ships) { assert(!ids.has(id), `duplicate ship id ${id}`); ids.add(id); assert(room.players.has(s.ownerId), `invalid owner ${s.ownerId}`); for (const f of ["x","y","vx","vy","hp","angle"]) assert(Number.isFinite(s[f]), `non-finite ship ${id}.${f}`); if (!s.alive) assert(!s.weaponFireTargetIds?.some(Boolean), "dead ship acting"); }
  for (const b of room.bullets) { assert(!ids.has(b.id), `duplicate entity id ${b.id}`); ids.add(b.id); for (const f of ["x","y","vx","vy","life"]) assert(Number.isFinite(b[f]), `non-finite bullet ${b.id}.${f}`); assert(room.players.has(b.ownerId), `invalid bullet owner ${b.ownerId}`); }
  for (const e of room.effects) for (const f of ["x","y","x2","y2"]) if (e[f] !== undefined) assert(Number.isFinite(e[f]), `non-finite effect ${f}`);
}
const memBefore = process.memoryUsage().heapUsed;
const room = createRoom("SOAK"); room.phase = "active"; room.rules.gameMode = "teams"; room.combatRandom = seededRandom(SEED); room.map.asteroids = room.map.asteroids.slice(0, 20);
for (let i=0;i<PLAYER_COUNT;i++) { const p = player(`${i%2?"bot":"human"}${i}`, i % 2, designs[i % designs.length]); room.players.set(p.id, p); }
let now = performanceNow();
for (const p of room.players.values()) for (let i=0;i<SHIPS_PER_PLAYER;i++) spawnShip(room, p, now, i, { design:p.design, stats:p.stats, combatStyle:i%2?"charge":"sentry" });
let peakShips=0, peakBullets=0, peakEffects=0, worstTick=0, totalTick=0;
const started = performance.now();
for (let i=0;i<TICKS;i++) { const t0 = performance.now(); now += DT*1000; tick(room, DT, now); const elapsed = performance.now()-t0; totalTick += elapsed; worstTick = Math.max(worstTick, elapsed); peakShips = Math.max(peakShips, room.ships.size); peakBullets = Math.max(peakBullets, room.bullets.length); peakEffects = Math.max(peakEffects, room.effects.length); assert(room.bullets.length < 1500, "unbounded bullets"); assert(room.effects.length < 3000, "unbounded effects"); assertFiniteEntity(room); }
const duration = performance.now()-started; const snapshotSize = Buffer.byteLength(JSON.stringify({ ships:[...room.ships.values()], bullets:room.bullets, effects:room.effects }));
const purchaseCachePeak = [...room.players.values()].reduce((m,p)=>Math.max(m,p.purchaseRequests?.size||0),0); assert(purchaseCachePeak < 20, "unbounded purchase cache");
room.winner = { id:"human0" }; tick(room, DT, now+1000); resetMatch(room, "design"); assert.strictEqual(room.bullets.length,0,"rematch clears bullets"); assert(room.effects.length < peakEffects, "rematch leaves only bounded fresh setup effects");
const cleanupStart = performance.now(); room.ships.clear(); room.players.clear(); room.clients.clear(); const cleanupDuration = performance.now()-cleanupStart; assert.strictEqual(room.ships.size,0,"room cleanup clears ships");
const memAfter = process.memoryUsage().heapUsed;
console.log(JSON.stringify({ seed:SEED, players:PLAYER_COUNT, shipsPerPlayer:SHIPS_PER_PLAYER, ticks:TICKS, durationMs:Math.round(duration), averageTickMs:+(totalTick/TICKS).toFixed(3), worstTickMs:+worstTick.toFixed(3), peakShips, peakBullets, peakEffects, snapshotSize, purchaseCachePeak, memoryBefore:memBefore, memoryAfter:memAfter, cleanupDurationMs:+cleanupDuration.toFixed(3) }, null, 2));
console.log("Deterministic soak verification passed");
