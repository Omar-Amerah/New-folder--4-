#!/usr/bin/env node
import assert from "node:assert/strict";

if (typeof globalThis.document === "undefined") {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
}
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;

const { buildExteriorHullEdges } = await import("./public/src/game/shipHullOutline.js");
const { PART_STATS } = await import("./public/src/design/parts.js");
const { getOccupiedCells } = await import("./public/src/design/footprint.js");
const { moduleLocalPosition, GRID_CENTER } = await import("./public/src/game/shipGeometry.js");

const SCALE = 10;
const m = (x, y, type = "frame", rotation = 0) => ({ x, y, type, rotation });
const key = (e) => `${e.x1},${e.y1},${e.x2},${e.y2}`;
const rkey = (e) => `${e.x2},${e.y2},${e.x1},${e.y1}`;
const length = (e) => Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
const edgesFor = (design, live = () => true) => buildExteriorHullEdges(design, { scale: SCALE, isLive: live });
function assertNoDuplicates(edges) {
  const seen = new Set();
  for (const e of edges) {
    assert(Number.isFinite(e.x1) && Number.isFinite(e.y1) && Number.isFinite(e.x2) && Number.isFinite(e.y2), "edge endpoints are finite");
    assert(!seen.has(key(e)), "no duplicate edge");
    assert(!seen.has(rkey(e)), "no reversed duplicate edge");
    seen.add(key(e));
  }
}
function hasEdge(edges, a, b) {
  return edges.some((e) => (e.x1 === a.x && e.y1 === a.y && e.x2 === b.x && e.y2 === b.y) || (e.x1 === b.x && e.y1 === b.y && e.x2 === a.x && e.y2 === a.y));
}
function cellSide(cell, side) {
  const c = moduleLocalPosition(cell, SCALE); const h = SCALE / 2;
  return {
    left: [{ x: c.x - h, y: c.y - h }, { x: c.x - h, y: c.y + h }],
    right: [{ x: c.x + h, y: c.y - h }, { x: c.x + h, y: c.y + h }],
    top: [{ x: c.x - h, y: c.y - h }, { x: c.x + h, y: c.y - h }],
    bottom: [{ x: c.x - h, y: c.y + h }, { x: c.x + h, y: c.y + h }]
  }[side];
}
function perimeterUnits(edges) { return edges.reduce((sum, e) => sum + length(e), 0) / SCALE; }

{
  const edges = edgesFor([m(7, 7), m(8, 7)]);
  assertNoDuplicates(edges);
  assert.equal(perimeterUnits(edges), 6, "two adjacent cells have six exterior edge lengths");
  assert(!hasEdge(edges, ...cellSide({ x: 7, y: 7 }, "bottom")), "shared side is absent");
}
{
  const edges = edgesFor([m(7, 7), m(8, 7), m(7, 8), m(8, 8)]);
  assertNoDuplicates(edges);
  assert.equal(perimeterUnits(edges), 8, "2x2 block has only outside perimeter");
  assert(!hasEdge(edges, ...cellSide({ x: 7, y: 7 }, "bottom")), "central horizontal seam absent");
  assert(!hasEdge(edges, ...cellSide({ x: 7, y: 7 }, "left")), "central vertical seam absent");
}
{
  const design = [m(7, 7), m(8, 7), m(8, 8)];
  const edges = edgesFor(design);
  assertNoDuplicates(edges);
  assert(hasEdge(edges, ...cellSide({ x: 7, y: 7 }, "left")), "concave exterior corner edge retained");
  assert(!hasEdge(edges, ...cellSide({ x: 7, y: 7 }, "bottom")), "L shared edge removed");
  assert.deepEqual(edges, edgesFor(design), "L-shaped outline is deterministic");
}
{
  const type = Object.entries(PART_STATS).find(([, s]) => (s.footprint?.width || 1) > 1 || (s.footprint?.height || 1) > 1)?.[0] || "heavyEngine";
  for (const rotation of [0, 90]) {
    const part = m(7, 7, type, rotation);
    const cells = getOccupiedCells(part.x, part.y, PART_STATS[type].footprint, rotation);
    assert(cells.length > 1, "production multi-cell component fixture is multi-cell");
    const adjacent = m(cells[0].x - 1, cells[0].y);
    const edges = edgesFor([part, adjacent]);
    assertNoDuplicates(edges);
    assert(perimeterUnits(edges) < cells.length * 4 + 4, "multi-cell internal and adjacent seams are absent");
  }
}
{
  const design = [m(7, 7), m(8, 7)];
  const destroyed = edgesFor(design, (i) => i === 0);
  assert.equal(perimeterUnits(destroyed), 4, "destroyed component does not contribute");
  assert(hasEdge(destroyed, ...cellSide({ x: 7, y: 7 }, "bottom")), "survivor gains newly exposed side");
  assert.equal(perimeterUnits(edgesFor(design)), 6, "repair restores combined outline");
}
{
  const ring = [m(6,6),m(6,7),m(6,8),m(7,6),m(7,8),m(8,6),m(8,7),m(8,8)];
  const edges = edgesFor(ring);
  assert.equal(perimeterUnits(edges), 12, "enclosed cavity is not outlined; outside perimeter only");
  for (const side of ["left","right","top","bottom"]) assert(!hasEdge(edges, ...cellSide({ x: 7, y: 7 }, side)), "no cavity outline");
}
{
  const edges = edgesFor([m(5, 5), m(9, 9)]);
  assert.equal(perimeterUnits(edges), 8, "disconnected islands both receive exterior outlines");
  assertNoDuplicates(edges);
}
{
  const left = moduleLocalPosition({ x: GRID_CENTER, y: GRID_CENTER - 1 }, SCALE);
  const right = moduleLocalPosition({ x: GRID_CENTER, y: GRID_CENTER + 1 }, SCALE);
  assert(left.x > right.x, "ship-local mapping uses existing non-mirrored grid axes");
  assertNoDuplicates(edgesFor([m(6, 6), m(8, 8)]));
}
console.log("ship hull exterior outline geometry verified");
