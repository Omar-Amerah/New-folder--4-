// Ship rendering for the PixiJS arena renderer: baked hull sprites, rotating
// turret sprites, per-frame HUD bars, name labels, and selection overlays.
// Hull art is baked by replaying the Canvas 2D module drawing into textures.

import { state } from "../../state.js";
import { clamp } from "../../shared/math.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "../../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../../design/rotation.js";
import { isCircleVisible, drawShipStructure, drawModule, drawFootprintComponent, moduleLocalPosition, footprintLocalPlacement, updateShipHud, getWeaponTurnRate, approachAngle, hullColorForRatio, shieldRatioForShip, shieldRingRadius, shipEngineNozzles, engineThrustRatio, emitEngineSmoke, maxSpeedForRenderedShip, componentHealthRatio } from "../renderer.js";
import { pixiBakeTexture, registerPixiTextureCache, createPixiKeyedPool, getPixiBakeGeneration } from "./pixiBake.js";

const SHIP_SCALE = 13;
// Nominal zoom used when baking zoom-compensated line widths into textures.
const BAKE_NOMINAL_ZOOM = 0.6;

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
      if (isRotatablePart(part.type)) continue;
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const place = footprintLocalPlacement(part, SHIP_SCALE);
      if (place.multi) {
        bctx.save();
        bctx.translate(place.cx, place.cy);
        bctx.rotate(place.longAxisAngle);
        drawFootprintComponent({ type: part.type, unit: SHIP_SCALE - 1, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: color });
        bctx.restore();
      } else {
        drawModule({ x: place.cx, y: place.cy, size: SHIP_SCALE - 1, color: def.color, type: part.type, trim: color });
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
  // Extent must cover the elongated barrel (canonical art spans ±tilesLong/2).
  const halfExtent = SHIP_SCALE * (multi ? tilesLong * 0.62 + 1.0 : 2.1);
  texture = pixiBakeTexture(env, halfExtent * 2, halfExtent * 2, () => {
    if (multi) {
      drawFootprintComponent({ type: partType, unit: SHIP_SCALE - 1, tilesLong, tilesCross, color: def.color, trim });
    } else {
      drawModule({ x: 0, y: 0, size: SHIP_SCALE - 1, color: def.color, type: partType, trim });
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
  const damageGfx = new PIXI.Graphics(); // destroyed/damaged component overlays
  hullGroup.addChild(engineGfx);
  hullGroup.addChild(hullSprite);
  hullGroup.addChild(damageGfx);
  const hudGfx = new PIXI.Graphics();
  const makeText = (style) => {
    const text = new PIXI.Text({ text: "", style, resolution: 2 });
    text.anchor.set(0.5);
    text.visible = false;
    return text;
  };
  const shieldText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "900", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.65)", width: 2 } });
  const hullText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 12, fontWeight: "900", fill: "#ffffff", stroke: { color: "rgba(0,0,0,0.65)", width: 2 } });
  const hudName = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fontWeight: "bold", fill: "#ffffff" });
  const idleName = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 13, fill: "rgba(237,244,255,0.5)" });
  const lostText = makeText({ fontFamily: "system-ui, sans-serif", fontSize: 14, fill: "rgba(237,244,255,0.7)" });
  root.addChild(shieldGfx);
  root.addChild(hullGroup);
  root.addChild(hudGfx);
  root.addChild(shieldText);
  root.addChild(hullText);
  root.addChild(hudName);
  root.addChild(idleName);
  root.addChild(lostText);
  return {
    root,
    shieldGfx,
    hullGroup,
    engineGfx,
    engines: [],
    hullSprite,
    damageGfx,
    damageSig: null,
    turretSprites: [],
    hudGfx,
    shieldText,
    hullText,
    hudName,
    idleName,
    lostText,
    hullKey: null,
    names: { hud: null, idle: null },
    release() {
      this.hullKey = null;
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
  const alpha = 0.18 + ratio * 0.42;
  const lineWidth = Math.max(1.7, ringRadius * 0.04) / zoom;
  const now = performance.now() * 0.001;
  const phase = now * 1.15 + pixiShieldIdPhase(ship.id);
  const segmentCount = 12;
  const step = (Math.PI * 2) / segmentCount;
  const gap = step * 0.26;
  const activeSegments = ratio * segmentCount;

  gfx.visible = true;
  gfx.circle(0, 0, ringRadius + lineWidth * 2.2);
  gfx.fill(`rgba(56,213,255,${alpha * 0.035})`);

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

function rebuildPixiShipVisual(env, view, design, color, radius, hullKey) {
  view.hullSprite.texture = getPixiShipHullTexture(env, design, color, radius);
  view.hullSprite.scale.set(1 / env.bakeScale);
  for (const sprite of view.turretSprites) sprite.destroy();
  view.turretSprites = [];
  design.forEach((part, i) => {
    if (!isRotatablePart(part.type)) return;
    const sprite = new env.PIXI.Sprite(getPixiTurretTexture(env, part.type, color));
    sprite.anchor.set(0.5);
    sprite.scale.set(1 / env.bakeScale);
    // Multi-tile weapons pivot at their footprint centre, not the anchor cell.
    const place = footprintLocalPlacement(part, SHIP_SCALE);
    sprite.position.set(place.cx, place.cy);
    sprite.__designIndex = i;
    view.hullGroup.addChild(sprite);
    view.turretSprites.push(sprite);
  });
  // Keep the damage overlay above the freshly re-added turret sprites.
  view.hullGroup.addChild(view.damageGfx);
  view.damageSig = null;
  view.engines = shipEngineNozzles(design, SHIP_SCALE);
  view.hullKey = hullKey;
}

// Draws darkened slabs (plus cracks when destroyed) over damaged components.
// Redrawn only when the quantized damage signature changes, so healthy ships
// cost nothing per frame.
function updatePixiComponentDamage(view, ship, design) {
  const gfx = view.damageGfx;
  if (!ship.chp) {
    if (view.damageSig !== null) {
      gfx.clear();
      view.damageSig = null;
    }
    return;
  }

  let sig = "";
  for (let i = 0; i < design.length; i += 1) {
    const ratio = componentHealthRatio(ship, i);
    if (ratio === null || ratio >= 0.55) continue;
    sig += `${i}:${ratio <= 0 ? "x" : Math.round(ratio * 10)};`;
  }
  if (sig === view.damageSig) return;
  view.damageSig = sig;
  gfx.clear();
  if (!sig) return;

  for (let i = 0; i < design.length; i += 1) {
    const ratio = componentHealthRatio(ship, i);
    if (ratio === null || ratio >= 0.55) continue;
    const part = design[i];
    const place = footprintLocalPlacement(part, SHIP_SCALE);
    const halfW = (place.tilesLong * (SHIP_SCALE - 1)) / 2;
    const halfH = (place.tilesCross * (SHIP_SCALE - 1)) / 2;
    const ang = place.multi ? place.longAxisAngle : 0;
    const cos = Math.cos(ang);
    const sin = Math.sin(ang);
    const corner = (x, y) => [place.cx + x * cos - y * sin, place.cy + x * sin + y * cos];
    const pt = (x, y) => {
      const [px, py] = corner(x, y);
      return { x: px, y: py };
    };

    const c0 = pt(-halfW, -halfH);
    const c1 = pt(halfW, -halfH);
    const c2 = pt(halfW, halfH);
    const c3 = pt(-halfW, halfH);
    gfx.moveTo(c0.x, c0.y);
    gfx.lineTo(c1.x, c1.y);
    gfx.lineTo(c2.x, c2.y);
    gfx.lineTo(c3.x, c3.y);
    gfx.closePath();

    if (ratio <= 0) {
      gfx.fill({ color: 0x07090d, alpha: 0.78 });
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
    } else {
      gfx.fill({ color: 0x080a0e, alpha: (0.55 - ratio) * 0.85 });
    }
  }
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
  emitEngineSmoke(ship, view.engines, SHIP_SCALE, now);
  if (intensity <= 0.03) {
    gfx.visible = false;
    return;
  }
  gfx.visible = true;

  const t = now * 0.001;
  const phase = pixiEngineIdPhase(ship.id);
  for (let e = 0; e < view.engines.length; e += 1) {
    const nz = view.engines[e];
    const flicker = 0.78 + 0.22 * Math.sin(t * 34 + phase + e * 1.7) + 0.08 * Math.sin(t * 61 + e);
    const halfW = nz.halfW * (0.8 + intensity * 0.65);
    const len = halfW * (1.2 + intensity * 9.4 + speedRatio * 2.4) * flicker;
    const ox = nz.x;
    const oy = nz.y;

    // Outer glow plume (wide, faint).
    gfx.moveTo(ox, oy - halfW * 1.15);
    gfx.quadraticCurveTo(ox - len * 0.55, oy - halfW * 0.7, ox - len, oy);
    gfx.quadraticCurveTo(ox - len * 0.55, oy + halfW * 0.7, ox, oy + halfW * 1.15);
    gfx.closePath();
    gfx.fill({ color: "#2b7bff", alpha: 0.18 + intensity * 0.22 });

    // Inner flame body.
    const innerLen = len * 0.72;
    gfx.moveTo(ox, oy - halfW * 0.72);
    gfx.quadraticCurveTo(ox - innerLen * 0.5, oy - halfW * 0.42, ox - innerLen, oy);
    gfx.quadraticCurveTo(ox - innerLen * 0.5, oy + halfW * 0.42, ox, oy + halfW * 0.72);
    gfx.closePath();
    gfx.fill({ color: "#63e6ff", alpha: 0.5 + intensity * 0.4 });

    // Hot core near the nozzle.
    const coreLen = len * 0.4;
    gfx.moveTo(ox + 0.5, oy - halfW * 0.42);
    gfx.quadraticCurveTo(ox - coreLen * 0.5, oy - halfW * 0.24, ox - coreLen, oy);
    gfx.quadraticCurveTo(ox - coreLen * 0.5, oy + halfW * 0.24, ox + 0.5, oy + halfW * 0.42);
    gfx.closePath();
    gfx.fill({ color: "#eafcff", alpha: 0.72 + intensity * 0.28 });
  }
}

function updatePixiTurrets(view, ship, design) {
  if (!state.weaponAnglesMap) state.weaponAnglesMap = new Map();
  let visualAngles = state.weaponAnglesMap.get(ship.id);
  if (!visualAngles || visualAngles.length !== design.length) {
    visualAngles = design.map((part) => moduleRotationToRadians(normalizeRotation(part.rotation)));
    state.weaponAnglesMap.set(ship.id, visualAngles);
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
    visualAngles[i] = approachAngle(visualAngles[i], targetRelative, turnRate * dt);
    sprite.rotation = visualAngles[i];
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
      if (view.hullKey !== hullKey) rebuildPixiShipVisual(env, view, design, player.color, ship.radius || 0, hullKey);

      view.root.position.set(renderShip.x, renderShip.y);
      view.hullGroup.rotation = renderShip.angle;
      view.hullGroup.alpha = ship.alive ? 1 : 0.32;
      updatePixiShieldRing(view, ship, zoom);
      updatePixiEngineExhaust(view, renderShip, now);
      updatePixiTurrets(view, ship, design);
      updatePixiComponentDamage(view, ship, design);
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

  if (state.weaponAnglesMap) {
    for (const shipId of state.weaponAnglesMap.keys()) {
      if (!visibleShipIds.has(shipId)) state.weaponAnglesMap.delete(shipId);
    }
  }
  for (const id of state.shipHud.keys()) {
    if (!visibleShipIds.has(id)) state.shipHud.delete(id);
  }
}
