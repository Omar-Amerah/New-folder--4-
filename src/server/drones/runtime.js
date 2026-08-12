"use strict";

const { performanceNow } = require("../utils");
const { getComponentPowerMultiplier } = require("../componentPower");
const { bump, recordDuration } = require("../roomTelemetry");
const DroneDecisionContext = require("../droneDecisionContext");
const { CONFIG, effectiveDroneConfig } = require("./settings");
const {
  droneBayById,
  buildBayFrameState,
  bayPoseFromFrame,
  isInOwnSpawnZone
} = require("./production");
const {
  markDroneDecisionInvalidated,
  clearDroneTarget,
  resolveCachedDroneTarget,
  droneContextMembers,
  chooseTarget,
  chooseFallbackTarget,
  rememberDroneTarget
} = require("./targeting");
const { steerDrone } = require("./movement");
const { fighterProjectileEvasion, steerFighterDrone } = require("./evasion");
const { setDroneDestroyed, removeActiveDrone } = require("./lifecycle");
const { performDroneAction } = require("./combat");

function updateDroneEntity(room, drone, dt, now, bayState = null, members = []) {
  const parent = room.ships.get(drone.parentShipId);
  const effective = effectiveDroneConfig(parent, drone);
  const config = effective.config;
  const runtimeConfig = effective.runtime;
  bump(room, "dronePhysicalUpdates");

  if (!parent?.alive) {
    drone.orphanedAt ||= now;
    drone.state = "orphaned";
    const movementStart = performanceNow();
    drone.vx *= Math.max(0, 1 - dt * 0.8);
    drone.vy *= Math.max(0, 1 - dt * 0.8);
    drone.x += drone.vx * dt;
    drone.y += drone.vy * dt;
    recordDuration(room, "droneMovementMs", movementStart);
    if (now - drone.orphanedAt >= CONFIG.orphanLifetimeSeconds * 1000) setDroneDestroyed(room, drone, now, "orphaned");
    return;
  }

  const bay = droneBayById(parent, drone.bayComponentId);
  const state = bayState || (bay ? buildBayFrameState(room, parent, bay, room._droneFrameId || 0, now, isInOwnSpawnZone(room, parent)) : null);
  if (state?.inSpawnZone || (!state && isInOwnSpawnZone(room, parent))) {
    setDroneDestroyed(room, drone, now, "spawn-zone");
    return;
  }

  const bayOperational = state ? state.operational : Boolean(bay && (parent.componentHp?.[bay.componentIndex] ?? 0) > 0);
  const bayPower = state ? state.powerMultiplier : (bayOperational && getComponentPowerMultiplier(parent, bay.componentIndex));
  const bayPowered = bayOperational && bayPower > 0;
  const fallback = !bayOperational || !bayPowered;
  const previousCommandState = drone.commandState;
  const previousBayRevision = drone._lastBayRevision;
  if (state?.revision !== undefined) drone._lastBayRevision = state.revision;
  if (previousBayRevision !== undefined && state?.revision !== previousBayRevision) markDroneDecisionInvalidated(room, drone, "bay-revision");
  if (drone._lastParentCommandState !== undefined && drone._lastParentCommandState !== parent.commandState) markDroneDecisionInvalidated(room, drone, "parent-command");
  drone._lastParentCommandState = parent.commandState;

  const enteredFallback = fallback && previousCommandState !== "fallback";
  drone.commandState = fallback ? "fallback" : bay?.mode;
  if (fallback) {
    drone.state = "fallback";
    if (enteredFallback) {
      clearDroneTarget(room, drone, true);
      drone.nextDecisionAt = now;
      drone.nextThinkAt = now;
    }
  } else if (drone.state === "fallback") {
    drone.state = "active";
    markDroneDecisionInvalidated(room, drone, "power-restored");
  }

  if (drone.state === "launching" && now >= drone.stateUntil) {
    drone.state = "active";
    const slot = bay?.slots?.[drone.slot];
    if (slot) slot.state = "active";
  }
  const pose = bayPoseFromFrame(state, parent);
  if (bayOperational && bay.mode === "recalled") {
    if (drone.commandState !== "recalled") markDroneDecisionInvalidated(room, drone, "recall");
    drone.state = "returning";
    drone.returnReason = "recall";
    clearDroneTarget(room, drone, false);
  } else if (bayOperational && bay.mode === "deployed" && ["returning", "docking"].includes(drone.state) && drone.returnReason !== "fuel") {
    drone.state = bayPowered ? "active" : "fallback";
    const returningSlot = bay.slots[drone.slot];
    if (returningSlot) returningSlot.state = drone.state;
    markDroneDecisionInvalidated(room, drone, "deploy");
  }

  if (drone.state === "refueling") {
    drone.x = pose.x;
    drone.y = pose.y;
    drone.vx = 0;
    drone.vy = 0;
    if (now >= drone.refuelUntil) {
      drone.state = "launching";
      drone.returnReason = null;
      drone.refuelStartedAt = null;
      drone.refuelUntil = null;
      drone.fuelRemainingSeconds = runtimeConfig.fuelCapacitySeconds;
      drone.launchedAt = now;
      drone.stateUntil = now + CONFIG.launchDurationSeconds * 1000;
      drone.vx = pose.nx * config.speed * 0.35;
      drone.vy = pose.ny * config.speed * 0.35;
      drone.angle = Math.atan2(pose.ny, pose.nx);
      const refueledSlot = bay?.slots?.[drone.slot];
      if (refueledSlot) refueledSlot.state = "launching";
      room.effects.push({ type: "dronelaunch", subtype: drone.type, ownerId: drone.ownerId, x: drone.x, y: drone.y, at: now });
      markDroneDecisionInvalidated(room, drone, "refueled");
    }
    return;
  }

  if (!["returning", "docking"].includes(drone.state)) {
    if (!Number.isFinite(drone.fuelRemainingSeconds)) drone.fuelRemainingSeconds = runtimeConfig.fuelCapacitySeconds;
    drone.fuelRemainingSeconds = Math.max(0, drone.fuelRemainingSeconds - dt);
    if (drone.fuelRemainingSeconds <= 0) {
      drone.state = "returning";
      drone.returnReason = "fuel";
      clearDroneTarget(room, drone, true);
      const fuelSlot = bay?.slots?.[drone.slot];
      if (fuelSlot) fuelSlot.state = "returning";
    }
  }
  if (drone.state === "returning" || drone.state === "docking") {
    const movementStart = performanceNow();
    steerDrone(drone, pose.x, pose.y, config.speed, config.turnRate, dt);
    recordDuration(room, "droneMovementMs", movementStart);
    const dockDx = drone.x - pose.x;
    const dockDy = drone.y - pose.y;
    const dockDistanceSq = dockDx * dockDx + dockDy * dockDy;
    if (dockDistanceSq < 30 * 30) {
      drone.state = "docking";
      const dockingSlot = bay?.slots?.[drone.slot];
      if (dockingSlot) dockingSlot.state = "docking";
    }
    if (dockDistanceSq < 12 * 12) {
      const slot = bay?.slots?.[drone.slot];
      if (slot && drone.returnReason === "fuel" && bay.mode === "deployed") {
        drone.state = "refueling";
        drone.refuelStartedAt = now;
        drone.refuelUntil = now + CONFIG.refuelSeconds * 1000;
        drone.x = pose.x;
        drone.y = pose.y;
        drone.vx = 0;
        drone.vy = 0;
        slot.state = "refueling";
      } else if (slot) {
        removeActiveDrone(room, drone);
        slot.droneId = null;
        slot.state = "stored";
      }
    }
    return;
  }

  const validationStart = performanceNow();
  const focusTargetId = parent.focusTargetId || null;
  if (drone.type === "fighter" && drone._lastFocusTargetId !== undefined && drone._lastFocusTargetId !== focusTargetId) {
    markDroneDecisionInvalidated(room, drone, "focus-change");
  }
  let target = resolveCachedDroneTarget(room, drone, now);
  const parentDx = drone.x - parent.x;
  const parentDy = drone.y - parent.y;
  const outsideCommandRange = parentDx * parentDx + parentDy * parentDy > runtimeConfig.commandRangeSquared;
  if (target && outsideCommandRange) {
    clearDroneTarget(room, drone, true);
    target = null;
  } else if (outsideCommandRange) {
    markDroneDecisionInvalidated(room, drone, "command-range");
  }
  recordDuration(room, "droneTargetValidationMs", validationStart);

  if (!drone._cadenceInitialized) {
    drone._cadenceInitialized = true;
    if (!Number.isFinite(drone.nextDecisionAt)) drone.nextDecisionAt = now + runtimeConfig.decisionStaggerMs;
    drone.nextThinkAt = drone.nextDecisionAt;
  }
  const nextDecisionAt = Number.isFinite(drone.nextDecisionAt) ? drone.nextDecisionAt : now;
  const shouldDecide = Boolean(drone.decisionInvalidated) || now >= nextDecisionAt;
  let context = null;
  if (shouldDecide) {
    const decisionStart = performanceNow();
    const immediate = Boolean(drone.decisionInvalidated);
    const memberList = members.length ? members : droneContextMembers(room, parent, bay, drone.type);
    context = DroneDecisionContext.buildDroneDecisionContext(
      room,
      parent,
      bay,
      drone.type,
      runtimeConfig,
      memberList,
      now,
      room._droneFrameId || room._simulationStep || now,
      state?.revision
    );
    const decisionRange = Math.max(
      Number(config.commandRange) || 0,
      Number(config.weaponRange) || 0,
      runtimeConfig.supportsEvasion
        ? ((room.spatialIndex?.maxProjectileSpeed || 0) + (Number(config.speed) || 0)) * runtimeConfig.evasionLookaheadSeconds + runtimeConfig.evasionClearance
        : 0
    );
    const contextPoint = drone.type === "repair" ? parent : drone;
    if (context && !DroneDecisionContext.contextCoversPoint(context, contextPoint.x, contextPoint.y, decisionRange)) {
      DroneDecisionContext.markContextFallback(room, context);
      context = null;
    }
    const scoringStart = performanceNow();
    const selectedTarget = outsideCommandRange
      ? null
      : fallback
        ? chooseFallbackTarget(room, drone, parent, config, now, context)
        : chooseTarget(room, drone, parent, config, now, context);
    recordDuration(room, "droneTargetScoringMs", scoringStart);
    rememberDroneTarget(room, drone, selectedTarget);
    drone._lastFocusTargetId = focusTargetId;
    const evasionStart = performanceNow();
    drone.cachedEvasion = runtimeConfig.supportsEvasion
      ? fighterProjectileEvasion(room, drone, config, context)
      : null;
    recordDuration(room, "droneEvasionMs", evasionStart);
    drone.nextDecisionAt = now + runtimeConfig.decisionIntervalMs;
    drone.nextThinkAt = drone.nextDecisionAt;
    drone.decisionInvalidated = false;
    bump(room, "droneDecisionsRun");
    if (immediate) bump(room, "droneImmediateDecisions");
    recordDuration(room, "droneDecisionMs", decisionStart);
    target = resolveCachedDroneTarget(room, drone, now);
  } else {
    bump(room, "droneDecisionsDeferred");
  }

  const effectiveTarget = target;
  const anchor = effectiveTarget || parent;
  const orbit = runtimeConfig.orbitDistance || 80;
  const phase = runtimeConfig.stableOrbitPhase + now * 0.00055;
  const pathX = anchor.x + Math.cos(phase) * orbit;
  const pathY = anchor.y + Math.sin(phase) * orbit;
  const movementStart = performanceNow();
  if (runtimeConfig.supportsEvasion) steerFighterDrone(room, drone, pathX, pathY, config, dt, now, drone.cachedEvasion || null);
  else steerDrone(drone, pathX, pathY, config.speed, config.turnRate, dt);
  recordDuration(room, "droneMovementMs", movementStart);

  performDroneAction(room, drone, effectiveTarget, config, runtimeConfig, now);
}

module.exports = { updateDroneEntity };
