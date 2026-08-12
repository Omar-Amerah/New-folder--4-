// Protection, repair, drone, decoy, and support-system artwork.

import { ctx } from "../../ui/dom.js";
import { qualityShadowBlur } from "../renderSettings.js";
import { drawComponentPort, drawFootprintPanel, drawFootprintPort, drawFootprintSeams, drawRecessedPanel, mixColor, roundRect } from "./common.js";
import { drawWeaponBase } from "./weapons/index.js";

export function drawSupportModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "weaponMount") {
    const pale = mixColor(color, "#ffffff", 0.62);
    drawRecessedPanel(size, 0.76, 0.76, 0.14);
    drawWeaponBase(size);
    drawComponentPort(size, -0.3, -0.3, 0.045, pale, 0.4);
    drawComponentPort(size, 0.3, -0.3, 0.045, pale, 0.4);
    drawComponentPort(size, -0.3, 0.3, 0.045, pale, 0.4);
    drawComponentPort(size, 0.3, 0.3, 0.045, pale, 0.4);
    return true;
  }

  if (type === "shield") {
    // Projector: a lensed emitter in a dark well throwing three field arcs, with
    // the phase nodes that shape them bolted around the rim. Two bare arcs on an
    // empty panel gave no clue where the field was coming from.
    drawRecessedPanel(size, 0.82, 0.82, 0.18);

    // Field arcs, faintest outermost : the projected barrier.
    const arcs = [[0.4, 0.3], [0.32, 0.52], [0.24, 0.82]];
    for (const [r, alpha] of arcs) {
      ctx.strokeStyle = `rgba(167,243,208,${alpha})`;
      ctx.lineWidth = r > 0.3 ? fine : line;
      ctx.beginPath();
      ctx.arc(0, 0, size * r, Math.PI * 0.16, Math.PI * 1.84);
      ctx.stroke();
    }

    // Emitter well and lens.
    ctx.fillStyle = "rgba(3,20,13,0.9)";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.19, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.shadowColor = "#7cffa0";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#b9ffd0";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.105, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    // Phase nodes on the rim, sitting on the arc gap side so the ring reads open.
    for (let i = 0; i < 3; i += 1) {
      const a = Math.PI * (1.5 + (i - 1) * 0.42);
      drawComponentPort(size, Math.cos(a) * 0.33, Math.sin(a) * 0.33, 0.06, "#a7f3d0", 0.5);
    }
    return true;
  }

  if (type === "decoyLauncher") {
    const inactive = visualState === "inactive" || visualState === "disabled";
    const damaged = visualState === "damaged";
    const signal = damaged ? "#fb7185" : inactive ? "#64748b" : "#7dd3fc";
    const falseLock = damaged ? "#fda4af" : inactive ? "#94a3b8" : "#c4b5fd";

    // The housing is the cell: chamfered emitter wings, radial signal traces,
    // and corner projector nodes all converge on the false-lock beacon.
    ctx.save();
    ctx.fillStyle = "rgba(5,11,24,0.72)";
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.22);
    ctx.lineWidth = Math.max(0.8, size * 0.055);
    ctx.beginPath();
    ctx.moveTo(-size * 0.46, -size * 0.25);
    ctx.lineTo(-size * 0.25, -size * 0.46);
    ctx.lineTo(size * 0.25, -size * 0.46);
    ctx.lineTo(size * 0.46, -size * 0.25);
    ctx.lineTo(size * 0.46, size * 0.25);
    ctx.lineTo(size * 0.25, size * 0.46);
    ctx.lineTo(-size * 0.25, size * 0.46);
    ctx.lineTo(-size * 0.46, size * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Four projector vanes make the role legible even when the glow is absent.
    ctx.fillStyle = mixColor(color, "#071426", 0.5);
    for (let i = 0; i < 4; i += 1) {
      ctx.save();
      ctx.rotate(i * Math.PI / 2);
      ctx.beginPath();
      ctx.moveTo(-size * 0.12, -size * 0.16);
      ctx.lineTo(size * 0.38, -size * 0.29);
      ctx.lineTo(size * 0.43, -size * 0.1);
      ctx.lineTo(size * 0.15, -size * 0.03);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.shadowColor = signal;
    ctx.shadowBlur = qualityShadowBlur(inactive ? 0 : 7);
    ctx.strokeStyle = signal;
    ctx.lineWidth = Math.max(0.8, size * 0.055);
    for (const radius of [0.18, 0.31]) {
      ctx.beginPath();
      ctx.arc(0, 0, size * radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;

    // Offset diamond is a projected false target, not a generic badge.
    ctx.strokeStyle = falseLock;
    ctx.lineWidth = Math.max(1, size * 0.075);
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.16);
    ctx.lineTo(size * 0.16, 0);
    ctx.lineTo(0, size * 0.16);
    ctx.lineTo(-size * 0.16, 0);
    ctx.closePath();
    ctx.stroke();
    drawComponentPort(size, 0, 0, 0.09, inactive ? "#64748b" : "#eff6ff", 0.58);

    for (const [x, y] of [[-0.35, -0.35], [0.35, -0.35], [-0.35, 0.35], [0.35, 0.35]]) {
      drawComponentPort(size, x, y, 0.07, signal, inactive ? 0.32 : 0.58);
    }

    if (damaged) {
      ctx.strokeStyle = "#fecaca";
      ctx.lineWidth = Math.max(0.8, size * 0.05);
      ctx.beginPath();
      ctx.moveTo(-size * 0.28, -size * 0.08);
      ctx.lineTo(-size * 0.08, size * 0.02);
      ctx.lineTo(size * 0.02, size * 0.24);
      ctx.lineTo(size * 0.24, size * 0.32);
      ctx.stroke();
    }
    ctx.restore();
    return true;
  }
  if (type === "repair") {
    drawRecessedPanel(size, 0.74, 0.74, 0.16);
    ctx.fillStyle = "#bbf7d0";
    roundRect(ctx, { x: -size * 0.09, y: -size * 0.3, width: size * 0.18, height: size * 0.6, radius: size * 0.035 }); ctx.fill();
    roundRect(ctx, { x: -size * 0.3, y: -size * 0.09, width: size * 0.6, height: size * 0.18, radius: size * 0.035 }); ctx.fill();
    return true;
  }

  if (type === "signalAmplifier") {
    drawRecessedPanel(size, 0.76, 0.76, 0.14);
    ctx.fillStyle = "#5eead4"; ctx.fillRect(-size * 0.05, -size * 0.28, size * 0.1, size * 0.56);
    ctx.strokeStyle = "#ccfbf1"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.22, -Math.PI * 0.62, -Math.PI * 0.38); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, size * 0.34, -Math.PI * 0.62, -Math.PI * 0.38); ctx.stroke();
    return true;
  }
  if (type === "stabilizerNode") {
    drawRecessedPanel(size, 0.76, 0.76, 0.16);
    ctx.strokeStyle = "#c4b5fd"; ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(0, -size * 0.33); ctx.lineTo(size * 0.13, -size * 0.13); ctx.lineTo(size * 0.33, 0);
    ctx.lineTo(size * 0.13, size * 0.13); ctx.lineTo(0, size * 0.33); ctx.lineTo(-size * 0.13, size * 0.13);
    ctx.lineTo(-size * 0.33, 0); ctx.lineTo(-size * 0.13, -size * 0.13); ctx.closePath(); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.11, "#ddd6fe", 0.5);
    return true;
  }

  return false;
}

export function drawSupportFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "overclockedRepair") {
    // The standard Repair module's cross, driven hard: a doubled emitter cross
    // on a machined bed, flanked by two exposed heat-stressed drive stacks that
    // say where all that Power goes and why the part cooks itself.
    drawFootprintPanel(unit, hl, hc, 0.94, 0.9, 0.1);

    ctx.save();
    ctx.shadowColor = "#86efac";
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = "#d7ffe2";
    const armLong = hl * 0.44;
    const armCross = hc * 0.62;
    const armHalf = Math.min(unit * 0.11, hc * 0.16);
    ctx.fillRect(-armLong, -armHalf, armLong * 2, armHalf * 2);
    ctx.fillRect(-armHalf, -armCross, armHalf * 2, armCross * 2);
    ctx.restore();

    // Drive stacks at both ends, running warm.
    for (const sx of [-hl * 0.76, hl * 0.76]) {
      ctx.fillStyle = mixColor(color, "#05070c", 0.42);
      ctx.strokeStyle = "rgba(3,6,12,0.72)";
      ctx.lineWidth = Math.max(0.8, unit * 0.05);
      roundRect(ctx, { x: sx - unit * 0.16, y: -hc * 0.56, width: unit * 0.32, height: hc * 1.12, radius: unit * 0.05 });
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.shadowColor = "#fb923c";
      ctx.shadowBlur = qualityShadowBlur(5);
      ctx.fillStyle = "#fdba74";
      for (const cy of [-hc * 0.3, 0, hc * 0.3]) {
        ctx.fillRect(sx - unit * 0.1, cy - unit * 0.03, unit * 0.2, unit * 0.06);
      }
      ctx.restore();
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "droneBay") {
    // Launch deck: a translucent bay opening (keeps the lit hull cube showing
    // through, like every other multi-tile module) with three recessed docking
    // cradles for the squad and a bright central launch rail. One signature
    // accent : cyan : instead of the former flat crosshair on an opaque box.
    drawFootprintPanel(unit, hl, hc, 0.9, 0.9, 0.14);

    const accent = "#67e8f9";
    const cradleFill = mixColor(color, "#04121f", 0.42);
    const bays = 3; // matches the drone squad size
    const span = hl * 1.5;
    const cradleW = span / bays;
    for (let i = 0; i < bays; i += 1) {
      const cx = -span * 0.5 + cradleW * (i + 0.5);
      ctx.fillStyle = cradleFill;
      roundRect(ctx, { x: cx - cradleW * 0.34, y: -hc * 0.5, width: cradleW * 0.68, height: hc, radius: unit * 0.06 });
      ctx.fill();
      ctx.strokeStyle = "rgba(225,238,255,0.22)";
      ctx.lineWidth = fine;
      ctx.stroke();
      drawFootprintPort(unit, cx, 0, unit * 0.1, accent);
    }

    // Central launch rail down the long axis with a restrained glow.
    ctx.save();
    ctx.shadowColor = accent;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.strokeStyle = "#a5f3fc";
    ctx.lineWidth = Math.max(fine, unit * 0.06);
    ctx.beginPath();
    ctx.moveTo(-span * 0.5, 0);
    ctx.lineTo(span * 0.5, 0);
    ctx.stroke();
    ctx.restore();

    drawFootprintSeams(unit, hl, hc, Math.max(2, tilesLong));
    return true;
  }

  return false;
}
