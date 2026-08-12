"use strict";

const { angleDifference, clampNumber, fastHypot } = require("../utils");
const { WORLD } = require("../config");
const {
  ARRIVE_DISTANCE,
  KITE_BLOCKED_RETRY_MS,
  KITE_CLEAR_SCAN_MS,
  KITE_CLOSING_SPEED_BUFFER,
  KITE_CLOSING_TRIGGER_SPEED,
  KITE_CONTACT_PADDING,
  KITE_EDGE_BUFFER_MIN,
  KITE_EDGE_INWARD_BIAS,
  KITE_ESCAPE_LOOKAHEAD_MIN,
  KITE_ESCAPE_LOOKAHEAD_SECONDS,
  KITE_ESCAPE_REPLAN_MS,
  KITE_HEADING_IMPROVEMENT_RATIO,
  KITE_INNER_RANGE_RATIO,
  KITE_MIN_ESCAPE_PROJECTION,
  KITE_OUTER_RANGE_RATIO,
  KITE_PREFERRED_RANGE_RATIO,
  KITE_RANGE_GAIN,
  KITE_ROUTE_PAD,
  KITE_TARGET_MOVE_REPLAN,
  KITE_TARGET_PREDICTION_SECONDS,
  ORBIT_AVOIDANCE_REACTION_TIME,
  REST_SPEED,
  WORLD_MARGIN
} = require("../movementTuning");
const {
  navigationClearanceRadius,
  physicalCollisionRadius
} = require("../movementCollision");
const {
  isSegmentClear,
  nearestClearPoint,
  searchPathWorld
} = require("../movementNavigation");
const { KITE_RUNTIME_DEFAULTS } = require("../movementRuntimeV2");
const { combat } = require("./combatAccess");
const {
  currentFiringLineClear,
  engagementGeometry,
  radialSeparationSpeed,
  reachableFiringPosition,
  targetAttackPointFrom,
  targetIsStation
} = require("./engagement");
const { movementToggles } = require("./intent");
const { clearRoute, routeClearance } = require("./navigation");
const { staticObstacleBrakingCeiling } = require("./obstacleAvoidance");
const { brakingAcceleration, normalizeHullAngle } = require("./propulsion");

const BEARING_MIN_DISTANCE = 1;

// Kite steering is live only while the stance is actually flying the band.
// Everything else -- no target, another stance, Static, an order -- must leave
// it switched off, or a stale speed ceiling would throttle the next order and a
// stale heading would be flown at a target this ship is no longer fighting.
function clearKiteSteering(runtime) {
  for (const key of Object.keys(KITE_RUNTIME_DEFAULTS)) runtime[key] = KITE_RUNTIME_DEFAULTS[key];
}

// The far-range band, measured the same way engagementGeometry measures
// distance -- to the hull for a ship, to the attackable surface for a station.
//
// `battery` is the main battery's all-heading reach, so the band is the reach of
// the guns the stance is actually being flown for. A short-ranged secondary does
// not appear in it and so cannot drag the hull into a knife fight. The contact
// floor is the only thing that may raise the band, and it exists so a
// short-ranged hull kites around its target rather than through it.
function kiteRanges(battery, contact) {
  const floor = contact + KITE_CONTACT_PADDING;
  const preferred = Math.max(floor, battery * KITE_PREFERRED_RANGE_RATIO);
  const inner = Math.max(floor, battery * KITE_INNER_RANGE_RATIO);
  return {
    preferred,
    // Never above preferred: with a short battery both collapse onto the
    // contact floor, and an inner band outside the preferred one would mean
    // retreating from the range the ship is trying to hold.
    inner: Math.min(inner, preferred),
    outer: Math.max(preferred + ARRIVE_DISTANCE, battery * KITE_OUTER_RANGE_RATIO)
  };
}

// Where the target will be in a moment, bounded hard. This is reaction time, not
// a forecast: half a second of the target's own velocity is enough to start
// running before a fast attacker actually closes the band, and long enough that
// a malformed velocity could put the answer anywhere is not.
//
// A station does not move, so it keeps the range already measured against its
// surface rather than having a velocity applied to a shape.
function kitePredictedDistance(ship, target, distance) {
  if (targetIsStation(target)) return distance;
  const vx = clampNumber(Number(target.vx) || 0, -10000, 10000);
  const vy = clampNumber(Number(target.vy) || 0, -10000, 10000);
  const x = (Number(target.x) || 0) + vx * KITE_TARGET_PREDICTION_SECONDS;
  const y = (Number(target.y) || 0) + vy * KITE_TARGET_PREDICTION_SECONDS;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return distance;
  return fastHypot(x - (ship.x || 0), y - (ship.y || 0));
}

// Is the ship being crowded? Three separate ways of being crowded, because a
// range that is about to collapse has to be treated as collapsed: a fast
// attacker crosses the band in the time it takes a heavy hull to turn around.
function kiteUnderPressure(ranges, distance, predicted, radial) {
  if (distance < ranges.inner) return true;
  if (predicted < ranges.inner) return true;
  const closing = -radial;
  if (!(closing > KITE_CLOSING_TRIGGER_SPEED)) return false;
  // Margin left, against the ground the target will make up while the ship
  // reacts, plus the buffer that stops this triggering on the exact tick the
  // band is breached.
  return (distance - ranges.inner)
    < closing * KITE_TARGET_PREDICTION_SECONDS + KITE_CLOSING_SPEED_BUFFER;
}

// The most this hull can actually do, which is not what its blueprint says: the
// heat- and damage-adjusted figure is the one every Kite speed is measured
// against, so a ship with a burnt engine kites slower rather than asking for a
// speed it cannot make.
function kiteAvailableSpeed(ship, stats) {
  const effective = Math.max(0, Number(stats.maxSpeed) || 0);
  const paper = Number(ship.stats?.maxSpeed);
  return Number.isFinite(paper) && paper > 0 ? Math.min(effective, paper) : effective;
}

// Range is controlled as a desired RATE, not as a stop point. A stop point makes
// a ship park; a rate lets it ease onto the band, run from something closing,
// and drift back in when the target is slower than it is.
//
// Positive opens the range, negative closes it. Nothing here is a ship speed
// yet: the chosen heading's outward projection is what turns it into one.
function kiteDesiredOpeningSpeed(mode, ranges, distance, radial, available, toggles) {
  const rangeError = ranges.preferred - distance;
  let opening = clampNumber(rangeError * KITE_RANGE_GAIN, -available, available);
  if (mode === "retreat") {
    // Matching the target's closing speed only holds the gap. The buffer is
    // what makes a retreat actually gain ground.
    opening = clampNumber(
      Math.max(opening, -radial + KITE_CLOSING_SPEED_BUFFER),
      0,
      available
    );
  }
  // Pursue off means never chasing a target that opens the range. It does not
  // mean standing still while one closes, so only the closing half is removed.
  if (!toggles.pursue) opening = Math.max(opening, 0);
  return Number.isFinite(opening) ? opening : 0;
}

// How much of the map Kite treats as unusable.
//
// Collision clamping at the boundary is a final safety net, not navigation: a
// ship that only notices the edge when it touches it accelerates into the wall,
// grinds along it and never opens the range. This inset is what keeps escape
// destinations off the wall in the first place, and it is wider than the
// navigation envelope by a deliberate buffer so the reaction happens with room
// left to turn.
function kiteEdgeInset(ship) {
  return WORLD_MARGIN + navigationClearanceRadius(ship) + KITE_EDGE_BUFFER_MIN;
}

function insideKiteInset(room, x, y, inset) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  return x >= inset && x <= width - inset && y >= inset && y <= height - inset;
}

// How far along `heading` the hull may travel before it leaves the inset above.
// Zero for a ship already outside it pointing further out, which is exactly the
// reading that rejects "keep accelerating into the wall".
function kiteInsetRun(room, ship, heading, inset) {
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const dx = Math.cos(heading);
  const dy = Math.sin(heading);
  const axis = (position, direction, low, high) => {
    if (direction > 1e-9) return (high - position) / direction;
    if (direction < -1e-9) return (low - position) / direction;
    return Infinity;
  };
  return Math.max(0, Math.min(
    axis(ship.x || 0, dx, inset, width - inset),
    axis(ship.y || 0, dy, inset, height - inset)
  ));
}

// How pinned against the boundary the hull currently is, 0 well inside the inset
// to 1 on it or beyond. Scales the inward bias, so the edge costs nothing in
// open space and dominates against the wall.
function kiteEdgePressure(room, ship, inset) {
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  const margin = Math.min(
    (ship.x || 0) - inset,
    width - inset - (ship.x || 0),
    (ship.y || 0) - inset,
    height - inset - (ship.y || 0)
  );
  if (!Number.isFinite(margin)) return 1;
  if (margin >= KITE_EDGE_BUFFER_MIN) return 0;
  return clampNumber(1 - margin / KITE_EDGE_BUFFER_MIN, 0, 1);
}

// The bearing from the hull toward the middle of the map. Only ever used as a
// bias, never as a destination: "inward" is a tie-breaker among escape
// headings, not somewhere Kite is trying to go.
function kiteInwardBearing(room, ship) {
  const width = room?.world?.width || WORLD.width;
  const height = room?.world?.height || WORLD.height;
  return Math.atan2(height / 2 - (ship.y || 0), width / 2 - (ship.x || 0));
}

// How far ahead a retreat aim point is placed. Enough that the hull always has
// somewhere to be going, and never less than it takes to stop from the speed it
// is carrying -- a point closer than the stopping distance is a point the ship
// is already committed past.
function kiteEscapeLookahead(ship, stats) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  const deceleration = Math.max(1, brakingAcceleration(stats));
  const stopping = speed * speed / (2 * deceleration)
    + speed * ORBIT_AVOIDANCE_REACTION_TIME
    + routeClearance(ship) * 2;
  return Math.max(
    KITE_ESCAPE_LOOKAHEAD_MIN,
    speed * KITE_ESCAPE_LOOKAHEAD_SECONDS,
    stopping
  );
}

function kiteProjectedPoint(ship, heading, distance) {
  return {
    x: (ship.x || 0) + Math.cos(heading) * distance,
    y: (ship.y || 0) + Math.sin(heading) * distance
  };
}

// Offsets a candidate heading is generated at, around each base bearing. Fixed
// and ordered, so the candidate list -- and therefore the choice -- is the same
// every time the same geometry is presented.
const KITE_HEADING_OFFSETS = Object.freeze([
  0,
  Math.PI / 12,
  -Math.PI / 12,
  Math.PI / 6,
  -Math.PI / 6,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 3,
  -Math.PI / 3,
  Math.PI / 2,
  -Math.PI / 2
]);

// How many candidates are scored against the weapons. The geometric pass is
// cheap and the coverage pass is not, so the list is cut to the best geometry
// first; this is a cost bound, not a behaviour choice.
const KITE_HEADING_COVERAGE_LIMIT = 12;
// ...and how many of them are worth a path search when none of them has a clear
// straight run.
const KITE_ROUTED_CANDIDATE_LIMIT = 3;

// Every hull heading worth considering.
//
// The straight-away, tangent and straight-toward bearings are the geometry of
// the problem; the current hull heading and the one already committed to are
// what continuity is measured against; and each main-battery gun contributes
// the hull heading that would put its own mount on the target plus the two
// edges of its own arc. That last family is the whole point: it is what lets a
// rear-mounted gun's ideal heading -- straight away from the target -- be
// discovered as a heading that both escapes and shoots.
function kiteCandidateHeadings(ship, runtime, awayBearing, profile) {
  const headings = [];
  const add = (angle) => {
    const value = normalizeHullAngle(angle);
    if (!Number.isFinite(value)) return;
    for (const existing of headings) {
      if (Math.abs(angleDifference(existing, value)) < 1e-4) return;
    }
    headings.push(value);
  };

  const previous = Number(runtime.kiteHeading);
  const bases = [awayBearing];
  if (Number.isFinite(previous)) bases.push(previous);
  for (const base of bases) {
    for (const offset of KITE_HEADING_OFFSETS) add(base + offset);
  }
  add(ship.angle || 0);
  // Straight at the target: the heading a nose gun wants, and the one a drift
  // back toward the band is flown on.
  add(awayBearing + Math.PI);

  // idealHullHeading = (bearing from the mount to the target) - (the mount's own
  // blueprint-relative facing). Taken from the hull centre, because the mount's
  // world position is itself a function of the heading being solved for; over
  // the distances Kite fights at the difference is a fraction of a degree, and
  // the coverage pass below measures the real mount position anyway.
  const targetBearing = awayBearing + Math.PI;
  for (const weapon of profile.weapons) {
    const centre = targetBearing - weapon.mountAngle;
    add(centre);
    if (weapon.arcRadians < Math.PI * 2 - 1e-6) {
      add(centre - weapon.arcRadians / 2);
      add(centre + weapon.arcRadians / 2);
    } else if (weapon.mountOffset > 1e-6) {
      // A full-circle turret has no arc to generate candidates from, but its
      // coverage still moves with the heading: rotating the hull swings the
      // mount between the near and the far side of the target.
      add(targetBearing - weapon.mountOffsetAngle);
    }
  }
  return headings;
}

// Can this heading serve the requested change in range at all?
//
// In a retreat the answer has to be yes with room to spare: a heading that
// barely opens the range is not an escape. Elsewhere it only has to point the
// right way -- and when the controller is asking for no change at all, any
// heading will do and the weapons decide.
function kiteProjectionUsable(mode, need, projection) {
  if (mode === "retreat") return projection > KITE_MIN_ESCAPE_PROJECTION;
  if (need > REST_SPEED) return projection > KITE_MIN_ESCAPE_PROJECTION;
  if (need < -REST_SPEED) return projection < -KITE_MIN_ESCAPE_PROJECTION;
  return true;
}

// A desired opening speed becomes a ship speed by dividing out how much of this
// heading actually points along the radius. The floor is what keeps a nearly
// tangential heading from asking for infinite thrust; the result is always a
// non-negative FORWARD speed, because that is the only kind this model has.
function kiteForwardSpeed(need, projection, available) {
  const along = Math.max(Math.abs(projection), KITE_MIN_ESCAPE_PROJECTION);
  const speed = Math.abs(need) / along;
  return clampNumber(Number.isFinite(speed) ? speed : 0, 0, available);
}

// Rank two candidates. Deterministic to the last comparison: equal scores fall
// back to the smaller turn and then to the numerically smaller heading, so two
// mirror-image escape routes always resolve the same way rather than by
// whichever the loop happened to see first.
function kiteCandidateBetter(candidate, best) {
  if (!best) return true;
  if (candidate.score > best.score + 1e-6) return true;
  if (candidate.score < best.score - 1e-6) return false;
  if (candidate.turn < best.turn - 1e-6) return true;
  if (candidate.turn > best.turn + 1e-6) return false;
  return candidate.heading < best.heading;
}

// What a heading is worth before the weapons have been asked.
//
// Escaping, staying off the wall, having a clear run and not spending the next
// second turning. Coverage is added on top of this for the shortlist only,
// because it is the expensive question.
//
// `relaxed` is the cornered case, and it is scored on completely different
// terms. There, by construction, no heading opens the range at all -- every one
// that would leaves the map -- so ranking by outward projection ranks a set of
// equally useless options and picks a different one each time the geometry
// shifts by a pixel. What matters when pinned is getting back into open water:
// how far inward the heading points, and how much room it actually has. Ranking
// by those is what makes the choice stable long enough to act on.
function kiteGeometryScore(context, heading, projection, direct, options = null) {
  const turn = Math.abs(angleDifference(context.hullAngle, heading));
  const inward = Math.cos(angleDifference(context.inwardBearing, heading));
  const sided = context.escapeSide !== 0
    && Math.sign(angleDifference(context.awayBearing, heading)) === context.escapeSide;
  if (options?.relaxed) {
    const room = clampNumber((Number(options.run) || 0) / Math.max(1, Number(options.lookahead) || 1), 0, 1);
    return 1200 * inward
      + 400 * room
      + (sided ? 120 : 0)
      - 60 * (turn / Math.PI);
  }
  const alignment = context.mode === "retreat"
    ? projection
    : projection * Math.sign(Math.abs(context.need) > REST_SPEED ? context.need : 0);
  return (context.mode === "retreat" ? 1200 : 200) * alignment
    + (direct ? 300 : 0)
    + 600 * KITE_EDGE_INWARD_BIAS * context.edgePressure * inward
    + (sided ? 120 : 0)
    - 60 * (turn / Math.PI);
}

// Try to turn a heading into somewhere the hull could actually fly.
//
// A candidate has to end inside the navigable inset, on ground the hull could
// occupy, and be reachable -- directly if the run is clear, otherwise through
// the shared static route search, which is the same planner every other order
// uses. `relaxed` is the corner case: pinned into a boundary, the run is allowed
// to be cut short at the inset provided it still has somewhere to go, because
// getting back into open water outranks both range and firing.
function kiteDestinationFor(room, ship, heading, options) {
  const { lookahead, inset, clearance, relaxed, allowRouted, pinched } = options;
  const insetRun = kiteInsetRun(room, ship, heading, inset);
  let distance = Math.min(lookahead, insetRun);
  if (!relaxed && distance < lookahead - 1e-6) return null;
  if (relaxed) distance = Math.min(lookahead, Math.max(0, insetRun));
  if (!(distance >= clearance * 2)) return null;

  const point = kiteProjectedPoint(ship, heading, distance);
  if (!insideKiteInset(room, point.x, point.y, inset)) return null;
  if (isSegmentClear(room, ship.x, ship.y, point.x, point.y, clearance)) {
    return { x: point.x, y: point.y, direct: true, run: distance };
  }
  // The hull has drifted inside its own planning envelope -- parked against a
  // rock, shoved there, or spawned there. Every segment out of it is "blocked"
  // by construction, including the ones that lead to open water, so insisting on
  // the padded envelope here traps the ship permanently. Fall back to the
  // physical hull margin, which is the same allowance the braking ceiling makes
  // for the same situation, and let that ceiling hold it to a crawl until it is
  // out and an ordinary plan can be made.
  if (pinched && isSegmentClear(room, ship.x, ship.y, point.x, point.y, physicalCollisionRadius(ship))) {
    return { x: point.x, y: point.y, direct: true, run: distance };
  }
  if (!allowRouted) return null;
  // The straight run is obstructed. The point itself still has to be ground the
  // hull could sit on -- a destination inside an asteroid or a station is not a
  // destination -- and then the shared planner decides whether there is a way
  // round to it.
  const clear = nearestClearPoint(room, point.x, point.y, clearance);
  if (!clear.clear || fastHypot(clear.x - point.x, clear.y - point.y) > clearance) return null;
  if (!insideKiteInset(room, clear.x, clear.y, inset)) return null;
  const search = searchPathWorld(room, ship.x, ship.y, clear.x, clear.y, clearance, {
    minimumClearance: clearance,
    preferredClearance: clearance + KITE_ROUTE_PAD
  });
  if (!search.reachedGoal) return null;
  return { x: clear.x, y: clear.y, direct: false, run: distance };
}

// Choose the heading to fly and the place to fly it to.
//
// Two passes on purpose. The geometric pass is a handful of cheap tests and it
// is what decides feasibility; the coverage pass measures what the main battery
// could do from each surviving heading, and it is only ever run on a shortlist
// and on a cadence. A path search happens only when nothing has a clear run,
// which in open space is never.
function chooseKitePlan(room, ship, runtime, target, stats, mode, context, now) {
  const clearance = routeClearance(ship);
  const inset = kiteEdgeInset(ship);
  const lookahead = kiteEscapeLookahead(ship, stats);
  const headings = kiteCandidateHeadings(ship, runtime, context.awayBearing, context.profile);
  // Is the hull already inside its own planning envelope? Asked once, as a
  // zero-length segment at the ship's own position, because it changes what
  // "clear" has to mean for every candidate below.
  const pinched = !isSegmentClear(room, ship.x, ship.y, ship.x, ship.y, clearance);

  const collect = (relaxed) => {
    const found = [];
    for (const heading of headings) {
      const projection = Math.cos(angleDifference(context.awayBearing, heading));
      if (!relaxed && !kiteProjectionUsable(mode, context.need, projection)) continue;
      // Pinned, the only headings worth having are the ones that take the ship
      // back toward open space. Without this the relaxed pass considers the
      // whole circle, including the headings that put the hull further into the
      // corner it is trying to leave.
      if (relaxed
        && !(Math.cos(angleDifference(context.inwardBearing, heading)) > 0.1)) continue;
      const destination = kiteDestinationFor(room, ship, heading, {
        lookahead,
        inset,
        clearance,
        relaxed,
        pinched,
        allowRouted: false
      });
      if (!destination) continue;
      found.push({
        heading,
        projection,
        destination,
        turn: Math.abs(angleDifference(context.hullAngle, heading)),
        score: kiteGeometryScore(context, heading, projection, true, {
          relaxed,
          run: destination.run,
          lookahead
        })
      });
    }
    return found;
  };

  // Straight runs first. An obstructed one costs a path search, so it is only
  // worth having when there is no clear escape at all.
  let candidates = collect(false);
  let routed = false;
  if (!candidates.length) {
    const ranked = [];
    for (const heading of headings) {
      const projection = Math.cos(angleDifference(context.awayBearing, heading));
      if (!kiteProjectionUsable(mode, context.need, projection)) continue;
      ranked.push({
        heading,
        projection,
        turn: Math.abs(angleDifference(context.hullAngle, heading)),
        score: kiteGeometryScore(context, heading, projection, false)
      });
    }
    ranked.sort((a, b) => (kiteCandidateBetter(a, b) ? -1 : 1));
    for (const candidate of ranked.slice(0, KITE_ROUTED_CANDIDATE_LIMIT)) {
      const destination = kiteDestinationFor(room, ship, candidate.heading, {
        lookahead,
        inset,
        clearance,
        relaxed: false,
        pinched,
        allowRouted: true
      });
      if (!destination) continue;
      candidates.push({ ...candidate, destination });
      routed = true;
    }
  }
  if (!candidates.length) {
    // Boxed into a boundary or a corner. Every direction that opens the range
    // leaves the map, so the gate comes off and the best short inward run wins;
    // losing range for a moment is the correct trade against being pinned.
    candidates = collect(true);
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => (kiteCandidateBetter(a, b) ? -1 : 1));
  const shortlist = candidates.slice(0, KITE_HEADING_COVERAGE_LIMIT);
  const totalOutput = Math.max(1e-6, Number(context.profile.output) || 0);
  const previousHeading = Number(runtime.kiteHeading);
  let best = null;
  let incumbent = null;
  for (const candidate of shortlist) {
    const coverage = combat().evaluateMainBatteryFacing(room, ship, target, candidate.heading, now);
    const share = clampNumber((Number(coverage.output) || 0) / totalOutput, 0, 1);
    // Escaping outranks shooting inside the danger band, and shooting outranks
    // fine range control outside it. Both are the same two terms with the
    // weights the other way round -- there is no separate retreat controller.
    const weight = mode === "retreat" ? 250 : 1000;
    const scored = { ...candidate, score: candidate.score + weight * share, coverage: share };
    if (kiteCandidateBetter(scored, best)) best = scored;
    if (Number.isFinite(previousHeading)
      && Math.abs(angleDifference(previousHeading, scored.heading)) < 1e-4) incumbent = scored;
  }
  if (!best) return null;

  // Heading hysteresis, measured inside ONE scoring pass rather than against a
  // score kept from an earlier tick -- scores are relative to the geometry they
  // were computed in and mean nothing across ticks. The heading already being
  // flown stands unless the alternative is materially better by this much; two
  // mirror-image escape routes score within a hair of each other, and a ship
  // that takes whichever is ahead this tick spends the fight weaving.
  if (incumbent && best !== incumbent
    && best.score <= incumbent.score + KITE_HEADING_IMPROVEMENT_RATIO * Math.abs(incumbent.score)) {
    best = incumbent;
  }

  return {
    targetId: String(target.id),
    targetX: Number(target.x) || 0,
    targetY: Number(target.y) || 0,
    mode,
    heading: best.heading,
    destination: { x: best.destination.x, y: best.destination.y },
    direct: best.destination.direct,
    coverage: best.coverage,
    score: best.score,
    plannedAt: now,
    replanAt: now + KITE_ESCAPE_REPLAN_MS,
    escapeSide: Math.sign(angleDifference(context.awayBearing, best.heading)) || 0,
    preferredRange: context.ranges.preferred,
    innerRange: context.ranges.inner,
    outerRange: context.ranges.outer,
    routed
  };
}

// Is a plan still worth flying? Cheap enough to ask on a cadence, and never on
// a plan that has just been made.
//
// A committed detour is deliberately NOT re-tested against the straight line:
// that line goes clear while the hull is still beside the obstacle, and dropping
// the detour there is what walks a ship back into the rock it was halfway round.
// The route planner owns a routed plan until it is replanned.
function kitePlanFlyable(room, ship, plan, inset, clearance) {
  if (!plan?.destination) return false;
  if (!Number.isFinite(plan.destination.x) || !Number.isFinite(plan.destination.y)) return false;
  if (!insideKiteInset(room, plan.destination.x, plan.destination.y, inset)) return false;
  if (!plan.direct) return true;
  return isSegmentClear(room, ship.x, ship.y, plan.destination.x, plan.destination.y, clearance);
}

// Kite's forward-collision ceiling. Identical to Orbit's in every respect but
// one: the crawl out of a pinch is measured against the bare hull. A kiting ship
// that has ended up inside its own envelope is trying to LEAVE, and at a gap
// narrower than the padded margin no direction reads as open, so the padded test
// would answer "stop" whichever way it pointed and hold it there permanently.
function kiteBrakingCeiling(room, ship, stats) {
  return staticObstacleBrakingCeiling(room, ship, stats, {
    escapeClearance: physicalCollisionRadius(ship)
  });
}

// The band this ship would hold around this target. Pure: it reads no runtime
// state and changes none, which is what makes it safe to ask from outside the
// controller -- tests and diagnostics use it to check the band without having
// to fly a ship to find out what it is.
function kiteRangeBand(ship, target) {
  const profile = combat().mainBatteryProfile(ship);
  const band = kiteRanges(profile.standoffRange, engagementGeometry(ship, target).contact);
  return { ...band, battery: profile.standoffRange };
}

// One tick of Kite. Chooses the tactical mode, the heading, the aim point and
// the speed ceiling; it fires nothing and latches nothing.
function planKite(room, ship, runtime, target, stats, now) {
  const targetId = String(target.id);
  if (runtime.kiteTargetId !== targetId) {
    // A different target. The band, the heading, the escape side and the route
    // were all chosen for the old one and none of them means anything now --
    // inheriting them is what makes a ship reverse to get back onto a ring it
    // planned around something else.
    clearKiteSteering(runtime);
    runtime.kiteTargetId = targetId;
  }
  runtime.kiteSteering = true;

  const profile = combat().mainBatteryProfile(ship);
  const geometry = engagementGeometry(ship, target);
  const distance = geometry.distance;
  const ranges = kiteRanges(profile.standoffRange, geometry.contact);
  const toggles = movementToggles(ship);

  const attackPoint = targetAttackPointFrom(ship.x || 0, ship.y || 0, target);
  let awayX = (ship.x || 0) - attackPoint.x;
  let awayY = (ship.y || 0) - attackPoint.y;
  if (!(fastHypot(awayX, awayY) > BEARING_MIN_DISTANCE)) {
    // Standing on the target: there is no radial to work from, so take one off
    // the nose and let the band push the ship out along it.
    awayX = Math.cos(ship.angle || 0);
    awayY = Math.sin(ship.angle || 0);
  }
  const awayBearing = Math.atan2(awayY, awayX);

  const radial = radialSeparationSpeed(ship, target, distance);
  const predicted = kitePredictedDistance(ship, target, distance);
  const pressed = kiteUnderPressure(ranges, distance, predicted, radial);

  // --- Mode ---------------------------------------------------------------
  //
  // The hysteresis is in the two "keep doing what you were doing" clauses: a
  // retreat runs until the preferred range is back, not until the inner one is
  // scraped, and an approach closes to preferred rather than releasing the
  // moment the outer band is crossed. Without them a one-pixel range change at
  // a band edge flips the mode every tick.
  const previousMode = runtime.kiteMode;
  let mode;
  if (pressed) mode = "retreat";
  else if (previousMode === "retreat" && distance < ranges.preferred) mode = "retreat";
  else if (distance > ranges.outer) mode = toggles.pursue ? "approach" : "maintain";
  else if (previousMode === "approach" && toggles.pursue && distance > ranges.preferred) mode = "approach";
  else mode = "maintain";
  // Line of sight is a reason to move somewhere else, never a reason to close.
  // It is also only ever asked once the ship is not being pressed: running from
  // something at knife range matters more than being able to see it.
  if (mode === "maintain" && !currentFiringLineClear(room, ship, target)) mode = "reposition";

  // --- Approach and reposition -------------------------------------------
  //
  // Both are "go and stand somewhere useful", which is the problem the shared
  // firing-position search already solves: a reachable point at the band's
  // preferred range with a clear line to the target, chosen on the side of the
  // target this ship already occupies. The route planner flies the hull there
  // nose-first; the weapon-facing heading takes over once the band is reached.
  if (mode === "approach" || mode === "reposition") {
    runtime.kiteMode = mode;
    runtime.kiteDirect = false;
    runtime.kitePlan = null;
    runtime.kiteHeading = null;
    runtime.kiteSpeedLimit = kiteBrakingCeiling(room, ship, stats);
    const destination = reachableFiringPosition(
      room, ship, target, runtime, ranges.preferred, ranges.preferred, now
    );
    if (destination) {
      runtime.destination = destination;
      runtime.blocked = false;
      return;
    }
    runtime.kiteMode = "blocked";
    runtime.kiteSpeedLimit = 0;
    runtime.destination = null;
    runtime.blocked = true;
    clearRoute(runtime);
    return;
  }

  // --- Retreat and maintain ----------------------------------------------
  const available = kiteAvailableSpeed(ship, stats);
  const need = kiteDesiredOpeningSpeed(mode, ranges, distance, radial, available, toggles);
  const inset = kiteEdgeInset(ship);
  const clearance = routeClearance(ship);
  const context = {
    mode,
    need,
    ranges,
    profile,
    awayBearing,
    hullAngle: ship.angle || 0,
    inwardBearing: kiteInwardBearing(room, ship),
    edgePressure: kiteEdgePressure(room, ship, inset),
    escapeSide: Number(runtime.kiteEscapeSide) || 0
  };

  const existing = runtime.kitePlan;
  const targetMoved = existing
    ? fastHypot(
      (Number(target.x) || 0) - (Number(existing.targetX) || 0),
      (Number(target.y) || 0) - (Number(existing.targetY) || 0)
    )
    : Infinity;
  let plan = existing
    && existing.targetId === targetId
    && existing.mode === mode
    && now < (Number(existing.replanAt) || 0)
    && targetMoved <= KITE_TARGET_MOVE_REPLAN
    ? existing
    : null;

  // A committed plan is re-checked on a cadence, never per tick. What makes the
  // delay safe is the braking ceiling below, which is evaluated every tick
  // against the direction the hull is actually travelling.
  if (plan && now >= (Number(runtime.kiteScanAt) || 0)) {
    runtime.kiteScanAt = now + KITE_CLEAR_SCAN_MS;
    if (!kitePlanFlyable(room, ship, plan, inset, clearance)) plan = null;
  }

  if (!plan && now >= (Number(runtime.kiteReplanAt) || 0)) {
    // chooseKitePlan carries the heading hysteresis itself, against the heading
    // in the runtime, so a replan that finds nothing materially better returns
    // the heading already being flown rather than a new one.
    plan = chooseKitePlan(room, ship, runtime, target, stats, mode, context, now);
    if (plan) {
      runtime.kiteScanAt = now + KITE_CLEAR_SCAN_MS;
    } else {
      runtime.kiteReplanAt = now + KITE_BLOCKED_RETRY_MS;
      // Nothing new could be found, but a plan that is merely due for review and
      // is still flyable is better than stopping. Keep flying it and try again
      // on the retry cadence -- this is what stops a ship halfway round an
      // obstacle abandoning its detour because the moment was briefly awkward.
      if (existing
        && existing.targetId === targetId
        && existing.mode === mode
        && kitePlanFlyable(room, ship, existing, inset, clearance)) {
        existing.replanAt = now + KITE_BLOCKED_RETRY_MS;
        plan = existing;
      }
    }
  }

  // A clear Kite aim point is a moving tactical bearing, not a place: it is
  // regenerated ahead of the hull every tick and never reached, so arrival
  // braking must not apply to it. A committed detour is the opposite -- a real
  // routed destination with the ordinary corner and arrival limits in force.
  //
  // Regenerating it is not a free extension of the old one. The hull has moved
  // since the plan was made, so the same heading now runs out of map sooner;
  // pushing the point out blindly is exactly how an aim point ends up outside
  // the navigable inset and steers a ship at the wall. It is clipped to the run
  // the inset still allows, and a run too short to be worth flying retires the
  // plan on the spot rather than next time the cadence comes round.
  if (plan && plan.direct) {
    const run = Math.min(
      kiteEscapeLookahead(ship, stats),
      kiteInsetRun(room, ship, plan.heading, inset)
    );
    if (run >= clearance * 2) plan.destination = kiteProjectedPoint(ship, plan.heading, run);
    else plan = null;
  }

  if (!plan) {
    // Nowhere safe to go. Brake, keep whatever heading was last chosen so the
    // guns that still bear go on bearing, and look again on the retry cadence.
    // Driving on would be driving into the obstacle.
    runtime.kiteMode = "blocked";
    runtime.kitePlan = null;
    runtime.kiteDirect = false;
    runtime.kiteSpeedLimit = 0;
    runtime.destination = null;
    runtime.blocked = true;
    // Not a backoff: an aim point that ran out of map is a reason to choose a
    // new heading immediately, and the mode-and-target gate above already stops
    // that becoming a per-tick search.
    runtime.kiteReplanAt = 0;
    clearRoute(runtime);
    return;
  }

  runtime.kitePlan = plan;
  runtime.kiteMode = mode;
  runtime.kiteHeading = plan.heading;
  runtime.kiteEscapeSide = plan.escapeSide;
  runtime.blocked = false;
  runtime.kiteReplanAt = 0;
  runtime.destination = { x: plan.destination.x, y: plan.destination.y };
  runtime.kiteDirect = Boolean(plan.direct);

  const projection = Math.cos(angleDifference(awayBearing, plan.heading));
  const desired = kiteForwardSpeed(need, projection, available);
  if (!(desired > REST_SPEED)) {
    // The CONTROLLER is asking for no travel -- the range is where it wants it,
    // or Pursue is off and the target has simply left. Hold station on the
    // chosen heading: a null destination is what makes planMovement park the
    // hull and point it, and pointing it is still the whole job.
    //
    // Deliberately distinct from the braking ceiling below pulling the speed to
    // zero, which is an instruction to slow down, not to stop wanting to go
    // anywhere. Conflating the two makes a pinched ship alternate between
    // "accelerate" and "park", which cancels its own escape velocity every
    // other tick and holds it against the obstacle indefinitely.
    runtime.destination = null;
    runtime.kiteDirect = false;
    runtime.kiteSpeedLimit = 0;
    clearRoute(runtime);
    return;
  }
  runtime.kiteSpeedLimit = Math.min(desired, kiteBrakingCeiling(room, ship, stats));
}

module.exports = {
  clearKiteSteering,
  kiteRangeBand,
  planKite
};
