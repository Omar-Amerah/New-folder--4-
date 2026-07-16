"use strict";
const assert = require("assert");
const { createRoom } = require("./src/server/rooms");
const { addBot, updateBots, chooseBotDesign } = require("./src/server/ships");
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

{
 const {room,bot}=setup(999);
 assert.deepStrictEqual(bot.design, DEFAULT_DESIGN.map(p => ({...p})), "addBot assigns the stock default blueprint");
 assert.deepStrictEqual(computeStats(bot.design), computeStats(DEFAULT_DESIGN), "bot design statistics match DEFAULT_DESIGN statistics");
 const startingMoney = bot.money = 700;
 const bought = buyShip(room, bot, 0, { silent: true });
 assert(bought && bought.ownerId === bot.id, "bot starter purchasing succeeds");
 assert.strictEqual(bot.spent, bot.stats.unitCost, "bot purchase deducts the stock unit cost");
 assert.strictEqual(bot.money, startingMoney - bot.stats.unitCost, "bot starter purchase leaves the correct balance");
 const a = chooseBotDesign();
 const b = chooseBotDesign();
 a[0].x = 99;
 assert.notStrictEqual(b[0].x, 99, "two bots receive independent cloned designs");
 assert.notStrictEqual(DEFAULT_DESIGN[0].x, 99, "bot design mutation cannot mutate DEFAULT_DESIGN");
}

console.log("Deterministic bot safety checks passed; seeds: 777, 888, 999");
