"use strict";

const { shipHullCircles } = require("../componentGeometry");
const { buildHomeStationGeometry, buildRelayStationGeometry } = require("../stationTemplates");

// Authored template geometry, measured once at module load rather than per
// station: it depends only on the design, never on where a station stands.
const homeStationGeometry = buildHomeStationGeometry();
const relayStationGeometry = buildRelayStationGeometry();

function rotatePoint(px, py, cos, sin) {
  return { x: px * cos - py * sin, y: px * sin + py * cos };
}

// Compound collision pieces in world space: an oriented box per authored hull
// section plus one-way mouth doors for each authored launch corridor. The
// three hangar openings are deliberately not among the hull pieces, so ships
// can travel through genuine gaps in the station.
function stationCollisionPieces(station) {
  const geometry = station.stationType === "home" ? homeStationGeometry : relayStationGeometry;
  const cos = Math.cos(station.angle);
  const sin = Math.sin(station.angle);
  const toPiece = (rect, door, bayIndex = null) => {
    const cx = (rect.minX + rect.maxX) / 2;
    const cy = (rect.minY + rect.maxY) / 2;
    const centre = rotatePoint(cx, cy, cos, sin);
    return {
      x: station.x + centre.x,
      y: station.y + centre.y,
      halfWidth: (rect.maxX - rect.minX) / 2,
      halfHeight: (rect.maxY - rect.minY) / 2,
      angle: station.angle,
      // Stations never move, so the rotation into and out of the piece's local
      // frame is fixed. Collision resolution runs per ship per separation
      // iteration; deriving these trigonometrically each time was pure waste.
      cos: cos,
      sin: sin,
      // Broad-phase circle so spatial queries can reject quickly.
      radius: Math.hypot(rect.maxX - rect.minX, rect.maxY - rect.minY) / 2,
      door: Boolean(door),
      bayIndex: door ? bayIndex : undefined
    };
  };
  const pieces = geometry.collisionRects.map((rect) => toPiece(rect, false));
  if (Array.isArray(geometry.doorRects)) {
    geometry.doorRects.forEach((rect, index) => pieces.push(toPiece(rect, true, index)));
  } else if (geometry.doorRect) {
    pieces.push(toPiece(geometry.doorRect, true, null));
  }
  return pieces;
}

// True when a circle of `radius` at world (x, y) overlaps any solid station
// piece. Used by collision, navigation and launch-clearance checks alike.
function stationOverlapsCircle(station, x, y, radius) {
  const cos = Math.cos(-station.angle);
  const sin = Math.sin(-station.angle);
  const dx = x - station.x;
  const dy = y - station.y;
  // Into structure-local space, where every piece is axis aligned.
  const local = rotatePoint(dx, dy, cos, sin);
  const geometry = station.stationType === "home" ? homeStationGeometry : relayStationGeometry;
  for (const rect of geometry.collisionRects) {
    const nearestX = Math.max(rect.minX, Math.min(rect.maxX, local.x));
    const nearestY = Math.max(rect.minY, Math.min(rect.maxY, local.y));
    const ox = local.x - nearestX;
    const oy = local.y - nearestY;
    if (ox * ox + oy * oy <= radius * radius) return true;
  }
  return false;
}

function resolveStationCollision(
  room,
  ship,
  shipRadius,
  onContact = null,
  maxCorrection = Number.POSITIVE_INFINITY
) {
  if (!room?.stations?.length) return false;
  const staticContactEpsilon = 0.5;
  const shipX = ship.x || 0;
  const shipY = ship.y || 0;
  let hit = false;
  const contacts = [];
  for (let stationIndex = 0; stationIndex < room.stations.length; stationIndex += 1) {
    const station = room.stations[stationIndex];
    if (!station?.collisionPieces?.length) continue;
    // station.radius already bounds every solid piece. Almost every ship on the
    // map is nowhere near a given structure, and this runs for each of them on
    // each separation iteration, so reject the whole station in one test before
    // walking its pieces.
    const reach = (Number(station.radius) || 0) + shipRadius;
    const stationDx = shipX - station.x;
    const stationDy = shipY - station.y;
    if (stationDx * stationDx + stationDy * stationDy > reach * reach) continue;
    // Only the hull this station is currently launching gets an own-station
    // collision exemption, and only while it is still clearing its corridor.
    // Every other ship - including the launched ship the moment it is released
    // - collides with the solid hull and the one-way mouth doors normally.
    const launching = Boolean(ship.launchPhase) && ship.launchPhase.stationId === station.id;
    // During the controlled launch window the ship is allowed to overlap its
    // own station geometry. This is what lets the historical three-cell bays
    // release a maximum-size hull without trapping it in a divider or rear
    // bulkhead. The exemption ends exactly at the recorded release plane.
    if (launching) continue;
    const circles = Array.isArray(ship.design) && ship.design.length
      ? shipHullCircles(ship)
      : [{ x: ship.x || 0, y: ship.y || 0, radius: shipRadius }];
    for (const circle of circles) {
      for (let pieceIndex = 0; pieceIndex < station.collisionPieces.length; pieceIndex += 1) {
        const piece = station.collisionPieces[pieceIndex];
      const cos = piece.cos !== undefined ? piece.cos : Math.cos(-piece.angle);
      const sin = piece.sin !== undefined ? -piece.sin : Math.sin(-piece.angle);
      const local = rotatePoint(circle.x - piece.x, circle.y - piece.y, cos, sin);
      const halfW = piece.halfWidth;
      const halfH = piece.halfHeight;
      const circleRadius = Number(circle.radius) || shipRadius;
      const nearestX = Math.max(-halfW, Math.min(halfW, local.x));
      const nearestY = Math.max(-halfH, Math.min(halfH, local.y));
      const lx = local.x - nearestX;
      const ly = local.y - nearestY;
      const dist2 = lx * lx + ly * ly;
      let nx = 0;
      let ny = 0;
      let penetration = 0;
      if (dist2 < 0.0001) {
        // Ship centre is inside the rectangle; exit through the closest face.
        const left = local.x + halfW;
        const right = halfW - local.x;
        const top = local.y + halfH;
        const bottom = halfH - local.y;
        const minDist = Math.min(left, right, top, bottom);
        // The hull must travel from its centre to the nearest face, then one
        // full radius farther so the circle clears the solid piece.
        penetration = minDist + circleRadius;
        if (minDist === left) { nx = -1; ny = 0; }
        else if (minDist === right) { nx = 1; ny = 0; }
        else if (minDist === top) { nx = 0; ny = -1; }
        else { nx = 0; ny = 1; }
      } else {
        const dist = Math.sqrt(dist2);
        if (dist > circleRadius + staticContactEpsilon) continue;
        penetration = Math.max(0, circleRadius - dist);
        const inv = 1 / dist;
        nx = lx * inv;
        ny = ly * inv;
      }
      const worldCos = piece.cos !== undefined ? piece.cos : Math.cos(piece.angle);
      const worldSin = piece.sin !== undefined ? piece.sin : Math.sin(piece.angle);
      const worldN = rotatePoint(nx, ny, worldCos, worldSin);
      const inwardSpeed = (ship.vx || 0) * worldN.x + (ship.vy || 0) * worldN.y;
      if (inwardSpeed < 0) {
        ship.vx -= inwardSpeed * worldN.x;
        ship.vy -= inwardSpeed * worldN.y;
      }
      contacts.push({
        obstacleId: `station:${String(station.id ?? stationIndex)}:${String(piece.id ?? pieceIndex)}`,
        normalX: worldN.x,
        normalY: worldN.y,
        penetration
      });
      hit = true;
      }
    }
  }

  // A compound ship can expose many hull cells to the same station wall. The
  // old loop translated the ship once per cell, so three touching cells could
  // turn one shallow wall contact into three sequential displacements. Keep
  // the deepest contact for aligned normals, and combine only independent
  // directions such as a genuine corner contact. Opposing normals are
  // incompatible (the hull is trapped between faces), so retain the deepest
  // side and let the next authoritative step continue the recovery.
  const normalGroups = [];
  for (const contact of contacts) {
    if (!(Number(contact.penetration) > 0)) continue;
    const nx = Number(contact.normalX) || 0;
    const ny = Number(contact.normalY) || 0;
    const group = normalGroups.find((candidate) => (
      candidate.normalX * nx + candidate.normalY * ny >= 0.98
    ));
    if (!group) {
      normalGroups.push({ ...contact, normalX: nx, normalY: ny });
    } else if (contact.penetration > group.penetration) {
      group.penetration = contact.penetration;
    }
  }
  normalGroups.sort((a, b) => b.penetration - a.penetration);
  let correctionX = 0;
  let correctionY = 0;
  for (const group of normalGroups) {
    const candidateX = group.normalX * group.penetration;
    const candidateY = group.normalY * group.penetration;
    const existingLength = Math.hypot(correctionX, correctionY);
    const candidateLength = Math.hypot(candidateX, candidateY);
    if (existingLength > 0.001
      && correctionX * candidateX + correctionY * candidateY
        < -0.25 * existingLength * candidateLength) continue;
    correctionX += candidateX;
    correctionY += candidateY;
  }
  if (correctionX !== 0 || correctionY !== 0) {
    const correctionLength = Math.hypot(correctionX, correctionY);
    const correctionLimit = Math.max(0, Number(maxCorrection));
    if (Number.isFinite(correctionLimit) && correctionLength > correctionLimit && correctionLength > 0) {
      const scale = correctionLimit / correctionLength;
      correctionX *= scale;
      correctionY *= scale;
    }
    ship.x += correctionX;
    ship.y += correctionY;
    ship._collisionCorrectionX = (ship._collisionCorrectionX || 0) + correctionX;
    ship._collisionCorrectionY = (ship._collisionCorrectionY || 0) + correctionY;
  }
  if (typeof onContact === "function") {
    for (const contact of contacts) onContact(contact);
  }
  return hit;
}

module.exports = {
  stationCollisionPieces,
  stationOverlapsCircle,
  resolveStationCollision
};
