// Propulsion housings, thrusters, gimbals, and multi-cell drives.

import { ctx } from "../../ui/dom.js";
import { qualityShadowBlur } from "../renderSettings.js";
import { drawComponentPort, drawFootprintPort, drawRecessedPanel, mixColor, roundRect } from "./common.js";

function drawPropulsionCasing(unit, halfLong, halfCross, color, radius = unit * 0.11) {
  ctx.save();
  ctx.fillStyle = mixColor(color, "#05070c", 0.7);
  ctx.strokeStyle = "rgba(2,5,10,0.85)";
  ctx.lineWidth = Math.max(0.9, unit * 0.055);
  roundRect(ctx, { x: -halfLong, y: -halfCross, width: halfLong * 2, height: halfCross * 2, radius });
  ctx.fill();
  ctx.stroke();
  // Lit top edge and shaded bottom edge: the shared bevel that makes the family
  // read as the same milled alloy as the rest of the catalogue.
  ctx.lineCap = "butt";
  ctx.strokeStyle = mixColor(color, "#ffffff", 0.6);
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = Math.max(0.7, unit * 0.035);
  ctx.beginPath();
  ctx.moveTo(-halfLong + radius, -halfCross + unit * 0.03);
  ctx.lineTo(halfLong - radius, -halfCross + unit * 0.03);
  ctx.stroke();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = "rgba(2,5,10,0.9)";
  ctx.beginPath();
  ctx.moveTo(-halfLong + radius, halfCross - unit * 0.03);
  ctx.lineTo(halfLong - radius, halfCross - unit * 0.03);
  ctx.stroke();
  ctx.restore();
}

function drawThrustChamber(unit, fromX, toX, halfCross, color, ribs = 3) {
  const span = toX - fromX;
  if (span <= 0) return;
  ctx.save();
  // Darker than the casing around it. A chamber lighter than its housing reads as
  // a lit window, which is exactly how these parts ended up looking like control
  // panels; the machinery has to sit *into* the block, not on top of it.
  ctx.fillStyle = mixColor(color, "#04080e", 0.8);
  ctx.strokeStyle = "rgba(2,5,10,0.85)";
  ctx.lineWidth = Math.max(0.8, unit * 0.045);
  roundRect(ctx, { x: fromX, y: -halfCross, width: span, height: halfCross * 2, radius: unit * 0.06 });
  ctx.fill();
  ctx.stroke();

  // Segment ribs: raised bands, so they catch light on top and shade underneath
  // rather than scoring a flat grid across the face.
  ctx.lineCap = "butt";
  ctx.lineWidth = Math.max(0.9, unit * 0.07);
  for (let i = 1; i <= ribs; i += 1) {
    const rx = fromX + (span * i) / (ribs + 1);
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.34);
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.moveTo(rx, -halfCross * 0.88);
    ctx.lineTo(rx, halfCross * 0.88);
    ctx.stroke();
    ctx.strokeStyle = "rgba(2,5,10,0.7)";
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(0.6, unit * 0.028);
    ctx.beginPath();
    ctx.moveTo(rx + unit * 0.045, -halfCross * 0.88);
    ctx.lineTo(rx + unit * 0.045, halfCross * 0.88);
    ctx.stroke();
    ctx.lineWidth = Math.max(0.9, unit * 0.07);
  }
  ctx.globalAlpha = 1;

  // Feed spine down the thrust axis, running toward the nozzle at -x.
  ctx.strokeStyle = "rgba(132,230,255,0.72)";
  ctx.lineWidth = Math.max(0.8, unit * 0.04);
  ctx.beginPath();
  ctx.moveTo(toX - unit * 0.06, 0);
  ctx.lineTo(fromX, 0);
  ctx.stroke();
  ctx.restore();
}

function drawNozzleBell(unit, { throatX, mouthX, throatHalf, mouthHalf, glow = true }) {
  const bell = () => {
    ctx.beginPath();
    ctx.moveTo(throatX, -throatHalf);
    ctx.lineTo(mouthX, -mouthHalf);
    ctx.lineTo(mouthX, mouthHalf);
    ctx.lineTo(throatX, throatHalf);
    ctx.closePath();
  };
  ctx.save();
  ctx.fillStyle = "rgba(2,11,18,0.96)";
  ctx.strokeStyle = "rgba(2,5,10,0.85)";
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  bell();
  ctx.fill();
  ctx.stroke();

  // Cone walls: two lit flanks converging on the throat. These do the work of
  // making the bell read hollow, so the hot core can stay small : a bell filled
  // edge to edge with glow is just a bright wedge again.
  ctx.save();
  bell();
  ctx.clip();
  ctx.strokeStyle = "rgba(168,208,232,0.42)";
  ctx.lineWidth = Math.max(0.9, unit * 0.055);
  ctx.beginPath();
  ctx.moveTo(throatX, -throatHalf);
  ctx.lineTo(mouthX, -mouthHalf);
  ctx.moveTo(throatX, throatHalf);
  ctx.lineTo(mouthX, mouthHalf);
  ctx.stroke();
  ctx.restore();

  // Machined lip around the mouth: the rim that says "this end is open".
  ctx.strokeStyle = "rgba(203,229,245,0.75)";
  ctx.lineWidth = Math.max(1, unit * 0.055);
  ctx.beginPath();
  ctx.moveTo(mouthX, -mouthHalf);
  ctx.lineTo(mouthX, mouthHalf);
  ctx.stroke();

  if (glow) {
    // Two-layer plume: a tight bright core at the throat and a dim flare behind
    // it. A single wedge of near-constant width just reads as a lit rectangle
    // parked inside the bell, which is what the first pass produced.
    const plume = (fromT, toT, fromHalf, toHalf) => {
      const x0 = throatX + (mouthX - throatX) * fromT;
      const x1 = throatX + (mouthX - throatX) * toT;
      ctx.beginPath();
      ctx.moveTo(x0, -throatHalf * fromHalf);
      ctx.lineTo(x1, -mouthHalf * toHalf);
      ctx.lineTo(x1, mouthHalf * toHalf);
      ctx.lineTo(x0, throatHalf * fromHalf);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = "rgba(109,222,255,0.34)";
    plume(0, 0.86, 0.9, 0.78);
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#c8fbff";
    plume(0, 0.34, 0.62, 0.3);
  }
  ctx.restore();
}

function drawEngineMount(unit, fromX, toX, halfCross, color, bolts = [-0.55, 0.55]) {
  ctx.save();
  ctx.fillStyle = mixColor(color, "#05070c", 0.4);
  ctx.strokeStyle = "rgba(2,5,10,0.8)";
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  roundRect(ctx, { x: fromX, y: -halfCross, width: toX - fromX, height: halfCross * 2, radius: unit * 0.05 });
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  const cap = mixColor(color, "#ffffff", 0.66);
  const bx = (fromX + toX) * 0.5;
  for (const t of bolts) drawFootprintPort(unit, bx, halfCross * t, unit * 0.06, cap);
}

export function drawPropulsionModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "engine") {
    drawRecessedPanel(size, 0.92, 0.88, 0.1);
    // Twin recessed exhaust bells at the rear and a clean central power spine.
    drawComponentPort(size, -0.34, -0.24, 0.15, "#b8f8ff", 0.43);
    drawComponentPort(size, -0.34, 0.24, 0.15, "#61d9ff", 0.43);
    ctx.fillStyle = "#72ddf7";
    roundRect(ctx, { x: -size * 0.12, y: -size * 0.26, width: size * 0.54, height: size * 0.52, radius: size * 0.08 });
    ctx.fill();
    ctx.strokeStyle = "rgba(225,248,255,0.55)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(-size * 0.02, -size * 0.13); ctx.lineTo(size * 0.34, -size * 0.13);
    ctx.moveTo(-size * 0.02, size * 0.13); ctx.lineTo(size * 0.34, size * 0.13);
    ctx.stroke();
    return true;
  }

  if (type === "compactEngine") {
    // The main engine compressed into one cell: the same mount / chamber / bell
    // sequence, but overbuilt : thicker casing, a stubbier two-rib chamber, and a
    // bell that gives up length rather than width. It should read as the small
    // dense member of the family; the old centred intake disc sitting between two
    // flank conduits read as a face.
    drawPropulsionCasing(size, size * 0.46, size * 0.44, color, size * 0.07);
    // No anchor bolts on this one: a symmetric pair of dots above a ribbed block
    // is a face, and at 1x1 there is nowhere for them to go that isn't "eyes".
    // The mount reads from its own machined cap line instead.
    drawEngineMount(size, size * 0.28, size * 0.42, size * 0.32, color, []);
    ctx.save();
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.55);
    ctx.globalAlpha = 0.6;
    ctx.lineWidth = Math.max(0.7, size * 0.035);
    ctx.beginPath();
    ctx.moveTo(size * 0.35, -size * 0.28);
    ctx.lineTo(size * 0.35, size * 0.28);
    ctx.stroke();
    ctx.restore();
    drawThrustChamber(size, -size * 0.05, size * 0.26, size * 0.29, color, 2);
    drawNozzleBell(size, {
      throatX: -size * 0.06,
      mouthX: -size * 0.42,
      throatHalf: size * 0.15,
      mouthHalf: size * 0.37
    });
    return true;
  }

  if (type === "gyroscope") {
    // Propulsion SUPPORT hardware, not a thruster: it wears the family's casing
    // and cyan energy, but has no nozzle and no thrust axis : it is radially
    // symmetric on purpose. The read is a gimballed rotor: an outer housing ring,
    // a tilted inner gimbal journalled on two trunnion pins, and a lit flywheel.
    // The old crosshair-through-a-circle was a targeting reticle, and shared both
    // silhouette and violet with the Backup Command Core.
    drawPropulsionCasing(size, size * 0.46, size * 0.46, color, size * 0.09);

    ctx.save();
    // Housing well.
    ctx.fillStyle = "rgba(2,10,18,0.9)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.36, 0, Math.PI * 2);
    ctx.fill();

    // Outer gimbal ring.
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.5);
    ctx.lineWidth = Math.max(1, size * 0.055);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
    ctx.stroke();

    // Inner gimbal, tilted out of plane: an ellipse, which is what sells rotation
    // in a flat top-down icon.
    ctx.save();
    ctx.rotate(-Math.PI * 0.18);
    ctx.scale(1, 0.42);
    ctx.strokeStyle = "rgba(196,225,245,0.85)";
    ctx.lineWidth = Math.max(1, size * 0.075);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Trunnion pins: the bearings the inner gimbal swings on.
    for (const sx of [-1, 1]) {
      const px = sx * size * 0.32 * Math.cos(-Math.PI * 0.18);
      const py = sx * size * 0.32 * Math.sin(-Math.PI * 0.18);
      ctx.fillStyle = "rgba(3,8,14,0.92)";
      ctx.beginPath();
      ctx.arc(px, py, size * 0.055, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = mixColor(color, "#ffffff", 0.7);
      ctx.beginPath();
      ctx.arc(px, py, size * 0.028, 0, Math.PI * 2);
      ctx.fill();
    }

    // Flywheel: the one hot thing on the part.
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = "#9ff6ff";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Spin highlight: a partial arc, so the rotor reads as turning.
    ctx.strokeStyle = "rgba(230,250,255,0.7)";
    ctx.lineWidth = Math.max(0.8, size * 0.035);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.17, -Math.PI * 0.85, -Math.PI * 0.15);
    ctx.stroke();
    ctx.restore();
    return true;
  }
  if (type === "maneuverThruster") {
    // Attitude control, so the whole point is that it pushes SIDEWAYS: a gimbal
    // yoke bolted at +x carrying a bell canted off the thrust axis, plus one small
    // vernier firing the other way. Deliberately asymmetric : the old symmetric
    // wedge-and-dot read as a UI arrow rather than a piece of hardware.
    drawPropulsionCasing(size, size * 0.46, size * 0.44, color, size * 0.07);

    // Mounting block along the +x edge, with the gimbal yoke reaching off it. One
    // bracket, one pivot, one bell: at 40px there is no room for more, and the
    // first pass : yoke plus canted bell plus an opposed vernier : turned to
    // scribble at icon size.
    ctx.save();
    ctx.fillStyle = mixColor(color, "#05070c", 0.4);
    ctx.strokeStyle = "rgba(2,5,10,0.8)";
    ctx.lineWidth = Math.max(0.8, size * 0.05);
    roundRect(ctx, { x: size * 0.24, y: -size * 0.38, width: size * 0.18, height: size * 0.76, radius: size * 0.05 });
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    const cap = mixColor(color, "#ffffff", 0.68);
    drawComponentPort(size, 0.33, -0.26, 0.05, cap, 0.5);
    drawComponentPort(size, 0.33, 0.26, 0.05, cap, 0.5);

    // Yoke arm from the bracket down to the pivot: the asymmetry is the point.
    const pivotX = size * 0.02;
    const pivotY = -size * 0.06;
    ctx.save();
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.32);
    ctx.lineWidth = Math.max(1.4, size * 0.095);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(size * 0.26, size * 0.16);
    ctx.lineTo(pivotX, pivotY);
    ctx.stroke();
    ctx.restore();

    // Vectoring bell, pivoted about its throat and canted well off the long axis
    // so the part visibly pushes sideways.
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(-0.62);
    drawNozzleBell(size, {
      throatX: 0,
      mouthX: -size * 0.4,
      throatHalf: size * 0.11,
      mouthHalf: size * 0.28
    });
    ctx.restore();

    // Gimbal pivot pin.
    ctx.save();
    ctx.fillStyle = "rgba(3,8,14,0.94)";
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, size * 0.08, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cap;
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, size * 0.036, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return true;
  }

  return false;
}

export function drawPropulsionFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "engine") {
    // The family's baseline main drive, read front to back: hull mount at +x,
    // ribbed thrust chamber, then one bell nozzle flared across the entire stern.
    // The old art led with a big concentric intake disc, which at icon size read
    // as a camera lens; the nozzle is now the largest feature on the part, which
    // is what makes it a thruster rather than a blue machine block.
    drawPropulsionCasing(unit, hl * 0.98, hc * 0.94, color);

    const mountFrom = hl * 0.98 - unit * 0.3;
    drawEngineMount(unit, mountFrom, hl * 0.98 - unit * 0.03, hc * 0.8, color);

    const throatX = -hl + unit * 0.72;
    drawThrustChamber(unit, throatX - unit * 0.02, mountFrom - unit * 0.04, hc * 0.68, color, 3);

    // Turbopump feed lines flanking the chamber: machinery, without the detail
    // storm that made the earlier weapons hard to read.
    ctx.save();
    ctx.strokeStyle = mixColor(color, "#ffffff", 0.4);
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.moveTo(throatX + unit * 0.1, -hc * 0.82);
    ctx.lineTo(mountFrom - unit * 0.1, -hc * 0.82);
    ctx.moveTo(throatX + unit * 0.1, hc * 0.82);
    ctx.lineTo(mountFrom - unit * 0.1, hc * 0.82);
    ctx.stroke();
    ctx.restore();

    drawNozzleBell(unit, {
      throatX,
      mouthX: -hl + unit * 0.06,
      throatHalf: hc * 0.34,
      mouthHalf: hc * 0.92
    });
    return true;
  }

  if (type === "heavyEngine") {
    // The capital drive: the standard Engine's construction, reinforced and given
    // a nozzle CLUSTER : one oversized centre bell with two outboard bells : fed
    // from a common manifold. The cluster is the whole read. The previous art was
    // a flat panel carrying two discs and a row of ports, which said "control
    // console" at every size; three flared mouths across the stern say "this is
    // several engines' worth of drive in one casing", which is what the part is.
    drawPropulsionCasing(unit, hl * 0.98, hc * 0.96, color);

    // Heavy longitudinal reinforcement down both flanks.
    ctx.save();
    ctx.fillStyle = mixColor(color, "#05070c", 0.42);
    ctx.strokeStyle = "rgba(2,5,10,0.8)";
    ctx.lineWidth = Math.max(0.8, unit * 0.045);
    for (const sy of [-1, 1]) {
      roundRect(ctx, {
        x: -hl * 0.9,
        y: sy * hc * 0.94 - (sy > 0 ? unit * 0.2 : 0),
        width: hl * 1.8,
        height: unit * 0.2,
        radius: unit * 0.05
      });
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // Mount face and its heavy anchor bolts, forward.
    const mountFrom = hl * 0.98 - unit * 0.36;
    drawEngineMount(unit, mountFrom, hl * 0.98 - unit * 0.04, hc * 0.74, color, [-0.72, -0.24, 0.24, 0.72]);

    // Segmented chamber block: three ribs, wide enough to feed the whole cluster.
    const manifoldX = -hl + unit * 1.08;
    drawThrustChamber(unit, manifoldX, mountFrom - unit * 0.05, hc * 0.62, color, 3);

    // Common exhaust manifold: the dark plenum every bell hangs off, with a hot
    // distribution strip running across it.
    ctx.save();
    ctx.fillStyle = "rgba(2,9,15,0.94)";
    ctx.strokeStyle = "rgba(2,5,10,0.85)";
    ctx.lineWidth = Math.max(0.8, unit * 0.05);
    roundRect(ctx, { x: manifoldX - unit * 0.24, y: -hc * 0.9, width: unit * 0.3, height: hc * 1.8, radius: unit * 0.05 });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Nozzle cluster: big centre bell with an outboard pair whose mouths meet it,
    // so the stern reads as one continuous exhaust array. Spacing them apart left
    // three separate trapezoids that looked like legs under a table.
    const throatX = manifoldX - unit * 0.24;
    const mouthX = -hl + unit * 0.08;
    drawNozzleBell(unit, { throatX, mouthX, throatHalf: hc * 0.17, mouthHalf: hc * 0.36 });
    for (const sy of [-1, 1]) {
      ctx.save();
      ctx.translate(0, sy * hc * 0.65);
      drawNozzleBell(unit, {
        throatX,
        mouthX: mouthX + unit * 0.1,
        throatHalf: hc * 0.13,
        mouthHalf: hc * 0.29
      });
      ctx.restore();
    }

    // One injector per bell on the manifold face. A single continuous glowing
    // strip across the plenum read as a strip light bolted to the back of the
    // part; three discrete feeds read as three nozzles being fed.
    ctx.save();
    ctx.shadowColor = "#89f7ff";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#9ff6ff";
    for (const cy of [-hc * 0.65, 0, hc * 0.65]) {
      roundRect(ctx, {
        x: manifoldX - unit * 0.17,
        y: cy - hc * 0.15,
        width: unit * 0.09,
        height: hc * 0.3,
        radius: unit * 0.035
      });
      ctx.fill();
    }
    ctx.restore();
    return true;
  }

  return false;
}
