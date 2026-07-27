"use strict";

// Deterministic static navigation: point/segment clearance, grid A* path planning,
// and path smoothing.  Used by the authoritative movement controller.

const { fastHypot, clampNumber } = require("./utils");

const WORLD_MARGIN = 42;
const NAV_SAFETY_MARGIN = 8;
const PATH_REPLAN_INTERVAL_MS = 150;
const WAYPOINT_CAPTURE = 24;
const WAYPOINT_CAPTURE_SQ = WAYPOINT_CAPTURE * WAYPOINT_CAPTURE;
const MAX_ASTEROID_INFLATE_MARGIN = 24;
const A_STAR_ITER_LIMIT = 20000;

function physicalCollisionRadius(ship) {
  return clampNumber((ship.radius || 0) * 0.56, 18, 48);
}

function navigationClearanceRadius(ship) {
  return physicalCollisionRadius(ship) + NAV_SAFETY_MARGIN;
}

function roomMaxAsteroidRadius(room) {
  const map = room?.map || null;
  const source = map?.asteroids || [];
  const revision = room?.asteroidRevision ?? map?.asteroidRevision ?? map?.revision ?? room?.mapRevision ?? 0;
  const cache = room?._maxAsteroidCache;
  if (cache && cache.source === source && cache.revision === revision) return cache.radius;
  let radius = 0;
  for (const asteroid of source) {
    const r = Number(asteroid?.radius) || 0;
    if (r > radius) radius = r;
  }
  if (!room) return 0;
  room._maxAsteroidCache = { source, revision, radius };
  return radius;
}

function isPointClear(room, x, y, clearance) {
  if (x < WORLD_MARGIN + clearance || x > room.world.width - WORLD_MARGIN - clearance) return false;
  if (y < WORLD_MARGIN + clearance || y > room.world.height - WORLD_MARGIN - clearance) return false;
  const index = room.spatialIndex;
  if (index?.dynamicValid) {
    const maxR = roomMaxAsteroidRadius(room);
    const scratch = [];
    const candidates = index.queryRangeUnordered("asteroids", x, y, clearance + maxR, scratch);
    for (const a of candidates) {
      if (a && fastHypot(x - a.x, y - a.y) < a.radius + clearance) return false;
    }
  } else {
    for (const a of room.map?.asteroids || []) {
      if (a && fastHypot(x - a.x, y - a.y) < a.radius + clearance) return false;
    }
  }
  return true;
}

function isSegmentClear(room, x1, y1, x2, y2, clearance) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = fastHypot(dx, dy);
  if (len < 0.001) return isPointClear(room, x1, y1, clearance);
  const ux = dx / len;
  const uy = dy / len;
  const index = room.spatialIndex;
  const candidates = index?.dynamicValid
    ? index.querySweptAabbUnordered("asteroids", x1, y1, x2, y2, clearance + roomMaxAsteroidRadius(room), [])
    : (room.map?.asteroids || []);
  for (const a of candidates) {
    if (!a) continue;
    const relX = a.x - x1;
    const relY = a.y - y1;
    const along = relX * ux + relY * uy;
    const clampedAlong = clampNumber(along, 0, len);
    const closestX = x1 + ux * clampedAlong;
    const closestY = y1 + uy * clampedAlong;
    const d = fastHypot(a.x - closestX, a.y - closestY);
    if (d < a.radius + clearance) return false;
  }
  return true;
}

function ensurePathState(ship) {
  if (!ship._movementPath) {
    ship._movementPath = {
      waypoints: null,
      goalX: null,
      goalY: null,
      replannedAt: 0,
      committedSide: null
    };
  }
  return ship._movementPath;
}

function computeCellSize(clearance) {
  return Math.max(24, clearance * 0.65);
}

function buildBlockedCells(room, ship, clearance, minX, minY, cellSize, countX, countY) {
  const blocked = new Set();
  const index = room.spatialIndex;
  const maxR = roomMaxAsteroidRadius(room);
  const centerX = minX + countX * cellSize * 0.5;
  const centerY = minY + countY * cellSize * 0.5;
  const halfW = countX * cellSize * 0.5 + maxR + clearance + MAX_ASTEROID_INFLATE_MARGIN;
  const halfH = countY * cellSize * 0.5 + maxR + clearance + MAX_ASTEROID_INFLATE_MARGIN;
  const candidates = index?.dynamicValid
    ? index.queryAabbUnordered("asteroids", centerX - halfW, centerY - halfH, centerX + halfW, centerY + halfH, [])
    : (room.map?.asteroids || []);

  for (const a of candidates) {
    if (!a) continue;
    const inflate = a.radius + clearance + cellSize;
    const cMinX = Math.floor((a.x - inflate - minX) / cellSize);
    const cMaxX = Math.floor((a.x + inflate - minX) / cellSize);
    const cMinY = Math.floor((a.y - inflate - minY) / cellSize);
    const cMaxY = Math.floor((a.y + inflate - minY) / cellSize);
    const loX = Math.max(0, cMinX);
    const hiX = Math.min(countX - 1, cMaxX);
    const loY = Math.max(0, cMinY);
    const hiY = Math.min(countY - 1, cMaxY);
    for (let cx = loX; cx <= hiX; cx++) {
      for (let cy = loY; cy <= hiY; cy++) {
        const cxWorld = minX + (cx + 0.5) * cellSize;
        const cyWorld = minY + (cy + 0.5) * cellSize;
        if (fastHypot(cxWorld - a.x, cyWorld - a.y) < a.radius + clearance + cellSize * 0.65) {
          blocked.add(`${cx},${cy}`);
        }
      }
    }
  }

  for (let cx = 0; cx < countX; cx++) {
    for (let cy = 0; cy < countY; cy++) {
      const wx = minX + (cx + 0.5) * cellSize;
      const wy = minY + (cy + 0.5) * cellSize;
      if (wx < WORLD_MARGIN + clearance || wx > room.world.width - WORLD_MARGIN - clearance ||
          wy < WORLD_MARGIN + clearance || wy > room.world.height - WORLD_MARGIN - clearance) {
        blocked.add(`${cx},${cy}`);
      }
    }
  }

  return blocked;
}

function heuristic(cx, cy, gx, gy, cellSize) {
  const dx = cx - gx;
  const dy = cy - gy;
  return cellSize * fastHypot(dx, dy);
}

function reconstructPath(cameFrom, startKey, goalKey, minX, minY, cellSize) {
  const path = [];
  let key = goalKey;
  while (key !== undefined) {
    const [cx, cy] = key.split(",").map(Number);
    const x = minX + (cx + 0.5) * cellSize;
    const y = minY + (cy + 0.5) * cellSize;
    path.push({ x, y });
    key = cameFrom.get(key);
  }
  path.reverse();
  return path;
}

function aStarGrid(room, ship, startX, startY, goalX, goalY, clearance) {
  const cellSize = computeCellSize(clearance);
  const minX = WORLD_MARGIN + clearance;
  const minY = WORLD_MARGIN + clearance;
  const maxX = room.world.width - WORLD_MARGIN - clearance;
  const maxY = room.world.height - WORLD_MARGIN - clearance;
  const countX = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const countY = Math.max(1, Math.ceil((maxY - minY) / cellSize));

  const startCellX = Math.max(0, Math.min(countX - 1, Math.floor((startX - minX) / cellSize)));
  const startCellY = Math.max(0, Math.min(countY - 1, Math.floor((startY - minY) / cellSize)));
  const goalCellX = Math.max(0, Math.min(countX - 1, Math.floor((goalX - minX) / cellSize)));
  const goalCellY = Math.max(0, Math.min(countY - 1, Math.floor((goalY - minY) / cellSize)));

  const blocked = buildBlockedCells(room, ship, clearance, minX, minY, cellSize, countX, countY);

  const startKey = `${startCellX},${startCellY}`;
  const goalKey = `${goalCellX},${goalCellY}`;

  if (blocked.has(startKey) || blocked.has(goalKey)) {
    return null;
  }

  const cameFrom = new Map();
  const gScore = new Map();
  const fScore = new Map();
  const open = [];

  gScore.set(startKey, 0);
  fScore.set(startKey, heuristic(startCellX, startCellY, goalCellX, goalCellY, cellSize));
  open.push(startKey);

  const neighbors = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
  ];

  let iterations = 0;
  while (open.length > 0 && iterations < A_STAR_ITER_LIMIT) {
    iterations++;
    let bestIdx = 0;
    let bestF = Infinity;
    for (let i = 0; i < open.length; i++) {
      const f = fScore.get(open[i]) ?? Infinity;
      if (f < bestF) { bestF = f; bestIdx = i; }
    }
    const current = open[bestIdx];
    open.splice(bestIdx, 1);

    if (current === goalKey) {
      return reconstructPath(cameFrom, startKey, goalKey, minX, minY, cellSize);
    }

    const [cx, cy] = current.split(",").map(Number);
    const currentG = gScore.get(current) ?? Infinity;

    for (const [dx, dy, cost] of neighbors) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= countX || ny < 0 || ny >= countY) continue;
      const nKey = `${nx},${ny}`;
      if (blocked.has(nKey)) continue;
      const tentative = currentG + cellSize * cost;
      const existing = gScore.get(nKey) ?? Infinity;
      if (tentative < existing) {
        cameFrom.set(nKey, current);
        gScore.set(nKey, tentative);
        fScore.set(nKey, tentative + heuristic(nx, ny, goalCellX, goalCellY, cellSize));
        open.push(nKey);
      }
    }
  }

  return null;
}

function smoothPath(room, ship, rawPath, clearance) {
  if (rawPath.length < 3) return rawPath;
  const out = [rawPath[0]];
  let i = 0;
  while (i < rawPath.length - 1) {
    let j = rawPath.length - 1;
    for (; j > i + 1; j--) {
      if (isSegmentClear(room, rawPath[i].x, rawPath[i].y, rawPath[j].x, rawPath[j].y, clearance)) break;
    }
    out.push(rawPath[j]);
    i = j;
  }
  return out;
}

function planRoute(room, ship, startX, startY, goalX, goalY, clearance) {
  const raw = aStarGrid(room, ship, startX, startY, goalX, goalY, clearance);
  if (!raw || raw.length < 2) {
    return { waypoints: [], reason: "blocked-destination" };
  }
  const smooth = smoothPath(room, ship, raw, clearance);
  return { waypoints: smooth.slice(1), reason: "waypoint-route" };
}

function computePathDesiredAngle(room, ship) {
  const goalX = ship.targetX;
  const goalY = ship.targetY;
  const startX = ship.x;
  const startY = ship.y;
  const clearance = navigationClearanceRadius(ship);
  const path = ensurePathState(ship);
  const now = ship._simNow || 0;

  if (isSegmentClear(room, startX, startY, goalX, goalY, clearance)) {
    path.waypoints = null;
    path.goalX = goalX;
    path.goalY = goalY;
    path.replannedAt = now;
    if (ship._movementDebug) ship._movementDebug.pathReason = "direct-route";
    return Math.atan2(goalY - startY, goalX - startX);
  }

  const goalChanged = path.goalX !== goalX || path.goalY !== goalY;
  const noCache = !path.waypoints;
  const stale = now - path.replannedAt > PATH_REPLAN_INTERVAL_MS;
  let needsReplan = goalChanged || noCache || stale;

  if (!needsReplan && path.waypoints) {
    while (path.waypoints.length > 1) {
      const wp = path.waypoints[0];
      const dSq = (startX - wp.x) * (startX - wp.x) + (startY - wp.y) * (startY - wp.y);
      if (dSq > WAYPOINT_CAPTURE_SQ) break;
      path.waypoints.shift();
    }
    const next = path.waypoints[0];
    if (!next || !isSegmentClear(room, startX, startY, next.x, next.y, clearance)) {
      needsReplan = true;
    }
  }

  if (needsReplan) {
    const route = planRoute(room, ship, startX, startY, goalX, goalY, clearance);
    path.waypoints = route.waypoints;
    path.goalX = goalX;
    path.goalY = goalY;
    path.replannedAt = now;
    if (ship._movementDebug) ship._movementDebug.pathReason = route.reason;
  }

  if (!path.waypoints || path.waypoints.length === 0) {
    return Math.atan2(goalY - startY, goalX - startX);
  }

  const next = path.waypoints[0];
  return Math.atan2(next.y - startY, next.x - startX);
}

module.exports = {
  navigationClearanceRadius,
  physicalCollisionRadius,
  isPointClear,
  isSegmentClear,
  computePathDesiredAngle,
  ensurePathState,
  planRoute
};
