"use strict";

// Pair ownership is shared by steering and physical contact. Keeping it in a
// dependency-free module keeps steering and packed collision stages from
// quietly inventing a second right-of-way rule.

const { compareEntityIds, fastHypot } = require("./utils");
const { REST_SPEED } = require("./movementTuning");

function trafficPairKey(a, b) {
  return compareEntityIds(a, b) <= 0
    ? `${a.id}|${b.id}`
    : `${b.id}|${a.id}`;
}

function trafficIsStationary(ship) {
  const movement = ship?.movement;
  return fastHypot(ship?.vx || 0, ship?.vy || 0) <= REST_SPEED
    || movement?.arrived === true
    || movement?.phase === "positioned"
    || movement?.phase === "blocked"
    || movement?.phase === "idle"
    || movement?.command?.type === "stop";
}

function trafficIsPositioned(ship) {
  const movement = ship?.movement;
  return !movement?.command
    || movement.arrived === true
    || movement.orderComplete === true
    || movement.phase === "positioned"
    || movement.phase === "idle"
    || movement.command?.type === "stop";
}

function activeRouteGoal(ship) {
  const movement = ship?.movement;
  if (!movement?.destination) return null;
  const path = movement.path;
  const index = Math.max(0, Math.floor(Number(movement.waypointIndex) || 0));
  return path?.[index] || movement.destination;
}

function trafficRouteProgress(ship) {
  const movement = ship?.movement;
  const index = Math.max(0, Math.floor(Number(movement?.waypointIndex) || 0));
  const goal = activeRouteGoal(ship);
  return {
    index,
    distance: goal
      ? fastHypot(goal.x - (ship.x || 0), goal.y - (ship.y || 0))
      : Infinity
  };
}

function attackCommand(ship) {
  return ship?.movement?.command?.type === "attack"
    && Boolean(ship.movement.command.targetId);
}

function chargeShip(ship) {
  const style = ship?.combatStyleRaw || ship?.combatStyle;
  return attackCommand(ship) && String(style || "").toLowerCase() === "charge";
}

function attackerRange(ship) {
  if (!attackCommand(ship)) return Infinity;
  const stats = ship?.stats || {};
  const ranges = [stats.blasterRange, stats.missileRange, stats.railgunRange, stats.beamRange]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return ranges.length ? Math.min(...ranges) : Infinity;
}

function unfinishedMovement(ship) {
  const movement = ship?.movement;
  if (!movement?.command || movement.arrived === true || movement.orderComplete === true) return false;
  return movement.command.type === "move"
    || movement.command.type === "attack"
    || movement.command.type === "repair";
}

function trafficPriorityMap(room) {
  return room._trafficPriorities || (room._trafficPriorities = new Map());
}

function trafficPriorityWinner(room, a, b, now, releaseDistance) {
  const key = trafficPairKey(a, b);
  const priorities = trafficPriorityMap(room);
  // A station-controlled hull owns its launch corridor. Generic traffic
  // ordering must never choose it as the yielding ship; the station has already
  // advanced it monotonically and moved any blocker outward.
  const aLaunching = Boolean(a?.launchPhase);
  const bLaunching = Boolean(b?.launchPhase);
  if (aLaunching !== bLaunching) {
    const winnerId = aLaunching ? a.id : b.id;
    priorities.set(key, { winnerId, at: now });
    return winnerId;
  }
  const distance = fastHypot((a.x || 0) - (b.x || 0), (a.y || 0) - (b.y || 0));
  const current = priorities.get(key);
  if (current && distance > releaseDistance) {
    priorities.delete(key);
  } else if (current) {
    return current.winnerId;
  }

  const aStopped = trafficIsStationary(a);
  const bStopped = trafficIsStationary(b);
  const aPositioned = trafficIsPositioned(a);
  const bPositioned = trafficIsPositioned(b);
  let winner;
  if (aPositioned !== bPositioned) {
    winner = aPositioned ? a : b;
  } else if (aStopped !== bStopped) {
    winner = aStopped ? a : b;
  } else {
    const aCharge = chargeShip(a);
    const bCharge = chargeShip(b);
    if (aCharge !== bCharge) {
      winner = aCharge ? a : b;
    } else {
      const aRange = attackerRange(a);
      const bRange = attackerRange(b);
      if (Math.abs(aRange - bRange) > 0.5) {
        winner = aRange < bRange ? a : b;
      } else {
        const aUnfinished = unfinishedMovement(a);
        const bUnfinished = unfinishedMovement(b);
        if (aUnfinished !== bUnfinished) {
          winner = aUnfinished ? a : b;
        } else {
          const aProgress = trafficRouteProgress(a);
          const bProgress = trafficRouteProgress(b);
          if (aProgress.index !== bProgress.index) {
            winner = aProgress.index > bProgress.index ? a : b;
          } else if (Math.abs(aProgress.distance - bProgress.distance) > 0.5) {
            winner = aProgress.distance < bProgress.distance ? a : b;
          } else {
            winner = compareEntityIds(a, b) <= 0 ? a : b;
          }
        }
      }
    }
  }

  priorities.set(key, { winnerId: winner.id, at: now });
  return winner.id;
}

module.exports = {
  trafficIsPositioned,
  trafficIsStationary,
  trafficPairKey,
  trafficPriorityWinner
};
