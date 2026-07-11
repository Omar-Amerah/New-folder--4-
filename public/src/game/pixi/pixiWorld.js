// World-space statics and dynamics for the PixiJS arena renderer:
// grid, map features, relays, command target, bullets, effects, selection box.

import { state } from "../../state.js";
import { clamp } from "../../shared/math.js";
import { getCombatEffectsEnabled, getRenderQuality } from "../renderSettings.js";
import { isCircleVisible, getNebulaSprite, drawAsteroid, drawBulletVisual, activeEngineSmoke } from "../renderer.js";
import { pixiBakeTexture, registerPixiTextureCache, createPixiKeyedPool, getPixiBakeGeneration } from "./pixiBake.js";
import { getRallyPoint } from "../../ui/sidePanelUi.js";

const PIXI_BAKE_NOMINAL_ZOOM = 0.6;

let gridCache = { width: 0, height: 0, zoom: 0 };
let pixiMapStatics = null;
let pixiRelayPool = null;
let pixiBulletPool = null;
let pixiEffectTextPool = null;
let pixiEffectsGfx = null;

const pixiAsteroidTextureCache = registerPixiTextureCache(new Map());
const pixiNebulaTextureCache = registerPixiTextureCache(new Map());
const pixiBulletTextureCache = registerPixiTextureCache(new Map());

function updatePixiGrid(env) {
  const gfx = env.layers.grid;
  const zoom = state.camera.zoom;
  const worldW = state.world.width;
  const worldH = state.world.height;
  const zoomChanged = Math.abs(zoom - gridCache.zoom) / (gridCache.zoom || 1) > 0.02;
  if (gridCache.width === worldW && gridCache.height === worldH && !zoomChanged) return;
  gridCache = { width: worldW, height: worldH, zoom };

  gfx.clear();
  for (let x = 0; x <= worldW; x += 160) {
    gfx.moveTo(x, 0);
    gfx.lineTo(x, worldH);
  }
  for (let y = 0; y <= worldH; y += 160) {
    gfx.moveTo(0, y);
    gfx.lineTo(worldW, y);
  }
  gfx.stroke({ width: 1 / zoom, color: "rgba(130,160,205,0.11)" });
  gfx.rect(0, 0, worldW, worldH);
  gfx.stroke({ width: 3 / zoom, color: "rgba(255,255,255,0.22)" });
}

// --- Map features (safe zones, nebulas, asteroids) ---------------------------

function getPixiAsteroidTexture(env, asteroid) {
  let texture = pixiAsteroidTextureCache.get(asteroid);
  if (texture) return texture;
  const radius = asteroid.radius || 60;
  // Padding covers the 1.2x shape multiplier plus the baked drop shadow.
  const half = radius * 1.3 + 26;
  texture = pixiBakeTexture(env, half * 2, half * 2, () => {
    drawAsteroid({ ...asteroid, x: 0, y: 0, rotation: 0, spin: 0 }, 0);
  });
  pixiAsteroidTextureCache.set(asteroid, texture);
  return texture;
}

function getPixiNebulaTexture(env, cloud) {
  let entry = pixiNebulaTextureCache.get(cloud);
  if (entry) return entry;
  const sprite = getNebulaSprite(cloud);
  entry = { texture: env.PIXI.Texture.from(sprite.canvas), extent: sprite.extent };
  pixiNebulaTextureCache.set(cloud, entry);
  return entry;
}

function buildPixiSafeZones(env, gfx, zones) {
  gfx.clear();
  for (const zone of zones) {
    gfx.circle(zone.x, zone.y, zone.radius);
    gfx.fill(zone.color || "rgba(255,255,255,0.04)");
    // Dashed border (20/20 world units) approximated with arc segments.
    const dashCount = Math.max(8, Math.round((Math.PI * 2 * zone.radius) / 40));
    const dashAngle = (Math.PI * 2) / dashCount;
    for (let i = 0; i < dashCount; i += 1) {
      const start = i * dashAngle;
      // Seed the current point so arc() does not connect a stray line from (0,0).
      gfx.moveTo(zone.x + Math.cos(start) * zone.radius, zone.y + Math.sin(start) * zone.radius);
      gfx.arc(zone.x, zone.y, zone.radius, start, start + dashAngle * 0.5);
    }
    gfx.stroke({ width: 4, color: zone.color || "rgba(255,255,255,0.1)" });
  }
}

function updatePixiMapFeatures(env, now, bounds) {
  const map = state.snapshot?.map || state.map;
  const layer = env.layers.map;
  if (!pixiMapStatics) {
    const zonesGfx = new env.PIXI.Graphics();
    layer.addChild(zonesGfx);
    const featureLayer = new env.PIXI.Container();
    layer.addChild(featureLayer);
    pixiMapStatics = {
      map: null,
      zonesGfx,
      nebulaPool: createPixiKeyedPool(featureLayer, () => {
        const sprite = new env.PIXI.Sprite();
        sprite.anchor.set(0.5);
        return { root: sprite };
      }),
      asteroidPool: createPixiKeyedPool(featureLayer, () => {
        const sprite = new env.PIXI.Sprite();
        sprite.anchor.set(0.5);
        return { root: sprite };
      })
    };
  }
  if (pixiMapStatics.map !== map) {
    pixiMapStatics.map = map;
    buildPixiSafeZones(env, pixiMapStatics.zonesGfx, map?.safeZones || []);
  }

  pixiMapStatics.nebulaPool.frameStart();
  pixiMapStatics.asteroidPool.frameStart();
  if (map) {
    for (const cloud of map.clouds || []) {
      if (bounds && !isCircleVisible(cloud.x, cloud.y, Math.max(cloud.rx || 300, cloud.ry || 180), bounds)) continue;
      const view = pixiMapStatics.nebulaPool.acquire(cloud);
      const generation = getPixiBakeGeneration();
      if (view.fresh || view.generation !== generation) {
        view.generation = generation;
        const entry = getPixiNebulaTexture(env, cloud);
        view.root.texture = entry.texture;
        view.root.width = entry.extent * 2;
        view.root.height = entry.extent * 2;
        view.root.position.set(cloud.x, cloud.y);
        view.root.rotation = cloud.rotation || 0;
      }
    }
    for (const asteroid of map.asteroids || []) {
      if (state.debugStats) state.debugStats.totalAsteroids++;
      if (bounds && !isCircleVisible(asteroid.x, asteroid.y, asteroid.radius || 60, bounds)) continue;
      if (state.debugStats) state.debugStats.drawnAsteroids++;
      const view = pixiMapStatics.asteroidPool.acquire(asteroid);
      const generation = getPixiBakeGeneration();
      if (view.fresh || view.generation !== generation) {
        view.generation = generation;
        view.root.texture = getPixiAsteroidTexture(env, asteroid);
        view.root.scale.set(1 / env.bakeScale);
        view.root.position.set(asteroid.x, asteroid.y);
      }
      view.root.rotation = (asteroid.rotation || 0) + (asteroid.spin || 0) * now * 0.001;
    }
  }
  pixiMapStatics.nebulaPool.frameEnd();
  pixiMapStatics.asteroidPool.frameEnd();
}

// --- Relays -------------------------------------------------------------------

function createPixiRelayView(env) {
  const PIXI = env.PIXI;
  const root = new PIXI.Container();
  const gfx = new PIXI.Graphics();
  const badgeText = new PIXI.Text({ text: "", style: { fontFamily: "system-ui, sans-serif", fontSize: 18, fontWeight: "bold", fill: "#ffffff" }, resolution: 2 });
  badgeText.anchor.set(0.5);
  const ownerText = new PIXI.Text({ text: "", style: { fontFamily: "system-ui, sans-serif", fontSize: 13, fill: "#ccd5e0" }, resolution: 2 });
  ownerText.anchor.set(0.5);
  root.addChild(gfx);
  root.addChild(badgeText);
  root.addChild(ownerText);
  return { root, gfx, badgeText, ownerText, id: null, ownerLabel: null, ownerFill: null };
}

function updatePixiRelays(env, now, players, bounds) {
  if (!pixiRelayPool) pixiRelayPool = createPixiKeyedPool(env.layers.relays, () => createPixiRelayView(env));
  pixiRelayPool.frameStart();
  const snap = state.snapshot;
  const zoom = state.camera.zoom;
  if (snap && snap.points) {
    for (const point of snap.points) {
      if (bounds && !isCircleVisible(point.x, point.y, point.radius || 100, bounds)) continue;

      const owner = point.ownerId ? players.get(point.ownerId) : null;
      let color = "rgba(180,200,225,0.62)";
      const isSolo = state.rules?.gameMode === "solo";
      const myTeam = state.mine?.team;
      if (point.ownerTeam && !isSolo) {
        color = (myTeam && point.ownerTeam === myTeam) ? "#38d7ff" : "#ff3838";
      } else if (owner) {
        color = owner.color || color;
      }

      const view = pixiRelayPool.acquire(point.id);
      view.root.position.set(point.x, point.y);
      const gfx = view.gfx;
      gfx.clear();

      // Capture influence disc.
      gfx.circle(0, 0, point.radius);
      gfx.fill({ color, alpha: 0.12 });

      // Capture progress ring.
      const progress = point.progress || 0;
      if (progress > 0) {
        const start = -Math.PI / 2;
        // Seed the current point so arc() does not connect a stray line from the relay center.
        gfx.moveTo(Math.cos(start) * point.radius, Math.sin(start) * point.radius);
        gfx.arc(0, 0, point.radius, start, start + Math.PI * 2 * progress);
        gfx.stroke({ width: 3 / zoom, color, alpha: 0.76 });
      }

      // Rotating struts with node tips.
      const strutColor = owner ? color : "rgba(180,200,225,0.28)";
      for (let i = 0; i < 3; i++) {
        const angle = (i * Math.PI * 2) / 3 + now * 0.00015;
        gfx.moveTo(0, 0);
        gfx.lineTo(Math.cos(angle) * 36, Math.sin(angle) * 36);
        gfx.stroke({ width: 3.5 / zoom, color: strutColor, alpha: owner ? 0.4 : 1 });
        gfx.circle(Math.cos(angle) * 36, Math.sin(angle) * 36, 4);
        gfx.fill(color);
      }

      // Station hull + glowing core.
      gfx.circle(0, 0, 22);
      gfx.fill("rgba(13,18,30,0.95)");
      gfx.stroke({ width: 2.5 / zoom, color });
      gfx.circle(0, 0, 7);
      gfx.fill(color);

      // Letter badge above the station.
      const idLabelY = -46 / zoom;
      const badgeWidth = 38 / zoom;
      const badgeHeight = 28 / zoom;
      gfx.roundRect(-badgeWidth / 2, idLabelY - badgeHeight / 2, badgeWidth, badgeHeight, 6 / zoom);
      gfx.fill("rgba(8,12,20,0.78)");
      gfx.stroke({ width: 1.5 / zoom, color });

      if (view.id !== point.id) {
        view.id = point.id;
        view.badgeText.text = point.id;
      }
      const badgeFont = Math.max(14, 18 / zoom);
      view.badgeText.scale.set(badgeFont / 18);
      view.badgeText.position.set(0, idLabelY);

      // Owner label below the relay.
      const ownerLabel = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
      const ownerFill = owner ? color : "#ccd5e0";
      const labelY = point.radius + 18 / zoom;
      gfx.rect(-50, labelY - 9, 100, 18);
      gfx.fill("rgba(8,12,20,0.72)");
      if (view.ownerLabel !== ownerLabel) {
        view.ownerLabel = ownerLabel;
        view.ownerText.text = ownerLabel;
      }
      if (view.ownerFill !== ownerFill) {
        view.ownerFill = ownerFill;
        view.ownerText.style.fill = ownerFill;
      }
      const ownerFont = Math.max(10, 13 / zoom);
      view.ownerText.scale.set(ownerFont / 13);
      view.ownerText.position.set(0, labelY);
    }
  }
  pixiRelayPool.frameEnd();
}

// --- Command target -------------------------------------------------------------

function updatePixiCommandTarget(env, now) {
  const gfx = env.layers.command;
  gfx.clear();
  const rally = getRallyPoint();
  if (rally) {
    const pulse = (Math.sin(now * 0.004) + 1) * 0.5;
    const radius = 24 + pulse * 8;
    const zoom = state.camera.zoom;
    gfx.circle(rally.x, rally.y, radius);
    gfx.fill({ color: "#67e08a", alpha: 0.18 });
    gfx.stroke({ width: 2.5 / zoom, color: "#67e08a", alpha: 1 });
  }
  if (!state.command) return;
  const age = now - state.command.at;
  if (age > 1600) {
    state.command = null;
    return;
  }
  const alpha = 1 - age / 1600;
  const zoom = state.camera.zoom;
  const x = state.command.x;
  const y = state.command.y;
  const color = state.command.targetName ? "#ff5f7e" : "#ffca57";
  gfx.circle(x, y, 26 + age * 0.025);
  gfx.moveTo(x - 42, y);
  gfx.lineTo(x + 42, y);
  gfx.moveTo(x, y - 42);
  gfx.lineTo(x, y + 42);
  gfx.stroke({ width: 3 / zoom, color, alpha });
}

// --- Bullets ---------------------------------------------------------------------

function getPixiBulletTexture(env, bullet, color) {
  const isTracer = bullet.type !== "rail" && bullet.type !== "missile" && bullet.type !== "pdShot";
  const key = isTracer ? `tracer|${color}` : `${bullet.type}|${bullet.subtype || ""}`;
  let entry = pixiBulletTextureCache.get(key);
  if (entry) return entry;
  // Extents cover the largest art per type plus baked glow.
  let halfW = 24;
  let halfH = 12;
  if (bullet.type === "rail") { halfW = 48; halfH = 18; }
  else if (bullet.type === "missile") { halfW = 44; halfH = 20; }
  else if (bullet.type === "pdShot") { halfW = 18; halfH = 12; }
  const texture = pixiBakeTexture(env, halfW * 2, halfH * 2, () => {
    drawBulletVisual({ type: bullet.type, subtype: bullet.subtype }, color);
  });
  entry = { texture };
  pixiBulletTextureCache.set(key, entry);
  return entry;
}

function updatePixiBullets(env, players, bounds) {
  if (!pixiBulletPool) {
    pixiBulletPool = createPixiKeyedPool(env.layers.bullets, () => {
      const sprite = new env.PIXI.Sprite();
      sprite.anchor.set(0.5);
      return { root: sprite, textureKey: null };
    });
  }
  pixiBulletPool.frameStart();
  const snap = state.snapshot;
  if (snap && snap.bullets) {
    const now = performance.now();
    const elapsed = Math.min(0.15, (now - (state.snapshotReceivedAt || now)) / 1000);
    for (const bullet of snap.bullets) {
      if (state.debugStats) state.debugStats.totalBullets++;
      const renderX = bullet.x + bullet.vx * elapsed;
      const renderY = bullet.y + bullet.vy * elapsed;
      if (bounds && !isCircleVisible(renderX, renderY, 20, bounds)) continue;
      if (state.debugStats) state.debugStats.drawnBullets++;

      const owner = players.get(bullet.ownerId);
      const color = owner?.color || "#ffffff";
      const view = pixiBulletPool.acquire(bullet.id);
      const isTracer = bullet.type !== "rail" && bullet.type !== "missile" && bullet.type !== "pdShot";
      const textureKey = `${getPixiBakeGeneration()}|${isTracer ? `tracer|${color}` : `${bullet.type}|${bullet.subtype || ""}`}`;
      if (view.textureKey !== textureKey) {
        view.textureKey = textureKey;
        view.root.texture = getPixiBulletTexture(env, bullet, color).texture;
        view.root.scale.set(1 / env.bakeScale);
      }
      view.root.position.set(renderX, renderY);
      view.root.rotation = Math.atan2(bullet.vy, bullet.vx);
    }
  }
  pixiBulletPool.frameEnd();
}

// --- Effects ---------------------------------------------------------------------

function pixiEffectKey(effect) {
  return `${effect.type}|${effect.at ?? "?"}|${Math.round(effect.x)}|${Math.round(effect.y)}|${effect.x2 ?? ""}`;
}

function updatePixiEffects(env, now, bounds) {
  if (!pixiEffectsGfx) {
    pixiEffectsGfx = new env.PIXI.Graphics();
    env.layers.effects.addChild(pixiEffectsGfx);
  }
  if (!pixiEffectTextPool) {
    pixiEffectTextPool = createPixiKeyedPool(env.layers.effectText, () => {
      const text = new env.PIXI.Text({ text: "", style: { fontFamily: "monospace", fontSize: 16, fontWeight: "bold", fill: "#ff5f7e", stroke: { color: "rgba(0,0,0,0.8)", width: 3 } }, resolution: 2 });
      text.anchor.set(0.5);
      return { root: text };
    });
  }

  const gfx = pixiEffectsGfx;
  gfx.clear();
  pixiEffectTextPool.frameStart();

  const snap = state.snapshot;
  const combatEffectsEnabled = getCombatEffectsEnabled();
  const zoom = state.camera.zoom;
  if (snap && snap.effects) {
    if (state.debugStats) state.debugStats.totalEffects = snap.effects.length;
    let drawn = 0;
    for (const effect of snap.effects) {
      drawn++;
      const age = effect.age || 0;
      const t = clamp(age / 900, 0, 1);
      const alpha = 1 - t;
      const x = effect.x;
      const y = effect.y;

      if (effect.type === "beam") {
        const beamT = clamp(age / 120, 0, 1);
        const beamAlpha = 1 - beamT * 0.65;
        const x2 = effect.x2 || x;
        const y2 = effect.y2 || y;
        const radius = effect.radius || 24;
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: radius * 2, color: "rgba(14,165,233,0.18)", alpha: beamAlpha, cap: "round" });
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: Math.max(radius * 0.82, 7 / zoom), color: "rgba(125,211,252,0.68)", alpha: beamAlpha, cap: "round" });
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: Math.max(radius * 0.16, 1.7 / zoom), color: "rgba(240,253,255,0.95)", alpha: beamAlpha, cap: "round" });
      } else if (effect.type === "boom") {
        gfx.circle(x, y, 18 + t * 64);
        gfx.fill({ color: "#ffca57", alpha });
        gfx.circle(x, y, 34 + t * 84);
        gfx.stroke({ width: 5 / zoom, color: "#ff5f7e", alpha });
      } else if (effect.type === "repair") {
        gfx.circle(x, y, 16 + t * 28);
        gfx.stroke({ width: 3 / zoom, color: "#67e08a", alpha });
      } else if (effect.type === "railhit") {
        gfx.moveTo(x - 24 - t * 24, y);
        gfx.lineTo(x + 24 + t * 24, y);
        gfx.moveTo(x, y - 24 - t * 24);
        gfx.lineTo(x, y + 24 + t * 24);
        gfx.stroke({ width: 3 / zoom, color: "#f4f7ff", alpha });
      } else if (effect.type === "shieldhit") {
        // Impact flash on the shield surface: a hexagonal facet ripple bulging
        // outward along the impact normal, plus a bright core spark.
        const st = clamp(age / 300, 0, 1);
        const sAlpha = 1 - st;
        const nx = effect.nx || 0;
        const ny = effect.ny || 0;
        const tx = -ny;
        const ty = nx;
        const spread = 12 + st * 24;
        const bulge = 7 + st * 7;
        const p1x = x + tx * spread;
        const p1y = y + ty * spread;
        const p2x = x - tx * spread;
        const p2y = y - ty * spread;
        const outX = x + nx * bulge;
        const outY = y + ny * bulge;
        const inX = x - nx * bulge * 0.55;
        const inY = y - ny * bulge * 0.55;
        gfx.moveTo(p1x, p1y);
        gfx.quadraticCurveTo(outX, outY, p2x, p2y);
        gfx.quadraticCurveTo(inX, inY, p1x, p1y);
        gfx.fill({ color: "#7fe9ff", alpha: sAlpha * 0.26 });
        gfx.stroke({ width: 2 / zoom, color: "#dffaff", alpha: sAlpha * 0.85 });
        gfx.circle(x, y, 3 + st * 5);
        gfx.fill({ color: "#eafcff", alpha: sAlpha });
        gfx.moveTo(x, y);
        gfx.lineTo(x + nx * (9 + st * 15), y + ny * (9 + st * 15));
        gfx.stroke({ width: 1.6 / zoom, color: "#bfefff", alpha: sAlpha * 0.65 });
      } else if (effect.type === "destructcharge") {
        // Warning sparks pulsing off a ship while it charges its self-destruct.
        const ct = clamp(age / 300, 0, 1);
        const ca = 1 - ct;
        const rr = effect.radius || 26;
        gfx.circle(x, y, rr * (0.5 + ct * 1.0));
        gfx.stroke({ width: 2.5 / zoom, color: "#ff7b3c", alpha: ca * 0.8 });
        gfx.circle(x, y, 2 + ct * 3);
        gfx.fill({ color: "#ffd7a8", alpha: ca });
      } else if (effect.type === "selfdestruct") {
        // Detonation shockwave (paired with a regular boom).
        const rr = effect.radius || 26;
        gfx.circle(x, y, rr * (0.6 + t * 3.4));
        gfx.stroke({ width: 6 / zoom, color: "#ffcaa0", alpha });
        gfx.circle(x, y, rr * (0.4 + t * 2.1));
        gfx.stroke({ width: 3 / zoom, color: "#fff2e0", alpha });
      } else if (effect.type === "rockhit") {
        gfx.circle(x, y, 5 + t * 18);
        gfx.fill({ color: "rgba(196,174,142,0.82)", alpha });
        gfx.moveTo(x - 10 - t * 12, y - 4);
        gfx.lineTo(x + 8 + t * 18, y + 5);
        gfx.stroke({ width: 2 / zoom, color: "rgba(255,226,175,0.72)", alpha });
      } else if (effect.type === "dmg" || effect.type === "text") {
        if (combatEffectsEnabled) {
          const view = pixiEffectTextPool.acquire(pixiEffectKey(effect));
          const label = effect.type === "dmg" ? Math.round(effect.amount).toString() : String(effect.text || "");
          if (view.root.text !== label) view.root.text = label;
          const fill = effect.type === "dmg" ? (effect.isShield ? "#7dd3fc" : "#ff5f7e") : "#e2e8f0";
          if (view.root.style.fill !== fill) view.root.style.fill = fill;
          const fontSize = effect.type === "dmg" ? Math.max(12, 16 / zoom) : Math.max(10, 14 / zoom);
          view.root.scale.set(fontSize / 16);
          view.root.position.set(x, y - t * 30);
          view.root.alpha = alpha;
        }
      } else if (effect.type === "burst") {
        gfx.circle(x, y, 12 + t * 40);
        gfx.fill({ color: "#ffca57", alpha });
        gfx.circle(x, y, 20 + t * 50);
        gfx.stroke({ width: 4 / zoom, color: "#ff9a57", alpha });
      } else if (effect.type === "spark") {
        gfx.circle(x, y, 6 + t * 12);
        gfx.fill({ color: "#f3f7ff", alpha });
        gfx.moveTo(x - 8 - t * 16, y);
        gfx.lineTo(x + 8 + t * 16, y);
        gfx.moveTo(x, y - 8 - t * 16);
        gfx.lineTo(x, y + 8 + t * 16);
        gfx.stroke({ width: 2 / zoom, color: "#a5c2ff", alpha });
      } else if (effect.type === "despawn") {
        const q = getRenderQuality();
        if (q === "low") {
          gfx.circle(x, y, 4 + t * 8);
          gfx.fill({ color: "#ffca57", alpha });
        } else {
          const subtype = effect.subtype || "missile";
          if (subtype === "interceptorPod") {
            gfx.circle(x, y, 3 + t * 12);
            gfx.fill({ color: "#e9d5ff", alpha });
            gfx.moveTo(x - 6 - t * 12, y);
            gfx.lineTo(x + 6 + t * 12, y);
            gfx.moveTo(x, y - 6 - t * 12);
            gfx.lineTo(x, y + 6 + t * 12);
            gfx.stroke({ width: 2 / zoom, color: "#a855f7", alpha });
          } else if (subtype === "flakCannon") {
            gfx.circle(x, y, 4 + t * 14);
            gfx.fill({ color: "#f97316", alpha });
            gfx.circle(x, y, 6 + t * 18);
            gfx.stroke({ width: 2 / zoom, color: "#fdba74", alpha });
          } else if (subtype === "swarmMissile") {
            gfx.circle(x, y, 2 + t * 6);
            gfx.fill({ color: "#c084fc", alpha });
          } else if (subtype === "torpedo") {
            gfx.circle(x, y, 8 + t * 24);
            gfx.fill({ color: "#ff7e5f", alpha });
            gfx.circle(x, y, 12 + t * 30);
            gfx.stroke({ width: 3 / zoom, color: "#ff9a57", alpha });
          } else {
            gfx.circle(x, y, 4 + t * 12);
            gfx.fill({ color: "#ffca57", alpha });
            gfx.circle(x, y, 6 + t * 16);
            gfx.stroke({ width: 2 / zoom, color: "#ff9a57", alpha });
          }
        }
      } else {
        gfx.circle(x, y, 8 + t * 32);
        gfx.fill({ color: effect.type === "warp" ? "#38d5ff" : "#f3f7ff", alpha });
      }
    }
    if (state.debugStats) state.debugStats.drawnEffects = drawn;
  }

  pixiEffectTextPool.frameEnd();
}

// --- Selection box ---------------------------------------------------------------

function updatePixiEngineSmoke(env, now, bounds) {
  const gfx = env.layers.engineSmoke;
  if (!gfx) return;
  gfx.clear();
  const particles = activeEngineSmoke(now);
  for (const p of particles) {
    if (bounds && !isCircleVisible(p.x, p.y, p.radius, bounds)) continue;
    gfx.circle(p.x, p.y, p.radius);
    gfx.fill({ color: "#7f8f88", alpha: p.alpha });
  }
}

function updatePixiSelectionBox(env) {
  if (!state.drag) return;
  const a = state.drag.startWorld;
  const b = state.drag.currentWorld;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const width = Math.abs(a.x - b.x);
  const height = Math.abs(a.y - b.y);
  if (width < 12 && height < 12) return;
  const gfx = env.layers.overlay;
  gfx.rect(x, y, width, height);
  gfx.fill("rgba(56,213,255,0.08)");
  gfx.stroke({ width: 2 / state.camera.zoom, color: "rgba(56,213,255,0.82)" });
}

export function updatePixiWorld(env, now, players, bounds, rect) {
  updatePixiGrid(env);
  updatePixiMapFeatures(env, now, bounds);
  updatePixiRelays(env, now, players, bounds);
  updatePixiCommandTarget(env, now);
  updatePixiEngineSmoke(env, now, bounds);
  updatePixiBullets(env, players, bounds);
  updatePixiEffects(env, now, bounds);
  updatePixiSelectionBox(env);
}
