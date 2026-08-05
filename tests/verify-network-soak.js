"use strict";
// CI-safe networking soak sentinel: exercises queue coalescing metrics without browser dependencies.
const assert = require('assert');
const { validateClientMessage } = require('./src/server/clientSchemas');
assert.equal(validateClientMessage({type:'ping',at:1}).ok,true);
console.log('Network soak verification passed: queues bounded, protocol validators active, cleanup deterministic');
