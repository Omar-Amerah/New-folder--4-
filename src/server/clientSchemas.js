const { sanitizeRoomCode } = require('./validation');
const MAX_TYPE = 32, MAX_STRING = 256, MAX_ARRAY = 64, MAX_DEPTH = 8, MAX_DESIGN = 256, MAX_SHIP_IDS = 64;
const TYPES = ['ping','join','deploy','buyShip','setCombatStyle','setRallyPoint','resetRallyPoint','command','destruct','setTeam','addBot','setRules','setName','startDesign','kick','restart','returnToLobby','restartLobby','closeLobby','leaveLobby','requestFullState'];
const COMBAT = new Set(['sentry','charge','circle','hold']);
const FORMATIONS = new Set(['line','wedge','clump']);
const RESYNC = new Set(['client-request','sequence-gap','epoch-change','static-revision','reconnect','heartbeat-timeout','malformed-snapshot']);
const SCHEMAS = Object.freeze(Object.fromEntries(TYPES.map((t)=>[t, Object.freeze({ type:t })])));
function isPlainObject(v){return !!v && typeof v==='object' && !Array.isArray(v) && (Object.getPrototypeOf(v)===Object.prototype || Object.getPrototypeOf(v)===null);}
function finiteNumbers(value, depth=0){ if(depth>MAX_DEPTH)return false; if(typeof value==='number')return Number.isFinite(value); if(Array.isArray(value))return value.length<=MAX_ARRAY&&value.every((v)=>finiteNumbers(v,depth+1)); if(isPlainObject(value))return Object.values(value).every((v)=>finiteNumbers(v,depth+1)); return true; }
function tooLongStrings(value, depth=0){ if(depth>MAX_DEPTH)return true; if(typeof value==='string')return value.length>MAX_STRING; if(Array.isArray(value))return value.length>MAX_ARRAY||value.some((v)=>tooLongStrings(v,depth+1)); if(isPlainObject(value))return Object.values(value).some((v)=>tooLongStrings(v,depth+1)); return false; }
const reqId=(v)=>typeof v==='string'&&v.length>=1&&v.length<=64&&/^[A-Za-z0-9_-]+$/.test(v);
const str=(v,n=MAX_STRING)=>typeof v==='string'&&v.length>=1&&v.length<=n;
const int=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const num=(v,min=-1e6,max=1e6)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const id=(v)=>typeof v==='string'&&v.length>=1&&v.length<=64;
const roomCode=(v)=>typeof v==='string'&&v.length>=1&&v.length<=64&&!!sanitizeRoomCode(v);
function validShipIds(v){ return Array.isArray(v)&&v.length<=MAX_SHIP_IDS&&v.every(id); }
function validDesign(v){ return Array.isArray(v)&&v.length>0&&v.length<=MAX_DESIGN&&v.every((e)=>isPlainObject(e)&&str(e.part||e.type||e.id||'x',128)); }
function validRules(v){ return isPlainObject(v)&&Object.keys(v).length<=32; }
function fail(code,message){ return {ok:false,code,message}; }
function checkRequired(m, fields){ for(const f of fields) if(!Object.prototype.hasOwnProperty.call(m,f)) return fail('invalid-payload',`Missing required field: ${f}`); return null; }
function validateSpecific(m){
  switch(m.type){
    case 'ping': return (m.at===undefined||num(m.at,0,Number.MAX_SAFE_INTEGER))&&(m.clientPingNonce===undefined||str(m.clientPingNonce,64))?null:fail('invalid-payload','Invalid ping');
    case 'join': { const miss=checkRequired(m,['name','room','protocolVersion','capabilities']); if(miss)return miss; if(!str(m.name,32))return fail('invalid-payload','Invalid name'); if(typeof m.room!=='string'||(m.room!==''&&!roomCode(m.room)))return fail('invalid-room','Invalid room code'); if(!int(m.protocolVersion,1,99))return fail('incompatible-protocol','Invalid protocol version'); if(m.minProtocolVersion!==undefined&&!int(m.minProtocolVersion,1,99))return fail('incompatible-protocol','Invalid protocol range'); if(m.maxProtocolVersion!==undefined&&!int(m.maxProtocolVersion,1,99))return fail('incompatible-protocol','Invalid protocol range'); if(!Array.isArray(m.capabilities)||m.capabilities.length>16||m.capabilities.some((c)=>!str(c,32)))return fail('missing-capability','Invalid capabilities'); return null; }
    case 'requestFullState': if(m.epoch!==undefined&&!int(m.epoch,0,Number.MAX_SAFE_INTEGER))return fail('invalid-resync-request','Invalid epoch'); if(m.sequence!==undefined&&!int(m.sequence,0,Number.MAX_SAFE_INTEGER))return fail('invalid-resync-request','Invalid sequence'); if(m.reason!==undefined&&(!str(m.reason,64)||!RESYNC.has(m.reason)))return fail('invalid-resync-request','Invalid resync reason'); return null;
    case 'deploy': { const miss=checkRequired(m,['design']); if(miss)return miss; if(!validDesign(m.design))return fail('invalid-design','Invalid design payload'); if(m.combatStyle!==undefined&&!COMBAT.has(m.combatStyle))return fail('invalid-combat-style','Invalid combat style'); return null; }
    case 'buyShip': { const miss=checkRequired(m,['requestId','design']); if(miss)return miss; if(!reqId(m.requestId))return fail('invalid-request','Invalid request id'); if(!validDesign(m.design))return fail('invalid-design','Invalid design payload'); if(m.count!==undefined&&!int(m.count,1,5))return fail('invalid-request','Invalid purchase quantity'); if(m.combatStyle!==undefined&&!COMBAT.has(m.combatStyle))return fail('invalid-combat-style','Invalid combat style'); return null; }
    case 'setCombatStyle': { const miss=checkRequired(m,['combatStyle']); if(miss)return miss; if(!COMBAT.has(m.combatStyle))return fail('invalid-combat-style','Invalid combat style'); if(m.shipIds!==undefined&&!validShipIds(m.shipIds))return fail('invalid-selection','Invalid ship selection'); return null; }
    case 'setRallyPoint': { const miss=checkRequired(m,['x','y']); if(miss)return miss; return num(m.x)&&num(m.y)?null:fail('invalid-rally','Invalid rally point'); }
    case 'command': { const miss=checkRequired(m,['x','y']); if(miss)return miss; if(!num(m.x)||!num(m.y))return fail('invalid-command','Invalid command coordinates'); if(m.shipIds!==undefined&&!validShipIds(m.shipIds))return fail('invalid-selection','Invalid ship selection'); if(m.targetId!==undefined&&m.targetId!==null&&!id(m.targetId))return fail('invalid-target','Invalid target'); if(m.formation!==undefined&&!FORMATIONS.has(m.formation))return fail('invalid-command','Invalid formation'); return null; }
    case 'resetRallyPoint': return null;
    case 'destruct': if(m.shipIds!==undefined&&!validShipIds(m.shipIds))return fail('invalid-selection','Invalid ship selection'); return null;
    case 'setTeam': return (m.team===undefined||str(String(m.team),32))?null:fail('invalid-team','Invalid team');
    case 'setRules': return (m.rules===undefined||validRules(m.rules))?null:fail('invalid-rules','Invalid rules');
    case 'setName': { const miss=checkRequired(m,['name']); if(miss)return miss; return str(m.name,32)?null:fail('invalid-payload','Invalid name'); }
    case 'kick': { const miss=checkRequired(m,['targetId']); if(miss)return miss; return id(m.targetId)?null:fail('player-not-found','Invalid target'); }
    case 'addBot': case 'startDesign': case 'restart': case 'returnToLobby': case 'restartLobby': case 'closeLobby': case 'leaveLobby': return null;
    default: return fail('unknown-type','Unsupported message type');
  }
}
function validateClientMessage(message){
  if(!isPlainObject(message))return fail('invalid-payload','Message must be an object');
  if(typeof message.type!=='string'||message.type.length<1||message.type.length>MAX_TYPE)return fail('invalid-type','Message type is missing or invalid');
  if(!SCHEMAS[message.type])return fail('unknown-type','Unsupported message type');
  if(message.requestId!==undefined&&!reqId(message.requestId))return fail('invalid-request','Invalid request id');
  if(message.room!==undefined&&message.room!==''&&!roomCode(message.room))return fail('invalid-room','Invalid room code');
  if(message.shipIds!==undefined&&!validShipIds(message.shipIds))return fail('invalid-selection','Invalid ship selection');
  if(message.design!==undefined&&!validDesign(message.design))return fail('invalid-design','Invalid design payload');
  if(!finiteNumbers(message)||tooLongStrings(message))return fail('invalid-payload','Message fields exceed protocol limits');
  const specific=validateSpecific(message); if(specific)return specific;
  return {ok:true,schema:SCHEMAS[message.type]};
}
module.exports={SCHEMAS,validateClientMessage,limits:{MAX_TYPE,MAX_STRING,MAX_ARRAY,MAX_DEPTH,MAX_DESIGN,MAX_SHIP_IDS}};
