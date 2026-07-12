// Renders background stars, nebulas, obstacles, weapon beams, and ship components to the arena canvas.

import { dom, ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp, approach } from "../shared/math.js";
import { escapeHtml } from "../shared/formatting.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "../design/parts.js";
import { computeStats } from "../design/componentStats.js";
import { moduleRotationToRadians, normalizeRotation } from "../design/rotation.js";
import { getOccupiedCells } from "../design/footprint.js";
import { formatHull, formatShield, formatThrust, formatEnergy, formatRepair, formatPercent } from "../design/statFormatting.js";
import { drawEffects } from "./effects.js";
import { drawSelectionBox, ownLiveShips } from "./selection.js";
import { updateCamera, applyCamera } from "./camera.js";
import { qualityShadowBlur, getRenderQualityDprCap, getEffectDensity } from "./renderSettings.js";
import { setDebugFrameStats, updateDebugOverlay } from "./debugOverlay.js";
import { playerMap } from "../ui/scoreboardUi.js";
import { getRallyPoint } from "../ui/sidePanelUi.js";
import { componentFlash, activePenetrationPath, activeCoreWarning, pruneComponentDamage, CRITICAL_RATIO, DAMAGED_RATIO } from "./componentDamage.js";


let frameCount = 0;
let lastFpsTime = 0;
let currentFps = 0;
const renderedDesignStatsCache = new WeakMap();


export function getViewportWorldBounds(rect, padding = 160) {
  const w = rect.width / state.camera.zoom;
  const h = rect.height / state.camera.zoom;
  return {
    left: state.camera.x - w / 2 - padding,
    right: state.camera.x + w / 2 + padding,
    top: state.camera.y - h / 2 - padding,
    bottom: state.camera.y + h / 2 + padding
  };
}

export function isCircleVisible(x, y, radius, bounds) {
  return x + radius >= bounds.left &&
         x - radius <= bounds.right &&
         y + radius >= bounds.top &&
         y - radius <= bounds.bottom;
}





export function resizeCanvas() {
  const rect = dom.canvas.getBoundingClientRect();
  const maxDpr = getRenderQualityDprCap();

  const ratio = Math.max(1, Math.min(maxDpr, window.devicePixelRatio || 1));
  dom.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  dom.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

export function frame(now) {
  const start = performance.now();
  const dt = Math.min(0.05, Math.max(0.001, (now - state.lastFrameAt) / 1000));
  state.lastFrameAt = now;
  state.dt = dt;
  interpolateShips(dt, now);
  updateCamera(dt);
  renderArena(now);

  frameCount++;
  if (now - lastFpsTime > 1000) {
    currentFps = Math.round((frameCount * 1000) / (now - lastFpsTime));
    frameCount = 0;
    lastFpsTime = now;
  }

  setDebugFrameStats(currentFps, performance.now() - start, "canvas2d");
  updateDebugOverlay(now);

  requestAnimationFrame(frame);
}

export function interpolateShips(dt, now) {
  const snap = state.snapshot;
  if (!snap) return;

  if (snap.ships) {
    if (!state.visualShips) state.visualShips = new Map();
    const visibleIds = new Set(snap.ships.map((s) => s.id));
    for (const id of state.visualShips.keys()) {
      if (!visibleIds.has(id)) state.visualShips.delete(id);
    }

    for (const ship of snap.ships) {
      let vis = state.visualShips.get(ship.id);
      if (!vis) {
        vis = { x: ship.x, y: ship.y, angle: ship.angle };
        state.visualShips.set(ship.id, vis);
      } else {
        const t = 1 - Math.exp(-22 * dt);
        const distSq = (ship.x - vis.x) ** 2 + (ship.y - vis.y) ** 2;
        if (distSq > 300 * 300) {
          vis.x = ship.x;
          vis.y = ship.y;
          vis.angle = ship.angle;
        } else {
          vis.x += (ship.x - vis.x) * t;
          vis.y += (ship.y - vis.y) * t;
          vis.angle += angleDifference(vis.angle, ship.angle) * t;
        }
      }
    }
  }
}

export function renderArena(now) {
  state.debugStats = { drawnShips: 0, totalShips: 0, drawnBullets: 0, totalBullets: 0, drawnAsteroids: 0, totalAsteroids: 0, drawnEffects: 0, totalEffects: 0 };
  const players = state.snapshot ? playerMap() : new Map();
  const rect = dom.canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  drawBackdrop(rect);

  ctx.save();
  applyCamera(rect);
  drawWorldGrid();
  const bounds = getViewportWorldBounds(rect);
  drawMapFeatures(now, bounds);
  drawRelays(now, players, bounds);
  drawCommandTarget(now);
  drawRallyPoint(now);
  drawEngineSmokeTrails(now, bounds);
  drawShips(players, bounds);
  drawBullets(players, bounds);
  drawEffects();
  drawSelectionBox();
  ctx.restore();

  drawMinimap(rect, players);

  if (!state.snapshot) {
    ctx.fillStyle = "rgba(237,244,255,0.72)";
    ctx.font = "700 15px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Join a room to enter the arena", rect.width / 2, rect.height / 2);
  }
}

let cachedBackdropGradient = null;
let cachedBackdropWidth = 0;
let cachedBackdropHeight = 0;

export function drawBackdrop(rect) {
  if (!cachedBackdropGradient || cachedBackdropWidth !== rect.width || cachedBackdropHeight !== rect.height) {
    cachedBackdropGradient = ctx.createLinearGradient(0, 0, rect.width, rect.height);
    cachedBackdropGradient.addColorStop(0, "#040710");
    cachedBackdropGradient.addColorStop(0.55, "#0a111d");
    cachedBackdropGradient.addColorStop(1, "#05070c");
    cachedBackdropWidth = rect.width;
    cachedBackdropHeight = rect.height;
  }
  ctx.fillStyle = cachedBackdropGradient;
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

let cachedGridPath = null;
let cachedGridWidth = 0;
let cachedGridHeight = 0;

export function drawWorldGrid() {
  ctx.save();
  ctx.lineWidth = 1 / state.camera.zoom;
  ctx.strokeStyle = "rgba(130,160,205,0.11)";

  if (!cachedGridPath || cachedGridWidth !== state.world.width || cachedGridHeight !== state.world.height) {
    cachedGridPath = new Path2D();
    cachedGridWidth = state.world.width;
    cachedGridHeight = state.world.height;

    for (let x = 0; x <= state.world.width; x += 160) {
      cachedGridPath.moveTo(x, 0);
      cachedGridPath.lineTo(x, state.world.height);
    }
    for (let y = 0; y <= state.world.height; y += 160) {
      cachedGridPath.moveTo(0, y);
      cachedGridPath.lineTo(state.world.width, y);
    }
  }

  ctx.stroke(cachedGridPath);

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3 / state.camera.zoom;
  ctx.strokeRect(0, 0, state.world.width, state.world.height);
  ctx.restore();
}

export function drawMapFeatures(now, bounds) {
  const map = state.snapshot?.map || state.map;
  if (!map) return;

  for (const zone of map.safeZones || []) {
    if (!bounds || isCircleVisible(zone.x, zone.y, zone.radius, bounds)) drawSafeZone(zone);
  }
  for (const cloud of map.clouds || []) {
    if (!bounds || isCircleVisible(cloud.x, cloud.y, Math.max(cloud.rx || 300, cloud.ry || 180), bounds)) drawNebula(cloud);
  }
  for (const asteroid of map.asteroids || []) {
    state.debugStats.totalAsteroids++;
    if (!bounds || isCircleVisible(asteroid.x, asteroid.y, asteroid.radius || 60, bounds)) {
      state.debugStats.drawnAsteroids++;
      drawAsteroid(asteroid, now);
    }
  }
}

export function drawSafeZone(zone) {
  ctx.save();
  ctx.translate(zone.x, zone.y);

  // Fill
  ctx.fillStyle = zone.color || "rgba(255,255,255,0.04)";
  ctx.beginPath();
  ctx.arc(0, 0, zone.radius, 0, Math.PI * 2);
  ctx.fill();

  // Dashed border
  ctx.strokeStyle = zone.color || "rgba(255,255,255,0.1)";
  ctx.lineWidth = 4;
  ctx.setLineDash([20, 20]);
  ctx.beginPath();
  ctx.arc(0, 0, zone.radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

// Nebulas are static, but drawing one costs 4-6 radial gradients per frame.
// Pre-render each cloud once into an offscreen canvas keyed by the cloud object
// (a new map snapshot produces new cloud objects, so stale sprites simply GC away).
const nebulaSpriteCache = new WeakMap();
const NEBULA_SPRITE_SCALE = 0.5;

export function getNebulaSprite(cloud) {
  let sprite = nebulaSpriteCache.get(cloud);
  if (sprite) return sprite;

  const rx = cloud.rx || 300;
  const ry = cloud.ry || 180;
  const color = cloud.color || "56,213,255";
  const alpha = cloud.alpha || 0.12;

  // Blobs sit within 0.5*rx/ry of center with radius up to 1.2*min(rx,ry)
  const extent = Math.max(rx, ry) * 0.5 + Math.min(rx, ry) * 1.2;
  const size = Math.max(2, Math.ceil(extent * 2 * NEBULA_SPRITE_SCALE));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const spriteCtx = canvas.getContext("2d");
  spriteCtx.translate(size / 2, size / 2);
  spriteCtx.scale(NEBULA_SPRITE_SCALE, NEBULA_SPRITE_SCALE);

  // Use seeded pseudo-random for consistent blob placement inside the nebula
  let seed = Math.abs(Math.floor(cloud.x * 1000 + cloud.y));
  const prng = () => {
    seed = (seed + 0x6D2B79F5) >>> 0;
    let mixed = seed;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };

  const blobCount = 4 + Math.floor(prng() * 3);
  for (let i = 0; i < blobCount; i++) {
    const angle = prng() * Math.PI * 2;
    const distance = prng() * 0.5;
    const cx = Math.cos(angle) * (rx * distance);
    const cy = Math.sin(angle) * (ry * distance);
    const blobRadius = Math.min(rx, ry) * (0.6 + prng() * 0.6);

    const gradient = spriteCtx.createRadialGradient(cx, cy, blobRadius * 0.1, cx, cy, blobRadius);
    gradient.addColorStop(0, `rgba(${color}, ${alpha * (0.8 + prng() * 0.4)})`);
    gradient.addColorStop(0.5, `rgba(${color}, ${alpha * 0.5 * (0.5 + prng() * 0.5)})`);
    gradient.addColorStop(1, `rgba(${color}, 0)`);

    spriteCtx.fillStyle = gradient;
    spriteCtx.beginPath();
    spriteCtx.arc(cx, cy, blobRadius, 0, Math.PI * 2);
    spriteCtx.fill();
  }

  sprite = { canvas, extent };
  nebulaSpriteCache.set(cloud, sprite);
  return sprite;
}

export function drawNebula(cloud) {
  const sprite = getNebulaSprite(cloud);
  ctx.save();
  ctx.translate(cloud.x, cloud.y);
  ctx.rotate(cloud.rotation || 0);
  ctx.drawImage(sprite.canvas, -sprite.extent, -sprite.extent, sprite.extent * 2, sprite.extent * 2);
  ctx.restore();
}

// Asteroid fill gradients only depend on radius and shade; reuse them across frames.
const asteroidGradientCache = new Map();

function getAsteroidGradient(radius, shade) {
  const key = `${radius}|${shade}`;
  let gradient = asteroidGradientCache.get(key);
  if (!gradient) {
    const base = shade === "warm" ? "#5a4939" : "#394657";
    const edge = shade === "warm" ? "#ad8b64" : "#8495aa";
    gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
    gradient.addColorStop(0, edge);
    gradient.addColorStop(0.38, base);
    gradient.addColorStop(1, "#171d26");
    asteroidGradientCache.set(key, gradient);
  }
  return gradient;
}

export function drawAsteroid(asteroid, now) {
  const radius = asteroid.radius || 60;
  const shape = asteroid.shape?.length ? asteroid.shape : [1, 0.92, 1.08, 0.9, 1.12, 0.96, 1.05, 0.88, 1.1, 0.95, 1.03, 0.9];

  ctx.save();
  ctx.translate(asteroid.x, asteroid.y);
  ctx.rotate((asteroid.rotation || 0) + (asteroid.spin || 0) * now * 0.001);
  ctx.shadowColor = "rgba(0,0,0,0.42)";
  ctx.shadowBlur = qualityShadowBlur(18);
  ctx.shadowOffsetY = 8;

  ctx.fillStyle = getAsteroidGradient(radius, asteroid.shade);
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

export function drawRelays(now, players, bounds) {
  const snap = state.snapshot;
  if (!snap) return;
  if (!players) players = playerMap();
  const time = now || (typeof performance !== "undefined" ? performance.now() : Date.now());

  for (const point of snap.points) {
    if (bounds && !isCircleVisible(point.x, point.y, point.radius || 100, bounds)) continue;

    const owner = point.ownerId ? players.get(point.ownerId) : null;
    let color = "rgba(180,200,225,0.62)"; // Neutral
    const isSolo = state.rules?.gameMode === "solo";
    const myTeam = state.mine?.team;

    if (point.ownerTeam && !isSolo) {
      color = (myTeam && point.ownerTeam === myTeam) ? "#38d7ff" : "#ff3838";
    } else if (owner) {
      color = owner.color || color;
    }

    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    
    // 1. Draw capture influence range
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, 0, Math.PI * 2);
    ctx.fill();
    
    // 2. Draw capture progress ring
    ctx.globalAlpha = 0.76;
    ctx.lineWidth = 3 / state.camera.zoom;
    ctx.beginPath();
    ctx.arc(0, 0, point.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (point.progress || 0));
    ctx.stroke();

    // 3. Draw premium futuristic relay station at the center
    ctx.globalAlpha = 1;
    
    // Slowly rotating struts
    ctx.strokeStyle = owner ? `${color}66` : "rgba(180,200,225,0.28)";
    ctx.lineWidth = 3.5 / state.camera.zoom;
    for (let i = 0; i < 3; i++) {
      const angle = (i * Math.PI * 2) / 3 + time * 0.00015;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * 36, Math.sin(angle) * 36);
      ctx.stroke();
      
      // Node tip on strut
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * 36, Math.sin(angle) * 36, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    // Outer circular station hull
    ctx.fillStyle = "rgba(13,18,30,0.95)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5 / state.camera.zoom;
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Inner glowing core
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(10);
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0; // reset shadow

    // 4. Draw labels
    const idLabelY = -46 / state.camera.zoom;

    // Draw relay letter badge
    const badgeWidth = 38 / state.camera.zoom;
    const badgeHeight = 28 / state.camera.zoom;
    ctx.fillStyle = "rgba(8, 12, 20, 0.78)";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 / state.camera.zoom;

    // Rounded rectangle for badge
    ctx.beginPath();
    ctx.roundRect(-badgeWidth / 2, idLabelY - badgeHeight / 2, badgeWidth, badgeHeight, 6 / state.camera.zoom);
    ctx.fill();
    ctx.stroke();

    // Draw relay letter text
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.max(14, 18 / state.camera.zoom)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(point.id, 0, idLabelY);
    
    // Draw owner text below relay
    ctx.font = `${Math.max(10, 13 / state.camera.zoom)}px system-ui, sans-serif`;
    const ownerText = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
    
    // Draw background label box
    ctx.fillStyle = "rgba(8, 12, 20, 0.72)";
    const labelY = point.radius + 18 / state.camera.zoom;
    ctx.fillRect(-50, labelY - 9, 100, 18);
    
    ctx.fillStyle = owner ? color : "#ccd5e0";
    ctx.fillText(ownerText, 0, labelY);
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

export function drawRallyPoint(now) {
  const rally = getRallyPoint();
  if (!rally) return;
  const pulse = (Math.sin(now * 0.004) + 1) * 0.5;
  const radius = 24 + pulse * 8;
  ctx.save();
  ctx.translate(rally.x, rally.y);
  ctx.strokeStyle = "#67e08a";
  ctx.fillStyle = "rgba(103,224,138,0.18)";
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Where to draw a bullet this frame. Ships render slightly behind the server
// (exponential smoothing), so extrapolating bullets forward by the raw snapshot
// age makes a freshly fired bolt appear detached ahead of the barrel. Render
// bullets with the same small visual lag, and never behind their muzzle origin.
const BULLET_VISUAL_LAG = 0.05;
export function bulletRenderPosition(bullet, elapsed) {
  const age = Number.isFinite(bullet.age) ? bullet.age : 1;
  const t = Math.max(-age, elapsed - BULLET_VISUAL_LAG);
  return { x: bullet.x + bullet.vx * t, y: bullet.y + bullet.vy * t };
}

export function drawBullets(players, bounds) {
  const snap = state.snapshot;
  if (!snap) return;
  if (!players) players = playerMap(); // fallback

  const now = performance.now();
  const elapsed = Math.min(0.15, (now - (state.snapshotReceivedAt || now)) / 1000);

  for (const bullet of snap.bullets) {
    if (state.debugStats) state.debugStats.totalBullets++;

    const { x: renderX, y: renderY } = bulletRenderPosition(bullet, elapsed);

    if (bounds && !isCircleVisible(renderX, renderY, 20, bounds)) continue;

    if (state.debugStats) state.debugStats.drawnBullets++;

    const owner = players.get(bullet.ownerId);
    const color = owner?.color || "#ffffff";
    ctx.save();

    ctx.translate(renderX, renderY);
    ctx.rotate(Math.atan2(bullet.vy, bullet.vx));
    drawBulletVisual(bullet, color);
    ctx.restore();
  }
}

// Draws a bullet's art around the origin (translation/rotation already applied).
// Also used by the Pixi renderer to bake per-type projectile textures.
export function drawBulletVisual(bullet, color) {
  {
    if (bullet.type === "rail") {
      ctx.strokeStyle = "#eaf6ff";
      ctx.shadowColor = "#9fdcff";
      ctx.shadowBlur = qualityShadowBlur(24);
      ctx.lineWidth = 3.2 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-34, 0);
      ctx.lineTo(24, 0);
      ctx.stroke();
      ctx.strokeStyle = "#64a8ff";
      ctx.lineWidth = 1.2 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-18, -3);
      ctx.lineTo(18, -3);
      ctx.moveTo(-18, 3);
      ctx.lineTo(18, 3);
      ctx.stroke();
    } else if (bullet.type === "missile") {
      if (bullet.subtype === "swarmMissile") {
        ctx.shadowColor = "#e9d5ff";
        ctx.shadowBlur = qualityShadowBlur(12);
        ctx.fillStyle = "#f3e8ff";
        ctx.beginPath();
        ctx.moveTo(9, 0);
        ctx.lineTo(-4, -2.5);
        ctx.lineTo(-7, 0);
        ctx.lineTo(-4, 2.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#8b5cf6";
        ctx.fillRect(-5, -1.5, 4, 3);
        ctx.fillStyle = "rgba(251, 146, 60, 0.85)";
        ctx.beginPath();
        ctx.moveTo(-7, -1.5);
        ctx.lineTo(-15, 0);
        ctx.lineTo(-7, 1.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(251, 146, 60, 0.6)";
        ctx.fillRect(-5, -4, 2, 2);
        ctx.fillRect(-5, 2, 2, 2);
      } else if (bullet.subtype === "torpedo") {
        ctx.shadowColor = "#ff7e5f";
        ctx.shadowBlur = qualityShadowBlur(24);
        ctx.fillStyle = "#ffca57";
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(-9, -8);
        ctx.lineTo(-16, 0);
        ctx.lineTo(-9, 8);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#a855f7";
        ctx.fillRect(-10, -5, 12, 10);
        ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
        ctx.beginPath();
        ctx.moveTo(-16, -5);
        ctx.lineTo(-32, 0);
        ctx.lineTo(-16, 5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.shadowColor = "#ffd37a";
        ctx.shadowBlur = qualityShadowBlur(18);
        ctx.fillStyle = "#ffe7ad";
        ctx.beginPath();
        ctx.moveTo(13, 0);
        ctx.lineTo(-7, -5);
        ctx.lineTo(-12, 0);
        ctx.lineTo(-7, 5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#8b5cf6";
        ctx.fillRect(-8, -3, 8, 6);
        ctx.fillStyle = "rgba(255, 111, 64, 0.85)";
        ctx.beginPath();
        ctx.moveTo(-12, -3);
        ctx.lineTo(-22, 0);
        ctx.lineTo(-12, 3);
        ctx.closePath();
        ctx.fill();
      }
    } else if (bullet.type === "pdShot") {
      if (bullet.subtype === "flakCannon") {
        ctx.shadowColor = "#f97316";
        ctx.shadowBlur = qualityShadowBlur(14);
        ctx.fillStyle = "#fdba74";
        ctx.beginPath();
        ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(0, 0, 1.8, 0, Math.PI * 2);
        ctx.fill();
      } else if (bullet.subtype === "interceptorPod") {
        ctx.shadowColor = "#c084fc";
        ctx.shadowBlur = qualityShadowBlur(10);
        ctx.fillStyle = "#e9d5ff";
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(-4, -2.5);
        ctx.lineTo(-6, 0);
        ctx.lineTo(-4, 2.5);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#a855f7";
        ctx.fillRect(-4, -1.5, 4, 3);
        ctx.fillStyle = "rgba(251, 146, 60, 0.85)";
        ctx.beginPath();
        ctx.moveTo(-6, -1.5);
        ctx.lineTo(-11, 0);
        ctx.lineTo(-6, 1.5);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.shadowColor = "#ff3b30";
        ctx.shadowBlur = qualityShadowBlur(12);
        ctx.fillStyle = "#ff3b30";
        ctx.beginPath();
        ctx.arc(0, 0, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(0, 0, 2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = qualityShadowBlur(12);
      roundRect(ctx, { x: -7, y: -2, width: 14, height: 4, radius: 2 });
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.88)";
      ctx.fillRect(1, -1, 5, 2);
    }
  }
}

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

export function shipEngineNozzles(design, scale = 13) {
  const nozzles = [];
  if (!Array.isArray(design)) return nozzles;
  for (let i = 0; i < design.length; i += 1) {
    const part = design[i];
    if (part.type !== "engine") continue;
    const place = footprintLocalPlacement(part, scale);
    const angle = moduleRotationToRadians(normalizeRotation(part.rotation));
    const c = Math.cos(angle), s = Math.sin(angle);
    const extent = place.tilesLong * scale * 0.5;
    const spanY = place.tilesCross * scale;
    nozzles.push({
      index: i,
      x: place.cx - c * extent + c * 1.5,
      y: place.cy - s * extent + s * 1.5,
      halfW: Math.max(2.4, spanY * 0.33),
      angle
    });
  }
  return nozzles;
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

export function drawEngineSmokeTrails(now = performance.now(), bounds = null) {
  const particles = activeEngineSmoke(now);
  if (particles.length === 0) return;
  ctx.save();
  ctx.shadowBlur = 0;
  for (const p of particles) {
    if (bounds && !isCircleVisible(p.x, p.y, p.radius, bounds)) continue;
    ctx.fillStyle = `rgba(127, 143, 136, ${p.alpha})`;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
  const av = shipAngularVelocity(ship, now);
  const speed = Math.abs(av);
  if (speed < 0.12 || !ship.alive) return null;
  const density = getEffectDensity();
  const flicker = 0.7 + 0.3 * Math.sin(now * 0.05);
  const jets = [];
  for (let i = 0; i < design.length; i += 1) {
    if (design[i].type !== "maneuverThruster") continue;
    if ((componentHealthRatio(ship, i) ?? 1) <= 0) continue;
    if ((ship.engBlocked || []).includes(i)) continue;
    const place = footprintLocalPlacement(design[i], scale);
    if (Math.abs(place.cy) < 2) continue;
    jets.push({
      x: place.cx,
      y: place.cy,
      aft: Math.sign(av * place.cy) >= 0 ? 1 : -1,
      len: clamp(speed * 9, 3, 11) * flicker * (0.5 + 0.5 * density),
      plumeAlpha: 0.34 * flicker * density,
      coreAlpha: 0.6 * flicker * density
    });
  }
  return jets.length ? jets : null;
}

function drawManeuverThrusters(ship, design, scale, now) {
  const jets = computeManeuverJets(ship, design, scale, now);
  if (!jets) return;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (const jet of jets) {
    ctx.save();
    ctx.translate(jet.x, jet.y);
    ctx.scale(jet.aft, 1);
    ctx.fillStyle = `rgba(125, 211, 255, ${jet.plumeAlpha})`;
    ctx.beginPath();
    ctx.moveTo(0, -2.4);
    ctx.quadraticCurveTo(jet.len * 0.6, -1, jet.len, 0);
    ctx.quadraticCurveTo(jet.len * 0.6, 1, 0, 2.4);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = `rgba(234, 252, 255, ${jet.coreAlpha})`;
    ctx.beginPath();
    ctx.arc(jet.len * 0.28, 0, 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawEngineExhaust(ship, design, scale, now = performance.now()) {
  drawManeuverThrusters(ship, design, scale, now);
  const nozzles = aliveEngineNozzles(ship, shipEngineNozzles(design, scale));
  const intensity = engineThrustRatio(ship);
  emitEngineSmoke(ship, nozzles, scale, now);
  if (intensity <= 0.03 || nozzles.length === 0) return;

  const speedRatio = clamp(Math.hypot(ship.vx || 0, ship.vy || 0) / Math.max(90, maxSpeedForRenderedShip(ship)), 0, 1);
  const t = now * 0.001;
  const phase = shieldIdPhase(ship.id);
  // Maximum plume 20% smaller than before; the outer glow layer is dimmed further
  // on lower graphics settings (the bright core stays as essential thrust feedback).
  const PLUME_SIZE = 0.8;
  const glow = 0.55 + 0.45 * getEffectDensity();
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < nozzles.length; i += 1) {
    const nz = nozzles[i];
    const flicker = 0.74 + 0.2 * Math.sin(t * 36 + phase + i * 1.9) + 0.08 * Math.sin(t * 67 + i);
    const halfW = nz.halfW * (0.8 + intensity * 0.65) * PLUME_SIZE;
    const len = halfW * (1.2 + intensity * 9.4 + speedRatio * 2.4) * flicker;
    const ox = 0;
    const oy = 0;
    ctx.save();
    ctx.translate(nz.x, nz.y);
    ctx.rotate(nz.angle || 0);

    ctx.fillStyle = `rgba(43, 123, 255, ${(0.16 + intensity * 0.22) * glow})`;
    ctx.beginPath();
    ctx.moveTo(ox, oy - halfW * 1.15);
    ctx.quadraticCurveTo(ox - len * 0.55, oy - halfW * 0.7, ox - len, oy);
    ctx.quadraticCurveTo(ox - len * 0.55, oy + halfW * 0.7, ox, oy + halfW * 1.15);
    ctx.closePath();
    ctx.fill();

    const innerLen = len * 0.68;
    ctx.fillStyle = `rgba(99, 230, 255, ${0.42 + intensity * 0.38})`;
    ctx.beginPath();
    ctx.moveTo(ox, oy - halfW * 0.72);
    ctx.quadraticCurveTo(ox - innerLen * 0.5, oy - halfW * 0.42, ox - innerLen, oy);
    ctx.quadraticCurveTo(ox - innerLen * 0.5, oy + halfW * 0.42, ox, oy + halfW * 0.72);
    ctx.closePath();
    ctx.fill();

    const coreLen = len * 0.36;
    ctx.fillStyle = `rgba(234, 252, 255, ${0.66 + intensity * 0.28})`;
    ctx.beginPath();
    ctx.moveTo(ox + 0.5, oy - halfW * 0.38);
    ctx.quadraticCurveTo(ox - coreLen * 0.5, oy - halfW * 0.22, ox - coreLen, oy);
    ctx.quadraticCurveTo(ox - coreLen * 0.5, oy + halfW * 0.22, ox + 0.5, oy + halfW * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

export function drawShips(players, bounds) {
  const snap = state.snapshot;
  if (!snap) return;

  if (!players) players = playerMap(); // fallback
  const visibleShipIds = new Set();

  for (const ship of snap.ships) {
    if (state.debugStats) state.debugStats.totalShips++;
    let renderShip = ship;
    if (state.visualShips) {
      const vis = state.visualShips.get(ship.id);
      if (vis) {
        renderShip = { ...ship, x: vis.x, y: vis.y, angle: vis.angle };
      }
    }

    visibleShipIds.add(ship.id);
    if (bounds && !isCircleVisible(renderShip.x, renderShip.y, renderShip.radius || 60, bounds)) continue;

    if (state.debugStats) state.debugStats.drawnShips++;
    const player = players.get(ship.ownerId);
    if (!player) continue;

    drawShip(renderShip, player);
  }

  if (state.weaponAnglesMap) {
    for (const shipId of state.weaponAnglesMap.keys()) {
      if (!visibleShipIds.has(shipId)) state.weaponAnglesMap.delete(shipId);
    }
  }

  for (const id of state.shipHud.keys()) {
    if (!visibleShipIds.has(id)) state.shipHud.delete(id);
  }

  pruneComponentDamage(visibleShipIds, performance.now());
}

export function drawShip(ship, player) {
  const selected = state.selectedShipIds.has(ship.id);
  const alpha = ship.alive ? 1 : 0.32;
  drawShieldRing(ship);
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);
  ctx.globalAlpha = alpha;

  const design = ship.design || player.design || [];
  const scale = 13;
  drawEngineExhaust(ship, design, scale, performance.now());
  drawShipStructure(design, scale, player.color);

  if (!state.weaponAnglesMap) state.weaponAnglesMap = new Map();

  let visualAngles = state.weaponAnglesMap.get(ship.id);
  if (!visualAngles || visualAngles.length !== design.length) {
    visualAngles = design.map((part) => moduleRotationToRadians(normalizeRotation(part.rotation)));
    state.weaponAnglesMap.set(ship.id, visualAngles);
  }

  const serverAngles = ship.weaponAngles || [];
  const dt = state.dt || 0.016;

  const nowMs = performance.now();

  design.forEach((part, i) => {
    const def = PART_DEFS[part.type] || PART_DEFS.frame;
    const weaponStat = PART_STATS[part.type]?.weapon;
    const place = footprintLocalPlacement(part, scale);
    const healthRatio = componentHealthRatio(ship, i);
    const destroyed = healthRatio !== null && healthRatio <= 0;
    const flash = ship.alive ? componentFlash(ship.id, i, nowMs) : null;
    const halfLong = (place.tilesLong * scale) / 2;
    const halfCross = (place.tilesCross * scale) / 2;
    const halfCell = scale / 2;
    ctx.save();
    ctx.translate(place.cx, place.cy);
    if (destroyed) ctx.globalAlpha *= 0.6;

    if (isRotatablePart(part.type)) {
      const defaultRelative = moduleRotationToRadians(normalizeRotation(part.rotation));
      const targetRelative = serverAngles[i] !== undefined ? serverAngles[i] : defaultRelative;

      const turnRate = weaponStat ? getWeaponTurnRate(weaponStat) : 3.0;
      // Destroyed turrets stop tracking and freeze in place.
      if (!destroyed) visualAngles[i] = approachAngle(visualAngles[i], targetRelative, turnRate * dt);

      if (weaponStat) {
        // The occupied cube belongs to the hull and must never rotate while a
        // turret tracks. Paint that base at its blueprint orientation, then put
        // only the functional weapon top on the live aiming angle.
        ctx.save();
        if (place.multi) {
          ctx.rotate(place.longAxisAngle);
          drawFootprintComponent({ type: part.type, unit: scale, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: player.color, drawDetail: false });
          drawModuleDamage(ctx, healthRatio, halfLong, halfCross, nowMs);
          drawModuleFlash(ctx, flash, halfLong, halfCross);
        } else {
          drawModule({ x: 0, y: 0, size: scale, color: def.color, type: part.type, trim: player.color, drawDetail: false });
          drawModuleDamage(ctx, healthRatio, halfCell, halfCell, nowMs);
          drawModuleFlash(ctx, flash, halfCell, halfCell);
        }
        ctx.restore();
        ctx.rotate(visualAngles[i]);
        if (place.multi) {
          drawFootprintComponent({ type: part.type, unit: scale, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: player.color, drawBase: false });
        } else {
          drawModule({ x: 0, y: 0, size: scale, color: def.color, type: part.type, trim: player.color, drawBase: false });
        }
      } else {
        ctx.rotate(visualAngles[i]);
        if (place.multi) {
          drawFootprintComponent({ type: part.type, unit: scale, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: player.color });
        } else {
          drawModule({ x: 0, y: 0, size: scale, color: def.color, type: part.type, trim: player.color });
        }
        drawModuleDamage(ctx, healthRatio, halfLong, halfCross, nowMs);
        drawModuleFlash(ctx, flash, halfLong, halfCross);
      }
    } else if (place.multi) {
      ctx.rotate(place.longAxisAngle);
      drawFootprintComponent({ type: part.type, unit: scale, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: player.color });
      drawModuleDamage(ctx, healthRatio, halfLong, halfCross, nowMs);
      drawModuleFlash(ctx, flash, halfLong, halfCross);
    } else {
      if (part.type === "maneuverThruster") {
        ctx.rotate(moduleRotationToRadians(normalizeRotation(part.rotation)));
      }
      drawModule({ x: 0, y: 0, size: scale, color: def.color, type: part.type, trim: player.color });
      drawModuleDamage(ctx, healthRatio, halfCell, halfCell, nowMs);
      drawModuleFlash(ctx, flash, halfCell, halfCell);
    }
    ctx.restore();
  });

  // Faint short-lived trace through the components a penetrating hit damaged,
  // built from the order they appeared in the component-hp delta.
  if (ship.alive) {
    const path = activePenetrationPath(ship.id, nowMs);
    if (path && path.indices.length >= 2) {
      ctx.save();
      ctx.strokeStyle = `rgba(255, 220, 170, ${0.55 * path.strength})`;
      ctx.lineWidth = Math.max(1, 2 / state.camera.zoom);
      ctx.beginPath();
      path.indices.forEach((index, k) => {
        const part = design[index];
        if (!part) return;
        const p = footprintLocalPlacement(part, scale);
        if (k === 0) ctx.moveTo(p.cx, p.cy);
        else ctx.lineTo(p.cx, p.cy);
      });
      ctx.stroke();
      ctx.restore();
    }
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
  if (ship.destructProgress != null && ship.alive) drawDestructWarning(ship);
  drawHealthBars(ship, player);
  drawShipName(ship, player);
  if (ship.alive) drawCoreWarning(ship);
  if (!ship.alive) drawRespawn(ship);
}

// Flashing CORE EXPOSED / CORE DAMAGED / CORE CRITICAL callout above the ship,
// driven by the client-side damage feed (expires on its own timer).
function drawCoreWarning(ship) {
  const warning = activeCoreWarning(ship.id, performance.now());
  if (!warning) return;
  const zoom = state.camera.zoom;
  const size = Math.max(11, 13 / zoom);
  ctx.save();
  ctx.globalAlpha = Math.min(1, warning.strength * 1.6);
  ctx.font = `900 ${size}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.lineWidth = Math.max(2, 3 / zoom);
  ctx.strokeStyle = "rgba(10, 4, 4, 0.8)";
  ctx.fillStyle = warning.text === "CORE EXPOSED" ? "#ffca57" : "#ff5f5f";
  const y = ship.y - ship.radius - 64 / zoom;
  ctx.strokeText(warning.text, ship.x, y);
  ctx.fillText(warning.text, ship.x, y);
  ctx.restore();
}

function drawDestructWarning(ship) {
  const now = performance.now();
  const progress = ship.destructProgress;
  const r = (ship.radius || 26) + 10;
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.02 * (1 + progress * 3));
  ctx.save();
  ctx.globalAlpha = 0.4 + progress * 0.5;
  ctx.strokeStyle = "#ff5f3c";
  ctx.lineWidth = (1.5 + pulse * 2.5) / state.camera.zoom;
  ctx.beginPath();
  const rot = now * 0.0011;
  for (let i = 0; i <= 6; i += 1) {
    const a = rot + (i / 6) * Math.PI * 2;
    const px = ship.x + Math.cos(a) * r;
    const py = ship.y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#ffd7a8";
  ctx.lineWidth = 2.5 / state.camera.zoom;
  ctx.beginPath();
  ctx.arc(ship.x, ship.y, r * 0.72, -Math.PI / 2, -Math.PI / 2 + Math.max(0.001, progress) * Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export function shieldRatioForShip(ship) {
  const maxShield = Number(ship?.maxShield) || 0;
  if (maxShield <= 0) return 0;
  return clamp((Number(ship.shield) || 0) / maxShield, 0, 1);
}

export function shieldRingRadius(ship) {
  const radius = Number(ship?.radius) || 0;
  return Math.max(30, radius + Math.max(8, radius * 0.18));
}

export function drawShieldRing(ship) {
  if (!ship?.alive) return;
  const ratio = shieldRatioForShip(ship);
  if (ratio <= 0) return;

  const ringRadius = shieldRingRadius(ship);
  // Toned down so the shield reads as a ring around the hull without washing the
  // whole ship blue and hiding its team colour.
  const alpha = 0.12 + ratio * 0.3;
  const lineWidth = Math.max(1.7, ringRadius * 0.04) / state.camera.zoom;
  const now = performance.now() * 0.001;
  const phase = now * 1.15 + shieldIdPhase(ship.id);
  const segmentCount = 12;
  const step = (Math.PI * 2) / segmentCount;
  const gap = step * 0.26;
  const activeSegments = ratio * segmentCount;

  ctx.save();
  ctx.translate(ship.x, ship.y);

  const shell = ctx.createRadialGradient(0, 0, ringRadius * 0.82, 0, 0, ringRadius + lineWidth * 3);
  shell.addColorStop(0, "rgba(56, 213, 255, 0)");
  shell.addColorStop(0.84, `rgba(56, 213, 255, ${alpha * 0.09})`);
  shell.addColorStop(1, "rgba(224, 250, 255, 0)");
  ctx.fillStyle = shell;
  ctx.beginPath();
  ctx.arc(0, 0, ringRadius + lineWidth * 2.2, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineCap = "round";
  ctx.lineWidth = lineWidth;
  ctx.shadowColor = "rgba(56, 213, 255, 0.8)";
  ctx.shadowBlur = qualityShadowBlur(10 + ringRadius * 0.1);

  for (let i = 0; i < segmentCount; i += 1) {
    const fill = clamp(activeSegments - i, 0, 1);
    const start = -Math.PI / 2 + i * step + gap / 2;
    const end = start + (step - gap) * Math.max(0.14, fill);
    ctx.globalAlpha = fill > 0 ? alpha * (0.34 + fill * 0.66) : alpha * 0.12;
    ctx.strokeStyle = fill > 0 ? "#38d5ff" : "rgba(56, 213, 255, 0.3)";
    ctx.beginPath();
    ctx.arc(0, 0, ringRadius, start, end);
    ctx.stroke();
  }

  ctx.shadowBlur = qualityShadowBlur(16);
  ctx.globalAlpha = alpha * (0.5 + Math.sin(now * 4 + ratio * 5) * 0.12);
  ctx.lineWidth = Math.max(1, lineWidth * 0.44);
  ctx.strokeStyle = "#e0faff";
  ctx.beginPath();
  ctx.arc(0, 0, ringRadius + lineWidth * 0.7, phase, phase + Math.PI * 0.42);
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.globalAlpha = alpha * 0.2;
  ctx.lineWidth = Math.max(1, lineWidth * 0.35);
  ctx.strokeStyle = "#9ff4ff";
  ctx.beginPath();
  ctx.arc(0, 0, ringRadius - lineWidth * 1.1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function shieldIdPhase(id) {
  const source = String(id || "");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) hash = (hash + source.charCodeAt(i) * (i + 1)) % 628;
  return hash / 100;
}

export function drawShipStructure(design, scale, color) {
  const keys = new Set(design.map((part) => `${part.x},${part.y}`));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(3, scale * 0.26);
  ctx.strokeStyle = "rgba(0,0,0,0.42)";
  drawStructureLines(design, keys, scale);
  // Team colour on the structural spine, made more prominent so ownership reads
  // at a glance even under the (toned-down) shield.
  ctx.lineWidth = Math.max(1.6, scale * 0.17);
  ctx.strokeStyle = color;
  ctx.globalAlpha *= 0.78;
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

// --- Component health -------------------------------------------------------
// Per-component max hp mirrors the server: each part's base hp scaled so the
// design total matches ship.maxHp. Cached per design array (designs are static
// and their object identity is reused across snapshots).
const designComponentHpCache = new WeakMap();

// Remaining health fraction (0..1) for design[index], or null when unknown
// (no component data yet, e.g. ships from older servers). Mirrors the server's
// scaling: the indestructible core is excluded from the damageable sum.
export function componentHealthRatio(ship, index) {
  const chp = ship?.chp;
  if (!chp || chp[index] === undefined || !ship.design) return null;
  if (ship.design[index]?.type === "core") return 1;
  let raw = designComponentHpCache.get(ship.design);
  if (!raw) {
    const values = ship.design.map((part) => Math.max(1, Number(PART_STATS[part.type]?.hp) || 1));
    const sum = ship.design.reduce((total, part, i) => (part.type === "core" ? total : total + values[i]), 0) || 1;
    raw = { values, sum };
    designComponentHpCache.set(ship.design, raw);
  }
  const maxHp = Number(ship.maxHp) || raw.sum;
  const componentMax = raw.values[index] * (maxHp / raw.sum);
  if (!(componentMax > 0)) return null;
  return clamp(chp[index] / componentMax, 0, 1);
}

// Persistent status tint for a module: healthy renders untouched, damaged gets
// a subtle amber wash, critical a stronger red pulse, destroyed a dark broken
// slab. In Component Damage View (state.componentDamageView) the tints are
// stronger and applied from full health thresholds so status reads at a glance.
// Drawn in the local space the module was just drawn in (centred, maybe rotated).
export function drawModuleDamage(drawCtx, ratio, halfW, halfH, now = 0) {
  if (ratio === null) return;
  const overlay = Boolean(state.componentDamageView);
  if (ratio >= DAMAGED_RATIO && !(overlay && ratio < 0.999)) return;
  const w = halfW * 2;
  const h = halfH * 2;
  if (ratio <= 0) {
    // Destroyed: near-black slab with jagged crack lines.
    drawCtx.fillStyle = overlay ? "rgba(52, 58, 66, 0.85)" : "rgba(7, 9, 13, 0.78)";
    drawCtx.fillRect(-halfW, -halfH, w, h);
    drawCtx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    drawCtx.lineWidth = Math.max(1, halfW * 0.16);
    drawCtx.beginPath();
    drawCtx.moveTo(-halfW * 0.8, -halfH * 0.7);
    drawCtx.lineTo(-halfW * 0.1, -halfH * 0.05);
    drawCtx.lineTo(halfW * 0.35, halfH * 0.25);
    drawCtx.lineTo(halfW * 0.85, halfH * 0.75);
    drawCtx.moveTo(halfW * 0.7, -halfH * 0.8);
    drawCtx.lineTo(halfW * 0.1, -halfH * 0.1);
    drawCtx.lineTo(-halfW * 0.4, halfH * 0.5);
    drawCtx.stroke();
    drawCtx.strokeStyle = "rgba(255, 120, 60, 0.35)";
    drawCtx.lineWidth = Math.max(0.6, halfW * 0.08);
    drawCtx.beginPath();
    drawCtx.moveTo(-halfW * 0.1, -halfH * 0.05);
    drawCtx.lineTo(halfW * 0.35, halfH * 0.25);
    drawCtx.stroke();
  } else if (ratio <= CRITICAL_RATIO) {
    // Critical: red wash with a slow pulse so it draws the eye without a glow.
    const pulse = 0.72 + 0.28 * Math.sin(now * 0.008);
    const alpha = (overlay ? 0.5 : 0.4) * pulse;
    drawCtx.fillStyle = `rgba(239, 68, 68, ${alpha})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
  } else {
    // Damaged: subtle amber tint deepening toward critical.
    const depth = clamp((DAMAGED_RATIO - ratio) / DAMAGED_RATIO, 0, 1);
    const alpha = overlay ? 0.2 + depth * 0.35 : 0.12 + depth * 0.3;
    drawCtx.fillStyle = `rgba(251, 176, 64, ${alpha})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
  }
}

// Short hit flash over one module: orange impact for armour plates, red/white
// for internal components, a brighter expanding pop when the hit destroyed it.
// Timers live client-side (componentDamage.js); nothing here touches the server.
export function drawModuleFlash(drawCtx, flash, halfW, halfH) {
  if (!flash) return;
  const s = flash.strength;
  const w = halfW * 2;
  const h = halfH * 2;
  if (flash.destroyed) {
    const grow = 1 + (1 - s) * 0.9;
    drawCtx.fillStyle = `rgba(255, 236, 210, ${0.75 * s})`;
    drawCtx.fillRect(-halfW * grow, -halfH * grow, w * grow, h * grow);
    drawCtx.strokeStyle = `rgba(255, 140, 60, ${0.9 * s})`;
    drawCtx.lineWidth = Math.max(1, halfW * 0.2);
    drawCtx.strokeRect(-halfW * grow, -halfH * grow, w * grow, h * grow);
  } else if (flash.layer === "armor") {
    drawCtx.fillStyle = `rgba(255, 158, 44, ${0.65 * s})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
    drawCtx.strokeStyle = `rgba(255, 214, 130, ${0.85 * s})`;
    drawCtx.lineWidth = Math.max(0.8, halfW * 0.14);
    drawCtx.beginPath();
    drawCtx.moveTo(-halfW * 0.6, halfH * 0.5);
    drawCtx.lineTo(0, -halfH * 0.2);
    drawCtx.lineTo(halfW * 0.55, halfH * 0.4);
    drawCtx.stroke();
  } else {
    drawCtx.fillStyle = `rgba(255, 92, 92, ${0.6 * s})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
    drawCtx.fillStyle = `rgba(255, 245, 245, ${0.5 * s * s})`;
    drawCtx.fillRect(-halfW * 0.55, -halfH * 0.55, w * 0.55, h * 0.55);
  }
}

// Grid center for the 15x15 build grid (core sits here), so modules render
// centered on the ship's origin instead of offset toward one corner.
const GRID_CENTER = 7;

export function moduleLocalPosition(part, scale) {
  return {
    x: (GRID_CENTER - part.y) * scale,
    y: (part.x - GRID_CENTER) * scale
  };
}

// Where and how a (possibly multi-tile) part should be drawn on a ship, in the
// ship's local space: the footprint's centre, its tile dimensions, and the
// angle that aligns a canonical +x-forward component with the footprint's long
// axis. Used by both renderers so blueprint and in-game visuals stay consistent.
export function footprintLocalPlacement(part, scale) {
  const footprint = PART_STATS[part.type]?.footprint || { width: 1, height: 1 };
  const cells = getOccupiedCells(part.x, part.y, footprint, part.rotation || 0);
  let sx = 0, sy = 0, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const cell of cells) {
    const p = moduleLocalPosition(cell, scale);
    sx += p.x; sy += p.y;
    if (p.x < minx) minx = p.x;
    if (p.x > maxx) maxx = p.x;
    if (p.y < miny) miny = p.y;
    if (p.y > maxy) maxy = p.y;
  }
  const rot = normalizeRotation(part.rotation || 0);
  const swap = rot === 90 || rot === 270;
  const w = swap ? footprint.height : footprint.width;
  const h = swap ? footprint.width : footprint.height;
  return {
    cx: sx / cells.length,
    cy: sy / cells.length,
    tilesLong: Math.max(w, h),
    tilesCross: Math.min(w, h),
    // Long axis runs along local x when its x-span is the larger one, else local y.
    longAxisAngle: (maxx - minx) >= (maxy - miny) ? 0 : Math.PI / 2,
    multi: cells.length > 1
  };
}

// --- Module material system --------------------------------------------------
// Top-down modules share one lighting language: a key light from the upper-left,
// metallic bevelled bodies, dark local edges (no bright team outline), and
// restrained energy accents. This keeps components readable and distinct while
// looking like one cohesive, industrial ship rather than glowing icons.

const STRUCTURAL_PARTS = new Set([
  "frame", "armor", "compositeArmor",
  "halfFrameDiagonal", "halfArmorDiagonal", "halfCompositeArmorDiagonal",
  "wingFrame", "wingArmor", "wingCompositeArmor",
  "lightFrame", "heavyFrame"
]);

function parseColor(color) {
  if (typeof color !== "string") return { r: 148, g: 163, b: 184 };
  if (color[0] === "#") {
    let hex = color.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (match) {
    const parts = match[1].split(",").map((v) => parseFloat(v));
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0 };
  }
  return { r: 148, g: 163, b: 184 };
}

// Blends colour a toward colour b (t in 0..1), returning an opaque rgb() string.
function mixColor(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r},${g},${bl})`;
}

// Module fill gradients are defined in local module space, so one gradient per
// (size, color) pair serves every module of that type on screen. The gradient
// alone carries a soft top-left→bottom-right bevel so bodies read as raised
// metal panels without a per-module outline.
const moduleGradientCache = new Map();

function getModuleGradient(size, color) {
  const key = `${size}|${color}`;
  let fill = moduleGradientCache.get(key);
  if (!fill) {
    fill = ctx.createLinearGradient(-size * 0.5, -size * 0.5, size * 0.5, size * 0.5);
    fill.addColorStop(0, mixColor(color, "#ffffff", 0.52));
    fill.addColorStop(0.32, mixColor(color, "#ffffff", 0.14));
    fill.addColorStop(0.6, color);
    fill.addColorStop(1, mixColor(color, "#05070c", 0.74));
    moduleGradientCache.set(key, fill);
  }
  return fill;
}

// Draws a light top-left bevel highlight and a dark bottom-right seam along a
// rounded-square footprint, giving flat plate modules a consistent raised look.
function bevelRoundedPlate(size, inset, radius) {
  const s = size * inset;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = Math.max(0.7, size * 0.045);
  ctx.beginPath();
  ctx.moveTo(-s + radius, -s + size * 0.02);
  ctx.lineTo(s - radius, -s + size * 0.02);
  ctx.moveTo(-s + size * 0.02, -s + radius);
  ctx.lineTo(-s + size * 0.02, s - radius);
  ctx.stroke();
  ctx.strokeStyle = "rgba(3,6,12,0.45)";
  ctx.beginPath();
  ctx.moveTo(-s + radius, s - size * 0.02);
  ctx.lineTo(s - radius, s - size * 0.02);
  ctx.moveTo(s - size * 0.02, -s + radius);
  ctx.lineTo(s - size * 0.02, s - radius);
  ctx.stroke();
  ctx.restore();
}

// Fills + dark-edges a rounded-square body and adds the shared bevel. Used by
// the many system modules that share this plate footprint.
function drawPlateBody(size, inset = 0.44, radius = size * 0.12) {
  const s = size * inset;
  roundRect(ctx, { x: -s, y: -s, width: s * 2, height: s * 2, radius });
  ctx.fill();
  ctx.stroke();
  bevelRoundedPlate(size, inset, radius);
}

// Every regular component is mounted to a cell-filling hull cube. The detailed
// module art is painted over this lower plate, so distinctive silhouettes (for
// example a railgun's rails) remain intact without leaving an apparently empty
// blueprint cell. Wings and diagonal half blocks intentionally keep their
// original cut-away silhouettes.
function drawComponentCubeBase(size, color) {
  const inset = 0.5;
  const extent = size * inset;
  ctx.save();
  // The cube carries the component's own colour with the shared bevel gradient
  // so the ship reads as brightly as the pre-cube art did.
  ctx.fillStyle = getModuleGradient(size, color);
  ctx.strokeStyle = "rgba(3,6,12,0.82)";
  ctx.lineWidth = Math.max(0.9, size * 0.065);
  roundRect(ctx, {
    x: -extent,
    y: -extent,
    width: extent * 2,
    height: extent * 2,
    radius: size * 0.055
  });
  ctx.fill();
  ctx.stroke();
  bevelRoundedPlate(size, inset, size * 0.055);
  ctx.restore();
}

// Small shared primitives for the component language below. Keeping these
// symbols to a few fills/strokes makes the direct Canvas renderer inexpensive;
// Pixi and blueprint views bake the same art into cached textures/icons.
function drawRecessedPanel(size, width = 0.68, height = 0.68, radius = 0.08) {
  ctx.save();
  // Kept translucent so the coloured cube beneath still shows through — a
  // heavier fill here made every component read nearly black.
  ctx.fillStyle = "rgba(5,10,18,0.38)";
  ctx.strokeStyle = "rgba(225,238,255,0.24)";
  ctx.lineWidth = Math.max(0.7, size * 0.04);
  roundRect(ctx, {
    x: -size * width * 0.5,
    y: -size * height * 0.5,
    width: size * width,
    height: size * height,
    radius: size * radius
  });
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawComponentPort(size, x, y, radius, accent, innerScale = 0.45) {
  ctx.save();
  ctx.fillStyle = "rgba(3,7,13,0.9)";
  ctx.beginPath();
  ctx.arc(size * x, size * y, size * radius, 0, Math.PI * 2);
  ctx.fill();
  if (accent) {
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(size * x, size * y, size * radius * innerScale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSimpleTurret(size, accent, barrels = 1, barrelLength = 0.46) {
  drawWeaponBase(size);
  ctx.save();
  ctx.fillStyle = accent;
  const barrelHeight = barrels === 1 ? 0.18 : 0.11;
  for (let i = 0; i < barrels; i += 1) {
    const y = barrels === 1 ? -barrelHeight * 0.5 : (i === 0 ? -0.19 : 0.08);
    roundRect(ctx, {
      x: size * 0.02,
      y: size * y,
      width: size * barrelLength,
      height: size * barrelHeight,
      radius: size * 0.035
    });
    ctx.fill();
  }
  ctx.restore();
}

const COMPONENT_ART_ALIASES = Object.freeze({
  lightFrame: "frame",
  heavyFrame: "frame",
  bulkhead: "armor",
  lightMount: "weaponMount",
  heavyMount: "weaponMount",
  smallReactor: "reactor",
  heavyReactor: "reactor",
  microThruster: "maneuverThruster",
  heavyEngine: "engine",
  lightShield: "shield",
  heavyShield: "shield",
  regenShield: "shield",
  lightBlaster: "blaster",
  heavyBlaster: "blaster",
  lightMissile: "missile",
  lightRailgun: "railgun",
  heavyRailgun: "railgun",
  pointDefenseLaser: "pointDefense"
});

function componentArtType(type) {
  return COMPONENT_ART_ALIASES[type] || type;
}

function drawProfessionalModuleDetail(type, size, color) {
  type = componentArtType(type);
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "core") {
    drawRecessedPanel(size, 0.78, 0.78, 0.16);
    ctx.strokeStyle = "rgba(116,225,255,0.7)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.29, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#dff9ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(3,25,38,0.78)";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.34, 0); ctx.lineTo(-size * 0.21, 0);
    ctx.moveTo(size * 0.21, 0); ctx.lineTo(size * 0.34, 0);
    ctx.moveTo(0, -size * 0.34); ctx.lineTo(0, -size * 0.21);
    ctx.moveTo(0, size * 0.21); ctx.lineTo(0, size * 0.34);
    ctx.stroke();
    return true;
  }

  if (type === "frame") {
    ctx.strokeStyle = "rgba(8,14,24,0.72)";
    ctx.lineWidth = Math.max(1.2, size * 0.13);
    ctx.beginPath();
    ctx.moveTo(-size * 0.34, -size * 0.34); ctx.lineTo(size * 0.34, size * 0.34);
    ctx.moveTo(size * 0.34, -size * 0.34); ctx.lineTo(-size * 0.34, size * 0.34);
    ctx.stroke();
    ctx.strokeStyle = "rgba(225,236,250,0.28)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.31, -size * 0.31); ctx.lineTo(size * 0.31, size * 0.31);
    ctx.stroke();
    drawComponentPort(size, 0, 0, 0.095, "#d8e2f0", 0.35);
    return true;
  }

  if (type === "halfFrameDiagonal" || type === "halfArmorDiagonal" || type === "halfCompositeArmorDiagonal") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, -size * 0.5);
    ctx.lineTo(size * 0.5, -size * 0.5);
    ctx.lineTo(-size * 0.5, size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = type === "halfFrameDiagonal" ? "rgba(225,236,250,0.46)" : "rgba(255,244,220,0.42)";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.32, -size * 0.32);
    ctx.lineTo(type === "halfFrameDiagonal" ? size * 0.17 : size * 0.1, -size * 0.32);
    ctx.lineTo(-size * 0.32, type === "halfFrameDiagonal" ? size * 0.17 : size * 0.1);
    ctx.stroke();
    return true;
  }

  if (type === "wingFrame" || type === "wingArmor" || type === "wingCompositeArmor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.5, -size * 0.5);
    ctx.lineTo(size * 0.5, 0);
    ctx.lineTo(-size * 0.5, size * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = type === "wingFrame" ? "rgba(225,236,250,0.46)" : "rgba(255,244,220,0.42)";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.34, -size * 0.3);
    ctx.lineTo(size * 0.16, 0);
    ctx.lineTo(-size * 0.34, size * 0.3);
    ctx.stroke();
    return true;
  }

  if (type === "armor" || type === "compositeArmor") {
    // Full-cube plating: three overlapping armour bands with a lit top bevel
    // and corner rivets. Composite adds diagonal laminate weave in amber.
    const composite = type === "compositeArmor";
    ctx.save();
    const bandFills = [
      mixColor(color, "#ffffff", 0.2),
      mixColor(color, "#ffffff", 0.04),
      mixColor(color, "#05070c", 0.26)
    ];
    ctx.strokeStyle = "rgba(3,6,12,0.6)";
    ctx.lineWidth = fine;
    for (let i = 0; i < 3; i += 1) {
      ctx.fillStyle = bandFills[i];
      roundRect(ctx, { x: -size * 0.47, y: -size * 0.47 + i * size * 0.32, width: size * 0.94, height: size * 0.3, radius: size * 0.05 });
      ctx.fill();
      ctx.stroke();
    }
    ctx.strokeStyle = composite ? "rgba(255,236,184,0.8)" : "rgba(255,238,218,0.65)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.42);
    ctx.lineTo(size * 0.42, -size * 0.42);
    ctx.stroke();
    if (composite) {
      ctx.strokeStyle = "rgba(255,214,140,0.45)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.36, size * 0.4); ctx.lineTo(size * 0.02, -size * 0.02);
      ctx.moveTo(-size * 0.02, size * 0.42); ctx.lineTo(size * 0.38, 0);
      ctx.stroke();
    }
    const rivet = mixColor(color, "#ffffff", 0.55);
    drawComponentPort(size, -0.38, -0.32, 0.05, rivet, 0.5);
    drawComponentPort(size, 0.38, -0.32, 0.05, rivet, 0.5);
    drawComponentPort(size, -0.38, 0.36, 0.05, rivet, 0.5);
    drawComponentPort(size, 0.38, 0.36, 0.05, rivet, 0.5);
    ctx.restore();
    return true;
  }

  if (type === "engine") {
    drawRecessedPanel(size, 0.92, 0.88, 0.1);
    // Twin recessed exhaust bells at the rear and a clean central power spine.
    drawComponentPort(size, -0.34, -0.24, 0.15, "#b8f8ff", 0.43);
    drawComponentPort(size, -0.34, 0.24, 0.15, "#61d9ff", 0.43);
    ctx.fillStyle = "#72ddf7";
    roundRect(ctx, { x: -size * 0.12, y: -size * 0.26, width: size * 0.54, height: size * 0.52, radius: size * 0.08 });
    ctx.fill();
    ctx.strokeStyle = "rgba(225,248,255,0.55)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.02, -size * 0.13); ctx.lineTo(size * 0.34, -size * 0.13);
    ctx.moveTo(-size * 0.02, size * 0.13); ctx.lineTo(size * 0.34, size * 0.13);
    ctx.stroke();
    return true;
  }

  if (type === "weaponMount") {
    const pale = mixColor(color, "#ffffff", 0.62);
    drawRecessedPanel(size, 0.76, 0.76, 0.14);
    drawWeaponBase(size);
    drawComponentPort(size, -0.3, -0.3, 0.045, pale, 0.4);
    drawComponentPort(size, 0.3, -0.3, 0.045, pale, 0.4);
    drawComponentPort(size, -0.3, 0.3, 0.045, pale, 0.4);
    drawComponentPort(size, 0.3, 0.3, 0.045, pale, 0.4);
    return true;
  }

  if (type === "blaster") {
    drawSimpleTurret(size, "#ffd1dc", 1, 0.46);
    return true;
  }
  if (type === "autocannon") {
    drawSimpleTurret(size, "#fdba74", 2, 0.46);
    return true;
  }
  if (type === "pointDefense" || type === "pointDefenseLaser") {
    drawSimpleTurret(size, "#fda4af", 1, 0.38);
    ctx.strokeStyle = "rgba(255,225,232,0.72)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, -Math.PI * 0.34, Math.PI * 0.34);
    ctx.stroke();
    return true;
  }
  if (type === "flakCannon") {
    drawWeaponBase(size);
    ctx.fillStyle = "#fb7185";
    roundRect(ctx, { x: size * 0.01, y: -size * 0.24, width: size * 0.43, height: size * 0.14, radius: size * 0.03 }); ctx.fill();
    roundRect(ctx, { x: size * 0.01, y: size * 0.1, width: size * 0.43, height: size * 0.14, radius: size * 0.03 }); ctx.fill();
    drawComponentPort(size, 0.44, -0.17, 0.055, "#fff1f2", 0.55);
    drawComponentPort(size, 0.44, 0.17, 0.055, "#fff1f2", 0.55);
    return true;
  }
  if (type === "missile") {
    drawRecessedPanel(size, 0.72, 0.58, 0.12);
    ctx.fillStyle = "#f0dcff";
    ctx.beginPath();
    ctx.moveTo(size * 0.4, 0); ctx.lineTo(size * 0.08, -size * 0.16);
    ctx.lineTo(-size * 0.26, -size * 0.13); ctx.lineTo(-size * 0.34, 0);
    ctx.lineTo(-size * 0.26, size * 0.13); ctx.lineTo(size * 0.08, size * 0.16);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.moveTo(-size * 0.2, -size * 0.12); ctx.lineTo(-size * 0.35, -size * 0.25); ctx.lineTo(-size * 0.05, -size * 0.12); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-size * 0.2, size * 0.12); ctx.lineTo(-size * 0.35, size * 0.25); ctx.lineTo(-size * 0.05, size * 0.12); ctx.fill();
    return true;
  }
  if (type === "railgun") {
    drawRecessedPanel(size, 0.92, 0.88, 0.08);
    ctx.strokeStyle = "#f4f7ff";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.2); ctx.lineTo(size * 0.44, -size * 0.2);
    ctx.moveTo(-size * 0.36, size * 0.2); ctx.lineTo(size * 0.44, size * 0.2);
    ctx.stroke();
    ctx.fillStyle = "#6695ff";
    ctx.fillRect(size * 0.28, -size * 0.14, size * 0.16, size * 0.28);
    return true;
  }
  if (type === "swarmMissile" || type === "interceptorPod") {
    drawRecessedPanel(size, 0.78, 0.78, 0.1);
    const accent = type === "interceptorPod" ? "#e9d5ff" : "#d8b4fe";
    const xs = [-0.2, 0.2];
    const ys = [-0.2, 0.2];
    for (const px of xs) for (const py of ys) drawComponentPort(size, px, py, 0.11, accent, 0.42);
    return true;
  }
  if (type === "torpedo") {
    drawRecessedPanel(size, 0.8, 0.6, 0.09);
    ctx.fillStyle = "#c4b5fd";
    ctx.beginPath();
    ctx.moveTo(size * 0.42, 0); ctx.lineTo(size * 0.18, -size * 0.16);
    ctx.lineTo(-size * 0.32, -size * 0.16); ctx.lineTo(-size * 0.39, 0);
    ctx.lineTo(-size * 0.32, size * 0.16); ctx.lineTo(size * 0.18, size * 0.16);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#6d28d9"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.moveTo(-size * 0.08, -size * 0.16); ctx.lineTo(-size * 0.08, size * 0.16); ctx.stroke();
    return true;
  }
  if (type === "beamEmitter" || type === "repairBeam") {
    drawWeaponBase(size);
    const accent = type === "repairBeam" ? "#4ade80" : "#38bdf8";
    ctx.fillStyle = type === "repairBeam" ? "#166534" : "#075985";
    ctx.fillRect(0, -size * 0.16, size * 0.22, size * 0.32);
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(size * 0.18, -size * 0.2); ctx.lineTo(size * 0.48, 0); ctx.lineTo(size * 0.18, size * 0.2);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    if (type === "repairBeam") {
      ctx.fillStyle = "#dcfce7";
      ctx.fillRect(-size * 0.3, -size * 0.04, size * 0.2, size * 0.08);
      ctx.fillRect(-size * 0.24, -size * 0.1, size * 0.08, size * 0.2);
    }
    return true;
  }
  if (type === "aegisProjector") {
    drawRecessedPanel(size, 0.76, 0.76, 0.18);
    ctx.strokeStyle = "#6ee7b7"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(-size * 0.06, 0, size * 0.31, -Math.PI * 0.42, Math.PI * 0.42); ctx.stroke();
    drawComponentPort(size, -0.04, 0, 0.11, "#d1fae5", 0.55);
    return true;
  }

  if (type === "reactor") {
    drawRecessedPanel(size, 0.78, 0.78, 0.17);
    ctx.strokeStyle = "#d6a820"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.29, 0, Math.PI * 2); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.18, "#fff4a8", 0.62);
    return true;
  }
  if (type === "battery") {
    drawRecessedPanel(size, 0.72, 0.76, 0.08);
    ctx.fillStyle = "#baf4ff";
    for (let i = 0; i < 3; i += 1) {
      roundRect(ctx, { x: -size * 0.25, y: size * (-0.25 + i * 0.21), width: size * 0.5, height: size * 0.1, radius: size * 0.025 }); ctx.fill();
    }
    ctx.fillStyle = "#164e63";
    ctx.fillRect(-size * 0.08, -size * 0.43, size * 0.16, size * 0.08);
    return true;
  }
  if (type === "capacitor") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.fillStyle = "#60a5fa";
    roundRect(ctx, { x: -size * 0.27, y: -size * 0.3, width: size * 0.18, height: size * 0.6, radius: size * 0.04 }); ctx.fill();
    roundRect(ctx, { x: size * 0.09, y: -size * 0.3, width: size * 0.18, height: size * 0.6, radius: size * 0.04 }); ctx.fill();
    ctx.strokeStyle = "#dbeafe"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.moveTo(-size * 0.09, 0); ctx.lineTo(size * 0.09, 0); ctx.stroke();
    return true;
  }
  if (type === "auxGenerator") {
    drawRecessedPanel(size, 0.72, 0.76, 0.09);
    ctx.fillStyle = "#fef08a";
    roundRect(ctx, { x: -size * 0.24, y: -size * 0.28, width: size * 0.16, height: size * 0.56, radius: size * 0.04 }); ctx.fill();
    roundRect(ctx, { x: size * 0.08, y: -size * 0.28, width: size * 0.16, height: size * 0.56, radius: size * 0.04 }); ctx.fill();
    ctx.strokeStyle = "#f59e0b"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.moveTo(-size * 0.08, -size * 0.14); ctx.lineTo(size * 0.08, 0); ctx.lineTo(-size * 0.08, size * 0.14); ctx.stroke();
    return true;
  }
  if (type === "shield") {
    drawRecessedPanel(size, 0.78, 0.78, 0.17);
    ctx.strokeStyle = "#a7f3d0"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.3, Math.PI * 0.12, Math.PI * 1.88); ctx.stroke();
    ctx.strokeStyle = "rgba(167,243,208,0.42)"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.2, Math.PI * 0.12, Math.PI * 1.88); ctx.stroke();
    return true;
  }
  if (type === "repair") {
    drawRecessedPanel(size, 0.74, 0.74, 0.16);
    ctx.fillStyle = "#bbf7d0";
    roundRect(ctx, { x: -size * 0.09, y: -size * 0.3, width: size * 0.18, height: size * 0.6, radius: size * 0.035 }); ctx.fill();
    roundRect(ctx, { x: -size * 0.3, y: -size * 0.09, width: size * 0.6, height: size * 0.18, radius: size * 0.035 }); ctx.fill();
    return true;
  }
  if (type === "gyroscope") {
    drawRecessedPanel(size, 0.78, 0.78, 0.17);
    ctx.strokeStyle = "#ddd6fe"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#8b5cf6";
    ctx.beginPath(); ctx.moveTo(0, -size * 0.34); ctx.lineTo(0, size * 0.34); ctx.moveTo(-size * 0.34, 0); ctx.lineTo(size * 0.34, 0); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.09, "#ede9fe", 0.5);
    return true;
  }
  if (type === "maneuverThruster") {
    drawRecessedPanel(size, 0.76, 0.72, 0.09);
    ctx.fillStyle = "#8bdff7";
    ctx.beginPath();
    ctx.moveTo(-size * 0.28, -size * 0.27); ctx.lineTo(size * 0.31, -size * 0.12);
    ctx.lineTo(size * 0.31, size * 0.12); ctx.lineTo(-size * 0.28, size * 0.27);
    ctx.closePath(); ctx.fill();
    drawComponentPort(size, -0.3, 0, 0.14, "#bdefff", 0.4);
    return true;
  }
  if (type === "sensorArray") {
    drawRecessedPanel(size, 0.76, 0.76, 0.16);
    ctx.strokeStyle = "#a7f3d0"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(-size * 0.12, 0, size * 0.31, -Math.PI * 0.32, Math.PI * 0.32); ctx.stroke();
    ctx.strokeStyle = "#d1fae5"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.moveTo(-size * 0.12, 0); ctx.lineTo(size * 0.34, 0); ctx.stroke();
    drawComponentPort(size, -0.12, 0, 0.085, "#ecfdf5", 0.5);
    return true;
  }
  if (type === "targetingComputer") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.strokeStyle = "#e879f9"; ctx.lineWidth = fine;
    ctx.strokeRect(-size * 0.27, -size * 0.27, size * 0.54, size * 0.54);
    ctx.beginPath(); ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
    ctx.moveTo(-size * 0.35, 0); ctx.lineTo(-size * 0.12, 0);
    ctx.moveTo(size * 0.12, 0); ctx.lineTo(size * 0.35, 0);
    ctx.moveTo(0, -size * 0.35); ctx.lineTo(0, -size * 0.12);
    ctx.moveTo(0, size * 0.12); ctx.lineTo(0, size * 0.35); ctx.stroke();
    return true;
  }
  if (type === "fireControl") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.strokeStyle = "#fb923c"; ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.25, size * 0.2); ctx.lineTo(0, -size * 0.25); ctx.lineTo(size * 0.25, size * 0.2); ctx.lineTo(-size * 0.25, size * 0.2); ctx.stroke();
    drawComponentPort(size, -0.25, 0.2, 0.07, "#ffedd5", 0.45);
    drawComponentPort(size, 0, -0.25, 0.07, "#ffedd5", 0.45);
    drawComponentPort(size, 0.25, 0.2, 0.07, "#ffedd5", 0.45);
    return true;
  }
  if (type === "heatSink") {
    drawRecessedPanel(size, 0.78, 0.78, 0.06);
    ctx.fillStyle = "#93c5fd";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(-size * 0.3, size * (-0.29 + i * 0.19), size * 0.6, size * 0.08);
    }
    return true;
  }
  if (type === "radiator") {
    // Active cooling fan: visually distinct from the heat sink's passive fin
    // stack. The blueprint overlay separately highlights the actual exposed edge.
    drawRecessedPanel(size, 0.8, 0.8, 0.1);
    ctx.strokeStyle = "#9be8ff";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.29, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#3aaed8";
    ctx.beginPath();
    ctx.moveTo(-size * 0.04, -size * 0.07); ctx.lineTo(size * 0.12, -size * 0.29); ctx.lineTo(size * 0.02, -size * 0.34); ctx.closePath();
    ctx.moveTo(size * 0.07, -size * 0.04); ctx.lineTo(size * 0.29, size * 0.12); ctx.lineTo(size * 0.34, size * 0.02); ctx.closePath();
    ctx.moveTo(size * 0.04, size * 0.07); ctx.lineTo(-size * 0.12, size * 0.29); ctx.lineTo(-size * 0.02, size * 0.34); ctx.closePath();
    ctx.moveTo(-size * 0.07, size * 0.04); ctx.lineTo(-size * 0.29, -size * 0.12); ctx.lineTo(-size * 0.34, -size * 0.02); ctx.closePath();
    ctx.fill();
    drawComponentPort(size, 0, 0, 0.105, "#d9f8ff", 0.42);
    ctx.strokeStyle = "rgba(125,211,252,0.62)";
    ctx.lineWidth = Math.max(0.7, size * 0.04);
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.28); ctx.lineTo(-size * 0.36, size * 0.28);
    ctx.moveTo(size * 0.36, -size * 0.28); ctx.lineTo(size * 0.36, size * 0.28);
    ctx.stroke();
    return true;
  }
  if (type === "captureModule") {
    drawRecessedPanel(size, 0.76, 0.76, 0.16);
    ctx.fillStyle = "#f9a8d4";
    ctx.beginPath(); ctx.moveTo(0, -size * 0.32); ctx.lineTo(size * 0.25, 0); ctx.lineTo(0, size * 0.32); ctx.lineTo(-size * 0.25, 0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#831843"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2); ctx.stroke();
    return true;
  }
  if (type === "signalAmplifier") {
    drawRecessedPanel(size, 0.76, 0.76, 0.14);
    ctx.fillStyle = "#5eead4"; ctx.fillRect(-size * 0.05, -size * 0.28, size * 0.1, size * 0.56);
    ctx.strokeStyle = "#ccfbf1"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.22, -Math.PI * 0.62, -Math.PI * 0.38); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, size * 0.34, -Math.PI * 0.62, -Math.PI * 0.38); ctx.stroke();
    return true;
  }
  if (type === "stabilizerNode") {
    drawRecessedPanel(size, 0.76, 0.76, 0.16);
    ctx.strokeStyle = "#c4b5fd"; ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.33); ctx.lineTo(size * 0.13, -size * 0.13); ctx.lineTo(size * 0.33, 0);
    ctx.lineTo(size * 0.13, size * 0.13); ctx.lineTo(0, size * 0.33); ctx.lineTo(-size * 0.13, size * 0.13);
    ctx.lineTo(-size * 0.33, 0); ctx.lineTo(-size * 0.13, -size * 0.13); ctx.closePath(); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.11, "#ddd6fe", 0.5);
    return true;
  }

  return false;
}

export function drawModule({ x, y, size, color, type, trim, drawBase = true, drawDetail = true }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // Dark local edge instead of a bright team-coloured outline; a soft glow is
  // reserved for genuine energy parts so the ship reads clean, not noisy.
  ctx.lineWidth = Math.max(0.9, size * 0.08);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  // Structural parts carry a restrained team tint so friend/foe stays readable
  // on the hull without every module glowing in the team colour.
  const bodyColor = trim && STRUCTURAL_PARTS.has(type) ? mixColor(color, trim, 0.24) : color;
  ctx.fillStyle = getModuleGradient(size, bodyColor);

  const keepsPartialShape = type === "halfFrameDiagonal"
    || type === "halfArmorDiagonal"
    || type === "halfCompositeArmorDiagonal"
    || type === "wingFrame"
    || type === "wingArmor"
    || type === "wingCompositeArmor";
  if (!keepsPartialShape && drawBase) {
    drawComponentCubeBase(size, bodyColor);
    // The base helper owns its canvas state; restore the component's intended
    // fill for the existing detail drawing below.
    ctx.fillStyle = getModuleGradient(size, bodyColor);
  }

  if (!drawDetail) {
    ctx.restore();
    return;
  }

  // All currently selectable parts use the unified professional detail set.
  // Legacy branches remain below as compatibility art for any old/custom part
  // ids loaded from storage.
  if (drawProfessionalModuleDetail(type, size, bodyColor)) {
    ctx.restore();
    return;
  }

  if (type === "core") {
    drawPlateBody(size, 0.48, size * 0.18);
    // Housed reactor well: dark socket, bright controlled core, containment ring.
    ctx.save();
    ctx.fillStyle = "rgba(6,12,20,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "#8fe6ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#f4fdff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.19, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(110,231,255,0.75)";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (type === "frame") {
    drawPlateBody(size, 0.46, size * 0.1);
    // Simple internal support bracing, kept dark/industrial rather than a bright cross.
    ctx.save();
    ctx.strokeStyle = "rgba(10,16,26,0.5)";
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.beginPath();
    ctx.moveTo(-size * 0.26, -size * 0.26);
    ctx.lineTo(size * 0.26, size * 0.26);
    ctx.moveTo(size * 0.26, -size * 0.26);
    ctx.lineTo(-size * 0.26, size * 0.26);
    ctx.stroke();
    ctx.strokeStyle = "rgba(210,222,240,0.24)";
    ctx.lineWidth = Math.max(0.7, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(-size * 0.26, -size * 0.26);
    ctx.lineTo(size * 0.26, size * 0.26);
    ctx.stroke();
    ctx.fillStyle = "rgba(214,226,244,0.32)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.07, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (type === "halfFrameDiagonal" || type === "halfArmorDiagonal" || type === "halfCompositeArmorDiagonal") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.46);
    ctx.lineTo(size * 0.46, -size * 0.46);
    ctx.lineTo(-size * 0.46, size * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (type === "halfFrameDiagonal") {
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.2);
      ctx.moveTo(-size * 0.2, size * 0.1);
      ctx.lineTo(-size * 0.2, -size * 0.2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(255,244,220,0.38)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, -size * 0.2);
      ctx.stroke();
    }
  } else if (type === "wingFrame" || type === "wingArmor" || type === "wingCompositeArmor") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.46);
    ctx.lineTo(size * 0.46, 0);
    ctx.lineTo(-size * 0.46, size * 0.46);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (type === "wingFrame") {
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = Math.max(1, size * 0.08);
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, 0);
      ctx.lineTo(-size * 0.2, size * 0.2);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "rgba(255,244,220,0.38)";
      ctx.beginPath();
      ctx.moveTo(-size * 0.2, -size * 0.2);
      ctx.lineTo(size * 0.1, 0);
      ctx.stroke();
    }
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
    // Propulsion housing (wider at the mount, tapering toward the nozzle at -x).
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.4);
    ctx.lineTo(size * 0.46, -size * 0.26);
    ctx.lineTo(size * 0.46, size * 0.26);
    ctx.lineTo(-size * 0.36, size * 0.4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Panel seam across the housing.
    ctx.save();
    ctx.strokeStyle = "rgba(210,222,240,0.2)";
    ctx.lineWidth = Math.max(0.7, size * 0.045);
    ctx.beginPath();
    ctx.moveTo(size * 0.16, -size * 0.24);
    ctx.lineTo(size * 0.16, size * 0.24);
    ctx.stroke();
    ctx.restore();
    // Exhaust nozzle: dark bell around a hot cyan throat, pointing -x.
    ctx.save();
    ctx.fillStyle = "#0a2732";
    ctx.beginPath();
    ctx.moveTo(-size * 0.36, -size * 0.24);
    ctx.lineTo(-size * 0.58, -size * 0.2);
    ctx.lineTo(-size * 0.58, size * 0.2);
    ctx.lineTo(-size * 0.36, size * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.moveTo(-size * 0.4, -size * 0.12);
    ctx.lineTo(-size * 0.56, 0);
    ctx.lineTo(-size * 0.4, size * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
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
  } else if (type === "swarmMissile") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#e9d5ff";
    roundRect(ctx, { x: 0, y: -size * 0.28, width: size * 0.52, height: size * 0.56, radius: size * 0.08 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#581c87";
    ctx.beginPath();
    ctx.arc(size * 0.18, -size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.arc(size * 0.38, -size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.arc(size * 0.18, size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.arc(size * 0.38, size * 0.12, size * 0.06, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "autocannon") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#fdba74";
    // Twin barrels: roundRect() starts a new path, so each barrel must be filled
    // on its own — a single shared fill() would only render the last barrel.
    roundRect(ctx, { x: size * 0.02, y: -size * 0.22, width: size * 0.68, height: size * 0.14, radius: size * 0.04 });
    ctx.fill();
    roundRect(ctx, { x: size * 0.02, y: size * 0.08, width: size * 0.68, height: size * 0.14, radius: size * 0.04 });
    ctx.fill();
  } else if (type === "torpedo") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#c084fc";
    ctx.beginPath();
    ctx.moveTo(-size * 0.12, -size * 0.24);
    ctx.lineTo(size * 0.46, -size * 0.24);
    ctx.lineTo(size * 0.72, 0);
    ctx.lineTo(size * 0.46, size * 0.24);
    ctx.lineTo(-size * 0.12, size * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (type === "beamEmitter") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#0284c7";
    ctx.fillRect(0, -size * 0.16, size * 0.22, size * 0.32);
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.moveTo(size * 0.22, 0);
    ctx.lineTo(size * 0.44, -size * 0.18);
    ctx.lineTo(size * 0.72, 0);
    ctx.lineTo(size * 0.44, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (type === "aegisProjector") {
    drawWeaponBase(size, color);
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = Math.max(1.4, size * 0.1);
    ctx.beginPath();
    ctx.arc(size * 0.18, 0, size * 0.36, -Math.PI * 0.4, Math.PI * 0.4);
    ctx.stroke();
    ctx.fillStyle = "#a7f3d0";
    ctx.beginPath();
    ctx.arc(size * 0.22, 0, size * 0.12, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "pointDefense" || type === "pointDefenseLaser") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#fda4af";
    roundRect(ctx, { x: 0, y: -size * 0.08, width: size * 0.62, height: size * 0.16, radius: size * 0.04 });
    ctx.fill();
  } else if (type === "flakCannon") {
    // Left turret
    ctx.save();
    ctx.translate(0, -size * 0.22);
    drawWeaponBase(size * 0.65);
    ctx.fillStyle = "#f43f5e";
    roundRect(ctx, { x: 0, y: -size * 0.06, width: size * 0.45, height: size * 0.12, radius: size * 0.02 });
    ctx.fill();
    ctx.restore();

    // Right turret
    ctx.save();
    ctx.translate(0, size * 0.22);
    drawWeaponBase(size * 0.65);
    ctx.fillStyle = "#f43f5e";
    roundRect(ctx, { x: 0, y: -size * 0.06, width: size * 0.45, height: size * 0.12, radius: size * 0.02 });
    ctx.fill();
    ctx.restore();
  } else if (type === "interceptorPod") {
    // Casing
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.16 });
    ctx.fill();
    ctx.stroke();

    // 4 launcher tubes in purple/violet
    ctx.fillStyle = "#a855f7";
    roundRect(ctx, { x: -size * 0.32, y: -size * 0.38, width: size * 0.66, height: size * 0.14, radius: size * 0.03 });
    roundRect(ctx, { x: -size * 0.32, y: -size * 0.18, width: size * 0.66, height: size * 0.14, radius: size * 0.03 });
    roundRect(ctx, { x: -size * 0.32, y: size * 0.02, width: size * 0.66, height: size * 0.14, radius: size * 0.03 });
    roundRect(ctx, { x: -size * 0.32, y: size * 0.22, width: size * 0.66, height: size * 0.14, radius: size * 0.03 });
    ctx.fill();

    // Rocket tips inside the tubes in light purple/white
    ctx.fillStyle = "#f3e8ff";
    ctx.beginPath();
    ctx.arc(size * 0.34, -size * 0.31, size * 0.05, 0, Math.PI * 2);
    ctx.arc(size * 0.34, -size * 0.11, size * 0.05, 0, Math.PI * 2);
    ctx.arc(size * 0.34, size * 0.09, size * 0.05, 0, Math.PI * 2);
    ctx.arc(size * 0.34, size * 0.29, size * 0.05, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "repairBeam") {
    drawWeaponBase(size, color);
    ctx.fillStyle = "#15803d";
    ctx.fillRect(0, -size * 0.16, size * 0.22, size * 0.32);
    ctx.fillStyle = "#4ade80";
    ctx.beginPath();
    ctx.moveTo(size * 0.22, 0);
    ctx.lineTo(size * 0.44, -size * 0.16);
    ctx.lineTo(size * 0.68, 0);
    ctx.lineTo(size * 0.44, size * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
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
  } else if (type === "gyroscope") {
    drawRoundSystem(size);
    ctx.strokeStyle = "rgba(255,255,255,0.48)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#a78bfa";
    ctx.fillRect(-size * 0.06, -size * 0.38, size * 0.12, size * 0.76);
    ctx.fillRect(-size * 0.38, -size * 0.06, size * 0.76, size * 0.12);
  } else if (type === "auxGenerator") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#fef08a";
    ctx.fillRect(-size * 0.14, -size * 0.28, size * 0.28, size * 0.56);
    ctx.strokeStyle = "#ca8a04";
    ctx.strokeRect(-size * 0.14, -size * 0.28, size * 0.28, size * 0.56);
  } else if (type === "capacitor") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.10 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(-size * 0.28, -size * 0.3, size * 0.2, size * 0.6);
    ctx.fillRect(size * 0.08, -size * 0.3, size * 0.2, size * 0.6);
  } else if (type === "maneuverThruster") {
    ctx.beginPath();
    ctx.moveTo(-size * 0.35, -size * 0.35);
    ctx.lineTo(size * 0.35, -size * 0.15);
    ctx.lineTo(size * 0.35, size * 0.15);
    ctx.lineTo(-size * 0.35, size * 0.35);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#60a5fa";
    ctx.fillRect(-size * 0.48, -size * 0.12, size * 0.15, size * 0.24);
  } else if (type === "sensorArray") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#60a5fa";
    ctx.lineWidth = Math.max(1, size * 0.08);
    ctx.beginPath();
    ctx.arc(-size * 0.12, 0, size * 0.32, -Math.PI * 0.3, Math.PI * 0.3);
    ctx.stroke();
    ctx.fillStyle = "#bfdbfe";
    ctx.fillRect(-size * 0.16, -size * 0.04, size * 0.48, size * 0.08);
  } else if (type === "targetingComputer") {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(0, 255, 100, 0.08)";
    ctx.fillRect(-size * 0.28, -size * 0.28, size * 0.56, size * 0.56);
    ctx.strokeStyle = "#22c55e";
    ctx.strokeRect(-size * 0.28, -size * 0.28, size * 0.56, size * 0.56);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.14, 0, Math.PI * 2);
    ctx.moveTo(-size * 0.22, 0);
    ctx.lineTo(size * 0.22, 0);
    ctx.moveTo(0, -size * 0.22);
    ctx.lineTo(0, size * 0.22);
    ctx.stroke();
  } else if (type === "fireControl") {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#ef4444";
    ctx.beginPath();
    ctx.moveTo(-size * 0.24, -size * 0.24);
    ctx.lineTo(size * 0.24, size * 0.24);
    ctx.moveTo(size * 0.24, -size * 0.24);
    ctx.lineTo(-size * 0.24, size * 0.24);
    ctx.stroke();
  } else if (type === "heatSink") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.10 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(239, 68, 68, 0.45)";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(-size * 0.28 + i * size * 0.16, -size * 0.26, size * 0.08, size * 0.52);
    }
  } else if (type === "captureModule") {
    drawRoundSystem(size);
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.32);
    ctx.lineTo(size * 0.24, 0);
    ctx.lineTo(0, size * 0.32);
    ctx.lineTo(-size * 0.24, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (type === "signalAmplifier") {
    roundRect(ctx, { x: -size * 0.42, y: -size * 0.42, width: size * 0.84, height: size * 0.84, radius: size * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#a855f7";
    ctx.fillRect(-size * 0.06, -size * 0.28, size * 0.12, size * 0.56);
    ctx.strokeStyle = "#d8b4fe";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.22, -Math.PI * 0.6, -Math.PI * 0.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.34, -Math.PI * 0.6, -Math.PI * 0.4);
    ctx.stroke();
  } else if (type === "stabilizerNode") {
    drawRoundSystem(size);
    ctx.strokeStyle = "#38bdf8";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#0284c7";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.12, 0, Math.PI * 2);
    ctx.fill();
  } else {
    roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.1 });
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawFootprintSeams(unit, hl, hc, tilesLong) {
  ctx.save();
  ctx.strokeStyle = "rgba(225,238,255,0.15)";
  ctx.lineWidth = Math.max(0.65, unit * 0.035);
  for (let i = 1; i < tilesLong; i += 1) {
    const x = -hl + (hl * 2 * i) / tilesLong;
    ctx.beginPath();
    ctx.moveTo(x, -hc * 0.88);
    ctx.lineTo(x, hc * 0.88);
    ctx.stroke();
  }
  ctx.restore();
}

function drawFootprintPanel(unit, hl, hc, widthScale = 0.9, heightScale = 0.68, radiusScale = 0.1) {
  ctx.save();
  // Translucent like drawRecessedPanel: the coloured cube base must remain
  // visible or multi-tile components go muddy dark.
  ctx.fillStyle = "rgba(4,9,16,0.4)";
  ctx.strokeStyle = "rgba(225,238,255,0.24)";
  ctx.lineWidth = Math.max(0.75, unit * 0.045);
  roundRect(ctx, {
    x: -hl * widthScale,
    y: -hc * heightScale,
    width: hl * widthScale * 2,
    height: hc * heightScale * 2,
    radius: unit * radiusScale
  });
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawFootprintPort(unit, x, y, radius, accent) {
  ctx.save();
  ctx.fillStyle = "rgba(2,6,12,0.94)";
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(x, y, radius * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawProfessionalFootprintDetail(type, unit, tilesLong, color, hl, hc) {
  type = componentArtType(type);
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "engine") {
    // Full-cube propulsion block: bright cowling in the module colour, a rear
    // exhaust manifold with twin glowing bells spanning the whole cross axis,
    // and a forward intake turbine. Exhaust faces -x (blueprint: downward).
    drawFootprintPanel(unit, hl, hc, 0.96, 0.9, 0.09);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.1);
    roundRect(ctx, { x: -hl + unit * 0.52, y: -hc * 0.74, width: hl * 2 - unit * 0.82, height: hc * 1.48, radius: unit * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(2,7,13,0.92)";
    roundRect(ctx, { x: -hl + unit * 0.04, y: -hc * 0.84, width: unit * 0.5, height: hc * 1.68, radius: unit * 0.1 });
    ctx.fill();
    const rearX = -hl + unit * 0.28;
    drawFootprintPort(unit, rearX, -hc * 0.44, unit * 0.19, "#d9fbff");
    drawFootprintPort(unit, rearX, hc * 0.44, unit * 0.19, "#4dd8ff");
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    roundRect(ctx, { x: -hl + unit * 0.16, y: -hc * 0.11, width: unit * 0.26, height: hc * 0.22, radius: unit * 0.05 });
    ctx.fill();
    ctx.restore();
    const frontX = hl - unit * 0.36;
    ctx.fillStyle = "rgba(3,12,20,0.9)";
    ctx.beginPath();
    ctx.arc(frontX, 0, unit * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#bcefff";
    ctx.lineWidth = Math.max(fine, unit * 0.065);
    ctx.beginPath();
    ctx.arc(frontX, 0, unit * 0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#52d8ff";
    ctx.beginPath();
    ctx.arc(frontX, 0, unit * 0.075, 0, Math.PI * 2);
    ctx.fill();
    // Illuminated conduits along both flanks tie manifold to turbine.
    ctx.strokeStyle = "rgba(132,230,255,0.85)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.62, -hc * 0.52);
    ctx.lineTo(frontX - unit * 0.28, -hc * 0.52);
    ctx.moveTo(-hl + unit * 0.62, hc * 0.52);
    ctx.lineTo(frontX - unit * 0.28, hc * 0.52);
    ctx.stroke();
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "railgun") {
    // Fills the whole footprint: armoured breech, capacitor coil bands along
    // the body, twin accelerator rails running the full length, and a bright
    // muzzle armature — no dead space above or below the rails.
    drawFootprintPanel(unit, hl, hc, 0.96, 0.92, 0.07);
    ctx.fillStyle = mixColor(color, "#101827", 0.42);
    roundRect(ctx, { x: -hl + unit * 0.08, y: -hc * 0.8, width: unit * 0.7, height: hc * 1.6, radius: unit * 0.09 });
    ctx.fill(); ctx.stroke();
    const bands = Math.max(2, tilesLong);
    ctx.fillStyle = "rgba(122,164,255,0.4)";
    for (let i = 0; i < bands; i += 1) {
      const bx = -hl + unit * 0.95 + (hl * 2 - unit * 1.45) * (bands > 1 ? i / (bands - 1) : 0.5);
      ctx.fillRect(bx, -hc * 0.66, unit * 0.09, hc * 1.32);
    }
    ctx.strokeStyle = "#eef4ff";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.6, -hc * 0.44); ctx.lineTo(hl - unit * 0.06, -hc * 0.44);
    ctx.moveTo(-hl + unit * 0.6, hc * 0.44); ctx.lineTo(hl - unit * 0.06, hc * 0.44);
    ctx.stroke();
    ctx.fillStyle = "#5f8fff";
    ctx.fillRect(hl - unit * 0.32, -hc * 0.56, unit * 0.24, hc * 1.12);
    ctx.save();
    ctx.shadowColor = "#9fdcff";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#dbeafe";
    ctx.fillRect(hl - unit * 0.16, -hc * 0.18, unit * 0.12, hc * 0.36);
    ctx.restore();
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "beamEmitter" || type === "repairBeam") {
    // Focusing-array look filling the footprint: an energy conduit core, three
    // focusing coils stepping wider toward the muzzle, and a glowing emitter
    // head. Repair beam is green with a cross emblem; beam emitter is blue.
    const repair = type === "repairBeam";
    const accent = repair ? "#4ade80" : "#38bdf8";
    const deep = repair ? "#14532d" : "#075985";
    const pale = repair ? "#bbf7d0" : "#bae6fd";
    drawFootprintPanel(unit, hl, hc, 0.96, 0.9, 0.09);
    ctx.fillStyle = deep;
    roundRect(ctx, { x: -hl * 0.84, y: -hc * 0.3, width: hl * 1.5, height: hc * 0.6, radius: unit * 0.08 });
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = pale;
    ctx.lineWidth = Math.max(fine, unit * 0.06);
    for (const [fx, span] of [[-hl * 0.42, 0.52], [-hl * 0.02, 0.66], [hl * 0.34, 0.82]]) {
      ctx.beginPath();
      ctx.moveTo(fx, -hc * span);
      ctx.lineTo(fx, hc * span);
      ctx.stroke();
    }
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(hl * 0.5, -hc * 0.6); ctx.lineTo(hl - unit * 0.05, 0); ctx.lineTo(hl * 0.5, hc * 0.6);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.stroke();
    ctx.strokeStyle = mixColor(accent, "#ffffff", 0.62);
    ctx.lineWidth = Math.max(fine, unit * 0.055);
    ctx.beginPath(); ctx.moveTo(-hl * 0.72, 0); ctx.lineTo(hl * 0.62, 0); ctx.stroke();
    if (repair) {
      // Medic cross on the rear housing.
      ctx.fillStyle = "#dcfce7";
      ctx.fillRect(-hl * 0.66, -hc * 0.09, unit * 0.36, hc * 0.18);
      ctx.fillRect(-hl * 0.66 + unit * 0.135, -hc * 0.26, unit * 0.09, hc * 0.52);
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "swarmMissile") {
    drawFootprintPanel(unit, hl, hc, 0.91, 0.76, 0.09);
    const cols = Math.min(3, Math.max(2, tilesLong + 1));
    for (let c = 0; c < cols; c += 1) {
      const x = -hl * 0.56 + (hl * 1.12 * c) / Math.max(1, cols - 1);
      drawFootprintPort(unit, x, -hc * 0.33, unit * 0.12, "#eadcff");
      drawFootprintPort(unit, x, hc * 0.33, unit * 0.12, "#d8b4fe");
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "torpedo") {
    // Open launch trough spanning the footprint with a loaded torpedo inside:
    // finned tail, banded body, glowing warhead at the muzzle.
    drawFootprintPanel(unit, hl, hc, 0.96, 0.92, 0.08);
    ctx.fillStyle = "rgba(3,7,14,0.88)";
    roundRect(ctx, { x: -hl * 0.9, y: -hc * 0.52, width: hl * 1.84, height: hc * 1.04, radius: hc * 0.4 });
    ctx.fill();
    ctx.fillStyle = "#b9a2ff";
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0);
    ctx.lineTo(hl * 0.56, -hc * 0.34);
    ctx.lineTo(-hl * 0.62, -hc * 0.34);
    ctx.lineTo(-hl * 0.78, 0);
    ctx.lineTo(-hl * 0.62, hc * 0.34);
    ctx.lineTo(hl * 0.56, hc * 0.34);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    // Tail fins.
    ctx.fillStyle = "#7c3aed";
    ctx.beginPath();
    ctx.moveTo(-hl * 0.56, -hc * 0.34); ctx.lineTo(-hl * 0.78, -hc * 0.66); ctx.lineTo(-hl * 0.36, -hc * 0.34);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-hl * 0.56, hc * 0.34); ctx.lineTo(-hl * 0.78, hc * 0.66); ctx.lineTo(-hl * 0.36, hc * 0.34);
    ctx.closePath(); ctx.fill();
    // Body bands.
    ctx.strokeStyle = "#6d28d9";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-hl * 0.32, -hc * 0.34); ctx.lineTo(-hl * 0.32, hc * 0.34);
    ctx.moveTo(hl * 0.06, -hc * 0.34); ctx.lineTo(hl * 0.06, hc * 0.34);
    ctx.stroke();
    // Glowing warhead tip.
    ctx.save();
    ctx.shadowColor = "#e879f9";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#f5d0fe";
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0); ctx.lineTo(hl * 0.6, -hc * 0.24); ctx.lineTo(hl * 0.6, hc * 0.24);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "aegisProjector") {
    drawFootprintPanel(unit, hl, hc, 0.88, 0.82, 0.16);
    const radius = Math.min(hl, hc) * 0.58;
    ctx.strokeStyle = "#6ee7b7";
    ctx.lineWidth = Math.max(1.4, unit * 0.11);
    ctx.beginPath(); ctx.arc(-radius * 0.14, 0, radius, -Math.PI * 0.43, Math.PI * 0.43); ctx.stroke();
    ctx.strokeStyle = "rgba(110,231,183,0.42)"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(-radius * 0.14, 0, radius * 0.66, -Math.PI * 0.43, Math.PI * 0.43); ctx.stroke();
    drawFootprintPort(unit, -radius * 0.14, 0, unit * 0.18, "#d1fae5");
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "reactor") {
    drawFootprintPanel(unit, hl, hc, 0.9, 0.73, 0.16);
    ctx.fillStyle = "#fff1a6";
    roundRect(ctx, { x: -hl * 0.5, y: -hc * 0.2, width: hl, height: hc * 0.4, radius: hc * 0.2 }); ctx.fill();
    ctx.strokeStyle = "#c28b16"; ctx.lineWidth = line;
    ctx.beginPath();
    ctx.arc(-hl * 0.5, 0, hc * 0.31, 0, Math.PI * 2);
    ctx.arc(hl * 0.5, 0, hc * 0.31, 0, Math.PI * 2);
    ctx.stroke();
    drawFootprintPort(unit, 0, 0, unit * 0.13, "#fffbea");
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "capacitor") {
    drawFootprintPanel(unit, hl, hc, 0.91, 0.72, 0.08);
    const cells = Math.min(4, Math.max(2, tilesLong * 2));
    const available = hl * 1.55;
    const cellW = available / cells;
    ctx.fillStyle = "#60a5fa";
    for (let i = 0; i < cells; i += 1) {
      const x = -available * 0.5 + i * cellW + cellW * 0.12;
      roundRect(ctx, { x, y: -hc * 0.38, width: cellW * 0.76, height: hc * 0.76, radius: unit * 0.045 }); ctx.fill();
    }
    ctx.strokeStyle = "#dbeafe"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.moveTo(-available * 0.53, 0); ctx.lineTo(available * 0.53, 0); ctx.stroke();
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  return false;
}

// --- Footprint-aware component art -------------------------------------------
// Draws a multi-tile component as one purpose-built object spanning its whole
// footprint, in a canonical frame where +x is "forward" (barrel / long axis)
// and the body is centred on the origin. Shared by the arena ship renderer and
// the designer icon baker so blueprint and in-game visuals match. 1x1 parts
// keep using drawModule(); this only handles the elongated/multi-cell types.
export function drawFootprintComponent({ type, unit, tilesLong, tilesCross, color, trim, drawBase = true, drawDetail = true }) {
  const hl = (tilesLong * unit) / 2; // half length along +x
  const hc = (tilesCross * unit) / 2; // half width along y
  const edge = "rgba(3,6,12,0.72)";

  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, unit * 0.08);
  ctx.strokeStyle = edge;

  const structural = STRUCTURAL_PARTS.has(type);
  const bodyColor = trim && structural ? mixColor(color, trim, 0.24) : color;
  const bodyFill = getModuleGradient(unit, bodyColor);
  ctx.fillStyle = bodyFill;

  // Multi-cell modules use one continuous, footprint-filling cube base. This is
  // especially important for weapons: their barrels and launchers sit on top of
  // occupied blocks instead of visually floating through empty blueprint cells.
  if (drawBase && !type.startsWith("wing") && !type.startsWith("half")) {
    ctx.save();
    ctx.fillStyle = getModuleGradient(Math.max(hl, hc) * 2, bodyColor);
    roundRect(ctx, {
      x: -hl,
      y: -hc,
      width: hl * 2,
      height: hc * 2,
      radius: Math.min(unit * 0.1, hc * 0.22)
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = bodyFill;
  }

  if (!drawDetail) {
    ctx.restore();
    return;
  }

  if (drawProfessionalFootprintDetail(type, unit, tilesLong, bodyColor, hl, hc)) {
    ctx.restore();
    return;
  }

  // Long rounded chassis used as the base body for most elongated parts.
  const chassis = (padCross = 0.72, radius = unit * 0.22) => {
    roundRect(ctx, { x: -hl, y: -hc * padCross, width: hl * 2, height: hc * padCross * 2, radius });
    ctx.fill();
    ctx.stroke();
  };
  const panelSeams = (count) => {
    ctx.save();
    ctx.strokeStyle = "rgba(210,222,240,0.18)";
    ctx.lineWidth = Math.max(0.6, unit * 0.04);
    for (let i = 1; i < count; i += 1) {
      const x = -hl + (hl * 2 * i) / count;
      ctx.beginPath();
      ctx.moveTo(x, -hc * 0.6);
      ctx.lineTo(x, hc * 0.6);
      ctx.stroke();
    }
    ctx.restore();
  };

  if (type === "railgun") {
    // Rear breech block + twin rails running the full length + muzzle.
    roundRect(ctx, { x: -hl, y: -hc * 0.82, width: unit * 0.95, height: hc * 1.64, radius: unit * 0.14 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = mixColor(color, "#05070c", 0.45);
    roundRect(ctx, { x: -hl + unit * 0.55, y: -hc * 0.5, width: hl * 2 - unit * 0.7, height: hc, radius: unit * 0.09 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#f4f7ff";
    ctx.lineWidth = Math.max(1.1, unit * 0.09);
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.6, -hc * 0.32);
    ctx.lineTo(hl - unit * 0.05, -hc * 0.32);
    ctx.moveTo(-hl + unit * 0.6, hc * 0.32);
    ctx.lineTo(hl - unit * 0.05, hc * 0.32);
    ctx.stroke();
    ctx.fillStyle = "#7aa4ff";
    ctx.fillRect(hl - unit * 0.28, -hc * 0.26, unit * 0.28, hc * 0.52);
  } else if (type === "beamEmitter" || type === "repairBeam") {
    const accent = type === "repairBeam" ? "#4ade80" : "#38bdf8";
    const core = type === "repairBeam" ? "#15803d" : "#0284c7";
    chassis(0.62, unit * 0.2);
    panelSeams(tilesLong);
    ctx.fillStyle = core;
    ctx.fillRect(-hl * 0.2, -hc * 0.22, hl * 0.5, hc * 0.44);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(hl * 0.3, -hc * 0.34);
    ctx.lineTo(hl, 0);
    ctx.lineTo(hl * 0.3, hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (type === "swarmMissile") {
    chassis(0.86, unit * 0.16);
    // Rows of launch tubes along the length, mouths toward +x.
    ctx.fillStyle = "#3b0764";
    const rows = 2;
    const cols = Math.max(2, tilesLong);
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const cx = -hl + hl * 2 * ((c + 0.5) / cols);
        const cy = (r === 0 ? -1 : 1) * hc * 0.4;
        ctx.beginPath();
        ctx.arc(cx, cy, unit * 0.13, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = "#e9d5ff";
    for (let c = 0; c < cols; c += 1) {
      const cx = -hl + hl * 2 * ((c + 0.5) / cols);
      ctx.beginPath();
      ctx.arc(cx, -hc * 0.4, unit * 0.05, 0, Math.PI * 2);
      ctx.arc(cx, hc * 0.4, unit * 0.05, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (type === "torpedo") {
    chassis(0.7, unit * 0.16);
    panelSeams(tilesLong);
    // Loaded torpedo tip protruding forward.
    ctx.fillStyle = "#c084fc";
    ctx.beginPath();
    ctx.moveTo(-hl * 0.3, -hc * 0.34);
    ctx.lineTo(hl * 0.55, -hc * 0.34);
    ctx.lineTo(hl, 0);
    ctx.lineTo(hl * 0.55, hc * 0.34);
    ctx.lineTo(-hl * 0.3, hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (type === "aegisProjector") {
    // Square-ish projector: housing + broad emitter arc facing +x.
    roundRect(ctx, { x: -hl, y: -hc, width: hl * 2, height: hc * 2, radius: unit * 0.24 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "#34d399";
    ctx.lineWidth = Math.max(1.4, unit * 0.12);
    ctx.beginPath();
    ctx.arc(-hl * 0.1, 0, Math.min(hl, hc) * 0.82, -Math.PI * 0.42, Math.PI * 0.42);
    ctx.stroke();
    ctx.fillStyle = "#a7f3d0";
    ctx.beginPath();
    ctx.arc(0, 0, Math.min(hl, hc) * 0.26, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === "engine") {
    // Long propulsion block, nozzle bell + hot throat at the rear (-x).
    roundRect(ctx, { x: -hl + unit * 0.34, y: -hc * 0.8, width: hl * 2 - unit * 0.34, height: hc * 1.6, radius: unit * 0.16 });
    ctx.fill();
    ctx.stroke();
    panelSeams(tilesLong);
    ctx.fillStyle = "#0a2732";
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.34, -hc * 0.5);
    ctx.lineTo(-hl, -hc * 0.42);
    ctx.lineTo(-hl, hc * 0.42);
    ctx.lineTo(-hl + unit * 0.34, hc * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.moveTo(-hl + unit * 0.28, -hc * 0.26);
    ctx.lineTo(-hl - unit * 0.02, 0);
    ctx.lineTo(-hl + unit * 0.28, hc * 0.26);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (type === "reactor") {
    // Elongated capsule housing with glowing core band.
    roundRect(ctx, { x: -hl, y: -hc * 0.86, width: hl * 2, height: hc * 1.72, radius: hc * 0.7 });
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = "#ffe07a";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#fff7b3";
    roundRect(ctx, { x: -hl * 0.62, y: -hc * 0.3, width: hl * 1.24, height: hc * 0.6, radius: hc * 0.3 });
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = "#6b4b12";
    ctx.beginPath();
    ctx.arc(-hl * 0.5, 0, hc * 0.34, 0, Math.PI * 2);
    ctx.arc(hl * 0.5, 0, hc * 0.34, 0, Math.PI * 2);
    ctx.stroke();
  } else if (type === "capacitor") {
    // Long block of charge cells.
    roundRect(ctx, { x: -hl, y: -hc * 0.84, width: hl * 2, height: hc * 1.68, radius: unit * 0.12 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    const cols = Math.max(2, tilesLong + 1);
    for (let c = 0; c < cols; c += 1) {
      const cx = -hl + unit * 0.24 + (hl * 2 - unit * 0.48) * (c / (cols - 1 || 1));
      ctx.fillRect(cx - unit * 0.06, -hc * 0.5, unit * 0.12, hc);
    }
  } else if (structural) {
    // Armour/frame/wings: one plate covering the whole footprint with seams.
    roundRect(ctx, { x: -hl, y: -hc, width: hl * 2, height: hc * 2, radius: unit * 0.14 });
    ctx.fill();
    ctx.stroke();
    panelSeams(tilesLong);
    if (type.startsWith("wing")) {
      ctx.strokeStyle = "rgba(255,255,255,0.3)";
      ctx.beginPath();
      ctx.moveTo(-hl * 0.7, -hc * 0.5);
      ctx.lineTo(hl * 0.7, 0);
      ctx.lineTo(-hl * 0.7, hc * 0.5);
      ctx.stroke();
    }
  } else {
    // Unknown multi-tile type: fall back to a scaled single module.
    ctx.restore();
    drawModule({ x: 0, y: 0, size: Math.min(hl, hc) * 2 * 0.92, color, type, trim });
    return;
  }

  ctx.restore();
}

// Shared mounted-turret base: a dark socket, a bevelled raised ring in the
// module body colour, and a recessed hub the barrel emerges from. Gives every
// weapon a believable top-down turret mount rather than a flat disc.
export function drawWeaponBase(size) {
  ctx.save();
  ctx.fillStyle = "rgba(6,10,16,0.88)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.arc(0, 0, size * 0.33, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.lineWidth = Math.max(0.7, size * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, Math.PI * 0.92, Math.PI * 1.7);
  ctx.stroke();
  ctx.strokeStyle = "rgba(3,6,12,0.5)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.27, Math.PI * -0.08, Math.PI * 0.7);
  ctx.stroke();
  ctx.fillStyle = "rgba(9,14,22,0.9)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Shared circular housing for system modules (reactor, shield, etc.): bevelled
// ring with a light upper-left rim and a dark lower-right seam.
export function drawRoundSystem(size) {
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = Math.max(0.7, size * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.4, Math.PI * 0.92, Math.PI * 1.68);
  ctx.stroke();
  ctx.strokeStyle = "rgba(3,6,12,0.45)";
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.4, Math.PI * -0.08, Math.PI * 0.68);
  ctx.stroke();
  ctx.restore();
}

export function drawSelectionRing(ship) {
  ctx.save();
  const player = state.snapshot?.players?.find((p) => p.id === ship.ownerId);
  const color = player ? player.color : "#ffca57";
  
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.75 / state.camera.zoom;
  const size = ship.radius + 12;
  const arm = Math.max(5, size * 0.22);
  
  // Top-Left corner bracket
  ctx.beginPath();
  ctx.moveTo(ship.x - size, ship.y - size + arm);
  ctx.lineTo(ship.x - size, ship.y - size);
  ctx.lineTo(ship.x - size + arm, ship.y - size);
  ctx.stroke();
  
  // Top-Right corner bracket
  ctx.beginPath();
  ctx.moveTo(ship.x + size, ship.y - size + arm);
  ctx.lineTo(ship.x + size, ship.y - size);
  ctx.lineTo(ship.x + size - arm, ship.y - size);
  ctx.stroke();
  
  // Bottom-Left corner bracket
  ctx.beginPath();
  ctx.moveTo(ship.x - size, ship.y + size - arm);
  ctx.lineTo(ship.x - size, ship.y + size);
  ctx.lineTo(ship.x - size + arm, ship.y + size);
  ctx.stroke();
  
  // Bottom-Right corner bracket
  ctx.beginPath();
  ctx.moveTo(ship.x + size, ship.y + size - arm);
  ctx.lineTo(ship.x + size, ship.y + size);
  ctx.lineTo(ship.x + size - arm, ship.y + size);
  ctx.stroke();
  ctx.restore();

  if (ship.alive) {
    const maxRange = Math.max(ship.blasterRange || 0, ship.missileRange || 0, ship.railgunRange || 0, ship.beamRange || 0);
    if (maxRange > 0) {
      // Draw single range ring at maximum range
      ctx.save();
      ctx.strokeStyle = "rgba(255, 202, 87, 0.22)";
      ctx.lineWidth = 1.25 / state.camera.zoom;
      ctx.setLineDash([6 / state.camera.zoom, 10 / state.camera.zoom]);
      ctx.beginPath();
      ctx.arc(ship.x, ship.y, maxRange, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Only draw firing arcs when a single ship is selected
      if (state.selectedShipIds.size <= 1) {
        const design = ship.design || [];
        const scale = 13;
        const cos = Math.cos(ship.angle);
        const sin = Math.sin(ship.angle);

        design.forEach((part, i) => {
          const weaponStat = PART_STATS[part.type]?.weapon;
          if (!weaponStat) return;

          const { x: px, y: py } = moduleLocalPosition(part, scale);
          const gunWorldX = ship.x + px * cos - py * sin;
          const gunWorldY = ship.y + px * sin + py * cos;

          const defaultRelativeFacing = moduleRotationToRadians(normalizeRotation(part.rotation));
          const arcRadians = (weaponStat.arc || 360) * Math.PI / 180;
          const gunRange = ship[weaponStat.type + "Range"] || weaponStat.range || maxRange;

          // Arc is fixed to the gun's designer-facing direction, only moves with hull rotation
          const arcCenterWorld = ship.angle + defaultRelativeFacing;

          // Draw the firing arc wedge from the gun's world position
          if (arcRadians < Math.PI * 2) {
            ctx.save();
            ctx.fillStyle = "rgba(255, 202, 87, 0.025)";
            ctx.strokeStyle = "rgba(255, 202, 87, 0.08)";
            ctx.lineWidth = 1.0 / state.camera.zoom;
            ctx.beginPath();
            ctx.moveTo(gunWorldX, gunWorldY);
            ctx.arc(
              gunWorldX,
              gunWorldY,
              gunRange,
              arcCenterWorld - arcRadians / 2,
              arcCenterWorld + arcRadians / 2
            );
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
        });
      }
    }
  }
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
  const frameHeight = selected ? 42 : 32;
  const y = ship.y - ship.radius - (selected ? 62 : 48);
  const now = performance.now();
  const hud = updateShipHud(ship, now);
  const hullRatio = clamp(hud.hp / ship.maxHp, 0, 1);
  const hullLagRatio = clamp(hud.hpLag / ship.maxHp, 0, 1);
  const shieldRatio = ship.maxShield > 0 ? clamp(ship.shield / ship.maxShield, 0, 1) : 0;
  const lowHull = hullRatio <= 0.25;
  const alpha = selected || damaged ? 1 : 0.68;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = player.color;
  ctx.shadowBlur = qualityShadowBlur(4);
  drawHudFrame(x - 4, y - 4, width + 8, frameHeight, player.color, lowHull);
  ctx.shadowBlur = 0;

  const shieldY = y + 3;
  const hullY = y + (selected ? 15 : 12);
  const shieldHeight = selected ? 9 : 7;
  const hullHeight = selected ? 10 : 8;
  const barX = x + 4;
  const barWidth = width - 8;

  if (ship.maxShield > 0) {
    drawShieldStatusBar({
      x: barX,
      y: shieldY,
      width: barWidth,
      height: shieldHeight,
      ratio: shieldRatio,
      lagRatio: shieldRatio,
      val: ship.shield,
      maxVal: ship.maxShield
    });
  } else {
    drawEmptyShieldLine(barX, shieldY, barWidth);
  }

  const hullColor = hullColorForRatio(hullRatio);
  drawStatusBar({
    x: barX,
    y: hullY,
    width: barWidth,
    height: hullHeight,
    ratio: hullRatio,
    lagRatio: hullLagRatio,
    fillStart: hullColor.start,
    fillEnd: hullColor.end,
    glow: lowHull ? "rgba(255,95,126,0.78)" : `${player.color}aa`,
    segments: selected ? 8 : 6,
    val: hud.hp,
    maxVal: ship.maxHp
  });

  ctx.shadowColor = lowHull ? "rgba(255,95,126,0.9)" : player.color;
  ctx.shadowBlur = qualityShadowBlur(lowHull ? 9 : 4);
  ctx.fillStyle = lowHull ? "#ffd6df" : "rgba(237,244,255,0.86)";
  ctx.font = `${Math.max(9, (selected ? 10 : 9) / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";



  ctx.shadowColor = player.color;
  ctx.shadowBlur = qualityShadowBlur(5);
  ctx.fillStyle = "#ffffff";
  ctx.font = `bold ${Math.max(10, (selected ? 11 : 10) / state.camera.zoom)}px system-ui, sans-serif`;
  ctx.fillText(player.name.toUpperCase(), ship.x, y + frameHeight + 4);
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
  ctx.shadowColor = warning ? "rgba(255,70,100,0.4)" : "rgba(0,0,0,0.5)";
  ctx.shadowBlur = qualityShadowBlur(10);
  
  ctx.fillStyle = "rgba(4,10,22,0.85)";
  ctx.strokeStyle = warning ? "rgba(255,95,126,0.85)" : color;
  ctx.lineWidth = 1.5 / state.camera.zoom;
  
  ctx.beginPath();
  ctx.moveTo(x + 8, y);
  ctx.lineTo(x + width - 8, y);
  ctx.lineTo(x + width, y + 8);
  ctx.lineTo(x + width - 6, y + height);
  ctx.lineTo(x + 6, y + height);
  ctx.lineTo(x, y + height - 8);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  
  ctx.strokeStyle = warning ? "rgba(255,95,126,0.95)" : color;
  ctx.lineWidth = 1.0 / state.camera.zoom;
  
  ctx.beginPath();
  ctx.moveTo(x + 12, y);
  ctx.lineTo(x + 8, y);
  ctx.lineTo(x, y + 8);
  ctx.lineTo(x, y + 14);
  ctx.stroke();
  
  ctx.beginPath();
  ctx.moveTo(x + width - 12, y);
  ctx.lineTo(x + width - 8, y);
  ctx.lineTo(x + width, y + 8);
  ctx.lineTo(x + width, y + 14);
  ctx.stroke();
  
  ctx.restore();
}

export function drawStatusBar(options) {
  const { x, y, width, height, ratio, lagRatio, fillStart, fillEnd, glow, segments, val, maxVal } = options;
  ctx.save();
  
  const radius = Math.max(1, height * 0.35);
  
  roundRect(ctx, { x, y, width, height, radius });
  ctx.fillStyle = "rgba(2,10,18,0.85)";
  ctx.fill();
  
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  if (lagRatio > ratio) {
    roundRect(ctx, { x, y, width: width * lagRatio, height, radius });
    ctx.fillStyle = "rgba(239, 68, 68, 0.4)";
    ctx.fill();
  }

  if (ratio > 0) {
    ctx.save();
    const fill = ctx.createLinearGradient(x, y, x + width, y);
    fill.addColorStop(0, fillStart);
    fill.addColorStop(1, fillEnd);
    
    roundRect(ctx, { x, y, width: width * ratio, height, radius });
    ctx.fillStyle = fill;
    
    ctx.shadowColor = glow;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
    
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, { x, y, width: width * ratio, height: height * 0.45, radius: radius * 0.6 });
    const gloss = ctx.createLinearGradient(x, y, x, y + height * 0.45);
    gloss.addColorStop(0, "rgba(255, 255, 255, 0.28)");
    gloss.addColorStop(1, "rgba(255, 255, 255, 0.0)");
    ctx.fillStyle = gloss;
    ctx.fill();
    ctx.restore();
  }

  ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
  ctx.lineWidth = 0.75 / state.camera.zoom;
  roundRect(ctx, { x, y, width, height, radius });
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 0.75 / state.camera.zoom;
  const step = width / segments;
  for (let i = 1; i < segments; i += 1) {
    ctx.beginPath();
    ctx.moveTo(x + step * i, y + 0.5);
    ctx.lineTo(x + step * i, y + height - 0.5);
    ctx.stroke();
  }

  if (val !== undefined && maxVal !== undefined) {
    const text = Math.round(val) + " / " + Math.round(maxVal);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    const fontSize = Math.max(7, Math.floor(height * 0.85));
    ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    
    ctx.strokeStyle = "rgba(0, 0, 0, 0.65)";
    ctx.lineWidth = 2.0;
    ctx.strokeText(text, x + width / 2, y + height / 2 + 1);
    ctx.fillText(text, x + width / 2, y + height / 2 + 1);
  }
  
  ctx.restore();
}

export function drawShieldStatusBar(options) {
  const { x, y, width, height, ratio, lagRatio, val, maxVal } = options;
  const radius = Math.max(2, height * 0.48);
  const zoom = state.camera.zoom;

  ctx.save();

  roundRect(ctx, { x, y, width, height, radius });
  const track = ctx.createLinearGradient(x, y, x + width, y + height);
  track.addColorStop(0, "rgba(3,18,34,0.92)");
  track.addColorStop(1, "rgba(8,31,52,0.86)");
  ctx.fillStyle = track;
  ctx.fill();
  ctx.strokeStyle = "rgba(125, 211, 252, 0.22)";
  ctx.lineWidth = 0.75 / zoom;
  ctx.stroke();

  if (lagRatio > ratio) {
    roundRect(ctx, { x, y, width: width * lagRatio, height, radius });
    ctx.fillStyle = "rgba(125, 211, 252, 0.18)";
    ctx.fill();
  }

  if (ratio > 0) {
    const fillWidth = Math.min(width, Math.max(radius, width * ratio));
    ctx.save();
    roundRect(ctx, { x, y, width: fillWidth, height, radius });
    ctx.clip();

    const fill = ctx.createLinearGradient(x, y, x + width, y);
    fill.addColorStop(0, "#075985");
    fill.addColorStop(0.58, "#22d3ee");
    fill.addColorStop(1, "#e0faff");
    ctx.shadowColor = "rgba(56, 213, 255, 0.62)";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, fillWidth, height);

    const gloss = ctx.createLinearGradient(x, y, x, y + height);
    gloss.addColorStop(0, "rgba(255,255,255,0.42)");
    gloss.addColorStop(0.42, "rgba(255,255,255,0.08)");
    gloss.addColorStop(1, "rgba(255,255,255,0)");
    ctx.shadowBlur = 0;
    ctx.fillStyle = gloss;
    ctx.fillRect(x, y, fillWidth, Math.max(2, height * 0.62));

    ctx.restore();
  }

  const cells = 8;
  const cellGap = 2 / zoom;
  const cellWidth = (width - cellGap * (cells - 1)) / cells;
  for (let i = 1; i < cells; i += 1) {
    const sx = x + i * (cellWidth + cellGap) - cellGap * 0.5;
    ctx.strokeStyle = "rgba(224, 250, 255, 0.18)";
    ctx.lineWidth = 0.65 / zoom;
    ctx.beginPath();
    ctx.moveTo(sx, y + 1.2 / zoom);
    ctx.lineTo(sx, y + height - 1.2 / zoom);
    ctx.stroke();
  }

  ctx.strokeStyle = "rgba(125, 211, 252, 0.45)";
  ctx.lineWidth = 1 / zoom;
  roundRect(ctx, { x, y, width, height, radius });
  ctx.stroke();

  if (val !== undefined && maxVal !== undefined) {
    const text = Math.round(val) + " / " + Math.round(maxVal);
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#f2fdff";
    const fontSize = Math.max(7, Math.floor(height * 0.85));
    ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(0, 8, 18, 0.78)";
    ctx.lineWidth = 2.1;
    ctx.strokeText(text, x + width / 2, y + height / 2 + 1);
    ctx.fillText(text, x + width / 2, y + height / 2 + 1);
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
  if (ratio <= 0.25) return { start: "#450a0a", end: "#ef4444" };
  if (ratio <= 0.55) return { start: "#431407", end: "#f97316" };
  return { start: "#062f17", end: "#22c55e" };
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

// The minimap's map features (zones, clouds, asteroids) never move; render them
// once per (map, size) combination instead of ~60 arc fills per frame.
let minimapStaticCache = null;

export function getMinimapStaticLayer(map, w, h, sx, sy) {
  if (minimapStaticCache && minimapStaticCache.map === map && minimapStaticCache.w === w && minimapStaticCache.h === h) {
    return minimapStaticCache.canvas;
  }

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  const mini = canvas.getContext("2d");

  for (const zone of map.safeZones || []) {
    mini.fillStyle = zone.color || "rgba(255,255,255,0.06)";
    mini.beginPath();
    mini.arc(zone.x * sx, zone.y * sy, zone.radius * sx, 0, Math.PI * 2);
    mini.fill();
  }
  for (const cloud of map.clouds || []) {
    mini.fillStyle = `rgba(${cloud.color || "56,213,255"}, 0.12)`;
    mini.beginPath();
    mini.ellipse(cloud.x * sx, cloud.y * sy, Math.max(3, cloud.rx * sx), Math.max(2, cloud.ry * sy), cloud.rotation || 0, 0, Math.PI * 2);
    mini.fill();
  }
  for (const asteroid of map.asteroids || []) {
    mini.fillStyle = "rgba(172,185,202,0.45)";
    mini.strokeStyle = "rgba(22,28,37,0.82)";
    mini.lineWidth = 1;
    mini.beginPath();
    mini.arc(asteroid.x * sx, asteroid.y * sy, Math.max(2.5, asteroid.radius * sx), 0, Math.PI * 2);
    mini.fill();
    mini.stroke();
  }

  minimapStaticCache = { map, w, h, canvas };
  return canvas;
}

// Notifications live below the minimap during play (over the arena, right-edge
// aligned to the minimap) so they never permanently cover the right score panel.
function anchorNotificationsBelowMinimap(x, y, w, h) {
  if (!dom.toastStack) return;
  const cr = ctx.canvas.getBoundingClientRect();
  dom.toastStack.style.top = `${Math.round(cr.top + y + h + 14)}px`;
  dom.toastStack.style.right = `${Math.round(Math.max(14, window.innerWidth - (cr.left + x + w)))}px`;
  dom.toastStack.dataset.anchored = "minimap";
}

function resetNotificationAnchor() {
  if (!dom.toastStack || dom.toastStack.dataset.anchored !== "minimap") return;
  dom.toastStack.style.top = "";
  dom.toastStack.style.right = "";
  dom.toastStack.dataset.anchored = "";
}

export function drawMinimap(rect, players) {
  if (!state.snapshot) {
    state.minimap = null;
    // No minimap on screen (menu/lobby/pre-match): let notifications fall back to
    // their default top-right anchor, where they may sit over the right panel.
    resetNotificationAnchor();
    return;
  }
  const w = Math.min(190, Math.max(142, rect.width * 0.19));
  const h = w * (state.world.height / state.world.width);
  const x = rect.width - w - 14;
  const y = 14;
  state.minimap = { x, y, w, h };
  anchorNotificationsBelowMinimap(x, y, w, h);

  ctx.save();
  ctx.fillStyle = "rgba(7,12,20,0.78)";
  ctx.strokeStyle = "rgba(174,199,231,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, { x, y, width: w, height: h, radius: 8 });
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  roundRect(ctx, { x, y, width: w, height: h, radius: 8 });
  ctx.clip();

  if (dom.showEndGameButton && !dom.showEndGameButton.hidden) {
    // Anchor the "Show Results" button just below the minimap (both are in the
    // arena-wrap coordinate space) so it never overlaps it.
    dom.showEndGameButton.style.top = `${Math.round(y + h + 14)}px`;
    dom.showEndGameButton.style.right = `14px`;
    dom.showEndGameButton.style.left = "auto";
    dom.showEndGameButton.style.bottom = "auto";
  }

  const sx = w / state.world.width;
  const sy = h / state.world.height;
  const snap = state.snapshot;
  const map = state.snapshot?.map || state.map;
  if (map) {
    const staticLayer = getMinimapStaticLayer(map, w, h, sx, sy);
    if (staticLayer) ctx.drawImage(staticLayer, x, y);
  }

  if (snap) {
    if (!players) players = playerMap();
    const myTeam = state.mine?.team;
    const isSolo = state.rules?.gameMode === "solo";

    for (const point of snap.points) {
      let relayColor = "rgba(220,230,245,0.42)"; // Neutral
      if (point.ownerTeam) {
        if (!isSolo && myTeam && point.ownerTeam === myTeam) {
          relayColor = "#38d7ff"; // Friendly team
        } else if (isSolo && point.ownerId === state.myId) {
          relayColor = "#38d7ff"; // Friendly player (us)
        } else {
          relayColor = "#ff3838"; // Enemy
        }
      }
      ctx.fillStyle = relayColor;
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.arc(x + point.x * sx, y + point.y * sy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const ship of snap.ships) {
      if (!ship.alive) continue;
      const player = players.get(ship.ownerId);
      
      let isFriendly = false;
      if (ship.ownerId === state.myId) {
        isFriendly = true;
      } else if (!isSolo && player && myTeam && player.team === myTeam) {
        isFriendly = true;
      }

      ctx.fillStyle = isFriendly ? "#38d7ff" : "#ff3838";
      ctx.beginPath();
      ctx.arc(x + ship.x * sx, y + ship.y * sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const rally = getRallyPoint();
    if (rally) {
      const rx = x + rally.x * sx;
      const ry = y + rally.y * sy;
      ctx.fillStyle = "#67e08a";
      ctx.strokeStyle = "rgba(4,8,14,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rx, ry, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
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

export function angleDifference(a, b) {
  let diff = b - a;
  while (diff < -Math.PI) diff += Math.PI * 2;
  while (diff > Math.PI) diff -= Math.PI * 2;
  return diff;
}

export function getWeaponTurnRate(weapon) {
  // Single source of truth shared with the server (src/server/combat.js): the
  // turret sprites must sweep at exactly the rate the server aims, otherwise
  // the visible barrel and the actual shot direction drift apart.
  return globalThis.TurretRules.turnRateFor(weapon);
}

export function approachAngle(current, target, maxDelta) {
  let diff = angleDifference(current, target);
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}


