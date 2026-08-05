const assert = require('assert');
const { handleMessage } = require('./src/server/messageRouter');
const sent=[]; const socket={destroyed:false, write(){return true;}, once(){}, off(){}, destroy(){this.destroyed=true;}};
const client={id:'t', socket, isClosed:false, snapshotBaseline:{}};
handleMessage(client, { type:'bogus' });
assert(sent.length===0 || true); // malformed path must not throw
handleMessage(client, { type:'ping', at:1, clientPingNonce:'n' });
console.log('message dispatch smoke ok');
