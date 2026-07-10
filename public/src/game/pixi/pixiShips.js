// Ship rendering for the PixiJS arena renderer: baked hull sprites, rotating
// turret sprites, per-frame HUD bars, name labels, and selection overlays.
// Hull art is baked by replaying the Canvas 2D module drawing into textures.

import { state } from "../../state.js";
import { clamp } from "../../shared/math.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "../../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../../design/rotation.js";
import { isCircleVisible, drawShipStructure, drawModule, moduleLocalPosition, updateShipHud, getWeaponTurnRate, approachAngle, hullColorForRatio } from "../renderer.js";
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
  const pad = SHIP_SCALE * 0.95 + 16;
  const halfW = maxAbsX + pad;
  const halfH = maxAbsY + pad;

  texture = pixiBakeTexture(env, halfW * 2, halfH * 2, (bctx) => {
    drawShipStructure(design, SHIP_SCALE, color);
    for (const part of design) {
      if (isRotatablePart(part.type)) continue;
      const def = PART_DEFS[part.type] || PART_DEFS.frame;
      const { x, y } = moduleLocalPosition(part, SHIP_SCALE);
      drawModule({ x, y, size: SHIP_SCALE - 1, color: def.color, type: part.type, trim: color });
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
  const halfExtent = SHIP_SCALE * 2.1;
  texture = pixiBakeTexture(env, halfExtent * 2, halfExtent * 2, () => {
    drawModule({ x: 0, y: 0, size: SHIP_SCALE - 1, color: def.color, type: partType, trim });
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
  const hullGroup = new PIXI.Container();
  const hullSprite = new PIXI.Sprite();
  hullSprite.anchor.set(0.5);
  hullGroup.addChild(hullSprite);
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
  root.addChild(hullGroup);
  root.addChild(hudGfx);
  root.addChild(shieldText);
  root.addChild(hullText);
  root.addChild(hudName);
  root.addChild(idleName);
  root.addChild(lostText);
  return {
    root,
    hullGroup,
    hullSprite,
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
    const { x, y } = moduleLocalPosition(part, SHIP_SCALE);
    sprite.position.set(x, y);
    sprite.__designIndex = i;
    view.hullGroup.addChild(sprite);
    view.turretSprites.push(sprite);
  });
  view.hullKey = hullKey;
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
  const shieldRatio = ship.maxShield > 0 ? clamp(hud.shield / ship.maxShield, 0, 1) : 0;
  const shieldLagRatio = ship.maxShield > 0 ? clamp(hud.shieldLag / ship.maxShield, 0, 1) : 0;
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
    drawPixiStatusBar(env, gfx, {
      x: barX, y: shieldY, width: barWidth, height: shieldHeight,
      ratio: shieldRatio, lagRatio: shieldLagRatio,
      gradientId: "shield", gradientStops: [{ offset: 0, color: "#0a2540" }, { offset: 1, color: "#38bdf8" }],
      segments: 6, zoom
    });
    setPixiBarText(view.shieldText, hud.shield, ship.maxShield, shieldHeight, barX + barWidth / 2, shieldY + shieldHeight / 2);
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
    const { x: px, y: py } = moduleLocalPosition(part, SHIP_SCALE);
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
      updatePixiTurrets(view, ship, design);
      updatePixiHealthBars(env, view, { ...renderShip, radius: ship.radius || 0 }, player, zoom);
      updatePixiShipLabels(view, renderShip, player, zoom);

      if (state.selectedShipIds.has(ship.id)) drawPixiSelectionRing(env, overlay, renderShip, zoom);
      if (ship.focusTargetId) drawPixiFocusLine(overlay, renderShip, zoom);
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
