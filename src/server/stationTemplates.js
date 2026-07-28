"use strict";

// Authoritative developer-authored station designs (station infrastructure
// mode). These are ordinary component designs — not player blueprints, never
// exposed to the designer — so every downstream system (component HP, power,
// heat, weapons, point defence, repair) treats a station exactly like any other
// component structure.
//
// WHY STATIONS SHARE THE 15x15 GRID BUT NOT THE SHIP MODULE SCALE
// The wiring system is built around the designer grid: MAX_PATH_CELLS is
// GRID_SIZE^2 and MAX_SECTIONS_PER_KIND is 480, so a design laid out on a larger
// cell grid can never produce valid generated wiring — routes get truncated and
// interior consumers are stranded. Stations therefore stay within 15x15 cells
// and get their size from a larger MODULE SCALE instead. Component systems are
// index-based, so nothing about power, heat or damage notices; only geometry
// (render bounds, collision cells, hangar dimensions) reads the scale, and it is
// exported here as the single source of truth.
//
// STATION_MODULE_SCALE = 36 gives a 15-cell station front of 540 world units
// against a maximum 15x15 ship's 195 — a 2.77x ratio, inside the 2.2-2.8 target.
//
// GRID CONVENTION
// Client and server both map a design cell to structure-local space as
//   local.x = (7 - cell.y) * scale      // +x is FORWARD
//   local.y = (cell.x - 7) * scale      // +y is lateral
// so a station's hangar faces +x by opening at the LOWEST cell y, and the
// aperture's width runs along cell x.
//
// HOME STATION LAYOUT (cell space, front at the top / low y)
//
//        <------------- 15 cells (540u) ------------->
//        +--------+                      +-----------+   <- front face (y=0)
//        | left   |   aperture 7 cells   | right     |
//        | hull   |    (open corridor)   | hull      |   ^ 7 cells deep
//        | 4 wide |        238u          | 4 wide    |   v
//        +--------+----------------------+-----------+
//        |               rear body (8 cells)         |
//        +-------------------------------------------+
//
// The corridor is a genuine void in the design: no module occupies it, so the
// compound collision geometry leaves it open and a launching ship starts inside
// the structure rather than in front of it. Left and right hulls stay connected
// through the rear body, so generated wiring reaches every component.

const { PARTS } = require("./components");

// The ship module scale. Ships are laid out at 13 world units per cell.
const SHIP_MODULE_SCALE = 13;
// Stations use the same 15x15 grid at a larger scale (see the note above). 36
// is the smallest scale where the 7-cell aperture clears a maximum ship's
// lateral half-extent plus its per-cell hull collision radius by more than a
// full ship blueprint cell, while the 15-cell front stays inside the 2.2-2.8x
// visual ratio (540 / 195 = 2.77).
const STATION_MODULE_SCALE = 36;
const GRID_CENTER = 7;
const GRID_CELLS = 15;

// The largest ship a player can design. Every hangar dimension derives from
// this and nothing else, so the two can never drift apart.
const MAX_SHIP_CELLS = 15;
const MAX_SHIP_EXTENT = MAX_SHIP_CELLS * SHIP_MODULE_SCALE; // 195
// The physics engine treats each occupied ship cell as a circle of this radius,
// so a hull's real swept envelope is its rendered bounds grown by this much.
const HULL_CELL_PADDING = SHIP_MODULE_SCALE * Math.SQRT2 / 2;

// --- Home station cell layout ------------------------------------------------
const HOME_X_MIN = 0;
const HOME_X_MAX = GRID_CELLS - 1;
const HOME_Y_MIN = 0;
const HOME_Y_MAX = GRID_CELLS - 1;

// Aperture: seven cells (252u) around the grid centre. A 195u ship, padded by
// its per-cell hull radius, passes with 19.3u of clearance on each side.
const APERTURE_CELLS = 7;
const APERTURE_X_MIN = Math.floor((GRID_CELLS - APERTURE_CELLS) / 2); // 4
const APERTURE_X_MAX = APERTURE_X_MIN + APERTURE_CELLS - 1;           // 10

// Corridor depth: seven cells (252u), so a full 195u ship sits entirely inside
// the station before it moves.
const CORRIDOR_CELLS = 7;
const CORRIDOR_Y_MIN = HOME_Y_MIN;
const CORRIDOR_Y_MAX = CORRIDOR_Y_MIN + CORRIDOR_CELLS - 1; // 6
const BODY_CELLS = GRID_CELLS - CORRIDOR_CELLS;             // 8

const RELAY_CELLS = 9;
// Relays are structures too, but far smaller than a home station.
const RELAY_MODULE_SCALE = 20;

function inAperture(x) {
  return x >= APERTURE_X_MIN && x <= APERTURE_X_MAX;
}
function inCorridorVoid(x, y) {
  return inAperture(x) && y >= CORRIDOR_Y_MIN && y <= CORRIDOR_Y_MAX;
}

// Distance in cells to the nearest surface — the outer shell or a corridor wall.
function surfaceDepth(x, y) {
  let depth = Math.min(x - HOME_X_MIN, HOME_X_MAX - x, y - HOME_Y_MIN, HOME_Y_MAX - y);
  if (y <= CORRIDOR_Y_MAX) {
    if (x < APERTURE_X_MIN) depth = Math.min(depth, APERTURE_X_MIN - x - 1);
    else if (x > APERTURE_X_MAX) depth = Math.min(depth, x - APERTURE_X_MAX - 1);
  } else if (inAperture(x)) {
    depth = Math.min(depth, y - CORRIDOR_Y_MAX - 1);
  }
  return depth;
}

// Weapon batteries: point defence closest to the mouth (it protects the launch
// corridor), heavier mounts outboard and along the flanks. Every one is an
// ordinary weapon component running through the ordinary combat pipeline.
function homeStationSurfacePart(x, y) {
  const onFront = y === HOME_Y_MIN;
  const onFlank = x === HOME_X_MIN || x === HOME_X_MAX;
  const onRear = y === HOME_Y_MAX;
  // Corridor walls beside the mouth.
  const besideMouth = y <= CORRIDOR_Y_MIN + 2
    && (x === APERTURE_X_MIN - 1 || x === APERTURE_X_MAX + 1);
  if (besideMouth) return "pointDefense";
  if (onFront) {
    if (x === APERTURE_X_MIN - 2 || x === APERTURE_X_MAX + 2) return "flakCannon";
    if (x === HOME_X_MIN + 1 || x === HOME_X_MAX - 1) return "blaster";
    return "armor";
  }
  if (onFlank) {
    if (y === CORRIDOR_Y_MIN + 2) return "pointDefense";
    if (y === CORRIDOR_Y_MAX + 2) return "flakCannon";
    if (y === HOME_Y_MAX - 2) return "missile";
    return "armor";
  }
  if (onRear) {
    if (x === GRID_CENTER - 3 || x === GRID_CENTER + 3) return "missile";
    return "armor";
  }
  return "armor";
}

// Interior systems: power, cooling, repair and shielding spread through the
// structure rather than stacked in one destructible clump.
function homeStationInteriorPart(x, y, coreX, coreY) {
  if (x === coreX && y === coreY) return "core";
  const ring = Math.max(Math.abs(x - coreX), Math.abs(y - coreY));
  if (ring === 1) return (x + y) % 2 === 0 ? "auxGenerator" : "shield";
  switch ((x + y) % 5) {
    case 0: return "auxGenerator";
    case 1: return "radiator";
    case 2: return "repair";
    case 3: return "heatSink";
    default: return "shield";
  }
}

function buildHomeStationDesign() {
  const design = [];
  // The core sits in the rear body, behind the corridor, so it cannot be sniped
  // straight down the hangar mouth.
  const coreX = GRID_CENTER;
  const coreY = CORRIDOR_Y_MAX + Math.floor(BODY_CELLS / 2);
  for (let y = HOME_Y_MIN; y <= HOME_Y_MAX; y += 1) {
    for (let x = HOME_X_MIN; x <= HOME_X_MAX; x += 1) {
      if (inCorridorVoid(x, y)) continue;
      const type = surfaceDepth(x, y) === 0
        ? homeStationSurfacePart(x, y)
        : homeStationInteriorPart(x, y, coreX, coreY);
      design.push({ x, y, type, rotation: 0 });
    }
  }
  if (!design.some((module) => module.type === "core")) {
    const rear = design.find((module) => module.y === coreY) || design[0];
    rear.type = "core";
  }
  return design;
}

function buildRelayStationDesign() {
  const design = [];
  const half = Math.floor(RELAY_CELLS / 2);
  for (let y = GRID_CENTER - half; y <= GRID_CENTER + half; y += 1) {
    for (let x = GRID_CENTER - half; x <= GRID_CENTER + half; x += 1) {
      const ring = Math.max(Math.abs(x - GRID_CENTER), Math.abs(y - GRID_CENTER));
      let type;
      if (ring === 0) type = "core";
      else if (ring === 1) type = (x + y) % 2 === 0 ? "auxGenerator" : "shield";
      else if (ring === half) type = (x + y) % 5 === 0 ? "pointDefense" : "armor";
      else if ((x + y) % 4 === 0) type = "repair";
      else if ((x + y) % 4 === 2) type = "radiator";
      else type = "auxGenerator";
      design.push({ x, y, type, rotation: 0 });
    }
  }
  return design;
}

// --- Derived geometry --------------------------------------------------------

function stationModuleScale(stationType) {
  return stationType === "home" ? STATION_MODULE_SCALE : RELAY_MODULE_SCALE;
}

// The shared cell -> structure-local mapping, at a caller-supplied scale.
function cellToLocal(x, y, scale) {
  return { x: (GRID_CENTER - y) * scale, y: (x - GRID_CENTER) * scale };
}

// Axis-aligned local rectangle covering an inclusive cell range.
function cellRectToLocal(xMin, xMax, yMin, yMax, scale) {
  const half = scale / 2;
  const a = cellToLocal(xMin, yMin, scale);
  const b = cellToLocal(xMax, yMax, scale);
  return {
    minX: Math.min(a.x, b.x) - half,
    maxX: Math.max(a.x, b.x) + half,
    minY: Math.min(a.y, b.y) - half,
    maxY: Math.max(a.y, b.y) + half
  };
}

// Home station geometry in structure-local space, +x forward. Collision is
// compound on purpose: one circle would seal the hangar mouth, the single path
// that has to stay open.
function buildHomeStationGeometry() {
  const scale = STATION_MODULE_SCALE;
  const shell = cellRectToLocal(HOME_X_MIN, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX, scale);
  const aperture = cellRectToLocal(APERTURE_X_MIN, APERTURE_X_MAX, CORRIDOR_Y_MIN, CORRIDOR_Y_MAX, scale);
  const mouthX = shell.maxX;
  const rearWallX = aperture.minX;
  const halfWidth = (aperture.maxY - aperture.minY) / 2;

  return {
    moduleScale: scale,
    collisionRects: [
      // Left hull, full depth.
      cellRectToLocal(HOME_X_MIN, APERTURE_X_MIN - 1, HOME_Y_MIN, HOME_Y_MAX, scale),
      // Right hull, full depth.
      cellRectToLocal(APERTURE_X_MAX + 1, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX, scale),
      // Rear body closing the back of the corridor.
      cellRectToLocal(APERTURE_X_MIN, APERTURE_X_MAX, CORRIDOR_Y_MAX + 1, HOME_Y_MAX, scale)
    ],
    aperture: { x: mouthX, halfWidth, minY: aperture.minY, maxY: aperture.maxY },
    corridor: { rearWallX, mouthX, halfWidth, length: mouthX - rearWallX },
    // Centred in the corridor: the deepest point where a maximum ship's whole
    // padded hull is both clear of the rear wall and still behind the mouth.
    interiorSpawn: { x: (rearWallX + mouthX) / 2, y: 0 },
    // Where a launching ship's whole padded hull is outside the structure.
    releasePlaneX: mouthX + MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING,
    shell,
    maxShipExtent: MAX_SHIP_EXTENT,
    // Clearance the aperture grants a maximum ship on each side.
    clearance: halfWidth - MAX_SHIP_EXTENT / 2
  };
}

function buildRelayStationGeometry() {
  const scale = RELAY_MODULE_SCALE;
  const half = Math.floor(RELAY_CELLS / 2);
  const shell = cellRectToLocal(GRID_CENTER - half, GRID_CENTER + half, GRID_CENTER - half, GRID_CENTER + half, scale);
  return { moduleScale: scale, collisionRects: [shell], shell };
}

const HOME_STATION_CELLS = Object.freeze({
  gridCells: GRID_CELLS,
  corridorCells: CORRIDOR_CELLS,
  bodyCells: BODY_CELLS,
  apertureCells: APERTURE_CELLS,
  maxShipCells: MAX_SHIP_CELLS,
  xMin: HOME_X_MIN,
  xMax: HOME_X_MAX,
  yMin: HOME_Y_MIN,
  yMax: HOME_Y_MAX,
  apertureXMin: APERTURE_X_MIN,
  apertureXMax: APERTURE_X_MAX,
  corridorYMin: CORRIDOR_Y_MIN,
  corridorYMax: CORRIDOR_Y_MAX
});

module.exports = {
  SHIP_MODULE_SCALE,
  STATION_MODULE_SCALE,
  RELAY_MODULE_SCALE,
  GRID_CENTER,
  GRID_CELLS,
  MAX_SHIP_CELLS,
  MAX_SHIP_EXTENT,
  HULL_CELL_PADDING,
  HOME_STATION_CELLS,
  RELAY_CELLS,
  stationModuleScale,
  buildHomeStationDesign,
  buildRelayStationDesign,
  buildHomeStationGeometry,
  buildRelayStationGeometry,
  cellToLocal,
  cellRectToLocal,
  inCorridorVoid,
  PARTS_REFERENCE: PARTS
};
