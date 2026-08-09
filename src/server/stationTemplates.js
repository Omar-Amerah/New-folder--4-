"use strict";

// Authoritative developer-authored station designs (station infrastructure
// mode). These are ordinary component designs — not player blueprints, never
// exposed to the designer — so every downstream system (component HP, power,
// heat, weapons, point defence, repair) treats a station exactly like any other
// component structure.
//
// WHY STATIONS SHARE THE 15x15 GRID BUT NOT THE SHIP MODULE SCALE
// Stations stay within the same 15x15 grid as ship designs and get their size
// from a larger MODULE SCALE instead. Component systems are
// index-based, so nothing about power, heat or damage notices; only geometry
// (render bounds, collision cells, hangar dimensions) reads the scale, and
// it is exported here as the single source of truth.
//
// STATION_MODULE_SCALE = 56 gives the historical three-corridor home station
// its 15-cell, 840-unit front. The three openings are authored in cell space;
// every renderer and collision path derives from this same record.
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
// Each corridor is a genuine void in the design: no module occupies it, so the
// compound collision geometry leaves all three open. The outer hulls and the
// dividing walls stay connected through the rear body.

const { PARTS } = require("./components");
const { getOccupiedCells } = require("./footprint");

// The ship module scale. Ships are laid out at 13 world units per cell.
const SHIP_MODULE_SCALE = 13;
// Stations use the same 15x15 grid at a larger scale. The three historical
// launch corridors use the full 15-cell frontage at scale 56.
const STATION_MODULE_SCALE = 56;
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

// Three symmetric corridors: [hull][bay][wall][bay][wall][bay][hull].
const HANGAR_BAY_COUNT = 3;
const APERTURE_CELLS = 3;
const HANGAR_BAY_CELLS = Object.freeze([2, 6, 10].map((xMin) => Object.freeze({
  xMin,
  xMax: xMin + APERTURE_CELLS - 1
})));

// The component design remains on the 15x15 grid, but the physical frontage is
// fractional. A 216-unit opening gives the maximum legal hull (195 units plus
// its 9.19-unit collision-cell padding on each side) positive clearance while
// preserving the 840-unit station shell. The remaining frontage is two 88-unit
// shoulders and two 8-unit divider noses.
const HANGAR_APERTURE_WIDTH = 216;
const HANGAR_DIVIDER_WIDTH = 8;
const HANGAR_APERTURE_HALF_WIDTH = HANGAR_APERTURE_WIDTH / 2;

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

// The physical corridors are seven cells deep (392u), enough for the maximum
// legal 195u ship plus the collision padding used by the movement system. The
// client may render a shorter ramp inside this authored opening.
const CORRIDOR_CELLS = 7;
const CORRIDOR_Y_MIN = HOME_Y_MIN;
const CORRIDOR_Y_MAX = CORRIDOR_Y_MIN + CORRIDOR_CELLS - 1; // 6
const BODY_CELLS = GRID_CELLS - CORRIDOR_CELLS;             // 8

const RELAY_CELLS = 9;
// Relays are structures too, but far smaller than a home station.
const RELAY_MODULE_SCALE = 20;

function inCorridorVoid(x, y) {
  return bayIndexAt(x) >= 0 && y >= CORRIDOR_Y_MIN && y <= CORRIDOR_Y_MAX;
}

function isSolidCell(x, y) {
  if (x < HOME_X_MIN || x > HOME_X_MAX || y < HOME_Y_MIN || y > HOME_Y_MAX) return false;
  return !inCorridorVoid(x, y);
}

function onHullSurface(x, y) {
  return !isSolidCell(x - 1, y) || !isSolidCell(x + 1, y)
    || !isSolidCell(x, y - 1) || !isSolidCell(x, y + 1);
}

function homeSurfaceRotation(x, y) {
  if (!isSolidCell(x, y - 1)) return 0;
  if (!isSolidCell(x, y + 1)) return 180;
  if (!isSolidCell(x - 1, y)) return 270;
  if (!isSolidCell(x + 1, y)) return 90;
  return 0;
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

// Deliberate outer-wall hardpoints. The historical station had continuous
// weapon chains through the corridor walls; keep only a small set of readable
// corner, divider-nose and outer-wall positions instead.
const HOME_WEAPON_MOUNTS = Object.freeze([
  { x: 1, y: 0, type: "blaster" },
  { x: 5, y: 0, type: "pointDefense" },
  { x: 9, y: 0, type: "pointDefense" },
  { x: 13, y: 0, type: "blaster" },
  { x: 0, y: 3, type: "flakCannon" },
  { x: 14, y: 3, type: "flakCannon" },
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
  { x: HOME_X_MIN + 1, y: CORRIDOR_Y_MIN + 1, rotation: 0 },
  { x: HOME_X_MAX - 1, y: CORRIDOR_Y_MIN + 1, rotation: 0 },
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
      // Weapons on the station surface face the open side of their actual
      // hull cell. Interior armour remains unrotated.
      const rotation = onSurface && PARTS[type]?.weapon
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
// compound on purpose: one circle would seal all three hangar mouths. Each
// authored bay gets its own launch record and door while the hull columns and
// rear body remain shared structural pieces.
function buildHomeStationGeometry() {
  const scale = STATION_MODULE_SCALE;
  const shell = cellRectToLocal(HOME_X_MIN, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX, scale);
  const mouthX = shell.maxX;
  const corridorLength = CORRIDOR_CELLS * scale;
  const rearWallX = mouthX - corridorLength;
  const releasePlaneX = mouthX + MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING;
  const hangars = HANGAR_BAY_CELLS.map((cells, index) => {
    const centreY = ((cells.xMin + cells.xMax) / 2 - GRID_CENTER) * scale;
    const halfWidth = HANGAR_APERTURE_HALF_WIDTH;
    const minY = centreY - halfWidth;
    const maxY = centreY + halfWidth;
    const aperture = {
      x: mouthX,
      halfWidth,
      minY,
      maxY
    };
    const doorRect = {
      minX: mouthX - scale * 0.4,
      maxX: mouthX,
      minY,
      maxY
    };
    return {
      id: ["left", "central", "right"][index] || `hangar-${index}`,
      index,
      localNormal: { x: 1, y: 0 },
      localCentre: { x: (rearWallX + mouthX) / 2, y: centreY },
      centreY,
      aperture,
      apertureWidth: HANGAR_APERTURE_WIDTH,
      apertureHalfWidth: halfWidth,
      minY,
      maxY,
      corridor: { rearWallX, mouthX, halfWidth, length: corridorLength },
      corridorLength,
      interiorSpawn: { x: (rearWallX + mouthX) / 2, y: centreY },
      mouth: { x: mouthX, y: centreY },
      innerWall: { x: rearWallX, y: centreY },
      releasePlane: { x: releasePlaneX, y: centreY },
      releaseDistance: releasePlaneX,
      collisionOpening: { minX: rearWallX, maxX: mouthX, minY, maxY },
      doorRect,
      maximumShipWidth: MAX_SHIP_EXTENT,
      maximumShipHeight: MAX_SHIP_EXTENT,
      clearance: halfWidth - (MAX_SHIP_EXTENT / 2 + HULL_CELL_PADDING),
      safetyMargin: HULL_CELL_PADDING
    };
  });

  // The four solid frontage segments are authored from the aperture records,
  // not from whole grid columns. The rear body closes the corridor behind the
  // shared rear wall; together these five rectangles are the complete shell
  // minus the three exact hangar voids.
  const solidFrontage = [
    { minY: shell.minY, maxY: hangars[0].minY },
    { minY: hangars[0].maxY, maxY: hangars[1].minY },
    { minY: hangars[1].maxY, maxY: hangars[2].minY },
    { minY: hangars[2].maxY, maxY: shell.maxY }
  ].map((segment) => ({ minX: rearWallX, maxX: mouthX, ...segment }));
  const rearBody = {
    minX: shell.minX,
    maxX: rearWallX,
    minY: shell.minY,
    maxY: shell.maxY
  };
  return {
    moduleScale: scale,
    collisionRects: [...solidFrontage, rearBody],
    doorRects: hangars.map((hangar) => hangar.doorRect),
    hangars,
    frontage: {
      apertureWidth: HANGAR_APERTURE_WIDTH,
      dividerWidth: HANGAR_DIVIDER_WIDTH,
      outerShoulderWidth: (shell.maxY - shell.minY
        - HANGAR_BAY_COUNT * HANGAR_APERTURE_WIDTH
        - (HANGAR_BAY_COUNT - 1) * HANGAR_DIVIDER_WIDTH) / 2,
      solidFrontage,
      rearBody
    },
    releasePlaneX,
    shell,
    maxShipExtent: MAX_SHIP_EXTENT,
    safetyMargin: HULL_CELL_PADDING,
    clearance: hangars[Math.floor(hangars.length / 2)].clearance
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
  hangarCount: HANGAR_BAY_COUNT,
  corridorCells: CORRIDOR_CELLS,
  bodyCells: BODY_CELLS,
  apertureCells: APERTURE_CELLS,
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
  HANGAR_APERTURE_WIDTH,
  HANGAR_APERTURE_HALF_WIDTH,
  HANGAR_DIVIDER_WIDTH,
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
  inCorridorVoid,
  isSolidCell,
  onHullSurface,
  bayIndexAt,
  HANGAR_BAY_COUNT,
  HANGAR_BAY_CELLS,
  PARTS_REFERENCE: PARTS
};
