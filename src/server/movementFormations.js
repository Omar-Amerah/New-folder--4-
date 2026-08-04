"use strict";

// Command-time formations.
//
// A formation is resolved exactly once, at the moment the order is issued.
// Every selected ship comes away with ONE fixed world-space destination and
// then flies to it on its own, through the ordinary route/steering/collision
// path. Nothing in this module runs per tick: there is no fleet anchor, no
// shared throttle and no shape that keeps pulling ships back into line.
//
// What the formation decides is therefore only "where does each hull end up",
// and the answer is recorded on the order for debugging. After assignment the
// data is informational.

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
// Below this the click is on top of the fleet and the travel vector carries no
// usable direction.
const MIN_DIRECTION_DISTANCE = 1;
// Wedge geometry, as fractions of slot spacing. Two constraints set these. The
// closest pair in the shape -- two ships on the same side, one rank apart --
// has to stay a full spacing apart, which the depth/half-width hypotenuse gives.
// And the lane down the middle has to be wide enough for a maximum-size hull to
// fly up it: the fleet approaches a wedge from behind, so the ship holding the
// point must be able to overtake the ranks that are already parked in front of
// its slot. Spacing is a hull diameter plus the visual gap, so two ranks a full
// spacing either side of the axis leave a diameter of daylight between them.
const WEDGE_RANK_DEPTH = 0.9;
const WEDGE_RANK_WIDTH = 1;

// Deterministic order in, deterministic slots out. Two identical orders must
// assign the same ship to the same slot, so the sort is the stable entity-id
// comparison used everywhere else in movement.
function orderShipsForFormation(ships) {
  return (ships || []).filter((ship) => ship).slice().sort(compareEntityIds);
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
  return fastHypot(x, y) > 1e-6 ? Math.atan2(y, x) : 0;
}

// A formation faces the way the fleet is being sent. Falling back to world-east
// would rotate every shape the moment a click happened to land on the fleet's
// own position, so the last resort is where the ships are already pointing.
function formationDirection(ships, centre, requested) {
  if (Number.isFinite(Number(requested))) return Number(requested);
  let sumX = 0;
  let sumY = 0;
  for (const ship of ships) {
    sumX += Number(ship.x) || 0;
    sumY += Number(ship.y) || 0;
  }
  const count = Math.max(1, ships.length);
  const dx = centre.x - sumX / count;
  const dy = centre.y - sumY / count;
  if (fastHypot(dx, dy) > MIN_DIRECTION_DISTANCE) return Math.atan2(dy, dx);
  return averageShipHeading(ships);
}

// Offsets are in formation space: +x is the direction of travel, +y is to the
// right of it. planFormation rotates them into the world.
function formationOffset(index, count, spacing, formation) {
  if (formation === "wedge") {
    // Lead hull at the point, the rest falling in behind it alternating right
    // and left. Index order therefore reads straight off the sorted selection.
    const side = index % 2 === 0 ? -1 : 1;
    const rank = Math.ceil(index / 2);
    return {
      x: -rank * spacing * WEDGE_RANK_DEPTH,
      y: side * rank * spacing * WEDGE_RANK_WIDTH
    };
  }
  if (formation === "clump") {
    // Golden-angle spiral at sqrt spacing: the nearest pair of slots is exactly
    // one spacing apart, and the cluster stays as tight as that allows.
    const angle = index * GOLDEN_ANGLE;
    const radius = spacing * Math.sqrt(index);
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }
  // Line: abreast, across the axis of travel.
  return { x: 0, y: (index - (count - 1) / 2) * spacing };
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
  const cos = Math.cos(direction);
  const sin = Math.sin(direction);
  const slots = ordered.map((ship, index) => {
    const offset = formationOffset(index, ordered.length, spacing, formation);
    const requestedX = centre.x + offset.x * cos - offset.y * sin;
    const requestedY = centre.y + offset.x * sin + offset.y * cos;
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
  return { x: centre.x, y: centre.y, formation, direction, spacing, slots };
}

module.exports = {
  DEFAULT_FORMATION_TYPE,
  FORMATION_TYPES,
  formationDirection,
  formationOffset,
  formationSpacing,
  planFormation,
  sanitizeFormationType
};
