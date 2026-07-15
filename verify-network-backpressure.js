"use strict";
const assert = require("assert");
const EventEmitter = require("events");
const messages = require("./src/server/messages");
class Transport extends EventEmitter { constructor(pattern){ super(); this.pattern=pattern; this.writes=[]; this.destroyed=false; } write(buf){ this.writes.push(buf); return this.pattern.length ? this.pattern.shift() : true; } destroy(){ this.destroyed=true; this.emit('close'); } }
function client(pattern){ return { id:'test', socket:new Transport(pattern), isClosed:false }; }
const slow=client([true,false]);
messages.enqueueRaw(slow, Buffer.from([1]));
messages.enqueueRaw(slow, Buffer.from([2]));
assert.equal(slow.socket.writes.length,2, 'second write blocks');
messages.enqueueRaw(slow, Buffer.from([3]));
messages.enqueueRaw(slow, Buffer.from([4]), {kind:'snapshot-compact'});
messages.enqueueRaw(slow, Buffer.from([5]), {kind:'snapshot-compact'});
assert.equal(slow.socket.writes.length,2, 'no writes while waiting for drain');
assert.equal(messages.getOutbound(slow).coalescedSnapshots,1);
slow.socket.emit('drain');
assert.equal(slow.socket.writes.length,4, 'drain resumes control then latest compact');
assert.equal(messages.getOutbound(slow).bytes,0);
const healthy=client([true,true,true]);
messages.enqueueRaw(healthy, Buffer.from([9]));
assert.equal(healthy.socket.writes.length,1, 'healthy client unaffected');
const blocked=client([false]);
messages.enqueueRaw(blocked, Buffer.alloc(1024));
for(let i=0;i<300;i++) messages.enqueueRaw(blocked, Buffer.alloc(4096));
assert.equal(blocked.isClosed, true, 'blocked client closes at queue limit');
messages.resetOutbound(slow);
assert.equal(messages.getOutbound(slow).bytes,0);
console.log("Network backpressure verification passed");
