// Ballistic gun and rail artwork.

import { ctx } from "../../../ui/dom.js";
import { qualityShadowBlur } from "../../renderSettings.js";
import { mixColor, roundRect } from "../common.js";
import { drawTurretCap, weaponBodyFill, weaponFine, weaponLine } from "./common.js";

export function drawSimpleTurntable(size, color) {
  ctx.save();
  ctx.lineJoin = "miter";
  ctx.fillStyle = mixColor(color, "#0b1018", 0.36);
  ctx.strokeStyle = "rgba(3,6,12,0.7)";
  ctx.lineWidth = Math.max(0.7, size * 0.045);
  ctx.beginPath();
  for (let i = 0; i < 8; i += 1) {
    const a = Math.PI / 8 + (Math.PI * i) / 4;
    const px = Math.cos(a) * size * 0.36;
    const py = Math.sin(a) * size * 0.36;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export function drawBallisticWeaponTop(artType, size, color, M) {
  if (artType === "blaster") {
    // Short, wide straight-sided barrel. Its breech end runs back over the
    // pivot cap so the barrel visibly bolts into the hub instead of ending at
    // the socket ring. Tip sits at TurretRules.MUZZLE_TIP_TILES.blaster.
    // `half` is the only width control here : the muzzle and bore below are all
    // expressed as fractions of it, so the barrel narrows as one piece. `tip` is
    // pinned to TurretRules.MUZZLE_TIP_TILES.blaster and must not move with it.
    const back = -size * 0.15;
    const tip = size * 0.56;
    const half = size * 0.1;
    const barrelPath = (dy = 0, grow = 0) => {
      roundRect(ctx, {
        x: back - grow,
        y: -half - grow + dy,
        width: tip - back + grow * 2,
        height: half * 2 + grow * 2,
        radius: size * 0.04
      });
    };

    // Pivot cap first: the barrel is drawn over it, so the cap reads as the
    // yoke the barrel is seated in.
    drawTurretCap(size, color, 0.2);

    // Contact shadow separating the barrel from the circular base below it.
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.55)";
    barrelPath(size * 0.075, size * 0.015);
    ctx.fill();
    ctx.restore();

    // Barrel in the shared weapon shell tone, shaded across the tube so it
    // reads as rounded rather than a flat tab.
    ctx.save();
    ctx.lineWidth = weaponLine(size);
    ctx.fillStyle = weaponBodyFill(M);
    barrelPath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // Muzzle: the shared dark bore with the weapon's one emissive accent inside.
    ctx.save();
    ctx.fillStyle = M.bore;
    roundRect(ctx, {
      x: tip - size * 0.11,
      y: -half * 0.9,
      width: size * 0.11,
      height: half * 1.8,
      radius: size * 0.028
    });
    ctx.fill();
    ctx.shadowColor = mixColor(color, "#ffffff", 0.35);
    ctx.shadowBlur = qualityShadowBlur(4);
    ctx.fillStyle = M.hot;
    ctx.fillRect(tip - size * 0.08, -half * 0.48, size * 0.04, half * 0.96);
    ctx.restore();
    return true;
  }

  if (artType === "autocannon") {
    // Two chunky gun tubes on a compact mount : the identity is the pair of
    // barrels and their muzzles, so everything else stays out of their way.
    // A short breech bar behind them is the only structure: casings, collars
    // and layered housings turned this into an armoured weapons platform.
    // Tips sit at TurretRules.MUZZLE_TIP_TILES.autocannon (0.62) : shortening
    // the barrels means moving that constant too, or rounds stop leaving the
    // visible muzzle.
    const back = -size * 0.18;
    const tip = size * 0.62;
    const half = size * 0.09;
    const spread = size * 0.17;
    // roundRect() starts a new path, so each barrel must be filled on its own :
    // a single shared fill() would only render the last one.
    const barrelPath = (cy, dy = 0, grow = 0) => {
      roundRect(ctx, {
        x: back - grow,
        y: cy - half - grow + dy,
        width: tip - back + grow * 2,
        height: half * 2 + grow * 2,
        radius: size * 0.032
      });
    };

    // Contact shadow so the barrels sit on the mount instead of floating.
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.45)";
    for (const cy of [-spread, spread]) {
      barrelPath(cy, size * 0.05, size * 0.01);
      ctx.fill();
    }
    ctx.restore();

    // Breech bar: just enough to tie the two tubes together at the back and
    // give the pair a pivot to sit on. Drawn before the barrels so they
    // overlap it and read as running out of it.
    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.78)";
    ctx.lineWidth = weaponFine(size);
    roundRect(ctx, {
      x: back - size * 0.02,
      y: -spread - half,
      width: size * 0.2,
      height: (spread + half) * 2,
      radius: size * 0.04
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    for (const cy of [-spread, spread]) {
      ctx.save();
      ctx.translate(0, cy);
      // Thinner outline than the shared weapon stroke: two tubes this narrow
      // are swallowed by a full-width dark edge at arena zoom.
      ctx.lineWidth = weaponLine(size) * 0.85;
      ctx.fillStyle = weaponBodyFill(M);
      barrelPath(0);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    // Muzzles: a dark bore cut into each tip with a thin lit rim on its upper
    // inside edge, so both openings read instantly as gun barrels.
    ctx.save();
    for (const cy of [-spread, spread]) {
      ctx.fillStyle = M.bore;
      roundRect(ctx, {
        x: tip - size * 0.1,
        y: cy - half * 0.86,
        width: size * 0.1,
        height: half * 1.72,
        radius: size * 0.022
      });
      ctx.fill();
      ctx.fillStyle = M.hot;
      ctx.fillRect(tip - size * 0.088, cy - half * 0.58, size * 0.062, Math.max(0.7, size * 0.026));
    }
    ctx.restore();
    return true;
  }

  if (artType === "scatterCannon") {
    // Three short, flared tubes splayed outward from a common breech. The splay
    // is the identity: the autocannon's two parallel barrels say "rapid fire",
    // three barrels pointing slightly apart say "one pull, several rounds, wide".
    // Tips sit at TurretRules.MUZZLE_TIP_TILES.scatterCannon (0.54) and the
    // lateral spacing mirrors TurretRules.BARRELS.scatterCannon.spreadTiles.
    const back = -size * 0.16;
    const tip = size * 0.54;
    const half = size * 0.062;
    const lanes = [-size * 0.15, 0, size * 0.15];
    const splay = 0.19; // radians of outward cant on the two flanking tubes

    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.78)";
    ctx.lineWidth = weaponFine(size);
    roundRect(ctx, {
      x: back - size * 0.03,
      y: -size * 0.24,
      width: size * 0.22,
      height: size * 0.48,
      radius: size * 0.05
    });
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    lanes.forEach((cy, index) => {
      const cant = (index - 1) * splay;
      ctx.save();
      ctx.translate(0, cy);
      ctx.rotate(cant);
      ctx.lineWidth = weaponLine(size) * 0.8;
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: back, y: -half, width: tip - back, height: half * 2, radius: size * 0.024 });
      ctx.fill();
      ctx.stroke();
      // Flared choke at the mouth: a cluster gun throws its load, it does not
      // aim it, and the widened tip is what says so at arena zoom.
      ctx.fillStyle = M.shellDeep;
      roundRect(ctx, { x: tip - size * 0.1, y: -half * 1.5, width: size * 0.1, height: half * 3, radius: size * 0.022 });
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = M.bore;
      roundRect(ctx, { x: tip - size * 0.075, y: -half * 1.1, width: size * 0.06, height: half * 2.2, radius: size * 0.016 });
      ctx.fill();
      ctx.restore();
    });
    return true;
  }

  if (artType === "railgun") {
    const progress = chargeProgress === null || chargeProgress === undefined
      ? 1
      : Math.max(0, Math.min(1, Number(chargeProgress) || 0));
    const railBack = -size * 0.04;
    const railFront = size * 0.68;
    ctx.strokeStyle = M.shell;
    ctx.lineWidth = Math.max(1.2, size * 0.1);
    ctx.beginPath();
    ctx.moveTo(railBack, -size * 0.16);
    ctx.lineTo(railFront, -size * 0.16);
    ctx.moveTo(railBack, size * 0.16);
    ctx.lineTo(railFront, size * 0.16);
    ctx.stroke();
    // A recessed light channel in each rail fills from breech to muzzle. At the
    // default blueprint rotation that is bottom to top; rotating the mount keeps
    // the bar aligned with the weapon instead of with the screen.
    ctx.save();
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(3,6,12,0.82)";
    ctx.lineWidth = Math.max(0.8, size * 0.035);
    for (const ry of [-size * 0.16, size * 0.16]) {
      ctx.beginPath();
      ctx.moveTo(railBack, ry);
      ctx.lineTo(railFront, ry);
      ctx.stroke();
    }
    if (progress > 0) {
      const litFront = railBack + (railFront - railBack) * progress;
      ctx.shadowColor = "#38bdf8";
      ctx.shadowBlur = qualityShadowBlur(3 + 7 * progress);
      ctx.strokeStyle = mixColor("#38bdf8", "#ffffff", 0.25 + 0.55 * progress);
      ctx.lineWidth = Math.max(0.8, size * 0.04);
      for (const ry of [-size * 0.16, size * 0.16]) {
        ctx.beginPath();
        ctx.moveTo(railBack, ry);
        ctx.lineTo(litFront, ry);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.fillStyle = M.hot;
    ctx.fillRect(size * 0.42, -size * 0.06, size * 0.16, size * 0.12);
    drawTurretCap(size, color, 0.15);
    return true;
  }
  return false;
}

export function drawBallisticMultiWeaponTop(artType, unit, hl, hc, color, chargeProgress, M, fine) {
  if (artType === "railgun") {
    // Two rails, an open gap between them, a compact breech and a muzzle
    // bridge. Every extra mechanism tried here (inner cage, paired clamps,
    // rail-end brackets, machined rail bodies, feed ports) pushed it toward
    // reading as a capital-class spinal mount, so the empty space is
    // load-bearing: keep it empty.
    const railY = hc * 0.54;
    const railBack = -hl + unit * 0.44;
    const railFront = hl - unit * 0.2;
    const progress = chargeProgress === null || chargeProgress === undefined
      ? 1
      : Math.max(0, Math.min(1, Number(chargeProgress) || 0));

    // 1. The open gap, filled flush between the rails with no border of its own.
    ctx.save();
    ctx.fillStyle = "rgba(6,10,18,0.58)";
    ctx.fillRect(railBack, -railY, railFront - railBack, railY * 2);
    ctx.restore();

    // 2. Compact breech at the rear: the only heavy mass on the weapon.
    ctx.fillStyle = M.housing;
    roundRect(ctx, {
      x: -hl + unit * 0.07,
      y: -hc * 0.6,
      width: unit * 0.4,
      height: hc * 1.2,
      radius: unit * 0.07
    });
    ctx.fill();
    ctx.stroke();
    // Charge slot recessed into the breech: on a pale weapon the accent needs
    // a dark surround or it disappears into the body.
    ctx.fillStyle = M.bore;
    ctx.fillRect(-hl + unit * 0.15, -hc * 0.34, unit * 0.2, hc * 0.68);
    ctx.save();
    ctx.shadowColor = mixColor(color, "#7dd3fc", 0.5);
    ctx.shadowBlur = qualityShadowBlur(5);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.45);
    ctx.fillRect(-hl + unit * 0.18, -hc * 0.26, unit * 0.14, hc * 0.52);
    ctx.restore();

    // 3. The rails: two continuous bars running almost the full length. Drawn
    //    as shaded tubes with a contact shadow rather than flat strokes : flat
    //    bars on a flat bed plate were what made this weapon read as a decal.
    const railHalf = Math.max(0.8, unit * 0.055);
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.45)";
    for (const ry of [-railY, railY]) {
      roundRect(ctx, { x: railBack, y: ry - railHalf + unit * 0.035, width: railFront - railBack, height: railHalf * 2, radius: railHalf * 0.6 });
      ctx.fill();
    }
    ctx.lineWidth = weaponFine(unit);
    for (const ry of [-railY, railY]) {
      ctx.save();
      ctx.translate(0, ry);
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: railBack, y: -railHalf, width: railFront - railBack, height: railHalf * 2, radius: railHalf * 0.6 });
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // Recessed luminous channels turn the long rails into the reload indicator.
    // The dark channel is always visible; its cyan-white fill advances from the
    // breech toward the muzzle and remains full while the weapon is ready.
    const channelBack = railBack + unit * 0.04;
    const channelFront = railFront - unit * 0.04;
    const channelHalf = Math.max(0.55, unit * 0.026);
    ctx.save();
    ctx.fillStyle = "rgba(3,6,12,0.86)";
    for (const ry of [-railY, railY]) {
      roundRect(ctx, {
        x: channelBack,
        y: ry - channelHalf,
        width: channelFront - channelBack,
        height: channelHalf * 2,
        radius: channelHalf
      });
      ctx.fill();
    }
    if (progress > 0) {
      const litFront = channelBack + (channelFront - channelBack) * progress;
      const litWidth = Math.max(channelHalf * 2, litFront - channelBack);
      ctx.shadowColor = "#38bdf8";
      ctx.shadowBlur = qualityShadowBlur(4 + 10 * progress);
      ctx.fillStyle = mixColor("#38bdf8", "#ffffff", 0.22 + 0.58 * progress);
      for (const ry of [-railY, railY]) {
        roundRect(ctx, {
          x: channelBack,
          y: ry - channelHalf,
          width: litWidth,
          height: channelHalf * 2,
          radius: channelHalf
        });
        ctx.fill();
      }
    }
    ctx.restore();

    // A single brace tying the rails together.
    ctx.fillStyle = M.housing;
    roundRect(ctx, {
      x: -unit * 0.54,
      y: -railY,
      width: unit * 0.09,
      height: railY * 2,
      radius: unit * 0.02
    });
    ctx.fill();
    ctx.stroke();

    // 4. Muzzle bridge: one bar spanning the rail tips, marking the exit.
    ctx.fillStyle = M.shell;
    roundRect(ctx, {
      x: hl - unit * 0.24,
      y: -railY - unit * 0.05,
      width: unit * 0.13,
      height: railY * 2 + unit * 0.1,
      radius: unit * 0.035
    });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.bore;
    ctx.fillRect(hl - unit * 0.215, -railY * 0.5, unit * 0.08, railY);
    return true;
  }
  return false;
}
