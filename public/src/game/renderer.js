// Renders background stars, nebulas, obstacles, weapon beams, and ship components to the arena canvas.

import { dom, ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp, approach } from "../shared/math.js";
import { escapeHtml } from "../shared/formatting.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../design/rotation.js";
import { formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatPercent } from "../design/statFormatting.js";
import { drawEffects } from "./effects.js";
import { drawSelectionBox, ownLiveShips } from "./selection.js";
import { updateCamera, applyCamera } from "./camera.js";
import { playerMap } from "../ui/scoreboardUi.js";

export function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  dom.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  dom.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

export function frame(now) {
  const dt = Math.min(0.05, Math.max(0.001, (now - state.lastFrameAt) / 1000));
  state.lastFrameAt = now;
  updateCamera(dt);
  renderArena(now);
  requestAnimationFrame(frame);
}

export function renderArena(now) {
  const rect = dom.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawBackdrop(rect);

  ctx.save();
  applyCamera(rect);
  drawWorldGrid();
  drawMapFeatures(now);
  drawRelays();
  drawCommandTarget(now);
  drawBullets();
  drawShips();
  drawEffects();
  drawSelectionBox();
  ctx.restore();

  drawMinimap(rect);

  if (!state.snapshot) {
    ctx.fillStyle = "rgba(237,244,255,0.72)";
    ctx.font = "700 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Join a room to enter the arena", rect.width / 2, rect.height / 2);
  }
}

export function drawBackdrop(rect) {
  const gradient = ctx.createLinearGradient(0, 0, rect.width, rect.height);
  gradient.addColorStop(0, "#040710");
  gradient.addColorStop(0.55, "#0a111d");
  gradient.addColorStop(1, "#05070c");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, rect.width, rect.height);

  ctx.save();
  ctx.globalAlpha = 0.88;
  for (const star of state.stars) {
    const x = (star.x * rect.width + state.camera.x * star.drift) % rect.width;
    const y = (star.y * rect.height + state.camera.y * star.drift) % rect.height;
    ctx.fillStyle = star.color;
    ctx.fillRect(x < 0 ? x + rect.width : x, y < 0 ? y + rect.height : y, star.size, star.size);
  }
  ctx.restore();
}

export function drawWorldGrid() {
  ctx.save();
  ctx.lineWidth = 1 / state.camera.zoom;
  ctx.strokeStyle = "rgba(130,160,205,0.11)";
  for (let x = 0; x <= state.world.width; x += 160) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, state.world.height);
    ctx.stroke();
  }
  for (let y = 0; y <= state.world.height; y += 160) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(state.world.width, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3 / state.camera.zoom;
  ctx.strokeRect(0, 0, state.world.width, state.world.height);
  ctx.restore();
}

export function drawMapFeatures(now) {
  const map = state.snapshot?.map || state.map;
  if (!map) return;

  for (const cloud of map.clouds || []) drawNebula(cloud);
  for (const asteroid of map.asteroids || []) drawAsteroid(asteroid, now);
}

export function drawNebula(cloud) {
  const rx = cloud.rx || 300;
  const ry = cloud.ry || 180;
  const color = cloud.color || "56,213,255";
  const alpha = cloud.alpha || 0.12;

  ctx.save();
  ctx.translate(cloud.x, cloud.y);
  ctx.rotate(cloud.rotation || 0);
  const gradient = ctx.createRadialGradient(0, 0, Math.min(rx, ry) * 0.1, 0, 0, rx);
  gradient.addColorStop(0, `rgba(${color}, ${alpha})`);
  gradient.addColorStop(0.52, `rgba(${color}, ${alpha * 0.42})`);
  gradient.addColorStop(1, `rgba(${color}, 0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawAsteroid(asteroid, now) {
  const radius = asteroid.radius || 60;
  const shape = asteroid.shape?.length ? asteroid.shape : [1, 0.92, 1.08, 0.9, 1.12, 0.96, 1.05, 0.88, 1.1, 0.95, 1.03, 0.9];
  const base = asteroid.shade === "warm" ? "#5a4939" : "#394657";
  const edge = asteroid.shade === "warm" ? "#ad8b64" : "#8495aa";

  ctx.save();
  ctx.translate(asteroid.x, asteroid.y);
  ctx.rotate((asteroid.rotation || 0) + (asteroid.spin || 0) * now * 0.001);
  ctx.shadowColor = "rgba(0,0,0,0.42)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 8;

  const gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
  gradient.addColorStop(0, edge);
  gradient.addColorStop(0.38, base);
  gradient.addColorStop(1, "#171d26");
  ctx.fillStyle = gradient;
  ctx.strokeStyle = "rgba(220,235,255,0.22)";
  ctx.lineWidth = Math.max(1.5, 2.5 / state.camera.zoom);
  ctx.beginPath();
  for (let i = 0; i < shape.length; i += 1) {
    const angle = i / shape.length * Math.PI * 2;
    const r = radius * shape[i];
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();

  ctx.fillStyle = "rgba(0,0,0,0.24)";
  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  for (const crater of asteroid.craters || []) {
    const angle = crater.angle || 0;
    const distance = radius * (crater.distance || 0.3);
    const craterRadius = radius * (crater.radius || 0.12);
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, craterRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

export function drawRelays() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();

  for (const point of snap.points) {
    const owner = point.ownerId ? players.get(point.ownerId) : null;
    const color = owner?.color || "rgba(180,200,225,0.62)";

    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.76;
    ctx.lineWidth = 3 / state.camera.zoom;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * point.progress);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = "#eaf3ff";
    ctx.font = `${Math.max(18, 24 / state.camera.zoom)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(point.id, 0, 0);
    ctx.font = `${Math.max(10, 13 / state.camera.zoom)}px system-ui, sans-serif`;
    const ownerText = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
    ctx.fillText(ownerText, 0, point.radius + 18 / state.camera.zoom);
    ctx.restore();
  }
}

export function drawCommandTarget(now) {
  if (!state.command) return;
  const age = now - state.command.at;
  if (age > 1600) {
    state.command = null;
    return;
  }
  const alpha = 1 - age / 1600;
  ctx.save();
  ctx.translate(state.command.x, state.command.y);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = state.command.targetName ? "#ff5f7e" : "#ffca57";
  ctx.lineWidth = 3 / state.camera.zoom;
  ctx.beginPath();
  ctx.arc(0, 0, 26 + age * 0.025, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-42, 0);
  ctx.lineTo(42, 0);
  ctx.moveTo(0, -42);
  ctx.lineTo(0, 42);
  ctx.stroke();
  ctx.restore();
}

export function drawBullets() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();

  for (const bullet of snap.bullets) {
    const owner = players.get(bullet.ownerId);
    const color = owner?.color || "#ffffff";
    ctx.save();
    ctx.translate(bullet.x, bullet.y);
    ctx.rotate(Math.atan2(bullet.vy, bullet.vx));
    ctx.fillStyle = bullet.type === "missile" ? "#f7d37b" : bullet.type === "rail" ? "#f4f7ff" : color;
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = bullet.type === "rail" ? 22 : bullet.type === "missile" ? 18 : 12;
    if (bullet.type === "rail") {
      ctx.fillRect(-18, -2, 36, 4);
    } else {
      ctx.fillRect(bullet.type === "missile" ? -10 : -7, bullet.type === "missile" ? -3 : -2, bullet.type === "missile" ? 20 : 14, bullet.type === "missile" ? 6 : 4);
    }
    ctx.restore();
  }
}

export function drawShips() {
  const snap = state.snapshot;
  if (!snap) return;
  const players = playerMap();
  const visibleShipIds = new Set();

  for (const ship of snap.ships) {
    visibleShipIds.add(ship.id);
    const player = players.get(ship.ownerId);
    if (!player) continue;
    drawShip(ship, player);
  }

  for (const id of state.shipHud.keys()) {
    if (!visibleShipIds.has(id)) state.shipHud.delete(id);
  }
}

export function drawShip(ship, player) {
  const selected = state.selectedShipIds.has(ship.id);
  const alpha = ship.alive ? 1 : 0.32;
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);
  ctx.globalAlpha = alpha;

  const design = ship.design || player.design || [];
  const scale = 13;
  drawShipStructure(design, scale, player.color);
  for (const part of design) {
    const def = PART_DEFS[part.type] || PART_DEFS.frame;
    const { x: px, y: py } = moduleLocalPosition(part, scale);
    ctx.save();
    ctx.translate(px, py);
    if (isRotatablePart(part.type)) ctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
    drawModule(0, 0, scale - 1, def.color, part.type, player.color);
    ctx.restore();
  }

  ctx.strokeStyle = player.color;
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(ship.radius + 8, 0);
  ctx.lineTo(ship.radius - 8, -7);
  ctx.lineTo(ship.radius - 8, 7);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();

  if (selected) drawSelectionRing(ship);
  if (ship.focusTargetId) drawFocusLine(ship);
  drawHealthBars(ship, player);
  drawShipName(ship, player);
  if (!ship.alive) drawRespawn(ship);
}

export function drawShipStructure(design, scale, color) {
  const keys = new Set(design.map((part) => `${part.x},${part.y}`));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, scale * 0.26);
  ctx.strokeStyle = "rgba(0,0,0,0.42)";
  drawStructureLines(design, keys, scale);
  ctx.lineWidth = Math.max(1.2, scale * 0.12);
  ctx.strokeStyle = color;
  ctx.globalAlpha *= 0.48;
  drawStructureLines(design, keys, scale);
  ctx.restore();
}

export function drawStructureLines(design, keys, scale) {
  ctx.beginPath();
  for (const part of design) {
    const { x, y } = moduleLocalPosition(part, scale);
    if (keys.has(`${part.x + 1},${part.y}`)) {
      const next = moduleLocalPosition({ x: part.x + 1, y: part.y }, scale);
      ctx.moveTo(x, y);
      ctx.lineTo(next.x, next.y);
    }
    if (keys.has(`${part.x},${part.y + 1}`)) {
      const next = moduleLocalPosition({ x: part.x, y: part.y + 1 }, scale);
      ctx.moveTo(x, y);
      ctx.lineTo(next.x, next.y);
    }
  }
  ctx.stroke();
}

export function moduleLocalPosition(part, scale) {
  return {
    x: (3 - part.y) * scale,
    y: (part.x - 3) * scale
  };
}

export function drawModule(x, y, size, color, type, trim) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.15, size * 0.12);
  ctx.strokeStyle = trim;
  ctx.shadowColor = color;
  ctx.shadowBlur = type === "core" || type === "reactor" || type === "shield" ? 8 : 3;

  const fill = ctx.createLinearGradient(-size * 0.55, -size * 0.55, size * 0.55, size * 0.55);
  fill.addColorStop(0, "rgba(255,255,255,0.42)");
  fill.addColorStop(0.24, color);
  fill.addColorStop(1, "rgba(8,12,20,0.92)");
  ctx.fillStyle = fill;

  if (type === "core") {
    roundRect(ctx, { x: -size * 0.48, y: -size * 0.48, width: size * 0.96, height: size * 0.96, radius: size * 0.18 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#f8fbff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6ee7ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "frame") {
    roundRect(ctx, { x: -size * 0.46, y: -size * 0.46, width: size * 0.92, height: size * 0.92, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.42)";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.moveTo(-size * 0.28, -size * 0.28);
    ctx.lineTo(size * 0.28, size * 0.28);
    ctx.moveTo(size * 0.28, -size * 0.28);
    ctx.lineTo(-size * 0.28, size * 0.28);
    ctx.stroke();
  } else if (type === "armor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.24);
    ctx.lineTo(-size * 0.18, -size * 0.48);
    ctx.lineTo(size * 0.42, -size * 0.34);
    ctx.lineTo(size * 0.48, size * 0.2);
    ctx.lineTo(size * 0.18, size * 0.48);
    ctx.lineTo(-size * 0.48, size * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,244,220,0.38)";
    ctx.beginPath();
    ctx.moveTo(-size * 0.18, -size * 0.34);
    ctx.lineTo(size * 0.24, size * 0.28);
    ctx.stroke();
  } else if (type === "engine") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.48, -size * 0.38);
    ctx.lineTo(size * 0.4, -size * 0.24);
    ctx.lineTo(size * 0.48, size * 0.24);
    ctx.lineTo(-size * 0.48, size * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffca57";
    ctx.beginPath();
    ctx.moveTo(-size * 0.58, -size * 0.18);
    ctx.lineTo(-size * 0.95, 0);
    ctx.lineTo(-size * 0.58, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#89f7ff";
    ctx.fillRect(-size * 0.35, -size * 0.16, size * 0.26, size * 0.32);
  } else if (type === "blaster") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#ffd1dc";
    roundRect(ctx, { x: size * 0.02, y: -size * 0.13, width: size * 0.62, height: size * 0.26, radius: size * 0.08 });
    ctx.fill();
  } else if (type === "missile") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#f0dcff";
    ctx.beginPath();
    ctx.moveTo(size * 0.64, 0);
    ctx.lineTo(size * 0.08, -size * 0.2);
    ctx.lineTo(-size * 0.08, 0);
    ctx.lineTo(size * 0.08, size * 0.2);
    ctx.closePath();
    ctx.fill();
  } else if (type === "railgun") {
    drawWeaponBase(size, color);
    ctx.strokeStyle = "#f4f7ff";
    ctx.lineWidth = Math.max(1.2, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(-size * 0.04, -size * 0.16);
    ctx.lineTo(size * 0.68, -size * 0.16);
    ctx.moveTo(-size * 0.04, size * 0.16);
    ctx.lineTo(size * 0.68, size * 0.16);
    ctx.stroke();
    ctx.fillStyle = "#7aa4ff";
    ctx.fillRect(size * 0.42, -size * 0.06, size * 0.16, size * 0.12);
  } else if (type === "reactor") {
    drawRoundSystem(size);
    ctx.fillStyle = "#fff7b3";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#6b4b12";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "battery") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#d5fbff";
    for (let i = 0; i < 3; i += 1) {
      ctx.fillRect(-size * 0.25, -size * 0.28 + i * size * 0.21, size * 0.5, size * 0.09);
    }
  } else if (type === "shield") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#b9ffd0";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, Math.PI * 0.15, Math.PI * 1.85);
    ctx.stroke();
  } else if (type === "repair") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#d7ffe2";
    ctx.lineWidth = Math.max(1.4, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, 0);
    ctx.lineTo(size * 0.24, 0);
    ctx.moveTo(0, -size * 0.24);
    ctx.lineTo(0, size * 0.24);
    ctx.stroke();
  } else {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.1 });
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

export function drawWeaponBase(size) {
  roundRect(ctx, { x: -size * 0.46, y: -size * 0.32, width: size * 0.68, height: size * 0.64, radius: size * 0.12 });
  ctx.fill();
  ctx.stroke();
}

export function drawRoundSystem(size) {
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawSelectionRing(ship) {
  ctx.save();
  ctx.strokeStyle = "#ffca57";
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.setLineDash([10 / state.camera.zoom, 7 / state.camera.zoom]);
  ctx.beginPath();
  ctx.arc(ship.x, ship.y, ship.radius + 14, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function drawFocusLine(ship) {
  const target = state.snapshot?.ships?.find((candidate) => candidate.id === ship.focusTargetId);
  if (!target) return;
  ctx.save();
  ctx.globalAlpha = 0.36;
  ctx.strokeStyle = "#ff5f7e";
  ctx.lineWidth = 1.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(ship.x, ship.y);
  ctx.lineTo(target.x, target.y);
  ctx.stroke();
  ctx.restore();
}

export function drawHealthBars(ship, player) {
  if (!ship.alive) return;
  const selected = state.selectedShipIds.has(ship.id);
  const damaged = ship.hp < ship.maxHp || ship.shield < ship.maxShield;
  const width = Math.max(selected ? 72 : 56, ship.radius * (selected ? 2.15 : 1.85));
  const x = ship.x - width / 2;
  const frameHeight = selected ? 34 : 25;
  const y = ship.y - ship.radius - (selected ? 46 : 35);
  const now = performance.now();
  const hud = updateShipHud(ship, now);
  const hullRatio = clamp(hud.hp / ship.maxHp, 0, 1);
  const hullLagRatio = clamp(hud.hpLag / ship.maxHp, 0, 1);
  const shieldRatio = ship.maxShield > 0 ? clamp(hud.shield / ship.maxShield, 0, 1) : 0;
  const shieldLagRatio = ship.maxShield > 0 ? clamp(hud.shieldLag / ship.maxShield, 0, 1) : 0;
  const lowHull = hullRatio <= 0.25;
  const alpha = selected || damaged ? 1 : 0.68;
  const pulse = clamp(1 - (now - hud.hitAt) / 280, 0, 1);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = pulse > 0 && hud.lastHitShield ? "rgba(81,226,255,0.85)" : player.color;
  ctx.shadowBlur = 4 + pulse * 11;
  drawHudFrame(x - 4, y - 4, width + 8, frameHeight, player.color, lowHull);
  ctx.shadowBlur = 0;

  const shieldY = y + 1;
  const hullY = y + (selected ? 9 : 8);
  const shieldHeight = selected ? 6 : 4;
  const hullHeight = selected ? 7 : 6;

  if (ship.maxShield > 0) {
    drawStatusBar({
      x,
      y: shieldY,
      width,
      height: shieldHeight,
      ratio: shieldRatio,
      lagRatio: shieldLagRatio,
      fillStart: "#b8f7ff",
      fillEnd: "#38d5ff",
      glow: "rgba(56,213,255,0.62)",
      segments: 6
    });
  } else {
    drawEmptyShieldLine(x, shieldY, width);
  }

  const hullColor = hullColorForRatio(hullRatio);
  drawStatusBar({
    x,
    y: hullY,
    width,
    height: hullHeight,
    ratio: hullRatio,
    lagRatio: hullLagRatio,
    fillStart: hullColor.start,
    fillEnd: hullColor.end,
    glow: lowHull ? "rgba(255,95,126,0.78)" : `${player.color}aa`,
    segments: selected ? 8 : 6
  });

  ctx.shadowColor = lowHull ? "rgba(255,95,126,0.9)" : player.color;
  ctx.shadowBlur = lowHull ? 9 : 4;
  ctx.fillStyle = lowHull ? "#ffd6df" : "rgba(237,244,255,0.86)";
  ctx.font = `${Math.max(9, (selected ? 10 : 9) / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  if (selected) {
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(213,236,255,0.86)";
    ctx.font = `${Math.max(8, 8 / state.camera.zoom)}px system-ui, sans-serif`;
    ctx.fillText(`Shield ${Math.round(shieldRatio * 100)}%  Hull ${Math.round(hullRatio * 100)}%`, ship.x, y + 18);
  }

  ctx.shadowBlur = lowHull ? 8 : 3;
  ctx.fillStyle = "rgba(237,244,255,0.9)";
  ctx.font = `${Math.max(9, (selected ? 10 : 9) / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.fillText(player.name, ship.x, y + frameHeight + 2);
  ctx.restore();
}

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

export function drawHudFrame(x, y, width, height, color, warning) {
  ctx.save();
  ctx.fillStyle = "rgba(3,8,15,0.72)";
  ctx.strokeStyle = warning ? "rgba(255,95,126,0.9)" : color;
  ctx.lineWidth = 1.25 / state.camera.zoom;
  ctx.beginPath();
  ctx.moveTo(x + 7, y);
  ctx.lineTo(x + width - 7, y);
  ctx.lineTo(x + width, y + 7);
  ctx.lineTo(x + width - 5, y + height);
  ctx.lineTo(x + 5, y + height);
  ctx.lineTo(x, y + height - 7);
  ctx.lineTo(x + 7, y);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = warning ? 0.92 : 0.62;
  ctx.stroke();
  ctx.strokeStyle = "rgba(237,244,255,0.22)";
  ctx.beginPath();
  ctx.moveTo(x + 9, y + 3);
  ctx.lineTo(x + width - 15, y + 3);
  ctx.stroke();
  ctx.restore();
}

export function drawStatusBar(options) {
  const { x, y, width, height, ratio, lagRatio, fillStart, fillEnd, glow, segments } = options;
  ctx.save();
  roundRect(ctx, { x, y, width, height, radius: Math.max(1, height * 0.35) });
  ctx.fillStyle = "rgba(1,5,10,0.82)";
  ctx.fill();

  if (lagRatio > ratio) {
    roundRect(ctx, { x, y, width: width * lagRatio, height, radius: Math.max(1, height * 0.35) });
    ctx.fillStyle = "rgba(255,245,194,0.48)";
    ctx.fill();
  }

  if (ratio > 0) {
    const fill = ctx.createLinearGradient(x, y, x + width, y);
    fill.addColorStop(0, fillStart);
    fill.addColorStop(1, fillEnd);
    ctx.shadowColor = glow;
    ctx.shadowBlur = 7;
    roundRect(ctx, { x, y, width: width * ratio, height, radius: Math.max(1, height * 0.35) });
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(225,241,255,0.22)";
  ctx.lineWidth = 0.9 / state.camera.zoom;
  roundRect(ctx, { x, y, width, height, radius: Math.max(1, height * 0.35) });
  ctx.stroke();

  ctx.strokeStyle = "rgba(2,8,16,0.72)";
  ctx.lineWidth = 0.8 / state.camera.zoom;
  const step = width / segments;
  for (let i = 1; i < segments; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + step * i, y + 1);
    ctx.lineTo(x + step * i, y + height - 1);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawEmptyShieldLine(x, y, width) {
  ctx.save();
  ctx.strokeStyle = "rgba(88,122,150,0.42)";
  ctx.lineWidth = 1 / state.camera.zoom;
  ctx.setLineDash([4 / state.camera.zoom, 4 / state.camera.zoom]);
  ctx.beginPath();
  ctx.moveTo(x, y + 2);
  ctx.lineTo(x + width, y + 2);
  ctx.stroke();
  ctx.restore();
}

export function hullColorForRatio(ratio) {
  if (ratio <= 0.25) return { start: "#ffd0d9", end: "#ff5f7e" };
  if (ratio <= 0.55) return { start: "#fff1a6", end: "#ffca57" };
  return { start: "#d8ffe3", end: "#67e08a" };
}

export function drawShipName(ship, player) {
  if (!ship.alive || state.camera.zoom < 0.48 || state.selectedShipIds.has(ship.id)) return;
  if (ship.hp < ship.maxHp || ship.shield < ship.maxShield) return;
  ctx.save();
  ctx.fillStyle = "rgba(237,244,255,0.5)";
  ctx.font = `${Math.max(10, 11 / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(player.name, ship.x, ship.y + ship.radius + 18);
  ctx.restore();
}

export function drawRespawn(ship) {
  ctx.save();
  ctx.fillStyle = "rgba(237,244,255,0.7)";
  ctx.font = `${Math.max(11, 13 / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("lost", ship.x, ship.y - ship.radius - 12);
  ctx.restore();
}

export function drawMinimap(rect) {
  const w = Math.min(190, Math.max(142, rect.width * 0.19));
  const h = w * (state.world.height / state.world.width);
  const x = 14;
  const y = 88;
  state.minimap = { x, y, w, h };

  ctx.save();
  ctx.fillStyle = "rgba(7,12,20,0.78)";
  ctx.strokeStyle = "rgba(174,199,231,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, { x, y, w, h, radius: 8 });
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  roundRect(ctx, { x, y, w, h, radius: 8 });
  ctx.clip();

  const sx = w / state.world.width;
  const sy = h / state.world.height;
  const snap = state.snapshot;
  const map = state.snapshot?.map || state.map;
  if (map) {
    for (const cloud of map.clouds || []) {
      ctx.fillStyle = `rgba(${cloud.color || "56,213,255"}, 0.12)`;
      ctx.beginPath();
      ctx.ellipse(x + cloud.x * sx, y + cloud.y * sy, Math.max(3, cloud.rx * sx), Math.max(2, cloud.ry * sy), cloud.rotation || 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const asteroid of map.asteroids || []) {
      ctx.fillStyle = "rgba(172,185,202,0.45)";
      ctx.strokeStyle = "rgba(22,28,37,0.82)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x + asteroid.x * sx, y + asteroid.y * sy, Math.max(2.5, asteroid.radius * sx), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  if (snap) {
    const players = playerMap();
    for (const point of snap.points) {
      const owner = players.get(point.ownerId);
      ctx.fillStyle = owner?.color || "rgba(220,230,245,0.42)";
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(x + point.x * sx, y + point.y * sy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const ship of snap.ships) {
      if (!ship.alive) continue;
      const player = players.get(ship.ownerId);
      ctx.fillStyle = player?.color || "#ffffff";
      ctx.fillRect(x + ship.x * sx - 2, y + ship.y * sy - 2, 4, 4);
    }
  }

  const viewW = rect.width / state.camera.zoom;
  const viewH = rect.height / state.camera.zoom;
  ctx.strokeStyle = "#ffca57";
  ctx.lineWidth = 1;
  ctx.strokeRect(
    x + (state.camera.x - viewW / 2) * sx,
    y + (state.camera.y - viewH / 2) * sy,
    viewW * sx,
    viewH * sy
  );
  ctx.restore();
}

function roundRect(context, { x, y, width, height, radius }) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
