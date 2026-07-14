// Renders background stars, nebulas, obstacles, weapon beams, and ship components to the arena canvas.

import { dom, ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp, angleDifference, approachAngle } from "../shared/math.js";
import { PART_DEFS, PART_STATS, isRotatablePart } from "../design/parts.js";
import { moduleRotationToRadians, normalizeRotation } from "../design/rotation.js";
import { moduleLocalPosition, footprintLocalPlacement, shipEngineNozzles } from "./shipGeometry.js";
import { componentHealthRatio, shieldRatioForShip, shieldRingRadius, hullColorForRatio } from "./shipVitals.js";
import { getWeaponTurnRate, defaultWeaponRelativeAngle } from "./weaponAim.js";
import {
  maxSpeedForRenderedShip,
  engineThrustRatio,
  aliveEngineNozzles,
  emitEngineSmoke,
  activeEngineSmoke,
  computeManeuverJets,
  updateShipHud
} from "./shipDynamics.js";
import {
  roundRect,
  drawModule,
  drawFootprintComponent,
  drawShipStructure,
  drawStructureLines,
  drawStaticComponentBase,
  drawStaticWeaponMount,
  drawRotatingWeaponTop,
  drawWeaponBase,
  drawRoundSystem
} from "./componentArt.js";
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
  drawBullets(players, bounds, false);
  drawShips(players, bounds);
  drawBullets(players, bounds, true);
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

export function isFriendlyProjectile(bullet, players) {
  if (!bullet) return false;
  if (bullet.ownerId === state.myId) return true;
  if (!players) players = playerMap();
  const mine = state.mine || players.get(state.myId);
  const owner = players.get(bullet.ownerId);
  return Boolean(mine?.team && owner?.team && mine.team === owner.team);
}

export function drawBullets(players, bounds, friendlyLayer = null) {
  const snap = state.snapshot;
  if (!snap) return;
  if (!players) players = playerMap(); // fallback

  const now = performance.now();
  const elapsed = Math.min(0.15, (now - (state.snapshotReceivedAt || now)) / 1000);

  for (const bullet of snap.bullets) {
    if (state.debugStats && friendlyLayer !== true) state.debugStats.totalBullets++;

    const { x: renderX, y: renderY } = bulletRenderPosition(bullet, elapsed);

    if (bounds && !isCircleVisible(renderX, renderY, 20, bounds)) continue;

    const friendly = isFriendlyProjectile(bullet, players);
    if (friendlyLayer !== null && friendly !== friendlyLayer) continue;

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
      const targetRelative = serverAngles[i] !== undefined ? serverAngles[i] : defaultWeaponRelativeAngle(part);

      const turnRate = weaponStat ? getWeaponTurnRate(weaponStat) : 3.0;
      // Destroyed turrets stop tracking and freeze in place.
      if (!destroyed) visualAngles[i] = approachAngle(visualAngles[i], targetRelative, turnRate * dt);

      if (weaponStat) {
        // The occupied block and weapon socket belong to the hull and must
        // never rotate while a turret tracks. Paint them at their blueprint
        // orientation, then put only the rotating weapon top on the live
        // aiming angle (explicit static/dynamic split in componentArt.js).
        ctx.save();
        if (place.multi) ctx.rotate(place.longAxisAngle);
        drawStaticComponentBase({ type: part.type, unit: scale, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color, trim: player.color });
        drawStaticWeaponMount({ type: part.type, unit: scale, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color });
        drawModuleDamage(ctx, healthRatio, place.multi ? halfLong : halfCell, place.multi ? halfCross : halfCell, nowMs);
        drawModuleFlash(ctx, flash, place.multi ? halfLong : halfCell, place.multi ? halfCross : halfCell);
        ctx.restore();
        ctx.rotate(visualAngles[i]);
        drawRotatingWeaponTop({ type: part.type, unit: scale, tilesLong: place.tilesLong, tilesCross: place.tilesCross, color: def.color });
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


// --- Compatibility re-exports ---------------------------------------------------
// Ship presentation math and component artwork moved to renderer-neutral
// modules (shipGeometry/shipVitals/weaponAim, shared/math) and the artwork
// module (componentArt). These re-exports keep older importers working; new
// code should import from the owning module directly.
export { moduleLocalPosition, footprintLocalPlacement, shipEngineNozzles };
export { componentHealthRatio, shieldRatioForShip, shieldRingRadius, hullColorForRatio };
export { getWeaponTurnRate, approachAngle, angleDifference };
export { drawModule, drawFootprintComponent, drawShipStructure, drawStructureLines, drawWeaponBase, drawRoundSystem };
export { maxSpeedForRenderedShip, engineThrustRatio, aliveEngineNozzles, emitEngineSmoke, activeEngineSmoke, computeManeuverJets, updateShipHud };
