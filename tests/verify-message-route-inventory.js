const assert = require('assert');
const { SCHEMAS } = require('../src/server/clientSchemas');
const { ROUTES, routesByType } = require('../src/server/routeRegistry');
const types = Object.keys(SCHEMAS).sort();
assert.deepStrictEqual(ROUTES.map(r=>r.type).sort(), types);
assert.strictEqual(new Set(ROUTES.map(r=>r.type)).size, ROUTES.length);
for (const route of ROUTES) {
  assert(!Object.prototype.hasOwnProperty.call(route, 'handler'), `${route.type} registry metadata must not claim to own dispatch`);
  for (const field of ['requiresJoin','requiresCurrentAttachment','phases','admin','requestId','rateLimit','mayTriggerStaticSnapshot','mayBroadcast']) assert(Object.prototype.hasOwnProperty.call(route, field), `${route.type} missing ${field}`);
  assert(route.rateLimit && typeof route.rateLimit.bucket === 'string', `${route.type} missing authoritative rate-limit bucket`);
  assert(Number.isInteger(route.rateLimit.limit) && route.rateLimit.limit > 0, `${route.type} invalid rate-limit count`);
  assert(Number.isInteger(route.rateLimit.windowMs) && route.rateLimit.windowMs > 0, `${route.type} invalid rate-limit window`);
  assert(Object.isFrozen(route), `${route.type} frozen`);
}
assert(Object.isFrozen(ROUTES));
assert(Object.isFrozen(routesByType));
const bucketConfigs = new Map();
for (const route of ROUTES) {
  const config = `${route.rateLimit.limit}/${route.rateLimit.windowMs}`;
  assert(!bucketConfigs.has(route.rateLimit.bucket) || bucketConfigs.get(route.rateLimit.bucket) === config, `${route.type} disagrees with its shared ${route.rateLimit.bucket} bucket`);
  bucketConfigs.set(route.rateLimit.bucket, config);
}
console.log(`message route inventory ok (${ROUTES.length} routes)`);
