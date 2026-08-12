// Reactors, generators, batteries, capacitors, and power assemblies.

import { ctx } from "../../ui/dom.js";
import { qualityShadowBlur } from "../renderSettings.js";
import { drawCapacitorPlatePair, drawCellStack, drawComponentPort, drawFootprintMachineFrame, drawFootprintPanel, drawFootprintPlate, drawFootprintPort, drawFootprintSeams, drawRecessedPanel, mixColor, roundRect } from "./common.js";

function drawNuclearReactorAssembly(unit, tilesLong, hl, hc, color) {
  // The capital-scale sibling of `reactor`: same panel, containment ring and
  // lit core, built out into an actual plant : a shielded core well feeding a
  // coolant loop that runs out to a heat-exchanger drum at each end. The plain
  // reactor's flat coolant bar disappeared against the bright gold body, so the
  // detail here is dark-on-gold machinery instead of yellow-on-yellow.
  const fine = Math.max(0.7, unit * 0.045);
  const line = Math.max(1, unit * 0.075);
  const coreRadius = Math.min(hc * 0.58, hl * 0.34);
  const drumX = hl - unit * 0.42;
  const loopY = hc * 0.64;

  drawFootprintPanel(unit, hl, hc, 0.92, 0.88, 0.14);

  // Coolant loop: hot feed out along one flank, return along the other.
  for (const sy of [-1, 1]) {
    ctx.save();
    ctx.strokeStyle = "rgba(10,15,23,0.78)";
    ctx.lineWidth = Math.max(1.4, unit * 0.115);
    ctx.beginPath();
    ctx.moveTo(-drumX, sy * loopY);
    ctx.lineTo(drumX, sy * loopY);
    ctx.stroke();
    ctx.strokeStyle = "#f6b93b";
    ctx.lineWidth = Math.max(0.9, unit * 0.055);
    ctx.stroke();
    ctx.restore();
  }

  // Risers tying the loop into the core well.
  ctx.save();
  ctx.strokeStyle = "rgba(246,185,59,0.55)";
  ctx.lineWidth = fine;
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(sx * coreRadius * 0.74, sy * coreRadius * 0.74);
      ctx.lineTo(sx * coreRadius * 1.3, sy * loopY);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Heat-exchanger drums at both ends of the long axis, where the plain
  // reactor carries its two containment rings.
  for (const sx of [-1, 1]) {
    ctx.save();
    ctx.fillStyle = "rgba(6,11,19,0.82)";
    ctx.strokeStyle = mixColor(color, "#2a1803", 0.55);
    ctx.lineWidth = fine;
    roundRect(ctx, {
      x: sx * drumX - unit * 0.19,
      y: -hc * 0.74,
      width: unit * 0.38,
      height: hc * 1.48,
      radius: unit * 0.1
    });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = "rgba(194,139,22,0.85)";
    for (const t of [-0.42, 0.42]) {
      ctx.beginPath();
      ctx.moveTo(sx * drumX - unit * 0.15, hc * t);
      ctx.lineTo(sx * drumX + unit * 0.15, hc * t);
      ctx.stroke();
    }
    ctx.restore();
    drawFootprintPort(unit, sx * drumX, 0, unit * 0.12, "#fde68a");
  }

  // Shielded core well: containment rings plus three shield blocks, which is
  // what separates it from the plain reactor's single ring at a glance.
  ctx.save();
  ctx.shadowColor = "#fbbf24";
  ctx.shadowBlur = qualityShadowBlur(7);
  ctx.fillStyle = "rgba(26,15,3,0.9)";
  ctx.strokeStyle = mixColor(color, "#2a1803", 0.45);
  ctx.lineWidth = Math.max(1.2, unit * 0.1);
  ctx.beginPath();
  ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.arc(0, 0, coreRadius * 0.74, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(253,230,138,0.5)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.arc(0, 0, coreRadius * 0.48, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = mixColor(color, "#150e02", 0.62);
  ctx.strokeStyle = "rgba(253,230,138,0.45)";
  for (let i = 0; i < 3; i += 1) {
    ctx.save();
    ctx.rotate(i * (Math.PI * 2 / 3) - Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(-coreRadius * 0.3, -coreRadius * 0.99);
    ctx.lineTo(coreRadius * 0.3, -coreRadius * 0.99);
    ctx.lineTo(coreRadius * 0.2, -coreRadius * 0.58);
    ctx.lineTo(-coreRadius * 0.2, -coreRadius * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();

  drawFootprintPort(unit, 0, 0, Math.max(1, coreRadius * 0.3), "#fffbe6");
  drawFootprintSeams(unit, hl, hc, tilesLong);
}

export function drawPowerModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "reactor") {
    // Containment ring braced to the housing by four coolant spurs, with the
    // fuel channel inside it and the controlled core in a well at the centre.
    // Was a bare circle with a bright dot in the middle, which carried none of
    // the "this is a pressure vessel" read the multi-cell reactor has.
    drawRecessedPanel(size, 0.8, 0.8, 0.17);
    // Spurs first, so the ring caps them where they meet it.
    ctx.strokeStyle = "#8a6414";
    ctx.lineWidth = Math.max(1.2, size * 0.075);
    ctx.beginPath();
    for (let i = 0; i < 4; i += 1) {
      const a = Math.PI * (0.25 + i * 0.5);
      ctx.moveTo(Math.cos(a) * size * 0.22, Math.sin(a) * size * 0.22);
      ctx.lineTo(Math.cos(a) * size * 0.38, Math.sin(a) * size * 0.38);
    }
    ctx.stroke();
    ctx.strokeStyle = "#d6a820"; ctx.lineWidth = line;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.3, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(255,244,168,0.42)"; ctx.lineWidth = fine;
    ctx.beginPath(); ctx.arc(0, 0, size * 0.22, 0, Math.PI * 2); ctx.stroke();
    drawComponentPort(size, 0, 0, 0.14, "#fff4a8", 0.62);
    return true;
  }
  if (type === "battery") {
    // Cell stack in a sealed case: three electrolyte cells standing in a dark
    // housing under a bus bar, with the terminal post on top and a charge
    // telltale at the foot. Was three bright horizontal bars, which read as a
    // barcode rather than as stored energy.
    drawRecessedPanel(size, 0.84, 0.88, 0.1);
    drawCellStack(size, {
      xs: [-0.19, 0, 0.19],
      halfWidth: 0.075,
      top: -0.26,
      bottom: 0.3,
      casing: "rgba(4,18,28,0.92)",
      edge: "rgba(186,244,255,0.34)",
      hot: "#d5fbff",
      cool: "#0e5f7f",
      fine
    });
    // Bus bar across the cell tops with the terminal post rising out of it.
    ctx.fillStyle = "#9fdcf0";
    roundRect(ctx, { x: -size * 0.29, y: -size * 0.36, width: size * 0.58, height: size * 0.075, radius: size * 0.03 });
    ctx.fill();
    ctx.fillStyle = "rgba(4,18,28,0.92)";
    roundRect(ctx, { x: -size * 0.075, y: -size * 0.45, width: size * 0.15, height: size * 0.1, radius: size * 0.03 });
    ctx.fill();
    drawComponentPort(size, 0, -0.4, 0.05, "#d5fbff", 0.5);
    drawComponentPort(size, 0, 0.38, 0.055, "#47caee", 0.5);
    return true;
  }
  if (type === "capacitor") {
    // Plate pair across a dielectric gap with the stored charge arcing in it.
    // The two flat blue slabs it replaces carried no sense of a gap at all :
    // the arc is what separates this from the Battery's chemical cells.
    drawRecessedPanel(size, 0.86, 0.8, 0.09);
    drawCapacitorPlatePair(size, 0, size * 0.115, size * 0.3, fine);
    // Terminal leads out to the housing wall on both faces.
    ctx.strokeStyle = "rgba(4,12,26,0.9)";
    ctx.lineWidth = Math.max(1.4, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(-size * 0.44, 0); ctx.lineTo(-size * 0.27, 0);
    ctx.moveTo(size * 0.44, 0); ctx.lineTo(size * 0.27, 0);
    ctx.stroke();
    drawComponentPort(size, -0.42, 0, 0.07, "#dbeafe", 0.5);
    drawComponentPort(size, 0.42, 0, 0.07, "#dbeafe", 0.5);
    return true;
  }
  if (type === "auxGenerator") {
    // Compact genset: a driven turbine rotor geared to an alternator can, with
    // the output bus leaving on the far face and a capped exhaust on the near
    // one. Deliberately machinery, not a containment ring : the Reactor owns
    // that read, and this used to be two amber slabs with a chevron on them.
    drawRecessedPanel(size, 0.86, 0.84, 0.1);

    // Turbine rotor with swept vanes.
    const hub = { x: -size * 0.16, y: 0, r: size * 0.19 };
    ctx.fillStyle = "rgba(24,14,2,0.9)";
    ctx.beginPath(); ctx.arc(hub.x, hub.y, hub.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(254,240,138,0.45)"; ctx.lineWidth = fine; ctx.stroke();
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = Math.max(0.9, size * 0.055);
    ctx.beginPath();
    for (let i = 0; i < 5; i += 1) {
      const a = (i * Math.PI * 2) / 5 - Math.PI / 5;
      ctx.moveTo(hub.x + Math.cos(a) * size * 0.05, hub.y + Math.sin(a) * size * 0.05);
      ctx.lineTo(hub.x + Math.cos(a + 0.5) * hub.r * 0.86, hub.y + Math.sin(a + 0.5) * hub.r * 0.86);
    }
    ctx.stroke();
    drawComponentPort(size, hub.x / size, 0, 0.05, "#fef9c3", 0.55);

    // Drive shaft into the alternator can.
    ctx.strokeStyle = "#a16207";
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.beginPath(); ctx.moveTo(hub.x + hub.r * 0.7, 0); ctx.lineTo(size * 0.06, 0); ctx.stroke();

    ctx.fillStyle = "rgba(24,14,2,0.9)";
    ctx.strokeStyle = "rgba(254,240,138,0.42)";
    ctx.lineWidth = fine;
    roundRect(ctx, { x: size * 0.06, y: -size * 0.22, width: size * 0.26, height: size * 0.44, radius: size * 0.06 });
    ctx.fill(); ctx.stroke();
    // Stator windings on the can.
    ctx.strokeStyle = "#fde047";
    ctx.lineWidth = Math.max(0.7, size * 0.04);
    ctx.beginPath();
    for (let i = 0; i < 3; i += 1) {
      const y = -size * 0.13 + i * size * 0.13;
      ctx.moveTo(size * 0.09, y); ctx.lineTo(size * 0.29, y);
    }
    ctx.stroke();

    // Output bus off the alternator, capped exhaust stub above the turbine.
    ctx.strokeStyle = "rgba(24,14,2,0.9)";
    ctx.lineWidth = Math.max(1.3, size * 0.1);
    ctx.beginPath(); ctx.moveTo(size * 0.32, size * 0.22); ctx.lineTo(size * 0.44, size * 0.22); ctx.stroke();
    drawComponentPort(size, 0.42, 0.22, 0.07, "#fef08a", 0.5);
    ctx.strokeStyle = "rgba(24,14,2,0.9)";
    ctx.lineWidth = Math.max(1.1, size * 0.085);
    ctx.beginPath(); ctx.moveTo(hub.x, -size * 0.32); ctx.lineTo(hub.x, -size * 0.44); ctx.stroke();
    drawComponentPort(size, hub.x / size, -0.42, 0.06, "#f59e0b", 0.5);
    return true;
  }

  if (type === "nuclearReactor") {
    drawRecessedPanel(size, 0.82, 0.78, 0.16);
    ctx.strokeStyle = "#fb923c";
    ctx.lineWidth = line;
    for (const radius of [0.16, 0.3]) {
      ctx.beginPath();
      ctx.arc(0, 0, size * radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    drawComponentPort(size, 0, 0, 0.12, "#fef08a", 0.65);
    return true;
  }

  return false;
}

export function drawPowerFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "reactor") {
    // A tall containment vessel holding one continuous plasma column, clamped by
    // two magnetic collars, capped by an injector at one end and a heavy power
    // coupling at the other.
    //
    // Two things drove this. The previous art put two identical discs side by
    // side on a flat yellow slab, which read as speakers or cooker rings rather
    // than a machine; and the yellow was the whole component body, so nothing on
    // the part was actually emitting. Yellow is now only the energy: a charcoal
    // casing covers the coloured slab and leaves it showing as a golden rim, and
    // the one bright thing in the tile is the column.
    //
    // Drawn in the footprint's long-axis frame, so local -x is the injector end
    // and +x the coupling end; the caller's rotation decides which way that
    // points on the hull.
    const casingHalfCross = hc * 0.9;
    const casingHalfLong = hl * 0.95;
    const columnHalf = Math.min(hc * 0.26, hl * 0.14);
    const capLong = hl * 0.2;
    const couplingLong = hl * 0.26;
    const columnFrom = -casingHalfLong + capLong * 1.5;
    const columnTo = casingHalfLong - couplingLong * 1.4;

    // Casing: near-opaque charcoal over the coloured slab. Every other part
    // keeps the slab visible, but a reactor that is uniformly its own bright
    // colour has nowhere left to put a glow.
    ctx.save();
    ctx.fillStyle = "rgba(16,20,27,0.93)";
    ctx.strokeStyle = "#d6a820";
    ctx.lineWidth = Math.max(0.9, unit * 0.05);
    roundRect(ctx, {
      x: -casingHalfLong,
      y: -casingHalfCross,
      width: casingHalfLong * 2,
      height: casingHalfCross * 2,
      radius: unit * 0.12
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Magnetic collars: clamps bridging casing wall to casing wall, in a steel
    // light enough to separate from the charcoal behind them. Drawn before the
    // column so the column passes in front and they read as clamped around it
    // rather than painted across it.
    //
    // These are the only things crossing the vessel. An earlier pass ran a
    // coolant conduit down one flank as a deliberate asymmetry; it broke the
    // mirror symmetry about the long axis for no gain, so the part is now
    // symmetric across that axis and only its two ends differ.
    ctx.save();
    ctx.lineCap = "butt";
    ctx.beginPath();
    for (const cx of [
      columnFrom + (columnTo - columnFrom) * 0.28,
      columnFrom + (columnTo - columnFrom) * 0.72
    ]) {
      ctx.moveTo(cx, -casingHalfCross * 0.88);
      ctx.lineTo(cx, casingHalfCross * 0.88);
    }
    ctx.strokeStyle = "#5d6a7c";
    ctx.lineWidth = Math.max(1.6, unit * 0.13);
    ctx.stroke();
    ctx.strokeStyle = "#98a6b8";
    ctx.lineWidth = Math.max(0.7, unit * 0.04);
    ctx.stroke();
    ctx.restore();

    // Plasma column. The gradient runs ALONG the column, not across it: this is
    // brightness falling off toward the ends, not the cross-tube shading the
    // weapon bodies had removed.
    ctx.save();
    ctx.shadowColor = "#f59e0b";
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = "#3a2405";
    roundRect(ctx, {
      x: columnFrom,
      y: -columnHalf,
      width: columnTo - columnFrom,
      height: columnHalf * 2,
      radius: columnHalf
    });
    ctx.fill();
    ctx.restore();

    ctx.save();
    const plasma = ctx.createLinearGradient(columnFrom, 0, columnTo, 0);
    plasma.addColorStop(0, "#b45309");
    plasma.addColorStop(0.28, "#f59e0b");
    plasma.addColorStop(0.5, "#fde68a");
    plasma.addColorStop(0.72, "#f59e0b");
    plasma.addColorStop(1, "#b45309");
    ctx.fillStyle = plasma;
    roundRect(ctx, {
      x: columnFrom + unit * 0.03,
      y: -columnHalf * 0.68,
      width: (columnTo - columnFrom) - unit * 0.06,
      height: columnHalf * 1.36,
      radius: columnHalf * 0.68
    });
    ctx.fill();
    // White-hot centre: one short bar, brightest where the collars hold it.
    ctx.fillStyle = "#fffbe8";
    roundRect(ctx, {
      x: columnFrom + (columnTo - columnFrom) * 0.24,
      y: -columnHalf * 0.24,
      width: (columnTo - columnFrom) * 0.52,
      height: columnHalf * 0.48,
      radius: columnHalf * 0.24
    });
    ctx.fill();
    ctx.restore();

    // Injector cap: a narrow control block with a single feed port.
    const capX = -casingHalfLong + unit * 0.06;
    ctx.save();
    ctx.fillStyle = "#3b4553";
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = fine;
    roundRect(ctx, {
      x: capX,
      y: -casingHalfCross * 0.46,
      width: capLong,
      height: casingHalfCross * 0.92,
      radius: unit * 0.04
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawFootprintPort(unit, capX + capLong * 0.5, 0, unit * 0.06, "#fde68a");

    // Power coupling: wider across and lighter in tone than the injector, with a
    // bus plate and two contact points, so the two ends of the vessel are
    // visibly doing different jobs rather than mirroring each other.
    const couplingX = casingHalfLong - unit * 0.06 - couplingLong;
    ctx.save();
    ctx.fillStyle = "#5d6a7c";
    ctx.strokeStyle = "rgba(3,6,12,0.72)";
    ctx.lineWidth = fine;
    roundRect(ctx, {
      x: couplingX,
      y: -casingHalfCross * 0.82,
      width: couplingLong,
      height: casingHalfCross * 1.64,
      radius: unit * 0.05
    });
    ctx.fill();
    ctx.stroke();
    // Bus plate across the coupling face.
    ctx.fillStyle = "#98a6b8";
    roundRect(ctx, {
      x: couplingX + couplingLong * 0.62,
      y: -casingHalfCross * 0.66,
      width: couplingLong * 0.26,
      height: casingHalfCross * 1.32,
      radius: unit * 0.02
    });
    ctx.fill();
    ctx.restore();
    for (const sy of [-0.44, 0.44]) {
      drawFootprintPort(unit, couplingX + couplingLong * 0.3, casingHalfCross * sy, unit * 0.055, "#d6a820");
    }

    return true;
  }

  if (type === "capacitor") {
    // Capacitor bank: the same plate pair the 1x1 draws, repeated along the
    // footprint and tied together by top and bottom charge rails. The flat blue
    // cell bars it replaces shared nothing with the single-cell part.
    drawFootprintPanel(unit, hl, hc, 0.92, 0.78, 0.08);
    const banks = Math.max(2, tilesLong);
    const span = hl * 1.7;
    const bankW = span / banks;
    const plateThickness = Math.min(unit * 0.16, bankW * 0.22);
    const gapHalf = Math.min(unit * 0.11, bankW * 0.16);
    const halfHeight = Math.min(hc * 0.5, unit * 0.3);
    for (let i = 0; i < banks; i += 1) {
      const cx = -span * 0.5 + bankW * (i + 0.5);
      drawCapacitorPlatePair(unit, cx, gapHalf, halfHeight, fine, plateThickness);
    }

    // Charge rails across the plate ends, with the bank terminals on the flanks.
    ctx.strokeStyle = "#93c5fd";
    ctx.lineWidth = Math.max(0.9, unit * 0.055);
    ctx.beginPath();
    for (const sy of [-1, 1]) {
      ctx.moveTo(-span * 0.5, sy * halfHeight * 1.24);
      ctx.lineTo(span * 0.5, sy * halfHeight * 1.24);
    }
    ctx.stroke();
    for (const sx of [-1, 1]) {
      drawFootprintPort(unit, sx * hl * 0.88, 0, unit * 0.075, "#dbeafe");
    }
    drawFootprintSeams(unit, hl, hc, tilesLong);
    return true;
  }

  if (type === "nuclearReactor") {
    drawNuclearReactorAssembly(unit, tilesLong, hl, hc, color);
    return true;
  }

  return false;
}

