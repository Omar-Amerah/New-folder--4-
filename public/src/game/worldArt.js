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
import { playerMap } from "../ui/matchStatusUi.js";

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
export function isFriendlyProjectile(bullet, players) {
  if (!bullet) return false;
  if (bullet.ownerId === state.myId) return true;
  if (!players) players = playerMap();
  const mine = state.mine || players.get(state.myId);
  const owner = players.get(bullet.ownerId);
  return Boolean(mine?.team && owner?.team && mine.team === owner.team);
}

// Ballistic bolt sizes, deliberately spread by weapon weight so a shot can be
// read at a glance without reading its colour (bolts wear the owner's team
// colour, so colour is not available to tell weapons apart). Ordering matters
// more than the absolute numbers: pellet < autocannon < blaster < shell.
const BOLT_ART = {
  scatterCannon: { length: 7, halfHeight: 1.5, glow: 7, nose: 2 },
  autocannon: { length: 11, halfHeight: 1.9, glow: 9, nose: 3 },
  blaster: { length: 16, halfHeight: 2.4, glow: 12, nose: 5 },
  default: { length: 14, halfHeight: 2, glow: 12, nose: 5 }
};

// A capsule tracer with a white-hot nose: the shared shape for every plain
// ballistic bolt. Only the dimensions change between weapons.
function drawTracerBolt(color, art) {
  const { length, halfHeight, glow, nose } = art;
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = qualityShadowBlur(glow);
  roundRect(ctx, { x: -length * 0.6, y: -halfHeight, width: length, height: halfHeight * 2, radius: halfHeight });
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  roundRect(ctx, {
    x: length * 0.4 - nose,
    y: -halfHeight * 0.6,
    width: nose,
    height: halfHeight * 1.2,
    radius: halfHeight * 0.6
  });
  ctx.fill();
}

// Half-extents of the baked texture for a projectile, art plus its glow. Lives
// next to the drawing code so a bigger shell cannot silently clip its own bake.
export function bulletArtExtent(bullet) {
  if (bullet?.type === "rail") {
    return bullet.subtype === "spinalAccelerator" ? { halfW: 88, halfH: 28 } : { halfW: 62, halfH: 22 };
  }
  if (bullet?.type === "emp") return { halfW: 34, halfH: 28 };
  if (bullet?.type === "missile") return { halfW: 44, halfH: 20 };
  if (bullet?.type === "pdShot") return { halfW: 18, halfH: 12 };
  return { halfW: 26, halfH: 16 };
}

// Draws a bullet's art around the origin (translation/rotation already applied
// by the caller). Used by the Pixi renderer to bake per-type projectile
// textures into the shared offscreen ctx. Sizes are constant world units : the
// art is baked once, so nothing here may depend on the live camera zoom.
export function drawBulletVisual(bullet, color) {
  if (bullet.type === "rail") {
    if (bullet.subtype === "spinalAccelerator") {
      // The heaviest gun in the game: a long white-hot lance inside a wider
      // blue envelope, roughly twice the railgun's reach on screen.
      ctx.lineCap = "round";
      ctx.strokeStyle = "#7fb2ff";
      ctx.shadowColor = "#93c5fd";
      ctx.shadowBlur = qualityShadowBlur(30);
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(-54, 0);
      ctx.lineTo(46, 0);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-40, 0);
      ctx.lineTo(48, 0);
      ctx.stroke();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-44, -6.5);
      ctx.lineTo(30, -6.5);
      ctx.moveTo(-44, 6.5);
      ctx.lineTo(30, 6.5);
      ctx.stroke();
    } else {
      ctx.strokeStyle = "#eaf6ff";
      ctx.shadowColor = "#9fdcff";
      ctx.shadowBlur = qualityShadowBlur(24);
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(-34, 0);
      ctx.lineTo(24, 0);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#64a8ff";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-18, -3);
      ctx.lineTo(18, -3);
      ctx.moveTo(-18, 3);
      ctx.lineTo(18, 3);
      ctx.stroke();
    }
  } else if (bullet.type === "missile") {
    if (bullet.subtype === "swarmMissile") {
      ctx.shadowColor = "#5eead4";
      ctx.shadowBlur = qualityShadowBlur(12);
      ctx.fillStyle = "#ccfbf1";
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-4, -2.5);
      ctx.lineTo(-7, 0);
      ctx.lineTo(-4, 2.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#14b8a6";
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
      ctx.shadowColor = "#fbbf24";
      ctx.shadowBlur = qualityShadowBlur(18);
      ctx.fillStyle = "#fef3c7";
      ctx.beginPath();
      ctx.moveTo(13, 0);
      ctx.lineTo(-7, -5);
      ctx.lineTo(-12, 0);
      ctx.lineTo(-7, 5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(-8, -3, 8, 6);
      ctx.fillStyle = "rgba(255, 111, 64, 0.85)";
      ctx.beginPath();
      ctx.moveTo(-12, -3);
      ctx.lineTo(-22, 0);
      ctx.lineTo(-12, 3);
      ctx.closePath();
      ctx.fill();
    }
  } else if (bullet.type === "flak") {
    // Small proximity-fused shell: dark casing with a bright fuse tip, so a
    // curtain of flak never reads as friendly-coloured gunfire.
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(9);
    ctx.fillStyle = color;
    roundRect(ctx, { x: -6, y: -2.6, width: 9, height: 5.2, radius: 2.6 });
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(10, 14, 22, 0.5)";
    ctx.fillRect(-3.4, -2.6, 1.8, 5.2);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(1.4, 0, 1.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (bullet.type === "pdShot") {
    if (bullet.subtype === "interceptorPod") {
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
  } else if (bullet.type === "emp") {
    // A wide magenta containment pulse: pale core, luminous outer ring, and
    // broken arcs make the shot read as a field event rather than an explosion.
    // Fuchsia rather than cyan so the shot belongs to the EMP Cannon's own
    // colour (parts.js empCannon) instead of the cyan engine/sensor family.
    ctx.shadowColor = "#e879f9";
    ctx.shadowBlur = qualityShadowBlur(24);
    ctx.fillStyle = "#d946ef";
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "#e879f9";
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, 12, -Math.PI * 0.88, -Math.PI * 0.08);
    ctx.arc(0, 0, 12, Math.PI * 0.12, Math.PI * 0.92);
    ctx.stroke();
    ctx.strokeStyle = "#fae8ff";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, 5.2, -Math.PI * 0.55, Math.PI * 0.55);
    ctx.stroke();
    ctx.fillStyle = "#fdf4ff";
    ctx.beginPath();
    ctx.arc(2, 0, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(217,70,239,0.7)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.lineTo(-24, 0);
    ctx.stroke();
  } else if (bullet.subtype === "plasmaCannon") {
    // Slow, heavy and unmistakable: a glowing orb with a short trailing wisp.
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(18);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, 5.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(-3.5, -3.6);
    ctx.lineTo(-13, 0);
    ctx.lineTo(-3.5, 3.6);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.beginPath();
    ctx.arc(0.8, 0, 2.4, 0, Math.PI * 2);
    ctx.fill();
  } else if (bullet.subtype === "fragmentationCannon") {
    // The bulkiest bolt: a stubby high-explosive shell, wide rather than long,
    // with a dark casing band that sets it apart from a plain tracer.
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(13);
    ctx.fillStyle = color;
    roundRect(ctx, { x: -9, y: -3.8, width: 15, height: 7.6, radius: 3.4 });
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "rgba(12, 16, 24, 0.45)";
    ctx.fillRect(-4.6, -3.8, 2.4, 7.6);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    roundRect(ctx, { x: 1.4, y: -2.2, width: 4.6, height: 4.4, radius: 2.2 });
    ctx.fill();
  } else {
    drawTracerBolt(color, BOLT_ART[bullet.subtype] || BOLT_ART.default);
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
    if (zone.borderColor) {
      mini.strokeStyle = zone.borderColor;
      mini.lineWidth = 1.5;
      mini.beginPath();
      mini.arc(zone.x * sx, zone.y * sy, zone.radius * sx, 0, Math.PI * 2);
      mini.stroke();
    }
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
