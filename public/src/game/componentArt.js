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
import {
  moduleRotationToRadians,
  normalizeRotation
} from "../design/rotation.js";
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

export const STRUCTURAL_PARTS = new Set([
  "frame", "armor", "compositeArmor", "ablativeArmor",
  "halfFrameDiagonal", "halfArmorDiagonal", "halfCompositeArmorDiagonal",
  "wingFrame", "wingArmor", "wingCompositeArmor",
  "bevelFrame", "bevelArmor", "bevelCompositeArmor",
  "roundedFrame", "roundedArmor", "roundedCompositeArmor",
  "longWedgeFrame", "longWedgeArmor", "longWedgeCompositeArmor",
  "halfAblativeArmorDiagonal", "wingAblativeArmor", "bevelAblativeArmor",
  "roundedAblativeArmor", "longWedgeAblativeArmor",
  "lightFrame", "heavyFrame"
]);

// Ablative plating is its own material inside the structural family, so every
// silhouette that has an ablative variant asks this instead of `composite`.
const ABLATIVE_PARTS = new Set([
  "ablativeArmor", "halfAblativeArmorDiagonal", "wingAblativeArmor",
  "bevelAblativeArmor", "roundedAblativeArmor", "longWedgeAblativeArmor"
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
const moduleGradientCache = new WeakMap();

function getModuleGradient(size, color) {
  const key = `${size}|${color}`;
  let ctxCache = moduleGradientCache.get(ctx);
  if (!ctxCache) {
    ctxCache = new Map();
    moduleGradientCache.set(ctx, ctxCache);
  }
  let fill = ctxCache.get(key);
  if (!fill) {
    fill = ctx.createLinearGradient(-size * 0.5, -size * 0.5, size * 0.5, size * 0.5);
    fill.addColorStop(0, mixColor(color, "#ffffff", 0.52));
    fill.addColorStop(0.32, mixColor(color, "#ffffff", 0.14));
    fill.addColorStop(0.6, color);
    fill.addColorStop(1, mixColor(color, "#05070c", 0.74));
    ctxCache.set(key, fill);
  }
  return fill;
}

// Cross-axis barrel shading: the barrel keeps its original pale colour along
// the lit top edge and only darkens toward the underside, so it reads as a
// rounded tube instead of a flat tab. Cached the same way as the module
// gradient so the Canvas 2D path does not rebuild a gradient per frame.
const barrelGradientCache = new WeakMap();

function getBarrelGradient(halfWidth, pale) {
  const key = `${halfWidth}|${pale}`;
  let ctxCache = barrelGradientCache.get(ctx);
  if (!ctxCache) {
    ctxCache = new Map();
    barrelGradientCache.set(ctx, ctxCache);
  }
  let fill = ctxCache.get(key);
  if (!fill) {
    fill = ctx.createLinearGradient(0, -halfWidth, 0, halfWidth);
    fill.addColorStop(0, mixColor(pale, "#ffffff", 0.25));
    fill.addColorStop(0.4, pale);
    fill.addColorStop(1, mixColor(pale, "#7b2740", 0.62));
    ctxCache.set(key, fill);
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

// --- Shared structural material -------------------------------------------------
// The armour family (full cube, bevel, rounded corner, long wedge) is one
// material: three overlapping plate bands, a lit top bevel and — for composite —
// an amber laminate weave. Cut-away silhouettes clip these same strokes to their
// own outline so a bevelled plate reads as the same steel as a full one.
function drawArmorLaminate(size, color, composite, fine) {
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
}

// Ablative counterpart to the laminate: sacrificial spall plating. The same three
// courses as the armour family, but each course is broken into staggered tiles on
// a charred substrate whose seams glow through, with one tile already burned away
// at the leading edge — it ablates instead of stopping a shell, and the art has to
// say so at a glance. Callers clip to their own silhouette first, exactly as they
// do for drawArmorLaminate, so a bevelled ablative plate reads as the same
// material as a full one.
function drawAblativeSpallPlating(size, color, fine) {
  // Charred substrate: the tiles are bedded on it and its seams glow through.
  ctx.fillStyle = "rgba(14,7,10,0.94)";
  ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
  ctx.strokeStyle = "rgba(255,146,64,0.55)";
  ctx.lineWidth = Math.max(0.8, size * 0.03);
  ctx.beginPath();
  ctx.moveTo(-size * 0.5, -size * 0.16); ctx.lineTo(size * 0.5, -size * 0.16);
  ctx.moveTo(-size * 0.5, size * 0.16); ctx.lineTo(size * 0.5, size * 0.16);
  ctx.moveTo(0, -size * 0.5); ctx.lineTo(0, size * 0.5);
  ctx.stroke();

  // Sacrificial heat-shield tiles: cut-corner plates, hottest at the leading
  // edge where the top course has already charred through.
  const tilePath = (cx, cy, w, h, cut) => {
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.5 + cut, cy - h * 0.5);
    ctx.lineTo(cx + w * 0.5 - cut, cy - h * 0.5);
    ctx.lineTo(cx + w * 0.5, cy - h * 0.5 + cut);
    ctx.lineTo(cx + w * 0.5, cy + h * 0.5 - cut);
    ctx.lineTo(cx + w * 0.5 - cut, cy + h * 0.5);
    ctx.lineTo(cx - w * 0.5 + cut, cy + h * 0.5);
    ctx.lineTo(cx - w * 0.5, cy + h * 0.5 - cut);
    ctx.lineTo(cx - w * 0.5, cy - h * 0.5 + cut);
    ctx.closePath();
  };
  const rowFills = [
    mixColor(color, "#140609", 0.52),
    mixColor(color, "#ffffff", 0.08),
    mixColor(color, "#05070c", 0.28)
  ];
  const tileW = size * 0.42;
  const tileH = size * 0.27;
  const cut = size * 0.07;
  for (let row = 0; row < 3; row += 1) {
    const cy = -size * 0.31 + row * size * 0.31;
    for (const cx of [-size * 0.23, size * 0.23]) {
      ctx.fillStyle = rowFills[row];
      ctx.strokeStyle = "rgba(3,6,12,0.6)";
      ctx.lineWidth = fine;
      tilePath(cx, cy, tileW, tileH, cut);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = row === 0 ? "rgba(255,168,96,0.6)" : "rgba(255,255,255,0.2)";
      ctx.lineWidth = Math.max(0.7, size * 0.022);
      ctx.beginPath();
      ctx.moveTo(cx - tileW * 0.5 + cut, cy - tileH * 0.5);
      ctx.lineTo(cx + tileW * 0.5 - cut, cy - tileH * 0.5);
      ctx.stroke();
    }
  }

  // One tile spalled away at the leading edge, exposing glowing substrate.
  ctx.fillStyle = "rgba(255,132,52,0.5)";
  ctx.beginPath();
  ctx.moveTo(size * 0.06, -size * 0.44);
  ctx.lineTo(size * 0.34, -size * 0.44);
  ctx.lineTo(size * 0.28, -size * 0.29);
  ctx.lineTo(size * 0.1, -size * 0.33);
  ctx.closePath();
  ctx.fill();
}

// Fills an already-described silhouette with spall plating and re-inks its edge,
// so cut-away ablative shapes (half, wing) show the same tiles as a full block
// without the tile strokes bleeding past the outline.
function drawClippedAblativeFace(size, color, fine, outline) {
  ctx.save();
  outline();
  ctx.clip();
  drawAblativeSpallPlating(size, color, fine);
  ctx.restore();
  outline();
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.lineWidth = Math.max(0.9, size * 0.08);
  ctx.stroke();
}

// Glowing cut face for ablative silhouettes: the edge the plating is burning
// back from, drawn just inside the outline so it lights the shape's own profile.
function drawAblativeHotEdge(size, describe) {
  ctx.strokeStyle = "rgba(255,168,96,0.6)";
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.beginPath();
  describe();
  ctx.stroke();
}

// Frame counterpart to the laminate: dark internal bracing with one lit chord.
function drawFrameBracing(size, fine, reach = 0.34) {
  ctx.strokeStyle = "rgba(8,14,24,0.72)";
  ctx.lineWidth = Math.max(1.2, size * 0.13);
  ctx.beginPath();
  ctx.moveTo(-size * reach, -size * reach); ctx.lineTo(size * reach, size * reach);
  ctx.moveTo(size * reach, -size * reach); ctx.lineTo(-size * reach, size * reach);
  ctx.stroke();
  ctx.strokeStyle = "rgba(225,236,250,0.28)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.moveTo(-size * (reach - 0.03), -size * (reach - 0.03));
  ctx.lineTo(size * (reach - 0.03), size * (reach - 0.03));
  ctx.stroke();
}

// Corner rivets on whichever corners a cut-away shape actually keeps.
function drawArmorRivets(size, color, corners) {
  const rivet = mixColor(color, "#ffffff", 0.55);
  for (const [x, y] of corners) drawComponentPort(size, x, y, 0.05, rivet, 0.5);
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
  pointDefenseLaser: "pointDefense",
  sensorArray: "largeSensor",
  directedSensor: "largeDirectedSensor"
});

function componentArtType(type) {
  return COMPONENT_ART_ALIASES[type] || type;
}

// Aliased art types whose weapon art is split into a static mount plus a
// rotating top. Every active rotating weapon family must appear here; unknown
// weapon types fall back to a generic barrel top so they still visibly track.
const WEAPON_ART_TYPES = new Set([
  "blaster", "autocannon", "pointDefense", "flakCannon", "missile",
  "railgun", "swarmMissile", "torpedo", "beamEmitter", "thermalInductionLance", "repairBeam",
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
    // Keep the outside half of the outline inside the occupied footprint.
    // Arena textures are not cell-clipped, so this prevents a multi-cell body
    // from bleeding a dark stroke into an adjacent component at any zoom.
    const edgeInset = ctx.lineWidth * 0.5;
    ctx.fillStyle = getModuleGradient(Math.max(hl, hc) * 2, bodyColor);
    roundRect(ctx, {
      x: -hl + edgeInset,
      y: -hc + edgeInset,
      width: hl * 2 - edgeInset * 2,
      height: hc * 2 - edgeInset * 2,
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
    // Central bearing ring the gun assembly pivots on. The railgun keeps a
    // small one: its slug carriage sits over the pivot, and a full-size ring
    // would peek out between the open rails as a stray circle.
    drawWeaponBase(Math.min(hl, hc) * (artType === "railgun" ? 0.85 : 1.7));
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

// Aegis projector head: a continuous emitter ring instead of a barrel, so the
// module never reads as a turret. Deliberately rotationally symmetric — the
// projector puts out a field in every direction, it does not aim.
function drawAegisEmitterRing(unit, radius) {
  ctx.save();
  ctx.shadowColor = "#34d399";
  ctx.shadowBlur = qualityShadowBlur(6);
  ctx.strokeStyle = "#6ee7b7";
  ctx.lineWidth = Math.max(1.4, unit * 0.085);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(110,231,183,0.45)";
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.6, 0, Math.PI * 2);
  ctx.stroke();
  // Emitter nodes on the ring keep the field legible when the glow is off.
  ctx.fillStyle = "#a7f3d0";
  for (let i = 0; i < 4; i += 1) {
    const a = Math.PI * (0.25 + i * 0.5);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * radius, Math.sin(a) * radius, Math.max(1, unit * 0.06), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#ecfdf5";
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1, unit * 0.09), 0, Math.PI * 2);
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
    // Short, wide straight-sided barrel. Its breech end runs back over the
    // pivot cap so the barrel visibly bolts into the hub instead of ending at
    // the socket ring. Tip sits at TurretRules.MUZZLE_TIP_TILES.blaster.
    const back = -size * 0.15;
    const tip = size * 0.56;
    const half = size * 0.15;
    const barrelPath = (dy = 0, grow = 0) => {
      roundRect(ctx, {
        x: back - grow,
        y: -half - grow + dy,
        width: tip - back + grow * 2,
        height: half * 2 + grow * 2,
        radius: size * 0.04
      });
    };

    // Pivot cap first: the barrel is drawn over it, so the cap reads as the
    // yoke the barrel is seated in.
    drawTurretCap(size, color, 0.2);

    // Contact shadow separating the barrel from the circular base below it.
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.55)";
    barrelPath(size * 0.075, size * 0.015);
    ctx.fill();
    ctx.restore();

    // Same pale barrel colour as before, shaded across the tube so it reads as
    // a rounded barrel rather than a flat tab.
    ctx.fillStyle = getBarrelGradient(half, "#ffd1dc");
    barrelPath();
    ctx.fill();
    ctx.stroke();

    // Muzzle: a dark opening recessed into the tip with a bright energy slit
    // inside it. The slit stays inside the barrel edge so it never reads as a
    // pale tab stuck on the end.
    ctx.save();
    ctx.fillStyle = "rgba(4,7,13,0.94)";
    roundRect(ctx, {
      x: tip - size * 0.11,
      y: -half * 0.9,
      width: size * 0.11,
      height: half * 1.8,
      radius: size * 0.028
    });
    ctx.fill();
    ctx.shadowColor = mixColor(color, "#ffffff", 0.35);
    ctx.shadowBlur = qualityShadowBlur(4);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.68);
    ctx.fillRect(tip - size * 0.08, -half * 0.48, size * 0.04, half * 0.96);
    ctx.restore();
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
    // A missile on a rail rather than a flat kite: straight body, a distinct
    // nose cone, swept tail fins, and a rear that runs back over the pivot cap
    // so the round is visibly seated on the launcher. The round is balanced
    // about the pivot: `back` and `nose` are equal and opposite (give or take
    // the fin overhang) so the round's own midpoint lands on the component
    // centre instead of riding forward in the cell. The nose sits at
    // TurretRules.MUZZLE_TIP_TILES.missile (0.4) — keep the two in sync.
    const back = -size * 0.36;
    const shoulder = size * 0.2;
    const nose = size * 0.4;
    const half = size * 0.135;
    const bodyPath = (dy = 0, grow = 0) => {
      ctx.beginPath();
      ctx.moveTo(nose + grow, dy);
      ctx.lineTo(shoulder, -half - grow + dy);
      ctx.lineTo(back - grow, -half - grow + dy);
      ctx.lineTo(back - grow, half + grow + dy);
      ctx.lineTo(shoulder, half + grow + dy);
      ctx.closePath();
    };

    drawTurretCap(size, color, 0.19);

    // Contact shadow so the round sits on the launcher instead of floating.
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.55)";
    bodyPath(size * 0.075, size * 0.015);
    ctx.fill();
    ctx.restore();

    // Fins first, so the body overlaps them and they read as attached.
    ctx.save();
    ctx.fillStyle = "#a78bfa";
    ctx.lineWidth = Math.max(0.7, size * 0.04);
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(size * 0.02, sy * half * 0.85);
      ctx.lineTo(back - size * 0.01, sy * size * 0.25);
      ctx.lineTo(back - size * 0.01, sy * half * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = getBarrelGradient(half, "#f0dcff");
    bodyPath();
    ctx.fill();
    ctx.stroke();

    // The whole warhead cone is tinted, not just its tip, so the head reads as
    // a separate section at a glance. A seam band marks where it joins the body.
    ctx.save();
    ctx.fillStyle = mixColor("#f0dcff", "#7c3aed", 0.72);
    ctx.beginPath();
    ctx.moveTo(nose, 0);
    ctx.lineTo(shoulder, -half);
    ctx.lineTo(shoulder, half);
    ctx.closePath();
    ctx.fill();
    // Re-stroke the cone edges the tint just covered, so the head keeps a crisp
    // outline against a purple hull.
    ctx.stroke();
    ctx.fillStyle = "rgba(50,22,95,0.7)";
    ctx.fillRect(shoulder - size * 0.03, -half, size * 0.035, half * 2);
    ctx.restore();
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
  } else if (artType === "thermalInductionLance") {
    // Single-cell fallback for the same coil-wound lance the 1x2 footprint draws.
    ctx.fillStyle = "#4c1d95";
    roundRect(ctx, { x: -size * 0.04, y: -size * 0.1, width: size * 0.6, height: size * 0.2, radius: size * 0.05 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#e9d5ff";
    ctx.lineWidth = Math.max(0.9, size * 0.06);
    for (const cx of [0.12, 0.28, 0.44]) {
      ctx.beginPath();
      ctx.moveTo(size * cx, -size * 0.18);
      ctx.lineTo(size * cx, size * 0.18);
      ctx.stroke();
    }
    ctx.save();
    ctx.shadowColor = "#e879f9";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#f5d0fe";
    ctx.beginPath();
    ctx.moveTo(size * 0.5, -size * 0.14);
    ctx.lineTo(size * 0.66, -size * 0.05);
    ctx.lineTo(size * 0.66, size * 0.05);
    ctx.lineTo(size * 0.5, size * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    drawTurretCap(size, color, 0.13);
  } else if (artType === "aegisProjector") {
    drawAegisEmitterRing(size, size * 0.32);
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

  if (artType === "railgun") {
    // Two rails accelerating one visible slug — deliberately only four parts,
    // plus a single brace. Every extra mechanism (inner cage, paired clamps,
    // rail-end brackets, a second charge bar) made this read as a capital-class
    // spinal mount rather than a standard railgun, so the empty space between
    // the rails is load-bearing here: keep it empty.
    const railY = hc * 0.54;
    const railBack = -hl + unit * 0.44;
    const railFront = hl - unit * 0.2;

    // 1. The open gap. Filled flush between the rails with no border of its
    //    own — the railgun's near-white colour would otherwise swallow the
    //    rails, but an outlined panel here reads as a cage around the slug.
    ctx.save();
    ctx.fillStyle = "rgba(6,10,18,0.58)";
    ctx.fillRect(railBack, -railY, railFront - railBack, railY * 2);
    ctx.restore();

    // 2. Compact breech at the rear: the only heavy mass on the weapon.
    ctx.fillStyle = mixColor(color, "#0b111c", 0.55);
    roundRect(ctx, {
      x: -hl + unit * 0.07,
      y: -hc * 0.6,
      width: unit * 0.4,
      height: hc * 1.2,
      radius: unit * 0.07
    });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(122,164,255,0.5)";
    ctx.fillRect(-hl + unit * 0.17, -hc * 0.3, unit * 0.16, hc * 0.6);

    // 3. The rails: two continuous pale bars running almost the full length.
    ctx.save();
    ctx.strokeStyle = "#eef4ff";
    ctx.lineWidth = Math.max(1.1, unit * 0.1);
    ctx.beginPath();
    ctx.moveTo(railBack, -railY); ctx.lineTo(railFront, -railY);
    ctx.moveTo(railBack, railY); ctx.lineTo(railFront, railY);
    ctx.stroke();
    ctx.restore();

    // A single brace behind the slug, so the rails read as one assembly.
    ctx.fillStyle = mixColor(color, "#0b111c", 0.45);
    roundRect(ctx, {
      x: -unit * 0.54,
      y: -railY,
      width: unit * 0.09,
      height: railY * 2,
      radius: unit * 0.02
    });
    ctx.fill();
    ctx.stroke();

    // 4. The slug: small, bright, sitting directly in the open gap. This is the
    //    focal point, so it is the only part that glows.
    ctx.save();
    ctx.shadowColor = "#9fdcff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#dbeafe";
    roundRect(ctx, {
      x: -unit * 0.13,
      y: -unit * 0.075,
      width: unit * 0.32,
      height: unit * 0.15,
      radius: unit * 0.06
    });
    ctx.fill();
    ctx.restore();

    // 5. Muzzle bridge: one bar spanning the rail tips, marking the exit.
    ctx.fillStyle = "#cbd5e1";
    roundRect(ctx, {
      x: hl - unit * 0.24,
      y: -railY - unit * 0.05,
      width: unit * 0.13,
      height: railY * 2 + unit * 0.1,
      radius: unit * 0.035
    });
    ctx.fill();
    ctx.stroke();
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
  } else if (artType === "thermalInductionLance") {
    // Induction lance: a slim waveguide wound with coil rings, fed from a rear
    // charge cell, ending in a narrow violet emitter throat. Nothing like the
    // beam emitter's wide focusing head — this one couples heat, not damage.
    const violet = "#a855f7";
    ctx.fillStyle = "#2e1065";
    roundRect(ctx, { x: -hl * 0.82, y: -hc * 0.46, width: hl * 0.6, height: hc * 0.92, radius: unit * 0.09 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = violet;
    roundRect(ctx, { x: -hl * 0.72, y: -hc * 0.26, width: hl * 0.38, height: hc * 0.52, radius: unit * 0.05 });
    ctx.fill();

    // Waveguide out to the muzzle.
    ctx.fillStyle = "#4c1d95";
    roundRect(ctx, { x: -hl * 0.3, y: -hc * 0.22, width: hl * 1.24 - unit * 0.05, height: hc * 0.44, radius: unit * 0.06 });
    ctx.fill();
    ctx.stroke();

    // Induction coils wrapped around the guide.
    ctx.strokeStyle = "#e9d5ff";
    ctx.lineWidth = Math.max(fine, unit * 0.075);
    for (const cx of [-hl * 0.14, hl * 0.12, hl * 0.38]) {
      ctx.beginPath();
      ctx.moveTo(cx, -hc * 0.42);
      ctx.lineTo(cx, hc * 0.42);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(216,180,254,0.55)";
    ctx.lineWidth = Math.max(0.7, unit * 0.035);
    ctx.beginPath();
    ctx.moveTo(-hl * 0.28, -hc * 0.34);
    ctx.lineTo(hl * 0.5, -hc * 0.34);
    ctx.moveTo(-hl * 0.28, hc * 0.34);
    ctx.lineTo(hl * 0.5, hc * 0.34);
    ctx.stroke();

    // Emitter throat: a narrow hot slot rather than a broad lens.
    ctx.save();
    ctx.shadowColor = "#e879f9";
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = "#f5d0fe";
    ctx.beginPath();
    ctx.moveTo(hl * 0.62, -hc * 0.34);
    ctx.lineTo(hl - unit * 0.04, -hc * 0.1);
    ctx.lineTo(hl - unit * 0.04, hc * 0.1);
    ctx.lineTo(hl * 0.62, hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "rgba(250,232,255,0.85)";
    ctx.lineWidth = Math.max(fine, unit * 0.05);
    ctx.beginPath();
    ctx.moveTo(-hl * 0.34, 0);
    ctx.lineTo(hl * 0.6, 0);
    ctx.stroke();
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
  } else if (artType === "aegisProjector") {
    // Same emitter ring as the single-cell head, scaled to the footprint: no
    // barrel, so a multi-cell projector never reads as a gun.
    drawAegisEmitterRing(unit, Math.min(hl, hc) * 0.82);
  } else {
    // Generic elongated barrel out to the forward footprint edge.
    ctx.fillStyle = "#e2e8f0";
    roundRect(ctx, { x: -hl * 0.3, y: -hc * 0.24, width: hl * 1.24, height: hc * 0.48, radius: unit * 0.08 });
    ctx.fill();
    ctx.stroke();
    drawTurretCap(unit * Math.min(2, (hc * 2) / unit), color, 0.2);
  }
}

// Draw a structural cut-away/rounded/wedge shape. The silhouette, cut edges and
// rivets rotate with `rotation`, but the underlying plate/tile material and the
// soft body gradient are drawn in ship-local space so adjacent armour tiles read
// as one continuous belt with consistent lighting.
function withRotatedShape(size, rotation, outline, drawMaterial, drawEdge) {
  const shapeAngle = moduleRotationToRadians(normalizeRotation(rotation));

  ctx.save();
  ctx.rotate(shapeAngle);
  outline();
  ctx.clip();
  ctx.rotate(-shapeAngle);
  ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
  drawMaterial();
  ctx.restore();

  ctx.save();
  ctx.rotate(shapeAngle);
  drawEdge();
  outline();
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.lineWidth = Math.max(0.9, size * 0.08);
  ctx.stroke();
  ctx.restore();
}

// --- Professional single-cell detail ------------------------------------------

function drawProfessionalModuleDetail(type, size, color, visualState = "active", rotation = 0) {
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
    drawFrameBracing(size, fine);
    drawComponentPort(size, 0, 0, 0.095, "#d8e2f0", 0.35);
    return true;
  }

  if (type === "halfFrameDiagonal" || type === "halfArmorDiagonal" || type === "halfCompositeArmorDiagonal"
    || type === "halfAblativeArmorDiagonal") {
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size * 0.5);
      ctx.lineTo(size * 0.5, -size * 0.5);
      ctx.lineTo(-size * 0.5, size * 0.5);
      ctx.closePath();
    };
    if (ABLATIVE_PARTS.has(type)) {
      withRotatedShape(size, rotation, outline,
        () => drawAblativeSpallPlating(size, color, fine),
        () => drawAblativeHotEdge(size, () => {
          ctx.moveTo(size * 0.4, -size * 0.42);
          ctx.lineTo(-size * 0.42, size * 0.4);
        }));
    } else {
      withRotatedShape(size, rotation, outline, () => {},
        () => {
          ctx.strokeStyle = type === "halfFrameDiagonal" ? "rgba(225,236,250,0.46)" : "rgba(255,244,220,0.42)";
          ctx.lineWidth = line;
          ctx.beginPath();
          ctx.moveTo(-size * 0.32, -size * 0.32);
          ctx.lineTo(type === "halfFrameDiagonal" ? size * 0.17 : size * 0.1, -size * 0.32);
          ctx.lineTo(-size * 0.32, type === "halfFrameDiagonal" ? size * 0.17 : size * 0.1);
          ctx.stroke();
        });
    }
    return true;
  }

  if (type === "wingFrame" || type === "wingArmor" || type === "wingCompositeArmor" || type === "wingAblativeArmor") {
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size * 0.5);
      ctx.lineTo(size * 0.5, 0);
      ctx.lineTo(-size * 0.5, size * 0.5);
      ctx.closePath();
    };
    if (ABLATIVE_PARTS.has(type)) {
      withRotatedShape(size, rotation, outline,
        () => drawAblativeSpallPlating(size, color, fine),
        () => drawAblativeHotEdge(size, () => {
          ctx.moveTo(-size * 0.44, -size * 0.4);
          ctx.lineTo(size * 0.38, -size * 0.03);
          ctx.moveTo(-size * 0.44, size * 0.4);
          ctx.lineTo(size * 0.38, size * 0.03);
        }));
    } else {
      withRotatedShape(size, rotation, outline, () => {},
        () => {
          ctx.strokeStyle = type === "wingFrame" ? "rgba(225,236,250,0.46)" : "rgba(255,244,220,0.42)";
          ctx.lineWidth = line;
          ctx.beginPath();
          ctx.moveTo(-size * 0.34, -size * 0.3);
          ctx.lineTo(size * 0.16, 0);
          ctx.lineTo(-size * 0.34, size * 0.3);
          ctx.stroke();
        });
    }
    return true;
  }

  if (type === "ablativeArmor") {
    ctx.save();
    roundRect(ctx, { x: -size * 0.47, y: -size * 0.47, width: size * 0.94, height: size * 0.94, radius: size * 0.05 });
    ctx.clip();
    drawAblativeSpallPlating(size, color, fine);
    ctx.restore();

    drawArmorRivets(size, color, [[-0.42, -0.16], [0.42, -0.16], [-0.42, 0.42], [0.42, 0.42]]);
    return true;
  }

  if (type === "bevelFrame" || type === "bevelArmor" || type === "bevelCompositeArmor" || type === "bevelAblativeArmor") {
    // Cell block with the leading corner chamfered away. It carries the same
    // laminate/bracing as the full cube, clipped to the cut silhouette, plus a
    // lit chamfer face so the cut reads as machined rather than as a missing
    // corner.
    const isFrame = type === "bevelFrame";
    const s = size * 0.46;
    const cut = size * 0.46;
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-s, -s);
      ctx.lineTo(s - cut, -s);
      ctx.lineTo(s, -s + cut);
      ctx.lineTo(s, s);
      ctx.lineTo(-s, s);
      ctx.closePath();
    };
    const drawMaterial = () => {
      if (isFrame) drawFrameBracing(size, fine, 0.3);
      else if (type === "bevelAblativeArmor") drawAblativeSpallPlating(size, color, fine);
      else drawArmorLaminate(size, color, type === "bevelCompositeArmor", fine);
    };
    const drawEdge = () => {
      ctx.save();
      ctx.lineCap = "butt";
      ctx.strokeStyle = isFrame ? "rgba(232,241,255,0.6)" : "rgba(255,240,214,0.62)";
      ctx.lineWidth = Math.max(1.4, size * 0.11);
      ctx.beginPath();
      ctx.moveTo(s - cut - size * 0.06, -s - size * 0.06);
      ctx.lineTo(s + size * 0.06, -s + cut + size * 0.06);
      ctx.stroke();
      ctx.strokeStyle = "rgba(3,6,12,0.4)";
      ctx.lineWidth = Math.max(0.8, size * 0.05);
      ctx.beginPath();
      ctx.moveTo(s - cut + size * 0.09, -s + size * 0.14);
      ctx.lineTo(s - size * 0.14, -s + cut - size * 0.09);
      ctx.stroke();
      ctx.restore();
      if (isFrame) drawComponentPort(size, -0.08, 0.08, 0.085, "#d8e2f0", 0.35);
      else drawArmorRivets(size, color, [[-0.38, -0.34], [-0.38, 0.36], [0.38, 0.36]]);
    };
    withRotatedShape(size, rotation, outline, drawMaterial, drawEdge);
    return true;
  }

  if (type === "roundedFrame" || type === "roundedArmor" || type === "roundedCompositeArmor" || type === "roundedAblativeArmor") {
    // Same block with a full quarter-round on the leading corner: a swept
    // shoulder that deflects fire instead of the barely visible fillet it used
    // to be.
    const isFrame = type === "roundedFrame";
    const s = size * 0.46;
    const r = size * 0.62;
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-s, -s);
      ctx.lineTo(s - r, -s);
      ctx.arcTo(s, -s, s, -s + r, r);
      ctx.lineTo(s, s);
      ctx.lineTo(-s, s);
      ctx.closePath();
    };
    const drawMaterial = () => {
      if (isFrame) drawFrameBracing(size, fine, 0.3);
      else if (type === "roundedAblativeArmor") drawAblativeSpallPlating(size, color, fine);
      else drawArmorLaminate(size, color, type === "roundedCompositeArmor", fine);
    };
    const drawEdge = () => {
      // Swept shoulder: a bright rim inside the arc with a darker shadow line
      // behind it, so the curve reads as a rolled surface.
      ctx.strokeStyle = isFrame ? "rgba(232,241,255,0.6)" : "rgba(255,240,214,0.62)";
      ctx.lineWidth = Math.max(1.4, size * 0.1);
      ctx.beginPath();
      ctx.arc(s - r, -s + r, r - size * 0.04, -Math.PI * 0.5, 0);
      ctx.stroke();
      ctx.strokeStyle = "rgba(3,6,12,0.4)";
      ctx.lineWidth = Math.max(0.8, size * 0.05);
      ctx.beginPath();
      ctx.arc(s - r, -s + r, r - size * 0.16, -Math.PI * 0.5, 0);
      ctx.stroke();
      if (isFrame) drawComponentPort(size, -0.1, 0.1, 0.085, "#d8e2f0", 0.35);
      else drawArmorRivets(size, color, [[-0.38, -0.34], [-0.38, 0.36], [0.38, 0.36]]);
    };
    withRotatedShape(size, rotation, outline, drawMaterial, drawEdge);
    return true;
  }

  if (type === "armor" || type === "compositeArmor") {
    // Full-cube plating: three overlapping armour bands with a lit top bevel
    // and corner rivets. Composite adds diagonal laminate weave in amber.
    const composite = type === "compositeArmor";
    ctx.save();
    drawArmorLaminate(size, color, composite, fine);
    drawArmorRivets(size, color, [[-0.38, -0.32], [0.38, -0.32], [-0.38, 0.36], [0.38, 0.36]]);
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

  if (type === "compactEngine") {
    // Single-cell sibling of the main engine, built from the same parts so the
    // two read as one family: intake turbine forward (+x), cowled power section,
    // one nozzle bell with a hot throat aft (-x).
    drawRecessedPanel(size, 0.92, 0.88, 0.1);

    // Cowling over the power section.
    ctx.fillStyle = mixColor(color, "#ffffff", 0.12);
    ctx.strokeStyle = "rgba(3,6,12,0.66)";
    ctx.lineWidth = fine;
    roundRect(ctx, { x: -size * 0.16, y: -size * 0.27, width: size * 0.5, height: size * 0.54, radius: size * 0.09 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(225,248,255,0.5)";
    ctx.beginPath();
    ctx.moveTo(size * 0.09, -size * 0.24); ctx.lineTo(size * 0.09, size * 0.24);
    ctx.stroke();

    // Nozzle bell aft: a slim shroud around a glowing throat.
    ctx.fillStyle = "rgba(2,20,29,0.92)";
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = Math.max(0.8, size * 0.05);
    ctx.beginPath();
    ctx.moveTo(-size * 0.17, -size * 0.2);
    ctx.lineTo(-size * 0.42, -size * 0.28);
    ctx.lineTo(-size * 0.42, size * 0.28);
    ctx.lineTo(-size * 0.17, size * 0.2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(137,247,255,0.5)";
    ctx.lineWidth = Math.max(0.7, size * 0.03);
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.28);
    ctx.lineTo(-size * 0.42, size * 0.28);
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.moveTo(-size * 0.2, -size * 0.12);
    ctx.lineTo(-size * 0.4, -size * 0.17);
    ctx.lineTo(-size * 0.4, size * 0.17);
    ctx.lineTo(-size * 0.2, size * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Intake turbine forward.
    ctx.fillStyle = "rgba(3,12,20,0.9)";
    ctx.beginPath();
    ctx.arc(size * 0.3, 0, size * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#bcefff";
    ctx.lineWidth = Math.max(0.8, size * 0.045);
    ctx.beginPath();
    ctx.arc(size * 0.3, 0, size * 0.105, 0, Math.PI * 2);
    ctx.stroke();
    drawComponentPort(size, 0.3, 0, 0.045, "#52d8ff", 0.6);

    // Flank conduits tying turbine to nozzle.
    ctx.strokeStyle = "rgba(132,230,255,0.7)";
    ctx.lineWidth = Math.max(0.7, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(-size * 0.1, -size * 0.35); ctx.lineTo(size * 0.26, -size * 0.35);
    ctx.moveTo(-size * 0.1, size * 0.35); ctx.lineTo(size * 0.26, size * 0.35);
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
  if (type === "smallSensor") {
    // Compact omni dish: the shared scope face on a mounting plate, with the
    // same corner telltales the other 1x1 system modules carry.
    drawRecessedPanel(size, 0.82, 0.82, 0.14);
    drawSensorScope(size, size * 0.29, "#67e8f9", "#ecfeff", 2);
    for (const [px, py] of [[-0.37, -0.37], [0.37, -0.37], [-0.37, 0.37], [0.37, 0.37]]) {
      drawComponentPort(size, px, py, 0.055, "#7dd3fc", 0.5);
    }
    return true;
  }
  if (type === "largeSensor") {
    // Same instrument as the small dish, one size up: a wider well with an
    // extra range ring and a bolted mounting collar around it.
    drawRecessedPanel(size, 0.88, 0.88, 0.13);
    ctx.save();
    ctx.strokeStyle = "rgba(103,232,249,0.4)";
    ctx.lineWidth = Math.max(0.7, size * 0.045);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawSensorScope(size, size * 0.34, "#67e8f9", "#ecfeff", 3);
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI * (0.25 + i * 0.5);
      drawComponentPort(size, Math.cos(a) * 0.4, Math.sin(a) * 0.4, 0.06, "#a5f3fc", 0.5);
    }
    return true;
  }
  if (type === "smallDirectedSensor" || type === "largeDirectedSensor") {
    // Directional aperture pointing along local +x — the same facing the
    // in-game sensor cone uses.
    const directed = type === "largeDirectedSensor";
    drawRecessedPanel(size, 0.88, 0.82, 0.11);
    drawDirectedSensorArray(size, size * 0.5, size * 0.5, "#a5f3fc", "#ecfeff", directed ? 5 : 3);
    for (const py of [-0.37, 0.37]) {
      drawComponentPort(size, -0.38, py, 0.055, "#7dd3fc", 0.5);
    }
    return true;
  }

  if (type === "proximityDemolitionCharge" || type === "demolitionCharge") {
    // Same housing language as every other system module — recessed panel,
    // centred assembly, corner telltales — with the shared warhead face at
    // its centre so it matches the multi-cell charge instead of reading as a
    // cartoon bomb.
    const armed = visualState === "armed" || visualState === "active";
    const accent = armed ? "#ff5a4d" : "#f59e0b";
    const hot = armed ? "#fff1e6" : "#fde68a";
    drawRecessedPanel(size, 0.8, 0.8, 0.16);
    drawChargeWarhead(size, size * 0.3, accent, hot, armed);
    for (const [px, py] of [[-0.37, -0.37], [0.37, -0.37], [-0.37, 0.37], [0.37, 0.37]]) {
      drawComponentPort(size, px, py, 0.06, armed ? "#ff6b5c" : "#64748b", 0.5);
    }
    return true;
  }

  if (type === "decoyLauncher") {
    const inactive = visualState === "inactive" || visualState === "disabled";
    const damaged = visualState === "damaged";
    const signal = damaged ? "#fb7185" : inactive ? "#64748b" : "#7dd3fc";
    const falseLock = damaged ? "#fda4af" : inactive ? "#94a3b8" : "#c4b5fd";

    // The housing is the cell: chamfered emitter wings, radial signal traces,
    // and corner projector nodes all converge on the false-lock beacon.
    ctx.save();
    ctx.fillStyle = "rgba(5,11,24,0.72)";
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.22);
    ctx.lineWidth = Math.max(0.8, size * 0.055);
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.25);
    ctx.lineTo(-size * 0.25, -size * 0.46);
    ctx.lineTo(size * 0.25, -size * 0.46);
    ctx.lineTo(size * 0.46, -size * 0.25);
    ctx.lineTo(size * 0.46, size * 0.25);
    ctx.lineTo(size * 0.25, size * 0.46);
    ctx.lineTo(-size * 0.25, size * 0.46);
    ctx.lineTo(-size * 0.46, size * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Four projector vanes make the role legible even when the glow is absent.
    ctx.fillStyle = mixColor(color, "#071426", 0.5);
    for (let i = 0; i < 4; i += 1) {
      ctx.save();
      ctx.rotate(i * Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(-size * 0.12, -size * 0.16);
      ctx.lineTo(size * 0.38, -size * 0.29);
      ctx.lineTo(size * 0.43, -size * 0.1);
      ctx.lineTo(size * 0.15, -size * 0.03);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.shadowColor = signal;
    ctx.shadowBlur = qualityShadowBlur(inactive ? 0 : 7);
    ctx.strokeStyle = signal;
    ctx.lineWidth = Math.max(0.8, size * 0.055);
    for (const radius of [0.18, 0.31]) {
      ctx.beginPath();
      ctx.arc(0, 0, size * radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Offset diamond is a projected false target, not a generic badge.
    ctx.strokeStyle = falseLock;
    ctx.lineWidth = Math.max(1, size * 0.075);
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.16);
    ctx.lineTo(size * 0.16, 0);
    ctx.lineTo(0, size * 0.16);
    ctx.lineTo(-size * 0.16, 0);
    ctx.closePath();
    ctx.stroke();
    drawComponentPort(size, 0, 0, 0.09, inactive ? "#64748b" : "#eff6ff", 0.58);

    for (const [x, y] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
      drawComponentPort(size, x, y, 0.07, signal, inactive ? 0.32 : 0.58);
    }

    if (damaged) {
      ctx.strokeStyle = "#fecaca";
      ctx.lineWidth = Math.max(0.8, size * 0.05);
      ctx.beginPath();
      ctx.moveTo(-size * 0.28, -size * 0.08);
      ctx.lineTo(-size * 0.08, size * 0.02);
      ctx.lineTo(size * 0.02, size * 0.24);
      ctx.lineTo(size * 0.24, size * 0.32);
      ctx.stroke();
    }
    ctx.restore();
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
  if (type === "backupCore") {
    drawRecessedPanel(size, 0.8, 0.76, 0.14);
    ctx.strokeStyle = "#c4b5fd";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#8b5cf6";
    ctx.fillRect(-size * 0.06, -size * 0.3, size * 0.12, size * 0.6);
    ctx.fillRect(-size * 0.3, -size * 0.06, size * 0.6, size * 0.12);
    drawComponentPort(size, 0, 0, 0.09, "#f5f3ff", 0.55);
    return true;
  }
  if (type === "nuclearReactor") {
    drawRecessedPanel(size, 0.82, 0.78, 0.16);
    ctx.strokeStyle = "#fb923c";
    ctx.lineWidth = line;
    for (const radius of [0.16, 0.3]) {
      ctx.beginPath();
      ctx.arc(0, 0, size * radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawComponentPort(size, 0, 0, 0.12, "#fef08a", 0.65);
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
  if (type === "closedCycleCooler") {
    // Sealed refrigeration loop: a dark machinery bay holding a closed circuit
    // of coolant pipe that runs from a capped inlet, round a driven compressor,
    // out through a capped outlet. Reads as plumbing under pressure — nothing
    // like the heat sink's open fin stack or the radiator's bare fan.
    drawRecessedPanel(size, 0.88, 0.88, 0.12);

    // Closed circuit: dark pipe casing with a bright coolant core inside it.
    const loop = (width, stroke) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      roundRect(ctx, { x: -size * 0.31, y: -size * 0.31, width: size * 0.62, height: size * 0.62, radius: size * 0.16 });
      ctx.stroke();
    };
    loop(Math.max(2, size * 0.16), "rgba(4,26,38,0.92)");
    loop(Math.max(1, size * 0.075), "#5ce1f5");

    // Compressor: a housed rotor with vanes, driven off the loop.
    ctx.fillStyle = "rgba(3,14,22,0.92)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.185, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(186,240,255,0.5)";
    ctx.lineWidth = fine;
    ctx.stroke();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    for (let i = 0; i < 3; i += 1) {
      const a = (i * Math.PI * 2) / 3 - Math.PI / 6;
      ctx.moveTo(Math.cos(a) * size * 0.05, Math.sin(a) * size * 0.05);
      ctx.lineTo(Math.cos(a) * size * 0.15, Math.sin(a) * size * 0.15);
    }
    ctx.stroke();
    drawComponentPort(size, 0, 0, 0.055, "#ecfeff", 0.55);

    // Capped inlet and outlet on opposite faces — a sealed cycle, not an
    // exhaust: the stubs stop at the housing wall.
    ctx.strokeStyle = "rgba(4,26,38,0.92)";
    ctx.lineWidth = Math.max(1.6, size * 0.13);
    ctx.beginPath();
    ctx.moveTo(-size * 0.44, -size * 0.19); ctx.lineTo(-size * 0.31, -size * 0.19);
    ctx.moveTo(size * 0.44, size * 0.19); ctx.lineTo(size * 0.31, size * 0.19);
    ctx.stroke();
    drawComponentPort(size, -0.42, -0.19, 0.075, "#a5f3fc", 0.5);
    drawComponentPort(size, 0.42, 0.19, 0.075, "#a5f3fc", 0.5);

    // Accumulator bottle on the return leg — the sealed charge this loop carries.
    ctx.fillStyle = "rgba(4,26,38,0.92)";
    ctx.strokeStyle = "rgba(165,243,252,0.5)";
    ctx.lineWidth = Math.max(0.7, size * 0.03);
    roundRect(ctx, { x: -size * 0.12, y: size * 0.24, width: size * 0.24, height: size * 0.14, radius: size * 0.06 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#67e8f9";
    roundRect(ctx, { x: -size * 0.08, y: size * 0.275, width: size * 0.11, height: size * 0.07, radius: size * 0.03 });
    ctx.fill();
    return true;
  }
  if (type === "heatPipe") {
    // Cell-wide thermal manifold: insulated edge couplings joined by a broad
    // serpentine coolant route, with no separate icon plate.
    ctx.save();
    ctx.fillStyle = "rgba(5,16,27,0.54)";
    ctx.strokeStyle = "rgba(186,230,253,0.34)";
    ctx.lineWidth = fine;
    roundRect(ctx, { x: -size * 0.45, y: -size * 0.34, width: size * 0.9, height: size * 0.68, radius: size * 0.15 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#0c4a6e";
    ctx.lineWidth = Math.max(2, size * 0.17);
    ctx.beginPath();
    ctx.moveTo(-size * 0.48, -size * 0.2);
    ctx.lineTo(-size * 0.18, -size * 0.2);
    ctx.quadraticCurveTo(0, -size * 0.2, 0, 0);
    ctx.quadraticCurveTo(0, size * 0.2, size * 0.18, size * 0.2);
    ctx.lineTo(size * 0.48, size * 0.2);
    ctx.stroke();
    ctx.strokeStyle = "#7dd3fc";
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.stroke();
    drawComponentPort(size, -0.4, -0.2, 0.1, "#e0f2fe", 0.5);
    drawComponentPort(size, 0.4, 0.2, 0.1, "#e0f2fe", 0.5);
    ctx.restore();
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

export function drawModule({ x, y, size, color, type, trim, drawBase = true, drawDetail = true, visualState = "active", rotation = 0 }) {
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
    || type === "wingCompositeArmor"
    || type === "bevelFrame"
    || type === "bevelArmor"
    || type === "bevelCompositeArmor"
    || type === "roundedFrame"
    || type === "roundedArmor"
    || type === "roundedCompositeArmor"
    || type === "halfAblativeArmorDiagonal"
    || type === "wingAblativeArmor"
    || type === "bevelAblativeArmor"
    || type === "roundedAblativeArmor";
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
  if (drawProfessionalModuleDetail(type, size, bodyColor, visualState, rotation)) {
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
  } else if (type === "backupCore") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#c4b5fd";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.moveTo(-size * 0.28, 0); ctx.lineTo(size * 0.28, 0);
    ctx.moveTo(0, -size * 0.28); ctx.lineTo(0, size * 0.28);
    ctx.stroke();
    ctx.fillStyle = "#ede9fe";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.1, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "reactor" || type === "nuclearReactor") {
    drawRoundSystem(size);
    ctx.fillStyle = type === "nuclearReactor" ? "#fef08a" : "#fff7b3";
    ctx.beginPath();
    ctx.arc(0, 0, size * (type === "nuclearReactor" ? 0.24 : 0.2), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = type === "nuclearReactor" ? "#c2410c" : "#6b4b12";
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
  } else if (type === "closedCycleCooler") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "#06b6d4";
    ctx.beginPath();
    for (let i = 0; i < 4; i += 1) {
      const a = (i * Math.PI) / 2;
      ctx.moveTo(Math.cos(a) * size * 0.08, Math.sin(a) * size * 0.08);
      ctx.lineTo(Math.cos(a) * size * 0.22, Math.sin(a) * size * 0.22);
    }
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

function drawFootprintMachineFrame(unit, hl, hc, accent, options = {}) {
  const insetX = options.insetX ?? unit * 0.12;
  const insetY = options.insetY ?? unit * 0.12;
  const fine = Math.max(0.7, unit * 0.045);
  ctx.save();
  ctx.fillStyle = "rgba(4,9,16,0.68)";
  ctx.strokeStyle = "rgba(226,237,250,0.28)";
  ctx.lineWidth = fine;
  roundRect(ctx, {
    x: -hl + insetX,
    y: -hc + insetY,
    width: hl * 2 - insetX * 2,
    height: hc * 2 - insetY * 2,
    radius: Math.min(unit * 0.16, hc * 0.22)
  });
  ctx.fill();
  ctx.stroke();

  // Long structural rails visually bind every occupied cell into one machine.
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.2);
  ctx.lineWidth = Math.max(1, unit * 0.08);
  ctx.beginPath();
  ctx.moveTo(-hl + unit * 0.2, -hc + unit * 0.22);
  ctx.lineTo(hl - unit * 0.2, -hc + unit * 0.22);
  ctx.moveTo(-hl + unit * 0.2, hc - unit * 0.22);
  ctx.lineTo(hl - unit * 0.2, hc - unit * 0.22);
  ctx.stroke();

  ctx.strokeStyle = "rgba(3,7,13,0.88)";
  ctx.lineWidth = Math.max(1.2, unit * 0.11);
  for (const x of [-hl + unit * 0.2, hl - unit * 0.2]) {
    ctx.beginPath();
    ctx.moveTo(x, -hc + unit * 0.16);
    ctx.lineTo(x, hc - unit * 0.16);
    ctx.stroke();
  }
  ctx.restore();
}

// Shared warhead face for both demolition charges: a dark containment well,
// accent containment rings, diagonal compression bolts and a lit detonator
// core. The 1x1 and the multi-cell charge draw the same face at different
// radii, so the pair reads as one family instead of two unrelated props.
export function drawChargeWarhead(unit, radius, accent, hot, armed) {
  ctx.save();
  ctx.shadowColor = accent;
  ctx.shadowBlur = qualityShadowBlur(armed ? 9 : 3);
  ctx.fillStyle = "rgba(8,12,20,0.86)";
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.38);
  ctx.lineWidth = Math.max(1, unit * 0.075);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(0.9, unit * (armed ? 0.07 : 0.05));
  for (const scale of [0.74, 0.46]) {
    ctx.beginPath();
    ctx.arc(0, 0, radius * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.45);
  ctx.lineWidth = Math.max(0.7, unit * 0.04);
  for (let i = 0; i < 4; i += 1) {
    const a = Math.PI * (0.25 + i * 0.5);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * radius * 0.5, Math.sin(a) * radius * 0.5);
    ctx.lineTo(Math.cos(a) * radius * 0.92, Math.sin(a) * radius * 0.92);
    ctx.stroke();
  }
  ctx.restore();
  drawFootprintPort(unit, 0, 0, Math.max(1, radius * 0.3), hot);
}

// Shared scope face for the omnidirectional sensors: a dark receiver well,
// accent range rings, a graticule, one swept return wedge and a lit feed at the
// boresight. The small dish, the 1x1 array and the multi-cell array all draw
// this face at their own radius, so the omni family reads as one instrument the
// way both demolition charges share drawChargeWarhead.
function drawSensorScope(unit, radius, accent, hot, rings = 2) {
  const fine = Math.max(0.6, unit * 0.035);

  ctx.save();
  ctx.fillStyle = "rgba(4,13,23,0.88)";
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.32);
  ctx.lineWidth = Math.max(0.9, unit * 0.06);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // The sweep's afterglow, laid down first so the graticule stays legible over
  // it. Clipped to the well so the wedge can never spill onto the housing, and
  // stacked in narrowing bands so the tail fades behind the sweep line instead
  // of ending on a hard edge.
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.95, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = accent;
  for (const trail of [0.72, 0.44, 0.24]) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, -Math.PI * trail, -Math.PI * 0.1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = fine;
  ctx.globalAlpha = 0.32;
  ctx.beginPath();
  ctx.moveTo(-radius * 0.92, 0);
  ctx.lineTo(radius * 0.92, 0);
  ctx.moveTo(0, -radius * 0.92);
  ctx.lineTo(0, radius * 0.92);
  ctx.stroke();
  ctx.globalAlpha = 0.72;
  for (let i = 1; i <= rings; i += 1) {
    ctx.beginPath();
    ctx.arc(0, 0, radius * (i / (rings + 1)) * 0.94, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Leading edge of the sweep, the one bright line on the face.
  ctx.save();
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.5);
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(-Math.PI * 0.1) * radius * 0.94, Math.sin(-Math.PI * 0.1) * radius * 0.94);
  ctx.stroke();
  ctx.restore();

  drawFootprintPort(unit, 0, 0, Math.max(1, radius * 0.26), hot);
}

// Shared aperture for the directed sensors: a receiver housing at the rear, a
// waveguide spine, a phased dish bowed toward the target with its emitter
// elements, and the watched cone fanning off the rim. Laid out in the canonical
// frame where local +x is the sensor's facing, matching the arc the game draws.
function drawDirectedSensorArray(unit, hl, hc, accent, hot, elements = 4) {
  const fine = Math.max(0.6, unit * 0.04);
  const dishX = -hl * 0.06;      // dish rim plane
  const bow = hl * 0.34;         // how far the dish bows forward of the rim
  const aperture = hc * 0.78;    // dish half-height
  const reach = hl * 0.94;       // front of the watched cone

  // The cone first, so the hardware sits on top of it. Stacked in shortening
  // bands so it dims with distance rather than ending on a flat edge.
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = accent;
  const throatX = dishX + bow * 0.4;
  for (const depth of [1, 0.66, 0.34]) {
    const frontX = throatX + (reach - throatX) * depth;
    const frontY = aperture * 0.62 + (hc * 0.92 - aperture * 0.62) * depth;
    ctx.beginPath();
    ctx.moveTo(throatX, -aperture * 0.62);
    ctx.lineTo(frontX, -frontY);
    ctx.lineTo(frontX, frontY);
    ctx.lineTo(throatX, aperture * 0.62);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Phase fronts crossing the cone give it depth without another fill.
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.66;
  ctx.lineWidth = fine;
  for (let i = 1; i <= 2; i += 1) {
    const t = i / 2.6;
    const x = dishX + bow + (reach - dishX - bow) * t;
    const y = aperture * (0.66 + t * 0.3);
    ctx.beginPath();
    ctx.moveTo(x, -y);
    ctx.quadraticCurveTo(x + hl * 0.08, 0, x, y);
    ctx.stroke();
  }
  ctx.restore();

  // Receiver housing and waveguide spine.
  ctx.save();
  ctx.fillStyle = "rgba(4,13,23,0.9)";
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.3);
  ctx.lineWidth = Math.max(0.8, unit * 0.055);
  roundRect(ctx, {
    x: -hl * 0.88,
    y: -hc * 0.46,
    width: hl * 0.46,
    height: hc * 0.92,
    radius: unit * 0.07
  });
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.24);
  ctx.lineWidth = Math.max(1, unit * 0.07);
  ctx.beginPath();
  ctx.moveTo(-hl * 0.42, 0);
  ctx.lineTo(dishX + bow * 0.5, 0);
  ctx.stroke();
  ctx.restore();

  // The dish: a crescent bowed forward, dark inside so the elements read.
  ctx.save();
  ctx.fillStyle = "rgba(5,17,29,0.94)";
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.2);
  ctx.lineWidth = Math.max(0.9, unit * 0.06);
  ctx.beginPath();
  ctx.moveTo(dishX, -aperture);
  ctx.quadraticCurveTo(dishX + bow * 2.1, 0, dishX, aperture);
  ctx.quadraticCurveTo(dishX + bow * 0.9, 0, dishX, -aperture);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Emitter elements spaced across the aperture, riding the dish midline.
  ctx.save();
  ctx.fillStyle = accent;
  for (let i = 0; i < elements; i += 1) {
    const t = elements === 1 ? 0 : (i / (elements - 1)) * 2 - 1;
    const y = t * aperture * 0.7;
    const x = dishX + bow * 0.75 * (1 - t * t);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.8, unit * 0.055), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  drawFootprintPort(unit, -hl * 0.65, 0, Math.max(1, unit * 0.13), hot);
}

function drawDemolitionChargeAssembly(unit, tilesLong, hl, hc, color, visualState = "safed") {
  const armed = visualState === "armed" || visualState === "active";
  const accent = armed ? "#ff5a4d" : "#f59e0b";
  const hot = armed ? "#fff1e6" : "#fde68a";
  const fine = Math.max(0.7, unit * 0.045);
  const warheadRadius = Math.min(hc * 0.6, hl * 0.36);

  drawFootprintPanel(unit, hl, hc, 0.9, 0.86, 0.14);

  // Firing bus down the long axis, ending at the two trigger heads, with the
  // charge racks along both flanks — the same deck layout the other multi-cell
  // machines use, rather than a bomb sitting in the middle of a frame.
  const headX = hl - unit * 0.32;
  ctx.save();
  ctx.strokeStyle = "rgba(226,237,250,0.3)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.moveTo(-headX, 0);
  ctx.lineTo(headX, 0);
  ctx.stroke();
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.42);
  ctx.lineWidth = Math.max(1, unit * 0.07);
  for (const sy of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(-hl * 0.6, sy * hc * 0.62);
    ctx.lineTo(hl * 0.6, sy * hc * 0.62);
    ctx.stroke();
  }
  ctx.restore();

  drawChargeWarhead(unit, warheadRadius, accent, hot, armed);

  // Safed keeps cold grey telltales; armed energises every trigger head.
  for (const sx of [-1, 1]) {
    drawFootprintPort(unit, sx * headX, 0, unit * 0.13, armed ? "#ff6b5c" : "#94a3b8");
    for (const sy of [-1, 1]) {
      drawFootprintPort(unit, sx * hl * 0.6, sy * hc * 0.62, unit * 0.075, armed ? "#ff5a4d" : "#64748b");
    }
  }

  drawFootprintSeams(unit, hl, hc, tilesLong);
}

function drawNuclearReactorAssembly(unit, tilesLong, hl, hc, color) {
  // The capital-scale sibling of `reactor`: same panel, containment ring and
  // lit core, built out into an actual plant — a shielded core well feeding a
  // coolant loop that runs out to a heat-exchanger drum at each end. The plain
  // reactor's flat coolant bar disappeared against the bright gold body, so the
  // detail here is dark-on-gold machinery instead of yellow-on-yellow.
  const fine = Math.max(0.7, unit * 0.045);
  const line = Math.max(1, unit * 0.075);
  const coreRadius = Math.min(hc * 0.58, hl * 0.34);
  const drumX = hl - unit * 0.42;
  const loopY = hc * 0.64;

  drawFootprintPanel(unit, hl, hc, 0.92, 0.88, 0.14);

  // Coolant loop: hot feed out along one flank, return along the other.
  for (const sy of [-1, 1]) {
    ctx.save();
    ctx.strokeStyle = "rgba(10,15,23,0.78)";
    ctx.lineWidth = Math.max(1.4, unit * 0.115);
    ctx.beginPath();
    ctx.moveTo(-drumX, sy * loopY);
    ctx.lineTo(drumX, sy * loopY);
    ctx.stroke();
    ctx.strokeStyle = "#f6b93b";
    ctx.lineWidth = Math.max(0.9, unit * 0.055);
    ctx.stroke();
    ctx.restore();
  }

  // Risers tying the loop into the core well.
  ctx.save();
  ctx.strokeStyle = "rgba(246,185,59,0.55)";
  ctx.lineWidth = fine;
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * coreRadius * 0.74, sy * coreRadius * 0.74);
      ctx.lineTo(sx * coreRadius * 1.3, sy * loopY);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Heat-exchanger drums at both ends of the long axis, where the plain
  // reactor carries its two containment rings.
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.fillStyle = "rgba(6,11,19,0.82)";
    ctx.strokeStyle = mixColor(color, "#2a1803", 0.55);
    ctx.lineWidth = fine;
    roundRect(ctx, {
      x: sx * drumX - unit * 0.19,
      y: -hc * 0.74,
      width: unit * 0.38,
      height: hc * 1.48,
      radius: unit * 0.1
    });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(194,139,22,0.85)";
    for (const t of [-0.42, 0.42]) {
      ctx.beginPath();
      ctx.moveTo(sx * drumX - unit * 0.15, hc * t);
      ctx.lineTo(sx * drumX + unit * 0.15, hc * t);
      ctx.stroke();
    }
    ctx.restore();
    drawFootprintPort(unit, sx * drumX, 0, unit * 0.12, "#fde68a");
  }

  // Shielded core well: containment rings plus three shield blocks, which is
  // what separates it from the plain reactor's single ring at a glance.
  ctx.save();
  ctx.shadowColor = "#fbbf24";
  ctx.shadowBlur = qualityShadowBlur(7);
  ctx.fillStyle = "rgba(26,15,3,0.9)";
  ctx.strokeStyle = mixColor(color, "#2a1803", 0.45);
  ctx.lineWidth = Math.max(1.2, unit * 0.1);
  ctx.beginPath();
  ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(0, 0, coreRadius * 0.74, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(253,230,138,0.5)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.arc(0, 0, coreRadius * 0.48, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = mixColor(color, "#150e02", 0.62);
  ctx.strokeStyle = "rgba(253,230,138,0.45)";
  for (let i = 0; i < 3; i += 1) {
    ctx.save();
    ctx.rotate(i * (Math.PI * 2 / 3) - Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(-coreRadius * 0.3, -coreRadius * 0.99);
    ctx.lineTo(coreRadius * 0.3, -coreRadius * 0.99);
    ctx.lineTo(coreRadius * 0.2, -coreRadius * 0.58);
    ctx.lineTo(-coreRadius * 0.2, -coreRadius * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  drawFootprintPort(unit, 0, 0, Math.max(1, coreRadius * 0.3), "#fffbe6");
  drawFootprintSeams(unit, hl, hc, tilesLong);
}

function drawBackupCoreAssembly(unit, tilesLong, hl, hc, color) {
  // Multi-cell version of the single-cell backup core badge: recessed panel,
  // violet command ring with a crosshair, and link nodes along the long axis.
  const fine = Math.max(0.7, unit * 0.045);
  const line = Math.max(1, unit * 0.075);
  const ringR = Math.min(hc * 0.54, hl * 0.34);

  drawFootprintPanel(unit, hl, hc, 0.9, 0.8, 0.14);

  ctx.strokeStyle = "rgba(196,181,253,0.55)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.moveTo(-hl * 0.72, 0);
  ctx.lineTo(hl * 0.72, 0);
  ctx.stroke();

  ctx.strokeStyle = "#c4b5fd";
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(0, 0, ringR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#8b5cf6";
  roundRect(ctx, { x: -ringR * 0.16, y: -ringR * 1.16, width: ringR * 0.32, height: ringR * 2.32, radius: unit * 0.03 });
  ctx.fill();
  roundRect(ctx, { x: -ringR * 1.16, y: -ringR * 0.16, width: ringR * 2.32, height: ringR * 0.32, radius: unit * 0.03 });
  ctx.fill();

  drawFootprintPort(unit, 0, 0, unit * 0.12, "#f5f3ff");
  drawFootprintPort(unit, -hl * 0.72, 0, unit * 0.09, "#a78bfa");
  drawFootprintPort(unit, hl * 0.72, 0, unit * 0.09, "#a78bfa");

  drawFootprintSeams(unit, hl, hc, tilesLong);
}

// --- Command deck family ------------------------------------------------------

// Every Command-category module is the same machine with a different job: a
// recessed console deck, a data bus down the long axis ending in the uplink
// nodes the aura is broadcast from, flanking workstations, and one command
// ring carrying a single role glyph. Only the accent colour and the glyph
// differ, so a command block reads as command at a glance and as its specific
// role on inspection — the same way the backup core badge is built.
const COMMAND_ROLE_ART = Object.freeze({
  fireControlCommandCentre: { accent: "#fdba74", glyph: "targetLock" },
  fleetDefenceCoordinator: { accent: "#fca5a5", glyph: "escort" },
  shieldCommandRelay: { accent: "#86efac", glyph: "shieldArcs" },
  engineeringCommandCentre: { accent: "#93c5fd", glyph: "damageControl" },
  propulsionCommandRelay: { accent: "#67e8f9", glyph: "vector" },
  electronicWarfareCommandCentre: { accent: "#d8b4fe", glyph: "jammer" }
});

function drawCommandRoleGlyph(glyph, unit, r, accent) {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = Math.max(0.9, unit * 0.06);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (glyph === "targetLock") {
    // Fire control: a lock box drawn as four corner brackets around a pip.
    const g = r * 0.62;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx * g, sy * g * 0.36);
      ctx.lineTo(sx * g, sy * g);
      ctx.lineTo(sx * g * 0.36, sy * g);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
  } else if (glyph === "escort") {
    // Fleet defence: an escort wedge sheltering two flanking hulls.
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.62);
    ctx.lineTo(r * 0.5, r * 0.16);
    ctx.lineTo(0, r * 0.4);
    ctx.lineTo(-r * 0.5, r * 0.16);
    ctx.closePath();
    ctx.stroke();
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.66, r * 0.5, r * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (glyph === "shieldArcs") {
    // Shield relay: the shield module's open-bottom arcs, doubled.
    for (const scale of [0.72, 0.44]) {
      ctx.beginPath();
      ctx.arc(0, 0, r * scale, Math.PI * 0.18, Math.PI * 1.82);
      ctx.stroke();
    }
  } else if (glyph === "damageControl") {
    // Engineering: a hex service plate around a repair cross.
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = i * (Math.PI / 3) + Math.PI / 6;
      const x = Math.cos(a) * r * 0.66;
      const y = Math.sin(a) * r * 0.66;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, 0); ctx.lineTo(r * 0.3, 0);
    ctx.moveTo(0, -r * 0.3); ctx.lineTo(0, r * 0.3);
    ctx.stroke();
  } else if (glyph === "vector") {
    // Propulsion relay: stacked thrust chevrons along the long axis.
    for (const dx of [-0.4, 0.06]) {
      ctx.beginPath();
      ctx.moveTo(r * dx, -r * 0.5);
      ctx.lineTo(r * (dx + 0.42), 0);
      ctx.lineTo(r * dx, r * 0.5);
      ctx.stroke();
    }
  } else if (glyph === "jammer") {
    // Electronic warfare: mirrored emission fans instead of one aimed beam.
    for (const sx of [-1, 1]) {
      for (const scale of [0.38, 0.68]) {
        const from = sx > 0 ? -Math.PI * 0.3 : Math.PI * 0.7;
        ctx.beginPath();
        ctx.arc(0, 0, r * scale, from, from + Math.PI * 0.6);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCommandDeckAssembly(type, unit, tilesLong, tilesCross, hl, hc, color) {
  const role = COMMAND_ROLE_ART[type];
  const accent = role ? role.accent : mixColor(color, "#ffffff", 0.5);
  const fine = Math.max(0.7, unit * 0.045);
  const line = Math.max(1, unit * 0.075);
  const ringR = Math.min(hc * 0.62, hl * 0.46);
  const nodeX = hl - unit * 0.3;

  drawFootprintPanel(unit, hl, hc, 0.9, 0.84, 0.14);

  ctx.save();
  ctx.strokeStyle = "rgba(226,237,250,0.3)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.moveTo(-nodeX, 0);
  ctx.lineTo(nodeX, 0);
  ctx.stroke();

  // Flanking workstations; only decks two cells across have room for them.
  if (tilesCross > 1) {
    ctx.strokeStyle = mixColor(accent, "#05070c", 0.42);
    ctx.lineWidth = Math.max(1, unit * 0.07);
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl * 0.58, sy * hc * 0.62);
      ctx.lineTo(hl * 0.58, sy * hc * 0.62);
      ctx.stroke();
    }
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        drawFootprintPort(unit, sx * hl * 0.58, sy * hc * 0.62, unit * 0.075, accent);
      }
    }
  }
  ctx.restore();

  // Command ring: dark instrument well with a lit accent rim.
  ctx.save();
  ctx.fillStyle = "rgba(4,9,17,0.8)";
  ctx.beginPath();
  ctx.arc(0, 0, ringR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = line;
  ctx.stroke();
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.5);
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.arc(0, 0, ringR * 0.86, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  drawCommandRoleGlyph(role ? role.glyph : "targetLock", unit, ringR, accent);

  drawFootprintPort(unit, -nodeX, 0, unit * 0.11, mixColor(accent, "#ffffff", 0.45));
  drawFootprintPort(unit, nodeX, 0, unit * 0.11, mixColor(accent, "#ffffff", 0.45));

  drawFootprintSeams(unit, hl, hc, tilesLong);
}

function drawGenericFootprintMachine(type, unit, tilesLong, color, hl, hc) {
  const category = PART_STATS[type]?.category || "Support";
  const fine = Math.max(0.7, unit * 0.045);
  drawFootprintMachineFrame(unit, hl, hc, color);
  drawFootprintSeams(unit, hl, hc, tilesLong);

  if (category === "Structure") {
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.34);
    ctx.lineWidth = Math.max(1.2, unit * 0.12);
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.28, -hc + unit * 0.28);
    ctx.lineTo(hl - unit * 0.28, hc - unit * 0.28);
    ctx.moveTo(hl - unit * 0.28, -hc + unit * 0.28);
    ctx.lineTo(-hl + unit * 0.28, hc - unit * 0.28);
    ctx.stroke();
  } else {
    // Unknown future modules still receive a connected relay/conduit machine,
    // never a scaled single-cell badge floating in the centre.
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.24);
    ctx.lineWidth = Math.max(1, unit * 0.085);
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.3, 0);
    ctx.lineTo(hl - unit * 0.3, 0);
    ctx.stroke();
    const nodes = Math.max(2, tilesLong);
    for (let i = 0; i < nodes; i += 1) {
      const x = -hl + unit * 0.5 + (hl * 2 - unit) * (i / Math.max(1, nodes - 1));
      drawFootprintPort(unit, x, 0, unit * 0.12, mixColor(color, "#ffffff", 0.52));
    }
    ctx.strokeStyle = "rgba(226,237,250,0.34)";
    ctx.lineWidth = fine;
  }
  return true;
}

function drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0) {
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

  if (type === "largeSensor" || type === "largeDirectedSensor") {
    const directed = type === "largeDirectedSensor";
    const accent = directed ? "#a5f3fc" : "#67e8f9";
    drawFootprintPanel(unit, hl, hc, 0.94, 0.86, 0.12);

    if (directed) {
      // The same aperture as the 1x1 directed sensor, spanning the footprint.
      // It points along local +x, matching the authoritative component rotation
      // the in-game cone uses.
      drawDirectedSensorArray(unit, hl, hc, accent, "#ecfeff", 5);
    } else {
      // One primary scope on the boresight with two secondary apertures on the
      // flanks, so the array stays symmetric like the omni sensor it models.
      const radius = Math.min(hc * 0.82, hl * 0.42);
      ctx.save();
      ctx.strokeStyle = "rgba(226,237,250,0.22)";
      ctx.lineWidth = Math.max(0.7, unit * 0.04);
      ctx.beginPath();
      ctx.moveTo(-hl * 0.74, 0);
      ctx.lineTo(hl * 0.74, 0);
      ctx.stroke();
      ctx.restore();
      for (const sx of [-1, 1]) {
        const x = sx * (radius + unit * 0.22);
        ctx.save();
        ctx.fillStyle = "rgba(4,13,23,0.86)";
        ctx.strokeStyle = mixColor(accent, "#05070c", 0.34);
        ctx.lineWidth = Math.max(0.8, unit * 0.055);
        ctx.beginPath();
        ctx.arc(x, 0, unit * 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawFootprintPort(unit, x, 0, unit * 0.09, "#ecfeff");
      }
      drawSensorScope(unit, radius, accent, "#ecfeff", 3);
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "nuclearReactor") {
    drawNuclearReactorAssembly(unit, tilesLong, hl, hc, color);
    return true;
  }

  if (type === "backupCore") {
    drawBackupCoreAssembly(unit, tilesLong, hl, hc, color);
    return true;
  }

  if (type === "proximityDemolitionCharge" || type === "demolitionCharge") {
    drawDemolitionChargeAssembly(unit, tilesLong, hl, hc, color, visualState);
    return true;
  }

  if (type === "longWedgeFrame" || type === "longWedgeArmor" || type === "longWedgeCompositeArmor"
    || type === "longWedgeAblativeArmor") {
    // Two-cell prow: broad at the rear (-x), tapering to a blunt nose at +x.
    // The prow silhouette rotates with the part, but the armour courses / tile
    // rows stay in ship-local space so the prow still reads as the same belt.
    const isFrame = type === "longWedgeFrame";
    const composite = type === "longWedgeCompositeArmor";
    const ablative = type === "longWedgeAblativeArmor";
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-hl, -hc);
      ctx.lineTo(hl * 0.86, -hc * 0.2);
      ctx.lineTo(hl, -hc * 0.06);
      ctx.lineTo(hl, hc * 0.06);
      ctx.lineTo(hl * 0.86, hc * 0.2);
      ctx.lineTo(-hl, hc);
      ctx.closePath();
    };

    const drawMaterial = () => {
      if (ablative) {
        ctx.fillStyle = "rgba(14,7,10,0.94)";
        ctx.fillRect(-hl, -hc, hl * 2, hc * 2);
        ctx.strokeStyle = "rgba(255,146,64,0.55)";
        ctx.lineWidth = Math.max(0.8, unit * 0.03);
        ctx.beginPath();
        ctx.moveTo(-hl, 0);
        ctx.lineTo(hl, 0);
        ctx.stroke();

        const columns = Math.max(4, tilesLong * 2);
        const span = (hl * 2) / columns;
        const tileW = span - unit * 0.06;
        const tileH = hc - unit * 0.06;
        const cut = Math.min(tileW, tileH) * 0.22;
        const tileFills = [
          mixColor(color, "#140609", 0.52),
          mixColor(color, "#ffffff", 0.08),
          mixColor(color, "#05070c", 0.28)
        ];
        ctx.lineWidth = fine;
        for (let i = 0; i < columns; i += 1) {
          const cx = -hl + span * (i + 0.5);
          for (const row of [-1, 1]) {
            const cy = row * hc * 0.5;
            ctx.fillStyle = tileFills[(i + (row > 0 ? 1 : 0)) % tileFills.length];
            ctx.strokeStyle = "rgba(3,6,12,0.6)";
            ctx.beginPath();
            ctx.moveTo(cx - tileW * 0.5 + cut, cy - tileH * 0.5);
            ctx.lineTo(cx + tileW * 0.5 - cut, cy - tileH * 0.5);
            ctx.lineTo(cx + tileW * 0.5, cy - tileH * 0.5 + cut);
            ctx.lineTo(cx + tileW * 0.5, cy + tileH * 0.5 - cut);
            ctx.lineTo(cx + tileW * 0.5 - cut, cy + tileH * 0.5);
            ctx.lineTo(cx - tileW * 0.5 + cut, cy + tileH * 0.5);
            ctx.lineTo(cx - tileW * 0.5, cy + tileH * 0.5 - cut);
            ctx.lineTo(cx - tileW * 0.5, cy - tileH * 0.5 + cut);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
        }

        ctx.fillStyle = "rgba(255,132,52,0.5)";
        ctx.beginPath();
        ctx.moveTo(hl * 0.6, -hc * 0.42);
        ctx.lineTo(hl * 0.95, -hc * 0.1);
        ctx.lineTo(hl * 0.95, hc * 0.1);
        ctx.lineTo(hl * 0.6, hc * 0.42);
        ctx.closePath();
        ctx.fill();
      } else if (!isFrame) {
        // Laminate courses stacked across the width, so the wedge reads as the
        // same plate material as the rest of the armour family.
        const courses = Math.max(4, tilesLong * 2);
        const span = (hl * 2) / courses;
        const fills = [
          mixColor(color, "#ffffff", 0.2),
          mixColor(color, "#ffffff", 0.03),
          mixColor(color, "#05070c", 0.26)
        ];
        ctx.strokeStyle = "rgba(3,6,12,0.6)";
        ctx.lineWidth = fine;
        for (let i = 0; i < courses; i += 1) {
          ctx.fillStyle = fills[i % fills.length];
          roundRect(ctx, { x: -hl + i * span + unit * 0.02, y: -hc, width: span - unit * 0.04, height: hc * 2, radius: unit * 0.05 });
          ctx.fill();
          ctx.stroke();
        }
        if (composite) {
          ctx.strokeStyle = "rgba(255,214,140,0.45)";
          ctx.lineWidth = fine;
          ctx.beginPath();
          for (let i = 0; i < 3; i += 1) {
            const x = -hl * 0.62 + i * hl * 0.52;
            ctx.moveTo(x - hc * 0.7, hc);
            ctx.lineTo(x + hc * 0.7, -hc);
          }
          ctx.stroke();
        }
      }
    };

    const drawEdge = () => {
      if (isFrame) {
        // Truss: flank chords, a centre spar and diagonal web members.
        ctx.strokeStyle = "rgba(8,14,24,0.7)";
        ctx.lineWidth = Math.max(1.2, unit * 0.11);
        ctx.beginPath();
        ctx.moveTo(-hl * 0.92, -hc * 0.78);
        ctx.lineTo(hl * 0.82, -hc * 0.12);
        ctx.moveTo(-hl * 0.92, hc * 0.78);
        ctx.lineTo(hl * 0.82, hc * 0.12);
        ctx.moveTo(-hl * 0.92, 0);
        ctx.lineTo(hl * 0.86, 0);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, unit * 0.075);
        ctx.beginPath();
        const bays = 3;
        for (let i = 0; i < bays; i += 1) {
          const x0 = -hl * 0.9 + (hl * 1.7 * i) / bays;
          const x1 = -hl * 0.9 + (hl * 1.7 * (i + 1)) / bays;
          const t0 = 1 - (x0 + hl) / (hl * 2);
          const t1 = 1 - (x1 + hl) / (hl * 2);
          ctx.moveTo(x0, -hc * 0.78 * t0);
          ctx.lineTo(x1, hc * 0.78 * t1);
          ctx.moveTo(x0, hc * 0.78 * t0);
          ctx.lineTo(x1, -hc * 0.78 * t1);
        }
        ctx.stroke();
        ctx.strokeStyle = "rgba(225,236,250,0.3)";
        ctx.lineWidth = Math.max(0.7, unit * 0.04);
        ctx.beginPath();
        ctx.moveTo(-hl * 0.92, -hc * 0.72);
        ctx.lineTo(hl * 0.8, -hc * 0.1);
        ctx.stroke();
      }

      // Lit leading edges along both angled flanks: the signature of a prow.
      ctx.lineCap = "butt";
      ctx.strokeStyle = isFrame ? "rgba(232,241,255,0.6)" : ablative ? "rgba(255,168,96,0.6)" : "rgba(255,240,214,0.62)";
      ctx.lineWidth = Math.max(1.3, unit * 0.09);
      ctx.beginPath();
      ctx.moveTo(-hl, -hc);
      ctx.lineTo(hl * 0.86, -hc * 0.2);
      ctx.lineTo(hl, -hc * 0.06);
      ctx.moveTo(-hl, hc);
      ctx.lineTo(hl * 0.86, hc * 0.2);
      ctx.lineTo(hl, hc * 0.06);
      ctx.stroke();

      if (isFrame) {
        drawFootprintPort(unit, -hl + unit * 0.34, 0, unit * 0.1, "#d8e2f0");
        drawFootprintPort(unit, hl * 0.62, 0, unit * 0.08, "#d8e2f0");
      } else {
        const rivet = mixColor(color, "#ffffff", 0.55);
        drawFootprintPort(unit, -hl + unit * 0.22, -hc * 0.66, unit * 0.07, rivet);
        drawFootprintPort(unit, -hl + unit * 0.22, hc * 0.66, unit * 0.07, rivet);
        drawFootprintPort(unit, hl * 0.42, 0, unit * 0.07, rivet);
      }
    };

    // Base fill and material are clipped to the rotated prow but drawn in ship
    // axes so plating direction is continuous across the whole ship.
    ctx.save();
    ctx.rotate(rotation);
    outline();
    ctx.clip();
    ctx.rotate(-rotation);
    ctx.fillRect(-hl, -hc, hl * 2, hc * 2);
    drawMaterial();
    ctx.restore();

    // Silhouette, chamfer and hardware rotate with the prow.
    ctx.save();
    ctx.rotate(rotation);
    drawEdge();
    outline();
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = Math.max(0.9, unit * 0.08);
    ctx.stroke();
    ctx.restore();
    return true;
  }

  if (COMMAND_ROLE_ART[type]) {
    drawCommandDeckAssembly(type, unit, tilesLong, tilesCross, hl, hc, color);
    return true;
  }

  return drawGenericFootprintMachine(type, unit, tilesLong, color, hl, hc);
}

// Draws a multi-tile component as one purpose-built object spanning its whole
// footprint, in a canonical frame where +x is "forward" (barrel / long axis)
// and the body is centred on the origin. Shared by the arena ship renderer and
// the designer icon baker so blueprint and in-game visuals match. 1x1 parts
// keep using drawModule(); this only handles the elongated/multi-cell types.
export function drawFootprintComponent({ type, unit, tilesLong, tilesCross, color, trim, drawBase = true, drawDetail = true, visualState = "safed", rotation = 0 }) {
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
  if (drawBase && !type.startsWith("wing") && !type.startsWith("half") && !type.startsWith("longWedge")) {
    drawStaticComponentBase({ type, unit, tilesLong, tilesCross, color, trim });
    ctx.fillStyle = bodyFill;
  }

  if (!drawDetail) {
    ctx.restore();
    return;
  }

  if (drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, bodyColor, hl, hc, visualState, rotation)) {
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
