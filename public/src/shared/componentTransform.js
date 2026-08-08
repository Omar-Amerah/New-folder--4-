// The single authority for a placed component's transform, shared by the browser
// designer, the renderers and the Node server.
//
// A placed module carries two independent transform fields:
//   rotation : 0 / 90 / 180 / 270 (degrees, clockwise on the blueprint grid)
//   flipped  : false / true       (horizontal mirror in LOCAL component space)
//
// TRANSFORM ORDER : every system must apply these in exactly this order:
//
//   BASE COMPONENT  ->  HORIZONTAL MIRROR (local component space)  ->  ROTATION
//
// so a transformed local point is  rotate(rotation, mirror(point)).  Canvas
// renderers get the same order by calling ctx.rotate() BEFORE ctx.scale(-1, 1),
// because canvas transforms apply to geometry in reverse call order; use
// artFlipScaleX() rather than restating that rule.
//
// The mirror is taken about the footprint's own vertical centre line, not about
// the anchor tile: a mirrored component covers exactly the cells it covered
// before, so pressing Flip can never move a component or change its footprint.
// Because every catalogue footprint is a full W x H rectangle, the mirror is
// cell-set invariant today : occupancy, connectivity, wiring and heat adjacency
// therefore read the same cells whether or not they pass the flag. That is a
// property of rectangular footprints, not a licence to skip the flag: any future
// non-rectangular shape mask must be mirrored through transformLocalOffset()
// here rather than by re-deriving the math locally.
//
// UMD: CommonJS for the server (require) and a global (ComponentTransform) for
// the browser, mirroring the other shared rule modules. Dependency-free.

(function initComponentTransform(root, factory) {
  const api = factory();
  root.ComponentTransform = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function componentTransformFactory() {
  "use strict";

  const TRANSFORM_ORDER = "mirror-then-rotate";

  // Only an explicit true is a flip. Absent/undefined/null : every blueprint
  // saved before mirroring existed : is false.
  function normalizeFlipped(value) {
    return value === true;
  }

  // Catalogue-level capability: mirroring is offered only where the component's
  // silhouette/detailing actually has a handedness worth reversing.
  function isFlippableStat(stat) {
    return Boolean(stat && stat.flippable === true);
  }

  // The value a placed module may store: a flip that the catalogue does not
  // offer is dropped rather than rejected, so an edited or stale blueprint
  // loads instead of failing.
  function normalizePartFlip(stat, flipped) {
    return isFlippableStat(stat) && normalizeFlipped(flipped);
  }

  function normalizedRotation(rotation) {
    return ((Number(rotation) || 0) % 360 + 360) % 360;
  }

  // Local footprint offset (dx, dy inside the W x H box) -> offset from the
  // anchor tile, with the mirror applied first and the rotation second.
  function transformLocalOffset(dx, dy, footprint, rotation = 0, flipped = false) {
    const width = Math.max(1, Number(footprint?.width) || 1);
    // 1. horizontal mirror in local component space.
    const mx = flipped === true ? width - 1 - dx : dx;
    const my = dy;
    // 2. rotation about the anchor tile.
    const rot = normalizedRotation(rotation);
    if (rot === 90) return { x: -my, y: mx };
    if (rot === 180) return { x: -mx, y: -my };
    if (rot === 270) return { x: my, y: -mx };
    return { x: mx, y: my };
  }

  // Grid cells a component occupies. The anchor stays (x, y); 90/270 degree
  // rotations may push cells to the left of / above it.
  function getOccupiedCells(x, y, footprint, rotation = 0, flipped = false) {
    const cells = [];
    const width = Math.max(1, Number(footprint?.width) || 1);
    const height = Math.max(1, Number(footprint?.height) || 1);
    for (let dy = 0; dy < height; dy += 1) {
      for (let dx = 0; dx < width; dx += 1) {
        const offset = transformLocalOffset(dx, dy, footprint, rotation, flipped);
        cells.push({ x: x + offset.x, y: y + offset.y });
      }
    }
    return cells;
  }

  // Bounding box of the transformed footprint. Rendering positions the visual
  // box from (minX, minY) because the anchor is not always the top-left cell.
  function getFootprintBounds(x, y, footprint, rotation = 0, flipped = false) {
    const cells = getOccupiedCells(x, y, footprint, rotation, flipped);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const cell of cells) {
      if (cell.x < minX) minX = cell.x;
      if (cell.y < minY) minY = cell.y;
      if (cell.x > maxX) maxX = cell.x;
      if (cell.y > maxY) maxY = cell.y;
    }
    return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  function footprintIncludes(x, y, footprint, rotation, targetX, targetY, flipped = false) {
    return getOccupiedCells(x, y, footprint, rotation, flipped)
      .some((cell) => cell.x === targetX && cell.y === targetY);
  }

  // Canvas/Pixi horizontal-mirror factor. Apply it AFTER the rotation call so
  // the mirror is the inner (first-applied) transform:
  //   ctx.rotate(angle); ctx.scale(artFlipScaleX(flipped), 1);
  function artFlipScaleX(flipped) {
    return flipped === true ? -1 : 1;
  }

  return Object.freeze({
    TRANSFORM_ORDER,
    normalizeFlipped,
    isFlippableStat,
    normalizePartFlip,
    transformLocalOffset,
    getOccupiedCells,
    getFootprintBounds,
    footprintIncludes,
    artFlipScaleX
  });
});
