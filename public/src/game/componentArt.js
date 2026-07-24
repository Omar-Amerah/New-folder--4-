// Component artwork and static-texture drawing for ships and blueprints.
//
// This is the artwork/baking module: every Canvas 2D routine that paints a
// ship component lives here (drawing into the shared `ctx`, which callers may
// temporarily point at an offscreen canvas via withCanvasContext for texture
// baking). The arena frame renderers do not define art; they compose it.
//
// The module exposes an explicit static/dynamic split for weapons:
//   drawStaticComponentBase  - the occupied hull block(s) for a part
//   drawStaticWeaponMount    - the non-directional weapon socket/housing
//   drawRotatingWeaponTop    - ONLY the rotating weapon top (barrels, rails,
//                              launcher/emitter heads), transparent background,
//                              centred pivot, local +x = weapon-forward
// Static hull textures must never contain rotating weapon tops, and rotating
// turret textures must never contain hull blocks or sockets.

import { ctx } from "../ui/dom.js";
import { PART_STATS } from "../design/parts.js";
import { qualityShadowBlur } from "./renderSettings.js";
import { moduleLocalPosition } from "./shipGeometry.js";

// --- Shared primitives --------------------------------------------------------

export function roundRect(context, { x, y, width, height, radius }) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

const STRUCTURAL_PARTS = new Set([
  "frame", "armor", "compositeArmor",
  "halfFrameDiagonal", "halfArmorDiagonal", "halfCompositeArmorDiagonal",
  "wingFrame", "wingArmor", "wingCompositeArmor",
  "lightFrame", "heavyFrame"
]);

function parseColor(color) {
  if (typeof color !== "string") return { r: 148, g: 163, b: 184 };
  if (color[0] === "#") {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(",").map((v) => parseFloat(v));
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0 };
  }
  return { r: 148, g: 163, b: 184 };
}

// Blends colour a toward colour b (t in 0..1), returning an opaque rgb() string.
export function mixColor(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r},${g},${bl})`;
}

// Module fill gradients are defined in local module space, so one gradient per
// (size, color) pair serves every module of that type on screen. The gradient
// alone carries a soft top-left→bottom-right bevel so bodies read as raised
// metal panels without a per-module outline.
const moduleGradientCache = new Map();

function getModuleGradient(size, color) {
  const key = `${size}|${color}`;
  let fill = moduleGradientCache.get(key);
  if (!fill) {
    fill = ctx.createLinearGradient(-size * 0.5, -size * 0.5, size * 0.5, size * 0.5);
    fill.addColorStop(0, mixColor(color, "#ffffff", 0.52));
    fill.addColorStop(0.32, mixColor(color, "#ffffff", 0.14));
    fill.addColorStop(0.6, color);
    fill.addColorStop(1, mixColor(color, "#05070c", 0.74));
    moduleGradientCache.set(key, fill);
  }
  return fill;
}

// Draws a light top-left bevel highlight and a dark bottom-right seam along a
// rounded-square footprint, giving flat plate modules a consistent raised look.
function bevelRoundedPlate(size, inset, radius) {
  const s = size * inset;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = Math.max(0.7, size * 0.045);
  ctx.beginPath();
  ctx.moveTo(-s + radius, -s + size * 0.02);
  ctx.lineTo(s - radius, -s + size * 0.02);
  ctx.moveTo(-s + size * 0.02, -s + radius);
  ctx.lineTo(-s + size * 0.02, s - radius);
  ctx.stroke();
  ctx.strokeStyle = "rgba(3,6,12,0.45)";
  ctx.beginPath();
  ctx.moveTo(-s + radius, s - size * 0.02);
  ctx.lineTo(s - radius, s - size * 0.02);
  ctx.moveTo(s - size * 0.02, -s + radius);
  ctx.lineTo(s - size * 0.02, s - radius);
  ctx.stroke();
  ctx.restore();
}

// Fills + dark-edges a rounded-square body and adds the shared bevel. Used by
// the many system modules that share this plate footprint.
function drawPlateBody(size, inset = 0.44, radius = size * 0.12) {
  const s = size * inset;
  roundRect(ctx, { x: -s, y: -s, width: s * 2, height: s * 2, radius });
  ctx.fill();
  ctx.stroke();
  bevelRoundedPlate(size, inset, radius);
}

// Every regular component is mounted to a cell-filling hull cube. The detailed
// module art is painted over this lower plate, so distinctive silhouettes (for
// example a railgun's rails) remain intact without leaving an apparently empty
// blueprint cell. Wings and diagonal half blocks intentionally keep their
// original cut-away silhouettes.
function drawComponentCubeBase(size, color) {
  const inset = 0.5;
  const extent = size * inset;
  ctx.save();
  // The cube carries the component's own colour with the shared bevel gradient
  // so the ship reads as brightly as the pre-cube art did.
  ctx.fillStyle = getModuleGradient(size, color);
  ctx.strokeStyle = "rgba(3,6,12,0.82)";
  ctx.lineWidth = Math.max(0.9, size * 0.065);
  roundRect(ctx, {
    x: -extent,
    y: -extent,
    width: extent * 2,
    height: extent * 2,
    radius: size * 0.055
  });
  ctx.fill();
  ctx.stroke();
  bevelRoundedPlate(size, inset, size * 0.055);
  ctx.restore();
}

// Small shared primitives for the component language below. Keeping these
// symbols to a few fills/strokes makes the direct Canvas renderer inexpensive;
// Pixi and blueprint views bake the same art into cached textures/icons.
function drawRecessedPanel(size, width = 0.68, height = 0.68, radius = 0.08) {
  ctx.save();
  // Kept translucent so the coloured cube beneath still shows through — a
  // heavier fill here made every component read nearly black.
  ctx.fillStyle = "rgba(5,10,18,0.38)";
  ctx.strokeStyle = "rgba(225,238,255,0.24)";
  ctx.lineWidth = Math.max(0.7, size * 0.04);
  roundRect(ctx, {
    x: -size * width * 0.5,
    y: -size * height * 0.5,
    width: size * width,
    height: size * height,
    radius: size * radius
  });
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawComponentPort(size, x, y, radius, accent, innerScale = 0.45) {
  ctx.save();
  ctx.fillStyle = "rgba(3,7,13,0.9)";
  ctx.beginPath();
  ctx.arc(size * x, size * y, size * radius, 0, Math.PI * 2);
  ctx.fill();
  if (accent) {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(size * x, size * y, size * radius * innerScale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const COMPONENT_ART_ALIASES = Object.freeze({
  lightFrame: "frame",
  heavyFrame: "frame",
  bulkhead: "armor",
  lightMount: "weaponMount",
  heavyMount: "weaponMount",
  smallReactor: "reactor",
  heavyReactor: "reactor",
  microThruster: "maneuverThruster",
  heavyEngine: "engine",
  lightShield: "shield",
  heavyShield: "shield",
  regenShield: "shield",
  lightBlaster: "blaster",
  heavyBlaster: "blaster",
  lightMissile: "missile",
  lightRailgun: "railgun",
  heavyRailgun: "railgun",
  pointDefenseLaser: "pointDefense"
});

function componentArtType(type) {
  return COMPONENT_ART_ALIASES[type] || type;
}

// Aliased art types whose weapon art is split into a static mount plus a
// rotating top. Every active rotating weapon family must appear here; unknown
// weapon types fall back to a generic barrel top so they still visibly track.
const WEAPON_ART_TYPES = new Set([
  "blaster", "autocannon", "pointDefense", "flakCannon", "missile",
  "railgun", "swarmMissile", "torpedo", "beamEmitter", "repairBeam",
  "aegisProjector", "interceptorPod"
]);

// Shared mounted-turret base: a dark socket, a bevelled raised ring in the
// module body colour, and a recessed hub the barrel emerges from. Gives every
// weapon a believable top-down turret mount rather than a flat disc. Fully
// radially symmetric — it belongs to the STATIC hull, never to the turret top.
export function drawWeaponBase(size) {
  ctx.save();
  ctx.fillStyle = "rgba(6,10,16,0.88)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(0, 0, size * 0.33, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.lineWidth = Math.max(0.7, size * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, Math.PI * 0.92, Math.PI * 1.7);
  ctx.stroke();
  ctx.strokeStyle = "rgba(3,6,12,0.5)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, Math.PI * -0.08, Math.PI * 0.7);
  ctx.stroke();
  ctx.fillStyle = "rgba(9,14,22,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Shared circular housing for system modules (reactor, shield, etc.): bevelled
// ring with a light upper-left rim and a dark lower-right seam.
export function drawRoundSystem(size) {
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = Math.max(0.7, size * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.4, Math.PI * 0.92, Math.PI * 1.68);
  ctx.stroke();
  ctx.strokeStyle = "rgba(3,6,12,0.45)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.4, Math.PI * -0.08, Math.PI * 0.68);
  ctx.stroke();
  ctx.restore();
}

// --- Explicit static/dynamic weapon split -------------------------------------

// The occupied hull block(s) for a part, drawn at the footprint centre in the
// footprint's long-axis frame. This is pure hull: no sockets, no barrels.
export function drawStaticComponentBase({ type, unit, tilesLong = 1, tilesCross = 1, color, trim }) {
  const structural = STRUCTURAL_PARTS.has(type);
  const bodyColor = trim && structural ? mixColor(color, trim, 0.24) : color;
  const multi = tilesLong > 1 || tilesCross > 1;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  if (!multi) {
    drawComponentCubeBase(unit, bodyColor);
  } else {
    const hl = (tilesLong * unit) / 2;
    const hc = (tilesCross * unit) / 2;
    ctx.fillStyle = getModuleGradient(Math.max(hl, hc) * 2, bodyColor);
    roundRect(ctx, {
      x: -hl,
      y: -hc,
      width: hl * 2,
      height: hc * 2,
      radius: Math.min(unit * 0.1, hc * 0.22)
    });
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// The non-directional weapon socket/housing a rotating top sits on. Drawn at
// the footprint centre in the footprint's long-axis frame; because it carries
// no directional detail it can be baked into the static hull texture.
export function drawStaticWeaponMount({ type, unit, tilesLong = 1, tilesCross = 1, color }) {
  const artType = componentArtType(type);
  const multi = tilesLong > 1 || tilesCross > 1;
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.fillStyle = getModuleGradient(unit, color);

  if (multi) {
    const hl = (tilesLong * unit) / 2;
    const hc = (tilesCross * unit) / 2;
    drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
    drawFootprintSeams(unit, hl, hc, tilesLong);
    // Central bearing ring the gun assembly pivots on.
    drawWeaponBase(Math.min(hl, hc) * 1.7);
    ctx.restore();
    return;
  }

  const size = unit;
  if (artType === "flakCannon") {
    // Twin small sockets: one per mini-turret.
    ctx.save();
    ctx.translate(0, -size * 0.22);
    drawWeaponBase(size * 0.65);
    ctx.restore();
    ctx.save();
    ctx.fillStyle = getModuleGradient(unit, color);
    ctx.translate(0, size * 0.22);
    drawWeaponBase(size * 0.65);
    ctx.restore();
  } else if (artType === "missile") {
    drawRecessedPanel(size, 0.72, 0.58, 0.12);
    drawWeaponBase(size * 0.62);
  } else if (artType === "railgun") {
    drawRecessedPanel(size, 0.92, 0.88, 0.08);
    drawWeaponBase(size * 0.66);
  } else if (artType === "swarmMissile" || artType === "interceptorPod") {
    drawRecessedPanel(size, 0.78, 0.78, 0.1);
    drawWeaponBase(size * 0.62);
  } else if (artType === "torpedo") {
    drawRecessedPanel(size, 0.8, 0.6, 0.09);
    drawWeaponBase(size * 0.6);
  } else if (artType === "aegisProjector") {
    drawRecessedPanel(size, 0.76, 0.76, 0.18);
    drawWeaponBase(size * 0.62);
  } else {
    // blaster / autocannon / pointDefense / beamEmitter / repairBeam / unknown
    drawWeaponBase(size);
  }
  ctx.restore();
}

// Small rotating cap over the pivot so every turret top visually connects to
// its mount. Part of the DYNAMIC art (it turns with the barrel).
function drawTurretCap(size, color, r = 0.16) {
  ctx.save();
  ctx.fillStyle = mixColor(color, "#05070c", 0.3);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.lineWidth = Math.max(0.7, size * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, size * r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.2)";
  ctx.beginPath();
  ctx.arc(-size * r * 0.3, -size * r * 0.3, size * r * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ONLY the rotating weapon top: barrels, rails, launcher heads, emitter heads.
// Drawn around the pivot (origin) with local +x as weapon-forward, on a
// transparent background. Barrel tips line up with TurretRules.MUZZLE_TIP_TILES
// so projectiles emerge exactly at the visible muzzle. Never draws hull
// blocks, sockets, or recessed panels — those are static mount artwork.
export function drawRotatingWeaponTop({ type, unit, tilesLong = 1, tilesCross = 1, color }) {
  const artType = componentArtType(type);
  const size = unit;
  const hl = (Math.max(1, tilesLong) * unit) / 2;
  const hc = (Math.max(1, tilesCross) * unit) / 2;
  const multi = tilesLong > 1 || tilesCross > 1;

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";

  if (multi) {
    drawMultiCellWeaponTop(artType, unit, hl, hc, color);
    ctx.restore();
    return;
  }

  if (artType === "blaster") {
    ctx.fillStyle = "#ffd1dc";
    roundRect(ctx, { x: size * 0.02, y: -size * 0.13, width: size * 0.62, height: size * 0.26, radius: size * 0.08 });
    ctx.fill();
    drawTurretCap(size, color);
  } else if (artType === "autocannon") {
    ctx.fillStyle = "#fdba74";
    // Twin barrels: roundRect() starts a new path, so each barrel must be filled
    // on its own — a single shared fill() would only render the last barrel.
    roundRect(ctx, { x: size * 0.02, y: -size * 0.22, width: size * 0.68, height: size * 0.14, radius: size * 0.04 });
    ctx.fill();
    roundRect(ctx, { x: size * 0.02, y: size * 0.08, width: size * 0.68, height: size * 0.14, radius: size * 0.04 });
    ctx.fill();
    drawTurretCap(size, color, 0.18);
  } else if (artType === "pointDefense") {
    ctx.fillStyle = "#fda4af";
    roundRect(ctx, { x: 0, y: -size * 0.08, width: size * 0.62, height: size * 0.16, radius: size * 0.04 });
    ctx.fill();
    ctx.fillStyle = "#fff1f2";
    ctx.fillRect(size * 0.52, -size * 0.05, size * 0.1, size * 0.1);
    ctx.strokeStyle = "rgba(255,225,232,0.72)";
    ctx.lineWidth = Math.max(0.7, size * 0.045);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, -Math.PI * 0.34, Math.PI * 0.34);
    ctx.stroke();
    drawTurretCap(size, color, 0.14);
  } else if (artType === "flakCannon") {
    ctx.fillStyle = "#f43f5e";
    roundRect(ctx, { x: size * 0.01, y: -size * 0.28, width: size * 0.44, height: size * 0.12, radius: size * 0.02 });
    ctx.fill();
    roundRect(ctx, { x: size * 0.01, y: size * 0.16, width: size * 0.44, height: size * 0.12, radius: size * 0.02 });
    ctx.fill();
    ctx.save();
    ctx.translate(0, -size * 0.22);
    drawTurretCap(size * 0.65, color, 0.16);
    ctx.restore();
    ctx.save();
    ctx.translate(0, size * 0.22);
    drawTurretCap(size * 0.65, color, 0.16);
    ctx.restore();
  } else if (artType === "missile") {
    ctx.fillStyle = "#f0dcff";
    ctx.beginPath();
    ctx.moveTo(size * 0.64, 0);
    ctx.lineTo(size * 0.08, -size * 0.2);
    ctx.lineTo(-size * 0.08, 0);
    ctx.lineTo(size * 0.08, size * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.moveTo(-size * 0.02, -size * 0.14);
    ctx.lineTo(-size * 0.16, -size * 0.24);
    ctx.lineTo(size * 0.08, -size * 0.14);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-size * 0.02, size * 0.14);
    ctx.lineTo(-size * 0.16, size * 0.24);
    ctx.lineTo(size * 0.08, size * 0.14);
    ctx.fill();
  } else if (artType === "railgun") {
    ctx.strokeStyle = "#f4f7ff";
    ctx.lineWidth = Math.max(1.2, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(-size * 0.04, -size * 0.16);
    ctx.lineTo(size * 0.68, -size * 0.16);
    ctx.moveTo(-size * 0.04, size * 0.16);
    ctx.lineTo(size * 0.68, size * 0.16);
    ctx.stroke();
    ctx.fillStyle = "#7aa4ff";
    ctx.fillRect(size * 0.42, -size * 0.06, size * 0.16, size * 0.12);
    drawTurretCap(size, color, 0.15);
  } else if (artType === "swarmMissile") {
    ctx.fillStyle = "#e9d5ff";
    roundRect(ctx, { x: -size * 0.06, y: -size * 0.28, width: size * 0.58, height: size * 0.56, radius: size * 0.08 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#581c87";
    ctx.beginPath();
    ctx.arc(size * 0.18, -size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.arc(size * 0.38, -size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.arc(size * 0.18, size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.arc(size * 0.38, size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.fill();
  } else if (artType === "torpedo") {
    ctx.fillStyle = "#c084fc";
    ctx.beginPath();
    ctx.moveTo(-size * 0.12, -size * 0.24);
    ctx.lineTo(size * 0.46, -size * 0.24);
    ctx.lineTo(size * 0.72, 0);
    ctx.lineTo(size * 0.46, size * 0.24);
    ctx.lineTo(-size * 0.12, size * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#6d28d9";
    ctx.lineWidth = Math.max(0.7, size * 0.045);
    ctx.beginPath();
    ctx.moveTo(size * 0.08, -size * 0.24);
    ctx.lineTo(size * 0.08, size * 0.24);
    ctx.stroke();
  } else if (artType === "beamEmitter" || artType === "repairBeam") {
    const repair = artType === "repairBeam";
    const accent = repair ? "#4ade80" : "#38bdf8";
    ctx.fillStyle = repair ? "#15803d" : "#0284c7";
    ctx.fillRect(-size * 0.08, -size * 0.16, size * 0.3, size * 0.32);
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(size * 0.22, -size * 0.18);
    ctx.lineTo(size * 0.66, 0);
    ctx.lineTo(size * 0.22, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (repair) {
      ctx.fillStyle = "#dcfce7";
      ctx.fillRect(-size * 0.05, -size * 0.03, size * 0.2, size * 0.06);
      ctx.fillRect(size * 0.01, -size * 0.1, size * 0.06, size * 0.2);
    }
    drawTurretCap(size, color, 0.13);
  } else if (artType === "aegisProjector") {
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = Math.max(1.4, size * 0.1);
    ctx.beginPath();
    ctx.arc(size * 0.06, 0, size * 0.34, -Math.PI * 0.4, Math.PI * 0.4);
    ctx.stroke();
    ctx.fillStyle = "#a7f3d0";
    ctx.beginPath();
    ctx.arc(size * 0.16, 0, size * 0.11, 0, Math.PI * 2);
    ctx.fill();
    drawTurretCap(size, color, 0.13);
  } else if (artType === "interceptorPod") {
    ctx.fillStyle = "#a855f7";
    roundRect(ctx, { x: -size * 0.3, y: -size * 0.3, width: size * 0.62, height: size * 0.12, radius: size * 0.03 });
    ctx.fill();
    roundRect(ctx, { x: -size * 0.3, y: -size * 0.06, width: size * 0.62, height: size * 0.12, radius: size * 0.03 });
    ctx.fill();
    roundRect(ctx, { x: -size * 0.3, y: size * 0.18, width: size * 0.62, height: size * 0.12, radius: size * 0.03 });
    ctx.fill();
    ctx.fillStyle = "#f3e8ff";
    ctx.beginPath();
    ctx.arc(size * 0.3, -size * 0.24, size * 0.045, 0, Math.PI * 2);
    ctx.arc(size * 0.3, 0, size * 0.045, 0, Math.PI * 2);
    ctx.arc(size * 0.3, size * 0.24, size * 0.045, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Unknown rotating weapon: generic barrel to the shared default muzzle tip.
    ctx.fillStyle = "#e2e8f0";
    roundRect(ctx, { x: size * 0.02, y: -size * 0.11, width: size * 0.58, height: size * 0.22, radius: size * 0.06 });
    ctx.fill();
    drawTurretCap(size, color);
  }
  ctx.restore();
}

// Elongated rotating gun assemblies for multi-cell footprints. The whole
// assembly (breech + barrel/rails + muzzle) rotates as one piece around the
// footprint centre; the footprint slab and panel stay on the hull.
function drawMultiCellWeaponTop(artType, unit, hl, hc, color) {
  const fine = Math.max(0.7, unit * 0.045);
  const line = Math.max(1, unit * 0.075);

  if (artType === "railgun") {
    // Armoured breech, capacitor coil bands, twin accelerator rails and the
    // bright muzzle armature — the gun assembly from the pro footprint art.
    ctx.fillStyle = mixColor(color, "#101827", 0.42);
    roundRect(ctx, { x: -hl + unit * 0.08, y: -hc * 0.8, width: unit * 0.7, height: hc * 1.6, radius: unit * 0.09 });
    ctx.fill();
    ctx.stroke();
    const bands = Math.max(2, Math.round((hl * 2) / unit));
    ctx.fillStyle = "rgba(122,164,255,0.4)";
    for (let i = 0; i < bands; i += 1) {
      const bx = -hl + unit * 0.95 + (hl * 2 - unit * 1.45) * (bands > 1 ? i / (bands - 1) : 0.5);
      ctx.fillRect(bx, -hc * 0.66, unit * 0.09, hc * 1.32);
    }
    ctx.strokeStyle = "#eef4ff";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.6, -hc * 0.44);
    ctx.lineTo(hl - unit * 0.06, -hc * 0.44);
    ctx.moveTo(-hl + unit * 0.6, hc * 0.44);
    ctx.lineTo(hl - unit * 0.06, hc * 0.44);
    ctx.stroke();
    ctx.fillStyle = "#5f8fff";
    ctx.fillRect(hl - unit * 0.32, -hc * 0.56, unit * 0.24, hc * 1.12);
    ctx.save();
    ctx.shadowColor = "#9fdcff";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#dbeafe";
    ctx.fillRect(hl - unit * 0.16, -hc * 0.18, unit * 0.12, hc * 0.36);
    ctx.restore();
  } else if (artType === "beamEmitter" || artType === "repairBeam") {
    const repair = artType === "repairBeam";
    const accent = repair ? "#4ade80" : "#38bdf8";
    const deep = repair ? "#14532d" : "#075985";
    const pale = repair ? "#bbf7d0" : "#bae6fd";
    ctx.fillStyle = deep;
    roundRect(ctx, { x: -hl * 0.84, y: -hc * 0.3, width: hl * 1.5, height: hc * 0.6, radius: unit * 0.08 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = pale;
    ctx.lineWidth = Math.max(fine, unit * 0.06);
    for (const [fx, span] of [[-hl * 0.42, 0.52], [-hl * 0.02, 0.66], [hl * 0.34, 0.82]]) {
      ctx.beginPath();
      ctx.moveTo(fx, -hc * span);
      ctx.lineTo(fx, hc * span);
      ctx.stroke();
    }
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(hl * 0.5, -hc * 0.6);
    ctx.lineTo(hl - unit * 0.05, 0);
    ctx.lineTo(hl * 0.5, hc * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = mixColor(accent, "#ffffff", 0.62);
    ctx.lineWidth = Math.max(fine, unit * 0.055);
    ctx.beginPath();
    ctx.moveTo(-hl * 0.72, 0);
    ctx.lineTo(hl * 0.62, 0);
    ctx.stroke();
    if (repair) {
      ctx.fillStyle = "#dcfce7";
      ctx.fillRect(-hl * 0.66, -hc * 0.09, unit * 0.36, hc * 0.18);
      ctx.fillRect(-hl * 0.66 + unit * 0.135, -hc * 0.26, unit * 0.09, hc * 0.52);
    }
  } else if (artType === "torpedo") {
    // The loaded torpedo (finned tail, banded body, glowing warhead) rotates;
    // the launch trough stays on the hull as part of the mount.
    ctx.fillStyle = "#b9a2ff";
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0);
    ctx.lineTo(hl * 0.56, -hc * 0.34);
    ctx.lineTo(-hl * 0.62, -hc * 0.34);
    ctx.lineTo(-hl * 0.78, 0);
    ctx.lineTo(-hl * 0.62, hc * 0.34);
    ctx.lineTo(hl * 0.56, hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.moveTo(-hl * 0.56, -hc * 0.34);
    ctx.lineTo(-hl * 0.78, -hc * 0.66);
    ctx.lineTo(-hl * 0.36, -hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-hl * 0.56, hc * 0.34);
    ctx.lineTo(-hl * 0.78, hc * 0.66);
    ctx.lineTo(-hl * 0.36, hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#6d28d9";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-hl * 0.32, -hc * 0.34);
    ctx.lineTo(-hl * 0.32, hc * 0.34);
    ctx.moveTo(hl * 0.06, -hc * 0.34);
    ctx.lineTo(hl * 0.06, hc * 0.34);
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#e879f9";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#f5d0fe";
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0);
    ctx.lineTo(hl * 0.6, -hc * 0.24);
    ctx.lineTo(hl * 0.6, hc * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (artType === "swarmMissile") {
    // Rotating launcher block with tube mouths toward +x.
    ctx.fillStyle = "#e9d5ff";
    roundRect(ctx, { x: -hl * 0.7, y: -hc * 0.62, width: hl * 1.6, height: hc * 1.24, radius: unit * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#3b0764";
    const cols = Math.max(2, Math.round((hl * 2) / unit));
    for (let r = 0; r < 2; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cx = -hl * 0.5 + hl * 1.3 * ((c + 0.5) / cols);
        const cy = (r === 0 ? -1 : 1) * hc * 0.32;
        ctx.beginPath();
        ctx.arc(cx, cy, unit * 0.11, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = "#d8b4fe";
    for (let c = 0; c < cols; c += 1) {
      const cx = -hl * 0.5 + hl * 1.3 * ((c + 0.5) / cols);
      ctx.beginPath();
      ctx.arc(cx, -hc * 0.32, unit * 0.045, 0, Math.PI * 2);
      ctx.arc(cx, hc * 0.32, unit * 0.045, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Generic elongated barrel out to the forward footprint edge.
    ctx.fillStyle = "#e2e8f0";
    roundRect(ctx, { x: -hl * 0.3, y: -hc * 0.24, width: hl * 1.24, height: hc * 0.48, radius: unit * 0.08 });
    ctx.fill();
    ctx.stroke();
    drawTurretCap(unit * Math.min(2, (hc * 2) / unit), color, 0.2);
  }
}

// --- Professional single-cell detail ------------------------------------------

function drawProfessionalModuleDetail(type, size, color) {
  type = componentArtType(type);
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  // Weapons use the explicit static/dynamic split: a non-directional mount
  // plus the rotating top drawn at its blueprint-neutral (+x) facing. The
  // in-game renderers call the two halves separately.
  if (WEAPON_ART_TYPES.has(type)) {
    drawStaticWeaponMount({ type, unit: size, color });
    drawRotatingWeaponTop({ type, unit: size, color });
    return true;
  }

  if (type === "core") {
    drawRecessedPanel(size, 0.78, 0.78, 0.16);
    ctx.strokeStyle = "rgba(116,225,255,0.7)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.29, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#dff9ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(3,25,38,0.78)";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.34, 0); ctx.lineTo(-size * 0.21, 0);
    ctx.moveTo(size * 0.21, 0); ctx.lineTo(size * 0.34, 0);
    ctx.moveTo(0, -size * 0.34); ctx.lineTo(0, -size * 0.21);
    ctx.moveTo(0, size * 0.21); ctx.lineTo(0, size * 0.34);
    ctx.stroke();
    return true;
  }

  if (type === "frame") {
    ctx.strokeStyle = "rgba(8,14,24,0.72)";
    ctx.lineWidth = Math.max(1.2, size * 0.13);
    ctx.beginPath();
    ctx.moveTo(-size * 0.34, -size * 0.34); ctx.lineTo(size * 0.34, size * 0.34);
    ctx.moveTo(size * 0.34, -size * 0.34); ctx.lineTo(-size * 0.34, size * 0.34);
    ctx.stroke();
    ctx.strokeStyle = "rgba(225,236,250,0.28)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.31, -size * 0.31); ctx.lineTo(size * 0.31, size * 0.31);
    ctx.stroke();
    drawComponentPort(size, 0, 0, 0.095, "#d8e2f0", 0.35);
    return true;
  }

  if (type === "halfFrameDiagonal" || type === "halfArmorDiagonal" || type === "halfCompositeArmorDiagonal") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, -size * 0.5);
    ctx.lineTo(size * 0.5, -size * 0.5);
    ctx.lineTo(-size * 0.5, size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = type === "halfFrameDiagonal" ? "rgba(225,236,250,0.46)" : "rgba(255,244,220,0.42)";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.32, -size * 0.32);
    ctx.lineTo(type === "halfFrameDiagonal" ? size * 0.17 : size * 0.1, -size * 0.32);
    ctx.lineTo(-size * 0.32, type === "halfFrameDiagonal" ? size * 0.17 : size * 0.1);
    ctx.stroke();
    return true;
  }

  if (type === "wingFrame" || type === "wingArmor" || type === "wingCompositeArmor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, -size * 0.5);
    ctx.lineTo(size * 0.5, 0);
    ctx.lineTo(-size * 0.5, size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = type === "wingFrame" ? "rgba(225,236,250,0.46)" : "rgba(255,244,220,0.42)";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.34, -size * 0.3);
    ctx.lineTo(size * 0.16, 0);
    ctx.lineTo(-size * 0.34, size * 0.3);
    ctx.stroke();
    return true;
  }

  if (type === "armor" || type === "compositeArmor") {
    // Full-cube plating: three overlapping armour bands with a lit top bevel
    // and corner rivets. Composite adds diagonal laminate weave in amber.
    const composite = type === "compositeArmor";
    ctx.save();
    const bandFills = [
      mixColor(color, "#ffffff", 0.2),
      mixColor(color, "#ffffff", 0.04),
      mixColor(color, "#05070c", 0.26)
    ];
    ctx.strokeStyle = "rgba(3,6,12,0.6)";
    ctx.lineWidth = fine;
    for (let i = 0; i < 3; i += 1) {
      ctx.fillStyle = bandFills[i];
      roundRect(ctx, { x: -size * 0.47, y: -size * 0.47 + i * size * 0.32, width: size * 0.94, height: size * 0.3, radius: size * 0.05 });
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = composite ? "rgba(255,236,184,0.8)" : "rgba(255,238,218,0.65)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.42);
    ctx.lineTo(size * 0.42, -size * 0.42);
    ctx.stroke();
    if (composite) {
      ctx.strokeStyle = "rgba(255,214,140,0.45)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.36, size * 0.4); ctx.lineTo(size * 0.02, -size * 0.02);
      ctx.moveTo(-size * 0.02, size * 0.42); ctx.lineTo(size * 0.38, 0);
      ctx.stroke();
    }
    const rivet = mixColor(color, "#ffffff", 0.55);
    drawComponentPort(size, -0.38, -0.32, 0.05, rivet, 0.5);
    drawComponentPort(size, 0.38, -0.32, 0.05, rivet, 0.5);
    drawComponentPort(size, -0.38, 0.36, 0.05, rivet, 0.5);
    drawComponentPort(size, 0.38, 0.36, 0.05, rivet, 0.5);
    ctx.restore();
    return true;
  }

  if (type === "engine") {
    drawRecessedPanel(size, 0.92, 0.88, 0.1);
    // Twin recessed exhaust bells at the rear and a clean central power spine.
    drawComponentPort(size, -0.34, -0.24, 0.15, "#b8f8ff", 0.43);
    drawComponentPort(size, -0.34, 0.24, 0.15, "#61d9ff", 0.43);
    ctx.fillStyle = "#72ddf7";
    roundRect(ctx, { x: -size * 0.12, y: -size * 0.26, width: size * 0.54, height: size * 0.52, radius: size * 0.08 });
    ctx.fill();
    ctx.strokeStyle = "rgba(225,248,255,0.55)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.02, -size * 0.13); ctx.lineTo(size * 0.34, -size * 0.13);
    ctx.moveTo(-size * 0.02, size * 0.13); ctx.lineTo(size * 0.34, size * 0.13);
    ctx.stroke();
    return true;
  }

  if (type === "weaponMount") {
    const pale = mixColor(color, "#ffffff", 0.62);
    drawRecessedPanel(size, 0.76, 0.76, 0.14);
    drawWeaponBase(size);
    drawComponentPort(size, -0.3, -0.3, 0.045, pale, 0.4);
    drawComponentPort(size, 0.3, -0.3, 0.045, pale, 0.4);
    drawComponentPort(size, -0.3, 0.3, 0.045, pale, 0.4);
    drawComponentPort(size, 0.3, 0.3, 0.045, pale, 0.4);
    return true;
  }

  if (type === "reactor") {
    drawRecessedPanel(size, 0.78, 0.78, 0.17);
    ctx.strokeStyle = "#d6a820"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.29, 0, Math.PI * 2); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.18, "#fff4a8", 0.62);
    return true;
  }
  if (type === "battery") {
    drawRecessedPanel(size, 0.72, 0.76, 0.08);
    ctx.fillStyle = "#baf4ff";
    for (let i = 0; i < 3; i += 1) {
      roundRect(ctx, { x: -size * 0.25, y: size * (-0.25 + i * 0.21), width: size * 0.5, height: size * 0.1, radius: size * 0.025 }); ctx.fill();
    }
    ctx.fillStyle = "#164e63";
    ctx.fillRect(-size * 0.08, -size * 0.43, size * 0.16, size * 0.08);
    return true;
  }
  if (type === "capacitor") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.fillStyle = "#60a5fa";
    roundRect(ctx, { x: -size * 0.27, y: -size * 0.3, width: size * 0.18, height: size * 0.6, radius: size * 0.04 }); ctx.fill();
    roundRect(ctx, { x: size * 0.09, y: -size * 0.3, width: size * 0.18, height: size * 0.6, radius: size * 0.04 }); ctx.fill();
    ctx.strokeStyle = "#dbeafe"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.moveTo(-size * 0.09, 0); ctx.lineTo(size * 0.09, 0); ctx.stroke();
    return true;
  }
  if (type === "auxGenerator") {
    drawRecessedPanel(size, 0.72, 0.76, 0.09);
    ctx.fillStyle = "#fef08a";
    roundRect(ctx, { x: -size * 0.24, y: -size * 0.28, width: size * 0.16, height: size * 0.56, radius: size * 0.04 }); ctx.fill();
    roundRect(ctx, { x: size * 0.08, y: -size * 0.28, width: size * 0.16, height: size * 0.56, radius: size * 0.04 }); ctx.fill();
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.moveTo(-size * 0.08, -size * 0.14); ctx.lineTo(size * 0.08, 0); ctx.lineTo(-size * 0.08, size * 0.14); ctx.stroke();
    return true;
  }
  if (type === "shield") {
    drawRecessedPanel(size, 0.78, 0.78, 0.17);
    ctx.strokeStyle = "#a7f3d0"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.3, Math.PI * 0.12, Math.PI * 1.88); ctx.stroke();
    ctx.strokeStyle = "rgba(167,243,208,0.42)"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.2, Math.PI * 0.12, Math.PI * 1.88); ctx.stroke();
    return true;
  }
  if (type === "repair") {
    drawRecessedPanel(size, 0.74, 0.74, 0.16);
    ctx.fillStyle = "#bbf7d0";
    roundRect(ctx, { x: -size * 0.09, y: -size * 0.3, width: size * 0.18, height: size * 0.6, radius: size * 0.035 }); ctx.fill();
    roundRect(ctx, { x: -size * 0.3, y: -size * 0.09, width: size * 0.6, height: size * 0.18, radius: size * 0.035 }); ctx.fill();
    return true;
  }
  if (type === "gyroscope") {
    drawRecessedPanel(size, 0.78, 0.78, 0.17);
    ctx.strokeStyle = "#ddd6fe"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#8b5cf6";
    ctx.beginPath(); ctx.moveTo(0, -size * 0.34); ctx.lineTo(0, size * 0.34); ctx.moveTo(-size * 0.34, 0); ctx.lineTo(size * 0.34, 0); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.09, "#ede9fe", 0.5);
    return true;
  }
  if (type === "maneuverThruster") {
    drawRecessedPanel(size, 0.76, 0.72, 0.09);
    ctx.fillStyle = "#8bdff7";
    ctx.beginPath();
    ctx.moveTo(-size * 0.28, -size * 0.27); ctx.lineTo(size * 0.31, -size * 0.12);
    ctx.lineTo(size * 0.31, size * 0.12); ctx.lineTo(-size * 0.28, size * 0.27);
    ctx.closePath(); ctx.fill();
    drawComponentPort(size, -0.3, 0, 0.14, "#bdefff", 0.4);
    return true;
  }
  if (type === "sensorArray") {
    drawRecessedPanel(size, 0.76, 0.76, 0.16);
    ctx.strokeStyle = "#a7f3d0"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(-size * 0.12, 0, size * 0.31, -Math.PI * 0.32, Math.PI * 0.32); ctx.stroke();
    ctx.strokeStyle = "#d1fae5"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.moveTo(-size * 0.12, 0); ctx.lineTo(size * 0.34, 0); ctx.stroke();
    drawComponentPort(size, -0.12, 0, 0.085, "#ecfdf5", 0.5);
    return true;
  }
  if (type === "targetingComputer") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.strokeStyle = "#e879f9"; ctx.lineWidth = fine;
    ctx.strokeRect(-size * 0.27, -size * 0.27, size * 0.54, size * 0.54);
    ctx.beginPath(); ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
    ctx.moveTo(-size * 0.35, 0); ctx.lineTo(-size * 0.12, 0);
    ctx.moveTo(size * 0.12, 0); ctx.lineTo(size * 0.35, 0);
    ctx.moveTo(0, -size * 0.35); ctx.lineTo(0, -size * 0.12);
    ctx.moveTo(0, size * 0.12); ctx.lineTo(0, size * 0.35); ctx.stroke();
    return true;
  }
  if (type === "fireControl") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.strokeStyle = "#fb923c"; ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.25, size * 0.2); ctx.lineTo(0, -size * 0.25); ctx.lineTo(size * 0.25, size * 0.2); ctx.lineTo(-size * 0.25, size * 0.2); ctx.stroke();
    drawComponentPort(size, -0.25, 0.2, 0.07, "#ffedd5", 0.45);
    drawComponentPort(size, 0, -0.25, 0.07, "#ffedd5", 0.45);
    drawComponentPort(size, 0.25, 0.2, 0.07, "#ffedd5", 0.45);
    return true;
  }
  if (type === "heatSink") {
    drawRecessedPanel(size, 0.78, 0.78, 0.06);
    ctx.fillStyle = "#93c5fd";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(-size * 0.3, size * (-0.29 + i * 0.19), size * 0.6, size * 0.08);
    }
    return true;
  }
  if (type === "radiator") {
    // Active cooling fan: visually distinct from the heat sink's passive fin
    // stack. The blueprint overlay separately highlights the actual exposed edge.
    drawRecessedPanel(size, 0.8, 0.8, 0.1);
    ctx.strokeStyle = "#9be8ff";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.29, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#3aaed8";
    ctx.beginPath();
    ctx.moveTo(-size * 0.04, -size * 0.07); ctx.lineTo(size * 0.12, -size * 0.29); ctx.lineTo(size * 0.02, -size * 0.34); ctx.closePath();
    ctx.moveTo(size * 0.07, -size * 0.04); ctx.lineTo(size * 0.29, size * 0.12); ctx.lineTo(size * 0.34, size * 0.02); ctx.closePath();
    ctx.moveTo(size * 0.04, size * 0.07); ctx.lineTo(-size * 0.12, size * 0.29); ctx.lineTo(-size * 0.02, size * 0.34); ctx.closePath();
    ctx.moveTo(-size * 0.07, size * 0.04); ctx.lineTo(-size * 0.29, -size * 0.12); ctx.lineTo(-size * 0.34, -size * 0.02); ctx.closePath();
    ctx.fill();
    drawComponentPort(size, 0, 0, 0.105, "#d9f8ff", 0.42);
    ctx.strokeStyle = "rgba(125,211,252,0.62)";
    ctx.lineWidth = Math.max(0.7, size * 0.04);
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.28); ctx.lineTo(-size * 0.36, size * 0.28);
    ctx.moveTo(size * 0.36, -size * 0.28); ctx.lineTo(size * 0.36, size * 0.28);
    ctx.stroke();
    return true;
  }
  if (type === "captureModule") {
    drawRecessedPanel(size, 0.76, 0.76, 0.16);
    ctx.fillStyle = "#f9a8d4";
    ctx.beginPath(); ctx.moveTo(0, -size * 0.32); ctx.lineTo(size * 0.25, 0); ctx.lineTo(0, size * 0.32); ctx.lineTo(-size * 0.25, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#831843"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2); ctx.stroke();
    return true;
  }
  if (type === "signalAmplifier") {
    drawRecessedPanel(size, 0.76, 0.76, 0.14);
    ctx.fillStyle = "#5eead4"; ctx.fillRect(-size * 0.05, -size * 0.28, size * 0.1, size * 0.56);
    ctx.strokeStyle = "#ccfbf1"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.22, -Math.PI * 0.62, -Math.PI * 0.38); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, size * 0.34, -Math.PI * 0.62, -Math.PI * 0.38); ctx.stroke();
    return true;
  }
  if (type === "stabilizerNode") {
    drawRecessedPanel(size, 0.76, 0.76, 0.16);
    ctx.strokeStyle = "#c4b5fd"; ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.33); ctx.lineTo(size * 0.13, -size * 0.13); ctx.lineTo(size * 0.33, 0);
    ctx.lineTo(size * 0.13, size * 0.13); ctx.lineTo(0, size * 0.33); ctx.lineTo(-size * 0.13, size * 0.13);
    ctx.lineTo(-size * 0.33, 0); ctx.lineTo(-size * 0.13, -size * 0.13); ctx.closePath(); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.11, "#ddd6fe", 0.5);
    return true;
  }

  return false;
}

// --- Single-cell module composition --------------------------------------------

export function drawModule({ x, y, size, color, type, trim, drawBase = true, drawDetail = true }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Dark local edge instead of a bright team-coloured outline; a soft glow is
  // reserved for genuine energy parts so the ship reads clean, not noisy.
  ctx.lineWidth = Math.max(0.9, size * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  // Structural parts carry a restrained team tint so friend/foe stays readable
  // on the hull without every module glowing in the team colour.
  const bodyColor = trim && STRUCTURAL_PARTS.has(type) ? mixColor(color, trim, 0.24) : color;
  ctx.fillStyle = getModuleGradient(size, bodyColor);

  const keepsPartialShape = type === "halfFrameDiagonal"
    || type === "halfArmorDiagonal"
    || type === "halfCompositeArmorDiagonal"
    || type === "wingFrame"
    || type === "wingArmor"
    || type === "wingCompositeArmor";
  if (!keepsPartialShape && drawBase) {
    drawComponentCubeBase(size, bodyColor);
    // The base helper owns its canvas state; restore the component's intended
    // fill for the existing detail drawing below.
    ctx.fillStyle = getModuleGradient(size, bodyColor);
  }

  if (!drawDetail) {
    ctx.restore();
    return;
  }

  // All currently selectable parts use the unified professional detail set.
  // Legacy branches remain below as compatibility art for any old/custom part
  // ids loaded from storage.
  if (drawProfessionalModuleDetail(type, size, bodyColor)) {
    ctx.restore();
    return;
  }

  if (type === "core") {
    drawPlateBody(size, 0.48, size * 0.18);
    // Housed reactor well: dark socket, bright controlled core, containment ring.
    ctx.save();
    ctx.fillStyle = "rgba(6,12,20,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "#8fe6ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#f4fdff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.19, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(110,231,255,0.75)";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (type === "frame") {
    drawPlateBody(size, 0.46, size * 0.1);
    // Simple internal support bracing, kept dark/industrial rather than a bright cross.
    ctx.save();
    ctx.strokeStyle = "rgba(10,16,26,0.5)";
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.beginPath();
    ctx.moveTo(-size * 0.26, -size * 0.26);
    ctx.lineTo(size * 0.26, size * 0.26);
    ctx.moveTo(size * 0.26, -size * 0.26);
    ctx.lineTo(-size * 0.26, size * 0.26);
    ctx.stroke();
    ctx.strokeStyle = "rgba(210,222,240,0.24)";
    ctx.lineWidth = Math.max(0.7, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(-size * 0.26, -size * 0.26);
    ctx.lineTo(size * 0.26, size * 0.26);
    ctx.stroke();
    ctx.fillStyle = "rgba(214,226,244,0.32)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (type === "halfFrameDiagonal" || type === "halfArmorDiagonal" || type === "halfCompositeArmorDiagonal") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.46);
    ctx.lineTo(size * 0.46, -size * 0.46);
    ctx.lineTo(-size * 0.46, size * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (type === "halfFrameDiagonal") {
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.2);
      ctx.moveTo(-size * 0.2, size * 0.1);
      ctx.lineTo(-size * 0.2, -size * 0.2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(255,244,220,0.38)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.2);
      ctx.stroke();
    }
  } else if (type === "wingFrame" || type === "wingArmor" || type === "wingCompositeArmor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.46);
    ctx.lineTo(size * 0.46, 0);
    ctx.lineTo(-size * 0.46, size * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (type === "wingFrame") {
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, 0);
      ctx.lineTo(-size * 0.2, size * 0.2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(255,244,220,0.38)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, 0);
      ctx.stroke();
    }
  } else if (type === "armor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.24);
    ctx.lineTo(-size * 0.18, -size * 0.48);
    ctx.lineTo(size * 0.42, -size * 0.34);
    ctx.lineTo(size * 0.48, size * 0.2);
    ctx.lineTo(size * 0.18, size * 0.48);
    ctx.lineTo(-size * 0.48, size * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,244,220,0.38)";
    ctx.beginPath();
    ctx.moveTo(-size * 0.18, -size * 0.34);
    ctx.lineTo(size * 0.24, size * 0.28);
    ctx.stroke();
  } else if (type === "engine") {
    // Propulsion housing (wider at the mount, tapering toward the nozzle at -x).
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.4);
    ctx.lineTo(size * 0.46, -size * 0.26);
    ctx.lineTo(size * 0.46, size * 0.26);
    ctx.lineTo(-size * 0.36, size * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Panel seam across the housing.
    ctx.save();
    ctx.strokeStyle = "rgba(210,222,240,0.2)";
    ctx.lineWidth = Math.max(0.7, size * 0.045);
    ctx.beginPath();
    ctx.moveTo(size * 0.16, -size * 0.24);
    ctx.lineTo(size * 0.16, size * 0.24);
    ctx.stroke();
    ctx.restore();
    // Exhaust nozzle: dark bell around a hot cyan throat, pointing -x.
    ctx.save();
    ctx.fillStyle = "#0a2732";
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.24);
    ctx.lineTo(-size * 0.58, -size * 0.2);
    ctx.lineTo(-size * 0.58, size * 0.2);
    ctx.lineTo(-size * 0.36, size * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.moveTo(-size * 0.4, -size * 0.12);
    ctx.lineTo(-size * 0.56, 0);
    ctx.lineTo(-size * 0.4, size * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (type === "reactor") {
    drawRoundSystem(size);
    ctx.fillStyle = "#fff7b3";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b4b12";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "battery") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d5fbff";
    for (let i = 0; i < 3; i += 1) {
      ctx.fillRect(-size * 0.25, -size * 0.28 + i * size * 0.21, size * 0.5, size * 0.09);
    }
  } else if (type === "shield") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#b9ffd0";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, Math.PI * 0.15, Math.PI * 1.85);
    ctx.stroke();
  } else if (type === "repair") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#d7ffe2";
    ctx.lineWidth = Math.max(1.4, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, 0);
    ctx.lineTo(size * 0.24, 0);
    ctx.moveTo(0, -size * 0.24);
    ctx.lineTo(0, size * 0.24);
    ctx.stroke();
  } else if (type === "gyroscope") {
    drawRoundSystem(size);
    ctx.strokeStyle = "rgba(255,255,255,0.48)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#a78bfa";
    ctx.fillRect(-size * 0.06, -size * 0.38, size * 0.12, size * 0.76);
    ctx.fillRect(-size * 0.38, -size * 0.06, size * 0.76, size * 0.12);
  } else if (type === "auxGenerator") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fef08a";
    ctx.fillRect(-size * 0.14, -size * 0.28, size * 0.28, size * 0.56);
    ctx.strokeStyle = "#ca8a04";
    ctx.strokeRect(-size * 0.14, -size * 0.28, size * 0.28, size * 0.56);
  } else if (type === "capacitor") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.10 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(-size * 0.28, -size * 0.3, size * 0.2, size * 0.6);
    ctx.fillRect(size * 0.08, -size * 0.3, size * 0.2, size * 0.6);
  } else if (type === "maneuverThruster") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.35, -size * 0.35);
    ctx.lineTo(size * 0.35, -size * 0.15);
    ctx.lineTo(size * 0.35, size * 0.15);
    ctx.lineTo(-size * 0.35, size * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(-size * 0.48, -size * 0.12, size * 0.15, size * 0.24);
  } else if (type === "sensorArray") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.arc(-size * 0.12, 0, size * 0.32, -Math.PI * 0.3, Math.PI * 0.3);
    ctx.stroke();
    ctx.fillStyle = "#bfdbfe";
    ctx.fillRect(-size * 0.16, -size * 0.04, size * 0.48, size * 0.08);
  } else if (type === "targetingComputer") {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(0, 255, 100, 0.08)";
    ctx.fillRect(-size * 0.28, -size * 0.28, size * 0.56, size * 0.56);
    ctx.strokeStyle = "#22c55e";
    ctx.strokeRect(-size * 0.28, -size * 0.28, size * 0.56, size * 0.56);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.14, 0, Math.PI * 2);
    ctx.moveTo(-size * 0.22, 0);
    ctx.lineTo(size * 0.22, 0);
    ctx.moveTo(0, -size * 0.22);
    ctx.lineTo(0, size * 0.22);
    ctx.stroke();
  } else if (type === "fireControl") {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, -size * 0.24);
    ctx.lineTo(size * 0.24, size * 0.24);
    ctx.moveTo(size * 0.24, -size * 0.24);
    ctx.lineTo(-size * 0.24, size * 0.24);
    ctx.stroke();
  } else if (type === "heatSink") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.10 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(239, 68, 68, 0.45)";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(-size * 0.28 + i * size * 0.16, -size * 0.26, size * 0.08, size * 0.52);
    }
  } else if (type === "captureModule") {
    drawRoundSystem(size);
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.32);
    ctx.lineTo(size * 0.24, 0);
    ctx.lineTo(0, size * 0.32);
    ctx.lineTo(-size * 0.24, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (type === "signalAmplifier") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#a855f7";
    ctx.fillRect(-size * 0.06, -size * 0.28, size * 0.12, size * 0.56);
    ctx.strokeStyle = "#d8b4fe";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.22, -Math.PI * 0.6, -Math.PI * 0.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, -Math.PI * 0.6, -Math.PI * 0.4);
    ctx.stroke();
  } else if (type === "stabilizerNode") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#0284c7";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.12, 0, Math.PI * 2);
    ctx.fill();
  } else {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.1 });
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

// --- Footprint-aware (multi-cell) component art --------------------------------

function drawFootprintSeams(unit, hl, hc, tilesLong) {
  ctx.save();
  ctx.strokeStyle = "rgba(225,238,255,0.15)";
  ctx.lineWidth = Math.max(0.65, unit * 0.035);
  for (let i = 1; i < tilesLong; i += 1) {
    const x = -hl + (hl * 2 * i) / tilesLong;
    ctx.beginPath();
    ctx.moveTo(x, -hc * 0.88);
    ctx.lineTo(x, hc * 0.88);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFootprintPanel(unit, hl, hc, widthScale = 0.9, heightScale = 0.68, radiusScale = 0.1) {
  ctx.save();
  // Translucent like drawRecessedPanel: the coloured cube base must remain
  // visible or multi-tile components go muddy dark.
  ctx.fillStyle = "rgba(4,9,16,0.4)";
  ctx.strokeStyle = "rgba(225,238,255,0.24)";
  ctx.lineWidth = Math.max(0.75, unit * 0.045);
  roundRect(ctx, {
    x: -hl * widthScale,
    y: -hc * heightScale,
    width: hl * widthScale * 2,
    height: hc * heightScale * 2,
    radius: unit * radiusScale
  });
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawFootprintPort(unit, x, y, radius, accent) {
  ctx.save();
  ctx.fillStyle = "rgba(2,6,12,0.94)";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc) {
  type = componentArtType(type);
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  // Weapons: explicit static mount + rotating top at blueprint-neutral facing.
  if (WEAPON_ART_TYPES.has(type)) {
    drawStaticWeaponMount({ type, unit, tilesLong, tilesCross, color });
    drawRotatingWeaponTop({ type, unit, tilesLong, tilesCross, color });
    return true;
  }

  if (type === "engine") {
    // Full-cube propulsion block: bright cowling in the module colour, a rear
    // exhaust manifold with twin glowing bells spanning the whole cross axis,
    // and a forward intake turbine. Exhaust faces -x (blueprint: downward).
    drawFootprintPanel(unit, hl, hc, 0.96, 0.9, 0.09);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.1);
    roundRect(ctx, { x: -hl + unit * 0.52, y: -hc * 0.74, width: hl * 2 - unit * 0.82, height: hc * 1.48, radius: unit * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(2,7,13,0.92)";
    roundRect(ctx, { x: -hl + unit * 0.04, y: -hc * 0.84, width: unit * 0.5, height: hc * 1.68, radius: unit * 0.1 });
    ctx.fill();
    const rearX = -hl + unit * 0.28;
    drawFootprintPort(unit, rearX, -hc * 0.44, unit * 0.19, "#d9fbff");
    drawFootprintPort(unit, rearX, hc * 0.44, unit * 0.19, "#4dd8ff");
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    roundRect(ctx, { x: -hl + unit * 0.16, y: -hc * 0.11, width: unit * 0.26, height: hc * 0.22, radius: unit * 0.05 });
    ctx.fill();
    ctx.restore();
    const frontX = hl - unit * 0.36;
    ctx.fillStyle = "rgba(3,12,20,0.9)";
    ctx.beginPath();
    ctx.arc(frontX, 0, unit * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#bcefff";
    ctx.lineWidth = Math.max(fine, unit * 0.065);
    ctx.beginPath();
    ctx.arc(frontX, 0, unit * 0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#52d8ff";
    ctx.beginPath();
    ctx.arc(frontX, 0, unit * 0.075, 0, Math.PI * 2);
    ctx.fill();
    // Illuminated conduits along both flanks tie manifold to turbine.
    ctx.strokeStyle = "rgba(132,230,255,0.85)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.62, -hc * 0.52);
    ctx.lineTo(frontX - unit * 0.28, -hc * 0.52);
    ctx.moveTo(-hl + unit * 0.62, hc * 0.52);
    ctx.lineTo(frontX - unit * 0.28, hc * 0.52);
    ctx.stroke();
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "aegisProjector") {
    drawFootprintPanel(unit, hl, hc, 0.88, 0.82, 0.16);
    const radius = Math.min(hl, hc) * 0.58;
    ctx.strokeStyle = "#6ee7b7";
    ctx.lineWidth = Math.max(1.4, unit * 0.11);
    ctx.beginPath(); ctx.arc(-radius * 0.14, 0, radius, -Math.PI * 0.43, Math.PI * 0.43); ctx.stroke();
    ctx.strokeStyle = "rgba(110,231,183,0.42)"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(-radius * 0.14, 0, radius * 0.66, -Math.PI * 0.43, Math.PI * 0.43); ctx.stroke();
    drawFootprintPort(unit, -radius * 0.14, 0, unit * 0.18, "#d1fae5");
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "reactor") {
    drawFootprintPanel(unit, hl, hc, 0.9, 0.73, 0.16);
    ctx.fillStyle = "#fff1a6";
    roundRect(ctx, { x: -hl * 0.5, y: -hc * 0.2, width: hl, height: hc * 0.4, radius: hc * 0.2 }); ctx.fill();
    ctx.strokeStyle = "#c28b16"; ctx.lineWidth = line;
    ctx.beginPath();
    ctx.arc(-hl * 0.5, 0, hc * 0.31, 0, Math.PI * 2);
    ctx.arc(hl * 0.5, 0, hc * 0.31, 0, Math.PI * 2);
    ctx.stroke();
    drawFootprintPort(unit, 0, 0, unit * 0.13, "#fffbea");
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "capacitor") {
    drawFootprintPanel(unit, hl, hc, 0.91, 0.72, 0.08);
    const cells = Math.min(4, Math.max(2, tilesLong * 2));
    const available = hl * 1.55;
    const cellW = available / cells;
    ctx.fillStyle = "#60a5fa";
    for (let i = 0; i < cells; i += 1) {
      const x = -available * 0.5 + i * cellW + cellW * 0.12;
      roundRect(ctx, { x, y: -hc * 0.38, width: cellW * 0.76, height: hc * 0.76, radius: unit * 0.045 }); ctx.fill();
    }
    ctx.strokeStyle = "#dbeafe"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.moveTo(-available * 0.53, 0); ctx.lineTo(available * 0.53, 0); ctx.stroke();
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "droneBay") {
    // Launch deck: a translucent bay opening (keeps the lit hull cube showing
    // through, like every other multi-tile module) with three recessed docking
    // cradles for the squad and a bright central launch rail. One signature
    // accent — cyan — instead of the former flat crosshair on an opaque box.
    drawFootprintPanel(unit, hl, hc, 0.9, 0.9, 0.14);

    const accent = "#67e8f9";
    const cradleFill = mixColor(color, "#04121f", 0.42);
    const bays = 3; // matches the drone squad size
    const span = hl * 1.5;
    const cradleW = span / bays;
    for (let i = 0; i < bays; i += 1) {
      const cx = -span * 0.5 + cradleW * (i + 0.5);
      ctx.fillStyle = cradleFill;
      roundRect(ctx, { x: cx - cradleW * 0.34, y: -hc * 0.5, width: cradleW * 0.68, height: hc, radius: unit * 0.06 });
      ctx.fill();
      ctx.strokeStyle = "rgba(225,238,255,0.22)";
      ctx.lineWidth = fine;
      ctx.stroke();
      drawFootprintPort(unit, cx, 0, unit * 0.1, accent);
    }

    // Central launch rail down the long axis with a restrained glow.
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.strokeStyle = "#a5f3fc";
    ctx.lineWidth = Math.max(fine, unit * 0.06);
    ctx.beginPath();
    ctx.moveTo(-span * 0.5, 0);
    ctx.lineTo(span * 0.5, 0);
    ctx.stroke();
    ctx.restore();

    drawFootprintSeams(unit, hl, hc, Math.max(2, tilesLong));
    return true;
  }

  return false;
}

// Draws a multi-tile component as one purpose-built object spanning its whole
// footprint, in a canonical frame where +x is "forward" (barrel / long axis)
// and the body is centred on the origin. Shared by the arena ship renderer and
// the designer icon baker so blueprint and in-game visuals match. 1x1 parts
// keep using drawModule(); this only handles the elongated/multi-cell types.
export function drawFootprintComponent({ type, unit, tilesLong, tilesCross, color, trim, drawBase = true, drawDetail = true }) {
  const hl = (tilesLong * unit) / 2; // half length along +x
  const hc = (tilesCross * unit) / 2; // half width along y
  const edge = "rgba(3,6,12,0.72)";

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = edge;

  const structural = STRUCTURAL_PARTS.has(type);
  const bodyColor = trim && structural ? mixColor(color, trim, 0.24) : color;
  const bodyFill = getModuleGradient(unit, bodyColor);
  ctx.fillStyle = bodyFill;

  // Multi-cell modules use one continuous, footprint-filling cube base. This is
  // especially important for weapons: their barrels and launchers sit on top of
  // occupied blocks instead of visually floating through empty blueprint cells.
  if (drawBase && !type.startsWith("wing") && !type.startsWith("half")) {
    drawStaticComponentBase({ type, unit, tilesLong, tilesCross, color, trim });
    ctx.fillStyle = bodyFill;
  }

  if (!drawDetail) {
    ctx.restore();
    return;
  }

  if (drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, bodyColor, hl, hc)) {
    ctx.restore();
    return;
  }

  // Long rounded chassis used as the base body for most elongated parts.
  const chassis = (padCross = 0.72, radius = unit * 0.22) => {
    roundRect(ctx, { x: -hl, y: -hc * padCross, width: hl * 2, height: hc * padCross * 2, radius });
    ctx.fill();
    ctx.stroke();
  };
  const panelSeams = (count) => {
    ctx.save();
    ctx.strokeStyle = "rgba(210,222,240,0.18)";
    ctx.lineWidth = Math.max(0.6, unit * 0.04);
    for (let i = 1; i < count; i += 1) {
      const x = -hl + (hl * 2 * i) / count;
      ctx.beginPath();
      ctx.moveTo(x, -hc * 0.6);
      ctx.lineTo(x, hc * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  };

  if (type === "engine") {
    // Long propulsion block, nozzle bell + hot throat at the rear (-x).
    roundRect(ctx, { x: -hl + unit * 0.34, y: -hc * 0.8, width: hl * 2 - unit * 0.34, height: hc * 1.6, radius: unit * 0.16 });
    ctx.fill();
    ctx.stroke();
    panelSeams(tilesLong);
    ctx.fillStyle = "#0a2732";
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.34, -hc * 0.5);
    ctx.lineTo(-hl, -hc * 0.42);
    ctx.lineTo(-hl, hc * 0.42);
    ctx.lineTo(-hl + unit * 0.34, hc * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.28, -hc * 0.26);
    ctx.lineTo(-hl - unit * 0.02, 0);
    ctx.lineTo(-hl + unit * 0.28, hc * 0.26);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (type === "reactor") {
    // Elongated capsule housing with glowing core band.
    roundRect(ctx, { x: -hl, y: -hc * 0.86, width: hl * 2, height: hc * 1.72, radius: hc * 0.7 });
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#ffe07a";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#fff7b3";
    roundRect(ctx, { x: -hl * 0.62, y: -hc * 0.3, width: hl * 1.24, height: hc * 0.6, radius: hc * 0.3 });
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#6b4b12";
    ctx.beginPath();
    ctx.arc(-hl * 0.5, 0, hc * 0.34, 0, Math.PI * 2);
    ctx.arc(hl * 0.5, 0, hc * 0.34, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "capacitor") {
    // Long block of charge cells.
    roundRect(ctx, { x: -hl, y: -hc * 0.84, width: hl * 2, height: hc * 1.68, radius: unit * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    const cols = Math.max(2, tilesLong + 1);
    for (let c = 0; c < cols; c += 1) {
      const cx = -hl + unit * 0.24 + (hl * 2 - unit * 0.48) * (c / (cols - 1 || 1));
      ctx.fillRect(cx - unit * 0.06, -hc * 0.5, unit * 0.12, hc);
    }
  } else if (structural) {
    // Armour/frame/wings: one plate covering the whole footprint with seams.
    roundRect(ctx, { x: -hl, y: -hc, width: hl * 2, height: hc * 2, radius: unit * 0.14 });
    ctx.fill();
    ctx.stroke();
    panelSeams(tilesLong);
    if (type.startsWith("wing")) {
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.moveTo(-hl * 0.7, -hc * 0.5);
      ctx.lineTo(hl * 0.7, 0);
      ctx.lineTo(-hl * 0.7, hc * 0.5);
      ctx.stroke();
    }
  } else {
    // Unknown multi-tile type: fall back to a scaled single module.
    ctx.restore();
    drawModule({ x: 0, y: 0, size: Math.min(hl, hc) * 2 * 0.92, color, type, trim });
    return;
  }

  ctx.restore();
}

// --- Ship structural spine ------------------------------------------------------

export function drawShipStructure(design, scale, color) {
  const keys = new Set(design.map((part) => `${part.x},${part.y}`));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, scale * 0.26);
  ctx.strokeStyle = "rgba(0,0,0,0.42)";
  drawStructureLines(design, keys, scale);
  // Team colour on the structural spine, made more prominent so ownership reads
  // at a glance even under the (toned-down) shield.
  ctx.lineWidth = Math.max(1.6, scale * 0.17);
  ctx.strokeStyle = color;
  ctx.globalAlpha *= 0.78;
  drawStructureLines(design, keys, scale);
  ctx.restore();
}

export function drawStructureLines(design, keys, scale) {
  ctx.beginPath();
  for (const part of design) {
    const { x, y } = moduleLocalPosition(part, scale);
    if (keys.has(`${part.x + 1},${part.y}`)) {
      const next = moduleLocalPosition({ x: part.x + 1, y: part.y }, scale);
      ctx.moveTo(x, y);
      ctx.lineTo(next.x, next.y);
    }
    if (keys.has(`${part.x},${part.y + 1}`)) {
      const next = moduleLocalPosition({ x: part.x, y: part.y + 1 }, scale);
      ctx.moveTo(x, y);
      ctx.lineTo(next.x, next.y);
    }
  }
  ctx.stroke();
}
