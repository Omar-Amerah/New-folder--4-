"use strict";

// Single home for every movement tunable, so the handling of the game can be
// changed from one file.
//
// Ship performance itself (thrust -> speed/accel/turn curves) is NOT here: that
// is derived in public/src/shared/movementStats.js, which the client mirrors for
// blueprint previews. Keep the split -- this file is "how the autopilot flies",
// that one is "what the hull is capable of".
//
// Constants specific to the controller's own behaviour -- route padding,
// waypoint capture, avoidance shaping -- live next to the code that uses them in
// movementV2.js. What is here is shared with collision, navigation and the
// combat stance.

module.exports = Object.freeze({
  // --- World bounds -------------------------------------------------------
  WORLD_MARGIN: 42,
  EDGE_BOUNCE_MARGIN: 43,
  EDGE_RESTITUTION: 0.3,

  // --- Arrival ------------------------------------------------------------
  ARRIVE_DISTANCE: 16,
  // A ship still doing 18 px/s when it declares itself arrived coasts well past
  // the point while it turns to its final heading.
  DESTINATION_ARRIVE_SPEED: 4,
  // How far a parked ship may be nudged off its destination before it bothers to
  // correct, measured against where a ship actually STOPS rather than the
  // destination: the braking profile reaches zero at ARRIVE_DISTANCE, so a
  // parked ship already sits that far out. Wide enough to absorb a separation
  // shove without the ship deciding it has been displaced and re-commanding a
  // crawl -- which its nose would then follow, for no visible reason.
  ARRIVE_LATCH_RATIO: 2,
  // Below this the hull is close enough to its commanded heading to report no
  // thruster activity. It does not gate the turn itself -- see turnTowardHeading.
  FINAL_FACING_TOLERANCE: 0.035,
  // Speed at or below which a ship asked to hold station is simply parked.
  // Converging on zero asymptotically never arrives, and there is no drag out
  // here to finish the job.
  REST_SPEED: 0.5,
  // Turn penalty while running on the backup core.
  BACKUP_CORE_TURN_SCALE: 0.9,

  // --- Hard collision / separation ---------------------------------------
  SEPARATION_ITERATIONS: 4,
  SEPARATION_SLOP: 0.2,
  SEPARATION_CORRECTION: 0.88,
  SEPARATION_MAX_BIAS_SPEED: 8,
  SEPARATION_BIAS_SCALE: 0.8,
  SEPARATION_MIN_IMPULSE_CAP: 20,
  SEPARATION_IMPULSE_HEADROOM: 12,
  SEPARATION_BROAD_PHASE_PAD: 192,
  ASTEROID_RESTITUTION: 1.5,
  ASTEROID_QUERY_PAD: 128,
  STOPPED_SPEED: 3,

  // --- Navigation ---------------------------------------------------------
  NAV_GRID_CELL_SIZE: 24,
  NAV_STUCK_TIME_MS: 1500,
  NAV_WAYPOINT_CAPTURE_RATIO: 0.75,
  NAV_PROGRESS_EPSILON: 8,

  // --- Integration --------------------------------------------------------
  MAX_MOVEMENT_DT: 0.25,

  // --- Combat stance ------------------------------------------------------
  // Hold closes to 80% of its reach and stops there. This is an approach
  // threshold, not a station: once inside it the ship does not correct its range
  // and does not back away from anything.
  HOLD_RANGE_RATIO: 0.8,
  // ...and only resumes the chase once the target has opened past 98%, so a
  // target loitering near the edge cannot make the ship start and abandon an
  // approach every second. The gap between the two is the whole dead band.
  HOLD_RESUME_RATIO: 0.98,
  // A ship with nothing that reaches still has to stop somewhere short of
  // wearing its target as a hat.
  REPAIR_STANDOFF_PAD: 30,

  // --- Component heat from movement --------------------------------------
  ENGINE_HEAT_BASE: 2,
  ENGINE_HEAT_PER_THRUST: 0.018,
  MANEUVER_HEAT_PER_THRUST: 0.018
});
