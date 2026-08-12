// The client's record of a course drawn for a single ship.
//
// The queue that actually moves a ship is the server's. This is the copy kept
// so the path can be drawn, and the whole risk in it is drift: the ship reaches
// a leg, or somebody else's order takes the hull, and the drawing has to follow
// without ever being told. It follows the ship's published destination, which
// is the one thing that says which leg is being flown right now.

import assert from 'node:assert/strict';
globalThis.performance = globalThis.performance || { now: () => Date.now() };
globalThis.localStorage = globalThis.localStorage || { getItem(){return null}, setItem(){}, removeItem(){} };
globalThis.document = globalThis.document || { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: null, addEventListener(){}, removeEventListener(){}, activeElement: null, visibilityState: 'visible' };
globalThis.window = globalThis.window || { devicePixelRatio: 1, addEventListener(){}, removeEventListener(){} };
const { state } = await import('../public/src/state.js');
const { recordOrderQueue, clearOrderQueues, pruneOrderQueues, orderQueuePath, MAX_QUEUED_WAYPOINTS } =
  await import('../public/src/game/orderQueue.js');

const ship = (over = {}) => ({ id: 's1', alive: true, x: 0, y: 0, targetX: 0, targetY: 0, ...over });

state.orderQueues.clear();

// Exact click-to-snapshot race: the current snapshot still publishes the OLD
// destination when the user records a NEW course, and the renderer asks for the
// path before a snapshot carrying that new destination has arrived.
const oldSnapshotShip = ship({ id: 'race', targetX: 250, targetY: 300 });
const newDestination = { x: 900, y: 700 };
state.snapshot = { ships: [oldSnapshotShip] };
recordOrderQueue('race', newDestination, false);
assert.deepEqual(orderQueuePath(oldSnapshotShip), [newDestination],
  'a renderer pass against the old snapshot preserves the newly issued local course');
assert(state.orderQueues.has('race'),
  'the old published destination must not delete the new course before its snapshot arrives');
assert.deepEqual(orderQueuePath(ship({ id: 'race', targetX: 900, targetY: 700 })), [newDestination],
  'the new published destination takes ownership of the recorded course');
state.snapshot = null;
state.orderQueues.clear();

// A course is the leg being flown plus everything behind it.
recordOrderQueue('s1', { x: 1000, y: 0 }, false);
recordOrderQueue('s1', { x: 1000, y: 1000 }, true);
recordOrderQueue('s1', { x: 2000, y: 1000 }, true);
assert.equal(orderQueuePath(ship({ targetX: 1000, targetY: 0 })).length, 3,
  'the whole course is drawn while the ship is on its first leg');

// The ship reaches the first point and the server hands it the second: the
// published destination is what says so, and the leg already flown drops off.
const midway = orderQueuePath(ship({ x: 1000, y: 0, targetX: 1000, targetY: 1000 }));
assert.deepEqual(midway, [{ x: 1000, y: 1000 }, { x: 2000, y: 1000 }],
  'legs behind the one being flown are no longer part of the path ahead');

// Off-by-a-little is still the same leg: the server walks a clicked point clear
// of geometry before flying to it.
assert.equal(orderQueuePath(ship({ x: 1000, y: 0, targetX: 1040, targetY: 1030 })).length, 2,
  'a destination nudged clear of a rock is still the leg it was queued as');

// Arrived on the last point, with nothing behind it: the course is over. The
// destination stays published after arrival, so nothing else would retire it.
assert.equal(orderQueuePath(ship({ x: 2000, y: 1000, targetX: 2000, targetY: 1000 })), null,
  'a finished course stops being drawn');
assert.equal(state.orderQueues.size, 0, '...and is dropped');

// Something else took the hull -- an attack order, a rally, another client.
recordOrderQueue('s2', { x: 500, y: 500 }, false);
assert.equal(orderQueuePath(ship({ id: 's2', targetX: 4000, targetY: 4000 })), null,
  'a destination that matches no queued leg means the course no longer describes this ship');
assert.equal(state.orderQueues.size, 0);

// Appending with no course starts one; the cap is real.
recordOrderQueue('s3', { x: 1, y: 1 }, true);
for (let index = 0; index < MAX_QUEUED_WAYPOINTS + 5; index += 1) {
  recordOrderQueue('s3', { x: 100 + index, y: 1 }, true);
}
assert.equal(state.orderQueues.get('s3').length, MAX_QUEUED_WAYPOINTS + 1,
  'the drawn course never grows past the leg in flight plus the server-side cap');

// Dead and gone.
recordOrderQueue('s4', { x: 1, y: 1 }, false);
assert.equal(orderQueuePath(ship({ id: 's4', alive: false, targetX: 1, targetY: 1 })), null,
  'a dead ship has no course');
pruneOrderQueues(new Set());
assert.equal(state.orderQueues.size, 0, 'pruning drops courses for ships that are gone');

recordOrderQueue('s5', { x: 1, y: 1 }, false);
clearOrderQueues(['s5']);
assert.equal(state.orderQueues.size, 0, 'an order that is not a queued move ends the course');

console.log('Client order queue verification passed');
