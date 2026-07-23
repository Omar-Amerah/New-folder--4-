import assert from 'node:assert/strict';
globalThis.document = globalThis.document || { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: null, addEventListener(){}, removeEventListener(){}, activeElement: null, visibilityState: 'visible' };
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener(){}, removeEventListener(){} };
globalThis.performance = globalThis.performance || { now: () => Date.now() };
const { worldToScreen, screenToWorldPoint, clampCameraToWorld, zoomCameraAtScreenPoint, minimapToWorld, worldToMinimap, cameraViewportWorldBounds, CAMERA_PAN_RANGE_SCALE } = await import('./public/src/game/camera.js');
const rect={left:40,top:20,width:900,height:700}, world={width:2000,height:1200};
for (const zoom of [0.32,0.58,1,1.45]) { const cam={x:777,y:444,zoom}; const p={x:1234.5,y:888.25}; const s=worldToScreen(p,cam,rect,world); const r=screenToWorldPoint(s,cam,rect,world); assert(Math.abs(r.x-p.x)<1e-9); assert(Math.abs(r.y-p.y)<1e-9); }
assert.equal(CAMERA_PAN_RANGE_SCALE, 2);
assert.equal(clampCameraToWorld({x:-9999,y:-9999,zoom:1},rect,world).x,-550);
assert.equal(clampCameraToWorld({x:9999,y:9999,zoom:1},rect,world).x,2550);
assert.equal(clampCameraToWorld({x:-9999,y:-9999,zoom:1},rect,world).y,-250);
assert.equal(clampCameraToWorld({x:9999,y:9999,zoom:1},rect,world).y,1450);
assert.equal(clampCameraToWorld({x:0,y:0,zoom:0.5},rect,{width:500,height:300}).x,250);
const cam={x:500,y:500,zoom:.5}; const pt={x:300,y:260}; const before=screenToWorldPoint(pt,cam,rect,world); const z=zoomCameraAtScreenPoint(cam,pt,1,rect,world); const after=screenToWorldPoint(pt,z,rect,world); assert(Number.isFinite(z.x)); assert(Number.isFinite(after.x));
const mini={x:10,y:20,w:200,h:120}; const mp=worldToMinimap({x:1000,y:600},mini,world); const wp=minimapToWorld(mp,mini,world); assert(Math.abs(wp.x-1000)<1e-9); assert(Math.abs(wp.y-600)<1e-9);
const b=cameraViewportWorldBounds({x:1000,y:600,zoom:1},rect,world); assert.equal(b.left,550); assert(Number.isFinite(b.right));
console.log('Camera transform verification passed');
