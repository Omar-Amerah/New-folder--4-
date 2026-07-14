"use strict";
const assert = require("assert");
const { createRoom } = require("./src/server/rooms");
const { addBot, updateBots } = require("./src/server/ships");
const { DEFAULT_DESIGN } = require("./src/server/config");
const { computeStats } = require("./src/server/shipStats");
const { buyShip } = require("./src/server/economy");
function human(id, team) { const design = DEFAULT_DESIGN.map(p => ({...p})); return { id, name:id, team, ready:true, design, stats:computeStats(design), ships:[], money:1000, spent:0, earned:1000, deployedFleetCost:0, destroyedEnemyCost:0, lostFleetCost:0, shipCap:8, maxMoney:10000, connected:true, client:{}, purchaseRequests:new Map() }; }
function setup(seed=12345) { const room=createRoom("BOT"); room.phase="active"; room.mapSeed=seed; room.players.clear(); room.ships.clear(); room.effects.length=0; room.points=[]; const h=human("h","blue"); room.players.set(h.id,h); addBot(room,h); const bot=[...room.players.values()].find(p=>p.isBot); bot.ready=true; bot.money=1000; bot.client={}; bot.shipCap=5; return {room,h,bot}; }
{
 const a=setup(777); const b=setup(777);
 buyShip(a.room,a.bot,0,{silent:true}); buyShip(b.room,b.bot,0,{silent:true});
 updateBots(a.room,1000); updateBots(b.room,1000);
 assert.strictEqual(a.bot.ai.nextThinkAt,b.bot.ai.nextThinkAt,"bot think interval deterministic for seed/player/sequence");
 assert.deepStrictEqual(a.bot.ships.map(s=>[Math.round(s.targetX),Math.round(s.targetY)]),b.bot.ships.map(s=>[Math.round(s.targetX),Math.round(s.targetY)]),"bot movement offsets deterministic");
}
{
 const {room,bot}=setup(888); bot.money=0; const before={ships:bot.ships.length,spent:bot.spent}; updateBots(room,1000); assert.strictEqual(bot.ships.length,before.ships,"failed bot purchase changes nothing"); assert.strictEqual(bot.spent,before.spent,"failed bot purchase preserves accounting");
 room.winner={team:"blue"}; const next=bot.ai.nextThinkAt; updateBots(room,next+1); assert.strictEqual(bot.ai.nextThinkAt,next,"bots stop after winner");
}
console.log("Deterministic bot safety checks passed; seeds: 777, 888");
