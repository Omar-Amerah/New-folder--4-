// Bakes blueprint component icons from the same drawModule() vector art used by
// the battle arena, so the designer palette/grid/inspector stay pixel-consistent
// with what ships look like on the map. Multi-cell parts render at their footprint
// aspect ratio with a hull plate behind the single-cell emblem.

import { PART_DEFS, PART_STATS, isRotatablePart } from "../design/parts.js";
import { normalizeRotation, moduleRotationToRadians } from "../design/rotation.js";
import { withCanvasContext } from "./dom.js";
import { drawModule, drawFootprintComponent } from "../game/componentArt.js";

const CELL = 40; // logical px per footprint cell
const PAD = 0; // full cubes meet the exact blueprint-cell bounds
const DPR = 2; // bake at 2x for crisp downscaling
const EMBLEM = CELL; // regular bases occupy the full blueprint cube
const NEUTRAL_TRIM = "#e7eef8"; // edge colour (player colour is used on the map)

const iconCache = new Map();

export function clearComponentIconCache() {
  iconCache.clear();
}

// Footprint (after applying rotation) for a placed/preview part.
export function rotatedFootprint(type, rotationDeg = 0) {
  const stat = PART_STATS[type] || PART_STATS.frame;
  const base = stat.footprint || { width: 1, height: 1 };
  const w = base.width || 1;
  const h = base.height || 1;
  const rot = normalizeRotation(rotationDeg);
  const swap = rot === 90 || rot === 270;
  return { width: swap ? h : w, height: swap ? w : h };
}

// Orientation of the emblem within the icon.
function emblemAngle(type, rotationDeg) {
  const rot = normalizeRotation(rotationDeg);
  // Fixed propulsion faces ship-forward. The arena's canonical +x direction is
  // up on the blueprint, including the square maneuver-thruster footprint.
  if (type === "engine") return -Math.PI / 2;
  if (type === "maneuverThruster") return moduleRotationToRadians(rot) - Math.PI / 2;
  // Every rotatable part rotates its own art with placement (there is no separate
  // rotation marker). Weapons additionally face their firing direction, so
  // rotation 0 points forward (up in the grid); structural diagonal/wing shapes
  // rotate in their natural frame.
  if (isRotatablePart(type)) {
    const stat = PART_STATS[type] || {};
    return isWeaponPart(stat) ? moduleRotationToRadians(rot) - Math.PI / 2 : moduleRotationToRadians(rot);
  }
  // Non-rotatable parts align the emblem with the footprint's long axis so
  // elongated parts (engine, reactor, ...) point along their body.
  const { width, height } = rotatedFootprint(type, rotationDeg);
  return height > width ? -Math.PI / 2 : 0;
}

function isWeaponPart(stat) {
  return stat.category === "Weapons" || Boolean(stat.weapon);
}

// Orientation for the footprint-spanning art: align its canonical +x long axis
// with the icon's longer footprint dimension (post-rotation w/h cells).
function footprintArtAngle(type, rotationDeg, wCells, hCells) {
  const stat = PART_STATS[type] || {};
  if (isRotatablePart(type) && isWeaponPart(stat)) {
    const footprint = stat.footprint || { width: 1, height: 1 };
    const baseAngle = (footprint.width || 1) >= (footprint.height || 1) ? 0 : -Math.PI / 2;
    return baseAngle + moduleRotationToRadians(normalizeRotation(rotationDeg));
  }
  return wCells >= hCells ? 0 : -Math.PI / 2;
}

export function componentIconDataUrl(type, rotationDeg = 0) {
  const { width: w, height: h } = rotatedFootprint(type, rotationDeg);
  const key = `${type}|${w}x${h}|${normalizeRotation(rotationDeg)}`;
  const cached = iconCache.get(key);
  if (cached !== undefined) return cached;
  let url = "";
  try {
    url = bakeIcon(type, w, h, rotationDeg);
  } catch (error) {
    // One broken vector must not abort palette/grid rendering and leave the
    // Blueprint Designer in a half-cleared state. Cache the empty fallback so
    // the same bad icon cannot throw on every subsequent UI refresh.
    console.error(`Failed to render component icon: ${type}`, error);
  }
  iconCache.set(key, url);
  return url;
}

function bakeIcon(type, wCells, hCells, rotationDeg) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return "";
  const logicalW = wCells * CELL + PAD * 2;
  const logicalH = hCells * CELL + PAD * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalW * DPR);
  canvas.height = Math.round(logicalH * DPR);
  if (typeof canvas.toDataURL !== "function") return ""; // fake-DOM test sandbox
  const ictx = canvas.getContext("2d");
  if (!ictx || typeof ictx.setTransform !== "function") return "";

  const color = PART_DEFS[type]?.color || "#8393aa";
  const multi = wCells > 1 || hCells > 1;

  withCanvasContext(ictx, () => {
    ictx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ictx.clearRect(0, 0, logicalW, logicalH);

    ictx.save();
    ictx.translate(logicalW / 2, logicalH / 2);
    if (multi) {
      // Draw one footprint-spanning component (canonical frame has the long axis
      // along +x); footprintArtAngle keeps weapon facing distinct within the box.
      const tilesLong = Math.max(wCells, hCells);
      const tilesCross = Math.min(wCells, hCells);
      ictx.rotate(footprintArtAngle(type, rotationDeg, wCells, hCells));
      drawFootprintComponent({ type, unit: EMBLEM, tilesLong, tilesCross, color, trim: NEUTRAL_TRIM });
    } else {
      ictx.rotate(emblemAngle(type, rotationDeg));
      // drawModule reads the module-level ctx, which withCanvasContext has pointed here.
      drawModule({ x: 0, y: 0, size: EMBLEM, color, type, trim: NEUTRAL_TRIM });
    }
    ictx.restore();
  });

  try {
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

// Elongated casing behind multi-cell emblems, matching drawModule's material look.
function drawHullPlate(ictx, w, h, color) {
  const inset = PAD * 0.55;
  const x = inset;
  const y = inset;
  const width = w - inset * 2;
  const height = h - inset * 2;
  const radius = Math.min(width, height) * 0.26;

  const gradient = ictx.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, "rgba(255,255,255,0.16)");
  gradient.addColorStop(0.3, color);
  gradient.addColorStop(1, "rgba(8,12,20,0.94)");

  if (typeof ictx.roundRect === "function") {
    ictx.beginPath();
    ictx.roundRect(x, y, width, height, radius);
  } else {
    ictx.beginPath();
    ictx.rect(x, y, width, height);
  }
  ictx.fillStyle = gradient;
  ictx.fill();
  ictx.lineWidth = 1.4;
  ictx.strokeStyle = "rgba(231,238,248,0.5)";
  ictx.stroke();
}
