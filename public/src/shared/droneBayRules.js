(function initDroneBayRules(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DroneBayRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function droneBayRulesFactory() {
  "use strict";

  const DRONE_TYPES = Object.freeze(["fighter", "defence", "repair"]);
  const TYPE_SET = new Set(DRONE_TYPES);
  const MAX_BAYS_PER_SHIP = 4;
  const SIDE_ORDER = Object.freeze([
    Object.freeze({ side: "top", dx: 0, dy: -1 }),
    Object.freeze({ side: "right", dx: 1, dy: 0 }),
    Object.freeze({ side: "bottom", dx: 0, dy: 1 }),
    Object.freeze({ side: "left", dx: -1, dy: 0 })
  ]);

  function cellsForPart(part, catalogue) {
    const footprint = catalogue?.[part?.type]?.footprint || { width: 1, height: 1 };
    const rotation = ((Number(part?.rotation) || 0) % 360 + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const width = Math.max(1, Math.trunc(Number(swap ? footprint.height : footprint.width) || 1));
    const height = Math.max(1, Math.trunc(Number(swap ? footprint.width : footprint.height) || 1));
    const cells = [];
    for (let oy = 0; oy < height; oy += 1) {
      for (let ox = 0; ox < width; ox += 1) cells.push({ x: part.x + ox, y: part.y + oy });
    }
    return cells;
  }

  function occupiedCellSet(design, catalogue, excludeIndex = -1) {
    const occupied = new Set();
    for (let index = 0; index < (design || []).length; index += 1) {
      if (index === excludeIndex) continue;
      for (const cell of cellsForPart(design[index], catalogue)) occupied.add(`${cell.x},${cell.y}`);
    }
    return occupied;
  }

  function exteriorEmptyCellSet(design, catalogue) {
    const occupied = occupiedCellSet(design, catalogue);
    const coordinates = [...occupied].map((key) => key.split(",").map(Number));
    if (!coordinates.length) return new Set();
    const minX = Math.min(...coordinates.map(([x]) => x)) - 1;
    const maxX = Math.max(...coordinates.map(([x]) => x)) + 1;
    const minY = Math.min(...coordinates.map(([, y]) => y)) - 1;
    const maxY = Math.max(...coordinates.map(([, y]) => y)) + 1;
    const exterior = new Set([`${minX},${minY}`]);
    const queue = [{ x: minX, y: minY }];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const cell = queue[cursor];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        const key = `${x},${y}`;
        if (x < minX || x > maxX || y < minY || y > maxY || occupied.has(key) || exterior.has(key)) continue;
        exterior.add(key);
        queue.push({ x, y });
      }
    }
    return exterior;
  }

  function edgeCells(cells, side) {
    const minX = Math.min(...cells.map((cell) => cell.x));
    const maxX = Math.max(...cells.map((cell) => cell.x));
    const minY = Math.min(...cells.map((cell) => cell.y));
    const maxY = Math.max(...cells.map((cell) => cell.y));
    if (side.side === "top") return cells.filter((cell) => cell.y === minY);
    if (side.side === "bottom") return cells.filter((cell) => cell.y === maxY);
    if (side.side === "left") return cells.filter((cell) => cell.x === minX);
    return cells.filter((cell) => cell.x === maxX);
  }

  function exposedLaunchEdges(design, componentIndex, catalogue) {
    const part = design?.[componentIndex];
    if (!part || part.type !== "droneBay") return [];
    const cells = cellsForPart(part, catalogue);
    const occupied = occupiedCellSet(design, catalogue, componentIndex);
    const exterior = exteriorEmptyCellSet(design, catalogue);
    return SIDE_ORDER.filter((side) => {
      const edge = edgeCells(cells, side);
      return edge.length === 2 && edge.every((cell) => {
        const key = `${cell.x + side.dx},${cell.y + side.dy}`;
        return !occupied.has(key) && exterior.has(key);
      });
    }).map((side) => {
      const edge = edgeCells(cells, side);
      return {
        ...side,
        cells: edge,
        // Grid coordinates identify cell centres. Place the authoritative launch
        // pose just beyond the hull edge so a drone never appears inside a bay.
        centerX: edge.reduce((sum, cell) => sum + cell.x, 0) / edge.length + side.dx * 0.75,
        centerY: edge.reduce((sum, cell) => sum + cell.y, 0) / edge.length + side.dy * 0.75
      };
    });
  }

  function stableComponentId(part) {
    return `drone-bay:${Math.trunc(Number(part?.x))},${Math.trunc(Number(part?.y))}`;
  }

  function normalizeDroneType(value) {
    const type = String(value || "").toLowerCase();
    return TYPE_SET.has(type) ? type : null;
  }

  function validateDroneBays(design, catalogue, options = {}) {
    const errors = [];
    const bays = [];
    for (let index = 0; index < (design || []).length; index += 1) {
      const part = design[index];
      if (part?.type !== "droneBay") continue;
      const droneType = normalizeDroneType(part.droneType);
      const launchEdges = exposedLaunchEdges(design, index, catalogue);
      if (!droneType) errors.push({ code: "drone-bay-unconfigured", componentIndex: index, message: "Drone Bay needs a drone type: Fighter, Defence, or Repair." });
      if (!launchEdges.length) errors.push({ code: "drone-bay-blocked", componentIndex: index, message: "Drone Bay requires an exposed two-cell launch edge." });
      bays.push({
        componentIndex: index,
        componentId: stableComponentId(part),
        droneType,
        launchEdge: launchEdges[0] || null
      });
    }
    const maximum = Number.isInteger(options.maximum) ? options.maximum : MAX_BAYS_PER_SHIP;
    if (bays.length > maximum) errors.push({ code: "too-many-drone-bays", message: `A ship may have at most ${maximum} Drone Bays.` });
    return { ok: errors.length === 0, bays, errors };
  }

  return Object.freeze({
    DRONE_TYPES,
    MAX_BAYS_PER_SHIP,
    cellsForPart,
    exteriorEmptyCellSet,
    exposedLaunchEdges,
    normalizeDroneType,
    stableComponentId,
    validateDroneBays
  });
});
