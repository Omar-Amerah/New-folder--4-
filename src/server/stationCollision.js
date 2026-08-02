"use strict";

const STATION_SHIELD_MARGIN_MULTIPLIER = 1.06;

function segmentAabbFirstHit(x0, y0, x1, y1, halfWidth, halfHeight) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let first = 0;
  let last = 1;
  for (const [start, delta, extent] of [[x0, dx, halfWidth], [y0, dy, halfHeight]]) {
    if (Math.abs(delta) < 1e-9) {
      if (start < -extent || start > extent) return -1;
      continue;
    }
    let near = (-extent - start) / delta;
    let far = (extent - start) / delta;
    if (near > far) [near, far] = [far, near];
    first = Math.max(first, near);
    last = Math.min(last, far);
    if (first > last) return -1;
  }
  return first >= 0 && first <= 1 ? first : -1;
}

function pointInsideStationPiece(x, y, piece, margin = 0) {
  const angle = Number(piece?.angle) || 0;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = x - piece.x;
  const dy = y - piece.y;
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;
  return Math.abs(localX) <= (Number(piece.halfWidth) || 0) + margin
    && Math.abs(localY) <= (Number(piece.halfHeight) || 0) + margin;
}

function segmentStationPieceBlocked(x0, y0, x1, y1, piece, margin = 0) {
  const angle = Number(piece?.angle) || 0;
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const startDx = x0 - piece.x;
  const startDy = y0 - piece.y;
  const endDx = x1 - piece.x;
  const endDy = y1 - piece.y;
  const localX0 = startDx * cos - startDy * sin;
  const localY0 = startDx * sin + startDy * cos;
  const localX1 = endDx * cos - endDy * sin;
  const localY1 = endDx * sin + endDy * cos;
  return segmentAabbFirstHit(
    localX0,
    localY0,
    localX1,
    localY1,
    Math.max(0, Number(piece.halfWidth) || 0) + margin,
    Math.max(0, Number(piece.halfHeight) || 0) + margin
  ) >= 0;
}

// Shared station segment geometry for movement navigation and weapon LOS. The
// caller chooses whether one-way launch doors count as hull; all ordinary
// collision pieces use identical rotated-box math in both systems.
function isSegmentStationClear(room, x0, y0, x1, y1, margin = 0, options = null) {
  for (const station of room?.stations || []) {
    const pieces = station?.collisionPieces || [];
    if (options?.ignoreStationContainingEndpoint
      && pieces.some((piece) => piece && !piece.door && pointInsideStationPiece(x1, y1, piece, margin))) {
      continue;
    }
    for (const piece of pieces) {
      if (!piece || (options?.ignoreDoors && piece.door)) continue;
      if (segmentStationPieceBlocked(x0, y0, x1, y1, piece, margin)) return false;
    }
  }
  return true;
}

function segmentStationHullHit(station, x0, y0, x1, y1, margin = 0) {
  let best = null;
  const padding = Math.max(0, Number(margin) || 0);
  for (const piece of station?.collisionPieces || []) {
    // The one-way launch door is a movement barrier, not visible hull plating.
    // Weapons may enter the open hangar and strike its rendered rear bulkhead.
    if (piece.door) continue;
    const angle = Number(piece.angle) || 0;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const startDx = x0 - piece.x;
    const startDy = y0 - piece.y;
    const endDx = x1 - piece.x;
    const endDy = y1 - piece.y;
    const localX0 = startDx * cos - startDy * sin;
    const localY0 = startDx * sin + startDy * cos;
    const localX1 = endDx * cos - endDy * sin;
    const localY1 = endDx * sin + endDy * cos;
    const t = segmentAabbFirstHit(
      localX0,
      localY0,
      localX1,
      localY1,
      Math.max(0, Number(piece.halfWidth) || 0) + padding,
      Math.max(0, Number(piece.halfHeight) || 0) + padding
    );
    if (t < 0 || (best && t >= best.t)) continue;
    best = {
      t,
      x: x0 + (x1 - x0) * t,
      y: y0 + (y1 - y0) * t,
      piece,
      geometry: "station-hull"
    };
  }
  return best;
}

function nearestStationHullPoint(x, y, station) {
  let best = null;
  let bestDistSq = Infinity;
  for (const piece of station?.collisionPieces || []) {
    if (piece.door) continue;
    const angle = Number(piece.angle) || 0;
    const cos = Math.cos(-angle);
    const sin = Math.sin(-angle);
    const dx = x - piece.x;
    const dy = y - piece.y;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const nearestX = Math.max(-piece.halfWidth, Math.min(piece.halfWidth, localX));
    const nearestY = Math.max(-piece.halfHeight, Math.min(piece.halfHeight, localY));
    const worldCos = Math.cos(angle);
    const worldSin = Math.sin(angle);
    const worldX = piece.x + nearestX * worldCos - nearestY * worldSin;
    const worldY = piece.y + nearestX * worldSin + nearestY * worldCos;
    const worldDx = worldX - x;
    const worldDy = worldY - y;
    const distSq = worldDx * worldDx + worldDy * worldDy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = { x: worldX, y: worldY, distance: Math.sqrt(distSq), piece };
    }
  }
  return best || {
    x: Number(station?.x) || x,
    y: Number(station?.y) || y,
    distance: Math.hypot((Number(station?.x) || x) - x, (Number(station?.y) || y) - y),
    piece: null
  };
}

function computeStationShieldCollisionRadius(station) {
  let furthestSq = 0;
  for (const piece of station?.collisionPieces || []) {
    const angle = Number(piece.angle) || 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const localX = sx * (Number(piece.halfWidth) || 0);
        const localY = sy * (Number(piece.halfHeight) || 0);
        const worldX = piece.x + localX * cos - localY * sin;
        const worldY = piece.y + localX * sin + localY * cos;
        const dx = worldX - station.x;
        const dy = worldY - station.y;
        furthestSq = Math.max(furthestSq, dx * dx + dy * dy);
      }
    }
  }
  return Math.sqrt(furthestSq) * STATION_SHIELD_MARGIN_MULTIPLIER;
}

function stationShieldCollisionRadius(station) {
  const stored = Number(station?.shieldRadius);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return computeStationShieldCollisionRadius(station);
}

module.exports = {
  STATION_SHIELD_MARGIN_MULTIPLIER,
  segmentStationHullHit,
  isSegmentStationClear,
  nearestStationHullPoint,
  computeStationShieldCollisionRadius,
  stationShieldCollisionRadius
};
