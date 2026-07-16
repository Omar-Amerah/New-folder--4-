"use strict";
const assert = require("assert");
const { validateClientMessage } = require("./src/server/clientSchemas");
const design=[{part:"core",x:0,y:0}];
const valid={
 ping:{type:'ping',at:1,clientPingNonce:'n'}, join:{type:'join',name:'A',room:'ABCD',protocolVersion:4,capabilities:['messagepack']}, requestFullState:{type:'requestFullState',epoch:1,sequence:1,reason:'client-request'}, deploy:{type:'deploy',design}, buyShip:{type:'buyShip',requestId:'r1',design,count:1}, setCombatStyle:{type:'setCombatStyle',combatStyle:'sentry',shipIds:[]}, setRallyPoint:{type:'setRallyPoint',x:1,y:2}, resetRallyPoint:{type:'resetRallyPoint'}, command:{type:'command',x:1,y:2,shipIds:[],formation:'line'}, destruct:{type:'destruct',shipIds:[]}, setTeam:{type:'setTeam',team:'blue'}, addBot:{type:'addBot'}, setRules:{type:'setRules',rules:{gameMode:'teams'}}, setName:{type:'setName',name:'Ace'}, startDesign:{type:'startDesign'}, kick:{type:'kick',targetId:'p1'}, restart:{type:'restart'}, returnToLobby:{type:'returnToLobby'}, restartLobby:{type:'restartLobby'}, closeLobby:{type:'closeLobby'}, leaveLobby:{type:'leaveLobby'}
};
for(const [type,msg] of Object.entries(valid)) assert.equal(validateClientMessage(msg).ok,true, `${type} valid minimum`);
assert.equal(validateClientMessage({...valid.join, room:''}).ok, true, 'join accepts empty room for Create Game');
assert.equal(validateClientMessage({...valid.join, room:'ABCD'}).ok, true, 'join accepts valid non-empty room');
assert.equal(validateClientMessage({...valid.join, room:'   '}).code, 'invalid-room', 'join rejects whitespace-only room');
assert.equal(validateClientMessage({...valid.join, room:'@@@'}).code, 'invalid-room', 'join rejects malformed non-empty room');
{ const missingRoom = {...valid.join}; delete missingRoom.room; assert.equal(validateClientMessage(missingRoom).ok, false, 'join still requires room field'); }
for(const type of ['buyShip','deploy']) assert.equal(validateClientMessage({type}).ok,false, `${type} requires payload`);
assert.equal(validateClientMessage({type:'command'}).ok,false);
assert.equal(validateClientMessage({type:'buyShip',requestId:'bad space',design}).code,'invalid-request');
assert.equal(validateClientMessage({type:'deploy',design:[{part:'x'.repeat(300)}]}).ok,false);
assert.equal(validateClientMessage({type:'command',x:Infinity,y:0}).ok,false);
assert.equal(validateClientMessage({type:'requestFullState',epoch:1.2}).code,'invalid-resync-request');
assert.equal(validateClientMessage({type:'setCombatStyle',combatStyle:'bogus'}).code,'invalid-combat-style');
let deep={type:'ping'}; let cur=deep; for(let i=0;i<12;i++){cur.next={}; cur=cur.next;} assert.equal(validateClientMessage(deep).ok,false);

// Wiring v2 physical sections and logical connections.
const section={id:'0,0:1,0',x1:0,y1:0,x2:1,y2:0,tier:'standard'};
const connection={sourceIndex:0,targetIndex:1,sectionIds:[section.id]};
const wiring={version:2,power:{sections:[section],connections:[connection]},data:{sections:[],connections:[]}};
assert.equal(validateClientMessage({type:'deploy',design,wiring}).ok,true,'deploy accepts separated physical/logical wiring');
assert.equal(validateClientMessage({type:'buyShip',requestId:'r1',design,wiring,count:1}).ok,true,'buyShip accepts wiring');
assert.equal(validateClientMessage({type:'deploy',design,wiring:{version:1,power:[],data:[]}}).code,'invalid-wiring','old wiring rejected');
assert.equal(validateClientMessage({type:'deploy',design,wiring:{...wiring,power:{...wiring.power,sections:[{...section,x1:-1}]}}}).code,'invalid-wiring','section cells stay on grid');
assert.equal(validateClientMessage({type:'deploy',design,wiring:{...wiring,networks:[]}}).code,'invalid-wiring','precomputed networks rejected');
const oversized={...wiring,power:{sections:[],connections:Array.from({length:500},()=>connection)}};
assert.equal(validateClientMessage({type:'deploy',design,wiring:oversized}).code,'invalid-wiring','connection count bounded');
assert.equal(validateClientMessage({type:'ping',at:1,wiring}).ok,false,'wiring only accepted on blueprint messages');

console.log('Protocol schema verification passed');
