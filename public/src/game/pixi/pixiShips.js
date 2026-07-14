// Ship rendering for the PixiJS arena renderer.
//
// Each ship is a persistent PixiShipView (see pixiShipView.js) with an explicit
// scene graph: a baked static hull sprite, one persistent turret sprite per
// rotating weapon, and separate damage/flash/effect/label layers. Static hull
// art is baked once (only rebuilt when the design signature, colour, radius
// bounds or bake generation change); ordinary snapshot updates only move and
// re-angle existing display objects. Turret sprites carry the authoritative
// ship-relative weapon angle, so their world direction is (hull rotation +
// turret local rotation) — the visible barrel tracks exactly what the server
// aims.

import { state } from "../../state.js";
import { clamp, approachAngle } from "../../shared/math.js";
import { PART_STATS } from "../../design/parts.js";
import { normalizeRotation } from "../../design/rotation.js";
import { isCircleVisible } from "../viewportCulling.js";
import { footprintLocalPlacement, footprintCorners } from "../shipGeometry.js";
import { componentHealthRatio, shieldRatioForShip, shieldRingRadius, hullColorForRatio } from "../shipVitals.js";
import {
  getWeaponTurnRate,
  authoritativeWeaponAngle,
  defaultWeaponRelativeAngle,
  weaponRelativeToWorld,
  rotatingWeaponIndices
} from "../weaponAim.js";
import {
  aliveEngineNozzles,
  engineThrustRatio,
  emitEngineSmoke,
  maxSpeedForRenderedShip,
  computeManeuverJets,
  updateShipHud
} from "../shipDynamics.js";
import { createPixiKeyedPool, getPixiBakeGeneration, pixiTextureDiagnostics } from "./pixiBake.js";
import {
  SHIP_SCALE,
  createPixiShipView,
  rebuildPixiShipStatic,
  setHullFrameRotation,
  pixiStaticSignature,
  acquireTurretArrowLease
} from "./pixiShipView.js";
import { getEffectDensity } from "../renderSettings.js";
import { componentFlash, activePenetrationPath, activeCoreWarning, pruneComponentDamage, hasActiveDamageVisuals, CRITICAL_RATIO, DAMAGED_RATIO } from "../componentDamage.js";

const pixiDesignSignatures = new WeakMap();
let pixiShipPool = null;
let pixiGradientCache = new Map();

function pixiDesignSignature(design) {
  let signature = pixiDesignSignatures.get(design);
  if (!signature) {
    signature = design.map((part) => `${part.x},${part.y},${part.type},${normalizeRotation(part.rotation) || 0}`).join(";");
    pixiDesignSignatures.set(design, signature);
  }
  return signature;
}

function turretDebugEnabled() {
  return typeof window !== "undefined" && window.__mfaDebugTurrets === true;
}

function forcedArrowEnabled() {
  return typeof window !== "undefined" && window.__mfaDebugTurretArrows === true;
}

function getPixiBarGradient(env, id, stops, vertical) {
  let gradient = pixiGradientCache.get(id);
  if (!gradient) {
    gradient = new env.PIXI.FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: vertical ? { x: 0, y: 1 } : { x: 1, y: 0 },
      colorStops: stops,
      textureSpace: "local"
    });
    pixiGradientCache.set(id, gradient);
  }
  return gradient;
}

function updatePixiShieldRing(view, ship, zoom) {
  const gfx = view.shieldGfx;
  gfx.clear();
  if (!ship?.alive) {
    gfx.visible = false;
    return;
  }

  const ratio = shieldRatioForShip(ship);
  if (ratio <= 0) {
    gfx.visible = false;
    return;
  }

  const ringRadius = shieldRingRadius(ship);
  const alpha = 0.12 + ratio * 0.3;
  const lineWidth = Math.max(1.7, ringRadius * 0.04) / zoom;
  const now = performance.now() * 0.001;
  const phase = now * 1.15 + pixiShieldIdPhase(ship.id);
  const segmentCount = 12;
  const step = (Math.PI * 2) / segmentCount;
  const gap = step * 0.26;
  const activeSegments = ratio * segmentCount;

  gfx.visible = true;
  gfx.circle(0, 0, ringRadius + lineWidth * 2.2);
  gfx.fill(`rgba(56,213,255,${alpha * 0.02})`);

  for (let i = 0; i < segmentCount; i += 1) {
    const fill = clamp(activeSegments - i, 0, 1);
    const start = -Math.PI / 2 + i * step + gap / 2;
    const end = start + (step - gap) * Math.max(0.14, fill);
    gfx.moveTo(Math.cos(start) * ringRadius, Math.sin(start) * ringRadius);
    gfx.arc(0, 0, ringRadius, start, end);
    gfx.stroke({
      width: lineWidth,
      color: "#38d5ff",
      alpha: fill > 0 ? alpha * (0.34 + fill * 0.66) : alpha * 0.12
    });
  }

  gfx.moveTo(Math.cos(phase) * (ringRadius + lineWidth * 0.7), Math.sin(phase) * (ringRadius + lineWidth * 0.7));
  gfx.arc(0, 0, ringRadius + lineWidth * 0.7, phase, phase + Math.PI * 0.42);
  gfx.stroke({
    width: Math.max(1, lineWidth * 0.44),
    color: "#e0faff",
    alpha: alpha * (0.5 + Math.sin(now * 4 + ratio * 5) * 0.12)
  });

  gfx.circle(0, 0, ringRadius - lineWidth * 1.1);
  gfx.stroke({ width: Math.max(1, lineWidth * 0.35), color: "#9ff4ff", alpha: alpha * 0.2 });
}

function pixiShieldIdPhase(id) {
  const source = String(id || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) hash = (hash + source.charCodeAt(i) * (i + 1)) % 628;
  return hash / 100;
}

function tracePoly(gfx, corners) {
  gfx.moveTo(corners[0].x, corners[0].y);
  gfx.lineTo(corners[1].x, corners[1].y);
  gfx.lineTo(corners[2].x, corners[2].y);
  gfx.lineTo(corners[3].x, corners[3].y);
  gfx.closePath();
}

// Persistent status tints over damaged/critical/destroyed components. Redrawn
// only when the quantized damage signature changes. Drawn in the DamageOverlay
// layer (a child of HullContainer), i.e. in hull-rotated ship-local space.
function updatePixiComponentDamage(view, ship, design) {
  const gfx = view.damageOverlay;
  if (!ship.chp) {
    if (view.damageSig !== null) {
      gfx.clear();
      view.damageSig = null;
    }
    return;
  }

  const overlay = Boolean(state.componentDamageView);
  const shows = (ratio) => ratio !== null && (ratio < DAMAGED_RATIO || (overlay && ratio < 0.999));
  let sig = overlay ? "V|" : "";
  for (let i = 0; i < design.length; i += 1) {
    const ratio = componentHealthRatio(ship, i);
    if (!shows(ratio)) continue;
    sig += `${i}:${ratio <= 0 ? "x" : Math.round(ratio * 10)};`;
  }
  if (sig === view.damageSig) return;
  view.damageSig = sig;
  gfx.clear();
  if (!sig || sig === "V|") return;

  for (let i = 0; i < design.length; i += 1) {
    const ratio = componentHealthRatio(ship, i);
    if (!shows(ratio)) continue;
    const part = design[i];
    const place = footprintLocalPlacement(part, SHIP_SCALE);
    const halfW = (place.tilesLong * SHIP_SCALE) / 2;
    const halfH = (place.tilesCross * SHIP_SCALE) / 2;
    const corners = footprintCorners(place, halfW, halfH);
    const pt = corners[4];
    tracePoly(gfx, corners);

    if (ratio <= 0) {
      gfx.fill({ color: overlay ? 0x343a42 : 0x07090d, alpha: overlay ? 0.85 : 0.78 });
      const k0 = pt(-halfW * 0.8, -halfH * 0.7);
      const k1 = pt(-halfW * 0.1, -halfH * 0.05);
      const k2 = pt(halfW * 0.35, halfH * 0.25);
      const k3 = pt(halfW * 0.85, halfH * 0.75);
      gfx.moveTo(k0.x, k0.y);
      gfx.lineTo(k1.x, k1.y);
      gfx.lineTo(k2.x, k2.y);
      gfx.lineTo(k3.x, k3.y);
      gfx.stroke({ width: Math.max(1, halfW * 0.16), color: 0x000000, alpha: 0.85 });
      gfx.moveTo(k1.x, k1.y);
      gfx.lineTo(k2.x, k2.y);
      gfx.stroke({ width: Math.max(0.6, halfW * 0.08), color: 0xff783c, alpha: 0.35 });
    } else if (ratio <= CRITICAL_RATIO) {
      gfx.fill({ color: 0xef4444, alpha: overlay ? 0.5 : 0.38 });
    } else {
      const depth = clamp((DAMAGED_RATIO - ratio) / DAMAGED_RATIO, 0, 1);
      gfx.fill({ color: 0xfbb040, alpha: (overlay ? 0.2 : 0.12) + depth * (overlay ? 0.35 : 0.3) });
    }
  }
}

// Short-lived hit flashes plus the faint penetration trace, in the FlashOverlay
// layer (hull-rotated ship-local space).
function updatePixiDamageFlashes(view, ship, design, now) {
  const gfx = view.flashOverlay;
  if (!ship.alive || !hasActiveDamageVisuals(ship.id, now)) {
    if (gfx.visible) {
      gfx.clear();
      gfx.visible = false;
    }
    return;
  }
  gfx.visible = true;
  gfx.clear();

  for (let i = 0; i < design.length; i += 1) {
    const flash = componentFlash(ship.id, i, now);
    if (!flash) continue;
    const place = footprintLocalPlacement(design[i], SHIP_SCALE);
    const halfW = (place.tilesLong * SHIP_SCALE) / 2;
    const halfH = (place.tilesCross * SHIP_SCALE) / 2;
    const s = flash.strength;

    if (flash.destroyed) {
      const grow = 1 + (1 - s) * 0.9;
      const corners = footprintCorners(place, halfW * grow, halfH * grow);
      tracePoly(gfx, corners);
      gfx.fill({ color: 0xffecd2, alpha: 0.75 * s });
      tracePoly(gfx, corners);
      gfx.stroke({ width: Math.max(1, halfW * 0.2), color: 0xff8c3c, alpha: 0.9 * s });
    } else if (flash.layer === "armor") {
      const corners = footprintCorners(place, halfW, halfH);
      tracePoly(gfx, corners);
      gfx.fill({ color: 0xff9e2c, alpha: 0.65 * s });
      const pt = corners[4];
      const p0 = pt(-halfW * 0.6, halfH * 0.5);
      const p1 = pt(0, -halfH * 0.2);
      const p2 = pt(halfW * 0.55, halfH * 0.4);
      gfx.moveTo(p0.x, p0.y);
      gfx.lineTo(p1.x, p1.y);
      gfx.lineTo(p2.x, p2.y);
      gfx.stroke({ width: Math.max(0.8, halfW * 0.14), color: 0xffd682, alpha: 0.85 * s });
    } else {
      const corners = footprintCorners(place, halfW, halfH);
      tracePoly(gfx, corners);
      gfx.fill({ color: 0xff5c5c, alpha: 0.6 * s });
      const inner = footprintCorners(place, halfW * 0.55, halfH * 0.55);
      tracePoly(gfx, inner);
      gfx.fill({ color: 0xfff5f5, alpha: 0.5 * s * s });
    }
  }

  const path = activePenetrationPath(ship.id, now);
  if (path && path.indices.length >= 2) {
    let started = false;
    for (const index of path.indices) {
      const part = design[index];
      if (!part) continue;
      const place = footprintLocalPlacement(part, SHIP_SCALE);
      if (!started) {
        gfx.moveTo(place.cx, place.cy);
        started = true;
      } else {
        gfx.lineTo(place.cx, place.cy);
      }
    }
    if (started) gfx.stroke({ width: 2, color: 0xffdcaa, alpha: 0.55 * path.strength });
  }
}

function updatePixiCoreWarning(view, ship, zoom) {
  const warning = ship.alive ? activeCoreWarning(ship.id, performance.now()) : null;
  const text = view.coreWarnText;
  if (!warning) {
    text.visible = false;
    return;
  }
  if (text.text !== warning.text) text.text = warning.text;
  text.style.fill = warning.text === "CORE EXPOSED" ? "#ffca57" : "#ff5f5f";
  const size = Math.max(11, 13 / zoom);
  text.scale.set(size / 13);
  text.position.set(0, -(ship.radius || 26) - 64 / zoom);
  text.alpha = Math.min(1, warning.strength * 1.6);
  text.visible = true;
}

function pixiEngineIdPhase(id) {
  const source = String(id || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) hash = (hash + source.charCodeAt(i) * 31) % 1000;
  return hash / 159;
}

// Animated exhaust plume behind each engine, drawn in the EffectsBelow layer.
function updatePixiEngineExhaust(view, ship, now) {
  const gfx = view.engineGfx;
  gfx.clear();
  if (!ship.alive || !view.engines || view.engines.length === 0) {
    gfx.visible = false;
    return;
  }
  const speed = Math.hypot(ship.vx || 0, ship.vy || 0);
  const maxSpeed = Math.max(90, maxSpeedForRenderedShip(ship));
  const speedRatio = clamp(speed / maxSpeed, 0, 1);
  const intensity = engineThrustRatio(ship);
  const liveEngines = aliveEngineNozzles(ship, view.engines);
  emitEngineSmoke(ship, liveEngines, SHIP_SCALE, now);

  const jets = computeManeuverJets(ship, ship.design || [], SHIP_SCALE, now);
  if (jets) {
    for (const jet of jets) {
      const tipX = jet.x + jet.aft * jet.len;
      gfx.moveTo(jet.x, jet.y - 2.4);
      gfx.quadraticCurveTo(jet.x + jet.aft * jet.len * 0.6, jet.y - 1, tipX, jet.y);
      gfx.quadraticCurveTo(jet.x + jet.aft * jet.len * 0.6, jet.y + 1, jet.x, jet.y + 2.4);
      gfx.closePath();
      gfx.fill({ color: "#7dd3ff", alpha: jet.plumeAlpha });
      gfx.circle(jet.x + jet.aft * jet.len * 0.28, jet.y, 1.7);
      gfx.fill({ color: "#eafcff", alpha: jet.coreAlpha });
    }
  }

  if (intensity <= 0.03 || liveEngines.length === 0) {
    gfx.visible = Boolean(jets);
    return;
  }
  gfx.visible = true;

  const t = now * 0.001;
  const phase = pixiEngineIdPhase(ship.id);
  const PLUME_SIZE = 0.8;
  const glow = 0.55 + 0.45 * getEffectDensity();
  for (let e = 0; e < liveEngines.length; e += 1) {
    const nz = liveEngines[e];
    const flicker = 0.78 + 0.22 * Math.sin(t * 34 + phase + e * 1.7) + 0.08 * Math.sin(t * 61 + e);
    const halfW = nz.halfW * (0.8 + intensity * 0.65) * PLUME_SIZE;
    const len = halfW * (1.2 + intensity * 9.4 + speedRatio * 2.4) * flicker;
    const ox = nz.x;
    const oy = nz.y;
    const angle = nz.angle || 0;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const pt = (x, y) => ({ x: ox + x * ca - y * sa, y: oy + x * sa + y * ca });

    let p0 = pt(0, -halfW * 1.15), p1 = pt(-len * .55, -halfW * .7), p2 = pt(-len, 0), p3 = pt(-len * .55, halfW * .7), p4 = pt(0, halfW * 1.15);
    gfx.moveTo(p0.x, p0.y);
    gfx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    gfx.quadraticCurveTo(p3.x, p3.y, p4.x, p4.y);
    gfx.closePath();
    gfx.fill({ color: "#2b7bff", alpha: (0.18 + intensity * 0.22) * glow });

    const innerLen = len * 0.72;
    p0 = pt(0, -halfW * .72); p1 = pt(-innerLen * .5, -halfW * .42); p2 = pt(-innerLen, 0); p3 = pt(-innerLen * .5, halfW * .42); p4 = pt(0, halfW * .72);
    gfx.moveTo(p0.x, p0.y);
    gfx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    gfx.quadraticCurveTo(p3.x, p3.y, p4.x, p4.y);
    gfx.closePath();
    gfx.fill({ color: "#63e6ff", alpha: 0.5 + intensity * 0.4 });

    const coreLen = len * 0.4;
    p0 = pt(.5, -halfW * .42); p1 = pt(-coreLen * .5, -halfW * .24); p2 = pt(-coreLen, 0); p3 = pt(-coreLen * .5, halfW * .24); p4 = pt(.5, halfW * .42);
    gfx.moveTo(p0.x, p0.y);
    gfx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    gfx.quadraticCurveTo(p3.x, p3.y, p4.x, p4.y);
    gfx.closePath();
    gfx.fill({ color: "#eafcff", alpha: 0.72 + intensity * 0.28 });
  }
}

// Drives the persistent turret sprites toward the authoritative ship-relative
// weapon angle (ship.weaponAngles[designIndex]). Each turret sprite lives in the
// hull frame, so setting sprite.rotation to the ship-relative angle places the
// barrel at (hull rotation + relative) in world space — the hull angle is never
// added here. The angle is smoothed toward the target at the shared traverse
// rate with shortest-angle interpolation; it snaps on (re)bind, and destroyed
// turrets freeze and dim.
// Last received authoritative angle per "shipId:designIndex", with the time it
// last changed — read-only diagnostics for __mfaLiveTurretDiagnostics. Bounded:
// cleared wholesale when it grows past a sane fleet size.
const liveTurretAngleTrace = new Map();
const LIVE_TURRET_TRACE_LIMIT = 2048;

function traceReceivedTurretAngle(shipId, designIndex, rawAngle) {
  if (!Number.isFinite(rawAngle)) return;
  if (liveTurretAngleTrace.size > LIVE_TURRET_TRACE_LIMIT) liveTurretAngleTrace.clear();
  const key = `${shipId}:${designIndex}`;
  const previous = liveTurretAngleTrace.get(key);
  if (!previous || previous.angle !== rawAngle) {
    liveTurretAngleTrace.set(key, { angle: rawAngle, changedAt: performance.now() });
  }
}

function updatePixiTurrets(env, view, ship, design) {
  ensureForcedArrowState(env, view);

  // Re-seed smoothed angles when this pooled view starts rendering a new ship.
  const isNewBinding = view.boundShipId !== ship.id;
  if (isNewBinding) view.boundShipId = ship.id;

  const dt = state.dt || 0.016;
  // Smoothing is the normal path; tests can force an instant snap for pixel
  // comparisons via window.__mfaDisableTurretSmoothing.
  const instant = typeof window !== "undefined" && window.__mfaDisableTurretSmoothing === true;

  for (const sprite of view.turretSprites) {
    const i = sprite.__designIndex;
    const part = design[i];
    if (!part) continue;

    traceReceivedTurretAngle(ship.id, i, ship.weaponAngles?.[i]);
    const target = authoritativeWeaponAngle(ship, i, part);
    const healthRatio = componentHealthRatio(ship, i);
    const destroyed = healthRatio !== null && healthRatio <= 0;

    let visual = view.visualTurretAngles.get(i);
    if (!Number.isFinite(visual)) visual = target;

    if (destroyed) {
      sprite.alpha = 0.3; // knocked out: freeze in place
    } else {
      sprite.alpha = 1;
      if (instant || isNewBinding) {
        visual = target;
      } else {
        const turnRate = sprite.__weaponStat ? getWeaponTurnRate(sprite.__weaponStat) : getWeaponTurnRate(sprite.__partType === "repairBeam" ? "beam" : null);
        visual = approachAngle(visual, target, turnRate * dt);
      }
    }

    view.visualTurretAngles.set(i, visual);
    sprite.rotation = visual;
  }
}

// Applies / clears forced-arrow debug textures when the flag changes. The base
// turret leases stay held throughout; only a shared arrow lease is acquired
// while arrows are active, so repeated toggles never leak textures.
function ensureForcedArrowState(env, view) {
  const want = forcedArrowEnabled();
  if (want === view.forcedArrowActive) return;
  view.forcedArrowActive = want;
  if (want) {
    if (!view.arrowLease) view.arrowLease = acquireTurretArrowLease(env);
    for (const sprite of view.turretSprites) sprite.texture = view.arrowLease.texture;
  } else {
    for (const sprite of view.turretSprites) {
      if (sprite.__baseTexture) sprite.texture = sprite.__baseTexture;
    }
    if (view.arrowLease) {
      view.arrowLease.release();
      view.arrowLease = null;
    }
  }
}

// Runtime visual diagnostics for turret tracking. Draws, per turret:
//   red   line = authoritative world direction (hull + server relative angle)
//   cyan  line = actual rendered turret world direction (from sprite transform)
//   yellow dot = the turret pivot
// The red and cyan lines must overlap. Also logs per-turret fields and asserts
// rotatingWeaponCount === turretSpriteCount. Enable with
//   window.__mfaDebugTurrets = true
// and force obvious arrows with window.__mfaDebugTurretArrows = true.
function drawPixiTurretDiagnostics(view, overlay, ship, design, renderShip, zoom) {
  const hullAngle = renderShip.angle || 0;
  const cos = Math.cos(hullAngle);
  const sin = Math.sin(hullAngle);
  const rotIndices = rotatingWeaponIndices(design);
  const len = Math.max(26, (ship.radius || 26) * 1.4);

  const lines = [`ship ${ship.id} rot=${rotIndices.length} sprites=${view.turretSprites.length}`];
  if (rotIndices.length !== view.turretSprites.length) {
    const have = new Set(view.turretSprites.map((s) => s.__designIndex));
    const missing = rotIndices.filter((i) => !have.has(i));
    const seen = new Map();
    for (const s of view.turretSprites) seen.set(s.__designIndex, (seen.get(s.__designIndex) || 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([i]) => i);
    console.error(`[mfaDebugTurrets] rotatingWeaponCount(${rotIndices.length}) !== turretSpriteCount(${view.turretSprites.length}) ship ${ship.id}`,
      { missingDesignIndices: missing, duplicateDesignIndices: dupes });
    lines.push(`MISMATCH missing=[${missing}] dup=[${dupes}]`);
  }

  for (const sprite of view.turretSprites) {
    const i = sprite.__designIndex;
    const part = design[i];
    if (!part) continue;
    const place = footprintLocalPlacement(part, SHIP_SCALE);
    // Pivot in world space.
    const pivotX = renderShip.x + place.cx * cos - place.cy * sin;
    const pivotY = renderShip.y + place.cx * sin + place.cy * cos;

    // Authoritative world direction (server relative + hull).
    const relAuthoritative = authoritativeWeaponAngle(ship, i, part);
    const worldAuthoritative = weaponRelativeToWorld(hullAngle, relAuthoritative);
    // Actual rendered world direction from the live sprite transform.
    const worldRendered = hullAngle + sprite.rotation;

    overlay.moveTo(pivotX, pivotY);
    overlay.lineTo(pivotX + Math.cos(worldAuthoritative) * len, pivotY + Math.sin(worldAuthoritative) * len);
    overlay.stroke({ width: 3 / zoom, color: 0xff0033, alpha: 0.9 });

    overlay.moveTo(pivotX, pivotY);
    overlay.lineTo(pivotX + Math.cos(worldRendered) * len * 0.82, pivotY + Math.sin(worldRendered) * len * 0.82);
    overlay.stroke({ width: 1.4 / zoom, color: 0x00e5ff, alpha: 0.95 });

    overlay.circle(pivotX, pivotY, Math.max(2.2, 3 / zoom));
    overlay.fill({ color: 0xffe600, alpha: 0.95 });

    if (performance.now() - (view.turretDebugLastAt || 0) > 500) {
      lines.push(`#${i} ${sprite.__partType} rel=${relAuthoritative.toFixed(2)} loc=${sprite.rotation.toFixed(2)} hull=${hullAngle.toFixed(2)} world=${worldRendered.toFixed(2)} vis=${sprite.visible} a=${sprite.alpha.toFixed(2)} par=${sprite.parent?.label || "?"}`);
    }
  }

  if (performance.now() - (view.turretDebugLastAt || 0) > 500) {
    view.turretDebugLastAt = performance.now();
    console.debug("[mfaDebugTurrets]\n" + lines.join("\n"));
  }

  const dt = view.debugText;
  dt.text = `backend=${(typeof window !== "undefined" && window.__mfaRenderer?.backend) || "pixi"}  ${lines[0]}`;
  const size = Math.max(9, 10 / zoom);
  dt.scale.set(size / 9);
  dt.position.set(-(ship.radius || 26), (ship.radius || 26) + 20 / zoom);
  dt.visible = true;
}

function drawPixiHudFrame(gfx, x, y, width, height, color, warning, zoom) {
  gfx.moveTo(x + 8, y);
  gfx.lineTo(x + width - 8, y);
  gfx.lineTo(x + width, y + 8);
  gfx.lineTo(x + width - 6, y + height);
  gfx.lineTo(x + 6, y + height);
  gfx.lineTo(x, y + height - 8);
  gfx.closePath();
  gfx.fill("rgba(4,10,22,0.85)");
  gfx.stroke({ width: 1.5 / zoom, color: warning ? "rgba(255,95,126,0.85)" : color });

  gfx.moveTo(x + 12, y);
  gfx.lineTo(x + 8, y);
  gfx.lineTo(x, y + 8);
  gfx.lineTo(x, y + 14);
  gfx.moveTo(x + width - 12, y);
  gfx.lineTo(x + width - 8, y);
  gfx.lineTo(x + width, y + 8);
  gfx.lineTo(x + width, y + 14);
  gfx.stroke({ width: 1.0 / zoom, color: warning ? "rgba(255,95,126,0.95)" : color });
}

function drawPixiStatusBar(env, gfx, options) {
  const { x, y, width, height, ratio, lagRatio, gradientId, gradientStops, segments, zoom } = options;
  const radius = Math.max(1, height * 0.35);

  gfx.roundRect(x, y, width, height, radius);
  gfx.fill("rgba(2,10,18,0.85)");
  gfx.stroke({ width: 0.5, color: "rgba(0,0,0,0.4)" });

  if (lagRatio > ratio) {
    gfx.roundRect(x, y, width * lagRatio, height, radius);
    gfx.fill("rgba(239,68,68,0.4)");
  }

  if (ratio > 0) {
    gfx.roundRect(x, y, width * ratio, height, radius);
    gfx.fill(getPixiBarGradient(env, gradientId, gradientStops, false));
    gfx.roundRect(x, y, width * ratio, height * 0.45, radius * 0.6);
    gfx.fill(getPixiBarGradient(env, "gloss", [
      { offset: 0, color: "rgba(255,255,255,0.28)" },
      { offset: 1, color: "rgba(255,255,255,0.0)" }
    ], true));
  }

  gfx.roundRect(x, y, width, height, radius);
  gfx.stroke({ width: 0.75 / zoom, color: "rgba(255,255,255,0.15)" });

  const step = width / segments;
  for (let i = 1; i < segments; i += 1) {
    gfx.moveTo(x + step * i, y + 0.5);
    gfx.lineTo(x + step * i, y + height - 0.5);
  }
  gfx.stroke({ width: 0.75 / zoom, color: "rgba(255,255,255,0.08)" });
}

function drawPixiShieldStatusBar(env, gfx, options) {
  const { x, y, width, height, ratio, lagRatio, zoom } = options;
  const radius = Math.max(2, height * 0.48);

  gfx.roundRect(x, y, width, height, radius);
  gfx.fill(getPixiBarGradient(env, "shield-track", [
    { offset: 0, color: "rgba(3,18,34,0.92)" },
    { offset: 1, color: "rgba(8,31,52,0.86)" }
  ], false));
  gfx.stroke({ width: 0.75 / zoom, color: "rgba(125,211,252,0.22)" });

  if (lagRatio > ratio) {
    gfx.roundRect(x, y, width * lagRatio, height, radius);
    gfx.fill("rgba(125,211,252,0.18)");
  }

  if (ratio > 0) {
    const fillWidth = Math.min(width, Math.max(radius, width * ratio));
    gfx.roundRect(x, y, fillWidth, height, radius);
    gfx.fill(getPixiBarGradient(env, "shield-fill", [
      { offset: 0, color: "#075985" },
      { offset: 0.58, color: "#22d3ee" },
      { offset: 1, color: "#e0faff" }
    ], false));
    gfx.roundRect(x, y, fillWidth, Math.max(2, height * 0.62), radius * 0.8);
    gfx.fill(getPixiBarGradient(env, "shield-gloss", [
      { offset: 0, color: "rgba(255,255,255,0.42)" },
      { offset: 0.42, color: "rgba(255,255,255,0.08)" },
      { offset: 1, color: "rgba(255,255,255,0.0)" }
    ], true));
  }

  const cells = 8;
  const cellGap = 2 / zoom;
  const cellWidth = (width - cellGap * (cells - 1)) / cells;
  for (let i = 1; i < cells; i += 1) {
    const sx = x + i * (cellWidth + cellGap) - cellGap * 0.5;
    gfx.moveTo(sx, y + 1.2 / zoom);
    gfx.lineTo(sx, y + height - 1.2 / zoom);
  }
  gfx.stroke({ width: 0.65 / zoom, color: "rgba(224,250,255,0.18)" });

  gfx.roundRect(x, y, width, height, radius);
  gfx.stroke({ width: 1 / zoom, color: "rgba(125,211,252,0.45)" });
}

function setPixiBarText(text, val, maxVal, height, centerX, centerY) {
  const label = `${Math.round(val)} / ${Math.round(maxVal)}`;
  if (text.text !== label) text.text = label;
  const fontSize = Math.max(7, Math.floor(height * 0.85));
  text.scale.set(fontSize / 12);
  text.position.set(centerX, centerY + 1);
  text.visible = true;
}

function updatePixiHealthBars(env, view, ship, player, zoom) {
  const gfx = view.hudGfx;
  if (!ship.alive) {
    gfx.visible = false;
    view.shieldText.visible = false;
    view.hullText.visible = false;
    view.hudName.visible = false;
    return;
  }
  gfx.visible = true;
  gfx.clear();

  const selected = state.selectedShipIds.has(ship.id);
  const damaged = ship.hp < ship.maxHp || ship.shield < ship.maxShield;
  const width = Math.max(selected ? 72 : 56, ship.radius * (selected ? 2.15 : 1.85));
  const x = -width / 2;
  const frameHeight = selected ? 42 : 32;
  const y = -ship.radius - (selected ? 62 : 48);
  const now = performance.now();
  const hud = updateShipHud(ship, now);
  const hullRatio = clamp(hud.hp / ship.maxHp, 0, 1);
  const hullLagRatio = clamp(hud.hpLag / ship.maxHp, 0, 1);
  const shieldRatio = ship.maxShield > 0 ? clamp(ship.shield / ship.maxShield, 0, 1) : 0;
  const lowHull = hullRatio <= 0.25;
  const alpha = selected || damaged ? 1 : 0.68;
  gfx.alpha = alpha;

  drawPixiHudFrame(gfx, x - 4, y - 4, width + 8, frameHeight, player.color, lowHull, zoom);

  const shieldY = y + 3;
  const hullY = y + (selected ? 15 : 12);
  const shieldHeight = selected ? 9 : 7;
  const hullHeight = selected ? 10 : 8;
  const barX = x + 4;
  const barWidth = width - 8;

  if (ship.maxShield > 0) {
    drawPixiShieldStatusBar(env, gfx, {
      x: barX, y: shieldY, width: barWidth, height: shieldHeight,
      ratio: shieldRatio, lagRatio: shieldRatio,
      zoom
    });
    setPixiBarText(view.shieldText, ship.shield, ship.maxShield, shieldHeight, barX + barWidth / 2, shieldY + shieldHeight / 2);
  } else {
    const dash = 4 / zoom;
    for (let dx = 0; dx < barWidth; dx += dash * 2) {
      gfx.moveTo(barX + dx, shieldY + 2);
      gfx.lineTo(barX + Math.min(dx + dash, barWidth), shieldY + 2);
    }
    gfx.stroke({ width: 1 / zoom, color: "rgba(88,122,150,0.42)" });
    view.shieldText.visible = false;
  }

  const hullColor = hullColorForRatio(hullRatio);
  drawPixiStatusBar(env, gfx, {
    x: barX, y: hullY, width: barWidth, height: hullHeight,
    ratio: hullRatio, lagRatio: hullLagRatio,
    gradientId: `hull|${hullColor.start}`, gradientStops: [{ offset: 0, color: hullColor.start }, { offset: 1, color: hullColor.end }],
    segments: selected ? 8 : 6, zoom
  });
  setPixiBarText(view.hullText, hud.hp, ship.maxHp, hullHeight, barX + barWidth / 2, hullY + hullHeight / 2);
  view.shieldText.alpha = alpha;
  view.hullText.alpha = alpha;

  if (view.names.hud !== player.name) {
    view.names.hud = player.name;
    view.hudName.text = player.name.toUpperCase();
  }
  const nameSize = Math.max(10, (selected ? 11 : 10) / zoom);
  view.hudName.scale.set(nameSize / 13);
  view.hudName.position.set(0, y + frameHeight + 4 + nameSize * 0.5);
  view.hudName.alpha = alpha;
  view.hudName.visible = true;
}

function updatePixiShipLabels(view, ship, player, zoom) {
  const showIdleName = ship.alive && zoom >= 0.48 && !state.selectedShipIds.has(ship.id) && !(ship.hp < ship.maxHp || ship.shield < ship.maxShield);
  if (showIdleName) {
    if (view.names.idle !== player.name) {
      view.names.idle = player.name;
      view.idleName.text = player.name;
    }
    const size = Math.max(10, 11 / zoom);
    view.idleName.scale.set(size / 13);
    view.idleName.position.set(0, ship.radius + 18);
    view.idleName.visible = true;
  } else {
    view.idleName.visible = false;
  }
  if (!ship.alive) view.hudName.visible = false;

  if (!ship.alive) {
    const size = Math.max(11, 13 / zoom);
    view.lostText.scale.set(size / 14);
    view.lostText.position.set(0, -ship.radius - 12 - size * 0.4);
    view.lostText.text = "lost";
    view.lostText.visible = true;
  } else {
    view.lostText.visible = false;
  }
}

function drawPixiSelectionRing(env, gfx, ship, zoom) {
  const player = state.snapshot?.players?.find((p) => p.id === ship.ownerId);
  const mine = state.mine || state.snapshot?.players?.find((p) => p.id === state.myId);
  const friendly = ship.ownerId === state.myId || Boolean(mine?.team && player?.team && mine.team === player.team);
  const color = friendly ? "#4ade80" : (player ? player.color : "#ffca57");
  const size = ship.radius + 12;
  const arm = Math.max(5, size * 0.22);

  gfx.moveTo(ship.x - size, ship.y - size + arm);
  gfx.lineTo(ship.x - size, ship.y - size);
  gfx.lineTo(ship.x - size + arm, ship.y - size);
  gfx.moveTo(ship.x + size, ship.y - size + arm);
  gfx.lineTo(ship.x + size, ship.y - size);
  gfx.lineTo(ship.x + size - arm, ship.y - size);
  gfx.moveTo(ship.x - size, ship.y + size - arm);
  gfx.lineTo(ship.x - size, ship.y + size);
  gfx.lineTo(ship.x - size + arm, ship.y + size);
  gfx.moveTo(ship.x + size, ship.y + size - arm);
  gfx.lineTo(ship.x + size, ship.y + size);
  gfx.lineTo(ship.x + size - arm, ship.y + size);
  gfx.stroke({ width: 1.75 / zoom, color });

  if (!ship.alive) return;
  const maxRange = Math.max(ship.blasterRange || 0, ship.missileRange || 0, ship.railgunRange || 0, ship.beamRange || 0);
  if (maxRange <= 0) return;

  const dashLen = 6 / zoom;
  const gapLen = 10 / zoom;
  const circumference = Math.PI * 2 * maxRange;
  const dashCount = Math.min(160, Math.max(8, Math.floor(circumference / (dashLen + gapLen))));
  const dashAngle = (Math.PI * 2) / dashCount;
  const dashArc = dashAngle * (dashLen / (dashLen + gapLen));
  for (let i = 0; i < dashCount; i += 1) {
    const startAngle = i * dashAngle;
    gfx.moveTo(ship.x + Math.cos(startAngle) * maxRange, ship.y + Math.sin(startAngle) * maxRange);
    gfx.arc(ship.x, ship.y, maxRange, startAngle, startAngle + dashArc);
  }
  gfx.stroke({ width: 1.25 / zoom, color: "rgba(255,202,87,0.22)" });

  if (state.selectedShipIds.size > 1) return;
  const design = ship.design || [];
  const cos = Math.cos(ship.angle);
  const sin = Math.sin(ship.angle);
  design.forEach((part) => {
    const weaponStat = PART_STATS[part.type]?.weapon;
    if (!weaponStat) return;
    const { cx: px, cy: py } = footprintLocalPlacement(part, SHIP_SCALE);
    const gunWorldX = ship.x + px * cos - py * sin;
    const gunWorldY = ship.y + px * sin + py * cos;
    const defaultRelativeFacing = defaultWeaponRelativeAngle(part);
    const arcRadians = (weaponStat.arc || 360) * Math.PI / 180;
    const gunRange = ship[weaponStat.type + "Range"] || weaponStat.range || maxRange;
    const arcCenterWorld = ship.angle + defaultRelativeFacing;
    if (arcRadians < Math.PI * 2) {
      gfx.moveTo(gunWorldX, gunWorldY);
      gfx.arc(gunWorldX, gunWorldY, gunRange, arcCenterWorld - arcRadians / 2, arcCenterWorld + arcRadians / 2);
      gfx.closePath();
      gfx.fill("rgba(255,202,87,0.025)");
      gfx.stroke({ width: 1.0 / zoom, color: "rgba(255,202,87,0.08)" });
    }
  });
}

function drawPixiDestructWarning(gfx, ship, progress, zoom, now) {
  const r = (ship.radius || 26) + 10;
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.02 * (1 + progress * 3));
  const alpha = 0.4 + progress * 0.5;
  const rot = now * 0.0011;
  const sides = 6;
  for (let i = 0; i <= sides; i += 1) {
    const a = rot + (i / sides) * Math.PI * 2;
    const px = ship.x + Math.cos(a) * r;
    const py = ship.y + Math.sin(a) * r;
    if (i === 0) gfx.moveTo(px, py);
    else gfx.lineTo(px, py);
  }
  gfx.stroke({ width: (1.5 + pulse * 2.5) / zoom, color: "#ff5f3c", alpha });

  const arcR = r * 0.72;
  const start = -Math.PI / 2;
  gfx.moveTo(ship.x + Math.cos(start) * arcR, ship.y + Math.sin(start) * arcR);
  gfx.arc(ship.x, ship.y, arcR, start, start + Math.max(0.001, progress) * Math.PI * 2);
  gfx.stroke({ width: 2.5 / zoom, color: "#ffd7a8", alpha: 0.9 });
}

function drawPixiFocusLine(gfx, ship, zoom) {
  const target = state.snapshot?.ships?.find((candidate) => candidate.id === ship.focusTargetId);
  if (!target) return;
  gfx.moveTo(ship.x, ship.y);
  gfx.lineTo(target.x, target.y);
  gfx.stroke({ width: 1.5 / zoom, color: "rgba(255,95,126,0.36)" });
}

export function updatePixiShips(env, now, players, bounds) {
  if (!pixiShipPool) pixiShipPool = createPixiKeyedPool(env.layers.ships, () => createPixiShipView(env));
  pixiShipPool.frameStart();

  const snap = state.snapshot;
  const zoom = state.camera.zoom;
  const overlay = env.layers.overlay;
  const debug = turretDebugEnabled();
  const visibleShipIds = new Set();

  if (snap && snap.ships) {
    for (const ship of snap.ships) {
      if (state.debugStats) state.debugStats.totalShips++;
      visibleShipIds.add(ship.id);
      let renderShip = ship;
      const vis = state.visualShips ? state.visualShips.get(ship.id) : null;
      if (vis) renderShip = { ...ship, x: vis.x, y: vis.y, angle: vis.angle };
      if (bounds && !isCircleVisible(renderShip.x, renderShip.y, renderShip.radius || 60, bounds)) continue;
      const player = players.get(ship.ownerId);
      if (!player) continue;
      if (state.debugStats) state.debugStats.drawnShips++;

      const view = pixiShipPool.acquire(ship.id);
      const design = ship.design || player.design || [];
      const staticKey = pixiStaticSignature(pixiDesignSignature(design), player.color, ship.radius || 0, env.bakeScale);
      // Static content is rebuilt ONLY when the signature changes — never on a
      // position/angle/weaponAngle/hp/shield/heat update.
      if (view.staticKey !== staticKey) {
        rebuildPixiShipStatic(env, view, design, player.color, ship.radius || 0, staticKey);
        view.boundShipId = null; // force turret angle re-seed for the new static content
      }

      view.root.position.set(renderShip.x, renderShip.y);
      setHullFrameRotation(view, renderShip.angle);
      view.hullContainer.alpha = ship.alive ? 1 : 0.32;
      updatePixiShieldRing(view, ship, zoom);
      updatePixiEngineExhaust(view, renderShip, now);
      updatePixiTurrets(env, view, ship, design);
      updatePixiComponentDamage(view, ship, design);
      updatePixiDamageFlashes(view, ship, design, performance.now());
      updatePixiCoreWarning(view, ship, zoom);
      updatePixiHealthBars(env, view, { ...renderShip, radius: ship.radius || 0 }, player, zoom);
      updatePixiShipLabels(view, renderShip, player, zoom);

      if (debug) {
        drawPixiTurretDiagnostics(view, overlay, ship, design, renderShip, zoom);
      } else if (view.debugText.visible) {
        view.debugText.visible = false;
      }

      if (state.selectedShipIds.has(ship.id)) drawPixiSelectionRing(env, overlay, renderShip, zoom);
      if (ship.focusTargetId) drawPixiFocusLine(overlay, renderShip, zoom);
      if (ship.destructProgress != null && ship.alive) {
        drawPixiDestructWarning(overlay, { x: renderShip.x, y: renderShip.y, radius: ship.radius || 0 }, ship.destructProgress, zoom, now);
      }
    }
  }

  pixiShipPool.frameEnd();

  for (const id of state.shipHud.keys()) {
    if (!visibleShipIds.has(id)) state.shipHud.delete(id);
  }

  pruneComponentDamage(visibleShipIds, performance.now());
}

// Tears down the ship pool (releasing every texture lease and destroying display
// objects without their cache-owned textures) and resets module-global state.
// Called by destroyPixiRenderer().
export function destroyPixiShipPool() {
  if (pixiShipPool) {
    pixiShipPool.destroy();
    pixiShipPool = null;
  }
  pixiGradientCache = new Map();
}

// Live counts of ship views for texture diagnostics.
export function pixiShipViewCounts() {
  return {
    activeShipViews: pixiShipPool ? pixiShipPool.activeCount() : 0,
    freeShipViews: pixiShipPool ? pixiShipPool.freeCount() : 0
  };
}

// Test/diagnostic hook: exposes the live turret-sprite state for a ship id so
// browser tests can assert real rendered rotations and world transforms without
// scraping pixels. Returns null when no view is bound to that ship.
export function __pixiTurretDebugInfo(shipId) {
  if (!pixiShipPool) return null;
  const view = pixiShipPool.peek ? pixiShipPool.peek(shipId) : null;
  if (!view) return null;
  const hullAngle = view.hullContainer.rotation;
  const engWt = view.engineGfx ? view.engineGfx.worldTransform : null;
  return {
    shipId,
    hullRotation: hullAngle,
    // World rotation of the engine-effects layer: must equal the hull rotation
    // (the exhaust is anchored to the ship body and turns with it).
    engineWorldRotation: engWt ? Math.atan2(engWt.b, engWt.a) : null,
    engineVisible: view.engineGfx ? view.engineGfx.visible : false,
    engineParentLabel: view.engineGfx?.parent?.label || null,
    turretCount: view.turretSprites.length,
    turrets: view.turretSprites.map((s) => {
      const wt = s.worldTransform;
      return {
        designIndex: s.__designIndex,
        partType: s.__partType,
        localRotation: s.rotation,
        worldRotation: hullAngle + s.rotation,
        worldTransformRotation: Math.atan2(wt.b, wt.a),
        visible: s.visible,
        alpha: s.alpha,
        parentLabel: s.parent?.label || null,
        x: wt.tx,
        y: wt.ty
      };
    })
  };
}

// Read-only live turret diagnostics for a ship id: per rotating weapon, what
// authoritative angle was received, what is actually rendered, and whether the
// angle is present/changing. For debugging live tracking issues only — reads
// snapshot + view state and never mutates anything.
export function __pixiLiveTurretDiagnostics(shipId) {
  const ship = state.snapshot?.ships?.find((candidate) => candidate.id === shipId);
  if (!ship || !Array.isArray(ship.design)) return null;
  const view = pixiShipPool && pixiShipPool.peek ? pixiShipPool.peek(shipId) : null;
  const hullAngle = view ? view.hullContainer.rotation : Number(ship.angle) || 0;
  const now = performance.now();
  return rotatingWeaponIndices(ship.design).map((designIndex) => {
    const raw = ship.weaponAngles?.[designIndex];
    const anglePresent = Number.isFinite(raw);
    const sprite = view ? view.turretSprites.find((candidate) => candidate.__designIndex === designIndex) || null : null;
    const trace = liveTurretAngleTrace.get(`${shipId}:${designIndex}`);
    return {
      designIndex,
      partType: ship.design[designIndex]?.type || null,
      receivedAuthoritativeAngle: anglePresent ? raw : null,
      renderedLocalAngle: sprite ? sprite.rotation : null,
      renderedWorldAngle: sprite ? weaponRelativeToWorld(hullAngle, sprite.rotation) : null,
      hullAngle,
      anglePresent,
      angleChangedRecently: Boolean(trace && now - trace.changedAt < 3000),
      targetId: ship.combatTargetId ?? null
    };
  });
}

// Read-only Pixi texture diagnostics: cache generation, per-cache entry/ref
// counts, created/destroyed texture totals, and ship-view counts. Returns plain
// data — no mutable cache objects are exposed.
export function pixiTextureDiagnosticsSnapshot() {
  const base = pixiTextureDiagnostics();
  const counts = pixiShipViewCounts();
  let staleEntries = 0;
  let liveRefs = 0;
  for (const c of base.caches) {
    staleEntries += c.stale;
    liveRefs += c.refs;
  }
  return {
    generation: base.generation,
    createdTextures: base.createdTextures,
    destroyedTextures: base.destroyedTextures,
    staleEntries,
    liveReferenceCount: liveRefs,
    caches: base.caches,
    cacheNames: base.caches.map((c) => c.name),
    activeShipViews: counts.activeShipViews,
    freeShipViews: counts.freeShipViews
  };
}

// Expose the live turret inspection + texture diagnostics hooks so browser tests
// (and manual debugging) can read real rendered rotations/world transforms and
// texture lifecycle state. Works in both the ES-module dev build and the
// concatenated production bundle.
if (typeof window !== "undefined") {
  window.__mfaTurretDebugInfo = __pixiTurretDebugInfo;
  window.__mfaLiveTurretDiagnostics = __pixiLiveTurretDiagnostics;
  window.__mfaPixiTextureDiagnostics = pixiTextureDiagnosticsSnapshot;
}
