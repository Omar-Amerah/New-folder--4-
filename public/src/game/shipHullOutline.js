// Pure exterior hull-outline geometry for player-colour ship identification.
// Builds a silhouette from the union of live footprint cells, then emits only
// sides touching empty space that is reachable from outside the hull bounds.

import { PART_STATS } from "../design/parts.js";
import { getOccupiedCells } from "../design/footprint.js";
import { moduleLocalPosition } from "./shipGeometry.js";

function cellKey(x, y) { return `${x},${y}`; }
function edgeKey(edge) { return `${edge.x1},${edge.y1},${edge.x2},${edge.y2}`; }
function finiteEdge(edge) {
  return Number.isFinite(edge.x1) && Number.isFinite(edge.y1) && Number.isFinite(edge.x2) && Number.isFinite(edge.y2);
}

export function buildExteriorHullEdges(design, { scale, isLive } = {}) {
  if (!Array.isArray(design) || !Number.isFinite(scale) || scale <= 0) return [];
  const occupied = new Set();
  const cells = [];
  for (let index = 0; index < design.length; index += 1) {
    const part = design[index];
    if (!part || (typeof isLive === "function" && !isLive(index, part))) continue;
    const footprint = PART_STATS[part.type]?.footprint || { width: 1, height: 1 };
    const partCells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
    for (const cell of partCells) {
      const key = cellKey(cell.x, cell.y);
      if (!occupied.has(key)) {
        occupied.add(key);
        cells.push({ x: cell.x, y: cell.y });
      }
    }
  }
  if (!cells.length) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const cell of cells) {
    if (cell.x < minX) minX = cell.x;
    if (cell.y < minY) minY = cell.y;
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y > maxY) maxY = cell.y;
  }
  minX -= 1; minY -= 1; maxX += 1; maxY += 1;

  const exterior = new Set();
  const queue = [{ x: minX, y: minY }];
  exterior.add(cellKey(minX, minY));
  for (let head = 0; head < queue.length; head += 1) {
    const cell = queue[head];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      const key = cellKey(nx, ny);
      if (occupied.has(key) || exterior.has(key)) continue;
      exterior.add(key);
      queue.push({ x: nx, y: ny });
    }
  }

  const edges = [];
  const pushEdge = (x1, y1, x2, y2) => {
    const edge = { x1, y1, x2, y2 };
    if (finiteEdge(edge)) edges.push(edge);
  };
  const half = scale / 2;
  const sortedCells = cells.slice().sort((a, b) => (a.x - b.x) || (a.y - b.y));
  for (const cell of sortedCells) {
    const center = moduleLocalPosition(cell, scale);
    const left = center.x - half;
    const right = center.x + half;
    const top = center.y - half;
    const bottom = center.y + half;
    if (exterior.has(cellKey(cell.x - 1, cell.y))) pushEdge(left, top, right, top);
    if (exterior.has(cellKey(cell.x, cell.y - 1))) pushEdge(right, bottom, right, top);
    if (exterior.has(cellKey(cell.x + 1, cell.y))) pushEdge(right, bottom, left, bottom);
    if (exterior.has(cellKey(cell.x, cell.y + 1))) pushEdge(left, top, left, bottom);
  }
  return edges.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)));
}
