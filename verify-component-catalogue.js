const assert = require('assert');

global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, appendChild(){}, getContext: () => null })
};
global.window = { devicePixelRatio: 1 };

(async () => {
  const parts = await import('./public/src/design/parts.js');
  const before = parts.PART_STATS.core.cost;
  assert.notStrictEqual(parts.componentCatalogueSource(), 'server');
  parts.applyServerParts({ core: { cost: 123, mass: 1, hp: 1, footprint: { width: 1, height: 1 } } });
  assert.strictEqual(parts.componentCatalogueSource(), 'server');
  assert.strictEqual(parts.PART_STATS.core.cost, 123);
  const applied = parts.applyComponentBalance({ components: [{ id: 'core', cost: 999, mass: 1, hull: 1, footprint: { width: 1, height: 1 } }] });
  assert.strictEqual(applied, false, 'late HTTP balance must not override server catalogue');
  assert.strictEqual(parts.PART_STATS.core.cost, 123);
  assert(Number.isFinite(before));
  console.log('Component catalogue precedence verification passed');
})();
