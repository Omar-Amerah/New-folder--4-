const assert = require('assert');
global.document = { getElementById: () => ({ getContext: () => ({}) }), querySelector: () => null, createElement: () => ({ getContext: () => ({ setTransform(){}}) }) };
global.window = {};
(async () => {
  const bake = await import('./public/src/game/pixi/pixiBake.js');
  let destroyed=0, made=0; const cache=bake.createPixiTextureCache('test');
  const factory=()=>({id:++made,destroy(){destroyed+=1;}});
  const a=cache.acquire('design:red:r0:q0',factory); const b=cache.acquire('design:red:r0:q0',factory); assert.strictEqual(made,1);
  const c=cache.acquire('design:blue:r0:q0',factory); const d=cache.acquire('design:red:r1:q0',factory); assert.strictEqual(made,3);
  assert.strictEqual(a.release(),true); assert.strictEqual(a.release(),false); assert.strictEqual(cache.diagnostics().duplicateReleases,1); c.release(); d.release();
  bake.advancePixiBakeGeneration(); assert.strictEqual(destroyed,2); assert.strictEqual(b.release(),true); assert.strictEqual(destroyed,3);
  const old=bake.createPixiTextureCache('old'); const lease=old.acquire('active-old',factory); bake.advancePixiBakeGeneration(); assert.strictEqual(old.diagnostics().entries,1); lease.release(); assert.strictEqual(old.diagnostics().entries,0);
  cache.flush(); old.flush(); const before=destroyed; cache.flush(); assert.strictEqual(destroyed,before);
  console.log('renderer texture verification passed');
})();
