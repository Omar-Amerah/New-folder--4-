"use strict";

const { clampNumber, fastHypot } = require("./utils");
const {
  NAV_GRID_CELL_SIZE,
  NAV_PROGRESS_EPSILON,
  NAV_REPLAN_CHARGE_THRESHOLD,
  NAV_REPLAN_COMBAT_THRESHOLD,
  NAV_REPLAN_MOVE_THRESHOLD,
  NAV_STUCK_TIME_MS,
  NAV_WAYPOINT_CAPTURE_RATIO,
  WORLD_MARGIN
} = require("./movementTuning");
const { navigationClearanceRadius } = require("./movementCollision");
const { bumpMovementMetric } = require("./movementMetrics");
const { ensureMovementRuntime } = require("./movementRuntime");
const { isSegmentStationClear } = require("./stationCollision");

// Stations are solid: resolveStationCollision pushes any hull that touches one
// back out. Until they were added here the navigator could not see them at all,
// so a routed path ran straight through a home station and the mover spent the
// crossing being shoved sideways by the collision solver. Everything that is
// physically solid has to be navigationally solid too, or the two disagree and
// the ship grinds along the hull. No state filter, for exactly that reason:
// resolveStationCollision does not filter either, so a disabled wreck is still
// an obstacle to both.
function stationCollisionPieces(room) {
  const pieces = [];
  for (const station of room?.stations || []) {
    for (const piece of station?.collisionPieces || []) {
      if (piece) pieces.push(piece);
    }
  }
  return pieces;
}

// Cheap identity for the structure set. Stations never move once placed, so the
// piece count changing is the only thing that can alter the grid.
function stationSignature(room) {
  let count = 0;
  for (const station of room?.stations || []) count += station?.collisionPieces?.length || 0;
  return count;
}

// Signed distance from a point to a rotated rectangle: positive outside,
// negative inside, so it drops into the same "clearance" min as an asteroid.
function boxClearance(x, y, piece) {
  const cos = Math.cos(-(piece.angle || 0));
  const sin = Math.sin(-(piece.angle || 0));
  const dx = x - piece.x;
  const dy = y - piece.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  const halfWidth = piece.halfWidth || 0;
  const halfHeight = piece.halfHeight || 0;
  const outX = Math.abs(localX) - halfWidth;
  const outY = Math.abs(localY) - halfHeight;
  if (outX <= 0 && outY <= 0) return -Math.min(-outX, -outY);
  return fastHypot(Math.max(outX, 0), Math.max(outY, 0));
}

// Past this distance a structure can no longer be the binding constraint on any
// ship's clearance, so cells beyond it keep whatever the asteroids and walls
// gave them. Bounding the sweep this way keeps the rebuild proportional to the
// area the stations actually cover rather than to the whole map times the piece
// count.
const NAV_STATION_INFLUENCE = 260;

function applyStationClearance(room, nav) {
  const pieces = stationCollisionPieces(room);
  if (pieces.length === 0) return;
  const { cellSize, cols, rows, cells } = nav;
  for (const piece of pieces) {
    const reach = fastHypot(piece.halfWidth || 0, piece.halfHeight || 0) + NAV_STATION_INFLUENCE;
    const minCol = Math.max(0, Math.floor((piece.x - reach) / cellSize));
    const maxCol = Math.min(cols - 1, Math.floor((piece.x + reach) / cellSize));
    const minRow = Math.max(0, Math.floor((piece.y - reach) / cellSize));
    const maxRow = Math.min(rows - 1, Math.floor((piece.y + reach) / cellSize));
    for (let col = minCol; col <= maxCol; col += 1) {
      const x = col * cellSize + cellSize / 2;
      for (let row = minRow; row <= maxRow; row += 1) {
        const index = row * cols + col;
        const distance = boxClearance(x, row * cellSize + cellSize / 2, piece);
        if (distance < cells[index]) cells[index] = distance;
      }
    }
  }
}

function ensureRoomNavigation(room) {
  const map = room?.map || null;
  const asteroids = map?.asteroids || [];
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const revision = room?.mapRevision ?? map?.revision ?? 0;
  const stations = stationSignature(room);
  if (room?._movementNav
    && room._movementNav.revision === revision
    && room._movementNav.width === width
    && room._movementNav.height === height
    && room._movementNav.asteroidRef === asteroids
    && room._movementNav.stationSignature === stations) {
    return room._movementNav;
  }
  const cellSize = NAV_GRID_CELL_SIZE;
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const cells = new Float32Array(cols * rows);
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < rows; row += 1) {
      const x = col * cellSize + cellSize / 2;
      const y = row * cellSize + cellSize / 2;
      let clearance = Math.min(
        x - WORLD_MARGIN,
        y - WORLD_MARGIN,
        width - WORLD_MARGIN - x,
        height - WORLD_MARGIN - y
      );
      for (const asteroid of asteroids) {
        if (!asteroid) continue;
        const distance = fastHypot(x - asteroid.x, y - asteroid.y)
          - (asteroid.radius || 0);
        if (distance < clearance) clearance = distance;
      }
      cells[row * cols + col] = clearance;
    }
  }
  room._movementNav = {
    width,
    height,
    cellSize,
    cols,
    rows,
    cells,
    revision,
    asteroidRef: asteroids,
    stationSignature: stations
  };
  applyStationClearance(room, room._movementNav);
  return room._movementNav;
}

function cellFor(nav, x, y) {
  const col = clampNumber(Math.floor(x / nav.cellSize), 0, nav.cols - 1);
  const row = clampNumber(Math.floor(y / nav.cellSize), 0, nav.rows - 1);
  return { col, row, index: row * nav.cols + col };
}

function cellCenter(nav, col, row) {
  return {
    x: col * nav.cellSize + nav.cellSize / 2,
    y: row * nav.cellSize + nav.cellSize / 2
  };
}

function cellClearanceAt(nav, x, y) {
  return nav.cells[cellFor(nav, x, y).index];
}

function nearestClearCell(nav, startX, startY, clearance) {
  const start = cellFor(nav, startX, startY);
  if (nav.cells[start.index] >= clearance) return cellCenter(nav, start.col, start.row);
  const visited = new Uint8Array(nav.cols * nav.rows);
  const queue = [start.col, start.row];
  const directions = [
    [0, -1], [1, -1], [1, 0], [1, 1],
    [0, 1], [-1, 1], [-1, 0], [-1, -1]
  ];
  let queueIndex = 0;
  visited[start.index] = 1;
  while (queueIndex < queue.length) {
    const col = queue[queueIndex++];
    const row = queue[queueIndex++];
    const index = row * nav.cols + col;
    if (nav.cells[index] >= clearance) return cellCenter(nav, col, row);
    for (const [dx, dy] of directions) {
      const nextCol = col + dx;
      const nextRow = row + dy;
      if (nextCol < 0 || nextCol >= nav.cols || nextRow < 0 || nextRow >= nav.rows) continue;
      const nextIndex = nextRow * nav.cols + nextCol;
      if (visited[nextIndex]) continue;
      visited[nextIndex] = 1;
      queue.push(nextCol, nextRow);
    }
  }
  return null;
}

function nearestClearPoint(room, x, y, clearance) {
  const nav = ensureRoomNavigation(room);
  const width = room?.world?.width || nav.width;
  const height = room?.world?.height || nav.height;
  const startX = clampNumber(Number(x) || width * 0.5, WORLD_MARGIN, width - WORLD_MARGIN);
  const startY = clampNumber(Number(y) || height * 0.5, WORLD_MARGIN, height - WORLD_MARGIN);
  const start = cellFor(nav, startX, startY);
  if (nav.cells[start.index] >= clearance) {
    return {
      x: startX,
      y: startY,
      adjusted: false,
      passes: 0,
      clear: true,
      reason: "clear"
    };
  }
  const clear = nearestClearCell(nav, startX, startY, clearance);
  if (clear) {
    return {
      x: clear.x,
      y: clear.y,
      adjusted: true,
      passes: 1,
      clear: true,
      reason: "adjusted"
    };
  }
  return {
    x: startX,
    y: startY,
    adjusted: false,
    passes: 0,
    clear: false,
    reason: "blocked"
  };
}

function segmentCircleClearance(x1, y1, x2, y2, centerX, centerY, radius) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = fastHypot(dx, dy);
  if (length < 0.001) {
    return {
      blocked: fastHypot(centerX - x1, centerY - y1) < radius,
      along: 0,
      lateral: 0
    };
  }
  const unitX = dx / length;
  const unitY = dy / length;
  const relativeX = centerX - x1;
  const relativeY = centerY - y1;
  const along = relativeX * unitX + relativeY * unitY;
  const closestX = x1 + unitX * clampNumber(along, 0, length);
  const closestY = y1 + unitY * clampNumber(along, 0, length);
  return {
    blocked: fastHypot(centerX - closestX, centerY - closestY) < radius,
    along,
    lateral: relativeX * (-unitY) + relativeY * unitX
  };
}

function isStaticObstacleLineClear(room, x1, y1, x2, y2, clearance, options = null) {
  const scratch = room._segmentScratch || (room._segmentScratch = []);
  const authoritativeAsteroids = room.map?.asteroids || [];
  const index = room.spatialIndex;
  const indexedAsteroids = index?.dynamicValid
    && index.querySweptAabbUnordered
    && typeof index.count === "function"
    && index.count("asteroids") === authoritativeAsteroids.length;
  const asteroids = indexedAsteroids
    ? index.querySweptAabbUnordered(
      "asteroids",
      x1,
      y1,
      x2,
      y2,
      clearance,
      scratch
    )
    : authoritativeAsteroids;
  for (const asteroid of asteroids) {
    if (!asteroid) continue;
    if (segmentCircleClearance(
      x1,
      y1,
      x2,
      y2,
      asteroid.x,
      asteroid.y,
      (asteroid.radius || 0) + clearance
    ).blocked) return false;
  }
  return isSegmentStationClear(room, x1, y1, x2, y2, clearance, options);
}

function isSegmentClear(room, x1, y1, x2, y2, clearance) {
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  if (x1 < WORLD_MARGIN + clearance
    || x1 > width - WORLD_MARGIN - clearance
    || y1 < WORLD_MARGIN + clearance
    || y1 > height - WORLD_MARGIN - clearance
    || x2 < WORLD_MARGIN + clearance
    || x2 > width - WORLD_MARGIN - clearance
    || y2 < WORLD_MARGIN + clearance
    || y2 > height - WORLD_MARGIN - clearance) return false;
  return isStaticObstacleLineClear(room, x1, y1, x2, y2, clearance);
}

class BinaryHeap {
  constructor(compare) {
    this.heap = [];
    this.compare = compare;
  }

  get length() {
    return this.heap.length;
  }

  push(value) {
    this.heap.push(value);
    this.siftUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  siftUp(index) {
    const value = this.heap[index];
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.compare(value, this.heap[parent])) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = value;
  }

  siftDown(index) {
    const value = this.heap[index];
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) break;
      const right = left + 1;
      let child = left;
      if (right < this.heap.length && this.compare(this.heap[right], this.heap[left])) {
        child = right;
      }
      if (this.compare(value, this.heap[child])) break;
      this.heap[index] = this.heap[child];
      index = child;
    }
    this.heap[index] = value;
  }
}

function heuristic(nav, colA, rowA, colB, rowB) {
  const a = cellCenter(nav, colA, rowA);
  const b = cellCenter(nav, colB, rowB);
  return fastHypot(a.x - b.x, a.y - b.y);
}

// The search proper. Reports whether it actually got there, because "no route"
// and "a route" need different answers from the caller and collapsing them to
// null loses the half of the search that is still useful: the flood already
// knows the reachable cell nearest the goal, which is exactly where a ship that
// cannot arrive should go instead.
function searchPathWorld(room, startX, startY, goalX, goalY, clearance) {
  bumpMovementMetric("pathPlanCount");
  const nav = ensureRoomNavigation(room);
  const startClear = nearestClearPoint(room, startX, startY, clearance + nav.cellSize / 2);
  const goalClear = nearestClearPoint(room, goalX, goalY, clearance + nav.cellSize / 2);
  if (!goalClear.clear) return {
    waypoints: [],
    reachedGoal: false,
    requestedGoal: { x: goalX, y: goalY },
    terminal: null,
    adjustedGoal: false
  };
  const start = cellFor(nav, startClear.x, startClear.y);
  const goal = cellFor(nav, goalClear.x, goalClear.y);
  const size = nav.cols * nav.rows;
  const scores = new Float64Array(size);
  const parents = new Int32Array(size);
  scores.fill(Infinity);
  parents.fill(-1);
  scores[start.index] = 0;
  let order = 0;
  const open = new BinaryHeap((a, b) => a.score < b.score
    || (a.score === b.score && a.order < b.order));
  open.push({
    score: heuristic(nav, start.col, start.row, goal.col, goal.row),
    index: start.index,
    order: ++order
  });
  const directions = [
    [1, 0, 1], [0, 1, 1], [-1, 0, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2]
  ];
  const required = clearance + nav.cellSize / 2;
  // Best consolation prize seen so far: the settled cell closest to the goal.
  // Costs one heuristic per expansion and is what makes an unreachable
  // destination produce a sane partial route rather than nothing.
  let closestIndex = start.index;
  let closestHeuristic = heuristic(nav, start.col, start.row, goal.col, goal.row);
  let reachedSearchCell = false;
  while (open.length > 0) {
    const node = open.pop();
    if (node.index === goal.index) {
      reachedSearchCell = true;
      break;
    }
    const row = Math.floor(node.index / nav.cols);
    const col = node.index % nav.cols;
    const remaining = heuristic(nav, col, row, goal.col, goal.row);
    if (remaining < closestHeuristic) {
      closestHeuristic = remaining;
      closestIndex = node.index;
    }
    for (const [dx, dy, distanceMultiplier] of directions) {
      const nextCol = col + dx;
      const nextRow = row + dy;
      if (nextCol < 0 || nextCol >= nav.cols || nextRow < 0 || nextRow >= nav.rows) continue;
      const nextIndex = nextRow * nav.cols + nextCol;
      if (nav.cells[nextIndex] < required) continue;
      if (distanceMultiplier !== 1) {
        const horizontalIndex = row * nav.cols + nextCol;
        const verticalIndex = nextRow * nav.cols + col;
        if (nav.cells[horizontalIndex] < required || nav.cells[verticalIndex] < required) continue;
      }
      const score = scores[node.index] + distanceMultiplier * nav.cellSize;
      if (score >= scores[nextIndex] - 1e-9) continue;
      scores[nextIndex] = score;
      parents[nextIndex] = node.index;
      open.push({
        score: score + heuristic(nav, nextCol, nextRow, goal.col, goal.row),
        index: nextIndex,
        order: ++order
      });
    }
  }
  const reachedGoal = reachedSearchCell && !goalClear.adjusted;
  const terminalIndex = reachedSearchCell ? goal.index : closestIndex;
  const raw = [];
  let index = terminalIndex;
  while (index !== -1) {
    const row = Math.floor(index / nav.cols);
    const col = index % nav.cols;
    raw.push(cellCenter(nav, col, row));
    index = parents[index];
  }
  raw.reverse();
  const smoothed = [raw[0]];
  let anchor = 0;
  while (anchor < raw.length - 1) {
    let candidate = raw.length - 1;
    while (candidate > anchor + 1
      && !isSegmentClear(
        room,
        smoothed[smoothed.length - 1].x,
        smoothed[smoothed.length - 1].y,
        raw[candidate].x,
        raw[candidate].y,
        clearance
      )) {
      candidate -= 1;
    }
    smoothed.push(raw[candidate]);
    anchor = candidate;
  }
  // Only a route that arrives may end on the requested point. A partial one ends
  // on the cell the search actually settled, which is already the last entry.
  if (reachedGoal) smoothed[smoothed.length - 1] = { x: goalX, y: goalY };
  const terminal = smoothed[smoothed.length - 1] || null;
  return {
    waypoints: smoothed,
    reachedGoal,
    requestedGoal: { x: goalX, y: goalY },
    terminal: terminal ? { x: terminal.x, y: terminal.y } : null,
    adjustedGoal: Boolean(goalClear.adjusted)
  };
}

// Full routes only, for callers that want "is there a way through" rather than
// "how close can this hull get".
function findPathWorld(room, startX, startY, goalX, goalY, clearance) {
  const result = searchPathWorld(room, startX, startY, goalX, goalY, clearance);
  return result.reachedGoal ? result.waypoints : null;
}

// The clearance the planner will demand of a destination. Anything that picks a
// point for a ship to be sent to has to use this and not the bare hull
// clearance: the grid is sampled at cell centres, so the search needs half a
// cell more than the hull does, and a destination legal by the looser test is
// one the planner then quietly relocates -- leaving the ship parked somewhere
// the player never clicked while the order marker sits elsewhere.
function navigationPlanningClearance(ship) {
  return navigationClearanceRadius(ship) + NAV_GRID_CELL_SIZE / 2;
}

function planPath(room, ship, destination, now) {
  const runtime = ensureMovementRuntime(ship);
  const navigation = runtime.navigation;
  const clearance = navigationClearanceRadius(ship);
  let waypoints;
  let reachable = true;
  if (isSegmentClear(room, ship.x, ship.y, destination.x, destination.y, clearance)) {
    waypoints = [{ x: destination.x, y: destination.y }];
  } else {
    const search = searchPathWorld(
      room,
      ship.x,
      ship.y,
      destination.x,
      destination.y,
      clearance
    );
    waypoints = search.waypoints;
    reachable = search.reachedGoal;
    // Nothing is routable at all -- the hull is too wide for anywhere it could
    // go from here. Hold station rather than invent a course.
    //
    // What this replaces: a straight line drawn to the destination whenever the
    // search failed. That line ran through whatever the search had just proved
    // impassable, so the ship drove into a station and stayed there being pushed
    // back out -- 95% of ticks in hull contact, a thousand pixels short, for as
    // long as the order stood. A route that does not exist must not be faked.
    if (!waypoints.length) {
      waypoints = [{ x: ship.x, y: ship.y }];
      reachable = false;
    }
  }
  const finalStart = waypoints.length > 1
    ? waypoints[waypoints.length - 2]
    : { x: ship.x, y: ship.y };
  const final = waypoints[waypoints.length - 1];
  const commandId = runtime.command?.id || `intent:${runtime.command?.type || "idle"}`;
  // The heading a ship ends on belongs to the order, not to whichever leg it
  // happened to be flying when the route was last recomputed. Replanning
  // mid-approach -- after an overshoot, say -- would otherwise derive the final
  // facing from the ship's current position and park it pointing an arbitrary
  // way. Keep the first answer for as long as the command stands.
  const keepFinalFacing = navigation.commandId === commandId
    && Number.isFinite(navigation.finalFacing);
  navigation.waypoints = waypoints;
  navigation.waypointIndex = 0;
  navigation.plannedDestination = { ...destination };
  navigation.plannedAt = now;
  navigation.commandId = commandId;
  navigation.clearance = clearance;
  navigation.reachable = reachable;
  if (!keepFinalFacing) {
    navigation.finalFacing = Math.atan2(final.y - finalStart.y, final.x - finalStart.x);
  }
  navigation.progressDistance = fastHypot(final.x - ship.x, final.y - ship.y);
  navigation.progressAt = now;
  bumpMovementMetric("pathReplanCount");
  if (!reachable) bumpMovementMetric("pathUnreachableCount");
  return navigation;
}

function waypointInvalid(room, navigation) {
  const index = clampNumber(
    navigation.waypointIndex || 0,
    0,
    Math.max(0, navigation.waypoints.length - 1)
  );
  const waypoint = navigation.waypoints[index];
  return waypoint
    && cellClearanceAt(ensureRoomNavigation(room), waypoint.x, waypoint.y)
      < navigation.clearance;
}

function replanThreshold(runtime, intent) {
  if (intent?.type === "charge") return NAV_REPLAN_CHARGE_THRESHOLD;
  return runtime.command?.type === "move"
    ? NAV_REPLAN_MOVE_THRESHOLD
    : NAV_REPLAN_COMBAT_THRESHOLD;
}

function shouldReplan(room, ship, destination, now, intent = null) {
  const runtime = ensureMovementRuntime(ship);
  const navigation = runtime.navigation;
  if (!navigation.waypoints?.length || !navigation.plannedDestination) return true;
  if (navigation.commandId !== (runtime.command?.id || `intent:${runtime.command?.type || "idle"}`)) {
    return true;
  }
  if (navigation.clearance !== navigationClearanceRadius(ship)) return true;
  const displacement = fastHypot(
    destination.x - navigation.plannedDestination.x,
    destination.y - navigation.plannedDestination.y
  );
  if (displacement > replanThreshold(runtime, intent)) return true;
  if (waypointInvalid(room, navigation)) return true;
  const index = clampNumber(
    navigation.waypointIndex || 0,
    0,
    Math.max(0, navigation.waypoints.length - 1)
  );
  const waypoint = navigation.waypoints[index];
  const distance = waypoint ? fastHypot(waypoint.x - ship.x, waypoint.y - ship.y) : 0;
  if (!Number.isFinite(navigation.progressDistance)
    || distance < navigation.progressDistance - NAV_PROGRESS_EPSILON) {
    navigation.progressDistance = distance;
    navigation.progressAt = now;
  }
  return distance > navigationClearanceRadius(ship)
    && now - (navigation.progressAt ?? now) > NAV_STUCK_TIME_MS;
}

function selectWaypoint(ship) {
  const navigation = ensureMovementRuntime(ship).navigation;
  const previousIndex = navigation.waypointIndex || 0;
  let index = clampNumber(
    previousIndex,
    0,
    Math.max(0, navigation.waypoints.length - 1)
  );
  const captureDistance = navigationClearanceRadius(ship) * NAV_WAYPOINT_CAPTURE_RATIO;
  while (index < navigation.waypoints.length - 1
    && fastHypot(
      ship.x - navigation.waypoints[index].x,
      ship.y - navigation.waypoints[index].y
    ) < captureDistance) {
    index += 1;
    bumpMovementMetric("waypointAdvanceCount");
  }
  navigation.waypointIndex = index;
  if (index !== previousIndex) {
    const next = navigation.waypoints[index];
    navigation.progressDistance = next
      ? fastHypot(next.x - ship.x, next.y - ship.y)
      : 0;
    navigation.progressAt = Number(ship._simNow) || navigation.plannedAt || 0;
  }
  return {
    goal: navigation.waypoints[index],
    isFinal: index === navigation.waypoints.length - 1,
    nextGoal: index < navigation.waypoints.length - 1
      ? navigation.waypoints[index + 1]
      : null,
    captureDistance,
    finalFacing: navigation.finalFacing,
    // False when the route stops short because the destination cannot be
    // reached. The mover still flies and arrives normally -- it just arrives
    // somewhere else, and callers that care can tell the difference.
    reachable: navigation.reachable !== false
  };
}

function resolveNavigation(room, ship, intent, now) {
  const runtime = ensureMovementRuntime(ship);
  if (!intent.destination) {
    runtime.navigation.waypoints = [];
    runtime.navigation.waypointIndex = 0;
    return {
      goal: null,
      isFinal: true,
      nextGoal: null,
      captureDistance: 0,
      finalFacing: runtime.command?.finalFacing,
      reachable: true
    };
  }
  if (shouldReplan(room, ship, intent.destination, now, intent)) {
    planPath(room, ship, intent.destination, now);
  } else {
    bumpMovementMetric("pathCacheHitCount");
  }
  const selected = selectWaypoint(ship);
  if (Number.isFinite(runtime.command?.finalFacing)) {
    selected.finalFacing = runtime.command.finalFacing;
  }
  return selected;
}

module.exports = {
  ensureRoomNavigation,
  findPathWorld,
  isSegmentClear,
  isSegmentStationClear,
  isStaticObstacleLineClear,
  navigationPlanningClearance,
  nearestClearPoint,
  resolveNavigation,
  searchPathWorld,
  segmentCircleClearance
};
