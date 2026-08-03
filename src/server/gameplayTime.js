"use strict";

const { performanceNow } = require("./utils");

// Gameplay-time helper for external input handlers.
//
// When the fixed authoritative timestep is active, input handlers should stamp
// timers and durations using the room's authoritative simulation time instead
// of the wall clock. This prevents spawn protection, self-destruct, projectiles,
// effects and other gameplay timers from drifting after catch-up or discarded
// backlog. Rate limiting, telemetry, cleanup and networking continue to use wall
// time.
function gameplayNow(room, wallNow = performanceNow()) {
  // During a fixed step, internal simulation systems see the step's own
  // timestamp, not the one that was committed at the end of the previous step.
  const activeStep = room && Number(room._currentAuthoritativeStepTimeMs);
  if (Number.isFinite(activeStep) && activeStep > 0) return activeStep;
  const auth = room && Number(room._authoritativeTimeMs);
  return Number.isFinite(auth) && auth > 0 ? auth : wallNow;
}

module.exports = { gameplayNow };
