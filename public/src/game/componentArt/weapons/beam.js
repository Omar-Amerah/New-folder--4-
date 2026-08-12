// Beam emitter, repair beam, and thermal-lance artwork.

import { ctx } from "../../../ui/dom.js";
import { qualityShadowBlur } from "../../renderSettings.js";
import { mixColor, roundRect } from "../common.js";
import { drawTurretCap, weaponFine, weaponLine, weaponMetals } from "./common.js";

function drawBeamCollar(unit, hc, cx, radius, thickness, metal, sweep) {
  ctx.save();
  ctx.lineCap = "butt";
  for (const dir of [-1, 1]) {
    // Connector first, so the arm caps it.
    ctx.fillStyle = metal;
    ctx.fillRect(cx - thickness * 0.28, dir * hc * 0.12, thickness * 0.56, dir * (radius - hc * 0.12));
    const from = dir < 0 ? Math.PI * (1.5 - sweep) : Math.PI * (0.5 - sweep);
    const to = dir < 0 ? Math.PI * (1.5 + sweep) : Math.PI * (0.5 + sweep);
    // Dark edge under the arm so it reads as a separate piece of hardware
    // sitting on the body rather than a tint on it.
    ctx.strokeStyle = "rgba(3,6,12,0.75)";
    ctx.lineWidth = thickness + Math.max(1, unit * 0.05);
    ctx.beginPath();
    ctx.arc(cx, 0, radius, from, to);
    ctx.stroke();
    ctx.strokeStyle = metal;
    ctx.lineWidth = thickness;
    ctx.beginPath();
    ctx.arc(cx, 0, radius, from, to);
    ctx.stroke();
    // Lit outer rim on the arm.
    ctx.strokeStyle = "rgba(226,232,240,0.3)";
    ctx.lineWidth = Math.max(0.6, unit * 0.025);
    ctx.beginPath();
    ctx.arc(cx, 0, radius + thickness * 0.42, dir < 0 ? Math.PI * (1.5 - sweep) : Math.PI * (0.5 - sweep),
      dir < 0 ? Math.PI * (1.5 + sweep) : Math.PI * (0.5 + sweep));
    ctx.stroke();
  }
  ctx.restore();
}

function drawBeamFamilyTop(unit, hl, hc, color, opts) {
  const { chamberFront, channelHalf, collars, collarR, collarSweep, lens } = opts;
  const M = weaponMetals(color);
  const casing = M.housing;
  const core = mixColor(color, "#05070c", 0.25);
  const accent = mixColor(color, "#ffffff", 0.2);
  const glow = color;
  const pale = M.hot;
  const metal = M.shellDeep;
  // The arms are deliberately lighter than the rest of the body: in dark metal
  // a pair of arcs closes up visually into the old black ring.
  const armMetal = M.shell;
  const fine = weaponFine(unit);

  // Power chamber: broader than the channel it feeds, with a coloured core
  // showing through and a couple of casing seams.
  ctx.fillStyle = casing;
  roundRect(ctx, { x: -hl * 0.94, y: -hc * 0.48, width: hl * 0.94 + chamberFront * hl, height: hc * 0.96, radius: unit * 0.09 });
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.fillStyle = core;
  roundRect(ctx, { x: -hl * 0.82, y: -hc * 0.26, width: hl * 0.78 + chamberFront * hl, height: hc * 0.52, radius: unit * 0.05 });
  ctx.fill();
  ctx.fillStyle = "rgba(3,6,12,0.45)";
  for (const sx of [-hl * 0.6, -hl * 0.34]) {
    ctx.fillRect(sx, -hc * 0.48, Math.max(0.8, unit * 0.035), hc * 0.96);
  }
  ctx.restore();

  // Energy channel forward to the lens.
  ctx.fillStyle = metal;
  roundRect(ctx, {
    x: -hl * 0.3,
    y: -hc * channelHalf,
    width: hl * 0.3 + lens.base * hl,
    height: hc * channelHalf * 2,
    radius: unit * 0.05
  });
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = qualityShadowBlur(5);
  ctx.fillStyle = accent;
  ctx.fillRect(-hl * 0.26, -hc * channelHalf * 0.42, hl * 0.26 + lens.base * hl - unit * 0.04, hc * channelHalf * 0.84);
  ctx.restore();

  // Focusing arms.
  for (const cx of collars) {
    drawBeamCollar(unit, hc, hl * cx, hc * collarR, hc * 0.26, armMetal, collarSweep);
  }

  // Emitter lens: dark shroud, bright face, narrow aperture at the very tip.
  ctx.save();
  ctx.fillStyle = metal;
  ctx.beginPath();
  ctx.moveTo(hl * lens.base, -hc * lens.rootHalf);
  ctx.lineTo(hl * lens.tip, -hc * lens.tipHalf);
  ctx.lineTo(hl * lens.tip, hc * lens.tipHalf);
  ctx.lineTo(hl * lens.base, hc * lens.rootHalf);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.shadowColor = glow;
  ctx.shadowBlur = qualityShadowBlur(7);
  if (lens.forked) {
    // Support beam: the aperture is split, so the head never reads as a spike.
    for (const dir of [-1, 1]) {
      ctx.fillStyle = pale;
      ctx.fillRect(hl * (lens.tip - 0.1), dir * hc * lens.tipHalf * 0.9 - hc * lens.tipHalf * 0.42,
        hl * 0.09, hc * lens.tipHalf * 0.84);
    }
  } else {
    ctx.fillStyle = pale;
    ctx.fillRect(hl * (lens.tip - 0.12), -hc * lens.tipHalf * 0.72, hl * 0.11, hc * lens.tipHalf * 1.44);
    ctx.fillStyle = mixColor(pale, "#ffffff", 0.6);
    ctx.fillRect(hl * (lens.tip - 0.04), -hc * lens.tipHalf * 0.4, hl * 0.03, hc * lens.tipHalf * 0.8);
  }
  ctx.restore();

  // Optional containment bands over the shroud (the lance's extra hardware).
  if (lens.bands) {
    ctx.save();
    ctx.strokeStyle = metal;
    ctx.lineWidth = Math.max(fine, unit * 0.055);
    for (const bx of lens.bands) {
      ctx.beginPath();
      ctx.moveTo(hl * bx, -hc * lens.rootHalf * 1.05);
      ctx.lineTo(hl * bx, hc * lens.rootHalf * 1.05);
      ctx.stroke();
    }
    ctx.restore();
  }
}

export function drawBeamWeaponTop(artType, size, color, M) {
  if (artType === "beamEmitter" || artType === "repairBeam") {
    const repair = artType === "repairBeam";
    ctx.fillStyle = M.housing;
    ctx.fillRect(-size * 0.08, -size * 0.16, size * 0.3, size * 0.32);
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = M.hot;
    ctx.beginPath();
    ctx.moveTo(size * 0.22, -size * 0.18);
    ctx.lineTo(size * 0.66, 0);
    ctx.lineTo(size * 0.22, size * 0.18);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    if (repair) {
      ctx.fillStyle = M.trimLine;
      ctx.fillRect(-size * 0.05, -size * 0.03, size * 0.2, size * 0.06);
      ctx.fillRect(size * 0.01, -size * 0.1, size * 0.06, size * 0.2);
    }
    drawTurretCap(size, color, 0.13);
    return true;
  }

  if (artType === "thermalInductionLance") {
    // Single-cell fallback for the same coil-wound lance the 1x2 footprint draws.
    ctx.fillStyle = M.shellDeep;
    roundRect(ctx, { x: -size * 0.04, y: -size * 0.1, width: size * 0.6, height: size * 0.2, radius: size * 0.05 });
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = M.shell;
    ctx.lineWidth = weaponLine(size);
    for (const cx of [0.12, 0.28, 0.44]) {
      ctx.beginPath();
      ctx.moveTo(size * cx, -size * 0.18);
      ctx.lineTo(size * cx, size * 0.18);
      ctx.stroke();
    }
    ctx.save();
    ctx.shadowColor = "#e879f9";
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = "#f5d0fe";
    ctx.beginPath();
    ctx.moveTo(size * 0.5, -size * 0.14);
    ctx.lineTo(size * 0.66, -size * 0.05);
    ctx.lineTo(size * 0.66, size * 0.05);
    ctx.lineTo(size * 0.5, size * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    drawTurretCap(size, color, 0.13);
    return true;
  }
  return false;
}

export function drawBeamMultiWeaponTop(artType, unit, hl, hc, color, chargeProgress, M, fine) {
  if (artType === "beamEmitter") {
    // The family baseline: compact chamber, one pair of focusing arms, a
    // straight channel and a narrow blue-white lens. Everything else in the
    // family is a variation on these proportions.
    drawBeamFamilyTop(unit, hl, hc, color, {
      chamberFront: 0.06,
      channelHalf: 0.2,
      collars: [0.16],
      collarR: 0.46,
      collarSweep: 0.2,
      lens: { base: 0.52, tip: 0.95, rootHalf: 0.34, tipHalf: 0.17 }
    });
    return true;
  }

  if (artType === "repairBeam") {
    // Support variant: slimmer channel, arms opened out, and a split aperture
    // so the head reads as controlled emission rather than a weapon point.
    drawBeamFamilyTop(unit, hl, hc, color, {
      chamberFront: 0.02,
      channelHalf: 0.15,
      collars: [0.14],
      collarR: 0.48,
      collarSweep: 0.15,
      lens: { base: 0.5, tip: 0.93, rootHalf: 0.3, tipHalf: 0.24, forked: true }
    });
    return true;
  }

  if (artType === "thermalInductionLance") {
    // Heavy variant: a longer heat chamber, two pairs of containment arms with
    // a tighter sweep, and containment bands over a white-hot shroud. Clearly
    // the same construction as the Beam Emitter, built for something less
    // stable : it couples heat rather than cutting.
    drawBeamFamilyTop(unit, hl, hc, color, {
      chamberFront: 0.16,
      channelHalf: 0.22,
      collars: [0.02, 0.34],
      collarR: 0.5,
      collarSweep: 0.26,
      lens: { base: 0.56, tip: 0.95, rootHalf: 0.38, tipHalf: 0.19, bands: [0.66, 0.8] }
    });
    // Small warm accent in the heat chamber: the one thing on the family that
    // says this member runs hot.
    ctx.save();
    ctx.fillStyle = M.hot;
    ctx.fillRect(-hl * 0.78, -hc * 0.1, unit * 0.12, hc * 0.2);
    ctx.restore();
    return true;
  }
  return false;
}
