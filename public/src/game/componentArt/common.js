// Shared component-art drawing primitives and the sole module-gradient cache owner.

import { ctx } from "../../ui/dom.js";
import { qualityShadowBlur } from "../renderSettings.js";
import "../../shared/componentTransform.js";

export const flippedScaleX = (flipped) => globalThis.ComponentTransform.artFlipScaleX(flipped);

const moduleGradientCache = new WeakMap();

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

export function parseColor(color) {
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

export function mixColor(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r},${g},${bl})`;
}

export function saturate(color, amount) {
  const { r, g, b } = parseColor(color);
  const grey = r * 0.299 + g * 0.587 + b * 0.114;
  const ch = (v) => Math.max(0, Math.min(255, Math.round(grey + (v - grey) * (1 + amount))));
  return `rgb(${ch(r)},${ch(g)},${ch(b)})`;
}

export function withLightness(color, lightness) {
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

export function colorLightness(color) {
  const { r, g, b } = parseColor(color);
  return (Math.max(r, g, b) + Math.min(r, g, b)) / 510;
}

export function getModuleGradient(size, color) {
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

export function drawPlateBody(size, inset = 0.44, radius = size * 0.12) {
  const s = size * inset;
  roundRect(ctx, { x: -s, y: -s, width: s * 2, height: s * 2, radius });
  ctx.fill();
  ctx.stroke();
  bevelRoundedPlate(size, inset, radius);
}

export function drawComponentCubeBase(size, color) {
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

export function drawRecessedPanel(size, width = 0.68, height = 0.68, radius = 0.08) {
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

export function drawComponentPort(size, x, y, radius, accent, innerScale = 0.45) {
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


export function drawGenericFootprintMachine(type, unit, tilesLong, color, hl, hc) {
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


export function bevelRoundedPlate(size, inset, radius) {
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

export function drawCellStack(unit, { xs, halfWidth, top, bottom, casing, edge, hot, cool, fine }) {
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

export function drawCapacitorPlatePair(unit, centerX, gapHalf, halfHeight, fine, plateThickness = unit * 0.17) {
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

export function drawFootprintSeams(unit, hl, hc, tilesLong) {
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

export function drawFootprintPanel(unit, hl, hc, widthScale = 0.9, heightScale = 0.68, radiusScale = 0.1) {
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

export function drawFootprintPlate(unit, hl, hc, color) {
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

export function drawFootprintPort(unit, x, y, radius, accent) {
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

export function drawFootprintMachineFrame(unit, hl, hc, accent, options = {}) {
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
