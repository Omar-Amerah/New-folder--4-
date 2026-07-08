// Manages and draws visual-only temporary effects (explosions, repair waves, rock hits).

import { ctx } from "../ui/dom.js";
import { state } from "../state.js";
import { clamp } from "../shared/math.js";

export function drawEffects() {
  const snap = state.snapshot;
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
