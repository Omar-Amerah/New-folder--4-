const fs = require('fs');
const assert = require('assert');
const source = fs.readFileSync('public/src/network.js','utf8');
assert.match(source, /connectionGeneration/);
assert.match(source, /MessagePack bundle unavailable/);
assert.doesNotMatch(source, /JSON\.stringify\(message\)/);
console.log('network browser verification passed');
