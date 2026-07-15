const assert = require('assert');
(async () => {
  const { createRendererPool } = await import('./public/src/game/rendererPool.js');
  const destroyed=[]; let n=0;
  const pool=createRendererPool({name:'ship',maxIdle:2,create:()=>({id:++n,root:{x:1,visible:true},heat:5,damage:9,weaponAngle:3,text:'old',owner:'red'}),reset:o=>{o.root.x=0;o.root.visible=false;o.heat=0;o.damage=0;o.weaponAngle=0;o.text='';o.owner=null;},destroy:o=>destroyed.push(o.id)});
  const a=pool.acquire(), b=pool.acquire(); assert.strictEqual(pool.activeCount(),2);
  assert.strictEqual(pool.release(a),true); assert.strictEqual(a.heat,0); assert.strictEqual(pool.release(a),false);
  const c=pool.acquire(); assert.strictEqual(c,a); assert.strictEqual(c.owner,null);
  pool.release(b); pool.release(c); const d=pool.acquire(), e=pool.acquire(), f=pool.acquire(), g=pool.acquire(); [d,e,f,g].forEach(o=>pool.release(o));
  assert(pool.idleCount()<=2); pool.trim(1); assert.strictEqual(pool.idleCount(),1); assert(pool.peakCount()>=4);
  pool.reset(); assert.strictEqual(pool.activeCount(),0); pool.clear(); pool.clear(); assert(destroyed.length>=1);
  console.log('renderer pool verification passed');
})();
