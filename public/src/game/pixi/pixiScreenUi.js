// Screen-space visuals for the PixiJS arena renderer: backdrop gradient,
// parallax starfield, minimap, and the "join a room" prompt.

import { dom } from "../../ui/dom.js";
import { state } from "../../state.js";
import { getMinimapStaticLayer } from "../renderer.js";
import { pixiBakeScreenTexture } from "./pixiBake.js";
import { getRallyPoint } from "../../ui/sidePanelUi.js";

let screenUiViews = null;
let backdropSize = { width: 0, height: 0 };
let minimapView = null;

function ensureScreenUiViews(env) {
  if (screenUiViews) return screenUiViews;
  const PIXI = env.PIXI;

  const backdrop = new PIXI.Sprite(PIXI.Texture.WHITE);
  env.layers.backdropRoot.addChild(backdrop);

  const starContainer = new PIXI.Container();
  env.layers.backdropRoot.addChild(starContainer);
  const stars = state.stars.map((star) => {
    const sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    const color = new PIXI.Color(star.color);
    sprite.tint = color.toNumber();
    sprite.alpha = color.alpha * 0.88;
    sprite.width = star.size;
    sprite.height = star.size;
    starContainer.addChild(sprite);
    return sprite;
  });

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

  screenUiViews = { backdrop, starContainer, stars, joinText };
  return screenUiViews;
}

function updatePixiBackdrop(env, rect) {
  const views = ensureScreenUiViews(env);
  if (backdropSize.width !== rect.width || backdropSize.height !== rect.height) {
    backdropSize = { width: rect.width, height: rect.height };
    const old = views.backdrop.texture;
    views.backdrop.texture = pixiBakeScreenTexture(env, rect.width, rect.height, (bctx) => {
      const gradient = bctx.createLinearGradient(0, 0, rect.width, rect.height);
      gradient.addColorStop(0, "#040710");
      gradient.addColorStop(0.55, "#0a111d");
      gradient.addColorStop(1, "#05070c");
      bctx.fillStyle = gradient;
      bctx.fillRect(0, 0, rect.width, rect.height);
    });
    if (old && old !== env.PIXI.Texture.WHITE) old.destroy(true);
    views.backdrop.width = rect.width;
    views.backdrop.height = rect.height;
  }

  for (let i = 0; i < views.stars.length; i += 1) {
    const star = state.stars[i];
    const sprite = views.stars[i];
    let x = (star.x * rect.width + state.camera.x * star.drift) % rect.width;
    let y = (star.y * rect.height + state.camera.y * star.drift) % rect.height;
    if (x < 0) x += rect.width;
    if (y < 0) y += rect.height;
    sprite.position.set(x, y);
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
  const mask = new PIXI.Graphics();
  content.addChild(staticSprite);
  content.addChild(dots);
  content.mask = mask;
  root.addChild(background);
  root.addChild(content);
  root.addChild(mask);
  env.layers.screenUiRoot.addChild(root);
  minimapView = { root, background, content, staticSprite, dots, mask, w: 0, h: 0, staticCanvas: null };
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
      if (old && old !== env.PIXI.Texture.EMPTY) old.destroy(true);
    }
    view.staticSprite.visible = true;
  } else {
    view.staticSprite.visible = false;
  }

  const dots = view.dots;
  dots.clear();
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
  const rally = getRallyPoint();
  if (rally) {
    dots.circle(rally.x * sx, rally.y * sy, 4.5);
    dots.fill("#67e08a");
    dots.stroke({ width: 1.5, color: "rgba(4,8,14,0.9)" });
  }
  const viewW = rect.width / state.camera.zoom;
  const viewH = rect.height / state.camera.zoom;
  dots.rect((state.camera.x - viewW / 2) * sx, (state.camera.y - viewH / 2) * sy, viewW * sx, viewH * sy);
  dots.stroke({ width: 1, color: "#ffca57" });
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
