// Structural plates, partial silhouettes, armour materials, and hull spines.

import { ctx } from "../../ui/dom.js";
import { moduleRotationToRadians, normalizeRotation } from "../../design/rotation.js";
import { qualityShadowBlur } from "../renderSettings.js";
import { moduleLocalPosition } from "../shipGeometry.js";
import {
  drawComponentPort,
  drawFootprintPort,
  flippedScaleX,
  mixColor,
  roundRect
} from "./common.js";

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

export const ABLATIVE_PARTS = new Set([
  "ablativeArmor", "halfAblativeArmorDiagonal", "wingAblativeArmor",
  "bevelAblativeArmor", "roundedAblativeArmor", "longWedgeAblativeArmor"
]);

export const REFRACTORY_PARTS = new Set([
  "refractoryArmor", "halfRefractoryArmorDiagonal", "wingRefractoryArmor",
  "bevelRefractoryArmor", "roundedRefractoryArmor", "longWedgeRefractoryArmor"
]);

export const LEGACY_PARTIAL_SHAPE_PARTS = new Set([
  "halfFrameDiagonal", "halfArmorDiagonal", "halfCompositeArmorDiagonal",
  "wingFrame", "wingArmor", "wingCompositeArmor",
  "bevelFrame", "bevelArmor", "bevelCompositeArmor",
  "roundedFrame", "roundedArmor", "roundedCompositeArmor",
  "halfAblativeArmorDiagonal", "wingAblativeArmor",
  "bevelAblativeArmor", "roundedAblativeArmor"
]);

export function drawArmorLaminate(size, color, composite, fine) {
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

export function drawAblativeSpallPlating(size, color, fine) {
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

export function drawClippedAblativeFace(size, color, fine, outline) {
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


export function drawStructureModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

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

  return false;
}

export function drawStructureFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

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

  return false;
}


export function drawAblativeHotEdge(size, describe) {
  ctx.strokeStyle = "rgba(255,168,96,0.6)";
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.beginPath();
  describe();
  ctx.stroke();
}

export function drawRefractoryTiles(size, color, fine) {
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

export function drawRefractoryColdEdge(size, describe) {
  ctx.strokeStyle = "rgba(214,240,255,0.6)";
  ctx.lineWidth = Math.max(1, size * 0.06);
  ctx.beginPath();
  describe();
  ctx.stroke();
}

export function drawFrameBracing(size, fine, reach = 0.34) {
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

export function drawArmorRivets(size, color, corners) {
  const rivet = mixColor(color, "#ffffff", 0.55);
  for (const [x, y] of corners) drawComponentPort(size, x, y, 0.05, rivet, 0.5);
}

export function withRotatedShape(size, rotation, outline, drawMaterial, drawEdge, flipped = false) {
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
