// Chooses and boots the arena rendering backend: PixiJS (WebGL) when available, Canvas 2D as fallback.

import { dom, acquireArenaCtx, replaceArenaCanvasElement } from "../ui/dom.js";
import { resizeCanvas, frame } from "./renderer.js";
import { initPixiRenderer, resizePixiRenderer } from "./pixi/pixiRenderer.js";
import { bindArenaPointerListeners } from "./input.js";

let activeBackend = null;

export function getActiveRendererBackend() {
  return activeBackend;
}

export async function initArenaRenderer() {
  if (activeBackend) return activeBackend;
  const forced = readForcedRendererBackend();
  if (forced === "canvas") {
    console.warn("[render] Canvas 2D renderer forced via mfa.rendererBackend.");
    return startCanvas2dFallback();
  }
  if (!probeWebGlSupport()) {
    console.error("[render] WebGL unavailable, falling back to Canvas 2D renderer.");
    return startCanvas2dFallback();
  }
  try {
    await initPixiRenderer();
    activeBackend = "pixi";
    publishRendererBackend();
    return activeBackend;
  } catch (err) {
    console.error("[render] PixiJS init failed, falling back to Canvas 2D renderer:", err);
    return startCanvas2dFallback();
  }
}

export function resizeArenaRenderer() {
  if (activeBackend === "pixi") {
    resizePixiRenderer();
  } else if (activeBackend === "canvas2d") {
    resizeCanvas();
  }
}

function readForcedRendererBackend() {
  try {
    return localStorage.getItem("mfa.rendererBackend");
  } catch {
    return null;
  }
}

// Probes WebGL on a scratch canvas so a doomed init never claims the arena canvas.
function probeWebGlSupport() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch {
    return false;
  }
}

function startCanvas2dFallback() {
  if (!acquireArenaCtx()) {
    // A failed WebGL init may have claimed the canvas; swap in a fresh element.
    replaceArenaCanvasElement();
    bindArenaPointerListeners(dom.canvas);
    acquireArenaCtx();
  }
  resizeCanvas();
  requestAnimationFrame(frame);
  activeBackend = "canvas2d";
  publishRendererBackend();
  return activeBackend;
}

function publishRendererBackend() {
  if (typeof window !== "undefined") {
    window.__mfaRenderer = { backend: activeBackend };
  }
}
