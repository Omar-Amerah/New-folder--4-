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

  // --- Friendly contact: shoving -----------------------------------------
  // A ship-to-ship contact is a shove, not a transfer of momentum. Sharing the
  // pair's normal speed by mass turns 120 into 0 into 60 and 60: the stationary
  // hull is launched at half cruising speed by being touched. What ships
  // actually do is bulldoze -- the one behind leans on the one in front, the
  // front hull creeps forward at walking pace, and both of them slow down.
  //
  // Fraction of the closing speed the pushed hull is asked to take on. Low,
  // because the rest is absorbed by the contact rather than shared.
  FRIENDLY_TRANSFER_RATIO: 0.25,
  // Ceiling on how hard contact alone may accelerate a hull, px/s^2, before the
  // mass ratio scales it. This is what makes a shove develop over half a second
  // instead of arriving as an impact.
  FRIENDLY_PUSH_ACCELERATION: 45,
  // ...and on the speed contact alone may give it: the smaller of this fraction
  // of its own maximum and the absolute cap. A ship already travelling faster
  // than that under its own power is NOT slowed to it -- the cap governs speed
  // the contact created, never the ship's own propulsion.
  FRIENDLY_PUSH_SPEED_RATIO: 0.2,
  FRIENDLY_PUSH_ABSOLUTE_CAP: 30,
  // How far the mass ratio may swing that acceleration. A heavy hull shifts a
  // light one easily; a light one barely moves a heavy one; neither is launched.
  FRIENDLY_PUSH_MASS_FACTOR_MIN: 0.25,
  FRIENDLY_PUSH_MASS_FACTOR_MAX: 2,
  // Closing speed left in the pusher afterwards. Without it the pair latches to
  // exactly equal speeds, the contact ends, and the engine behind re-establishes
  // it next tick -- which reads as juddering rather than as pushing.
  FRIENDLY_COMPRESSION_SPEED: 3,

  // --- Hard collision / separation ---------------------------------------
  SEPARATION_BROAD_PHASE_PAD: 16,
  // A static or ship-contact correction may be collected by several
  // contacts in one authoritative tick. Keep that total bounded so a bad
  // spawn or dense pile-up is recovered over successive ticks instead of
  // becoming a visible one-frame relocation.
  STATIC_COLLISION_MAX_TICK_CORRECTION: 8,
  // Overlap shallower than this is left alone. Two hulls resting against each
  // other sit a hair inside one another permanently, and correcting that every
  // tick is a standing shove that shows up as contact jitter.
  POSITION_SLOP: 0.5,
  // How much of the remaining overlap one tick takes out. Short of the whole
  // depth on purpose, so a correction converges over a couple of ticks instead
  // of overshooting into the ship on the other side.
  POSITION_CORRECTION_RATIO: 0.8,
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
  // Cruising, under power: none. What caps a ship is its effective maximum
  // speed, and any drag at all here is subtracted from its engines -- worst for
  // exactly the heavy, low-acceleration hulls that can least afford it. Ending
  // a coast is UNPOWERED_DAMPING's job, and that only applies to a ship with no
  // working drive, which is the only ship actually coasting.
  TRAVEL_DAMPING: 1,
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
  // Granularity of the weapon-aware correction to that threshold. The gate above
  // is measured from the hull centre, which carries no guns; the correction is
  // measured from the mounts and so shifts by a pixel or two every tick as the
  // ship closes. Quantising it downward keeps the resulting firing point stable
  // enough not to invalidate the route cache on every tick, and always errs
  // toward closing slightly further than strictly needed.
  HOLD_COVERAGE_STANDOFF_STEP: 8,
  // A ship with nothing that reaches still has to stop somewhere short of
  // wearing its target as a hat.
  REPAIR_STANDOFF_PAD: 30,

  // --- Orbit --------------------------------------------------------------
  // Orbit is a travelling stance, not a standing one: it never latches, never
  // stops, and never shares a position with another ship. Every constant here
  // shapes one ship's own circle around its own target.
  //
  // How much of the main battery's reach the orbit radius spends. The rest is
  // margin: a ship holding station exactly on its maximum range drops out of it
  // every time the target drifts outward, and an orbit is in constant lateral
  // motion, so it needs more slack than a stationary Hold does.
  ORBIT_RANGE_RATIO: 0.85,
  // Daylight between the two hulls when the guns want a radius so short that
  // the orbit would otherwise be flown through the target.
  ORBIT_CONTACT_PADDING: 48,
  // Radial error at which the steering asks for a full sideways correction.
  // Inside the band the correction tapers, which is what turns "get to the
  // radius" into a spiral rather than a series of turns toward and away.
  //
  // A settled orbit sits slightly outside its radius, because a hull travelling
  // at its turn-limited speed cannot curve tighter than it is already curving.
  // Narrowing this band pulls the settled radius back in; past roughly this
  // value it stops helping, since what is left is the turn limit rather than a
  // weak correction.
  ORBIT_CORRECTION_BAND: 120,
  // How hard a full correction pulls against the tangent. At 1 the desired
  // direction at maximum error is 45 degrees off the tangent -- closing briskly
  // while still going round, rather than driving straight at the target and
  // having to turn the whole way out again on arrival.
  ORBIT_RADIAL_GAIN: 1,
  // The virtual waypoint is this far ahead along the desired direction. It is a
  // steering aim point, never a destination the ship is trying to reach: it is
  // recomputed every tick from wherever the hull has got to, so the ship chases
  // a point that keeps moving away around the circle.
  ORBIT_LOOKAHEAD_DISTANCE: 180,
  // Fraction of the turn rate the orbit is allowed to consume. A circle flown
  // at exactly the turn-rate limit has no authority left for the radial
  // correction, gusts of separation, or a target that moves.
  ORBIT_TURN_MARGIN: 0.75,
  // Tangential speed at or below which a direction reversal is complete and the
  // ship may accelerate the new way round.
  ORBIT_REVERSAL_SPEED: 24,
  // ...or the heading error to the new tangent that also ends it, for a hull
  // agile enough to have come round before it finished shedding the old speed.
  ORBIT_REVERSAL_HEADING_TOLERANCE: 0.35,
  // How far round the circle a detour anchor is placed when an obstacle blocks
  // the direct line to the aim point, in radians of orbit arc. Far enough that
  // the route goes past the obstacle rather than into the near edge of it.
  ORBIT_DETOUR_ARC: Math.PI / 3,
  // Detours are re-planned on a cadence rather than per tick. The aim point
  // moves every tick by design, and feeding that to A* would invalidate the
  // route as fast as it could be built.
  ORBIT_DETOUR_REPLAN_MS: 750,
  // ...and immediately if the target has moved this far since the anchor was
  // placed, because then the anchor is no longer on the circle it was on.
  ORBIT_DETOUR_TARGET_MOVE: 120,

  // --- Component heat from movement --------------------------------------
  ENGINE_HEAT_BASE: 2,
  ENGINE_HEAT_PER_THRUST: 0.018,
  MANEUVER_HEAT_PER_THRUST: 0.018
});
