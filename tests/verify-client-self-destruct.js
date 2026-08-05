import assert from "node:assert/strict";

globalThis.performance ||= { now: () => Date.now() };
globalThis.localStorage = { getItem(){return null;}, setItem(){}, removeItem(){} };
globalThis.WebSocket = { OPEN: 1 };
const sent = [];
globalThis.MessagePack = { encode(message){ sent.push(message); return new Uint8Array([1]); }, decode(){} };
const fakeElement = () => ({ hidden:false, style:{}, classList:{add(){},remove(){},toggle(){}}, children:[], prepend(){}, replaceChildren(){}, append(){}, addEventListener(){}, removeEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];} });
globalThis.document = { getElementById:()=>null, querySelector:()=>null, querySelectorAll:()=>[], createElement:fakeElement, activeElement:null, addEventListener(){}, removeEventListener(){}, visibilityState:"visible" };
globalThis.window = { addEventListener(){}, removeEventListener(){}, devicePixelRatio:1 };

const { state } = await import("./public/src/state.js");
const { destructSelectedShips } = await import("./public/src/game/commands.js");
const ships = [
  { id:"own-a", ownerId:"p1", alive:true },
  { id:"own-b", ownerId:"p1", alive:true },
  { id:"enemy", ownerId:"p2", alive:true },
  { id:"dead", ownerId:"p1", alive:false }
];
function reset(ids=[]) { sent.length=0; state.myId="p1"; state.phase="active"; state.socket={readyState:WebSocket.OPEN,send(){}}; state.snapshot={ships:[...ships]}; state.selectedShipIds=new Set(ids); }

reset(["own-a"]); assert.equal(destructSelectedShips(),true); assert.deepEqual(sent,[{type:"destruct",shipIds:["own-a"]}],"one selected owned living ship is sent");
reset(["own-a","own-b"]); destructSelectedShips(); assert.deepEqual(sent[0].shipIds,["own-a","own-b"],"multiple explicit IDs are preserved");
reset(); assert.equal(destructSelectedShips(),false); assert.equal(sent.length,0,"empty selection never falls back to the fleet");
reset(["enemy","dead","stale","own-a"]); destructSelectedShips(); assert.deepEqual(sent[0].shipIds,["own-a"],"enemy, dead, removed, and stale IDs are pruned"); assert.deepEqual([...state.selectedShipIds],["own-a"]);
reset(["own-a"]); state.snapshot.ships=state.snapshot.ships.filter(ship=>ship.id!=="own-a"); assert.equal(destructSelectedShips(),false); assert.equal(sent.length,0,"removed selected IDs send nothing");
reset(["own-a"]); state.socket.readyState=3; assert.equal(destructSelectedShips(),false); assert.equal(sent.length,0,"closed sockets send nothing");
reset(["own-a"]); state.phase="end"; assert.equal(destructSelectedShips(),false); assert.equal(sent.length,0,"non-active phases send nothing");
console.log("Client self-destruct command verification passed");
