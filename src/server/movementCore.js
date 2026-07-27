"use strict";

const { clampNumber, rotateToward, angleDifference, fastHypot, performanceNow, hashString } = require("./utils");
const { PARTS } = require("./components");
const { findShipById } = require("./ships");
const { areEnemies, areAllies, moduleRotationToRadians, moduleLocalPosition, armedProximityChargeRanges, resolveDemolitionContacts, nearestDemolitionTargetPoint, shipHasOperationalDemolitionCharge } = require("./combat");
const { normalizeRotation } = require("./shipDesign");
const { addComponentHeat, componentPerformance } = require("./heat");
const { getCommandAuraMultiplier } = require("./commandAuras");
const { calculateDirectionalTurnInputs, calculateMovementPowerMultiplier, calculateMovementStats, maneuverThrusterTorqueSign } = require("../../public/src/shared/movementStats.js");
const { selectOwnedLivingShips } = require("./selection");
const { getComponentPowerMultiplier, effectiveShieldStats } = require("./componentPower");
const { getEffectiveWeaponStatsInternal, getEffectiveWeaponRanges } = require("./componentData");
const { getShipComponentIndexes } = require("./componentIndexes");
const { BALANCE } = require("./balanceConfig");

const WORLD_MARGIN = 42;
const EDGE_BOUNCE_MARGIN = 43;
const ARRIVE_DISTANCE = 16;
const ARRIVE_SPEED = 18;
const MAX_MOVEMENT_DT = 0.25;
const MOVEMENT_SUBSTEP = 1 / 30;

const FACING_DEAD_ZONE = 0.035;
const FACING_HYSTERESIS = 0.15;
const BROADSIDE_COMMIT_THRESHOLD = 0.5;
const HULL_ANGLE_BEARING_THRESHOLD = 4 * Math.PI / 180;
const HULL_ANGLE_REFRESH_INTERVAL = 250;

const NAV_GRID_CELL_SIZE = 24;
const NAV_REPLAN_MOVE_THRESHOLD = 60;
const NAV_REPLAN_COMBAT_THRESHOLD = 120;
const NAV_STUCK_TIME_MS = 1500;
const NAV_STUCK_RECOVERY_TIME_MS = 2500;

const HOLD_RANGE_RATIO = 0.9;
const CHARGE_RANGE_RATIO = 0.3;
const ORBIT_RANGE_RATIO = 0.75;
const MAINTAIN_RANGE_RATIO = 0.9;
const MAINTAIN_TOLERANCE = 0.05;
const KITE_RANGE_RATIO = 0.9;
const KITE_TOLERANCE = 0.05;
const INTERCEPTOR_RANGE_RATIO = 0.35;
const EVASIVE_RANGE_RATIO = 0.75;
const BRAWLER_RANGE_RATIO = 0.5;
const HEAVY_RANGE_RATIO = 0.85;

function movePerf() { return global.__mfaMovePerf || null; }
function moveBump(name) { const p = movePerf(); if (p) p[name] = (p[name] || 0) + 1; }

function physicalCollisionRadius(ship) { return Math.max(18, (ship.radius || 0) * 0.56); }
function navigationClearanceRadius(ship) { const p = physicalCollisionRadius(ship); const safety = Math.max(8, (ship.radius || 0) * 0.12); return p + safety; }
function separationRadius(ship) { return physicalCollisionRadius(ship) + 4; }

function heatAdjustedMovementStats(ship, stats) {
  const design = ship.design || [];
  const multiplier = (i) => (ship.componentHp?.[i] ?? 1) > 0 ? componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i) : 0;
  const engineThrustValues = [], engineMassValues = [];
  for (const i of getShipComponentIndexes(ship).thrustIndices) {
    const module = design[i];
    const part = PARTS[module.type] || {};
    const output = multiplier(i);
    if (output > 0 && (!ship.validEngineIndices || ship.validEngineIndices.has(i))) {
      engineThrustValues.push(part.thrust * output);
      engineMassValues.push(part.mass || 0);
    }
  }
  const directionalTurnInputs = calculateDirectionalTurnInputs(design, PARTS, {
    componentMultiplier: multiplier,
    isBlockedEngine: (i, module, part) => (part.thrust > 0 || module.type === "maneuverThruster" || module.type === "vectorThruster") && ship.validEngineIndices && !ship.validEngineIndices.has(i)
  });
  const movement = calculateMovementStats({
    mass: stats.mass, thrust: stats.thrust, turnBonus: 0,
    powerGeneration: stats.powerGeneration, powerUse: stats.powerUse,
    engineThrustValues, engineMassValues, directionalTurnInputs,
    hullControlThrust: BALANCE.movement?.hullControlThrust,
    movementPowerMultiplier: Math.max(1, calculateMovementPowerMultiplier(stats.powerGeneration || 0, stats.powerUse || 0))
  });
  const accelMult = getCommandAuraMultiplier(ship, "accelerationMultiplier");
  const turnMult = getCommandAuraMultiplier(ship, "turnRateMultiplier");
  if (Number.isFinite(movement.accel) && Number.isFinite(accelMult) && accelMult !== 1) movement.accel *= accelMult;
  if (Number.isFinite(movement.turnRate) && Number.isFinite(turnMult) && turnMult !== 1) { movement.turnRate *= turnMult; movement.turnRateLeft *= turnMult; movement.turnRateRight *= turnMult; }
  return { ...stats, ...movement };
}

function directionalTurnRate(stats, current, desired, ship) {
  const diff = angleDifference(current, desired);
  if (Math.abs(diff) < 1e-9) return 0;
  const base = diff > 0 ? (stats.turnRateRight ?? stats.turnRate ?? 0) : (stats.turnRateLeft ?? stats.turnRate ?? 0);
  const baseRate = Number.isFinite(base) ? base : 0;
  if (ship?.commandState === "backupCore") return baseRate * 0.90;
  return baseRate;
}

function rotateShipToward(ship, desired, stats, dt) {
  const before = ship.angle || 0;
  const diff = angleDifference(before, desired);
  if (Math.abs(diff) < FACING_DEAD_ZONE) { ship.turnActivity = 0; return; }
  const rate = directionalTurnRate(stats, before, desired, ship);
  const next = rotateToward(before, desired, rate * dt);
  ship.angle = next;
  const applied = Math.abs(angleDifference(before, next));
  const activity = rate > 0 ? clampNumber((applied / Math.max(rate * dt, 1e-9)) * Math.sign(angleDifference(before, next)), -1, 1) : 0;
  ship.turnActivity = Number.isFinite(activity) ? activity : 0;
  heatActiveManeuverThrusters(ship, activity, dt);
  heatActiveGyroscopes(ship, activity, dt);
}

function heatActiveManeuverThrusters(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  const desiredSign = Math.sign(turnActivity);
  const ex = ship.engineExhaustAnalysis;
  if (!ex) return;
  const cm = ex.centerOfMass;
  for (const i of getShipComponentIndexes(ship).maneuverThrusterIndices) {
    const module = ship.design[i];
    const part = PARTS[module.type];
    if (!part || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    if (!ex.validEngineIndices.has(i)) continue;
    if (maneuverThrusterTorqueSign(module, cm) !== desiredSign) continue;
    const perf = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
    if (perf > 0) addComponentHeat(ship, i, (2 + (part.lateralThrust || 0) * 0.018) * Math.abs(turnActivity) * perf * dt);
  }
}

function heatActiveGyroscopes(ship, turnActivity, dt) {
  if (!turnActivity || !Number.isFinite(turnActivity)) return;
  for (const i of getShipComponentIndexes(ship).gyroscopeIndices) {
    const part = PARTS[ship.design[i].type] || {};
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    const perf = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
    const rate = activityHeatRate("gyroscope", part);
    if (perf > 0 && rate > 0) addComponentHeat(ship, i, rate * Math.abs(turnActivity) * perf * dt);
  }
}

let _heatRules = null;
function heatRules() { return _heatRules || (_heatRules = require("../../public/src/shared/heatRules.js")); }
function activityHeatRate(type, part) { return Math.max(0, Number(heatRules().activityHeat(type, part)) || 0); }

function computeStoppingDistance(ship, stats) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  const accel = stats.accel || 0;
  if (speed <= 0 || accel <= 0) return 0;
  const decel = Math.max(accel * 0.5, speed * 0.06 + 1, (stats.brakingAccel || 0) * 0.5);
  return (speed * speed) / (2 * decel);
}

function ensureRoomNavigation(room) {
  const map = room?.map || null;
  const asteroids = map?.asteroids || [];
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const revision = room?.mapRevision ?? map?.revision ?? 0;
  if (room?._movementNav && room._movementNav.revision === revision && room._movementNav.width === width && room._movementNav.height === height) return room._movementNav;
  const cellSize = NAV_GRID_CELL_SIZE;
  const cols = Math.max(1, Math.ceil(width / cellSize));
  const rows = Math.max(1, Math.ceil(height / cellSize));
  const cells = new Float32Array(cols * rows);
  for (let c = 0; c < cols; c += 1) {
    for (let r = 0; r < rows; r += 1) {
      const x = c * cellSize + cellSize / 2;
      const y = r * cellSize + cellSize / 2;
      let clearance = Math.min(x - WORLD_MARGIN, y - WORLD_MARGIN, width - WORLD_MARGIN - x, height - WORLD_MARGIN - y);
      for (const a of asteroids) {
        if (!a) continue;
        const dx = x - a.x;
        const dy = y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) - (a.radius || 0);
        if (dist < clearance) clearance = dist;
      }
      cells[r * cols + c] = clearance;
    }
  }
  room._movementNav = { width, height, cellSize, cols, rows, cells, revision };
  return room._movementNav;
}

function cellFor(nav, x, y) {
  const c = clampNumber(Math.floor(x / nav.cellSize), 0, nav.cols - 1);
  const r = clampNumber(Math.floor(y / nav.cellSize), 0, nav.rows - 1);
  return { c, r, i: r * nav.cols + c };
}
function cellCenter(nav, c, r) { return { x: c * nav.cellSize + nav.cellSize / 2, y: r * nav.cellSize + nav.cellSize / 2 }; }
function cellClearanceAt(nav, x, y) { return nav.cells[cellFor(nav, x, y).i]; }

function bfsNearestClearCell(nav, startX, startY, clearance) {
  const start = cellFor(nav, startX, startY);
  if (nav.cells[start.i] >= clearance) return start;
  const size = nav.cols * nav.rows;
  const visited = new Uint8Array(size);
  const q = [start.c, start.r];
  let qi = 0;
  visited[start.i] = 1;
  const dirs = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  let best = null;
  let bestDist = Infinity;
  while (qi < q.length) {
    const c = q[qi++];
    const r = q[qi++];
    const i = r * nav.cols + c;
    if (nav.cells[i] >= clearance) {
      const center = cellCenter(nav, c, r);
      const d = fastHypot(center.x - startX, center.y - startY);
      if (d < bestDist) { bestDist = d; best = center; }
    }
    for (const d of dirs) {
      const nc = c + d[0], nr = r + d[1];
      if (nc < 0 || nc >= nav.cols || nr < 0 || nr >= nav.rows) continue;
      const ni = nr * nav.cols + nc;
      if (visited[ni]) continue;
      visited[ni] = 1;
      q.push(nc, nr);
    }
  }
  return best;
}

function nearestClearPoint(room, x, y, clearance) {
  const nav = ensureRoomNavigation(room);
  const width = room?.world?.width || nav.width;
  const height = room?.world?.height || nav.height;
  const startX = clampNumber(Number(x) || width * 0.5, WORLD_MARGIN, width - WORLD_MARGIN);
  const startY = clampNumber(Number(y) || height * 0.5, WORLD_MARGIN, height - WORLD_MARGIN);
  const cell = cellFor(nav, startX, startY);
  if (nav.cells[cell.i] >= clearance) return { x: startX, y: startY, adjusted: false, passes: 0, clear: true, reason: "clear" };
  const best = bfsNearestClearCell(nav, startX, startY, clearance);
  if (best) return { x: best.x, y: best.y, adjusted: true, passes: 1, clear: true, reason: "adjusted" };
  return { x: startX, y: startY, adjusted: false, passes: 0, clear: false, reason: "blocked" };
}

class BinaryHeap {
  constructor(compare) { this.heap = []; this.compare = compare; }
  push(value) { this.heap.push(value); this._siftUp(this.heap.length - 1); }
  pop() { if (!this.heap.length) return undefined; const top = this.heap[0]; const last = this.heap.pop(); if (this.heap.length) { this.heap[0] = last; this._siftDown(0); } return top; }
  get length() { return this.heap.length; }
  _siftUp(i) { const v = this.heap[i]; while (i > 0) { const p = (i - 1) >> 1; if (this.compare(v, this.heap[p])) { this.heap[i] = this.heap[p]; i = p; } else break; } this.heap[i] = v; }
  _siftDown(i) { const v = this.heap[i]; const n = this.heap.length; while (true) { let l = i * 2 + 1; if (l >= n) break; let c = l; let r = l + 1; if (r < n && this.compare(this.heap[r], this.heap[l])) c = r; if (this.compare(v, this.heap[c])) break; this.heap[i] = this.heap[c]; i = c; } this.heap[i] = v; }
}

function heuristicCell(nav, c1, r1, c2, r2) {
  const a = cellCenter(nav, c1, r1), b = cellCenter(nav, c2, r2);
  return fastHypot(a.x - b.x, a.y - b.y);
}

function segmentCircleClearance(x1, y1, x2, y2, cx, cy, radius) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = fastHypot(dx, dy);
  if (len < 0.001) return { blocked: fastHypot(cx - x1, cy - y1) < radius, along: 0, lateral: 0 };
  const ux = dx / len, uy = dy / len;
  const relX = cx - x1, relY = cy - y1;
  const along = relX * ux + relY * uy;
  const cx2 = x1 + ux * clampNumber(along, 0, len);
  const cy2 = y1 + uy * clampNumber(along, 0, len);
  const lateral = relX * (-uy) + relY * ux;
  return { blocked: fastHypot(cx - cx2, cy - cy2) < radius, along, lateral };
}

function isSegmentClear(room, x1, y1, x2, y2, clearance) {
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const dx = x2 - x1, dy = y2 - y1;
  const len = fastHypot(dx, dy);
  if (len < 0.001) return x1 >= WORLD_MARGIN + clearance && x1 <= width - WORLD_MARGIN - clearance && y1 >= WORLD_MARGIN + clearance && y1 <= height - WORLD_MARGIN - clearance;
  const ux = dx / len, uy = dy / len;
  const scratch = room._segmentScratch || (room._segmentScratch = []);
  const asteroids = (room.spatialIndex?.dynamicValid && room.spatialIndex.querySweptAabbUnordered)
    ? room.spatialIndex.querySweptAabbUnordered("asteroids", x1, y1, x2, y2, clearance, scratch)
    : (room.map?.asteroids || []);
  for (const a of asteroids) {
    if (!a) continue;
    if (segmentCircleClearance(x1, y1, x2, y2, a.x, a.y, (a.radius || 0) + clearance).blocked) return false;
  }
  const steps = Math.ceil(len / 8);
  for (let s = 0; s <= steps; s += 1) {
    const t = Math.min(1, (s * 8) / len);
    const px = x1 + ux * t * len, py = y1 + uy * t * len;
    if (px < WORLD_MARGIN + clearance || px > width - WORLD_MARGIN - clearance || py < WORLD_MARGIN + clearance || py > height - WORLD_MARGIN - clearance) return false;
  }
  return true;
}

function findPath(room, ship, goalX, goalY, clearance) {
  return findPathWorld(room, ship.x, ship.y, goalX, goalY, clearance);
}

function findPathWorld(room, startX, startY, goalX, goalY, clearance) {
  const nav = ensureRoomNavigation(room);
  const startClear = nearestClearPoint(room, startX, startY, clearance + nav.cellSize / 2);
  const goalClear = nearestClearPoint(room, goalX, goalY, clearance + nav.cellSize / 2);
  if (!goalClear.clear) return null;
  const start = cellFor(nav, startClear.x, startClear.y);
  const goal = cellFor(nav, goalClear.x, goalClear.y);
  const size = nav.cols * nav.rows;
  const gScore = new Float64Array(size), parent = new Int32Array(size);
  gScore.fill(Infinity); parent.fill(-1);
  const startI = start.r * nav.cols + start.c;
  const goalI = goal.r * nav.cols + goal.c;
  gScore[startI] = 0;
  let order = 0;
  const heap = new BinaryHeap((a, b) => a.f < b.f || (a.f === b.f && a.order < b.order));
  heap.push({ f: heuristicCell(nav, start.c, start.r, goal.c, goal.r), i: startI, order: ++order });
  const dirs = [[1, 0, 1], [0, 1, 1], [-1, 0, 1], [0, -1, 1], [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2]];
  const required = clearance + nav.cellSize / 2;
  while (heap.length > 0) {
    const node = heap.pop();
    const i = node.i;
    if (i === goalI) break;
    const r = Math.floor(i / nav.cols), c = i % nav.cols;
    for (const d of dirs) {
      const nc = c + d[0], nr = r + d[1];
      if (nc < 0 || nc >= nav.cols || nr < 0 || nr >= nav.rows) continue;
      const ni = nr * nav.cols + nc;
      if (nav.cells[ni] < required) continue;
      if (d[2] !== 1) {
        const ci = r * nav.cols + nc, ri = nr * nav.cols + c;
        if (nav.cells[ci] < required || nav.cells[ri] < required) continue;
      }
      const cost = d[2] * nav.cellSize;
      const ng = gScore[i] + cost;
      if (ng < gScore[ni] - 1e-9) {
        gScore[ni] = ng; parent[ni] = i;
        heap.push({ f: ng + heuristicCell(nav, nc, nr, goal.c, goal.r), i: ni, order: ++order });
      }
    }
  }
  if (gScore[goalI] === Infinity) return null;
  const raw = [];
  let i = goalI;
  while (i !== -1) {
    const r = Math.floor(i / nav.cols), c = i % nav.cols;
    raw.push(cellCenter(nav, c, r));
    i = parent[i];
  }
  raw.reverse();
  const smoothed = [raw[0]];
  let a = 0;
  while (a < raw.length - 1) {
    let b = raw.length - 1;
    while (b > a + 1 && !isSegmentClear(room, smoothed[smoothed.length - 1].x, smoothed[smoothed.length - 1].y, raw[b].x, raw[b].y, clearance)) b -= 1;
    smoothed.push(raw[b]); a = b;
  }
  return smoothed;
}

function shouldReplanPath(room, ship, goalX, goalY) {
  const p = ship._movementPath;
  if (!p) return true;
  if (p.clearance !== navigationClearanceRadius(ship)) return true;
  const commandId = ship._movementCommand?.id || ship.commandMode || "none";
  if (p.commandId !== commandId) return true;
  const dx = goalX - p.goalX;
  const dy = goalY - p.goalY;
  const threshold = ship.commandMode === "move" ? NAV_REPLAN_MOVE_THRESHOLD : NAV_REPLAN_COMBAT_THRESHOLD;
  if (fastHypot(dx, dy) > threshold) return true;
  if (ship._simNow - p.plannedAt > 4000) return true;
  const idx = ship._movementWaypointIndex || 0;
  if (idx < p.waypoints.length) {
    const wp = p.waypoints[idx];
    if (cellClearanceAt(ensureRoomNavigation(room), wp.x, wp.y) < p.clearance) return true;
  }
  if ((ship._stuckTimer || 0) > NAV_STUCK_TIME_MS) return true;
  return false;
}

function getOrUpdatePath(room, ship, goalX, goalY) {
  if (!shouldReplanPath(room, ship, goalX, goalY)) {
    moveBump("pathCacheHitCount");
    return ship._movementPath.waypoints;
  }
  moveBump("pathPlanCount");
  const clearance = navigationClearanceRadius(ship);
  let waypoints;
  if (isSegmentClear(room, ship.x, ship.y, goalX, goalY, clearance)) {
    waypoints = [{ x: goalX, y: goalY }];
  } else {
    waypoints = findPath(room, ship, goalX, goalY, clearance);
    if (!waypoints) {
      const goalClear = nearestClearPoint(room, goalX, goalY, clearance);
      if (goalClear.clear && isSegmentClear(room, ship.x, ship.y, goalClear.x, goalClear.y, clearance)) {
        waypoints = [{ x: goalClear.x, y: goalClear.y }];
      } else {
        waypoints = [{ x: goalX, y: goalY }];
      }
    }
  }
  ship._movementPath = { waypoints, goalX, goalY, clearance, commandId: ship._movementCommand?.id || ship.commandMode || "none", plannedAt: ship._simNow || 0 };
  ship._movementWaypointIndex = 0;
  moveBump("pathReplanCount");
  return waypoints;
}

function selectCurrentWaypoint(ship, waypoints) {
  let idx = ship._movementWaypointIndex || 0;
  idx = clampNumber(idx, 0, Math.max(0, waypoints.length - 1));
  const threshold = navigationClearanceRadius(ship) * 0.75;
  while (idx < waypoints.length - 1 && fastHypot(ship.x - waypoints[idx].x, ship.y - waypoints[idx].y) < threshold) {
    idx += 1;
    moveBump("waypointAdvanceCount");
  }
  ship._movementWaypointIndex = idx;
  return { goal: waypoints[idx], isFinal: idx === waypoints.length - 1 };
}

function worldFromOffset(heading, wp, off) {
  const c = Math.cos(heading), s = Math.sin(heading);
  return { x: wp.x + off.forward * c - off.lateral * s, y: wp.y + off.forward * s + off.lateral * c };
}

function buildCommandWaypoints(ship) {
  const plan = ship._movementCommand;
  if (!plan || !plan.anchorRoute || !plan.heading) return null;
  const off = plan.localOffsets?.[ship.id];
  if (!off) return null;
  return plan.anchorRoute.map(wp => worldFromOffset(plan.heading, wp, off));
}

function computeFleetCenter(ships) {
  let x = 0, y = 0;
  for (const s of ships) { x += s.x || 0; y += s.y || 0; }
  return { x: x / ships.length, y: y / ships.length };
}

function setGroundMoveTarget(room, ship, x, y, plan) {
  ship.targetX = x;
  ship.targetY = y;
  ship.commandMode = "move";
  ship.isManualMove = true;
  ship.arrived = false;
  ship.focusTargetId = null;
  ship.repairTargetId = null;
  ship.holdState = null;
  clearCombatState(ship);
  ship._movementPath = null;
  ship._movementWaypointIndex = 0;
  ship._movementCommand = plan || null;
  ship._lastCommandId = plan?.id || null;
  ship._commandWaypointIndex = 0;
}

function commandShips(room, player, x, y, options = {}) {
  const command = selectOwnedLivingShips(player, options.shipIds);
  if (!command.ok) return { ok: false, code: command.code, commanded: 0 };
  const ships = command.ships;
  if (ships.length === 0) return { ok: true, code: "none", commanded: 0 };
  let isEnemy = false, isAlly = false, targetId = null;
  if (options.targetId) {
    targetId = String(options.targetId);
    const target = room.ships?.get(targetId);
    if (target && target.alive) {
      isEnemy = areEnemies(player, target);
      isAlly = !isEnemy;
    }
  }
  if (isEnemy) {
    for (const ship of ships) {
      ship.commandMode = "attack";
      ship.combatTargetId = targetId;
      ship.focusTargetId = targetId;
      ship.isManualMove = false;
      ship.arrived = false;
      ship.holdState = null;
      ship._movementPath = null;
      ship._movementCommand = null;
      ship._movementWaypointIndex = 0;
      ship._commandWaypointIndex = 0;
    }
    return { ok: true, code: "attack", commanded: ships.length };
  }
  if (isAlly) {
    for (const ship of ships) {
      ship.commandMode = "repair";
      ship.repairTargetId = targetId;
      ship.isManualMove = false;
      ship.arrived = false;
      ship._movementPath = null;
      ship._movementCommand = null;
      ship._movementWaypointIndex = 0;
      ship._commandWaypointIndex = 0;
    }
    return { ok: true, code: "repair", commanded: ships.length };
  }
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const dest = { x: clampNumber(x, WORLD_MARGIN, width - WORLD_MARGIN), y: clampNumber(y, WORLD_MARGIN, height - WORLD_MARGIN) };
  const anchorStart = computeFleetCenter(ships);
  const heading = Math.atan2(dest.y - anchorStart.y, dest.x - anchorStart.x);
  const largestClearance = ships.reduce((m, s) => Math.max(m, navigationClearanceRadius(s)), 0);
  const anchorRoute = findPathWorld(room, anchorStart.x, anchorStart.y, dest.x, dest.y, largestClearance) || [{ x: dest.x, y: dest.y }];
  const roomId = (room._nextCommandId || 0) + 1;
  room._nextCommandId = roomId;
  const plan = { id: "m" + roomId, anchorStart, anchorDestination: dest, heading, anchorRoute, members: ships.map(s => s.id), localOffsets: {} };
  const c = Math.cos(heading), s = Math.sin(heading);
  for (let i = 0; i < ships.length; i += 1) {
    const ship = ships[i];
    const ox = ship.x - anchorStart.x;
    const oy = ship.y - anchorStart.y;
    const offF = ox * c + oy * s;
    const offR = -ox * s + oy * c;
    let useF = offF, useR = offR;
    if (ships.length > 1 && fastHypot(ox, oy) < 0.001) {
      const ring = 1 + Math.floor(i / 6);
      const turn = i % 6;
      const spacing = separationRadius(ship) * 2;
      useF = Math.cos(turn) * ring * spacing;
      useR = Math.sin(turn) * ring * spacing;
    }
    plan.localOffsets[ship.id] = { forward: useF, lateral: useR };
    const worldDest = worldFromOffset(heading, dest, { forward: useF, lateral: useR });
    const clear = nearestClearPoint(room, worldDest.x, worldDest.y, navigationClearanceRadius(ship));
    if (clear.clear) {
      setGroundMoveTarget(room, ship, clear.x, clear.y, plan);
    } else {
      const fallback = nearestClearPoint(room, dest.x, dest.y, navigationClearanceRadius(ship));
      setGroundMoveTarget(room, ship, fallback.x, fallback.y, plan);
    }
  }
  return { ok: true, code: "move", commanded: ships.length };
}

function stopShips(room, player, options = {}) {
  const command = selectOwnedLivingShips(player, options.shipIds);
  if (!command.ok) return { ok: false, code: command.code, commanded: 0 };
  for (const ship of command.ships) {
    ship.commandMode = "stop";
    ship.isManualMove = false;
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.arrived = false;
    ship._movementPath = null;
    ship._movementCommand = null;
    ship._movementWaypointIndex = 0;
    ship._commandWaypointIndex = 0;
    ship.focusTargetId = null;
    ship.repairTargetId = null;
    ship.holdState = null;
    clearCombatState(ship);
  }
  return { ok: true, code: "stop", commanded: command.ships.length };
}

function rotateShips(room, player, direction, options = {}) {
  const command = selectOwnedLivingShips(player, options.shipIds);
  if (!command.ok) return { ok: false, code: command.code, commanded: 0 };
  const normalized = clampNumber(direction, -1, 1);
  for (const ship of command.ships) {
    ship.rotationInput = normalized;
    ship.commandMode = "stop";
    ship.isManualMove = false;
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.arrived = true;
    ship.focusTargetId = null;
    ship.repairTargetId = null;
    ship.holdState = null;
    ship._movementPath = null;
    ship._movementCommand = null;
    ship._movementWaypointIndex = 0;
    ship._commandWaypointIndex = 0;
    clearCombatState(ship);
  }
  return { ok: true, code: "rotate", commanded: command.ships.length };
}

function sanitizeCombatStyle(style) { return require("./validation").sanitizeCombatStyle(style); }
function getCombatStyle(ship) { return sanitizeCombatStyle(ship.combatStyle); }

function getActiveCombatTarget(room, ship) {
  if (ship.commandMode === "move" || ship.commandMode === "repair") return null;
  const id = ship.focusTargetId || ship.combatTargetId;
  const target = id && room.ships?.get(id);
  return (target && target.alive) ? target : null;
}

function clearCombatState(ship) {
  ship.orbitDir = undefined;
  ship.lastOrbitTargetId = null;
  ship._orbitAngle = undefined;
  ship._maintainBand = undefined;
  ship._kiteBand = undefined;
  ship._evasiveDodgeDir = undefined;
  ship._evasiveDodgeUntil = 0;
  ship._interceptorBand = undefined;
  ship._brawlerBand = undefined;
  ship._heavyBand = undefined;
  ship._facingState = null;
  ship._hullAngleCache = null;
}

function updateRepairMoveTarget(room, ship) {
  const targetId = ship.repairTargetId;
  const target = targetId && room.ships?.get(targetId);
  if (!target || !target.alive) {
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.commandMode = "stop";
    ship.arrived = true;
    return;
  }
  const radiusSum = (ship.radius || 0) + (target.radius || 0) + 30;
  const dx = ship.x - target.x;
  const dy = ship.y - target.y;
  const dist = fastHypot(dx, dy) || 1;
  ship.targetX = target.x + (dx / dist) * radiusSum;
  ship.targetY = target.y + (dy / dist) * radiusSum;
  ship.arrived = false;
}

function getMaxWeaponRange(ship) {
  const ranges = getEffectiveWeaponRanges(ship);
  return Math.max(0, ranges.blaster || 0, ranges.missile || 0, ranges.railgun || 0, ranges.beam || 0);
}

function findOptimalHullAngle(ship, target) {
  const design = ship.design || [];
  const best = { angle: Math.atan2(target.y - ship.y, target.x - ship.x), score: -Infinity };
  const base = best.angle;
  const step = Math.PI / 64;
  for (let k = -32; k <= 32; k += 1) {
    const a = base + k * step;
    let s = 0;
    for (let i = 0; i < design.length; i += 1) {
      const module = design[i];
      const part = PARTS[module.type];
      if (!part || !part.weapon) continue;
      if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
      const profile = getEffectiveWeaponStatsInternal(ship, i, part);
      if (!profile) continue;
      const local = moduleLocalPosition(ship, i);
      const worldX = ship.x + Math.cos(a) * local.x - Math.sin(a) * local.y;
      const worldY = ship.y + Math.sin(a) * local.x + Math.cos(a) * local.y;
      const dx = target.x - worldX;
      const dy = target.y - worldY;
      const d = Math.max(1, fastHypot(dx, dy));
      const barrel = normalizeRotation(a + moduleRotationToRadians(module.rotation || 0));
      const desired = Math.atan2(dy, dx);
      const diff = Math.abs(angleDifference(barrel, desired));
      const inArc = diff <= (profile.fireArc || Math.PI) * 0.5 + 0.05;
      const inRange = d <= (profile.range || 0);
      const score = (inArc && inRange) ? (profile.damage || 0) * 1000 / (d + 1) : -(profile.damage || 0) * diff;
      s += score;
    }
    if (s > best.score) { best.angle = a; best.score = s; }
  }
  return best.angle;
}

function getCachedOptimalHullAngle(ship, target) {
  const now = ship._simNow || 0;
  const cache = ship._hullAngleCache;
  const tId = target?.id || null;
  if (cache && cache.targetId === tId && cache.angle != null && (now - cache.time) < HULL_ANGLE_REFRESH_INTERVAL) {
    return cache.angle;
  }
  const angle = findOptimalHullAngle(ship, target);
  ship._hullAngleCache = { targetId: tId, angle, time: now };
  return angle;
}

function applyFacingHysteresis(ship, desired) {
  const state = ship._facingState || (ship._facingState = { last: 0, locked: 0, committedSide: 0 });
  if (!Number.isFinite(ship.angle)) ship.angle = 0;
  const diff = angleDifference(ship.angle, desired);
  const threshold = FACING_HYSTERESIS;
  if (Math.abs(diff) < threshold) return ship.angle;
  const broadside = Math.sin(diff);
  if (Math.abs(broadside) > BROADSIDE_COMMIT_THRESHOLD) state.committedSide = broadside > 0 ? 1 : -1;
  else if (state.committedSide !== 0 && Math.abs(broadside) > 0.12) {
    const corrected = desired + Math.PI - (Math.PI * 0.5 * state.committedSide);
    desired = normalizeRotation(corrected);
  }
  state.locked = desired;
  state.last = desired;
  return desired;
}

function updatePropulsionCapacitors(ship, stats, dt, now) {
  const idx = getShipComponentIndexes(ship).propulsionCapacitorIndices;
  if (!idx.length) return 1;
  let boost = 1;
  const style = getCombatStyle(ship);
  const moving = ship.arrived === false ? 1 : 0;
  const dodging = (style === "evasive" && ship._evasiveDodgeDir) ? 1 : 0;
  for (const i of idx) {
    if ((ship.componentHp?.[i] ?? 1) <= 0) continue;
    const part = PARTS[ship.design[i].type];
    const mult = getComponentPowerMultiplier(ship, i);
    const state = ship.propulsionCapacitorCharge || (ship.propulsionCapacitorCharge = {});
    let charge = state[i] || 0;
    const max = (part.propulsionCapacitor || 0) * 5;
    const passive = (part.passiveRecharge || 0.8) * (moving + dodging * 0.5) * mult * dt;
    charge = Math.min(max, charge + passive);
    if (moving && charge > 0) {
      const drain = (part.activeDischarge || 0) * dt * mult;
      const use = Math.min(charge, drain);
      charge -= use;
      boost += use * 0.05;
    }
    state[i] = charge;
  }
  return boost;
}

function ensureMoveTarget(ship) {
  if (!Number.isFinite(ship.x)) ship.x = 0;
  if (!Number.isFinite(ship.y)) ship.y = 0;
  if (!Number.isFinite(ship.vx)) ship.vx = 0;
  if (!Number.isFinite(ship.vy)) ship.vy = 0;
  if (!Number.isFinite(ship.angle)) ship.angle = 0;
  if (!Number.isFinite(ship.targetX)) ship.targetX = ship.x;
  if (!Number.isFinite(ship.targetY)) ship.targetY = ship.y;
  if (!ship.commandMode) ship.commandMode = null;
}

function computeStandoffPosition(ship, target, desiredRange) {
  const dx = (ship.x || 0) - (target.x || 0);
  const dy = (ship.y || 0) - (target.y || 0);
  const dist = fastHypot(dx, dy) || 1;
  const scale = desiredRange / dist;
  return { x: (target.x || 0) + dx * scale, y: (target.y || 0) + dy * scale, dist };
}

function radialSpeed(ship, target) {
  const dx = (ship.x || 0) - (target.x || 0);
  const dy = (ship.y || 0) - (target.y || 0);
  const dist = fastHypot(dx, dy) || 1;
  const dvx = (ship.vx || 0) - (target.vx || 0);
  const dvy = (ship.vy || 0) - (target.vy || 0);
  return (dvx * dx + dvy * dy) / dist;
}

function setStandoffTarget(ship, target, desiredRange, stateProp, toleranceRatio) {
  const standoff = computeStandoffPosition(ship, target, desiredRange);
  const tolerance = Math.max(6, desiredRange * toleranceRatio);
  const rangeError = standoff.dist - desiredRange;
  const vRadial = radialSpeed(ship, target);
  let inBand = !!ship[stateProp];
  const shouldEnter = Math.abs(rangeError) <= tolerance * 0.8 && Math.abs(vRadial) <= 15;
  const shouldExit = Math.abs(rangeError) > tolerance * 1.5 || Math.abs(vRadial) > 35;
  if (shouldEnter) inBand = true;
  if (shouldExit) inBand = false;
  ship[stateProp] = inBand;
  if (inBand) {
    ship.targetX = ship.x;
    ship.targetY = ship.y;
  } else {
    ship.targetX = standoff.x;
    ship.targetY = standoff.y;
  }
}

function updateDirectMoveTarget(ship, target) {
  ship.targetX = target.x;
  ship.targetY = target.y;
  ship.arrived = false;
}

function updateOrbitMoveTarget(ship, target, maxRange, stats, dt) {
  const orbitRadius = Math.max(80, maxRange * ORBIT_RANGE_RATIO);
  const dx = (ship.x || 0) - (target.x || 0);
  const dy = (ship.y || 0) - (target.y || 0);
  const currentAngle = Math.atan2(dy, dx);
  if (!ship.orbitDir || ship.lastOrbitTargetId !== target.id) {
    const fx = Math.cos(ship.angle || 0), fy = Math.sin(ship.angle || 0);
    const tangent = -dx * fy + dy * fx;
    ship.orbitDir = tangent >= 0 ? 1 : -1;
    if (Math.abs(tangent) < 1e-6) ship.orbitDir = dx >= 0 ? 1 : -1;
    ship.lastOrbitTargetId = target.id;
    ship._orbitAngle = currentAngle;
  }
  if (ship.lastOrbitTargetId !== target.id || !Number.isFinite(ship._orbitAngle)) ship._orbitAngle = currentAngle;
  ship.lastOrbitTargetId = target.id;
  const angularStep = clampNumber((stats.turnRate || 0) * dt * 0.7, 0.02, 0.18);
  ship._orbitAngle = normalizeRotation(ship._orbitAngle + ship.orbitDir * angularStep);
  ship.targetX = (target.x || 0) + Math.cos(ship._orbitAngle) * orbitRadius;
  ship.targetY = (target.y || 0) + Math.sin(ship._orbitAngle) * orbitRadius;
  ship.arrived = false;
}

function updateHoldMoveTarget(ship, target, maxRange) {
  const desiredRange = Math.max(80, maxRange * HOLD_RANGE_RATIO);
  const standoff = computeStandoffPosition(ship, target, desiredRange);
  const margin = Math.max(ARRIVE_DISTANCE, (ship.radius || 0) * 0.5);
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  ship.holdState = ship.holdState || { phase: "positioning" };
  if (ship.holdState.phase === "positioning") {
    if (Math.abs(standoff.dist - desiredRange) <= margin && speed < ARRIVE_SPEED) {
      ship.holdState = { phase: "holding", x: ship.x, y: ship.y };
      ship.targetX = ship.x;
      ship.targetY = ship.y;
    } else {
      ship.holdState.phase = "positioning";
      ship.targetX = standoff.x;
      ship.targetY = standoff.y;
    }
  } else {
    const d = fastHypot((ship.x || 0) - ship.holdState.x, (ship.y || 0) - ship.holdState.y);
    const rangeErr = Math.abs(standoff.dist - desiredRange);
    const reEnter = d > ARRIVE_DISTANCE * 3 || (rangeErr > margin * 3 && d > ARRIVE_DISTANCE * 1.5);
    if (reEnter) {
      ship.holdState = { phase: "positioning", x: null, y: null };
      ship.targetX = standoff.x;
      ship.targetY = standoff.y;
    } else {
      ship.targetX = ship.holdState.x;
      ship.targetY = ship.holdState.y;
    }
  }
}

function updateMaintainRangeTarget(ship, target, maxRange) {
  const desiredRange = Math.max(80, maxRange * MAINTAIN_RANGE_RATIO);
  setStandoffTarget(ship, target, desiredRange, "_maintainBand", MAINTAIN_TOLERANCE);
}

function updateKiteMoveTarget(ship, target, maxRange) {
  const desiredRange = Math.max(80, maxRange * KITE_RANGE_RATIO);
  setStandoffTarget(ship, target, desiredRange, "_kiteBand", KITE_TOLERANCE);
}

function updateEvasiveMoveTarget(ship, target) {
  const desiredRange = Math.max(80, getMaxWeaponRange(ship) * EVASIVE_RANGE_RATIO);
  const standoff = computeStandoffPosition(ship, target, desiredRange);
  if (!ship._evasiveDodgeDir) {
    const sid = String(ship.id || "");
    ship._evasiveDodgeDir = ((hashString(sid + "dodge") % 2) === 0) ? 1 : -1;
  }
  const toShipX = (ship.x || 0) - (target.x || 0);
  const toShipY = (ship.y || 0) - (target.y || 0);
  const dist = standoff.dist || 1;
  const perpX = -toShipY / dist * ship._evasiveDodgeDir;
  const perpY = toShipX / dist * ship._evasiveDodgeDir;
  const dodgeMag = Math.min(80, dist * 0.2);
  ship.targetX = standoff.x + perpX * dodgeMag;
  ship.targetY = standoff.y + perpY * dodgeMag;
}

function updateChargeMoveTarget(ship, target) {
  if (shipHasOperationalDemolitionCharge(ship)) {
    const p = nearestDemolitionTargetPoint(ship, target);
    ship.targetX = p.x;
    ship.targetY = p.y;
  } else {
    ship.targetX = target.x;
    ship.targetY = target.y;
  }
  ship.arrived = false;
}

function updateSentryMoveTarget(ship) {
  if (!Number.isFinite(ship.sentryX)) { ship.sentryX = ship.x; ship.sentryY = ship.y; }
  ship.targetX = ship.sentryX;
  ship.targetY = ship.sentryY;
  ship.arrived = false;
}

function updateCombatMoveTarget(room, ship, target, style, stats, dt) {
  const maxRange = getMaxWeaponRange(ship);
  if (maxRange <= 0) {
    ship.targetX = ship.x;
    ship.targetY = ship.y;
    ship.arrived = true;
    ship.holdState = null;
    return;
  }
  if (style !== "hold") ship.holdState = null;
  switch (style) {
    case "orbit":
    case "circle":
      updateOrbitMoveTarget(ship, target, maxRange, stats, dt);
      break;
    case "hold":
      updateHoldMoveTarget(ship, target, maxRange);
      break;
    case "maintain":
      updateMaintainRangeTarget(ship, target, maxRange);
      break;
    case "kite":
      updateKiteMoveTarget(ship, target, maxRange);
      break;
    case "direct":
      updateDirectMoveTarget(ship, target);
      break;
    case "sentry":
      updateSentryMoveTarget(ship);
      break;
    case "charge":
      updateChargeMoveTarget(ship, target);
      break;
    case "interceptor":
      setStandoffTarget(ship, target, Math.max(40, maxRange * INTERCEPTOR_RANGE_RATIO), "_interceptorBand", 0.04);
      break;
    case "evasive":
      updateEvasiveMoveTarget(ship, target);
      break;
    case "brawler":
      setStandoffTarget(ship, target, Math.max(40, maxRange * BRAWLER_RANGE_RATIO), "_brawlerBand", 0.04);
      break;
    case "heavy":
      setStandoffTarget(ship, target, Math.max(40, maxRange * HEAVY_RANGE_RATIO), "_heavyBand", 0.04);
      break;
    default:
      setStandoffTarget(ship, target, Math.max(80, maxRange * HOLD_RANGE_RATIO), "_maintainBand", 0.05);
  }
}

function isPersistentStyle(style) {
  return style === "orbit" || style === "maintain" || style === "kite" || style === "direct" || style === "interceptor" || style === "evasive" || style === "brawler" || style === "heavy" || style === "circle";
}

function arrivalAwareFor(style, commandMode, isFinal) {
  if (!isFinal) return false;
  if (commandMode === "move" || commandMode === "stop") return true;
  if (commandMode === "repair") return true;
  return style === "hold" || style === "maintain" || style === "sentry" || style === "kite" || style === "interceptor" || style === "brawler" || style === "heavy";
}

function canMaintainCombatFacing(ship, stats, moveAngle, combatAngle) {
  if (!Number.isFinite(combatAngle) || !Number.isFinite(moveAngle)) return false;
  const angleDiff = Math.abs(angleDifference(moveAngle, combatAngle));
  if (angleDiff > Math.PI * 0.85) return false;
  const forwardAuthority = stats.accel || 0;
  const lateralAuthority = stats.lateralAccel || 0;
  const reverseAuthority = stats.reverseAccel || 0;
  if (lateralAuthority < forwardAuthority * 0.25) return false;
  if (reverseAuthority < forwardAuthority * 0.15) return false;
  return true;
}

function buildMovementDecision(room, ship, stats, goal, isFinal, combatTarget, style, dt) {
  const dx = (goal.x || 0) - (ship.x || 0);
  const dy = (goal.y || 0) - (ship.y || 0);
  const distance = fastHypot(dx, dy);
  const commandMode = ship.commandMode || null;
  const arrivalAware = arrivalAwareFor(style, commandMode, isFinal);
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  let desiredSpeed = 0;
  if (commandMode === "stop") {
    desiredSpeed = 0;
  } else if (!arrivalAware) {
    desiredSpeed = stats.maxSpeed || 0;
  } else if (distance < ARRIVE_DISTANCE && speed < ARRIVE_SPEED) {
    desiredSpeed = 0;
  } else {
    const stopDist = computeStoppingDistance(ship, stats);
    if (distance <= stopDist) desiredSpeed = 0;
    else desiredSpeed = Math.min(stats.maxSpeed || 0, Math.sqrt(2 * (stats.accel || 0) * Math.max(0, distance - stopDist)));
  }
  const goalDirX = distance > 0.001 ? dx / distance : Math.cos(ship.angle || 0);
  const goalDirY = distance > 0.001 ? dy / distance : Math.sin(ship.angle || 0);
  const desiredWorldVelX = goalDirX * desiredSpeed;
  const desiredWorldVelY = goalDirY * desiredSpeed;
  let accelX = (desiredWorldVelX - (ship.vx || 0)) * 8;
  let accelY = (desiredWorldVelY - (ship.vy || 0)) * 8;
  if (arrivalAware && speed > desiredSpeed + 3) {
    const brakeMag = clampNumber(speed - desiredSpeed, 0, stats.brakingAccel || 0);
    const ux = (ship.vx || 0) / speed;
    const uy = (ship.vy || 0) / speed;
    accelX -= ux * brakeMag;
    accelY -= uy * brakeMag;
  }
  const maxAccel = (stats.accel || 0) + (stats.lateralAccel || 0) + (stats.reverseAccel || 0);
  if (maxAccel > 0) {
    const mag = fastHypot(accelX, accelY);
    if (mag > maxAccel) { const s = maxAccel / mag; accelX *= s; accelY *= s; }
  }
  let moveAngle;
  if (desiredSpeed > 1) moveAngle = Math.atan2(desiredWorldVelY, desiredWorldVelX);
  else if (distance > 0.001) moveAngle = Math.atan2(dy, dx);
  else moveAngle = ship.angle || 0;
  const combatAngle = combatTarget ? getCachedOptimalHullAngle(ship, combatTarget) : null;
  const needsPropulsion = (commandMode === "stop" && speed > 5) || (commandMode !== "stop" && (distance > ARRIVE_DISTANCE || speed > ARRIVE_SPEED || !arrivalAware));
  const capacitorBoost = updatePropulsionCapacitors(ship, stats, dt, ship._simNow || 0);
  return {
    distance,
    isFinal,
    arrivalAware,
    persistentStyle: isPersistentStyle(style),
    desiredWorldAccel: { x: accelX, y: accelY },
    moveAngle,
    combatTarget,
    combatAngle,
    needsPropulsion,
    capacitorBoost
  };
}

function applyPropulsion(ship, stats, decision, dt) {
  const a = decision.desiredWorldAccel;
  const forwardX = Math.cos(ship.angle || 0);
  const forwardY = Math.sin(ship.angle || 0);
  const rightX = -forwardY;
  const rightY = forwardX;
  const aF = a.x * forwardX + a.y * forwardY;
  const aR = a.x * rightX + a.y * rightY;
  const forwardInput = clampNumber(aF, 0, (stats.accel || 0) * decision.capacitorBoost);
  const reverseInput = clampNumber(-aF, 0, stats.reverseAccel || 0);
  const lateralInput = clampNumber(aR, -(stats.lateralAccel || 0), stats.lateralAccel || 0);
  if (forwardInput > 0) {
    ship.vx += forwardX * forwardInput * dt;
    ship.vy += forwardY * forwardInput * dt;
  }
  if (reverseInput > 0) {
    ship.vx -= forwardX * reverseInput * dt;
    ship.vy -= forwardY * reverseInput * dt;
  }
  if (Math.abs(lateralInput) > 0) {
    ship.vx += rightX * lateralInput * dt;
    ship.vy += rightY * lateralInput * dt;
  }
  if (forwardInput > 0 && Math.cos(angleDifference(ship.angle || 0, decision.moveAngle)) < -0.3) moveBump("wrongWayAccelerationCount");
  heatMainEngines(ship, forwardInput, dt, stats);
  heatVectorThrusters(ship, Math.abs(lateralInput) + reverseInput, dt, stats);
}

function heatMainEngines(ship, forwardInput, dt, stats) {
  const total = stats.accel || 1;
  const relative = total > 0 ? clampNumber(forwardInput / total, 0, 1) : 0;
  for (const i of getShipComponentIndexes(ship).thrustIndices) {
    const part = PARTS[ship.design[i].type];
    if (!part || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    if (ship.validEngineIndices && !ship.validEngineIndices.has(i)) continue;
    const perf = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
    if (perf > 0) addComponentHeat(ship, i, (2 + (part.thrust || 0) * 0.018) * relative * perf * dt);
  }
}

function heatVectorThrusters(ship, vectorMag, dt, stats) {
  const maxVector = (stats.lateralAccel || 0) + (stats.reverseAccel || 0);
  const relative = maxVector > 0 ? clampNumber(vectorMag / maxVector, 0, 1) : 0;
  for (const i of getShipComponentIndexes(ship).vectorThrusterIndices) {
    const part = PARTS[ship.design[i].type];
    if (!part || (ship.componentHp?.[i] ?? 1) <= 0) continue;
    const perf = componentPerformance(ship, i) * getComponentPowerMultiplier(ship, i);
    if (perf > 0) addComponentHeat(ship, i, (2 + ((part.lateralThrust || 0) * 0.01)) * relative * perf * dt);
  }
}

function applyMovementDecision(room, ship, stats, decision, dt) {
  let desiredHullFacing = ship.angle || 0;
  if (Number.isFinite(ship.rotationInput)) {
    desiredHullFacing = ship.angle + ship.rotationInput * (Math.PI - 1e-9);
  } else if (Number.isFinite(ship.facingTarget)) {
    desiredHullFacing = ship.facingTarget;
  } else if (decision.combatTarget) {
    if (!decision.needsPropulsion) desiredHullFacing = decision.combatAngle;
    else if (canMaintainCombatFacing(ship, stats, decision.moveAngle, decision.combatAngle)) desiredHullFacing = decision.combatAngle;
    else desiredHullFacing = decision.moveAngle;
  } else if (decision.needsPropulsion) {
    desiredHullFacing = decision.moveAngle;
  }
  desiredHullFacing = applyFacingHysteresis(ship, desiredHullFacing);
  if (decision.needsPropulsion || decision.combatTarget || Number.isFinite(ship.rotationInput)) {
    rotateShipToward(ship, desiredHullFacing, stats, dt);
  }
  if (decision.needsPropulsion || (ship.commandMode === "stop" && fastHypot(ship.vx || 0, ship.vy || 0) > 1)) {
    applyPropulsion(ship, stats, decision, dt);
  }
}

function applyDamping(ship, distance, isPersistentMove, dt) {
  let damping = 0.985;
  if (!isPersistentMove && ship.arrived) damping = 0.97;
  if (!isPersistentMove && !ship.arrived && distance < 85) damping = 0.975;
  const factor = Math.pow(damping, Math.max(0, dt * 60));
  ship.vx = (ship.vx || 0) * factor;
  ship.vy = (ship.vy || 0) * factor;
}

function applySpeedLimit(ship, stats) {
  const limit = Math.max(0, stats.maxSpeed || 0);
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (speed > limit && speed > 0) { const s = limit / speed; ship.vx *= s; ship.vy *= s; }
}

function applyPosition(room, ship, dt) {
  ship.x = (ship.x || 0) + (ship.vx || 0) * dt;
  ship.y = (ship.y || 0) + (ship.vy || 0) * dt;
  const w = room?.world?.width || 2000;
  const h = room?.world?.height || 1600;
  if (ship.x < EDGE_BOUNCE_MARGIN) { ship.x = EDGE_BOUNCE_MARGIN; ship.vx = Math.abs(ship.vx || 0) * 0.3; }
  if (ship.x > w - EDGE_BOUNCE_MARGIN) { ship.x = w - EDGE_BOUNCE_MARGIN; ship.vx = -Math.abs(ship.vx || 0) * 0.3; }
  if (ship.y < EDGE_BOUNCE_MARGIN) { ship.y = EDGE_BOUNCE_MARGIN; ship.vy = Math.abs(ship.vy || 0) * 0.3; }
  if (ship.y > h - EDGE_BOUNCE_MARGIN) { ship.y = h - EDGE_BOUNCE_MARGIN; ship.vy = -Math.abs(ship.vy || 0) * 0.3; }
}

function resolveMapCollision(room, ship) {
  const radius = physicalCollisionRadius(ship);
  const width = room?.world?.width || 2000;
  const height = room?.world?.height || 1600;
  const scratch = room._mapCollisionScratch || (room._mapCollisionScratch = []);
  const asteroids = (room.spatialIndex?.dynamicValid && room.spatialIndex.queryAabbUnordered)
    ? room.spatialIndex.queryAabbUnordered("asteroids", ship.x - radius - 128, ship.y - radius - 128, ship.x + radius + 128, ship.y + radius + 128, scratch)
    : (room.map?.asteroids || []);
  let hit = false;
  for (const a of asteroids) {
    if (!a) continue;
    const dx = (ship.x || 0) - a.x;
    const dy = (ship.y || 0) - a.y;
    const dist = fastHypot(dx, dy);
    const minDist = (a.radius || 0) + radius;
    if (dist < minDist && dist > 0.001) {
      hit = true;
      const overlap = minDist - dist;
      const ux = dx / dist;
      const uy = dy / dist;
      ship.x += ux * overlap;
      ship.y += uy * overlap;
      const dot = (ship.vx || 0) * ux + (ship.vy || 0) * uy;
      if (dot < 0) { ship.vx -= dot * ux * 1.5; ship.vy -= dot * uy * 1.5; }
    }
  }
  if (hit) moveBump("collisionCount");
  return hit;
}

function resolveSeparationPair(a, b) {
  const dx = (b.x || 0) - (a.x || 0);
  const dy = (b.y || 0) - (a.y || 0);
  const dist = fastHypot(dx, dy);
  const min = separationRadius(a) + separationRadius(b);
  if (dist < min && dist > 0.001) {
    const overlap = (min - dist) * 0.5;
    const ux = dx / dist;
    const uy = dy / dist;
    a.x -= ux * overlap;
    a.y -= uy * overlap;
    b.x += ux * overlap;
    b.y += uy * overlap;
    const dotA = (a.vx || 0) * ux + (a.vy || 0) * uy;
    const dotB = (b.vx || 0) * ux + (b.vy || 0) * uy;
    if (dotA > 0) { a.vx -= ux * dotA * 0.5; a.vy -= uy * dotA * 0.5; }
    if (dotB < 0) { b.vx += ux * dotB * 0.5; b.vy += uy * dotB * 0.5; }
    return true;
  }
  return false;
}

function getLiveShips(room) { return Array.from(room.ships?.values() || []).filter(s => s && s.alive); }

function updateShipSeparation(room) {
  const ships = getLiveShips(room);
  const modified = new Set();
  for (let i = 0; i < ships.length; i += 1) {
    for (let j = i + 1; j < ships.length; j += 1) {
      if (resolveSeparationPair(ships[i], ships[j])) { modified.add(ships[i].id); modified.add(ships[j].id); }
    }
  }
  return Array.from(modified);
}

function resolveFleetMapCollisions(room) {
  let count = 0;
  for (const ship of getLiveShips(room)) { if (resolveMapCollision(room, ship)) count += 1; }
  return count;
}

function evaluateArrival(ship, decision) {
  const speed = fastHypot(ship.vx || 0, ship.vy || 0);
  if (decision.arrivalAware && decision.isFinal) {
    ship.arrived = decision.distance < ARRIVE_DISTANCE && speed < ARRIVE_SPEED;
  } else {
    ship.arrived = false;
  }
}

function regenerateShield(ship, stats, dt, now) {
  if (typeof effectiveShieldStats !== "function") return;
  const es = effectiveShieldStats(ship);
  if (!es || es.maxShield <= 0) return;
  const maxShield = es.maxShield;
  const rate = es.rechargeRate || 0;
  if (!Number.isFinite(ship.shield)) ship.shield = 0;
  ship.shield = clampNumber(ship.shield, 0, maxShield);
  if (ship.shield <= 0) {
    if (ship._shieldDepletedAt === undefined || ship._shieldDepletedAt === null) ship._shieldDepletedAt = now;
  } else {
    ship._shieldDepletedAt = null;
  }
  if (rate > 0 && ship.shield < maxShield) {
    const resumeAt = (ship._shieldDepletedAt || 0) + SHIELD_RESTART_DELAY_MS;
    if (now >= resumeAt) ship.shield = clampNumber(ship.shield + rate * dt, 0, maxShield);
  }
}

function sanitizeMovementState(room, ship) {
  const w = room?.world?.width || 2000;
  const h = room?.world?.height || 1600;
  ship.x = clampNumber(ship.x, EDGE_BOUNCE_MARGIN, w - EDGE_BOUNCE_MARGIN);
  ship.y = clampNumber(ship.y, EDGE_BOUNCE_MARGIN, h - EDGE_BOUNCE_MARGIN);
  ship.vx = clampNumber(ship.vx, -10000, 10000);
  ship.vy = clampNumber(ship.vy, -10000, 10000);
  ship.angle = normalizeRotation(Number(ship.angle) || 0);
  ship.targetX = clampNumber(ship.targetX, 0, w);
  ship.targetY = clampNumber(ship.targetY, 0, h);
}

function updateShipMovementStep(room, ship, dt, now, stats) {
  ensureMoveTarget(ship);
  ship._simNow = Number(now) || ship._simNow || 0;
  ship.turnActivity = 0;
  moveBump("movementDecisionCount");
  const style = getCombatStyle(ship);
  if (ship.commandMode === "repair") updateRepairMoveTarget(room, ship);
  const combatTarget = getActiveCombatTarget(room, ship);
  if (combatTarget) updateCombatMoveTarget(room, ship, combatTarget, style, stats, dt);
  else clearCombatState(ship);
  let waypoints = null;
  if (ship.commandMode === "move" && ship._movementCommand && ship._movementCommand.anchorRoute) {
    if (ship._lastCommandId !== ship._movementCommand.id) { ship._commandWaypointIndex = 0; ship._lastCommandId = ship._movementCommand.id; }
    waypoints = buildCommandWaypoints(ship);
  } else if (ship.commandMode === "move" || ship.commandMode === "attack" || ship.commandMode === "repair") {
    waypoints = getOrUpdatePath(room, ship, ship.targetX, ship.targetY);
  } else {
    waypoints = [{ x: ship.targetX, y: ship.targetY }];
  }
  if (!waypoints || waypoints.length === 0) waypoints = [{ x: ship.targetX, y: ship.targetY }];
  const wp = selectCurrentWaypoint(ship, waypoints);
  const decision = buildMovementDecision(room, ship, stats, wp.goal, wp.isFinal, combatTarget, style, dt);
  applyMovementDecision(room, ship, stats, decision, dt);
  applyDamping(ship, decision.distance, decision.persistentStyle, dt);
  applySpeedLimit(ship, stats);
  applyPosition(room, ship, dt);
  resolveMapCollision(room, ship);
  evaluateArrival(ship, decision);
  regenerateShield(ship, stats, dt, ship._simNow);
  sanitizeMovementState(room, ship);
}

function updateShipMovement(room, ship, dt) {
  ensureMoveTarget(ship);
  let safeDt = Number(dt);
  if (!Number.isFinite(safeDt) || safeDt <= 0) return;
  safeDt = Math.min(safeDt, MAX_MOVEMENT_DT);
  const stats = heatAdjustedMovementStats(ship, ship.stats || {});
  const now = ship._simNow || 0;
  const steps = Math.max(1, Math.round(safeDt / MOVEMENT_SUBSTEP));
  const stepDt = safeDt / steps;
  for (let i = 0; i < steps; i += 1) {
    updateShipMovementStep(room, ship, stepDt, now + (i * stepDt * 1000), stats);
  }
}

module.exports = {
  commandShips,
  stopShips,
  rotateShips,
  updateShipMovement,
  updateShipSeparation,
  resolveFleetMapCollisions,
  resolveMapCollision,
  nearestClearPoint,
  segmentCircleClearance,
  physicalCollisionRadius,
  navigationClearanceRadius,
  separationRadius
};

