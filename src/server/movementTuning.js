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
  // --- Orbit obstacle avoidance -------------------------------------------
  // Avoidance is a committed manoeuvre, not a per-tick reaction. The ship
  // predicts far enough ahead to have somewhere to turn, commits to a route
  // round the obstacle, and rejoins the circle on the far side; it does not
  // abandon the route the instant the next few metres in front of it look
  // clear, because that is what walks a hull into the side of the rock.
  //
  // How long the helm is assumed to take to act, in seconds. Added to the
  // braking distance so detection happens while there is still room to turn
  // rather than only room to stop.
  ORBIT_AVOIDANCE_REACTION_TIME: 0.35,
  // How much further than its stopping distance the ship looks. At 1 it would
  // notice every obstacle exactly as it had to begin an emergency stop.
  //
  // What this buys is orbiting, not safety -- the braking ceiling and the pinch
  // margin are what stop the hull touching anything. Seeing the obstacle early
  // lets the response be a course correction; seeing it late forces one large
  // deviation per lap, and measurably so: past a large asteroid, halving this
  // cut angular progress from ten radians to three over the same thirty
  // seconds. A ship that spends the fight negotiating a rock is not orbiting.
  ORBIT_AVOIDANCE_MARGIN: 2,
  // Chords the predicted orbit path is sampled in. The path curves, so a single
  // straight sweep would both miss obstacles on the inside of the turn and
  // invent ones on the outside. The count follows the horizon so that a long
  // sweep is not sampled so coarsely that a chord cuts the corner off the arc
  // and passes straight over whatever is sitting on it.
  ORBIT_AVOIDANCE_STEP_LENGTH: 110,
  ORBIT_AVOIDANCE_MIN_STEPS: 3,
  ORBIT_AVOIDANCE_MAX_STEPS: 12,
  // Extra room a detour route is planned with, on top of the ordinary
  // navigation envelope. A detour is flown under momentum, round the outside of
  // a corner, so a route drawn along the edge of the ordinary envelope leaves a
  // hull tracking it a few pixels wide of the line in contact with the
  // obstacle. See routeClearance in movementV2.js.
  ORBIT_AVOIDANCE_ROUTE_PAD: 24,
  // Where a rejoin point may be placed, as arc ahead of the ship in its own
  // direction of travel. Tried in order, so the first reachable one is the
  // least deviation that works -- and a large station simply pushes the choice
  // further round rather than needing different logic.
  ORBIT_REJOIN_ARCS: Object.freeze([
    Math.PI / 4,
    Math.PI / 3,
    Math.PI / 2,
    Math.PI * 2 / 3,
    Math.PI * 5 / 6
  ]),
  // How close to the orbit radius, and how well aligned with the tangent, the
  // ship has to be before avoidance is released and live orbit steering resumes.
  // Loose enough that the hull does not have to be threaded back onto the circle
  // exactly, tight enough that it is genuinely orbiting when it takes over.
  ORBIT_REJOIN_RADIAL_TOLERANCE: 110,
  ORBIT_REJOIN_HEADING_TOLERANCE: 0.7,
  // Avoidance is re-planned on a cadence, never per tick.
  ORBIT_AVOIDANCE_REPLAN_MS: 1000,
  // ...immediately if the target has moved this far, because then the rejoin
  // point is no longer on the circle it was placed on...
  ORBIT_AVOIDANCE_TARGET_MOVE: 140,
  // ...and after this long if no rejoin point could be found at all, so a ship
  // boxed in for a moment retries at a bounded rate instead of running the
  // candidate search every tick.
  ORBIT_AVOIDANCE_RETRY_MS: 500,
  // How often a ship with nothing in the way sweeps its path again. The geometry
  // being swept never moves and the ship covers a small fraction of its horizon
  // in this long, so sweeping every tick is repeated work; the detection margin
  // above is what makes the delay free.
  ORBIT_AVOIDANCE_SCAN_MS: 150,
  // Halvings used to find how much clear room lies directly ahead of the hull.
  // Six brings a 600px sweep down to under ten pixels of uncertainty, for six
  // segment checks -- and only on the ticks where something is in the way at all.
  ORBIT_BRAKING_PROBE_STEPS: 6,
  // The crawl a hull that has ended up inside its own clearance envelope is
  // allowed, so the route can steer it back out. Slow enough that it cannot
  // cross the remaining margin into the obstacle, fast enough to be steerable.
  ORBIT_PINCH_ESCAPE_SPEED: 45,
  // Daylight the crawl above insists on keeping between the bare hull and the
  // obstacle. Small: this is a contact margin, not a comfortable standoff.
  ORBIT_PINCH_HULL_MARGIN: 10,

  // --- Kite ---------------------------------------------------------------
  // Kite is a travelling ranged stance: it holds its target near the far edge
  // of its main battery, runs when the range collapses, and closes only when
  // the target leaves that battery's reach. Like Orbit it never latches and is
  // never given a position by anything above it -- every constant here shapes
  // ONE ship's own band around its own target.
  //
  // There is no reverse thrust in the movement model, so "retreat" is a hull
  // heading with an outward component plus ordinary forward propulsion. A
  // rear-mounted gun is what lets that heading keep shooting; see the heading
  // search in movementV2.js, which scores mount bearings rather than assuming
  // the ship must look at what it is fighting.
  //
  // The band, as fractions of the main battery's all-heading reach. Preferred
  // sits inside the edge rather than on it, because a ship parked exactly on
  // its maximum range drops out of it every time the target drifts outward.
  KITE_PREFERRED_RANGE_RATIO: 0.9,
  // Below this the ship is being crowded and runs. The gap to preferred is the
  // hysteresis: without it a one-pixel range change would flip the mode.
  KITE_INNER_RANGE_RATIO: 0.78,
  // Above this the target has left the band and is worth closing on -- if
  // Pursue allows. Deliberately short of 1: re-approach has to start while the
  // guns still reach, not after they have stopped.
  KITE_OUTER_RANGE_RATIO: 0.96,

  // How far ahead the target's own motion is projected when deciding whether
  // the range is about to collapse. Short and bounded on purpose: this is
  // reaction time, not a prediction of where the fight will be.
  KITE_TARGET_PREDICTION_SECONDS: 0.6,
  // Range error -> desired opening speed. Under 1 so the correction eases onto
  // the preferred range instead of arriving at it under full power.
  KITE_RANGE_GAIN: 0.8,
  // Extra opening speed asked for on top of merely matching a closing target,
  // so a retreat actually gains ground rather than holding the gap.
  KITE_CLOSING_SPEED_BUFFER: 18,
  // Closing speed at which the target counts as pressing, whatever the current
  // range says.
  KITE_CLOSING_TRIGGER_SPEED: 16,

  // A retreat aim point is placed this far ahead: far enough that the hull has
  // somewhere to be going, short enough that it stays inside checked geometry.
  KITE_ESCAPE_LOOKAHEAD_MIN: 360,
  KITE_ESCAPE_LOOKAHEAD_SECONDS: 2,
  // The heading search is a cadence, never a per-tick decision. Between runs
  // the committed heading stands and only the aim point moves ahead of the hull.
  KITE_ESCAPE_REPLAN_MS: 500,
  // How often a committed plan re-checks that the ground it is flying over is
  // still clear.
  KITE_CLEAR_SCAN_MS: 150,
  // ...and immediately if the target has moved this far, because then the band
  // the plan was drawn for is somewhere else.
  KITE_TARGET_MOVE_REPLAN: 120,

  // Kite reacts to the world edge before touching it. Collision clamping at the
  // boundary is a safety net, not navigation: this inset is what keeps escape
  // destinations off the wall in the first place.
  KITE_EDGE_BUFFER_MIN: 120,
  // How hard proximity to that inset biases the heading choice back inward.
  KITE_EDGE_INWARD_BIAS: 0.35,

  // A new heading has to be this much better than the one being flown before it
  // is taken. This is what stops a ship alternating between two nearly equal
  // escape sides every few ticks.
  KITE_HEADING_IMPROVEMENT_RATIO: 0.12,
  // Floor on the outward projection used to convert a desired opening speed
  // into a forward speed. Without it a near-tangential heading divides by
  // nothing and asks for infinite thrust.
  KITE_MIN_ESCAPE_PROJECTION: 0.15,
  // Extra room a Kite detour route is planned with, on top of the ordinary
  // navigation envelope -- the same allowance and for the same reason as
  // ORBIT_AVOIDANCE_ROUTE_PAD.
  KITE_ROUTE_PAD: 24,

  // Daylight between the two hulls when the guns want a band so short that the
  // ship would otherwise be asked to stand inside its target.
  KITE_CONTACT_PADDING: 48,
  // How long a ship that could find nowhere safe to go waits before looking
  // again. Bounded, so being boxed in for a moment does not run the candidate
  // search every tick.
  KITE_BLOCKED_RETRY_MS: 500,

  // --- Component heat from movement --------------------------------------
  ENGINE_HEAT_BASE: 2,
  ENGINE_HEAT_PER_THRUST: 0.018,
  MANEUVER_HEAT_PER_THRUST: 0.018
});
