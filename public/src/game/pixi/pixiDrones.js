// Lightweight transient Drone entities. They deliberately avoid ship chrome:
// no name, selection ring, fleet marker, or normal ship health bar. Each drone
// is drawn as a miniature craft in the same lit-plate material language as the
// hull modules that launch it: a diagonal top-left->bottom-right body gradient,
// a dark structural edge, a thin team-colour rim light, and a bright role port.

import { state } from "../../state.js";
import { isCircleVisible } from "../viewportCulling.js";

let views = new Map();
let productionBars = null;
let trails = null;
let renderedProductionBarCount = 0;
let renderedPausedBarCount = 0;
let renderedRangeRings = [];

// Nominal silhouette size in world units before per-drone visual scaling.
const DRONE_SIZE = 16;

// Cached body gradients keyed by role colour (persist across renderer lifetimes,
// like the ship gradient cache — a handful of entries at most).
const bodyGradients = new Map();

function droneColors(type) {
  if (type === "defence") return { body: 0x67e8f9, core: 0xe0f2fe, trail: 0x22d3ee };
  if (type === "repair") return { body: 0x86efac, core: 0xecfdf5, trail: 0x22c55e };
  return { body: 0xfb7185, core: 0xffe4e6, trail: 0xf43f5e };
}

function droneRangeColor(type) {
  if (type === "defence") return 0x22d3ee;
  if (type === "repair") return 0x4ade80;
  return 0xfb7185;
}

function mixHex(a, b, t) {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

// Mirrors getModuleGradient() from the hull art: light top-left highlight down
// to a near-black bottom-right seam, so a drone reads as a lit plate, not a
// flat icon.
function bodyGradient(env, color) {
  let gradient = bodyGradients.get(color);
  if (!gradient) {
    gradient = new env.PIXI.FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 1, y: 1 },
      colorStops: [
        { offset: 0, color: mixHex(color, 0xffffff, 0.52) },
        { offset: 0.32, color: mixHex(color, 0xffffff, 0.16) },
        { offset: 0.6, color },
        { offset: 1, color: mixHex(color, 0x05070c, 0.72) }
      ],
      textureSpace: "local"
    });
    bodyGradients.set(color, gradient);
  }
  return gradient;
}

// Silhouette paths, local +x = forward (matches ship/weapon convention).
// Deliberately chunky, faceted hulls — blunt fronts, rectangular cores and
// hard-edged wings — so each drone reads as a small blocky craft.
function buildDronePath(gfx, type, s) {
  if (type === "defence") {
    // Blocky guardian bastion: a blunt vertical prow and a hexagonal body.
    gfx.moveTo(s * 0.46, -s * 0.18);
    gfx.lineTo(s * 0.46, s * 0.18);
    gfx.lineTo(s * 0.04, s * 0.42);
    gfx.lineTo(-s * 0.42, s * 0.26);
    gfx.lineTo(-s * 0.42, -s * 0.26);
    gfx.lineTo(s * 0.04, -s * 0.42);
    gfx.closePath();
  } else if (type === "repair") {
    // Two crossed service booms with hard, square corners.
    gfx.rect(-s * 0.36, -s * 0.14, s * 0.72, s * 0.28);
    gfx.rect(-s * 0.14, -s * 0.36, s * 0.28, s * 0.72);
  } else {
    // Blocky gunship: blunt nose, rectangular engine block, hard-edged wings.
    gfx.moveTo(s * 0.5, -s * 0.13);
    gfx.lineTo(s * 0.5, s * 0.13);
    gfx.lineTo(s * 0.04, s * 0.2);
    gfx.lineTo(-s * 0.04, s * 0.44);
    gfx.lineTo(-s * 0.26, s * 0.44);
    gfx.lineTo(-s * 0.2, s * 0.16);
    gfx.lineTo(-s * 0.4, s * 0.16);
    gfx.lineTo(-s * 0.4, -s * 0.16);
    gfx.lineTo(-s * 0.2, -s * 0.16);
    gfx.lineTo(-s * 0.26, -s * 0.44);
    gfx.lineTo(-s * 0.04, -s * 0.44);
    gfx.lineTo(s * 0.04, -s * 0.2);
    gfx.closePath();
  }
}

// A single top-edge highlight, echoing the light top-left bevel every hull plate
// carries so all three drone types sit in the same lighting.
function drawDroneHighlight(gfx, type, s) {
  if (type === "repair") {
    gfx.moveTo(-s * 0.3, -s * 0.12);
    gfx.lineTo(s * 0.3, -s * 0.12);
  } else {
    const topY = type === "defence" ? -s * 0.34 : -s * 0.26;
    gfx.moveTo(s * 0.45, -s * 0.02);
    gfx.lineTo(-s * 0.28, topY);
  }
  gfx.stroke({ width: Math.max(0.7, s * 0.05), color: 0xffffff, alpha: 0.3 });
}

function drawPort(gfx, x, y, r, accent) {
  gfx.circle(x, y, r);
  gfx.fill({ color: 0x030a12, alpha: 0.9 });
  gfx.circle(x, y, r * 0.5);
  gfx.fill(accent);
}

function drawDrone(env, view, drone, player) {
  const gfx = view.gfx;
  const colors = droneColors(drone.type);
  const teamColor = player?.color || colors.core;
  const s = DRONE_SIZE;
  gfx.clear();

  // Lit body + dark structural edge.
  buildDronePath(gfx, drone.type, s);
  gfx.fill(bodyGradient(env, colors.body));
  gfx.stroke({ width: Math.max(1, s * 0.09), color: 0x05070c, alpha: 0.85 });

  // Thin team-colour rim light for friend/foe identity — an edge, not a ring.
  buildDronePath(gfx, drone.type, s);
  gfx.stroke({ width: Math.max(0.8, s * 0.05), color: teamColor, alpha: 0.85 });

  drawDroneHighlight(gfx, drone.type, s);

  // Signature accent per role: defence carries a forward shield arc. Seed the
  // arc with a moveTo to its start point — otherwise Pixi connects it to the
  // leftover current point (the highlight endpoint) with a stray line.
  if (drone.type === "defence") {
    const arcX = s * 0.04;
    const arcR = s * 0.42;
    gfx.moveTo(arcX + Math.cos(-0.72) * arcR, Math.sin(-0.72) * arcR);
    gfx.arc(arcX, 0, arcR, -0.72, 0.72);
    gfx.stroke({ width: Math.max(1, s * 0.07), color: colors.core, alpha: 0.55 });
  }

  // Role core port and rear thruster glow.
  drawPort(gfx, s * 0.1, 0, s * 0.16, colors.core);
  gfx.circle(-s * 0.24, 0, s * 0.085);
  gfx.fill({ color: colors.trail, alpha: 0.95 });
}

function createView(env, drone) {
  const root = new env.PIXI.Container();
  const gfx = new env.PIXI.Graphics();
  root.addChild(gfx);
  env.layers.drones.addChild(root);
  const view = { root, gfx, type: null };
  views.set(drone.id, view);
  return view;
}

// Shared, cleared-each-frame layer for drone exhaust and damage smoke, kept
// beneath the drone bodies so trails read as motion, not chrome.
function ensureTrails(env) {
  if (!trails) {
    trails = new env.PIXI.Graphics();
    env.layers.drones.addChildAt(trails, 0);
  }
  return trails;
}

// Speed-scaled exhaust in the shared effect language (translucent under-stroke +
// bright core, round caps), replacing the old baked static tail stub. The plume
// is anchored to the rear thruster port in the drone's *facing* frame (not raw
// velocity) so it stays glued to the tail while the drone strafes or orbits.
function drawDroneTrail(gfx, drone, x, y, scale, zoom, damaged, now, angle = drone.angle || 0) {
  if (drone.state === "docking") return;
  const colors = droneColors(drone.type);
  const speed = Math.hypot(drone.vx || 0, drone.vy || 0);
  if (speed > 5) {
    const facingX = Math.cos(angle);
    const facingY = Math.sin(angle);
    // Start exactly at the thruster port (local -0.24 * size, rotated + scaled).
    const rear = DRONE_SIZE * 0.24 * scale;
    const sx = x - facingX * rear;
    const sy = y - facingY * rear;
    const length = Math.min(26, 7 + speed * 0.09);
    gfx.moveTo(sx, sy);
    gfx.lineTo(sx - facingX * length, sy - facingY * length);
    gfx.stroke({ width: Math.max(1.4, 3.4 / zoom), color: colors.trail, alpha: 0.22, cap: "round" });
    gfx.moveTo(sx, sy);
    gfx.lineTo(sx - facingX * length * 0.5, sy - facingY * length * 0.5);
    gfx.stroke({ width: Math.max(0.8, 1.5 / zoom), color: colors.core, alpha: 0.6, cap: "round" });
  }
  if (damaged) {
    // Failing-systems smoke: a soft, smooth pulse instead of a positional jitter.
    const puff = (3 + 2 * Math.abs(Math.sin(now * 0.02))) / zoom;
    gfx.circle(x, y, puff);
    gfx.fill({ color: 0xff6b6b, alpha: 0.2 });
  }
}

export function droneRangeCenterForShip(ship) {
  const visual = state.visualShips?.get?.(ship.id);
  const x = Number(visual?.x);
  const y = Number(visual?.y);
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, interpolated: true };
  return { x: Number(ship.x) || 0, y: Number(ship.y) || 0, interpolated: false };
}

function drawDroneRangeRings(env) {
  const gfx = env.layers.overlay;
  const zoom = Math.max(0.25, Number(state.camera?.zoom) || 1);
  const selected = state.selectedShipIds || new Set();
  const drawn = new Set();
  renderedRangeRings = [];

  for (const ship of state.snapshot?.ships || []) {
    if (!ship.alive || !selected.has(ship.id)) continue;
    const center = droneRangeCenterForShip(ship);
    for (const bay of ship.droneBays || []) {
      const radius = Number(bay.commandRange) || 0;
      if (radius <= 0 || bay.operational === false) continue;
      const key = `${ship.id}:${bay.droneType}:${radius}`;
      if (drawn.has(key)) continue;
      drawn.add(key);

      const color = droneRangeColor(bay.droneType);
      const circumference = Math.PI * 2 * radius;
      const dashLength = 9 / zoom;
      const gapLength = 7 / zoom;
      const dashCount = Math.min(240, Math.max(20, Math.floor(circumference / (dashLength + gapLength))));
      const dashAngle = (Math.PI * 2) / dashCount;
      const dashArc = dashAngle * (dashLength / (dashLength + gapLength));
      for (let index = 0; index < dashCount; index += 1) {
        const start = index * dashAngle;
        gfx.moveTo(center.x + Math.cos(start) * radius, center.y + Math.sin(start) * radius);
        gfx.arc(center.x, center.y, radius, start, start + dashArc);
      }
      gfx.stroke({ width: 1.7 / zoom, color, alpha: 0.72 });

      // Cardinal ticks distinguish this complete operating radius from a
      // directional weapon arc.
      const tick = 7 / zoom;
      for (let index = 0; index < 4; index += 1) {
        const angle = index * Math.PI / 2;
        gfx.moveTo(center.x + Math.cos(angle) * (radius - tick), center.y + Math.sin(angle) * (radius - tick));
        gfx.lineTo(center.x + Math.cos(angle) * (radius + tick), center.y + Math.sin(angle) * (radius + tick));
      }
      gfx.stroke({ width: 2 / zoom, color, alpha: 0.9 });
      renderedRangeRings.push({
        shipId: ship.id,
        type: bay.droneType,
        radius,
        degrees: 360,
        centerX: center.x,
        centerY: center.y,
        interpolated: center.interpolated
      });
    }
  }
}

function updateProductionBars(env, now, bounds) {
  if (!productionBars) {
    productionBars = new env.PIXI.Graphics();
    env.layers.drones.addChild(productionBars);
  }
  productionBars.clear();
  renderedProductionBarCount = 0;
  renderedPausedBarCount = 0;
  const selected = state.selectedShipIds || new Set();
  for (const ship of state.snapshot?.ships || []) {
    if (!selected.has(ship.id) && state.camera.zoom < 1.05) continue;
    for (const bay of ship.droneBays || []) {
      const slot = bay.slots?.find((candidate) => candidate.state === "producing");
      if (!slot || (bounds && !isCircleVisible(bay.x, bay.y, 24, bounds))) continue;
      // "low-power" means the bay is still building, just slowly, so it reads as
      // active (amber + moving scan line) rather than a hard pause.
      const lowPower = slot.pauseReason === "low-power";
      const hardPaused = Boolean(slot.pauseReason) && !lowPower;
      renderedProductionBarCount += 1;
      if (hardPaused) renderedPausedBarCount += 1;
      const width = 24;
      const x = bay.x - width / 2;
      const y = bay.y - 18;
      productionBars.roundRect(x, y, width, 4, 2);
      productionBars.fill({ color: 0x07111f, alpha: 0.86 });
      productionBars.roundRect(x + 1, y + 1, Math.max(0, (width - 2) * slot.progress), 2, 1);
      productionBars.fill({ color: slot.pauseReason ? 0xfbbf24 : 0x67e8f9, alpha: 0.95 });
      if (!hardPaused) {
        const scan = x + 1 + ((now * 0.025) % Math.max(1, width - 2));
        productionBars.rect(scan, y, 1, 4);
        productionBars.fill({ color: 0xe0f2fe, alpha: 0.55 });
      }
    }
  }
}

export function updatePixiDrones(env, now, players, bounds) {
  const trailGfx = ensureTrails(env);
  trailGfx.clear();
  const live = new Set();
  const zoom = Math.max(0.25, Number(state.camera?.zoom) || 1);
  for (const drone of state.snapshot?.drones || []) {
    live.add(drone.id);
    let view = views.get(drone.id);
    if (!view) view = createView(env, drone);
    const player = players?.get?.(drone.ownerId);
    // Use the shared render-interpolation transform (same 100ms delayed,
    // extrapolation-capped timeline as ships) so drones glide between snapshots
    // instead of jittering on each heading change.
    const vis = state.visualDrones?.get?.(drone.id);
    const x = vis ? vis.x : drone.x;
    const y = vis ? vis.y : drone.y;
    const angle = vis ? vis.angle : (drone.angle || 0);
    view.root.visible = !bounds || isCircleVisible(x, y, 24, bounds);
    if (!view.root.visible) continue;
    if (view.type !== drone.type || view.teamColor !== player?.color) {
      view.type = drone.type;
      view.teamColor = player?.color;
      drawDrone(env, view, drone, player);
    }
    view.root.position.set(x, y);
    view.root.rotation = angle;
    const launchScale = drone.state === "launching" ? 0.7 + 0.3 * (drone.stateProgress || 0) : 1;
    const damageScale = drone.maxHull > 0 ? 0.9 + 0.1 * Math.max(0, drone.hull / drone.maxHull) : 1;
    // Keep drones readable when zoomed out without letting them balloon.
    const minimumScreenScale = Math.min(1.6, Math.max(1, 0.8 / zoom));
    const scale = 1.25 * minimumScreenScale * launchScale * damageScale;
    view.root.scale.set(scale);

    const damaged = drone.maxHull > 0 && drone.hull < drone.maxHull * 0.35;
    let alpha = drone.state === "orphaned" ? 0.55 : 1;
    if (damaged) alpha *= 0.68 + 0.32 * Math.abs(Math.sin(now * 0.012));
    view.root.alpha = alpha;

    drawDroneTrail(trailGfx, drone, x, y, scale, zoom, damaged, now, angle);
  }
  for (const [id, view] of views) {
    if (live.has(id)) continue;
    view.root.parent?.removeChild(view.root);
    view.root.destroy({ children: true });
    views.delete(id);
  }
  updateProductionBars(env, now, bounds);
  drawDroneRangeRings(env);
}

export function destroyPixiDrones() {
  for (const view of views.values()) {
    view.root.parent?.removeChild(view.root);
    view.root.destroy({ children: true });
  }
  views = new Map();
  bodyGradients.clear();
  if (productionBars) {
    productionBars.parent?.removeChild(productionBars);
    productionBars.destroy();
    productionBars = null;
  }
  if (trails) {
    trails.parent?.removeChild(trails);
    trails.destroy();
    trails = null;
  }
  renderedProductionBarCount = 0;
  renderedPausedBarCount = 0;
  renderedRangeRings = [];
}

export function droneRenderDiagnostics() {
  const visible = [...views.values()].filter((view) => view.root.visible !== false);
  const scales = visible.map((view) => Number(view.root.scale?.x) || 0);
  return {
    entityViews: views.size,
    visibleEntityViews: visible.length,
    minimumEntityScale: scales.length ? Math.min(...scales) : 0,
    productionBars: renderedProductionBarCount,
    pausedProductionBars: renderedPausedBarCount,
    rangeRings: renderedRangeRings.map((ring) => ({ ...ring })),
    shipChromeCreated: false
  };
}
