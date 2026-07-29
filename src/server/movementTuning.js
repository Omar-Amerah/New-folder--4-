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
  //
  // This has to be measured against where a ship actually STOPS, not against the
  // destination: the braking profile reaches zero speed at ARRIVE_DISTANCE, so a
  // parked ship is already sitting a full ARRIVE_DISTANCE out. At 1.25 that left
  // 4 px of headroom, so a parked ship sat at 80% of its own tolerance and the
  // first neighbour to jostle it tipped it out -- whereupon it re-commanded a
  // crawl at the destination, and its nose followed that crawl. That was the
  // "turned for no reason on arrival" pirouette. 2.0 leaves a whole
  // ARRIVE_DISTANCE of slack on top of the stopping shortfall, which absorbs a
  // separation shove without the ship ever deciding it has been displaced.
  // A new order resets the phase to "travelling" (see setMovementCommand), so a
  // wider latch can never suppress a genuine short move.
  ARRIVE_LATCH_RATIO: 2,
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
  // How close the goal may get before its bearing stops meaning anything. Speed
  // alone is not a sufficient test for "under way": an intent that skips arrival
  // braking -- charge, most of all -- still commands cruise speed while standing
  // on its goal, so the ship reads as travelling while the point it is steering
  // at is a couple of pixels away. The bearing to a point that close swings
  // faster than the hull can follow, and the hull chasing it moves the ship,
  // which swings the bearing further: a charger parked on its target's hull
  // rotated a full turn every three and a half seconds without going anywhere.
  // Entering and leaving use different distances for the same reason the speed
  // test does -- one threshold makes a ship hovering at the boundary swap the
  // source of its facing every tick.
  FACING_MIN_GOAL_DISTANCE: 16,
  FACING_MIN_GOAL_DISTANCE_RELEASE: 8,
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
  //
  // This sets the ANGLE of the dodge, not its speed: applyLocalShipAvoidance
  // bounds the amended command by the intent's own throttle, so a ratio of 1
  // means the lateral term is comparable to the forward one -- a decisive swerve
  // -- and not, as it used to, a full-throttle broadside dash. Turning it down
  // was tried and is the wrong lever: it costs a heavy hull the lateral term it
  // needs to clear a light one, and buys nothing the magnitude bound has not
  // already bought.
  AVOIDANCE_MIN_LATERAL: 18,
  AVOIDANCE_SIDESTEP_RATIO: 1,
  // How much of the original course a give-way keeps. Giving way used to replace
  // the commanded velocity with the sidestep outright, which leaves a vector
  // perpendicular to the goal -- zero closing rate. A ship that gives way has to
  // still be going somewhere, or it slides sideways until the obstruction leaves,
  // and in a crowd the obstruction never leaves.
  AVOIDANCE_YIELD_COURSE_RETENTION: 0.35,

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
  // How far around the circle the aim point may slide looking for somewhere the
  // ship can actually be, before orbit gives up on this direction and reverses.
  // Six steps sweeps ~155 degrees, which clears anything short of an obstacle
  // that swallows half the ring -- and half the ring is a case where reversing
  // is the right answer anyway.
  //
  // The long slide looks wrong on paper: the ship flies the chord to its aim
  // point, and a chord subtending 155 degrees passes 0.22r from the centre, so
  // in principle a blocked near arc is an order to cut across the middle of the
  // orbit. Capping it was tried and measured worse on both cases that exercise
  // it. Pulling the aim point back lands it on the obstacle, and the route the
  // navigator then finds around the obstacle dives further inside the ring than
  // the chord ever did -- 205 px on a 507 px ring, against 434 px for the long
  // slide. Against a ring clipped by the world edge, capping forces a reversal
  // instead, and the hairpin cuts in to 104 px. Leave it long.
  ORBIT_LEAD_STEPS: 6,
  // Charge aims where the target will be, not where it is. Capped so a fast
  // target seen from across the map does not send the charger to empty space.
  CHARGE_LEAD_MAX_S: 1.5,
  // A charge deliberately skips arrival braking -- stopping ARRIVE_DISTANCE short
  // is exactly wrong for the stance whose purpose is contact. But arriving at the
  // contact ring at full throttle is just as wrong: separation actively holds the
  // pair apart, so the charger is shoved back out, re-accelerates into the same
  // wall, and oscillates about the target forever instead of sitting on its hull.
  // Throttle is tapered over the last CHARGE_SETTLE_TIME_S of closing instead, so
  // the ship still never stops short -- it just stops slamming.
  CHARGE_SETTLE_TIME_S: 0.55,
  // Zero at the contact ring itself. Any floor here is a permanent order to keep
  // driving into a hull the separation solver is already holding off, which is a
  // limit cycle by construction: the ship rams, gets pushed out, rams again. A
  // charger that has arrived should sit on its target and shoot; it picks the
  // throttle straight back up the moment the target opens the range.
  CHARGE_MIN_SPEED_FACTOR: 0,
  REPAIR_STANDOFF_PAD: 30,

  // --- Component heat from movement --------------------------------------
  ENGINE_HEAT_BASE: 2,
  ENGINE_HEAT_PER_THRUST: 0.018,
  MANEUVER_HEAT_PER_THRUST: 0.018
});
