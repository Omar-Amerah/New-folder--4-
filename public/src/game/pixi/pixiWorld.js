// World-space statics and dynamics for the PixiJS arena renderer:
// grid, map features, relays, command target, bullets, effects, selection box.

import { state } from "../../state.js";
import { clamp } from "../../shared/math.js";
import { INTERPOLATION_DELAY_MS } from "../renderInterpolation.js";
import { projectBallisticProjectile } from "../projectileTimeline.js";
import { getCombatEffectsEnabled, getRenderQuality } from "../renderSettings.js";
import { isCircleVisible, cullVisual } from "../viewportCulling.js";
import { getNebulaSprite, drawAsteroid, drawBulletVisual, isFriendlyProjectile } from "../worldArt.js";
import { playerMap } from "../../ui/matchStatusUi.js";
import { activeEngineSmoke } from "../shipDynamics.js";
import { pixiBakeTexture, createPixiKeyedPool, createPixiTextureCache, getPixiBakeGeneration, swapTextureLease } from "./pixiBake.js";
import { getRallyPoint } from "../../ui/sidePanelUi.js";
import { invalidatePresentation } from "../../presentationInvalidation.js";
import { updatePixiContacts } from "./pixiSensorContacts.js";
import { updatePixiFog } from "./pixiFog.js";

const LINE_EFFECT_TYPES = new Set(["beam", "repairbeam", "laserPdPulse", "laserpd", "droneshot", "dronerepair"]);

const projectilePresentationById = new Map();
let lastProjectileSnapshotSeq = -1;

let gridCache = { width: 0, height: 0, zoom: 0 };
let pixiMapStatics = null;
let pixiRelayPool = null;
let pixiEnemyBulletPool = null;
let pixiFriendlyBulletPool = null;
let pixiEffectTextPool = null;
let pixiEffectsGfx = null;
let lastProjectileClockWarningKey = null;

// Reference-counted texture caches. World object views hold LEASES only; the
// cache owns destruction (see pixiBake.js).
const asteroidTextureCache = createPixiTextureCache("asteroid");
const nebulaTextureCache = createPixiTextureCache("nebula");
const bulletTextureCache = createPixiTextureCache("bullet");

// Stable string ids for map objects (asteroids/clouds) so their per-object
// textures can be keyed in the string-keyed lease caches.
const worldObjectIds = new WeakMap();
let worldObjectIdSeq = 0;
function worldObjectId(obj) {
  let id = worldObjectIds.get(obj);
  if (id === undefined) {
    id = ++worldObjectIdSeq;
    worldObjectIds.set(obj, id);
  }
  return id;
}

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

function acquireAsteroidLease(env, asteroid) {
  const radius = asteroid.radius || 60;
  // Padding covers the 1.2x shape multiplier plus the baked drop shadow.
  const half = radius * 1.3 + 26;
  const key = `${worldObjectId(asteroid)}|${env.bakeScale}|${getPixiBakeGeneration()}`;
  return asteroidTextureCache.acquire(key, () => pixiBakeTexture(env, half * 2, half * 2, () => {
    drawAsteroid({ ...asteroid, x: 0, y: 0, rotation: 0, spin: 0 }, 0);
  }));
}

function acquireNebulaLease(env, cloud) {
  const sprite = getNebulaSprite(cloud);
  const key = `${worldObjectId(cloud)}|${env.bakeScale}|${getPixiBakeGeneration()}`;
  const lease = nebulaTextureCache.acquire(key, () => env.PIXI.Texture.from(sprite.canvas));
  return { lease, extent: sprite.extent };
}

// A pooled world-object view that owns a single texture lease and releases it
// on recycle / pool destruction.
function makeLeasedSpriteView(env) {
  const sprite = new env.PIXI.Sprite(env.PIXI.Texture.EMPTY);
  sprite.anchor.set(0.5);
  return {
    root: sprite,
    lease: null,
    textureKey: null,
    release() {
      this.root.texture = env.PIXI.Texture.EMPTY;
      if (this.lease) {
        this.lease.release();
        this.lease = null;
      }
      this.textureKey = null;
    }
  };
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
    gfx.stroke({ width: 4, color: zone.borderColor || zone.color || "rgba(255,255,255,0.1)" });
  }
}

function updatePixiMapFeatures(env, now, bounds) {
  const map = state.snapshot?.map || state.map;
  const layer = env.layers.map;
  if (!pixiMapStatics) {
    const zonesGfx = new env.PIXI.Graphics();
    layer.addChild(zonesGfx);
    const featureLayer = new env.PIXI.Container();
    const nebulaLayer = new env.PIXI.Container();
    const asteroidLayer = new env.PIXI.Container();
    featureLayer.addChild(nebulaLayer);
    featureLayer.addChild(asteroidLayer);
    layer.addChild(featureLayer);
    pixiMapStatics = {
      map: null,
      zonesGfx,
      featureLayer,
      nebulaLayer,
      asteroidLayer,
      nebulaPool: createPixiKeyedPool(nebulaLayer, () => makeLeasedSpriteView(env)),
      asteroidPool: createPixiKeyedPool(asteroidLayer, () => makeLeasedSpriteView(env))
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
      const key = `${worldObjectId(cloud)}|${env.bakeScale}|${getPixiBakeGeneration()}`;
      if (view.textureKey !== key) {
        const { lease, extent } = acquireNebulaLease(env, cloud);
        swapTextureLease(view, lease, key, (texture) => {
          view.root.texture = texture;
          view.root.width = extent * 2;
          view.root.height = extent * 2;
          view.root.position.set(cloud.x, cloud.y);
          view.root.rotation = cloud.rotation || 0;
        });
      }
    }
    for (const asteroid of map.asteroids || []) {
      if (state.debugStats) state.debugStats.totalAsteroids++;
      if (bounds && !isCircleVisible(asteroid.x, asteroid.y, asteroid.radius || 60, bounds)) continue;
      if (state.debugStats) state.debugStats.drawnAsteroids++;
      const view = pixiMapStatics.asteroidPool.acquire(asteroid);
      const key = `${worldObjectId(asteroid)}|${env.bakeScale}|${getPixiBakeGeneration()}`;
      if (view.textureKey !== key) {
        const lease = acquireAsteroidLease(env, asteroid);
        swapTextureLease(view, lease, key, (texture) => {
          view.root.texture = texture;
          view.root.scale.set(1 / env.bakeScale);
          view.root.position.set(asteroid.x, asteroid.y);
        });
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
  const staticGfx = new PIXI.Graphics();
  const captureGfx = new PIXI.Graphics();
  const strutGfx = new PIXI.Graphics();
  const badgeText = new PIXI.Text({ text: "", style: { fontFamily: "system-ui, sans-serif", fontSize: 18, fontWeight: "bold", fill: "#ffffff" }, resolution: 2 });
  badgeText.anchor.set(0.5);
  const ownerText = new PIXI.Text({ text: "", style: { fontFamily: "system-ui, sans-serif", fontSize: 13, fill: "#ccd5e0" }, resolution: 2 });
  ownerText.anchor.set(0.5);
  root.addChild(captureGfx);
  root.addChild(strutGfx);
  root.addChild(staticGfx);
  root.addChild(badgeText);
  root.addChild(ownerText);
  return {
    root, staticGfx, captureGfx, strutGfx, badgeText, ownerText,
    id: null, ownerLabel: null, ownerFill: null,
    staticSignature: "", captureSignature: "", strutSignature: ""
  };
}

function updatePixiRelays(env, now, players, bounds) {
  if (!pixiRelayPool) pixiRelayPool = createPixiKeyedPool(env.layers.relays, () => createPixiRelayView(env));
  pixiRelayPool.frameStart();
  const snap = state.snapshot;
  const zoom = state.camera.zoom;
  // In station mode a relay is a real structure and the station renderer draws
  // its body, its capture ring (at the authoritative capture radius, which is
  // NOT the map point's radius) and its ownership label. Drawing the abstract
  // objective marker on top of it stacked two bodies, two rings of different
  // sizes and two owner labels on the same coordinates, so here only the ID
  // badge survives — the one thing the objective HUD refers to by name.
  const stationMode = Array.isArray(snap?.stations) && snap.stations.length > 0;
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
      const progress = point.progress || 0;
      const strutColor = owner ? color : "rgba(180,200,225,0.28)";
      // The badge clears the structure in station mode instead of sitting on it.
      const idLabelY = stationMode ? -(140 + 26 / zoom) : -46 / zoom;
      const badgeWidth = 38 / zoom;
      const badgeHeight = 28 / zoom;
      const zoomKey = zoom.toFixed(3);
      const staticSignature = `${zoomKey}|${color}|${stationMode ? 1 : 0}`;
      if (view.staticSignature !== staticSignature) {
        view.staticSignature = staticSignature;
        const gfx = view.staticGfx;
        gfx.clear();
        if (!stationMode) {
          gfx.circle(0, 0, 22);
          gfx.fill("rgba(13,18,30,0.95)");
          gfx.stroke({ width: 2.5 / zoom, color });
          gfx.circle(0, 0, 7);
          gfx.fill(color);
        }
        gfx.roundRect(-badgeWidth / 2, idLabelY - badgeHeight / 2, badgeWidth, badgeHeight, 6 / zoom);
        gfx.fill("rgba(8,12,20,0.78)");
        gfx.stroke({ width: 1.5 / zoom, color });
      }

      const strutSignature = `${zoomKey}|${strutColor}|${color}|${owner ? 1 : 0}|${stationMode ? 1 : 0}`;
      if (view.strutSignature !== strutSignature) {
        view.strutSignature = strutSignature;
        const gfx = view.strutGfx;
        gfx.clear();
        for (let i = 0; !stationMode && i < 3; i++) {
          const angle = (i * Math.PI * 2) / 3;
          gfx.moveTo(0, 0);
          gfx.lineTo(Math.cos(angle) * 36, Math.sin(angle) * 36);
          gfx.stroke({ width: 3.5 / zoom, color: strutColor, alpha: owner ? 0.4 : 1 });
          gfx.circle(Math.cos(angle) * 36, Math.sin(angle) * 36, 4);
          gfx.fill(color);
        }
      }
      view.strutGfx.rotation = now * 0.00015;

      if (view.id !== point.id) {
        view.id = point.id;
        view.badgeText.text = point.id;
      }
      const badgeFont = Math.max(14, 18 / zoom);
      const badgeScale = badgeFont / 18;
      if (view.badgeText.scale.x !== badgeScale) view.badgeText.scale.set(badgeScale);
      if (view.badgeText.position.y !== idLabelY) view.badgeText.position.set(0, idLabelY);

      // Owner label below the relay.
      const ownerLabel = point.contested ? "Contested" : owner ? owner.teamName || owner.name : "Neutral";
      const ownerFill = owner ? color : "#ccd5e0";
      const labelY = point.radius + 18 / zoom;
      const captureSignature = `${zoomKey}|${point.radius}|${progress}|${color}|${ownerLabel}|${stationMode ? 1 : 0}`;
      if (view.captureSignature !== captureSignature) {
        view.captureSignature = captureSignature;
        const gfx = view.captureGfx;
        gfx.clear();
        if (!stationMode) {
          gfx.circle(0, 0, point.radius);
          gfx.fill({ color, alpha: 0.12 });
          if (progress > 0) {
            const start = -Math.PI / 2;
            gfx.moveTo(Math.cos(start) * point.radius, Math.sin(start) * point.radius);
            gfx.arc(0, 0, point.radius, start, start + Math.PI * 2 * progress);
            gfx.stroke({ width: 3 / zoom, color, alpha: 0.76 });
          }
          gfx.rect(-50, labelY - 9, 100, 18);
          gfx.fill("rgba(8,12,20,0.72)");
        }
      }
      if (view.ownerLabel !== ownerLabel) {
        view.ownerLabel = ownerLabel;
        view.ownerText.text = ownerLabel;
      }
      if (view.ownerFill !== ownerFill) {
        view.ownerFill = ownerFill;
        view.ownerText.style.fill = ownerFill;
      }
      const ownerFont = Math.max(10, 13 / zoom);
      const ownerScale = ownerFont / 13;
      if (view.ownerText.scale.x !== ownerScale) view.ownerText.scale.set(ownerScale);
      if (view.ownerText.position.y !== labelY) view.ownerText.position.set(0, labelY);
      view.ownerText.visible = !stationMode;
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
    invalidatePresentation("command");
    return;
  }
  const alpha = 1 - age / 1600;
  const zoom = state.camera.zoom;
  const x = state.command.x;
  const y = state.command.y;
  const color = state.command.targetKind === "friendly" ? "#4ade80" : (state.command.targetKind === "hostile" ? "#ff5f7e" : (state.command.targetName ? "#ff5f7e" : "#ffca57"));
  gfx.circle(x, y, 26 + age * 0.025);
  gfx.moveTo(x - 42, y);
  gfx.lineTo(x + 42, y);
  gfx.moveTo(x, y - 42);
  gfx.lineTo(x, y + 42);
  gfx.stroke({ width: 3 / zoom, color, alpha });
}

// --- Bullets ---------------------------------------------------------------------

function bulletArtKey(bullet, color) {
  const isTracer = bullet.type !== "rail" && bullet.type !== "missile" && bullet.type !== "pdShot";
  return isTracer ? `tracer|${color}` : `${bullet.type}|${bullet.subtype || ""}`;
}

function acquireBulletLease(env, bullet, color) {
  const key = `${bulletArtKey(bullet, color)}|${env.bakeScale}|${getPixiBakeGeneration()}`;
  return bulletTextureCache.acquire(key, () => {
    // Extents cover the largest art per type plus baked glow.
    let halfW = 24;
    let halfH = 12;
    if (bullet.type === "rail") { halfW = 48; halfH = 18; }
    else if (bullet.type === "missile") { halfW = 44; halfH = 20; }
    else if (bullet.type === "pdShot") { halfW = 18; halfH = 12; }
    return pixiBakeTexture(env, halfW * 2, halfH * 2, () => {
      drawBulletVisual({ type: bullet.type, subtype: bullet.subtype }, color);
    });
  });
}

function createPixiBulletPool(env, layer) {
  return createPixiKeyedPool(layer, () => makeLeasedSpriteView(env));
}

function updatePixiBullets(env, players, bounds, renderTime) {
  if (!pixiEnemyBulletPool) pixiEnemyBulletPool = createPixiBulletPool(env, env.layers.enemyBullets);
  if (!pixiFriendlyBulletPool) pixiFriendlyBulletPool = createPixiBulletPool(env, env.layers.friendlyBullets);
  pixiEnemyBulletPool.frameStart();
  pixiFriendlyBulletPool.frameStart();
  const snap = state.snapshot;
  const currentIds = new Set();
  const snapshotChanged = snap && (snap.snapshotSeq || 0) !== lastProjectileSnapshotSeq;
  if (snapshotChanged) lastProjectileSnapshotSeq = snap ? (snap.snapshotSeq || 0) : -1;
  const missileRenderTime = renderTime + (INTERPOLATION_DELAY_MS - 30);

  if (snap && snap.bullets) {
    for (const bullet of snap.bullets) {
      currentIds.add(bullet.id);
      let p = projectilePresentationById.get(bullet.id);
      if (!p) {
        p = { id: bullet.id, type: bullet.type, subtype: bullet.subtype, ownerId: bullet.ownerId, previousSample: null, currentSample: null, renderedX: 0, renderedY: 0, renderedVx: 0, renderedVy: 0, terminal: null };
        projectilePresentationById.set(bullet.id, p);
      }
      if (snapshotChanged) {
        if (bullet.terminal) {
          if (!p.terminal) {
            let fromX = p.renderedX;
            let fromY = p.renderedY;
            const fromVx = p.renderedVx;
            const fromVy = p.renderedVy;
            if (fromX === 0 && fromY === 0 && !p.currentSample) {
              fromX = bullet.x;
              fromY = bullet.y;
            }
            const dx = bullet.x - fromX;
            const dy = bullet.y - fromY;
            const speed = Math.max(0.001, Math.hypot(fromVx, fromVy));
            const distance = Math.hypot(dx, dy);
            const travelMs = clamp(distance / speed * 1000, 25, 120);
            const fadeMs = bullet.type === "missile" ? 300 : 180;
            const pTime = bullet.type === "missile" ? missileRenderTime : renderTime;
            p.terminal = {
              finalX: bullet.x,
              finalY: bullet.y,
              fromX,
              fromY,
              startTime: pTime,
              impactTime: pTime + travelMs,
              endTime: pTime + travelMs + fadeMs,
              type: bullet.type,
              ownerId: bullet.ownerId
            };
          }
        } else {
          const newSample = { x: bullet.x, y: bullet.y, vx: bullet.vx, vy: bullet.vy, angle: bullet.angle, simulationTimeMs: bullet.simulationTimeMs };
          if (!p.currentSample || newSample.simulationTimeMs > p.currentSample.simulationTimeMs) {
            if (p.currentSample) p.previousSample = p.currentSample;
            p.currentSample = newSample;
            p.terminal = null;
          } else if (!p.previousSample || newSample.simulationTimeMs > p.previousSample.simulationTimeMs) {
            p.previousSample = newSample;
          }
        }
      }
    }
  }

  if (state.debugStats) state.debugStats.totalBullets = projectilePresentationById.size;

  const toDelete = [];
  for (const [id, p] of projectilePresentationById) {
    if (!p.terminal && !currentIds.has(id)) {
      toDelete.push(id);
      continue;
    }
    const pTime = p.type === "missile" ? missileRenderTime : renderTime;
    let sample = null;
    if (p.terminal) {
      if (pTime < p.terminal.startTime) {
        p.renderedX = p.terminal.fromX;
        p.renderedY = p.terminal.fromY;
        p.renderedVx = 0;
        p.renderedVy = 0;
      } else if (pTime < p.terminal.impactTime) {
        const span = Math.max(1, p.terminal.impactTime - p.terminal.startTime);
        const t = (pTime - p.terminal.startTime) / span;
        p.renderedX = p.terminal.fromX + (p.terminal.finalX - p.terminal.fromX) * t;
        p.renderedY = p.terminal.fromY + (p.terminal.finalY - p.terminal.fromY) * t;
        const dtSec = span / 1000;
        p.renderedVx = (p.terminal.finalX - p.terminal.fromX) / dtSec;
        p.renderedVy = (p.terminal.finalY - p.terminal.fromY) / dtSec;
      } else {
        p.renderedX = p.terminal.finalX;
        p.renderedY = p.terminal.finalY;
        p.renderedVx = 0;
        p.renderedVy = 0;
      }
      if (pTime >= p.terminal.endTime && !currentIds.has(id)) {
        toDelete.push(id);
      }
    } else if (p.type === "missile") {
      if (!p.previousSample && p.currentSample && pTime < p.currentSample.simulationTimeMs) {
        continue;
      }
      if (p.previousSample && p.currentSample) {
        const a = p.previousSample;
        const b = p.currentSample;
        if (pTime >= a.simulationTimeMs && pTime <= b.simulationTimeMs) {
          const span = Math.max(1, b.simulationTimeMs - a.simulationTimeMs);
          const t = clamp((pTime - a.simulationTimeMs) / span, 0, 1);
          p.renderedX = a.x + (b.x - a.x) * t;
          p.renderedY = a.y + (b.y - a.y) * t;
          p.renderedVx = a.vx + (b.vx - a.vx) * t;
          p.renderedVy = a.vy + (b.vy - a.vy) * t;
        } else if (pTime < a.simulationTimeMs) {
          p.renderedX = a.x;
          p.renderedY = a.y;
          p.renderedVx = a.vx;
          p.renderedVy = a.vy;
        } else {
          const delta = (pTime - b.simulationTimeMs) / 1000;
          p.renderedX = b.x + b.vx * delta;
          p.renderedY = b.y + b.vy * delta;
          p.renderedVx = b.vx;
          p.renderedVy = b.vy;
        }
      } else if (p.currentSample) {
        const delta = Math.max(0, (pTime - p.currentSample.simulationTimeMs) / 1000);
        p.renderedX = p.currentSample.x + p.currentSample.vx * delta;
        p.renderedY = p.currentSample.y + p.currentSample.vy * delta;
        p.renderedVx = p.currentSample.vx;
        p.renderedVy = p.currentSample.vy;
      }
    } else {
      if (!p.currentSample) {
        toDelete.push(id);
        continue;
      }
      // A newly received projectile belongs to the future of the delayed
      // render timeline until its spawn tick arrives.  Keep it hidden rather
      // than drawing it at a muzzle position that is newer than its ship.
      const projected = projectBallisticProjectile(p.currentSample, p.previousSample, pTime);
      if (!projected) continue;
      sample = projected.sample;
      p.renderedX = projected.x;
      p.renderedY = projected.y;
      p.renderedVx = projected.vx;
      p.renderedVy = projected.vy;
    }

    if (p.terminal && pTime >= p.terminal.impactTime) {
      continue;
    }
    const x = p.renderedX;
    const y = p.renderedY;
    if (bounds && !isCircleVisible(x, y, 20, bounds)) continue;
    if (state.debugStats) state.debugStats.drawnBullets++;

    const owner = players.get(p.ownerId);
    const color = owner?.color || "#ffffff";
    const bullet = { id: p.id, type: p.type, subtype: p.subtype, ownerId: p.ownerId };
    const friendly = isFriendlyProjectile(bullet, players);
    const view = (friendly ? pixiFriendlyBulletPool : pixiEnemyBulletPool).acquire(p.id);
    const textureKey = `${getPixiBakeGeneration()}|${env.bakeScale}|${bulletArtKey(bullet, color)}`;
    if (view.textureKey !== textureKey) {
      const lease = acquireBulletLease(env, bullet, color);
      swapTextureLease(view, lease, textureKey, (texture) => {
        view.root.texture = texture;
        view.root.scale.set(1 / env.bakeScale);
      });
    }
    view.root.position.set(x, y);
    view.root.rotation = p.type === "missile" ? Math.atan2(p.renderedVy, p.renderedVx) : (Number.isFinite(sample?.angle) ? sample.angle : Math.atan2(p.renderedVy, p.renderedVx));
  }

  for (const id of toDelete) projectilePresentationById.delete(id);

  pixiEnemyBulletPool.frameEnd();
  pixiFriendlyBulletPool.frameEnd();
}

// --- Effects ---------------------------------------------------------------------

function pixiEffectKey(effect) {
  return `${effect.type}|${effect.at ?? "?"}|${Math.round(effect.x)}|${Math.round(effect.y)}|${effect.x2 ?? ""}`;
}

function updatePixiEffects(env, now, bounds, renderTime) {
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

  // Terminal projectile impact flashes. These are driven by the renderer's own
  // presentation map rather than per-snapshot state.
  const players = playerMap();
  const fxMissileRenderTime = renderTime + (INTERPOLATION_DELAY_MS - 30);
  for (const p of projectilePresentationById.values()) {
    const pTime = p.type === "missile" ? fxMissileRenderTime : renderTime;
    if (!p.terminal || pTime < p.terminal.impactTime) continue;
    const x = p.terminal.finalX;
    const y = p.terminal.finalY;
    if (bounds && !isCircleVisible(x, y, 40, bounds)) continue;
    const t = Math.max(0, Math.min(1, (pTime - p.terminal.impactTime) / Math.max(1, p.terminal.endTime - p.terminal.impactTime)));
    const impactFade = 1 - t;
    if (impactFade <= 0) continue;
    const owner = players.get(p.terminal.ownerId);
    const color = owner?.color || "#ffffff";
    const maxRadius = p.terminal.type === "missile" ? 34 : 10;
    const r = maxRadius * (0.4 + t * 0.6);
    const alpha = impactFade;
    gfx.circle(x, y, r);
    gfx.fill({ color, alpha: alpha * 0.4 });
    gfx.circle(x, y, r * 0.45);
    gfx.fill({ color, alpha });
  }

  // Decoys are persistent gameplay entities, so they remain visible even when
  // optional combat particles are disabled. Their noisy double image and
  // targeting brackets deliberately read as a false sensor contact.
  if (snap?.decoys) {
    const elapsed = Math.min(0.15, (performance.now() - (state.snapshotReceivedAt || performance.now())) / 1000);
    for (const decoy of snap.decoys) {
      const x = decoy.x + (decoy.vx || 0) * elapsed;
      const y = decoy.y + (decoy.vy || 0) * elapsed;
      const radius = Math.max(10, Number(decoy.radius) || 12);
      if (bounds && !isCircleVisible(x, y, radius * 2.2, bounds)) continue;
      const pulse = 0.72 + Math.sin(now * 0.018 + String(decoy.id).length) * 0.2;

      // A compact luminous body and velocity-aligned emission trail keep the
      // flare readable at normal and low zoom, even over bright ship effects.
      const speed = Math.hypot(decoy.vx || 0, decoy.vy || 0);
      const dirX = speed > 0.001 ? (decoy.vx || 0) / speed : 1;
      const dirY = speed > 0.001 ? (decoy.vy || 0) / speed : 0;
      gfx.circle(x, y, radius * 1.18);
      gfx.fill({ color: "#60a5fa", alpha: pulse * 0.12 });
      gfx.moveTo(x - dirX * radius * 0.4, y - dirY * radius * 0.4);
      gfx.lineTo(x - dirX * radius * 2.05, y - dirY * radius * 2.05);
      gfx.stroke({ width: Math.max(3 / zoom, radius * 0.38), color: "#60a5fa", alpha: pulse * 0.2, cap: "round" });
      gfx.moveTo(x - dirX * radius * 0.25, y - dirY * radius * 0.25);
      gfx.lineTo(x - dirX * radius * 1.5, y - dirY * radius * 1.5);
      gfx.stroke({ width: Math.max(1.2 / zoom, radius * 0.12), color: "#e0f2fe", alpha: pulse * 0.72, cap: "round" });

      gfx.circle(x, y, radius);
      gfx.stroke({ width: 2 / zoom, color: "#93c5fd", alpha: pulse });
      gfx.circle(x + radius * 0.35, y - radius * 0.22, radius * 0.72);
      gfx.stroke({ width: 1.2 / zoom, color: "#c4b5fd", alpha: pulse * 0.55 });
      gfx.circle(x, y, radius * 0.42);
      gfx.fill({ color: "#7dd3fc", alpha: pulse * 0.82 });
      gfx.circle(x, y, radius * 0.2);
      gfx.fill({ color: "#f8fafc", alpha: Math.min(1, pulse + 0.18) });
      gfx.moveTo(x - radius * 1.65, y);
      gfx.lineTo(x - radius * 0.75, y);
      gfx.moveTo(x + radius * 0.75, y);
      gfx.lineTo(x + radius * 1.65, y);
      gfx.moveTo(x, y - radius * 1.65);
      gfx.lineTo(x, y - radius * 0.75);
      gfx.moveTo(x, y + radius * 0.75);
      gfx.lineTo(x, y + radius * 1.65);
      gfx.stroke({ width: 1.5 / zoom, color: "#a78bfa", alpha: pulse * 0.9 });
    }
  }
  if (snap && snap.effects) {
    if (state.debugStats) state.debugStats.totalEffects = snap.effects.length;
    let drawn = 0;
    for (const effect of snap.effects) {
      const age = effect.age || 0;
      const t = clamp(age / 900, 0, 1);
      const alpha = 1 - t;
      const x = effect.x;
      const y = effect.y;
      if (bounds) {
        const visual = LINE_EFFECT_TYPES.has(effect.type)
          ? { type: "line", x1: x, y1: y, x2: effect.x2 || x, y2: effect.y2 || y }
          : { x, y, radius: effect.radius || 0 };
        const kind = effect.type === "dmg" || effect.type === "text" ? "floatingText" : "explosion";
        if (!cullVisual(kind, visual, bounds)) continue;
      }
      drawn++;

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
      } else if (effect.type === "repairbeam") {
        const beamT = clamp(age / 140, 0, 1);
        const beamAlpha = (1 - beamT) * 0.9;
        const x2 = effect.x2 || x;
        const y2 = effect.y2 || y;
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: 7 / zoom, color: "rgba(34,197,94,0.28)", alpha: beamAlpha, cap: "round" });
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: 2 / zoom, color: "rgba(190,255,214,0.95)", alpha: beamAlpha, cap: "round" });
        gfx.circle(x2, y2, 6);
        gfx.fill({ color: "#4ade80", alpha: beamAlpha * 0.6 });
      } else if (effect.type === "laserPdPulse" || effect.type === "laserpd") {
        const pulseT = clamp(age / 120, 0, 1);
        const pulseAlpha = (1 - pulseT) * 0.95;
        const x2 = effect.x2 ?? x;
        const y2 = effect.y2 ?? y;
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: 3.5 / zoom, color: "rgba(251,113,133,0.45)", alpha: pulseAlpha, cap: "round" });
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: 1.2 / zoom, color: "rgba(255,241,242,0.95)", alpha: pulseAlpha, cap: "round" });
        gfx.circle(x2, y2, 3);
        gfx.fill({ color: "#fb7185", alpha: pulseAlpha * 0.85 });
      } else if (effect.type === "droneshot" || effect.type === "dronerepair") {
        const x2 = effect.x2 ?? x;
        const y2 = effect.y2 ?? y;
        gfx.moveTo(x, y);
        gfx.lineTo(x2, y2);
        gfx.stroke({ width: 1.5 / zoom, color: effect.type === "dronerepair" ? "#86efac" : "#fb7185", alpha: alpha * 0.8 });
      } else if (effect.type === "dronelaunch") {
        gfx.moveTo(x - 12 * (1 - t), y);
        gfx.lineTo(x, y);
        gfx.stroke({ width: 2 / zoom, color: "#67e8f9", alpha });
        gfx.circle(x, y, 3 + t * 5);
        gfx.stroke({ width: 1 / zoom, color: "#cffafe", alpha });
      } else if (effect.type === "droneburst") {
        gfx.circle(x, y, 4 + t * 14);
        gfx.fill({ color: "#fb7185", alpha: alpha * 0.75 });
        gfx.circle(x, y, 6 + t * 18);
        gfx.stroke({ width: 1.5 / zoom, color: "#fda4af", alpha });
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
          const targetScale = fontSize / 16;
          if (view.root.scale.x !== targetScale) view.root.scale.set(targetScale);
          view.root.position.set(x, y - t * 30);
          view.root.alpha = alpha;
        }
      } else if (effect.type === "flakburst") {
        const rr = effect.radius || 36;
        gfx.circle(x, y, rr * (0.2 + t));
        gfx.fill({ color: "#fbbf24", alpha });
        gfx.circle(x, y, rr * (0.05 + t * 0.5));
        gfx.fill({ color: "#fff3c2", alpha: alpha * 0.75 });
        gfx.circle(x, y, rr * (0.3 + t * 1.1));
        gfx.stroke({ width: 3 / zoom, color: "#ef4444", alpha });
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
    if (bounds && !isCircleVisible(p.renderX, p.renderY, p.renderRadius, bounds)) continue;
    gfx.circle(p.renderX, p.renderY, p.renderRadius);
    gfx.fill({ color: "#7f8f88", alpha: p.renderAlpha });
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
  const baseRenderTime = state.renderHistory?.renderSimulationTimeMs ?? now;
  const snap = state.snapshot;
  const snapTime = snap?.simulationTimeMs ?? baseRenderTime;
  const projectileSnapTime = snap?.projectileSimulationTimeMs ?? snapTime;
  if (Number.isFinite(snapTime) && Number.isFinite(projectileSnapTime)
    && Math.abs(projectileSnapTime - snapTime) > 1) {
    const warningKey = `${snap?.stateEpoch ?? 0}:${snap?.snapshotSeq ?? 0}:${snapTime}:${projectileSnapTime}`;
    if (warningKey !== lastProjectileClockWarningKey) {
      lastProjectileClockWarningKey = warningKey;
      console.warn("Projectile and snapshot clocks diverged", {
        projectileSnapTime,
        snapTime
      });
    }
  } else {
    lastProjectileClockWarningKey = null;
  }
  // Ships and projectiles are both rendered on the delayed authoritative
  // simulation timeline.  Never advance one from the other's packet stamp.
  const renderTime = baseRenderTime;
  updatePixiGrid(env);
  updatePixiMapFeatures(env, now, bounds);
  updatePixiRelays(env, now, players, bounds);
  updatePixiCommandTarget(env, now);
  updatePixiEngineSmoke(env, now, bounds);
  updatePixiBullets(env, players, bounds, renderTime);
  updatePixiEffects(env, now, bounds, renderTime);
  updatePixiSelectionBox(env);
  updatePixiContacts(env, now, bounds);
  updatePixiFog(env, now, bounds);
}

// Tears down every world-object pool (releasing texture leases and destroying
// display objects without their cache-owned textures) and clears module-global
// state so a re-initialized renderer starts fresh. The texture caches are
// flushed centrally by the renderer after all leases are released.
export function destroyPixiWorld() {
  if (pixiMapStatics) {
    pixiMapStatics.nebulaPool.destroy();
    pixiMapStatics.asteroidPool.destroy();
    if (pixiMapStatics.nebulaLayer?.parent) pixiMapStatics.nebulaLayer.parent.removeChild(pixiMapStatics.nebulaLayer);
    pixiMapStatics.nebulaLayer?.destroy({ children: false, texture: false, textureSource: false });
    if (pixiMapStatics.asteroidLayer?.parent) pixiMapStatics.asteroidLayer.parent.removeChild(pixiMapStatics.asteroidLayer);
    pixiMapStatics.asteroidLayer?.destroy({ children: false, texture: false, textureSource: false });
    if (pixiMapStatics.featureLayer?.parent) pixiMapStatics.featureLayer.parent.removeChild(pixiMapStatics.featureLayer);
    pixiMapStatics.featureLayer?.destroy({ children: false, texture: false, textureSource: false });
    if (pixiMapStatics.zonesGfx?.parent) pixiMapStatics.zonesGfx.parent.removeChild(pixiMapStatics.zonesGfx);
    pixiMapStatics.zonesGfx?.destroy();
    pixiMapStatics = null;
  }
  if (pixiRelayPool) { pixiRelayPool.destroy(); pixiRelayPool = null; }
  if (pixiEnemyBulletPool) { pixiEnemyBulletPool.destroy(); pixiEnemyBulletPool = null; }
  if (pixiFriendlyBulletPool) { pixiFriendlyBulletPool.destroy(); pixiFriendlyBulletPool = null; }
  if (pixiEffectTextPool) { pixiEffectTextPool.destroy(); pixiEffectTextPool = null; }
  if (pixiEffectsGfx) {
    if (pixiEffectsGfx.parent) pixiEffectsGfx.parent.removeChild(pixiEffectsGfx);
    pixiEffectsGfx.destroy();
    pixiEffectsGfx = null;
  }
  projectilePresentationById.clear();
  lastProjectileSnapshotSeq = -1;
  lastProjectileClockWarningKey = null;
  gridCache = { width: 0, height: 0, zoom: 0 };
}
