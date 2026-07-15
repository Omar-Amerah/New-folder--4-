const assert = require('assert');
const { ROUTES } = require('./src/server/routeRegistry');
const phases = new Set(['any','lobby','design','active','ended']);
for (const r of ROUTES) {
  assert(r.phases.every(p=>phases.has(p)), r.type);
  if (!['ping','join'].includes(r.type)) assert.strictEqual(r.requiresJoin, true, r.type);
  if (['addBot','setRules','startDesign','kick','restart','returnToLobby','restartLobby','closeLobby'].includes(r.type)) assert.strictEqual(r.admin, true, r.type);
  if (['command','destruct','buyShip','setCombatStyle','setRallyPoint','resetRallyPoint'].includes(r.type)) assert.deepStrictEqual(r.phases, ['active'], r.type);
}
console.log('message permission matrix metadata ok');
