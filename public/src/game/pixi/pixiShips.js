// Ship rendering for the PixiJS arena renderer: baked hull sprites, rotating
// turret sprites, per-frame HUD bars, name labels, and selection overlays.
// Hull art is baked by replaying the Canvas 2D module drawing into textures.

import { state } from "../../state.js";
import { clamp } from "../../shared/math.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "../../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../../design/rotation.js";
import { isCircleVisible, drawShipStructure, drawModule, drawFootprintComponent, moduleLocalPosition, footprintLocalPlacement, updateShipHud, getWeaponTurnRate, approachAngle, hullColorForRatio, shieldRatioForShip, shieldRingRadius, shipEngineNozzles, aliveEngineNozzles, engineThrustRatio, emitEngineSmoke, maxSpeedForRenderedShip, componentHealthRatio, computeManeuverJets } from "../renderer.js";
import { pixiBakeTexture, registerPixiTextureCache, createPixiKeyedPool, getPixiBakeGeneration } from "./pixiBake.js";
import { getEffectDensity } from "../renderSettings.js";
import { componentFlash, activePenetrationPath, activeCoreWarning, pruneComponentDamage, hasActiveDamageVisuals, CRITICAL_RATIO, DAMAGED_RATIO } from "../componentDamage.js";

const SHIP_SCALE = 13;
// Nominal zoom used when baking zoom-compensated line widths into textures.
const BAKE_NOMINAL_ZOOM = 0.6;
const TURRET_DEBUG_ARROW_KEY = "__mfa_turret_debug_arrow__";

function turretDebugEnabled() {
  return typeof window !== "undefined" && window.__mfaDebugTurrets === true;
}

function weaponComponentIndices(design) {
  return (design || []).map((part, index) => ({ part, index })).filter(({ part }) => Boolean(PART_STATS[part.type]?.weapon));
}

function getDebugArrowTexture(env) {
  let texture = pixiTurretTextureCache.get(TURRET_DEBUG_ARROW_KEY);
  if (texture) return texture;
  const halfW = SHIP_SCALE * 3.2;
  const halfH = SHIP_SCALE * 0.9;
  texture = pixiBakeTexture(env, halfW * 2, halfH * 2, (bctx) => {
    bctx.lineWidth = 3;
    bctx.strokeStyle = "#001018";
    bctx.fillStyle = "#fff200";
    bctx.beginPath();
    bctx.moveTo(0, -5); bctx.lineTo(SHIP_SCALE * 2.8, -5); bctx.lineTo(SHIP_SCALE * 2.8, -13);
    bctx.lineTo(SHIP_SCALE * 3.8, 0); bctx.lineTo(SHIP_SCALE * 2.8, 13); bctx.lineTo(SHIP_SCALE * 2.8, 5); bctx.lineTo(0, 5);
    bctx.closePath(); bctx.fill(); bctx.stroke();
  });
  pixiTurretTextureCache.set(TURRET_DEBUG_ARROW_KEY, texture);
  return texture;
}

const pixiHullTextureCache = registerPixiTextureCache(new Map());
const pixiTurretTextureCache = registerPixiTextureCache(new Map());
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

function getPixiShipHullTexture(env, design, color, radius) {
  const key = `${pixiDesignSignature(design)}|${color}|${Math.round(radius)}|${env.bakeScale}`;
  let texture = pixiHullTextureCache.get(key);
  if (texture) return texture;

  let maxAbsX = radius + 12;
  let maxAbsY = radius + 12;
  for (const part of design) {
    const { x, y } = moduleLocalPosition(part, SHIP_SCALE);
    maxAbsX = Math.max(maxAbsX, Math.abs(x));
    maxAbsY = Math.max(maxAbsY, Math.abs(y));
  }
  // Extra pad so multi-tile non-rotatable parts (engine/reactor/capacitor) that
  // extend a tile beyond their anchor cell are not clipped by the bake bounds.
  const pad = SHIP_SCALE * 1.6 + 16;
  const halfW = maxAbsX + pad;
  const halfH = maxAbsY + pad;

  texture = pixiBakeTexture(env, halfW * 2, halfH * 2, (bctx) => {
    drawShipStructure(design, SHIP_SCALE, color);
    for (const part of design) {
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const place = footprintLocalPlacement(part, SHIP_SCALE);
      const rotatable = isRotatablePart(part.type);
      const weapon = Boolean(PART_STATS[part.type]?.weapon);
      if (rotatable && !weapon) continue;
      if (place.multi) {
        bctx.save();
        bctx.translate(place.cx, place.cy);
        bctx.rotate(place.longAxisAngle);
        drawFootprintComponent({ type: part.type, unit: SHIP_SCALE, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: color, drawDetail: !weapon });
        bctx.restore();
      } else {
        if (part.type === "maneuverThruster") {
          bctx.save();
          bctx.translate(place.cx, place.cy);
          bctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
          drawModule({ x: 0, y: 0, size: SHIP_SCALE, color: def.color, type: part.type, trim: color, drawDetail: !weapon });
          bctx.restore();
        } else {
          drawModule({ x: place.cx, y: place.cy, size: SHIP_SCALE, color: def.color, type: part.type, trim: color, drawDetail: !weapon });
        }
      }
    }
    // Direction indicator (drawn by drawShip after the module loop).
    bctx.strokeStyle = color;
    bctx.lineWidth = 2.5 / BAKE_NOMINAL_ZOOM;
    bctx.beginPath();
    bctx.moveTo(radius + 8, 0);
    bctx.lineTo(radius - 8, -7);
    bctx.lineTo(radius - 8, 7);
    bctx.closePath();
    bctx.stroke();
  });
  // Simple bounded eviction: baked hulls are per design+color and can pile up
  // across long sessions with many opponents.
  if (pixiHullTextureCache.size > 96) {
    const oldestKey = pixiHullTextureCache.keys().next().value;
    const oldest = pixiHullTextureCache.get(oldestKey);
    pixiHullTextureCache.delete(oldestKey);
    if (oldest) oldest.destroy(true);
  }
  pixiHullTextureCache.set(key, texture);
  return texture;
}

function getPixiTurretTexture(env, partType, trim) {
  const key = `${partType}|${trim}|${env.bakeScale}`;
  let texture = pixiTurretTextureCache.get(key);
  if (texture) return texture;
  const def = PART_DEFS[partType] || PART_DEFS.frame;
  const footprint = PART_STATS[partType]?.footprint || { width: 1, height: 1 };
  const tilesLong = Math.max(footprint.width || 1, footprint.height || 1);
  const tilesCross = Math.min(footprint.width || 1, footprint.height || 1);
  const multi = tilesLong > 1 || tilesCross > 1;
  const weapon = Boolean(PART_STATS[partType]?.weapon);
  // Extent must cover the elongated barrel (canonical art spans ±tilesLong/2).
  const halfExtent = SHIP_SCALE * (multi ? tilesLong * 0.62 + 1.0 : 2.1);
  texture = pixiBakeTexture(env, halfExtent * 2, halfExtent * 2, () => {
    if (multi) {
      drawFootprintComponent({ type: partType, unit: SHIP_SCALE, tilesLong, tilesCross, color: def.color, trim, drawBase: !weapon });
    } else {
      drawModule({ x: 0, y: 0, size: SHIP_SCALE, color: def.color, type: partType, trim, drawBase: !weapon });
    }
  });
  pixiTurretTextureCache.set(key, texture);
  return texture;
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

function createPixiShipView(env) {
  const PIXI = env.PIXI;
  const root = new PIXI.Container();
  const shieldGfx = new PIXI.Graphics();
  const hullGroup = new PIXI.Container();
  const engineGfx = new PIXI.Graphics(); // exhaust plumes, drawn behind the hull
  const hullSprite = new PIXI.Sprite();
  hullSprite.anchor.set(0.5);
  const damageGfx = new PIXI.Graphics(); // persistent destroyed/damaged tints
  const flashGfx = new PIXI.Graphics(); // short-lived hit flashes + penetration trace
  root.label = root.name = "shipRoot";
  hullGroup.label = hullGroup.name = "hullGroup";
  engineGfx.label = engineGfx.name = "engineEffects";
  hullSprite.label = hullSprite.name = "staticHullSprite";
  damageGfx.label = damageGfx.name = "damageOverlay";
  flashGfx.label = flashGfx.name = "flashOverlay";
  const makeText = (style) => {
    const text = new PIXI.Text({ text: "", style, resolution: 2 });
    text.anchor.set(0.5);
    text.visible = false;
    return text;
  };
  const coreWarnText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "900", fill: "#ff5f5f", stroke: { color: "rgba(10,4,4,0.8)", width: 3 } });
  const shieldText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "900", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.65)", width: 2 } });
  const hullText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "900", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.65)", width: 2 } });
  const hudName = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "bold", fill: "#ffffff" });
  const idleName = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fill: "rgba(237,244,255,0.5)" });
  const lostText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 14, fill: "rgba(237,244,255,0.7)" });
  const turretDebugGfx = new PIXI.Graphics();
  turretDebugGfx.label = turretDebugGfx.name = "turretDebugOverlay";
  const turretDebugText = makeText({ fontFamily: "monospace", fontSize: 11, fill: "#fff200", stroke: { color: "rgba(0,0,0,0.9)", width: 3 }, align: "left" });
  turretDebugText.anchor.set(0, 0);
  const hudGfx = new PIXI.Graphics();
  hullGroup.addChild(engineGfx);
  hullGroup.addChild(hullSprite);
  hullGroup.addChild(turretDebugGfx);
  hullGroup.addChild(turretDebugText);
  hullGroup.addChild(damageGfx);
  hullGroup.addChild(flashGfx);
  root.addChild(shieldGfx);
  root.addChild(hullGroup);
  root.addChild(hudGfx);
  root.addChild(shieldText);
  root.addChild(hullText);
  root.addChild(hudName);
  root.addChild(idleName);
  root.addChild(lostText);
  root.addChild(coreWarnText);
  return {
    root,
    shieldGfx,
    hullGroup,
    engineGfx,
    engines: [],
    hullSprite,
    damageGfx,
    flashGfx,
    turretDebugGfx,
    turretDebugText,
    coreWarnText,
    damageSig: null,
    turretSprites: [],
    hudGfx,
    shieldText,
    hullText,
    hudName,
    idleName,
    lostText,
    hullKey: null,
    boundShipId: null,
    visualTurretAngles: [],
    turretDebugLastAt: 0,
    names: { hud: null, idle: null },
    release() {
      this.hullKey = null;
      this.boundShipId = null;
      this.visualTurretAngles = [];
      this.damageSig = null;
      for (const sprite of this.turretSprites) sprite.visible = false;
    }
  };
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
  // Toned down (mirrors the canvas renderer) so the shield does not wash the ship
  // blue and hide its team colour.
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
      color: fill > 0 ? "#38d5ff" : "#38d5ff",
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

function rebuildPixiShipVisual(env, view, design, color, radius, hullKey, ship = null) {
  view.hullSprite.texture = getPixiShipHullTexture(env, design, color, radius);
  view.hullSprite.scale.set(1 / env.bakeScale);
  const previousAngles = view.visualTurretAngles || [];
  for (const sprite of view.turretSprites) sprite.destroy();
  view.turretSprites = [];
  view.visualTurretAngles = design.map((part, i) => {
    const serverAngle = ship?.weaponAngles?.[i];
    if (Number.isFinite(serverAngle)) return serverAngle;
    if (Number.isFinite(previousAngles[i])) return previousAngles[i];
    return moduleRotationToRadians(normalizeRotation(part.rotation));
  });
  const weaponIndices = weaponComponentIndices(design);
  design.forEach((part, i) => {
    const weapon = Boolean(PART_STATS[part.type]?.weapon);
    if (!weapon || !isRotatablePart(part.type)) return;
    const sprite = new env.PIXI.Sprite(turretDebugEnabled() ? getDebugArrowTexture(env) : getPixiTurretTexture(env, part.type, color));
    sprite.anchor.set(0.5);
    sprite.scale.set(1 / env.bakeScale);
    // Multi-tile weapons pivot at their footprint centre, not the anchor cell.
    const place = footprintLocalPlacement(part, SHIP_SCALE);
    sprite.position.set(place.cx, place.cy);
    sprite.__designIndex = i;
    sprite.__weaponType = part.type;
    sprite.label = sprite.name = `dynamicTurret:${i}:${part.type}`;
    sprite.rotation = view.visualTurretAngles[i];
    sprite.visible = true;
    view.hullGroup.addChild(sprite);
    view.turretSprites.push(sprite);
  });
  // Keep the damage/flash overlays above the freshly re-added turret sprites.
  view.hullGroup.addChild(view.damageGfx);
  view.hullGroup.addChild(view.flashGfx);
  if (turretDebugEnabled() && weaponIndices.length !== view.turretSprites.length) {
    throw new Error(`[turret-debug] weaponComponentCount ${weaponIndices.length} !== dynamicTurretSpriteCount ${view.turretSprites.length}`);
  }
  view.damageSig = null;
  view.engines = shipEngineNozzles(design, SHIP_SCALE);
  view.hullKey = hullKey;
}

// Corner positions of a (possibly rotated) footprint rect in ship-local space.
function footprintCorners(place, halfW, halfH) {
  const ang = place.multi ? place.longAxisAngle : 0;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  const pt = (x, y) => ({ x: place.cx + x * cos - y * sin, y: place.cy + x * sin + y * cos });
  return [pt(-halfW, -halfH), pt(halfW, -halfH), pt(halfW, halfH), pt(-halfW, halfH), pt];
}

function tracePoly(gfx, corners) {
  gfx.moveTo(corners[0].x, corners[0].y);
  gfx.lineTo(corners[1].x, corners[1].y);
  gfx.lineTo(corners[2].x, corners[2].y);
  gfx.lineTo(corners[3].x, corners[3].y);
  gfx.closePath();
}

// Persistent status tints over damaged components (amber), critical ones (red),
// and destroyed ones (dark broken slab). Redrawn only when the quantized damage
// signature changes, so healthy ships cost nothing per frame. The Component
// Damage View toggle strengthens the tints and is part of the signature.
function updatePixiComponentDamage(view, ship, design) {
  const gfx = view.damageGfx;
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

// Short-lived hit flashes (orange = armour, red/white = internal, bright pop =
// destroyed) plus the faint penetration trace. Fully client-side timers; the
// graphics clear themselves once nothing is active, so idle ships skip work.
function updatePixiDamageFlashes(view, ship, design, now) {
  const gfx = view.flashGfx;
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

// CORE EXPOSED / CORE DAMAGED / CORE CRITICAL callout above the ship.
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

// Animated exhaust plume behind each engine, intensity driven by forward thrust.
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

  // Lateral maneuvering-thruster jets (fire only while turning); drawn even when
  // the main engines are idle, so a rotating-in-place ship still shows them.
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
  // Match the canvas renderer: 20% smaller max plume, outer glow dimmed on low graphics.
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

    // Outer glow plume (wide, faint).
    let p0 = pt(0, -halfW * 1.15), p1 = pt(-len * .55, -halfW * .7), p2 = pt(-len, 0), p3 = pt(-len * .55, halfW * .7), p4 = pt(0, halfW * 1.15);
    gfx.moveTo(p0.x, p0.y);
    gfx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    gfx.quadraticCurveTo(p3.x, p3.y, p4.x, p4.y);
    gfx.closePath();
    gfx.fill({ color: "#2b7bff", alpha: (0.18 + intensity * 0.22) * glow });

    // Inner flame body.
    const innerLen = len * 0.72;
    p0 = pt(0, -halfW * .72); p1 = pt(-innerLen * .5, -halfW * .42); p2 = pt(-innerLen, 0); p3 = pt(-innerLen * .5, halfW * .42); p4 = pt(0, halfW * .72);
    gfx.moveTo(p0.x, p0.y);
    gfx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    gfx.quadraticCurveTo(p3.x, p3.y, p4.x, p4.y);
    gfx.closePath();
    gfx.fill({ color: "#63e6ff", alpha: 0.5 + intensity * 0.4 });

    // Hot core near the nozzle.
    const coreLen = len * 0.4;
    p0 = pt(.5, -halfW * .42); p1 = pt(-coreLen * .5, -halfW * .24); p2 = pt(-coreLen, 0); p3 = pt(-coreLen * .5, halfW * .24); p4 = pt(.5, halfW * .42);
    gfx.moveTo(p0.x, p0.y);
    gfx.quadraticCurveTo(p1.x, p1.y, p2.x, p2.y);
    gfx.quadraticCurveTo(p3.x, p3.y, p4.x, p4.y);
    gfx.closePath();
    gfx.fill({ color: "#eafcff", alpha: 0.72 + intensity * 0.28 });
  }
}

function updatePixiTurretDebug(env, view, ship, design) {
  const enabled = turretDebugEnabled();
  view.turretDebugGfx.visible = enabled; view.turretDebugText.visible = enabled;
  if (!enabled) { view.turretDebugGfx.clear(); return; }
  const gfx = view.turretDebugGfx; gfx.clear();
  const lines = [`backend=${window.__mfaRenderer?.backend || "unknown"} ship=${ship.id}`, `weapons=${weaponComponentIndices(design).length} pixiTurrets=${view.turretSprites.length}`];
  for (const sprite of view.turretSprites) {
    const i = sprite.__designIndex; const part = design[i]; const place = footprintLocalPlacement(part, SHIP_SCALE);
    const auth = ship.weaponAngles?.[i] ?? moduleRotationToRadians(normalizeRotation(part.rotation));
    const world = (ship.angle || 0) + auth; const renderedWorld = (ship.angle || 0) + sprite.rotation;
    const baked = Boolean(PART_STATS[part.type]?.weapon);
    lines.push(`#${i} ${part.type} auth=${auth.toFixed(2)} local=${sprite.rotation.toFixed(2)} world=${renderedWorld.toFixed(2)} vis=${sprite.visible} a=${sprite.alpha.toFixed(2)} parent=${sprite.parent?.name || sprite.parent?.label || "?"} bakedHull=${baked}`);
    gfx.circle(place.cx, place.cy, 2.8).fill({ color: 0xffe600, alpha: 1 });
    gfx.moveTo(place.cx, place.cy); gfx.lineTo(place.cx + Math.cos(auth) * 38, place.cy + Math.sin(auth) * 38); gfx.stroke({ width: 2, color: 0xff2525, alpha: 0.95 });
    gfx.moveTo(place.cx, place.cy); gfx.lineTo(place.cx + Math.cos(sprite.rotation) * 32, place.cy + Math.sin(sprite.rotation) * 32); gfx.stroke({ width: 2, color: 0x00e5ff, alpha: 0.95 });
  }
  view.turretDebugText.text = lines.join("\n");
  view.turretDebugText.position.set(-(ship.radius || 40), (ship.radius || 40) + 10);
}

function updatePixiTurrets(view, ship, design, env) {
  if (view.boundShipId !== ship.id) {
    view.boundShipId = ship.id;
    view.visualTurretAngles = design.map((part, i) => {
      const serverAngle = ship.weaponAngles?.[i];
      return Number.isFinite(serverAngle) ? serverAngle : moduleRotationToRadians(normalizeRotation(part.rotation));
    });
  }
  let visualAngles = view.visualTurretAngles;
  if (!visualAngles || visualAngles.length !== design.length) {
    visualAngles = design.map((part, i) => {
      const serverAngle = ship.weaponAngles?.[i];
      return Number.isFinite(serverAngle) ? serverAngle : moduleRotationToRadians(normalizeRotation(part.rotation));
    });
    view.visualTurretAngles = visualAngles;
  }
  const serverAngles = ship.weaponAngles || [];
  const dt = state.dt || 0.016;
  for (const sprite of view.turretSprites) {
    const i = sprite.__designIndex;
    const part = design[i];
    if (!part) continue;
    const healthRatio = componentHealthRatio(ship, i);
    if (healthRatio !== null && healthRatio <= 0) {
      // Destroyed turrets freeze in place and read as knocked out.
      sprite.alpha = 0.3;
      sprite.rotation = visualAngles[i];
      continue;
    }
    sprite.alpha = 1;
    const weaponStat = PART_STATS[part.type]?.weapon;
    const defaultRelative = moduleRotationToRadians(normalizeRotation(part.rotation));
    const targetRelative = serverAngles[i] !== undefined ? serverAngles[i] : defaultRelative;
    const turnRate = weaponStat ? getWeaponTurnRate(weaponStat) : 3.0;
    if (turretDebugEnabled()) {
      sprite.texture = getDebugArrowTexture(env);
      visualAngles[i] = targetRelative;
      sprite.rotation = targetRelative;
    } else {
      visualAngles[i] = approachAngle(visualAngles[i], targetRelative, turnRate * dt);
      sprite.rotation = visualAngles[i];
    }
    if (state.debugTurrets && performance.now() - (view.turretDebugLastAt || 0) > 500) {
      view.turretDebugLastAt = performance.now();
      // Disabled by default; useful when validating Pixi visual/server angle flow.
      console.debug("pixi turret", { shipId: ship.id, designIndex: i, weaponType: part.type, serverRelativeAngle: targetRelative, visualRelativeAngle: visualAngles[i], hullAngle: ship.angle || 0, finalWorldAngle: (ship.angle || 0) + visualAngles[i] });
    }
  }
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
    // Dashed "no shield" line.
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
  // The HUD name is only shown while bars are visible; hide it alongside them.
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
  const color = player ? player.color : "#ffca57";
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

  // Dashed max-range ring (Pixi has no dash support; approximate with arc segments).
  const dashLen = 6 / zoom;
  const gapLen = 10 / zoom;
  const circumference = Math.PI * 2 * maxRange;
  const dashCount = Math.min(160, Math.max(8, Math.floor(circumference / (dashLen + gapLen))));
  const dashAngle = (Math.PI * 2) / dashCount;
  const dashArc = dashAngle * (dashLen / (dashLen + gapLen));
  for (let i = 0; i < dashCount; i += 1) {
    const startAngle = i * dashAngle;
    // Seed the current point at the dash start so arc() does not connect from (0,0).
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
    const defaultRelativeFacing = moduleRotationToRadians(normalizeRotation(part.rotation));
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
      const hullKey = `${pixiDesignSignature(design)}|${player.color}|${Math.round(ship.radius || 0)}|${env.bakeScale}|${getPixiBakeGeneration()}`;
      if (view.hullKey !== hullKey) rebuildPixiShipVisual(env, view, design, player.color, ship.radius || 0, hullKey, ship);

      view.root.position.set(renderShip.x, renderShip.y);
      view.hullGroup.rotation = renderShip.angle;
      view.hullGroup.alpha = ship.alive ? 1 : 0.32;
      updatePixiShieldRing(view, ship, zoom);
      updatePixiEngineExhaust(view, renderShip, now);
      // updatePixiTurrets(view, ship, design) -- compatibility assertion: called every rendered ship frame.
      updatePixiTurrets(view, ship, design, env);
      updatePixiTurretDebug(env, view, ship, design);
      updatePixiComponentDamage(view, ship, design);
      updatePixiDamageFlashes(view, ship, design, performance.now());
      updatePixiCoreWarning(view, ship, zoom);
      updatePixiHealthBars(env, view, { ...renderShip, radius: ship.radius || 0 }, player, zoom);
      updatePixiShipLabels(view, renderShip, player, zoom);

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
