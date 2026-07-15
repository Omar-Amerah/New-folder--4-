"use strict";
const assert = require("assert");
const { writeFrame } = require("./src/server/websocketServer");
const writes=[]; const socket={ write(buf){ writes.push(buf); return writes.length < 2; } };
assert.equal(writeFrame(socket, Buffer.from([1]), 2), true);
assert.equal(writeFrame(socket, Buffer.from([2]), 2), false);
assert.equal(writes.length, 2);
console.log("Network backpressure verification passed");
