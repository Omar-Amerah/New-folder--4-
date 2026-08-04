"use strict";

// Command-time formations.
//
// A formation is resolved exactly once, at the moment the order is issued.
// Every selected ship comes away with ONE fixed slot and then flies to it on
// its own, through the ordinary route/steering/collision path. Nothing in this
// module runs per tick: there is no fleet anchor, no shared throttle and no
// shape that keeps pulling ships back into line.
//
// There is one shape -- a compact clump -- used for both jobs:
//
//   planFormation       an ordinary move. Slots are fixed world points around
//                       the clicked position, and the order is finished.
//   planAttackFormation a Hold attack. Slots are fixed offsets in a frame
//                       anchored on the target, so the clump translates with a
//                       moving enemy. The runtime carries the offset; the shape
//                       is still never rebuilt.
//
// What a formation decides is therefore only "where does each hull end up".

const { clampNumber, compareEntityIds, fastHypot } = require("./utils");
const { WORLD } = require("./config");
const { FORMATION_VISUAL_GAP, WORLD_MARGIN } = require("./movementTuning");
const { navigationClearanceRadius, physicalCollisionRadius } = require("./movementCollision");
const { nearestClearPoint } = require("./movementNavigation");
const {
  DEFAULT_FORMATION_TYPE,
  FORMATION_TYPES,
  sanitizeFormationType
} = require("./movementFlags");

// The sunflower angle. Successive slots land in the gaps left by every earlier
// one, which is what makes a clump compact without any of them colliding.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
// Radial pitch of the spiral, in slot spacings. See clumpOffsets.
const CLUMP_RADIAL_SCALE = 0.65;
// Below this the click is on top of the fleet and the travel vector carries no
// usable direction.
const MIN_DIRECTION_DISTANCE = 1;
// How many times an obstacle-adjusted slot may be walked further out before it
// is left where it is. Bounded so a pocket of clear ground surrounded by rock
// cannot spin here.
const SLOT_CONFLICT_ATTEMPTS = 6;
// Slack between the rear of an attack clump and the shortest selected weapon
// range, so a hull that stops a little wide of its slot is still inside it.
const HOLD_RANGE_PADDING = 24;
// Daylight between the front of an attack clump and the target's own hull.
const CONTACT_PADDING = 24;

// Deterministic order in, deterministic slots out. Two identical orders must
// assign the same ship to the same slot, so the sort is the stable entity-id
// comparison used everywhere else in movement.
function orderShipsForFormation(ships) {
  return (ships || []).filter((ship) => ship).slice().sort(compareEntityIds);
}

// Which ship takes which slot. The shape is generated in index order, so
// handing out slots in entity-id order gives the leftmost ship whichever slot
// its id happens to sort to, and the fleet spends the whole move crossing
// through itself to trade places.
//
// Instead: a greedy nearest-slot pass. Every ship/slot pair is ranked by how far
// the ship would have to travel, the shortest run-in is taken first, and both
// sides drop out. A group therefore forms out of the order it is already
// standing in -- the ship on the left takes a slot on the left, the one at the
// back takes a slot at the back -- without anyone being sent through the middle
// of the fleet to reach a place on the far side of it.
//
// Still a pure function of the order: the same ships, in the same places, sent
// to the same point always produce the same assignment. Entity id and slot index
// break any tie, so two hulls sitting on the same spot cannot flip between
// plans. This runs once, at command time, and never again.
function pairShipsToOffsets(ships, offsets, toWorld) {
  const points = offsets.map(toWorld);
  const pairs = [];
  for (let shipIndex = 0; shipIndex < ships.length; shipIndex += 1) {
    const x = Number(ships[shipIndex].x) || 0;
    const y = Number(ships[shipIndex].y) || 0;
    for (let slotIndex = 0; slotIndex < points.length; slotIndex += 1) {
      pairs.push({
        shipIndex,
        slotIndex,
        distance: fastHypot(points[slotIndex].x - x, points[slotIndex].y - y)
      });
    }
  }
  pairs.sort((left, right) => (
    (left.distance - right.distance)
    || compareEntityIds(ships[left.shipIndex], ships[right.shipIndex])
    || (left.slotIndex - right.slotIndex)
  ));
  const assigned = new Array(ships.length).fill(-1);
  const takenShips = new Set();
  const takenSlots = new Set();
  for (const pair of pairs) {
    if (takenShips.has(pair.shipIndex) || takenSlots.has(pair.slotIndex)) continue;
    takenShips.add(pair.shipIndex);
    takenSlots.add(pair.slotIndex);
    assigned[pair.shipIndex] = pair.slotIndex;
    if (takenShips.size === ships.length) break;
  }

  // Greedy alone can still leave two ships booked to fly through each other:
  // one takes a slot that was a hair closer, and the other is left with the one
  // on the far side of it. Swapping any pair that would be shorter the other way
  // round fixes that, because two run-ins that cross are always longer than the
  // same two exchanged. Pairs are visited in index order and swapped only on a
  // strict improvement, so it terminates and it is the same answer every time.
  //
  // The cost is squared travel, not travel. Plain distance is indifferent to
  // swapping two ships that differ only along the axis of approach -- the total
  // is identical either way -- which lets the hull that started furthest back be
  // sent to the front of the shape past everyone else. Squaring prefers the
  // even split, so the fleet's own depth order survives into the clump.
  const travel = (shipIndex, slotIndex) => {
    const dx = points[slotIndex].x - (Number(ships[shipIndex].x) || 0);
    const dy = points[slotIndex].y - (Number(ships[shipIndex].y) || 0);
    return dx * dx + dy * dy;
  };
  for (let pass = 0; pass < ships.length; pass += 1) {
    let swapped = false;
    for (let a = 0; a < ships.length; a += 1) {
      for (let b = a + 1; b < ships.length; b += 1) {
        const current = travel(a, assigned[a]) + travel(b, assigned[b]);
        const exchanged = travel(a, assigned[b]) + travel(b, assigned[a]);
        if (!(exchanged < current - 1e-9)) continue;
        const slot = assigned[a];
        assigned[a] = assigned[b];
        assigned[b] = slot;
        swapped = true;
      }
    }
    if (!swapped) break;
  }
  return ships.map((ship, index) => ({ ship, offset: offsets[assigned[index]] }));
}

// Spacing comes from what the hulls physically are, not from an assumed maximum
// size. One fleet-wide figure keeps the shape readable when sizes are mixed:
// the largest hull in the order sets the pitch for all of them.
function formationSpacing(ships) {
  let largest = 0;
  for (const ship of ships) largest = Math.max(largest, physicalCollisionRadius(ship));
  return largest * 2 + FORMATION_VISUAL_GAP;
}

function averageShipHeading(ships) {
  let x = 0;
  let y = 0;
  for (const ship of ships) {
    const angle = Number(ship.angle) || 0;
    x += Math.cos(angle);
    y += Math.sin(angle);
  }
  // Circular average first. When the headings cancel out exactly -- two hulls
  // nose to nose -- fall back to a deterministic one of them rather than to
  // world-east, and only to zero if there is no heading to be had at all.
  if (fastHypot(x, y) > 1e-6) return Math.atan2(y, x);
  const first = ships.find((ship) => Number.isFinite(Number(ship?.angle)));
  return first ? Number(first.angle) : 0;
}

function fleetCentre(ships) {
  let sumX = 0;
  let sumY = 0;
  for (const ship of ships) {
    sumX += Number(ship.x) || 0;
    sumY += Number(ship.y) || 0;
  }
  const count = Math.max(1, ships.length);
  return { x: sumX / count, y: sumY / count };
}

// A formation faces the way the fleet is being sent -- one shared heading for
// the whole shape, taken from the fleet's own centre to the clicked point. It is
// deliberately not each ship's own bearing to the click: that is what leaves a
// settled group fanned out looking inward at the spot it was sent to.
//
// Falling back to world-east would rotate every shape the moment a click landed
// on the fleet's own position, so the last resort is where the ships are
// already pointing.
function formationDirection(ships, centre, requested) {
  if (Number.isFinite(Number(requested))) return Number(requested);
  const fleet = fleetCentre(ships);
  const dx = centre.x - fleet.x;
  const dy = centre.y - fleet.y;
  if (fastHypot(dx, dy) > MIN_DIRECTION_DISTANCE) return Math.atan2(dy, dx);
  return averageShipHeading(ships);
}

// Offsets are in formation space: +x is the direction of travel, +y is to the
// right of it. The callers rotate them into the world.
//
// Golden-angle spiral on the area-preserving radial law: every slot covers the
// same area, so the cluster is as dense as a sunflower gets. CLUMP_RADIAL_SCALE
// is then the smallest multiplier that still keeps the closest pair of slots a
// full spacing apart -- verified against every fleet size up to 200 hulls, where
// the tightest pair comes out at 1.005 spacings.
//
// The naive r = spacing * sqrt(index) also separates the slots, but it wastes
// most of the area doing it: the same ten hulls spread half again as wide. That
// matters directly for a Hold attack, where the whole clump has to fit inside
// the shortest weapon range in the selection.
//
// The offsets are then recentred on their own middle, so the shape straddles
// the point it was asked for rather than hanging off one side of it -- and a
// single ship, whose middle is itself, is sent exactly where it was clicked.
function clumpOffsets(count, spacing) {
  const offsets = [];
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < count; index += 1) {
    const angle = index * GOLDEN_ANGLE;
    const radius = spacing * CLUMP_RADIAL_SCALE * Math.sqrt(index + 0.5);
    const offset = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    sumX += offset.x;
    sumY += offset.y;
    offsets.push(offset);
  }
  const centreX = sumX / Math.max(1, count);
  const centreY = sumY / Math.max(1, count);
  for (const offset of offsets) {
    offset.x -= centreX;
    offset.y -= centreY;
  }
  return offsets;
}

// One slot may land inside an asteroid, a station or the world edge. Only that
// slot moves, and only as far as the nearest point the ship could actually
// occupy -- which keeps it on its own side of the formation. The rest of the
// shape is untouched, because rebuilding it would re-task ships that had
// nothing wrong with their destination.
function resolveSlotPoint(room, ship, requestedX, requestedY) {
  const clearance = navigationClearanceRadius(ship);
  const clear = nearestClearPoint(room, requestedX, requestedY, clearance);
  return {
    x: clear.x,
    y: clear.y,
    clearance,
    adjusted: Boolean(clear.adjusted),
    reachable: Boolean(clear.clear)
  };
}

function slotsTooClose(a, b) {
  const minimum = physicalCollisionRadius(a.ship) + physicalCollisionRadius(b.ship);
  return fastHypot(a.x - b.x, a.y - b.y) < minimum;
}

// Slots on the generated lattice are spaced by construction, but a slot walked
// out of an asteroid is not: several slots inside the same rock are each moved
// to the nearest clear ground, which can be the same patch of it. One pass over
// the moved slots, in index order, pushes any that landed on top of another one
// further out along its own side of the shape. The lattice is never rebuilt and
// nothing that was already clear is touched.
function separateAdjustedSlots(room, slots, centre) {
  for (const slot of slots) {
    if (!slot.adjusted) continue;
    let outX = slot.x - centre.x;
    let outY = slot.y - centre.y;
    const length = fastHypot(outX, outY);
    if (length < 1e-6) {
      outX = 1;
      outY = 0;
    } else {
      outX /= length;
      outY /= length;
    }
    for (let attempt = 0; attempt < SLOT_CONFLICT_ATTEMPTS; attempt += 1) {
      const conflict = slots.find((other) => other !== slot && slotsTooClose(slot, other));
      if (!conflict) break;
      const needed = physicalCollisionRadius(slot.ship)
        + physicalCollisionRadius(conflict.ship)
        + FORMATION_VISUAL_GAP
        - fastHypot(slot.x - conflict.x, slot.y - conflict.y);
      const point = resolveSlotPoint(room, slot.ship, slot.x + outX * needed, slot.y + outY * needed);
      // Nowhere to go: leave it where it is rather than walking it somewhere
      // arbitrary. Collision will settle the last of it on arrival.
      if (fastHypot(point.x - slot.x, point.y - slot.y) < 1e-6) break;
      slot.x = point.x;
      slot.y = point.y;
      slot.reachable = point.reachable;
    }
  }
}

function planFormation(room, ships, options = {}) {
  const ordered = orderShipsForFormation(ships);
  const formation = sanitizeFormationType(options.formation);
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const centre = {
    x: clampNumber(Number(options.x) || 0, WORLD_MARGIN, width - WORLD_MARGIN),
    y: clampNumber(Number(options.y) || 0, WORLD_MARGIN, height - WORLD_MARGIN)
  };
  const direction = formationDirection(ordered, centre, options.direction);
  const spacing = formationSpacing(ordered);
  const offsets = clumpOffsets(ordered.length, spacing);
  const cos = Math.cos(direction);
  const sin = Math.sin(direction);
  const toWorld = (offset) => ({
    x: centre.x + offset.x * cos - offset.y * sin,
    y: centre.y + offset.x * sin + offset.y * cos
  });
  const slots = pairShipsToOffsets(ordered, offsets, toWorld).map(({ ship, offset }, index) => {
    const { x: requestedX, y: requestedY } = toWorld(offset);
    const point = resolveSlotPoint(room, ship, requestedX, requestedY);
    return {
      ship,
      shipId: ship.id,
      index,
      x: point.x,
      y: point.y,
      requestedX,
      requestedY,
      offsetX: offset.x,
      offsetY: offset.y,
      clearance: point.clearance,
      adjusted: point.adjusted,
      reachable: point.reachable
    };
  });
  separateAdjustedSlots(room, slots, centre);
  return { x: centre.x, y: centre.y, formation, direction, spacing, slots };
}

// --- Hold attack clump ------------------------------------------------------

// How far out the target's own hull reaches. A station is not a circle, so its
// widest half-extent stands in for one; it only has to keep the front of the
// clump from being planned inside the thing it is shooting at.
function targetContactExtent(target) {
  if (Array.isArray(target?.collisionPieces)) {
    return Math.max(
      Number(target.radius) || 0,
      (Number(target.width) || 0) / 2,
      (Number(target.height) || 0) / 2
    );
  }
  return physicalCollisionRadius(target);
}

// The direction the clump forms in: from the target back toward the fleet, so
// the group assembles on the side it is already coming from and nobody has to
// fly around the enemy. Deterministic when the two centres coincide -- the
// fleet's own heading, reversed, puts the clump behind where the hulls point.
function attackApproachUnit(ships, target) {
  const fleet = fleetCentre(ships);
  const awayX = fleet.x - (Number(target.x) || 0);
  const awayY = fleet.y - (Number(target.y) || 0);
  const length = fastHypot(awayX, awayY);
  if (length > MIN_DIRECTION_DISTANCE) return { x: awayX / length, y: awayY / length };
  const heading = averageShipHeading(ships);
  return { x: -Math.cos(heading), y: -Math.sin(heading) };
}

// Where the clump centre goes.
//
// The whole shape is placed by the SHORTEST usable Hold range in the selection,
// measured against the slot that ends up furthest from the target. That is what
// lets a short-range hull take a rear slot and still be able to fire from it,
// without anyone being pushed forward individually and without the group being
// sorted by weapon range.
//
// A slot sits at (centreDistance + forwardOffset) along the approach axis and
// lateralOffset across it, so the constraint per slot is
// hypot(centreDistance + forwardOffset, lateralOffset) <= range. Solving that
// for the centre and taking the tightest is the rear-extent rule with the
// clump's width carried through it.
function attackCentreDistance(offsets, range) {
  let distance = Infinity;
  for (const offset of offsets) {
    const lateral = Math.abs(offset.y);
    const reach = lateral >= range ? 0 : Math.sqrt(range * range - lateral * lateral);
    distance = Math.min(distance, reach - offset.x);
  }
  return distance - HOLD_RANGE_PADDING;
}

// One clump on the near side of the target, in a frame anchored on the target
// itself. `holdRange(ship)` reports that ship's usable Hold engagement range and
// whether it is genuinely armed; an unarmed hull still gets a slot, at the back,
// but its range does not drag the whole fleet onto the enemy.
function planAttackFormation(room, ships, target, options = {}) {
  const ordered = orderShipsForFormation(ships);
  if (!ordered.length || !target) return null;
  const holdRange = typeof options.holdRange === "function" ? options.holdRange : () => ({ range: 0 });

  const away = attackApproachUnit(ordered, target);
  const lateralX = -away.y;
  const lateralY = away.x;
  const targetX = Number(target.x) || 0;
  const targetY = Number(target.y) || 0;

  const spacing = formationSpacing(ordered);
  const offsets = clumpOffsets(ordered.length, spacing);
  const direction = Math.atan2(away.y, away.x);

  let minimumHoldRange = Infinity;
  let nominalRange = 0;
  let armedCount = 0;
  let largestHull = 0;
  for (const ship of ordered) {
    largestHull = Math.max(largestHull, physicalCollisionRadius(ship));
    const reported = holdRange(ship) || {};
    const range = Math.max(0, Number(reported.range) || 0);
    nominalRange = Math.max(nominalRange, range);
    if (!reported.armed || !(range > 0)) continue;
    armedCount += 1;
    minimumHoldRange = Math.min(minimumHoldRange, range);
  }
  // Nobody in the selection can actually shoot. Their nominal envelope still
  // has to put them somewhere sensible, and it must not be zero -- that would
  // stack an unarmed group on top of the enemy.
  if (!armedCount) minimumHoldRange = nominalRange;

  let frontExtent = 0;
  let backExtent = 0;
  for (const offset of offsets) {
    frontExtent = Math.max(frontExtent, -offset.x + largestHull);
    backExtent = Math.max(backExtent, offset.x);
  }
  const minimumCentreDistance = targetContactExtent(target) + frontExtent + CONTACT_PADDING;
  const centreDistance = Math.max(
    minimumCentreDistance,
    attackCentreDistance(offsets, minimumHoldRange)
  );
  const centre = {
    x: targetX + away.x * centreDistance,
    y: targetY + away.y * centreDistance
  };
  const toWorld = (offset) => ({
    x: centre.x + away.x * offset.x + lateralX * offset.y,
    y: centre.y + away.y * offset.x + lateralY * offset.y
  });

  const slots = pairShipsToOffsets(ordered, offsets, toWorld).map(({ ship, offset }, index) => {
    const { x: requestedX, y: requestedY } = toWorld(offset);
    const point = resolveSlotPoint(room, ship, requestedX, requestedY);
    return {
      ship,
      shipId: ship.id,
      index,
      x: point.x,
      y: point.y,
      requestedX,
      requestedY,
      forwardOffset: offset.x,
      lateralOffset: offset.y,
      clearance: point.clearance,
      adjusted: point.adjusted,
      reachable: point.reachable
    };
  });
  separateAdjustedSlots(room, slots, centre);
  // An adjusted slot is folded back into its own offset rather than kept as a
  // separate correction, so the whole clump -- adjustment included -- translates
  // with the target as one rigid shape.
  for (const slot of slots) {
    const dx = slot.x - centre.x;
    const dy = slot.y - centre.y;
    slot.forwardOffset = dx * away.x + dy * away.y;
    slot.lateralOffset = dx * lateralX + dy * lateralY;
  }

  return {
    targetId: String(target.id),
    x: centre.x,
    y: centre.y,
    awayX: away.x,
    awayY: away.y,
    centreDistance,
    minimumCentreDistance,
    minimumHoldRange,
    armedCount,
    backExtent,
    frontExtent,
    direction,
    spacing,
    slots
  };
}

// The world point an attack slot currently stands for. The offsets are fixed
// for the life of the order; what moves is the target they hang off.
function attackSlotPoint(slot, target) {
  const away = { x: Number(slot.awayX) || 0, y: Number(slot.awayY) || 0 };
  const lateralX = -away.y;
  const lateralY = away.x;
  const along = (Number(slot.centreDistance) || 0) + (Number(slot.forwardOffset) || 0);
  const across = Number(slot.lateralOffset) || 0;
  return {
    x: (Number(target.x) || 0) + away.x * along + lateralX * across,
    y: (Number(target.y) || 0) + away.y * along + lateralY * across
  };
}

module.exports = {
  CONTACT_PADDING,
  DEFAULT_FORMATION_TYPE,
  FORMATION_TYPES,
  HOLD_RANGE_PADDING,
  attackSlotPoint,
  clumpOffsets,
  formationDirection,
  formationSpacing,
  planAttackFormation,
  planFormation,
  sanitizeFormationType
};
