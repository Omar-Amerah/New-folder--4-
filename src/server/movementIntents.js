"use strict";

const { clampNumber, fastHypot, hashString } = require("./utils");
const {
  nearestDemolitionTargetPoint,
  shipHasOperationalDemolitionCharge
} = require("./combat");
const { getEffectiveWeaponRanges } = require("./componentData");
const { sanitizeCombatStyle } = require("./validation");
const { BALANCE } = require("./balanceConfig");
const {
  ARRIVE_DISTANCE,
  ARRIVE_SPEED,
  BRAWLER_RANGE_RATIO,
  EVASIVE_RANGE_RATIO,
  HEAVY_RANGE_RATIO,
  HOLD_RANGE_RATIO,
  INTERCEPTOR_RANGE_RATIO,
  KITE_RANGE_RATIO,
  KITE_TOLERANCE,
  MAINTAIN_RANGE_RATIO,
  MAINTAIN_TOLERANCE,
  ORBIT_RANGE_RATIO,
  BRAWLER_TOLERANCE,
  HEAVY_TOLERANCE,
  RANGE_BAND_RADIAL_SPEED,
  ORBIT_TANGENTIAL_SPEED_RATIO,
  ORBIT_TANGENTIAL_ACCEL_SCALE,
  ORBIT_RADIAL_RANGE_GAIN,
  ORBIT_RADIAL_DAMPING_GAIN,
  ORBIT_MIN_RADIAL_LIMIT,
  DIRECT_LEAD_SCALE,
  DIRECT_MAX_LEAD_S,
  INTERCEPTOR_MAX_LEAD_S,
  EVASIVE_LATERAL_SPEED_RATIO,
  EVASIVE_MIN_LATERAL_SPEED,
  REPAIR_STANDOFF_PAD
} = require("./movementTuning");
const { ensureMovementRuntime } = require("./movementRuntime");

const SUPPORTED_MOVEMENT_TYPES = Object.freeze([
  "move",
  "hold",
  "maintain",
  "kite",
  "orbit",
  "direct",
  "sentry",
  "charge",
  "interceptor",
  "evasive",
  "brawler",
  "heavy",
  "repair",
  "stop"
]);

function point(x, y) {
  return { x: Number(x) || 0, y: Number(y) || 0 };
}

function movementIntent(type, values = {}) {
  return {
    type,
    destination: values.destination || null,
    desiredVelocity: values.desiredVelocity || null,
    facingMode: values.facingMode || "current",
    facingTargetId: values.facingTargetId || null,
    finalFacing: Number.isFinite(values.finalFacing) ? values.finalFacing : null,
    desiredRange: Number.isFinite(values.desiredRange) ? values.desiredRange : null,
    arrivalRequired: Boolean(values.arrivalRequired),
    persistent: Boolean(values.persistent),
    debugReason: String(values.debugReason || type),
    maxSpeedFactor: Number.isFinite(values.maxSpeedFactor) ? values.maxSpeedFactor : 1,
    styleMemory: values.styleMemory || null
  };
}

function stopIntent(reason = "no-command") {
  return movementIntent("stop", {
    desiredVelocity: { x: 0, y: 0 },
    facingMode: "current",
    arrivalRequired: true,
    persistent: false,
    debugReason: reason
  });
}

function activeTarget(room, ship, runtime) {
  const targetId = ship.repairTargetId
    || ship.focusTargetId
    || ship.combatTargetId
    || runtime.command?.targetId;
  const target = targetId && room.ships?.get(String(targetId));
  return target?.alive ? target : null;
}

function maximumWeaponRange(ship) {
  const ranges = getEffectiveWeaponRanges(ship);
  return Math.max(
    0,
    Number(ranges.blaster) || 0,
    Number(ranges.missile) || 0,
    Number(ranges.railgun) || 0,
    Number(ranges.beam) || 0
  );
}

function relativeRangeState(ship, target, desiredRange) {
  const dx = (ship.x || 0) - (target.x || 0);
  const dy = (ship.y || 0) - (target.y || 0);
  const distance = fastHypot(dx, dy) || 1;
  const unitX = dx / distance;
  const unitY = dy / distance;
  const relativeVx = (ship.vx || 0) - (target.vx || 0);
  const relativeVy = (ship.vy || 0) - (target.vy || 0);
  return {
    distance,
    unitX,
    unitY,
    rangeError: distance - desiredRange,
    radialVelocity: relativeVx * unitX + relativeVy * unitY,
    destination: {
      x: (target.x || 0) + unitX * desiredRange,
      y: (target.y || 0) + unitY * desiredRange
    }
  };
}

function rangeIntent(type, ship, target, desiredRange, toleranceRatio, reason) {
  const range = relativeRangeState(ship, target, desiredRange);
  const tolerance = Math.max(6, desiredRange * toleranceRatio);
  const insideBand = Math.abs(range.rangeError) <= tolerance
    && Math.abs(range.radialVelocity) <= RANGE_BAND_RADIAL_SPEED;
  if (insideBand) {
    return movementIntent(type, {
      desiredVelocity: point(target.vx, target.vy),
      facingMode: "target",
      facingTargetId: target.id,
      desiredRange,
      arrivalRequired: true,
      persistent: true,
      debugReason: `${reason}:range-band`
    });
  }
  return movementIntent(type, {
    destination: range.destination,
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: range.rangeError > 0 ? `${reason}:approach` : `${reason}:retreat`
  });
}

function holdIntent(ship, target, maximumRange, runtime) {
  const desiredRange = Math.max(80, maximumRange * HOLD_RANGE_RATIO);
  if (runtime.style.holdPosition && runtime.style.holdTargetId === target.id) {
    return movementIntent("hold", {
      destination: { ...runtime.style.holdPosition },
      facingMode: "target",
      facingTargetId: target.id,
      desiredRange,
      arrivalRequired: true,
      persistent: true,
      debugReason: "hold:stored-position"
    });
  }
  const range = relativeRangeState(ship, target, desiredRange);
  const margin = Math.max(ARRIVE_DISTANCE, (Number(ship.radius) || 0) * 0.5);
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (Math.abs(range.rangeError) <= margin && speed < ARRIVE_SPEED) {
    const holdPosition = point(ship.x, ship.y);
    return movementIntent("hold", {
      destination: holdPosition,
      facingMode: "target",
      facingTargetId: target.id,
      desiredRange,
      arrivalRequired: true,
      persistent: true,
      debugReason: "hold:position-committed",
      styleMemory: { holdPosition, holdTargetId: target.id }
    });
  }
  return movementIntent("hold", {
    destination: range.destination,
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "hold:positioning",
    styleMemory: { holdPosition: null, holdTargetId: target.id }
  });
}

function orbitIntent(ship, target, maximumRange, stats, runtime) {
  const desiredRange = Math.max(80, maximumRange * ORBIT_RANGE_RATIO);
  const range = relativeRangeState(ship, target, desiredRange);
  const existing = runtime.style.orbit;
  let direction = existing?.targetId === target.id ? existing.direction : null;
  if (direction !== 1 && direction !== -1) {
    const forwardX = Math.cos(ship.angle || 0);
    const forwardY = Math.sin(ship.angle || 0);
    const tangent = -range.unitX * forwardY + range.unitY * forwardX;
    direction = Math.abs(tangent) > 1e-6
      ? (tangent >= 0 ? 1 : -1)
      : ((hashString(`${ship.id}:${target.id}:orbit`) & 1) ? 1 : -1);
  }
  const maximumSpeed = Math.max(10, Number(stats.maxSpeed) || 0);
  const orbitAcceleration = Math.max(1, Number(stats.accel) || 0);
  const tangentialSpeed = Math.min(
    maximumSpeed * ORBIT_TANGENTIAL_SPEED_RATIO,
    Math.sqrt(orbitAcceleration * desiredRange * ORBIT_TANGENTIAL_ACCEL_SCALE)
  );
  const radialLimit = Math.max(ORBIT_MIN_RADIAL_LIMIT, tangentialSpeed * 2);
  const radialSpeed = clampNumber(
    -range.rangeError * ORBIT_RADIAL_RANGE_GAIN
      - range.radialVelocity * ORBIT_RADIAL_DAMPING_GAIN,
    -radialLimit,
    radialLimit
  );
  const tangentX = -range.unitY * direction;
  const tangentY = range.unitX * direction;
  return movementIntent("orbit", {
    desiredVelocity: {
      x: (target.vx || 0) + range.unitX * radialSpeed + tangentX * tangentialSpeed,
      y: (target.vy || 0) + range.unitY * radialSpeed + tangentY * tangentialSpeed
    },
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: false,
    persistent: true,
    debugReason: "orbit:radial-plus-tangential",
    styleMemory: { orbit: { targetId: target.id, direction } }
  });
}

function directIntent(ship, target, stats) {
  const distance = fastHypot((target.x || 0) - (ship.x || 0), (target.y || 0) - (ship.y || 0));
  const leadSeconds = clampNumber(
    distance / Math.max(1, Number(stats.maxSpeed) || 1) * DIRECT_LEAD_SCALE,
    0,
    DIRECT_MAX_LEAD_S
  );
  return movementIntent("direct", {
    destination: {
      x: (target.x || 0) + (target.vx || 0) * leadSeconds,
      y: (target.y || 0) + (target.vy || 0) * leadSeconds
    },
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange: 0,
    arrivalRequired: false,
    persistent: true,
    debugReason: "direct:predicted-target"
  });
}

function sentryIntent(ship, target, runtime) {
  const sentryPosition = runtime.style.sentryPosition || point(ship.x, ship.y);
  return movementIntent("sentry", {
    destination: { ...sentryPosition },
    facingMode: "target",
    facingTargetId: target.id,
    arrivalRequired: true,
    persistent: true,
    debugReason: runtime.style.sentryPosition ? "sentry:return" : "sentry:position-committed",
    styleMemory: runtime.style.sentryPosition ? null : { sentryPosition }
  });
}

function chargeIntent(ship, target) {
  const destination = shipHasOperationalDemolitionCharge(ship)
    ? nearestDemolitionTargetPoint(ship, target)
    : target;
  return movementIntent("charge", {
    destination: point(destination.x, destination.y),
    facingMode: "travel",
    facingTargetId: target.id,
    desiredRange: 0,
    arrivalRequired: false,
    persistent: true,
    maxSpeedFactor: 1,
    debugReason: shipHasOperationalDemolitionCharge(ship)
      ? "charge:demolition-contact"
      : "charge:hostile-position"
  });
}

function interceptorIntent(
  ship,
  target,
  maximumRange,
  stats,
  desiredRangeRatio = INTERCEPTOR_RANGE_RATIO
) {
  const desiredRange = Math.max(40, maximumRange * desiredRangeRatio);
  const distance = fastHypot((target.x || 0) - (ship.x || 0), (target.y || 0) - (ship.y || 0));
  const leadSeconds = clampNumber(
    distance / Math.max(1, Number(stats.maxSpeed) || 1),
    0,
    INTERCEPTOR_MAX_LEAD_S
  );
  const predictedTarget = {
    x: (target.x || 0) + (target.vx || 0) * leadSeconds,
    y: (target.y || 0) + (target.vy || 0) * leadSeconds,
    vx: target.vx || 0,
    vy: target.vy || 0
  };
  const range = relativeRangeState(ship, predictedTarget, desiredRange);
  return movementIntent("interceptor", {
    destination: range.destination,
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "interceptor:predicted-intercept"
  });
}

function evasiveIntent(ship, target, maximumRange, stats, runtime, now) {
  const styleConfig = BALANCE.movement?.movementStyles?.evasive || {};
  const desiredRange = Math.max(
    80,
    maximumRange * (styleConfig.desiredRangeRatio ?? EVASIVE_RANGE_RATIO)
  );
  const range = relativeRangeState(ship, target, desiredRange);
  let evasive = runtime.style.evasive;
  if (!evasive || now >= evasive.expiresAt) {
    const interval = Math.max(250, Number(styleConfig.dodgeIntervalSeconds) * 1000 || 2500);
    const window = Math.floor(now / interval);
    evasive = {
      direction: (hashString(`${ship.id}:${target.id}:evasive:${window}`) & 1) ? 1 : -1,
      expiresAt: (window + 1) * interval
    };
  }
  const lateralSpeed = Math.min(
    Number(styleConfig.dodgeMagnitude) || 120,
    Math.max(
      EVASIVE_MIN_LATERAL_SPEED,
      (Number(stats.maxSpeed) || 0) * EVASIVE_LATERAL_SPEED_RATIO
    )
  );
  return movementIntent("evasive", {
    destination: range.destination,
    desiredVelocity: {
      x: -range.unitY * evasive.direction * lateralSpeed,
      y: range.unitX * evasive.direction * lateralSpeed
    },
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "evasive:range-plus-lateral-offset",
    styleMemory: { evasive }
  });
}

function repairIntent(ship, target) {
  const desiredRange = (Number(ship.radius) || 0)
    + (Number(target.radius) || 0)
    + REPAIR_STANDOFF_PAD;
  const range = relativeRangeState(ship, target, desiredRange);
  return movementIntent("repair", {
    destination: range.destination,
    facingMode: "target",
    facingTargetId: target.id,
    desiredRange,
    arrivalRequired: true,
    persistent: true,
    debugReason: "repair:standoff"
  });
}

function moveIntent(runtime) {
  const command = runtime.command;
  if (!command?.destination) return stopIntent("move:missing-destination");
  return movementIntent("move", {
    destination: { ...command.destination },
    facingMode: "final",
    finalFacing: command.finalFacing,
    arrivalRequired: true,
    persistent: false,
    debugReason: command.finalFacing == null
      ? "move:route-final-facing"
      : "move:explicit-final-facing"
  });
}

function createMovementIntent(room, ship, stats = ship.stats || {}, now = 0) {
  const runtime = ensureMovementRuntime(ship);
  const commandType = runtime.command?.type || null;
  const target = activeTarget(room, ship, runtime);
  if (commandType === "move") return moveIntent(runtime);
  if (commandType === "stop") return stopIntent("stop:brake");
  if (commandType === "repair") {
    return target ? repairIntent(ship, target) : stopIntent("repair:target-lost");
  }
  if (!target) return stopIntent(commandType === "attack" ? "attack:target-lost" : "idle");

  const maximumRange = maximumWeaponRange(ship);
  if (maximumRange <= 0) return stopIntent("attack:no-operational-weapons");
  const style = sanitizeCombatStyle(ship.combatStyle);
  switch (style) {
    case "orbit":
      return orbitIntent(ship, target, maximumRange, stats, runtime);
    case "maintain":
      return rangeIntent(
        "maintain",
        ship,
        target,
        Math.max(80, maximumRange * MAINTAIN_RANGE_RATIO),
        MAINTAIN_TOLERANCE,
        "maintain"
      );
    case "kite":
      return rangeIntent(
        "kite",
        ship,
        target,
        Math.max(80, maximumRange * KITE_RANGE_RATIO),
        KITE_TOLERANCE,
        "kite"
      );
    case "direct":
      return directIntent(ship, target, stats);
    case "sentry":
      return sentryIntent(ship, target, runtime);
    case "charge":
      return chargeIntent(ship, target);
    case "interceptor":
      return interceptorIntent(
        ship,
        target,
        maximumRange,
        stats,
        BALANCE.movement?.movementStyles?.interceptor?.desiredRangeRatio
          ?? INTERCEPTOR_RANGE_RATIO
      );
    case "evasive":
      return evasiveIntent(ship, target, maximumRange, stats, runtime, now);
    case "brawler":
      return rangeIntent(
        "brawler",
        ship,
        target,
        Math.max(
          40,
          maximumRange
            * (BALANCE.movement?.movementStyles?.brawler?.desiredRangeRatio
              ?? BRAWLER_RANGE_RATIO)
        ),
        BRAWLER_TOLERANCE,
        "brawler"
      );
    case "heavy":
      return rangeIntent(
        "heavy",
        ship,
        target,
        Math.max(
          40,
          maximumRange
            * (BALANCE.movement?.movementStyles?.heavy?.desiredRangeRatio
              ?? HEAVY_RANGE_RATIO)
        ),
        HEAVY_TOLERANCE,
        "heavy"
      );
    case "hold":
    default:
      return holdIntent(ship, target, maximumRange, runtime);
  }
}

function commitIntentStyleMemory(ship, intent) {
  const patch = intent?.styleMemory;
  if (!patch) return;
  const style = ensureMovementRuntime(ship).style;
  for (const key of [
    "orbit",
    "evasive",
    "sentryPosition",
    "holdPosition",
    "holdTargetId"
  ]) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) style[key] = patch[key];
  }
}

module.exports = {
  SUPPORTED_MOVEMENT_TYPES,
  commitIntentStyleMemory,
  createMovementIntent,
  movementIntent
};
