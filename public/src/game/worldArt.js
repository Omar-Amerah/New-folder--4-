// Offscreen Canvas artwork and presentation helpers for world objects
// (nebulas, asteroids, projectiles, minimap statics). The Pixi arena renderer
// bakes these into GPU textures via withCanvasContext; there is no Canvas arena
// loop. Drawing routines paint into the shared 2D `ctx` (pointed at an offscreen
// bake surface by the caller); the sprite/minimap helpers create their own
// offscreen canvases.

import { ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { qualityShadowBlur } from "./renderSettings.js";
import { roundRect } from "./componentArt.js";
import { playerMap } from "../ui/scoreboardUi.js";

// --- Nebula sprite (own offscreen canvas) ------------------------------------
// Nebulas are static but cost several radial gradients to draw. Each cloud is
// pre-rendered once into an offscreen canvas keyed by the cloud object.
const nebulaSpriteCache = new WeakMap();
const NEBULA_SPRITE_SCALE = 0.5;

export function getNebulaSprite(cloud) {
  let sprite = nebulaSpriteCache.get(cloud);
  if (sprite) return sprite;

  const rx = cloud.rx || 300;
  const ry = cloud.ry || 180;
  const color = cloud.color || "56,213,255";
  const alpha = cloud.alpha || 0.12;

  const extent = Math.max(rx, ry) * 0.5 + Math.min(rx, ry) * 1.2;
  const size = Math.max(2, Math.ceil(extent * 2 * NEBULA_SPRITE_SCALE));
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const spriteCtx = canvas.getContext("2d");
  spriteCtx.translate(size / 2, size / 2);
  spriteCtx.scale(NEBULA_SPRITE_SCALE, NEBULA_SPRITE_SCALE);

  // Seeded pseudo-random for consistent blob placement inside the nebula.
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

// --- Asteroid art (bakes into the shared ctx) --------------------------------
function getAsteroidGradient(radius, shade) {
  // CanvasGradient instances are bound to the CanvasRenderingContext2D that
  // created them. Pixi texture baking points the shared ctx at a fresh offscreen
  // canvas per texture, so reusing a gradient from a previous bake can throw on
  // the first active map frame and leave the WebGL canvas black.
  const base = shade === "warm" ? "#5a4939" : "#394657";
  const edge = shade === "warm" ? "#ad8b64" : "#8495aa";
  const gradient = ctx.createLinearGradient(-radius, -radius, radius, radius);
  gradient.addColorStop(0, edge);
  gradient.addColorStop(0.38, base);
  gradient.addColorStop(1, "#171d26");
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

// --- Projectile presentation helpers -----------------------------------------
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

// Draws a bullet's art around the origin (translation/rotation already applied
// by the caller). Used by the Pixi renderer to bake per-type projectile
// textures into the shared offscreen ctx.
export function drawBulletVisual(bullet, color) {
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

// --- Minimap static layer (own offscreen canvas) -----------------------------
// The minimap's map features (zones, clouds, asteroids) never move; render them
// once per (map, size) combination instead of dozens of arc fills per frame.
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
