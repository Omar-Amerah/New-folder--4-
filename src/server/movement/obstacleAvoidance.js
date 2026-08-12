"use strict";

const { fastHypot } = require("../utils");
const {
  ORBIT_AVOIDANCE_REACTION_TIME,
  ORBIT_BRAKING_PROBE_STEPS,
  ORBIT_PINCH_ESCAPE_SPEED,
  ORBIT_PINCH_HULL_MARGIN,
  REST_SPEED
} = require("../movementTuning");
const { physicalCollisionRadius } = require("../movementCollision");
const { isSegmentClear } = require("../movementNavigation");
const { brakingAcceleration } = require("./propulsion");

// The fastest this hull may travel and still be able to stop before the static
// geometry directly in front of it.
//
// Measured along the ship's actual velocity, not its intended heading: momentum
// is the thing that puts a hull into a rock its route went around. Infinity
// means nothing is in the way within stopping distance.
//
// The free distance is found by halving rather than by marching, so a long
// sweep costs a bounded handful of segment checks; each is exact geometry
// against asteroids and station pieces -- and against the world boundary, which
// isSegmentClear applies the same clearance rule to -- via the shared
// navigation authority.
//
// Shared by every travelling stance. Orbit needs it because a circle is flown
// under momentum around the outside of a corner; Kite needs it for the same
// reason, running from something. Neither may have its own slightly different
// copy: this is the guarantee that a hull can always stop before whatever is
// directly ahead of it, and two of them would be two different guarantees.
//
// `options.escapeClearance` is the one thing a caller may vary, and only for
// the pinch case below: how much daylight the crawl OUT of a pinch insists on.
// It defaults to the same padded margin the forward probe uses, which is what
// Orbit has always had. Kite passes the bare hull, because its pinch is a
// different situation -- Orbit is pinched while flying a circle it can widen,
// Kite is pinched while trying to leave, and refusing the crawl at a gap
// narrower than the margin leaves it with no direction that reads as open at
// all. The forward-collision probe itself is identical for both.
function staticObstacleBrakingCeiling(room, ship, stats, options = null) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (!(speed > REST_SPEED)) return Infinity;

  // The +24 route-planning envelope is for planning the detour, not for the
  // emergency forward-collision probe. The emergency probe uses the physical
  // hull margin so that being inside the padded envelope is not mistaken for
  // being in physical contact.
  const emergencyClearance = physicalCollisionRadius(ship) + ORBIT_PINCH_HULL_MARGIN;
  const escapeClearance = Number.isFinite(Number(options?.escapeClearance))
    ? Math.max(physicalCollisionRadius(ship), Number(options.escapeClearance))
    : emergencyClearance;
  const deceleration = Math.max(1, brakingAcceleration(stats));
  const reach = speed * speed / (2 * deceleration) + speed * ORBIT_AVOIDANCE_REACTION_TIME;
  if (!(reach > 1)) return Infinity;

  // Probe along the actual velocity. Momentum is what puts a hull into a rock;
  // a valid detour route is checked by orbitPathClearDistance before the ship
  // is committed to it.
  const unitX = (ship.vx || 0) / speed;
  const unitY = (ship.vy || 0) / speed;

  const clearFor = (distance, margin = emergencyClearance) => isSegmentClear(
    room,
    ship.x,
    ship.y,
    (ship.x || 0) + unitX * distance,
    (ship.y || 0) + unitY * distance,
    margin
  );
  // The hull has drifted inside its own clearance envelope, so "distance until
  // blocked" is zero by construction. Two very different situations produce
  // that reading and they need opposite answers:
  //
  //   still moving  -- the ship is arriving at the obstacle. Brake, hard. An
  //                    earlier version handed back a generous allowance here,
  //                    which released the brakes at the exact moment the ship
  //                    was a few pixels short of contact and drove it in.
  //   at a crawl    -- the ship is parked alongside and needs to leave. A
  //                    ceiling of zero is a trap: it cancels the very velocity
  //                    that would carry it out, so the hull sits against the
  //                    rock for the rest of the match. Allow a crawl and let
  //                    the route steer it back into open space.
  //
  // The crawl is also what would otherwise eat the margin: the planning
  // envelope is comfortably wider than the hull, so a ship that stopped at the
  // edge of it still had room to creep most of the way to the rock before
  // anything objected. So the crawl is offered only while the HULL itself --
  // not the padded envelope -- has somewhere to go. Refused, the ship brakes to
  // a standstill, the route turns its nose away, and the crawl is offered again
  // the moment it is pointing somewhere that is actually open.
  if (!clearFor(0)) {
    if (speed > ORBIT_PINCH_ESCAPE_SPEED) return 0;
    const crawlStop = ORBIT_PINCH_ESCAPE_SPEED * ORBIT_PINCH_ESCAPE_SPEED / (2 * deceleration);
    return clearFor(crawlStop + ORBIT_PINCH_HULL_MARGIN, escapeClearance)
      ? ORBIT_PINCH_ESCAPE_SPEED
      : 0;
  }
  if (clearFor(reach)) return Infinity;
  let low = 0;
  let high = reach;
  for (let step = 0; step < ORBIT_BRAKING_PROBE_STEPS; step += 1) {
    const middle = (low + high) / 2;
    if (clearFor(middle)) low = middle;
    else high = middle;
  }
  return Math.sqrt(2 * deceleration * Math.max(0, low));
}

module.exports = { staticObstacleBrakingCeiling };

