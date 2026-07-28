"use strict";

// Production and tests share this single authoritative movement implementation.
// It is also the public surface: nothing outside src/server/movement*.js should
// reach past this file.

const { clampNumber } = require("./utils");
const {
  EDGE_BOUNCE_MARGIN,
  MAX_MOVEMENT_DT,
  MOVEMENT_SUBSTEP
} = require("./movementTuning");
const {
  applyCombatStyle,
  commandShips,
  commandShipsToAssignedSlots,
  generateDestinationSlots,
  rotateShips,
  stopShips
} = require("./movementCommands");
const {
  SUPPORTED_MOVEMENT_TYPES,
  commitIntentStyleMemory,
  createMovementIntent
} = require("./movementIntents");
const {
  applyFlightAssist,
  applySpeedLimit,
  buildMovementDecision,
  computeStoppingDistance,
  heatAdjustedMovementStats,
  integratePosition,
  movementIntentIsFinite,
  refreshDecisionHeading,
  resolveDesiredFacing,
  turnHullToward,
  updateMovementPhase
} = require("./movementSteering");
const {
  resolveNavigation,
  nearestClearPoint,
  segmentCircleClearance
} = require("./movementNavigation");
const {
  applyLocalShipAvoidance,
  navigationClearanceRadius,
  physicalCollisionRadius,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  separationRadius,
  updateShipSeparation
} = require("./movementCollision");
const {
  ensureMovementRuntime,
  syncMovementTarget
} = require("./movementRuntime");
const { bumpMovementMetric } = require("./movementMetrics");

function normalizeHullAngle(angle) {
  let normalized = angle % (Math.PI * 2);
  if (normalized <= -Math.PI) normalized += Math.PI * 2;
  if (normalized > Math.PI) normalized -= Math.PI * 2;
  return normalized;
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

function initializeKinematics(ship) {
  if (!Number.isFinite(ship.x)) ship.x = 0;
  if (!Number.isFinite(ship.y)) ship.y = 0;
  if (!Number.isFinite(ship.vx)) ship.vx = 0;
  if (!Number.isFinite(ship.vy)) ship.vy = 0;
  if (!Number.isFinite(ship.angle)) ship.angle = 0;
  if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
  if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
}

// One physics substep: decide, steer, thrust, move, resolve contact. The intent
// and the route are decided once per tick by updateShipMovement and passed in --
// they are strategy, not physics, and re-running A* per substep bought nothing.
function integrateMovementStep(room, ship, stats, intent, navigation, dt) {
  ship.turnActivity = 0;

  bumpMovementMetric("sharedControllerRuns");
  const decision = buildMovementDecision(room, ship, stats, intent, navigation);
  // Avoidance steers by editing the commanded velocity, so the heading it
  // implies has to be recomputed before anything reads it.
  applyLocalShipAvoidance(room, ship, decision, stats, ship._simNow);
  refreshDecisionHeading(ship, decision);

  bumpMovementMetric("sharedFacingRuns");
  turnHullToward(ship, resolveDesiredFacing(ship, stats, intent, decision), stats, dt);

  bumpMovementMetric("sharedPropulsionRuns");
  applyFlightAssist(ship, stats, decision, dt);
  applySpeedLimit(ship, stats, decision);
  integratePosition(room, ship, dt);

  bumpMovementMetric("sharedCollisionRuns");
  resolveMapCollision(room, ship);
  updateMovementPhase(ship, stats, intent, navigation, decision);
  sanitizeMovementState(room, ship);
}

function updateShipMovement(room, ship, dt, now) {
  initializeKinematics(ship);
  ensureMovementRuntime(ship);
  ship._collisionCorrectionX = 0;
  ship._collisionCorrectionY = 0;
  ship._integratedMovementX = 0;
  ship._integratedMovementY = 0;
  let safeDt = Number(dt);
  if (!Number.isFinite(safeDt) || safeDt <= 0) return;
  safeDt = Math.min(safeDt, MAX_MOVEMENT_DT);
  ship._simNow = Number.isFinite(Number(now)) ? Number(now) : (ship._simNow || 0);

  const stats = heatAdjustedMovementStats(ship, ship.stats || {});
  bumpMovementMetric("movementCapabilityBuilds");

  bumpMovementMetric("movementDecisionCount");
  const intent = createMovementIntent(room, ship, stats, ship._simNow);
  if (!movementIntentIsFinite(intent)) {
    throw new Error(`Invalid MovementIntent for ship ${ship.id || "unknown"}`);
  }
  commitIntentStyleMemory(ship, intent);

  bumpMovementMetric("sharedNavigationRuns");
  const navigation = resolveNavigation(room, ship, intent, ship._simNow);

  const steps = Math.max(1, Math.round(safeDt / MOVEMENT_SUBSTEP));
  const stepDt = safeDt / steps;
  for (let index = 0; index < steps; index += 1) {
    integrateMovementStep(room, ship, stats, intent, navigation, stepDt);
  }
  syncMovementTarget(ship, intent);
}

module.exports = {
  SUPPORTED_MOVEMENT_TYPES,
  applyCombatStyle,
  applyLocalShipAvoidance,
  buildMovementDecision,
  commandShips,
  commandShipsToAssignedSlots,
  computeStoppingDistance,
  createMovementIntent,
  generateDestinationSlots,
  movementIntentIsFinite,
  navigationClearanceRadius,
  nearestClearPoint,
  physicalCollisionRadius,
  resolveFleetMapCollisions,
  resolveMapCollision,
  resolveSeparationPair,
  rotateShips,
  segmentCircleClearance,
  separationRadius,
  stopShips,
  updateShipMovement,
  updateShipSeparation
};
