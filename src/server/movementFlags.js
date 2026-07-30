"use strict";

// Order types the movement controller understands.
//
// The rewrite's temporary scaffolding has been removed: there is no fallback
// implementation to switch to any more, and the withdrawn combat stances are
// handled where stances actually live -- sanitizeCombatStyle in validation.js
// resolves Charge, Orbit and Kite to Hold, so no ship can end up carrying a
// stance nothing flies.
const SUPPORTED_MOVEMENT_TYPES = Object.freeze(["move", "stop", "attack", "repair"]);

module.exports = { SUPPORTED_MOVEMENT_TYPES };
