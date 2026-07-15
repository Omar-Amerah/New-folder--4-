const { sanitizeRequestId, sanitizeRoomCode } = require('./validation');
const MAX_TYPE = 32, MAX_STRING = 256, MAX_ARRAY = 64, MAX_DEPTH = 8, MAX_DESIGN = 256, MAX_SHIP_IDS = 64;
const TYPES = ['ping','join','deploy','buyShip','setCombatStyle','setRallyPoint','resetRallyPoint','command','destruct','setTeam','addBot','setRules','setName','startDesign','kick','restart','returnToLobby','restartLobby','closeLobby','leaveLobby'];
const SCHEMAS = Object.freeze(Object.fromEntries(TYPES.map((t)=>[t, Object.freeze({ type:t })])));
function isPlainObject(v){return !!v && typeof v==='object' && !Array.isArray(v) && (Object.getPrototypeOf(v)===Object.prototype || Object.getPrototypeOf(v)===null);}
function finiteNumbers(value, depth=0){
  if (depth > MAX_DEPTH) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= MAX_ARRAY && value.every((v)=>finiteNumbers(v, depth+1));
  if (isPlainObject(value)) return Object.values(value).every((v)=>finiteNumbers(v, depth+1));
  return true;
}
function tooLongStrings(value, depth=0){
  if (depth > MAX_DEPTH) return true;
  if (typeof value === 'string') return value.length > MAX_STRING;
  if (Array.isArray(value)) return value.length > MAX_ARRAY || value.some((v)=>tooLongStrings(v, depth+1));
  if (isPlainObject(value)) return Object.values(value).some((v)=>tooLongStrings(v, depth+1));
  return false;
}
function validateClientMessage(message){
  if (!isPlainObject(message)) return { ok:false, code:'invalid-payload', message:'Message must be an object' };
  if (typeof message.type !== 'string' || message.type.length<1 || message.type.length>MAX_TYPE) return { ok:false, code:'invalid-type', message:'Message type is missing or invalid' };
  if (!SCHEMAS[message.type]) return { ok:false, code:'unknown-type', message:'Unsupported message type' };
  if (message.requestId !== undefined && (typeof message.requestId !== 'string' || message.requestId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(message.requestId))) return { ok:false, code:'invalid-request', message:'Invalid request id' };
  if (message.room !== undefined && message.room !== '' && (typeof message.room !== 'string' || !/^[A-Za-z0-9_-]{3,64}$/.test(message.room))) return { ok:false, code:'invalid-room', message:'Invalid room code' };
  if (message.shipIds !== undefined && (!Array.isArray(message.shipIds) || message.shipIds.length > MAX_SHIP_IDS || message.shipIds.some((id)=>typeof id !== 'string' || id.length > 64))) return { ok:false, code:'invalid-ship-ids', message:'Invalid ship selection' };
  if (message.design !== undefined && (!Array.isArray(message.design) || message.design.length > MAX_DESIGN)) return { ok:false, code:'invalid-design', message:'Invalid design payload' };
  if (!finiteNumbers(message) || tooLongStrings(message)) return { ok:false, code:'invalid-payload', message:'Message fields exceed protocol limits' };
  return { ok:true, schema:SCHEMAS[message.type] };
}
module.exports={ SCHEMAS, validateClientMessage, limits:{MAX_TYPE,MAX_STRING,MAX_ARRAY,MAX_DEPTH,MAX_DESIGN,MAX_SHIP_IDS} };
