// Renderer-neutral ship dynamics presentation state: derived thrust/speed
// ratios, live engine-nozzle filtering, engine-smoke particle simulation,
// maneuvering-jet computation, and the ship HUD lag values. Pure state + math
// (no Canvas, no Pixi, no DOM); the Pixi arena renderer consumes these and draws the
// results with their own primitives.

import { state } from "../state.js";
import { clamp, approach } from "../shared/math.js";
import { computeStats } from "../design/componentStats.js";
import { PART_STATS } from "../design/parts.js";
import { calculateCenterOfMass, maneuverThrusterTorqueSign } from "../shared/movementStats.js";
import { getEffectDensity } from "./renderSettings.js";
import { footprintLocalPlacement } from "./shipGeometry.js";
import { componentHealthRatio } from "./shipVitals.js";

const renderedDesignStatsCache = new WeakMap();

export function maxSpeedForRenderedShip(ship) {
  if (ship?.stats?.maxSpeed) return ship.stats.maxSpeed;
  const design = ship?.design;
  if (!Array.isArray(design)) return 180;
  let stats = renderedDesignStatsCache.get(design);
  if (!stats) {
    stats = computeStats(design);
    renderedDesignStatsCache.set(design, stats);
  }
  return stats.maxSpeed || 180;
}

export function engineThrustRatio(ship) {
  if (!ship?.alive) return 0;
  const angle = Number(ship.angle) || 0;
  const forwardX = Math.cos(angle);
  const forwardY = Math.sin(angle);
  const vx = Number(ship.vx) || 0;
  const vy = Number(ship.vy) || 0;
  const speed = Math.hypot(vx, vy);
  const maxSpeed = Math.max(90, maxSpeedForRenderedShip(ship));
  const forwardSpeed = vx * forwardX + vy * forwardY;
  const speedRatio = clamp(Math.max(0, forwardSpeed) / maxSpeed, 0, 1);

  const tx = Number.isFinite(ship.targetX) ? ship.targetX : ship.x;
  const ty = Number.isFinite(ship.targetY) ? ship.targetY : ship.y;
  const dx = tx - ship.x;
  const dy = ty - ship.y;
  const dist = Math.hypot(dx, dy);
  let commandedRatio = 0;
  if (dist > Math.max(28, (ship.radius || 30) * 0.35)) {
    const align = clamp((dx * forwardX + dy * forwardY) / dist, 0, 1);
    const distanceRamp = clamp(dist / 190, 0.2, 1);
    commandedRatio = align * distanceRamp;
  }

  const driftGlow = speed > 14 ? 0.1 : 0;
  return clamp(Math.max(speedRatio, commandedRatio, driftGlow), 0, 1);
}

// Destroyed engines are dead metal: no plume, no smoke. Filters a nozzle list
// against the ship's live component hp.
export function aliveEngineNozzles(ship, nozzles) {
  if (!Array.isArray(nozzles) || nozzles.length === 0 || !ship?.chp) return nozzles || [];
  const blocked = new Set(ship.engBlocked || []);
  return nozzles.filter((nozzle) => {
    if (blocked.has(nozzle.index)) return false;
    const ratio = componentHealthRatio(ship, nozzle.index);
    return ratio === null || ratio > 0;
  });
}

export function emitEngineSmoke(ship, nozzles, scale = 13, now = performance.now()) {
  const intensity = engineThrustRatio(ship);
  if (intensity < 0.18 || !Array.isArray(nozzles) || nozzles.length === 0) return;
  if (!state.engineSmoke) state.engineSmoke = [];
  if (!state.engineSmokeEmitters) state.engineSmokeEmitters = new Map();

  const angle = Number(ship.angle) || 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const vx = Number(ship.vx) || 0;
  const vy = Number(ship.vy) || 0;
  // Slightly less smoke overall, thinned further on lower graphics settings by
  // stretching the emit cadence (fewer puffs) as density drops.
  const density = getEffectDensity();
  const cadence = (125 - intensity * 58) / Math.max(0.2, density);
  const shipKey = String(ship.id || "ship");

  for (let i = 0; i < nozzles.length; i += 1) {
    const key = `${shipKey}:${i}`;
    const last = state.engineSmokeEmitters.get(key) || 0;
    if (now - last < cadence) continue;
    state.engineSmokeEmitters.set(key, now);

    const nz = nozzles[i];
    const jitter = (Math.random() - 0.5) * nz.halfW * 0.9;
    const nozzleAngle = nz.angle || 0;
    const exhaustX = -Math.cos(nozzleAngle), exhaustY = -Math.sin(nozzleAngle);
    const crossX = -exhaustY, crossY = exhaustX;
    const offset = nz.halfW * (0.9 + intensity * 1.4);
    const localX = nz.x + exhaustX * offset + crossX * jitter;
    const localY = nz.y + exhaustY * offset + crossY * jitter;
    const wx = ship.x + localX * cos - localY * sin;
    const wy = ship.y + localX * sin + localY * cos;
    const push = 26 + intensity * 74;
    const worldExhaustX = exhaustX * cos - exhaustY * sin;
    const worldExhaustY = exhaustX * sin + exhaustY * cos;
    state.engineSmoke.push({
      x: wx,
      y: wy,
      vx: vx * 0.18 + worldExhaustX * push + (Math.random() - 0.5) * 14,
      vy: vy * 0.18 + worldExhaustY * push + (Math.random() - 0.5) * 14,
      radius: Math.max(3.2, scale * (0.18 + intensity * 0.34)),
      alpha: 0.14 + intensity * 0.18,
      createdAt: now,
      life: 1900 + Math.random() * 900
    });
  }

  if (state.engineSmoke.length > 560) {
    state.engineSmoke.splice(0, state.engineSmoke.length - 560);
  }
}

export function activeEngineSmoke(now = performance.now()) {
  if (!state.engineSmoke) state.engineSmoke = [];
  const visible = [];
  const kept = [];
  for (const smoke of state.engineSmoke) {
    const age = now - smoke.createdAt;
    const life = smoke.life || 2200;
    const t = age / life;
    if (t >= 1) continue;
    kept.push(smoke);
    const drift = age / 1000;
    const fade = Math.pow(1 - t, 1.65);
    visible.push({
      x: smoke.x + smoke.vx * drift,
      y: smoke.y + smoke.vy * drift,
      radius: smoke.radius * (1 + t * 2.2),
      alpha: smoke.alpha * fade
    });
  }
  state.engineSmoke = kept;
  return visible;
}

// Tracks each ship's angular velocity between frames so maneuvering thrusters
// can fire only while the hull is actually rotating.
function shipAngularVelocity(ship, now) {
  if (!state.shipAngTrack) state.shipAngTrack = new Map();
  const prev = state.shipAngTrack.get(ship.id);
  let av = 0;
  if (prev && now > prev.t) {
    let d = ship.angle - prev.a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    av = d / ((now - prev.t) / 1000);
  }
  state.shipAngTrack.set(ship.id, { a: ship.angle, t: now });
  return av;
}

// Computes the lateral thruster jets to draw this frame (ship-local space,
// forward = +x). Jets fire only while the hull is rotating; each maneuvering
// thruster offset from the centreline pulses fore/aft to match the turn
// direction, so only the thrusters "being used" animate. Shared by both
// renderers. Returns null when nothing should draw.
export function computeManeuverJets(ship, design, scale, now) {
  const activity = Number.isFinite(ship.turnActivity) ? clamp(ship.turnActivity, -1, 1) : 0;
  const speed = Math.abs(activity);
  if (speed < 0.01 || !ship.alive) return null;
  const desiredSign = Math.sign(activity);
  const density = getEffectDensity();
  const flicker = 0.7 + 0.3 * Math.sin(now * 0.05);
  const centerOfMass = calculateCenterOfMass(design, PART_STATS);
  const contributors = [];
  let total = 0;
  for (let i = 0; i < design.length; i += 1) {
    const module = design[i];
    if (module.type !== "maneuverThruster") continue;
    if ((componentHealthRatio(ship, i) ?? 1) <= 0) continue;
    if (maneuverThrusterTorqueSign(module, centerOfMass) !== desiredSign) continue;
    const localY = Math.abs((Number(module.y) || 0) - centerOfMass.y);
    const value = Math.max(0.001, localY);
    contributors.push({ index: i, module, value });
    total += value;
  }
  const jets = [];
  for (const contributor of contributors) {
    const place = footprintLocalPlacement(contributor.module, scale);
    const rotation = Number(contributor.module.rotation) === 270 ? 270 : 90;
    const nozzleSide = rotation === 90 ? -1 : 1;
    const share = total > 0 ? contributor.value / total : 1 / contributors.length;
    const intensity = speed * Math.min(1, share * contributors.length);
    jets.push({
      x: place.cx,
      y: place.cy + nozzleSide * scale * 0.34,
      aft: nozzleSide,
      len: clamp(intensity * 10, 2.5, 10) * flicker * (0.55 + 0.45 * density),
      plumeAlpha: 0.32 * intensity * flicker * density,
      coreAlpha: 0.58 * intensity * flicker * density
    });
  }
  return jets.length ? jets : null;
}
// Smoothed HUD hp/shield display values with the lagging "recent damage" bar.
export function updateShipHud(ship, now) {
  const previous = state.shipHud.get(ship.id) || {
    hp: ship.hp,
    shield: ship.shield,
    hpLag: ship.hp,
    shieldLag: ship.shield,
    actualHp: ship.hp,
    actualShield: ship.shield,
    hitAt: 0,
    lastHitShield: false,
    lastSeenAt: now
  };
  const dt = clamp((now - previous.lastSeenAt) / 1000, 0, 0.12);
  const shieldHit = ship.shield < previous.actualShield;
  const hullHit = ship.hp < previous.actualHp;
  const displayRate = 14 * dt;
  const lagRate = 4.4 * dt;
  const next = {
    hp: approach(previous.hp, ship.hp, displayRate),
    shield: approach(previous.shield, ship.shield, displayRate),
    hpLag: approach(previous.hpLag, ship.hp, lagRate),
    shieldLag: approach(previous.shieldLag, ship.shield, lagRate),
    actualHp: ship.hp,
    actualShield: ship.shield,
    hitAt: shieldHit || hullHit ? now : previous.hitAt,
    lastHitShield: shieldHit || (!hullHit && previous.lastHitShield),
    lastSeenAt: now
  };
  if (ship.hp > previous.actualHp) next.hpLag = Math.max(next.hpLag, ship.hp);
  if (ship.shield > previous.actualShield) next.shieldLag = Math.max(next.shieldLag, ship.shield);
  state.shipHud.set(ship.id, next);
  return next;
}
