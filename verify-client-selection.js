import assert from 'node:assert/strict';
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.localStorage = globalThis.localStorage || { getItem(){return null}, setItem(){}, removeItem(){} };
const fakeElement = () => ({ textContent:'', hidden:false, style:{ setProperty(){} }, classList:{ add(){}, remove(){}, toggle(){} }, replaceChildren(){}, append(){}, addEventListener(){}, removeEventListener(){}, querySelector(){ return null; }, querySelectorAll(){ return []; } });
globalThis.document = globalThis.document || { getElementById: () => fakeElement(), querySelector: () => null, querySelectorAll: () => [], body: null, addEventListener(){}, removeEventListener(){}, activeElement: null, visibilityState: 'visible' };
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener(){}, removeEventListener(){} };
const { state } = await import('./public/src/state.js');
const { selectAt, selectBox, selectAllOwnShips, pruneSelection, resetSelectionForEpoch, findShipAt } = await import('./public/src/game/selection.js');
function reset(){ state.myId='p1'; state.selectedShipIds=new Set(); state.activeShipGroup=null; state.visualShips=new Map(); state.snapshot={ players:[{id:'p1',team:'blue'},{id:'p2',team:'red'}], points:[], ships:[
 {id:'own-a',ownerId:'p1',alive:true,x:100,y:100,radius:20},
 {id:'own-b',ownerId:'p1',alive:true,x:132,y:100,radius:20},
 {id:'enemy',ownerId:'p2',alive:true,x:100,y:100,radius:40},
 {id:'dead',ownerId:'p1',alive:false,x:100,y:100,radius:40},
]}; }
function ids(){ return [...state.selectedShipIds].sort(); }
reset(); state.visualShips.set('own-a',{x:110,y:100,angle:0}); assert.equal(findShipAt(110,100,s=>s.ownerId==='p1'&&s.alive)?.id,'own-a'); selectAt({x:110,y:100},false); assert.deepEqual(ids(),['own-a']);
selectAt({x:116,y:100},false); assert.deepEqual(ids(),['own-a'],'nearest overlapping owned visual ship wins and enemies are ignored');
selectAt({x:110,y:100},true); assert.deepEqual(ids(),[],'Shift-click toggles selected ship off');
selectAt({x:500,y:500},false); assert.deepEqual(ids(),[],'non-intersecting click clears selection');
reset(); selectBox({x:80,y:80},{x:120,y:120},false); assert.deepEqual(ids(),['own-a','own-b'],'drag intersects visible radius even when centre outside');
selectBox({x:400,y:400},{x:450,y:450},false); assert.deepEqual(ids(),[],'normal drag replaces with empty selection');
selectBox({x:80,y:80},{x:120,y:120},true); assert.deepEqual(ids(),['own-a','own-b'],'Shift-drag adds owned living ships only');
selectAllOwnShips(); assert.deepEqual(ids(),['own-a','own-b'],'Q selection path selects all owned living ships');
state.snapshot.ships = state.snapshot.ships.filter(s => s.id !== 'own-b'); pruneSelection(); assert.deepEqual(ids(),['own-a'],'removed entities are pruned');
resetSelectionForEpoch(); assert.deepEqual(ids(),[],'epoch reset clears client selection');
const before=JSON.stringify(state.snapshot); selectAt({x:100,y:100},false); assert.equal(JSON.stringify(state.snapshot),before,'authoritative snapshot remains immutable');
console.log('Client selection verification passed');
