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
//        | 4 wide |        252u          | 4 wide    |   v
//        +--------+----------------------+-----------+
//        |               rear body (8 cells)         |
//        +-------------------------------------------+
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

// Every launch opening is seven cells wide. The forward aperture retains the
// pre-experiment centreline and the side apertures use the same physical width.
const APERTURE_CELLS = 7;
const APERTURE_X_MIN = Math.floor((GRID_CELLS - APERTURE_CELLS) / 2); // 4
const APERTURE_X_MAX = APERTURE_X_MIN + APERTURE_CELLS - 1;           // 10

// Each physical corridor is seven cells deep (252u), enough for the maximum
// legal 195u ship plus the collision padding used by the movement system. The
// client may render a shorter ramp inside this authored opening.
const CORRIDOR_CELLS = 7;
const CORRIDOR_Y_MIN = HOME_Y_MIN;
const CORRIDOR_Y_MAX = CORRIDOR_Y_MIN + CORRIDOR_CELLS - 1; // 6
const BODY_CELLS = GRID_CELLS - CORRIDOR_CELLS;             // 8

const LAUNCH_BAY_CELL_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "forward",
    xMin: APERTURE_X_MIN,
    xMax: APERTURE_X_MAX,
    yMin: 0,
    yMax: CORRIDOR_Y_MAX,
    normal: Object.freeze({ x: 1, y: 0 })
  }),
  Object.freeze({
    id: "upper",
    xMin: 0,
    xMax: CORRIDOR_CELLS - 1,
    yMin: CORRIDOR_Y_MAX + 2,
    yMax: HOME_Y_MAX,
    normal: Object.freeze({ x: 0, y: -1 })
  }),
  Object.freeze({
    id: "lower",
    xMin: GRID_CELLS - CORRIDOR_CELLS,
    xMax: HOME_Y_MAX,
    yMin: CORRIDOR_Y_MAX + 2,
    yMax: HOME_Y_MAX,
    normal: Object.freeze({ x: 0, y: 1 })
  })
]);

const RELAY_CELLS = 9;
// Relays are structures too, but far smaller than a home station.
const RELAY_MODULE_SCALE = 20;

function inAperture(x) {
  return x >= APERTURE_X_MIN && x <= APERTURE_X_MAX;
}

function inLaunchBayVoid(x, y) {
  return LAUNCH_BAY_CELL_DEFINITIONS.some((bay) =>
    x >= bay.xMin && x <= bay.xMax && y >= bay.yMin && y <= bay.yMax
  );
}

// The station design builder uses this name for the authored empty cells. It
// now covers all three launch bays; there is no second hangar representation.
function inCorridorVoid(x, y) {
  return inLaunchBayVoid(x, y);
}

function cellAdjacentToLaunchBayVoid(x, y) {
  return inLaunchBayVoid(x + 1, y)
    || inLaunchBayVoid(x - 1, y)
    || inLaunchBayVoid(x, y + 1)
    || inLaunchBayVoid(x, y - 1);
}

function launchBayNormalForCell(x, y) {
  for (const bay of LAUNCH_BAY_CELL_DEFINITIONS) {
    if (bay.normal.x !== 0
      && y >= bay.yMin && y <= bay.yMax
      && (x === bay.xMin - 1 || x === bay.xMax + 1)) return bay.normal;
    if (bay.normal.y !== 0
      && x >= bay.xMin && x <= bay.xMax
      && (y === bay.yMin - 1 || y === bay.yMax + 1)) return bay.normal;
  }
  return null;
}

// Distance in cells to the nearest surface — the outer shell or a corridor wall.
function surfaceDepth(x, y) {
  let depth = Math.min(x - HOME_X_MIN, HOME_X_MAX - x, y - HOME_Y_MIN, HOME_Y_MAX - y);
  if (cellAdjacentToLaunchBayVoid(x, y)) depth = 0;
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

// Weapon batteries: point defence closest to the mouth (it protects the launch
// corridor), heavier mounts outboard and along the flanks. Every one is an
// ordinary weapon component running through the ordinary combat pipeline.
function homeStationSurfacePart(x, y) {
  const onFront = y === HOME_Y_MIN;
  const onFlank = x === HOME_X_MIN || x === HOME_X_MAX;
  const onRear = y === HOME_Y_MAX;
  // Corridor walls beside any of the three mouths.
  const besideMouth = cellAdjacentToLaunchBayVoid(x, y);
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
  { x: APERTURE_X_MIN - 1, y: CORRIDOR_Y_MIN + 2, rotation: 0 },
  { x: APERTURE_X_MAX + 1, y: CORRIDOR_Y_MIN + 2, rotation: 0 },
  { x: HOME_X_MIN, y: 5, rotation: 270 },
  { x: HOME_X_MAX, y: 5, rotation: 90 },
  { x: HOME_X_MIN, y: 7, rotation: 270 },
  { x: HOME_X_MAX, y: 7, rotation: 90 }
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
      // Batteries beside the hangar mouth stay bore-sighted down the launch
      // corridor; every other surface battery points off its own facing.
      // Only weapons are turned: armour plating is non-rotatable hull art.
      const besideMouth = cellAdjacentToLaunchBayVoid(x, y);
      const bayNormal = launchBayNormalForCell(x, y);
      const rotation = onSurface && PARTS[type]?.weapon && !besideMouth
        ? outwardRotation(x, y, HOME_X_MIN, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX)
        : bayNormal
          ? (bayNormal.x > 0 ? 0 : bayNormal.x < 0 ? 180 : bayNormal.y < 0 ? 270 : 90)
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

function buildLaunchBayGeometry(definition, scale) {
  const opening = cellRectToLocal(
    definition.xMin,
    definition.xMax,
    definition.yMin,
    definition.yMax,
    scale
  );
  const normal = { x: definition.normal.x, y: definition.normal.y };
  const lateralMin = normal.x !== 0 ? opening.minY : opening.minX;
  const lateralMax = normal.x !== 0 ? opening.maxY : opening.maxX;
  const lateralCentre = (lateralMin + lateralMax) / 2;
  const mouthCoordinate = normal.x > 0
    ? opening.maxX
    : normal.x < 0
      ? opening.minX
      : normal.y > 0
        ? opening.maxY
        : opening.minY;
  const innerCoordinate = normal.x > 0
    ? opening.minX
    : normal.x < 0
      ? opening.maxX
      : normal.y > 0
        ? opening.minY
        : opening.maxY;
  const corridorLength = Math.abs(mouthCoordinate - innerCoordinate);
  const halfWidth = (lateralMax - lateralMin) / 2;
  const localCentre = normal.x !== 0
    ? { x: (mouthCoordinate + innerCoordinate) / 2, y: lateralCentre }
    : { x: lateralCentre, y: (mouthCoordinate + innerCoordinate) / 2 };
  const interiorSpawn = { x: localCentre.x, y: localCentre.y };
  const mouth = normal.x !== 0
    ? { x: mouthCoordinate, y: lateralCentre }
    : { x: lateralCentre, y: mouthCoordinate };
  const safetyMargin = HULL_CELL_PADDING;
  const releaseOffset = MAX_SHIP_EXTENT / 2 + safetyMargin;
  const releasePlane = {
    x: mouth.x + normal.x * releaseOffset,
    y: mouth.y + normal.y * releaseOffset
  };
  const doorThickness = scale * 0.4;
  const doorRect = normal.x !== 0
    ? {
      minX: normal.x > 0 ? mouthCoordinate - doorThickness : mouthCoordinate,
      maxX: normal.x > 0 ? mouthCoordinate : mouthCoordinate + doorThickness,
      minY: lateralMin,
      maxY: lateralMax
    }
    : {
      minX: lateralMin,
      maxX: lateralMax,
      minY: normal.y > 0 ? mouthCoordinate - doorThickness : mouthCoordinate,
      maxY: normal.y > 0 ? mouthCoordinate : mouthCoordinate + doorThickness
    };

  return {
    id: definition.id,
    localCentre,
    localNormal: normal,
    apertureHalfWidth: halfWidth,
    apertureWidth: lateralMax - lateralMin,
    corridorDepth: corridorLength,
    corridorLength,
    rampDepth: Math.min(corridorLength * 0.4, scale * 2.5),
    interiorSpawn,
    mouth,
    innerWall: normal.x !== 0
      ? { x: innerCoordinate, y: lateralCentre }
      : { x: lateralCentre, y: innerCoordinate },
    releasePlane,
    releaseDistance: releasePlane.x * normal.x + releasePlane.y * normal.y,
    collisionOpening: { ...opening },
    doorRect,
    clearance: halfWidth - (MAX_SHIP_EXTENT / 2 + safetyMargin),
    maximumShipWidth: MAX_SHIP_EXTENT,
    maximumShipHeight: MAX_SHIP_EXTENT,
    safetyMargin
  };
}

// Home station geometry in structure-local space, +x forward. Collision is
// compound on purpose: one circle would seal all three launch openings. The
// solid cell runs below leave a connected central/armour structure between the
// forward, upper and lower voids.
function buildHomeStationGeometry() {
  const scale = STATION_MODULE_SCALE;
  const shell = cellRectToLocal(HOME_X_MIN, HOME_X_MAX, HOME_Y_MIN, HOME_Y_MAX, scale);
  const launchBays = LAUNCH_BAY_CELL_DEFINITIONS.map((definition) =>
    buildLaunchBayGeometry(definition, scale)
  );
  return {
    moduleScale: scale,
    collisionRects: [
      // Forward-face side hulls.
      cellRectToLocal(HOME_X_MIN, APERTURE_X_MIN - 1, HOME_Y_MIN, CORRIDOR_Y_MAX, scale),
      cellRectToLocal(APERTURE_X_MAX + 1, HOME_X_MAX, HOME_Y_MIN, CORRIDOR_Y_MAX, scale),
      // The solid band behind the forward bay connects the two arms.
      cellRectToLocal(HOME_X_MIN, HOME_X_MAX, CORRIDOR_Y_MAX + 1, CORRIDOR_Y_MAX + 1, scale),
      // The centre keel separates the upper and lower side openings and joins
      // the rear body to the cross-band.
      cellRectToLocal(GRID_CENTER, GRID_CENTER, CORRIDOR_Y_MAX + 2, HOME_Y_MAX, scale)
    ],
    launchBays,
    shell,
    maxShipExtent: MAX_SHIP_EXTENT,
    safetyMargin: HULL_CELL_PADDING
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
  launchBayCount: LAUNCH_BAY_CELL_DEFINITIONS.length,
  launchBayIds: Object.freeze(LAUNCH_BAY_CELL_DEFINITIONS.map((bay) => bay.id)),
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
  corridorYMax: CORRIDOR_Y_MAX,
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
  LAUNCH_BAY_CELL_DEFINITIONS,
  inLaunchBayVoid,
  launchBayNormalForCell,
  inCorridorVoid,
  PARTS_REFERENCE: PARTS
};
