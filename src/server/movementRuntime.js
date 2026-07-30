"use strict";

// Per-ship movement state. ships.js, players.js, combat.js and targetLocks.js
// all reach for ship.movement through here rather than at the implementation,
// so the shape of that state stays the controller's business.

module.exports = require("./movementRuntimeV2");
