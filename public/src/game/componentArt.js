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
import "../shared/componentTransform.js";

// Horizontal-mirror factor for a flipped component, from the shared transform
// authority so the art can never mirror on a different axis than the geometry.
const flippedScaleX = (flipped) => globalThis.ComponentTransform.artFlipScaleX(flipped);

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
  "frame", "armor", "compositeArmor", "ablativeArmor", "refractoryArmor",
  "halfFrameDiagonal", "halfArmorDiagonal", "halfCompositeArmorDiagonal",
  "wingFrame", "wingArmor", "wingCompositeArmor",
  "bevelFrame", "bevelArmor", "bevelCompositeArmor",
  "roundedFrame", "roundedArmor", "roundedCompositeArmor",
  "longWedgeFrame", "longWedgeArmor", "longWedgeCompositeArmor",
  "halfAblativeArmorDiagonal", "wingAblativeArmor", "bevelAblativeArmor",
  "roundedAblativeArmor", "longWedgeAblativeArmor",
  "halfRefractoryArmorDiagonal", "wingRefractoryArmor", "bevelRefractoryArmor",
  "roundedRefractoryArmor", "longWedgeRefractoryArmor",
  "lightFrame", "heavyFrame"
]);

// Ablative plating is its own material inside the structural family, so every
// silhouette that has an ablative variant asks this instead of `composite`.
const ABLATIVE_PARTS = new Set([
  "ablativeArmor", "halfAblativeArmorDiagonal", "wingAblativeArmor",
  "bevelAblativeArmor", "roundedAblativeArmor", "longWedgeAblativeArmor"
]);

// Refractory ceramic is a third structural material alongside armour laminate
// and ablative plating; the shared silhouette branches ask this the same way.
const REFRACTORY_PARTS = new Set([
  "refractoryArmor", "halfRefractoryArmorDiagonal", "wingRefractoryArmor",
  "bevelRefractoryArmor", "roundedRefractoryArmor", "longWedgeRefractoryArmor"
]);

// Silhouettes that predate `shapeType` in the balance file, or that can arrive
// from a saved blueprint with no catalogue entry at all. drawModule consults the
// catalogue first and only falls back to this.
const LEGACY_PARTIAL_SHAPE_PARTS = new Set([
  "halfFrameDiagonal", "halfArmorDiagonal", "halfCompositeArmorDiagonal",
  "wingFrame", "wingArmor", "wingCompositeArmor",
  "bevelFrame", "bevelArmor", "bevelCompositeArmor",
  "roundedFrame", "roundedArmor", "roundedCompositeArmor",
  "halfAblativeArmorDiagonal", "wingAblativeArmor",
  "bevelAblativeArmor", "roundedAblativeArmor"
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

// Pushes a colour away from its own grey. Mixing toward white or black : which
// is how every tone in the weapon ramp is derived : bleeds chroma out with it,
// so a violet launcher and a blue emitter both drift toward the same pale
// lavender. Re-saturating after the mix keeps each weapon's own colour reading
// as a colour at small sizes instead of as tinted grey.
function saturate(color, amount) {
  const { r, g, b } = parseColor(color);
  const grey = r * 0.299 + g * 0.587 + b * 0.114;
  const ch = (v) => Math.max(0, Math.min(255, Math.round(grey + (v - grey) * (1 + amount))));
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}

// Re-lights a colour to an explicit HSL lightness, keeping its own hue and
// saturation. Every other tone here is derived by mixing toward white or black,
// which works only while the colour has room left to travel: a channel already
// near its ceiling barely moves, and the re-saturation that follows drags it
// straight back. That is exactly how an amber round ended up the same colour as
// the amber launcher it was sitting on. Setting lightness directly gives the
// same visible step no matter where the component colour starts.
function withLightness(color, lightness) {
  const { r, g, b } = parseColor(color);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = Math.min(1, Math.max(0, lightness));
  const d = max - min;
  if (d === 0) {
    const v = Math.round(l * 255);
    return `rgb(${v},${v},${v})`;
  }
  const l0 = (max + min) / 2;
  const s = l0 > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const to255 = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${to255(channel(h + 1 / 3))},${to255(channel(h))},${to255(channel(h - 1 / 3))})`;
}

function colorLightness(color) {
  const { r, g, b } = parseColor(color);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
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
    // The lit corner still mixes hard toward white for the bevel, but each stop
    // is re-saturated afterwards: without that the top half of every hull cube
    // washed to near-white and the whole grid read as grey with a faint tint.
    fill.addColorStop(0, saturate(mixColor(color, "#ffffff", 0.46), 0.5));
    fill.addColorStop(0.32, saturate(mixColor(color, "#ffffff", 0.12), 0.4));
    fill.addColorStop(0.6, saturate(color, 0.3));
    fill.addColorStop(1, saturate(mixColor(color, "#05070c", 0.74), 0.35));
    ctxCache.set(key, fill);
  }
  return fill;
}

// Weapon bodies (barrels, rounds, rails, emitter shells) used to take a
// cylindrical cross-axis gradient : dark at both edges, bright just above centre
// : which rendered them as modelled tubes sitting on a grid of flat system
// modules. They now take one flat tone and let the dark outline do the
// separating, the same way a capacitor's plates or a heat sink's fins do. The
// gradient caches went with it: a flat fill is a string, so there is nothing to
// rebuild per frame.
//
// This is the one place to reintroduce shading if the whole catalogue ever moves
// to a rounder look; every weapon body routes through here.
function weaponBodyFill(M) {
  return M.shell;
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
  // Kept translucent so the coloured cube beneath still shows through : a
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

// --- Shared power-storage detail ------------------------------------------------
// The Battery and the Capacitor are both "stored charge in a dark case", so they
// share their two building blocks: a stack of cells whose fill reads as level in
// a can, and a plate pair with the charge arcing across its dielectric gap. The
// 1x1 and multi-cell variants call the same helpers at different spans, which is
// what keeps a capacitor bank looking like four of the same capacitor.

// Cells standing in a housing: dark can, electrolyte core graded bright at the
// foot, lit cap. All coordinates are fractions of `unit`.
function drawCellStack(unit, { xs, halfWidth, top, bottom, casing, edge, hot, cool, fine }) {
  const height = (bottom - top) * unit;
  ctx.save();
  for (const cx of xs) {
    const x = cx * unit;
    const w = halfWidth * unit;
    ctx.fillStyle = casing;
    ctx.strokeStyle = edge;
    ctx.lineWidth = fine;
    roundRect(ctx, { x: x - w, y: top * unit, width: w * 2, height, radius: w * 0.55 });
    ctx.fill();
    ctx.stroke();

    // Electrolyte: brightest at the bottom of the can so a row of cells reads as
    // a level, not as a row of identical bars.
    const charge = ctx.createLinearGradient(0, bottom * unit, 0, top * unit);
    charge.addColorStop(0, hot);
    charge.addColorStop(1, cool);
    ctx.fillStyle = charge;
    roundRect(ctx, {
      x: x - w * 0.58,
      y: top * unit + height * 0.12,
      width: w * 1.16,
      height: height * 0.76,
      radius: w * 0.4
    });
    ctx.fill();

    // Contact plate on the terminal end: dark against the electrolyte, so the
    // cells read as having a top rather than fading out into the bus bar.
    ctx.fillStyle = casing;
    roundRect(ctx, { x: x - w * 0.72, y: top * unit + height * 0.04, width: w * 1.44, height: height * 0.11, radius: w * 0.3 });
    ctx.fill();
  }
  ctx.restore();
}

// One plate pair either side of a dielectric gap, with the held charge arcing
// across it. `gapHalf` is the half-width of the gap; the plates hang off it.
function drawCapacitorPlatePair(unit, centerX, gapHalf, halfHeight, fine, plateThickness = unit * 0.17) {
  ctx.save();
  for (const side of [-1, 1]) {
    const inner = centerX + side * gapHalf;
    const outer = inner + side * plateThickness;
    ctx.fillStyle = "#2f6fd0";
    ctx.strokeStyle = "rgba(3,10,24,0.85)";
    ctx.lineWidth = fine;
    roundRect(ctx, {
      x: Math.min(inner, outer),
      y: -halfHeight,
      width: plateThickness,
      height: halfHeight * 2,
      radius: plateThickness * 0.22
    });
    ctx.fill();
    ctx.stroke();
    // Charged face toward the gap.
    ctx.fillStyle = "#dbeafe";
    const faceWidth = plateThickness * 0.26;
    ctx.fillRect(
      side < 0 ? inner - faceWidth : inner,
      -halfHeight * 0.86,
      faceWidth,
      halfHeight * 1.72
    );
  }

  // Discharge arc across the dielectric.
  ctx.shadowColor = "#93c5fd";
  ctx.shadowBlur = qualityShadowBlur(4);
  ctx.strokeStyle = "#eff6ff";
  ctx.lineWidth = Math.max(0.7, unit * 0.035);
  ctx.beginPath();
  const steps = 4;
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = centerX - gapHalf + gapHalf * 2 * t;
    const y = i === 0 || i === steps ? 0 : (i % 2 ? -1 : 1) * halfHeight * 0.34;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

// --- Shared structural material -------------------------------------------------
// The armour family (full cube, bevel, rounded corner, long wedge) is one
// material: three overlapping plate bands, a lit top bevel and : for composite :
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
// at the leading edge : it ablates instead of stopping a shell, and the art has to
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

// Refractory counterpart to the laminate: a ceramic thermal-tile field. Callers
// clip to their own silhouette first, exactly as they do for drawArmorLaminate
// and drawAblativeSpallPlating, so a bevelled refractory plate reads as the same
// material as a full one. Deliberately few, large tiles with a hairline grout:
// at blueprint-icon size a finer mesh collapses into a dark cross.
function drawRefractoryTiles(size, color, fine) {
  ctx.fillStyle = "rgba(10,18,26,0.95)";
  ctx.fillRect(-size * 0.5, -size * 0.5, size, size);

  const tile = size * 0.44;
  const tileFill = mixColor(color, "#ffffff", 0.14);
  ctx.strokeStyle = "rgba(3,8,14,0.75)";
  ctx.lineWidth = Math.max(0.7, size * 0.028);
  // Rows and columns deliberately overrun the cell on every side; the caller's
  // clip trims them, which is what makes the tiling read as continuous material
  // rather than as a motif centred in a box.
  for (let row = -1; row <= 5; row += 1) {
    const oy = -size * 0.5 + row * tile * 0.86;
    const ox = (row % 2 === 0 ? 0 : tile * 0.5) - size * 0.5;
    for (let col = 0; col <= 5; col += 1) {
      const cx = ox + col * tile;
      ctx.beginPath();
      for (let corner = 0; corner < 6; corner += 1) {
        const a = Math.PI / 6 + (Math.PI * corner) / 3;
        const px = cx + Math.cos(a) * tile * 0.5;
        const py = oy + Math.sin(a) * tile * 0.5;
        if (corner === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = tileFill;
      ctx.fill();
      ctx.stroke();
    }
  }

  // Insulating grout, glowing faintly: the heat that gets in stays in the joints
  // instead of reaching anything behind the plate.
  ctx.save();
  ctx.shadowColor = "#bae6fd";
  ctx.shadowBlur = qualityShadowBlur(4);
  ctx.strokeStyle = "rgba(186,230,253,0.35)";
  ctx.lineWidth = Math.max(0.7, fine * 0.7);
  ctx.beginPath();
  ctx.moveTo(-size * 0.5, -size * 0.06); ctx.lineTo(size * 0.5, -size * 0.06);
  ctx.moveTo(-size * 0.5, size * 0.19); ctx.lineTo(size * 0.5, size * 0.19);
  ctx.stroke();
  ctx.restore();
}

// Cool cut face for refractory silhouettes. The ablative family lights its cut
// edge orange because it is burning back; refractory ceramic is doing the
// opposite : holding heat out : so its edge reads as a cold, glazed rim.
function drawRefractoryColdEdge(size, describe) {
  ctx.strokeStyle = "rgba(214,240,255,0.6)";
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
  "aegisProjector", "interceptorPod",
  "scatterCannon", "plasmaCannon", "fragmentationCannon", "spinalAccelerator"
]);

// --- Shared weapon material system --------------------------------------------
//
// System modules (reactor, engine, shield…) all read as one family because they
// are built the same way: the coloured cube carries the part's own colour, a
// recessed panel darkens the working area, and the detail on top is drawn in a
// small ramp derived from that same colour plus one emissive accent.
//
// Weapons used to ignore this: each invented its own palette (a pink barrel on
// a red blaster, lilac rounds on a violet torpedo, teal casings on a blue beam),
// so they read as a different art set dropped into the grid. Every weapon now
// pulls its metals from this ramp instead, which ties each weapon both to its
// own component colour and to the rest of the catalogue.
//
// shell     - lit face of the moving part (barrel, round, emitter body)
// shellDeep - its shaded side, for cross-tube and underside shading
// housing   - breech blocks, collars, cradles, racks: the structure it sits in
// trimLine  - hairline seams and rims on that structure
// bore      - muzzles, apertures, nozzles, tube interiors
// hot       - the single emissive accent per weapon
// munition  - body of a round drawn straight onto the hull cube (see below)
// munitionDeep - that round's warhead cone and casing bands
function weaponMetals(color) {
  const { r, g, b } = parseColor(color);
  // Already-pale parts (the railgun's near-white, for one) have nowhere to go
  // lighter: brightening them further collapses the whole weapon into one grey
  // mass on a grey tile. Those shade downward instead, keeping the same
  // light-body/dark-structure relationship the rest of the family has.
  const pale = (r * 0.299 + g * 0.587 + b * 0.114) / 255 > 0.9;
  // A round drawn onto the bare hull cube needs more separation than `shell`
  // gives it. `shell` is one small step off the component colour, which is
  // plenty inside a recessed dark bay but vanishes against a full-strength hull
  // face of the same colour : the missile's amber body on its amber launcher was
  // invisible, leaving the round reading as a black line drawing. The munition
  // ramp keeps the component hue and forces a fixed lightness step instead:
  // upward for dark and mid hulls, downward for ones already too light to climb
  // (a lighter lilac than the torpedo's would just wash out to white).
  const lightness = colorLightness(color);
  const bodyLight = lightness > 0.72 ? lightness - 0.19 : Math.min(0.78, lightness + 0.19);
  // Re-saturated like the rest of the ramp: setting lightness alone squeezes the
  // chroma out of a colour on its way up, which turned the swarm rack's teal
  // rounds into pale mint.
  const munition = saturate(withLightness(color, bodyLight), 0.35);
  // Warhead cone and casing bands. Measured down from whichever of the hull and
  // the body is darker, so the head separates from both : pinned to the body
  // alone it landed back on the hull's own value on the parts whose round is the
  // lighter of the two.
  const munitionDeep = saturate(
    withLightness(color, Math.max(0.16, Math.min(lightness, bodyLight) - 0.22)),
    0.25
  );
  return {
    shell: pale ? mixColor(color, "#5c6577", 0.4) : saturate(mixColor(color, "#f4f7ff", 0.16), 0.5),
    shellDeep: saturate(mixColor(color, "#05070c", pale ? 0.55 : 0.3), 0.4),
    housing: saturate(mixColor(color, "#05070c", pale ? 0.68 : 0.44), 0.3),
    trimLine: "rgba(226,232,240,0.28)",
    bore: "rgba(4,7,13,0.94)",
    hot: pale ? mixColor(color, "#ffffff", 0.2) : saturate(mixColor(color, "#ffffff", 0.26), 0.75),
    munition,
    munitionDeep
  };
}

// Shared outline weights for weapon art, mirroring the `line`/`fine` pair the
// system modules use. Weapon bodies take `weaponLine`, detail takes `weaponFine`.
function weaponLine(unit) {
  return Math.max(0.8, unit * 0.06);
}

function weaponFine(unit) {
  return Math.max(0.7, unit * 0.04);
}

// Shared mounted-turret base: a dark socket, a flat ring in the module body
// colour, and a recessed hub the barrel emerges from. The ring used to carry its
// own lit/shaded bevel pair on top of the one the hull cube already has, which
// stacked two levels of relief under every gun and was the main reason weapons
// read as modelled objects next to flat system tiles. One hairline rim replaces
// it: enough to separate ring from socket, not enough to dish the mount.
// Fully radially symmetric : it belongs to the STATIC hull, never to the top.
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
  ctx.strokeStyle = "rgba(226,232,240,0.22)";
  ctx.lineWidth = Math.max(0.6, size * 0.03);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(9,14,22,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Autocannon mount: one flat turntable, nothing more. Deliberately simpler
// than drawWeaponBase() : no dark outer socket, no rim, no inner hub : because
// the twin barrels already carry the weapon's identity and a layered housing
// under them turns a basic rapid-fire gun into a boss turret. The octagon is the
// only kinetic cue it needs against the blaster's round socket. Flat-filled: the
// hull cube beneath it is the only thing in a tile that carries a gradient.
function drawSimpleTurntable(size, color) {
  ctx.save();
  ctx.lineJoin = "miter";
  ctx.fillStyle = mixColor(color, "#0b1018", 0.36);
  ctx.strokeStyle = "rgba(3,6,12,0.7)";
  ctx.lineWidth = Math.max(0.7, size * 0.045);
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = Math.PI / 8 + (Math.PI * i) / 4;
    const px = Math.cos(a) * size * 0.36;
    const py = Math.sin(a) * size * 0.36;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// --- Beam family ---------------------------------------------------------------
//
// The beam weapons share a construction language, not a symbol: a power chamber
// at the rear, a narrow energy channel running forward out of it, curved
// focusing arms clamped onto that channel, and a manufactured lens at the tip.
// Each weapon varies the same four parts (chamber size, arm count and sweep,
// channel width, lens shape) instead of recolouring one icon. Two rules hold
// the family together: nothing draws a closed ring around the weapon, and no
// bar crosses the full width of it : both read as UI symbols laid over the
// hull rather than hardware bolted to it.

// One pair of focusing arms: curved brackets hugging the channel, open fore and
// aft, each tied to the channel by a short connector so they read as clamped on.
function drawBeamCollar(unit, hc, cx, radius, thickness, metal, sweep) {
  ctx.save();
  ctx.lineCap = "butt";
  for (const dir of [-1, 1]) {
    // Connector first, so the arm caps it.
    ctx.fillStyle = metal;
    ctx.fillRect(cx - thickness * 0.28, dir * hc * 0.12, thickness * 0.56, dir * (radius - hc * 0.12));
    const from = dir < 0 ? Math.PI * (1.5 - sweep) : Math.PI * (0.5 - sweep);
    const to = dir < 0 ? Math.PI * (1.5 + sweep) : Math.PI * (0.5 + sweep);
    // Dark edge under the arm so it reads as a separate piece of hardware
    // sitting on the body rather than a tint on it.
    ctx.strokeStyle = "rgba(3,6,12,0.75)";
    ctx.lineWidth = thickness + Math.max(1, unit * 0.05);
    ctx.beginPath();
    ctx.arc(cx, 0, radius, from, to);
    ctx.stroke();
    ctx.strokeStyle = metal;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.arc(cx, 0, radius, from, to);
    ctx.stroke();
    // Lit outer rim on the arm.
    ctx.strokeStyle = "rgba(226,232,240,0.3)";
    ctx.lineWidth = Math.max(0.6, unit * 0.025);
    ctx.beginPath();
    ctx.arc(cx, 0, radius + thickness * 0.42, dir < 0 ? Math.PI * (1.5 - sweep) : Math.PI * (0.5 - sweep),
      dir < 0 ? Math.PI * (1.5 + sweep) : Math.PI * (0.5 + sweep));
    ctx.stroke();
  }
  ctx.restore();
}

// The shared beam body. `opts` picks the family member: see the three call
// sites for the blue baseline, the softer green support beam and the heavier
// purple lance.
function drawBeamFamilyTop(unit, hl, hc, color, opts) {
  const { chamberFront, channelHalf, collars, collarR, collarSweep, lens } = opts;
  const M = weaponMetals(color);
  const casing = M.housing;
  const core = mixColor(color, "#05070c", 0.25);
  const accent = mixColor(color, "#ffffff", 0.2);
  const glow = color;
  const pale = M.hot;
  const metal = M.shellDeep;
  // The arms are deliberately lighter than the rest of the body: in dark metal
  // a pair of arcs closes up visually into the old black ring.
  const armMetal = M.shell;
  const fine = weaponFine(unit);

  // Power chamber: broader than the channel it feeds, with a coloured core
  // showing through and a couple of casing seams.
  ctx.fillStyle = casing;
  roundRect(ctx, { x: -hl * 0.94, y: -hc * 0.48, width: hl * 0.94 + chamberFront * hl, height: hc * 0.96, radius: unit * 0.09 });
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.fillStyle = core;
  roundRect(ctx, { x: -hl * 0.82, y: -hc * 0.26, width: hl * 0.78 + chamberFront * hl, height: hc * 0.52, radius: unit * 0.05 });
  ctx.fill();
  ctx.fillStyle = "rgba(3,6,12,0.45)";
  for (const sx of [-hl * 0.6, -hl * 0.34]) {
    ctx.fillRect(sx, -hc * 0.48, Math.max(0.8, unit * 0.035), hc * 0.96);
  }
  ctx.restore();

  // Energy channel forward to the lens.
  ctx.fillStyle = metal;
  roundRect(ctx, {
    x: -hl * 0.3,
    y: -hc * channelHalf,
    width: hl * 0.3 + lens.base * hl,
    height: hc * channelHalf * 2,
    radius: unit * 0.05
  });
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = qualityShadowBlur(5);
  ctx.fillStyle = accent;
  ctx.fillRect(-hl * 0.26, -hc * channelHalf * 0.42, hl * 0.26 + lens.base * hl - unit * 0.04, hc * channelHalf * 0.84);
  ctx.restore();

  // Focusing arms.
  for (const cx of collars) {
    drawBeamCollar(unit, hc, hl * cx, hc * collarR, hc * 0.26, armMetal, collarSweep);
  }

  // Emitter lens: dark shroud, bright face, narrow aperture at the very tip.
  ctx.save();
  ctx.fillStyle = metal;
  ctx.beginPath();
  ctx.moveTo(hl * lens.base, -hc * lens.rootHalf);
  ctx.lineTo(hl * lens.tip, -hc * lens.tipHalf);
  ctx.lineTo(hl * lens.tip, hc * lens.tipHalf);
  ctx.lineTo(hl * lens.base, hc * lens.rootHalf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.shadowColor = glow;
  ctx.shadowBlur = qualityShadowBlur(7);
  if (lens.forked) {
    // Support beam: the aperture is split, so the head never reads as a spike.
    for (const dir of [-1, 1]) {
      ctx.fillStyle = pale;
      ctx.fillRect(hl * (lens.tip - 0.1), dir * hc * lens.tipHalf * 0.9 - hc * lens.tipHalf * 0.42,
        hl * 0.09, hc * lens.tipHalf * 0.84);
    }
  } else {
    ctx.fillStyle = pale;
    ctx.fillRect(hl * (lens.tip - 0.12), -hc * lens.tipHalf * 0.72, hl * 0.11, hc * lens.tipHalf * 1.44);
    ctx.fillStyle = mixColor(pale, "#ffffff", 0.6);
    ctx.fillRect(hl * (lens.tip - 0.04), -hc * lens.tipHalf * 0.4, hl * 0.03, hc * lens.tipHalf * 0.8);
  }
  ctx.restore();

  // Optional containment bands over the shroud (the lance's extra hardware).
  if (lens.bands) {
    ctx.save();
    ctx.strokeStyle = metal;
    ctx.lineWidth = Math.max(fine, unit * 0.055);
    for (const bx of lens.bands) {
      ctx.beginPath();
      ctx.moveTo(hl * bx, -hc * lens.rootHalf * 1.05);
      ctx.lineTo(hl * bx, hc * lens.rootHalf * 1.05);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// One miniature round on a swarm rack, nose toward +x. Deliberately a whole
// little missile : purple body, warm nose, tail fins : because the Swarm Pod
// reads as "carries many small missiles" only if you can actually see the
// missiles. Launch holes, however deep, always read as a panel of dots.
function drawRackMissile(unit, mx, my, len, M) {
  const w = len * 0.15;
  // Drawn around the origin and translated into place. This matters: the shared
  // tube/cone gradients are built in local space around y=0, so a round drawn
  // directly at y = ±lane sampled past both ends of its own shading and filled
  // flat : which is exactly why a rack of them read as printed-on decals.
  const tail = -len * 0.5;
  const nose = len * 0.5;
  const shoulder = len * 0.18;

  ctx.save();
  ctx.translate(mx, my);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(3,6,12,0.75)";
  ctx.lineWidth = Math.max(0.6, unit * 0.03);

  // Contact shadow, so each round sits in the rack rather than printing on it.
  ctx.fillStyle = "rgba(3,6,12,0.55)";
  roundRect(ctx, {
    x: tail,
    y: -w + w * 0.55,
    width: nose - tail,
    height: w * 2,
    radius: w * 0.45
  });
  ctx.fill();

  // Fins, drawn before the body so it overlaps their roots. The upper pair
  // catches the light and the lower pair sits in shadow, which is what tells
  // you the round is a cylinder hanging off a rail rather than a flat tab.
  for (const dir of [-1, 1]) {
    ctx.fillStyle = dir < 0
      ? saturate(mixColor(M.housing, "#ffffff", 0.34), 0.3)
      : mixColor(M.housing, "#05070c", 0.4);
    ctx.beginPath();
    ctx.moveTo(tail + len * 0.18, dir * w);
    ctx.lineTo(tail - len * 0.04, dir * w * 2.2);
    ctx.lineTo(tail - len * 0.04, dir * w);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Body.
  ctx.fillStyle = M.munition;
  roundRect(ctx, { x: tail, y: -w, width: shoulder - tail, height: w * 2, radius: w * 0.4 });
  ctx.fill();
  ctx.stroke();

  // Nose cone: one flat tone a step darker than the body, so the warhead still
  // separates from it without the body reading as a shaded cylinder.
  ctx.fillStyle = M.munitionDeep;
  ctx.beginPath();
  ctx.moveTo(nose, 0);
  ctx.lineTo(shoulder, -w);
  ctx.lineTo(shoulder, w);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Warhead band and motor throat: the two emissive marks that keep a round
  // legible once the whole rack shrinks to a dozen pixels.
  ctx.save();
  ctx.shadowColor = M.hot;
  ctx.shadowBlur = qualityShadowBlur(4);
  ctx.fillStyle = M.hot;
  ctx.fillRect(shoulder - len * 0.06, -w, len * 0.05, w * 2);
  ctx.beginPath();
  ctx.arc(tail + len * 0.03, 0, Math.max(0.7, w * 0.44), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

// The open frame both swarm footprints hang their rounds on: a hollow trough,
// two side rails and one cross bracket per station. The recess is one flat dark
// tone and the rails one flat metal tone : the rounds read against the trough by
// value alone, which is what the system modules do with their recessed bays.
function drawMissileRack(unit, { halfLong, railY, rail, troughHalf, stations, bracketWidth }, M) {
  ctx.save();
  ctx.fillStyle = "rgba(3,6,13,0.55)";
  roundRect(ctx, {
    x: -halfLong,
    y: -troughHalf,
    width: halfLong * 2,
    height: troughHalf * 2,
    radius: unit * 0.08
  });
  ctx.fill();

  ctx.strokeStyle = "rgba(3,6,12,0.7)";
  ctx.lineWidth = weaponFine(unit);
  ctx.fillStyle = M.housing;
  for (const dir of [-1, 1]) {
    const y = dir * railY;
    roundRect(ctx, {
      x: -halfLong,
      y: y - rail * 0.5,
      width: halfLong * 2,
      height: rail,
      radius: rail * 0.5
    });
    ctx.fill();
    ctx.stroke();
  }
  for (const sx of stations) {
    roundRect(ctx, {
      x: sx - bracketWidth * 0.5,
      y: -troughHalf,
      width: bracketWidth,
      height: troughHalf * 2,
      radius: rail * 0.4
    });
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Torpedo cradle: the clamp the round is strapped into, in place of the plain
// bearing ring. The ring is heavy along the cross axis (where a clamp would
// actually grip) and thin through the middle, where the torpedo body covers it
// anyway : a full-weight circle there just read as a painted-on decoration.
// Static hull art, so the clamp blocks stay in the footprint frame.
function drawTorpedoCradle(unit, hl, hc) {
  const r = Math.min(hl, hc) * 0.72;
  ctx.save();
  ctx.fillStyle = "rgba(6,10,16,0.8)";
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.04, 0, Math.PI * 2);
  ctx.fill();

  // Thin bearing ring: still a circle, but it no longer competes with the round.
  ctx.strokeStyle = "rgba(3,6,12,0.4)";
  ctx.lineWidth = Math.max(0.7, unit * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  // The two gripping bands, thick where the clamp closes over the body.
  ctx.strokeStyle = "rgba(4,7,13,0.92)";
  ctx.lineWidth = Math.max(1.2, unit * 0.16);
  ctx.lineCap = "butt";
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.86, dir * Math.PI * 0.18, dir * Math.PI * 0.82, dir < 0);
    ctx.stroke();
  }

  // Connection blocks bolting each band down to the hull.
  ctx.fillStyle = "rgba(9,14,22,0.95)";
  ctx.strokeStyle = "rgba(3,6,12,0.7)";
  ctx.lineWidth = Math.max(0.7, unit * 0.045);
  for (const dir of [-1, 1]) {
    roundRect(ctx, {
      x: -unit * 0.17,
      y: dir * r * 0.86 - unit * 0.09,
      width: unit * 0.34,
      height: unit * 0.18,
      radius: unit * 0.04
    });
    ctx.fill();
    ctx.stroke();
  }
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
    const radius = Math.min(unit * 0.1, hc * 0.22);
    ctx.fillStyle = getModuleGradient(Math.max(hl, hc) * 2, bodyColor);
    roundRect(ctx, {
      x: -hl + edgeInset,
      y: -hc + edgeInset,
      width: hl * 2 - edgeInset * 2,
      height: hc * 2 - edgeInset * 2,
      radius
    });
    ctx.fill();
    ctx.stroke();
    // Same lit top-left / dark bottom-right bevel the 1x1 cube carries, so a
    // multi-cell weapon slab is made of the same metal as every other tile
    // instead of reading as a flat painted panel next to them.
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = Math.max(0.7, unit * 0.045);
    ctx.beginPath();
    ctx.moveTo(-hl + radius, -hc + unit * 0.03);
    ctx.lineTo(hl - radius, -hc + unit * 0.03);
    ctx.moveTo(-hl + unit * 0.03, -hc + radius);
    ctx.lineTo(-hl + unit * 0.03, hc - radius);
    ctx.stroke();
    ctx.strokeStyle = "rgba(3,6,12,0.45)";
    ctx.beginPath();
    ctx.moveTo(-hl + radius, hc - unit * 0.03);
    ctx.lineTo(hl - radius, hc - unit * 0.03);
    ctx.moveTo(hl - unit * 0.03, -hc + radius);
    ctx.lineTo(hl - unit * 0.03, hc - radius);
    ctx.stroke();
    ctx.restore();
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
    if (artType === "railgun") {
      // Same recessed bay as the rest of the catalogue. This used to be a
      // bright machined plate, which left an open-frame weapon sitting on a
      // flat silver slab with nothing behind it to read against. It still gets
      // no bearing ring : an open frame has nowhere to hide one, and a disc in
      // the middle of the bore just reads as a stray circle.
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
    } else if (artType === "torpedo") {
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      drawTorpedoCradle(unit, hl, hc);
    } else if (artType === "swarmMissile") {
      // Pod, not turret: no bearing ring under it. A circular base made the
      // launcher read as a gun mount with a box sitting on top.
      drawFootprintPanel(unit, hl, hc, 0.96, 0.92, 0.08);
      drawFootprintSeams(unit, hl, hc, tilesLong);
    } else if (artType === "spinalAccelerator") {
      // A spinal mount is not a turret: it is a gun the ship is built around.
      // The hull under it carries a long recessed race with heavy cross frames,
      // and deliberately no bearing ring : a disc in the middle of a twelve-cell
      // weapon reads as a decal, exactly as it did on the railgun.
      drawFootprintPanel(unit, hl, hc, 0.96, 0.9, 0.08);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      ctx.save();
      ctx.strokeStyle = "rgba(3,6,12,0.6)";
      ctx.lineWidth = Math.max(1, unit * 0.09);
      ctx.lineCap = "butt";
      for (let frame = 1; frame < tilesLong; frame += 1) {
        const fx = -hl + (hl * 2 * frame) / tilesLong;
        ctx.beginPath();
        ctx.moveTo(fx, -hc * 0.86);
        ctx.lineTo(fx, hc * 0.86);
        ctx.stroke();
      }
      ctx.restore();
    } else if (artType === "beamEmitter" || artType === "repairBeam" || artType === "thermalInductionLance") {
      // The beam family pivots on a low collar, not the wide bearing ring: at
      // this footprint the ring drew a black circle right through the middle of
      // the weapon, which read as a symbol printed on the hull.
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      drawWeaponBase(Math.min(hl, hc) * 0.95);
    } else {
      drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.09);
      drawFootprintSeams(unit, hl, hc, tilesLong);
      // Central bearing ring the gun assembly pivots on.
      drawWeaponBase(Math.min(hl, hc) * 1.7);
    }
    ctx.restore();
    return;
  }

  const size = unit;

  // Every weapon opens with the same recessed bay the system modules use, so a
  // weapon tile is built like a reactor or engine tile: coloured cube, dark
  // inset working area, hardware on top. Weapons used to skip this and paint
  // their socket straight onto the cube, which is a large part of why they read
  // as a different art set in the grid.
  drawRecessedPanel(size, 0.88, 0.88, 0.09);
  ctx.fillStyle = getModuleGradient(unit, color);

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
    drawWeaponBase(size * 0.62);
  } else if (artType === "railgun") {
    drawWeaponBase(size * 0.66);
  } else if (artType === "swarmMissile") {
    // No bearing ring: a launch pod is a block bolted to the hull, and a
    // circular turret base under it made it read as a gun mount.
  } else if (artType === "interceptorPod") {
    drawWeaponBase(size * 0.62);
  } else if (artType === "torpedo") {
    drawWeaponBase(size * 0.6);
  } else if (artType === "aegisProjector") {
    drawWeaponBase(size * 0.62);
  } else if (artType === "autocannon" || artType === "scatterCannon") {
    drawSimpleTurntable(size, color);
  } else {
    // blaster / pointDefense / beamEmitter / repairBeam / unknown
    drawWeaponBase(size * 0.86);
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
  // Concentric pivot mark, not an offset specular blob: the off-centre highlight
  // was reading as a lit sphere sitting on the tile.
  ctx.fillStyle = "rgba(226,232,240,0.22)";
  ctx.beginPath();
  ctx.arc(0, 0, size * r * 0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Aegis projector head: a continuous emitter ring instead of a barrel, so the
// module never reads as a turret. Deliberately rotationally symmetric : the
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
// blocks, sockets, or recessed panels : those are static mount artwork.
export function drawRotatingWeaponTop({ type, unit, tilesLong = 1, tilesCross = 1, color, chargeProgress = 0 }) {
  const artType = componentArtType(type);
  const size = unit;
  const hl = (Math.max(1, tilesLong) * unit) / 2;
  const hc = (Math.max(1, tilesCross) * unit) / 2;
  const multi = tilesLong > 1 || tilesCross > 1;

  const M = weaponMetals(color);

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = weaponLine(unit);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";

  if (multi) {
    drawMultiCellWeaponTop(artType, unit, hl, hc, color, chargeProgress);
    ctx.restore();
    return;
  }

  if (artType === "blaster") {
    // Short, wide straight-sided barrel. Its breech end runs back over the
    // pivot cap so the barrel visibly bolts into the hub instead of ending at
    // the socket ring. Tip sits at TurretRules.MUZZLE_TIP_TILES.blaster.
    // `half` is the only width control here : the muzzle and bore below are all
    // expressed as fractions of it, so the barrel narrows as one piece. `tip` is
    // pinned to TurretRules.MUZZLE_TIP_TILES.blaster and must not move with it.
    const back = -size * 0.15;
    const tip = size * 0.56;
    const half = size * 0.1;
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

    // Barrel in the shared weapon shell tone, shaded across the tube so it
    // reads as rounded rather than a flat tab.
    ctx.save();
    ctx.lineWidth = weaponLine(size);
    ctx.fillStyle = weaponBodyFill(M);
    barrelPath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Muzzle: the shared dark bore with the weapon's one emissive accent inside.
    ctx.save();
    ctx.fillStyle = M.bore;
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
    ctx.fillStyle = M.hot;
    ctx.fillRect(tip - size * 0.08, -half * 0.48, size * 0.04, half * 0.96);
    ctx.restore();
  } else if (artType === "autocannon") {
    // Two chunky gun tubes on a compact mount : the identity is the pair of
    // barrels and their muzzles, so everything else stays out of their way.
    // A short breech bar behind them is the only structure: casings, collars
    // and layered housings turned this into an armoured weapons platform.
    // Tips sit at TurretRules.MUZZLE_TIP_TILES.autocannon (0.62) : shortening
    // the barrels means moving that constant too, or rounds stop leaving the
    // visible muzzle.
    const back = -size * 0.18;
    const tip = size * 0.62;
    const half = size * 0.09;
    const spread = size * 0.17;
    // roundRect() starts a new path, so each barrel must be filled on its own :
    // a single shared fill() would only render the last one.
    const barrelPath = (cy, dy = 0, grow = 0) => {
      roundRect(ctx, {
        x: back - grow,
        y: cy - half - grow + dy,
        width: tip - back + grow * 2,
        height: half * 2 + grow * 2,
        radius: size * 0.032
      });
    };

    // Contact shadow so the barrels sit on the mount instead of floating.
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.45)";
    for (const cy of [-spread, spread]) {
      barrelPath(cy, size * 0.05, size * 0.01);
      ctx.fill();
    }
    ctx.restore();

    // Breech bar: just enough to tie the two tubes together at the back and
    // give the pair a pivot to sit on. Drawn before the barrels so they
    // overlap it and read as running out of it.
    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.78)";
    ctx.lineWidth = weaponFine(size);
    roundRect(ctx, {
      x: back - size * 0.02,
      y: -spread - half,
      width: size * 0.2,
      height: (spread + half) * 2,
      radius: size * 0.04
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    for (const cy of [-spread, spread]) {
      ctx.save();
      ctx.translate(0, cy);
      // Thinner outline than the shared weapon stroke: two tubes this narrow
      // are swallowed by a full-width dark edge at arena zoom.
      ctx.lineWidth = weaponLine(size) * 0.85;
      ctx.fillStyle = weaponBodyFill(M);
      barrelPath(0);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Muzzles: a dark bore cut into each tip with a thin lit rim on its upper
    // inside edge, so both openings read instantly as gun barrels.
    ctx.save();
    for (const cy of [-spread, spread]) {
      ctx.fillStyle = M.bore;
      roundRect(ctx, {
        x: tip - size * 0.1,
        y: cy - half * 0.86,
        width: size * 0.1,
        height: half * 1.72,
        radius: size * 0.022
      });
      ctx.fill();
      ctx.fillStyle = M.hot;
      ctx.fillRect(tip - size * 0.088, cy - half * 0.58, size * 0.062, Math.max(0.7, size * 0.026));
    }
    ctx.restore();
  } else if (artType === "scatterCannon") {
    // Three short, flared tubes splayed outward from a common breech. The splay
    // is the identity: the autocannon's two parallel barrels say "rapid fire",
    // three barrels pointing slightly apart say "one pull, several rounds, wide".
    // Tips sit at TurretRules.MUZZLE_TIP_TILES.scatterCannon (0.54) and the
    // lateral spacing mirrors TurretRules.BARRELS.scatterCannon.spreadTiles.
    const back = -size * 0.16;
    const tip = size * 0.54;
    const half = size * 0.062;
    const lanes = [-size * 0.15, 0, size * 0.15];
    const splay = 0.19; // radians of outward cant on the two flanking tubes

    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.78)";
    ctx.lineWidth = weaponFine(size);
    roundRect(ctx, {
      x: back - size * 0.03,
      y: -size * 0.24,
      width: size * 0.22,
      height: size * 0.48,
      radius: size * 0.05
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    lanes.forEach((cy, index) => {
      const cant = (index - 1) * splay;
      ctx.save();
      ctx.translate(0, cy);
      ctx.rotate(cant);
      ctx.lineWidth = weaponLine(size) * 0.8;
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: back, y: -half, width: tip - back, height: half * 2, radius: size * 0.024 });
      ctx.fill();
      ctx.stroke();
      // Flared choke at the mouth: a cluster gun throws its load, it does not
      // aim it, and the widened tip is what says so at arena zoom.
      ctx.fillStyle = M.shellDeep;
      roundRect(ctx, { x: tip - size * 0.1, y: -half * 1.5, width: size * 0.1, height: half * 3, radius: size * 0.022 });
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = M.bore;
      roundRect(ctx, { x: tip - size * 0.075, y: -half * 1.1, width: size * 0.06, height: half * 2.2, radius: size * 0.016 });
      ctx.fill();
      ctx.restore();
    });
  } else if (artType === "pointDefense") {
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: 0, y: -size * 0.08, width: size * 0.62, height: size * 0.16, radius: size * 0.04 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.bore;
    ctx.fillRect(size * 0.5, -size * 0.06, size * 0.12, size * 0.12);
    ctx.fillStyle = M.hot;
    ctx.fillRect(size * 0.54, -size * 0.025, size * 0.06, size * 0.05);
    ctx.strokeStyle = M.trimLine;
    ctx.lineWidth = weaponFine(size);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, -Math.PI * 0.34, Math.PI * 0.34);
    ctx.stroke();
    drawTurretCap(size, color, 0.14);
  } else if (artType === "flakCannon") {
    ctx.lineWidth = weaponLine(size) * 0.8;
    for (const cy of [-size * 0.22, size * 0.22]) {
      ctx.save();
      ctx.translate(0, cy);
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: size * 0.01, y: -size * 0.06, width: size * 0.44, height: size * 0.12, radius: size * 0.02 });
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = M.bore;
      ctx.fillRect(size * 0.37, -size * 0.05, size * 0.08, size * 0.1);
      ctx.restore();
    }
    ctx.lineWidth = weaponLine(size);
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
    // TurretRules.MUZZLE_TIP_TILES.missile (0.4) : keep the two in sync.
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
    ctx.fillStyle = M.housing;
    ctx.lineWidth = weaponFine(size);
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

    // Thinner outline than the shared weapon stroke, kept in scope through the
    // warhead so the body and the cone re-stroke stay the same weight.
    ctx.save();
    ctx.lineWidth = weaponLine(size);
    ctx.fillStyle = M.munition;
    bodyPath();
    ctx.fill();
    ctx.stroke();

    // The whole warhead cone is tinted, not just its tip, so the head reads as
    // a separate section at a glance. A seam band marks where it joins the body.
    ctx.save();
    ctx.fillStyle = M.munitionDeep;
    ctx.beginPath();
    ctx.moveTo(nose, 0);
    ctx.lineTo(shoulder, -half);
    ctx.lineTo(shoulder, half);
    ctx.closePath();
    ctx.fill();
    // Re-stroke the cone edges the tint just covered, so the head keeps a crisp
    // outline against a purple hull.
    ctx.stroke();
    ctx.fillStyle = "rgba(3,6,12,0.45)";
    ctx.fillRect(shoulder - size * 0.03, -half, size * 0.035, half * 2);
    ctx.restore();
    ctx.restore();
  } else if (artType === "railgun") {
    ctx.strokeStyle = M.shell;
    ctx.lineWidth = Math.max(1.2, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(-size * 0.04, -size * 0.16);
    ctx.lineTo(size * 0.68, -size * 0.16);
    ctx.moveTo(-size * 0.04, size * 0.16);
    ctx.lineTo(size * 0.68, size * 0.16);
    ctx.stroke();
    ctx.fillStyle = M.hot;
    ctx.fillRect(size * 0.42, -size * 0.06, size * 0.16, size * 0.12);
    drawTurretCap(size, color, 0.15);
  } else if (artType === "swarmMissile") {
    // Same exposed rack as the multi-cell pod, squeezed into one tile: an open
    // frame carrying four visible miniature missiles in two pairs. No launch
    // holes and no turret ring : the rounds are the identity.
    const lane = size * 0.2;
    const len = size * 0.42;
    const rail = Math.max(1, size * 0.05);
    const stations = [-size * 0.22, size * 0.22];

    drawMissileRack(size, {
      halfLong: size * 0.46,
      railY: lane + size * 0.13,
      rail,
      troughHalf: lane + size * 0.15,
      stations,
      bracketWidth: len * 0.24
    }, M);

    for (const sx of stations) {
      for (const dir of [-1, 1]) {
        drawRackMissile(size, sx, dir * lane, len, M);
      }
    }
  } else if (artType === "torpedo") {
    ctx.fillStyle = M.munition;
    ctx.beginPath();
    ctx.moveTo(-size * 0.12, -size * 0.24);
    ctx.lineTo(size * 0.46, -size * 0.24);
    ctx.lineTo(size * 0.72, 0);
    ctx.lineTo(size * 0.46, size * 0.24);
    ctx.lineTo(-size * 0.12, size * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = M.munitionDeep;
    ctx.lineWidth = weaponFine(size);
    ctx.beginPath();
    ctx.moveTo(size * 0.08, -size * 0.24);
    ctx.lineTo(size * 0.08, size * 0.24);
    ctx.stroke();
  } else if (artType === "beamEmitter" || artType === "repairBeam") {
    const repair = artType === "repairBeam";
    ctx.fillStyle = M.housing;
    ctx.fillRect(-size * 0.08, -size * 0.16, size * 0.3, size * 0.32);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = M.hot;
    ctx.beginPath();
    ctx.moveTo(size * 0.22, -size * 0.18);
    ctx.lineTo(size * 0.66, 0);
    ctx.lineTo(size * 0.22, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (repair) {
      ctx.fillStyle = M.trimLine;
      ctx.fillRect(-size * 0.05, -size * 0.03, size * 0.2, size * 0.06);
      ctx.fillRect(size * 0.01, -size * 0.1, size * 0.06, size * 0.2);
    }
    drawTurretCap(size, color, 0.13);
  } else if (artType === "thermalInductionLance") {
    // Single-cell fallback for the same coil-wound lance the 1x2 footprint draws.
    ctx.fillStyle = M.shellDeep;
    roundRect(ctx, { x: -size * 0.04, y: -size * 0.1, width: size * 0.6, height: size * 0.2, radius: size * 0.05 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = M.shell;
    ctx.lineWidth = weaponLine(size);
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
    // Three-cell interceptor launcher: a boxed magazine with three tubes running
    // forward, each holding a round whose nose sits at the tube mouth. This was
    // three bare dark bars with a dot on the end of each, which read as a vent
    // rather than a weapon and shared no construction with the other launchers.
    const back = -size * 0.32;
    const mouth = size * 0.36;
    const half = size * 0.085;
    const rows = [-size * 0.21, 0, size * 0.21];

    ctx.fillStyle = M.housing;
    ctx.lineWidth = weaponLine(size);
    roundRect(ctx, { x: back, y: -size * 0.33, width: mouth - back + size * 0.03, height: size * 0.66, radius: size * 0.06 });
    ctx.fill();
    ctx.stroke();

    ctx.lineWidth = weaponFine(size);
    for (const cy of rows) {
      ctx.save();
      ctx.translate(0, cy);
      // Tube bore, open at the front.
      ctx.fillStyle = M.bore;
      roundRect(ctx, { x: back + size * 0.04, y: -half, width: mouth - back - size * 0.02, height: half * 2, radius: size * 0.02 });
      ctx.fill();
      // Loaded round: flat body, darker nose cone, seated with the nose at the
      // mouth so a loaded pod is distinguishable from an empty rack.
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: back + size * 0.09, y: -half * 0.6, width: size * 0.47, height: half * 1.2, radius: size * 0.015 });
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = M.shellDeep;
      ctx.beginPath();
      ctx.moveTo(mouth - size * 0.01, 0);
      ctx.lineTo(mouth - size * 0.11, -half * 0.6);
      ctx.lineTo(mouth - size * 0.11, half * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Seeker heads: the pod's one emissive mark, repeated once per loaded round.
    ctx.fillStyle = M.hot;
    for (const cy of rows) {
      ctx.beginPath();
      ctx.arc(mouth - size * 0.05, cy, Math.max(0.7, size * 0.026), 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Unknown rotating weapon: generic barrel to the shared default muzzle tip.
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: size * 0.02, y: -size * 0.11, width: size * 0.58, height: size * 0.22, radius: size * 0.06 });
    ctx.fill();
    drawTurretCap(size, color);
  }
  ctx.restore();
}

// Elongated rotating gun assemblies for multi-cell footprints. The whole
// assembly (breech + barrel/rails + muzzle) rotates as one piece around the
// footprint centre; the footprint slab and panel stay on the hull.
// --- Spinal accelerator -------------------------------------------------------
//
// The Spinal Accelerator's whole balance case is its telegraph: the shot is
// allowed to be enormous because an opponent gets ten seconds of unmistakable
// warning on the hull itself, not in a UI panel. So the art is authored as a
// function of charge progress rather than as one static picture:
//
//   * a rear capacitor chamber that lights first,
//   * a run of accelerator coils that illuminate in sequence toward the muzzle,
//   * a muzzle assembly that goes white-hot only in the last stage.
//
// Progress is quantised into SPINAL_CHARGE_STAGES so the renderer can bake one
// texture per stage instead of per frame; the stage boundaries are the only
// place that quantisation exists.
export const SPINAL_CHARGE_STAGES = 8;

export function spinalChargeStage(progress) {
  const value = Number(progress);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(SPINAL_CHARGE_STAGES - 1, Math.round(Math.min(1, value) * (SPINAL_CHARGE_STAGES - 1)));
}

function drawSpinalAcceleratorTop(unit, hl, hc, color, M, fine, chargeProgress = 0) {
  const progress = Math.max(0, Math.min(1, Number(chargeProgress) || 0));
  M = {
    ...M,
    housing: mixColor(M.housing, "#05070c", 0.25),
    shellDeep: mixColor(M.shellDeep, "#05070c", 0.25),
    shell: mixColor(M.shell, "#05070c", 0.25)
  };
  const coils = 6;
  const chamberBack = -hl * 0.97;
  const chamberFront = -hl * 0.58;
  const muzzleBack = hl * 0.7;
  const railFrom = chamberFront;
  const railTo = muzzleBack;

  // Spine: the accelerator body itself, one continuous machined block.
  ctx.fillStyle = M.housing;
  roundRect(ctx, { x: chamberBack, y: -hc * 0.66, width: hl * 1.94, height: hc * 1.32, radius: unit * 0.1 });
  ctx.fill();
  ctx.stroke();

  // Capacitor chamber at the rear. It fills first and stays lit: this is the
  // energy the coils are pulling from.
  const chamberFill = Math.min(1, progress / 0.25);
  ctx.fillStyle = M.shellDeep;
  roundRect(ctx, { x: chamberBack + unit * 0.06, y: -hc * 0.5, width: chamberFront - chamberBack - unit * 0.12, height: hc, radius: unit * 0.07 });
  ctx.fill();
  ctx.stroke();
  if (chamberFill > 0) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(6 + 8 * chamberFill);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.25 + 0.5 * chamberFill);
    const innerW = (chamberFront - chamberBack - unit * 0.26) * chamberFill;
    ctx.fillRect(chamberBack + unit * 0.13, -hc * 0.3, Math.max(unit * 0.05, innerW), hc * 0.6);
    ctx.restore();
  }

  // Twin accelerator rails running the length of the weapon, with the coils
  // clamped across them.
  const railY = hc * 0.42;
  const railHalf = Math.max(0.9, unit * 0.05);
  ctx.save();
  ctx.fillStyle = weaponBodyFill(M);
  for (const ry of [-railY, railY]) {
    roundRect(ctx, { x: railFrom, y: ry - railHalf, width: railTo - railFrom, height: railHalf * 2, radius: railHalf * 0.6 });
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // Coils illuminate in sequence. Each owns an equal slice of the 0.2..1.0 band
  // so the travelling glow starts once the chamber has something to give.
  for (let coil = 0; coil < coils; coil += 1) {
    const cx = railFrom + ((railTo - railFrom) * (coil + 0.5)) / coils;
    const bandFrom = 0.2 + (0.75 * coil) / coils;
    const bandTo = 0.2 + (0.75 * (coil + 1)) / coils;
    const lit = Math.max(0, Math.min(1, (progress - bandFrom) / Math.max(1e-6, bandTo - bandFrom)));

    ctx.save();
    ctx.fillStyle = M.shellDeep;
    roundRect(ctx, { x: cx - unit * 0.07, y: -hc * 0.62, width: unit * 0.14, height: hc * 1.24, radius: unit * 0.035 });
    ctx.fill();
    ctx.stroke();
    if (lit > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = qualityShadowBlur(3 + 9 * lit);
      // Coils that have already fired stay warm; the one currently charging is
      // the brightest thing on the weapon, which is what the eye tracks.
      ctx.fillStyle = mixColor(color, "#ffffff", 0.2 + 0.6 * lit);
      ctx.fillRect(cx - unit * 0.035, -hc * 0.5, unit * 0.07, hc);
    }
    ctx.restore();
  }

  // Bore between the rails, brightening along its charged length.
  if (progress > 0.2) {
    ctx.save();
    const boreReach = Math.min(1, (progress - 0.2) / 0.75);
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(4 + 10 * boreReach);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.35 + 0.5 * boreReach);
    ctx.fillRect(railFrom, -unit * 0.04, (railTo - railFrom) * boreReach, unit * 0.08);
    ctx.restore();
  }

  // Muzzle assembly: heavy shroud, then a white-hot mouth in the final stage.
  ctx.fillStyle = M.shellDeep;
  roundRect(ctx, { x: muzzleBack, y: -hc * 0.74, width: hl * 0.97 - muzzleBack, height: hc * 1.48, radius: unit * 0.06 });
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.strokeStyle = M.trimLine;
  ctx.lineWidth = Math.max(fine, unit * 0.05);
  for (const bx of [muzzleBack + unit * 0.12, muzzleBack + unit * 0.26]) {
    ctx.beginPath();
    ctx.moveTo(bx, -hc * 0.7);
    ctx.lineTo(bx, hc * 0.7);
    ctx.stroke();
  }
  ctx.restore();

  const muzzleHeat = Math.max(0, Math.min(1, (progress - 0.8) / 0.2));
  ctx.save();
  ctx.fillStyle = M.bore;
  roundRect(ctx, { x: hl * 0.86, y: -hc * 0.34, width: unit * 0.16, height: hc * 0.68, radius: unit * 0.04 });
  ctx.fill();
  if (muzzleHeat > 0) {
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = qualityShadowBlur(6 + 16 * muzzleHeat);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.4 + 0.6 * muzzleHeat);
    ctx.fillRect(hl * 0.88, -hc * 0.26 * (0.4 + 0.6 * muzzleHeat), unit * 0.12, hc * 0.52 * (0.4 + 0.6 * muzzleHeat));
  }
  ctx.restore();
}

function drawMultiCellWeaponTop(artType, unit, hl, hc, color, chargeProgress = 0) {
  const fine = weaponFine(unit);
  const M = weaponMetals(color);

  if (artType === "railgun") {
    // Two rails, an open gap between them, a compact breech and a muzzle
    // bridge. Every extra mechanism tried here (inner cage, paired clamps,
    // rail-end brackets, machined rail bodies, feed ports) pushed it toward
    // reading as a capital-class spinal mount, so the empty space is
    // load-bearing: keep it empty.
    const railY = hc * 0.54;
    const railBack = -hl + unit * 0.44;
    const railFront = hl - unit * 0.2;

    // 1. The open gap, filled flush between the rails with no border of its own.
    ctx.save();
    ctx.fillStyle = "rgba(6,10,18,0.58)";
    ctx.fillRect(railBack, -railY, railFront - railBack, railY * 2);
    ctx.restore();

    // 2. Compact breech at the rear: the only heavy mass on the weapon.
    ctx.fillStyle = M.housing;
    roundRect(ctx, {
      x: -hl + unit * 0.07,
      y: -hc * 0.6,
      width: unit * 0.4,
      height: hc * 1.2,
      radius: unit * 0.07
    });
    ctx.fill();
    ctx.stroke();
    // Charge slot recessed into the breech: on a pale weapon the accent needs
    // a dark surround or it disappears into the body.
    ctx.fillStyle = M.bore;
    ctx.fillRect(-hl + unit * 0.15, -hc * 0.34, unit * 0.2, hc * 0.68);
    ctx.save();
    ctx.shadowColor = mixColor(color, "#7dd3fc", 0.5);
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.45);
    ctx.fillRect(-hl + unit * 0.18, -hc * 0.26, unit * 0.14, hc * 0.52);
    ctx.restore();

    // 3. The rails: two continuous bars running almost the full length. Drawn
    //    as shaded tubes with a contact shadow rather than flat strokes : flat
    //    bars on a flat bed plate were what made this weapon read as a decal.
    const railHalf = Math.max(0.8, unit * 0.055);
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.45)";
    for (const ry of [-railY, railY]) {
      roundRect(ctx, { x: railBack, y: ry - railHalf + unit * 0.035, width: railFront - railBack, height: railHalf * 2, radius: railHalf * 0.6 });
      ctx.fill();
    }
    ctx.lineWidth = weaponFine(unit);
    for (const ry of [-railY, railY]) {
      ctx.save();
      ctx.translate(0, ry);
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: railBack, y: -railHalf, width: railFront - railBack, height: railHalf * 2, radius: railHalf * 0.6 });
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // A single brace tying the rails together.
    ctx.fillStyle = M.housing;
    roundRect(ctx, {
      x: -unit * 0.54,
      y: -railY,
      width: unit * 0.09,
      height: railY * 2,
      radius: unit * 0.02
    });
    ctx.fill();
    ctx.stroke();

    // 4. Muzzle bridge: one bar spanning the rail tips, marking the exit.
    ctx.fillStyle = M.shell;
    roundRect(ctx, {
      x: hl - unit * 0.24,
      y: -railY - unit * 0.05,
      width: unit * 0.13,
      height: railY * 2 + unit * 0.1,
      radius: unit * 0.035
    });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.bore;
    ctx.fillRect(hl - unit * 0.215, -railY * 0.5, unit * 0.08, railY);
  } else if (artType === "plasmaCannon") {
    // A containment weapon, not a gun: a bottle at the breech holding the charge,
    // a short wide throat, and a flared magnetic nozzle. Deliberately built from
    // the beam family's language (chamber -> channel -> aperture) rather than the
    // ballistic one, because what leaves it is contained plasma, but it keeps a
    // solid muzzle mouth so it never reads as an emitter.
    const bottleFront = -hl * 0.18;

    ctx.fillStyle = M.housing;
    roundRect(ctx, { x: -hl * 0.96, y: -hc * 0.56, width: bottleFront + hl * 0.96, height: hc * 1.12, radius: unit * 0.1 });
    ctx.fill();
    ctx.stroke();

    // Charge visible through the bottle wall.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = M.hot;
    roundRect(ctx, { x: -hl * 0.8, y: -hc * 0.28, width: (bottleFront + hl * 0.8) * 0.82, height: hc * 0.56, radius: unit * 0.06 });
    ctx.fill();
    ctx.restore();

    // Containment rings clamped over the bottle.
    ctx.save();
    ctx.strokeStyle = M.shellDeep;
    ctx.lineWidth = Math.max(fine, unit * 0.075);
    for (const rx of [-hl * 0.62, -hl * 0.36]) {
      ctx.beginPath();
      ctx.moveTo(rx, -hc * 0.6);
      ctx.lineTo(rx, hc * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // Throat forward to the nozzle.
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: bottleFront, y: -hc * 0.24, width: hl * 0.82 - bottleFront, height: hc * 0.48, radius: unit * 0.05 });
    ctx.fill();
    ctx.stroke();

    // Flared magnetic nozzle with a hot mouth.
    ctx.fillStyle = M.shellDeep;
    ctx.beginPath();
    ctx.moveTo(hl * 0.7, -hc * 0.3);
    ctx.lineTo(hl * 0.96, -hc * 0.56);
    ctx.lineTo(hl * 0.96, hc * 0.56);
    ctx.lineTo(hl * 0.7, hc * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(8);
    ctx.fillStyle = M.hot;
    ctx.fillRect(hl * 0.88, -hc * 0.34, unit * 0.09, hc * 0.68);
    ctx.restore();
  } else if (artType === "fragmentationCannon") {
    // A shell gun: heavy squat barrel, a visible autoloader drum on one flank,
    // and a stepped muzzle brake. The drum is what separates it from the plain
    // blaster silhouette : you can see it feeds rounds rather than energy.
    const back = -hl * 0.86;
    const tip = hl * 0.92;

    // Autoloader drum, drawn first so the barrel overlaps its root.
    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.75)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(-hl * 0.5, hc * 0.34, Math.min(hc * 0.5, unit * 0.36), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.munitionDeep;
    for (let round = 0; round < 5; round += 1) {
      const a = (Math.PI * 2 * round) / 5;
      ctx.beginPath();
      ctx.arc(-hl * 0.5 + Math.cos(a) * unit * 0.19, hc * 0.34 + Math.sin(a) * unit * 0.19, Math.max(0.9, unit * 0.055), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Breech block and barrel.
    ctx.fillStyle = M.housing;
    roundRect(ctx, { x: back, y: -hc * 0.52, width: hl * 0.44, height: hc * 1.04, radius: unit * 0.07 });
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: back + hl * 0.2, y: -hc * 0.26, width: tip - back - hl * 0.2, height: hc * 0.52, radius: unit * 0.05 });
    ctx.fill();
    ctx.stroke();

    // Stepped muzzle brake: two vents cut through the barrel wall near the mouth.
    ctx.save();
    ctx.fillStyle = "rgba(4,7,13,0.7)";
    for (const vx of [hl * 0.44, hl * 0.62]) {
      ctx.fillRect(vx, -hc * 0.3, unit * 0.07, hc * 0.6);
    }
    ctx.restore();
    ctx.fillStyle = M.shellDeep;
    roundRect(ctx, { x: tip - unit * 0.16, y: -hc * 0.38, width: unit * 0.16, height: hc * 0.76, radius: unit * 0.04 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.bore;
    ctx.fillRect(tip - unit * 0.12, -hc * 0.2, unit * 0.1, hc * 0.4);
  } else if (artType === "spinalAccelerator") {
    drawSpinalAcceleratorTop(unit, hl, hc, color, M, fine, chargeProgress);
  } else if (artType === "beamEmitter") {
    // The family baseline: compact chamber, one pair of focusing arms, a
    // straight channel and a narrow blue-white lens. Everything else in the
    // family is a variation on these proportions.
    drawBeamFamilyTop(unit, hl, hc, color, {
      chamberFront: 0.06,
      channelHalf: 0.2,
      collars: [0.16],
      collarR: 0.46,
      collarSweep: 0.2,
      lens: { base: 0.52, tip: 0.95, rootHalf: 0.34, tipHalf: 0.17 }
    });
  } else if (artType === "repairBeam") {
    // Support variant: slimmer channel, arms opened out, and a split aperture
    // so the head reads as controlled emission rather than a weapon point.
    drawBeamFamilyTop(unit, hl, hc, color, {
      chamberFront: 0.02,
      channelHalf: 0.15,
      collars: [0.14],
      collarR: 0.48,
      collarSweep: 0.15,
      lens: { base: 0.5, tip: 0.93, rootHalf: 0.3, tipHalf: 0.24, forked: true }
    });
  } else if (artType === "thermalInductionLance") {
    // Heavy variant: a longer heat chamber, two pairs of containment arms with
    // a tighter sweep, and containment bands over a white-hot shroud. Clearly
    // the same construction as the Beam Emitter, built for something less
    // stable : it couples heat rather than cutting.
    drawBeamFamilyTop(unit, hl, hc, color, {
      chamberFront: 0.16,
      channelHalf: 0.22,
      collars: [0.02, 0.34],
      collarR: 0.5,
      collarSweep: 0.26,
      lens: { base: 0.56, tip: 0.95, rootHalf: 0.38, tipHalf: 0.19, bands: [0.66, 0.8] }
    });
    // Small warm accent in the heat chamber: the one thing on the family that
    // says this member runs hot.
    ctx.save();
    ctx.fillStyle = M.hot;
    ctx.fillRect(-hl * 0.78, -hc * 0.1, unit * 0.12, hc * 0.2);
    ctx.restore();
  } else if (artType === "torpedo") {
    // The loaded torpedo (finned tail, banded body, glowing warhead) rotates;
    // the launch trough stays on the hull as part of the mount. The stern is
    // cut flat around an engine nozzle so the tail can never be misread as a
    // second nose : front and rear have to be unambiguous on a round this long.
    const stern = -hl * 0.72;

    // Fins first, so the body overlaps their roots and they read as structure
    // bolted to the casing rather than spikes floating off the silhouette.
    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.7)";
    ctx.lineWidth = fine;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl * 0.3, dir * hc * 0.34);
      ctx.lineTo(-hl * 0.58, dir * hc * 0.58);
      ctx.lineTo(stern, dir * hc * 0.58);
      ctx.lineTo(stern, dir * hc * 0.34);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = M.munition;
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0);
    ctx.lineTo(hl * 0.56, -hc * 0.34);
    ctx.lineTo(-hl * 0.62, -hc * 0.34);
    ctx.lineTo(stern, -hc * 0.19);
    ctx.lineTo(stern, hc * 0.19);
    ctx.lineTo(-hl * 0.62, hc * 0.34);
    ctx.lineTo(hl * 0.56, hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Casing joints: a raised band with a lit forward edge and a shadow behind
    // it, so the segmentation reads as structure instead of paint. The forward
    // joint is the narrower of the two.
    ctx.save();
    for (const [bx, bw] of [[-hl * 0.32, unit * 0.13], [hl * 0.06, unit * 0.09]]) {
      ctx.fillStyle = M.munitionDeep;
      ctx.fillRect(bx - bw * 0.5, -hc * 0.34, bw, hc * 0.68);
      ctx.fillStyle = M.trimLine;
      ctx.fillRect(bx + bw * 0.5 - fine, -hc * 0.34, fine, hc * 0.68);
      ctx.fillStyle = "rgba(3,6,12,0.42)";
      ctx.fillRect(bx - bw * 0.5 - fine, -hc * 0.34, fine, hc * 0.68);
    }
    ctx.restore();

    // Engine nozzle in the flat stern, with a contained warm glow : heat in the
    // bell, deliberately no exhaust plume (the round is sitting in its cradle).
    ctx.save();
    ctx.fillStyle = M.bore;
    roundRect(ctx, {
      x: stern - unit * 0.05,
      y: -hc * 0.19,
      width: unit * 0.14,
      height: hc * 0.38,
      radius: unit * 0.03
    });
    ctx.fill();
    ctx.shadowColor = M.hot;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = M.hot;
    ctx.fillRect(stern - unit * 0.005, -hc * 0.08, unit * 0.04, hc * 0.16);
    ctx.restore();

    // Guidance band below the warhead: the one warm accent on the round, so it
    // still ties into the guided-weapon palette without lightening the body.
    ctx.fillStyle = M.trimLine;
    ctx.fillRect(hl * 0.47, -hc * 0.31, unit * 0.055, hc * 0.62);

    ctx.save();
    ctx.shadowColor = M.hot;
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = M.hot;
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0);
    ctx.lineTo(hl * 0.6, -hc * 0.24);
    ctx.lineTo(hl * 0.6, hc * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (artType === "swarmMissile") {
    // Exposed rack, not an enclosed pod: a light open frame carrying four
    // visible miniature missiles in two separated pairs. The rounds themselves
    // are the identity, so the structure stays to two rails and two cross
    // brackets : anything heavier starts hiding the ammunition it carries.
    const pairs = Math.max(2, Math.round((hl * 2) / unit));
    const lane = hc * 0.4;
    const len = Math.min(unit * 0.62, (hl * 1.8) / pairs * 0.92);
    const rail = Math.max(1, unit * 0.055);
    const stations = [];
    for (let p = 0; p < pairs; p += 1) {
      stations.push(-hl * 0.9 + (hl * 1.8 * (p + 0.5)) / pairs);
    }

    // Shadow trough, side rails and one cross bracket per pair: without a dark
    // hollow behind them, four pale rounds on a pale tile have nothing to read
    // against and the whole pod goes flat.
    drawMissileRack(unit, {
      halfLong: hl * 0.94,
      railY: lane + hc * 0.26,
      rail,
      troughHalf: lane + hc * 0.3,
      stations,
      bracketWidth: len * 0.24
    }, M);

    // The rounds: two per station, hung either side of the rack centreline.
    for (const sx of stations) {
      for (const dir of [-1, 1]) {
        drawRackMissile(unit, sx, dir * lane, len, M);
      }
    }
  } else if (artType === "aegisProjector") {
    // Same emitter ring as the single-cell head, scaled to the footprint: no
    // barrel, so a multi-cell projector never reads as a gun.
    drawAegisEmitterRing(unit, Math.min(hl, hc) * 0.82);
  } else {
    // Generic elongated barrel out to the forward footprint edge.
    ctx.fillStyle = weaponBodyFill(M);
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
function withRotatedShape(size, rotation, outline, drawMaterial, drawEdge, flipped = false) {
  const shapeAngle = moduleRotationToRadians(normalizeRotation(rotation));
  // Mirror first, rotation second (ComponentTransform.TRANSFORM_ORDER). Canvas
  // applies transforms to geometry in reverse call order, so scale() goes after
  // rotate().
  const flipX = flippedScaleX(flipped);
  // Getting from the mirrored+rotated frame back to the mirrored-only frame is
  // rotate(-angle) normally, but rotate(+angle) once mirrored: a reflection
  // conjugates a rotation into its inverse. The material is drawn there, so
  // plating direction stays in ship-local axes (unchanged by rotation) while
  // still mirroring with the part.
  const materialUnrotate = -shapeAngle * flipX;

  ctx.save();
  ctx.rotate(shapeAngle);
  ctx.scale(flipX, 1);
  outline();
  ctx.clip();
  ctx.rotate(materialUnrotate);
  ctx.fillRect(-size * 0.5, -size * 0.5, size, size);
  drawMaterial();
  ctx.restore();

  ctx.save();
  ctx.rotate(shapeAngle);
  ctx.scale(flipX, 1);
  drawEdge();
  outline();
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.lineWidth = Math.max(0.9, size * 0.08);
  ctx.stroke();
  ctx.restore();
}

// --- Propulsion family vocabulary -----------------------------------------------
// Every part in the Engines category is built from these four pieces so the whole
// group reads as one manufacturer's hardware: a dark gunmetal casing, a ribbed
// thrust chamber, a bell nozzle, and mount hardware. Cyan is reserved for the
// things that are actually hot : the throat and the feed spine : because when the
// body itself was cyan the colour did all the identifying work and the shapes
// could just as easily have been sensors or reactors.
//
// Everything below is authored in the canonical +x-forward frame, so a nozzle
// always opens toward -x and the mount always sits at +x. Coordinates are raw
// canvas units; `unit` only sets stroke weights, which lets the single-cell
// (`size`) and footprint (`unit`) paths share the same primitives.

// Dark machined housing over the coloured cube. The cube is deliberately left
// showing as a rim: part colour still identifies the module in the palette, but
// the object itself is metal.
function drawPropulsionCasing(unit, halfLong, halfCross, color, radius = unit * 0.11) {
  ctx.save();
  ctx.fillStyle = mixColor(color, "#05070c", 0.7);
  ctx.strokeStyle = "rgba(2,5,10,0.85)";
  ctx.lineWidth = Math.max(0.9, unit * 0.055);
  roundRect(ctx, { x: -halfLong, y: -halfCross, width: halfLong * 2, height: halfCross * 2, radius });
  ctx.fill();
  ctx.stroke();
  // Lit top edge and shaded bottom edge: the shared bevel that makes the family
  // read as the same milled alloy as the rest of the catalogue.
  ctx.lineCap = "butt";
  ctx.strokeStyle = mixColor(color, "#ffffff", 0.6);
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(0.7, unit * 0.035);
  ctx.beginPath();
  ctx.moveTo(-halfLong + radius, -halfCross + unit * 0.03);
  ctx.lineTo(halfLong - radius, -halfCross + unit * 0.03);
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "rgba(2,5,10,0.9)";
  ctx.beginPath();
  ctx.moveTo(-halfLong + radius, halfCross - unit * 0.03);
  ctx.lineTo(halfLong - radius, halfCross - unit * 0.03);
  ctx.stroke();
  ctx.restore();
}

// Ribbed pressure chamber: the "machinery" half of the propulsion read. Segment
// ribs run across the thrust axis and a lit feed spine runs along it, so the
// chamber visibly pipes energy toward the throat behind it.
function drawThrustChamber(unit, fromX, toX, halfCross, color, ribs = 3) {
  const span = toX - fromX;
  if (span <= 0) return;
  ctx.save();
  // Darker than the casing around it. A chamber lighter than its housing reads as
  // a lit window, which is exactly how these parts ended up looking like control
  // panels; the machinery has to sit *into* the block, not on top of it.
  ctx.fillStyle = mixColor(color, "#04080e", 0.8);
  ctx.strokeStyle = "rgba(2,5,10,0.85)";
  ctx.lineWidth = Math.max(0.8, unit * 0.045);
  roundRect(ctx, { x: fromX, y: -halfCross, width: span, height: halfCross * 2, radius: unit * 0.06 });
  ctx.fill();
  ctx.stroke();

  // Segment ribs: raised bands, so they catch light on top and shade underneath
  // rather than scoring a flat grid across the face.
  ctx.lineCap = "butt";
  ctx.lineWidth = Math.max(0.9, unit * 0.07);
  for (let i = 1; i <= ribs; i += 1) {
    const rx = fromX + (span * i) / (ribs + 1);
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.34);
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.moveTo(rx, -halfCross * 0.88);
    ctx.lineTo(rx, halfCross * 0.88);
    ctx.stroke();
    ctx.strokeStyle = "rgba(2,5,10,0.7)";
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(0.6, unit * 0.028);
    ctx.beginPath();
    ctx.moveTo(rx + unit * 0.045, -halfCross * 0.88);
    ctx.lineTo(rx + unit * 0.045, halfCross * 0.88);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.9, unit * 0.07);
  }
  ctx.globalAlpha = 1;

  // Feed spine down the thrust axis, running toward the nozzle at -x.
  ctx.strokeStyle = "rgba(132,230,255,0.72)";
  ctx.lineWidth = Math.max(0.8, unit * 0.04);
  ctx.beginPath();
  ctx.moveTo(toX - unit * 0.06, 0);
  ctx.lineTo(fromX, 0);
  ctx.stroke();
  ctx.restore();
}

// Bell nozzle opening toward -x: dark cone interior, a lit mouth lip, and a hot
// throat wedge behind it. This is the single shape that has to survive at icon
// size : if a propulsion part is unreadable, it is because this is missing.
function drawNozzleBell(unit, { throatX, mouthX, throatHalf, mouthHalf, glow = true }) {
  const bell = () => {
    ctx.beginPath();
    ctx.moveTo(throatX, -throatHalf);
    ctx.lineTo(mouthX, -mouthHalf);
    ctx.lineTo(mouthX, mouthHalf);
    ctx.lineTo(throatX, throatHalf);
    ctx.closePath();
  };
  ctx.save();
  ctx.fillStyle = "rgba(2,11,18,0.96)";
  ctx.strokeStyle = "rgba(2,5,10,0.85)";
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  bell();
  ctx.fill();
  ctx.stroke();

  // Cone walls: two lit flanks converging on the throat. These do the work of
  // making the bell read hollow, so the hot core can stay small : a bell filled
  // edge to edge with glow is just a bright wedge again.
  ctx.save();
  bell();
  ctx.clip();
  ctx.strokeStyle = "rgba(168,208,232,0.42)";
  ctx.lineWidth = Math.max(0.9, unit * 0.055);
  ctx.beginPath();
  ctx.moveTo(throatX, -throatHalf);
  ctx.lineTo(mouthX, -mouthHalf);
  ctx.moveTo(throatX, throatHalf);
  ctx.lineTo(mouthX, mouthHalf);
  ctx.stroke();
  ctx.restore();

  // Machined lip around the mouth: the rim that says "this end is open".
  ctx.strokeStyle = "rgba(203,229,245,0.75)";
  ctx.lineWidth = Math.max(1, unit * 0.055);
  ctx.beginPath();
  ctx.moveTo(mouthX, -mouthHalf);
  ctx.lineTo(mouthX, mouthHalf);
  ctx.stroke();

  if (glow) {
    // Two-layer plume: a tight bright core at the throat and a dim flare behind
    // it. A single wedge of near-constant width just reads as a lit rectangle
    // parked inside the bell, which is what the first pass produced.
    const plume = (fromT, toT, fromHalf, toHalf) => {
      const x0 = throatX + (mouthX - throatX) * fromT;
      const x1 = throatX + (mouthX - throatX) * toT;
      ctx.beginPath();
      ctx.moveTo(x0, -throatHalf * fromHalf);
      ctx.lineTo(x1, -mouthHalf * toHalf);
      ctx.lineTo(x1, mouthHalf * toHalf);
      ctx.lineTo(x0, throatHalf * fromHalf);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = "rgba(109,222,255,0.34)";
    plume(0, 0.86, 0.9, 0.78);
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#c8fbff";
    plume(0, 0.34, 0.62, 0.3);
  }
  ctx.restore();
}

// Mount block at the forward (+x) end with anchor bolts: where the drive bolts to
// the hull, and the visual counterweight that keeps a nozzle from floating.
function drawEngineMount(unit, fromX, toX, halfCross, color, bolts = [-0.55, 0.55]) {
  ctx.save();
  ctx.fillStyle = mixColor(color, "#05070c", 0.4);
  ctx.strokeStyle = "rgba(2,5,10,0.8)";
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  roundRect(ctx, { x: fromX, y: -halfCross, width: toX - fromX, height: halfCross * 2, radius: unit * 0.05 });
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  const cap = mixColor(color, "#ffffff", 0.66);
  const bx = (fromX + toX) * 0.5;
  for (const t of bolts) drawFootprintPort(unit, bx, halfCross * t, unit * 0.06, cap);
}

// --- Thermal plumbing art -----------------------------------------------------
//
// A Heat Pipe is one catalogue part with one 1x1 footprint; the six shapes a
// player sees (endpoint, straight, corner, T, cross, isolated) are all this one
// routine reading a four-bit connection mask. Bit order matches
// design/coolantLayout.js: N=1, E=2, S=4, W=8, in the space the caller draws in.

const PIPE_DIRECTION_VECTORS = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);
const COOLANT_CASING = "#0a2c42";
const COOLANT_FLUID = "#5ecdf0";
const COOLANT_HIGHLIGHT = "#c7f2ff";

function drawHeatPipeTile(size, connectionMask) {
  const mask = (Number(connectionMask) || 0) & 15;
  const directions = [];
  for (let bit = 0; bit < 4; bit += 1) if (mask & (1 << bit)) directions.push(PIPE_DIRECTION_VECTORS[bit]);

  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";

  // Dark mechanical housing on the same square tile the rest of the catalogue
  // uses, so a pipe run reads as installed hardware and not as loose cabling.
  ctx.fillStyle = "rgba(7,20,31,0.8)";
  ctx.strokeStyle = "rgba(150,206,232,0.26)";
  ctx.lineWidth = Math.max(0.7, size * 0.04);
  roundRect(ctx, { x: -size * 0.46, y: -size * 0.46, width: size * 0.92, height: size * 0.92, radius: size * 0.13 });
  ctx.fill();
  ctx.stroke();

  const casingWidth = Math.max(2, size * 0.34);
  const coolantWidth = Math.max(1, size * 0.17);
  const reach = size * 0.5;

  const runs = (width, style) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    if (!directions.length) {
      // Isolated pipe: a short capped section that plainly goes nowhere.
      ctx.moveTo(-size * 0.15, 0);
      ctx.lineTo(size * 0.15, 0);
    } else {
      for (const [dx, dy] of directions) {
        ctx.moveTo(0, 0);
        ctx.lineTo(dx * reach, dy * reach);
      }
    }
    ctx.stroke();
  };

  runs(casingWidth, COOLANT_CASING);
  ctx.fillStyle = COOLANT_CASING;
  ctx.beginPath();
  ctx.arc(0, 0, casingWidth * 0.56, 0, Math.PI * 2);
  ctx.fill();
  runs(coolantWidth, COOLANT_FLUID);
  ctx.fillStyle = COOLANT_FLUID;
  ctx.beginPath();
  ctx.arc(0, 0, coolantWidth * 0.62, 0, Math.PI * 2);
  ctx.fill();

  // Coupling flange where each live channel meets the tile edge: this is what
  // makes a connection read as reaching its neighbour rather than stopping short.
  ctx.fillStyle = "rgba(199,242,255,0.6)";
  for (const [dx, dy] of directions) {
    const along = casingWidth * 0.16;
    const across = casingWidth * 0.86;
    const width = dx ? along : across;
    const height = dx ? across : along;
    ctx.fillRect(dx * (reach - along) - width * 0.5, dy * (reach - along) - height * 0.5, width, height);
  }

  // Blanked faces keep the housing symmetric so an endpoint still looks like a
  // sealed pipe end rather than a broken one.
  ctx.fillStyle = "rgba(126,176,201,0.16)";
  for (let bit = 0; bit < 4; bit += 1) {
    if (mask & (1 << bit)) continue;
    const [dx, dy] = PIPE_DIRECTION_VECTORS[bit];
    const width = dx ? size * 0.05 : size * 0.3;
    const height = dx ? size * 0.3 : size * 0.05;
    ctx.fillRect(dx * size * 0.415 - width * 0.5, dy * size * 0.415 - height * 0.5, width, height);
  }

  ctx.restore();
}

function drawHeatVentTile(size, connectionMask) {
  const mask = (Number(connectionMask) || 0) & 15;
  ctx.save();
  ctx.lineJoin = "round";

  // Dark exchanger frame.
  ctx.fillStyle = "rgba(8,22,30,0.86)";
  ctx.strokeStyle = "rgba(150,206,232,0.3)";
  ctx.lineWidth = Math.max(0.7, size * 0.045);
  roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.1 });
  ctx.fill();
  ctx.stroke();

  // Exhaust face: a warm plenum behind hard louvre slats. The warmth is what
  // separates a Vent (heat leaving the hull) from the Heat Sink's cold fin
  // stack and the Radiator's fan.
  const plenum = ctx.createLinearGradient(0, -size * 0.3, 0, size * 0.3);
  plenum.addColorStop(0, "#7c2d12");
  plenum.addColorStop(0.55, "#c2410c");
  plenum.addColorStop(1, "#f59e0b");
  ctx.fillStyle = plenum;
  roundRect(ctx, { x: -size * 0.31, y: -size * 0.3, width: size * 0.62, height: size * 0.6, radius: size * 0.05 });
  ctx.fill();

  ctx.fillStyle = "rgba(6,18,26,0.9)";
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(-size * 0.31, -size * 0.26 + i * size * 0.155, size * 0.62, size * 0.075);
  }
  ctx.strokeStyle = "rgba(199,242,255,0.35)";
  ctx.lineWidth = Math.max(0.6, size * 0.03);
  ctx.strokeRect(-size * 0.31, -size * 0.3, size * 0.62, size * 0.6);

  // Coolant inlet toward whatever the vent is plumbed to. With nothing attached
  // it still shows a capped port, so the part never looks half-drawn.
  const directions = [];
  for (let bit = 0; bit < 4; bit += 1) if (mask & (1 << bit)) directions.push(PIPE_DIRECTION_VECTORS[bit]);
  const stubs = directions.length ? directions : [[0, 1]];
  ctx.lineCap = "butt";
  for (const pass of [[Math.max(1.6, size * 0.2), COOLANT_CASING], [Math.max(1, size * 0.09), COOLANT_FLUID]]) {
    ctx.strokeStyle = pass[1];
    ctx.lineWidth = pass[0];
    ctx.beginPath();
    for (const [dx, dy] of stubs) {
      ctx.moveTo(dx * size * 0.28, dy * size * 0.28);
      ctx.lineTo(dx * size * 0.5, dy * size * 0.5);
    }
    ctx.stroke();
  }
  for (const [dx, dy] of stubs) drawComponentPort(size, dx * 0.42, dy * 0.42, 0.075, COOLANT_HIGHLIGHT, 0.5);

  ctx.restore();
}

// --- Professional single-cell detail ------------------------------------------

function drawProfessionalModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
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
    || type === "halfAblativeArmorDiagonal" || type === "halfRefractoryArmorDiagonal") {
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size * 0.5);
      ctx.lineTo(size * 0.5, -size * 0.5);
      ctx.lineTo(-size * 0.5, size * 0.5);
      ctx.closePath();
    };
    if (REFRACTORY_PARTS.has(type)) {
      withRotatedShape(size, rotation, outline,
        () => drawRefractoryTiles(size, color, fine),
        () => drawRefractoryColdEdge(size, () => {
          ctx.moveTo(size * 0.4, -size * 0.42);
          ctx.lineTo(-size * 0.42, size * 0.4);
        }), flipped);
    } else if (ABLATIVE_PARTS.has(type)) {
      withRotatedShape(size, rotation, outline,
        () => drawAblativeSpallPlating(size, color, fine),
        () => drawAblativeHotEdge(size, () => {
          ctx.moveTo(size * 0.4, -size * 0.42);
          ctx.lineTo(-size * 0.42, size * 0.4);
        }), flipped);
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
        }, flipped);
    }
    return true;
  }

  if (type === "wingFrame" || type === "wingArmor" || type === "wingCompositeArmor" || type === "wingAblativeArmor"
    || type === "wingRefractoryArmor") {
    const outline = () => {
      ctx.beginPath();
      ctx.moveTo(-size * 0.5, -size * 0.5);
      ctx.lineTo(size * 0.5, 0);
      ctx.lineTo(-size * 0.5, size * 0.5);
      ctx.closePath();
    };
    if (REFRACTORY_PARTS.has(type)) {
      withRotatedShape(size, rotation, outline,
        () => drawRefractoryTiles(size, color, fine),
        () => drawRefractoryColdEdge(size, () => {
          ctx.moveTo(-size * 0.44, -size * 0.4);
          ctx.lineTo(size * 0.38, -size * 0.03);
          ctx.moveTo(-size * 0.44, size * 0.4);
          ctx.lineTo(size * 0.38, size * 0.03);
        }), flipped);
    } else if (ABLATIVE_PARTS.has(type)) {
      withRotatedShape(size, rotation, outline,
        () => drawAblativeSpallPlating(size, color, fine),
        () => drawAblativeHotEdge(size, () => {
          ctx.moveTo(-size * 0.44, -size * 0.4);
          ctx.lineTo(size * 0.38, -size * 0.03);
          ctx.moveTo(-size * 0.44, size * 0.4);
          ctx.lineTo(size * 0.38, size * 0.03);
        }), flipped);
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
        }, flipped);
    }
    return true;
  }

  if (type === "refractoryArmor") {
    // Ceramic thermal tile, not a metal plate. A hexagonal tile field with wide
    // insulating grout lines and a cool blue-white bloom in the joints: it reads
    // as a material that absorbs heat rather than one that stops a shell, which
    // is exactly the trade the component makes.
    ctx.save();
    roundRect(ctx, { x: -size * 0.47, y: -size * 0.47, width: size * 0.94, height: size * 0.94, radius: size * 0.06 });
    ctx.clip();
    drawRefractoryTiles(size, color, fine);
    ctx.restore();

    drawArmorRivets(size, color, [[-0.4, -0.36], [0.4, -0.36], [-0.4, 0.4], [0.4, 0.4]]);
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

  if (type === "bevelFrame" || type === "bevelArmor" || type === "bevelCompositeArmor" || type === "bevelAblativeArmor"
    || type === "bevelRefractoryArmor") {
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
      else if (type === "bevelRefractoryArmor") drawRefractoryTiles(size, color, fine);
      else drawArmorLaminate(size, color, type === "bevelCompositeArmor", fine);
    };
    const drawEdge = () => {
      ctx.save();
      ctx.lineCap = "butt";
      ctx.strokeStyle = isFrame ? "rgba(232,241,255,0.6)"
        : REFRACTORY_PARTS.has(type) ? "rgba(214,240,255,0.6)"
        : "rgba(255,240,214,0.62)";
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
    withRotatedShape(size, rotation, outline, drawMaterial, drawEdge, flipped);
    return true;
  }

  if (type === "roundedFrame" || type === "roundedArmor" || type === "roundedCompositeArmor" || type === "roundedAblativeArmor"
    || type === "roundedRefractoryArmor") {
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
      else if (type === "roundedRefractoryArmor") drawRefractoryTiles(size, color, fine);
      else drawArmorLaminate(size, color, type === "roundedCompositeArmor", fine);
    };
    const drawEdge = () => {
      // Swept shoulder: a bright rim inside the arc with a darker shadow line
      // behind it, so the curve reads as a rolled surface.
      ctx.strokeStyle = isFrame ? "rgba(232,241,255,0.6)"
        : REFRACTORY_PARTS.has(type) ? "rgba(214,240,255,0.6)"
        : "rgba(255,240,214,0.62)";
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
    withRotatedShape(size, rotation, outline, drawMaterial, drawEdge, flipped);
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
    // The main engine compressed into one cell: the same mount / chamber / bell
    // sequence, but overbuilt : thicker casing, a stubbier two-rib chamber, and a
    // bell that gives up length rather than width. It should read as the small
    // dense member of the family; the old centred intake disc sitting between two
    // flank conduits read as a face.
    drawPropulsionCasing(size, size * 0.46, size * 0.44, color, size * 0.07);
    // No anchor bolts on this one: a symmetric pair of dots above a ribbed block
    // is a face, and at 1x1 there is nowhere for them to go that isn't "eyes".
    // The mount reads from its own machined cap line instead.
    drawEngineMount(size, size * 0.28, size * 0.42, size * 0.32, color, []);
    ctx.save();
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.55);
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = Math.max(0.7, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(size * 0.35, -size * 0.28);
    ctx.lineTo(size * 0.35, size * 0.28);
    ctx.stroke();
    ctx.restore();
    drawThrustChamber(size, -size * 0.05, size * 0.26, size * 0.29, color, 2);
    drawNozzleBell(size, {
      throatX: -size * 0.06,
      mouthX: -size * 0.42,
      throatHalf: size * 0.15,
      mouthHalf: size * 0.37
    });
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
    // Containment ring braced to the housing by four coolant spurs, with the
    // fuel channel inside it and the controlled core in a well at the centre.
    // Was a bare circle with a bright dot in the middle, which carried none of
    // the "this is a pressure vessel" read the multi-cell reactor has.
    drawRecessedPanel(size, 0.8, 0.8, 0.17);
    // Spurs first, so the ring caps them where they meet it.
    ctx.strokeStyle = "#8a6414";
    ctx.lineWidth = Math.max(1.2, size * 0.075);
    ctx.beginPath();
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI * (0.25 + i * 0.5);
      ctx.moveTo(Math.cos(a) * size * 0.22, Math.sin(a) * size * 0.22);
      ctx.lineTo(Math.cos(a) * size * 0.38, Math.sin(a) * size * 0.38);
    }
    ctx.stroke();
    ctx.strokeStyle = "#d6a820"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,244,168,0.42)"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.22, 0, Math.PI * 2); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.14, "#fff4a8", 0.62);
    return true;
  }
  if (type === "battery") {
    // Cell stack in a sealed case: three electrolyte cells standing in a dark
    // housing under a bus bar, with the terminal post on top and a charge
    // telltale at the foot. Was three bright horizontal bars, which read as a
    // barcode rather than as stored energy.
    drawRecessedPanel(size, 0.84, 0.88, 0.1);
    drawCellStack(size, {
      xs: [-0.19, 0, 0.19],
      halfWidth: 0.075,
      top: -0.26,
      bottom: 0.3,
      casing: "rgba(4,18,28,0.92)",
      edge: "rgba(186,244,255,0.34)",
      hot: "#d5fbff",
      cool: "#0e5f7f",
      fine
    });
    // Bus bar across the cell tops with the terminal post rising out of it.
    ctx.fillStyle = "#9fdcf0";
    roundRect(ctx, { x: -size * 0.29, y: -size * 0.36, width: size * 0.58, height: size * 0.075, radius: size * 0.03 });
    ctx.fill();
    ctx.fillStyle = "rgba(4,18,28,0.92)";
    roundRect(ctx, { x: -size * 0.075, y: -size * 0.45, width: size * 0.15, height: size * 0.1, radius: size * 0.03 });
    ctx.fill();
    drawComponentPort(size, 0, -0.4, 0.05, "#d5fbff", 0.5);
    drawComponentPort(size, 0, 0.38, 0.055, "#47caee", 0.5);
    return true;
  }
  if (type === "capacitor") {
    // Plate pair across a dielectric gap with the stored charge arcing in it.
    // The two flat blue slabs it replaces carried no sense of a gap at all :
    // the arc is what separates this from the Battery's chemical cells.
    drawRecessedPanel(size, 0.86, 0.8, 0.09);
    drawCapacitorPlatePair(size, 0, size * 0.115, size * 0.3, fine);
    // Terminal leads out to the housing wall on both faces.
    ctx.strokeStyle = "rgba(4,12,26,0.9)";
    ctx.lineWidth = Math.max(1.4, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(-size * 0.44, 0); ctx.lineTo(-size * 0.27, 0);
    ctx.moveTo(size * 0.44, 0); ctx.lineTo(size * 0.27, 0);
    ctx.stroke();
    drawComponentPort(size, -0.42, 0, 0.07, "#dbeafe", 0.5);
    drawComponentPort(size, 0.42, 0, 0.07, "#dbeafe", 0.5);
    return true;
  }
  if (type === "auxGenerator") {
    // Compact genset: a driven turbine rotor geared to an alternator can, with
    // the output bus leaving on the far face and a capped exhaust on the near
    // one. Deliberately machinery, not a containment ring : the Reactor owns
    // that read, and this used to be two amber slabs with a chevron on them.
    drawRecessedPanel(size, 0.86, 0.84, 0.1);

    // Turbine rotor with swept vanes.
    const hub = { x: -size * 0.16, y: 0, r: size * 0.19 };
    ctx.fillStyle = "rgba(24,14,2,0.9)";
    ctx.beginPath(); ctx.arc(hub.x, hub.y, hub.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(254,240,138,0.45)"; ctx.lineWidth = fine; ctx.stroke();
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = Math.max(0.9, size * 0.055);
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const a = (i * Math.PI * 2) / 5 - Math.PI / 5;
      ctx.moveTo(hub.x + Math.cos(a) * size * 0.05, hub.y + Math.sin(a) * size * 0.05);
      ctx.lineTo(hub.x + Math.cos(a + 0.5) * hub.r * 0.86, hub.y + Math.sin(a + 0.5) * hub.r * 0.86);
    }
    ctx.stroke();
    drawComponentPort(size, hub.x / size, 0, 0.05, "#fef9c3", 0.55);

    // Drive shaft into the alternator can.
    ctx.strokeStyle = "#a16207";
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.beginPath(); ctx.moveTo(hub.x + hub.r * 0.7, 0); ctx.lineTo(size * 0.06, 0); ctx.stroke();

    ctx.fillStyle = "rgba(24,14,2,0.9)";
    ctx.strokeStyle = "rgba(254,240,138,0.42)";
    ctx.lineWidth = fine;
    roundRect(ctx, { x: size * 0.06, y: -size * 0.22, width: size * 0.26, height: size * 0.44, radius: size * 0.06 });
    ctx.fill(); ctx.stroke();
    // Stator windings on the can.
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = Math.max(0.7, size * 0.04);
    ctx.beginPath();
    for (let i = 0; i < 3; i += 1) {
      const y = -size * 0.13 + i * size * 0.13;
      ctx.moveTo(size * 0.09, y); ctx.lineTo(size * 0.29, y);
    }
    ctx.stroke();

    // Output bus off the alternator, capped exhaust stub above the turbine.
    ctx.strokeStyle = "rgba(24,14,2,0.9)";
    ctx.lineWidth = Math.max(1.3, size * 0.1);
    ctx.beginPath(); ctx.moveTo(size * 0.32, size * 0.22); ctx.lineTo(size * 0.44, size * 0.22); ctx.stroke();
    drawComponentPort(size, 0.42, 0.22, 0.07, "#fef08a", 0.5);
    ctx.strokeStyle = "rgba(24,14,2,0.9)";
    ctx.lineWidth = Math.max(1.1, size * 0.085);
    ctx.beginPath(); ctx.moveTo(hub.x, -size * 0.32); ctx.lineTo(hub.x, -size * 0.44); ctx.stroke();
    drawComponentPort(size, hub.x / size, -0.42, 0.06, "#f59e0b", 0.5);
    return true;
  }
  if (type === "shield") {
    // Projector: a lensed emitter in a dark well throwing three field arcs, with
    // the phase nodes that shape them bolted around the rim. Two bare arcs on an
    // empty panel gave no clue where the field was coming from.
    drawRecessedPanel(size, 0.82, 0.82, 0.18);

    // Field arcs, faintest outermost : the projected barrier.
    const arcs = [[0.4, 0.3], [0.32, 0.52], [0.24, 0.82]];
    for (const [r, alpha] of arcs) {
      ctx.strokeStyle = `rgba(167,243,208,${alpha})`;
      ctx.lineWidth = r > 0.3 ? fine : line;
      ctx.beginPath();
      ctx.arc(0, 0, size * r, Math.PI * 0.16, Math.PI * 1.84);
      ctx.stroke();
    }

    // Emitter well and lens.
    ctx.fillStyle = "rgba(3,20,13,0.9)";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.19, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.shadowColor = "#7cffa0";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#b9ffd0";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.105, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Phase nodes on the rim, sitting on the arc gap side so the ring reads open.
    for (let i = 0; i < 3; i += 1) {
      const a = Math.PI * (1.5 + (i - 1) * 0.42);
      drawComponentPort(size, Math.cos(a) * 0.33, Math.sin(a) * 0.33, 0.06, "#a7f3d0", 0.5);
    }
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
    // Directional aperture pointing along local +x : the same facing the
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
    // Same housing language as every other system module : recessed panel,
    // centred assembly, corner telltales : with the shared warhead face at
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
    // Propulsion SUPPORT hardware, not a thruster: it wears the family's casing
    // and cyan energy, but has no nozzle and no thrust axis : it is radially
    // symmetric on purpose. The read is a gimballed rotor: an outer housing ring,
    // a tilted inner gimbal journalled on two trunnion pins, and a lit flywheel.
    // The old crosshair-through-a-circle was a targeting reticle, and shared both
    // silhouette and violet with the Backup Command Core.
    drawPropulsionCasing(size, size * 0.46, size * 0.46, color, size * 0.09);

    ctx.save();
    // Housing well.
    ctx.fillStyle = "rgba(2,10,18,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.fill();

    // Outer gimbal ring.
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.5);
    ctx.lineWidth = Math.max(1, size * 0.055);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
    ctx.stroke();

    // Inner gimbal, tilted out of plane: an ellipse, which is what sells rotation
    // in a flat top-down icon.
    ctx.save();
    ctx.rotate(-Math.PI * 0.18);
    ctx.scale(1, 0.42);
    ctx.strokeStyle = "rgba(196,225,245,0.85)";
    ctx.lineWidth = Math.max(1, size * 0.075);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Trunnion pins: the bearings the inner gimbal swings on.
    for (const sx of [-1, 1]) {
      const px = sx * size * 0.32 * Math.cos(-Math.PI * 0.18);
      const py = sx * size * 0.32 * Math.sin(-Math.PI * 0.18);
      ctx.fillStyle = "rgba(3,8,14,0.92)";
      ctx.beginPath();
      ctx.arc(px, py, size * 0.055, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = mixColor(color, "#ffffff", 0.7);
      ctx.beginPath();
      ctx.arc(px, py, size * 0.028, 0, Math.PI * 2);
      ctx.fill();
    }

    // Flywheel: the one hot thing on the part.
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Spin highlight: a partial arc, so the rotor reads as turning.
    ctx.strokeStyle = "rgba(230,250,255,0.7)";
    ctx.lineWidth = Math.max(0.8, size * 0.035);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.17, -Math.PI * 0.85, -Math.PI * 0.15);
    ctx.stroke();
    ctx.restore();
    return true;
  }
  if (type === "maneuverThruster") {
    // Attitude control, so the whole point is that it pushes SIDEWAYS: a gimbal
    // yoke bolted at +x carrying a bell canted off the thrust axis, plus one small
    // vernier firing the other way. Deliberately asymmetric : the old symmetric
    // wedge-and-dot read as a UI arrow rather than a piece of hardware.
    drawPropulsionCasing(size, size * 0.46, size * 0.44, color, size * 0.07);

    // Mounting block along the +x edge, with the gimbal yoke reaching off it. One
    // bracket, one pivot, one bell: at 40px there is no room for more, and the
    // first pass : yoke plus canted bell plus an opposed vernier : turned to
    // scribble at icon size.
    ctx.save();
    ctx.fillStyle = mixColor(color, "#05070c", 0.4);
    ctx.strokeStyle = "rgba(2,5,10,0.8)";
    ctx.lineWidth = Math.max(0.8, size * 0.05);
    roundRect(ctx, { x: size * 0.24, y: -size * 0.38, width: size * 0.18, height: size * 0.76, radius: size * 0.05 });
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    const cap = mixColor(color, "#ffffff", 0.68);
    drawComponentPort(size, 0.33, -0.26, 0.05, cap, 0.5);
    drawComponentPort(size, 0.33, 0.26, 0.05, cap, 0.5);

    // Yoke arm from the bracket down to the pivot: the asymmetry is the point.
    const pivotX = size * 0.02;
    const pivotY = -size * 0.06;
    ctx.save();
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.32);
    ctx.lineWidth = Math.max(1.4, size * 0.095);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(size * 0.26, size * 0.16);
    ctx.lineTo(pivotX, pivotY);
    ctx.stroke();
    ctx.restore();

    // Vectoring bell, pivoted about its throat and canted well off the long axis
    // so the part visibly pushes sideways.
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(-0.62);
    drawNozzleBell(size, {
      throatX: 0,
      mouthX: -size * 0.4,
      throatHalf: size * 0.11,
      mouthHalf: size * 0.28
    });
    ctx.restore();

    // Gimbal pivot pin.
    ctx.save();
    ctx.fillStyle = "rgba(3,8,14,0.94)";
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, size * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cap;
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, size * 0.036, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
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
    // Cold fin stack on a charged mass block: fins graded bright at the tip and
    // dark at the root, fed from a coolant manifold down one side. The four flat
    // blue bars it replaces read the same as the Heat Vent's louvres; the
    // manifold and the frost-bright tips are what mark this as the cold end.
    drawRecessedPanel(size, 0.84, 0.86, 0.08);

    // Thermal mass the fins are bonded to.
    ctx.fillStyle = "rgba(6,20,34,0.9)";
    ctx.strokeStyle = "rgba(191,219,254,0.3)";
    ctx.lineWidth = fine;
    roundRect(ctx, { x: -size * 0.34, y: -size * 0.36, width: size * 0.68, height: size * 0.72, radius: size * 0.05 });
    ctx.fill();
    ctx.stroke();

    // Fin stack, tips lit. Left ends stop short of the manifold rail.
    const fins = 5;
    for (let i = 0; i < fins; i += 1) {
      const y = -size * 0.3 + i * size * 0.145;
      const fin = ctx.createLinearGradient(0, y, 0, y + size * 0.075);
      fin.addColorStop(0, "#eff6ff");
      fin.addColorStop(0.5, "#93c5fd");
      fin.addColorStop(1, "#1d4ed8");
      ctx.fillStyle = fin;
      ctx.fillRect(-size * 0.19, y, size * 0.5, size * 0.075);
    }

    // Coolant manifold feeding every fin root, capped at both ends.
    ctx.fillStyle = COOLANT_CASING;
    roundRect(ctx, { x: -size * 0.31, y: -size * 0.33, width: size * 0.11, height: size * 0.66, radius: size * 0.05 });
    ctx.fill();
    ctx.strokeStyle = COOLANT_FLUID;
    ctx.lineWidth = Math.max(1, size * 0.055);
    ctx.beginPath();
    ctx.moveTo(-size * 0.255, -size * 0.26);
    ctx.lineTo(-size * 0.255, size * 0.26);
    ctx.stroke();
    // Fin roots tapping the manifold : the bond that makes this one mass.
    ctx.strokeStyle = COOLANT_HIGHLIGHT;
    ctx.lineWidth = Math.max(0.6, size * 0.028);
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const y = -size * 0.263 + i * size * 0.145;
      ctx.moveTo(-size * 0.255, y);
      ctx.lineTo(-size * 0.19, y);
    }
    ctx.stroke();
    drawComponentPort(size, -0.255, -0.31, 0.05, COOLANT_HIGHLIGHT, 0.5);
    drawComponentPort(size, -0.255, 0.31, 0.05, COOLANT_HIGHLIGHT, 0.5);
    return true;
  }
  if (type === "closedCycleCooler") {
    // Sealed refrigeration loop: a dark machinery bay holding a closed circuit
    // of coolant pipe that runs from a capped inlet, round a driven compressor,
    // out through a capped outlet. Reads as plumbing under pressure : nothing
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

    // Capped inlet and outlet on opposite faces : a sealed cycle, not an
    // exhaust: the stubs stop at the housing wall.
    ctx.strokeStyle = "rgba(4,26,38,0.92)";
    ctx.lineWidth = Math.max(1.6, size * 0.13);
    ctx.beginPath();
    ctx.moveTo(-size * 0.44, -size * 0.19); ctx.lineTo(-size * 0.31, -size * 0.19);
    ctx.moveTo(size * 0.44, size * 0.19); ctx.lineTo(size * 0.31, size * 0.19);
    ctx.stroke();
    drawComponentPort(size, -0.42, -0.19, 0.075, "#a5f3fc", 0.5);
    drawComponentPort(size, 0.42, 0.19, 0.075, "#a5f3fc", 0.5);

    // Accumulator bottle on the return leg : the sealed charge this loop carries.
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
    drawHeatPipeTile(size, connectionMask);
    return true;
  }
  if (type === "heatVent") {
    drawHeatVentTile(size, connectionMask, visualState);
    return true;
  }
  if (type === "radiator") {
    // Active cooling fan: visually distinct from the heat sink's passive fin
    // stack. The blueprint overlay separately highlights the actual exposed edge.
    drawRecessedPanel(size, 0.86, 0.86, 0.1);

    // Shroud: a dark duct ring the impeller sits inside, with mounting bolts.
    ctx.fillStyle = "rgba(5,24,36,0.82)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.37, 0, Math.PI * 2);
    ctx.arc(0, 0, size * 0.31, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.strokeStyle = "rgba(155,232,255,0.55)";
    ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.37, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(155,232,255,0.3)";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.31, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI * (0.25 + i * 0.5);
      drawComponentPort(size, Math.cos(a) * 0.34, Math.sin(a) * 0.34, 0.045, "#bae6fd", 0.45);
    }

    // Six swept blades: dark body with a lit leading edge, so the impeller reads
    // as pitched metal rather than as four flat pinwheel triangles.
    const bladeR = size * 0.3;
    const hubR = size * 0.09;
    for (let i = 0; i < 6; i += 1) {
      const a = (i * Math.PI * 2) / 6;
      const sweep = 0.62;
      const tip = { x: Math.cos(a + sweep) * bladeR, y: Math.sin(a + sweep) * bladeR };
      const root = { x: Math.cos(a) * hubR, y: Math.sin(a) * hubR };
      const trail = { x: Math.cos(a - 0.2) * bladeR * 0.82, y: Math.sin(a - 0.2) * bladeR * 0.82 };
      ctx.fillStyle = "#2f8fb8";
      ctx.beginPath();
      ctx.moveTo(root.x, root.y);
      ctx.quadraticCurveTo(Math.cos(a + 0.3) * bladeR * 0.7, Math.sin(a + 0.3) * bladeR * 0.7, tip.x, tip.y);
      ctx.lineTo(trail.x, trail.y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#bae6fd";
      ctx.lineWidth = Math.max(0.6, size * 0.028);
      ctx.beginPath();
      ctx.moveTo(root.x, root.y);
      ctx.quadraticCurveTo(Math.cos(a + 0.3) * bladeR * 0.7, Math.sin(a + 0.3) * bladeR * 0.7, tip.x, tip.y);
      ctx.stroke();
    }

    // Motor hub over the blade roots.
    ctx.fillStyle = "rgba(4,20,30,0.92)";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.11, 0, Math.PI * 2); ctx.fill();
    drawComponentPort(size, 0, 0, 0.075, "#d9f8ff", 0.45);

    // Coolant risers up both flanks, feeding the exchanger behind the fan.
    ctx.strokeStyle = COOLANT_CASING;
    ctx.lineWidth = Math.max(1.3, size * 0.09);
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.3); ctx.lineTo(-size * 0.42, size * 0.3);
    ctx.moveTo(size * 0.42, -size * 0.3); ctx.lineTo(size * 0.42, size * 0.3);
    ctx.stroke();
    ctx.strokeStyle = COOLANT_FLUID;
    ctx.lineWidth = Math.max(0.7, size * 0.04);
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.26); ctx.lineTo(-size * 0.42, size * 0.26);
    ctx.moveTo(size * 0.42, -size * 0.26); ctx.lineTo(size * 0.42, size * 0.26);
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

export function drawModule({ x, y, size, color, type, trim, drawBase = true, drawDetail = true, visualState = "active", rotation = 0, flipped = false, connectionMask = 0 }) {
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

  // A cut-away silhouette draws its own body clipped to its outline, so a full
  // cube base behind it would fill the part of the cell the shape deliberately
  // gives up. The catalogue's `shapeType` is the authority: this used to be a
  // hand-listed set of every silhouette id, which silently reverted each new
  // structural material to a square block until someone remembered to add its
  // five variants.
  const keepsPartialShape = Boolean(PART_STATS[type]?.shapeType) || LEGACY_PARTIAL_SHAPE_PARTS.has(type);
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
  if (drawProfessionalModuleDetail(type, size, bodyColor, visualState, rotation, flipped, connectionMask)) {
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

// The bright counterpart to drawFootprintPanel, for open-frame weapons whose
// bed plate is visible between their parts: a light brushed-metal wash with a
// lit top edge, so the plate reads as machined silver rather than a recess.
function drawFootprintPlate(unit, hl, hc, color) {
  ctx.save();
  // Mid silver, not white: the rails sitting on it are near-white, so a bright
  // plate would leave them with nothing to read against.
  ctx.fillStyle = mixColor(color, "#7c8aa0", 0.45);
  ctx.strokeStyle = "rgba(9,14,24,0.5)";
  ctx.lineWidth = Math.max(0.75, unit * 0.045);
  roundRect(ctx, {
    x: -hl * 0.97,
    y: -hc * 0.94,
    width: hl * 0.97 * 2,
    height: hc * 0.94 * 2,
    radius: unit * 0.09
  });
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.5)";
  ctx.lineWidth = Math.max(0.6, unit * 0.03);
  ctx.beginPath();
  ctx.moveTo(-hl * 0.9, -hc * 0.87);
  ctx.lineTo(hl * 0.9, -hc * 0.87);
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
  // charge racks along both flanks : the same deck layout the other multi-cell
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
  // lit core, built out into an actual plant : a shielded core well feeding a
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
// role on inspection : the same way the backup core badge is built.
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

function drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
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
    // The family's baseline main drive, read front to back: hull mount at +x,
    // ribbed thrust chamber, then one bell nozzle flared across the entire stern.
    // The old art led with a big concentric intake disc, which at icon size read
    // as a camera lens; the nozzle is now the largest feature on the part, which
    // is what makes it a thruster rather than a blue machine block.
    drawPropulsionCasing(unit, hl * 0.98, hc * 0.94, color);

    const mountFrom = hl * 0.98 - unit * 0.3;
    drawEngineMount(unit, mountFrom, hl * 0.98 - unit * 0.03, hc * 0.8, color);

    const throatX = -hl + unit * 0.72;
    drawThrustChamber(unit, throatX - unit * 0.02, mountFrom - unit * 0.04, hc * 0.68, color, 3);

    // Turbopump feed lines flanking the chamber: machinery, without the detail
    // storm that made the earlier weapons hard to read.
    ctx.save();
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.4);
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(throatX + unit * 0.1, -hc * 0.82);
    ctx.lineTo(mountFrom - unit * 0.1, -hc * 0.82);
    ctx.moveTo(throatX + unit * 0.1, hc * 0.82);
    ctx.lineTo(mountFrom - unit * 0.1, hc * 0.82);
    ctx.stroke();
    ctx.restore();

    drawNozzleBell(unit, {
      throatX,
      mouthX: -hl + unit * 0.06,
      throatHalf: hc * 0.34,
      mouthHalf: hc * 0.92
    });
    return true;
  }

  if (type === "heavyEngine") {
    // The capital drive: the standard Engine's construction, reinforced and given
    // a nozzle CLUSTER : one oversized centre bell with two outboard bells : fed
    // from a common manifold. The cluster is the whole read. The previous art was
    // a flat panel carrying two discs and a row of ports, which said "control
    // console" at every size; three flared mouths across the stern say "this is
    // several engines' worth of drive in one casing", which is what the part is.
    drawPropulsionCasing(unit, hl * 0.98, hc * 0.96, color);

    // Heavy longitudinal reinforcement down both flanks.
    ctx.save();
    ctx.fillStyle = mixColor(color, "#05070c", 0.42);
    ctx.strokeStyle = "rgba(2,5,10,0.8)";
    ctx.lineWidth = Math.max(0.8, unit * 0.045);
    for (const sy of [-1, 1]) {
      roundRect(ctx, {
        x: -hl * 0.9,
        y: sy * hc * 0.94 - (sy > 0 ? unit * 0.2 : 0),
        width: hl * 1.8,
        height: unit * 0.2,
        radius: unit * 0.05
      });
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // Mount face and its heavy anchor bolts, forward.
    const mountFrom = hl * 0.98 - unit * 0.36;
    drawEngineMount(unit, mountFrom, hl * 0.98 - unit * 0.04, hc * 0.74, color, [-0.72, -0.24, 0.24, 0.72]);

    // Segmented chamber block: three ribs, wide enough to feed the whole cluster.
    const manifoldX = -hl + unit * 1.08;
    drawThrustChamber(unit, manifoldX, mountFrom - unit * 0.05, hc * 0.62, color, 3);

    // Common exhaust manifold: the dark plenum every bell hangs off, with a hot
    // distribution strip running across it.
    ctx.save();
    ctx.fillStyle = "rgba(2,9,15,0.94)";
    ctx.strokeStyle = "rgba(2,5,10,0.85)";
    ctx.lineWidth = Math.max(0.8, unit * 0.05);
    roundRect(ctx, { x: manifoldX - unit * 0.24, y: -hc * 0.9, width: unit * 0.3, height: hc * 1.8, radius: unit * 0.05 });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Nozzle cluster: big centre bell with an outboard pair whose mouths meet it,
    // so the stern reads as one continuous exhaust array. Spacing them apart left
    // three separate trapezoids that looked like legs under a table.
    const throatX = manifoldX - unit * 0.24;
    const mouthX = -hl + unit * 0.08;
    drawNozzleBell(unit, { throatX, mouthX, throatHalf: hc * 0.17, mouthHalf: hc * 0.36 });
    for (const sy of [-1, 1]) {
      ctx.save();
      ctx.translate(0, sy * hc * 0.65);
      drawNozzleBell(unit, {
        throatX,
        mouthX: mouthX + unit * 0.1,
        throatHalf: hc * 0.13,
        mouthHalf: hc * 0.29
      });
      ctx.restore();
    }

    // One injector per bell on the manifold face. A single continuous glowing
    // strip across the plenum read as a strip light bolted to the back of the
    // part; three discrete feeds read as three nozzles being fed.
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#9ff6ff";
    for (const cy of [-hc * 0.65, 0, hc * 0.65]) {
      roundRect(ctx, {
        x: manifoldX - unit * 0.17,
        y: cy - hc * 0.15,
        width: unit * 0.09,
        height: hc * 0.3,
        radius: unit * 0.035
      });
      ctx.fill();
    }
    ctx.restore();
    return true;
  }

  if (type === "burstCooler") {
    // A cryogenic accumulator, not a radiator: a sealed pressure vessel with a
    // frosted charge window down its length and one large relief valve at the
    // top. Nothing on it is a fin, because it does not shed heat continuously :
    // the valve is the entire mechanism and has to be the thing you notice.
    drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.1);

    ctx.fillStyle = "rgba(8,22,34,0.92)";
    roundRect(ctx, { x: -hl * 0.86, y: -hc * 0.58, width: hl * 1.72, height: hc * 1.16, radius: hc * 0.5 });
    ctx.fill();
    ctx.stroke();

    // Frosted charge window: how full the accumulator is.
    ctx.save();
    ctx.shadowColor = "#a5f3fc";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#cffafe";
    roundRect(ctx, { x: -hl * 0.7, y: -hc * 0.2, width: hl * 1.4, height: hc * 0.4, radius: hc * 0.2 });
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "rgba(3,18,28,0.6)";
    ctx.lineWidth = Math.max(0.7, unit * 0.035);
    ctx.beginPath();
    for (let tick = 1; tick < 4; tick += 1) {
      const tx = -hl * 0.7 + (hl * 1.4 * tick) / 4;
      ctx.moveTo(tx, -hc * 0.2);
      ctx.lineTo(tx, hc * 0.2);
    }
    ctx.stroke();
    ctx.restore();

    // Relief valve and its vent stack.
    ctx.fillStyle = mixColor(color, "#05070c", 0.35);
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = Math.max(0.8, unit * 0.05);
    ctx.beginPath();
    ctx.arc(hl * 0.4, -hc * 0.62, Math.min(hc * 0.42, unit * 0.3), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ecfeff";
    ctx.beginPath();
    ctx.arc(hl * 0.4, -hc * 0.62, Math.min(hc * 0.16, unit * 0.11), 0, Math.PI * 2);
    ctx.fill();
    drawFootprintPort(unit, -hl * 0.62, hc * 0.6, unit * 0.11, "#67e8f9");
    return true;
  }

  if (type === "overclockedRepair") {
    // The standard Repair module's cross, driven hard: a doubled emitter cross
    // on a machined bed, flanked by two exposed heat-stressed drive stacks that
    // say where all that Power goes and why the part cooks itself.
    drawFootprintPanel(unit, hl, hc, 0.94, 0.9, 0.1);

    ctx.save();
    ctx.shadowColor = "#86efac";
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = "#d7ffe2";
    const armLong = hl * 0.44;
    const armCross = hc * 0.62;
    const armHalf = Math.min(unit * 0.11, hc * 0.16);
    ctx.fillRect(-armLong, -armHalf, armLong * 2, armHalf * 2);
    ctx.fillRect(-armHalf, -armCross, armHalf * 2, armCross * 2);
    ctx.restore();

    // Drive stacks at both ends, running warm.
    for (const sx of [-hl * 0.76, hl * 0.76]) {
      ctx.fillStyle = mixColor(color, "#05070c", 0.42);
      ctx.strokeStyle = "rgba(3,6,12,0.72)";
      ctx.lineWidth = Math.max(0.8, unit * 0.05);
      roundRect(ctx, { x: sx - unit * 0.16, y: -hc * 0.56, width: unit * 0.32, height: hc * 1.12, radius: unit * 0.05 });
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.shadowColor = "#fb923c";
      ctx.shadowBlur = qualityShadowBlur(5);
      ctx.fillStyle = "#fdba74";
      for (const cy of [-hc * 0.3, 0, hc * 0.3]) {
        ctx.fillRect(sx - unit * 0.1, cy - unit * 0.03, unit * 0.2, unit * 0.06);
      }
      ctx.restore();
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "reactor") {
    // A tall containment vessel holding one continuous plasma column, clamped by
    // two magnetic collars, capped by an injector at one end and a heavy power
    // coupling at the other.
    //
    // Two things drove this. The previous art put two identical discs side by
    // side on a flat yellow slab, which read as speakers or cooker rings rather
    // than a machine; and the yellow was the whole component body, so nothing on
    // the part was actually emitting. Yellow is now only the energy: a charcoal
    // casing covers the coloured slab and leaves it showing as a golden rim, and
    // the one bright thing in the tile is the column.
    //
    // Drawn in the footprint's long-axis frame, so local -x is the injector end
    // and +x the coupling end; the caller's rotation decides which way that
    // points on the hull.
    const casingHalfCross = hc * 0.9;
    const casingHalfLong = hl * 0.95;
    const columnHalf = Math.min(hc * 0.26, hl * 0.14);
    const capLong = hl * 0.2;
    const couplingLong = hl * 0.26;
    const columnFrom = -casingHalfLong + capLong * 1.5;
    const columnTo = casingHalfLong - couplingLong * 1.4;

    // Casing: near-opaque charcoal over the coloured slab. Every other part
    // keeps the slab visible, but a reactor that is uniformly its own bright
    // colour has nowhere left to put a glow.
    ctx.save();
    ctx.fillStyle = "rgba(16,20,27,0.93)";
    ctx.strokeStyle = "#d6a820";
    ctx.lineWidth = Math.max(0.9, unit * 0.05);
    roundRect(ctx, {
      x: -casingHalfLong,
      y: -casingHalfCross,
      width: casingHalfLong * 2,
      height: casingHalfCross * 2,
      radius: unit * 0.12
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Magnetic collars: clamps bridging casing wall to casing wall, in a steel
    // light enough to separate from the charcoal behind them. Drawn before the
    // column so the column passes in front and they read as clamped around it
    // rather than painted across it.
    //
    // These are the only things crossing the vessel. An earlier pass ran a
    // coolant conduit down one flank as a deliberate asymmetry; it broke the
    // mirror symmetry about the long axis for no gain, so the part is now
    // symmetric across that axis and only its two ends differ.
    ctx.save();
    ctx.lineCap = "butt";
    ctx.beginPath();
    for (const cx of [
      columnFrom + (columnTo - columnFrom) * 0.28,
      columnFrom + (columnTo - columnFrom) * 0.72
    ]) {
      ctx.moveTo(cx, -casingHalfCross * 0.88);
      ctx.lineTo(cx, casingHalfCross * 0.88);
    }
    ctx.strokeStyle = "#5d6a7c";
    ctx.lineWidth = Math.max(1.6, unit * 0.13);
    ctx.stroke();
    ctx.strokeStyle = "#98a6b8";
    ctx.lineWidth = Math.max(0.7, unit * 0.04);
    ctx.stroke();
    ctx.restore();

    // Plasma column. The gradient runs ALONG the column, not across it: this is
    // brightness falling off toward the ends, not the cross-tube shading the
    // weapon bodies had removed.
    ctx.save();
    ctx.shadowColor = "#f59e0b";
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = "#3a2405";
    roundRect(ctx, {
      x: columnFrom,
      y: -columnHalf,
      width: columnTo - columnFrom,
      height: columnHalf * 2,
      radius: columnHalf
    });
    ctx.fill();
    ctx.restore();

    ctx.save();
    const plasma = ctx.createLinearGradient(columnFrom, 0, columnTo, 0);
    plasma.addColorStop(0, "#b45309");
    plasma.addColorStop(0.28, "#f59e0b");
    plasma.addColorStop(0.5, "#fde68a");
    plasma.addColorStop(0.72, "#f59e0b");
    plasma.addColorStop(1, "#b45309");
    ctx.fillStyle = plasma;
    roundRect(ctx, {
      x: columnFrom + unit * 0.03,
      y: -columnHalf * 0.68,
      width: (columnTo - columnFrom) - unit * 0.06,
      height: columnHalf * 1.36,
      radius: columnHalf * 0.68
    });
    ctx.fill();
    // White-hot centre: one short bar, brightest where the collars hold it.
    ctx.fillStyle = "#fffbe8";
    roundRect(ctx, {
      x: columnFrom + (columnTo - columnFrom) * 0.24,
      y: -columnHalf * 0.24,
      width: (columnTo - columnFrom) * 0.52,
      height: columnHalf * 0.48,
      radius: columnHalf * 0.24
    });
    ctx.fill();
    ctx.restore();

    // Injector cap: a narrow control block with a single feed port.
    const capX = -casingHalfLong + unit * 0.06;
    ctx.save();
    ctx.fillStyle = "#3b4553";
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = fine;
    roundRect(ctx, {
      x: capX,
      y: -casingHalfCross * 0.46,
      width: capLong,
      height: casingHalfCross * 0.92,
      radius: unit * 0.04
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawFootprintPort(unit, capX + capLong * 0.5, 0, unit * 0.06, "#fde68a");

    // Power coupling: wider across and lighter in tone than the injector, with a
    // bus plate and two contact points, so the two ends of the vessel are
    // visibly doing different jobs rather than mirroring each other.
    const couplingX = casingHalfLong - unit * 0.06 - couplingLong;
    ctx.save();
    ctx.fillStyle = "#5d6a7c";
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = fine;
    roundRect(ctx, {
      x: couplingX,
      y: -casingHalfCross * 0.82,
      width: couplingLong,
      height: casingHalfCross * 1.64,
      radius: unit * 0.05
    });
    ctx.fill();
    ctx.stroke();
    // Bus plate across the coupling face.
    ctx.fillStyle = "#98a6b8";
    roundRect(ctx, {
      x: couplingX + couplingLong * 0.62,
      y: -casingHalfCross * 0.66,
      width: couplingLong * 0.26,
      height: casingHalfCross * 1.32,
      radius: unit * 0.02
    });
    ctx.fill();
    ctx.restore();
    for (const sy of [-0.44, 0.44]) {
      drawFootprintPort(unit, couplingX + couplingLong * 0.3, casingHalfCross * sy, unit * 0.055, "#d6a820");
    }

    return true;
  }

  if (type === "capacitor") {
    // Capacitor bank: the same plate pair the 1x1 draws, repeated along the
    // footprint and tied together by top and bottom charge rails. The flat blue
    // cell bars it replaces shared nothing with the single-cell part.
    drawFootprintPanel(unit, hl, hc, 0.92, 0.78, 0.08);
    const banks = Math.max(2, tilesLong);
    const span = hl * 1.7;
    const bankW = span / banks;
    const plateThickness = Math.min(unit * 0.16, bankW * 0.22);
    const gapHalf = Math.min(unit * 0.11, bankW * 0.16);
    const halfHeight = Math.min(hc * 0.5, unit * 0.3);
    for (let i = 0; i < banks; i += 1) {
      const cx = -span * 0.5 + bankW * (i + 0.5);
      drawCapacitorPlatePair(unit, cx, gapHalf, halfHeight, fine, plateThickness);
    }

    // Charge rails across the plate ends, with the bank terminals on the flanks.
    ctx.strokeStyle = "#93c5fd";
    ctx.lineWidth = Math.max(0.9, unit * 0.055);
    ctx.beginPath();
    for (const sy of [-1, 1]) {
      ctx.moveTo(-span * 0.5, sy * halfHeight * 1.24);
      ctx.lineTo(span * 0.5, sy * halfHeight * 1.24);
    }
    ctx.stroke();
    for (const sx of [-1, 1]) {
      drawFootprintPort(unit, sx * hl * 0.88, 0, unit * 0.075, "#dbeafe");
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "droneBay") {
    // Launch deck: a translucent bay opening (keeps the lit hull cube showing
    // through, like every other multi-tile module) with three recessed docking
    // cradles for the squad and a bright central launch rail. One signature
    // accent : cyan : instead of the former flat crosshair on an opaque box.
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
    || type === "longWedgeAblativeArmor" || type === "longWedgeRefractoryArmor") {
    // Two-cell prow: broad at the rear (-x), tapering to a blunt nose at +x.
    // The prow silhouette rotates with the part, but the armour courses / tile
    // rows stay in ship-local space so the prow still reads as the same belt.
    const isFrame = type === "longWedgeFrame";
    const composite = type === "longWedgeCompositeArmor";
    const ablative = type === "longWedgeAblativeArmor";
    const refractory = type === "longWedgeRefractoryArmor";
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
      } else if (refractory) {
        // The tile field is authored around a single cell, so a two-cell prow
        // draws it once per cell along the long axis. That keeps the tiles the
        // same physical size here as on a 1x1 plate, which is what makes a
        // refractory nose read as continuous with the belt behind it.
        const cellSize = Math.min(hc * 2, hl);
        for (let cell = 0; cell < Math.max(1, Math.round((hl * 2) / cellSize)); cell += 1) {
          ctx.save();
          ctx.translate(-hl + cellSize * (cell + 0.5), 0);
          drawRefractoryTiles(cellSize, color, fine);
          ctx.restore();
        }
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
      ctx.strokeStyle = isFrame ? "rgba(232,241,255,0.6)"
        : ablative ? "rgba(255,168,96,0.6)"
        : refractory ? "rgba(214,240,255,0.6)"
        : "rgba(255,240,214,0.62)";
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

    // Base fill and material are clipped to the mirrored+rotated prow but drawn
    // in ship axes so plating direction is continuous across the whole ship.
    // Same mirror-then-rotate order and same unrotate trick as
    // withRotatedShape(): once mirrored, rotate(+angle) is the inverse rotation.
    const flipX = flippedScaleX(flipped);
    ctx.save();
    ctx.rotate(rotation);
    ctx.scale(flipX, 1);
    outline();
    ctx.clip();
    ctx.rotate(-rotation * flipX);
    ctx.fillRect(-hl, -hc, hl * 2, hc * 2);
    drawMaterial();
    ctx.restore();

    // Silhouette, chamfer and hardware mirror and rotate with the prow.
    ctx.save();
    ctx.rotate(rotation);
    ctx.scale(flipX, 1);
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
export function drawFootprintComponent({ type, unit, tilesLong, tilesCross, color, trim, drawBase = true, drawDetail = true, visualState = "safed", rotation = 0, flipped = false }) {
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

  if (drawProfessionalFootprintDetail(type, unit, tilesLong, tilesCross, bodyColor, hl, hc, visualState, rotation, flipped)) {
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
