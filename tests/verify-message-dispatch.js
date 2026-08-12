const assert = require('assert');
const { handleMessage } = require('../src/server/messageRouter');
const sent=[]; const socket={destroyed:false, write(chunk){sent.push(chunk);return true;}, once(){}, off(){}, destroy(){this.destroyed=true;}};
const client={id:'t', socket, isClosed:false, snapshotBaseline:{}};
handleMessage(client, { type:'bogus' });
assert.strictEqual(sent.length,1,'unknown messages produce one error response');
handleMessage(client, { type:'ping', at:1, clientPingNonce:'n' });
assert.strictEqual(sent.length,2,'ping dispatch produces one pong response');
console.log('message dispatch smoke ok');
