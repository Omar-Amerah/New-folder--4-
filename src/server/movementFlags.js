"use strict";

// Order types the movement controller understands.
//
// The rewrite's temporary scaffolding has been removed: there is no fallback
// implementation to switch to any more, and the withdrawn combat stances are
// handled where stances actually live -- sanitizeCombatStyle in validation.js
// resolves Charge, Orbit and Kite to Hold, so no ship can end up carrying a
// stance nothing flies.
const SUPPORTED_MOVEMENT_TYPES = Object.freeze(["move", "stop", "attack", "repair"]);

// Shapes an ordinary move order may be given. They exist only at command time:
// see movementFormations.js. Kept here, next to the order types and with no
// dependencies of its own, so both the command planner and the per-ship runtime
// state can name them without importing each other.
const FORMATION_TYPES = Object.freeze(["line", "wedge", "clump"]);
const DEFAULT_FORMATION_TYPE = "line";

function sanitizeFormationType(value) {
  const type = String(value ?? "").toLowerCase();
  return FORMATION_TYPES.includes(type) ? type : DEFAULT_FORMATION_TYPE;
}

module.exports = {
  DEFAULT_FORMATION_TYPE,
  FORMATION_TYPES,
  SUPPORTED_MOVEMENT_TYPES,
  sanitizeFormationType
};
