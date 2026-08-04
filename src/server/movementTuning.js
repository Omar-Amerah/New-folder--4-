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

  // --- Command-time formations -------------------------------------------
  // The one visual gap between formation slots. Slot spacing itself is derived
  // from the physical collision radii of the ships being commanded, so this is
  // only the daylight left between two hulls parked side by side -- enough that
  // a formation does not arrive already touching, and no more.
  FORMATION_VISUAL_GAP: 24,

  // --- Hard collision / separation ---------------------------------------
  SEPARATION_BROAD_PHASE_PAD: 16,
  // A static or ship-contact correction may be collected by several
  // contacts in one authoritative tick. Keep that total bounded so a bad
  // spawn or dense pile-up is recovered over successive ticks instead of
  // becoming a visible one-frame relocation.
  STATIC_COLLISION_MAX_TICK_CORRECTION: 8,
  ASTEROID_QUERY_PAD: 128,

  // --- Navigation ---------------------------------------------------------
  NAV_GRID_CELL_SIZE: 24,
  NAV_STUCK_TIME_MS: 2500,
  NAV_WAYPOINT_CAPTURE_RATIO: 0.75,
  NAV_PROGRESS_EPSILON: 8,

  // --- Propulsion and drag ------------------------------------------------
  // Thrust is added to the velocity the ship already has, so the hull carries
  // momentum through a turn instead of having its velocity rebuilt along the
  // nose every step. Drag is what bounds that momentum, and it is expressed as
  // a per-frame retention raised to dt * DAMPING_REFERENCE_HZ, so the handling
  // does not change with the tick rate.
  DAMPING_REFERENCE_HZ: 60,
  // Cruising. Deliberately near-transparent: the effective maximum speed of the
  // hull is what caps a ship, and drag heavy enough to be the real limit would
  // quietly override every engine stat on the ship. It is here so an unpowered
  // coast eventually ends, not to set the top speed.
  TRAVEL_DAMPING: 0.9995,
  // Closing on the destination. Enough bite that the braking profile is not the
  // only thing shedding speed on the way in.
  APPROACH_DAMPING: 0.99,
  // How close to the arrival point counts as closing on it.
  APPROACH_DAMPING_DISTANCE: 85,
  // Parked, or asked to stop. Strong, so residual drift dies rather than being
  // carried into a slow wander around the destination.
  ARRIVED_DAMPING: 0.86,
  // Sideways momentum -- what a turn, a shove or a collision slide leaves the
  // hull carrying across its own nose. It decays on its own so a turning ship
  // arcs and then settles, rather than skating. This is the only drag that acts
  // across the hull; nothing here ever zeroes the component outright.
  LATERAL_DAMPING: 0.97,
  // With no working engine there is no propulsion and no lateral authority
  // either, so the whole vector coasts down at one gentle rate.
  UNPOWERED_DAMPING: 0.99917,
  // Forward thrust is at full throttle inside this much heading error, tapers
  // to nothing at 90 degrees, and is not applied at all beyond it: a ship whose
  // destination is behind it brakes and turns rather than driving further away.
  FULL_THRUST_HEADING_ERROR: Math.PI / 4,

  // --- Integration --------------------------------------------------------
  MAX_MOVEMENT_DT: 0.25,

  // --- Combat stance ------------------------------------------------------
  // Hold enters at the first usable firing envelope. This is an approach
  // threshold, not a station: once inside it the ship does not correct its range
  // and does not back away from anything.
  HOLD_RANGE_RATIO: 0.92,
  // Resume only after the target has opened beyond the usable range. The gap is
  // deliberate hysteresis, not a preferred combat distance.
  HOLD_RESUME_RATIO: 1.05,
  // A ship with nothing that reaches still has to stop somewhere short of
  // wearing its target as a hat.
  REPAIR_STANDOFF_PAD: 30,

  // --- Component heat from movement --------------------------------------
  ENGINE_HEAT_BASE: 2,
  ENGINE_HEAT_PER_THRUST: 0.018,
  MANEUVER_HEAT_PER_THRUST: 0.018
});
