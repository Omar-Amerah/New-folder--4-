// Fog-of-war overlay.
//
// The first implementation rebuilt one enormous Pixi Graphics polygon and
// re-tessellated every sensor cut-out whenever a moving ship crossed a single
// pixel. That put geometry work and allocations on the hottest render path.
// This version rasterizes the low-frequency visibility mask to one small canvas
// texture. Rendering the fog is then one sprite, while soft sensor edges avoid
// the distracting hard-edged overlapping discs.

import { state } from "../../state.js";
import { WORLD_FALLBACK } from "../../constants.js";
import { getFogOpacity } from "../../game/renderSettings.js";
import { angleDifference } from "../../shared/math.js";

const SENSOR_FOG_COLOR_BASE = "rgba(0, 4, 16, ";
const FULL_DARK_COLOR = "rgba(0, 0, 0, 1)";
const EDGE_START = 0.86;
export const SENSOR_FADE_START = EDGE_START;

let fogView = null;
let visibilityMaskView = null;

function viewerTeam() {
  return state.mine?.team
    ?? state.snapshot?.players?.find((player) => player.id === state.myId)?.team
    ?? null;
}

function texturePolicy(quality) {
  if (quality === "low") return { maxDimension: 384, intervalMs: 100 };
  if (quality === "high") return { maxDimension: 640, intervalMs: 50 };
  return { maxDimension: 512, intervalMs: 66 };
}

function textureDimensions(worldW, worldH, maxDimension) {
  const longest = Math.max(1, worldW, worldH);
  return {
    width: Math.max(1, Math.round(worldW / longest * maxDimension)),
    height: Math.max(1, Math.round(worldH / longest * maxDimension))
  };
}

function worldDimensions(snapshot = state.snapshot) {
  return {
    worldW: Math.max(1, Number(state.world?.width) || Number(snapshot?.world?.width) || WORLD_FALLBACK.width),
    worldH: Math.max(1, Number(state.world?.height) || Number(snapshot?.world?.height) || WORLD_FALLBACK.height)
  };
}

function createFogView(env) {
  const root = new env.PIXI.Container();
  const outside = new env.PIXI.Graphics();
  const sprite = new env.PIXI.Sprite(env.PIXI.Texture.EMPTY);
  root.eventMode = "none";
  outside.eventMode = "none";
  sprite.eventMode = "none";
  root.addChild(outside, sprite);
  env.layers.fog.addChild(root);
  return {
    root,
    outside,
    sprite,
    texture: null,
    canvas: null,
    context: null,
    canvasWidth: 0,
    canvasHeight: 0,
    worldW: 0,
    worldH: 0,
    mode: null,
    lastCheckAt: Number.NEGATIVE_INFINITY,
    lastDrawAt: Number.NEGATIVE_INFINITY,
    lastSourcesKey: null,
    quality: null
  };
}

function disposeTexture(env, view) {
  if (!view.texture) return;
  view.sprite.texture = env.PIXI.Texture.EMPTY;
  view.texture.destroy(true);
  view.texture = null;
}

function configureFogSurface(env, view, worldW, worldH, mode, opacity) {
  const policy = texturePolicy(env.quality);
  const dimensions = textureDimensions(worldW, worldH, policy.maxDimension);
  const unchanged = view.canvas
    && view.canvasWidth === dimensions.width
    && view.canvasHeight === dimensions.height
    && view.worldW === worldW
    && view.worldH === worldH
    && view.mode === mode
    && view.opacity === opacity
    && view.quality === env.quality;
  if (unchanged) return policy;

  disposeTexture(env, view);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { alpha: true });
  view.canvas = canvas;
  view.context = context;
  view.canvasWidth = dimensions.width;
  view.canvasHeight = dimensions.height;
  view.worldW = worldW;
  view.worldH = worldH;
  view.mode = mode;
  view.opacity = opacity;
  view.quality = env.quality;
  view.texture = env.PIXI.Texture.from(canvas);
  view.sprite.texture = view.texture;
  view.sprite.position.set(0, 0);
  view.sprite.width = worldW;
  view.sprite.height = worldH;
  view.lastSourcesKey = null;
  view.lastCheckAt = Number.NEGATIVE_INFINITY;
  view.lastDrawAt = Number.NEGATIVE_INFINITY;

  const margin = Math.max(4000, worldW, worldH);
  view.outside.clear();
  view.outside.rect(-margin, -margin, worldW + margin * 2, margin);
  view.outside.rect(-margin, worldH, worldW + margin * 2, margin);
  view.outside.rect(-margin, 0, margin, worldH);
  view.outside.rect(worldW, 0, margin, worldH);
  view.outside.fill(mode === "dark"
    ? { color: 0x000000, alpha: 1 }
    : { color: 0x000410, alpha: opacity });
  return policy;
}

function alliedSensorSources(snapshot, team) {
  const sources = [];
  if (team === null || team === undefined) return sources;
  const ownerTeams = new Map((snapshot.players || []).map((player) => [player.id, player.team]));

  for (const ship of snapshot.ships || []) {
    const range = Number(ship.sensorRange);
    const shipTeam = ship.team ?? ownerTeams.get(ship.ownerId);
    if (!(range > 0) || shipTeam !== team || ship.alive === false) continue;
    const visual = state.visualShips?.get?.(ship.id);
    const x = Number.isFinite(visual?.x) ? visual.x : Number(ship.x);
    const y = Number.isFinite(visual?.y) ? visual.y : Number(ship.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sources.push({ id: ship.id, shape: "circle", x, y, range });
    const shipAngle = Number.isFinite(visual?.angle) ? visual.angle : Number(ship.angle) || 0;
    for (const cone of ship.sensorCones || []) {
      const coneRange = Number(cone.range);
      const arc = Number(cone.arc);
      if (!(coneRange > 0) || !(arc > 0)) continue;
      sources.push({
        id: `${ship.id}:cone:${cone.componentIndex}`,
        shape: "cone",
        x,
        y,
        range: coneRange,
        angle: shipAngle + (Number(cone.relativeAngle) || 0),
        arc
      });
    }
  }

  for (const station of snapshot.stations || []) {
    const range = Number(station.sensorRange);
    if (!(range > 0) || station.team !== team) continue;
    if (!Number.isFinite(Number(station.x)) || !Number.isFinite(Number(station.y))) continue;
    sources.push({ id: `station:${station.id}`, shape: "circle", x: Number(station.x), y: Number(station.y), range });
  }
  return sources;
}

function sourcesKey(sources) {
  let key = "";
  for (const source of sources) {
    // Two-world-unit quantization removes sub-pixel churn without allowing the
    // mask to visibly drift behind an interpolated ship.
    key += `${source.id}:${source.shape}:${Math.round(source.x / 2)}:${Math.round(source.y / 2)}:${Math.round(source.range)}:${Math.round((source.angle || 0) * 180)}:${Math.round((source.arc || 0) * 180)};`;
  }
  return key;
}

function drawFogMask(view, sources, mode, opacity) {
  const context = view.context;
  if (!context) return;
  const sx = view.canvasWidth / view.worldW;
  const sy = view.canvasHeight / view.worldH;
  const scale = Math.min(sx, sy);
  const fogColor = mode === "dark" ? FULL_DARK_COLOR : `${SENSOR_FOG_COLOR_BASE}${opacity})`;

  context.save();
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, view.canvasWidth, view.canvasHeight);
  context.fillStyle = fogColor;
  context.fillRect(0, 0, view.canvasWidth, view.canvasHeight);
  context.globalCompositeOperation = "destination-out";

  for (const source of sources) {
    const x = source.x * sx;
    const y = source.y * sy;
    const radius = Math.max(1, source.range * scale);
    const gradient = context.createRadialGradient(x, y, radius * EDGE_START, x, y, radius);
    gradient.addColorStop(0, "rgba(0, 0, 0, 1)");
    gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    context.save();
    if (source.shape === "cone") {
      const angle = Number(source.angle) || 0;
      const halfArc = Math.max(0, Number(source.arc) || 0) * 0.5;
      context.beginPath();
      context.moveTo(x, y);
      context.arc(x, y, radius, angle - halfArc, angle + halfArc);
      context.closePath();
      context.clip();
    }
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
  context.restore();
  view.texture?.source?.update?.();
}

function createVisibilityMaskView(env, sprite) {
  sprite.eventMode = "none";
  return {
    sprite,
    texture: null,
    canvas: null,
    context: null,
    canvasWidth: 0,
    canvasHeight: 0,
    worldW: 0,
    worldH: 0,
    quality: null,
    lastSourcesKey: null,
    lastDrawAt: Number.NEGATIVE_INFINITY,
    retiredTextures: []
  };
}

function disposeVisibilityMaskTexture(view, destroyRetired = false) {
  if (!view) return;
  if (view.sprite?.parent?.mask === view.sprite) view.sprite.parent.mask = null;
  const textures = view.texture ? [view.texture] : [];
  const emptyTexture = view.texture?.constructor?.EMPTY;
  if (emptyTexture) view.sprite.texture = emptyTexture;
  view.texture = null;
  if (destroyRetired) {
    textures.push(...view.retiredTextures);
    view.retiredTextures = [];
    for (const texture of textures) texture.destroy(true);
  } else if (textures.length) {
    view.retiredTextures.push(...textures);
  }
}

function configureVisibilityMaskSurface(env, view, worldW, worldH) {
  const policy = texturePolicy(env.quality);
  const dimensions = textureDimensions(worldW, worldH, policy.maxDimension);
  const unchanged = view.canvas
    && view.canvasWidth === dimensions.width
    && view.canvasHeight === dimensions.height
    && view.worldW === worldW
    && view.worldH === worldH
    && view.quality === env.quality;
  if (unchanged) return Boolean(view.context && view.texture);

  disposeVisibilityMaskTexture(view);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d", { alpha: true });
  view.canvas = canvas;
  view.context = context;
  view.canvasWidth = dimensions.width;
  view.canvasHeight = dimensions.height;
  view.worldW = worldW;
  view.worldH = worldH;
  view.quality = env.quality;
  view.lastSourcesKey = null;
  view.lastDrawAt = Number.NEGATIVE_INFINITY;
  if (!context) return false;

  view.texture = env.PIXI.Texture.from(canvas);
  view.sprite.texture = view.texture;
  view.sprite.position.set(0, 0);
  view.sprite.width = worldW;
  view.sprite.height = worldH;
  return true;
}

function drawVisibilityMask(view, sources) {
  const context = view.context;
  if (!context) return;
  const sx = view.canvasWidth / view.worldW;
  const sy = view.canvasHeight / view.worldH;
  const scale = Math.min(sx, sy);
  const texelWorld = 1 / Math.max(scale, Number.EPSILON);

  context.save();
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, view.canvasWidth, view.canvasHeight);

  for (const source of sources) {
    const x = Number(source.x) * sx;
    const y = Number(source.y) * sy;
    const range = Number(source.range);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(range > 0)) continue;

    // Leave a transparent texel inside the authoritative edge. Linear texture
    // sampling can then never turn the last non-zero sample into visibility
    // beyond the legal sensor range.
    const drawRange = Math.max(0, range - texelWorld * 0.5);
    const radius = drawRange * scale;
    if (!(radius > 0)) continue;
    const fadeStart = Math.min(radius, range * EDGE_START * scale);
    const gradient = context.createRadialGradient(x, y, fadeStart, x, y, radius);
    gradient.addColorStop(0, "rgba(255, 255, 255, 1)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");

    context.save();
    if (source.shape === "cone" && (Number(source.arc) || 0) < Math.PI * 2 - 1e-6) {
      const angle = Number(source.angle) || 0;
      const halfArc = Math.max(0, Number(source.arc) || 0) * 0.5;
      context.beginPath();
      context.moveTo(x, y);
      context.arc(x, y, radius, angle - halfArc, angle + halfArc);
      context.closePath();
      context.clip();
    }
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }

  context.restore();
  view.texture?.source?.update?.();
}

export function updatePixiVisibilityMask(env, maskSprite, sources = []) {
  if (!env?.PIXI || !maskSprite) return false;
  if (!visibilityMaskView || visibilityMaskView.sprite !== maskSprite) {
    if (visibilityMaskView) disposeVisibilityMaskTexture(visibilityMaskView, true);
    visibilityMaskView = createVisibilityMaskView(env, maskSprite);
  }

  const { worldW, worldH } = worldDimensions();
  if (!configureVisibilityMaskSurface(env, visibilityMaskView, worldW, worldH)) return false;
  const key = sourcesKey(sources);
  if (key !== visibilityMaskView.lastSourcesKey) {
    drawVisibilityMask(visibilityMaskView, sources);
    visibilityMaskView.lastSourcesKey = key;
    visibilityMaskView.lastDrawAt = performance.now();
  }
  return true;
}

export function pixiVisibilityMaskDiagnostics() {
  return {
    ready: Boolean(visibilityMaskView?.texture && visibilityMaskView.context),
    width: visibilityMaskView?.canvasWidth || 0,
    height: visibilityMaskView?.canvasHeight || 0,
    worldW: visibilityMaskView?.worldW || 0,
    worldH: visibilityMaskView?.worldH || 0
  };
}

export function updatePixiFog(env, now, _bounds) {
  if (!usesSensorVisibility()) {
    if (fogView) {
      fogView.root.visible = false;
      fogView.lastSourcesKey = null;
    }
    return;
  }
  if (!env.layers?.fog) return;
  if (!fogView) fogView = createFogView(env);
  fogView.root.visible = true;

  const snapshot = state.snapshot || {};
  const mode = state.rules?.visibilityMode;
  const opacity = mode === "dark" ? 1 : getFogOpacity();
  const { worldW, worldH } = worldDimensions(snapshot);
  const policy = configureFogSurface(env, fogView, worldW, worldH, mode, opacity);
  if (now - fogView.lastCheckAt < policy.intervalMs) return;
  fogView.lastCheckAt = now;
  const sources = alliedSensorSources(snapshot, viewerTeam());
  const key = sourcesKey(sources);

  if (opacity !== fogView.opacity) {
    fogView.lastSourcesKey = null;
    fogView.opacity = opacity;
  }
  if (key === fogView.lastSourcesKey) return;
  drawFogMask(fogView, sources, mode, opacity);
  fogView.lastSourcesKey = key;
  fogView.lastDrawAt = now;
}

export function getAlliedSensorSources() {
  return alliedSensorSources(state.snapshot || {}, viewerTeam());
}

export function sensorVisibilityAlpha(distance, range) {
  const safeDistance = Number(distance);
  const safeRange = Number(range);
  if (!Number.isFinite(safeDistance) || !(safeRange > 0)) return 0;
  const fadeStart = safeRange * EDGE_START;
  if (safeDistance <= fadeStart) return 1;
  if (safeDistance >= safeRange) return 0;
  return 1 - (safeDistance - fadeStart) / (safeRange - fadeStart);
}

export function visibilityAlphaAtPoint(x, y, sources = []) {
  const pointX = Number(x);
  const pointY = Number(y);
  if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return 0;
  let alpha = 0;
  for (const source of sources) {
    const sourceX = Number(source.x);
    const sourceY = Number(source.y);
    const range = Number(source.range);
    if (!Number.isFinite(sourceX) || !Number.isFinite(sourceY) || !(range > 0)) continue;
    const dx = pointX - sourceX;
    const dy = pointY - sourceY;
    const distance = Math.hypot(dx, dy);
    const sourceAlpha = sensorVisibilityAlpha(distance, range);
    if (!(sourceAlpha > 0)) continue;
    if (source.shape === "cone") {
      const halfArc = Math.max(0, Number(source.arc) || 0) * 0.5;
      if (halfArc < Math.PI && distance > 1e-6) {
        const a = Number(source.angle) || 0;
        const da = Math.abs(angleDifference(Math.atan2(dy, dx), a));
        if (da > halfArc + 1e-6) continue;
      }
    }
    alpha = Math.max(alpha, sourceAlpha);
    if (alpha >= 1) return 1;
  }
  return alpha;
}

export function isPointVisible(x, y, sources) {
  return visibilityAlphaAtPoint(x, y, sources) > 0;
}

export function destroyPixiFog() {
  if (fogView) {
    const { root, texture } = fogView;
    root.destroy({ children: true, texture: false, textureSource: false });
    texture?.destroy?.(true);
    fogView = null;
  }
  if (visibilityMaskView) {
    // Pixi keeps pooled alpha-mask filters after renderer teardown. Keep the
    // canvas source alive so a later renderer reinitialization cannot reuse a
    // filter whose mask resource has been destroyed; the application teardown
    // releases the associated GPU resources.
    disposeVisibilityMaskTexture(visibilityMaskView);
    visibilityMaskView = null;
  }
}

// The Full Dark minimap reuses this exact world-space raster mask. Sharing the
// texture keeps its coverage identical to the arena and avoids a second sensor
// scan, canvas redraw, or GPU upload on the screen-UI path.
export function getPixiFogTexture() {
  return fogView?.root?.visible && fogView.texture ? fogView.texture : null;
}

export function usesSensorVisibility() {
  const mode = state.rules?.visibilityMode;
  return mode === "sensors" || mode === "dark";
}
