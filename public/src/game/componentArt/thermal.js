// Heat transport, storage, and cooling artwork.

import { ctx } from "../../ui/dom.js";
import { qualityShadowBlur } from "../renderSettings.js";
import { drawComponentPort, drawFootprintMachineFrame, drawFootprintPanel, drawFootprintPort, drawRecessedPanel, mixColor, roundRect } from "./common.js";

const PIPE_DIRECTION_VECTORS = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);
const COOLANT_CASING = "#0a2c42";
const COOLANT_FLUID = "#5ecdf0";
const COOLANT_HIGHLIGHT = "#c7f2ff";

function drawHeatPipeTile(size, connectionMask) {
  const mask = (Number(connectionMask) || 0) & 15;
  const directions = [];
  for (let bit = 0; bit < 4; bit += 1) if (mask & (1 << bit)) directions.push(PIPE_DIRECTION_VECTORS[bit]);

  ctx.save();
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";

  // Dark mechanical housing on the same square tile the rest of the catalogue
  // uses, so a pipe run reads as installed hardware and not as loose cabling.
  ctx.fillStyle = "rgba(7,20,31,0.8)";
  ctx.strokeStyle = "rgba(150,206,232,0.26)";
  ctx.lineWidth = Math.max(0.7, size * 0.04);
  roundRect(ctx, { x: -size * 0.46, y: -size * 0.46, width: size * 0.92, height: size * 0.92, radius: size * 0.13 });
  ctx.fill();
  ctx.stroke();

  const casingWidth = Math.max(2, size * 0.34);
  const coolantWidth = Math.max(1, size * 0.17);
  const reach = size * 0.5;

  const runs = (width, style) => {
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.beginPath();
    if (!directions.length) {
      // Isolated pipe: a short capped section that plainly goes nowhere.
      ctx.moveTo(-size * 0.15, 0);
      ctx.lineTo(size * 0.15, 0);
    } else {
      for (const [dx, dy] of directions) {
        ctx.moveTo(0, 0);
        ctx.lineTo(dx * reach, dy * reach);
      }
    }
    ctx.stroke();
  };

  runs(casingWidth, COOLANT_CASING);
  ctx.fillStyle = COOLANT_CASING;
  ctx.beginPath();
  ctx.arc(0, 0, casingWidth * 0.56, 0, Math.PI * 2);
  ctx.fill();
  runs(coolantWidth, COOLANT_FLUID);
  ctx.fillStyle = COOLANT_FLUID;
  ctx.beginPath();
  ctx.arc(0, 0, coolantWidth * 0.62, 0, Math.PI * 2);
  ctx.fill();

  // Coupling flange where each live channel meets the tile edge: this is what
  // makes a connection read as reaching its neighbour rather than stopping short.
  ctx.fillStyle = "rgba(199,242,255,0.6)";
  for (const [dx, dy] of directions) {
    const along = casingWidth * 0.16;
    const across = casingWidth * 0.86;
    const width = dx ? along : across;
    const height = dx ? across : along;
    ctx.fillRect(dx * (reach - along) - width * 0.5, dy * (reach - along) - height * 0.5, width, height);
  }

  // Blanked faces keep the housing symmetric so an endpoint still looks like a
  // sealed pipe end rather than a broken one.
  ctx.fillStyle = "rgba(126,176,201,0.16)";
  for (let bit = 0; bit < 4; bit += 1) {
    if (mask & (1 << bit)) continue;
    const [dx, dy] = PIPE_DIRECTION_VECTORS[bit];
    const width = dx ? size * 0.05 : size * 0.3;
    const height = dx ? size * 0.3 : size * 0.05;
    ctx.fillRect(dx * size * 0.415 - width * 0.5, dy * size * 0.415 - height * 0.5, width, height);
  }

  ctx.restore();
}

function drawHeatVentTile(size, connectionMask) {
  const mask = (Number(connectionMask) || 0) & 15;
  ctx.save();
  ctx.lineJoin = "round";

  // Dark exchanger frame.
  ctx.fillStyle = "rgba(8,22,30,0.86)";
  ctx.strokeStyle = "rgba(150,206,232,0.3)";
  ctx.lineWidth = Math.max(0.7, size * 0.045);
  roundRect(ctx, { x: -size * 0.44, y: -size * 0.44, width: size * 0.88, height: size * 0.88, radius: size * 0.1 });
  ctx.fill();
  ctx.stroke();

  // Exhaust face: a warm plenum behind hard louvre slats. The warmth is what
  // separates a Vent (heat leaving the hull) from the Heat Sink's cold fin
  // stack and the Radiator's fan.
  const plenum = ctx.createLinearGradient(0, -size * 0.3, 0, size * 0.3);
  plenum.addColorStop(0, "#7c2d12");
  plenum.addColorStop(0.55, "#c2410c");
  plenum.addColorStop(1, "#f59e0b");
  ctx.fillStyle = plenum;
  roundRect(ctx, { x: -size * 0.31, y: -size * 0.3, width: size * 0.62, height: size * 0.6, radius: size * 0.05 });
  ctx.fill();

  ctx.fillStyle = "rgba(6,18,26,0.9)";
  for (let i = 0; i < 4; i += 1) {
    ctx.fillRect(-size * 0.31, -size * 0.26 + i * size * 0.155, size * 0.62, size * 0.075);
  }
  ctx.strokeStyle = "rgba(199,242,255,0.35)";
  ctx.lineWidth = Math.max(0.6, size * 0.03);
  ctx.strokeRect(-size * 0.31, -size * 0.3, size * 0.62, size * 0.6);

  // Coolant inlet toward whatever the vent is plumbed to. With nothing attached
  // it still shows a capped port, so the part never looks half-drawn.
  const directions = [];
  for (let bit = 0; bit < 4; bit += 1) if (mask & (1 << bit)) directions.push(PIPE_DIRECTION_VECTORS[bit]);
  const stubs = directions.length ? directions : [[0, 1]];
  ctx.lineCap = "butt";
  for (const pass of [[Math.max(1.6, size * 0.2), COOLANT_CASING], [Math.max(1, size * 0.09), COOLANT_FLUID]]) {
    ctx.strokeStyle = pass[1];
    ctx.lineWidth = pass[0];
    ctx.beginPath();
    for (const [dx, dy] of stubs) {
      ctx.moveTo(dx * size * 0.28, dy * size * 0.28);
      ctx.lineTo(dx * size * 0.5, dy * size * 0.5);
    }
    ctx.stroke();
  }
  for (const [dx, dy] of stubs) drawComponentPort(size, dx * 0.42, dy * 0.42, 0.075, COOLANT_HIGHLIGHT, 0.5);

  ctx.restore();
}

export function drawThermalModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "heatSink") {
    // Cold fin stack on a charged mass block: fins graded bright at the tip and
    // dark at the root, fed from a coolant manifold down one side. The four flat
    // blue bars it replaces read the same as the Heat Vent's louvres; the
    // manifold and the frost-bright tips are what mark this as the cold end.
    drawRecessedPanel(size, 0.84, 0.86, 0.08);

    // Thermal mass the fins are bonded to.
    ctx.fillStyle = "rgba(6,20,34,0.9)";
    ctx.strokeStyle = "rgba(191,219,254,0.3)";
    ctx.lineWidth = fine;
    roundRect(ctx, { x: -size * 0.34, y: -size * 0.36, width: size * 0.68, height: size * 0.72, radius: size * 0.05 });
    ctx.fill();
    ctx.stroke();

    // Fin stack, tips lit. Left ends stop short of the manifold rail.
    const fins = 5;
    for (let i = 0; i < fins; i += 1) {
      const y = -size * 0.3 + i * size * 0.145;
      const fin = ctx.createLinearGradient(0, y, 0, y + size * 0.075);
      fin.addColorStop(0, "#eff6ff");
      fin.addColorStop(0.5, "#93c5fd");
      fin.addColorStop(1, "#1d4ed8");
      ctx.fillStyle = fin;
      ctx.fillRect(-size * 0.19, y, size * 0.5, size * 0.075);
    }

    // Coolant manifold feeding every fin root, capped at both ends.
    ctx.fillStyle = COOLANT_CASING;
    roundRect(ctx, { x: -size * 0.31, y: -size * 0.33, width: size * 0.11, height: size * 0.66, radius: size * 0.05 });
    ctx.fill();
    ctx.strokeStyle = COOLANT_FLUID;
    ctx.lineWidth = Math.max(1, size * 0.055);
    ctx.beginPath();
    ctx.moveTo(-size * 0.255, -size * 0.26);
    ctx.lineTo(-size * 0.255, size * 0.26);
    ctx.stroke();
    // Fin roots tapping the manifold : the bond that makes this one mass.
    ctx.strokeStyle = COOLANT_HIGHLIGHT;
    ctx.lineWidth = Math.max(0.6, size * 0.028);
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const y = -size * 0.263 + i * size * 0.145;
      ctx.moveTo(-size * 0.255, y);
      ctx.lineTo(-size * 0.19, y);
    }
    ctx.stroke();
    drawComponentPort(size, -0.255, -0.31, 0.05, COOLANT_HIGHLIGHT, 0.5);
    drawComponentPort(size, -0.255, 0.31, 0.05, COOLANT_HIGHLIGHT, 0.5);
    return true;
  }
  if (type === "closedCycleCooler") {
    // Sealed refrigeration loop: a dark machinery bay holding a closed circuit
    // of coolant pipe that runs from a capped inlet, round a driven compressor,
    // out through a capped outlet. Reads as plumbing under pressure : nothing
    // like the heat sink's open fin stack or the radiator's bare fan.
    drawRecessedPanel(size, 0.88, 0.88, 0.12);

    // Closed circuit: dark pipe casing with a bright coolant core inside it.
    const loop = (width, stroke) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.beginPath();
      roundRect(ctx, { x: -size * 0.31, y: -size * 0.31, width: size * 0.62, height: size * 0.62, radius: size * 0.16 });
      ctx.stroke();
    };
    loop(Math.max(2, size * 0.16), "rgba(4,26,38,0.92)");
    loop(Math.max(1, size * 0.075), "#5ce1f5");

    // Compressor: a housed rotor with vanes, driven off the loop.
    ctx.fillStyle = "rgba(3,14,22,0.92)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.185, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(186,240,255,0.5)";
    ctx.lineWidth = fine;
    ctx.stroke();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    for (let i = 0; i < 3; i += 1) {
      const a = (i * Math.PI * 2) / 3 - Math.PI / 6;
      ctx.moveTo(Math.cos(a) * size * 0.05, Math.sin(a) * size * 0.05);
      ctx.lineTo(Math.cos(a) * size * 0.15, Math.sin(a) * size * 0.15);
    }
    ctx.stroke();
    drawComponentPort(size, 0, 0, 0.055, "#ecfeff", 0.55);

    // Capped inlet and outlet on opposite faces : a sealed cycle, not an
    // exhaust: the stubs stop at the housing wall.
    ctx.strokeStyle = "rgba(4,26,38,0.92)";
    ctx.lineWidth = Math.max(1.6, size * 0.13);
    ctx.beginPath();
    ctx.moveTo(-size * 0.44, -size * 0.19); ctx.lineTo(-size * 0.31, -size * 0.19);
    ctx.moveTo(size * 0.44, size * 0.19); ctx.lineTo(size * 0.31, size * 0.19);
    ctx.stroke();
    drawComponentPort(size, -0.42, -0.19, 0.075, "#a5f3fc", 0.5);
    drawComponentPort(size, 0.42, 0.19, 0.075, "#a5f3fc", 0.5);

    // Accumulator bottle on the return leg : the sealed charge this loop carries.
    ctx.fillStyle = "rgba(4,26,38,0.92)";
    ctx.strokeStyle = "rgba(165,243,252,0.5)";
    ctx.lineWidth = Math.max(0.7, size * 0.03);
    roundRect(ctx, { x: -size * 0.12, y: size * 0.24, width: size * 0.24, height: size * 0.14, radius: size * 0.06 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#67e8f9";
    roundRect(ctx, { x: -size * 0.08, y: size * 0.275, width: size * 0.11, height: size * 0.07, radius: size * 0.03 });
    ctx.fill();
    return true;
  }
  if (type === "heatPipe") {
    drawHeatPipeTile(size, connectionMask);
    return true;
  }
  if (type === "heatVent") {
    drawHeatVentTile(size, connectionMask, visualState);
    return true;
  }
  if (type === "radiator") {
    // Active cooling fan: visually distinct from the heat sink's passive fin
    // stack. The blueprint overlay separately highlights the actual exposed edge.
    drawRecessedPanel(size, 0.86, 0.86, 0.1);

    // Shroud: a dark duct ring the impeller sits inside, with mounting bolts.
    ctx.fillStyle = "rgba(5,24,36,0.82)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.37, 0, Math.PI * 2);
    ctx.arc(0, 0, size * 0.31, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.strokeStyle = "rgba(155,232,255,0.55)";
    ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.37, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(155,232,255,0.3)";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.31, 0, Math.PI * 2); ctx.stroke();
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI * (0.25 + i * 0.5);
      drawComponentPort(size, Math.cos(a) * 0.34, Math.sin(a) * 0.34, 0.045, "#bae6fd", 0.45);
    }

    // Six swept blades: dark body with a lit leading edge, so the impeller reads
    // as pitched metal rather than as four flat pinwheel triangles.
    const bladeR = size * 0.3;
    const hubR = size * 0.09;
    for (let i = 0; i < 6; i += 1) {
      const a = (i * Math.PI * 2) / 6;
      const sweep = 0.62;
      const tip = { x: Math.cos(a + sweep) * bladeR, y: Math.sin(a + sweep) * bladeR };
      const root = { x: Math.cos(a) * hubR, y: Math.sin(a) * hubR };
      const trail = { x: Math.cos(a - 0.2) * bladeR * 0.82, y: Math.sin(a - 0.2) * bladeR * 0.82 };
      ctx.fillStyle = "#2f8fb8";
      ctx.beginPath();
      ctx.moveTo(root.x, root.y);
      ctx.quadraticCurveTo(Math.cos(a + 0.3) * bladeR * 0.7, Math.sin(a + 0.3) * bladeR * 0.7, tip.x, tip.y);
      ctx.lineTo(trail.x, trail.y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#bae6fd";
      ctx.lineWidth = Math.max(0.6, size * 0.028);
      ctx.beginPath();
      ctx.moveTo(root.x, root.y);
      ctx.quadraticCurveTo(Math.cos(a + 0.3) * bladeR * 0.7, Math.sin(a + 0.3) * bladeR * 0.7, tip.x, tip.y);
      ctx.stroke();
    }

    // Motor hub over the blade roots.
    ctx.fillStyle = "rgba(4,20,30,0.92)";
    ctx.beginPath(); ctx.arc(0, 0, size * 0.11, 0, Math.PI * 2); ctx.fill();
    drawComponentPort(size, 0, 0, 0.075, "#d9f8ff", 0.45);

    // Coolant risers up both flanks, feeding the exchanger behind the fan.
    ctx.strokeStyle = COOLANT_CASING;
    ctx.lineWidth = Math.max(1.3, size * 0.09);
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.3); ctx.lineTo(-size * 0.42, size * 0.3);
    ctx.moveTo(size * 0.42, -size * 0.3); ctx.lineTo(size * 0.42, size * 0.3);
    ctx.stroke();
    ctx.strokeStyle = COOLANT_FLUID;
    ctx.lineWidth = Math.max(0.7, size * 0.04);
    ctx.beginPath();
    ctx.moveTo(-size * 0.42, -size * 0.26); ctx.lineTo(-size * 0.42, size * 0.26);
    ctx.moveTo(size * 0.42, -size * 0.26); ctx.lineTo(size * 0.42, size * 0.26);
    ctx.stroke();
    return true;
  }

  return false;
}

export function drawThermalFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "burstCooler") {
    // A cryogenic accumulator, not a radiator: a sealed pressure vessel with a
    // frosted charge window down its length and one large relief valve at the
    // top. Nothing on it is a fin, because it does not shed heat continuously :
    // the valve is the entire mechanism and has to be the thing you notice.
    drawFootprintPanel(unit, hl, hc, 0.94, 0.88, 0.1);

    ctx.fillStyle = "rgba(8,22,34,0.92)";
    roundRect(ctx, { x: -hl * 0.86, y: -hc * 0.58, width: hl * 1.72, height: hc * 1.16, radius: hc * 0.5 });
    ctx.fill();
    ctx.stroke();

    // Frosted charge window: how full the accumulator is.
    ctx.save();
    ctx.shadowColor = "#a5f3fc";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#cffafe";
    roundRect(ctx, { x: -hl * 0.7, y: -hc * 0.2, width: hl * 1.4, height: hc * 0.4, radius: hc * 0.2 });
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = "rgba(3,18,28,0.6)";
    ctx.lineWidth = Math.max(0.7, unit * 0.035);
    ctx.beginPath();
    for (let tick = 1; tick < 4; tick += 1) {
      const tx = -hl * 0.7 + (hl * 1.4 * tick) / 4;
      ctx.moveTo(tx, -hc * 0.2);
      ctx.lineTo(tx, hc * 0.2);
    }
    ctx.stroke();
    ctx.restore();

    // Relief valve and its vent stack.
    ctx.fillStyle = mixColor(color, "#05070c", 0.35);
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = Math.max(0.8, unit * 0.05);
    ctx.beginPath();
    ctx.arc(hl * 0.4, -hc * 0.62, Math.min(hc * 0.42, unit * 0.3), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ecfeff";
    ctx.beginPath();
    ctx.arc(hl * 0.4, -hc * 0.62, Math.min(hc * 0.16, unit * 0.11), 0, Math.PI * 2);
    ctx.fill();
    drawFootprintPort(unit, -hl * 0.62, hc * 0.6, unit * 0.11, "#67e8f9");
    return true;
  }

  return false;
}
