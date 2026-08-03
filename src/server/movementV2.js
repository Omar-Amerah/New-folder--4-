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
// The controller has no other responsibilities. Its normal route plan is
// stateless between ticks; the only short-lived exceptions are explicit
// traffic commitments and static-contact slide state, both owned by the
// authoritative movement runtime. It contains no bang-bang branches -- every
// discontinuity ("brake now", "cut thrust now", "face the other way now") is a
// limit cycle at tick rate and reads to the player as jitter.
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
const { WORLD } = require("./config");
const { gameplayNow } = require("./gameplayTime");
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
const { circularShipSeparation } = require("./performanceFlags");
const { getMaxEffectiveWeaponRange, shipHasArmedProximityCharge } = require("./componentData");
const {
  MOVEMENT_TOGGLE_DEFAULTS,
  sanitizeCombatStyle,
  sanitizeMovementToggles
} = require("./validation");
const {
  applyEngineHeat,
  applyTurnHeat,
  directionalTurnRate,
  driveAcceleration,
  hasDrive,
  heatAdjustedMovementStats,
  signedTurnRate
} = require("./movementCapability");
// Collision and separation are map geometry, not steering. Moving-ship traffic
// is resolved by the explicit controller in movementTraffic.js.
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
  ensureRoomNavigation,
  isSegmentClear,
  isStaticObstacleLineClear,
  navigationPlanningClearance,
  nearestClearPoint,
  searchPathWorld,
  segmentCircleClearance
} = require("./movementNavigation");
const { stationAttackPoint } = require("./stationCollision");
const {
  applyCombatSlotAssignments,
  assignCombatSlots,
  combatGroupForTarget,
  combatGroupSignature,
  combatModeForShip,
  combatSlotPoint,
  combatSlotTargetMoved
} = require("./movementCombatSlots");
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
const { resolveTraffic } = require("./movementTraffic");

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
const BRAKE_ACCEL_RATIO = 5;

// How far off the goal a ship may be pointing before it gives up speed it has
// already paid for. Inside this cone it coasts through the turn: the alignment
// throttle stops it *adding* speed it cannot use, which is all it was ever for,
// but there is no drag out here and nothing is gained by braking into a corner
// and re-accelerating out of it. Past the cone the goal is genuinely behind the
// ship, the momentum is being spent going the wrong way, and it is shed --
// smoothly, reaching zero when the goal is dead astern.
const MOMENTUM_HOLD_ANGLE = Math.PI / 2;

// Grid spacing between destination slots, on top of the widest hull in the
// selection, so a capital and a corvette in the same order both get room.
const SLOT_SPACING_PAD = 12;

// --- Charge ------------------------------------------------------------------
// Charge means contact. Ordinary chargers brake into it; demolition carriers
// keep ram speed on the final leg until their payload resolves.
// ...and how far the target may open up before the charger gets under way again
// on distance alone. A charger at contact is standing in a
// crowd and is shoved constantly, and a narrow band made it let go every time a
// neighbour leaned on it -- which cost it the one thing the stance has to
// guarantee, since a ship that has let go is steering at a point again rather
// than at the hull it is supposed to be facing. A target that is genuinely
// leaving is caught by radial separation speed long before this.
const CHARGE_CLING_SLACK = 24;
const CHARGE_SETTLE_RADIAL_SPEED = 24;
// How fast the target has to be pulling away, in its own right, before the
// charger stops treating a growing gap as somebody jostling it.
const CHARGE_PURSUE_SPEED = 8;
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
// Normal contact correction remains strong enough to recover a newly packed
// group immediately. Only a friendly pair that has crossed the timed soft
// threshold gets the separate bounded correction in movementCollision; that
// exception is what permits forward pressure without weakening spawn recovery.
function getSeparationOptions() {
  return { circular: circularShipSeparation() };
}

// A destination that has moved less than this keeps the route it already has.
// Slots shift by a few pixels whenever a formation is re-solved, and replanning
// on that is pure waste.
const ROUTE_REPLAN_DISTANCE = 48;

// A ship that has not closed on its current waypoint for this long has been
// pushed off its route, or the route was never usable. Plan a new one.
const ROUTE_STUCK_MS = 1500;
const ROUTE_PROGRESS_EPSILON = 8;

// Static contact is a short steering mode, not a second route. Collision
// resolution refreshes the contact while the hull is touching the obstacle;
// these thresholds control how the route responds to a persistent contact.
const STATIC_SLIDE_SPEED_RATIO = 0.45;
const STATIC_SLIDE_ESCAPE_SPEED_RATIO = 0.65;
const STATIC_SLIDE_MIN_SPEED = 24;
const STATIC_SLIDE_ESCAPE_AFTER_MS = 750;
const STATIC_SLIDE_REPLAN_AFTER_MS = 1500;
const STATIC_SLIDE_RECOVERY_AFTER_MS = 2500;
const STATIC_SLIDE_RECOVERY_MAX_DISTANCE = 160;
const SOFT_FRIENDLY_RANGE_PAD = ARRIVE_DISTANCE * 2;
const COMBAT_SLOT_POSITION_TOLERANCE = ARRIVE_LATCH_DISTANCE + 12;
const CHARGE_CONTACT_PADDING = 8;

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
  if (!hasDrive(stats)) {
    const damping = 0.05;
    ship.vx = (ship.vx || 0) * (1 - damping * dt);
    ship.vy = (ship.vy || 0) * (1 - damping * dt);
    return;
  }

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
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
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
//   Engage          -- the combat stance, on an explicit or automatic target
//   Position hold   -- a completed Move, reacquired after displacement
//   Idle            -- nothing to do
//
// Manual I/O rotation is deliberately absent: it overrides facing only, and it
// must not delete the order underneath it, so it is applied in the step rather
// than competing for authority here.
//
// Completion is an event marker, not permission to forget the slot. Combat may
// temporarily take the helm, but once it releases, a ship displaced beyond the
// arrival latch flies back to the completed Move destination.
function movementAuthority(room, ship, runtime) {
  const command = runtime.command;
  if (command?.type === "stop") return "stop";
  if (command?.type === "move") {
    if (!runtime.orderComplete) return "move";
    if (engagementTarget(room, ship, runtime)) return "engage";
    const destination = command.destination;
    runtime.destination = destination;
    const displaced = destination
      && fastHypot(destination.x - (ship.x || 0), destination.y - (ship.y || 0)) > ARRIVE_LATCH_DISTANCE;
    if (displaced) {
      runtime.orderComplete = false;
      runtime.arrived = false;
      runtime.blocked = false;
      return "move";
    }
    return "position";
  }
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

function targetIsStation(target) {
  return Array.isArray(target?.collisionPieces);
}

function targetSurfacePoint(target, bearing) {
  if (!targetIsStation(target)) return { x: target.x, y: target.y };
  const far = Math.max(
    Number(target.radius) || 0,
    Number(target.width) || 0,
    Number(target.height) || 0,
    1000
  ) * 4;
  return stationAttackPoint(
    target.x + Math.cos(bearing) * far,
    target.y + Math.sin(bearing) * far,
    target
  );
}

function targetAttackPointFrom(originX, originY, target) {
  if (targetIsStation(target)) return stationAttackPoint(originX, originY, target);
  return { x: target.x, y: target.y };
}

function targetDistanceFrom(originX, originY, target) {
  const point = targetAttackPointFrom(originX, originY, target);
  return fastHypot(point.x - originX, point.y - originY);
}

function engagementGeometry(ship, target) {
  if (targetIsStation(target)) {
    const surface = stationAttackPoint(ship.x || 0, ship.y || 0, target);
    return {
      distance: fastHypot(surface.x - (ship.x || 0), surface.y - (ship.y || 0)),
      contact: physicalCollisionRadius(ship),
      surface
    };
  }
  return {
    distance: fastHypot(target.x - (ship.x || 0), target.y - (ship.y || 0)),
    contact: physicalCollisionRadius(ship) + physicalCollisionRadius(target),
    surface: { x: target.x, y: target.y }
  };
}

function firingLineClearFrom(room, x, y, target, margin = 8) {
  const targetPoint = targetAttackPointFrom(x, y, target);
  const bearing = Math.atan2(y - targetPoint.y, x - targetPoint.x);
  const surface = targetSurfacePoint(target, bearing);
  return isStaticObstacleLineClear(room, x, y, surface.x, surface.y, margin, {
    ignoreStationContainingEndpoint: true
  });
}

function currentFiringLineClear(room, ship, target) {
  return firingLineClearFrom(room, ship.x || 0, ship.y || 0, target);
}

function hasRecentSoftFriendlyContact(room, ship, runtime, now) {
  if (runtime?.traffic?.mode === "soft") return true;
  const contacts = room?._shipCollisionContacts;
  if (!contacts?.size) return false;
  const tick = Number(now) || 0;
  const shipId = String(ship.id);
  for (const [key, contact] of contacts) {
    if (!(Number(contact?.duration) >= 1500)
      || tick - (Number(contact?.at) || 0) > 250) continue;
    const ids = String(key).split("|");
    const otherId = ids[0] === shipId ? ids[1] : (ids[1] === shipId ? ids[0] : null);
    const other = otherId ? room.ships?.get?.(otherId) : null;
    if (other && areEntityAllies(room, ship.ownerId, other)) return true;
  }
  return false;
}

function radialSeparationSpeed(ship, target, distance) {
  const originX = ship.x || 0;
  const originY = ship.y || 0;
  const point = targetAttackPointFrom(originX, originY, target);
  const actualDistance = targetIsStation(target)
    ? fastHypot(point.x - originX, point.y - originY)
    : distance;
  if (!(actualDistance > BEARING_MIN_DISTANCE)) return 0;
  const unitX = (point.x - originX) / actualDistance;
  const unitY = (point.y - originY) / actualDistance;
  return ((target.vx || 0) - (ship.vx || 0)) * unitX
    + ((target.vy || 0) - (ship.vy || 0)) * unitY;
}

// Once per tick, for a ship whose movement is the combat stance's to decide.
//
// The destination this produces is a consequence of the target, never a place
// the player clicked, and it is recomputed from the target's current position --
// so a target that runs is followed and a target that closes is simply held.
// A Hold/Charge group keeps a target-relative destination until it reaches its
// assigned slot; once there, the destination is cleared and the ship holds
// station and faces the target.
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
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    runtime.firingSolution = null;
    runtime.combatSlot = null;
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

  const toggles = movementToggles(ship);

  // Static never repositions for combat, and neither does a ship whose owner has
  // switched off going after targets it picked out for itself. Both stand where
  // they are and turn to face what they can shoot, which is what planMovement
  // does for an engaged ship with no destination -- so both are exactly "produce
  // no destination".
  //
  // Note the automatic case is scoped to targets nobody named. An attack the
  // player ordered is an order, and no toggle countermands it.
  if (type !== "repair" && (combatStance(ship) === "static" || (!explicit && !toggles.autoEngage))) {
    runtime.holdEngaged = true;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    runtime.combatSlot = null;
    clearRoute(runtime);
    return;
  }

  const combatMode = type === "attack" ? combatModeForShip(ship) : null;
  const combatSlot = combatMode
    ? ensureCombatSlotAssignment(room, ship, target, combatMode, now, runtime)
    : null;
  if (type === "attack" && combatMode === "charge" && combatSlot?.staging) {
    runtime.chargeEngaged = false;
  }

  const geometry = engagementGeometry(ship, target);
  const distance = geometry.distance;
  const ranges = engagementRanges(ship, target, type, explicit);
  const { enter, resume } = ranges;

  if (type === "attack" && combatStance(ship) === "charge") {
    runtime.holdEngaged = false;
    const armed = shipHasArmedProximityCharge(ship);
    const contactSlot = !combatSlot || !combatSlot.staging;
    if (runtime.chargeEngaged && contactSlot) {
      if (distance <= resume && radialSeparationSpeed(ship, target, targetDistanceFrom(ship.x || 0, ship.y || 0, target)) <= CHARGE_PURSUE_SPEED) {
        runtime.blocked = false;
        clearRoute(runtime);
        return;
      }
      runtime.chargeEngaged = false;
    } else if (contactSlot && distance <= enter
      && (armed || Math.abs(radialSeparationSpeed(ship, target, targetDistanceFrom(ship.x || 0, ship.y || 0, target))) <= CHARGE_SETTLE_RADIAL_SPEED)) {
      runtime.chargeEngaged = true;
      if (combatSlot) combatSlot.contactEstablished = true;
      runtime.blocked = false;
      clearRoute(runtime);
      return;
    }

    // A live demolition carrier keeps ram speed until the first contact tick;
    // if combat has not consumed the payload by the next tick, the contact latch
    // prevents it leaning on and bulldozing a stationary target forever.
    runtime.ramming = armed;

    let destination = reachableFiringPosition(
      room,
      ship,
      target,
      runtime,
      command,
      ranges.destination,
      enter,
      now
    );
    if (!destination && combatMode === "charge" && runtime.combatSlot?.unreachable) {
      ensureCombatSlotAssignment(room, ship, target, combatMode, now, runtime);
      destination = reachableFiringPosition(
        room,
        ship,
        target,
        runtime,
        command,
        ranges.destination,
        enter,
        now
      );
    }
    runtime.blocked = !destination;
    if (destination) runtime.destination = destination;
    else clearRoute(runtime);
    return;
  }

  runtime.chargeEngaged = false;

  if (runtime.holdEngaged) {
    // Established. Only a target that has genuinely opened the range is worth
    // getting under way for again -- and nothing at all is worth backing away
    // from, however close it comes. With pursuit switched off, nothing at all
    // is: the ship has taken its position and that is where it stays.
    const firingLineClear = type !== "attack" || currentFiringLineClear(room, ship, target);
    const slotPoint = combatSlotPoint(target, combatSlot);
    const slotDisplaced = Boolean(slotPoint
      && fastHypot(slotPoint.x - (ship.x || 0), slotPoint.y - (ship.y || 0))
        > COMBAT_SLOT_POSITION_TOLERANCE);
    const softContactBand = hasRecentSoftFriendlyContact(room, ship, runtime, now)
      && distance <= enter + SOFT_FRIENDLY_RANGE_PAD
      && firingLineClear;
    const chase = toggles.pursue
      && !softContactBand
      && (distance > resume || !firingLineClear
        || (slotDisplaced && distance > enter + COMBAT_SLOT_POSITION_TOLERANCE));
    if (!chase) {
      runtime.blocked = false;
      clearRoute(runtime);
      return;
    }
    runtime.holdEngaged = false;
  } else if (canEngageFromHere(room, ship, target, type, runtime, distance, enter, resume, now)) {
    runtime.holdEngaged = true;
    runtime.blocked = false;
    clearRoute(runtime);
    return;
  }

  // A ship whose weapon is itself is on a ramming run, and a ram that arrives at
  // walking pace is not a ram. Recorded here, once per tick, because this is the
  // only place that knows all three things at the same time: the stance, the
  // target, and whether the charge is still aboard to be delivered.
  runtime.ramming = false;
  let destination = reachableFiringPosition(
    room,
    ship,
    target,
    runtime,
    command,
    ranges.destination,
    enter,
    now
  );
  if (!destination && combatMode === "hold" && runtime.combatSlot?.unreachable) {
    ensureCombatSlotAssignment(room, ship, target, combatMode, now, runtime);
    destination = reachableFiringPosition(
      room,
      ship,
      target,
      runtime,
      command,
      ranges.destination,
      enter,
      now
    );
  }
  runtime.blocked = !destination;
  if (destination) runtime.destination = destination;
  else clearRoute(runtime);
}

// Is this ship close enough to stop and fire? Each attack order resolves its own
// range and line of sight. There is no shared firing rank or group destination.
function canEngageFromHere(room, ship, target, type, runtime, distance, enter, resume, now) {
  const slotPoint = combatSlotPoint(target, runtime?.combatSlot);
  if (slotPoint
    && fastHypot(slotPoint.x - (ship.x || 0), slotPoint.y - (ship.y || 0))
      > COMBAT_SLOT_POSITION_TOLERANCE) return false;
  const softContact = hasRecentSoftFriendlyContact(room, ship, runtime, now);
  const inBand = distance <= enter
    || (softContact && distance <= enter + SOFT_FRIENDLY_RANGE_PAD)
    || (runtime.arrived && distance <= resume);
  if (!inBand) return false;
  return type !== "attack" || currentFiringLineClear(room, ship, target);
}

// Which side of the target a charging ship comes in on, as a bearing from the
// target outward.
//
// Far out it is the side the group handed this ship, so a fleet converging on
// one hull fans out on the way in instead of queueing up behind each other.
//
// Close in it is simply the direction the ship is already coming from, so the
// last stretch is driven straight at the target. That is not a detail: a hull
// travels along its nose and nothing else, so steering for a *particular* side
// from close range means crossing in front of the target showing it a flank,
// and a ring of ships all doing that circles the target forever instead of
// hitting it -- measured at four chargers still swinging round after a minute,
// two of them pointing more than 60 degrees off the thing they were charging.
// Where they end up spread is then settled by arriving from different sides and
// by the separation solver, which is enough to surround a hull without any ship
// ever having to fly sideways to do it.
function chargeBearing(ship, target, command, standoff) {
  const targetPoint = targetAttackPointFrom(ship.x || 0, ship.y || 0, target);
  return Math.atan2((ship.y || 0) - targetPoint.y, (ship.x || 0) - targetPoint.x);
}

// The bearing this ship approaches its target on.
//
// Held fixed while the ship is detouring around something, and only then.
// Recomputing it mid-detour is a feedback loop -- the detour moves the ship,
// which swings the firing point, which changes the detour -- and that loop
// walked ships into the very asteroids they were routing around.
//
// With a clear line to the target there is no loop, and holding a stale bearing
// is actively harmful. It leaves the firing point off to one side of the enemy,
// so the commanded heading is the bearing to a spot while the ship is closing
// and the bearing to the enemy the instant it arrives. Those are two different
// directions, and Hold crosses between them every time the target drifts far
// enough to be worth stepping after: 331 times in 40 seconds against a target
// ambling across at 25 px/s. That is the shake.
function heldApproach(ship, target, runtime) {
  const held = runtime.engageApproach;
  const detouring = (runtime.path?.length || 0) > 0;
  if (held && held.targetId === target.id && detouring) return held.approach;
  const targetPoint = targetAttackPointFrom(ship.x || 0, ship.y || 0, target);
  const approach = Math.atan2((ship.y || 0) - targetPoint.y, (ship.x || 0) - targetPoint.x);
  runtime.engageApproach = { targetId: target.id, approach };
  return approach;
}

// A place to stand: a bearing from the target and a distance along it.
//
// Everything that positions a ship for combat resolves to this, and stating it
// as an angle and a radius rather than as an offset from a straight line is what
// keeps every ship in a group at exactly the range it was sent to. A straight
// line puts its ends further out than its middle -- measurably outside their own
// weapons range -- so the wings never counted as engaged, never stopped fussing,
// and never turned to face what they were shooting at.
function firingPoint(target, bearing, radius) {
  const surface = targetSurfacePoint(target, bearing);
  return {
    x: surface.x + Math.cos(bearing) * radius,
    y: surface.y + Math.sin(bearing) * radius
  };
}

function preferredFiringBearing(ship, target, runtime, command, standoff) {
  if (combatStance(ship) === "charge") return chargeBearing(ship, target, command, standoff);
  return heldApproach(ship, target, runtime);
}

function ensureCombatSlotAssignment(room, ship, target, mode, now, runtime) {
  if (!target || !mode) return null;
  const group = combatGroupForTarget(room, target, mode);
  if (!group.some((member) => member.id === ship.id)) group.push(ship);
  const uniqueGroup = Array.from(new Map(group.map((member) => [member.id, member])).values());
  for (const member of uniqueGroup) ensureMovementRuntime(member);
  uniqueGroup.sort((a, b) => compareEntityIds(a, b));

  const signature = combatGroupSignature(uniqueGroup);
  const slot = runtime.combatSlot;
  const targetChanged = !slot
    || String(slot.targetId) !== String(target.id)
    || slot.combatMode !== mode
    || slot.groupSignature !== signature
    || combatSlotTargetMoved(slot, target);
  const geometry = slot && mode === "charge" && slot.contactEstablished && !runtime.chargeEngaged
    ? engagementGeometry(ship, target)
    : null;
  const contactLost = Boolean(geometry
    && geometry.distance > engagementRanges(ship, target, "attack", true).enter
      + COMBAT_SLOT_POSITION_TOLERANCE);
  if (targetChanged || slot?.unreachable || contactLost) {
    const blockedAngles = new Map();
    if (slot?.unreachable && Number.isFinite(Number(slot.assignedAngle))) {
      blockedAngles.set(ship.id, Number(slot.assignedAngle));
    }
    const assignments = assignCombatSlots(room, uniqueGroup, target, mode, now, { blockedAngles });
    applyCombatSlotAssignments(uniqueGroup, assignments);
  }
  return ensureMovementRuntime(ship).combatSlot;
}

function reachableFiringPosition(room, ship, target, runtime, command, standoff, engageRange, now) {
  const navigation = ensureRoomNavigation(room);
  const targetId = String(target.id);
  const assignedSlot = runtime.combatSlot
    && String(runtime.combatSlot.targetId) === targetId
    ? runtime.combatSlot
    : null;

  if (assignedSlot) {
    const slotPoint = combatSlotPoint(target, assignedSlot);
    const candidate = slotPoint && assignedSlot.combatMode === "charge" && !targetIsStation(target)
      ? {
        x: (Number(target.x) || 0)
          + Math.cos(Number(assignedSlot.assignedAngle))
            * Math.max(0, Number(assignedSlot.assignedRadius) - ARRIVE_DISTANCE),
        y: (Number(target.y) || 0)
          + Math.sin(Number(assignedSlot.assignedAngle))
            * Math.max(0, Number(assignedSlot.assignedRadius) - ARRIVE_DISTANCE)
      }
      : slotPoint;
    if (!candidate) {
      assignedSlot.unreachable = true;
      return null;
    }
    const requiresLineOfSight = combatStance(ship) !== "charge";
    if (requiresLineOfSight && !firingLineClearFrom(room, candidate.x, candidate.y, target)) {
      assignedSlot.unreachable = true;
      return null;
    }
    const clearance = routeClearance(ship);
    const clear = nearestClearPoint(room, candidate.x, candidate.y, clearance + 12);
    if (!clear.clear || fastHypot(clear.x - candidate.x, clear.y - candidate.y) > 2) {
      assignedSlot.unreachable = true;
      return null;
    }
    if (!isSegmentClear(room, ship.x, ship.y, candidate.x, candidate.y, clearance)) {
      const search = searchPathWorld(room, ship.x, ship.y, candidate.x, candidate.y, clearance);
      if (!search.reachedGoal) {
        assignedSlot.unreachable = true;
        return null;
      }
    }
    runtime.firingSolution = {
      targetId,
      targetX: target.x,
      targetY: target.y,
      navigation,
      standoff,
      bearing: assignedSlot.assignedAngle,
      assignedRadius: assignedSlot.assignedRadius,
      slot: true,
      retryAt: 0
    };
    return candidate;
  }

  const destinationRadius = standoff;
  const restingRadius = engageRange;
  const cached = runtime.firingSolution;
  const targetMoved = cached
    ? fastHypot(target.x - cached.targetX, target.y - cached.targetY)
    : Infinity;
  const cacheMatches = cached
    && cached.targetId === targetId
    && cached.navigation === navigation
    && Math.abs(cached.standoff - destinationRadius) < 0.5
    && targetMoved <= ROUTE_REPLAN_DISTANCE;

  const candidateForBearing = (bearing, verifyReachability = true) => {
    const candidate = firingPoint(target, bearing, destinationRadius);
    const restingPoint = firingPoint(target, bearing, restingRadius);
    if (!firingLineClearFrom(room, restingPoint.x, restingPoint.y, target)) return null;

    const clearance = routeClearance(ship);
    // Contact with a station is intentionally inside navigation padding. Prove
    // reachability at the staging point just outside that padding, then let the
    // final clear leg run to hull contact.
    const probeRadius = targetIsStation(target)
      ? Math.max(destinationRadius, clearance + ARRIVE_DISTANCE)
      : destinationRadius;
    const probe = probeRadius === destinationRadius ? candidate : firingPoint(target, bearing, probeRadius);
    const clear = nearestClearPoint(room, probe.x, probe.y, clearance + 12);
    if (!clear.clear || fastHypot(clear.x - probe.x, clear.y - probe.y) > 2) return null;
    if (verifyReachability && !isSegmentClear(room, ship.x, ship.y, probe.x, probe.y, clearance)) {
      const search = searchPathWorld(room, ship.x, ship.y, probe.x, probe.y, clearance);
      if (!search.reachedGoal) return null;
    }
    return candidate;
  };

  if (cacheMatches && Number.isFinite(cached.bearing)) {
    const candidate = candidateForBearing(cached.bearing, false);
    if (candidate) return candidate;
  } else if (cacheMatches && now < cached.retryAt) {
    return null;
  }

  const preferred = preferredFiringBearing(ship, target, runtime, command, destinationRadius);
  const offsets = [0];
  for (let step = 1; step <= 12; step += 1) {
    const offset = step * Math.PI / 12;
    offsets.push(offset, -offset);
  }
  for (const offset of offsets) {
    const bearing = preferred + offset;
    const candidate = candidateForBearing(bearing);
    if (!candidate) continue;
    runtime.firingSolution = {
      targetId,
      targetX: target.x,
      targetY: target.y,
      navigation,
      standoff: destinationRadius,
      bearing,
      retryAt: 0
    };
    return candidate;
  }

  runtime.firingSolution = {
    targetId,
    targetX: target.x,
    targetY: target.y,
    navigation,
    standoff: destinationRadius,
    bearing: null,
    retryAt: now + 500
  };
  return null;
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

function directCombatLegClear(room, ship, runtime, destination, clearance) {
  const engagement = engagementTarget(room, ship, runtime);
  return targetIsStation(engagement?.target)
    && isStaticObstacleLineClear(
      room,
      ship.x,
      ship.y,
      destination.x,
      destination.y,
      clearance,
      { ignoreStationContainingEndpoint: true }
    );
}

function planRoute(room, ship, runtime, destination, now) {
  const clearance = routeClearance(ship);
  let path;
  let reachable = true;

  if (isSegmentClear(room, ship.x, ship.y, destination.x, destination.y, clearance)
    || directCombatLegClear(room, ship, runtime, destination, clearance)) {
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
    terminal: { ...path[path.length - 1] },
    navigation: ensureRoomNavigation(room),
    dynamicDetours: 0,
    plannedAt: now,
    progressDistance: fastHypot(path[0].x - ship.x, path[0].y - ship.y),
    progressAt: now
  };
  if (reachable) runtime.blocked = false;
  if (runtime.slide && now >= Number(runtime.slide.replanAt)) {
    runtime.slide.replanAt = now + STATIC_SLIDE_REPLAN_AFTER_MS;
    runtime.slide.replanCount = (Number(runtime.slide.replanCount) || 0) + 1;
    bumpMovementMetric("staticSlideReplans");
  }
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
  if (route.navigation !== ensureRoomNavigation(room)) return true;
  if (fastHypot(destination.x - route.destination.x, destination.y - route.destination.y)
    > ROUTE_REPLAN_DISTANCE) return true;

  const slide = runtime.slide;
  const slideReplanAt = Number(slide?.replanAt);
  if (slide
    && Number(now) < Number(slide.expiresAt)
    && (!Number.isFinite(slideReplanAt) || Number(now) < slideReplanAt)) {
    // Collision contact owns the temporary tangent course. Do not let the
    // ordinary stuck timer immediately discard it and point the hull back at
    // the surface on the next tick.
    route.progressAt = now;
    route.progressDistance = fastHypot(
      (runtime.path[routeWaypointIndex(runtime)]?.x ?? ship.x) - ship.x,
      (runtime.path[routeWaypointIndex(runtime)]?.y ?? ship.y) - ship.y
    );
    return false;
  }

  const index = routeWaypointIndex(runtime);
  const goal = runtime.path[index];
  if (route.reachable === false) {
    const engagement = engagementTarget(room, ship, runtime);
    if (targetIsStation(engagement?.target)
      && isStaticObstacleLineClear(
        room,
        ship.x,
        ship.y,
        destination.x,
        destination.y,
        route.clearance,
        { ignoreStationContainingEndpoint: true }
      )) return true;
  }
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
  return distance > route.clearance && now - (route.progressAt ?? now) > ROUTE_STUCK_MS;
}

function slideTangent(slide, side) {
  const normalLength = fastHypot(Number(slide?.normalX) || 0, Number(slide?.normalY) || 0);
  if (!(normalLength > 0.001)) return null;
  const nx = slide.normalX / normalLength;
  const ny = slide.normalY / normalLength;
  return side === 1 ? { x: -ny, y: nx } : { x: ny, y: -nx };
}

function chooseStaticSlideSide(ship, slide, goal) {
  if (slide.side === -1 || slide.side === 1) return slide.side;
  const left = slideTangent(slide, 1);
  const right = slideTangent(slide, -1);
  if (!left || !right) return 0;
  const dx = (goal?.x ?? ship.x) - ship.x;
  const dy = (goal?.y ?? ship.y) - ship.y;
  const length = fastHypot(dx, dy);
  const leftScore = length > 0.001 ? (left.x * dx + left.y * dy) / length : 0;
  const rightScore = length > 0.001 ? (right.x * dx + right.y * dy) / length : 0;
  if (Math.abs(leftScore - rightScore) > 0.001) return leftScore > rightScore ? 1 : -1;
  // A tie is still a decision, not a per-tick coin flip. The obstacle id is
  // part of the stable pair identity, so two ships meeting the same surface
  // choose reproducibly even if their headings happen to match.
  return String(ship.id) <= String(slide.obstacleId) ? 1 : -1;
}

function refreshStaticSlide(room, ship, runtime, now) {
  const slide = runtime.slide;
  if (!slide) return;
  if (Number.isFinite(Number(slide.expiresAt)) && now > Number(slide.expiresAt)) {
    runtime.slide = null;
    return;
  }
  const index = routeWaypointIndex(runtime);
  const goal = runtime.path?.[index] || runtime.destination;
  if (goal && isSegmentClear(room, ship.x, ship.y, goal.x, goal.y, routeClearance(ship))) {
    runtime.slide = null;
    return;
  }
  if (runtime.route && now < Number(slide.replanAt)) {
    runtime.route.progressAt = now;
  }
}

function applyStaticSlideSteering(room, ship, runtime, stats, route, plan, now) {
  const slide = runtime.slide;
  if (!slide) return false;
  if (Number.isFinite(Number(slide.expiresAt)) && now > Number(slide.expiresAt)) {
    runtime.slide = null;
    return false;
  }
  const goal = route?.goal || runtime.destination;
  if (goal && isSegmentClear(room, ship.x, ship.y, goal.x, goal.y, routeClearance(ship))) {
    runtime.slide = null;
    return false;
  }
  const side = chooseStaticSlideSide(ship, slide, goal);
  const tangent = slideTangent(slide, side);
  if (!tangent) return false;
  if (slide.side !== side) {
    slide.side = side;
    bumpMovementMetric("staticSlideSideChoices");
  }
  if (!Number.isFinite(Number(slide.steeringAt))) {
    slide.steeringAt = now;
    bumpMovementMetric("staticSlideActivations");
  }
  const elapsed = Math.max(0, now - (Number(slide.startedAt) || now));
  const maximum = Math.min(
    Number(stats.maxSpeed) || 0,
    Number.isFinite(Number(ship.stats?.maxSpeed)) && Number(ship.stats.maxSpeed) > 0
      ? Number(ship.stats.maxSpeed)
      : Number(stats.maxSpeed) || 0
  );
  plan.desiredHeading = Math.atan2(tangent.y, tangent.x);
  if (hasDrive(stats) && maximum > 0) {
    const ratio = elapsed >= STATIC_SLIDE_ESCAPE_AFTER_MS
      ? STATIC_SLIDE_ESCAPE_SPEED_RATIO
      : STATIC_SLIDE_SPEED_RATIO;
    const slideSpeed = Math.min(
      maximum,
      Math.max(STATIC_SLIDE_MIN_SPEED, maximum * ratio)
    );
    plan.desiredSpeed = slideSpeed;
    plan.speedCeiling = slideSpeed;
    plan.phase = "travelling";
    runtime.arrived = false;
    runtime.orderComplete = false;
  }
  return true;
}

function tryStaticSlideRecovery(room, ship, runtime, now) {
  const slide = runtime.slide;
  if (!slide || now < Number(slide.recoveryAt)) return false;
  const normalLength = fastHypot(Number(slide.normalX) || 0, Number(slide.normalY) || 0);
  if (!(normalLength > 0.001)) return false;
  const nx = slide.normalX / normalLength;
  const ny = slide.normalY / normalLength;
  const side = slide.side === -1 || slide.side === 1 ? slide.side : 1;
  const tangent = slideTangent(slide, side) || { x: -ny, y: nx };
  const directions = [
    { x: nx, y: ny },
    { x: nx + tangent.x, y: ny + tangent.y },
    { x: nx - tangent.x, y: ny - tangent.y },
    tangent,
    { x: -tangent.x, y: -tangent.y }
  ];
  const distances = [
    physicalCollisionRadius(ship) + 12,
    physicalCollisionRadius(ship) + 32,
    physicalCollisionRadius(ship) + 64,
    physicalCollisionRadius(ship) + 96
  ];
  let best = null;
  for (const rawDirection of directions) {
    const directionLength = fastHypot(rawDirection.x, rawDirection.y);
    if (!(directionLength > 0.001)) continue;
    const dx = rawDirection.x / directionLength;
    const dy = rawDirection.y / directionLength;
    for (const distance of distances) {
      const candidate = {
        x: ship.x + dx * distance,
        y: ship.y + dy * distance
      };
      const clear = nearestClearPoint(room, candidate.x, candidate.y, navigationClearanceRadius(ship));
      if (!clear?.clear) continue;
      const adjustedDistance = fastHypot(clear.x - ship.x, clear.y - ship.y);
      if (adjustedDistance > STATIC_SLIDE_RECOVERY_MAX_DISTANCE) continue;
      if (!isSegmentClear(
        room,
        ship.x,
        ship.y,
        clear.x,
        clear.y,
        physicalCollisionRadius(ship)
      )) continue;
      if (!best || adjustedDistance < best.distance) {
        best = { x: clear.x, y: clear.y, distance: adjustedDistance };
      }
    }
  }
  if (!best) {
    slide.recoveryAt = now + 1000;
    return false;
  }
  const oldX = ship.x;
  const oldY = ship.y;
  ship.x = best.x;
  ship.y = best.y;
  ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + ship.x - oldX;
  ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + ship.y - oldY;
  runtime.slide = null;
  runtime.path = [];
  runtime.waypointIndex = 0;
  runtime.route = null;
  runtime.blocked = false;
  bumpMovementMetric("staticSlideRecoveries");
  return true;
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
  // Traffic bypass points are held by movementTraffic; this route shortcut only
  // considers static map clearance.
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
    const terminal = runtime.route?.reachable === false ? runtime.route.terminal : destination;
    return fastHypot(terminal.x - ship.x, terminal.y - ship.y);
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
  if (!(rate > 0)) return Infinity;

  // How fast the ship may be going *at* the corner and still have swung onto the
  // next leg by the time it has crossed the capture circle.
  const atCorner = rate * Math.max(1, capture) / turn;

  // That is a speed for the corner, not a speed limit for the whole leg leading
  // up to it, and returning it as a flat cap was the whole of "pathing slows the
  // ship to a crawl": a single bend 2500 px away held a 500 px/s hull at 204 px/s
  // for the entire run in to it, and it was the binding limit for more than half
  // the journey.
  //
  // The ship can run at whatever else allows and brake for the corner when it
  // gets there, so this is the same arrival profile used for the destination --
  // just aimed at a speed rather than at a stop.
  const runway = Math.max(0, fastHypot(goal.x - ship.x, goal.y - ship.y) - Math.max(1, capture));
  return Math.sqrt(atCorner * atCorner + 2 * brakingAcceleration(stats) * runway);
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
    reachable: runtime.route?.reachable !== false,
    terminal: runtime.route?.terminal || destination
  };
}

// ---------------------------------------------------------------------------
// Deciding the route-following throttle
// ---------------------------------------------------------------------------

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

// Where a ship with nothing left to fly toward should point.
//
// Whatever it is fighting outranks the order's own idea of a final heading,
// because fixed weapons only bear where the hull points -- "close in and face
// it" is the whole of Charge, and a ship stopped in range is no use aimed at
// where it happened to arrive from. An explicit finalFacing still wins:
// that is the player asking for a heading in as many words.
//
// Without this a parked ship kept the angle it arrived on, so a target that then
// moved across it was tracked only if something else put the ship back under way.
function stationaryHeading(room, ship, runtime, command) {
  if (Number.isFinite(command?.finalFacing)) return command.finalFacing;
  if (combatStance(ship) !== "sentry") {
    const engaged = movementToggles(ship).autoTurn ? engagementTarget(room, ship, runtime) : null;
    if (engaged) {
      const distance = targetDistanceFrom(ship.x || 0, ship.y || 0, engaged.target);
      if (distance > BEARING_MIN_DISTANCE) return bearingTo(ship, targetAttackPointFrom(ship.x || 0, ship.y || 0, engaged.target));
    }
  }
  return restingHeading(ship, command);
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

// Which stance is flying this ship. Anything the controller does not implement
// has already been resolved to Hold by sanitizeCombatStyle, so this only ever
// returns something there is code for.
function combatStance(ship) {
  const raw = ship?.combatStyleRaw || ship?.combatStyle;
  if (raw === "sentry") return "sentry";
  return sanitizeCombatStyle(raw);
}

// The player's standing instructions for this hull. Absent means all of them,
// which is how the controller behaved before there were any -- so a ship that
// has never been told otherwise flies exactly as it always did.
function movementToggles(ship) {
  return ship?.movementToggles || MOVEMENT_TOGGLE_DEFAULTS;
}

// How close this ship needs to be to fight, and how far the target may drift
// before it is worth chasing again.
//
// Hold approaches to 80% of its reach and stops. The 80% is an approach
// threshold, not a station to be maintained: once the ship is inside it, it
// stays put whatever the target does short of leaving. Two separate ratios give
// that behaviour a dead band -- without one, a target hovering near the edge
// makes the ship start and abandon an approach every second.
//
// Charge ignores weapon reach entirely and closes to hull contact. Ordinary
// chargers brake into it; demolition carriers keep ram speed on the final leg.
//
// The dead band for Charge is deliberately narrow. Hold's exists so a target
// loitering near the edge of a 500 px envelope cannot restart an approach every
// second; a charger is already touching its target, so the only thing the band
// has to absorb is separation jitter. Anything wider would read as the ship
// letting go.
function engagementRanges(ship, target, type, explicit = false) {
  const hull = engagementGeometry(ship, target).contact;
  if (type !== "repair" && combatStance(ship) === "charge") {
    const enter = hull + CHARGE_CONTACT_PADDING;
    return {
      enter,
      resume: enter + CHARGE_CLING_SLACK,
      destination: Math.max(0, enter - ARRIVE_DISTANCE)
    };
  }
  const reach = type === "repair"
    ? (Number(ship.stats?.repairRange) || 0)
    : getMaxEffectiveWeaponRange(ship);
  // A ship with nothing that reaches still has to stop somewhere short of
  // wearing its target as a hat.
  const contact = hull + REPAIR_STANDOFF_PAD;
  // A player-selected attack is a firing order, not a formation-positioning
  // order: stop as soon as this hull has its own weapon envelope and LOS. The
  // stance's 80% comfort range remains for automatically acquired targets.
  const explicitAttack = explicit && type === "attack";
  const enter = Math.max(contact, explicitAttack ? reach : reach * HOLD_RANGE_RATIO);
  return {
    enter,
    resume: explicitAttack
      ? enter + SOFT_FRIENDLY_RANGE_PAD
      : Math.max(contact, reach * HOLD_RESUME_RATIO),
    // The arrival controller intentionally stops ARRIVE_DISTANCE short of its
    // command. Compensate here so the visible resting range, not the invisible
    // route endpoint, is exactly the stance percentage.
    destination: Math.max(hull, enter - ARRIVE_DISTANCE)
  };
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
function planMovement(room, ship, runtime, stats, route, steeringHeading = null, steeringPoint = null) {
  const command = runtime.command;
  const resting = { desiredHeading: restingHeading(ship, command), desiredSpeed: 0 };

  // Note there is deliberately no "no order, nothing to do" shortcut here. A
  // ship that has never been given an order is exactly the ship the stance flies
  // on its own, off a target combat acquired for it -- and returning idle the
  // moment runtime.command was null threw away the destination refreshEngagement
  // had just worked out. Every ship without an explicit order simply sat there,
  // which made the whole automatic-engagement path dead code.

  if (command?.type === "stop") {
    // Stop preserves the hull's heading: turning to face the destination it was
    // just cancelled off would make the stop key a rotate key.
    //
    // A target is the one exception, and not really an exception at all -- the
    // ship has stopped moving, not stopped fighting, so it keeps its guns on
    // what it was engaging.
    const speed = Math.abs(forwardSpeedOf(ship));
    const engaged = movementToggles(ship).autoTurn ? engagementTarget(room, ship, runtime) : null;
    const distance = engaged ? targetDistanceFrom(ship.x, ship.y, engaged.target) : 0;
    return {
      desiredHeading: engaged && distance > BEARING_MIN_DISTANCE
        ? bearingTo(ship, targetAttackPointFrom(ship.x, ship.y, engaged.target))
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
    const engaged = combatStance(ship) !== "sentry" && movementToggles(ship).autoTurn ? engagementTarget(room, ship, runtime) : null;
    if (engaged) {
      const distance = targetDistanceFrom(ship.x, ship.y, engaged.target);
      return {
        desiredHeading: distance > BEARING_MIN_DISTANCE
          ? bearingTo(ship, targetAttackPointFrom(ship.x, ship.y, engaged.target))
          : (ship.angle || 0),
        desiredSpeed: 0,
        phase: runtime.blocked ? "blocked" : "positioned"
      };
    }
    // Nowhere to be and nothing to shoot at. A ship that was never given an
    // order is idle; one that has carried its order out is in position.
    return { ...resting, phase: command ? "positioned" : "idle" };
  }

  const arrivalPoint = route?.reachable === false ? route.terminal : destination;
  const distance = fastHypot(arrivalPoint.x - (ship.x || 0), arrivalPoint.y - (ship.y || 0));

  // Arrived and latched. Only a shove big enough to matter puts the ship back
  // under way, so a neighbour jostling it in a crowded formation cannot restart
  // a crawl -- and a crawl is what the nose would then follow.
  if (runtime.arrived) {
    if (distance <= ARRIVE_LATCH_DISTANCE) {
      return {
        desiredHeading: stationaryHeading(room, ship, runtime, command),
        desiredSpeed: 0,
        phase: route?.reachable === false || runtime.blocked ? "blocked" : "positioned"
      };
    }
    runtime.arrived = false;
  }

  const speed = forwardSpeedOf(ship);
  if (distance <= ARRIVE_DISTANCE && speed <= DESTINATION_ARRIVE_SPEED) {
    runtime.arrived = true;
    // A Move that has been flown is done with. Latching it here is what hands
    // the helm to the combat stance afterwards, and what stops the stance and
    // the stale Move order taking turns to drag the ship about.
    if (command?.type === "move" && route?.reachable !== false) runtime.orderComplete = true;
    if (route?.reachable === false) runtime.blocked = true;
    return {
      desiredHeading: stationaryHeading(room, ship, runtime, command),
      desiredSpeed: 0,
      phase: route?.reachable === false ? "blocked" : "positioned"
    };
  }

  // The one point the controller steers at. It has no idea whether this is the
  // destination itself or a corner the search picked to get around an asteroid.
  const goal = route?.goal || destination;
  const steeringGoal = steeringPoint || goal;
  const goalDistance = fastHypot(steeringGoal.x - (ship.x || 0), steeringGoal.y - (ship.y || 0));
  const bearing = goalDistance > BEARING_MIN_DISTANCE
    ? bearingTo(ship, steeringGoal)
    : (ship.angle || 0);
  // A moving ship always faces the point it is currently flying toward. A
  // formation heading is an arrival-facing preference only; using it during
  // the final leg makes the ship point along the group's original course while
  // the speed/braking limits are calculated from this waypoint's real bearing.
  // That mismatch delays sideways corrections and can leave a ship oscillating
  // around its slot after an avoidance or separation correction.
  const desiredHeading = steeringHeading !== null
    && steeringHeading !== undefined
    && Number.isFinite(Number(steeringHeading))
    ? Number(steeringHeading)
    : bearing;

  // Speed from the ground still to cover -- along the whole remaining route, so
  // intermediate waypoints are rounded at speed and the ship comes to rest only
  // at the end.
  const remainingToEnd = steeringPoint
    ? Math.max(0, goalDistance)
    : Math.max(0, (route ? route.remaining : distance) - ARRIVE_DISTANCE);
  const safeArrivalSpeed = Math.sqrt(2 * brakingAcceleration(stats) * remainingToEnd);

  // Speed from the geometry of the turn: a ship doing v with turn rate w flies
  // a circle of radius v/w, and if that circle is wider than the distance left
  // it can only orbit the point it was steering at. Capping v at w*distance
  // makes the turn always tight enough to close.
  // Measured against the point the ship has to come to rest on, which on a
  // routed leg is the end of the route and not the corner it is currently
  // steering at. A waypoint is somewhere to pass, not somewhere to stop: capping
  // speed by the distance to one throttled a ship to 89 px/s as it rounded a
  // bend with three thousand pixels of clear run still ahead of it. Taking the
  // corner itself is cornerLimit's job.
  const turnRate = maxTurnRate(stats);
  const stoppingGoal = steeringPoint
    ? goalDistance
    : (route && !route.isFinal ? route.remaining : goalDistance);
  const turnLimit = turnRate > 0 ? turnRate * Math.max(stoppingGoal, ARRIVE_DISTANCE) : Infinity;

  // A ramming run keeps neither of those.
  //
  // The arrival profile and the turn-radius cap both exist to set a ship down
  // gently and accurately on a spot. A demolition ship wants the opposite: it is
  // the weapon, and everything that makes for a tidy arrival -- braking from a
  // third of the map out, easing off as the point gets close -- is exactly what
  // makes it drift up to its target and stop politely a hull's width short.
  //
  // Only on the final leg. A detour around an asteroid is still ordinary flying,
  // still has to be flown accurately, and a ship that took its corners at ram
  // speed would simply spread itself over the rock.
  //
  // Nothing else is relaxed. maxSpeed still binds, so "as fast as it can" means
  // the hull's own limit; the corner limit still binds; and the alignment
  // throttle still binds, so a ship that has lost the bearing slows down and
  // lines the run up again instead of tearing past at full power.
  const ramming = runtime.ramming && (!route || route.isFinal);

  // Alignment throttle: full speed pointing at the goal, nothing at all pointing
  // away from it. The ship accelerates gently out of a turn and hard once it is
  // on course, and it never has to stop and aim before setting off.
  const headingError = angleDifference(ship.angle || 0, desiredHeading);
  const alignment = clampNumber(Math.cos(headingError), 0, 1);
  const effectiveMaxSpeed = Number(stats.maxSpeed) || 0;
  const paperMaxSpeed = Number(ship.stats?.maxSpeed);
  const ownMaxSpeed = Number.isFinite(paperMaxSpeed) && paperMaxSpeed > 0
    ? Math.min(effectiveMaxSpeed, paperMaxSpeed)
    : effectiveMaxSpeed;
  const permitted = Math.min(
    ownMaxSpeed,
    ramming ? Infinity : safeArrivalSpeed,
    ramming ? Infinity : turnLimit,
    route ? route.cornerLimit : Infinity
  );

  const desiredSpeed = permitted * alignment;
  // Every limit in `permitted` is a hard one -- the arrival profile, the turn
  // radius, the corner, and this hull's own speed envelope -- so the ceiling is
  // the same figure. Live capability rebuilding may only derate the paper
  // maximum; it must not turn a damaged or heat-limited ship into a faster one.
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
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  ship.x = clampNumber(ship.x, EDGE_BOUNCE_MARGIN, width - EDGE_BOUNCE_MARGIN);
  ship.y = clampNumber(ship.y, EDGE_BOUNCE_MARGIN, height - EDGE_BOUNCE_MARGIN);
  ship.vx = clampNumber(ship.vx, -10000, 10000);
  ship.vy = clampNumber(ship.vy, -10000, 10000);
  ship.angle = normalizeHullAngle(Number(ship.angle) || 0);
  ship.targetX = clampNumber(ship.targetX, 0, width);
  ship.targetY = clampNumber(ship.targetY, 0, height);
}

function movementStep(room, ship, runtime, stats, routed, traffic, dt) {
  const route = routed ? routeView(ship, runtime, stats) : null;
  const bypassHeading = traffic?.mode === "bypass" && Number.isFinite(traffic.heading)
    ? traffic.heading
    : null;
  const bypassPoint = traffic?.mode === "bypass" && traffic.point
    && Number.isFinite(Number(traffic.point.x))
    && Number.isFinite(Number(traffic.point.y))
    ? traffic.point
    : null;
  const plan = planMovement(room, ship, runtime, stats, route, bypassHeading, bypassPoint);
  const sliding = applyStaticSlideSteering(
    room,
    ship,
    runtime,
    stats,
    route,
    plan,
    Number(ship._simNow) || 0
  );

  // Traffic has one of four explicit outcomes. A bypass owns the temporary
  // heading; following and queueing only cap forward speed. No generic lateral
  // nudge or proportional speed multiplier is applied to the route.
  if (!sliding && Number.isFinite(bypassHeading)) plan.desiredHeading = bypassHeading;
  if (!sliding && Number.isFinite(traffic?.speedCap)) {
    plan.desiredSpeed = Math.min(plan.desiredSpeed, traffic.speedCap);
    if (Number.isFinite(plan.speedCeiling)) plan.speedCeiling = Math.min(plan.speedCeiling, traffic.speedCap);
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
  // Station launch control advances these hulls at the movement boundary. Do
  // not let routing, steering, avoidance or integration touch them afterward.
  if (ship?.launchPhase) {
    ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);
    ship._collisionCorrectionX = 0;
    ship._collisionCorrectionY = 0;
    ship._integratedMovementX = 0;
    ship._integratedMovementY = 0;
    ship.turnActivity = 0;
    return;
  }
  initializeKinematics(ship);
  const runtime = ensureMovementRuntime(ship);
  ship._collisionCorrectionX = 0;
  ship._collisionCorrectionY = 0;
  ship._integratedMovementX = 0;
  ship._integratedMovementY = 0;
  ship.turnActivity = 0;
  // Cleared unconditionally so only refreshEngagement, running this same tick,
  // can turn it back on. A ram that outlived the order or the charge that
  // justified it would be a ship flying into things for no reason.
  runtime.ramming = false;

  let safeDt = Number(dt);
  if (!Number.isFinite(safeDt) || safeDt <= 0) return;
  safeDt = Math.min(safeDt, MAX_MOVEMENT_DT);
  ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);

  const stats = heatAdjustedMovementStats(ship, ship.stats || {});
  bumpMovementMetric("movementCapabilityBuilds");

  // Routing is strategy, not physics: it is resolved once per tick and the same
  // answer is flown by every substep. Re-running a path search inside the
  // integration loop buys nothing and costs a search per substep.
  const authority = movementAuthority(room, ship, runtime);
  if (authority === "engage") {
    // The stance turns a target into a destination only while the ship is out of
    // range; in range it produces none and the ship holds station and fires.
    refreshEngagement(room, ship, runtime, ship._simNow);
  } else if (authority === "stop") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
    clearRoute(runtime);
  } else if (authority === "position") {
    runtime.holdEngaged = false;
    runtime.chargeEngaged = false;
    runtime.blocked = false;
  }

  refreshStaticSlide(room, ship, runtime, ship._simNow);
  tryStaticSlideRecovery(room, ship, runtime, ship._simNow);
  const routed = runtime.destination
    ? resolveRoute(room, ship, runtime, ship._simNow)
    : false;
  if (!routed && runtime.path?.length) {
    runtime.path = [];
    runtime.waypointIndex = 0;
    runtime.route = null;
  }
  refreshStaticSlide(room, ship, runtime, ship._simNow);

  // Also once per tick: the spatial query is the expensive part, and a threat
  // that is worth dodging does not appear and vanish inside a single frame.
  const traffic = resolveTraffic(room, ship, runtime, ship._simNow);

  // Ceil, not round: the substep is an upper bound on integration error, and a
  // tick that rounded down would silently integrate more coarsely than the rest.
  // A tick that is a whole multiple of the substep -- 30 Hz, 60 Hz, 20 Hz --
  // divides exactly, so those cadences produce bit-identical trajectories.
  const steps = Math.max(1, Math.ceil(safeDt / MOVEMENT_SUBSTEP - 1e-9));
  const stepDt = safeDt / steps;
  for (let index = 0; index < steps; index += 1) {
    bumpMovementMetric("sharedControllerRuns");
    movementStep(room, ship, runtime, stats, routed, traffic, stepDt);
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
  return resolveShipSeparation(room, ships, dt, now, {
    ...getSeparationOptions(),
    dt
  });
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
  ship.commandMode = "move";
  setMovementCommand(ship, {
    id: `${commandId}:${ship.id}`,
    type: "move",
    destination,
    formationHeading: options.formationHeading,
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
    manual: true
  });
  const runtime = ensureMovementRuntime(ship);
  runtime.combatSlot = options.combatSlot || null;
  if (target) {
    const distance = engagementGeometry(ship, target).distance;
    if (combatStance(ship) !== "charge"
      && distance <= engagementRanges(ship, target, "attack", true).enter
      && currentFiringLineClear(room, ship, target)
      && (!runtime.combatSlot
        || (combatSlotPoint(target, runtime.combatSlot)
          && fastHypot(
            combatSlotPoint(target, runtime.combatSlot).x - ship.x,
            combatSlotPoint(target, runtime.combatSlot).y - ship.y
          ) <= COMBAT_SLOT_POSITION_TOLERANCE))) {
      runtime.holdEngaged = true;
    }
  }
  syncMovementTarget(ship);
  return true;
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
    const now = gameplayNow(room);
    const assignments = new Map();
    const modes = new Set(ships.map((ship) => combatModeForShip(ship)).filter(Boolean));
    for (const mode of modes) {
      const existing = combatGroupForTarget(room, livingTarget, mode);
      const selectedForMode = ships.filter((ship) => combatModeForShip(ship) === mode);
      const group = Array.from(new Map(
        [...existing, ...selectedForMode].map((ship) => [ship.id, ship])
      ).values());
      const modeAssignments = assignCombatSlots(room, group, livingTarget, mode, now);
      applyCombatSlotAssignments(group, modeAssignments);
      for (const [shipId, slot] of modeAssignments) assignments.set(shipId, slot);
    }
    for (const ship of ships) {
      issueAttack(room, ship, commandId, livingTarget.id, now, {
        combatSlot: assignments.get(ship.id) || null
      });
    }
    return { ok: true, code: "attack", commanded: ships.length };
  }
  if (ally) {
    for (const ship of ships) issueRepair(ship, commandId, livingTarget.id);
    return { ok: true, code: "repair", commanded: ships.length };
  }

  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const destination = {
    x: clampNumber(x, WORLD_MARGIN, width - WORLD_MARGIN),
    y: clampNumber(y, WORLD_MARGIN, height - WORLD_MARGIN)
  };
  const formationHeading = formationHeadingFor(ships, destination);
  const slots = generateDestinationSlots(room, ships, destination, formationHeading);

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
  const formationDestination = target?.count
    ? { x: target.x / target.count, y: target.y / target.count }
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

// Three stances are flown: Charge closes to contact, Hold approaches to weapons
// range and stops, Static never repositions at all. Orbit and Kite are still
// withdrawn in sanitizeCombatStyle and arrive here already resolved to Hold, so
// the controller never sees a stance it has no code for.
function applyCombatStyle(ship, combatStyle) {
  ship.combatStyle = combatStyle;
  // Runtime stance changes are already sanitized by the message router. Keep
  // the raw discriminator in step with that authoritative value as well:
  // combatStance() consults combatStyleRaw first so legacy spawn aliases can be
  // interpreted correctly, and leaving it stale made a ship continue flying
  // its previous stance while snapshots reported the newly selected one.
  ship.combatStyleRaw = combatStyle;
  const runtime = ensureMovementRuntime(ship);
  runtime.combatSlot = null;
  runtime.holdEngaged = false;
  runtime.chargeEngaged = false;
}

// Merge, not replace: a request naming one toggle leaves the rest of the ship's
// standing instructions alone, so the panel can send a single checkbox without
// having to restate everything else the player has already set.
function applyMovementToggles(ship, toggles) {
  ship.movementToggles = sanitizeMovementToggles(toggles, ship.movementToggles);
  return ship.movementToggles;
}

module.exports = {
  SUPPORTED_MOVEMENT_TYPES,
  applyCombatStyle,
  applyMovementToggles,
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



























