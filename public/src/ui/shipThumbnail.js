// Bakes a whole ship blueprint into a small preview image (data URL) by replaying
// the same Canvas 2D module art the arena uses, so saved-blueprint cards show an
// accurate top-down picture of the ship instead of just text. Cached by design
// signature + colour so re-rendering the library list is cheap.
//
// Keep imports explicit and side-effect-free so the native ES-module graph can
// be verified without relying on a flattened global bundle.

import { PART_DEFS, isRotatablePart } from "../design/parts.js";
import { normalizeRotation, moduleRotationToRadians } from "../design/rotation.js";
import { withCanvasContext } from "./dom.js";
import { drawShipStructure, drawModule, drawFootprintComponent } from "../game/componentArt.js";
import { moduleLocalPosition, footprintLocalPlacement } from "../game/shipGeometry.js";

const THUMB_SCALE = 13; // must match the arena's SHIP_SCALE so proportions are right
const THUMB_DPR = 2;

const shipThumbCache = new Map();

export function clearShipThumbnailCache() {
  shipThumbCache.clear();
}

function shipThumbSignature(design, color) {
  return `${color}|${design.map((p) => `${p.x},${p.y},${p.type},${normalizeRotation(p.rotation) || 0}`).join(";")}`;
}

// Renders `design` centred into a `size`x`size` (logical px) preview.
export function shipThumbnailDataUrl(design, color = "#8fb4ff", size = 84) {
  if (!Array.isArray(design) || design.length === 0) return "";
  const key = `${shipThumbSignature(design, color)}|${size}`;
  const cached = shipThumbCache.get(key);
  if (cached !== undefined) return cached;
  let url = "";
  try {
    url = bakeShipThumb(design, color, size);
  } catch (error) {
    // Thumbnail art is optional UI decoration; a malformed component drawing
    // must not prevent purchase/saved-blueprint panels from rendering.
    console.error("Failed to render ship thumbnail", error);
  }
  shipThumbCache.set(key, url);
  return url;
}

function bakeShipThumb(design, color, size) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") return "";
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(size * THUMB_DPR);
  canvas.height = Math.round(size * THUMB_DPR);
  if (typeof canvas.toDataURL !== "function") return "";
  const tctx = canvas.getContext("2d");
  if (!tctx || typeof tctx.setTransform !== "function") return "";

  // Bounding box of the design in local ship pixels.
  let maxAbs = THUMB_SCALE;
  for (const part of design) {
    const { x, y } = moduleLocalPosition(part, THUMB_SCALE);
    maxAbs = Math.max(maxAbs, Math.abs(x), Math.abs(y));
  }
  const pad = THUMB_SCALE * 1.6 + 8;
  const half = maxAbs + pad;
  const fit = (size / 2) / half;

  withCanvasContext(tctx, () => {
    tctx.setTransform(THUMB_DPR, 0, 0, THUMB_DPR, 0, 0);
    tctx.clearRect(0, 0, size, size);
    tctx.save();
    tctx.translate(size / 2, size / 2);
    tctx.scale(fit, fit);
    tctx.rotate(-Math.PI / 2); // point the nose up (designer "forward = up")

    drawShipStructure(design, THUMB_SCALE, color);
    for (const part of design) {
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const place = footprintLocalPlacement(part, THUMB_SCALE);
      tctx.save();
      tctx.translate(place.cx, place.cy);
      if (isRotatablePart(part.type)) {
        tctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
        if (place.multi) {
          drawFootprintComponent({ type: part.type, unit: THUMB_SCALE, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: color });
        } else {
          drawModule({ x: 0, y: 0, size: THUMB_SCALE, color: def.color, type: part.type, trim: color });
        }
      } else if (place.multi) {
        tctx.rotate(place.longAxisAngle);
        drawFootprintComponent({ type: part.type, unit: THUMB_SCALE, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: color });
      } else {
        if (part.type === "maneuverThruster") {
          tctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
        }
        drawModule({ x: 0, y: 0, size: THUMB_SCALE, color: def.color, type: part.type, trim: color });
      }
      tctx.restore();
    }
    tctx.restore();
  });

  try {
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}
