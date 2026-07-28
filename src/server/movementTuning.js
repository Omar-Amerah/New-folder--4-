"use strict";

// Single home for every movement tunable. Values that used to sit inline in
// movementController/movementPropulsion/movementBasic/movementCollision live
// here so the handling of the game can be tuned from one file.
//
// Ship performance itself (thrust -> speed/accel/turn curves) is NOT here: that
// is derived in public/src/shared/movementStats.js, which the client mirrors for
// blueprint previews. Keep the split -- this file is "how the autopilot flies",
// that one is "what the hull is capable of".

module.exports = Object.freeze({
  // --- World bounds -------------------------------------------------------
  WORLD_MARGIN: 42,
  EDGE_BOUNCE_MARGIN: 43,
  EDGE_RESTITUTION: 0.3,

  // --- Arrival ------------------------------------------------------------
  ARRIVE_DISTANCE: 16,
  // "Close enough to standing still" for combat range-keeping, where a ship
  // matching its target's velocity counts as on station.
  ARRIVE_SPEED: 18,
  // Arriving at a fixed destination is stricter: a ship still doing 18 px/s when
  // it declares itself arrived spends the next couple of seconds turning to its
  // final heading, and coasts well past the point while it does.
  DESTINATION_ARRIVE_SPEED: 4,
  // How far a parked ship may be nudged off its destination before it bothers
  // to correct. Wide enough to ignore a separation shove, narrow enough that it
  // never strands itself short of the point it was sent to.
  ARRIVE_LATCH_RATIO: 1.25,
  FINAL_FACING_TOLERANCE: 0.035,

  // --- Flight assist ------------------------------------------------------
  // Velocity decays toward the commanded velocity with this time constant.
  // Lower = crisper answer to the helm. This is the primary "responsiveness"
  // knob: at 0.12 a ship covers ~95% of a change of course in a third of a
  // second, bounded by whatever its engines can actually deliver.
  VELOCITY_TIME_CONSTANT_S: 0.12,
  // Speed at or below which a ship asked to hold station is simply parked.
  REST_SPEED: 0.5,
  // Commanded speed below which there is no meaningful direction of travel, so
  // the ship holds its heading rather than chasing a bearing that swings on
  // every small displacement. Entering and leaving that state use different
  // speeds: with one threshold, a ship hovering either side of it flips the
  // source of its facing every tick, and a hull that can turn fast enough
  // reproduces that flip exactly.
  FACING_MIN_SPEED: 5,
  FACING_MIN_SPEED_RELEASE: 3,
  // How far the newly computed facing must sit from the one already commanded
  // before the hull is told about it. Below this the previous command stands.
  // Without it a fast hull is a 1:1 follower of a signal that jitters with every
  // separation shove and every branch flip in resolveDesiredFacing.
  FACING_COMMAND_HYSTERESIS: 0.06,
  // Fraction of the remaining heading error the hull takes per tick once that
  // error is small enough to cover in one tick. Above that it is rate-limited as
  // before, so this only shapes the last few degrees -- the part a fast hull
  // used to cross in a single snap.
  TURN_COMMAND_DAMPING: 0.35,
  // Turn penalty while running on the backup core.
  BACKUP_CORE_TURN_SCALE: 0.9,

  // --- Ship avoidance (predictive, pre-collision) ------------------------
  AVOIDANCE_HORIZON_S: 1.15,
  AVOIDANCE_HORIZON_SPAWN_S: 1.8,
  AVOIDANCE_QUERY_MIN_RANGE: 120,
  AVOIDANCE_CLEARANCE_PAD: 6,
  AVOIDANCE_CLEARANCE_PAD_SPAWN: 12,
  // How long a ship commits to dodging left or right. Prevents the pair from
  // re-deciding every tick and shimmying against each other.
  AVOIDANCE_SIDE_COMMIT_MS: 700,
  AVOIDANCE_STRENGTH_YIELD: 1,
  AVOIDANCE_STRENGTH_EQUAL: 0.65,
  AVOIDANCE_STRENGTH_RIGHT_OF_WAY: 0.22,
  AVOIDANCE_BRAKE_TIME_S: 0.45,
  // Sidestep is a velocity offset, as a fraction of the ship's top speed scaled
  // by the strengths above, with a floor so near-stationary ships still edge out
  // of the way. It has to be a real swerve: a token nudge leaves a heavy ship
  // bulldozing whatever is in front of it rather than going round.
  AVOIDANCE_MIN_LATERAL: 18,
  AVOIDANCE_SIDESTEP_RATIO: 1,

  // --- Hard collision / separation ---------------------------------------
  SHIP_MASS_RIGHT_OF_WAY_RATIO: 1.35,
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
  NAV_REPLAN_MOVE_THRESHOLD: 60,
  NAV_REPLAN_COMBAT_THRESHOLD: 120,
  // A charge aims at a contact point roughly one hull across, so the 120 px
  // combat threshold is wider than the goal itself -- the charger would chase a
  // position the target left long ago.
  NAV_REPLAN_CHARGE_THRESHOLD: 40,
  NAV_STUCK_TIME_MS: 1500,
  NAV_WAYPOINT_CAPTURE_RATIO: 0.75,
  NAV_PROGRESS_EPSILON: 8,

  // --- Integration --------------------------------------------------------
  MAX_MOVEMENT_DT: 0.25,
  MOVEMENT_SUBSTEP: 1 / 30,

  // --- Combat style stand-off ratios -------------------------------------
  HOLD_RANGE_RATIO: 0.9,
  ORBIT_RANGE_RATIO: 0.9,
  KITE_RANGE_RATIO: 0.9,

  // --- Combat style shaping ----------------------------------------------
  // Orbit steers at a point on the circle this far ahead of the ship, measured
  // as an angle about the target. The ship therefore always flies toward the
  // ring itself, which corrects the radius without a separate controller.
  // Larger cuts the corner inward and flies a polygon; smaller tracks the
  // circle tightly but spends the whole orbit turning.
  ORBIT_LEAD_ANGLE: 0.45,
  // Charge aims where the target will be, not where it is. Capped so a fast
  // target seen from across the map does not send the charger to empty space.
  CHARGE_LEAD_MAX_S: 1.5,
  REPAIR_STANDOFF_PAD: 30,

  // --- Component heat from movement --------------------------------------
  ENGINE_HEAT_BASE: 2,
  ENGINE_HEAT_PER_THRUST: 0.018,
  MANEUVER_HEAT_PER_THRUST: 0.018
});
