"use strict";

// The one entry point for ship movement. simulation.js, ships.js and
// messageRouter.js reach for movement through here and nothing else.
//
// The implementation is movementV2.js. This file stays as the seam: it is what
// let the controller be swapped out from under its callers during the rewrite,
// and it is what would let it happen again.

module.exports = require("./movementV2");
