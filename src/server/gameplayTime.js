"use strict";

const { performanceNow } = require("./utils");
const { FIXED_AUTHORITATIVE_TIMESTEP } = require("./performanceFlags");

// Gameplay-time helper for external input handlers.
//
// When the fixed authoritative timestep is active, input handlers should stamp
// timers and durations using the room's authoritative simulation time instead
// of the wall clock. This prevents spawn protection, self-destruct, projectiles,
// effects and other gameplay timers from drifting after catch-up or discarded
// backlog. Rate limiting, telemetry, cleanup and networking continue to use wall
// time.
function gameplayNow(room, wallNow = performanceNow()) {
  if (FIXED_AUTHORITATIVE_TIMESTEP()) {
    const auth = room && Number(room._authoritativeTimeMs);
    return Number.isFinite(auth) && auth > 0 ? auth : wallNow;
  }
  return wallNow;
}

module.exports = { gameplayNow };
