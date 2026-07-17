import assert from 'node:assert/strict';
globalThis.performance={now:()=>Date.now()};
globalThis.localStorage={getItem(){return null},setItem(){},removeItem(){}};
globalThis.WebSocket={OPEN:1};
const sent=[]; globalThis.MessagePack={encode(value){sent.push(value); return new Uint8Array([1]);},decode(){}};
const listeners=new Map();
function target(){return { setPointerCapture(){}, releasePointerCapture(){}, hasPointerCapture(){return false}, getBoundingClientRect(){return {left:0,top:0,width:800,height:600}}, addEventListener(t,h){listeners.set(t,(listeners.get(t)||0)+1); this['on'+t]=h;}, removeEventListener(t){listeners.set(t,(listeners.get(t)||1)-1);} };}
globalThis.document={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},removeEventListener(){},visibilityState:'visible',activeElement:null};
globalThis.window={addEventListener(){},removeEventListener(){},devicePixelRatio:1};
const { state } = await import('./public/src/state.js'); const input=await import('./public/src/game/input.js');
const c1=target(); const c2=target(); state.snapshot={ships:[]}; state.world={width:2000,height:1200}; state.camera={x:1000,y:600,zoom:1,follow:true};
const u1=input.bindArenaPointerListeners(c1); input.bindArenaPointerListeners(c1); assert.equal(listeners.get('pointerdown'),1);
input.bindArenaPointerListeners(c2); assert.equal(listeners.get('pointerdown'),1);
c2.onpointerdown({currentTarget:c2,target:c2,pointerId:1,button:0,clientX:10,clientY:10,shiftKey:false}); assert(state.drag); c2.onpointercancel({pointerId:1,type:'pointercancel'}); assert.equal(state.drag,null);
c2.onwheel({currentTarget:c2,target:c2,clientX:100,clientY:100,deltaY:-120,deltaMode:0,preventDefault(){this.p=true},stopPropagation(){}}); assert(state.camera.zoom>1);
input.unbindArenaPointerListeners(); assert.equal(input.inputDiagnostics().bound,false);

function control(tag, options={}) { return { tagName:tag.toUpperCase(), isContentEditable:!!options.editable, closest(selector){ return selector.toLowerCase().includes(tag.toLowerCase()) || this.isContentEditable ? this : null; } }; }
function keyEvent(key, options={}) { return { key, target:options.target || null, repeat:!!options.repeat, prevented:false, preventDefault(){this.prevented=true;} }; }
state.myId='p1'; state.phase='active'; state.socket={readyState:WebSocket.OPEN,send(){}}; state.snapshot={ships:[{id:'selected',ownerId:'p1',alive:true},{id:'unselected',ownerId:'p1',alive:true}]};
state.selectedShipIds=new Set(['selected']); let event=keyEvent('Delete'); input.handleKeyDown(event); assert.equal(event.prevented,true); assert.deepEqual(sent.pop(),{type:'destruct',shipIds:['selected']},'Delete invokes explicit-selection self-destruct');
state.selectedShipIds=new Set(['selected']); event=keyEvent('Backspace'); input.handleKeyDown(event); assert.equal(event.prevented,true); assert.deepEqual(sent.pop(),{type:'destruct',shipIds:['selected']},'Backspace invokes explicit-selection self-destruct');
state.selectedShipIds=new Set(['selected']); event=keyEvent('Delete',{repeat:true}); input.handleKeyDown(event); assert.equal(event.prevented,false); assert.equal(sent.length,0,'held keys do not repeat requests');
for (const [key,editable] of [['Delete',control('input')],['Backspace',control('textarea')],['Delete',control('div',{editable:true})]]) { state.selectedShipIds=new Set(['selected']); event=keyEvent(key,{target:editable}); input.handleKeyDown(event); assert.equal(event.prevented,false); assert.equal(sent.length,0,`${key} editing remains native`); }
state.selectedShipIds=new Set(['selected']); event=keyEvent('f'); state.camera.follow=false; input.handleKeyDown(event); assert.equal(state.camera.follow,true,'other gameplay shortcuts remain intact');
console.log('Input lifecycle verification passed');
