"use strict";

// The movement controller.
//
// A ship flies like a boat: it has one engine that pushes it along its nose and
// one turn rate that swings the nose. It cannot slide sideways and it cannot
// reverse, because nothing aboard could produce either force. Everything the
// autopilot does is therefore two numbers -- where to point and how fast to go
// -- and three steps applied to them:
//
//     turnTowardHeading(ship, desiredHeading, dt)
//     moveSpeedToward(ship, desiredSpeed, dt)
//     integratePosition(ship, dt)
//
// The controller has no other responsibilities. It holds no memory between
// ticks beyond the order itself, takes no special cases per combat stance, and
// contains no bang-bang branches -- every discontinuity ("brake now", "cut
// thrust now", "face the other way now") is a limit cycle at tick rate and
// reads to the player as jitter.
//
// How the two numbers are chosen for a move order:
//
//   * desiredHeading is the bearing to the destination. The ship does NOT have
//     to be pointing there before it may move.
//   * desiredSpeed is the fastest the ship may be going right now, throttled by
//     how well it is currently aligned:
//
//         remaining     = max(0, distance - ARRIVE_RADIUS)
//         safeArrival   = sqrt(2 * brakingAccel * remaining)
//         permitted     = min(maxSpeed, safeArrival, turnLimit)
//         alignment     = clamp(cos(headingError), 0, 1)
//         desiredSpeed  = permitted * alignment
//
//     Facing the destination gives full permitted speed. Partly aligned gives
//     less. More than 90 degrees off gives zero, so the ship turns rather than
//     accelerating away from where it was sent.
//
//     safeArrival is the speed from which the ship can still stop on the mark,
//     so braking falls out of the geometry instead of being switched on at a
//     threshold. turnLimit is what keeps a fast hull from circling a
//     destination it cannot turn tightly enough to hit.
//
//     desiredSpeed is a throttle, not a speed to be held. It says how fast the
//     engines may push; it does not ask the ship to shed speed it already has.
//     What it may keep is a second number:
//
//         speedCeiling  = permitted * momentumRetention(headingError)
//
//     and between the two the ship simply coasts. That band is what carries a
//     ship through a corner -- see momentumRetention.

const {
  angleDifference,
  clampNumber,
  compareEntityIds,
  fastHypot,
  performanceNow
} = require("./utils");
const { areEntityAllies, areEntityEnemies } = require("./relationships");
const { selectOwnedLivingShips } = require("./selection");
const { canTeamTargetEntity } = require("./visibility");
const {
  ARRIVE_DISTANCE,
  ARRIVE_LATCH_RATIO,
  DESTINATION_ARRIVE_SPEED,
  EDGE_BOUNCE_MARGIN,
  EDGE_RESTITUTION,
  FINAL_FACING_TOLERANCE,
  HOLD_RANGE_RATIO,
  HOLD_RESUME_RATIO,
  MAX_MOVEMENT_DT,
  REPAIR_STANDOFF_PAD,
  REST_SPEED,
  WORLD_MARGIN
} = require("./movementTuning");
const { getMaxEffectiveWeaponRange } = require("./componentData");
const {
  applyEngineHeat,
  applyTurnHeat,
  directionalTurnRate,
  driveAcceleration,
  hasDrive,
  heatAdjustedMovementStats,
  signedTurnRate
} = require("./movementCapability");
// Collision and separation are map geometry, not steering. Predictive
// avoidance lives in this file -- see computeAvoidance -- and emits a bounded
// offset rather than the world-space velocity the old solver used.
const {
  navigationClearanceRadius,
  physicalCollisionRadius,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  separationRadius,
  updateShipSeparation: resolveShipSeparation
} = require("./movementCollision");
const {
  isSegmentClear,
  navigationPlanningClearance,
  nearestClearPoint,
  searchPathWorld,
  segmentCircleClearance
} = require("./movementNavigation");
const {
  createMovementRuntime,
  ensureMovementRuntime,
  nextMovementCommandId,
  setManualRotation,
  setMovementCommand,
  syncMovementTarget
} = require("./movementRuntimeV2");
const { bumpMovementMetric } = require("./movementMetrics");
const { SUPPORTED_MOVEMENT_TYPES } = require("./movementFlags");

// --- Controller tuning -------------------------------------------------------
// Physics runs on a fixed substep so the result does not depend on how the
// server happened to slice the frame. A tick is divided into a whole number of
// substeps of this length, which makes 1x30Hz and 2x60Hz produce bit-identical
// trajectories rather than merely similar ones.
const MOVEMENT_SUBSTEP = 1 / 60;

// How far a ship that has declared itself arrived may be shoved -- by the
// separation solver, by a hull backing into it -- before it bothers to fly back.
// Measured against the arrival radius, not the destination: the braking profile
// reaches zero speed at ARRIVE_DISTANCE, so a parked ship is already sitting
// that far out and a tighter latch would have it correcting a shortfall it was
// asked to have.
const ARRIVE_LATCH_DISTANCE = ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO;

// Below this the bearing to the destination is numerical noise: the ship is on
// the spot and any heading computed from the remaining offset would spin it.
const BEARING_MIN_DISTANCE = 1;

// How quickly the hull settles the last of a heading error once the turn is no
// longer rate-limited. Short enough to be invisible on a real change of course,
// long enough that command noise never reaches the hull one-for-one.
const TURN_TIME_CONSTANT_S = 0.04;

// Stopping is not acceleration run backwards. Getting under way is limited by
// what the engines can push a loaded hull to; shedding speed is the same engines
// against a hull that is no longer being asked anywhere, plus every attitude
// thruster aboard pointed the other way. A ship can therefore lose speed a good
// deal faster than it gained it.
//
// Without this a corvette needs its entire acceleration run again to stop --
// 1408 px and five and a half seconds from cruise -- which is exactly what "the
// ships are on ice" is. The arrival profile is measured with the same figure, so
// a ship still comes to rest precisely on its mark; it simply holds cruise most
// of the way there instead of coasting down from a third of the map out.
const BRAKE_ACCEL_RATIO = 3;

// How far off the goal a ship may be pointing before it gives up speed it has
// already paid for. Inside this cone it coasts through the turn: the alignment
// throttle stops it *adding* speed it cannot use, which is all it was ever for,
// but there is no drag out here and nothing is gained by braking into a corner
// and re-accelerating out of it. Past the cone the goal is genuinely behind the
// ship, the momentum is being spent going the wrong way, and it is shed --
// smoothly, reaching zero when the goal is dead astern.
const MOMENTUM_HOLD_ANGLE = Math.PI / 2;

// How far a ship may be off the group's heading before it is allowed to steer
// by its own slot bearing instead. Inside this cone the formation heading is
// close enough to fly, so the group stays visually parallel; outside it the
// ship genuinely has to deviate to reach its slot.
const FORMATION_HEADING_TOLERANCE = 0.30;
const FORMATION_HEADING_SPREAD = 0.55;

// Grid spacing between destination slots, on top of the widest hull in the
// selection, so a capital and a corvette in the same order both get room.
const SLOT_SPACING_PAD = 12;

// --- Route following ---------------------------------------------------------
// How far ahead of a corner a ship starts cutting toward the next leg. Scaled by
// the hull's own clearance so a capital begins its turn earlier than a corvette,
// and by speed so a ship doing 500 px/s does not arrive at the corner still
// pointing at it.
const WAYPOINT_CAPTURE_RATIO = 0.75;

// --- Separation --------------------------------------------------------------
// Ship-on-ship collision is a circle, not a hull outline. A circle has no
// orientation, so a hull turning on the spot cannot overlap a neighbour by
// turning -- which is the whole of "turning is never blocked by nearby friendly
// ships", and it is the only change needed to get it.
//
// Note what is deliberately NOT changed: the correction strength. Softening it
// was tried, on the theory that gentler separation would keep a rotating group
// from being shoved about. It is unnecessary -- rotation now creates no overlap
// to correct in the first place -- and it is harmful: it leaves two hulls
// spawned on the same coordinate visibly interpenetrated for several ticks
// instead of recovering at once.
const SEPARATION_OPTIONS = Object.freeze({ circular: true });

// --- Predictive avoidance ----------------------------------------------------
// How far ahead to look for a closing threat. Long, because the horizon is also
// the detection threshold: predicted closest approach is evaluated at the
// clamped time, so a pair whose closest approach is further out than this reads
// as harmless and is not seen at all. A short horizon means a ship that only
// notices a collision it no longer has room to avoid.
const AVOID_HORIZON_S = 2.2;
// Daylight to aim for at the closest point, on top of both hulls. Small enough
// that ships still pass close, large enough that "avoided" does not mean
// "grazed and then pushed apart by the separation solver".
const AVOID_CLEARANCE_PAD = 40;
// The spatial query has to cover the pair's closing speed, not just this ship's.
// Two ships meeting head-on close at twice cruise, so a range sized on one
// ship's speed gives the yielding hull half the warning it needs -- measured as
// a head-on pass with 1.4 px to spare, which is separation doing the work rather
// than avoidance.
const AVOID_QUERY_SPEED_FACTOR = 1.6;
// ...but bounded. The honest radius for a head-on pair at full cruise is over
// 2000 px, and a query that wide in a crowded fight returns most of the room
// every tick for every ship. Capping it costs the fastest pairs a little warning
// and saves the broad phase from doing the work of a global scan.
const AVOID_QUERY_MAX_RANGE = 1100;
// The most the yielding ship will lean off its course. Deliberately modest:
// avoidance nudges a course, it does not replace it, and a ship that swerves
// hard is a ship that has left its route.
const AVOID_MAX_ANGLE = 0.55;
// ...and how far it will throttle back. Much freer than the heading, because
// slowing is the one response that cannot make an encounter worse: it costs the
// ship a little time and buys the pair separation whatever the geometry, while a
// bigger swerve trades one crossing for another. In the 90-degree case it is
// what actually resolves the pass -- the yielding hull drops back and lets the
// other cross in front.
const AVOID_MIN_SPEED_MULTIPLIER = 0.15;
// Once a side is picked it stands for this long, whatever else wanders into
// range. Re-deciding every tick is what makes a pair of ships shimmy.
const AVOID_SIDE_COMMIT_MS = 700;
// Below this a ship is manoeuvring on the spot rather than going anywhere, and
// nothing it does can be a collision course.
const AVOID_MIN_SPEED = 12;

// A destination that has moved less than this keeps the route it already has.
// Slots shift by a few pixels whenever a formation is re-solved, and replanning
// on that is pure waste.
const ROUTE_REPLAN_DISTANCE = 48;

// A ship that has not closed on its current waypoint for this long has been
// pushed off its route, or the route was never usable. Plan a new one.
const ROUTE_STUCK_MS = 1500;
const ROUTE_PROGRESS_EPSILON = 8;

function normalizeHullAngle(angle) {
  let normalized = angle % (Math.PI * 2);
  if (normalized <= -Math.PI) normalized += Math.PI * 2;
  if (normalized > Math.PI) normalized -= Math.PI * 2;
  return normalized;
}

// ---------------------------------------------------------------------------
// The three controller primitives
// ---------------------------------------------------------------------------

// Swing the nose toward `desiredHeading` at whatever rate the hull's remaining
// gyroscopes, maneuver thrusters and vectoring engines can manage in that
// direction. Turning left and right are separately rated, so battle damage can
// leave a ship that turns one way faster than the other.
//
// The last of the error is absorbed exponentially rather than landed on. Two
// things go wrong without that, and together they are the whole of "ships
// jitter while moving":
//
//   * A hull that can cover the remaining error in one step lands on the
//     commanded heading exactly, which means whatever noise is in the command
//     reaches the hull angle undamped.
//   * Worse, pairing an exact landing with a dead zone makes the ship quantise
//     its own course. It holds still while the bearing to its destination drifts
//     out to the tolerance, snaps the whole accumulated error off in one step,
//     and starts again -- a sawtooth in heading, and because velocity is rewritten
//     along the nose, a sawtooth in the direction of travel too. Measured at
//     0.0226 rad (1.3 degrees) per snap on a corvette flying a straight line.
//
// So the dead zone no longer gates the turn -- a proportional correction to a
// tiny error is itself tiny, which is all the dead zone was for. It gates only
// whether the manoeuvre is worth reporting as thruster activity, so trimming a
// hundredth of a radian does not light the maneuver jets or charge heat.
function turnTowardHeading(ship, desiredHeading, stats, dt) {
  if (!Number.isFinite(desiredHeading)) {
    ship.turnActivity = 0;
    return;
  }
  const before = ship.angle || 0;
  const difference = angleDifference(before, desiredHeading);
  const rate = directionalTurnRate(stats, before, desiredHeading, ship);
  const maxDelta = rate * dt;
  if (!(maxDelta > 0)) {
    ship.turnActivity = 0;
    return;
  }
  // Exponential approach with a fixed time constant, so the damping is the same
  // whatever size the substep is. A large error is rate-limited long before this
  // term binds, so a genuine change of course is as quick as the hull allows.
  const blend = 1 - Math.exp(-dt / TURN_TIME_CONSTANT_S);
  const step = clampNumber(difference * blend, -maxDelta, maxDelta);
  ship.angle = normalizeHullAngle(before + step);
  ship.turnActivity = Math.abs(difference) < FINAL_FACING_TOLERANCE
    ? 0
    : clampNumber(step / maxDelta, -1, 1);
  applyTurnHeat(ship, ship.turnActivity, dt);
}

// Hold I or O and the hull turns at its full rate in that direction for as long
// as the key is down, whatever the movement order is doing. The order keeps the
// helm; only the facing is taken away from it.
function applyManualRotation(ship, stats, dt) {
  const direction = ship.manualRotation === 1 ? 1 : -1;
  const rate = signedTurnRate(stats, direction, ship);
  if (!(rate > 0)) {
    ship.turnActivity = 0;
    return;
  }
  ship.angle = normalizeHullAngle((ship.angle || 0) + direction * rate * dt);
  ship.turnActivity = direction;
  applyTurnHeat(ship, ship.turnActivity, dt);
}

function brakingAcceleration(stats) {
  return driveAcceleration(stats) * BRAKE_ACCEL_RATIO;
}

// The fraction of its current speed a ship is allowed to keep while it is off
// course: all of it while the goal is anywhere ahead of the beam, tapering to
// none as the goal passes astern.
function momentumRetention(headingError) {
  const beyond = Math.abs(headingError) - MOMENTUM_HOLD_ANGLE;
  if (beyond <= 0) return 1;
  return clampNumber(1 - beyond / (Math.PI - MOMENTUM_HOLD_ANGLE), 0, 1);
}

// Bring the ship's speed inside the band the plan asked for.
//
// Three regimes, and the middle one is the whole point of having two numbers:
//
//   below desiredSpeed  -- the engines push
//   above speedCeiling  -- the engines brake
//   between the two     -- the ship carries the speed it already has
//
// The band is what a ship keeps through a turn. A single target makes the
// alignment throttle do double duty: it is meant to stop a ship accelerating
// along a heading it is about to leave, but as a target it also actively brakes
// away momentum that costs nothing to keep, so every course change becomes a
// stop and a fresh acceleration run.
//
// The ship's velocity is read back off the hull axis first. That is what folds
// in everything else that touched it -- a separation impulse, an asteroid
// bounce, the hull having turned since last step -- without this function
// needing to know any of it happened. Speed is then floored at zero: no engine
// points backwards, so a ship asked to be somewhere behind it turns around
// rather than reversing into it.
function moveSpeedToward(ship, desiredSpeed, speedCeiling, stats, dt) {
  const forwardX = Math.cos(ship.angle || 0);
  const forwardY = Math.sin(ship.angle || 0);
  const speed = (ship.vx || 0) * forwardX + (ship.vy || 0) * forwardY;
  // No working engines, no helm: the wreck coasts on the momentum it has. It
  // must not fall through to the driveAcceleration floor, which would let it
  // both accelerate and re-point its whole velocity along its nose.
  if (!hasDrive(stats)) return;

  const target = Math.max(0, desiredSpeed);
  const ceiling = Math.max(target, Number.isFinite(speedCeiling) ? speedCeiling : target);
  let requested = 0;
  if (speed < target) requested = target - speed;
  else if (speed > ceiling) requested = ceiling - speed;

  const available = (requested < 0 ? brakingAcceleration(stats) : driveAcceleration(stats)) * dt;
  const delta = clampNumber(requested, -available, available);
  let next = speed + delta;
  if (next < 0) next = 0;
  // Converging on zero asymptotically never gets there, and out here there is
  // no drag to finish the job -- so a ship asked to stop creeps off station a
  // pixel at a time forever. Park it outright instead.
  if (next < REST_SPEED && ceiling < REST_SPEED) next = 0;
  ship.vx = forwardX * next;
  ship.vy = forwardY * next;

  // Coasting is free -- and now genuinely free, since the band means a ship
  // holding its momentum through a turn is not thrusting at all.
  applyEngineHeat(ship, Math.min(1, Math.abs(requested) / Math.max(available, 1e-9)), dt);
}

function integratePosition(room, ship, dt) {
  const dx = (ship.vx || 0) * dt;
  const dy = (ship.vy || 0) * dt;
  ship.x = (ship.x || 0) + dx;
  ship.y = (ship.y || 0) + dy;
  ship._integratedMovementX = (ship._integratedMovementX || 0) + dx;
  ship._integratedMovementY = (ship._integratedMovementY || 0) + dy;
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  if (ship.x < EDGE_BOUNCE_MARGIN) {
    ship.x = EDGE_BOUNCE_MARGIN;
    ship.vx = Math.abs(ship.vx || 0) * EDGE_RESTITUTION;
  } else if (ship.x > width - EDGE_BOUNCE_MARGIN) {
    ship.x = width - EDGE_BOUNCE_MARGIN;
    ship.vx = -Math.abs(ship.vx || 0) * EDGE_RESTITUTION;
  }
  if (ship.y < EDGE_BOUNCE_MARGIN) {
    ship.y = EDGE_BOUNCE_MARGIN;
    ship.vy = Math.abs(ship.vy || 0) * EDGE_RESTITUTION;
  } else if (ship.y > height - EDGE_BOUNCE_MARGIN) {
    ship.y = height - EDGE_BOUNCE_MARGIN;
    ship.vy = -Math.abs(ship.vy || 0) * EDGE_RESTITUTION;
  }
}

function forwardSpeedOf(ship) {
  return (ship.vx || 0) * Math.cos(ship.angle || 0) + (ship.vy || 0) * Math.sin(ship.angle || 0);
}

function maxTurnRate(stats) {
  return Math.max(
    Number(stats.turnRateLeft) || 0,
    Number(stats.turnRateRight) || 0,
    Number(stats.turnRate) || 0
  );
}

// Who owns the ship's movement this tick.
//
// One ladder, resolved here and nowhere else:
//
//   Stop            -- an explicit halt stands until another order replaces it
//   Move            -- a player's destination, until the ship gets there
//   Engage (Hold)   -- the combat stance, on an explicit or automatic target
//   Idle            -- nothing to do
//
// Manual I/O rotation is deliberately absent: it overrides facing only, and it
// must not delete the order underneath it, so it is applied in the step rather
// than competing for authority here.
//
// A completed Move does not keep the helm. Once the ship has reached the point
// it was sent to, that order has been carried out, and Hold is free to take over
// against whatever it can see -- which is what makes "move there, then engage"
// work without the player issuing a second order.
function movementAuthority(runtime) {
  const command = runtime.command;
  if (command?.type === "stop") return "stop";
  if (command?.type === "move") return runtime.orderComplete ? "engage" : "move";
  return "engage";
}

// The target the stance should act on: the one the player named, else the one
// combat acquired on its own. Explicit always wins while it is valid.
function engagementTarget(room, ship, runtime) {
  const command = runtime.command;
  if (command?.type === "attack" || command?.type === "repair") {
    const explicit = trackedEntity(room, command.targetId);
    if (explicit) return { target: explicit, type: command.type, explicit: true };
    return null;
  }
  // Automatic acquisition is combat's job; it publishes its choice on the ship.
  // Movement only reads it -- targeting never issues movement of its own, it
  // only supplies the stance with something to act on.
  const automatic = trackedEntity(room, ship.combatTargetId);
  return automatic ? { target: automatic, type: "attack", explicit: false } : null;
}

// Once per tick, for a ship whose movement is the combat stance's to decide.
//
// The destination this produces is a consequence of the target, never a place
// the player clicked, and it is recomputed from the target's current position --
// so a target that runs is followed and a target that closes is simply held.
// Inside engagement range there is no destination at all, which is what makes
// Hold stand still and shoot rather than fussing over an exact distance.
function refreshEngagement(room, ship, runtime, now) {
  const command = runtime.command;
  const engagement = engagementTarget(room, ship, runtime);

  if (!engagement) {
    // An explicit order against a target that no longer exists is not an order.
    // Clearing it is what lets automatic acquisition take over next tick.
    if (command?.type === "attack" || command?.type === "repair") {
      setMovementCommand(ship, null);
      clearTargetReferences(ship);
      syncMovementTarget(ship);
    }
    runtime.holdEngaged = false;
    clearRoute(runtime);
    return;
  }

  const { target, type, explicit } = engagement;
  if (explicit) {
    // Keep combat's explicit-focus channel pointing at what the player named.
    // It is what makes the chosen target outrank automatic acquisition.
    if (type === "attack") {
      ship.focusTargetId = command.targetId;
      ship.combatTargetId = command.targetId;
    } else {
      ship.repairTargetId = command.targetId;
    }
  }

  const distance = fastHypot(target.x - (ship.x || 0), target.y - (ship.y || 0));
  const { enter, resume } = engagementRanges(ship, target, type);

  if (runtime.holdEngaged) {
    // Established. Only a target that has genuinely opened the range is worth
    // getting under way for again -- and nothing at all is worth backing away
    // from, however close it comes.
    if (distance <= resume) {
      clearRoute(runtime);
      return;
    }
    runtime.holdEngaged = false;
  } else if (canEngageFromHere(runtime, distance, enter, resume)) {
    runtime.holdEngaged = true;
    clearRoute(runtime);
    return;
  }

  runtime.destination = firingPosition(ship, target, runtime, command, enter);
}

// Is the ship close enough to settle here and open fire?
//
// A lone ship stops the moment it is inside its reach -- that is the whole of
// Hold, and there is nowhere in particular it needs to be.
//
// A ship with a place on a group's firing line has somewhere to be, and only
// counts as established once it has got there. Coming into range half way to
// its slot is not a reason to abandon it: doing that leaves ships stopped
// wherever they happened to cross the range ring, several of them parked across
// the paths of the ones still coming, and the formation never forms. Ships that
// were already in range when the order was given are latched at that moment
// instead (see issueAttack), so they never relocate to tidy the line -- which is
// the case that rule is actually for.
//
// The arrival test is against `resume`, not `enter`: a ship stops its arrival
// radius short of its slot, which is fractionally outside the range the slot was
// placed at, and a strict test there would never fire.
function canEngageFromHere(runtime, distance, enter, resume) {
  const slotted = Number.isFinite(runtime.command?.formationHeading);
  if (slotted) return runtime.arrived && distance <= resume;
  return distance <= enter || (runtime.arrived && distance <= resume);
}

// Where to stand to shoot: on the line from the target back toward the attacker,
// at the engagement range.
//
// The direction is fixed when the engagement begins and then held. Recomputing
// it from the ship's live position is a feedback loop -- the ship detours around
// an obstacle, which swings the firing position, which changes the detour -- and
// it walked ships into the very asteroids the route was avoiding. Fixing the
// bearing means the point only ever moves because the target moved.
//
// For a group the direction is shared, and each ship takes its own place across
// it. That is what makes a fleet form a firing line rather than a ring:
// measuring from each ship's own bearing spreads them evenly around the target,
// which looks wrong and cannot concentrate fire.
function firingPosition(ship, target, runtime, command, standoff) {
  if (Number.isFinite(command?.formationHeading)) {
    return firingPoint(target, command.formationHeading + Math.PI, command.firingLateral, standoff);
  }
  const held = runtime.engageApproach;
  if (held && held.targetId === target.id) {
    return firingPoint(target, held.approach, 0, standoff);
  }
  const approach = Math.atan2((ship.y || 0) - target.y, (ship.x || 0) - target.x);
  runtime.engageApproach = { targetId: target.id, approach };
  return firingPoint(target, approach, 0, standoff);
}

// A place on the firing line, at the engagement range from the target.
//
// The along-track distance is shortened to absorb the lateral offset, so every
// ship in the line ends up the same distance from the target rather than the
// outer ones sitting further out. Without that the wings of a six-ship line
// parked at sqrt(standoff^2 + lateral^2) -- measurably outside the range they
// were sent to -- so they never counted as engaged, never stopped fussing, and
// never turned to face what they were shooting at.
//
// The result is a shallow arc rather than a straight line. That is the point:
// a line whose ends are out of range is not a firing line. The lateral spread is
// capped so the formation stays on one side of the target and never wraps into
// a ring.
function firingPoint(target, approach, lateral, standoff) {
  const requested = Number.isFinite(lateral) ? lateral : 0;
  const offset = clampNumber(requested, -standoff * 0.7, standoff * 0.7);
  const along = Math.sqrt(Math.max(0, standoff * standoff - offset * offset));
  return {
    x: target.x + Math.cos(approach) * along - Math.sin(approach) * offset,
    y: target.y + Math.sin(approach) * along + Math.cos(approach) * offset
  };
}

function clearRoute(runtime) {
  runtime.destination = null;
  runtime.path = [];
  runtime.waypointIndex = 0;
  runtime.route = null;
}

// ---------------------------------------------------------------------------
// Routes around static obstacles
// ---------------------------------------------------------------------------
//
// Asteroids, stations and the world edge are the only things routed around.
// Other ships are deliberately absent from both the grid and the search: they
// move, so a route planned around where they are now is wrong by the time it is
// flown, and re-planning to follow them is how a fleet ends up recomputing A*
// every tick and still colliding. Ships are handled where they belong, by local
// avoidance and by physical separation.
//
// Obstacle geometry is inflated by navigationClearanceRadius -- the hull's own
// collision radius plus its navigation padding -- so a capital is routed through
// wider gaps than a corvette and neither scrapes along an edge.
//
// The controller never learns any of this. It is handed one point to steer at,
// and it cannot tell whether that point is the destination itself or a corner
// the search picked.

// Obstacles are inflated by the hull's collision radius plus navigation padding,
// so a capital is routed through wider gaps than a corvette.
//
// The padding has to cover more than the hull: it has to cover how far off the
// planned line the ship actually flies. A route is a polyline, a ship is not --
// it arcs onto each new leg at whatever its turn rate allows, and comes out
// measurably inside the corner. Measured at 411 px/s: 15 px off the segment,
// against a bare navigation margin of 9 px, which is a hull grazing an asteroid
// it was routed around and then being held on the surface by the collision
// solver. The extra pad is what turns "clear on paper" into "clear in flight".
const ROUTE_TRACKING_PAD = 16;

function routeClearance(ship) {
  return navigationClearanceRadius(ship) + ROUTE_TRACKING_PAD;
}

function routeWaypointIndex(runtime) {
  const path = runtime.path;
  if (!path || path.length === 0) return -1;
  return clampNumber(Math.floor(runtime.waypointIndex) || 0, 0, path.length - 1);
}

// How close is close enough to a corner. Scaled by the hull, so a capital starts
// cutting earlier than a corvette.
//
// Deliberately NOT scaled by speed. Leaving a waypoint behind is leaving the
// cleared corridor behind, and the corridor is only as wide as the clearance the
// route was planned with -- so a capture radius that grows with speed is a fast
// ship cutting the corner straight through the obstacle the corner existed to
// avoid. Measured: a corvette at 500 px/s took a 175 px capture radius and flew
// into the asteroid it was routing around, ending up in permanent contact.
//
// Turning early is bought instead by the turn-radius speed cap, which winds a
// ship down as it closes on any point it still has to swing away from, and by
// shortcutWaypoint, which skips ahead only when it has checked that the shortcut
// is actually clear.
function waypointCaptureRadius(ship) {
  return Math.max(ARRIVE_DISTANCE, routeClearance(ship) * WAYPOINT_CAPTURE_RATIO);
}

function planRoute(room, ship, runtime, destination, now) {
  const clearance = routeClearance(ship);
  let path;
  let reachable = true;

  if (isSegmentClear(room, ship.x, ship.y, destination.x, destination.y, clearance)) {
    // Nothing in the way: the destination is the whole route. An unobstructed
    // order must never acquire waypoints it does not need.
    path = [{ x: destination.x, y: destination.y }];
  } else {
    const search = searchPathWorld(room, ship.x, ship.y, destination.x, destination.y, clearance);
    path = search.waypoints.slice();
    reachable = search.reachedGoal;
    // The search starts at the cell the ship is standing in. Steering at where
    // you already are is a wasted leg, so drop it.
    if (path.length > 1) path.shift();
    if (path.length === 0) {
      // Nothing is routable from here -- the hull is too wide for any gap it
      // could reach. Hold station rather than invent a course through what the
      // search has just proved impassable.
      path = [{ x: ship.x, y: ship.y }];
      reachable = false;
    }
  }

  runtime.path = path;
  runtime.waypointIndex = 0;
  runtime.route = {
    commandId: runtime.command?.id || null,
    destination: { x: destination.x, y: destination.y },
    clearance,
    reachable,
    plannedAt: now,
    progressDistance: fastHypot(path[0].x - ship.x, path[0].y - ship.y),
    progressAt: now
  };
  bumpMovementMetric("pathReplanCount");
  if (!reachable) bumpMovementMetric("pathUnreachableCount");
}

// Replan only when the route it is flying has stopped being usable. Everything
// here is a fact about the world or the order, never about the ship's heading --
// a hull rotating on the spot must not be able to trigger a search.
function routeNeedsReplan(room, ship, runtime, destination, now) {
  const route = runtime.route;
  if (!route || !runtime.path?.length) return true;
  if (route.commandId !== (runtime.command?.id || null)) return true;
  if (route.clearance !== routeClearance(ship)) return true;
  if (fastHypot(destination.x - route.destination.x, destination.y - route.destination.y)
    > ROUTE_REPLAN_DISTANCE) return true;

  const index = routeWaypointIndex(runtime);
  const goal = runtime.path[index];
  // The leg being flown has become blocked -- by a station that finished
  // building, or because separation shoved the ship off the cleared corridor.
  if (!isSegmentClear(room, ship.x, ship.y, goal.x, goal.y, route.clearance)) return true;

  // No progress for long enough that something is wrong with the route rather
  // than with this moment.
  const distance = fastHypot(goal.x - ship.x, goal.y - ship.y);
  if (distance < route.progressDistance - ROUTE_PROGRESS_EPSILON) {
    route.progressDistance = distance;
    route.progressAt = now;
  }
  return distance > route.clearance && now - (route.progressAt || now) > ROUTE_STUCK_MS;
}

// Pure distance arithmetic over the cached route, so this is safe to run every
// substep: a waypoint reached half way through a tick is left behind half way
// through that tick, whatever size the tick was.
function advanceWaypointsByCapture(ship, runtime) {
  const path = runtime.path;
  if (!path || path.length === 0) return;
  let index = routeWaypointIndex(runtime);
  const capture = waypointCaptureRadius(ship);
  while (index < path.length - 1
    && fastHypot(ship.x - path[index].x, ship.y - path[index].y) < capture) {
    index += 1;
    bumpMovementMetric("waypointAdvanceCount");
  }
  runtime.waypointIndex = index;
}

// If the leg after this one is already reachable in a straight line, take it.
// The route was string-pulled when it was planned, but the ship drifts off it,
// and without this it flies back to a corner it no longer needs to round. Costs
// a segment query, so it belongs on the per-tick side.
function shortcutWaypoint(room, ship, runtime) {
  const path = runtime.path;
  if (!path || path.length === 0) return;
  const index = routeWaypointIndex(runtime);
  if (index >= path.length - 1) return;
  const next = path[index + 1];
  const clearance = runtime.route?.clearance ?? routeClearance(ship);
  if (isSegmentClear(room, ship.x, ship.y, next.x, next.y, clearance)) {
    runtime.waypointIndex = index + 1;
  }
}

// Ground still to cover along the whole remaining route, not just to the next
// corner. The braking profile is measured against this, which is what lets a
// ship round intermediate waypoints at speed and come to rest only at the end.
function routeRemainingDistance(ship, runtime, destination) {
  const path = runtime.path;
  if (!path || path.length === 0) {
    return fastHypot(destination.x - ship.x, destination.y - ship.y);
  }
  const index = routeWaypointIndex(runtime);
  let total = fastHypot(path[index].x - ship.x, path[index].y - ship.y);
  for (let i = index; i < path.length - 1; i += 1) {
    total += fastHypot(path[i + 1].x - path[i].x, path[i + 1].y - path[i].y);
  }
  return total;
}

// Slow down for a sharp corner: how fast the ship may take this waypoint and
// still have swung onto the next leg by the time it has crossed the capture
// circle. A gentle bend costs nothing.
function cornerSpeedLimit(ship, runtime, stats, capture) {
  const path = runtime.path;
  if (!path || path.length === 0) return Infinity;
  const index = routeWaypointIndex(runtime);
  const goal = path[index];
  const next = path[index + 1];
  if (!next) return Infinity;
  const incoming = Math.atan2(goal.y - ship.y, goal.x - ship.x);
  const outgoing = Math.atan2(next.y - goal.y, next.x - goal.x);
  const turn = Math.abs(angleDifference(incoming, outgoing));
  if (turn < FINAL_FACING_TOLERANCE) return Infinity;
  const rate = maxTurnRate(stats);
  return rate > 0 ? rate * Math.max(1, capture) / turn : Infinity;
}

// Once per tick: the expensive half. Decide whether the route is still usable,
// search for a new one if not, and take any straight-line shortcut the ship has
// drifted into. Everything here is a query against the world, so it must not run
// per substep -- and nothing here depends on where inside the tick the ship is,
// so it does not need to.
function resolveRoute(room, ship, runtime, now) {
  const destination = runtime.destination;
  if (!destination) {
    runtime.path = [];
    runtime.waypointIndex = 0;
    runtime.route = null;
    return false;
  }
  if (routeNeedsReplan(room, ship, runtime, destination, now)) {
    planRoute(room, ship, runtime, destination, now);
  } else {
    bumpMovementMetric("pathCacheHitCount");
  }
  shortcutWaypoint(room, ship, runtime);
  return true;
}

// Every substep: the cheap half. Which point are we steering at right now, how
// much ground is left, and how fast may we take the corner. All of it is
// arithmetic over the route the tick already decided on, which is what keeps the
// trajectory identical however the frame was sliced.
function routeView(ship, runtime, stats) {
  const destination = runtime.destination;
  if (!destination) return null;
  advanceWaypointsByCapture(ship, runtime);
  const index = routeWaypointIndex(runtime);
  const goal = (index >= 0 && runtime.path[index]) || destination;
  return {
    goal,
    isFinal: index < 0 || index >= runtime.path.length - 1,
    remaining: routeRemainingDistance(ship, runtime, destination),
    cornerLimit: cornerSpeedLimit(ship, runtime, stats, waypointCaptureRadius(ship)),
    reachable: runtime.route?.reachable !== false
  };
}

// ---------------------------------------------------------------------------
// Predictive local avoidance
// ---------------------------------------------------------------------------
//
// Only ships actually closing on each other are considered, and the answer is
// always a nudge to the course the ship already has:
//
//     { headingOffset, speedMultiplier }
//
// never a replacement velocity. That distinction is the whole design. A sideways
// velocity command becomes the ship's heading (the hull points where it is
// going), so a dodge computed that way swings the nose broadside and swings it
// back when the dodge ends -- ships that shimmy rather than pass. A bounded
// offset on top of the route leaves the ship on its route throughout, and when
// the threat clears the offset simply goes to zero.

function avoidanceClearance(a, b) {
  return physicalCollisionRadius(a) + physicalCollisionRadius(b) + AVOID_CLEARANCE_PAD;
}

// Exactly one ship of any pair gives way, and both sides agree on which without
// talking to each other. Mass first (a corvette yields to a capital), then who
// is actually under way, then id as a final tie-break. Antisymmetric by
// construction, so two ships can never both yield -- which is what leaves a
// crowd milling about, each waiting for the other.
function yieldsTo(ship, other) {
  const shipMass = Math.max(1, Number(ship.stats?.mass) || 1);
  const otherMass = Math.max(1, Number(other.stats?.mass) || 1);
  if (otherMass > shipMass * 1.35) return true;
  if (shipMass > otherMass * 1.35) return false;
  const shipMoving = Math.abs(forwardSpeedOf(ship)) > AVOID_MIN_SPEED;
  const otherMoving = Math.abs(forwardSpeedOf(other)) > AVOID_MIN_SPEED;
  if (shipMoving !== otherMoving) return shipMoving;
  return compareEntityIds(ship, other) > 0;
}

// The nearest threat by time to closest approach, or null. A neighbour that is
// merely nearby is not a threat: the pair has to be predicted to come inside
// their combined clearance while still closing.
function findAvoidanceThreat(room, ship, stats) {
  if (!room.spatialIndex?.dynamicValid || !room.spatialIndex.queryRangeUnordered) return null;
  const speed = Math.abs(forwardSpeedOf(ship));
  // A ship holding station or turning on the spot is not on a collision course
  // with anything. Without this, a hull rotating inside a packed formation reads
  // every stationary neighbour as an imminent threat and panics.
  if (speed < AVOID_MIN_SPEED) return null;

  const ownRadius = physicalCollisionRadius(ship);
  const range = Math.min(
    AVOID_QUERY_MAX_RANGE,
    ownRadius * 2 + Math.max(160, speed * AVOID_HORIZON_S * AVOID_QUERY_SPEED_FACTOR)
  );
  const scratch = ship._avoidanceScratch || (ship._avoidanceScratch = []);
  const nearby = room.spatialIndex.queryRangeUnordered("ships", ship.x, ship.y, range, scratch);

  let best = null;
  for (const other of nearby) {
    if (!other?.alive || other === ship) continue;
    const rx = other.x - ship.x;
    const ry = other.y - ship.y;
    const rvx = (other.vx || 0) - (ship.vx || 0);
    const rvy = (other.vy || 0) - (ship.vy || 0);
    const closingRate = rx * rvx + ry * rvy;
    // Opening the range already, or matched velocities: nothing to solve.
    if (closingRate >= 0) continue;
    const relativeSpeedSq = rvx * rvx + rvy * rvy;
    if (relativeSpeedSq < 1) continue;
    const time = clampNumber(-closingRate / relativeSpeedSq, 0, AVOID_HORIZON_S);
    const closestX = rx + rvx * time;
    const closestY = ry + rvy * time;
    const closest = fastHypot(closestX, closestY);
    const minimum = avoidanceClearance(ship, other);
    if (closest >= minimum) continue;
    const urgency = (minimum - closest) + (AVOID_HORIZON_S - time) * 10;
    if (!best || urgency > best.urgency
      || (urgency === best.urgency && compareEntityIds(other, best.other) < 0)) {
      best = { other, rx, ry, time, closest, minimum, urgency };
    }
  }
  return best;
}

// A bounded nudge, or the identity. Committed to a side for a fixed window so a
// dodge stands for its whole duration rather than being re-argued every tick.
function computeAvoidance(room, ship, stats, now) {
  const identity = { headingOffset: 0, speedMultiplier: 1 };
  const threat = findAvoidanceThreat(room, ship, stats);
  const state = ship._avoidance
    || (ship._avoidance = { side: 0, committedUntil: 0, severity: 0 });
  if (!threat) {
    state.side = 0;
    state.committedUntil = 0;
    state.severity = 0;
    return identity;
  }
  // Right of way: the other ship is giving way, so hold course. If both leaned
  // off, the pair would swap sides forever and neither would pass.
  if (!yieldsTo(ship, threat.other)) return identity;

  let side = now < (state.committedUntil || 0) ? state.side : 0;
  if (!side) {
    // Turn away from whichever side the other ship lies on, relative to where
    // this one is pointing.
    const forwardX = Math.cos(ship.angle || 0);
    const forwardY = Math.sin(ship.angle || 0);
    const cross = forwardX * threat.ry - forwardY * threat.rx;
    side = Math.abs(cross) > 0.01
      ? (cross > 0 ? -1 : 1)
      : (compareEntityIds(ship, threat.other) > 0 ? 1 : -1);
    state.side = side;
    state.committedUntil = now + AVOID_SIDE_COMMIT_MS;
  }

  // How badly the predicted pass misses, in [0, 1].
  //
  // Scaled so the response is already at full by the time the predicted miss is
  // half of what is wanted, rather than ramping linearly all the way from zero.
  // A response that fades out exactly as the predicted miss reaches the minimum
  // is a control loop whose set point is "just touching": the ship eases off the
  // moment it is barely going to clear, lag eats the rest, and the pair grazes.
  // Measured head-on with the linear ramp: 83 px of gap where 108 was wanted.
  const measured = clampNumber(
    (threat.minimum - threat.closest) / Math.max(1, threat.minimum * 0.5),
    0,
    1
  );
  // Commit the strength of the dodge, not just its side.
  //
  // The measured severity is a prediction of the miss, and the dodge is what
  // improves that prediction -- so a purely proportional response backs off the
  // instant it is barely going to clear, and the encounter settles at exactly
  // the wrong equilibrium: measured head-on and crossing passes both landed
  // within 1 px of hull contact, with the separation solver doing the actual
  // avoiding. Holding the peak for the commit window makes the ship follow the
  // manoeuvre through instead of talking itself out of it half way.
  const severity = now < (state.committedUntil || 0)
    ? Math.max(measured, state.severity || 0)
    : measured;
  state.severity = severity;
  bumpMovementMetric("avoidanceActivations");
  return {
    headingOffset: side * AVOID_MAX_ANGLE * severity,
    // Never above 1: avoidance may only ever slow a ship down. Speeding up to
    // beat a crossing hull is not avoidance, it is a race.
    speedMultiplier: 1 - (1 - AVOID_MIN_SPEED_MULTIPLIER) * severity
  };
}

// ---------------------------------------------------------------------------
// Deciding the two numbers
// ---------------------------------------------------------------------------

// The heading a ship travelling in a group should hold.
//
// Whenever its slot lies roughly along the group's course, the ship flies the
// group's heading -- that is what keeps a formation visually parallel instead
// of each hull aiming at its own point. When the slot is far enough off that
// course that flying it would not get the ship there, the bearing takes over
// and the ship deviates as much as it needs to.
//
// The handover is continuous in the deviation angle. A threshold would flip the
// commanded facing back and forth across the boundary, which on a fast hull is a
// ship that visibly shivers all the way to its slot.
//
// Note what this deliberately does NOT do: taper toward the formation heading as
// the ship closes. The alignment throttle is measured against the true bearing,
// so a ship held off that bearing near its slot is a ship whose permitted speed
// has been squeezed to nothing while it still has ground to cover -- it parks
// broadside, metres short, forever. Facing is handed to the formation only once
// the ship has actually arrived (see restingHeading).
function travelHeading(bearing, formationHeading) {
  if (!Number.isFinite(formationHeading)) return bearing;
  const deviation = angleDifference(formationHeading, bearing);
  const weight = clampNumber(
    (Math.abs(deviation) - FORMATION_HEADING_TOLERANCE) / FORMATION_HEADING_SPREAD,
    0,
    1
  );
  return normalizeHullAngle(formationHeading + deviation * weight);
}

// The heading a ship holds once it has nothing left to fly toward: the facing
// the order asked for, else the formation's course, else where it already
// points. Never a bearing derived from the destination -- a parked ship sitting
// its permitted few pixels short of the mark would spend the rest of the match
// pointing at it.
function restingHeading(ship, command) {
  if (Number.isFinite(command?.finalFacing)) return command.finalFacing;
  if (Number.isFinite(command?.formationHeading)) return command.formationHeading;
  return ship.angle || 0;
}

function bearingTo(ship, point) {
  return Math.atan2(point.y - (ship.y || 0), point.x - (ship.x || 0));
}

// ---------------------------------------------------------------------------
// Explicit targeting
// ---------------------------------------------------------------------------
//
// Targeting and movement are separate things that happen to be issued by the
// same click. Right-clicking an enemy names a target; it does not name a place
// to stand. What the ship then does about position is a consequence of the
// stance -- under Hold, close only far enough to bring weapons to bear, and no
// further.
//
// The explicit target is authoritative for as long as it lives and can be seen:
// combat.js honours ship.focusTargetId over anything its automatic acquisition
// would otherwise pick, and targetLocks.js drops it when sensor fog takes the
// contact away.

// How close this ship needs to be to fight, and how far the target may drift
// before it is worth chasing again.
//
// Hold approaches to 90% of its reach and stops. The 90% is an approach
// threshold, not a station to be maintained: once the ship is inside it, it
// stays put whatever the target does short of leaving. Two separate ratios give
// that behaviour a dead band -- without one, a target hovering near the edge
// makes the ship start and abandon an approach every second.
function engagementRanges(ship, target, type) {
  const reach = type === "repair"
    ? (Number(ship.stats?.repairRange) || 0)
    : getMaxEffectiveWeaponRange(ship);
  // A ship with nothing that reaches still has to stop somewhere short of
  // wearing its target as a hat.
  const contact = physicalCollisionRadius(ship) + physicalCollisionRadius(target) + REPAIR_STANDOFF_PAD;
  const enter = Math.max(contact, reach * HOLD_RANGE_RATIO);
  return { enter, resume: Math.max(contact, reach * HOLD_RESUME_RATIO) };
}

function trackedEntity(room, targetId) {
  if (!targetId) return null;
  const entity = room?.ships?.get?.(String(targetId))
    || room?.stationsById?.get?.(String(targetId))
    || null;
  return entity && entity.alive !== false ? entity : null;
}

// One plan per substep: where to point, how fast to go, and what phase to
// report. Pure -- it reads the world and the order and returns numbers; nothing
// here moves the ship.
function planMovement(room, ship, runtime, stats, route) {
  const command = runtime.command;
  const resting = { desiredHeading: restingHeading(ship, command), desiredSpeed: 0 };

  if (!command) return { ...resting, desiredHeading: ship.angle || 0, phase: "idle" };

  if (command.type === "stop") {
    // Stop preserves the hull's heading: turning to face the destination it was
    // just cancelled off would make the stop key a rotate key.
    //
    // A target is the one exception, and not really an exception at all -- the
    // ship has stopped moving, not stopped fighting, so it keeps its guns on
    // what it was engaging.
    const speed = Math.abs(forwardSpeedOf(ship));
    const engaged = engagementTarget(room, ship, runtime);
    const distance = engaged ? fastHypot(engaged.target.x - ship.x, engaged.target.y - ship.y) : 0;
    return {
      desiredHeading: engaged && distance > BEARING_MIN_DISTANCE
        ? bearingTo(ship, engaged.target)
        : (ship.angle || 0),
      desiredSpeed: 0,
      phase: speed > REST_SPEED ? "braking" : "positioned"
    };
  }

  const destination = runtime.destination;

  // No destination, but something to shoot at: the ship is in its firing
  // position. It stands its ground and faces what it is engaging so fixed
  // weapons bear. This covers both an explicit attack order and a target
  // acquired automatically, and it is reached the moment the stance decides the
  // ship is close enough -- there is nothing else Hold does once established.
  if (!destination) {
    const engaged = engagementTarget(room, ship, runtime);
    if (engaged) {
      const distance = fastHypot(engaged.target.x - ship.x, engaged.target.y - ship.y);
      return {
        desiredHeading: distance > BEARING_MIN_DISTANCE
          ? bearingTo(ship, engaged.target)
          : (ship.angle || 0),
        desiredSpeed: 0,
        phase: "positioned"
      };
    }
    return { ...resting, phase: "positioned" };
  }

  const distance = fastHypot(destination.x - (ship.x || 0), destination.y - (ship.y || 0));

  // Arrived and latched. Only a shove big enough to matter puts the ship back
  // under way, so a neighbour jostling it in a crowded formation cannot restart
  // a crawl -- and a crawl is what the nose would then follow.
  if (runtime.arrived) {
    if (distance <= ARRIVE_LATCH_DISTANCE) {
      return { ...resting, phase: "positioned" };
    }
    runtime.arrived = false;
  }

  const speed = forwardSpeedOf(ship);
  if (distance <= ARRIVE_DISTANCE && speed <= DESTINATION_ARRIVE_SPEED) {
    runtime.arrived = true;
    // A Move that has been flown is done with. Latching it here is what hands
    // the helm to the combat stance afterwards, and what stops the stance and
    // the stale Move order taking turns to drag the ship about.
    if (command.type === "move") runtime.orderComplete = true;
    return { ...resting, phase: "positioned" };
  }

  // The one point the controller steers at. It has no idea whether this is the
  // destination itself or a corner the search picked to get around an asteroid.
  const goal = route?.goal || destination;
  const goalDistance = fastHypot(goal.x - (ship.x || 0), goal.y - (ship.y || 0));
  const bearing = goalDistance > BEARING_MIN_DISTANCE
    ? bearingTo(ship, goal)
    : (ship.angle || 0);
  // Formation facing applies to the run as a whole, not to a detour: a ship
  // rounding an obstacle has to be free to point where the detour goes.
  const desiredHeading = route && !route.isFinal
    ? bearing
    : travelHeading(bearing, command.formationHeading);

  // Speed from the ground still to cover -- along the whole remaining route, so
  // intermediate waypoints are rounded at speed and the ship comes to rest only
  // at the end.
  const remainingToEnd = Math.max(0, (route ? route.remaining : distance) - ARRIVE_DISTANCE);
  const safeArrivalSpeed = Math.sqrt(2 * brakingAcceleration(stats) * remainingToEnd);

  // Speed from the geometry of the turn: a ship doing v with turn rate w flies
  // a circle of radius v/w, and if that circle is wider than the distance left
  // it can only orbit the point it was steering at. Capping v at w*distance
  // makes the turn always tight enough to close.
  const turnRate = maxTurnRate(stats);
  const turnLimit = turnRate > 0 ? turnRate * Math.max(goalDistance, ARRIVE_DISTANCE) : Infinity;

  // Alignment throttle: full speed pointing at the goal, nothing at all pointing
  // away from it. The ship accelerates gently out of a turn and hard once it is
  // on course, and it never has to stop and aim before setting off.
  const headingError = angleDifference(ship.angle || 0, bearing);
  const alignment = clampNumber(Math.cos(headingError), 0, 1);
  const permitted = Math.min(
    Number(stats.maxSpeed) || 0,
    // A group travels at the pace of its slowest hull, so the formation stays a
    // formation the whole way instead of only at the destination.
    Number.isFinite(command.formationSpeed) ? command.formationSpeed : Infinity,
    safeArrivalSpeed,
    turnLimit,
    route ? route.cornerLimit : Infinity
  );

  const desiredSpeed = permitted * alignment;
  // Every limit in `permitted` is a hard one -- the arrival profile, the turn
  // radius, the corner, the group's pace -- so the ceiling is the same figure.
  // Only the alignment term is relaxed into a coast band, because it is the only
  // one that is about where the ship is pointing rather than about what it will
  // hit.
  const speedCeiling = permitted * momentumRetention(headingError);
  return {
    desiredHeading,
    desiredSpeed,
    speedCeiling,
    // "Braking" is a report of what the ship is doing, not of where it is: a
    // hull holding a cruise a long way out is travelling even though the
    // arrival profile is already the binding limit on its speed. Measured
    // against the ceiling, since that is the figure the engines actually work
    // against -- coasting through a turn is not braking.
    phase: speedCeiling < speed - REST_SPEED ? "braking" : "travelling"
  };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

function initializeKinematics(ship) {
  if (!Number.isFinite(ship.x)) ship.x = 0;
  if (!Number.isFinite(ship.y)) ship.y = 0;
  if (!Number.isFinite(ship.vx)) ship.vx = 0;
  if (!Number.isFinite(ship.vy)) ship.vy = 0;
  if (!Number.isFinite(ship.angle)) ship.angle = 0;
  if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
  if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
}

function sanitizeMovementState(room, ship) {
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  ship.x = clampNumber(ship.x, EDGE_BOUNCE_MARGIN, width - EDGE_BOUNCE_MARGIN);
  ship.y = clampNumber(ship.y, EDGE_BOUNCE_MARGIN, height - EDGE_BOUNCE_MARGIN);
  ship.vx = clampNumber(ship.vx, -10000, 10000);
  ship.vy = clampNumber(ship.vy, -10000, 10000);
  ship.angle = normalizeHullAngle(Number(ship.angle) || 0);
  ship.targetX = clampNumber(ship.targetX, 0, width);
  ship.targetY = clampNumber(ship.targetY, 0, height);
}

function movementStep(room, ship, runtime, stats, routed, avoidance, dt) {
  const plan = planMovement(room, ship, runtime, stats, routed ? routeView(ship, runtime, stats) : null);

  // Avoidance amends the course; it never becomes the course. Applying it here,
  // on top of a finished plan, is what guarantees the ship is still flying its
  // route while it dodges -- and that when the threat clears, the offset goes to
  // zero and the original route is simply resumed.
  if (avoidance && (avoidance.headingOffset !== 0 || avoidance.speedMultiplier !== 1)) {
    plan.desiredHeading = normalizeHullAngle(plan.desiredHeading + avoidance.headingOffset);
    plan.desiredSpeed *= avoidance.speedMultiplier;
    // The ceiling comes down with the throttle. Slowing for a threat is a
    // decision to give up speed, not merely to stop adding it -- a ship that
    // coasted through it would arrive at the closest point just as fast.
    if (Number.isFinite(plan.speedCeiling)) plan.speedCeiling *= avoidance.speedMultiplier;
  }

  runtime.desiredHeading = plan.desiredHeading;
  runtime.desiredSpeed = plan.desiredSpeed;

  if (ship.manualRotation) {
    applyManualRotation(ship, stats, dt);
    // Manual rotation owns the facing but not the throttle. The plan's terms
    // were computed against the hull's own angle, so swinging off course stops
    // the engines pushing long before it costs the ship the speed it has: it
    // carries its momentum round, and only gives it up once the goal is behind
    // it. Which is what a ship that cannot thrust sideways would do.
    runtime.phase = plan.phase === "idle" ? "turning" : plan.phase;
  } else {
    turnTowardHeading(ship, plan.desiredHeading, stats, dt);
    runtime.phase = plan.phase;
  }

  moveSpeedToward(ship, plan.desiredSpeed, plan.speedCeiling, stats, dt);
  integratePosition(room, ship, dt);
  sanitizeMovementState(room, ship);
}

function updateShipMovement(room, ship, dt, now) {
  initializeKinematics(ship);
  const runtime = ensureMovementRuntime(ship);
  ship._collisionCorrectionX = 0;
  ship._collisionCorrectionY = 0;
  ship._integratedMovementX = 0;
  ship._integratedMovementY = 0;
  ship.turnActivity = 0;

  let safeDt = Number(dt);
  if (!Number.isFinite(safeDt) || safeDt <= 0) return;
  safeDt = Math.min(safeDt, MAX_MOVEMENT_DT);
  ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);

  const stats = heatAdjustedMovementStats(ship, ship.stats || {});
  bumpMovementMetric("movementCapabilityBuilds");

  // Routing is strategy, not physics: it is resolved once per tick and the same
  // answer is flown by every substep. Re-running a path search inside the
  // integration loop buys nothing and costs a search per substep.
  const authority = movementAuthority(runtime);
  if (authority === "engage") {
    // The stance turns a target into a destination only while the ship is out of
    // range; in range it produces none and the ship holds station and fires.
    refreshEngagement(room, ship, runtime, ship._simNow);
  } else if (authority === "stop") {
    runtime.holdEngaged = false;
    clearRoute(runtime);
  }

  const routed = runtime.destination
    ? resolveRoute(room, ship, runtime, ship._simNow)
    : false;
  if (!routed && runtime.path?.length) {
    runtime.path = [];
    runtime.waypointIndex = 0;
    runtime.route = null;
  }

  // Also once per tick: the spatial query is the expensive part, and a threat
  // that is worth dodging does not appear and vanish inside a single frame.
  const avoidance = computeAvoidance(room, ship, stats, ship._simNow);

  // Ceil, not round: the substep is an upper bound on integration error, and a
  // tick that rounded down would silently integrate more coarsely than the rest.
  // A tick that is a whole multiple of the substep -- 30 Hz, 60 Hz, 20 Hz --
  // divides exactly, so those cadences produce bit-identical trajectories.
  const steps = Math.max(1, Math.ceil(safeDt / MOVEMENT_SUBSTEP - 1e-9));
  const stepDt = safeDt / steps;
  for (let index = 0; index < steps; index += 1) {
    bumpMovementMetric("sharedControllerRuns");
    movementStep(room, ship, runtime, stats, routed, avoidance, stepDt);
  }

  // Asteroids, stations and the world edge are resolved once per tick rather
  // than per substep: the substeps are short enough that nothing tunnels, and
  // the map query is the expensive part of the loop.
  resolveMapCollision(room, ship);
  syncMovementTarget(ship);
}

// Physical separation is the fallback, not the steering. Predictive avoidance
// above keeps ships from meeting; this resolves the overlaps that happen anyway
// -- a ship shoved by a third party, a hull spawning into a crowd -- using
// circles, so it can only ever undo positional overlap and never opposes a turn.
function updateShipSeparation(room, ships, dt, now = 0) {
  return resolveShipSeparation(room, ships, dt, now, SEPARATION_OPTIONS);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function clearTargetReferences(ship) {
  ship.focusTargetId = null;
  ship.combatTargetId = null;
  ship.repairTargetId = null;
}

function issueMove(ship, commandId, destination, options = {}) {
  clearTargetReferences(ship);
  setMovementCommand(ship, {
    id: `${commandId}:${ship.id}`,
    type: "move",
    destination,
    formationHeading: options.formationHeading,
    formationSpeed: options.formationSpeed,
    finalFacing: options.finalFacing,
    manual: options.manual
  });
  syncMovementTarget(ship);
}

// Stop halts the ship. It deliberately does not clear what the ship is aiming
// at: "stop moving" and "stop shooting" are different orders, and a ship told to
// hold position while engaging should keep tracking and firing at its target
// from where it now stands.
function issueStop(ship, commandId, manual = true) {
  setMovementCommand(ship, { id: `${commandId}:${ship.id}`, type: "stop", manual });
  syncMovementTarget(ship);
}

function issueAttack(room, ship, commandId, targetId, now, options = {}) {
  const target = trackedEntity(room, targetId);
  const viewerTeam = room?.players?.get?.(ship.ownerId)?.team ?? ship.team ?? ship.ownerId;
  clearTargetReferences(ship);
  if (target && room && !canTeamTargetEntity(room, viewerTeam, target, now)) return false;
  ship.combatTargetId = targetId;
  ship.focusTargetId = targetId;
  setMovementCommand(ship, {
    id: `${commandId}:${ship.id}`,
    type: "attack",
    targetId,
    formationHeading: options.formationHeading,
    firingLateral: options.firingLateral,
    manual: true
  });
  // A ship that could already shoot the target when the order arrived is
  // established where it stands. It does not relocate to make the firing line
  // tidier -- that is movement for its own sake, and the player watching it
  // sees a ship that was already fighting break off to shuffle sideways.
  if (target) {
    const runtime = ensureMovementRuntime(ship);
    const distance = fastHypot(target.x - (ship.x || 0), target.y - (ship.y || 0));
    if (distance <= engagementRanges(ship, target, "attack").enter) runtime.holdEngaged = true;
  }
  syncMovementTarget(ship);
  return true;
}

// Places on the firing line for a group attacking one target.
//
// Spaced across the line rather than around the enemy: a ring means half the
// fleet is shooting through the other half, and it reads as ships circling
// something they are supposed to be shooting. Assignment is by each ship's
// current position across the line, so nobody crosses anybody, and it is stable
// -- the same selection attacking the same target twice gets the same places.
//
// Ships already in range simply never use theirs: the stance stops them where
// they stand, so ordering an attack does not make a fleet that is already
// engaged shuffle into a tidier line.
function assignFiringLine(ships, target) {
  const lateral = new Map();
  if (ships.length < 2) return { lateral, approach: null };
  const centre = fleetCentre(ships);
  const approach = Math.atan2(target.y - centre.y, target.x - centre.x);
  const acrossX = -Math.sin(approach);
  const acrossY = Math.cos(approach);
  const ordered = ships.slice().sort((a, b) => {
    const acrossA = a.x * acrossX + a.y * acrossY;
    const acrossB = b.x * acrossX + b.y * acrossY;
    if (Math.abs(acrossA - acrossB) > 0.001) return acrossA - acrossB;
    return compareEntityIds(a, b);
  });
  const widest = ordered.reduce((largest, ship) => Math.max(largest, separationRadius(ship)), 18);
  const spacing = widest * 2 + SLOT_SPACING_PAD;
  for (let index = 0; index < ordered.length; index += 1) {
    lateral.set(ordered[index].id, (index - (ordered.length - 1) / 2) * spacing);
  }
  return { lateral, approach };
}

function issueRepair(ship, commandId, targetId) {
  clearTargetReferences(ship);
  ship.repairTargetId = targetId;
  setMovementCommand(ship, { id: `${commandId}:${ship.id}`, type: "repair", targetId, manual: true });
  syncMovementTarget(ship);
}

// --- Formation ---------------------------------------------------------------

// Slots for a group.
//
// The formation the player has on screen is the formation they get at the
// destination, in the same orientation. The whole selection is translated: each
// ship's offset from the group's centre is carried over unchanged, so a block
// that looks three wide and two deep arrives three wide and two deep, whatever
// direction it travelled to get there.
//
// This is not cosmetic. Because every ship's slot is the same translation of its
// own position, every ship flies the same vector -- no two approach paths cross,
// and the group is rigid from the moment it sets off rather than tangling in the
// middle and arriving as a crowd.
//
// It also rules out two things that were tried and were wrong:
//
//   * Rotating the layout to match the new course. It makes a line abreast
//     arrive as a column, which is not what the player pointed at, and it makes
//     the arrangement depend on which way the hulls happened to be facing.
//   * Scaling the whole formation up to open out a tight group. One close pair
//     scales every other ship's offset by the same factor, so relieving a 10 px
//     overlap in the middle flings the outer ships hundreds of pixels apart.
//     Overlaps are relaxed locally instead -- see relaxSlotSpacing.
//
// Fallback grid, used only when the selection has no shape worth keeping --
// everything piled on one point, as it is when a hangar has just launched a
// batch.
function formationSlotLayout(count, spacing) {
  if (count <= 1) return [{ across: 0, along: 0 }];
  const columns = Math.ceil(Math.sqrt(count));
  const offsets = [];
  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const inRow = Math.min(columns, count - row * columns);
    offsets.push({
      across: (column - (inRow - 1) / 2) * spacing,
      along: -row * spacing
    });
  }
  return offsets;
}

function slotClearOfOthers(point, radius, assigned) {
  for (const entry of assigned) {
    if (fastHypot(point.x - entry.x, point.y - entry.y) < radius + entry.radius + 4) return false;
  }
  return true;
}

// A slot the ship can actually be sent to: clear of the map by the planner's own
// standard, and not on top of a slot already handed out. A slot that only
// satisfies the hull clearance is one the route planner would quietly relocate
// later, leaving the ship parked somewhere the player never clicked while the
// order marker sat elsewhere.
//
// The search stays deliberately close to home. Ranging further to find a
// perfectly clear, perfectly unshared point is how a formation ends up scattered
// across the map to relieve a small overlap; the relaxation pass has already
// spaced the layout, so anything left is a genuine obstacle and half a spacing
// of give is enough. If even that fails, take the nearest clear point and accept
// the overlap -- the separation solver settles a few pixels quietly, whereas a
// ship sent 600 px off station is something the player watches happen.
function resolveSlot(room, desired, ship, assigned, ordinal, spacing) {
  const radius = separationRadius(ship);
  const clearance = navigationPlanningClearance(ship);
  let fallback = null;
  for (let attempt = 0; attempt < 17; attempt += 1) {
    const ring = attempt === 0 ? 0 : Math.ceil(attempt / 8);
    const turn = attempt === 0 ? 0 : (attempt - 1) % 8;
    const angle = turn * Math.PI / 4 + ordinal * 0.173;
    const clear = nearestClearPoint(
      room,
      desired.x + Math.cos(angle) * ring * spacing * 0.5,
      desired.y + Math.sin(angle) * ring * spacing * 0.5,
      clearance
    );
    if (!clear.clear) continue;
    if (!fallback) fallback = { x: clear.x, y: clear.y, radius };
    if (!slotClearOfOthers(clear, radius, assigned)) continue;
    return { x: clear.x, y: clear.y, radius };
  }
  return fallback;
}

function fleetCentre(ships) {
  let x = 0;
  let y = 0;
  for (const ship of ships) {
    x += Number(ship.x) || 0;
    y += Number(ship.y) || 0;
  }
  return { x: x / ships.length, y: y / ships.length };
}

// One heading for the whole selection, from where the group is to where it was
// sent. Every ship in the order carries it, and it is what they hold on arrival.
//
// A lone ship is not a formation and gets none: nothing about where it happens
// to be standing when the order is given should govern where it points once it
// gets there, so it simply keeps the heading it arrived on.
function formationHeadingFor(ships, destination) {
  if (!ships || ships.length < 2) return null;
  const centre = fleetCentre(ships);
  const dx = destination.x - centre.x;
  const dy = destination.y - centre.y;
  return fastHypot(dx, dy) > BEARING_MIN_DISTANCE ? Math.atan2(dy, dx) : null;
}

// A group travels at the pace of its slowest hull.
//
// Without this a selection only *starts* as a formation: the corvettes are gone
// inside a second and the capital arrives half a minute later, so the shape the
// slots so carefully preserved is never actually seen in flight. Holding the
// whole group to the slowest permitted speed keeps the arrangement rigid the
// entire way, which is the point of ordering a formation rather than six ships.
//
// Taken once, at the moment the order is given. Re-deriving it every tick would
// need every ship in the group to be looked up from every other ship's update,
// and a hull that takes engine damage mid-transit slowing the whole fleet is not
// obviously better than it simply falling behind.
function formationCruiseSpeed(ships) {
  if (!ships || ships.length < 2) return null;
  let slowest = Infinity;
  for (const ship of ships) {
    const speed = Number(ship?.stats?.maxSpeed) || 0;
    // A hull with no working engines cannot set the pace for everyone else --
    // it is not going anywhere and the rest of the group still has an order.
    if (speed > 0) slowest = Math.min(slowest, speed);
  }
  return Number.isFinite(slowest) ? slowest : null;
}

// The selection's shape, exactly as it stands. Null when there is nothing worth
// keeping -- a lone ship, or a group whose hulls are all on the same point, as a
// freshly launched batch is.
function preservedFormationOffsets(ships) {
  if (ships.length < 2) return null;
  const centre = fleetCentre(ships);
  const offsets = ships.map((ship) => ({
    x: (ship.x || 0) - centre.x,
    y: (ship.y || 0) - centre.y
  }));
  let widest = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    for (let j = i + 1; j < offsets.length; j += 1) {
      widest = Math.max(widest, fastHypot(offsets[i].x - offsets[j].x, offsets[i].y - offsets[j].y));
    }
  }
  return widest > 1 ? offsets : null;
}

// Open out only the pairs that are actually too close, by pushing each of them
// half the shortfall apart, a few times. Local and symmetric: a tight pair in
// the middle of a formation separates without the ships on the outside moving at
// all, which is what scaling the whole layout got wrong.
function relaxSlotSpacing(offsets, radii, spacing) {
  const points = offsets.map((offset) => ({ x: offset.x, y: offset.y }));
  for (let pass = 0; pass < 8; pass += 1) {
    let worst = 0;
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const required = Math.max(spacing, radii[i] + radii[j] + SLOT_SPACING_PAD);
        let dx = points[j].x - points[i].x;
        let dy = points[j].y - points[i].y;
        let distance = fastHypot(dx, dy);
        if (distance >= required) continue;
        if (distance < 1e-6) {
          // Exactly coincident: separate along a fixed axis chosen by index so
          // the result does not depend on floating-point noise.
          dx = Math.cos(i * 2.399963);
          dy = Math.sin(i * 2.399963);
          distance = 1;
        }
        const push = (required - distance) / 2;
        worst = Math.max(worst, push);
        const nx = dx / distance;
        const ny = dy / distance;
        points[i].x -= nx * push;
        points[i].y -= ny * push;
        points[j].x += nx * push;
        points[j].y += ny * push;
      }
    }
    if (worst < 0.5) break;
  }
  return points;
}

function generateDestinationSlots(room, ships, destination, heading = null) {
  const living = ships.filter((ship) => ship?.alive !== false);
  const slots = new Map();
  if (living.length === 0) return slots;

  const course = Number.isFinite(heading)
    ? heading
    : (formationHeadingFor(living, destination) ?? 0);
  const acrossX = -Math.sin(course);
  const acrossY = Math.cos(course);
  const alongX = Math.cos(course);
  const alongY = Math.sin(course);

  // Resolve slots in a fixed order -- across the course, then along it, then by
  // id -- so that when two of them do have to be nudged apart, which one moves
  // is a pure function of the fleet's geometry. Reissuing the same order from
  // the same positions therefore produces exactly the same slots.
  const ordered = living.slice().sort((a, b) => {
    const acrossA = a.x * acrossX + a.y * acrossY;
    const acrossB = b.x * acrossX + b.y * acrossY;
    if (Math.abs(acrossA - acrossB) > 0.001) return acrossA - acrossB;
    const alongA = a.x * alongX + a.y * alongY;
    const alongB = b.x * alongX + b.y * alongY;
    if (Math.abs(alongA - alongB) > 0.001) return alongB - alongA;
    return compareEntityIds(a, b);
  });

  const radii = ordered.map((ship) => separationRadius(ship));
  const widest = radii.reduce((largest, radius) => Math.max(largest, radius), 18);
  const spacing = widest * 2 + SLOT_SPACING_PAD;
  const preserved = preservedFormationOffsets(ordered);
  const layout = preserved
    ? relaxSlotSpacing(preserved, radii, spacing)
    : formationSlotLayout(ordered.length, spacing).map((offset) => ({
      x: acrossX * offset.across + alongX * offset.along,
      y: acrossY * offset.across + alongY * offset.along
    }));

  const assigned = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const offset = layout[index];
    const slot = resolveSlot(
      room,
      { x: destination.x + offset.x, y: destination.y + offset.y },
      ordered[index],
      assigned,
      index,
      spacing
    );
    if (!slot) continue;
    assigned.push(slot);
    slots.set(ordered[index].id, { x: slot.x, y: slot.y });
  }
  return slots;
}

function commandShips(room, player, x, y, options = {}) {
  const selected = selectOwnedLivingShips(player, options.shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const ships = selected.ships;
  if (ships.length === 0) return { ok: true, code: "none", commanded: 0 };

  const clicked = options.targetId == null
    ? null
    : (room.ships?.get(String(options.targetId)) || room.stationsById?.get(String(options.targetId)));
  const livingTarget = clicked?.alive ? clicked : null;
  const selectedIds = new Set(ships.map((ship) => ship.id));
  const enemy = livingTarget && areEntityEnemies(room, player?.id, livingTarget);
  const ally = livingTarget
    && !selectedIds.has(livingTarget.id)
    && areEntityAllies(room, player?.id, livingTarget);
  const commandId = nextMovementCommandId(room, enemy ? "a" : (ally ? "r" : "m"));

  if (enemy) {
    const now = performanceNow();
    const line = assignFiringLine(ships, livingTarget);
    for (const ship of ships) {
      issueAttack(room, ship, commandId, livingTarget.id, now, {
        formationHeading: line.approach,
        firingLateral: line.lateral?.get(ship.id)
      });
    }
    return { ok: true, code: "attack", commanded: ships.length };
  }
  if (ally) {
    for (const ship of ships) issueRepair(ship, commandId, livingTarget.id);
    return { ok: true, code: "repair", commanded: ships.length };
  }

  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const destination = {
    x: clampNumber(x, WORLD_MARGIN, width - WORLD_MARGIN),
    y: clampNumber(y, WORLD_MARGIN, height - WORLD_MARGIN)
  };
  const formationHeading = formationHeadingFor(ships, destination);
  const slots = generateDestinationSlots(room, ships, destination, formationHeading);
  const formationSpeed = formationCruiseSpeed(ships);

  let commanded = 0;
  for (const ship of ships) {
    const slot = slots.get(ship.id);
    // Nowhere clear to put this hull. Stopping where it stands is honest; the
    // alternative is sending it to a point the planner has already rejected.
    if (!slot) {
      issueStop(ship, commandId);
      continue;
    }
    issueMove(ship, commandId, slot, {
      formationHeading,
      formationSpeed,
      finalFacing: options.finalFacing,
      manual: true
    });
    commanded += 1;
  }
  return {
    ok: true,
    code: commanded === ships.length ? "move" : "partial-move",
    commanded
  };
}

// Slots chosen elsewhere -- station launches and rally-point arrivals, which
// plan their own spacing against the ships already holding places.
function commandShipsToAssignedSlots(room, ships, slots, options = {}) {
  const commandId = nextMovementCommandId(room, options.prefix || "m");
  const living = (ships || []).filter((ship) => ship?.alive);
  const target = living.length && slots
    ? living.reduce((sum, ship) => {
      const slot = slots.get(ship.id);
      return slot ? { x: sum.x + slot.x, y: sum.y + slot.y, count: sum.count + 1 } : sum;
    }, { x: 0, y: 0, count: 0 })
    : null;
  const formationHeading = target?.count
    ? formationHeadingFor(living, { x: target.x / target.count, y: target.y / target.count })
    : null;
  let commanded = 0;
  for (const ship of living) {
    const slot = slots?.get(ship.id);
    if (!slot || !Number.isFinite(slot.x) || !Number.isFinite(slot.y)) continue;
    issueMove(ship, commandId, { x: slot.x, y: slot.y }, {
      formationHeading,
      finalFacing: options.finalFacing
    });
    commanded += 1;
  }
  return commanded;
}

function stopShips(room, player, shipIds) {
  const selected = selectOwnedLivingShips(player, shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const commandId = nextMovementCommandId(room, "s");
  for (const ship of selected.ships) issueStop(ship, commandId);
  return { ok: true, code: "stop", commanded: selected.ships.length };
}

function rotateShips(room, player, options) {
  const selected = selectOwnedLivingShips(player, options?.shipIds);
  if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
  const direction = options?.direction;
  const active = options?.active;
  for (const ship of selected.ships) setManualRotation(ship, active ? direction : null);
  return { ok: true, code: "rotate", commanded: selected.ships.length };
}

// Combat stances are frozen for the rewrite: the selection is still recorded on
// the ship and still published in snapshots, so the UI and the fallback
// implementation both keep working, but the controller flies every ship as
// "hold" until charge, orbit and kite are reinstated.
function applyCombatStyle(ship, combatStyle) {
  ship.combatStyle = combatStyle;
}

module.exports = {
  SUPPORTED_MOVEMENT_TYPES,
  applyCombatStyle,
  commandShips,
  commandShipsToAssignedSlots,
  createMovementRuntime,
  generateDestinationSlots,
  integratePosition,
  moveSpeedToward,
  navigationClearanceRadius,
  nearestClearPoint,
  physicalCollisionRadius,
  planMovement,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  rotateShips,
  segmentCircleClearance,
  separationRadius,
  stopShips,
  turnTowardHeading,
  updateShipMovement,
  updateShipSeparation
};
