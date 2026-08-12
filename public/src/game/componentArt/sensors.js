// Omnidirectional, directed, and targeting sensor artwork.

import { ctx } from "../../ui/dom.js";
import { drawComponentPort, drawFootprintPanel, drawFootprintPort, drawFootprintSeams, drawRecessedPanel, mixColor, roundRect } from "./common.js";

function drawSensorScope(unit, radius, accent, hot, rings = 2) {
  const fine = Math.max(0.6, unit * 0.035);

  ctx.save();
  ctx.fillStyle = "rgba(4,13,23,0.88)";
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.32);
  ctx.lineWidth = Math.max(0.9, unit * 0.06);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // The sweep's afterglow, laid down first so the graticule stays legible over
  // it. Clipped to the well so the wedge can never spill onto the housing, and
  // stacked in narrowing bands so the tail fades behind the sweep line instead
  // of ending on a hard edge.
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.95, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = accent;
  for (const trail of [0.72, 0.44, 0.24]) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, -Math.PI * trail, -Math.PI * 0.1);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = fine;
  ctx.globalAlpha = 0.32;
  ctx.beginPath();
  ctx.moveTo(-radius * 0.92, 0);
  ctx.lineTo(radius * 0.92, 0);
  ctx.moveTo(0, -radius * 0.92);
  ctx.lineTo(0, radius * 0.92);
  ctx.stroke();
  ctx.globalAlpha = 0.72;
  for (let i = 1; i <= rings; i += 1) {
    ctx.beginPath();
    ctx.arc(0, 0, radius * (i / (rings + 1)) * 0.94, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Leading edge of the sweep, the one bright line on the face.
  ctx.save();
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.5);
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(-Math.PI * 0.1) * radius * 0.94, Math.sin(-Math.PI * 0.1) * radius * 0.94);
  ctx.stroke();
  ctx.restore();

  drawFootprintPort(unit, 0, 0, Math.max(1, radius * 0.26), hot);
}

function drawDirectedSensorArray(unit, hl, hc, accent, hot, elements = 4) {
  const fine = Math.max(0.6, unit * 0.04);
  const dishX = -hl * 0.06;      // dish rim plane
  const bow = hl * 0.34;         // how far the dish bows forward of the rim
  const aperture = hc * 0.78;    // dish half-height
  const reach = hl * 0.94;       // front of the watched cone

  // The cone first, so the hardware sits on top of it. Stacked in shortening
  // bands so it dims with distance rather than ending on a flat edge.
  ctx.save();
  ctx.globalAlpha = 0.13;
  ctx.fillStyle = accent;
  const throatX = dishX + bow * 0.4;
  for (const depth of [1, 0.66, 0.34]) {
    const frontX = throatX + (reach - throatX) * depth;
    const frontY = aperture * 0.62 + (hc * 0.92 - aperture * 0.62) * depth;
    ctx.beginPath();
    ctx.moveTo(throatX, -aperture * 0.62);
    ctx.lineTo(frontX, -frontY);
    ctx.lineTo(frontX, frontY);
    ctx.lineTo(throatX, aperture * 0.62);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Phase fronts crossing the cone give it depth without another fill.
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.66;
  ctx.lineWidth = fine;
  for (let i = 1; i <= 2; i += 1) {
    const t = i / 2.6;
    const x = dishX + bow + (reach - dishX - bow) * t;
    const y = aperture * (0.66 + t * 0.3);
    ctx.beginPath();
    ctx.moveTo(x, -y);
    ctx.quadraticCurveTo(x + hl * 0.08, 0, x, y);
    ctx.stroke();
  }
  ctx.restore();

  // Receiver housing and waveguide spine.
  ctx.save();
  ctx.fillStyle = "rgba(4,13,23,0.9)";
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.3);
  ctx.lineWidth = Math.max(0.8, unit * 0.055);
  roundRect(ctx, {
    x: -hl * 0.88,
    y: -hc * 0.46,
    width: hl * 0.46,
    height: hc * 0.92,
    radius: unit * 0.07
  });
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.24);
  ctx.lineWidth = Math.max(1, unit * 0.07);
  ctx.beginPath();
  ctx.moveTo(-hl * 0.42, 0);
  ctx.lineTo(dishX + bow * 0.5, 0);
  ctx.stroke();
  ctx.restore();

  // The dish: a crescent bowed forward, dark inside so the elements read.
  ctx.save();
  ctx.fillStyle = "rgba(5,17,29,0.94)";
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.2);
  ctx.lineWidth = Math.max(0.9, unit * 0.06);
  ctx.beginPath();
  ctx.moveTo(dishX, -aperture);
  ctx.quadraticCurveTo(dishX + bow * 2.1, 0, dishX, aperture);
  ctx.quadraticCurveTo(dishX + bow * 0.9, 0, dishX, -aperture);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // Emitter elements spaced across the aperture, riding the dish midline.
  ctx.save();
  ctx.fillStyle = accent;
  for (let i = 0; i < elements; i += 1) {
    const t = elements === 1 ? 0 : (i / (elements - 1)) * 2 - 1;
    const y = t * aperture * 0.7;
    const x = dishX + bow * 0.75 * (1 - t * t);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.8, unit * 0.055), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  drawFootprintPort(unit, -hl * 0.65, 0, Math.max(1, unit * 0.13), hot);
}

export function drawSensorModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "smallSensor") {
    // Compact omni dish: the shared scope face on a mounting plate, with the
    // same corner telltales the other 1x1 system modules carry.
    drawRecessedPanel(size, 0.82, 0.82, 0.14);
    drawSensorScope(size, size * 0.29, "#67e8f9", "#ecfeff", 2);
    for (const [px, py] of [[-0.37, -0.37], [0.37, -0.37], [-0.37, 0.37], [0.37, 0.37]]) {
      drawComponentPort(size, px, py, 0.055, "#7dd3fc", 0.5);
    }
    return true;
  }
  if (type === "largeSensor") {
    // Same instrument as the small dish, one size up: a wider well with an
    // extra range ring and a bolted mounting collar around it.
    drawRecessedPanel(size, 0.88, 0.88, 0.13);
    ctx.save();
    ctx.strokeStyle = "rgba(103,232,249,0.4)";
    ctx.lineWidth = Math.max(0.7, size * 0.045);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    drawSensorScope(size, size * 0.34, "#67e8f9", "#ecfeff", 3);
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI * (0.25 + i * 0.5);
      drawComponentPort(size, Math.cos(a) * 0.4, Math.sin(a) * 0.4, 0.06, "#a5f3fc", 0.5);
    }
    return true;
  }
  if (type === "smallDirectedSensor" || type === "largeDirectedSensor") {
    // Directional aperture pointing along local +x : the same facing the
    // in-game sensor cone uses.
    const directed = type === "largeDirectedSensor";
    drawRecessedPanel(size, 0.88, 0.82, 0.11);
    drawDirectedSensorArray(size, size * 0.5, size * 0.5, "#a5f3fc", "#ecfeff", directed ? 5 : 3);
    for (const py of [-0.37, 0.37]) {
      drawComponentPort(size, -0.38, py, 0.055, "#7dd3fc", 0.5);
    }
    return true;
  }

  if (type === "targetingComputer") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.strokeStyle = "#e879f9"; ctx.lineWidth = fine;
    ctx.strokeRect(-size * 0.27, -size * 0.27, size * 0.54, size * 0.54);
    ctx.beginPath(); ctx.arc(0, 0, size * 0.13, 0, Math.PI * 2);
    ctx.moveTo(-size * 0.35, 0); ctx.lineTo(-size * 0.12, 0);
    ctx.moveTo(size * 0.12, 0); ctx.lineTo(size * 0.35, 0);
    ctx.moveTo(0, -size * 0.35); ctx.lineTo(0, -size * 0.12);
    ctx.moveTo(0, size * 0.12); ctx.lineTo(0, size * 0.35); ctx.stroke();
    return true;
  }
  if (type === "fireControl") {
    drawRecessedPanel(size, 0.76, 0.76, 0.08);
    ctx.strokeStyle = "#fb923c"; ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.25, size * 0.2); ctx.lineTo(0, -size * 0.25); ctx.lineTo(size * 0.25, size * 0.2); ctx.lineTo(-size * 0.25, size * 0.2); ctx.stroke();
    drawComponentPort(size, -0.25, 0.2, 0.07, "#ffedd5", 0.45);
    drawComponentPort(size, 0, -0.25, 0.07, "#ffedd5", 0.45);
    drawComponentPort(size, 0.25, 0.2, 0.07, "#ffedd5", 0.45);
    return true;
  }

  return false;
}

export function drawSensorFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "largeSensor" || type === "largeDirectedSensor") {
    const directed = type === "largeDirectedSensor";
    const accent = directed ? "#a5f3fc" : "#67e8f9";
    drawFootprintPanel(unit, hl, hc, 0.94, 0.86, 0.12);

    if (directed) {
      // The same aperture as the 1x1 directed sensor, spanning the footprint.
      // It points along local +x, matching the authoritative component rotation
      // the in-game cone uses.
      drawDirectedSensorArray(unit, hl, hc, accent, "#ecfeff", 5);
    } else {
      // One primary scope on the boresight with two secondary apertures on the
      // flanks, so the array stays symmetric like the omni sensor it models.
      const radius = Math.min(hc * 0.82, hl * 0.42);
      ctx.save();
      ctx.strokeStyle = "rgba(226,237,250,0.22)";
      ctx.lineWidth = Math.max(0.7, unit * 0.04);
      ctx.beginPath();
      ctx.moveTo(-hl * 0.74, 0);
      ctx.lineTo(hl * 0.74, 0);
      ctx.stroke();
      ctx.restore();
      for (const sx of [-1, 1]) {
        const x = sx * (radius + unit * 0.22);
        ctx.save();
        ctx.fillStyle = "rgba(4,13,23,0.86)";
        ctx.strokeStyle = mixColor(accent, "#05070c", 0.34);
        ctx.lineWidth = Math.max(0.8, unit * 0.055);
        ctx.beginPath();
        ctx.arc(x, 0, unit * 0.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
        drawFootprintPort(unit, x, 0, unit * 0.09, "#ecfeff");
      }
      drawSensorScope(unit, radius, accent, "#ecfeff", 3);
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  return false;
}

