const assert = require('assert'); const fs=require('fs'); const path=require('path');
for (const file of ['src/server/messages.js','src/server/outbound.js','src/server/snapshotDelivery.js','src/server/messageRouter.js','src/server/websocketServer.js','server.js']) {
  const src=fs.readFileSync(file,'utf8');
  assert(!/require\(["']\.\/messages["']\)/.test(src) || file.endsWith('messages.js'), `${file} imports messages facade`);
}
const { createGameServer } = require('./server');
const g=createGameServer({port:0}); assert(g.diagnostics().stopped);
console.log('server dependency boundaries ok');
