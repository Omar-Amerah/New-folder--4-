"use strict";
const assert = require("assert");
const { buildSharedSnapshot } = require("./src/server/snapshots");
const { spawnShip } = require("./src/server/ships");
const { computeStats } = require("./src/server/shipStats");

const design = [
  {x:3,y:3,type:"core"}, {x:2,y:3,type:"blaster"}, {x:4,y:3,type:"armor"},
  {x:3,y:2,type:"missile"}, {x:3,y:4,type:"engine"}, {x:4,y:4,type:"reactor"},
  {x:1,y:3,type:"railgun"}, {x:5,y:3,type:"repair"}, {x:3,y:5,type:"wingFrame",rotation:90}
];
function makeRoom() {
  const player = { id:"p1", name:"P", team:"blue", design, stats:computeStats(design), ships:[], shipCap:3, rallyPoint:null };
  return { code:"IDX", world:{width:4160,height:2560}, mapSeed:77, rules:{gameMode:"teams"}, map:{asteroids:[], relays:[]}, players:new Map([[player.id, player]]), ships:new Map(), bullets:[], effects:[], points:[], phase:"active", winner:null, controlVictory:{}, clients:new Set(), nextEntityId:1 };
}
(async () => {
  const merge = await import("./public/src/snapshotMerge.js");
  const room = makeRoom();
  const player = room.players.get("p1");
  const ship = spawnShip(room, player, 0, 0, { design, stats: player.stats });
  ship.weaponAngles = design.map((part, i) => ["blaster","missile","railgun"].includes(part.type) ? i / 10 : 0);
  const full = buildSharedSnapshot(room, 0, true).ships[0];
  assert.strictEqual(full.design.length, design.length);
  assert.strictEqual(full.chp.length, design.length);
  assert.strictEqual(full.componentHeat.length, design.length);
  assert.deepStrictEqual(full.design.map(p=>p.type), design.map(p=>p.type));
  ship.componentHp[1] -= 7; ship.dirtyComponents.add(1);
  ship.componentHp[2] = 0; ship.dirtyComponents.add(2);
  ship.componentHp[2] = ship.componentMaxHp[2]; ship.dirtyComponents.add(2);
  ship.componentHeat[3] = 42; ship.componentHeatState[3] = 2; ship.dirtyHeat.add(3);
  ship.componentHeat[7] = 5; ship.componentHeatState[7] = 1; ship.dirtyHeat.add(7);
  const dyn = buildSharedSnapshot(room, 1000, false).ships[0];
  assert(!dyn.design, "dynamic snapshot should not resend design");
  assert.deepStrictEqual(dyn.chpD.map((_,i,a)=> i%2===0 ? a[i] : undefined).filter(v=>v!==undefined).sort((a,b)=>a-b), [1,2]);
  const merged = merge.mergeCachedShipFields([full], [dyn])[0];
  assert.strictEqual(merged.design[1].type, "blaster");
  assert.strictEqual(merged.design[2].type, "armor");
  assert.strictEqual(merged.design[3].type, "missile");
  assert.strictEqual(merged.chp.length, design.length);
  assert.strictEqual(merged.componentHeat.length, design.length);
  assert.strictEqual(merged.componentHeat[3][0], 42);
  assert.strictEqual(merged.componentHeat[7][1], 1);
  const reconnected = merge.mergeCachedShipFields([merged], [buildSharedSnapshot(room, 1500, true).ships[0]])[0];
  assert.deepStrictEqual(reconnected.design.map(p=>p.type), design.map(p=>p.type));
  room.ships.delete(ship.id); player.ships = [];
  const replacement = spawnShip(room, player, 2000, 0, { design: [{x:3,y:3,type:"core"},{x:3,y:4,type:"engine"},{x:4,y:3,type:"reactor"}], stats: computeStats([{x:3,y:3,type:"core"},{x:3,y:4,type:"engine"},{x:4,y:3,type:"reactor"}]) });
  replacement.id = "replacement";
  const fresh = merge.mergeCachedShipFields([reconnected], [buildSharedSnapshot(room, 2000, true).ships.find(s=>s.id==="replacement")])[0];
  assert.strictEqual(fresh.design.length, 3, "removed ship cache must not be reused by new ship");
  console.log("Component index lifecycle verification passed");
})().catch((err)=>{ console.error(err); process.exit(1); });
