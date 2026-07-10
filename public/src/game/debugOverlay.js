// Renders the F3 debug overlay (FPS, quality, cull counters) for whichever arena renderer backend is active.

import { dom } from "../ui/dom.js";
import { state } from "../state.js";
import { getRenderQuality, getDebugRendererEnabled, setDebugRendererEnabled } from "./renderSettings.js";

let debugFps = 0;
let debugRenderTimeMs = 0;
let debugLastUpdated = 0;
let debugBackendLabel = "";

export function setDebugFrameStats(fps, renderTimeMs, backendLabel) {
  debugFps = fps;
  debugRenderTimeMs = renderTimeMs;
  if (backendLabel) debugBackendLabel = backendLabel;
}

export function updateDebugOverlay(now, force = false) {
  const isEnabled = getDebugRendererEnabled();
  if (!dom.debugOverlay) return;

  if (!isEnabled) {
    if (dom.debugOverlay.style.display !== "none") dom.debugOverlay.style.display = "none";
    return;
  } else {
    if (dom.debugOverlay.style.display !== "block") dom.debugOverlay.style.display = "block";
  }

  if (!force && now - debugLastUpdated < 250) return; // throttle DOM updates
  debugLastUpdated = now;

  const dpr = window.devicePixelRatio || 1;
  const q = getRenderQuality();
  let maxDpr = 1.5;
  if (q === "low") maxDpr = 1.25;
  if (q === "high") maxDpr = 2.0;
  const actualDpr = Math.max(1, Math.min(maxDpr, dpr)).toFixed(2);

  const text = [
    `FPS: ${debugFps} (${debugRenderTimeMs.toFixed(1)}ms)${debugBackendLabel ? ` [${debugBackendLabel}]` : ""}`,
    `Quality: ${q} (DPR: ${actualDpr})`,
    `Zoom: ${state.camera.zoom.toFixed(2)}`,
    `Ships: ${state.debugStats?.drawnShips || 0} / ${state.debugStats?.totalShips || 0}`,
    `Bullets: ${state.debugStats?.drawnBullets || 0} / ${state.debugStats?.totalBullets || 0}`,
    `Asteroids: ${state.debugStats?.drawnAsteroids || 0} / ${state.debugStats?.totalAsteroids || 0}`,
    `Effects: ${state.debugStats?.drawnEffects || 0} / ${state.debugStats?.totalEffects || 0}`
  ].join("<br>");

  if (dom.debugOverlay.innerHTML !== text) {
    dom.debugOverlay.innerHTML = text;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key === "F3") {
      e.preventDefault();
      const next = !getDebugRendererEnabled();
      setDebugRendererEnabled(next);
      if (dom.debugOverlayToggle) dom.debugOverlayToggle.checked = next;
      updateDebugOverlay(performance.now(), true);
    }
  });

  window.addEventListener("DOMContentLoaded", () => {
    if (dom.debugOverlay) dom.debugOverlay.style.display = getDebugRendererEnabled() ? "block" : "none";
  });
}
