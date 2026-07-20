// Boots the arena renderer. There is one backend only: PixiJS (WebGL). There is
// no Canvas 2D arena fallback and no Canvas arena animation loop. (Offscreen
// Canvas 2D is still used elsewhere to bake Pixi textures and UI artwork.)

import { dom } from "../ui/dom.js";
import { initPixiRenderer, resizePixiRenderer, getPixiRuntimeDiagnostics } from "./pixi/pixiRenderer.js";

let activeBackend = null;

export async function initArenaRenderer() {
  if (activeBackend) return activeBackend;
  try {
    await initPixiRenderer();
    activeBackend = "pixi";
    publishRendererBackend();
    return activeBackend;
  } catch (err) {
    // No silent fallback: WebGL is required. Surface a clear fatal message and
    // stop — do not start any alternative renderer or partial game loop.
    console.error("[render] PixiJS/WebGL initialization failed:", err);
    showWebGlFatalMessage();
    throw err;
  }
}

export function resizeArenaRenderer() {
  if (activeBackend === "pixi") resizePixiRenderer();
}

function publishRendererBackend() {
  if (typeof window !== "undefined") {
    window.__mfaRenderer = { backend: activeBackend, diagnostics: getPixiRuntimeDiagnostics };
  }
}

// Renders a clear, user-facing fatal message in the arena area. No fallback
// renderer is started.
function showWebGlFatalMessage() {
  const message = "This game requires WebGL to render the battle.";
  try {
    const host = dom.canvas?.parentElement || document.body;
    if (!host) return;
    let overlay = document.getElementById("arenaFatalMessage");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "arenaFatalMessage";
      overlay.setAttribute("role", "alert");
      overlay.style.cssText = [
        "position:absolute", "inset:0", "display:flex",
        "align-items:center", "justify-content:center", "text-align:center",
        "padding:24px", "z-index:50", "pointer-events:none",
        "color:#e8f0ff", "background:rgba(4,7,16,0.92)",
        "font:600 18px/1.5 system-ui, sans-serif"
      ].join(";");
      host.appendChild(overlay);
    }
    overlay.textContent = message;
    overlay.hidden = false;
  } catch {
    // If even the DOM message cannot be shown, the console error above stands.
  }
}
