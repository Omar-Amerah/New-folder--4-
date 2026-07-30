"use strict";

// Per-ship movement state, from whichever implementation is active.
//
// ships.js, players.js, combat.js and targetLocks.js all reach for ship.movement
// through this module, so the rewrite and its fallback can swap the shape of
// that state without those callers knowing. See movementFlags.js for the switch.

const { movementFallbackEnabled } = require("./movementFlags");

module.exports = movementFallbackEnabled()
  ? require("./movementRuntimeLegacy")
  : require("./movementRuntimeV2");
