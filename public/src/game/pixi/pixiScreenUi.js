// Screen-space visuals for the PixiJS arena renderer: backdrop gradient,
// parallax starfield, viewport vignette, minimap, and the "join a room" prompt.

import { dom } from "../../ui/dom.js";
import { state } from "../../state.js";
import { getMinimapStaticLayer } from "../worldArt.js";
import { pixiBakeScreenTexture } from "./pixiBake.js";
import { getRallyPoint } from "../../ui/sidePanelUi.js";
import { getPixiFogTexture } from "./pixiFog.js";

let screenUiViews = null;
let backdropSize = { width: 0, height: 0 };
let minimapView = null;

// Bakes one star-field layer into a repeating tile. Called once per layer at
// renderer init; the resulting texture is drawn as a single tiling sprite.
function bakeStarTile(env, layer) {
  const texture = pixiBakeScreenTexture(env, layer.tile, layer.tile, (bctx) => {
    for (const star of layer.stars) {
      // Faint cool white; no per-star hue so the field stays textural.
      bctx.fillStyle = `rgba(206,224,247,${star.alpha})`;
      bctx.fillRect(star.x, star.y, star.size, star.size);
    }
  });
  // Tiling needs wrapped sampling; Texture.from() defaults to clamp.
  texture.source.addressMode = "repeat";
  return texture;
}

// A single static overlay: transparent through the middle, easing to a slight
// darkening at the corners. Baked once at a small fixed size and stretched over
// the viewport — bilinear filtering keeps the ramp smooth and it never re-bakes.
function bakeVignette(env) {
  const size = 256;
  return pixiBakeScreenTexture(env, size, size, (bctx) => {
    const half = size / 2;
    // Radius reaches the corners once the square is stretched to the viewport.
    const gradient = bctx.createRadialGradient(half, half, 0, half, half, half * Math.SQRT2);
    gradient.addColorStop(0, "rgba(2,4,9,0)");
    gradient.addColorStop(0.58, "rgba(2,4,9,0)");
    gradient.addColorStop(0.8, "rgba(2,4,9,0.08)");
    gradient.addColorStop(1, "rgba(2,4,9,0.26)");
    bctx.fillStyle = gradient;
    bctx.fillRect(0, 0, size, size);
  });
}

function ensureScreenUiViews(env) {
  if (screenUiViews) return screenUiViews;
  const PIXI = env.PIXI;

  const backdrop = new PIXI.Sprite(PIXI.Texture.WHITE);
  env.layers.backdropRoot.addChild(backdrop);

  // One tiling sprite per depth layer. Parallax moves the whole layer via
  // tilePosition, so panning costs two property writes rather than per-star work.
  const starLayers = state.starLayers.map((layer) => {
    const texture = bakeStarTile(env, layer);
    const sprite = new PIXI.TilingSprite({ texture, width: 1, height: 1 });
    env.layers.backdropRoot.addChild(sprite);
    return { sprite, texture, drift: layer.drift };
  });

  // Sits at the bottom of the screen-space root, so it darkens the arena but
  // stays under the minimap and prompts.
  const vignetteTexture = bakeVignette(env);
  const vignette = new PIXI.Sprite(vignetteTexture);
  vignette.eventMode = "none";
  env.layers.screenUiRoot.addChild(vignette);

  const joinText = new PIXI.Text({
    text: "Join a room to enter the arena",
    style: {
      fill: "rgba(237,244,255,0.72)",
      fontFamily: "system-ui, sans-serif",
      fontSize: 15,
      fontWeight: "700"
    }
  });
  joinText.anchor.set(0.5);
  env.layers.screenUiRoot.addChild(joinText);

  screenUiViews = { backdrop, starLayers, vignette, vignetteTexture, joinText };
  return screenUiViews;
}

function updatePixiBackdrop(env, rect) {
  const views = ensureScreenUiViews(env);
  if (backdropSize.width !== rect.width || backdropSize.height !== rect.height) {
    backdropSize = { width: rect.width, height: rect.height };
    const old = views.backdrop.texture;
    views.backdrop.texture = pixiBakeScreenTexture(env, rect.width, rect.height, (bctx) => {
      // Neutral dark charcoal-navy. The radial lift keeps empty space from
      // reading as flat black; the diagonal pass adds a touch of tonal
      // variation. Both stay far below the saturation of component art.
      bctx.fillStyle = "#05070d";
      bctx.fillRect(0, 0, rect.width, rect.height);
      const radius = Math.max(rect.width, rect.height) * 0.72;
      const lift = bctx.createRadialGradient(rect.width * 0.5, rect.height * 0.46, 0, rect.width * 0.5, rect.height * 0.46, radius);
      lift.addColorStop(0, "rgba(20,29,45,0.55)");
      lift.addColorStop(0.6, "rgba(12,18,29,0.3)");
      lift.addColorStop(1, "rgba(5,7,13,0)");
      bctx.fillStyle = lift;
      bctx.fillRect(0, 0, rect.width, rect.height);
      const tone = bctx.createLinearGradient(0, 0, rect.width, rect.height);
      tone.addColorStop(0, "rgba(14,20,33,0.28)");
      tone.addColorStop(0.55, "rgba(9,13,22,0)");
      tone.addColorStop(1, "rgba(3,5,10,0.3)");
      bctx.fillStyle = tone;
      bctx.fillRect(0, 0, rect.width, rect.height);
    });
    if (old && old !== env.PIXI.Texture.WHITE) old.destroy(false);
    views.backdrop.width = rect.width;
    views.backdrop.height = rect.height;
    for (const layer of views.starLayers) {
      layer.sprite.width = rect.width;
      layer.sprite.height = rect.height;
    }
    views.vignette.width = rect.width;
    views.vignette.height = rect.height;
  }

  // Whole-layer parallax: two writes per frame, no per-star work. tilePosition
  // wraps in the shader, so the offsets never need clamping.
  for (const layer of views.starLayers) {
    layer.sprite.tilePosition.set(-state.camera.x * layer.drift, -state.camera.y * layer.drift);
  }
}

function ensureMinimapView(env) {
  if (minimapView) return minimapView;
  const PIXI = env.PIXI;
  const root = new PIXI.Container();
  const background = new PIXI.Graphics();
  const content = new PIXI.Container();
  const staticSprite = new PIXI.Sprite();
  const dots = new PIXI.Graphics();
  const fullDarkFog = new PIXI.Sprite(PIXI.Texture.EMPTY);
  const overlay = new PIXI.Graphics();
  const mask = new PIXI.Graphics();
  content.addChild(staticSprite);
  content.addChild(dots);
  content.addChild(fullDarkFog);
  content.addChild(overlay);
  content.mask = mask;
  root.addChild(background);
  root.addChild(content);
  root.addChild(mask);
  env.layers.screenUiRoot.addChild(root);
  minimapView = {
    root,
    background,
    content,
    staticSprite,
    dots,
    fullDarkFog,
    overlay,
    mask,
    w: 0,
    h: 0,
    staticCanvas: null
  };
  return minimapView;
}

function updatePixiMinimap(env, players, rect) {
  const view = ensureMinimapView(env);
  if (!state.snapshot) {
    view.root.visible = false;
    state.minimap = null;
    return;
  }
  view.root.visible = true;

  const w = Math.min(190, Math.max(142, rect.width * 0.19));
  const h = w * (state.world.height / state.world.width);
  const x = rect.width - w - 14;
  const y = 14;
  state.minimap = { x, y, w, h };
  view.root.position.set(x, y);

  const arenaWrap = dom.canvas?.parentElement;
  if (arenaWrap) arenaWrap.style.setProperty('--minimap-bottom', `${Math.round(y + h)}px`);

  if (view.w !== w || view.h !== h) {
    view.w = w;
    view.h = h;
    view.background.clear();
    view.background.roundRect(0, 0, w, h, 8);
    view.background.fill("rgba(7,12,20,0.78)");
    view.background.stroke({ width: 1, color: "rgba(174,199,231,0.25)" });
    view.mask.clear();
    view.mask.roundRect(0, 0, w, h, 8);
    view.mask.fill(0xffffff);
  }

  if (dom.showEndGameButton && !dom.showEndGameButton.hidden) {
    // Anchor the "Show Results" button just below the minimap.
    dom.showEndGameButton.style.top = `${Math.round(y + h + 14)}px`;
    dom.showEndGameButton.style.right = "14px";
    dom.showEndGameButton.style.left = "auto";
    dom.showEndGameButton.style.bottom = "auto";
  }

  const sx = w / state.world.width;
  const sy = h / state.world.height;
  const snap = state.snapshot;
  const map = snap?.map || state.map;
  if (map) {
    const staticCanvas = getMinimapStaticLayer(map, w, h, sx, sy);
    if (staticCanvas !== view.staticCanvas) {
      view.staticCanvas = staticCanvas;
      const old = view.staticSprite.texture;
      view.staticSprite.texture = env.PIXI.Texture.from(staticCanvas);
      if (old && old !== env.PIXI.Texture.EMPTY) old.destroy(false);
    }
    view.staticSprite.visible = true;
  } else {
    view.staticSprite.visible = false;
  }

  const dots = view.dots;
  dots.clear();
  const overlay = view.overlay;
  overlay.clear();
  const myTeam = state.mine?.team;
  const isSolo = state.rules?.gameMode === "solo";
  for (const point of snap.points || []) {
    let relayColor = "rgba(220,230,245,0.42)";
    if (point.ownerTeam) {
      if (!isSolo && myTeam && point.ownerTeam === myTeam) relayColor = "#38d7ff";
      else if (isSolo && point.ownerId === state.myId) relayColor = "#38d7ff";
      else relayColor = "#ff3838";
    }
    dots.circle(point.x * sx, point.y * sy, 4);
    dots.fill({ color: relayColor, alpha: 0.75 });
  }
  for (const ship of snap.ships || []) {
    if (!ship.alive) continue;
    const player = players.get(ship.ownerId);
    let isFriendly = false;
    if (ship.ownerId === state.myId) isFriendly = true;
    else if (!isSolo && player && myTeam && player.team === myTeam) isFriendly = true;
    dots.circle(ship.x * sx, ship.y * sy, 2.5);
    dots.fill(isFriendly ? "#38d7ff" : "#ff3838");
  }

  const fogTexture = state.rules?.visibilityMode === "dark" ? getPixiFogTexture() : null;
  view.fullDarkFog.visible = Boolean(fogTexture);
  if (fogTexture) {
    view.fullDarkFog.texture = fogTexture;
    view.fullDarkFog.position.set(0, 0);
    view.fullDarkFog.width = w;
    view.fullDarkFog.height = h;
  } else {
    view.fullDarkFog.texture = env.PIXI.Texture.EMPTY;
  }

  const rally = getRallyPoint();
  if (rally) {
    overlay.circle(rally.x * sx, rally.y * sy, 4.5);
    overlay.fill("#67e08a");
    overlay.stroke({ width: 1.5, color: "rgba(4,8,14,0.9)" });
  }
  const viewW = rect.width / state.camera.zoom;
  const viewH = rect.height / state.camera.zoom;
  overlay.rect((state.camera.x - viewW / 2) * sx, (state.camera.y - viewH / 2) * sy, viewW * sx, viewH * sy);
  overlay.stroke({ width: 1, color: "#ffca57" });
}

export function updatePixiScreenUi(env, now, players, rect) {
  const views = ensureScreenUiViews(env);
  updatePixiBackdrop(env, rect);
  updatePixiMinimap(env, players, rect);

  views.joinText.visible = !state.snapshot;
  if (views.joinText.visible) {
    views.joinText.position.set(rect.width / 2, rect.height / 2);
    state.minimap = null;
  }
}

// Tears down screen-UI display objects and their view-owned (non-cache)
// textures — the per-size backdrop and the minimap static layer — then clears
// module-global state so a re-initialized renderer starts fresh.
export function destroyPixiScreenUi(env) {
  if (screenUiViews) {
    const bt = screenUiViews.backdrop.texture;
    if (bt && bt !== env.PIXI.Texture.WHITE) bt.destroy(false);
    screenUiViews.backdrop.destroy({ children: true, texture: false, textureSource: false });
    for (const layer of screenUiViews.starLayers) {
      layer.sprite.destroy({ children: true, texture: false, textureSource: false });
      layer.texture.destroy(true);
    }
    screenUiViews.vignette.destroy({ children: true, texture: false, textureSource: false });
    screenUiViews.vignetteTexture.destroy(true);
    screenUiViews.joinText.destroy({ children: true, texture: false, textureSource: false });
    screenUiViews = null;
  }
  if (minimapView) {
    const mt = minimapView.staticSprite.texture;
    if (mt && mt !== env.PIXI.Texture.EMPTY) mt.destroy(false);
    if (minimapView.root.parent) minimapView.root.parent.removeChild(minimapView.root);
    minimapView.root.destroy({ children: true, texture: false, textureSource: false });
    minimapView = null;
  }
  backdropSize = { width: 0, height: 0 };
}
