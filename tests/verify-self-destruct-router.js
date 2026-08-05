"use strict";

const assert = require("assert");
const { createRoom } = require("./src/server/rooms");
const { computeStats } = require("./src/server/shipStats");
const { DEFAULT_DESIGN } = require("./src/server/config");
const { spawnShip } = require("./src/server/ships");
const { handleMessage } = require("./src/server/messageRouter");
const { updateSelfDestructingShips, updateDestroyedShips } = require("./src/server/combat");

function player(id, team) {
  const design=DEFAULT_DESIGN.map(part=>({...part}));
  return {id,name:id,team,ready:true,design,stats:computeStats(design),ships:[],shipCap:10,money:1000,spent:0,deployedFleetCost:0,losses:0,lostFleetCost:0};
}
const room=createRoom("BOOM"); room.phase="active"; room.players.clear(); room.ships.clear(); room.effects.length=0; room.nextEntityId=1;
const owner=player("owner","blue"), enemy=player("enemy","red"); room.players.set(owner.id,owner); room.players.set(enemy.id,enemy);
const selected=spawnShip(room,owner,0,0), unselected=spawnShip(room,owner,0,1), hostile=spawnShip(room,enemy,0,0);
const socket={destroyed:false,write(){return true;},once(){},off(){},destroy(){this.destroyed=true;}};
const client={id:"client",socket,isClosed:false,snapshotBaseline:{},room,player:owner,attachmentId:1}; owner.client=client; owner.attachmentId=1; room.clients.add(client);

handleMessage(client,{type:"destruct",shipIds:[selected.id,hostile.id]});
assert.equal(selected.selfDestructAt>0,true,"selected owned ship is armed through the router");
assert.equal(Boolean(unselected.selfDestructAt),false,"unselected owned ship is unaffected");
assert.equal(Boolean(hostile.selfDestructAt),false,"enemy selection is rejected authoritatively");
const detonationAt=selected.selfDestructAt; updateSelfDestructingShips(room,detonationAt);
assert.equal(selected.alive,false,"selected ship dies after the existing charge");
assert(selected.componentHp.every(hp=>hp===0),"normal teardown zeroes component HP");
assert.equal(owner.losses,1,"self-destruct records one loss"); updateSelfDestructingShips(room,detonationAt+1); assert.equal(owner.losses,1,"loss is recorded exactly once");
assert.equal(room.ships.has(selected.id),true,"wreck remains for its removal timer"); updateDestroyedShips(room,selected.removeAt); assert.equal(room.ships.has(selected.id),false,"wreck is removed on the existing timer");
assert.equal(unselected.alive,true); assert.equal(hostile.alive,true);
console.log("Self-destruct message-router integration verification passed");
