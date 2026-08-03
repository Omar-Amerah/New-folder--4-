"use strict";

// Target-relative combat positioning. This module only assigns stable slots;
// movementV2 remains responsible for proving the slot reachable, routing around
// static geometry, and flying the resulting point with the normal hull model.

const { angleDifference, compareEntityIds, fastHypot } = require("./utils");
const { getMaxEffectiveWeaponRange } = require("./componentData");
const { physicalCollisionRadius } = require("./movementCollision");

const HOLD_SLOT_RANGE_RATIO = 0.76;
const HOLD_SLOT_EDGE_MARGIN = 8;
const HOLD_RING_RANGE_BAND = 96;
const COMBAT_SLOT_CONTACT_PADDING = 8;
const COMBAT_SLOT_SPACING_MIN = 64;
const COMBAT_SLOT_SPACING_PAD = 24;
const CHARGE_STAGING_RING_GAP = 96;
const COMBAT_SLOT_TARGET_REASSIGN_DISTANCE = 180;

function normalizeAngle(angle) {
  let result = Number(angle) || 0;
  while (result <= -Math.PI) result += Math.PI * 2;
  while (result > Math.PI) result -= Math.PI * 2;
  return result;
}

function targetIsStation(target) {
  return target?.entityType === "station" || Array.isArray(target?.collisionPieces);
}

function targetBoundaryRadius(target) {
  if (!targetIsStation(target)) return 0;
  const stored = Number(target?.radius);
  if (Number.isFinite(stored) && stored > 0) return stored;

  let largest = 0;
  for (const piece of target?.collisionPieces || []) {
    const halfWidth = Math.max(0, Number(piece?.halfWidth) || 0);
    const halfHeight = Math.max(0, Number(piece?.halfHeight) || 0);
    const offset = fastHypot(
      (Number(piece?.x) || 0) - (Number(target?.x) || 0),
      (Number(piece?.y) || 0) - (Number(target?.y) || 0)
    );
    largest = Math.max(largest, offset + fastHypot(halfWidth, halfHeight));
  }
  return largest;
}

function currentBearing(ship, target) {
  const dx = (Number(ship?.x) || 0) - (Number(target?.x) || 0);
  const dy = (Number(ship?.y) || 0) - (Number(target?.y) || 0);
  if (fastHypot(dx, dy) > 1e-6) return Math.atan2(dy, dx);
  return normalizeAngle(Number(ship?.angle) || 0);
}

function combatModeForShip(ship) {
  const raw = ship?.combatStyleRaw || ship?.combatStyle;
  if (String(raw || "").toLowerCase() === "sentry"
    || String(raw || "").toLowerCase() === "static") return null;
  return String(raw || "").toLowerCase() === "charge" ? "charge" : "hold";
}

function targetCommandMatches(ship, targetId) {
  const command = ship?.movement?.command;
  if (command?.type === "attack") return String(command.targetId) === String(targetId);
  return String(ship?.combatTargetId || "") === String(targetId);
}

function roomShips(room) {
  if (room?.ships instanceof Map) return Array.from(room.ships.values());
  if (Array.isArray(room?.ships)) return room.ships;
  return [];
}

function combatGroupForTarget(room, target, mode) {
  return roomShips(room)
    .filter((ship) => ship?.alive !== false
      && combatModeForShip(ship) === mode
      && targetCommandMatches(ship, target?.id))
    .sort((a, b) => compareEntityIds(a, b));
}

function combatGroupSignature(ships) {
  return (ships || [])
    .map((ship) => String(ship?.id || ""))
    .sort()
    .join("|");
}

function combatSlotTargetMoved(slot, target, threshold = COMBAT_SLOT_TARGET_REASSIGN_DISTANCE) {
  if (!slot || !target) return true;
  return fastHypot(
    (Number(target.x) || 0) - (Number(slot.targetX) || 0),
    (Number(target.y) || 0) - (Number(slot.targetY) || 0)
  ) >= threshold;
}

function combatSlotPoint(target, slot) {
  if (!target || !slot || !Number.isFinite(Number(slot.assignedAngle))
    || !Number.isFinite(Number(slot.assignedRadius))) return null;
  return {
    x: (Number(target.x) || 0) + Math.cos(Number(slot.assignedAngle)) * Number(slot.assignedRadius),
    y: (Number(target.y) || 0) + Math.sin(Number(slot.assignedAngle)) * Number(slot.assignedRadius)
  };
}

function ringCapacity(radius, spacing) {
  return Math.max(1, Math.floor((2 * Math.PI * Math.max(1, radius)) / Math.max(1, spacing)));
}

function chooseNearestRingAssignments(entries, ringRadius, count, phase, blockedAngles = null) {
  const slotAngles = [];
  for (let index = 0; index < count; index += 1) {
    slotAngles.push(normalizeAngle(phase + index * Math.PI * 2 / count));
  }

  const remainingEntries = entries.slice();
  const remainingAngles = slotAngles.slice();
  const assignments = [];
  while (remainingEntries.length && remainingAngles.length) {
    let best = null;
    for (const entry of remainingEntries) {
      for (let angleIndex = 0; angleIndex < remainingAngles.length; angleIndex += 1) {
        const angle = remainingAngles[angleIndex];
        const blocked = blockedAngles?.get?.(entry.ship.id);
        if (Number.isFinite(Number(blocked)) && Math.abs(angleDifference(angle, blocked)) < 1e-4) continue;
        const score = Math.abs(angleDifference(entry.bearing, angle));
        const candidate = {
          entry,
          angle,
          angleIndex,
          score
        };
        if (!best
          || candidate.score < best.score - 1e-9
          || (Math.abs(candidate.score - best.score) < 1e-9
            && compareEntityIds(candidate.entry.ship, best.entry.ship) < 0)
          || (Math.abs(candidate.score - best.score) < 1e-9
            && candidate.entry.ship.id === best.entry.ship.id
            && candidate.angleIndex < best.angleIndex)) best = candidate;
      }
    }
    if (!best) {
      // An unreachable slot should be avoided when another sector exists, but
      // never drop the ship from the assignment merely because a one-sector
      // ring has no alternative.
      const entry = remainingEntries.shift();
      const originalAngle = remainingAngles.shift();
      const blocked = blockedAngles?.get?.(entry.ship.id);
      const angle = Number.isFinite(Number(blocked))
        ? normalizeAngle(Number(blocked) + Math.PI / 2)
        : originalAngle;
      assignments.push({ entry, angle, radius: ringRadius });
      continue;
    }
    remainingEntries.splice(remainingEntries.indexOf(best.entry), 1);
    remainingAngles.splice(best.angleIndex, 1);
    assignments.push({ entry: best.entry, angle: best.angle, radius: ringRadius });
  }
  return assignments;
}

function assignRing(entries, ringRadius, spacing, blockedAngles = null) {
  if (!entries.length) return [];
  const count = Math.min(entries.length, ringCapacity(ringRadius, spacing));
  const anchor = entries.slice().sort((a, b) => {
    const idOrder = compareEntityIds(a.ship, b.ship);
    return idOrder || a.bearing - b.bearing;
  })[0];
  return chooseNearestRingAssignments(
    entries,
    ringRadius,
    count,
    anchor.bearing,
    blockedAngles
  );
}

function entryFor(ship, target, mode) {
  const targetRadius = targetBoundaryRadius(target);
  const targetCollision = targetIsStation(target) ? 0 : physicalCollisionRadius(target);
  const shipCollision = physicalCollisionRadius(ship);
  const minimumFromAim = targetCollision + shipCollision + COMBAT_SLOT_CONTACT_PADDING;
  const range = Math.max(1, Number(getMaxEffectiveWeaponRange(ship)) || 0);
  const bearing = currentBearing(ship, target);

  if (mode === "charge") {
    const contactFromBoundary = shipCollision + targetCollision + COMBAT_SLOT_CONTACT_PADDING;
    return {
      ship,
      bearing,
      range,
      minCenterRadius: targetRadius + contactFromBoundary,
      maxCenterRadius: Infinity,
      desiredRadius: targetRadius + contactFromBoundary,
      contactRadius: targetRadius + contactFromBoundary,
      distanceFromAim: contactFromBoundary,
      currentDistance: fastHypot(
        (Number(ship.x) || 0) - (Number(target.x) || 0),
        (Number(ship.y) || 0) - (Number(target.y) || 0)
      )
    };
  }

  const comfortableDistance = range * HOLD_SLOT_RANGE_RATIO;
  const maxComfortableDistance = Math.max(minimumFromAim, range - HOLD_SLOT_EDGE_MARGIN);
  const distanceFromAim = Math.max(
    minimumFromAim,
    Math.min(comfortableDistance, maxComfortableDistance)
  );
  return {
    ship,
    bearing,
    range,
    minCenterRadius: targetRadius + minimumFromAim,
    maxCenterRadius: targetRadius + maxComfortableDistance,
    desiredRadius: targetRadius + distanceFromAim,
    contactRadius: targetRadius + minimumFromAim,
    distanceFromAim,
    currentDistance: fastHypot(
      (Number(ship.x) || 0) - (Number(target.x) || 0),
      (Number(ship.y) || 0) - (Number(target.y) || 0)
    )
  };
}

function applyAssignment(assignments, target, mode, signature, now, entry, result) {
  const previous = entry.ship.movement?.combatSlot;
  const slot = {
    targetId: String(target.id),
    combatMode: mode,
    assignedAngle: normalizeAngle(result.angle),
    assignedRadius: Math.max(entry.minCenterRadius, Number(result.radius) || entry.desiredRadius),
    targetX: Number(target.x) || 0,
    targetY: Number(target.y) || 0,
    groupSignature: signature,
    ringIndex: result.ringIndex || 0,
    staging: Boolean(result.staging),
    contactEstablished: Boolean(previous?.contactEstablished && !result.staging),
    assignedAt: Number.isFinite(Number(now)) ? Number(now) : 0,
    unreachable: false
  };
  assignments.set(entry.ship.id, slot);
}

function assignHoldSlots(entries, target, spacing, signature, now, blockedAngles, assignments) {
  const remaining = entries.slice().sort((a, b) => {
    if (Math.abs(a.desiredRadius - b.desiredRadius) > 0.001) return a.desiredRadius - b.desiredRadius;
    const bearingOrder = a.bearing - b.bearing;
    return Math.abs(bearingOrder) > 1e-9 ? bearingOrder : compareEntityIds(a.ship, b.ship);
  });
  let ringIndex = 0;
  let radiusHint = null;
  while (remaining.length) {
    const seed = remaining[0];
    const bandLimit = seed.desiredRadius + Math.max(HOLD_RING_RANGE_BAND, spacing * 0.75);
    let ringRadius = Number.isFinite(radiusHint) ? radiusHint : seed.desiredRadius;
    const compatible = remaining.filter((entry) => entry.desiredRadius <= bandLimit
      && ringRadius >= entry.minCenterRadius - 1e-6
      && ringRadius <= entry.maxCenterRadius + 1e-6);
    if (!compatible.length) {
      radiusHint = null;
      ringRadius = seed.desiredRadius;
    }
    const eligible = remaining.filter((entry) => entry.desiredRadius <= bandLimit
      && ringRadius >= entry.minCenterRadius - 1e-6
      && ringRadius <= entry.maxCenterRadius + 1e-6);
    const capacity = ringCapacity(ringRadius, spacing);
    const selected = eligible.slice(0, capacity);
    if (!selected.length) {
      // A pathological hull/range combination still receives a stable slot;
      // the movement path will report it unreachable rather than discarding it.
      selected.push(seed);
      ringRadius = seed.desiredRadius;
    }
    const ringAssignments = assignRing(selected, ringRadius, spacing, blockedAngles);
    for (const result of ringAssignments) {
      applyAssignment(assignments, target, "hold", signature, now, result.entry, {
        angle: result.angle,
        radius: Math.max(result.radius, result.entry.minCenterRadius),
        ringIndex
      });
    }
    const selectedIds = new Set(selected.map((entry) => entry.ship.id));
    for (let index = remaining.length - 1; index >= 0; index -= 1) {
      if (selectedIds.has(remaining[index].ship.id)) remaining.splice(index, 1);
    }

    const sameBandRemains = remaining.some((entry) => entry.desiredRadius <= bandLimit);
    if (sameBandRemains) {
      const inner = ringRadius - Math.max(spacing * 0.85, 48);
      const canUseInner = remaining.some((entry) => entry.desiredRadius <= bandLimit
        && inner >= entry.minCenterRadius - 1e-6
        && inner <= entry.maxCenterRadius + 1e-6);
      const outer = ringRadius + Math.max(spacing * 0.85, 48);
      const canUseOuter = remaining.some((entry) => entry.desiredRadius <= bandLimit
        && outer >= entry.minCenterRadius - 1e-6
        && outer <= entry.maxCenterRadius + 1e-6);
      radiusHint = canUseInner ? inner : (canUseOuter ? outer : null);
    } else {
      radiusHint = null;
    }
    ringIndex += 1;
  }
}

function assignChargeSlots(entries, target, spacing, signature, now, blockedAngles, assignments) {
  const previous = new Map(entries.map((entry) => [
    entry.ship.id,
    entry.ship.movement?.combatSlot
  ]));
  const contactRadius = entries.reduce(
    (largest, entry) => Math.max(largest, entry.contactRadius),
    targetBoundaryRadius(target) + COMBAT_SLOT_CONTACT_PADDING
  );
  const contactCapacity = ringCapacity(contactRadius, spacing);
  const contactCount = Math.min(entries.length, contactCapacity);
  const contactEntries = entries.slice().sort((a, b) => {
    const aEstablished = previous.get(a.ship.id)?.staging === false
      && previous.get(a.ship.id)?.contactEstablished;
    const bEstablished = previous.get(b.ship.id)?.staging === false
      && previous.get(b.ship.id)?.contactEstablished;
    if (aEstablished !== bEstablished) return aEstablished ? -1 : 1;
    if (Math.abs(a.currentDistance - b.currentDistance) > 0.001) {
      return a.currentDistance - b.currentDistance;
    }
    const bearingOrder = a.bearing - b.bearing;
    return Math.abs(bearingOrder) > 1e-9 ? bearingOrder : compareEntityIds(a.ship, b.ship);
  }).slice(0, contactCount);
  const contactIds = new Set(contactEntries.map((entry) => entry.ship.id));
  const contactAssignments = assignRing(contactEntries, contactRadius, spacing, blockedAngles);
  for (const result of contactAssignments) {
    applyAssignment(assignments, target, "charge", signature, now, result.entry, {
      angle: result.angle,
      radius: result.entry.contactRadius,
      ringIndex: 0,
      staging: false
    });
  }

  const stagingEntries = entries.filter((entry) => !contactIds.has(entry.ship.id));
  if (!stagingEntries.length) return;
  const stagingRadius = contactRadius + Math.max(CHARGE_STAGING_RING_GAP, spacing);
  let remainder = stagingEntries.slice();
  let ringIndex = 1;
  while (remainder.length) {
    const ringRadius = stagingRadius + (ringIndex - 1) * spacing;
    const ringAssignments = assignRing(remainder, ringRadius, spacing, blockedAngles);
    if (!ringAssignments.length) break;
    for (const result of ringAssignments) {
      applyAssignment(assignments, target, "charge", signature, now, result.entry, {
        angle: result.angle,
        radius: ringRadius,
        ringIndex,
        staging: true
      });
    }
    const assignedIds = new Set(ringAssignments.map((result) => result.entry.ship.id));
    remainder = remainder.filter((entry) => !assignedIds.has(entry.ship.id));
    ringIndex += 1;
  }
}

function assignCombatSlots(room, ships, target, mode, now, options = {}) {
  const group = (ships || [])
    .filter((ship) => ship?.alive !== false && combatModeForShip(ship) === mode)
    .sort((a, b) => compareEntityIds(a, b));
  const assignments = new Map();
  if (!target || !group.length || (mode !== "hold" && mode !== "charge")) return assignments;

  const entries = group.map((ship) => entryFor(ship, target, mode));
  const largestShipRadius = entries.reduce(
    (largest, entry) => Math.max(largest, physicalCollisionRadius(entry.ship)),
    0
  );
  const spacing = Math.max(
    COMBAT_SLOT_SPACING_MIN,
    largestShipRadius * 2 + COMBAT_SLOT_SPACING_PAD
  );
  const signature = combatGroupSignature(group);
  const blockedAngles = options.blockedAngles || new Map();
  if (mode === "charge") assignChargeSlots(entries, target, spacing, signature, now, blockedAngles, assignments);
  else assignHoldSlots(entries, target, spacing, signature, now, blockedAngles, assignments);

  for (const ship of group) {
    if (!assignments.has(ship.id)) assignments.set(ship.id, null);
  }
  return assignments;
}

function applyCombatSlotAssignments(ships, assignments) {
  for (const ship of ships || []) {
    if (!ship?.movement) continue;
    ship.movement.combatSlot = assignments?.get?.(ship.id) || null;
  }
  return assignments;
}

module.exports = {
  COMBAT_SLOT_TARGET_REASSIGN_DISTANCE,
  HOLD_SLOT_RANGE_RATIO,
  applyCombatSlotAssignments,
  assignCombatSlots,
  combatGroupForTarget,
  combatGroupSignature,
  combatModeForShip,
  combatSlotPoint,
  combatSlotTargetMoved,
  targetBoundaryRadius
};
