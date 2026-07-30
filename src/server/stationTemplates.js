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
// STATION_MODULE_SCALE = 56 gives a 15-cell station front of 840 world units
// against a maximum 15x15 ship's 195 — a 4.3x ratio. The station is deliberately
// larger than the single-bay design it replaced: a team's home station now
// carries THREE launch bays side by side, one per player (up to three), and
// three bays cannot share a 540u front face.
//
// GRID CONVENTION
// Client and server both map a design cell to structure-local space as
//   local.x = (7 - cell.y) * scale      // +x is FORWARD
//   local.y = (cell.x - 7) * scale      // +y is lateral
// so a station's hangars face +x by opening at the LOWEST cell y, and each
// aperture's width runs along cell x.
//
// HOME STATION LAYOUT (cell space, front at the top / low y)
//
//        <---------------- 15 cells (840u) ---------------->
//        +----+-----+---+-----+---+-----+----+   <- front face (y=0)
//        |hull| bay |wal| bay |wal| bay |hull|
//        | 2  |  3  | 1 |  3  | 1 |  3  |  2 |   ^ 7 cells deep
//        |x0-1|x2-4 |x5 |x6-8 |x9 |x10-12|x13-14  v
//        +----+-----+---+-----+---+-----+----+
//        |            rear body (8 cells)    |
//        +-----------------------------------+
//
// Each bay is a genuine void in the design: no module occupies it, so the
// compound collision geometry leaves all three open. The outer hulls and the
// two dividing walls stay connected through the rear body, so generated wiring
// reaches every component.
//
// A bay is 3 cells (168u) wide, which is narrower than a maximum 15x15 hull
// (195u). That is deliberate and safe: a ship under launch control ignores its
// own station's collision entirely (see resolveStationCollision) and is pinned
// to its bay centreline until it clears the release plane, so an oversized hull
// simply pushes out through the bay mouth rather than jamming in it.

const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");

// The ship module scale. Ships are laid out at 13 world units per cell.
const SHIP_MODULE_SCALE = 13;
// Stations use the same 15x15 grid at a larger scale (see the note above). Three
// launch bays plus their dividing walls need the whole front face, so the scale
// carries the size instead of the cell count: 56 gives 168u bays, wide enough
// for every hull a player builds in practice, and a station that still fits
// inside its spawn region.
const STATION_MODULE_SCALE = 56;
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

// Three bays of three cells each, symmetric about the grid centre: outer hulls
// of two cells, single-cell dividing walls between neighbouring bays.
//   [0-1 hull][2-4 bay][5 wall][6-8 bay][9 wall][10-12 bay][13-14 hull]
// One player on the team gets the middle bay, two get the outer pair, three get
// all of them (see hangarBayForPlayer in stations.js).
const HANGAR_BAY_COUNT = 3;
const APERTURE_CELLS = 3;
const HANGAR_BAY_CELLS = Object.freeze([2, 6, 10].map((xMin) => Object.freeze({
  xMin,
  xMax: xMin + APERTURE_CELLS - 1
})));

// Corridor depth: seven cells (392u), so a full 195u ship sits entirely inside
// the station before it moves.
const CORRIDOR_CELLS = 7;
const CORRIDOR_Y_MIN = HOME_Y_MIN;
const CORRIDOR_Y_MAX = CORRIDOR_Y_MIN + CORRIDOR_CELLS - 1; // 6
const BODY_CELLS = GRID_CELLS - CORRIDOR_CELLS;             // 8

const RELAY_CELLS = 9;
// Relays are structures too, but far smaller than a home station.
const RELAY_MODULE_SCALE = 20;

// The solid hull columns left between and beside the bays, as inclusive cell
// ranges. Collision, wiring connectivity and the surface-part table all read
// this rather than re-deriving the gaps.
const HOME_HULL_COLUMNS = Object.freeze([
  Object.freeze({ xMin: 0, xMax: 1 }),
  Object.freeze({ xMin: 5, xMax: 5 }),
  Object.freeze({ xMin: 9, xMax: 9 }),
  Object.freeze({ xMin: 13, xMax: 14 })
]);

function bayIndexAt(x) {
  for (let i = 0; i < HANGAR_BAY_CELLS.length; i += 1) {
    const bay = HANGAR_BAY_CELLS[i];
    if (x >= bay.xMin && x <= bay.xMax) return i;
  }
  return -1;
}
function inCorridorVoid(x, y) {
  return bayIndexAt(x) >= 0 && y >= CORRIDOR_Y_MIN && y <= CORRIDOR_Y_MAX;
}

function isSolidCell(x, y) {
  if (x < HOME_X_MIN || x > HOME_X_MAX || y < HOME_Y_MIN || y > HOME_Y_MAX) return false;
  return !inCorridorVoid(x, y);
}

// A cell is on the hull surface when it touches open space — the outside of the
// shell or one of the three bay voids. With bays cut into the front face the old
// closed-form depth formula no longer describes the shape, so it is read
// straight off the cell occupancy instead.
function onHullSurface(x, y) {
  return !isSolidCell(x - 1, y) || !isSolidCell(x + 1, y)
    || !isSolidCell(x, y - 1) || !isSolidCell(x, y + 1);
}

// The rotation that points a surface module away from the hull it is mounted
// on, in the grid convention above (+x forward comes from the LOWEST cell y).
//   front  (y = min)  -> +x  ->   0
//   rear   (y = max)  -> -x  -> 180
//   x = min           -> -y  -> 270
//   x = max           -> +y  ->  90
// This matters for gameplay, not just looks: a weapon's firing arc is measured
// from its blueprint facing, so leaving every battery at rotation 0 would give a
// 125-degree blaster and a 220-degree missile launcher mounted on the REAR of
// the station an arc that cannot reach anything behind it.
function outwardRotation(x, y, xMin, xMax, yMin, yMax) {
  const toFront = y - yMin;
  const toRear = yMax - y;
  const toLeft = x - xMin;
  const toRight = xMax - x;
  const nearest = Math.min(toFront, toRear, toLeft, toRight);
  if (nearest === toFront) return 0;
  if (nearest === toRear) return 180;
  if (nearest === toLeft) return 270;
  return 90;
}

// The rotation that points a home-station surface module away from the solid it
// is mounted on, choosing whichever adjacent cell is actually open. Bay walls
// therefore face into their bay and the shell faces out of the station.
function homeSurfaceRotation(x, y) {
  if (!isSolidCell(x, y - 1)) return 0;    // open ahead  -> +x
  if (!isSolidCell(x, y + 1)) return 180;  // open behind -> -x
  if (!isSolidCell(x - 1, y)) return 270;  // open to -y
  if (!isSolidCell(x + 1, y)) return 90;   // open to +y
  return 0;
}

// Weapon batteries: point defence lines the bay walls (it protects the launch
// corridors), heavier mounts outboard and along the flanks. Every one is an
// ordinary weapon component running through the ordinary combat pipeline.
function homeStationSurfacePart(x, y) {
  const onFront = y === HOME_Y_MIN;
  const onFlank = x === HOME_X_MIN || x === HOME_X_MAX;
  const onRear = y === HOME_Y_MAX;
  // Bay walls: any solid cell inside the corridor band that borders a bay.
  const onBayWall = y <= CORRIDOR_Y_MAX
    && (bayIndexAt(x - 1) >= 0 || bayIndexAt(x + 1) >= 0);
  if (onBayWall && !onFront) {
    if (y === CORRIDOR_Y_MIN + 1 || y === CORRIDOR_Y_MAX - 1) return "pointDefense";
    return "armor";
  }
  if (onFront) {
    // The dividing walls between bays are single cells: give their noses point
    // defence so every launch corridor is covered from both sides.
    if (bayIndexAt(x - 1) >= 0 && bayIndexAt(x + 1) >= 0) return "pointDefense";
    if (bayIndexAt(x - 1) >= 0 || bayIndexAt(x + 1) >= 0) return "flakCannon";
    return "blaster";
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

// Long-range repair emitters, mounted on the hull surface and pointing off it.
// Two flank the hangar mouth (a ship limping home is repaired on final
// approach) and four sit along the flanks. Every one is an ordinary repairBeam
// component: it traverses, draws a beam and heals through the same pipeline a
// support ship's emitter does, just at the station's longer reach.
//
// repairBeam has a 1x2 footprint, so each emitter also consumes the cell it
// extends into — always inward, given these rotations — and the body fill skips
// those cells rather than stacking two modules on one square.
const HOME_REPAIR_BEAM_MOUNTS = Object.freeze([
  // Nose of each dividing wall, between two bays: a hull limping into either
  // corridor is under a beam on final approach.
  { x: 5, y: CORRIDOR_Y_MIN + 1, rotation: 0 },
  { x: 9, y: CORRIDOR_Y_MIN + 1, rotation: 0 },
  { x: HOME_X_MIN, y: 5, rotation: 270 },
  { x: HOME_X_MAX, y: 5, rotation: 90 },
  { x: HOME_X_MIN, y: 9, rotation: 270 },
  { x: HOME_X_MAX, y: 9, rotation: 90 }
]);

function buildHomeStationDesign() {
  const design = [];
  // The core sits in the rear body, behind the corridor, so it cannot be sniped
  // straight down the hangar mouth.
  const coreX = GRID_CENTER;
  const coreY = CORRIDOR_Y_MAX + Math.floor(BODY_CELLS / 2);
  // Cells the repair emitters occupy, so the body fill leaves them alone.
  const emitterCells = new Set();
  const emitterAt = new Map();
  for (const mount of HOME_REPAIR_BEAM_MOUNTS) {
    emitterAt.set(`${mount.x},${mount.y}`, mount);
    for (const cell of getOccupiedCells(mount.x, mount.y, PARTS.repairBeam.footprint, mount.rotation)) {
      emitterCells.add(`${cell.x},${cell.y}`);
    }
  }
  for (let y = HOME_Y_MIN; y <= HOME_Y_MAX; y += 1) {
    for (let x = HOME_X_MIN; x <= HOME_X_MAX; x += 1) {
      if (inCorridorVoid(x, y)) continue;
      const key = `${x},${y}`;
      const emitter = emitterAt.get(key);
      if (emitter) {
        design.push({ x, y, type: "repairBeam", rotation: emitter.rotation });
        continue;
      }
      if (emitterCells.has(key)) continue;
      const onSurface = onHullSurface(x, y);
      const type = onSurface
        ? homeStationSurfacePart(x, y)
        : homeStationInteriorPart(x, y, coreX, coreY);
      // Batteries on a bay wall stay bore-sighted down their launch corridor;
      // every other surface battery points off its own facing. Only weapons are
      // turned: armour plating is non-rotatable hull art.
      const onBayNose = y === HOME_Y_MIN && (bayIndexAt(x - 1) >= 0 || bayIndexAt(x + 1) >= 0);
      const rotation = onSurface && PARTS[type]?.weapon && !onBayNose
        ? homeSurfaceRotation(x, y)
        : 0;
      design.push({ x, y, type, rotation });
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
      // Ring batteries face out of the relay so their idle pose reads as a
      // defensive perimeter rather than six guns all staring the same way.
      const rotation = PARTS[type]?.weapon
        ? outwardRotation(x, y, GRID_CENTER - half, GRID_CENTER + half, GRID_CENTER - half, GRID_CENTER + half)
        : 0;
      design.push({ x, y, type, rotation });
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

// A placed module's centre in structure-local space, footprint aware. This is
// the one mapping every station system must agree on: the renderer draws a
// weapon here, the combat code fires from here, and both read it from the same
// function so a shot can never leave from somewhere the barrel is not.
function moduleCentreToLocal(module, scale, footprint) {
  const width = footprint?.width || 1;
  const height = footprint?.height || 1;
  return cellToLocal(
    (Number(module.x) || 0) + (width - 1) / 2,
    (Number(module.y) || 0) + (height - 1) / 2,
    scale
  );
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
// compound on purpose: one circle would seal the bay mouths, the three paths
// that have to stay open.
function buildHomeStationGeometry() {
  const scale = STATION_MODULE_SCALE;
  const shell = cellRectToLocal(HOME_X_MIN, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX, scale);
  const mouthX = shell.maxX;
  const releasePlaneX = mouthX + MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING;

  const bays = HANGAR_BAY_CELLS.map((cells, index) => {
    const rect = cellRectToLocal(cells.xMin, cells.xMax, CORRIDOR_Y_MIN, CORRIDOR_Y_MAX, scale);
    const rearWallX = rect.minX;
    const halfWidth = (rect.maxY - rect.minY) / 2;
    // Each bay runs parallel to the station's nose, offset laterally by its
    // centreline. Everything downstream measures ALONG +x and ACROSS from this
    // centreY, so the three bays share one set of maths.
    const centreY = (rect.minY + rect.maxY) / 2;
    return {
      index,
      centreY,
      halfWidth,
      minY: rect.minY,
      maxY: rect.maxY,
      mouthX,
      rearWallX,
      length: mouthX - rearWallX,
      // Centred in the corridor: the deepest point where a hull is both clear
      // of the rear wall and still behind the mouth.
      interiorSpawn: { x: (rearWallX + mouthX) / 2, y: centreY },
      // Where a launching ship's whole padded hull is outside the structure.
      releasePlaneX,
      // The blast door across this bay's mouth. Doors are NOT part of
      // collisionRects: they are solid to everything except a hull under launch
      // control, so ships may leave a bay but nothing may fly back in.
      doorRect: {
        minX: mouthX - scale * 0.4,
        maxX: mouthX,
        minY: rect.minY,
        maxY: rect.maxY
      }
    };
  });

  const primary = bays[Math.floor(bays.length / 2)];

  return {
    moduleScale: scale,
    bayCount: bays.length,
    bays,
    collisionRects: [
      // The outer hulls and the two dividing walls, each full depth.
      ...HOME_HULL_COLUMNS.map((column) =>
        cellRectToLocal(column.xMin, column.xMax, HOME_Y_MIN, HOME_Y_MAX, scale)),
      // Rear body closing the back of all three corridors.
      cellRectToLocal(HANGAR_BAY_CELLS[0].xMin, HANGAR_BAY_CELLS[HANGAR_BAY_CELLS.length - 1].xMax,
        CORRIDOR_Y_MAX + 1, HOME_Y_MAX, scale)
    ],
    doorRects: bays.map((bay) => bay.doorRect),
    // Back-compatible single-bay view, describing the centre bay. Callers that
    // predate multi-bay stations keep working and address the middle corridor.
    aperture: { x: mouthX, halfWidth: primary.halfWidth, minY: primary.minY, maxY: primary.maxY },
    corridor: { rearWallX: primary.rearWallX, mouthX, halfWidth: primary.halfWidth, length: primary.length },
    doorRect: primary.doorRect,
    interiorSpawn: primary.interiorSpawn,
    releasePlaneX,
    shell,
    maxShipExtent: MAX_SHIP_EXTENT,
    // Clearance a bay grants a maximum ship on each side. Negative for a full
    // 15x15 hull, which is expected: launching ships ignore their own station's
    // collision (see resolveStationCollision) and push straight out.
    clearance: primary.halfWidth - MAX_SHIP_EXTENT / 2
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
  bayCount: HANGAR_BAY_COUNT,
  bays: HANGAR_BAY_CELLS,
  hullColumns: HOME_HULL_COLUMNS,
  maxShipCells: MAX_SHIP_CELLS,
  xMin: HOME_X_MIN,
  xMax: HOME_X_MAX,
  yMin: HOME_Y_MIN,
  yMax: HOME_Y_MAX,
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
  HANGAR_BAY_COUNT,
  HANGAR_BAY_CELLS,
  RELAY_CELLS,
  stationModuleScale,
  buildHomeStationDesign,
  buildRelayStationDesign,
  buildHomeStationGeometry,
  buildRelayStationGeometry,
  cellToLocal,
  cellRectToLocal,
  moduleCentreToLocal,
  outwardRotation,
  inCorridorVoid,
  isSolidCell,
  onHullSurface,
  bayIndexAt,
  PARTS_REFERENCE: PARTS
};
