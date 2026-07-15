const assert = require('assert');
global.document = { getElementById: () => ({ getContext: () => ({}) }), querySelector: () => null };
global.window = {};
(async () => {
  const m = await import('./public/src/game/viewportCulling.js');
  const b={left:0,right:100,top:0,bottom:100};
  assert(m.circleIntersectsViewport({x:-5,y:50,radius:5},b)); assert(m.circleIntersectsViewport({x:105,y:50,radius:5},b));
  assert(m.circleIntersectsViewport({x:50,y:-5,radius:5},b)); assert(m.circleIntersectsViewport({x:50,y:105,radius:5},b));
  assert(!m.circleIntersectsViewport({x:-20,y:50,radius:5},b)); assert(m.circleIntersectsViewport({x:-20,y:50,radius:5},b,20));
  assert(m.circleIntersectsViewport({x:150,y:50,radius:60},b)); assert(m.lineIntersectsViewport({x1:-10,y1:50,x2:110,y2:50},b));
  assert(m.rectIntersectsViewport({type:'rect',x:50,y:50,width:300,height:10},b)); assert(m.circleIntersectsViewport({x:NaN,y:0,radius:1},b));
  const small={left:-50,right:50,top:-50,bottom:50}; assert(m.circleIntersectsViewport({x:0,y:0,radius:1},small));
  assert(m.cullVisual('trail',{type:'line',x1:-200,y1:50,x2:-10,y2:50},b));
  console.log('renderer culling verification passed');
})();
