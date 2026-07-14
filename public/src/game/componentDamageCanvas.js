// Offscreen/UI Canvas helpers for per-component damage tints and hit flashes.
// These paint into whatever 2D context the caller is drawing to (the ship
// damage panel canvas, or an offscreen bake surface) — they are UI artwork
// helpers, not an arena renderer. No arena render loop lives here.

import { state } from "../state.js";
import { clamp } from "../shared/math.js";
import { CRITICAL_RATIO, DAMAGED_RATIO } from "./componentDamage.js";

// Persistent status tint for a module: healthy renders untouched, damaged gets
// a subtle amber wash, critical a stronger red pulse, destroyed a dark broken
// slab. In Component Damage View (state.componentDamageView) the tints are
// stronger and applied from full health thresholds so status reads at a glance.
// Drawn in the local space the module was just drawn in (centred, maybe rotated).
export function drawModuleDamage(drawCtx, ratio, halfW, halfH, now = 0) {
  if (ratio === null) return;
  const overlay = Boolean(state.componentDamageView);
  if (ratio >= DAMAGED_RATIO && !(overlay && ratio < 0.999)) return;
  const w = halfW * 2;
  const h = halfH * 2;
  if (ratio <= 0) {
    // Destroyed: near-black slab with jagged crack lines.
    drawCtx.fillStyle = overlay ? "rgba(52, 58, 66, 0.85)" : "rgba(7, 9, 13, 0.78)";
    drawCtx.fillRect(-halfW, -halfH, w, h);
    drawCtx.strokeStyle = "rgba(0, 0, 0, 0.85)";
    drawCtx.lineWidth = Math.max(1, halfW * 0.16);
    drawCtx.beginPath();
    drawCtx.moveTo(-halfW * 0.8, -halfH * 0.7);
    drawCtx.lineTo(-halfW * 0.1, -halfH * 0.05);
    drawCtx.lineTo(halfW * 0.35, halfH * 0.25);
    drawCtx.lineTo(halfW * 0.85, halfH * 0.75);
    drawCtx.moveTo(halfW * 0.7, -halfH * 0.8);
    drawCtx.lineTo(halfW * 0.1, -halfH * 0.1);
    drawCtx.lineTo(-halfW * 0.4, halfH * 0.5);
    drawCtx.stroke();
    drawCtx.strokeStyle = "rgba(255, 120, 60, 0.35)";
    drawCtx.lineWidth = Math.max(0.6, halfW * 0.08);
    drawCtx.beginPath();
    drawCtx.moveTo(-halfW * 0.1, -halfH * 0.05);
    drawCtx.lineTo(halfW * 0.35, halfH * 0.25);
    drawCtx.stroke();
  } else if (ratio <= CRITICAL_RATIO) {
    // Critical: red wash with a slow pulse so it draws the eye without a glow.
    const pulse = 0.72 + 0.28 * Math.sin(now * 0.008);
    const alpha = (overlay ? 0.5 : 0.4) * pulse;
    drawCtx.fillStyle = `rgba(239, 68, 68, ${alpha})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
  } else {
    // Damaged: subtle amber tint deepening toward critical.
    const depth = clamp((DAMAGED_RATIO - ratio) / DAMAGED_RATIO, 0, 1);
    const alpha = overlay ? 0.2 + depth * 0.35 : 0.12 + depth * 0.3;
    drawCtx.fillStyle = `rgba(251, 176, 64, ${alpha})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
  }
}

// Short hit flash over one module: orange impact for armour plates, red/white
// for internal components, a brighter expanding pop when the hit destroyed it.
// Timers live client-side (componentDamage.js); nothing here touches the server.
export function drawModuleFlash(drawCtx, flash, halfW, halfH) {
  if (!flash) return;
  const s = flash.strength;
  const w = halfW * 2;
  const h = halfH * 2;
  if (flash.destroyed) {
    const grow = 1 + (1 - s) * 0.9;
    drawCtx.fillStyle = `rgba(255, 236, 210, ${0.75 * s})`;
    drawCtx.fillRect(-halfW * grow, -halfH * grow, w * grow, h * grow);
    drawCtx.strokeStyle = `rgba(255, 140, 60, ${0.9 * s})`;
    drawCtx.lineWidth = Math.max(1, halfW * 0.2);
    drawCtx.strokeRect(-halfW * grow, -halfH * grow, w * grow, h * grow);
  } else if (flash.layer === "armor") {
    drawCtx.fillStyle = `rgba(255, 158, 44, ${0.65 * s})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
    drawCtx.strokeStyle = `rgba(255, 214, 130, ${0.85 * s})`;
    drawCtx.lineWidth = Math.max(0.8, halfW * 0.14);
    drawCtx.beginPath();
    drawCtx.moveTo(-halfW * 0.6, halfH * 0.5);
    drawCtx.lineTo(0, -halfH * 0.2);
    drawCtx.lineTo(halfW * 0.55, halfH * 0.4);
    drawCtx.stroke();
  } else {
    drawCtx.fillStyle = `rgba(255, 92, 92, ${0.6 * s})`;
    drawCtx.fillRect(-halfW, -halfH, w, h);
    drawCtx.fillStyle = `rgba(255, 245, 245, ${0.5 * s * s})`;
    drawCtx.fillRect(-halfW * 0.55, -halfH * 0.55, w * 0.55, h * 0.55);
  }
}
