const assert = require('assert');
const { ROUTES } = require('../src/server/routeRegistry');
const { checkRateLimit, enforceRoutePolicy } = require('../src/server/messageRouter');
const phases = new Set(['any','lobby','design','active','ended']);
for (const r of ROUTES) {
  assert(r.phases.every(p=>phases.has(p)), r.type);
  if (!['ping','join'].includes(r.type)) assert.strictEqual(r.requiresJoin, true, r.type);
  if (['addBot','setRules','startDesign','kick','restart','returnToLobby','restartLobby','closeLobby'].includes(r.type)) assert.strictEqual(r.admin, true, r.type);
  if (['command','destruct','buyShip','setCombatStyle','setRallyPoint','resetRallyPoint'].includes(r.type)) assert.deepStrictEqual(r.phases, ['active'], r.type);
}
assert.deepStrictEqual(ROUTES.find(r=>r.type==='setTelemetryFocus').phases, ['lobby','design','active','ended'], 'telemetry focus may be cleared immediately after joining in any phase');

const socket = { destroyed:false, writes:[], write(chunk){ this.writes.push(chunk); return true; }, once(){}, off(){}, destroy(){ this.destroyed=true; } };
const room = { phase:'lobby', adminId:'admin' };
const player = { id:'pilot', name:'Pilot', isBot:false, attachmentId:1 };
const client = { socket, isClosed:false, room, player, attachmentId:1 };
player.client = client;

assert.strictEqual(enforceRoutePolicy(client, {type:'command'}, ROUTES.find(r=>r.type==='command'), 1000), false, 'runtime rejects wrong-phase commands from route metadata');
room.phase = 'active';
assert.strictEqual(enforceRoutePolicy(client, {type:'command'}, ROUTES.find(r=>r.type==='command'), 1001), true, 'runtime accepts a permitted command phase');
room.phase = 'lobby';
assert.strictEqual(enforceRoutePolicy(client, {type:'addBot'}, ROUTES.find(r=>r.type==='addBot'), 1002), false, 'runtime enforces admin metadata');
room.adminId = player.id;
assert.strictEqual(enforceRoutePolicy(client, {type:'addBot'}, ROUTES.find(r=>r.type==='addBot'), 1003), true, 'runtime accepts the room admin');

const unattached = { socket:{...socket,writes:[]}, isClosed:false };
assert.strictEqual(enforceRoutePolicy(unattached, {type:'setName'}, ROUTES.find(r=>r.type==='setName'), 1000), false, 'runtime enforces requiresJoin metadata');
const stale = { ...client, socket:{...socket,writes:[]}, attachmentId:2, rateLimits:{} };
assert.strictEqual(enforceRoutePolicy(stale, {type:'setName'}, ROUTES.find(r=>r.type==='setName'), 1000), false, 'runtime enforces current-attachment metadata');

const limited = {};
for (let i=0;i<30;i++) assert.strictEqual(checkRateLimit(limited, 'command', 5000), true, `command ${i+1} within the registered 30/s limit`);
assert.strictEqual(checkRateLimit(limited, 'command', 5000), false, '31st command is rejected by the registered route limit');
assert.strictEqual(checkRateLimit(limited, 'command', 6000), true, 'registered command window resets after one second');

const phaseLimited = {};
for (let i=0;i<8;i++) assert.strictEqual(checkRateLimit(phaseLimited, i % 2 ? 'restartLobby' : 'startDesign', 7000), true, `phase transition ${i+1} stays within the registered shared limit`);
assert.strictEqual(checkRateLimit(phaseLimited, 'returnToLobby', 7000), false, 'ninth shared phase transition is rejected');
assert.strictEqual(checkRateLimit(phaseLimited, 'startDesign', 12000), true, 'registered phase window resets after five seconds');

console.log('message permission metadata and runtime enforcement ok');
