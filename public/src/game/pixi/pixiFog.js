// Fog-of-war overlay.
//
// The first implementation rebuilt one enormous Pixi Graphics polygon and
// re-tessellated every sensor cut-out whenever a moving ship crossed a single
// pixel. That put geometry work and allocations on the hottest render path.
// This version rasterizes the low-frequency visibility mask to one small canvas
// texture. Rendering the fog is then one sprite, while soft sensor edges avoid
// the distracting hard-edged overlapping discs.

import { state } from "../../state.js";
import { getFogOpacity } from "../../game/renderSettings.js";
import { angleDifference } from "../../shared/math.js";

const SENSOR_FOG_COLOR_BASE = "rgba(0, 4, 16, ";
const FULL_DARK_COLOR = "rgba(0, 0, 0, 1)";
const EDGE_START = 0.86;

let fogView = null;

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
  const worldW = Math.max(1, Number(state.world?.width) || Number(snapshot.world?.width) || 4000);
  const worldH = Math.max(1, Number(state.world?.height) || Number(snapshot.world?.height) || 4000);
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

export function isPointVisible(x, y, sources) {
  for (const source of sources) {
    const dx = x - source.x;
    const dy = y - source.y;
    const dist2 = dx * dx + dy * dy;
    const range = source.range;
    if (!(dist2 <= (range + 0.5) * (range + 0.5))) continue;
    if (source.shape === "circle") return true;
    const a = source.angle || 0;
    const halfArc = (source.arc || 0) * 0.5;
    if (halfArc >= Math.PI) return true;
    const da = Math.abs(angleDifference(Math.atan2(dy, dx), a));
    if (da <= halfArc + 1e-6) return true;
  }
  return false;
}

function coneArcSteps(arc) {
  // Aim for about one segment per ~3 degrees of arc, with a sane minimum and
  // maximum so very small or very large cones are not under/over tessellated.
  return Math.min(120, Math.max(8, Math.ceil(arc / (Math.PI / 64))));
}

export function buildPixiVisibilityMaskGeometry(env, mask, sources) {
  if (!mask) return;
  mask.clear();
  for (const source of sources) {
    const x = Number(source.x);
    const y = Number(source.y);
    const range = Number(source.range);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !(range > 0)) continue;
    if (source.shape === "circle" || (source.shape === "cone" && (source.arc || 0) >= Math.PI * 2 - 1e-6)) {
      mask.circle(x, y, range);
      mask.fill(0xffffff);
      continue;
    }
    if (source.shape === "cone") {
      const angle = Number(source.angle) || 0;
      const arc = Math.max(0, Number(source.arc) || 0);
      const half = arc * 0.5;
      const steps = coneArcSteps(arc);
      mask.moveTo(x, y);
      for (let i = 0; i <= steps; i++) {
        const a = angle - half + (arc * i / steps);
        mask.lineTo(x + Math.cos(a) * range, y + Math.sin(a) * range);
      }
      mask.closePath();
      mask.fill(0xffffff);
    }
  }
}

export function destroyPixiFog() {
  if (!fogView) return;
  const { root, texture } = fogView;
  root.destroy({ children: true, texture: false, textureSource: false });
  texture?.destroy?.(true);
  fogView = null;
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
