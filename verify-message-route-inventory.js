const assert = require('assert');
const { SCHEMAS } = require('./src/server/clientSchemas');
const { ROUTES, routesByType } = require('./src/server/routeRegistry');
const types = Object.keys(SCHEMAS).sort();
assert.deepStrictEqual(ROUTES.map(r=>r.type).sort(), types);
assert.strictEqual(new Set(ROUTES.map(r=>r.type)).size, ROUTES.length);
for (const route of ROUTES) {
  assert.strictEqual(typeof route.handler, 'function', route.type);
  for (const field of ['requiresJoin','requiresCurrentAttachment','phases','admin','requestId','mayTriggerStaticSnapshot','mayBroadcast']) assert(Object.prototype.hasOwnProperty.call(route, field), `${route.type} missing ${field}`);
  assert(Object.isFrozen(route), `${route.type} frozen`);
}
assert(Object.isFrozen(ROUTES));
assert(Object.isFrozen(routesByType));
console.log(`message route inventory ok (${ROUTES.length} routes)`);
