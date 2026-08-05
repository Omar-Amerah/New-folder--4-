"use strict";

// Order types the movement controller understands.
//
// The rewrite's temporary scaffolding has been removed: there is no fallback
// implementation to switch to any more, and withdrawn combat stances are
// handled where stances actually live -- WITHDRAWN_COMBAT_STYLES in
// validation.js parks any stance the controller cannot fly on Hold, so no ship
// can end up carrying one nothing flies. Nothing is parked there now.
const SUPPORTED_MOVEMENT_TYPES = Object.freeze(["move", "stop", "attack", "repair"]);

// The shape a group order comes out of. There is exactly one: a compact clump,
// resolved once at command time (see movementFormations.js). The old line and
// wedge shapes are gone -- a line cannot approach anything without half of it
// being out of range, and a wedge spent the whole order overtaking itself.
//
// Kept here, next to the order types and with no dependencies of its own, so
// both the command planner and the per-ship runtime state can name the shape
// without importing each other.
const FORMATION_TYPES = Object.freeze(["clump"]);
const DEFAULT_FORMATION_TYPE = "clump";

// Anything that is not the one shape -- absent, unknown, or a "line"/"wedge"
// left over in an old client or a saved preference -- resolves to the clump
// rather than being rejected. There is nothing else to be.
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
