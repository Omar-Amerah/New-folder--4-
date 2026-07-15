const assert = require('assert');
(async () => {
  const { shipStructuralRevisionKey } = await import('./public/src/game/pixi/pixiStructuralKey.js');
  const design=[{type:'laser',x:0,y:0,rotation:0},{type:'engine',x:-1,y:0,rotation:90}];
  const base=shipStructuralRevisionKey({design,trimColor:'#f00',qualityGeneration:1,artVersion:2});
  assert.strictEqual(base, shipStructuralRevisionKey({design:design.map(p=>({...p})),trimColor:'#f00',qualityGeneration:1,artVersion:2}));
  assert.strictEqual(base, shipStructuralRevisionKey({design,trimColor:'#f00',qualityGeneration:1,artVersion:2, x:9, hp:[1], heat:[5], selected:true, weaponAngle:3}));
  assert.notStrictEqual(base, shipStructuralRevisionKey({design:[{...design[0],rotation:90},design[1]],trimColor:'#f00',qualityGeneration:1,artVersion:2}));
  assert.notStrictEqual(base, shipStructuralRevisionKey({design:[{...design[0],type:'railgun'},design[1]],trimColor:'#f00',qualityGeneration:1,artVersion:2}));
  assert.notStrictEqual(base, shipStructuralRevisionKey({design,trimColor:'#0f0',qualityGeneration:1,artVersion:2}));
  assert.notStrictEqual(base, shipStructuralRevisionKey({design,trimColor:'#f00',qualityGeneration:2,artVersion:2}));
  assert(shipStructuralRevisionKey({design:Array.from({length:600},(_,i)=>({type:'frame',x:i,y:0,rotation:0}))}).length < 120);
  console.log('renderer structural verification passed');
})();
