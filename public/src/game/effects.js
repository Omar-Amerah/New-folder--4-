// Manages and draws visual-only temporary effects (explosions, repair waves, rock hits).

import { ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp } from "../shared/math.js";
import { getCombatEffectsEnabled, getRenderQuality } from "./renderSettings.js";

export function drawEffects() {
  const snap = state.snapshot;
  const combatEffectsEnabled = getCombatEffectsEnabled();
  if (!snap) return;
  if(state.debugStats) state.debugStats.totalEffects = snap.effects.length;
  let drawn = 0;
  for (const effect of snap.effects) {
    drawn++;
    const age = effect.age || 0;
    const t = clamp(age / 900, 0, 1);
    ctx.save();
    ctx.translate(effect.x, effect.y);
    ctx.globalAlpha = 1 - t;
    if (effect.type === "beam") {
      const beamT = clamp(age / 120, 0, 1);
      const x2 = (effect.x2 || effect.x) - effect.x;
      const y2 = (effect.y2 || effect.y) - effect.y;
      const radius = effect.radius || 24;
      ctx.globalAlpha = 1 - beamT * 0.65;
      ctx.lineCap = "round";
      ctx.shadowColor = "#7dd3fc";
      ctx.shadowBlur = 24;
      ctx.strokeStyle = "rgba(14, 165, 233, 0.18)";
      ctx.lineWidth = radius * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.strokeStyle = "rgba(125, 211, 252, 0.68)";
      ctx.lineWidth = Math.max(radius * 0.82, 7 / state.camera.zoom);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "rgba(240, 253, 255, 0.95)";
      ctx.lineWidth = Math.max(radius * 0.16, 1.7 / state.camera.zoom);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    } else if (effect.type === "boom") {
      ctx.fillStyle = "#ffca57";
      ctx.beginPath();
      ctx.arc(0, 0, 18 + t * 64, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ff5f7e";
      ctx.lineWidth = 5 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 34 + t * 84, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "repair") {
      ctx.strokeStyle = "#67e08a";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 16 + t * 28, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "railhit") {
      ctx.strokeStyle = "#f4f7ff";
      ctx.lineWidth = 3 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-24 - t * 24, 0);
      ctx.lineTo(24 + t * 24, 0);
      ctx.moveTo(0, -24 - t * 24);
      ctx.lineTo(0, 24 + t * 24);
      ctx.stroke();
    } else if (effect.type === "rockhit") {
      ctx.fillStyle = "rgba(196,174,142,0.82)";
      ctx.beginPath();
      ctx.arc(0, 0, 5 + t * 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,226,175,0.72)";
      ctx.lineWidth = 2 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-10 - t * 12, -4);
      ctx.lineTo(8 + t * 18, 5);
      ctx.stroke();
    } else if (effect.type === "dmg" || effect.type === "text") {
      if (combatEffectsEnabled) {
        ctx.translate(0, -t * 30);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        if (effect.type === "dmg") {
          ctx.font = `bold ${Math.max(12, 16 / state.camera.zoom)}px monospace`;
          ctx.fillStyle = effect.isShield ? "#7dd3fc" : "#ff5f7e";
          ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
          ctx.lineWidth = 3 / state.camera.zoom;
          const text = Math.round(effect.amount).toString();
          ctx.strokeText(text, 0, 0);
          ctx.fillText(text, 0, 0);
        } else {
          ctx.font = `bold ${Math.max(10, 14 / state.camera.zoom)}px sans-serif`;
          ctx.fillStyle = "#e2e8f0";
          ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
          ctx.lineWidth = 3 / state.camera.zoom;
          ctx.strokeText(effect.text, 0, 0);
          ctx.fillText(effect.text, 0, 0);
        }
      }
    } else if (effect.type === "burst") {
      ctx.fillStyle = "#ffca57";
      ctx.beginPath();
      ctx.arc(0, 0, 12 + t * 40, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ff9a57";
      ctx.lineWidth = 4 / state.camera.zoom;
      ctx.beginPath();
      ctx.arc(0, 0, 20 + t * 50, 0, Math.PI * 2);
      ctx.stroke();
    } else if (effect.type === "spark") {
      ctx.fillStyle = "#f3f7ff";
      ctx.beginPath();
      ctx.arc(0, 0, 6 + t * 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#a5c2ff";
      ctx.lineWidth = 2 / state.camera.zoom;
      ctx.beginPath();
      ctx.moveTo(-8 - t * 16, 0);
      ctx.lineTo(8 + t * 16, 0);
      ctx.moveTo(0, -8 - t * 16);
      ctx.lineTo(0, 8 + t * 16);
      ctx.stroke();
    } else if (effect.type === "despawn") {
      const q = getRenderQuality();
      if (q === "low") {
        ctx.fillStyle = "#ffca57";
        ctx.beginPath();
        ctx.arc(0, 0, 4 + t * 8, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const subtype = effect.subtype || "missile";
        const isSwarm = subtype === "swarmMissile";
        const isTorpedo = subtype === "torpedo";
        const isInterceptor = subtype === "interceptorPod";
        const isFlak = subtype === "flakCannon";

        if (isInterceptor) {
           ctx.fillStyle = "#e9d5ff";
           ctx.beginPath();
           ctx.arc(0, 0, 3 + t * 12, 0, Math.PI * 2);
           ctx.fill();
           ctx.strokeStyle = "#a855f7";
           ctx.lineWidth = 2 / state.camera.zoom;
           ctx.beginPath();
           ctx.moveTo(-6 - t * 12, 0);
           ctx.lineTo(6 + t * 12, 0);
           ctx.moveTo(0, -6 - t * 12);
           ctx.lineTo(0, 6 + t * 12);
           ctx.stroke();
        } else if (isFlak) {
           ctx.fillStyle = "#f97316";
           ctx.beginPath();
           ctx.arc(0, 0, 4 + t * 14, 0, Math.PI * 2);
           ctx.fill();
           ctx.strokeStyle = "#fdba74";
           ctx.lineWidth = 2 / state.camera.zoom;
           ctx.beginPath();
           ctx.arc(0, 0, 6 + t * 18, 0, Math.PI * 2);
           ctx.stroke();
        } else if (isSwarm) {
           ctx.fillStyle = "#c084fc";
           ctx.beginPath();
           ctx.arc(0, 0, 2 + t * 6, 0, Math.PI * 2);
           ctx.fill();
        } else if (isTorpedo) {
           ctx.fillStyle = "#ff7e5f";
           ctx.beginPath();
           ctx.arc(0, 0, 8 + t * 24, 0, Math.PI * 2);
           ctx.fill();
           ctx.strokeStyle = "#ff9a57";
           ctx.lineWidth = 3 / state.camera.zoom;
           ctx.beginPath();
           ctx.arc(0, 0, 12 + t * 30, 0, Math.PI * 2);
           ctx.stroke();
        } else {
           ctx.fillStyle = "#ffca57";
           ctx.beginPath();
           ctx.arc(0, 0, 4 + t * 12, 0, Math.PI * 2);
           ctx.fill();
           ctx.strokeStyle = "#ff9a57";
           ctx.lineWidth = 2 / state.camera.zoom;
           ctx.beginPath();
           ctx.arc(0, 0, 6 + t * 16, 0, Math.PI * 2);
           ctx.stroke();
        }
      }
    } else {
      ctx.fillStyle = effect.type === "warp" ? "#38d5ff" : "#f3f7ff";
      ctx.beginPath();
      ctx.arc(0, 0, 8 + t * 32, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  if(state.debugStats) state.debugStats.drawnEffects = drawn;
}
