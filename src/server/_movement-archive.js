// =============================================================================
// ARCHIVED SERVER MOVEMENT CODE
// =============================================================================
//
// All of the files that used to make up the server-side ship movement system
// are archived in this single file. Every line is prefixed with "// " so the
// file is safe to leave in src/server/ without being loaded or executed.
//
// To restore the code later, copy each section back to its original
// src/server/<filename>.js path, strip the leading "// " from every line, and
// re-enable any require() / import() calls that were disabled while this code
// was archived.
//
// -----------------------------------------------------------------------------
// How the movement system used to work
// -----------------------------------------------------------------------------
//
// - movementTuning.js
//   A single frozen constants object for every movement tunable: world bounds,
//   arrival latches, flight-assist and facing thresholds, predictive ship
//   avoidance, hard-collision/separation, navigation grid settings, integration
//   substeps, and combat-style stand-off/shaping values. This was the one place
//   to change handling feel without touching the algorithms.
//
// - movementMetrics.js
//   A tiny telemetry helper that bumped named counters so movement could be
//   measured in production without adding inline logging.
//
// - movementRuntime.js
//   Owned the per-ship movement runtime object. It created/maintained
//   ship.movement, issued and cleared commands, tracked manual rotation,
//   allocated command ids, and synced command targets with the ship's
//   combat/focus targets.
//
// - movementCollision.js
//   Held the collision and separation pipeline: predictive local ship
//   avoidance, pairwise fleet separation, asteroid/station/world-edge map
//   collision resolution, and navigation clearance/physical radius helpers.
//
// - movementNavigation.js
//   Pathfinding for movement intents. It used a grid-based navigator to route
//   around asteroids and the world edge, exposed nearestClearPoint and
//   segmentCircleClearance helpers, and added station and world margin
//   awareness on top of the clearance geometry.
//
// - movementSteering.js
//   Built the low-level movement decision, resolved desired facing for
//   move/attack/orbit/kite/hold/charge/repair/stop intents, turned the hull
//   toward that facing, applied flight-assist velocity damping and speed limits,
//   integrated position, and added engine/maneuver heat based on thrust.
//
// - movementCommands.js
//   Handled incoming player and bot commands: right-click move with
//   deterministic destination slots, stop, attack, orbit, kite, hold, charge,
//   repair, rotate, and rally-point behaviour. Commands were validated against
//   ownership, relationships and world bounds.
//
// - movementIntents.js
//   Turned a ship's command and combat style into a concrete MovementIntent
//   (target, destination, throttle, facing rules, arrival rules, etc.) that the
//   steering and navigation code consumed.
//
// - movementModern.js
//   The authoritative public surface of the new movement implementation.
//   simulation.js called updateShipMovement from here. It initialized
//   kinematics, built heat-adjusted stats, created the intent, resolved
//   navigation, then subdivided the tick into 30 Hz physics substeps. Each
//   substep built a decision, steered the hull, applied thrust and speed limits,
//   integrated position and resolved collisions.
//
// - movementLegacy.js
//   The pre-rewrite movement implementation kept behind the MODERN_MOVEMENT
//   feature flag. It was loaded and merged with modern helpers when the flag was
//   off, providing the old behaviour for fallback.
//
// - movement.js
//   The module loader switch. If MODERN_MOVEMENT was enabled it exported
//   movementModern.js; otherwise it merged movementLegacy.js on top of the
//   modern helpers. This was the entry point that simulation.js and other
//   modules required.
//
// Other modules (simulation.js, ships.js, targetLocks.js, players.js,
// messageRouter.js, etc.) required these modules to drive ship position,
// commands, and bot spawning. Removing them means those consumers will need
// stubs or replacement code while the movement system is archived.
//
// =============================================================================

// ======== src/server/movementTuning.js ========
// "use strict";
// 
// // Single home for every movement tunable. Values that used to sit inline in
// // movementController/movementPropulsion/movementBasic/movementCollision live
// // here so the handling of the game can be tuned from one file.
// //
// // Ship performance itself (thrust -> speed/accel/turn curves) is NOT here: that
// // is derived in public/src/shared/movementStats.js, which the client mirrors for
// // blueprint previews. Keep the split -- this file is "how the autopilot flies",
// // that one is "what the hull is capable of".
// 
// module.exports = Object.freeze({
//   // --- World bounds -------------------------------------------------------
//   WORLD_MARGIN: 42,
//   EDGE_BOUNCE_MARGIN: 43,
//   EDGE_RESTITUTION: 0.3,
// 
//   // --- Arrival ------------------------------------------------------------
//   ARRIVE_DISTANCE: 16,
//   // "Close enough to standing still" for combat range-keeping, where a ship
//   // matching its target's velocity counts as on station.
//   ARRIVE_SPEED: 18,
//   // Arriving at a fixed destination is stricter: a ship still doing 18 px/s when
//   // it declares itself arrived spends the next couple of seconds turning to its
//   // final heading, and coasts well past the point while it does.
//   DESTINATION_ARRIVE_SPEED: 4,
//   // How far a parked ship may be nudged off its destination before it bothers
//   // to correct. Wide enough to ignore a separation shove, narrow enough that it
//   // never strands itself short of the point it was sent to.
//   //
//   // This has to be measured against where a ship actually STOPS, not against the
//   // destination: the braking profile reaches zero speed at ARRIVE_DISTANCE, so a
//   // parked ship is already sitting a full ARRIVE_DISTANCE out. At 1.25 that left
//   // 4 px of headroom, so a parked ship sat at 80% of its own tolerance and the
//   // first neighbour to jostle it tipped it out -- whereupon it re-commanded a
//   // crawl at the destination, and its nose followed that crawl. That was the
//   // "turned for no reason on arrival" pirouette. 2.0 leaves a whole
//   // ARRIVE_DISTANCE of slack on top of the stopping shortfall, which absorbs a
//   // separation shove without the ship ever deciding it has been displaced.
//   // A new order resets the phase to "travelling" (see setMovementCommand), so a
//   // wider latch can never suppress a genuine short move.
//   ARRIVE_LATCH_RATIO: 2,
//   FINAL_FACING_TOLERANCE: 0.035,
// 
//   // --- Flight assist ------------------------------------------------------
//   // Velocity decays toward the commanded velocity with this time constant.
//   // Lower = crisper answer to the helm. This is the primary "responsiveness"
//   // knob: at 0.12 a ship covers ~95% of a change of course in a third of a
//   // second, bounded by whatever its engines can actually deliver.
//   VELOCITY_TIME_CONSTANT_S: 0.12,
//   // Speed at or below which a ship asked to hold station is simply parked.
//   REST_SPEED: 0.5,
//   // Commanded speed below which there is no meaningful direction of travel, so
//   // the ship holds its heading rather than chasing a bearing that swings on
//   // every small displacement. Entering and leaving that state use different
//   // speeds: with one threshold, a ship hovering either side of it flips the
//   // source of its facing every tick, and a hull that can turn fast enough
//   // reproduces that flip exactly.
//   FACING_MIN_SPEED: 5,
//   FACING_MIN_SPEED_RELEASE: 3,
//   // How close the goal may get before its bearing stops meaning anything. Speed
//   // alone is not a sufficient test for "under way": an intent that skips arrival
//   // braking -- charge, most of all -- still commands cruise speed while standing
//   // on its goal, so the ship reads as travelling while the point it is steering
//   // at is a couple of pixels away. The bearing to a point that close swings
//   // faster than the hull can follow, and the hull chasing it moves the ship,
//   // which swings the bearing further: a charger parked on its target's hull
//   // rotated a full turn every three and a half seconds without going anywhere.
//   // Entering and leaving use different distances for the same reason the speed
//   // test does -- one threshold makes a ship hovering at the boundary swap the
//   // source of its facing every tick.
//   FACING_MIN_GOAL_DISTANCE: 16,
//   FACING_MIN_GOAL_DISTANCE_RELEASE: 8,
//   // How far the newly computed facing must sit from the one already commanded
//   // before the hull is told about it. Below this the previous command stands.
//   // Without it a fast hull is a 1:1 follower of a signal that jitters with every
//   // separation shove and every branch flip in resolveDesiredFacing.
//   FACING_COMMAND_HYSTERESIS: 0.06,
//   // Fraction of the remaining heading error the hull takes per tick once that
//   // error is small enough to cover in one tick. Above that it is rate-limited as
//   // before, so this only shapes the last few degrees -- the part a fast hull
//   // used to cross in a single snap.
//   TURN_COMMAND_DAMPING: 0.35,
//   // Turn penalty while running on the backup core.
//   BACKUP_CORE_TURN_SCALE: 0.9,
// 
//   // --- Ship avoidance (predictive, pre-collision) ------------------------
//   AVOIDANCE_HORIZON_S: 1.15,
//   AVOIDANCE_HORIZON_SPAWN_S: 1.8,
//   AVOIDANCE_QUERY_MIN_RANGE: 120,
//   AVOIDANCE_CLEARANCE_PAD: 6,
//   AVOIDANCE_CLEARANCE_PAD_SPAWN: 12,
//   // How long a ship commits to dodging left or right. Prevents the pair from
//   // re-deciding every tick and shimmying against each other.
//   AVOIDANCE_SIDE_COMMIT_MS: 700,
//   AVOIDANCE_STRENGTH_YIELD: 1,
//   AVOIDANCE_STRENGTH_EQUAL: 0.65,
//   AVOIDANCE_STRENGTH_RIGHT_OF_WAY: 0.22,
//   AVOIDANCE_BRAKE_TIME_S: 0.45,
//   // Sidestep is a velocity offset, as a fraction of the ship's top speed scaled
//   // by the strengths above, with a floor so near-stationary ships still edge out
//   // of the way. It has to be a real swerve: a token nudge leaves a heavy ship
//   // bulldozing whatever is in front of it rather than going round.
//   //
//   // This sets the ANGLE of the dodge, not its speed: applyLocalShipAvoidance
//   // bounds the amended command by the intent's own throttle, so a ratio of 1
//   // means the lateral term is comparable to the forward one -- a decisive swerve
//   // -- and not, as it used to, a full-throttle broadside dash. Turning it down
//   // was tried and is the wrong lever: it costs a heavy hull the lateral term it
//   // needs to clear a light one, and buys nothing the magnitude bound has not
//   // already bought.
//   AVOIDANCE_MIN_LATERAL: 18,
//   AVOIDANCE_SIDESTEP_RATIO: 1,
//   // How much of the original course a give-way keeps. Giving way used to replace
//   // the commanded velocity with the sidestep outright, which leaves a vector
//   // perpendicular to the goal -- zero closing rate. A ship that gives way has to
//   // still be going somewhere, or it slides sideways until the obstruction leaves,
//   // and in a crowd the obstruction never leaves.
//   AVOIDANCE_YIELD_COURSE_RETENTION: 0.35,
// 
//   // --- Hard collision / separation ---------------------------------------
//   SHIP_MASS_RIGHT_OF_WAY_RATIO: 1.35,
//   SEPARATION_ITERATIONS: 4,
//   SEPARATION_SLOP: 0.2,
//   SEPARATION_CORRECTION: 0.88,
//   SEPARATION_MAX_BIAS_SPEED: 8,
//   SEPARATION_BIAS_SCALE: 0.8,
//   SEPARATION_MIN_IMPULSE_CAP: 20,
//   SEPARATION_IMPULSE_HEADROOM: 12,
//   SEPARATION_BROAD_PHASE_PAD: 192,
//   ASTEROID_RESTITUTION: 1.5,
//   ASTEROID_QUERY_PAD: 128,
//   STOPPED_SPEED: 3,
// 
//   // --- Navigation ---------------------------------------------------------
//   NAV_GRID_CELL_SIZE: 24,
//   NAV_REPLAN_MOVE_THRESHOLD: 60,
//   NAV_REPLAN_COMBAT_THRESHOLD: 120,
//   // A charge aims at a contact point roughly one hull across, so the 120 px
//   // combat threshold is wider than the goal itself -- the charger would chase a
//   // position the target left long ago.
//   NAV_REPLAN_CHARGE_THRESHOLD: 40,
//   NAV_STUCK_TIME_MS: 1500,
//   NAV_WAYPOINT_CAPTURE_RATIO: 0.75,
//   NAV_PROGRESS_EPSILON: 8,
// 
//   // --- Integration --------------------------------------------------------
//   MAX_MOVEMENT_DT: 0.25,
//   MOVEMENT_SUBSTEP: 1 / 30,
// 
//   // --- Combat style stand-off ratios -------------------------------------
//   HOLD_RANGE_RATIO: 0.9,
//   ORBIT_RANGE_RATIO: 0.9,
//   KITE_RANGE_RATIO: 0.9,
// 
//   // --- Combat style shaping ----------------------------------------------
//   // Orbit steers at a point on the circle this far ahead of the ship, measured
//   // as an angle about the target. The ship therefore always flies toward the
//   // ring itself, which corrects the radius without a separate controller.
//   // Larger cuts the corner inward and flies a polygon; smaller tracks the
//   // circle tightly but spends the whole orbit turning.
//   ORBIT_LEAD_ANGLE: 0.45,
//   // How far around the circle the aim point may slide looking for somewhere the
//   // ship can actually be, before orbit gives up on this direction and reverses.
//   // Six steps sweeps ~155 degrees, which clears anything short of an obstacle
//   // that swallows half the ring -- and half the ring is a case where reversing
//   // is the right answer anyway.
//   //
//   // The long slide looks wrong on paper: the ship flies the chord to its aim
//   // point, and a chord subtending 155 degrees passes 0.22r from the centre, so
//   // in principle a blocked near arc is an order to cut across the middle of the
//   // orbit. Capping it was tried and measured worse on both cases that exercise
//   // it. Pulling the aim point back lands it on the obstacle, and the route the
//   // navigator then finds around the obstacle dives further inside the ring than
//   // the chord ever did -- 205 px on a 507 px ring, against 434 px for the long
//   // slide. Against a ring clipped by the world edge, capping forces a reversal
//   // instead, and the hairpin cuts in to 104 px. Leave it long.
//   ORBIT_LEAD_STEPS: 6,
//   // Charge aims where the target will be, not where it is. Capped so a fast
//   // target seen from across the map does not send the charger to empty space.
//   CHARGE_LEAD_MAX_S: 1.5,
//   // A charge deliberately skips arrival braking -- stopping ARRIVE_DISTANCE short
//   // is exactly wrong for the stance whose purpose is contact. But arriving at the
//   // contact ring at full throttle is just as wrong: separation actively holds the
//   // pair apart, so the charger is shoved back out, re-accelerates into the same
//   // wall, and oscillates about the target forever instead of sitting on its hull.
//   // Throttle is tapered over the last CHARGE_SETTLE_TIME_S of closing instead, so
//   // the ship still never stops short -- it just stops slamming.
//   CHARGE_SETTLE_TIME_S: 0.55,
//   // Zero at the contact ring itself. Any floor here is a permanent order to keep
//   // driving into a hull the separation solver is already holding off, which is a
//   // limit cycle by construction: the ship rams, gets pushed out, rams again. A
//   // charger that has arrived should sit on its target and shoot; it picks the
//   // throttle straight back up the moment the target opens the range.
//   CHARGE_MIN_SPEED_FACTOR: 0,
//   REPAIR_STANDOFF_PAD: 30,
// 
//   // --- Component heat from movement --------------------------------------
//   ENGINE_HEAT_BASE: 2,
//   ENGINE_HEAT_PER_THRUST: 0.018,
//   MANEUVER_HEAT_PER_THRUST: 0.018
// });

// ======== src/server/movementMetrics.js ========
// "use strict";
// 
// function movementMetrics() {
//   return global.__mfaMovePerf || null;
// }
// 
// function bumpMovementMetric(name, amount = 1) {
//   const metrics = movementMetrics();
//   if (metrics) metrics[name] = (metrics[name] || 0) + amount;
// }
// 
// module.exports = { bumpMovementMetric };

// ======== src/server/movementRuntime.js ========
// "use strict";
// 
// function finitePoint(point) {
//   return point && Number.isFinite(point.x) && Number.isFinite(point.y)
//     ? { x: Number(point.x), y: Number(point.y) }
//     : null;
// }
// 
// function emptyNavigation() {
//   return {
//     waypoints: [],
//     waypointIndex: 0,
//     plannedDestination: null,
//     plannedAt: 0,
//     commandId: null,
//     clearance: null,
//     finalFacing: null
//   };
// }
// 
// function emptyStyle() {
//   return {
//     orbit: null,
//     holdPosition: null,
//     holdTargetId: null,
//     kite: null
//   };
// }
// 
// function createMovementRuntime() {
//   return {
//     command: null,
//     navigation: emptyNavigation(),
//     style: emptyStyle(),
//     phase: "idle",
//     // Last facing actually commanded to the hull. Held across ticks so small
//     // wobble in the computed desire does not reach a fast-turning ship.
//     facingCommand: null
//   };
// }
// 
// function ensureMovementRuntime(ship) {
//   if (!ship.movement || typeof ship.movement !== "object") {
//     ship.movement = createMovementRuntime();
//   }
//   return ship.movement;
// }
// 
// function resetNavigation(ship) {
//   const runtime = ensureMovementRuntime(ship);
//   runtime.navigation = emptyNavigation();
//   runtime.facingCommand = null;
// }
// 
// function resetStyleMemory(ship, combatStyle = ship.combatStyle) {
//   const runtime = ensureMovementRuntime(ship);
//   runtime.style.orbit = null;
//   runtime.style.holdPosition = null;
//   runtime.style.holdTargetId = null;
//   runtime.style.kite = null;
// }
// 
// function setMovementCommand(ship, command) {
//   const runtime = ensureMovementRuntime(ship);
//   const previousTargetId = runtime.command?.targetId || null;
//   runtime.command = command
//     ? {
//       id: String(command.id),
//       type: String(command.type),
//       destination: finitePoint(command.destination),
//       targetId: command.targetId == null ? null : String(command.targetId),
//       finalFacing: Number.isFinite(command.finalFacing) ? Number(command.finalFacing) : null,
//       manual: Boolean(command.manual)
//     }
//     : null;
//   runtime.navigation = emptyNavigation();
//   ship.manualRotation = null;
//   if (!command) {
//     runtime.phase = "idle";
//   } else if (command.type === "stop") {
//     runtime.phase = "braking";
//   } else {
//     runtime.phase = "travelling";
//   }
//   if (previousTargetId !== runtime.command?.targetId || command?.type !== "attack") {
//     runtime.style.orbit = null;
//     runtime.style.holdPosition = null;
//     runtime.style.holdTargetId = null;
//     runtime.style.kite = null;
//   }
//   return runtime.command;
// }
// 
// function nextMovementCommandId(room, prefix = "m") {
//   room._nextCommandId = (Number(room._nextCommandId) || 0) + 1;
//   return `${prefix}${room._nextCommandId}`;
// }
// 
// function setManualRotation(ship, direction) {
//   const runtime = ensureMovementRuntime(ship);
//   ship.manualRotation = direction === 1 || direction === -1 ? direction : null;
//   if (ship.manualRotation) runtime.phase = "turning";
// }
// 
// function syncMovementTarget(ship, intent = null) {
//   const runtime = ensureMovementRuntime(ship);
//   const command = runtime.command;
//   const destination = finitePoint(intent?.destination) || finitePoint(command?.destination);
//   ship.targetX = destination?.x ?? (Number(ship.x) || 0);
//   ship.targetY = destination?.y ?? (Number(ship.y) || 0);
// }
// 
// module.exports = {
//   createMovementRuntime,
//   ensureMovementRuntime,
//   nextMovementCommandId,
//   resetNavigation,
//   resetStyleMemory,
//   setManualRotation,
//   setMovementCommand,
//   syncMovementTarget
// };

// ======== src/server/movementCollision.js ========
// "use strict";
// 
// const { clampNumber, fastHypot, hashString, compareEntityIds, compareNaturalIds } = require("./utils");
// const { findShipHullOverlap } = require("./componentGeometry");
// const {
//   ASTEROID_QUERY_PAD,
//   ASTEROID_RESTITUTION,
//   AVOIDANCE_BRAKE_TIME_S,
//   AVOIDANCE_CLEARANCE_PAD,
//   AVOIDANCE_CLEARANCE_PAD_SPAWN,
//   AVOIDANCE_HORIZON_S,
//   AVOIDANCE_HORIZON_SPAWN_S,
//   AVOIDANCE_MIN_LATERAL,
//   AVOIDANCE_QUERY_MIN_RANGE,
//   AVOIDANCE_SIDESTEP_RATIO,
//   AVOIDANCE_SIDE_COMMIT_MS,
//   AVOIDANCE_STRENGTH_EQUAL,
//   AVOIDANCE_STRENGTH_RIGHT_OF_WAY,
//   AVOIDANCE_STRENGTH_YIELD,
//   AVOIDANCE_YIELD_COURSE_RETENTION,
//   SEPARATION_BIAS_SCALE,
//   SEPARATION_BROAD_PHASE_PAD,
//   SEPARATION_CORRECTION,
//   SEPARATION_IMPULSE_HEADROOM,
//   SEPARATION_ITERATIONS,
//   SEPARATION_MAX_BIAS_SPEED,
//   SEPARATION_MIN_IMPULSE_CAP,
//   SEPARATION_SLOP,
//   SHIP_MASS_RIGHT_OF_WAY_RATIO,
//   STOPPED_SPEED,
//   WORLD_MARGIN
// } = require("./movementTuning");
// const { bumpMovementMetric } = require("./movementMetrics");
// 
// // combat.js pulls in most of the simulation, so resolve it on first use rather
// // than at load time -- this module sits underneath it.
// let cachedAreEnemies = null;
// function areEnemies(room, a, b) {
//   if (!cachedAreEnemies) cachedAreEnemies = require("./combat").areEnemies;
//   return cachedAreEnemies(room, a, b);
// }
// 
// let cachedResolveStationCollision = null;
// function resolveStationCollision(room, ship, shipRadius) {
//   if (!cachedResolveStationCollision) cachedResolveStationCollision = require("./stations").resolveStationCollision;
//   if (!cachedResolveStationCollision) return false;
//   return cachedResolveStationCollision(room, ship, shipRadius);
// }
// 
// function physicalCollisionRadius(ship) {
//   return Math.max(18, Number(ship?.physicalRadius) || (Number(ship?.radius) || 0) * 0.56);
// }
// 
// function navigationClearanceRadius(ship) {
//   const physical = physicalCollisionRadius(ship);
//   return physical + Math.max(8, (Number(ship?.radius) || 0) * 0.12);
// }
// 
// function separationRadius(ship) {
//   return physicalCollisionRadius(ship) + 4;
// }
// 
// function collisionCounters(room) {
//   return room.spawnCollisionDiagnostics || (room.spawnCollisionDiagnostics = {});
// }
// 
// function collisionBump(room, key, amount = 1) {
//   const counters = collisionCounters(room);
//   counters[key] = (counters[key] || 0) + amount;
// }
// 
// function shipIsStopped(ship) {
//   const phase = ship.movement?.phase;
//   return fastHypot(ship.vx || 0, ship.vy || 0) < STOPPED_SPEED
//     && (!ship.movement?.command
//       || ship.movement.command.type === "stop"
//       || phase === "positioned"
//       || phase === "idle");
// }
// 
// function stableAvoidancePriority(ship, other) {
//   const shipMass = Math.max(1, Number(ship.stats?.mass) || 1);
//   const otherMass = Math.max(1, Number(other.stats?.mass) || 1);
//   if (otherMass >= shipMass * SHIP_MASS_RIGHT_OF_WAY_RATIO) return 1;
//   if (shipMass >= otherMass * SHIP_MASS_RIGHT_OF_WAY_RATIO) return -1;
//   const otherStopped = shipIsStopped(other);
//   const shipStopped = shipIsStopped(ship);
//   if (otherStopped !== shipStopped) return otherStopped ? 1 : -1;
//   const massDifference = otherMass - shipMass;
//   if (Math.abs(massDifference) > 0.01) return massDifference > 0 ? 1 : -1;
//   return compareNaturalIds(other.id, ship.id) < 0 ? 1 : -1;
// }
// 
// function applyLocalShipAvoidance(room, ship, decision, stats, now) {
//   if (!decision.needsPropulsion
//     || !room.spatialIndex?.dynamicValid
//     || !room.spatialIndex.queryRangeUnordered) return;
//   const ownRadius = physicalCollisionRadius(ship);
//   const speed = fastHypot(ship.vx || 0, ship.vy || 0);
//   const spawning = Boolean(ship.spawnState && now < ship.spawnState.expiresAt);
//   const horizon = spawning ? AVOIDANCE_HORIZON_SPAWN_S : AVOIDANCE_HORIZON_S;
//   const queryRadius = ownRadius * 2
//     + Math.max(AVOIDANCE_QUERY_MIN_RANGE, speed * horizon);
//   // A player who right-clicks past an enemy asked for that line, not for a
//   // detour around it. Pathing already ignores ships entirely -- the swerve came
//   // from here -- so dropping enemies from the avoidance set while a hand-issued
//   // move is running gives the straight run. Enemy hulls stay solid: the ship
//   // drives into them and shoves through rather than sliding round.
//   const command = ship.movement?.command;
//   const drivingThrough = Boolean(command?.manual && command.type === "move");
//   const scratch = ship._shipAvoidanceScratch || (ship._shipAvoidanceScratch = []);
//   const nearby = room.spatialIndex.queryRangeUnordered(
//     "ships",
//     ship.x,
//     ship.y,
//     queryRadius,
//     scratch
//   );
//   let best = null;
//   for (const other of nearby) {
//     if (!other?.alive || other === ship) continue;
//     if (drivingThrough && areEnemies(room, ship.ownerId, other.ownerId)) continue;
//     const rx = other.x - ship.x;
//     const ry = other.y - ship.y;
//     const rvx = (other.vx || 0) - (ship.vx || 0);
//     const rvy = (other.vy || 0) - (ship.vy || 0);
//     const relativeSpeedSq = rvx * rvx + rvy * rvy;
//     const time = relativeSpeedSq > 0.01
//       ? clampNumber(-(rx * rvx + ry * rvy) / relativeSpeedSq, 0, horizon)
//       : 0;
//     const predictedX = rx + rvx * time;
//     const predictedY = ry + rvy * time;
//     const minimum = ownRadius + physicalCollisionRadius(other)
//       + (spawning ? AVOIDANCE_CLEARANCE_PAD_SPAWN : AVOIDANCE_CLEARANCE_PAD);
//     const predicted = fastHypot(predictedX, predictedY);
//     if (predicted >= minimum
//       || (!best && rx * rvx + ry * rvy >= 0 && fastHypot(rx, ry) > minimum * 1.15)) continue;
//     const urgency = minimum - predicted + (horizon - time) * 0.1;
//     if (!best
//       || urgency > best.urgency
//       || (urgency === best.urgency && String(other.id) < String(best.other.id))) {
//       best = { other, rx, ry, time, urgency };
//     }
//   }
//   if (!best) return;
// 
//   // The side commitment belongs to the ship's own course, not to whichever
//   // neighbour happens to be the most urgent this tick. Keying it to best.other
//   // meant that in any group the commitment was void the moment a different hull
//   // took the lead -- which in a six-ship arrival happened several times a second.
//   // Re-deciding flips the sign of the sidestep, and the sidestep is the whole
//   // heading once a ship is giving way, so the commanded facing swung 180 degrees
//   // and back: 698 flips in 40 seconds, and a hull that spun continuously trying
//   // to follow them. The dodge now stands for its full duration whatever else
//   // wanders into range.
//   const state = ship._shipAvoidance || (ship._shipAvoidance = {});
//   let side = now < (state.committedUntil || 0) ? state.side : 0;
//   if (!side) {
//     const travelX = Math.cos(decision.moveAngle || ship.angle || 0);
//     const travelY = Math.sin(decision.moveAngle || ship.angle || 0);
//     const cross = travelX * best.ry - travelY * best.rx;
//     side = Math.abs(cross) > 0.01
//       ? (cross > 0 ? -1 : 1)
//       : (hashString(`${ship.id}:${best.other.id}`) & 1 ? 1 : -1);
//     if (state.side && state.side !== side) collisionBump(room, "shipAvoidanceSideChanges");
//     state.otherShipId = best.other.id;
//     state.side = side;
//     state.committedUntil = now + AVOIDANCE_SIDE_COMMIT_MS;
//   }
// 
//   const priority = stableAvoidancePriority(ship, best.other);
//   const shipMass = Math.max(1, Number(ship.stats?.mass) || 1);
//   const otherMass = Math.max(1, Number(best.other.stats?.mass) || 1);
//   const hasMassRightOfWay = priority < 0
//     && shipMass >= otherMass * SHIP_MASS_RIGHT_OF_WAY_RATIO;
//   const strength = priority > 0
//     ? AVOIDANCE_STRENGTH_YIELD
//     : (hasMassRightOfWay ? AVOIDANCE_STRENGTH_RIGHT_OF_WAY : AVOIDANCE_STRENGTH_EQUAL);
//   // Avoidance steers by sidestepping the commanded velocity, not by pushing on
//   // the hull. Under flight assist the ship simply flies the amended command, and
//   // its heading follows from it -- so a dodge turns the ship as a consequence
//   // rather than by overwriting the facing, which used to snap the heading ~24
//   // degrees the instant a neighbour came into range and snap it back when they
//   // parted.
//   const sidestep = Math.max(
//     AVOIDANCE_MIN_LATERAL,
//     (Number(decision.maximumSpeed) || 0) * AVOIDANCE_SIDESTEP_RATIO
//   ) * strength;
//   // Avoidance may change where the command points. It may never raise how fast
//   // it asks for. On the final approach that budget is the braking profile, which
//   // has already reduced the commanded speed to what the remaining distance can
//   // absorb; everywhere else it is the intent's own throttle -- decision.maximumSpeed
//   // carries intent.maxSpeedFactor, so a stance that has deliberately wound the
//   // throttle down keeps it wound down.
//   //
//   // Leaving the non-arrival case uncapped meant a settled charger, whose own
//   // throttle is zero because it is sitting on its target's hull, was handed a
//   // lateral command anyway. Facing follows the commanded velocity, so the ship
//   // swung broadside to a target it was supposed to be ramming, and swung back
//   // when the dodge committed to the other side: 111 deg/s of rotation on a hull
//   // travelling 3 px/s.
//   const commandSpeedCap = decision.arrivalRequired && decision.isFinal && decision.goal
//     ? Math.max(0, Number(decision.desiredSpeed) || 0)
//     : Math.max(0, Number(decision.maximumSpeed) || 0);
//   const boundedSidestep = Math.min(sidestep, commandSpeedCap);
//   // Nothing left in the budget to steer with -- the intent has already wound the
//   // throttle to nothing, and a zero-length sidestep can only leave the command
//   // where it was. Bail rather than report an activation that did not happen.
//   if (boundedSidestep <= 0) return;
//   const forwardX = Math.cos(decision.moveAngle || ship.angle || 0);
//   const forwardY = Math.sin(decision.moveAngle || ship.angle || 0);
//   const sidestepX = -forwardY * side * boundedSidestep;
//   const sidestepY = forwardX * side * boundedSidestep;
//   // Exactly one ship in a pair gives way, and it is the one that lost the
//   // right-of-way test. The old disjunction also yielded on a short time to
//   // closest approach whenever the ship lacked a mass advantage -- but two hulls
//   // of similar mass both lack one, so both gave way to each other, neither
//   // closed, and a crowd converging on a rally point simply milled about. Priority
//   // is antisymmetric by construction, so this branch can only be true on one side
//   // of any pair.
//   const yielding = priority > 0 && best.time < AVOIDANCE_BRAKE_TIME_S;
//   if (yielding) {
//     // Give way by leaning off the course, not by abandoning it. Replacing the
//     // command with the sidestep alone leaves a velocity perpendicular to the
//     // goal -- the ship stops closing entirely and slides sideways for as long as
//     // anything is near it. Keeping a fraction of the course still opens the gap
//     // while the ship continues to make ground.
//     decision.desiredVelocity.x = decision.desiredVelocity.x * AVOIDANCE_YIELD_COURSE_RETENTION
//       + sidestepX;
//     decision.desiredVelocity.y = decision.desiredVelocity.y * AVOIDANCE_YIELD_COURSE_RETENTION
//       + sidestepY;
//   } else {
//     decision.desiredVelocity.x += sidestepX;
//     decision.desiredVelocity.y += sidestepY;
//   }
//   const amendedSpeed = fastHypot(
//     decision.desiredVelocity.x,
//     decision.desiredVelocity.y
//   );
//   if (amendedSpeed > commandSpeedCap && amendedSpeed > 0) {
//     const scale = commandSpeedCap / amendedSpeed;
//     decision.desiredVelocity.x *= scale;
//     decision.desiredVelocity.y *= scale;
//   }
//   decision.needsPropulsion = true;
//   collisionBump(room, "shipAvoidanceActivations");
// }
// 
// function resolveMapCollision(room, ship) {
//   const radius = physicalCollisionRadius(ship);
//   const width = room?.world?.width || 2000;
//   const height = room?.world?.height || 1600;
//   const scratch = room._mapCollisionScratch || (room._mapCollisionScratch = []);
//   const asteroids = room.spatialIndex?.dynamicValid && room.spatialIndex.queryAabbUnordered
//     ? room.spatialIndex.queryAabbUnordered(
//       "asteroids",
//       ship.x - radius - ASTEROID_QUERY_PAD,
//       ship.y - radius - ASTEROID_QUERY_PAD,
//       ship.x + radius + ASTEROID_QUERY_PAD,
//       ship.y + radius + ASTEROID_QUERY_PAD,
//       scratch
//     )
//     : (room.map?.asteroids || []);
//   let hit = false;
//   for (const asteroid of asteroids) {
//     if (!asteroid) continue;
//     let dx = (ship.x || 0) - asteroid.x;
//     let dy = (ship.y || 0) - asteroid.y;
//     let distance = fastHypot(dx, dy);
//     const minimum = (asteroid.radius || 0) + radius;
//     if (distance >= minimum) continue;
//     hit = true;
//     if (distance <= 0.001) {
//       const angle = ((hashString(String(ship.id)) >>> 0) / 0x100000000) * Math.PI * 2;
//       dx = Math.cos(angle);
//       dy = Math.sin(angle);
//       distance = 1;
//     }
//     const penetration = minimum - distance;
//     const normalX = dx / distance;
//     const normalY = dy / distance;
//     ship.x += normalX * penetration;
//     ship.y += normalY * penetration;
//     ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + normalX * penetration;
//     ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + normalY * penetration;
//     const inwardSpeed = (ship.vx || 0) * normalX + (ship.vy || 0) * normalY;
//     if (inwardSpeed < 0) {
//       ship.vx -= inwardSpeed * normalX * ASTEROID_RESTITUTION;
//       ship.vy -= inwardSpeed * normalY * ASTEROID_RESTITUTION;
//     }
//   }
//   if (resolveStationCollision(room, ship, radius)) hit = true;
//   const edge = WORLD_MARGIN + radius;
//   const beforeX = ship.x;
//   const beforeY = ship.y;
//   ship.x = clampNumber(ship.x, edge, width - edge);
//   ship.y = clampNumber(ship.y, edge, height - edge);
//   ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + ship.x - beforeX;
//   ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + ship.y - beforeY;
//   if (hit) bumpMovementMetric("collisionCount");
//   return hit;
// }
// 
// function resolveSeparationPair(room, a, b) {
//   const broadDx = (b.x || 0) - (a.x || 0);
//   const broadDy = (b.y || 0) - (a.y || 0);
//   const broadMinimum = physicalCollisionRadius(a) + physicalCollisionRadius(b);
//   if (broadDx * broadDx + broadDy * broadDy >= broadMinimum * broadMinimum) return null;
//   const overlap = findShipHullOverlap(a, b);
//   if (!overlap) return null;
// 
//   let normalX;
//   let normalY;
//   if (overlap.distance > 0.001) {
//     normalX = overlap.dx / overlap.distance;
//     normalY = overlap.dy / overlap.distance;
//   } else if (fastHypot(broadDx, broadDy) > 0.001) {
//     const inverse = 1 / fastHypot(broadDx, broadDy);
//     normalX = broadDx * inverse;
//     normalY = broadDy * inverse;
//   } else {
//     normalX = compareNaturalIds(a.id, b.id) <= 0 ? 1 : -1;
//     normalY = 0;
//   }
// 
//   const inverseMassA = 1 / Math.max(1, Number(a.stats?.mass) || 1);
//   const inverseMassB = 1 / Math.max(1, Number(b.stats?.mass) || 1);
//   const inverseMassSum = inverseMassA + inverseMassB;
//   const correctedPenetration = Math.max(0, overlap.penetration - SEPARATION_SLOP);
//   const correction = correctedPenetration * SEPARATION_CORRECTION;
//   const moveA = correction * inverseMassA / inverseMassSum;
//   const moveB = correction * inverseMassB / inverseMassSum;
//   const width = room.world?.width || 2000;
//   const height = room.world?.height || 1600;
//   const edgeA = WORLD_MARGIN + physicalCollisionRadius(a);
//   const edgeB = WORLD_MARGIN + physicalCollisionRadius(b);
//   const oldAX = a.x;
//   const oldAY = a.y;
//   const oldBX = b.x;
//   const oldBY = b.y;
//   a.x = clampNumber(a.x - normalX * moveA, edgeA, width - edgeA);
//   a.y = clampNumber(a.y - normalY * moveA, edgeA, height - edgeA);
//   b.x = clampNumber(b.x + normalX * moveB, edgeB, width - edgeB);
//   b.y = clampNumber(b.y + normalY * moveB, edgeB, height - edgeB);
//   a._collisionCorrectionX = (a._collisionCorrectionX || 0) + a.x - oldAX;
//   a._collisionCorrectionY = (a._collisionCorrectionY || 0) + a.y - oldAY;
//   b._collisionCorrectionX = (b._collisionCorrectionX || 0) + b.x - oldBX;
//   b._collisionCorrectionY = (b._collisionCorrectionY || 0) + b.y - oldBY;
// 
//   const relativeVx = (b.vx || 0) - (a.vx || 0);
//   const relativeVy = (b.vy || 0) - (a.vy || 0);
//   const closingSpeed = relativeVx * normalX + relativeVy * normalY;
//   // Only ships actually driving into each other get an impulse. The positional
//   // correction above already resolves overlap; adding a bias velocity to every
//   // touching pair regardless -- including two that are stationary -- injected
//   // energy the movers then had to fight, every tick.
//   let impulseMagnitude = 0;
//   if (closingSpeed < 0) {
//     const biasSpeed = Math.min(
//       SEPARATION_MAX_BIAS_SPEED,
//       correctedPenetration * SEPARATION_BIAS_SCALE
//     );
//     const maxImpulse = Math.max(
//       SEPARATION_MIN_IMPULSE_CAP,
//       (Math.abs(closingSpeed) + SEPARATION_IMPULSE_HEADROOM) / inverseMassSum
//     );
//     impulseMagnitude = clampNumber(
//       (-closingSpeed + biasSpeed) / inverseMassSum,
//       0,
//       maxImpulse
//     );
//   }
//   if (impulseMagnitude > 0) {
//     a.vx = (a.vx || 0) - impulseMagnitude * inverseMassA * normalX;
//     a.vy = (a.vy || 0) - impulseMagnitude * inverseMassA * normalY;
//     b.vx = (b.vx || 0) + impulseMagnitude * inverseMassB * normalX;
//     b.vy = (b.vy || 0) + impulseMagnitude * inverseMassB * normalY;
//     collisionBump(room, "shipCollisionImpulseApplied");
//   }
//   collisionBump(room, "shipCollisionPairs");
//   collisionBump(room, "shipCollisionPenetrationCorrected", correctedPenetration);
//   const pairKey = String(a.id) < String(b.id)
//     ? `${a.id}|${b.id}`
//     : `${b.id}|${a.id}`;
//   const contacts = room._shipCollisionContacts || (room._shipCollisionContacts = new Map());
//   const previous = contacts.get(pairKey);
//   const tick = Number(a._simNow || b._simNow) || 0;
//   const stationary = [a, b].find((ship) =>
//     shipIsStopped(ship)
//     && fastHypot(ship._integratedMovementX || 0, ship._integratedMovementY || 0) < 0.5);
//   const consecutive = previous && tick - previous.at < 300
//     ? previous.consecutive + 1
//     : 1;
//   contacts.set(pairKey, { at: tick, consecutive });
//   if (stationary
//     && consecutive === 12
//     && fastHypot(
//       stationary._collisionCorrectionX || 0,
//       stationary._collisionCorrectionY || 0
//     ) > 2) {
//     collisionBump(room, "towingRegressionDetections");
//   }
//   return { penetration: overlap.penetration };
// }
// 
// function getLiveShips(room) {
//   return Array.from(room.ships?.values() || []).filter((ship) => ship && ship.alive);
// }
// 
// const COLLISION_CONTACT_RETENTION_MS = 1000;
// 
// function pruneCollisionContacts(room, now) {
//   const contacts = room?._shipCollisionContacts;
//   const tick = Number(now) || 0;
//   if (!contacts?.size || tick <= 0) return;
//   if (tick < (Number(room._nextShipCollisionContactPruneAt) || 0)) return;
//   for (const [pairKey, contact] of contacts) {
//     if (tick - (Number(contact?.at) || 0) > COLLISION_CONTACT_RETENTION_MS) {
//       contacts.delete(pairKey);
//     }
//   }
//   room._nextShipCollisionContactPruneAt = tick + COLLISION_CONTACT_RETENTION_MS;
// }
// 
// function updateShipSeparation(room, shipList, dt, now = 0) {
//   pruneCollisionContacts(room, now);
//   const ships = (Array.isArray(shipList)
//     ? shipList.filter((ship) => ship && ship.alive)
//     : getLiveShips(room))
//     .slice()
//     .sort(compareEntityIds);
//   // Pair resolution has to visit (a, b) in a stable order, and it used to
//   // establish that order by comparing ids for every candidate of every ship on
//   // every iteration. Stamping each ship's rank in the already-sorted list turns
//   // those comparisons into integer arithmetic. Ships the spatial index returns
//   // that are not part of this pass keep the id comparison, so the ordering is
//   // identical either way.
//   const orderEpoch = (room._separationOrderEpoch = (Number(room._separationOrderEpoch) || 0) + 1);
//   for (let index = 0; index < ships.length; index += 1) {
//     ships[index]._separationOrder = index;
//     ships[index]._separationOrderEpoch = orderEpoch;
//   }
//   const rankOf = (ship) => (ship._separationOrderEpoch === orderEpoch ? ship._separationOrder : -1);
//   const byRank = (x, y) => {
//     const xRank = rankOf(x);
//     const yRank = rankOf(y);
//     return xRank >= 0 && yRank >= 0 ? xRank - yRank : compareEntityIds(x, y);
//   };
//   const modified = new Set();
//   let unresolved = [];
//   for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration += 1) {
//     let overlaps = 0;
//     unresolved = [];
//     collisionBump(room, "shipCollisionIterations");
//     for (const a of ships) {
//       const usingIndex = room.spatialIndex?.dynamicValid
//         && room.spatialIndex.queryRangeUnordered;
//       const candidates = usingIndex
//         ? room.spatialIndex.queryRangeUnordered(
//           "ships",
//           a.x,
//           a.y,
//           physicalCollisionRadius(a) * 2 + SEPARATION_BROAD_PHASE_PAD,
//           a._shipCollisionCandidateScratch || (a._shipCollisionCandidateScratch = [])
//         )
//         : ships;
//       if (usingIndex && candidates.length > 1) candidates.sort(byRank);
//       const aRank = rankOf(a);
//       for (const b of candidates) {
//         if (!b?.alive || b === a) continue;
//         const bRank = rankOf(b);
//         if (bRank >= 0 && aRank >= 0 ? bRank <= aRank : compareEntityIds(b, a) <= 0) continue;
//         const result = resolveSeparationPair(room, a, b);
//         if (!result) continue;
//         overlaps += 1;
//         unresolved.push([a, b, result.penetration]);
//         modified.add(a.id);
//         modified.add(b.id);
//       }
//     }
//     for (const ship of ships) resolveMapCollision(room, ship);
//     if (overlaps === 0) break;
//     if (room.spatialIndex?.rebuildKind) {
//       const { shipBroadPhaseRadius } = require("./spatialIndex");
//       room.spatialIndex.rebuildKind("ships", ships, shipBroadPhaseRadius, now);
//     }
//   }
//   if (unresolved.length) {
//     collisionBump(room, "shipCollisionUnresolvedPairs", unresolved.length);
//     const { findClearShipSpawnPoint } = require("./spawnPlanner");
//     for (const [a, b, penetration] of unresolved) {
//       const newcomer = a.spawnState && now < a.spawnState.expiresAt
//         ? a
//         : (b.spawnState && now < b.spawnState.expiresAt ? b : null);
//       if (!newcomer || penetration < 2) continue;
//       const recovery = findClearShipSpawnPoint(room, {
//         preferredX: newcomer.spawnState.launchPoint.x,
//         preferredY: newcomer.spawnState.launchPoint.y,
//         physicalRadius: physicalCollisionRadius(newcomer),
//         ownerId: newcomer.ownerId,
//         requestId: `recovery:${newcomer.id}`,
//         shipIndex: 0,
//         ignoredShips: new Set([newcomer])
//       });
//       if (recovery.ok) {
//         newcomer.x = recovery.x;
//         newcomer.y = recovery.y;
//         newcomer.vx = 0;
//         newcomer.vy = 0;
//       }
//     }
//   }
//   return Array.from(modified);
// }
// 
// function resolveFleetMapCollisions(room) {
//   let count = 0;
//   for (const ship of getLiveShips(room)) {
//     if (resolveMapCollision(room, ship)) count += 1;
//   }
//   return count;
// }
// 
// module.exports = {
//   applyLocalShipAvoidance,
//   navigationClearanceRadius,
//   physicalCollisionRadius,
//   resolveFleetMapCollisions,
//   resolveMapCollision,
//   resolveSeparationPair,
//   separationRadius,
//   updateShipSeparation
// };

// ======== src/server/movementNavigation.js ========
// "use strict";
// 
// const { clampNumber, fastHypot } = require("./utils");
// const {
//   NAV_GRID_CELL_SIZE,
//   NAV_PROGRESS_EPSILON,
//   NAV_REPLAN_CHARGE_THRESHOLD,
//   NAV_REPLAN_COMBAT_THRESHOLD,
//   NAV_REPLAN_MOVE_THRESHOLD,
//   NAV_STUCK_TIME_MS,
//   NAV_WAYPOINT_CAPTURE_RATIO,
//   WORLD_MARGIN
// } = require("./movementTuning");
// const { navigationClearanceRadius } = require("./movementCollision");
// const { bumpMovementMetric } = require("./movementMetrics");
// const { ensureMovementRuntime } = require("./movementRuntime");
// 
// // Stations are solid: resolveStationCollision pushes any hull that touches one
// // back out. Until they were added here the navigator could not see them at all,
// // so a routed path ran straight through a home station and the mover spent the
// // crossing being shoved sideways by the collision solver. Everything that is
// // physically solid has to be navigationally solid too, or the two disagree and
// // the ship grinds along the hull. No state filter, for exactly that reason:
// // resolveStationCollision does not filter either, so a disabled wreck is still
// // an obstacle to both.
// function stationCollisionPieces(room) {
//   const pieces = [];
//   for (const station of room?.stations || []) {
//     for (const piece of station?.collisionPieces || []) {
//       if (piece) pieces.push(piece);
//     }
//   }
//   return pieces;
// }
// 
// // Cheap identity for the structure set. Stations never move once placed, so the
// // piece count changing is the only thing that can alter the grid.
// function stationSignature(room) {
//   let count = 0;
//   for (const station of room?.stations || []) count += station?.collisionPieces?.length || 0;
//   return count;
// }
// 
// // Signed distance from a point to a rotated rectangle: positive outside,
// // negative inside, so it drops into the same "clearance" min as an asteroid.
// function boxClearance(x, y, piece) {
//   const cos = Math.cos(-(piece.angle || 0));
//   const sin = Math.sin(-(piece.angle || 0));
//   const dx = x - piece.x;
//   const dy = y - piece.y;
//   const localX = dx * cos - dy * sin;
//   const localY = dx * sin + dy * cos;
//   const halfWidth = piece.halfWidth || 0;
//   const halfHeight = piece.halfHeight || 0;
//   const outX = Math.abs(localX) - halfWidth;
//   const outY = Math.abs(localY) - halfHeight;
//   if (outX <= 0 && outY <= 0) return -Math.min(-outX, -outY);
//   return fastHypot(Math.max(outX, 0), Math.max(outY, 0));
// }
// 
// // Past this distance a structure can no longer be the binding constraint on any
// // ship's clearance, so cells beyond it keep whatever the asteroids and walls
// // gave them. Bounding the sweep this way keeps the rebuild proportional to the
// // area the stations actually cover rather than to the whole map times the piece
// // count.
// const NAV_STATION_INFLUENCE = 260;
// 
// function applyStationClearance(room, nav) {
//   const pieces = stationCollisionPieces(room);
//   if (pieces.length === 0) return;
//   const { cellSize, cols, rows, cells } = nav;
//   for (const piece of pieces) {
//     const reach = fastHypot(piece.halfWidth || 0, piece.halfHeight || 0) + NAV_STATION_INFLUENCE;
//     const minCol = Math.max(0, Math.floor((piece.x - reach) / cellSize));
//     const maxCol = Math.min(cols - 1, Math.floor((piece.x + reach) / cellSize));
//     const minRow = Math.max(0, Math.floor((piece.y - reach) / cellSize));
//     const maxRow = Math.min(rows - 1, Math.floor((piece.y + reach) / cellSize));
//     for (let col = minCol; col <= maxCol; col += 1) {
//       const x = col * cellSize + cellSize / 2;
//       for (let row = minRow; row <= maxRow; row += 1) {
//         const index = row * cols + col;
//         const distance = boxClearance(x, row * cellSize + cellSize / 2, piece);
//         if (distance < cells[index]) cells[index] = distance;
//       }
//     }
//   }
// }
// 
// function ensureRoomNavigation(room) {
//   const map = room?.map || null;
//   const asteroids = map?.asteroids || [];
//   const width = room?.world?.width || 2000;
//   const height = room?.world?.height || 1600;
//   const revision = room?.mapRevision ?? map?.revision ?? 0;
//   const stations = stationSignature(room);
//   if (room?._movementNav
//     && room._movementNav.revision === revision
//     && room._movementNav.width === width
//     && room._movementNav.height === height
//     && room._movementNav.asteroidRef === asteroids
//     && room._movementNav.stationSignature === stations) {
//     return room._movementNav;
//   }
//   const cellSize = NAV_GRID_CELL_SIZE;
//   const cols = Math.max(1, Math.ceil(width / cellSize));
//   const rows = Math.max(1, Math.ceil(height / cellSize));
//   const cells = new Float32Array(cols * rows);
//   for (let col = 0; col < cols; col += 1) {
//     for (let row = 0; row < rows; row += 1) {
//       const x = col * cellSize + cellSize / 2;
//       const y = row * cellSize + cellSize / 2;
//       let clearance = Math.min(
//         x - WORLD_MARGIN,
//         y - WORLD_MARGIN,
//         width - WORLD_MARGIN - x,
//         height - WORLD_MARGIN - y
//       );
//       for (const asteroid of asteroids) {
//         if (!asteroid) continue;
//         const distance = fastHypot(x - asteroid.x, y - asteroid.y)
//           - (asteroid.radius || 0);
//         if (distance < clearance) clearance = distance;
//       }
//       cells[row * cols + col] = clearance;
//     }
//   }
//   room._movementNav = {
//     width,
//     height,
//     cellSize,
//     cols,
//     rows,
//     cells,
//     revision,
//     asteroidRef: asteroids,
//     stationSignature: stations
//   };
//   applyStationClearance(room, room._movementNav);
//   return room._movementNav;
// }
// 
// function cellFor(nav, x, y) {
//   const col = clampNumber(Math.floor(x / nav.cellSize), 0, nav.cols - 1);
//   const row = clampNumber(Math.floor(y / nav.cellSize), 0, nav.rows - 1);
//   return { col, row, index: row * nav.cols + col };
// }
// 
// function cellCenter(nav, col, row) {
//   return {
//     x: col * nav.cellSize + nav.cellSize / 2,
//     y: row * nav.cellSize + nav.cellSize / 2
//   };
// }
// 
// function cellClearanceAt(nav, x, y) {
//   return nav.cells[cellFor(nav, x, y).index];
// }
// 
// function nearestClearCell(nav, startX, startY, clearance) {
//   const start = cellFor(nav, startX, startY);
//   if (nav.cells[start.index] >= clearance) return cellCenter(nav, start.col, start.row);
//   const visited = new Uint8Array(nav.cols * nav.rows);
//   const queue = [start.col, start.row];
//   const directions = [
//     [0, -1], [1, -1], [1, 0], [1, 1],
//     [0, 1], [-1, 1], [-1, 0], [-1, -1]
//   ];
//   let queueIndex = 0;
//   visited[start.index] = 1;
//   while (queueIndex < queue.length) {
//     const col = queue[queueIndex++];
//     const row = queue[queueIndex++];
//     const index = row * nav.cols + col;
//     if (nav.cells[index] >= clearance) return cellCenter(nav, col, row);
//     for (const [dx, dy] of directions) {
//       const nextCol = col + dx;
//       const nextRow = row + dy;
//       if (nextCol < 0 || nextCol >= nav.cols || nextRow < 0 || nextRow >= nav.rows) continue;
//       const nextIndex = nextRow * nav.cols + nextCol;
//       if (visited[nextIndex]) continue;
//       visited[nextIndex] = 1;
//       queue.push(nextCol, nextRow);
//     }
//   }
//   return null;
// }
// 
// function nearestClearPoint(room, x, y, clearance) {
//   const nav = ensureRoomNavigation(room);
//   const width = room?.world?.width || nav.width;
//   const height = room?.world?.height || nav.height;
//   const startX = clampNumber(Number(x) || width * 0.5, WORLD_MARGIN, width - WORLD_MARGIN);
//   const startY = clampNumber(Number(y) || height * 0.5, WORLD_MARGIN, height - WORLD_MARGIN);
//   const start = cellFor(nav, startX, startY);
//   if (nav.cells[start.index] >= clearance) {
//     return {
//       x: startX,
//       y: startY,
//       adjusted: false,
//       passes: 0,
//       clear: true,
//       reason: "clear"
//     };
//   }
//   const clear = nearestClearCell(nav, startX, startY, clearance);
//   if (clear) {
//     return {
//       x: clear.x,
//       y: clear.y,
//       adjusted: true,
//       passes: 1,
//       clear: true,
//       reason: "adjusted"
//     };
//   }
//   return {
//     x: startX,
//     y: startY,
//     adjusted: false,
//     passes: 0,
//     clear: false,
//     reason: "blocked"
//   };
// }
// 
// function segmentCircleClearance(x1, y1, x2, y2, centerX, centerY, radius) {
//   const dx = x2 - x1;
//   const dy = y2 - y1;
//   const length = fastHypot(dx, dy);
//   if (length < 0.001) {
//     return {
//       blocked: fastHypot(centerX - x1, centerY - y1) < radius,
//       along: 0,
//       lateral: 0
//     };
//   }
//   const unitX = dx / length;
//   const unitY = dy / length;
//   const relativeX = centerX - x1;
//   const relativeY = centerY - y1;
//   const along = relativeX * unitX + relativeY * unitY;
//   const closestX = x1 + unitX * clampNumber(along, 0, length);
//   const closestY = y1 + unitY * clampNumber(along, 0, length);
//   return {
//     blocked: fastHypot(centerX - closestX, centerY - closestY) < radius,
//     along,
//     lateral: relativeX * (-unitY) + relativeY * unitX
//   };
// }
// 
// // Segment against a rotated rectangle grown by `clearance`, done in the piece's
// // own frame where the box is axis aligned, by the standard slab test. The grid
// // alone is not enough: planPath takes a straight line whenever this says the
// // line is clear, and the path smoother uses it to cut corners -- so a station
// // invisible here is a station routed straight through however solid the grid
// // says it is.
// function segmentBoxBlocked(x1, y1, x2, y2, piece, clearance) {
//   const cos = Math.cos(-(piece.angle || 0));
//   const sin = Math.sin(-(piece.angle || 0));
//   const ax = x1 - piece.x;
//   const ay = y1 - piece.y;
//   const bx = x2 - piece.x;
//   const by = y2 - piece.y;
//   const localAx = ax * cos - ay * sin;
//   const localAy = ax * sin + ay * cos;
//   const localBx = bx * cos - by * sin;
//   const localBy = bx * sin + by * cos;
//   const halfWidth = (piece.halfWidth || 0) + clearance;
//   const halfHeight = (piece.halfHeight || 0) + clearance;
//   const dx = localBx - localAx;
//   const dy = localBy - localAy;
//   let enter = 0;
//   let exit = 1;
//   // One slab per axis; a zero-length component means the segment is parallel to
//   // that pair of faces, so it either lies inside the slab for its whole length
//   // or misses the box outright.
//   for (const [origin, delta, half] of [[localAx, dx, halfWidth], [localAy, dy, halfHeight]]) {
//     if (Math.abs(delta) < 1e-9) {
//       if (origin < -half || origin > half) return false;
//       continue;
//     }
//     const inverse = 1 / delta;
//     let near = (-half - origin) * inverse;
//     let far = (half - origin) * inverse;
//     if (near > far) { const swap = near; near = far; far = swap; }
//     if (near > enter) enter = near;
//     if (far < exit) exit = far;
//     if (enter > exit) return false;
//   }
//   return true;
// }
// 
// function isSegmentStationClear(room, x1, y1, x2, y2, clearance) {
//   for (const station of room?.stations || []) {
//     for (const piece of station?.collisionPieces || []) {
//       if (piece && segmentBoxBlocked(x1, y1, x2, y2, piece, clearance)) return false;
//     }
//   }
//   return true;
// }
// 
// function isSegmentClear(room, x1, y1, x2, y2, clearance) {
//   const width = room?.world?.width || 2000;
//   const height = room?.world?.height || 1600;
//   if (x1 < WORLD_MARGIN + clearance
//     || x1 > width - WORLD_MARGIN - clearance
//     || y1 < WORLD_MARGIN + clearance
//     || y1 > height - WORLD_MARGIN - clearance
//     || x2 < WORLD_MARGIN + clearance
//     || x2 > width - WORLD_MARGIN - clearance
//     || y2 < WORLD_MARGIN + clearance
//     || y2 > height - WORLD_MARGIN - clearance) return false;
//   const scratch = room._segmentScratch || (room._segmentScratch = []);
//   const asteroids = room.spatialIndex?.dynamicValid
//     && room.spatialIndex.querySweptAabbUnordered
//     ? room.spatialIndex.querySweptAabbUnordered(
//       "asteroids",
//       x1,
//       y1,
//       x2,
//       y2,
//       clearance,
//       scratch
//     )
//     : (room.map?.asteroids || []);
//   for (const asteroid of asteroids) {
//     if (!asteroid) continue;
//     if (segmentCircleClearance(
//       x1,
//       y1,
//       x2,
//       y2,
//       asteroid.x,
//       asteroid.y,
//       (asteroid.radius || 0) + clearance
//     ).blocked) return false;
//   }
//   return isSegmentStationClear(room, x1, y1, x2, y2, clearance);
// }
// 
// class BinaryHeap {
//   constructor(compare) {
//     this.heap = [];
//     this.compare = compare;
//   }
// 
//   get length() {
//     return this.heap.length;
//   }
// 
//   push(value) {
//     this.heap.push(value);
//     this.siftUp(this.heap.length - 1);
//   }
// 
//   pop() {
//     if (this.heap.length === 0) return undefined;
//     const top = this.heap[0];
//     const last = this.heap.pop();
//     if (this.heap.length) {
//       this.heap[0] = last;
//       this.siftDown(0);
//     }
//     return top;
//   }
// 
//   siftUp(index) {
//     const value = this.heap[index];
//     while (index > 0) {
//       const parent = (index - 1) >> 1;
//       if (!this.compare(value, this.heap[parent])) break;
//       this.heap[index] = this.heap[parent];
//       index = parent;
//     }
//     this.heap[index] = value;
//   }
// 
//   siftDown(index) {
//     const value = this.heap[index];
//     while (true) {
//       const left = index * 2 + 1;
//       if (left >= this.heap.length) break;
//       const right = left + 1;
//       let child = left;
//       if (right < this.heap.length && this.compare(this.heap[right], this.heap[left])) {
//         child = right;
//       }
//       if (this.compare(value, this.heap[child])) break;
//       this.heap[index] = this.heap[child];
//       index = child;
//     }
//     this.heap[index] = value;
//   }
// }
// 
// function heuristic(nav, colA, rowA, colB, rowB) {
//   const a = cellCenter(nav, colA, rowA);
//   const b = cellCenter(nav, colB, rowB);
//   return fastHypot(a.x - b.x, a.y - b.y);
// }
// 
// // The search proper. Reports whether it actually got there, because "no route"
// // and "a route" need different answers from the caller and collapsing them to
// // null loses the half of the search that is still useful: the flood already
// // knows the reachable cell nearest the goal, which is exactly where a ship that
// // cannot arrive should go instead.
// function searchPathWorld(room, startX, startY, goalX, goalY, clearance) {
//   bumpMovementMetric("pathPlanCount");
//   const nav = ensureRoomNavigation(room);
//   const startClear = nearestClearPoint(room, startX, startY, clearance + nav.cellSize / 2);
//   const goalClear = nearestClearPoint(room, goalX, goalY, clearance + nav.cellSize / 2);
//   if (!goalClear.clear) return { waypoints: [], reachedGoal: false };
//   const start = cellFor(nav, startClear.x, startClear.y);
//   const goal = cellFor(nav, goalClear.x, goalClear.y);
//   const size = nav.cols * nav.rows;
//   const scores = new Float64Array(size);
//   const parents = new Int32Array(size);
//   scores.fill(Infinity);
//   parents.fill(-1);
//   scores[start.index] = 0;
//   let order = 0;
//   const open = new BinaryHeap((a, b) => a.score < b.score
//     || (a.score === b.score && a.order < b.order));
//   open.push({
//     score: heuristic(nav, start.col, start.row, goal.col, goal.row),
//     index: start.index,
//     order: ++order
//   });
//   const directions = [
//     [1, 0, 1], [0, 1, 1], [-1, 0, 1], [0, -1, 1],
//     [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2],
//     [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2]
//   ];
//   const required = clearance + nav.cellSize / 2;
//   // Best consolation prize seen so far: the settled cell closest to the goal.
//   // Costs one heuristic per expansion and is what makes an unreachable
//   // destination produce a sane partial route rather than nothing.
//   let closestIndex = start.index;
//   let closestHeuristic = heuristic(nav, start.col, start.row, goal.col, goal.row);
//   let reachedGoal = false;
//   while (open.length > 0) {
//     const node = open.pop();
//     if (node.index === goal.index) {
//       reachedGoal = true;
//       break;
//     }
//     const row = Math.floor(node.index / nav.cols);
//     const col = node.index % nav.cols;
//     const remaining = heuristic(nav, col, row, goal.col, goal.row);
//     if (remaining < closestHeuristic) {
//       closestHeuristic = remaining;
//       closestIndex = node.index;
//     }
//     for (const [dx, dy, distanceMultiplier] of directions) {
//       const nextCol = col + dx;
//       const nextRow = row + dy;
//       if (nextCol < 0 || nextCol >= nav.cols || nextRow < 0 || nextRow >= nav.rows) continue;
//       const nextIndex = nextRow * nav.cols + nextCol;
//       if (nav.cells[nextIndex] < required) continue;
//       if (distanceMultiplier !== 1) {
//         const horizontalIndex = row * nav.cols + nextCol;
//         const verticalIndex = nextRow * nav.cols + col;
//         if (nav.cells[horizontalIndex] < required || nav.cells[verticalIndex] < required) continue;
//       }
//       const score = scores[node.index] + distanceMultiplier * nav.cellSize;
//       if (score >= scores[nextIndex] - 1e-9) continue;
//       scores[nextIndex] = score;
//       parents[nextIndex] = node.index;
//       open.push({
//         score: score + heuristic(nav, nextCol, nextRow, goal.col, goal.row),
//         index: nextIndex,
//         order: ++order
//       });
//     }
//   }
//   const terminal = reachedGoal ? goal.index : closestIndex;
//   const raw = [];
//   let index = terminal;
//   while (index !== -1) {
//     const row = Math.floor(index / nav.cols);
//     const col = index % nav.cols;
//     raw.push(cellCenter(nav, col, row));
//     index = parents[index];
//   }
//   raw.reverse();
//   const smoothed = [raw[0]];
//   let anchor = 0;
//   while (anchor < raw.length - 1) {
//     let candidate = raw.length - 1;
//     while (candidate > anchor + 1
//       && !isSegmentClear(
//         room,
//         smoothed[smoothed.length - 1].x,
//         smoothed[smoothed.length - 1].y,
//         raw[candidate].x,
//         raw[candidate].y,
//         clearance
//       )) {
//       candidate -= 1;
//     }
//     smoothed.push(raw[candidate]);
//     anchor = candidate;
//   }
//   // Only a route that arrives may end on the requested point. A partial one ends
//   // on the cell the search actually settled, which is already the last entry.
//   if (reachedGoal) smoothed[smoothed.length - 1] = { x: goalClear.x, y: goalClear.y };
//   return { waypoints: smoothed, reachedGoal };
// }
// 
// // Full routes only, for callers that want "is there a way through" rather than
// // "how close can this hull get".
// function findPathWorld(room, startX, startY, goalX, goalY, clearance) {
//   const result = searchPathWorld(room, startX, startY, goalX, goalY, clearance);
//   return result.reachedGoal ? result.waypoints : null;
// }
// 
// // The clearance the planner will demand of a destination. Anything that picks a
// // point for a ship to be sent to has to use this and not the bare hull
// // clearance: the grid is sampled at cell centres, so the search needs half a
// // cell more than the hull does, and a destination legal by the looser test is
// // one the planner then quietly relocates -- leaving the ship parked somewhere
// // the player never clicked while the order marker sits elsewhere.
// function navigationPlanningClearance(ship) {
//   return navigationClearanceRadius(ship) + NAV_GRID_CELL_SIZE / 2;
// }
// 
// function planPath(room, ship, destination, now) {
//   const runtime = ensureMovementRuntime(ship);
//   const navigation = runtime.navigation;
//   const clearance = navigationClearanceRadius(ship);
//   let waypoints;
//   let reachable = true;
//   if (isSegmentClear(room, ship.x, ship.y, destination.x, destination.y, clearance)) {
//     waypoints = [{ x: destination.x, y: destination.y }];
//   } else {
//     const search = searchPathWorld(
//       room,
//       ship.x,
//       ship.y,
//       destination.x,
//       destination.y,
//       clearance
//     );
//     waypoints = search.waypoints;
//     reachable = search.reachedGoal;
//     // Nothing is routable at all -- the hull is too wide for anywhere it could
//     // go from here. Hold station rather than invent a course.
//     //
//     // What this replaces: a straight line drawn to the destination whenever the
//     // search failed. That line ran through whatever the search had just proved
//     // impassable, so the ship drove into a station and stayed there being pushed
//     // back out -- 95% of ticks in hull contact, a thousand pixels short, for as
//     // long as the order stood. A route that does not exist must not be faked.
//     if (!waypoints.length) {
//       waypoints = [{ x: ship.x, y: ship.y }];
//       reachable = false;
//     }
//   }
//   const finalStart = waypoints.length > 1
//     ? waypoints[waypoints.length - 2]
//     : { x: ship.x, y: ship.y };
//   const final = waypoints[waypoints.length - 1];
//   const commandId = runtime.command?.id || `intent:${runtime.command?.type || "idle"}`;
//   // The heading a ship ends on belongs to the order, not to whichever leg it
//   // happened to be flying when the route was last recomputed. Replanning
//   // mid-approach -- after an overshoot, say -- would otherwise derive the final
//   // facing from the ship's current position and park it pointing an arbitrary
//   // way. Keep the first answer for as long as the command stands.
//   const keepFinalFacing = navigation.commandId === commandId
//     && Number.isFinite(navigation.finalFacing);
//   navigation.waypoints = waypoints;
//   navigation.waypointIndex = 0;
//   navigation.plannedDestination = { ...destination };
//   navigation.plannedAt = now;
//   navigation.commandId = commandId;
//   navigation.clearance = clearance;
//   navigation.reachable = reachable;
//   if (!keepFinalFacing) {
//     navigation.finalFacing = Math.atan2(final.y - finalStart.y, final.x - finalStart.x);
//   }
//   navigation.progressDistance = fastHypot(final.x - ship.x, final.y - ship.y);
//   navigation.progressAt = now;
//   bumpMovementMetric("pathReplanCount");
//   if (!reachable) bumpMovementMetric("pathUnreachableCount");
//   return navigation;
// }
// 
// function waypointInvalid(room, navigation) {
//   const index = clampNumber(
//     navigation.waypointIndex || 0,
//     0,
//     Math.max(0, navigation.waypoints.length - 1)
//   );
//   const waypoint = navigation.waypoints[index];
//   return waypoint
//     && cellClearanceAt(ensureRoomNavigation(room), waypoint.x, waypoint.y)
//       < navigation.clearance;
// }
// 
// function replanThreshold(runtime, intent) {
//   if (intent?.type === "charge") return NAV_REPLAN_CHARGE_THRESHOLD;
//   return runtime.command?.type === "move"
//     ? NAV_REPLAN_MOVE_THRESHOLD
//     : NAV_REPLAN_COMBAT_THRESHOLD;
// }
// 
// function shouldReplan(room, ship, destination, now, intent = null) {
//   const runtime = ensureMovementRuntime(ship);
//   const navigation = runtime.navigation;
//   if (!navigation.waypoints?.length || !navigation.plannedDestination) return true;
//   if (navigation.commandId !== (runtime.command?.id || `intent:${runtime.command?.type || "idle"}`)) {
//     return true;
//   }
//   if (navigation.clearance !== navigationClearanceRadius(ship)) return true;
//   const displacement = fastHypot(
//     destination.x - navigation.plannedDestination.x,
//     destination.y - navigation.plannedDestination.y
//   );
//   if (displacement > replanThreshold(runtime, intent)) return true;
//   if (waypointInvalid(room, navigation)) return true;
//   const index = clampNumber(
//     navigation.waypointIndex || 0,
//     0,
//     Math.max(0, navigation.waypoints.length - 1)
//   );
//   const waypoint = navigation.waypoints[index];
//   const distance = waypoint ? fastHypot(waypoint.x - ship.x, waypoint.y - ship.y) : 0;
//   if (!Number.isFinite(navigation.progressDistance)
//     || distance < navigation.progressDistance - NAV_PROGRESS_EPSILON) {
//     navigation.progressDistance = distance;
//     navigation.progressAt = now;
//   }
//   return distance > navigationClearanceRadius(ship)
//     && now - (navigation.progressAt || now) > NAV_STUCK_TIME_MS;
// }
// 
// function selectWaypoint(ship) {
//   const navigation = ensureMovementRuntime(ship).navigation;
//   const previousIndex = navigation.waypointIndex || 0;
//   let index = clampNumber(
//     previousIndex,
//     0,
//     Math.max(0, navigation.waypoints.length - 1)
//   );
//   const captureDistance = navigationClearanceRadius(ship) * NAV_WAYPOINT_CAPTURE_RATIO;
//   while (index < navigation.waypoints.length - 1
//     && fastHypot(
//       ship.x - navigation.waypoints[index].x,
//       ship.y - navigation.waypoints[index].y
//     ) < captureDistance) {
//     index += 1;
//     bumpMovementMetric("waypointAdvanceCount");
//   }
//   navigation.waypointIndex = index;
//   if (index !== previousIndex) {
//     const next = navigation.waypoints[index];
//     navigation.progressDistance = next
//       ? fastHypot(next.x - ship.x, next.y - ship.y)
//       : 0;
//     navigation.progressAt = Number(ship._simNow) || navigation.plannedAt || 0;
//   }
//   return {
//     goal: navigation.waypoints[index],
//     isFinal: index === navigation.waypoints.length - 1,
//     nextGoal: index < navigation.waypoints.length - 1
//       ? navigation.waypoints[index + 1]
//       : null,
//     captureDistance,
//     finalFacing: navigation.finalFacing,
//     // False when the route stops short because the destination cannot be
//     // reached. The mover still flies and arrives normally -- it just arrives
//     // somewhere else, and callers that care can tell the difference.
//     reachable: navigation.reachable !== false
//   };
// }
// 
// function resolveNavigation(room, ship, intent, now) {
//   const runtime = ensureMovementRuntime(ship);
//   if (!intent.destination) {
//     runtime.navigation.waypoints = [];
//     runtime.navigation.waypointIndex = 0;
//     return {
//       goal: null,
//       isFinal: true,
//       nextGoal: null,
//       captureDistance: 0,
//       finalFacing: runtime.command?.finalFacing,
//       reachable: true
//     };
//   }
//   if (shouldReplan(room, ship, intent.destination, now, intent)) {
//     planPath(room, ship, intent.destination, now);
//   } else {
//     bumpMovementMetric("pathCacheHitCount");
//   }
//   const selected = selectWaypoint(ship);
//   if (Number.isFinite(runtime.command?.finalFacing)) {
//     selected.finalFacing = runtime.command.finalFacing;
//   }
//   return selected;
// }
// 
// module.exports = {
//   ensureRoomNavigation,
//   findPathWorld,
//   isSegmentClear,
//   navigationPlanningClearance,
//   nearestClearPoint,
//   resolveNavigation,
//   searchPathWorld,
//   segmentCircleClearance
// };

// ======== src/server/movementSteering.js ========
// "use strict";
// 
// // Flight-assisted steering. One model for every intent -- click-to-move, stop,
// // and all combat styles:
// //
// //   desired velocity -> velocity decays toward it -> integrate
// //
// // Two properties make this predictable, and both are deliberate:
// //
// //   * Thrust is omnidirectional. A ship's drives push it toward the commanded
// //     velocity whatever direction that is. There is no hull-local decomposition
// //     into forward/reverse/lateral axes, so no ship ever has to swing its nose
// //     around to slow down.
// //   * Ships point where they are going. Heading follows the commanded velocity
// //     (or the combat target), never the acceleration vector. It changes smoothly
// //     and only when the ship's course changes.
// //
// // What this replaces: a Newtonian model where the only real thrust was the main
// // engine, so stopping meant a 180-degree flip-and-burn. On hulls that accelerate
// // ~16x harder than they brake that flip was mandatory, constantly re-decided,
// // and read to the player as ships spinning on the spot.
// //
// // The loop is also free of bang-bang branches. Every discontinuity here -- "brake
// // to zero the moment we're inside stopping distance", "cut thrust the moment
// // we're at speed", "switch which way we face at a speed threshold" -- limit
// // cycles at 30 Hz and shows up as jitter.
// 
// const {
//   angleDifference,
//   clampNumber,
//   fastHypot,
//   rotateToward
// } = require("./utils");
// const { PARTS } = require("./components");
// const { addComponentHeat, componentPerformance } = require("./heat");
// const { getCommandAuraMultiplier } = require("./commandAuras");
// const {
//   calculateDirectionalTurnInputs,
//   calculateMovementPowerMultiplier,
//   calculateMovementStats,
//   maneuverThrusterTorqueSign
// } = require("../../public/src/shared/movementStats.js");
// const { getComponentPowerMultiplier } = require("./componentPower");
// const { getShipComponentIndexes } = require("./componentIndexes");
// const { BALANCE } = require("./balanceConfig");
// const {
//   ARRIVE_DISTANCE,
//   ARRIVE_LATCH_RATIO,
//   ARRIVE_SPEED,
//   BACKUP_CORE_TURN_SCALE,
//   DESTINATION_ARRIVE_SPEED,
//   EDGE_BOUNCE_MARGIN,
//   EDGE_RESTITUTION,
//   ENGINE_HEAT_BASE,
//   ENGINE_HEAT_PER_THRUST,
//   FACING_COMMAND_HYSTERESIS,
//   FACING_MIN_GOAL_DISTANCE,
//   FACING_MIN_GOAL_DISTANCE_RELEASE,
//   FACING_MIN_SPEED,
//   FACING_MIN_SPEED_RELEASE,
//   FINAL_FACING_TOLERANCE,
//   MANEUVER_HEAT_PER_THRUST,
//   REST_SPEED,
//   TURN_COMMAND_DAMPING,
//   VELOCITY_TIME_CONSTANT_S
// } = require("./movementTuning");
// const { ensureMovementRuntime } = require("./movementRuntime");
// const { bumpMovementMetric } = require("./movementMetrics");
// 
// // ---------------------------------------------------------------------------
// // Derived stats
// // ---------------------------------------------------------------------------
// 
// function heatAdjustedMovementStats(ship, baseStats) {
//   const design = ship.design || [];
//   const multiplier = (index) => (ship.componentHp?.[index] ?? 1) > 0
//     ? componentPerformance(ship, index) * getComponentPowerMultiplier(ship, index)
//     : 0;
//   const engineThrustValues = [];
//   const engineMassValues = [];
//   for (const index of getShipComponentIndexes(ship).thrustIndices) {
//     const module = design[index];
//     const part = PARTS[module.type] || {};
//     const output = multiplier(index);
//     if (output > 0 && (!ship.validEngineIndices || ship.validEngineIndices.has(index))) {
//       engineThrustValues.push((part.thrust || 0) * output);
//       engineMassValues.push(part.mass || 0);
//     }
//   }
//   const isBlockedEngine = (index, module, part) => {
//     if ((ship.componentHp?.[index] ?? 1) <= 0) return true;
//     return ((part.thrust || 0) > 0 || module.type === "maneuverThruster")
//       && ship.validEngineIndices
//       && !ship.validEngineIndices.has(index);
//   };
//   const directionalTurnInputs = calculateDirectionalTurnInputs(design, PARTS, {
//     componentMultiplier: multiplier,
//     isBlockedEngine
//   });
//   const movement = calculateMovementStats({
//     mass: baseStats.mass,
//     thrust: baseStats.thrust,
//     turnBonus: 0,
//     powerGeneration: baseStats.powerGeneration,
//     powerUse: baseStats.powerUse,
//     engineThrustValues,
//     engineMassValues,
//     directionalTurnInputs,
//     hullControlThrust: BALANCE.movement?.hullControlThrust,
//     movementPowerMultiplier: Math.max(
//       1,
//       calculateMovementPowerMultiplier(
//         baseStats.powerGeneration || 0,
//         baseStats.powerUse || 0
//       )
//     )
//   });
//   const accelerationMultiplier = getCommandAuraMultiplier(ship, "accelerationMultiplier");
//   const turnMultiplier = getCommandAuraMultiplier(ship, "turnRateMultiplier");
//   if (Number.isFinite(movement.accel)
//     && Number.isFinite(accelerationMultiplier)
//     && accelerationMultiplier !== 1) {
//     movement.accel *= accelerationMultiplier;
//   }
//   if (Number.isFinite(movement.turnRate)
//     && Number.isFinite(turnMultiplier)
//     && turnMultiplier !== 1) {
//     movement.turnRate *= turnMultiplier;
//     movement.turnRateLeft *= turnMultiplier;
//     movement.turnRateRight *= turnMultiplier;
//   }
//   return { ...baseStats, ...movement };
// }
// 
// function driveAcceleration(stats) {
//   return Math.max(0.001, Number(stats.accel) || 0);
// }
// 
// // Whether the ship can produce thrust at all. driveAcceleration floors its
// // answer so the braking-profile maths never divides by zero, which means it
// // reports a trickle of thrust for a ship whose engines are all destroyed --
// // true of the stopping-distance maths, wrong for the propulsion path.
// function hasDrive(stats) {
//   return (Number(stats.effectiveThrust) || 0) > 0 && (Number(stats.maxSpeed) || 0) > 0;
// }
// 
// function computeStoppingDistance(ship, stats) {
//   const speed = fastHypot(ship.vx || 0, ship.vy || 0);
//   return speed * speed / (2 * driveAcceleration(stats));
// }
// 
// // Fastest a ship may be going with `distance` still to run and still stop on the
// // mark. Flight assist does not reverse thrust instantly -- it takes about
// // VELOCITY_TIME_CONSTANT_S to spin the command around -- so the ship coasts for
// // that long before it really starts shedding speed:
// //
// //     v*t + v^2/(2a) = d   =>   v = sqrt((a*t)^2 + 2*a*d) - a*t
// //
// // Ignoring the lag term leaves the ship a few pixels fast at the very end, which
// // it works off by drifting past the point and turning back -- a small visible
// // shimmy exactly when the player is watching the ship arrive.
// function approachSpeedLimitForExit(stats, distance, exitSpeed = 0) {
//   const remaining = Math.max(0, distance);
//   const boundedExitSpeed = Math.max(0, Number(exitSpeed) || 0);
//   if (remaining <= 0) return boundedExitSpeed;
//   const accel = driveAcceleration(stats);
//   const coast = accel * VELOCITY_TIME_CONSTANT_S;
//   return Math.sqrt(
//     (coast + boundedExitSpeed) * (coast + boundedExitSpeed)
//       + 2 * accel * remaining
//   ) - coast;
// }
// 
// function approachSpeedLimit(stats, distance) {
//   return approachSpeedLimitForExit(
//     stats,
//     Math.max(0, distance - ARRIVE_DISTANCE),
//     0
//   );
// }
// 
// function waypointTurnSpeedLimit(ship, stats, navigation) {
//   if (navigation.isFinal || !navigation.goal || !navigation.nextGoal) return Infinity;
//   const incoming = Math.atan2(
//     navigation.goal.y - (ship.y || 0),
//     navigation.goal.x - (ship.x || 0)
//   );
//   const outgoing = Math.atan2(
//     navigation.nextGoal.y - navigation.goal.y,
//     navigation.nextGoal.x - navigation.goal.x
//   );
//   const turnAngle = Math.abs(angleDifference(incoming, outgoing));
//   if (turnAngle < FINAL_FACING_TOLERANCE) return Infinity;
//   const turnRate = directionalTurnRate(stats, incoming, outgoing, ship);
//   const turningDistance = Math.max(1, Number(navigation.captureDistance) || 0);
//   return Math.max(0, turnRate) * turningDistance / turnAngle;
// }
// 
// // ---------------------------------------------------------------------------
// // Decision: what velocity do we want
// // ---------------------------------------------------------------------------
// 
// function clampVelocity(velocity, maximumSpeed) {
//   const speed = fastHypot(velocity.x, velocity.y);
//   if (speed <= maximumSpeed || speed <= 0) return velocity;
//   const scale = maximumSpeed / speed;
//   return { x: velocity.x * scale, y: velocity.y * scale };
// }
// 
// function desiredVelocityFor(ship, stats, intent, navigation) {
//   const runtime = ensureMovementRuntime(ship);
//   const maximumSpeed = Math.max(
//     0,
//     (Number(stats.maxSpeed) || 0) * (Number(intent.maxSpeedFactor) || 1)
//   );
//   const goal = navigation.goal;
//   let distance = 0;
//   let baseVelocity = { x: 0, y: 0 };
//   if (goal) {
//     const dx = goal.x - (ship.x || 0);
//     const dy = goal.y - (ship.y || 0);
//     distance = fastHypot(dx, dy);
//     const directionX = distance > 0.001 ? dx / distance : Math.cos(ship.angle || 0);
//     const directionY = distance > 0.001 ? dy / distance : Math.sin(ship.angle || 0);
//     const arrivalActive = intent.arrivalRequired && navigation.isFinal;
//     // Once a ship has arrived it stays parked, even if a neighbour nudges it a
//     // few pixels off the mark. Without this a ship standing on its destination
//     // re-commands a crawl toward it after every shove, swings the hull round to
//     // face it, and creeps -- which reads as the ship turning for no reason.
//     // Sticky hysteresis on an already-settled state, not a threshold the
//     // controller can oscillate across.
//     const parkedLatch = (runtime.phase === "final-facing" || runtime.phase === "positioned")
//       && navigation.isFinal
//       && distance < ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO
//       && fastHypot(ship.vx || 0, ship.vy || 0) < ARRIVE_SPEED;
//     // Braking profile. Reaches zero exactly at ARRIVE_DISTANCE, so there is no
//     // "are we inside stopping distance yet" branch -- that test compared against
//     // a stopping distance derived from current speed, so braking shrank it,
//     // which un-tripped the test, which resumed full speed. That feedback loop
//     // was the arrival jitter.
//     let desiredSpeed = arrivalActive
//       ? (parkedLatch ? 0 : Math.min(maximumSpeed, approachSpeedLimit(stats, distance)))
//       : maximumSpeed;
//     if (!navigation.isFinal && navigation.nextGoal) {
//       const cornerSpeed = waypointTurnSpeedLimit(ship, stats, navigation);
//       const brakingDistance = Math.max(
//         0,
//         distance - Math.max(0, Number(navigation.captureDistance) || 0)
//       );
//       desiredSpeed = Math.min(
//         desiredSpeed,
//         approachSpeedLimitForExit(stats, brakingDistance, cornerSpeed)
//       );
//     }
//     // After a waypoint advances, keep the ship inside the same turn-radius
//     // budget until its hull has actually acquired the new leg. Otherwise it
//     // brakes for the corner, switches waypoints, immediately accelerates, and
//     // draws a wide loop past the route before it has finished turning.
//     const headingError = Math.abs(angleDifference(ship.angle || 0, Math.atan2(dy, dx)));
//     if (headingError > FINAL_FACING_TOLERANCE) {
//       const turnRate = directionalTurnRate(
//         stats,
//         ship.angle || 0,
//         Math.atan2(dy, dx),
//         ship
//       );
//       const turningDistance = Math.max(
//         1,
//         Number(navigation.captureDistance) || ARRIVE_DISTANCE
//       );
//       desiredSpeed = Math.min(
//         desiredSpeed,
//         Math.max(0, turnRate) * turningDistance / headingError
//       );
//     }
//     baseVelocity = { x: directionX * desiredSpeed, y: directionY * desiredSpeed };
//   }
//   if (intent.desiredVelocity) {
//     if (goal) {
//       baseVelocity.x += intent.desiredVelocity.x;
//       baseVelocity.y += intent.desiredVelocity.y;
//     } else {
//       baseVelocity = { x: intent.desiredVelocity.x, y: intent.desiredVelocity.y };
//     }
//   }
//   return {
//     desiredVelocity: clampVelocity(baseVelocity, maximumSpeed),
//     distance,
//     maximumSpeed
//   };
// }
// 
// // Heading and speed follow from the commanded velocity, so anything that edits
// // that velocity -- ship avoidance, most notably -- must refresh them afterwards.
// function refreshDecisionHeading(ship, decision) {
//   const desired = decision.desiredVelocity;
//   decision.desiredSpeed = fastHypot(desired.x, desired.y);
//   // Below a real commanded speed there is no travel direction to point at, and
//   // aiming at the destination instead would have a ship standing on its mark
//   // chase the bearing to a point a few pixels away -- which swings wildly for
//   // any small displacement. Hold the current heading instead.
//   decision.moveAngle = decision.desiredSpeed > FACING_MIN_SPEED
//     ? Math.atan2(desired.y, desired.x)
//     : (ship.angle || 0);
//   return decision;
// }
// 
// function buildMovementDecision(room, ship, stats, intent, navigation) {
//   const velocityPlan = desiredVelocityFor(ship, stats, intent, navigation);
//   const currentSpeed = fastHypot(ship.vx || 0, ship.vy || 0);
//   const destinationPositioned = intent.arrivalRequired
//     && navigation.isFinal
//     && Boolean(navigation.goal)
//     && (velocityPlan.distance < ARRIVE_DISTANCE
//       || (["final-facing", "positioned"].includes(ensureMovementRuntime(ship).phase)
//         && velocityPlan.distance < ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO))
//     && currentSpeed < DESTINATION_ARRIVE_SPEED;
//   const rangePositioned = intent.arrivalRequired
//     && !navigation.goal
//     && fastHypot(
//       velocityPlan.desiredVelocity.x - (ship.vx || 0),
//       velocityPlan.desiredVelocity.y - (ship.vy || 0)
//     ) < ARRIVE_SPEED;
//   const facingTargetId = intent.facingTargetId == null
//     ? null
//     : String(intent.facingTargetId);
//   const target = facingTargetId
//     ? room.ships?.get(facingTargetId)
//       || room.stationsById?.get?.(facingTargetId)
//       || room.stations?.find((station) => String(station?.id) === facingTargetId)
//       || null
//     : null;
//   const decision = {
//     desiredVelocity: velocityPlan.desiredVelocity,
//     goal: navigation.goal,
//     distance: velocityPlan.distance,
//     desiredSpeed: 0,
//     speed: currentSpeed,
//     moveAngle: ship.angle || 0,
//     maximumSpeed: velocityPlan.maximumSpeed,
//     isFinal: navigation.isFinal,
//     finalFacing: intent.facingMode === "final"
//       ? (Number.isFinite(intent.finalFacing) ? intent.finalFacing : navigation.finalFacing)
//       : null,
//     target: target?.alive ? target : null,
//     positioned: rangePositioned || destinationPositioned,
//     needsPropulsion: !destinationPositioned || currentSpeed > REST_SPEED,
//     arrivalRequired: intent.arrivalRequired,
//     stoppingDistance: computeStoppingDistance(ship, stats)
//   };
//   return refreshDecisionHeading(ship, decision);
// }
// 
// // ---------------------------------------------------------------------------
// // Facing -- one ordered set of rules, no capability tests, no blending
// // ---------------------------------------------------------------------------
// 
// // Ordered rules, no capability tests and no blending. A ship under way points
// // where it is going, because that is the only direction it can travel; a ship
// // standing still points at whatever it cares about.
// function computeDesiredFacing(ship, stats, intent, decision) {
//   if (ship.manualRotation === 1 || ship.manualRotation === -1) {
//     return (ship.angle || 0) + ship.manualRotation * (Math.PI - 1e-9);
//   }
//   if (intent.type === "stop") return ship.angle || 0;
//   const targetAngle = decision.target
//     ? Math.atan2(
//       (decision.target.y || 0) - (ship.y || 0),
//       (decision.target.x || 0) - (ship.x || 0)
//     )
//     : null;
//   // Parked. Commit to one heading and hold it: a ship on station must not
//   // re-aim every time it is jostled.
//   if (decision.positioned) {
//     if (Number.isFinite(decision.finalFacing)) return decision.finalFacing;
//     if (targetAngle !== null) return targetAngle;
//     return ship.angle || 0;
//   }
//   // Under way: the nose is the direction of travel. Leaving that state costs
//   // less speed than entering it, so a ship idling either side of the threshold
//   // -- which is most of arrival -- does not swap the source of its facing every
//   // tick.
//   //
//   // "Under way" needs somewhere to be going as well as a speed to go there at.
//   // A commanded speed says nothing on its own: an intent that skips arrival
//   // braking keeps commanding one after the ship is standing on its goal, and the
//   // bearing to a goal that close is noise the hull would spend its whole turn
//   // rate chasing.
//   const wasTravelling = ensureMovementRuntime(ship).facingTravelling;
//   const goalIsSteerable = !decision.goal
//     || decision.distance > (wasTravelling
//       ? FACING_MIN_GOAL_DISTANCE_RELEASE
//       : FACING_MIN_GOAL_DISTANCE);
//   const travelling = goalIsSteerable
//     && (wasTravelling
//       ? decision.desiredSpeed > FACING_MIN_SPEED_RELEASE
//       : decision.desiredSpeed > FACING_MIN_SPEED);
//   ensureMovementRuntime(ship).facingTravelling = travelling;
//   if (travelling) return decision.moveAngle;
//   // A drifting hull can still have turn authority even when it has no working
//   // forward drive. Keep an unfinished ground move pointed at its live
//   // destination, but stop consulting that bearing once it is positioned.
//   //
//   // Only while the destination is far enough away for its bearing to mean
//   // anything. refreshDecisionHeading already refuses to derive a heading from a
//   // commanded velocity this small, for the reason that applies just as much
//   // here: the bearing to a point a few pixels away swings wildly, and at the
//   // end of an arrival that point is a few pixels away by definition. A ship
//   // parked on its mark and nudged sideways -- by a neighbour, or by the
//   // separation solver -- would drop out of `positioned` for one tick, land in
//   // this branch, and be told to face a destination now 20 px off its beam. It
//   // turned 40-odd degrees to obey, then re-settled: the arrival pirouette.
//   if (intent.type === "move"
//     && decision.goal
//     && decision.distance > ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO) {
//     return Math.atan2(
//       decision.goal.y - (ship.y || 0),
//       decision.goal.x - (ship.x || 0)
//     );
//   }
//   // Holding position without having formally arrived -- aim at the target if
//   // there is one, otherwise stay put.
//   if (targetAngle !== null) return targetAngle;
//   if (Number.isFinite(decision.finalFacing)) return decision.finalFacing;
//   return ship.angle || 0;
// }
// 
// // The facing computed above is a fresh answer every tick, and it moves: the
// // destination bearing swings when separation shoves the hull a few pixels, the
// // avoidance sidestep comes and goes, the branches above trade places. A slow
// // hull hid all of that behind its own turn rate, which is a low-pass filter by
// // accident. A fast one has none -- rotateToward reaches any of these in a single
// // tick -- so it reproduces the noise exactly, and that is the jitter. Filter the
// // command instead of the hull: hold the last one until the new answer is a real
// // change of mind.
// function resolveDesiredFacing(ship, stats, intent, decision) {
//   const desired = computeDesiredFacing(ship, stats, intent, decision);
//   const runtime = ensureMovementRuntime(ship);
//   const previous = runtime.facingCommand;
//   if (ship.manualRotation === 1 || ship.manualRotation === -1
//     || !Number.isFinite(previous)
//     || runtime.facingCommandIntent !== intent.type
//     || Math.abs(angleDifference(previous, desired)) > FACING_COMMAND_HYSTERESIS) {
//     runtime.facingCommand = desired;
//     runtime.facingCommandIntent = intent.type;
//     return desired;
//   }
//   return previous;
// }
// 
// function directionalTurnRate(stats, current, desired, ship) {
//   const difference = angleDifference(current, desired);
//   if (Math.abs(difference) < 1e-9) return 0;
//   const base = difference > 0
//     ? (stats.turnRateRight ?? stats.turnRate ?? 0)
//     : (stats.turnRateLeft ?? stats.turnRate ?? 0);
//   const rate = Number.isFinite(base) ? base : 0;
//   return ship?.commandState === "backupCore" ? rate * BACKUP_CORE_TURN_SCALE : rate;
// }
// 
// let cachedHeatRules = null;
// function activityHeatRate(type, part) {
//   if (!cachedHeatRules) cachedHeatRules = require("../../public/src/shared/heatRules.js");
//   return Math.max(0, Number(cachedHeatRules.activityHeat(type, part)) || 0);
// }
// 
// function heatActiveManeuverThrusters(ship, turnActivity, dt) {
//   if (!turnActivity || !Number.isFinite(turnActivity)) return;
//   const desiredSign = Math.sign(turnActivity);
//   const exhaust = ship.engineExhaustAnalysis;
//   if (!exhaust) return;
//   for (const index of getShipComponentIndexes(ship).maneuverThrusterIndices) {
//     const module = ship.design[index];
//     const part = PARTS[module.type];
//     if (!part || (ship.componentHp?.[index] ?? 1) <= 0) continue;
//     if (!exhaust.validEngineIndices.has(index)) continue;
//     if (maneuverThrusterTorqueSign(module, exhaust.centerOfMass) !== desiredSign) continue;
//     const performance = componentPerformance(ship, index)
//       * getComponentPowerMultiplier(ship, index);
//     if (performance > 0) {
//       addComponentHeat(
//         ship,
//         index,
//         (ENGINE_HEAT_BASE + (part.lateralThrust || 0) * MANEUVER_HEAT_PER_THRUST)
//           * Math.abs(turnActivity)
//           * performance
//           * dt
//       );
//     }
//   }
// }
// 
// function heatActiveGyroscopes(ship, turnActivity, dt) {
//   if (!turnActivity || !Number.isFinite(turnActivity)) return;
//   for (const index of getShipComponentIndexes(ship).gyroscopeIndices) {
//     const part = PARTS[ship.design[index].type] || {};
//     if ((ship.componentHp?.[index] ?? 1) <= 0) continue;
//     const performance = componentPerformance(ship, index)
//       * getComponentPowerMultiplier(ship, index);
//     const rate = activityHeatRate("gyroscope", part);
//     if (performance > 0 && rate > 0) {
//       addComponentHeat(ship, index, rate * Math.abs(turnActivity) * performance * dt);
//     }
//   }
// }
// 
// function turnHullToward(ship, desiredFacing, stats, dt) {
//   const before = ship.angle || 0;
//   const difference = angleDifference(before, desiredFacing);
//   if (Math.abs(difference) < FINAL_FACING_TOLERANCE) {
//     ship.turnActivity = 0;
//     return;
//   }
//   const rate = directionalTurnRate(stats, before, desiredFacing, ship);
//   // rotateToward lands exactly on the command as soon as the hull can cover the
//   // error in one tick, which for a fast hull is nearly always -- and an exact
//   // landing means whatever residual noise is left in the command shows up
//   // undamped in the hull angle. Approach the last of it exponentially instead.
//   // Large errors are unaffected: they are rate-limited long before the damping
//   // term binds, so a genuine change of course is as quick as it ever was.
//   const maxDelta = Math.max(0, rate * dt);
//   const step = clampNumber(difference * TURN_COMMAND_DAMPING, -maxDelta, maxDelta);
//   // sanitizeMovementState normalizes the hull angle at the end of every substep.
//   const next = before + step;
//   ship.angle = next;
//   const applied = Math.abs(angleDifference(before, next));
//   const signed = Math.sign(angleDifference(before, next));
//   ship.turnActivity = rate > 0
//     ? clampNumber(applied / Math.max(rate * dt, 1e-9) * signed, -1, 1)
//     : 0;
//   heatActiveManeuverThrusters(ship, ship.turnActivity, dt);
//   heatActiveGyroscopes(ship, ship.turnActivity, dt);
// }
// 
// // ---------------------------------------------------------------------------
// // Propulsion
// // ---------------------------------------------------------------------------
// 
// function heatMainEngines(ship, activity, dt, stats) {
//   if (activity <= 0) return;
//   for (const index of getShipComponentIndexes(ship).thrustIndices) {
//     const part = PARTS[ship.design[index].type];
//     if (!part || (ship.componentHp?.[index] ?? 1) <= 0) continue;
//     if (ship.validEngineIndices && !ship.validEngineIndices.has(index)) continue;
//     const performance = componentPerformance(ship, index)
//       * getComponentPowerMultiplier(ship, index);
//     if (performance > 0) {
//       addComponentHeat(
//         ship,
//         index,
//         (ENGINE_HEAT_BASE + (part.thrust || 0) * ENGINE_HEAT_PER_THRUST)
//           * activity * performance * dt
//       );
//     }
//   }
// }
// 
// // Ships travel along their nose and nowhere else. The engines point backwards,
// // so the only thing they can do is change how fast the ship is going; changing
// // where it is going is the job of the turn rate. A ship therefore steers like a
// // boat -- it swings onto its course and drives -- and it never slides sideways,
// // because nothing aboard could produce that force.
// //
// // Speed itself decays toward the commanded speed with time constant
// // VELOCITY_TIME_CONSTANT_S, limited by what the engines can deliver this step.
// // Exponential approach cannot overshoot the command, so a ship never oscillates
// // around its target speed however weak or strong its engines are.
// function applyFlightAssist(ship, stats, decision, dt) {
//   if (!decision.needsPropulsion) return;
//   // No working engines, no helm. Returning here leaves the existing velocity
//   // untouched, so the wreck coasts on the momentum it already had -- correct
//   // out here, and the only motion it can still have. Falling through would let
//   // it both accelerate on the driveAcceleration floor and, worse, re-point its
//   // whole velocity vector along the nose every substep, which is a ship with no
//   // engines steering itself.
//   if (!hasDrive(stats)) return;
//   const forwardX = Math.cos(ship.angle || 0);
//   const forwardY = Math.sin(ship.angle || 0);
// 
//   // Only the part of the commanded velocity that lies along the nose is
//   // achievable. While the ship is still coming round onto its course this is
//   // less than the full command, and if the course lies behind it the projection
//   // goes negative -- the ship coasts to a stop and turns rather than reversing.
//   const commanded = decision.desiredVelocity.x * forwardX
//     + decision.desiredVelocity.y * forwardY;
//   const targetSpeed = Math.max(0, commanded);
//   const speed = (ship.vx || 0) * forwardX + (ship.vy || 0) * forwardY;
// 
//   const blend = 1 - Math.exp(-dt / VELOCITY_TIME_CONSTANT_S);
//   const available = driveAcceleration(stats) * dt;
//   const requested = (targetSpeed - speed) * blend;
//   const delta = clampNumber(requested, -available, available);
// 
//   const next = speed + delta;
//   ship.vx = forwardX * next;
//   ship.vy = forwardY * next;
//   heatMainEngines(
//     ship,
//     Math.min(1, Math.abs(requested) / Math.max(available, 1e-9)),
//     dt,
//     stats
//   );
// }
// 
// function applySpeedLimit(ship, stats, decision) {
//   // A ship asked to hold still and already almost still is parked outright.
//   // Without this it converges on zero asymptotically and never gets there, so it
//   // creeps off station a pixel at a time -- there is no drag out here to finish
//   // the job.
//   if (decision && decision.desiredSpeed < REST_SPEED) {
//     const speed = fastHypot(ship.vx || 0, ship.vy || 0);
//     if (speed > 0 && speed < REST_SPEED) {
//       ship.vx = 0;
//       ship.vy = 0;
//       return;
//     }
//   }
//   const limit = Number(stats.maxSpeed) || 0;
//   // A ship with no engine-derived speed allowance is not clamped to a standstill:
//   // it has already been cut out of applyFlightAssist, so it cannot gain speed,
//   // and whatever momentum it still carries is a drift a collision may alter but
//   // nothing here should erase.
//   if (limit <= 0) return;
//   const speed = fastHypot(ship.vx || 0, ship.vy || 0);
//   if (speed <= limit || speed <= 0) return;
//   const scale = limit / speed;
//   ship.vx *= scale;
//   ship.vy *= scale;
// }
// 
// function integratePosition(room, ship, dt) {
//   const dx = (ship.vx || 0) * dt;
//   const dy = (ship.vy || 0) * dt;
//   ship.x = (ship.x || 0) + dx;
//   ship.y = (ship.y || 0) + dy;
//   ship._integratedMovementX = (ship._integratedMovementX || 0) + dx;
//   ship._integratedMovementY = (ship._integratedMovementY || 0) + dy;
//   const width = room?.world?.width || 2000;
//   const height = room?.world?.height || 1600;
//   if (ship.x < EDGE_BOUNCE_MARGIN) {
//     ship.x = EDGE_BOUNCE_MARGIN;
//     ship.vx = Math.abs(ship.vx || 0) * EDGE_RESTITUTION;
//   } else if (ship.x > width - EDGE_BOUNCE_MARGIN) {
//     ship.x = width - EDGE_BOUNCE_MARGIN;
//     ship.vx = -Math.abs(ship.vx || 0) * EDGE_RESTITUTION;
//   }
//   if (ship.y < EDGE_BOUNCE_MARGIN) {
//     ship.y = EDGE_BOUNCE_MARGIN;
//     ship.vy = Math.abs(ship.vy || 0) * EDGE_RESTITUTION;
//   } else if (ship.y > height - EDGE_BOUNCE_MARGIN) {
//     ship.y = height - EDGE_BOUNCE_MARGIN;
//     ship.vy = -Math.abs(ship.vy || 0) * EDGE_RESTITUTION;
//   }
// }
// 
// // ---------------------------------------------------------------------------
// // Phase reporting
// // ---------------------------------------------------------------------------
// 
// function postIntegrationPositioned(ship, intent, navigation) {
//   if (!intent.arrivalRequired) return false;
//   const speed = fastHypot(ship.vx || 0, ship.vy || 0);
//   if (!navigation.goal) {
//     const desired = intent.desiredVelocity || { x: 0, y: 0 };
//     return fastHypot(
//       (ship.vx || 0) - desired.x,
//       (ship.vy || 0) - desired.y
//     ) < ARRIVE_SPEED;
//   }
//   const distance = fastHypot(
//     navigation.goal.x - (ship.x || 0),
//     navigation.goal.y - (ship.y || 0)
//   );
//   const parked = ["final-facing", "positioned"].includes(ensureMovementRuntime(ship).phase)
//     && distance < ARRIVE_DISTANCE * ARRIVE_LATCH_RATIO;
//   return navigation.isFinal
//     && (distance < ARRIVE_DISTANCE || parked)
//     && speed < DESTINATION_ARRIVE_SPEED;
// }
// 
// function updateMovementPhase(ship, stats, intent, navigation, decision) {
//   const runtime = ensureMovementRuntime(ship);
//   if (ship.manualRotation === 1 || ship.manualRotation === -1) {
//     runtime.phase = "turning";
//     return runtime.phase;
//   }
//   if (postIntegrationPositioned(ship, intent, navigation)) {
//     const finalFacing = intent.facingMode === "final"
//       ? (Number.isFinite(intent.finalFacing) ? intent.finalFacing : navigation.finalFacing)
//       : null;
//     if (Number.isFinite(finalFacing)
//       && Math.abs(angleDifference(ship.angle || 0, finalFacing)) > FINAL_FACING_TOLERANCE) {
//       runtime.phase = "final-facing";
//     } else {
//       // A ship parked with nothing to do is idle; a ship parked because it was
//       // told to stop, or because its combat style has it holding station, is
//       // positioned. "Nothing to do" covers both no target at all and a target it
//       // can no longer act on (disarmed), which is why this keys off the intent
//       // collapsing to a stop rather than off the reason string.
//       runtime.phase = intent.type === "stop" && !runtime.command
//         ? "idle"
//         : "positioned";
//     }
//     return runtime.phase;
//   }
//   if (intent.type === "stop"
//     || (intent.arrivalRequired
//       && navigation.isFinal
//       && decision.distance <= decision.stoppingDistance + ARRIVE_DISTANCE)) {
//     runtime.phase = "braking";
//   } else {
//     runtime.phase = "travelling";
//   }
//   return runtime.phase;
// }
// 
// function movementIntentIsFinite(intent) {
//   if (!intent || typeof intent !== "object") return false;
//   const pointIsFinite = (value) => value == null
//     || (Number.isFinite(value.x) && Number.isFinite(value.y));
//   return typeof intent.type === "string"
//     && pointIsFinite(intent.destination)
//     && pointIsFinite(intent.desiredVelocity)
//     && (intent.finalFacing == null || Number.isFinite(intent.finalFacing))
//     && (intent.desiredRange == null || Number.isFinite(intent.desiredRange));
// }
// 
// module.exports = {
//   applyFlightAssist,
//   applySpeedLimit,
//   buildMovementDecision,
//   computeStoppingDistance,
//   heatAdjustedMovementStats,
//   integratePosition,
//   movementIntentIsFinite,
//   refreshDecisionHeading,
//   resolveDesiredFacing,
//   turnHullToward,
//   updateMovementPhase
// };

// ======== src/server/movementCommands.js ========
// "use strict";
// 
// const { clampNumber, fastHypot, compareEntityIds } = require("./utils");
// const { areEntityAllies, areEntityEnemies } = require("./relationships");
// const { selectOwnedLivingShips } = require("./selection");
// const { WORLD_MARGIN } = require("./movementTuning");
// const { separationRadius } = require("./movementCollision");
// const {
//   navigationPlanningClearance,
//   nearestClearPoint
// } = require("./movementNavigation");
// const {
//   ensureMovementRuntime,
//   nextMovementCommandId,
//   resetNavigation,
//   resetStyleMemory,
//   setManualRotation,
//   setMovementCommand,
//   syncMovementTarget
// } = require("./movementRuntime");
// const { canTeamTargetEntity } = require("./visibility");
// 
// function clearTargetReferences(ship) {
//   ship.focusTargetId = null;
//   ship.combatTargetId = null;
//   ship.repairTargetId = null;
// }
// 
// // `manual` marks an order the player issued directly. Those own movement
// // outright: auto-targeting re-assigns ship.combatTargetId every combat tick, so
// // without this flag a combat stance reclaims the helm on the tick after a right
// // click and drags the ship back to where it was. Internal rally moves (station
// // spawn, formation assignment) leave it false so freshly built ships still
// // engage on their own.
// function commandRecord(id, type, destination = null, targetId = null, finalFacing = null, manual = false) {
//   return { id, type, destination, targetId, finalFacing, manual };
// }
// 
// function slotOffsets(count, spacing) {
//   if (count <= 1) return [{ x: 0, y: 0 }];
//   const columns = Math.ceil(Math.sqrt(count));
//   const rows = Math.ceil(count / columns);
//   const offsets = [];
//   for (let index = 0; index < count; index += 1) {
//     const col = index % columns;
//     const row = Math.floor(index / columns);
//     const entriesInRow = Math.min(columns, count - row * columns);
//     offsets.push({
//       x: (col - (entriesInRow - 1) / 2) * spacing,
//       y: (row - (rows - 1) / 2) * spacing
//     });
//   }
//   return offsets;
// }
// 
// function slotDoesNotOverlap(point, radius, assigned) {
//   return assigned.every((entry) =>
//     fastHypot(point.x - entry.x, point.y - entry.y) >= radius + entry.radius + 4);
// }
// 
// function clearNonOverlappingSlot(room, desired, ship, assigned, ordinal, spacing) {
//   const radius = separationRadius(ship);
//   for (let attempt = 0; attempt < 48; attempt += 1) {
//     const ring = attempt === 0 ? 0 : Math.ceil(attempt / 8);
//     const turn = attempt === 0 ? 0 : (attempt - 1) % 8;
//     const angle = turn * Math.PI / 4 + ordinal * 0.173;
//     const candidate = {
//       x: desired.x + Math.cos(angle) * ring * spacing,
//       y: desired.y + Math.sin(angle) * ring * spacing
//     };
//     // The planner's requirement, not the hull's. A slot that satisfies only the
//     // hull clearance is one the path search will not accept as a goal, so it
//     // relocates it -- and the ship then parks wherever the relocation landed
//     // while the order marker stays where the player clicked. Measured 367 px
//     // apart for a wide hull ordered near a station, with the ship reporting
//     // itself arrived the whole time.
//     const clear = nearestClearPoint(
//       room,
//       candidate.x,
//       candidate.y,
//       navigationPlanningClearance(ship)
//     );
//     if (!clear.clear || !slotDoesNotOverlap(clear, radius, assigned)) continue;
//     return { x: clear.x, y: clear.y, radius };
//   }
//   return null;
// }
// 
// function generateDestinationSlots(room, ships, destination) {
//   const ordered = ships.slice().sort(compareEntityIds);
//   const largestRadius = ordered.reduce(
//     (largest, ship) => Math.max(largest, separationRadius(ship)),
//     18
//   );
//   const spacing = largestRadius * 2 + 12;
//   const offsets = slotOffsets(ordered.length, spacing);
//   const assigned = [];
//   const slots = new Map();
//   for (let index = 0; index < ordered.length; index += 1) {
//     const offset = offsets[index];
//     const desired = {
//       x: destination.x + offset.x,
//       y: destination.y + offset.y
//     };
//     const slot = clearNonOverlappingSlot(
//       room,
//       desired,
//       ordered[index],
//       assigned,
//       index,
//       spacing
//     );
//     if (!slot) continue;
//     assigned.push(slot);
//     slots.set(ordered[index].id, { x: slot.x, y: slot.y });
//   }
//   return slots;
// }
// 
// function setAttackCommand(ship, commandId, targetId, room = null, now = 0) {
//   const target = room?.ships?.get?.(targetId) || room?.stationsById?.get?.(targetId);
//   const viewerTeam = room?.players?.get?.(ship.ownerId)?.team ?? ship.team ?? ship.ownerId;
//   if (target && room && !canTeamTargetEntity(room, viewerTeam, target, now)) {
//     clearTargetReferences(ship);
//     ship.combatTargetId = null;
//     ship.focusTargetId = null;
//     return false;
//   }
//   clearTargetReferences(ship);
//   ship.combatTargetId = targetId;
//   ship.focusTargetId = targetId;
//   resetStyleMemory(ship, ship.combatStyle);
//   setMovementCommand(
//     ship,
//     commandRecord(`${commandId}:${ship.id}`, "attack", null, targetId, null)
//   );
//   syncMovementTarget(ship);
// }
// 
// function setRepairCommand(ship, commandId, targetId) {
//   clearTargetReferences(ship);
//   ship.repairTargetId = targetId;
//   resetStyleMemory(ship, ship.combatStyle);
//   setMovementCommand(
//     ship,
//     commandRecord(`${commandId}:${ship.id}`, "repair", null, targetId, null)
//   );
//   syncMovementTarget(ship);
// }
// 
// function setMoveCommand(ship, commandId, destination, finalFacing, manual = false) {
//   clearTargetReferences(ship);
//   resetStyleMemory(ship, ship.combatStyle);
//   setMovementCommand(
//     ship,
//     commandRecord(
//       `${commandId}:${ship.id}`,
//       "move",
//       destination,
//       null,
//       Number.isFinite(finalFacing) ? finalFacing : null,
//       manual
//     )
//   );
//   syncMovementTarget(ship);
// }
// 
// function commandShips(room, player, x, y, options = {}) {
//   const selected = selectOwnedLivingShips(player, options.shipIds);
//   if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
//   const ships = selected.ships;
//   if (ships.length === 0) return { ok: true, code: "none", commanded: 0 };
// 
//   const clickedTarget = options.targetId == null
//     ? null
//     : (room.ships?.get(String(options.targetId)) || room.stationsById?.get(String(options.targetId)));
//   const livingTarget = clickedTarget?.alive ? clickedTarget : null;
//   const selectedIds = new Set(ships.map((ship) => ship.id));
//   const enemy = livingTarget
//     && areEntityEnemies(room, player?.id, livingTarget);
//   const ally = livingTarget
//     && !selectedIds.has(livingTarget.id)
//     && areEntityAllies(room, player?.id, livingTarget);
//   const commandId = nextMovementCommandId(
//     room,
//     enemy ? "a" : (ally ? "r" : "m")
//   );
// 
//   if (enemy) {
//     const { performanceNow } = require("./utils");
//     const now = performanceNow();
//     for (const ship of ships) setAttackCommand(ship, commandId, livingTarget.id, room, now);
//     return { ok: true, code: "attack", commanded: ships.length };
//   }
//   if (ally) {
//     for (const ship of ships) setRepairCommand(ship, commandId, livingTarget.id);
//     return { ok: true, code: "repair", commanded: ships.length };
//   }
// 
//   const width = room?.world?.width || 2000;
//   const height = room?.world?.height || 1600;
//   const destination = {
//     x: clampNumber(x, WORLD_MARGIN, width - WORLD_MARGIN),
//     y: clampNumber(y, WORLD_MARGIN, height - WORLD_MARGIN)
//   };
//   const slots = generateDestinationSlots(room, ships, destination);
//   let commanded = 0;
//   for (const ship of ships) {
//     const slot = slots.get(ship.id);
//     if (!slot) {
//       setMovementCommand(
//         ship,
//         commandRecord(
//           `${commandId}:${ship.id}`,
//           "stop",
//           { x: ship.x, y: ship.y },
//           null,
//           null,
//           true
//         )
//       );
//       syncMovementTarget(ship);
//       continue;
//     }
//     setMoveCommand(ship, commandId, slot, options.finalFacing, true);
//     commanded += 1;
//   }
//   return {
//     ok: true,
//     code: commanded === ships.length ? "move" : "partial-move",
//     commanded
//   };
// }
// 
// function commandShipsToAssignedSlots(room, ships, slots, options = {}) {
//   const commandId = nextMovementCommandId(room, options.prefix || "m");
//   let commanded = 0;
//   for (const ship of ships || []) {
//     if (!ship?.alive) continue;
//     const slot = slots?.get(ship.id);
//     if (!slot || !Number.isFinite(slot.x) || !Number.isFinite(slot.y)) continue;
//     setMoveCommand(ship, commandId, { x: slot.x, y: slot.y }, options.finalFacing);
//     commanded += 1;
//   }
//   return commanded;
// }
// 
// function stopShips(room, player, shipIds) {
//   const selected = selectOwnedLivingShips(player, shipIds);
//   if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
//   const commandId = nextMovementCommandId(room, "s");
//   for (const ship of selected.ships) {
//     clearTargetReferences(ship);
//     resetStyleMemory(ship, ship.combatStyle);
//     setMovementCommand(
//       ship,
//       commandRecord(
//         `${commandId}:${ship.id}`,
//         "stop",
//         { x: ship.x, y: ship.y },
//         null,
//         null,
//         true
//       )
//     );
//     syncMovementTarget(ship);
//   }
//   return { ok: true, code: "stop", commanded: selected.ships.length };
// }
// 
// function rotateShips(room, player, options) {
//   const direction = options?.direction;
//   const active = options?.active;
//   const shipIds = options?.shipIds;
//   const selected = selectOwnedLivingShips(player, shipIds);
//   if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
//   for (const ship of selected.ships) {
//     if (!active) {
//       setManualRotation(ship, null);
//       continue;
//     }
//     setManualRotation(ship, direction);
//     syncMovementTarget(ship);
//   }
//   return { ok: true, code: "rotate", commanded: selected.ships.length };
// }
// 
// function applyCombatStyle(ship, combatStyle) {
//   ship.combatStyle = combatStyle;
//   resetStyleMemory(ship, combatStyle);
//   resetNavigation(ship);
// }
// 
// module.exports = {
//   applyCombatStyle,
//   commandShips,
//   commandShipsToAssignedSlots,
//   generateDestinationSlots,
//   rotateShips,
//   stopShips
// };

// ======== src/server/movementIntents.js ========
// "use strict";
// 
// const { clampNumber, fastHypot, hashString } = require("./utils");
// const {
//   nearestDemolitionTargetPoint,
//   shipHasOperationalDemolitionCharge
// } = require("./combat");
// const { areEntityEnemies } = require("./relationships");
// const { getEffectiveWeaponRanges } = require("./componentData");
// const { sanitizeCombatStyle } = require("./validation");
// const {
//   ARRIVE_DISTANCE,
//   ARRIVE_SPEED,
//   CHARGE_LEAD_MAX_S,
//   CHARGE_MIN_SPEED_FACTOR,
//   CHARGE_SETTLE_TIME_S,
//   HOLD_RANGE_RATIO,
//   KITE_RANGE_RATIO,
//   NAV_STUCK_TIME_MS,
//   ORBIT_LEAD_ANGLE,
//   ORBIT_LEAD_STEPS,
//   ORBIT_RANGE_RATIO,
//   REPAIR_STANDOFF_PAD,
//   WORLD_MARGIN
// } = require("./movementTuning");
// const {
//   navigationClearanceRadius,
//   physicalCollisionRadius,
//   separationRadius
// } = require("./movementCollision");
// const { ensureMovementRuntime } = require("./movementRuntime");
// const { nearestClearPoint } = require("./movementNavigation");
// 
// const SUPPORTED_MOVEMENT_TYPES = Object.freeze([
//   "move",
//   "hold",
//   "kite",
//   "orbit",
//   "charge",
//   "station",
//   "repair",
//   "stop"
// ]);
// 
// function point(x, y) {
//   return { x: Number(x) || 0, y: Number(y) || 0 };
// }
// 
// function movementIntent(type, values = {}) {
//   return {
//     type,
//     destination: values.destination || null,
//     desiredVelocity: values.desiredVelocity || null,
//     facingMode: values.facingMode || "current",
//     facingTargetId: values.facingTargetId || null,
//     finalFacing: Number.isFinite(values.finalFacing) ? values.finalFacing : null,
//     desiredRange: Number.isFinite(values.desiredRange) ? values.desiredRange : null,
//     arrivalRequired: Boolean(values.arrivalRequired),
//     persistent: Boolean(values.persistent),
//     debugReason: String(values.debugReason || type),
//     maxSpeedFactor: Number.isFinite(values.maxSpeedFactor) ? values.maxSpeedFactor : 1,
//     styleMemory: values.styleMemory || null
//   };
// }
// 
// function stopIntent(reason = "no-command") {
//   return movementIntent("stop", {
//     desiredVelocity: { x: 0, y: 0 },
//     facingMode: "current",
//     arrivalRequired: true,
//     persistent: false,
//     debugReason: reason
//   });
// }
// 
// function livingTarget(room, targetId) {
//   if (!targetId) return null;
//   const str = String(targetId);
//   const target = room.ships?.get(str) || room.stationsById?.get(str);
//   return target?.alive ? target : null;
// }
// 
// function firstLivingTarget(room, targetIds) {
//   for (const targetId of targetIds) {
//     const target = livingTarget(room, targetId);
//     if (target) return target;
//   }
//   return null;
// }
// 
// function firstLivingEnemyTarget(room, ship, targetIds) {
//   for (const targetId of targetIds) {
//     const target = livingTarget(room, targetId);
//     if (target && !target.removed
//       && areEntityEnemies(room, ship.ownerId, target)) return target;
//   }
//   return null;
// }
// 
// function activeRepairTarget(room, ship, runtime) {
//   return firstLivingTarget(room, [
//     ship.repairTargetId,
//     runtime.command?.type === "repair" ? runtime.command.targetId : null
//   ]);
// }
// 
// function activeCombatTarget(room, ship, runtime) {
//   return firstLivingEnemyTarget(room, ship, [
//     ship.focusTargetId,
//     ship.combatTargetId,
//     runtime.command?.type === "attack" ? runtime.command.targetId : null
//   ]);
// }
// 
// function maximumWeaponRange(ship) {
//   const ranges = getEffectiveWeaponRanges(ship);
//   return Math.max(
//     0,
//     Number(ranges.blaster) || 0,
//     Number(ranges.missile) || 0,
//     Number(ranges.railgun) || 0,
//     Number(ranges.beam) || 0
//   );
// }
// 
// function relativeRangeState(ship, target, desiredRange) {
//   const dx = (ship.x || 0) - (target.x || 0);
//   const dy = (ship.y || 0) - (target.y || 0);
//   const distance = fastHypot(dx, dy) || 1;
//   const unitX = dx / distance;
//   const unitY = dy / distance;
//   const relativeVx = (ship.vx || 0) - (target.vx || 0);
//   const relativeVy = (ship.vy || 0) - (target.vy || 0);
//   return {
//     distance,
//     unitX,
//     unitY,
//     rangeError: distance - desiredRange,
//     radialVelocity: relativeVx * unitX + relativeVy * unitY,
//     destination: {
//       x: (target.x || 0) + unitX * desiredRange,
//       y: (target.y || 0) + unitY * desiredRange
//     }
//   };
// }
// 
// // The legal interior a ship can actually be routed to. WORLD_MARGIN alone is not
// // enough: the nav grid additionally requires the ship's clearance radius, so a
// // destination inside that band is unreachable and nearestClearPoint relocates it
// // -- by BFS ring order, which is to say sideways, in whatever direction it
// // happens to visit first. Combat intents used to emit raw points and rely on
// // that, which is why a ship backed against a wall shuffled instead of moving.
// function playableBounds(room, ship) {
//   const width = room?.world?.width || 2000;
//   const height = room?.world?.height || 1600;
//   const inset = WORLD_MARGIN + navigationClearanceRadius(ship);
//   return {
//     minX: inset,
//     minY: inset,
//     maxX: Math.max(inset, width - inset),
//     maxY: Math.max(inset, height - inset)
//   };
// }
// 
// function clampToPlayableArea(room, ship, candidate) {
//   const bounds = playableBounds(room, ship);
//   const x = clampNumber(candidate.x, bounds.minX, bounds.maxX);
//   const y = clampNumber(candidate.y, bounds.minY, bounds.maxY);
//   return { x, y, clamped: x !== candidate.x || y !== candidate.y };
// }
// 
// function holdStationIntent(station, target, desiredRange, reason, memory = null) {
//   return movementIntent("hold", {
//     destination: { ...station },
//     facingMode: "target",
//     facingTargetId: target.id,
//     desiredRange,
//     arrivalRequired: true,
//     persistent: true,
//     debugReason: reason,
//     styleMemory: memory
//   });
// }
// 
// // Hold picks one firing position and works from it. It closes to weapon range
// // once, commits, and everything after that is a question of whether the target
// // is still shootable from where the ship already stands -- not of maintaining a
// // preferred separation. A target that closes in is a target that got easier to
// // hit, so it never causes a withdrawal.
// function holdIntent(ship, target, maximumRange, runtime) {
//   const desiredRange = Math.max(80, maximumRange * HOLD_RANGE_RATIO);
//   const range = relativeRangeState(ship, target, desiredRange);
//   // A committed station outlives the target that prompted it. Hold retargets
//   // deliberately (see findTarget), and re-approaching the range ring of every
//   // new contact would have it wandering the battle instead of holding a line.
//   // The station stands while anything it is shooting at is reachable from it.
//   const station = runtime.style.holdPosition;
//   if (station) {
//     const stationRange = fastHypot(
//       (target.x || 0) - station.x,
//       (target.y || 0) - station.y
//     );
//     if (stationRange <= maximumRange) {
//       return holdStationIntent(
//         station,
//         target,
//         desiredRange,
//         runtime.style.holdTargetId === target.id
//           ? "hold:established-position"
//           : "hold:station-retained-new-target",
//         { holdPosition: station, holdTargetId: target.id }
//       );
//     }
//   }
//   // Arrival braking parks a ship ARRIVE_DISTANCE short of its destination, and
//   // the approach destination sits exactly on the desiredRange ring -- so
//   // "distance <= desiredRange" is a condition the controller can never satisfy,
//   // and the ship chases the ring forever instead of committing. Commit on a
//   // band the size of that shortfall instead.
//   const tolerance = Math.max(ARRIVE_DISTANCE, (Number(ship.radius) || 0) * 0.5);
//   if (range.rangeError <= tolerance) {
//     // Inside the band but still carrying speed: park where we are rather than
//     // fall through to the approach branch, whose destination sits behind us and
//     // would read on screen as backing away from a target that just closed.
//     if (fastHypot(ship.vx || 0, ship.vy || 0) >= ARRIVE_SPEED) {
//       return holdStationIntent(
//         point(ship.x, ship.y),
//         target,
//         desiredRange,
//         "hold:settling"
//       );
//     }
//     const holdPosition = point(ship.x, ship.y);
//     return holdStationIntent(
//       holdPosition,
//       target,
//       desiredRange,
//       "hold:position-committed",
//       { holdPosition, holdTargetId: target.id }
//     );
//   }
//   return movementIntent("hold", {
//     destination: range.destination,
//     facingMode: "target",
//     facingTargetId: target.id,
//     desiredRange,
//     arrivalRequired: true,
//     persistent: true,
//     debugReason: "hold:approach-outside-range",
//     styleMemory: { holdPosition: null, holdTargetId: target.id }
//   });
// }
// 
// // Angles off the straight-back bearing to try when a straight retreat would run
// // the ship into the edge of the world. Each still sits on the safe-range ring,
// // so separation is preserved while the ship travels along the wall rather than
// // into it.
// const KITE_WALL_SLIDE_ANGLES = Object.freeze([0.6, 1.2, 1.8]);
// 
// function ringPoint(target, bearing, radius) {
//   return point(
//     (target.x || 0) + Math.cos(bearing) * radius,
//     (target.y || 0) + Math.sin(bearing) * radius
//   );
// }
// 
// // Straight back if that is available. Backed against the world edge it is not,
// // and a clamped point sits inside the ring the ship is trying to hold, so the
// // ship re-issues the same retreat every tick and grinds along the boundary
// // without ever satisfying it. Give up on the radial line in that case and take
// // the ring point nearest to it that is actually reachable, committing to one
// // side so the choice does not flip tick to tick.
// function kiteRetreatDestination(room, ship, target, range, safeRange, preferredSide) {
//   const straight = clampToPlayableArea(room, ship, range.destination);
//   if (!straight.clamped) return { destination: point(straight.x, straight.y), side: preferredSide };
//   const bearing = Math.atan2(range.unitY, range.unitX);
//   const sides = preferredSide === -1 ? [-1, 1] : [1, -1];
//   for (const offset of KITE_WALL_SLIDE_ANGLES) {
//     for (const side of sides) {
//       const candidate = ringPoint(target, bearing + side * offset, safeRange);
//       const clamped = clampToPlayableArea(room, ship, candidate);
//       if (!clamped.clamped) return { destination: candidate, side };
//     }
//   }
//   return { destination: point(straight.x, straight.y), side: preferredSide };
// }
// 
// function kiteIntent(room, ship, target, maximumRange, runtime, now) {
//   const safeRange = Math.max(80, maximumRange * KITE_RANGE_RATIO);
//   const range = relativeRangeState(ship, target, safeRange);
//   // Arrival braking parks a ship ARRIVE_DISTANCE short of its destination and
//   // the retreat destination sits exactly on the ring, so "distance >= safeRange"
//   // is a condition the controller can never reach: kite re-issued a retreat it
//   // had already completed, forever. Same shortfall, same band, as holdIntent.
//   const tolerance = Math.max(ARRIVE_DISTANCE, (Number(ship.radius) || 0) * 0.5);
//   const existing = runtime.style.kite?.targetId === target.id ? runtime.style.kite : null;
//   let side = existing?.side === 1 || existing?.side === -1 ? existing.side : null;
//   let stuckFlipAt = Number(existing?.stuckFlipAt) || 0;
//   if (side === null) {
//     side = orbitDirectionFor(ship, target, range);
//   } else if (orbitProgressStalled(runtime, now, stuckFlipAt)) {
//     side = -side;
//     stuckFlipAt = now;
//   }
// 
//   if (range.distance < safeRange - tolerance) {
//     const retreat = kiteRetreatDestination(room, ship, target, range, safeRange, side);
//     return movementIntent("kite", {
//       destination: retreat.destination,
//       facingMode: "target",
//       facingTargetId: target.id,
//       desiredRange: safeRange,
//       arrivalRequired: true,
//       persistent: true,
//       debugReason: "kite:retreat-too-close",
//       styleMemory: { kite: { targetId: target.id, side: retreat.side, stuckFlipAt } }
//     });
//   }
//   if (range.distance > maximumRange) {
//     const outside = relativeRangeState(ship, target, maximumRange);
//     const approach = clampToPlayableArea(room, ship, outside.destination);
//     return movementIntent("kite", {
//       destination: point(approach.x, approach.y),
//       facingMode: "target",
//       facingTargetId: target.id,
//       desiredRange: safeRange,
//       arrivalRequired: true,
//       persistent: true,
//       debugReason: "kite:approach-outside-weapon-range",
//       styleMemory: { kite: { targetId: target.id, side, stuckFlipAt } }
//     });
//   }
//   return movementIntent("kite", {
//     desiredVelocity: point(target.vx, target.vy),
//     facingMode: "target",
//     facingTargetId: target.id,
//     desiredRange: safeRange,
//     arrivalRequired: true,
//     persistent: true,
//     debugReason: "kite:safe-range-restored",
//     styleMemory: { kite: { targetId: target.id, side, stuckFlipAt } }
//   });
// }
// 
// // The direction a ship is already travelling decides which way round it goes:
// // the tangent it is closer to facing is the one it can take without first
// // throwing the hull through a half turn. A ship pointing straight at (or
// // straight away from) its target has no preference, so it falls back to a
// // stable per-pairing hash rather than picking a side that flips tick to tick.
// function orbitDirectionFor(ship, target, range) {
//   const forwardX = Math.cos(ship.angle || 0);
//   const forwardY = Math.sin(ship.angle || 0);
//   // Tangent for direction +1 is the radial unit rotated a quarter turn CCW.
//   const alignment = forwardX * -range.unitY + forwardY * range.unitX;
//   if (Math.abs(alignment) < 1e-6) {
//     return (hashString(`${ship.id}:${target.id}:orbit`) & 1) ? 1 : -1;
//   }
//   return alignment >= 0 ? 1 : -1;
// }
// 
// // Wedged against a rock the navigator cannot route past, going the other way
// // round is the answer that always exists. Rate-limited so a ship that is merely
// // slow does not sit there reversing.
// function orbitProgressStalled(runtime, now, lastFlipAt) {
//   const navigation = runtime.navigation;
//   if (!navigation?.waypoints?.length || !Number.isFinite(now)) return false;
//   const progressAt = Number(navigation.progressAt) || 0;
//   if (!progressAt || now - progressAt <= NAV_STUCK_TIME_MS) return false;
//   return now - lastFlipAt > NAV_STUCK_TIME_MS * 2;
// }
// 
// // Orbit steers at a point on the circle a fixed angle ahead of the ship rather
// // than at a blend of radial and tangential velocities. Two things fall out of
// // that: the destination always sits on the ring, so a ship too wide or too tight
// // closes on the correct radius with no separate controller, and the intent owns
// // a destination -- which is what lets resolveNavigation plan a path, so the
// // orbit routes around asteroids and rejoins the circle beyond them. Arrival is
// // never required, so none of this passes through arrival braking.
// // The aim point that keeps the ship ON the circle. Steering at a blocked lead
// // point does not stop the ship going there -- the navigator simply routes around
// // the obstacle, and "around" for anything sitting on the ring means outside it.
// // That is the fling: a ship orbiting at 508 px was dragged out past 880, well
// // beyond its own weapon range, before it could rejoin. Slide the aim point
// // further around the circle instead, so the detour is taken along the orbit
// // rather than away from it, and the guns stay on the target throughout.
// function orbitAimPoint(room, ship, target, ringRadius, baseBearing, direction) {
//   const clearance = navigationClearanceRadius(ship);
//   for (let step = 1; step <= ORBIT_LEAD_STEPS; step += 1) {
//     const candidate = ringPoint(
//       target,
//       baseBearing + direction * ORBIT_LEAD_ANGLE * step,
//       ringRadius
//     );
//     if (clampToPlayableArea(room, ship, candidate).clamped) continue;
//     const clear = nearestClearPoint(room, candidate.x, candidate.y, clearance);
//     // `adjusted` means the navigator had to move the point to make it legal, so
//     // the point asked for is inside something. Only an unmodified answer is a
//     // spot on the ring the ship can actually occupy.
//     if (clear.clear && !clear.adjusted) return candidate;
//   }
//   return null;
// }
// 
// function orbitIntent(room, ship, target, maximumRange, stats, runtime, now) {
//   const desiredRange = Math.max(80, maximumRange * ORBIT_RANGE_RATIO);
//   const range = relativeRangeState(ship, target, desiredRange);
//   const existing = runtime.style.orbit?.targetId === target.id
//     ? runtime.style.orbit
//     : null;
//   let direction = existing?.direction === 1 || existing?.direction === -1
//     ? existing.direction
//     : null;
//   let stuckFlipAt = Number(existing?.stuckFlipAt) || 0;
//   if (direction === null) {
//     direction = orbitDirectionFor(ship, target, range);
//   } else if (orbitProgressStalled(runtime, now, stuckFlipAt)) {
//     direction = -direction;
//     stuckFlipAt = now;
//   }
//   const baseBearing = Math.atan2(range.unitY, range.unitX);
//   // Steering at a point on the ring means flying its chords, and a chord runs
//   // inside the circle it joins -- so aiming at exactly desiredRange orbits
//   // measurably tighter than asked. Push the steering ring out by the chord's
//   // sagitta so the circle actually flown is the one requested.
//   const ringRadius = desiredRange / Math.cos(ORBIT_LEAD_ANGLE / 2);
//   let aim = orbitAimPoint(room, ship, target, ringRadius, baseBearing, direction);
//   let reason = "orbit:lead-point";
//   if (!aim) {
//     // The whole arc ahead is blocked -- a station or a large rock is sitting on
//     // it. Going the other way round is the answer that always exists, and it
//     // keeps the ship on the circle and in range. The reversal is committed to
//     // style memory, so the ship sweeps the clear arc rather than re-deciding
//     // into a stutter at the obstacle's edge every tick.
//     const reversed = orbitAimPoint(room, ship, target, ringRadius, baseBearing, -direction);
//     if (reversed) {
//       direction = -direction;
//       aim = reversed;
//       reason = "orbit:reversed-around-obstacle";
//     } else {
//       aim = ringPoint(target, baseBearing + direction * ORBIT_LEAD_ANGLE, ringRadius);
//       reason = "orbit:ring-blocked";
//     }
//   }
//   const maximumSpeed = Math.max(10, Number(stats.maxSpeed) || 0);
//   // v = omega * r. A hull that cannot turn fast enough to stay on the circle at
//   // full throttle would spiral out of it, so cap the throttle at what its
//   // weakest turn direction can actually hold.
//   const turnRate = Math.max(0, Math.min(
//     Number(stats.turnRateLeft ?? stats.turnRate) || 0,
//     Number(stats.turnRateRight ?? stats.turnRate) || 0
//   ));
//   return movementIntent("orbit", {
//     destination: point(aim.x, aim.y),
//     // Feed-forward so a moving target is orbited rather than trailed.
//     desiredVelocity: point(target.vx, target.vy),
//     facingMode: "travel",
//     facingTargetId: target.id,
//     desiredRange,
//     arrivalRequired: false,
//     persistent: true,
//     maxSpeedFactor: clampNumber(turnRate * desiredRange / maximumSpeed, 0.15, 1),
//     debugReason: reason,
//     styleMemory: { orbit: { targetId: target.id, direction, stuckFlipAt } }
//   });
// }
// 
// // Where the target will be by the time the charger gets there. Steering at
// // where it is now trails a moving target instead of intercepting it.
// function chargeInterceptPoint(ship, target, stats, distance) {
//   const closingSpeed = Math.max(10, Number(stats.maxSpeed) || 0);
//   const lead = Math.min(CHARGE_LEAD_MAX_S, distance / closingSpeed);
//   return {
//     x: (target.x || 0) + (Number(target.vx) || 0) * lead,
//     y: (target.y || 0) + (Number(target.vy) || 0) * lead
//   };
// }
// 
// function chargeIntent(room, ship, target, stats) {
//   const demolition = shipHasOperationalDemolitionCharge(ship);
//   // Separation actively holds the pair separationRadius + physicalCollisionRadius
//   // apart. A contact goal computed any tighter than that -- as this did, missing
//   // both the 18 px floor and the 4 px pad movementCollision applies -- sits
//   // inside the distance the solver is pushing the charger back out of, so flight
//   // assist and separation shove against each other and the charge never settles.
//   const contactRange = Math.max(1, separationRadius(ship) + physicalCollisionRadius(target));
//   let destination;
//   if (demolition) {
//     destination = nearestDemolitionTargetPoint(ship, target);
//   } else {
//     const lead = chargeInterceptPoint(
//       ship,
//       target,
//       stats,
//       relativeRangeState(ship, target, contactRange).distance
//     );
//     destination = relativeRangeState(ship, { ...target, ...lead }, contactRange).destination;
//   }
//   const clamped = clampToPlayableArea(room, ship, destination);
//   // Skipping arrival braking is not the same as closing at full throttle.
//   // Separation holds the pair contactRange apart, so a charger that arrives at
//   // maxSpeed is shoved straight back out, re-accelerates, and orbits the contact
//   // point forever -- never "positioned", speed bouncing between nothing and half
//   // its cruise. Taper the throttle over the last stretch instead: the ship still
//   // has no braking phase and never parks short of the hull, it just arrives
//   // slowly enough to stay there.
//   const closing = relativeRangeState(ship, target, contactRange);
//   const taperDistance = Math.max(
//     contactRange,
//     (Number(stats.maxSpeed) || 0) * CHARGE_SETTLE_TIME_S
//   );
//   return movementIntent("charge", {
//     destination: point(clamped.x, clamped.y),
//     facingMode: "travel",
//     facingTargetId: target.id,
//     desiredRange: demolition ? 0 : contactRange,
//     // A charge does not brake. Arrival braking zeroes commanded speed
//     // ARRIVE_DISTANCE short of the goal, which for the stance whose whole
//     // purpose is contact -- and for the demolition charge that needs it -- is
//     // exactly the wrong place to stop. Separation stops the ship on the hull.
//     arrivalRequired: false,
//     persistent: true,
//     maxSpeedFactor: clampNumber(
//       closing.rangeError / taperDistance,
//       CHARGE_MIN_SPEED_FACTOR,
//       1
//     ),
//     debugReason: demolition
//       ? "charge:demolition-contact"
//       : "charge:pursue-to-contact"
//   });
// }
// 
// // Static: the ship fights from wherever it already stands. It never yields a
// // destination, so nothing routes it anywhere; with no goal, rangePositioned
// // settles as soon as it is still, and the positioned branch of
// // resolveDesiredFacing turns it onto its target. Deliberately not a "stop"
// // intent -- that type short-circuits facing to the current angle, which would
// // leave it staring wherever it happened to be pointed.
// function stationIntent(target) {
//   return movementIntent("station", {
//     desiredVelocity: { x: 0, y: 0 },
//     facingMode: "target",
//     facingTargetId: target.id,
//     arrivalRequired: true,
//     persistent: true,
//     debugReason: "static:hold-ground"
//   });
// }
// 
// function repairIntent(ship, target) {
//   const desiredRange = (Number(ship.radius) || 0)
//     + (Number(target.radius) || 0)
//     + REPAIR_STANDOFF_PAD;
//   const range = relativeRangeState(ship, target, desiredRange);
//   return movementIntent("repair", {
//     destination: range.destination,
//     facingMode: "target",
//     facingTargetId: target.id,
//     desiredRange,
//     arrivalRequired: true,
//     persistent: true,
//     debugReason: "repair:standoff"
//   });
// }
// 
// function moveIntent(runtime) {
//   const command = runtime.command;
//   if (!command?.destination) return stopIntent("move:missing-destination");
//   const hasExplicitFinalFacing = Number.isFinite(command.finalFacing);
//   return movementIntent("move", {
//     destination: { ...command.destination },
//     // A plain ground move owns a destination, not a hidden final rotation.
//     // While travelling the hull still follows its course; once parked it keeps
//     // the heading it arrived with unless the player explicitly supplied one.
//     facingMode: hasExplicitFinalFacing ? "final" : "current",
//     finalFacing: command.finalFacing,
//     arrivalRequired: true,
//     persistent: false,
//     debugReason: hasExplicitFinalFacing
//       ? "move:explicit-final-facing"
//       : "move:course-facing"
//   });
// }
// 
// function createMovementIntent(room, ship, stats = ship.stats || {}, now = 0) {
//   const runtime = ensureMovementRuntime(ship);
//   const commandType = runtime.command?.type || null;
//   if (commandType === "repair") {
//     const repairTarget = activeRepairTarget(room, ship, runtime);
//     return repairTarget
//       ? repairIntent(ship, repairTarget)
//       : stopIntent("repair:target-lost");
//   }
// 
//   const combatTarget = activeCombatTarget(room, ship, runtime);
// 
//   // An order the player gave by hand outranks the combat stance. findTarget
//   // re-assigns ship.combatTargetId every combat tick, so without this a stance
//   // reclaimed the helm on the tick after a right click and walked the ship back
//   // to its station. Weapons are untouched -- the ship still shoots whatever it
//   // has acquired, it just goes where it was told. The lock stands until another
//   // command replaces it; right-clicking an enemy issues one.
//   if (runtime.command?.manual && (commandType === "move" || commandType === "stop")) {
//     if (commandType === "stop") return stopIntent("stop:brake");
//     // Once the move is done, hold the ground it was sent to and turn onto the
//     // target rather than keeping the heading it happened to arrive with.
//     if (combatTarget && runtime.phase === "positioned") return stationIntent(combatTarget);
//     return moveIntent(runtime);
//   }
// 
//   // Otherwise a living enemy target owns movement while it exists. Rally moves
//   // and stored Stop commands remain so they can resume if the target becomes
//   // invalid, but they must not suppress the stance after acquisition.
//   if (combatTarget) {
//     const style = sanitizeCombatStyle(ship.combatStyle);
//     const maximumRange = maximumWeaponRange(ship);
//     const demolitionCharge = style === "charge" && shipHasOperationalDemolitionCharge(ship);
//     if (maximumRange <= 0 && !demolitionCharge) {
//       return stopIntent("attack:no-operational-weapons");
//     }
//     switch (style) {
//       case "orbit":
//         return orbitIntent(room, ship, combatTarget, maximumRange, stats, runtime, now);
//       case "kite":
//         return kiteIntent(room, ship, combatTarget, maximumRange, runtime, now);
//       case "charge":
//         return chargeIntent(room, ship, combatTarget, stats);
//       case "static":
//         return stationIntent(combatTarget);
//       case "hold":
//       default:
//         return holdIntent(ship, combatTarget, maximumRange, runtime);
//     }
//   }
// 
//   if (commandType === "move") return moveIntent(runtime);
//   if (commandType === "stop") return stopIntent("stop:brake");
//   return stopIntent(commandType === "attack" ? "attack:target-lost" : "idle");
// }
// 
// function commitIntentStyleMemory(ship, intent) {
//   const patch = intent?.styleMemory;
//   if (!patch) return;
//   const style = ensureMovementRuntime(ship).style;
//   for (const key of [
//     "orbit",
//     "holdPosition",
//     "holdTargetId",
//     "kite"
//   ]) {
//     if (Object.prototype.hasOwnProperty.call(patch, key)) style[key] = patch[key];
//   }
// }
// 
// module.exports = {
//   SUPPORTED_MOVEMENT_TYPES,
//   commitIntentStyleMemory,
//   createMovementIntent,
//   movementIntent
// };

// ======== src/server/movementModern.js ========
// "use strict";
// 
// // Production and tests share this single authoritative movement implementation.
// // It is also the public surface: nothing outside src/server/movement*.js should
// // reach past this file.
// 
// const { clampNumber } = require("./utils");
// const {
//   EDGE_BOUNCE_MARGIN,
//   MAX_MOVEMENT_DT,
//   MOVEMENT_SUBSTEP
// } = require("./movementTuning");
// const {
//   applyCombatStyle,
//   commandShips,
//   commandShipsToAssignedSlots,
//   generateDestinationSlots,
//   rotateShips,
//   stopShips
// } = require("./movementCommands");
// const {
//   SUPPORTED_MOVEMENT_TYPES,
//   commitIntentStyleMemory,
//   createMovementIntent
// } = require("./movementIntents");
// const {
//   applyFlightAssist,
//   applySpeedLimit,
//   buildMovementDecision,
//   computeStoppingDistance,
//   heatAdjustedMovementStats,
//   integratePosition,
//   movementIntentIsFinite,
//   refreshDecisionHeading,
//   resolveDesiredFacing,
//   turnHullToward,
//   updateMovementPhase
// } = require("./movementSteering");
// const {
//   resolveNavigation,
//   nearestClearPoint,
//   segmentCircleClearance
// } = require("./movementNavigation");
// const {
//   applyLocalShipAvoidance,
//   navigationClearanceRadius,
//   physicalCollisionRadius,
//   resolveFleetMapCollisions,
//   resolveMapCollision,
//   resolveSeparationPair,
//   separationRadius,
//   updateShipSeparation
// } = require("./movementCollision");
// const {
//   ensureMovementRuntime,
//   syncMovementTarget
// } = require("./movementRuntime");
// const { bumpMovementMetric } = require("./movementMetrics");
// 
// function normalizeHullAngle(angle) {
//   let normalized = angle % (Math.PI * 2);
//   if (normalized <= -Math.PI) normalized += Math.PI * 2;
//   if (normalized > Math.PI) normalized -= Math.PI * 2;
//   return normalized;
// }
// 
// function sanitizeMovementState(room, ship) {
//   const width = room?.world?.width || 2000;
//   const height = room?.world?.height || 1600;
//   ship.x = clampNumber(ship.x, EDGE_BOUNCE_MARGIN, width - EDGE_BOUNCE_MARGIN);
//   ship.y = clampNumber(ship.y, EDGE_BOUNCE_MARGIN, height - EDGE_BOUNCE_MARGIN);
//   ship.vx = clampNumber(ship.vx, -10000, 10000);
//   ship.vy = clampNumber(ship.vy, -10000, 10000);
//   ship.angle = normalizeHullAngle(Number(ship.angle) || 0);
//   ship.targetX = clampNumber(ship.targetX, 0, width);
//   ship.targetY = clampNumber(ship.targetY, 0, height);
// }
// 
// function initializeKinematics(ship) {
//   if (!Number.isFinite(ship.x)) ship.x = 0;
//   if (!Number.isFinite(ship.y)) ship.y = 0;
//   if (!Number.isFinite(ship.vx)) ship.vx = 0;
//   if (!Number.isFinite(ship.vy)) ship.vy = 0;
//   if (!Number.isFinite(ship.angle)) ship.angle = 0;
//   if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
//   if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
// }
// 
// // One physics substep: decide, steer, thrust, move, resolve contact. The intent
// // and the route are decided once per tick by updateShipMovement and passed in --
// // they are strategy, not physics, and re-running A* per substep bought nothing.
// function integrateMovementStep(room, ship, stats, intent, navigation, dt) {
//   ship.turnActivity = 0;
// 
//   bumpMovementMetric("sharedControllerRuns");
//   const decision = buildMovementDecision(room, ship, stats, intent, navigation);
//   // Avoidance steers by editing the commanded velocity, so the heading it
//   // implies has to be recomputed before anything reads it.
//   applyLocalShipAvoidance(room, ship, decision, stats, ship._simNow);
//   refreshDecisionHeading(ship, decision);
// 
//   bumpMovementMetric("sharedFacingRuns");
//   turnHullToward(ship, resolveDesiredFacing(ship, stats, intent, decision), stats, dt);
// 
//   bumpMovementMetric("sharedPropulsionRuns");
//   applyFlightAssist(ship, stats, decision, dt);
//   applySpeedLimit(ship, stats, decision);
//   integratePosition(room, ship, dt);
// 
//   bumpMovementMetric("sharedCollisionRuns");
//   resolveMapCollision(room, ship);
//   updateMovementPhase(ship, stats, intent, navigation, decision);
//   sanitizeMovementState(room, ship);
// }
// 
// function updateShipMovement(room, ship, dt, now) {
//   initializeKinematics(ship);
//   ensureMovementRuntime(ship);
//   ship._collisionCorrectionX = 0;
//   ship._collisionCorrectionY = 0;
//   ship._integratedMovementX = 0;
//   ship._integratedMovementY = 0;
//   let safeDt = Number(dt);
//   if (!Number.isFinite(safeDt) || safeDt <= 0) return;
//   safeDt = Math.min(safeDt, MAX_MOVEMENT_DT);
//   ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);
// 
//   const stats = heatAdjustedMovementStats(ship, ship.stats || {});
//   bumpMovementMetric("movementCapabilityBuilds");
// 
//   bumpMovementMetric("movementDecisionCount");
//   const intent = createMovementIntent(room, ship, stats, ship._simNow);
//   if (!movementIntentIsFinite(intent)) {
//     throw new Error(`Invalid MovementIntent for ship ${ship.id || "unknown"}`);
//   }
//   commitIntentStyleMemory(ship, intent);
// 
//   bumpMovementMetric("sharedNavigationRuns");
//   const navigation = resolveNavigation(room, ship, intent, ship._simNow);
// 
//   const steps = Math.max(1, Math.round(safeDt / MOVEMENT_SUBSTEP));
//   const stepDt = safeDt / steps;
//   for (let index = 0; index < steps; index += 1) {
//     integrateMovementStep(room, ship, stats, intent, navigation, stepDt);
//   }
//   syncMovementTarget(ship, intent);
// }
// 
// module.exports = {
//   SUPPORTED_MOVEMENT_TYPES,
//   applyCombatStyle,
//   applyLocalShipAvoidance,
//   buildMovementDecision,
//   commandShips,
//   commandShipsToAssignedSlots,
//   computeStoppingDistance,
//   createMovementIntent,
//   generateDestinationSlots,
//   movementIntentIsFinite,
//   navigationClearanceRadius,
//   nearestClearPoint,
//   physicalCollisionRadius,
//   resolveFleetMapCollisions,
//   resolveMapCollision,
//   resolveSeparationPair,
//   rotateShips,
//   segmentCircleClearance,
//   separationRadius,
//   stopShips,
//   updateShipMovement,
//   updateShipSeparation
// };

// // Handles ship velocities, turning, path alignment, separation forces, map collision avoidance, and movement commands.
// 
// const { clampNumber, rotateToward, angleDifference } = require("./utils");
// const { PARTS } = require("./components");
// const { findShipById } = require("./ships");
// const { areEnemies, areAllies, moduleRotationToRadians, moduleLocalPosition } = require("./combat");
// const { normalizeRotation } = require("./shipDesign");
// const { addComponentHeat, componentPerformance } = require("./heat");
// const { selectOwnedLivingShips } = require("./selection");
// const { heatAdjustedMovementStats: modernHeatAdjusted } = require("./movementSteering");
// 
// const WORLD_MARGIN = 42;
// const EDGE_BOUNCE_MARGIN = 43;
// const ARRIVE_DISTANCE = 16;
// const MAX_MOVEMENT_DT = 0.25;
// const MOVEMENT_SUBSTEP = 1 / 30;
// 
// function heatWeightedMovementFactors(ship) {
//   let thrustWeighted = 0, thrustTotal = 0, turnWeighted = 0, turnTotal = 0;
//   for (let i = 0; i < (ship.design || []).length; i += 1) {
//     const part = PARTS[ship.design[i].type];
//     if (!part || (ship.componentHp?.[i] ?? 1) <= 0) continue;
//     const perf = componentPerformance(ship, i);
//     if ((part.thrust || 0) > 0 && (!ship.validEngineIndices || ship.validEngineIndices.has(i))) {
//       thrustWeighted += part.thrust * perf;
//       thrustTotal += part.thrust;
//     }
//     const turn = Math.max(0, part.turn || 0);
//     if (turn > 0 && (!part.thrust || !ship.validEngineIndices || ship.validEngineIndices.has(i))) {
//       turnWeighted += turn * perf;
//       turnTotal += turn;
//     }
//   }
//   const power = ship.thermalPowerFactor ?? 1;
//   return {
//     thrust: thrustTotal ? thrustWeighted / thrustTotal : 0,
//     turn: turnTotal ? turnWeighted / turnTotal : (thrustTotal ? thrustWeighted / thrustTotal : 0),
//     power
//   };
// }
// 
// function heatAdjustedMovementStats(ship, stats) {
//   return modernHeatAdjusted(ship, stats);
// }
// 
// const HOLD_RANGE_RATIO = 0.9;
// const CHARGE_RANGE_RATIO = 0.3;
// const CIRCLE_RANGE_RATIO = 0.8;
// 
// function shipCollisionRadius(ship) {
//   return clampNumber((ship.radius || 0) * 0.56, 18, 48);
// }
// 
// function commandShips(room, player, x, y, options = {}) {
//   const command = selectOwnedLivingShips(player, options.shipIds);
//   if (!command.ok) return { ok: false, code: command.code, commanded: 0 };
// 
//   // Omitted shipIds intentionally preserve the long-standing "all owned live ships" order.
//   // Explicit [] selects no ships; malformed input never falls back to every ship.
//   let ships = command.ships;
//   if (command.explicit && command.ids.size === 0) return { ok: true, code: "empty-selection", commanded: 0 };
// 
//   ships = ships.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
//   if (ships.length === 0) return { ok: true, code: "no-authorized-ships", commanded: 0 };
// 
//   const target = findShipById(room, options.targetId);
//   const focusTargetId = target && target.alive && areEnemies(room, player.id, target.ownerId)
//     ? target.id
//     : null;
//   // Clicking an allied ship directs repair-beam ships to prioritise it. Any
//   // other command clears a previously assigned repair target. Ships without a
//   // repair beam never take an allied target.
//   const repairTargetId = target && target.alive && !focusTargetId && areAllies(room, player.id, target.ownerId)
//     ? target.id
//     : null;
//   const hasRepairBeam = (ship) => (ship.design || []).some((module) => module.type === "repairBeam");
// 
//   const destination = nearestClearPoint(room, x, y, Math.max(42, Math.max(...ships.map((ship) => ship.radius || 0)) * 0.72));
//   const plan = planFormation(room, ships, {
//     x: destination.x,
//     y: destination.y,
//     formation: options.formation || "clump",
//     direction: Number.isFinite(options.direction) ? options.direction : null
//   });
// 
//   for (const slot of plan.slots) {
//     const ship = slot.ship;
//     ship.targetX = slot.x;
//     ship.targetY = slot.y;
//     ship.formationX = slot.offsetX;
//     ship.formationY = slot.offsetY;
//     ship.formationFacing = plan.direction;
// 
//     ship.focusTargetId = focusTargetId;
//     ship.repairTargetId = repairTargetId && hasRepairBeam(ship) ? repairTargetId : null;
//     ship.isManualMove = !focusTargetId;
//     ship.arrived = false;
// 
//     if (focusTargetId && ship.lastOrbitTargetId !== focusTargetId) {
//       ship.orbitDir = undefined;
//       ship.lastOrbitTargetId = null;
//     }
//   }
//   return { ok: true, code: "commanded", commanded: plan.slots.length, plan };
// }
// 
// function stopShips(room, player, shipIds) {
//   const selected = selectOwnedLivingShips(player, shipIds);
//   if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
//   for (const ship of selected.ships) {
//     ship.targetX = ship.x;
//     ship.targetY = ship.y;
//     ship.arrived = true;
//     ship.isManualMove = false;
//     ship.focusTargetId = null;
//     ship.combatTargetId = null;
//     clearOrbitState(ship);
//   }
//   return { ok: true, code: "stop", commanded: selected.ships.length };
// }
// 
// function rotateShips(room, player, options) {
//   const selected = selectOwnedLivingShips(player, options?.shipIds);
//   if (!selected.ok) return { ok: false, code: selected.code, commanded: 0 };
//   return { ok: true, code: "rotate", commanded: selected.ships.length };
// }
// 
// function planFormation(room, ships, options = {}) {
//   const formation = options.formation || "line";
//   const orderedShips = ships.slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
//   const maxRadius = Math.max(0, ...orderedShips.map((ship) => ship.radius || 0));
//   const spacing = clampNumber(62 + maxRadius * 0.75, 58, 132);
//   const destination = nearestClearPoint(room, options.x, options.y, Math.max(42, maxRadius * 0.72));
//   const direction = Number.isFinite(options.direction) ? options.direction : 0;
//   const cos = Math.cos(direction);
//   const sin = Math.sin(direction);
//   const slots = orderedShips.map((ship, index) => {
//     const offset = formationOffset(index, orderedShips.length, Math.max(spacing, (ship.radius || 0) * 1.5), formation);
//     const worldX = destination.x + offset.x * cos - offset.y * sin;
//     const worldY = destination.y + offset.x * sin + offset.y * cos;
//     const clearance = Math.max(42, (ship.radius || 0) * 0.72);
//     const clear = nearestClearPoint(room, worldX, worldY, clearance);
//     return {
//       ship,
//       shipId: ship.id,
//       x: clear.x,
//       y: clear.y,
//       offsetX: offset.x,
//       offsetY: offset.y,
//       clearance,
//       adjusted: clear.adjusted
//     };
//   });
//   return { x: destination.x, y: destination.y, formation, direction, slots, adjustedDestination: destination.adjusted };
// }
// 
// function formationOffset(index, count, spacing, formation) {
//   const center = index - (count - 1) / 2;
// 
//   if (formation === "wedge") {
//     const side = index % 2 === 0 ? -1 : 1;
//     const rank = Math.ceil(index / 2);
//     return {
//       x: -rank * spacing * 0.75,
//       y: side * rank * spacing * 0.62
//     };
//   }
// 
//   if (formation === "clump") {
//     const ring = Math.ceil(Math.sqrt(index + 1));
//     const angle = index * 2.399963;
//     return {
//       x: Math.cos(angle) * ring * spacing * 0.28,
//       y: Math.sin(angle) * ring * spacing * 0.28
//     };
//   }
// 
//   return {
//     x: center * spacing,
//     y: Math.sin(index * 1.7) * spacing * 0.28
//   };
// }
// 
// function updateShipMovement(room, ship, dt) {
//   const safeDt = Number(dt);
//   if (!Number.isFinite(safeDt) || safeDt <= 0) return;
//   const total = Math.min(safeDt, MAX_MOVEMENT_DT);
//   if (total > MOVEMENT_SUBSTEP * 1.01) {
//     let remaining = total;
//     while (remaining > 0) {
//       const step = Math.min(MOVEMENT_SUBSTEP, remaining);
//       updateShipMovementStep(room, ship, step);
//       remaining -= step;
//     }
//     sanitizeMovementState(room, ship);
//     return;
//   }
//   updateShipMovementStep(room, ship, total);
//   sanitizeMovementState(room, ship);
// }
// 
// function updateShipMovementStep(room, ship, dt) {
//   ensureMoveTarget(ship);
// 
//   const stats = heatAdjustedMovementStats(ship, ship.stats || {});
//   const style = getCombatStyle(ship);
//   const target = getActiveCombatTarget(room, ship);
// 
//   if (target) {
//     updateCombatMoveTarget(room, ship, target, style);
//   } else {
//     clearOrbitState(ship);
//   }
// 
//   const dx = ship.targetX - ship.x;
//   const dy = ship.targetY - ship.y;
//   const distance = Math.hypot(dx, dy);
// 
//   if (ship.arrived === undefined) {
//     ship.arrived = distance <= ARRIVE_DISTANCE;
//   }
// 
//   if (ship.isManualMove && !target && distance <= ARRIVE_DISTANCE) {
//     ship.isManualMove = false;
//     ship.arrived = true;
//   }
// 
//   const isCircleOrbit = Boolean(target && style === "circle");
// 
//   if (!ship.arrived || isCircleOrbit) {
//     driveTowardMoveTarget(room, ship, stats, distance, isCircleOrbit, dt);
//   } else {
//     rotateHullForCombat(room, ship, stats, target, dt);
//   }
// 
//   applyDamping(ship, distance, isCircleOrbit, dt);
//   applySpeedLimit(ship, stats);
//   applyPosition(room, ship, dt);
//   regenerateShield(ship, stats, dt);
// 
//   if (ship.arrived && !isCircleOrbit && !target && Number.isFinite(ship.formationFacing)) {
//     ship.angle = ship.formationFacing;
//   }
// }
// 
// function getCombatStyle(ship) {
//   if (ship.combatStyle === "hold") return "hold";
//   if (ship.combatStyle === "sentry") return "sentry";
//   if (ship.combatStyle === "circle") return "circle";
//   if (ship.combatStyle === "charge") return "charge";
//   return "sentry";
// }
// 
// function applyCombatStyle(ship, combatStyle) {
//   ship.combatStyle = combatStyle;
//   clearOrbitState(ship);
// }
// 
// function ensureMoveTarget(ship) {
//   if (!Number.isFinite(ship.x)) ship.x = 0;
//   if (!Number.isFinite(ship.y)) ship.y = 0;
//   if (!Number.isFinite(ship.vx)) ship.vx = 0;
//   if (!Number.isFinite(ship.vy)) ship.vy = 0;
//   if (!Number.isFinite(ship.angle)) ship.angle = 0;
//   if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
//   if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
// }
// 
// function sanitizeMovementState(room, ship) {
//   ensureMoveTarget(ship);
//   ship.x = clampNumber(ship.x, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//   ship.y = clampNumber(ship.y, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
//   ship.targetX = clampNumber(ship.targetX, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//   ship.targetY = clampNumber(ship.targetY, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
// }
// 
// function getActiveCombatTarget(room, ship) {
//   const activeTargetId = ship.focusTargetId || (!ship.isManualMove ? ship.combatTargetId : null);
//   if (!activeTargetId) return null;
// 
//   const target = room.ships.get(activeTargetId);
// 
//   if (!target || !target.alive) {
//     if (ship.focusTargetId === activeTargetId) ship.focusTargetId = null;
//     if (ship.combatTargetId === activeTargetId) ship.combatTargetId = null;
//     clearOrbitState(ship);
//     return null;
//   }
// 
//   return target;
// }
// 
// function updateCombatMoveTarget(room, ship, target, style) {
//   const maxRange = getMaxWeaponRange(ship);
//   const distanceToTarget = Math.hypot(target.x - ship.x, target.y - ship.y);
// 
//   if (style === "sentry") {
//     clearOrbitState(ship);
//     ship.targetX = ship.x;
//     ship.targetY = ship.y;
//     ship.arrived = true;
//     return;
//   }
// 
//   if (maxRange <= 0) {
//     clearOrbitState(ship);
//     ship.targetX = target.x;
//     ship.targetY = target.y;
//     ship.arrived = distanceToTarget <= ARRIVE_DISTANCE;
//     return;
//   }
// 
//   if (style === "circle") {
//     updateCircleMoveTarget(ship, target, maxRange);
//     return;
//   }
// 
//   clearOrbitState(ship);
// 
//   if (style === "hold") {
//     const holdRange = maxRange * HOLD_RANGE_RATIO;
//     const hysteresis = Math.max(18, ship.radius * 0.35);
// 
//     if (distanceToTarget > holdRange + hysteresis) {
//       ship.targetX = target.x;
//       ship.targetY = target.y;
//       ship.arrived = false;
//     } else {
//       ship.targetX = ship.x;
//       ship.targetY = ship.y;
//       ship.arrived = true;
//     }
//     return;
//   }
// 
//   if (style === "charge") {
//     const chargeRange = maxRange * CHARGE_RANGE_RATIO;
//     const hysteresis = Math.max(18, ship.radius * 0.35);
// 
//     if (distanceToTarget > chargeRange + hysteresis) {
//       ship.targetX = target.x;
//       ship.targetY = target.y;
//       ship.arrived = false;
//     } else {
//       ship.targetX = ship.x;
//       ship.targetY = ship.y;
//       ship.arrived = true;
//     }
//   }
// }
// 
// function getMaxWeaponRange(ship) {
//   const stats = ship.stats || {};
// 
//   const rawMaxRange = Math.max(
//     stats.blasterRange || 0,
//     stats.missileRange || 0,
//     stats.railgunRange || 0,
//     stats.beamRange || 0
//   );
// 
//   return rawMaxRange > 0 ? Math.max(120, rawMaxRange) : 0;
// }
// 
// function updateCircleMoveTarget(ship, target, maxRange) {
//   if (ship.lastOrbitTargetId !== target.id) {
//     ship.orbitDir = undefined;
//     ship.lastOrbitTargetId = target.id;
//   }
// 
//   const orbitRadius = Math.max(80, maxRange * CIRCLE_RANGE_RATIO);
//   const angleToShip = Math.atan2(ship.y - target.y, ship.x - target.x);
// 
//   if (ship.orbitDir === undefined) {
//     const forwardX = Math.cos(ship.angle);
//     const forwardY = Math.sin(ship.angle);
//     const dx = ship.x - target.x;
//     const dy = ship.y - target.y;
// 
//     const tangentAlignment = -dy * forwardX + dx * forwardY;
//     ship.orbitDir = tangentAlignment >= 0 ? 1 : -1;
//   }
// 
//   const orbitAngle = angleToShip + 0.42 * ship.orbitDir;
//   const targetX = target.x + Math.cos(orbitAngle) * orbitRadius;
//   const targetY = target.y + Math.sin(orbitAngle) * orbitRadius;
// 
//   if (Number.isFinite(targetX) && Number.isFinite(targetY)) {
//     ship.targetX = targetX;
//     ship.targetY = targetY;
//   }
// 
//   ship.arrived = false;
// }
// 
// function clearOrbitState(ship) {
//   ship.orbitDir = undefined;
//   ship.lastOrbitTargetId = null;
// }
// 
// function driveTowardMoveTarget(room, ship, stats, distance, isCircleOrbit, dt) {
//   if (distance <= ARRIVE_DISTANCE && !isCircleOrbit) {
//     ship.arrived = true;
//     return;
//   }
// 
//   const desired = getDesiredMoveAngle(room, ship);
//   ship.angle = rotateToward(ship.angle, desired, (stats.turnRate || 0) * dt);
// 
//   const alignment = Math.max(0.12, Math.cos(angleDifference(ship.angle, desired)));
//   for (let i = 0; i < (ship.design || []).length; i += 1) {
//     const part = PARTS[ship.design[i].type];
//     if (!part?.thrust || (ship.componentHp?.[i] ?? 1) <= 0) continue;
//     if (ship.validEngineIndices && !ship.validEngineIndices.has(i)) continue;
//     if (componentPerformance(ship, i) > 0) addComponentHeat(ship, i, (2 + part.thrust * 0.018) * dt);
//   }
//   const thrust = (stats.accel || 0) * alignment;
// 
//   ship.vx += Math.cos(ship.angle) * thrust * dt;
//   ship.vy += Math.sin(ship.angle) * thrust * dt;
// }
// 
// function getDesiredMoveAngle(room, ship) {
//   let desired = Math.atan2(ship.targetY - ship.y, ship.targetX - ship.x);
// 
//   const dx = ship.targetX - ship.x;
//   const dy = ship.targetY - ship.y;
//   const targetDistance = Math.hypot(dx, dy);
//   const pathX = targetDistance > 0.001 ? dx / targetDistance : Math.cos(ship.angle);
//   const pathY = targetDistance > 0.001 ? dy / targetDistance : Math.sin(ship.angle);
// 
//   let closestAsteroid = null;
//   let closestDist = Infinity;
// 
//   for (const asteroid of room.map?.asteroids || []) {
//     const avoidRadius = asteroid.radius + ship.radius + 38;
//     const hit = segmentCircleClearance(ship.x, ship.y, ship.targetX, ship.targetY, asteroid.x, asteroid.y, avoidRadius);
//     if (!hit.blocked || hit.along < 0 || hit.along > targetDistance || hit.along >= closestDist) continue;
// 
//     closestDist = hit.along;
//     closestAsteroid = { asteroid, lateralDistance: hit.lateral, avoidRadius };
//   }
// 
//   if (closestAsteroid) {
//     const { asteroid, lateralDistance, avoidRadius } = closestAsteroid;
//     const steerDir = lateralDistance >= 0 ? -1 : 1;
//     const sideX = asteroid.x + (-pathY) * avoidRadius * steerDir;
//     const sideY = asteroid.y + pathX * avoidRadius * steerDir;
//     return Math.atan2(sideY - ship.y, sideX - ship.x);
//   }
// 
//   const speed = Math.hypot(ship.vx || 0, ship.vy || 0);
//   const lookahead = Math.max(120, speed * 0.8 + 60);
//   const forwardX = Math.cos(ship.angle);
//   const forwardY = Math.sin(ship.angle);
// 
//   for (const asteroid of room.map?.asteroids || []) {
//     const ax = asteroid.x - ship.x;
//     const ay = asteroid.y - ship.y;
//     const forwardDistance = ax * forwardX + ay * forwardY;
// 
//     if (forwardDistance < 0 || forwardDistance > lookahead) continue;
// 
//     const lateralDistance = ax * (-forwardY) + ay * forwardX;
//     const avoidRadius = asteroid.radius + ship.radius + 32;
// 
//     if (Math.abs(lateralDistance) < avoidRadius && forwardDistance < closestDist) {
//       closestDist = forwardDistance;
//       closestAsteroid = { asteroid, lateralDistance, avoidRadius };
//     }
//   }
// 
//   if (closestAsteroid) {
//     const { asteroid, lateralDistance, avoidRadius } = closestAsteroid;
//     const steerDir = lateralDistance >= 0 ? -1 : 1;
//     const sideX = asteroid.x + (-forwardY) * avoidRadius * steerDir;
//     const sideY = asteroid.y + forwardX * avoidRadius * steerDir;
//     desired = Math.atan2(sideY - ship.y, sideX - ship.x);
//   }
// 
//   return desired;
// }
// 
// function segmentCircleClearance(x1, y1, x2, y2, cx, cy, radius) {
//   const dx = x2 - x1;
//   const dy = y2 - y1;
//   const len = Math.hypot(dx, dy);
//   if (len < 0.001) {
//     return { blocked: Math.hypot(cx - x1, cy - y1) < radius, along: 0, lateral: 0 };
//   }
//   const ux = dx / len;
//   const uy = dy / len;
//   const relX = cx - x1;
//   const relY = cy - y1;
//   const along = relX * ux + relY * uy;
//   const clampedAlong = clampNumber(along, 0, len);
//   const closestX = x1 + ux * clampedAlong;
//   const closestY = y1 + uy * clampedAlong;
//   const lateral = relX * (-uy) + relY * ux;
//   return { blocked: Math.hypot(cx - closestX, cy - closestY) < radius, along, lateral };
// }
// 
// function rotateHullForCombat(room, ship, stats, target, dt) {
//   let combatTarget = target;
// 
//   if (!combatTarget) {
//     const targetId = ship.focusTargetId || ship.combatTargetId;
//     combatTarget = targetId ? room.ships.get(targetId) : null;
//   }
// 
//   if (!combatTarget || !combatTarget.alive) return;
// 
//   const desired = findOptimalHullAngle(ship, combatTarget);
//   ship.angle = rotateToward(ship.angle, desired, (stats.turnRate || 0) * dt);
// }
// 
// function applyDamping(ship, distance, isCircleOrbit, dt) {
//   let damping = 0.998;
// 
//   if (ship.arrived && !isCircleOrbit) {
//     damping = 0.75;
//   } else if (distance < 85 && !isCircleOrbit) {
//     damping = 0.95;
//   }
// 
//   ship.vx *= Math.pow(damping, dt * 60);
//   ship.vy *= Math.pow(damping, dt * 60);
// }
// 
// function applySpeedLimit(ship, stats) {
//   const maxSpeed = stats.maxSpeed || 0;
//   if (maxSpeed <= 0) {
//     ship.vx = 0;
//     ship.vy = 0;
//     return;
//   }
// 
//   const speed = Math.hypot(ship.vx, ship.vy);
//   if (speed <= maxSpeed) return;
// 
//   const scale = maxSpeed / speed;
//   ship.vx *= scale;
//   ship.vy *= scale;
// }
// 
// function applyPosition(room, ship, dt) {
//   ship.x = clampNumber(ship.x + ship.vx * dt, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//   ship.y = clampNumber(ship.y + ship.vy * dt, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
// 
//   resolveMapCollision(room, ship);
// 
//   if (ship.x <= EDGE_BOUNCE_MARGIN || ship.x >= room.world.width - EDGE_BOUNCE_MARGIN) {
//     ship.vx *= -0.35;
//   }
// 
//   if (ship.y <= EDGE_BOUNCE_MARGIN || ship.y >= room.world.height - EDGE_BOUNCE_MARGIN) {
//     ship.vy *= -0.35;
//   }
// }
// 
// function regenerateShield(ship, stats, dt) {
//   if (ship.maxShield > 0) {
//     const missingShield = Math.max(0, ship.maxShield - ship.shield);
//     let recharge = 0;
//     const heatEntries = [];
//     for (let i = 0; i < (ship.design || []).length; i += 1) {
//       const part = PARTS[ship.design[i].type];
//       if (!part?.shieldRegen || (ship.componentHp?.[i] ?? 1) <= 0) continue;
//       const local = componentPerformance(ship, i);
//       const contribution = part.shieldRegen * local;
//       recharge += contribution;
//       if (contribution > 0) heatEntries.push({ index: i, contribution, baseRegen: part.shieldRegen });
//     }
//     const actualRecharge = Math.min(missingShield, recharge * (ship.thermalPowerFactor ?? 1) * dt);
//     if (actualRecharge > 0 && recharge > 0) {
//       for (const entry of heatEntries) {
//         const componentActual = actualRecharge * (entry.contribution / recharge);
//         addComponentHeat(ship, entry.index, componentActual * 0.7);
//       }
//     }
//     ship.shield = Math.min(ship.maxShield, ship.shield + actualRecharge);
//   }
// }
// 
// function updateShipSeparation(room, ships, dt) {
//   const safeDt = Number.isFinite(Number(dt)) && Number(dt) > 0 ? Math.min(Number(dt), MAX_MOVEMENT_DT) : 0;
//   const ordered = ships.filter((ship) => ship.alive).slice().sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
//   for (let i = 0; i < ordered.length; i += 1) {
//     for (let j = i + 1; j < ordered.length; j += 1) {
//       const a = ordered[i];
//       const b = ordered[j];
// 
//       let dx = b.x - a.x;
//       let dy = b.y - a.y;
//       const distSq = dx * dx + dy * dy;
// 
//       const minimum = shipCollisionRadius(a) + shipCollisionRadius(b);
//       if (distSq >= minimum * minimum) continue;
// 
//       let distance = Math.sqrt(distSq);
//       if (distance < 0.001) {
//         const hash = String(a.id).localeCompare(String(b.id), undefined, { numeric: true }) <= 0 ? 1 : -1;
//         const angle = hash > 0 ? 0 : Math.PI;
//         dx = Math.cos(angle);
//         dy = Math.sin(angle);
//         distance = 1;
//       }
//       const push = (minimum - distance) * 0.5;
// 
//       const nx = dx / distance;
//       const ny = dy / distance;
// 
//       a.x = clampNumber(a.x - nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//       a.y = clampNumber(a.y - ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
//       b.x = clampNumber(b.x + nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//       b.y = clampNumber(b.y + ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
// 
//       const impulse = push * safeDt * 9;
// 
//       a.vx -= nx * impulse;
//       a.vy -= ny * impulse;
//       b.vx += nx * impulse;
//       b.vy += ny * impulse;
//     }
//   }
// }
// 
// function resolveFleetMapCollisions(room, ships) {
//   for (const ship of ships) {
//     resolveMapCollision(room, ship);
//   }
// }
// 
// function resolveMapCollision(room, ship) {
//   const asteroids = room.map?.asteroids || [];
// 
//   for (const asteroid of asteroids) {
//     let dx = ship.x - asteroid.x;
//     let dy = ship.y - asteroid.y;
//     let distance = Math.hypot(dx, dy);
// 
//     if (distance < 0.001) {
//       dx = Math.cos(ship.angle || 0);
//       dy = Math.sin(ship.angle || 0);
//       distance = 1;
//     }
// 
//     const minimum = asteroid.radius + Math.max(24, ship.radius * 0.62);
//     if (distance >= minimum) continue;
// 
//     const nx = dx / distance;
//     const ny = dy / distance;
//     const push = minimum - distance;
// 
//     ship.x = clampNumber(ship.x + nx * push, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//     ship.y = clampNumber(ship.y + ny * push, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
// 
//     const velocityIntoRock = ship.vx * nx + ship.vy * ny;
// 
//     if (velocityIntoRock < 0) {
//       ship.vx -= velocityIntoRock * nx * 1.25;
//       ship.vy -= velocityIntoRock * ny * 1.25;
//     }
// 
//     ship.vx *= 0.82;
//     ship.vy *= 0.82;
//   }
// }
// 
// function nearestClearPoint(room, x, y, clearance) {
//   const startX = Number.isFinite(Number(x)) ? Number(x) : room.world.width * 0.5;
//   const startY = Number.isFinite(Number(y)) ? Number(y) : room.world.height * 0.5;
//   let px = clampNumber(startX, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//   let py = clampNumber(startY, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
//   let adjusted = px !== startX || py !== startY;
//   let passes = 0;
// 
//   const asteroids = room.map?.asteroids || [];
// 
//   for (let pass = 0; pass < 8; pass += 1) {
//     passes = pass + 1;
//     let passAdjusted = false;
// 
//     for (const asteroid of asteroids) {
//       const dx = px - asteroid.x;
//       const dy = py - asteroid.y;
//       const distance = Math.hypot(dx, dy);
//       const minimum = asteroid.radius + clearance;
// 
//       if (distance >= minimum) continue;
// 
//       const angle = distance > 0.001
//         ? Math.atan2(dy, dx)
//         : Math.atan2(py - room.world.height * 0.5, px - room.world.width * 0.5);
// 
//       px = asteroid.x + Math.cos(angle) * minimum;
//       py = asteroid.y + Math.sin(angle) * minimum;
// 
//       px = clampNumber(px, WORLD_MARGIN, room.world.width - WORLD_MARGIN);
//       py = clampNumber(py, WORLD_MARGIN, room.world.height - WORLD_MARGIN);
// 
//       adjusted = true;
//       passAdjusted = true;
//     }
// 
//     if (!passAdjusted) break;
//   }
// 
//   let clear = true;
//   for (const asteroid of asteroids) {
//     if (Math.hypot(px - asteroid.x, py - asteroid.y) < asteroid.radius + clearance - 0.001) {
//       clear = false;
//       break;
//     }
//   }
// 
//   return { x: px, y: py, adjusted, passes, clear, reason: clear ? (adjusted ? "adjusted" : "clear") : "blocked" };
// }
// 
// function findOptimalHullAngle(ship, target) {
//   const angleToTarget = Math.atan2(target.y - ship.y, target.x - ship.x);
// 
//   // Ship designs are immutable after spawn, so the weapon layout is computed once.
//   let weapons = ship.hullAngleWeapons;
//   if (!weapons) {
//     weapons = [];
//     for (const module of ship.design || []) {
//       const part = PARTS[module.type];
//       if (!part?.weapon) continue;
// 
//       weapons.push({
//         local: moduleLocalPosition(module),
//         range: ship.stats[part.weapon.type + "Range"] || part.weapon.range,
//         arcRadians: (part.weapon.arc || 360) * Math.PI / 180,
//         rotationOffset: moduleRotationToRadians(normalizeRotation(module.rotation))
//       });
//     }
//     ship.hullAngleWeapons = weapons;
//   }
// 
//   if (weapons.length === 0) {
//     return angleToTarget;
//   }
// 
//   let bestAngle = angleToTarget;
//   let bestScore = -Infinity;
// 
//   for (let i = 0; i < 24; i += 1) {
//     const candidateAngle = (i * Math.PI) / 12 - Math.PI;
// 
//     let activeWeapons = 0;
//     const cos = Math.cos(candidateAngle);
//     const sin = Math.sin(candidateAngle);
// 
//     for (const weapon of weapons) {
//       const worldX = ship.x + weapon.local.x * cos - weapon.local.y * sin;
//       const worldY = ship.y + weapon.local.x * sin + weapon.local.y * cos;
// 
//       const dx = target.x - worldX;
//       const dy = target.y - worldY;
//       const distance = Math.hypot(dx, dy);
// 
//       if (distance > weapon.range) continue;
// 
//       const targetAngle = Math.atan2(dy, dx);
//       const weaponFacing = candidateAngle + weapon.rotationOffset;
//       const diff = angleDifference(weaponFacing, targetAngle);
// 
//       if (Math.abs(diff) <= weapon.arcRadians / 2) {
//         activeWeapons += 1;
//       }
//     }
// 
//     const rotationPenalty = Math.abs(angleDifference(candidateAngle, ship.angle)) * 0.06;
//     const facingPenalty = Math.abs(angleDifference(candidateAngle, angleToTarget)) * 0.01;
//     const score = activeWeapons - rotationPenalty - facingPenalty;
// 
//     if (score > bestScore) {
//       bestScore = score;
//       bestAngle = candidateAngle;
//     }
//      }
// 
//   return bestAngle;
// }
// 
// module.exports = {
//   applyCombatStyle,
//   commandShips,
//   stopShips,
//   rotateShips,
//   formationOffset,
//   planFormation,
//   updateShipMovement,
//   updateShipSeparation,
//   resolveFleetMapCollisions,
//   resolveMapCollision,
//   nearestClearPoint,
//   segmentCircleClearance
// };

// ======== src/server/movement.js ========
// "use strict";
// 
// const { MODERN_MOVEMENT } = require("../../public/src/shared/featureFlags");
// const modern = require("./movementModern");
// 
// if (MODERN_MOVEMENT) {
//   module.exports = modern;
// } else {
//   const legacy = require("./movementLegacy");
//   // Keep modern-only helpers available while running the legacy core movement.
//   module.exports = Object.assign({}, modern, legacy);
// }
// ======== src/server/movementTuning.js ========
// "use strict";
// 
// // Single home for every movement tunable. Values that used to sit inline in
// // movementController/movementPropulsion/movementBasic/movementCollision live
// // here so the handling of the game can be tuned from one file.
// //
// // Ship performance itself (thrust -> speed/accel/turn curves) is NOT here: that
// // is derived in public/src/shared/movementStats.js, which the client mirrors for
// // blueprint previews. Keep the split -- this file is "how the autopilot flies",
// // that one is "what the hull is capable of".
// 
// module.exports = Object.freeze({
//   // --- World bounds -------------------------------------------------------
//   WORLD_MARGIN: 42,
//   EDGE_BOUNCE_MARGIN: 43,
//   EDGE_RESTITUTION: 0.3,
// 
//   // --- Arrival ------------------------------------------------------------
//   ARRIVE_DISTANCE: 16,
//   // "Close enough to standing still" for combat range-keeping, where a ship
//   // matching its target's velocity counts as on station.
//   ARRIVE_SPEED: 18,
//   // Arriving at a fixed destination is stricter: a ship still doing 18 px/s when
//   // it declares itself arrived spends the next couple of seconds turning to its
//   // final heading, and coasts well past the point while it does.
//   DESTINATION_ARRIVE_SPEED: 4,
//   // How far a parked ship may be nudged off its destination before it bothers
//   // to correct. Wide enough to ignore a separation shove, narrow enough that it
//   // never strands itself short of the point it was sent to.
//   //
//   // This has to be measured against where a ship actually STOPS, not against the
//   // destination: the braking profile reaches zero speed at ARRIVE_DISTANCE, so a
//   // parked ship is already sitting a full ARRIVE_DISTANCE out. At 1.25 that left
//   // 4 px of headroom, so a parked ship sat at 80% of its own tolerance and the
//   // first neighbour to jostle it tipped it out -- whereupon it re-commanded a
//   // crawl at the destination, and its nose followed that crawl. That was the
//   // "turned for no reason on arrival" pirouette. 2.0 leaves a whole
//   // ARRIVE_DISTANCE of slack on top of the stopping shortfall, which absorbs a
//   // separation shove without the ship ever deciding it has been displaced.
//   // A new order resets the phase to "travelling" (see setMovementCommand), so a
//   // wider latch can never suppress a genuine short move.
//   ARRIVE_LATCH_RATIO: 2,
//   FINAL_FACING_TOLERANCE: 0.035,
// 
//   // --- Flight assist ------------------------------------------------------
//   // Velocity decays toward the commanded velocity with this time constant.
//   // Lower = crisper answer to the helm. This is the primary "responsiveness"
//   // knob: at 0.12 a ship covers ~95% of a change of course in a third of a
//   // second, bounded by whatever its engines can actually deliver.
//   VELOCITY_TIME_CONSTANT_S: 0.12,
//   // Speed at or below which a ship asked to hold station is simply parked.
//   REST_SPEED: 0.5,
//   // Commanded speed below which there is no meaningful direction of travel, so
//   // the ship holds its heading rather than chasing a bearing that swings on
//   // every small displacement. Entering and leaving that state use different
//   // speeds: with one threshold, a ship hovering either side of it flips the
//   // source of its facing every tick, and a hull that can turn fast enough
//   // reproduces that flip exactly.
//   FACING_MIN_SPEED: 5,
//   FACING_MIN_SPEED_RELEASE: 3,
//   // How close the goal may get before its bearing stops meaning anything. Speed
//   // alone is not a sufficient test for "under way": an intent that skips arrival
//   // braking -- charge, most of all -- still commands cruise speed while standing
//   // on its goal, so the ship reads as travelling while the point it is steering
//   // at is a couple of pixels away. The bearing to a point that close swings
//   // faster than the hull can follow, and the hull chasing it moves the ship,
//   // which swings the bearing further: a charger parked on its target's hull
//   // rotated a full turn every three and a half seconds without going anywhere.
//   // Entering and leaving use different distances for the same reason the speed
//   // test does -- one threshold makes a ship hovering at the boundary swap the
//   // source of its facing every tick.
//   FACING_MIN_GOAL_DISTANCE: 16,
//   FACING_MIN_GOAL_DISTANCE_RELEASE: 8,
//   // How far the newly computed facing must sit from the one already commanded
//   // before the hull is told about it. Below this the previous command stands.
//   // Without it a fast hull is a 1:1 follower of a signal that jitters with every
//   // separation shove and every branch flip in resolveDesiredFacing.
//   FACING_COMMAND_HYSTERESIS: 0.06,
//   // Fraction of the remaining heading error the hull takes per tick once that
//   // error is small enough to cover in one tick. Above that it is rate-limited as
//   // before, so this only shapes the last few degrees -- the part a fast hull
//   // used to cross in a single snap.
//   TURN_COMMAND_DAMPING: 0.35,
//   // Turn penalty while running on the backup core.
//   BACKUP_CORE_TURN_SCALE: 0.9,
// 
//   // --- Ship avoidance (predictive, pre-collision) ------------------------
//   AVOIDANCE_HORIZON_S: 1.15,
//   AVOIDANCE_HORIZON_SPAWN_S: 1.8,
//   AVOIDANCE_QUERY_MIN_RANGE: 120,
//   AVOIDANCE_CLEARANCE_PAD: 6,
//   AVOIDANCE_CLEARANCE_PAD_SPAWN: 12,
//   // How long a ship commits to dodging left or right. Prevents the pair from
//   // re-deciding every tick and shimmying against each other.
//   AVOIDANCE_SIDE_COMMIT_MS: 700,
//   AVOIDANCE_STRENGTH_YIELD: 1,
//   AVOIDANCE_STRENGTH_EQUAL: 0.65,
//   AVOIDANCE_STRENGTH_RIGHT_OF_WAY: 0.22,
//   AVOIDANCE_BRAKE_TIME_S: 0.45,
//   // Sidestep is a velocity offset, as a fraction of the ship's top speed scaled
//   // by the strengths above, with a floor so near-stationary ships still edge out
//   // of the way. It has to be a real swerve: a token nudge leaves a heavy ship
//   // bulldozing whatever is in front of it rather than going round.
//   //
//   // This sets the ANGLE of the dodge, not its speed: applyLocalShipAvoidance
//   // bounds the amended command by the intent's own throttle, so a ratio of 1
//   // means the lateral term is comparable to the forward one -- a decisive swerve
//   // -- and not, as it used to, a full-throttle broadside dash. Turning it down
//   // was tried and is the wrong lever: it costs a heavy hull the lateral term it
//   // needs to clear a light one, and buys nothing the magnitude bound has not
//   // already bought.
//   AVOIDANCE_MIN_LATERAL: 18,
//   AVOIDANCE_SIDESTEP_RATIO: 1,
//   // How much of the original course a give-way keeps. Giving way used to replace
//   // the commanded velocity with the sidestep outright, which leaves a vector
//   // perpendicular to the goal -- zero closing rate. A ship that gives way has to
//   // still be going somewhere, or it slides sideways until the obstruction leaves,
//   // and in a crowd the obstruction never leaves.
//   AVOIDANCE_YIELD_COURSE_RETENTION: 0.35,
// 
//   // --- Hard collision / separation ---------------------------------------
//   SHIP_MASS_RIGHT_OF_WAY_RATIO: 1.35,
//   SEPARATION_ITERATIONS: 4,
//   SEPARATION_SLOP: 0.2,
//   SEPARATION_CORRECTION: 0.88,
//   SEPARATION_MAX_BIAS_SPEED: 8,
//   SEPARATION_BIAS_SCALE: 0.8,
//   SEPARATION_MIN_IMPULSE_CAP: 20,
//   SEPARATION_IMPULSE_HEADROOM: 12,
//   SEPARATION_BROAD_PHASE_PAD: 192,
//   ASTEROID_RESTITUTION: 1.5,
//   ASTEROID_QUERY_PAD: 128,
//   STOPPED_SPEED: 3,
// 
//   // --- Navigation ---------------------------------------------------------
//   NAV_GRID_CELL_SIZE: 24,
//   NAV_REPLAN_MOVE_THRESHOLD: 60,
//   NAV_REPLAN_COMBAT_THRESHOLD: 120,
//   // A charge aims at a contact point roughly one hull across, so the 120 px
//   // combat threshold is wider than the goal itself -- the charger would chase a
//   // position the target left long ago.
//   NAV_REPLAN_CHARGE_THRESHOLD: 40,
//   NAV_STUCK_TIME_MS: 1500,
//   NAV_WAYPOINT_CAPTURE_RATIO: 0.75,
//   NAV_PROGRESS_EPSILON: 8,
// 
//   // --- Integration --------------------------------------------------------
//   MAX_MOVEMENT_DT: 0.25,
//   MOVEMENT_SUBSTEP: 1 / 30,
// 
//   // --- Combat style stand-off ratios -------------------------------------
//   HOLD_RANGE_RATIO: 0.9,
//   ORBIT_RANGE_RATIO: 0.9,
//   KITE_RANGE_RATIO: 0.9,
// 
//   // --- Combat style shaping ----------------------------------------------
//   // Orbit steers at a point on the circle this far ahead of the ship, measured
//   // as an angle about the target. The ship therefore always flies toward the
//   // ring itself, which corrects the radius without a separate controller.
//   // Larger cuts the corner inward and flies a polygon; smaller tracks the
//   // circle tightly but spends the whole orbit turning.
//   ORBIT_LEAD_ANGLE: 0.45,
//   // How far around the circle the aim point may slide looking for somewhere the
//   // ship can actually be, before orbit gives up on this direction and reverses.
//   // Six steps sweeps ~155 degrees, which clears anything short of an obstacle
//   // that swallows half the ring -- and half the ring is a case where reversing
//   // is the right answer anyway.
//   //
//   // The long slide looks wrong on paper: the ship flies the chord to its aim
//   // point, and a chord subtending 155 degrees passes 0.22r from the centre, so
//   // in principle a blocked near arc is an order to cut across the middle of the
//   // orbit. Capping it was tried and measured worse on both cases that exercise
//   // it. Pulling the aim point back lands it on the obstacle, and the route the
//   // navigator then finds around the obstacle dives further inside the ring than
//   // the chord ever did -- 205 px on a 507 px ring, against 434 px for the long
//   // slide. Against a ring clipped by the world edge, capping forces a reversal
//   // instead, and the hairpin cuts in to 104 px. Leave it long.
//   ORBIT_LEAD_STEPS: 6,
//   // Charge aims where the target will be, not where it is. Capped so a fast
//   // target seen from across the map does not send the charger to empty space.
//   CHARGE_LEAD_MAX_S: 1.5,
//   // A charge deliberately skips arrival braking -- stopping ARRIVE_DISTANCE short
//   // is exactly wrong for the stance whose purpose is contact. But arriving at the
//   // contact ring at full throttle is just as wrong: separation actively holds the
//   // pair apart, so the charger is shoved back out, re-accelerates into the same
//   // wall, and oscillates about the target forever instead of sitting on its hull.
//   // Throttle is tapered over the last CHARGE_SETTLE_TIME_S of closing instead, so
//   // the ship still never stops short -- it just stops slamming.
//   CHARGE_SETTLE_TIME_S: 0.55,
//   // Zero at the contact ring itself. Any floor here is a permanent order to keep
//   // driving into a hull the separation solver is already holding off, which is a
//   // limit cycle by construction: the ship rams, gets pushed out, rams again. A
//   // charger that has arrived should sit on its target and shoot; it picks the
//   // throttle straight back up the moment the target opens the range.
//   CHARGE_MIN_SPEED_FACTOR: 0,
//   REPAIR_STANDOFF_PAD: 30,
// 
//   // --- Component heat from movement --------------------------------------
//   ENGINE_HEAT_BASE: 2,
//   ENGINE_HEAT_PER_THRUST: 0.018,
//   MANEUVER_HEAT_PER_THRUST: 0.018
// });
