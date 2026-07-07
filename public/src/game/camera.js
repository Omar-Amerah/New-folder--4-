import { PART_DEFS, SHIP_ECONOMY, PART_STATS, LOCAL_DESIGN_KEY, LOCAL_SAVED_DESIGNS_KEY, LOCAL_ACTIVE_ROOM_KEY } from "../constants.js";
import { dom, ctx, state } from "../ui/dom.js";
import { joinRoom } from "../ui/lobbyUi.js";
import { formatPercent, makeDesignPart, isRotatablePart, normalizeRotation } from "../ui/purchaseUi.js";
import { ownLiveShips, frame, updateCamera, renderArena, drawBackdrop, drawWorldGrid, drawMapFeatures, drawNebula, drawAsteroid, drawRelays, drawCommandTarget, drawBullets, drawShips, drawShip, drawShipStructure, drawStructureLines, moduleLocalPosition, moduleRotationToRadians, drawModule, drawWeaponBase, drawRoundSystem, drawSelectionRing, drawFocusLine, drawHealthBars, updateShipHud, drawHudFrame, drawStatusBar, drawEmptyShieldLine, hullColorForRatio, approach, drawShipName, drawRespawn, drawEffects, drawSelectionBox, drawMinimap, applyCamera, screenToWorld, minimapWorldAt, showCommandMarker, playerMap, isAdmin, currentMap, teamValue, loadDesign, persistDesign, loadSavedDesigns, persistSavedDesigns, defaultDesign, normalizeDesign, isConnected, explainConnectionProblem, computeStats, calculateCostBreakdown, weaponAccumulator, addWeaponStats, applyWeaponUtilityBonuses, calculateDps, calculateReload, calculateMovementStats, calculateSystemEfficiency, calculateMovementPowerMultiplier, effectiveStackedValue, softCap, massClassForMass, speedCapForMass, turnCapForMass, weaponRange, summarizeWeaponTotals, shipWarnings, makeStars, roundRect, clamp, escapeHtml, roomFromUrl } from "../ui/scoreboardUi.js";


export function updateCamera(dt) {
  const rect = dom.canvas.getBoundingClientRect();
  const fitZoom = clamp(Math.min(rect.width / 1300, rect.height / 820), 0.42, 0.82);
  if (state.camera.manualZoom == null) state.camera.zoom = fitZoom;

  const panSpeed = 760 * dt / state.camera.zoom;
  let moved = false;
  if (state.keys.has("arrowleft") || state.keys.has("a")) {
    state.camera.x -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowright") || state.keys.has("d")) {
    state.camera.x += panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowup") || state.keys.has("w")) {
    state.camera.y -= panSpeed;
    moved = true;
  }
  if (state.keys.has("arrowdown") || state.keys.has("s")) {
    state.camera.y += panSpeed;
    moved = true;
  }
  if (moved) state.camera.follow = false;

  if (state.camera.follow) {
    const focusShips = [...state.selectedShipIds].length
      ? (state.snapshot?.ships || []).filter((ship) => state.selectedShipIds.has(ship.id) && ship.alive)
      : ownLiveShips();
    if (focusShips.length) {
      const targetX = focusShips.reduce((sum, ship) => sum + ship.x, 0) / focusShips.length;
      const targetY = focusShips.reduce((sum, ship) => sum + ship.y, 0) / focusShips.length;
      state.camera.x += (targetX - state.camera.x) * 0.055;
      state.camera.y += (targetY - state.camera.y) * 0.055;
    }
  }

  state.camera.x = clamp(state.camera.x, 0, state.world.width);
  state.camera.y = clamp(state.camera.y, 0, state.world.height);
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
  const map = currentMap();
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

export function moduleRotationToRadians(rotation) {
  if (rotation === 90) return Math.PI / 2;
  if (rotation === 180) return Math.PI;
  if (rotation === 270) return -Math.PI / 2;
  return 0;
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
    roundRect(ctx, -size * 0.48, -size * 0.48, size * 0.96, size * 0.96, size * 0.18);
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
    roundRect(ctx, -size * 0.46, -size * 0.46, size * 0.92, size * 0.92, size * 0.12);
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
    roundRect(ctx, size * 0.02, -size * 0.13, size * 0.62, size * 0.26, size * 0.08);
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
    roundRect(ctx, -size * 0.42, -size * 0.42, size * 0.84, size * 0.84, size * 0.12);
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
    roundRect(ctx, -size * 0.44, -size * 0.44, size * 0.88, size * 0.88, size * 0.1);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

export function drawWeaponBase(size) {
  roundRect(ctx, -size * 0.46, -size * 0.32, size * 0.68, size * 0.64, size * 0.12);
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
  roundRect(ctx, x, y, width, height, Math.max(1, height * 0.35));
  ctx.fillStyle = "rgba(1,5,10,0.82)";
  ctx.fill();

  if (lagRatio > ratio) {
    roundRect(ctx, x, y, width * lagRatio, height, Math.max(1, height * 0.35));
    ctx.fillStyle = "rgba(255,245,194,0.48)";
    ctx.fill();
  }

  if (ratio > 0) {
    const fill = ctx.createLinearGradient(x, y, x + width, y);
    fill.addColorStop(0, fillStart);
    fill.addColorStop(1, fillEnd);
    ctx.shadowColor = glow;
    ctx.shadowBlur = 7;
    roundRect(ctx, x, y, width * ratio, height, Math.max(1, height * 0.35));
    ctx.fillStyle = fill;
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(225,241,255,0.22)";
  ctx.lineWidth = 0.9 / state.camera.zoom;
  roundRect(ctx, x, y, width, height, Math.max(1, height * 0.35));
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

export function approach(current, target, rate) {
  const t = clamp(rate, 0, 1);
  return current + (target - current) * t;
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

export function drawEffects() {
  const snap = state.snapshot;
  if (!snap) return;
  for (const effect of snap.effects) {
    const age = effect.age || 0;
    const t = clamp(age / 900, 0, 1);
    ctx.save();
    ctx.translate(effect.x, effect.y);
    ctx.globalAlpha = 1 - t;
    if (effect.type === "boom") {
      ctx.fillStyle = "#ffca57";
      ctx.beginPath();
      ctx.arc(0, 0, 18 + t * 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ff5f7e";
      ctx.lineWidth = 5 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 34 + t * 84, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "repair") {
      ctx.strokeStyle = "#67e08a";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 16 + t * 28, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "railhit") {
      ctx.strokeStyle = "#f4f7ff";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-24 - t * 24, 0);
      ctx.lineTo(24 + t * 24, 0);
      ctx.moveTo(0, -24 - t * 24);
      ctx.lineTo(0, 24 + t * 24);
      ctx.stroke();
    } else if (effect.type === "rockhit") {
      ctx.fillStyle = "rgba(196,174,142,0.82)";
      ctx.beginPath();
      ctx.arc(0, 0, 5 + t * 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,226,175,0.72)";
      ctx.lineWidth = 2 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-10 - t * 12, -4);
      ctx.lineTo(8 + t * 18, 5);
      ctx.stroke();
    } else {
      ctx.fillStyle = effect.type === "warp" ? "#38d5ff" : "#f3f7ff";
      ctx.beginPath();
      ctx.arc(0, 0, 8 + t * 32, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function drawSelectionBox() {
  if (!state.drag) return;
  const a = state.drag.startWorld;
  const b = state.drag.currentWorld;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width < 12 && height < 12) return;
  ctx.save();
  ctx.fillStyle = "rgba(56,213,255,0.08)";
  ctx.strokeStyle = "rgba(56,213,255,0.82)";
  ctx.lineWidth = 2 / state.camera.zoom;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
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
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  roundRect(ctx, x, y, w, h, 8);
  ctx.clip();

  const sx = w / state.world.width;
  const sy = h / state.world.height;
  const snap = state.snapshot;
  const map = currentMap();
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

export function applyCamera(rect) {
  ctx.translate(rect.width / 2, rect.height / 2);
  ctx.scale(state.camera.zoom, state.camera.zoom);
  ctx.translate(-state.camera.x, -state.camera.y);
}

export function screenToWorld(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: state.camera.x + (clientX - rect.left - rect.width / 2) / state.camera.zoom,
    y: state.camera.y + (clientY - rect.top - rect.height / 2) / state.camera.zoom
  };
}

export function minimapWorldAt(clientX, clientY) {
  if (!state.minimap) return null;
  const rect = dom.canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const mini = state.minimap;
  if (x < mini.x || x > mini.x + mini.w || y < mini.y || y > mini.y + mini.h) return null;
  return {
    x: clamp((x - mini.x) / mini.w * state.world.width, 0, state.world.width),
    y: clamp((y - mini.y) / mini.h * state.world.height, 0, state.world.height)
  };
}

export function showCommandMarker(clientX, clientY) {
  const rect = dom.canvas.getBoundingClientRect();
  dom.marker.hidden = false;
  dom.marker.style.left = `${clientX - rect.left}px`;
  dom.marker.style.top = `${clientY - rect.top}px`;
  dom.marker.style.animation = "none";
  dom.marker.offsetHeight;
  dom.marker.style.animation = "";
}

export function playerMap() {
  return new Map((state.snapshot?.players || []).map((player) => [player.id, player]));
}

export function isAdmin() {
  return state.adminId === state.myId || Boolean(state.snapshot?.players?.find((player) => player.id === state.myId && player.isAdmin));
}

export function currentMap() {
  return state.snapshot?.map || state.map;
}

export function teamValue() {
  return dom.teamSelect?.value === "red" ? "red" : "blue";
}

export function loadDesign() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_DESIGN_KEY) || "null");
    return normalizeDesign(saved);
  } catch {
    return normalizeDesign(null);
  }
}

export function persistDesign() {
  localStorage.setItem(LOCAL_DESIGN_KEY, JSON.stringify(state.design));
}

export function loadSavedDesigns() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOCAL_SAVED_DESIGNS_KEY) || "[]");
    if (!Array.isArray(saved)) return [];
    return saved.map((design, index) => ({
      id: String(design.id || `saved-${index}`),
      name: String(design.name || `Design ${index + 1}`).slice(0, 28),
      blueprint: normalizeDesign(design.blueprint),
      cost: Number(design.cost) || 0,
      weapons: String(design.weapons || "0/0/0"),
      speed: Number(design.speed) || 0,
      createdAt: Number(design.createdAt) || Date.now(),
      updatedAt: Number(design.updatedAt) || Date.now()
    })).slice(0, 12);
  } catch {
    return [];
  }
}

export function persistSavedDesigns() {
  localStorage.setItem(LOCAL_SAVED_DESIGNS_KEY, JSON.stringify(state.savedDesigns.slice(0, 12)));
}

export function defaultDesign() {
  return [
    { x: 3, y: 3, type: "core" },
    { x: 3, y: 4, type: "reactor" },
    { x: 2, y: 4, type: "engine" },
    { x: 4, y: 4, type: "engine" },
    { x: 2, y: 3, type: "blaster" },
    { x: 4, y: 3, type: "blaster" },
    { x: 3, y: 2, type: "shield" },
    { x: 2, y: 2, type: "armor" },
    { x: 4, y: 2, type: "armor" },
    { x: 3, y: 5, type: "battery" }
  ];
}

export function normalizeDesign(input) {
  const fallback = defaultDesign();
  const source = Array.isArray(input) ? input : fallback;
  const seen = new Set();
  const clean = [];

  for (const raw of source) {
    const x = Math.trunc(Number(raw?.x));
    const y = Math.trunc(Number(raw?.y));
    const type = String(raw?.type || "");
    const key = `${x},${y}`;
    if (x < 0 || x > 6 || y < 0 || y > 6 || !PART_DEFS[type] || seen.has(key)) continue;
    seen.add(key);
    clean.push(makeDesignPart(x, y, type, raw?.rotation));
  }

  if (clean.filter((part) => part.type === "core").length !== 1 || !isConnected(clean)) return fallback;
  return clean;
}

export function isConnected(parts) {
  const core = parts.find((part) => part.type === "core");
  if (!core) return false;
  const keys = new Set(parts.map((part) => `${part.x},${part.y}`));
  const seen = new Set([`${core.x},${core.y}`]);
  const queue = [core];

  for (let i = 0; i < queue.length; i += 1) {
    const part = queue[i];
    for (const [x, y] of [[part.x + 1, part.y], [part.x - 1, part.y], [part.x, part.y + 1], [part.x, part.y - 1]]) {
      const key = `${x},${y}`;
      if (keys.has(key) && !seen.has(key)) {
        seen.add(key);
        queue.push({ x, y });
      }
    }
  }

  return seen.size === parts.length;
}

export function explainConnectionProblem(parts, x, y, replacing) {
  if (!parts.some((part) => part.type === "core")) {
    return "Blueprint must keep exactly one core module";
  }

  const target = parts.find((part) => part.x === x && part.y === y);
  if (target) {
    const sideNeighbor = parts.some((part) => part !== target && Math.abs(part.x - x) + Math.abs(part.y - y) === 1);
    const cornerNeighbor = parts.some((part) => part !== target && Math.abs(part.x - x) === 1 && Math.abs(part.y - y) === 1);

    if (!sideNeighbor && cornerNeighbor) {
      return "Not connected: modules must touch by a full side; corner contact does not count";
    }

    if (!sideNeighbor) {
      return "Not connected: place it so one side touches an existing module";
    }
  }

  if (replacing) {
    return "That change would break the side-connected path back to the core";
  }

  return "Not connected to the core: every module needs a side-connected path to the core";
}

export function computeStats(modules) {
  let cost = 0;
  let mass = 0;
  let maxHp = 0;
  let maxShield = 0;
  let shieldRegen = 0;
  let powerGeneration = 0;
  let powerUse = 0;
  let thrust = 0;
  let turnBonus = 0;
  const engineThrustValues = [];
  const turnModuleValues = [];
  let energyStorage = 0;
  let blaster = 0;
  let missile = 0;
  let railgun = 0;
  let repair = 0;
  let repairRate = 0;
  let rangeBonus = 0;
  let accuracyBonus = 0;
  let fireRateBonus = 0;
  let coolingBonus = 0;
  let captureBonus = 0;
  const weaponTotals = {
    blaster: weaponAccumulator(),
    missile: weaponAccumulator(),
    railgun: weaponAccumulator()
  };

  for (const module of modules) {
    const part = PART_STATS[module.type] || PART_STATS.frame;
    cost += part.cost;
    mass += part.mass;
    maxHp += part.hp;
    maxShield += part.shield;
    shieldRegen += part.shieldRegen || 0;
    powerGeneration += part.powerGeneration || 0;
    powerUse += part.powerUse || 0;
    thrust += part.thrust;
    turnBonus += part.turn;
    if (part.thrust > 0) engineThrustValues.push(part.thrust);
    if (part.turn > 0) turnModuleValues.push(part.turn);
    energyStorage += part.energyStorage || 0;
    blaster += part.blaster || 0;
    missile += part.missile || 0;
    railgun += part.railgun || 0;
    repair += part.repair || 0;
    repairRate += part.repairRate || 0;
    rangeBonus += part.rangeBonus || 0;
    accuracyBonus += part.accuracyBonus || 0;
    fireRateBonus += part.fireRateBonus || 0;
    coolingBonus += Math.max(0, -(part.heat || 0)) * 0.01;
    captureBonus += part.captureBonus || 0;
    if (part.weapon) addWeaponStats(weaponTotals[part.weapon.type], part.weapon);
  }

  applyWeaponUtilityBonuses(weaponTotals, { rangeBonus, accuracyBonus, fireRateBonus, coolingBonus });
  const power = powerGeneration - powerUse;
  const efficiency = calculateSystemEfficiency(powerGeneration, powerUse);
  const movement = calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, turnModuleValues });
  const costBreakdown = calculateCostBreakdown({ cost, mass, maxHp, maxShield, repairRate, blaster, missile, railgun });
  const unitCost = costBreakdown.total;
  const fleetCount = clamp(Math.floor(260 / Math.max(58, unitCost * 0.72 + mass * 0.45)), 1, 5);
  const warnings = shipWarnings({ powerGeneration, powerUse, thrust, effectiveThrust: movement.effectiveThrust, thrustRatio: movement.thrustRatio, blaster, missile, railgun, mass, turnRate: movement.turnRate, repair, shield: maxShield, modules, speedCapped: movement.speedCapped, powerEfficiency: movement.powerEfficiency, powerDebuff: movement.powerDebuff });

  return {
    cost,
    unitCost,
    mass: Math.round(mass),
    maxHp: Math.max(140, Math.round(maxHp * 0.82)),
    maxShield: Math.round(maxShield * efficiency),
    shieldRegen: Number((shieldRegen * clamp(efficiency, 0.4, 1.12)).toFixed(2)),
    powerGeneration,
    powerUse,
    power,
    efficiency: Number(efficiency.toFixed(2)),
    thrust,
    effectiveThrust: Math.round(movement.effectiveThrust),
    engineEfficiency: Number(movement.engineEfficiency.toFixed(2)),
    thrustRatio: Number(movement.thrustRatio.toFixed(2)),
    energyStorage,
    accel: Math.round(movement.accel),
    maxSpeed: movement.maxSpeed,
    turnRate: movement.turnRate,
    massClass: movement.massClass,
    speedCap: movement.speedCap,
    turnCap: movement.turnCap,
    powerEfficiency: Number(movement.powerEfficiency.toFixed(2)),
    powerDebuff: Number(movement.powerDebuff.toFixed(2)),
    blaster,
    missile,
    railgun,
    repair,
    repairRate,
    coolingBonus: Number(coolingBonus.toFixed(2)),
    captureBonus: Number(captureBonus.toFixed(2)),
    blasterRange: weaponRange(weaponTotals.blaster),
    missileRange: weaponRange(weaponTotals.missile),
    railgunRange: weaponRange(weaponTotals.railgun),
    weaponDps: Number((weaponTotals.blaster.dps + weaponTotals.missile.dps + weaponTotals.railgun.dps).toFixed(1)),
    weapons: summarizeWeaponTotals(weaponTotals),
    warnings,
    costBreakdown,
    fleetCount
  };
}

export function calculateCostBreakdown(stats) {
  const base = SHIP_ECONOMY.baseShipCost;
  const parts = stats.cost * SHIP_ECONOMY.partCostMultiplier;
  const mass = stats.mass * SHIP_ECONOMY.massCostMultiplier;
  const hull = stats.maxHp * SHIP_ECONOMY.hullCostMultiplier;
  const shield = stats.maxShield * SHIP_ECONOMY.shieldCostMultiplier;
  const repair = stats.repairRate * SHIP_ECONOMY.repairCostMultiplier;
  const weaponPremium =
    stats.blaster * SHIP_ECONOMY.weaponPremiums.blaster +
    stats.missile * SHIP_ECONOMY.weaponPremiums.missile +
    stats.railgun * SHIP_ECONOMY.weaponPremiums.railgun;
  const preTaxTotal = base + parts + mass + hull + shield + repair + weaponPremium;
  const largeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.largeShipThreshold) * SHIP_ECONOMY.largeShipCostTax;
  const hugeTax = Math.max(0, preTaxTotal - SHIP_ECONOMY.hugeShipThreshold) * SHIP_ECONOMY.hugeShipCostTax;
  const sizeTax = largeTax + hugeTax;
  return {
    base: Math.round(base),
    parts: Math.round(parts),
    mass: Math.round(mass),
    hull: Math.round(hull),
    shield: Math.round(shield),
    repair: Math.round(repair),
    weaponPremium: Math.round(weaponPremium),
    sizeTax: Math.round(sizeTax),
    total: clamp(Math.round(preTaxTotal + sizeTax), 300, 2000)
  };
}

export function weaponAccumulator() {
  return { count: 0, damage: 0, range: 0, fireRate: 0, reload: 0, projectileSpeed: 0, accuracy: 0, tracking: 0, dps: 0 };
}

export function addWeaponStats(total, weapon) {
  total.count += 1;
  total.damage += weapon.damage;
  total.range = Math.max(total.range, weapon.range);
  total.fireRate += weapon.fireRate;
  total.reload += calculateReload(weapon);
  total.projectileSpeed += weapon.projectileSpeed;
  total.accuracy += weapon.accuracy;
  total.tracking += weapon.tracking || 0;
  total.dps += calculateDps(weapon);
}

export function applyWeaponUtilityBonuses(totals, bonuses) {
  const hasWeapons = Object.values(totals).some((total) => total.count > 0);
  if (!hasWeapons) return;
  const rangeBonus = Number(bonuses.rangeBonus) || 0;
  const accuracyBonus = Number(bonuses.accuracyBonus) || 0;
  const fireRateMultiplier = 1 + (Number(bonuses.fireRateBonus) || 0) + (Number(bonuses.coolingBonus) || 0);
  for (const total of Object.values(totals)) {
    if (total.count <= 0) continue;
    total.range += rangeBonus;
    total.accuracy = Math.min(total.count, total.accuracy + accuracyBonus * total.count);
    total.fireRate *= fireRateMultiplier;
    total.dps *= fireRateMultiplier;
    total.reload = fireRateMultiplier > 0 ? total.reload / fireRateMultiplier : total.reload;
  }
}

export function calculateDps(weapon) {
  return Number(((weapon.damage || 0) * (weapon.fireRate || 0)).toFixed(1));
}

export function calculateReload(weapon) {
  return Number((1 / Math.max(0.01, weapon.fireRate || 1)).toFixed(2));
}

export function calculateMovementStats({ mass, thrust, turnBonus, powerGeneration, powerUse, engineThrustValues, turnModuleValues }) {
  const safeMass = Math.max(mass, 1);
  const effectiveThrust = effectiveStackedValue(engineThrustValues, 0.88);
  const positiveTurn = effectiveStackedValue(turnModuleValues, 0.92);
  const negativeTurnDrag = Math.min(0, turnBonus);
  const effectiveTurnBonus = positiveTurn + negativeTurnDrag;
  const thrustRatio = effectiveThrust / safeMass;
  const hasEngineThrust = effectiveThrust > 0;
  const powerRatio = powerUse > 0 ? powerGeneration / powerUse : 1.1;
  const movementPowerMultiplier = calculateMovementPowerMultiplier(powerGeneration, powerUse);
  const powerEfficiency = clamp(powerRatio, 0, 1.1);
  const massSpeedPenalty = 1 / Math.pow(1 + safeMass / 95, 0.55);
  const massAccelPenalty = 1 / Math.pow(1 + safeMass / 76, 0.75);
  const massTurnPenalty = 1 / Math.pow(1 + safeMass / 82, 0.82);
  const rawSpeed = (90 + Math.sqrt(thrustRatio) * 52) * massSpeedPenalty * movementPowerMultiplier;
  const rawAccel = (45 + Math.sqrt(effectiveThrust) * 7) * massAccelPenalty * movementPowerMultiplier;
  const rawTurn = Math.max(0.22, (0.72 + effectiveTurnBonus * 1.34) * massTurnPenalty * movementPowerMultiplier);
  const speedCap = speedCapForMass(safeMass);
  const turnCap = turnCapForMass(safeMass);
  const cappedSpeed = hasEngineThrust ? softCap(rawSpeed, speedCap, 0.25) : 0;
  const cappedTurn = softCap(rawTurn, turnCap, 0.2);

  // Engines stack with diminishing returns, then mass and power apply soft limits.
  // This keeps engines useful on capital ships without letting high-mass hulls reach scout speeds.
  return {
    maxSpeed: hasEngineThrust ? Math.max(35, cappedSpeed) : 0,
    accel: hasEngineThrust ? Math.max(18, rawAccel) : 0,
    turnRate: cappedTurn,
    thrustRatio,
    effectiveThrust,
    engineEfficiency: thrust > 0 ? effectiveThrust / thrust : 0,
    powerEfficiency,
    powerDebuff: Math.max(0, 1 - movementPowerMultiplier),
    speedCap,
    turnCap,
    massClass: massClassForMass(safeMass),
    speedCapped: hasEngineThrust && rawSpeed > speedCap * 1.05
  };
}

export function calculateSystemEfficiency(powerGeneration, powerUse) {
  if (powerUse <= 0) return 1.08;
  const ratio = powerGeneration / Math.max(powerUse, 1);
  if (ratio >= 1) return clamp(1 + Math.min((ratio - 1) * 0.25, 0.12), 1, 1.12);
  return clamp(Math.pow(Math.max(ratio, 0), 1.35), 0.25, 1);
}

export function calculateMovementPowerMultiplier(powerGeneration, powerUse) {
  if (powerUse <= 0) return 1.04;
  const ratio = powerGeneration / Math.max(powerUse, 1);
  if (ratio >= 1) return clamp(Math.sqrt(ratio), 1, 1.08);
  return clamp(Math.pow(Math.max(ratio, 0), 1.8), 0.18, 1);
}

export function effectiveStackedValue(values, falloff) {
  return [...values].sort((a, b) => b - a).reduce((total, value, index) => total + value * Math.pow(falloff, index), 0);
}

export function softCap(value, cap, softness = 0.35) {
  if (value <= cap) return value;
  return cap + (value - cap) * softness;
}

export function massClassForMass(mass) {
  if (mass < 55) return "Light";
  if (mass < 125) return "Medium";
  if (mass < 230) return "Heavy";
  return "Capital";
}

export function speedCapForMass(mass) {
  if (mass < 55) return 340;
  if (mass < 125) return 285;
  if (mass < 230) return 215;
  return 165;
}

export function turnCapForMass(mass) {
  if (mass < 55) return 2.85;
  if (mass < 125) return 2.05;
  if (mass < 230) return 1.12;
  return 0.72;
}

export function weaponRange(total) {
  return total.count > 0 ? total.range : 0;
}

export function summarizeWeaponTotals(totals) {
  const result = {};
  for (const [type, total] of Object.entries(totals)) {
    result[type] = {
      count: total.count,
      damage: total.damage,
      range: total.range,
      fireRate: Number(total.fireRate.toFixed(2)),
      reload: total.count ? Number((total.reload / total.count).toFixed(2)) : 0,
      projectileSpeed: total.count ? Math.round(total.projectileSpeed / total.count) : 0,
      accuracy: total.count ? Number((total.accuracy / total.count).toFixed(2)) : 0,
      tracking: total.count ? Number((total.tracking / total.count).toFixed(2)) : 0,
      dps: Number(total.dps.toFixed(1))
    };
  }
  return result;
}

export function shipWarnings(stats) {
  const warnings = [];
  const weaponCount = stats.blaster + stats.missile + stats.railgun;
  const hasReactor = stats.modules.some((module) => module.type === "reactor");
  if (stats.powerGeneration < stats.powerUse) warnings.push(`Power deficit: uses ${stats.powerUse} but generates ${stats.powerGeneration}`);
  if (!hasReactor && stats.powerUse > PART_STATS.core.powerGeneration) warnings.push("No reactor: high-power systems need stronger generation");
  if (stats.effectiveThrust <= 0) warnings.push("No engines: this ship cannot move");
  if (stats.thrustRatio < 3.2 && stats.mass > 18) warnings.push("Low mobility: heavy for its engine power");
  if (stats.speedCapped) warnings.push("Large hull: speed capped by mass");
  if (stats.powerDebuff > 0.08 && stats.thrust > 0) warnings.push(`Underpowered systems: movement reduced ${formatPercent(stats.powerDebuff)}. Add reactors.`);
  if (stats.mass > 85 || stats.turnRate < 0.85) warnings.push("Heavy ship: turning will be slow");
  if (stats.repair > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Repair installed but power is insufficient");
  if (stats.shield > 0 && stats.powerGeneration < stats.powerUse) warnings.push("Shields installed but power is insufficient");
  if (weaponCount === 0) warnings.push("No weapons: this ship cannot attack");
  return warnings;
}

export function makeStars(count) {
  const stars = [];
  for (let i = 0; i < count; i += 1) {
    const bright = Math.random() > 0.78;
    stars.push({
      x: Math.random(),
      y: Math.random(),
      size: bright ? 2 : 1,
      drift: -0.006 - Math.random() * 0.018,
      color: bright ? "rgba(220,242,255,0.86)" : "rgba(170,194,220,0.42)"
    });
  }
  return stars;
}

export function roundRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

export const roomFromUrl = new URLSearchParams(location.search).get("room");
if (roomFromUrl) {
  dom.roomCode.value = roomFromUrl.toUpperCase().slice(0, 8);
} else {
  const activeRoom = (localStorage.getItem(LOCAL_ACTIVE_ROOM_KEY) || "").toUpperCase().slice(0, 8);
  if (activeRoom) {
    dom.roomCode.value = activeRoom;
    joinRoom(activeRoom);
  }
}