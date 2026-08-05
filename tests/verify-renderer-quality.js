const assert = require('assert');
global.document = { getElementById: () => ({ getContext: () => ({}) }), querySelector: () => null, createElement: () => ({ getContext: () => ({ setTransform(){}}) }) };
global.window = {};
global.localStorage = { store:new Map(), getItem(k){return this.store.get(k)||null;}, setItem(k,v){this.store.set(k,String(v));} };
(async () => {
  const s = await import('./public/src/game/renderSettings.js');
  assert.strictEqual(s.renderQualityProfile('low').dprCap,1.25); assert.strictEqual(s.renderQualityProfile('medium').bakeScale,2.0); assert.strictEqual(s.renderQualityProfile('high').effectDensity,1);
  s.setRenderQuality('low'); assert.strictEqual(s.getRenderQuality(),'low'); assert.strictEqual(s.getRenderQualityDprCap(),1.25); assert.strictEqual(s.getEffectDensity(),0.4);
  s.setRenderQuality('medium'); assert.strictEqual(global.localStorage.getItem('mfa.renderQuality'),'medium');
  const b = await import('./public/src/game/pixi/pixiBake.js'); const gen=b.getPixiBakeGeneration(); b.advancePixiBakeGeneration(); assert.strictEqual(b.getPixiBakeGeneration(),gen+1);
  console.log('renderer quality verification passed');
})();
