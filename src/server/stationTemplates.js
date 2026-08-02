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
// (render bounds, collision cells, hangar dimensions) reads the scale, and
// it is exported here as the single source of truth.
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
//        | 4 wide |                      | 4 wide    |   v
//        +--------+----------------------+-----------+
//        |              rear body (8 cells)            |
//        +----------------------------------------------+
//
// The corridor is a genuine void in the design: no module occupies it, so the
// compound collision geometry leaves it open and a launching ship starts inside
// the structure rather than in front of it. Left and right hulls stay connected
// through the rear body, so generated wiring reaches every component.

const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");

// The ship module scale. Ships are laid out at 13 world units per cell.
const SHIP_MODULE_SCALE = 13;
// Stations use the same 15x15 grid at a larger scale. At scale 36 the authored
// 15-cell frontage is 540 world units, matching the pre-multi-hangar design.
const STATION_MODULE_SCALE = 36;
const GRID_CENTER = 7;
const GRID_CELLS = 15;

// The largest ship a player can design. Every hangar dimension derives
// from this and nothing else, so the two can never drift apart.
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
// its per-cell hull radius, passes with positive clearance on each side.
const APERTURE_CELLS = 7;
const APERTURE_X_MIN = Math.floor((GRID_CELLS - APERTURE_CELLS) / 2); // 4
const APERTURE_X_MAX = APERTURE_X_MIN + APERTURE_CELLS - 1;           // 10

// The physical corridor is seven cells deep (252u), enough for the maximum
// legal 195u ship plus the collision padding used by the movement system. The
// client may render a shorter ramp inside this authored opening.
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

// The station design builder uses this name for the authored empty cells.
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
    // The first rear-body row is the complete structural tile behind the
    // corridor. It closes the hangar instead of opening directly to space.
    depth = Math.min(depth, y - CORRIDOR_Y_MAX - 1);
  }
  return depth;
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

// Deliberate outer-wall hardpoints. Keep the hangar walls and rear body clear
// of gun chains: these are the only home-station guns, while repair emitters
// remain separately authored below.
const HOME_WEAPON_MOUNTS = Object.freeze([
  { x: 1, y: 0, type: "blaster" },
  { x: 13, y: 0, type: "blaster" },
  { x: 0, y: 2, type: "pointDefense" },
  { x: 14, y: 2, type: "pointDefense" },
  { x: 0, y: 4, type: "flakCannon" },
  { x: 14, y: 4, type: "flakCannon" },
  { x: 0, y: 10, type: "missile" },
  { x: 14, y: 10, type: "missile" },
  { x: 3, y: 14, type: "missile" },
  { x: 11, y: 14, type: "missile" }
]);

function homeWeaponMountAt(x, y) {
  return HOME_WEAPON_MOUNTS.find((mount) => mount.x === x && mount.y === y) || null;
}

function homeStationSurfacePart(x, y) {
  return homeWeaponMountAt(x, y)?.type || "armor";
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
// Two flank the forward launch mouth (a ship limping home is repaired on final
// approach) and four sit along the flanks. Every one is an ordinary repairBeam
// component: it traverses, draws a beam and heals through the same pipeline a
// support ship's emitter does, just at the station's longer reach.
//
// repairBeam has a 1x2 footprint, so each emitter also consumes the cell it
// extends into — always inward, given these rotations — and the body fill skips
// those cells rather than stacking two modules on one square.
const HOME_REPAIR_BEAM_MOUNTS = Object.freeze([
  { x: APERTURE_X_MIN - 1, y: CORRIDOR_Y_MIN + 2, rotation: 0 },
  { x: APERTURE_X_MAX + 1, y: CORRIDOR_Y_MIN + 2, rotation: 0 },
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
      const onSurface = surfaceDepth(x, y) === 0;
      const type = onSurface
        ? homeStationSurfacePart(x, y)
        : homeStationInteriorPart(x, y, coreX, coreY);
      // Only authored outer-wall weapons are turned; armour is non-rotatable
      // hull art and the corridor walls contain no gun mounts.
      const rotation = onSurface && PARTS[type]?.weapon
        ? outwardRotation(x, y, HOME_X_MIN, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX)
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
// compound on purpose: one circle would seal the hangar mouth. The left and
// right hulls are full-depth and the rear body is a complete structural tile
// behind the seven-cell corridor.
function buildHomeStationGeometry() {
  const scale = STATION_MODULE_SCALE;
  const shell = cellRectToLocal(HOME_X_MIN, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX, scale);
  const aperture = cellRectToLocal(
    APERTURE_X_MIN,
    APERTURE_X_MAX,
    CORRIDOR_Y_MIN,
    CORRIDOR_Y_MAX,
    scale
  );
  const mouthX = shell.maxX;
  const rearWallX = aperture.minX;
  const halfWidth = (aperture.maxY - aperture.minY) / 2;
  const releasePlaneX = mouthX + MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING;
  const doorRect = {
    minX: mouthX - scale * 0.4,
    maxX: mouthX,
    minY: aperture.minY,
    maxY: aperture.maxY
  };
  const hangar = {
    id: "central",
    localNormal: { x: 1, y: 0 },
    localCentre: { x: (rearWallX + mouthX) / 2, y: 0 },
    aperture: { x: mouthX, halfWidth, minY: aperture.minY, maxY: aperture.maxY },
    apertureWidth: aperture.maxY - aperture.minY,
    apertureHalfWidth: halfWidth,
    corridor: { rearWallX, mouthX, halfWidth, length: mouthX - rearWallX },
    corridorLength: mouthX - rearWallX,
    interiorSpawn: { x: (rearWallX + mouthX) / 2, y: 0 },
    mouth: { x: mouthX, y: 0 },
    innerWall: { x: rearWallX, y: 0 },
    releasePlane: { x: releasePlaneX, y: 0 },
    releaseDistance: releasePlaneX,
    collisionOpening: { ...aperture },
    doorRect,
    maximumShipWidth: MAX_SHIP_EXTENT,
    maximumShipHeight: MAX_SHIP_EXTENT,
    clearance: halfWidth - (MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING),
    safetyMargin: HULL_CELL_PADDING
  };
  return {
    moduleScale: scale,
    collisionRects: [
      // Left and right hulls run the full station depth.
      cellRectToLocal(HOME_X_MIN, APERTURE_X_MIN - 1, HOME_Y_MIN, HOME_Y_MAX, scale),
      cellRectToLocal(APERTURE_X_MAX + 1, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX, scale),
      // One complete rear-body tile closes the corridor and connects both wings.
      cellRectToLocal(APERTURE_X_MIN, APERTURE_X_MAX, CORRIDOR_Y_MAX + 1, HOME_Y_MAX, scale)
    ],
    aperture: hangar.aperture,
    corridor: hangar.corridor,
    hangar,
    doorRect,
    interiorSpawn: hangar.interiorSpawn,
    releasePlaneX,
    shell,
    maxShipExtent: MAX_SHIP_EXTENT,
    safetyMargin: HULL_CELL_PADDING,
    clearance: hangar.clearance
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
  hangarCount: 1,
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
  moduleCentreToLocal,
  outwardRotation,
  inAperture,
  inCorridorVoid,
  PARTS_REFERENCE: PARTS
};
