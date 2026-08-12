// Command cores, backup cores, and command-deck role artwork.

import { ctx } from "../../ui/dom.js";
import { qualityShadowBlur } from "../renderSettings.js";
import { drawComponentPort, drawFootprintMachineFrame, drawFootprintPanel, drawFootprintPlate, drawFootprintPort, drawFootprintSeams, drawRecessedPanel, mixColor, roundRect } from "./common.js";

function drawBackupCoreAssembly(unit, tilesLong, hl, hc, color) {
  // Multi-cell version of the single-cell backup core badge: recessed panel,
  // violet command ring with a crosshair, and link nodes along the long axis.
  const fine = Math.max(0.7, unit * 0.045);
  const line = Math.max(1, unit * 0.075);
  const ringR = Math.min(hc * 0.54, hl * 0.34);

  drawFootprintPanel(unit, hl, hc, 0.9, 0.8, 0.14);

  ctx.strokeStyle = "rgba(196,181,253,0.55)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.moveTo(-hl * 0.72, 0);
  ctx.lineTo(hl * 0.72, 0);
  ctx.stroke();

  ctx.strokeStyle = "#c4b5fd";
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(0, 0, ringR, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#8b5cf6";
  roundRect(ctx, { x: -ringR * 0.16, y: -ringR * 1.16, width: ringR * 0.32, height: ringR * 2.32, radius: unit * 0.03 });
  ctx.fill();
  roundRect(ctx, { x: -ringR * 1.16, y: -ringR * 0.16, width: ringR * 2.32, height: ringR * 0.32, radius: unit * 0.03 });
  ctx.fill();

  drawFootprintPort(unit, 0, 0, unit * 0.12, "#f5f3ff");
  drawFootprintPort(unit, -hl * 0.72, 0, unit * 0.09, "#a78bfa");
  drawFootprintPort(unit, hl * 0.72, 0, unit * 0.09, "#a78bfa");

  drawFootprintSeams(unit, hl, hc, tilesLong);
}

const COMMAND_ROLE_ART = Object.freeze({
  fireControlCommandCentre: { accent: "#fdba74", glyph: "targetLock" },
  fleetDefenceCoordinator: { accent: "#fca5a5", glyph: "escort" },
  shieldCommandRelay: { accent: "#86efac", glyph: "shieldArcs" },
  engineeringCommandCentre: { accent: "#93c5fd", glyph: "damageControl" },
  propulsionCommandRelay: { accent: "#67e8f9", glyph: "vector" },
  electronicWarfareCommandCentre: { accent: "#d8b4fe", glyph: "jammer" }
});

function drawCommandRoleGlyph(glyph, unit, r, accent) {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = Math.max(0.9, unit * 0.06);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (glyph === "targetLock") {
    // Fire control: a lock box drawn as four corner brackets around a pip.
    const g = r * 0.62;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx * g, sy * g * 0.36);
      ctx.lineTo(sx * g, sy * g);
      ctx.lineTo(sx * g * 0.36, sy * g);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
  } else if (glyph === "escort") {
    // Fleet defence: an escort wedge sheltering two flanking hulls.
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.62);
    ctx.lineTo(r * 0.5, r * 0.16);
    ctx.lineTo(0, r * 0.4);
    ctx.lineTo(-r * 0.5, r * 0.16);
    ctx.closePath();
    ctx.stroke();
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(sx * r * 0.66, r * 0.5, r * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (glyph === "shieldArcs") {
    // Shield relay: the shield module's open-bottom arcs, doubled.
    for (const scale of [0.72, 0.44]) {
      ctx.beginPath();
      ctx.arc(0, 0, r * scale, Math.PI * 0.18, Math.PI * 1.82);
      ctx.stroke();
    }
  } else if (glyph === "damageControl") {
    // Engineering: a hex service plate around a repair cross.
    ctx.beginPath();
    for (let i = 0; i < 6; i += 1) {
      const a = i * (Math.PI / 3) + Math.PI / 6;
      const x = Math.cos(a) * r * 0.66;
      const y = Math.sin(a) * r * 0.66;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r * 0.3, 0); ctx.lineTo(r * 0.3, 0);
    ctx.moveTo(0, -r * 0.3); ctx.lineTo(0, r * 0.3);
    ctx.stroke();
  } else if (glyph === "vector") {
    // Propulsion relay: stacked thrust chevrons along the long axis.
    for (const dx of [-0.4, 0.06]) {
      ctx.beginPath();
      ctx.moveTo(r * dx, -r * 0.5);
      ctx.lineTo(r * (dx + 0.42), 0);
      ctx.lineTo(r * dx, r * 0.5);
      ctx.stroke();
    }
  } else if (glyph === "jammer") {
    // Electronic warfare: mirrored emission fans instead of one aimed beam.
    for (const sx of [-1, 1]) {
      for (const scale of [0.38, 0.68]) {
        const from = sx > 0 ? -Math.PI * 0.3 : Math.PI * 0.7;
        ctx.beginPath();
        ctx.arc(0, 0, r * scale, from, from + Math.PI * 0.6);
        ctx.stroke();
      }
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawCommandDeckAssembly(type, unit, tilesLong, tilesCross, hl, hc, color) {
  const role = COMMAND_ROLE_ART[type];
  const accent = role ? role.accent : mixColor(color, "#ffffff", 0.5);
  const fine = Math.max(0.7, unit * 0.045);
  const line = Math.max(1, unit * 0.075);
  const ringR = Math.min(hc * 0.62, hl * 0.46);
  const nodeX = hl - unit * 0.3;

  drawFootprintPanel(unit, hl, hc, 0.9, 0.84, 0.14);

  ctx.save();
  ctx.strokeStyle = "rgba(226,237,250,0.3)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.moveTo(-nodeX, 0);
  ctx.lineTo(nodeX, 0);
  ctx.stroke();

  // Flanking workstations; only decks two cells across have room for them.
  if (tilesCross > 1) {
    ctx.strokeStyle = mixColor(accent, "#05070c", 0.42);
    ctx.lineWidth = Math.max(1, unit * 0.07);
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl * 0.58, sy * hc * 0.62);
      ctx.lineTo(hl * 0.58, sy * hc * 0.62);
      ctx.stroke();
    }
    for (const sy of [-1, 1]) {
      for (const sx of [-1, 1]) {
        drawFootprintPort(unit, sx * hl * 0.58, sy * hc * 0.62, unit * 0.075, accent);
      }
    }
  }
  ctx.restore();

  // Command ring: dark instrument well with a lit accent rim.
  ctx.save();
  ctx.fillStyle = "rgba(4,9,17,0.8)";
  ctx.beginPath();
  ctx.arc(0, 0, ringR, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = accent;
  ctx.lineWidth = line;
  ctx.stroke();
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.5);
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.arc(0, 0, ringR * 0.86, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  drawCommandRoleGlyph(role ? role.glyph : "targetLock", unit, ringR, accent);

  drawFootprintPort(unit, -nodeX, 0, unit * 0.11, mixColor(accent, "#ffffff", 0.45));
  drawFootprintPort(unit, nodeX, 0, unit * 0.11, mixColor(accent, "#ffffff", 0.45));

  drawFootprintSeams(unit, hl, hc, tilesLong);
}

export function drawCommandModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "core") {
    drawRecessedPanel(size, 0.78, 0.78, 0.16);
    ctx.strokeStyle = "rgba(116,225,255,0.7)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.29, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#dff9ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(3,25,38,0.78)";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.moveTo(-size * 0.34, 0); ctx.lineTo(-size * 0.21, 0);
    ctx.moveTo(size * 0.21, 0); ctx.lineTo(size * 0.34, 0);
    ctx.moveTo(0, -size * 0.34); ctx.lineTo(0, -size * 0.21);
    ctx.moveTo(0, size * 0.21); ctx.lineTo(0, size * 0.34);
    ctx.stroke();
    return true;
  }

  if (type === "backupCore") {
    drawRecessedPanel(size, 0.8, 0.76, 0.14);
    ctx.strokeStyle = "#c4b5fd";
    ctx.lineWidth = line;
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.27, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#8b5cf6";
    ctx.fillRect(-size * 0.06, -size * 0.3, size * 0.12, size * 0.6);
    ctx.fillRect(-size * 0.3, -size * 0.06, size * 0.6, size * 0.12);
    drawComponentPort(size, 0, 0, 0.09, "#f5f3ff", 0.55);
    return true;
  }

  return false;
}

export function drawCommandFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "backupCore") {
    drawBackupCoreAssembly(unit, tilesLong, hl, hc, color);
    return true;
  }

  if (COMMAND_ROLE_ART[type]) {
    drawCommandDeckAssembly(type, unit, tilesLong, tilesCross, hl, hc, color);
    return true;
  }

  return false;
}

