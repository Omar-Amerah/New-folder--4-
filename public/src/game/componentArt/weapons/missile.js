// Missile, swarm-pod, and torpedo artwork.

import { ctx } from "../../../ui/dom.js";
import { qualityShadowBlur } from "../../renderSettings.js";
import { mixColor, roundRect, saturate } from "../common.js";
import { drawTurretCap, weaponBodyFill, weaponFine, weaponLine } from "./common.js";

function drawRackMissile(unit, mx, my, len, M) {
  const w = len * 0.15;
  // Drawn around the origin and translated into place. This matters: the shared
  // tube/cone gradients are built in local space around y=0, so a round drawn
  // directly at y = ±lane sampled past both ends of its own shading and filled
  // flat : which is exactly why a rack of them read as printed-on decals.
  const tail = -len * 0.5;
  const nose = len * 0.5;
  const shoulder = len * 0.18;

  ctx.save();
  ctx.translate(mx, my);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(3,6,12,0.75)";
  ctx.lineWidth = Math.max(0.6, unit * 0.03);

  // Contact shadow, so each round sits in the rack rather than printing on it.
  ctx.fillStyle = "rgba(3,6,12,0.55)";
  roundRect(ctx, {
    x: tail,
    y: -w + w * 0.55,
    width: nose - tail,
    height: w * 2,
    radius: w * 0.45
  });
  ctx.fill();

  // Fins, drawn before the body so it overlaps their roots. The upper pair
  // catches the light and the lower pair sits in shadow, which is what tells
  // you the round is a cylinder hanging off a rail rather than a flat tab.
  for (const dir of [-1, 1]) {
    ctx.fillStyle = dir < 0
      ? saturate(mixColor(M.housing, "#ffffff", 0.34), 0.3)
      : mixColor(M.housing, "#05070c", 0.4);
    ctx.beginPath();
    ctx.moveTo(tail + len * 0.18, dir * w);
    ctx.lineTo(tail - len * 0.04, dir * w * 2.2);
    ctx.lineTo(tail - len * 0.04, dir * w);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  // Body.
  ctx.fillStyle = M.munition;
  roundRect(ctx, { x: tail, y: -w, width: shoulder - tail, height: w * 2, radius: w * 0.4 });
  ctx.fill();
  ctx.stroke();

  // Nose cone: one flat tone a step darker than the body, so the warhead still
  // separates from it without the body reading as a shaded cylinder.
  ctx.fillStyle = M.munitionDeep;
  ctx.beginPath();
  ctx.moveTo(nose, 0);
  ctx.lineTo(shoulder, -w);
  ctx.lineTo(shoulder, w);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  // Warhead band and motor throat: the two emissive marks that keep a round
  // legible once the whole rack shrinks to a dozen pixels.
  ctx.save();
  ctx.shadowColor = M.hot;
  ctx.shadowBlur = qualityShadowBlur(4);
  ctx.fillStyle = M.hot;
  ctx.fillRect(shoulder - len * 0.06, -w, len * 0.05, w * 2);
  ctx.beginPath();
  ctx.arc(tail + len * 0.03, 0, Math.max(0.7, w * 0.44), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.restore();
}

function drawMissileRack(unit, { halfLong, railY, rail, troughHalf, stations, bracketWidth }, M) {
  ctx.save();
  ctx.fillStyle = "rgba(3,6,13,0.55)";
  roundRect(ctx, {
    x: -halfLong,
    y: -troughHalf,
    width: halfLong * 2,
    height: troughHalf * 2,
    radius: unit * 0.08
  });
  ctx.fill();

  ctx.strokeStyle = "rgba(3,6,12,0.7)";
  ctx.lineWidth = weaponFine(unit);
  ctx.fillStyle = M.housing;
  for (const dir of [-1, 1]) {
    const y = dir * railY;
    roundRect(ctx, {
      x: -halfLong,
      y: y - rail * 0.5,
      width: halfLong * 2,
      height: rail,
      radius: rail * 0.5
    });
    ctx.fill();
    ctx.stroke();
  }
  for (const sx of stations) {
    roundRect(ctx, {
      x: sx - bracketWidth * 0.5,
      y: -troughHalf,
      width: bracketWidth,
      height: troughHalf * 2,
      radius: rail * 0.4
    });
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function drawTorpedoCradle(unit, hl, hc) {
  const r = Math.min(hl, hc) * 0.72;
  ctx.save();
  ctx.fillStyle = "rgba(6,10,16,0.8)";
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.04, 0, Math.PI * 2);
  ctx.fill();

  // Thin bearing ring: still a circle, but it no longer competes with the round.
  ctx.strokeStyle = "rgba(3,6,12,0.4)";
  ctx.lineWidth = Math.max(0.7, unit * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  // The two gripping bands, thick where the clamp closes over the body.
  ctx.strokeStyle = "rgba(4,7,13,0.92)";
  ctx.lineWidth = Math.max(1.2, unit * 0.16);
  ctx.lineCap = "butt";
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.86, dir * Math.PI * 0.18, dir * Math.PI * 0.82, dir < 0);
    ctx.stroke();
  }

  // Connection blocks bolting each band down to the hull.
  ctx.fillStyle = "rgba(9,14,22,0.95)";
  ctx.strokeStyle = "rgba(3,6,12,0.7)";
  ctx.lineWidth = Math.max(0.7, unit * 0.045);
  for (const dir of [-1, 1]) {
    roundRect(ctx, {
      x: -unit * 0.17,
      y: dir * r * 0.86 - unit * 0.09,
      width: unit * 0.34,
      height: unit * 0.18,
      radius: unit * 0.04
    });
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function drawMissileWeaponTop(artType, size, color, M) {
  if (artType === "missile") {
    // A missile on a rail rather than a flat kite: straight body, a distinct
    // nose cone, swept tail fins, and a rear that runs back over the pivot cap
    // so the round is visibly seated on the launcher. The round is balanced
    // about the pivot: `back` and `nose` are equal and opposite (give or take
    // the fin overhang) so the round's own midpoint lands on the component
    // centre instead of riding forward in the cell. The nose sits at
    // TurretRules.MUZZLE_TIP_TILES.missile (0.4) : keep the two in sync.
    const back = -size * 0.36;
    const shoulder = size * 0.2;
    const nose = size * 0.4;
    const half = size * 0.135;
    const bodyPath = (dy = 0, grow = 0) => {
      ctx.beginPath();
      ctx.moveTo(nose + grow, dy);
      ctx.lineTo(shoulder, -half - grow + dy);
      ctx.lineTo(back - grow, -half - grow + dy);
      ctx.lineTo(back - grow, half + grow + dy);
      ctx.lineTo(shoulder, half + grow + dy);
      ctx.closePath();
    };

    drawTurretCap(size, color, 0.19);

    // Contact shadow so the round sits on the launcher instead of floating.
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.55)";
    bodyPath(size * 0.075, size * 0.015);
    ctx.fill();
    ctx.restore();

    // Fins first, so the body overlaps them and they read as attached.
    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.lineWidth = weaponFine(size);
    for (const sy of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(size * 0.02, sy * half * 0.85);
      ctx.lineTo(back - size * 0.01, sy * size * 0.25);
      ctx.lineTo(back - size * 0.01, sy * half * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // Thinner outline than the shared weapon stroke, kept in scope through the
    // warhead so the body and the cone re-stroke stay the same weight.
    ctx.save();
    ctx.lineWidth = weaponLine(size);
    ctx.fillStyle = M.munition;
    bodyPath();
    ctx.fill();
    ctx.stroke();

    // The whole warhead cone is tinted, not just its tip, so the head reads as
    // a separate section at a glance. A seam band marks where it joins the body.
    ctx.save();
    ctx.fillStyle = M.munitionDeep;
    ctx.beginPath();
    ctx.moveTo(nose, 0);
    ctx.lineTo(shoulder, -half);
    ctx.lineTo(shoulder, half);
    ctx.closePath();
    ctx.fill();
    // Re-stroke the cone edges the tint just covered, so the head keeps a crisp
    // outline against a purple hull.
    ctx.stroke();
    ctx.fillStyle = "rgba(3,6,12,0.45)";
    ctx.fillRect(shoulder - size * 0.03, -half, size * 0.035, half * 2);
    ctx.restore();
    ctx.restore();
    return true;
  }

  if (artType === "swarmMissile") {
    // Same exposed rack as the multi-cell pod, squeezed into one tile: an open
    // frame carrying four visible miniature missiles in two pairs. No launch
    // holes and no turret ring : the rounds are the identity.
    const lane = size * 0.2;
    const len = size * 0.42;
    const rail = Math.max(1, size * 0.05);
    const stations = [-size * 0.22, size * 0.22];

    drawMissileRack(size, {
      halfLong: size * 0.46,
      railY: lane + size * 0.13,
      rail,
      troughHalf: lane + size * 0.15,
      stations,
      bracketWidth: len * 0.24
    }, M);

    for (const sx of stations) {
      for (const dir of [-1, 1]) {
        drawRackMissile(size, sx, dir * lane, len, M);
      }
    }
    return true;
  }

  if (artType === "torpedo") {
    ctx.fillStyle = M.munition;
    ctx.beginPath();
    ctx.moveTo(-size * 0.12, -size * 0.24);
    ctx.lineTo(size * 0.46, -size * 0.24);
    ctx.lineTo(size * 0.72, 0);
    ctx.lineTo(size * 0.46, size * 0.24);
    ctx.lineTo(-size * 0.12, size * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = M.munitionDeep;
    ctx.lineWidth = weaponFine(size);
    ctx.beginPath();
    ctx.moveTo(size * 0.08, -size * 0.24);
    ctx.lineTo(size * 0.08, size * 0.24);
    ctx.stroke();
    return true;
  }
  return false;
}

export function drawMissileMultiWeaponTop(artType, unit, hl, hc, color, chargeProgress, M, fine) {
  if (artType === "torpedo") {
    // The loaded torpedo (finned tail, banded body, glowing warhead) rotates;
    // the launch trough stays on the hull as part of the mount. The stern is
    // cut flat around an engine nozzle so the tail can never be misread as a
    // second nose : front and rear have to be unambiguous on a round this long.
    const stern = -hl * 0.72;

    // Fins first, so the body overlaps their roots and they read as structure
    // bolted to the casing rather than spikes floating off the silhouette.
    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.7)";
    ctx.lineWidth = fine;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl * 0.3, dir * hc * 0.34);
      ctx.lineTo(-hl * 0.58, dir * hc * 0.58);
      ctx.lineTo(stern, dir * hc * 0.58);
      ctx.lineTo(stern, dir * hc * 0.34);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = M.munition;
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0);
    ctx.lineTo(hl * 0.56, -hc * 0.34);
    ctx.lineTo(-hl * 0.62, -hc * 0.34);
    ctx.lineTo(stern, -hc * 0.19);
    ctx.lineTo(stern, hc * 0.19);
    ctx.lineTo(-hl * 0.62, hc * 0.34);
    ctx.lineTo(hl * 0.56, hc * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Casing joints: a raised band with a lit forward edge and a shadow behind
    // it, so the segmentation reads as structure instead of paint. The forward
    // joint is the narrower of the two.
    ctx.save();
    for (const [bx, bw] of [[-hl * 0.32, unit * 0.13], [hl * 0.06, unit * 0.09]]) {
      ctx.fillStyle = M.munitionDeep;
      ctx.fillRect(bx - bw * 0.5, -hc * 0.34, bw, hc * 0.68);
      ctx.fillStyle = M.trimLine;
      ctx.fillRect(bx + bw * 0.5 - fine, -hc * 0.34, fine, hc * 0.68);
      ctx.fillStyle = "rgba(3,6,12,0.42)";
      ctx.fillRect(bx - bw * 0.5 - fine, -hc * 0.34, fine, hc * 0.68);
    }
    ctx.restore();

    // Engine nozzle in the flat stern, with a contained warm glow : heat in the
    // bell, deliberately no exhaust plume (the round is sitting in its cradle).
    ctx.save();
    ctx.fillStyle = M.bore;
    roundRect(ctx, {
      x: stern - unit * 0.05,
      y: -hc * 0.19,
      width: unit * 0.14,
      height: hc * 0.38,
      radius: unit * 0.03
    });
    ctx.fill();
    ctx.shadowColor = M.hot;
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = M.hot;
    ctx.fillRect(stern - unit * 0.005, -hc * 0.08, unit * 0.04, hc * 0.16);
    ctx.restore();

    // Guidance band below the warhead: the one warm accent on the round, so it
    // still ties into the guided-weapon palette without lightening the body.
    ctx.fillStyle = M.trimLine;
    ctx.fillRect(hl * 0.47, -hc * 0.31, unit * 0.055, hc * 0.62);

    ctx.save();
    ctx.shadowColor = M.hot;
    ctx.shadowBlur = qualityShadowBlur(6);
    ctx.fillStyle = M.hot;
    ctx.beginPath();
    ctx.moveTo(hl * 0.88, 0);
    ctx.lineTo(hl * 0.6, -hc * 0.24);
    ctx.lineTo(hl * 0.6, hc * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    return true;
  }

  if (artType === "swarmMissile") {
    // Exposed rack, not an enclosed pod: a light open frame carrying four
    // visible miniature missiles in two separated pairs. The rounds themselves
    // are the identity, so the structure stays to two rails and two cross
    // brackets : anything heavier starts hiding the ammunition it carries.
    const pairs = Math.max(2, Math.round((hl * 2) / unit));
    const lane = hc * 0.4;
    const len = Math.min(unit * 0.62, (hl * 1.8) / pairs * 0.92);
    const rail = Math.max(1, unit * 0.055);
    const stations = [];
    for (let p = 0; p < pairs; p += 1) {
      stations.push(-hl * 0.9 + (hl * 1.8 * (p + 0.5)) / pairs);
    }

    // Shadow trough, side rails and one cross bracket per pair: without a dark
    // hollow behind them, four pale rounds on a pale tile have nothing to read
    // against and the whole pod goes flat.
    drawMissileRack(unit, {
      halfLong: hl * 0.94,
      railY: lane + hc * 0.26,
      rail,
      troughHalf: lane + hc * 0.3,
      stations,
      bracketWidth: len * 0.24
    }, M);

    // The rounds: two per station, hung either side of the rack centreline.
    for (const sx of stations) {
      for (const dir of [-1, 1]) {
        drawRackMissile(unit, sx, dir * lane, len, M);
      }
    }
    return true;
  }
  return false;
}
