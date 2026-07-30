"use strict";

// The one entry point for ship movement. simulation.js, ships.js and
// messageRouter.js reach for movement through here and nothing else, so the
// implementation underneath can be swapped whole.
//
// movementV2.js is the rewritten controller and the default.
// movementFallback.js is the pre-rewrite stack, kept behind
// MFA_MOVEMENT_FALLBACK for as long as the rewrite is in progress.

const { movementFallbackEnabled } = require("./movementFlags");

module.exports = movementFallbackEnabled()
  ? require("./movementFallback")
  : require("./movementV2");
