"use strict";
const assert = require("assert");
const { validateClientMessage } = require("./src/server/clientSchemas");
const design=[{part:"core",x:0,y:0}];
const valid={
 ping:{type:'ping',at:1,clientPingNonce:'n'}, join:{type:'join',name:'A',room:'ABCD',protocolVersion:4,capabilities:['messagepack']}, requestFullState:{type:'requestFullState',epoch:1,sequence:1,reason:'client-request'}, deploy:{type:'deploy',design}, buyShip:{type:'buyShip',requestId:'r1',design,count:1}, setCombatStyle:{type:'setCombatStyle',combatStyle:'sentry',shipIds:[]}, setRallyPoint:{type:'setRallyPoint',x:1,y:2}, resetRallyPoint:{type:'resetRallyPoint'}, command:{type:'command',x:1,y:2,shipIds:[],formation:'line'}, destruct:{type:'destruct',shipIds:[]}, setTeam:{type:'setTeam',team:'blue'}, addBot:{type:'addBot'}, setRules:{type:'setRules',rules:{gameMode:'teams'}}, setName:{type:'setName',name:'Ace'}, startDesign:{type:'startDesign'}, kick:{type:'kick',targetId:'p1'}, restart:{type:'restart'}, returnToLobby:{type:'returnToLobby'}, restartLobby:{type:'restartLobby'}, closeLobby:{type:'closeLobby'}, leaveLobby:{type:'leaveLobby'}
};
for(const [type,msg] of Object.entries(valid)) assert.equal(validateClientMessage(msg).ok,true, `${type} valid minimum`);

assert.equal(validateClientMessage({...valid.join,room:''}).ok,true,'empty join room creates a new room');
assert.equal(validateClientMessage({...valid.join,room:'ROOM42'}).ok,true,'normal room code joins an existing room');
for (const room of ['   ','!!!']) {
  assert.equal(validateClientMessage({...valid.join,room}).code,'invalid-room',`invalid non-empty room rejected: ${JSON.stringify(room)}`);
}
assert.equal(validateClientMessage({...valid.join,room:'A'.repeat(65)}).code,'invalid-room','oversized room rejected');
assert.equal(validateClientMessage({type:'join',name:'A',protocolVersion:4,capabilities:['messagepack']}).code,'invalid-payload','join room remains required');
for(const type of ['buyShip','deploy']) assert.equal(validateClientMessage({type}).ok,false, `${type} requires payload`);
assert.equal(validateClientMessage({type:'command'}).ok,false);
assert.equal(validateClientMessage({type:'buyShip',requestId:'bad space',design}).code,'invalid-request');
assert.equal(validateClientMessage({type:'deploy',design:[{part:'x'.repeat(300)}]}).ok,false);
assert.equal(validateClientMessage({type:'command',x:Infinity,y:0}).ok,false);
assert.equal(validateClientMessage({type:'requestFullState',epoch:1.2}).code,'invalid-resync-request');
assert.equal(validateClientMessage({type:'setCombatStyle',combatStyle:'bogus'}).code,'invalid-combat-style');
let deep={type:'ping'}; let cur=deep; for(let i=0;i<12;i++){cur.next={}; cur=cur.next;} assert.equal(validateClientMessage(deep).ok,false);
console.log('Protocol schema verification passed');
