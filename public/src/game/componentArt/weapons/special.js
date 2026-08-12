// Special-purpose weapon artwork kept outside the rotating turret pipeline.

import { ctx } from "../../../ui/dom.js";
import { qualityShadowBlur } from "../../renderSettings.js";
import { drawComponentPort, drawFootprintMachineFrame, drawFootprintPanel, drawFootprintPlate, drawFootprintPort, drawFootprintSeams, drawRecessedPanel, mixColor, roundRect } from "../common.js";
import { weaponBodyFill } from "./common.js";

export function drawChargeWarhead(unit, radius, accent, hot, armed) {
  ctx.save();
  ctx.shadowColor = accent;
  ctx.shadowBlur = qualityShadowBlur(armed ? 9 : 3);
  ctx.fillStyle = "rgba(8,12,20,0.86)";
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.38);
  ctx.lineWidth = Math.max(1, unit * 0.075);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(0.9, unit * (armed ? 0.07 : 0.05));
  for (const scale of [0.74, 0.46]) {
    ctx.beginPath();
    ctx.arc(0, 0, radius * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = mixColor(accent, "#ffffff", 0.45);
  ctx.lineWidth = Math.max(0.7, unit * 0.04);
  for (let i = 0; i < 4; i += 1) {
    const a = Math.PI * (0.25 + i * 0.5);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * radius * 0.5, Math.sin(a) * radius * 0.5);
    ctx.lineTo(Math.cos(a) * radius * 0.92, Math.sin(a) * radius * 0.92);
    ctx.stroke();
  }
  ctx.restore();
  drawFootprintPort(unit, 0, 0, Math.max(1, radius * 0.3), hot);
}

function drawDemolitionChargeAssembly(unit, tilesLong, hl, hc, color, visualState = "safed") {
  const armed = visualState === "armed" || visualState === "active";
  const accent = armed ? "#ff5a4d" : "#f59e0b";
  const hot = armed ? "#fff1e6" : "#fde68a";
  const fine = Math.max(0.7, unit * 0.045);
  const warheadRadius = Math.min(hc * 0.6, hl * 0.36);

  drawFootprintPanel(unit, hl, hc, 0.9, 0.86, 0.14);

  // Firing bus down the long axis, ending at the two trigger heads, with the
  // charge racks along both flanks : the same deck layout the other multi-cell
  // machines use, rather than a bomb sitting in the middle of a frame.
  const headX = hl - unit * 0.32;
  ctx.save();
  ctx.strokeStyle = "rgba(226,237,250,0.3)";
  ctx.lineWidth = fine;
  ctx.beginPath();
  ctx.moveTo(-headX, 0);
  ctx.lineTo(headX, 0);
  ctx.stroke();
  ctx.strokeStyle = mixColor(accent, "#05070c", 0.42);
  ctx.lineWidth = Math.max(1, unit * 0.07);
  for (const sy of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(-hl * 0.6, sy * hc * 0.62);
    ctx.lineTo(hl * 0.6, sy * hc * 0.62);
    ctx.stroke();
  }
  ctx.restore();

  drawChargeWarhead(unit, warheadRadius, accent, hot, armed);

  // Safed keeps cold grey telltales; armed energises every trigger head.
  for (const sx of [-1, 1]) {
    drawFootprintPort(unit, sx * headX, 0, unit * 0.13, armed ? "#ff6b5c" : "#94a3b8");
    for (const sy of [-1, 1]) {
      drawFootprintPort(unit, sx * hl * 0.6, sy * hc * 0.62, unit * 0.075, armed ? "#ff5a4d" : "#64748b");
    }
  }

  drawFootprintSeams(unit, hl, hc, tilesLong);
}

export function drawSpecialModuleDetail(type, size, color, visualState = "active", rotation = 0, flipped = false, connectionMask = 0) {
  const line = Math.max(0.8, size * 0.065);
  const fine = Math.max(0.7, size * 0.045);

  if (type === "proximityDemolitionCharge" || type === "demolitionCharge") {
    // Same housing language as every other system module : recessed panel,
    // centred assembly, corner telltales : with the shared warhead face at
    // its centre so it matches the multi-cell charge instead of reading as a
    // cartoon bomb.
    const armed = visualState === "armed" || visualState === "active";
    const accent = armed ? "#ff5a4d" : "#f59e0b";
    const hot = armed ? "#fff1e6" : "#fde68a";
    drawRecessedPanel(size, 0.8, 0.8, 0.16);
    drawChargeWarhead(size, size * 0.3, accent, hot, armed);
    for (const [px, py] of [[-0.37, -0.37], [0.37, -0.37], [-0.37, 0.37], [0.37, 0.37]]) {
      drawComponentPort(size, px, py, 0.06, armed ? "#ff6b5c" : "#64748b", 0.5);
    }
    return true;
  }

  return false;
}


function drawSpinalAcceleratorTop(unit, hl, hc, color, M, fine, chargeProgress = 0) {
  const progress = Math.max(0, Math.min(1, Number(chargeProgress) || 0));
  M = {
    ...M,
    housing: mixColor(M.housing, "#05070c", 0.25),
    shellDeep: mixColor(M.shellDeep, "#05070c", 0.25),
    shell: mixColor(M.shell, "#05070c", 0.25)
  };
  const coils = 6;
  const chamberBack = -hl * 0.97;
  const chamberFront = -hl * 0.58;
  const muzzleBack = hl * 0.7;
  const railFrom = chamberFront;
  const railTo = muzzleBack;

  // Spine: the accelerator body itself, one continuous machined block.
  ctx.fillStyle = M.housing;
  roundRect(ctx, { x: chamberBack, y: -hc * 0.66, width: hl * 1.94, height: hc * 1.32, radius: unit * 0.1 });
  ctx.fill();
  ctx.stroke();

  // Capacitor chamber at the rear. It fills first and stays lit: this is the
  // energy the coils are pulling from.
  const chamberFill = Math.min(1, progress / 0.25);
  ctx.fillStyle = M.shellDeep;
  roundRect(ctx, { x: chamberBack + unit * 0.06, y: -hc * 0.5, width: chamberFront - chamberBack - unit * 0.12, height: hc, radius: unit * 0.07 });
  ctx.fill();
  ctx.stroke();
  if (chamberFill > 0) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(6 + 8 * chamberFill);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.25 + 0.5 * chamberFill);
    const innerW = (chamberFront - chamberBack - unit * 0.26) * chamberFill;
    ctx.fillRect(chamberBack + unit * 0.13, -hc * 0.3, Math.max(unit * 0.05, innerW), hc * 0.6);
    ctx.restore();
  }

  // Twin accelerator rails running the length of the weapon, with the coils
  // clamped across them.
  const railY = hc * 0.42;
  const railHalf = Math.max(0.9, unit * 0.05);
  ctx.save();
  ctx.fillStyle = weaponBodyFill(M);
  for (const ry of [-railY, railY]) {
    roundRect(ctx, { x: railFrom, y: ry - railHalf, width: railTo - railFrom, height: railHalf * 2, radius: railHalf * 0.6 });
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // Coils illuminate in sequence. Each owns an equal slice of the 0.2..1.0 band
  // so the travelling glow starts once the chamber has something to give.
  for (let coil = 0; coil < coils; coil += 1) {
    const cx = railFrom + ((railTo - railFrom) * (coil + 0.5)) / coils;
    const bandFrom = 0.2 + (0.75 * coil) / coils;
    const bandTo = 0.2 + (0.75 * (coil + 1)) / coils;
    const lit = Math.max(0, Math.min(1, (progress - bandFrom) / Math.max(1e-6, bandTo - bandFrom)));

    ctx.save();
    ctx.fillStyle = M.shellDeep;
    roundRect(ctx, { x: cx - unit * 0.07, y: -hc * 0.62, width: unit * 0.14, height: hc * 1.24, radius: unit * 0.035 });
    ctx.fill();
    ctx.stroke();
    if (lit > 0) {
      ctx.shadowColor = color;
      ctx.shadowBlur = qualityShadowBlur(3 + 9 * lit);
      // Coils that have already fired stay warm; the one currently charging is
      // the brightest thing on the weapon, which is what the eye tracks.
      ctx.fillStyle = mixColor(color, "#ffffff", 0.2 + 0.6 * lit);
      ctx.fillRect(cx - unit * 0.035, -hc * 0.5, unit * 0.07, hc);
    }
    ctx.restore();
  }

  // Bore between the rails, brightening along its charged length.
  if (progress > 0.2) {
    ctx.save();
    const boreReach = Math.min(1, (progress - 0.2) / 0.75);
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(4 + 10 * boreReach);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.35 + 0.5 * boreReach);
    ctx.fillRect(railFrom, -unit * 0.04, (railTo - railFrom) * boreReach, unit * 0.08);
    ctx.restore();
  }

  // Muzzle assembly: heavy shroud, then a white-hot mouth in the final stage.
  ctx.fillStyle = M.shellDeep;
  roundRect(ctx, { x: muzzleBack, y: -hc * 0.74, width: hl * 0.97 - muzzleBack, height: hc * 1.48, radius: unit * 0.06 });
  ctx.fill();
  ctx.stroke();
  ctx.save();
  ctx.strokeStyle = M.trimLine;
  ctx.lineWidth = Math.max(fine, unit * 0.05);
  for (const bx of [muzzleBack + unit * 0.12, muzzleBack + unit * 0.26]) {
    ctx.beginPath();
    ctx.moveTo(bx, -hc * 0.7);
    ctx.lineTo(bx, hc * 0.7);
    ctx.stroke();
  }
  ctx.restore();

  const muzzleHeat = Math.max(0, Math.min(1, (progress - 0.8) / 0.2));
  ctx.save();
  ctx.fillStyle = M.bore;
  roundRect(ctx, { x: hl * 0.86, y: -hc * 0.34, width: unit * 0.16, height: hc * 0.68, radius: unit * 0.04 });
  ctx.fill();
  if (muzzleHeat > 0) {
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = qualityShadowBlur(6 + 16 * muzzleHeat);
    ctx.fillStyle = mixColor(color, "#ffffff", 0.4 + 0.6 * muzzleHeat);
    ctx.fillRect(hl * 0.88, -hc * 0.26 * (0.4 + 0.6 * muzzleHeat), unit * 0.12, hc * 0.52 * (0.4 + 0.6 * muzzleHeat));
  }
  ctx.restore();
}

export function drawSpecialMultiWeaponTop(artType, unit, hl, hc, color, chargeProgress, M, fine) {
  if (artType === "empCannon") {
    // Not a gun. Read back to front: a capacitor bank with visible charge cans,
    // a spine of induction coils, and a forked emitter whose discharge arcs
    // across the open gap between its two horns. The old art was a ringed tube
    // with a lit slot at the end, which is the blaster/plasma silhouette with
    // different rings on it : this weapon fires no shell and does no hull
    // damage, so it deliberately has no barrel and no muzzle to look down.
    // The open fork is the whole identity: keep the gap between the horns empty.
    //
    // Arc colours are authored rather than pulled from M.hot because the arc has
    // to stay near-white at its core to read as a discharge; the fuchsia ramp
    // only surrounds it. They track the component colour in parts.js : move both
    // together. The arc gap sits at the multi-tile muzzle point
    // (TurretRules.muzzleTiles: hl - unit * 0.04) so the pulse leaves the gap.
    //
    // Everything emissive here is a function of `progress` (0 just after the
    // pulse, 1 when the mount is ready again : see WeaponPresentationRules
    // reloadTelegraph). The weapon used to wear a permanent white discharge
    // across the horn tips, which said "firing" on a mount that had just fired
    // and would not fire again for nine seconds. Now the bank fills, the charge
    // walks forward through the coils, and only the last stage strikes the arc,
    // so the hull itself tells an opponent how long they have. Nothing here
    // affects when the weapon fires.
    // No live charge state (a palette icon, a blueprint) means a mount at rest,
    // and a mount at rest is one that has not fired: fully recovered, arc
    // struck, ready. Only an actual reported progress can show it spent.
    const progress = chargeProgress === null || chargeProgress === undefined
      ? 1
      : Math.max(0, Math.min(1, Number(chargeProgress) || 0));
    // Fraction of a band [from, to] that `progress` has covered, 0..1.
    const band = (from, to) => Math.max(0, Math.min(1, (progress - from) / Math.max(1e-6, to - from)));
    const arcGlow = "#e879f9";
    const arcCore = "#fdf4ff";
    const bankBack = -hl + unit * 0.06;
    const bankFront = -hl + unit * 0.82;
    const hornRoot = hl * 0.34;
    const hornTip = hl - unit * 0.05;
    const hornSpread = hc * 0.62;
    const arcRing = Math.max(fine, unit * 0.06);

    // 1. Capacitor bank: the heavy mass, all of it at the rear.
    ctx.fillStyle = M.housing;
    roundRect(ctx, { x: bankBack, y: -hc * 0.78, width: bankFront - bankBack, height: hc * 1.56, radius: unit * 0.1 });
    ctx.fill();
    ctx.stroke();

    // Three charge cans recessed into it. Each is a dark slot with the stored
    // charge glowing inside : on the bare bank face the glow alone washed out.
    // They fill bottom to top over the first two thirds of the cycle, and each
    // keeps a dim residual ember at zero so a spent (or blueprint-static) mount
    // still reads as an energy weapon rather than a dead casting.
    const canInset = bankBack + unit * 0.17;
    const canWidth = bankFront - bankBack - unit * 0.34;
    for (const [slot, cy] of [hc * 0.46, 0, -hc * 0.46].entries()) {
      ctx.fillStyle = M.bore;
      roundRect(ctx, { x: bankBack + unit * 0.11, y: cy - hc * 0.15, width: bankFront - bankBack - unit * 0.22, height: hc * 0.3, radius: unit * 0.05 });
      ctx.fill();
      const fill = band(slot * 0.22, slot * 0.22 + 0.3);
      ctx.save();
      ctx.shadowColor = arcGlow;
      ctx.shadowBlur = qualityShadowBlur(3 + 7 * fill);
      ctx.fillStyle = mixColor(arcGlow, "#3b0764", 0.55 - 0.55 * fill);
      roundRect(ctx, {
        x: canInset,
        y: cy - hc * 0.08,
        width: Math.max(unit * 0.06, canWidth * (0.22 + 0.78 * fill)),
        height: hc * 0.16,
        radius: unit * 0.03
      });
      ctx.fill();
      ctx.restore();
    }

    // 2. Spine from the bank forward to the fork root, carrying the coils.
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: bankFront - unit * 0.06, y: -hc * 0.26, width: hornRoot - bankFront + unit * 0.12, height: hc * 0.52, radius: unit * 0.05 });
    ctx.fill();
    ctx.stroke();

    // 3. Induction coils: clamped collars with the charge visible in the gaps
    //    between them, so the spine reads as a launcher stage, not a barrel.
    const coilSpan = hornRoot - bankFront;
    for (let i = 0; i < 3; i += 1) {
      const cx = bankFront + coilSpan * (0.16 + i * 0.34);
      ctx.fillStyle = M.housing;
      roundRect(ctx, { x: cx - unit * 0.055, y: -hc * 0.4, width: unit * 0.11, height: hc * 0.8, radius: unit * 0.025 });
      ctx.fill();
      ctx.stroke();
    }
    // The charge walks forward through the coil gaps: the rear gap lights first,
    // the forward one hands it to the fork. This is the part that reads as
    // movement between two baked stages, so it owns the middle of the cycle.
    for (let i = 0; i < 2; i += 1) {
      const lit = band(0.3 + i * 0.22, 0.55 + i * 0.22);
      if (lit <= 0) continue;
      const cx = bankFront + coilSpan * (0.33 + i * 0.34);
      ctx.save();
      ctx.shadowColor = arcGlow;
      ctx.shadowBlur = qualityShadowBlur(2 + 8 * lit);
      ctx.strokeStyle = mixColor(arcGlow, "#ffffff", 0.45 * lit);
      ctx.lineWidth = arcRing * (0.6 + 0.4 * lit);
      ctx.beginPath();
      ctx.moveTo(cx, -hc * 0.2 * (0.5 + 0.5 * lit));
      ctx.lineTo(cx, hc * 0.2 * (0.5 + 0.5 * lit));
      ctx.stroke();
      ctx.restore();
    }

    // 4. The field gap between the horns, filled flush with no border of its
    //    own (the railgun's open gap does the same job). Without it the two
    //    horns closed up into a solid megaphone cone and the weapon read as a
    //    flared muzzle : the emptiness is the whole point of a fork.
    ctx.save();
    ctx.fillStyle = "rgba(6,10,18,0.55)";
    ctx.beginPath();
    ctx.moveTo(hornRoot - unit * 0.02, -hc * 0.24);
    ctx.lineTo(hornTip, -(hornSpread - hc * 0.16));
    ctx.lineTo(hornTip, hornSpread - hc * 0.16);
    ctx.lineTo(hornRoot - unit * 0.02, hc * 0.24);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 5. The horns themselves: slim tapered quads, not tubes. A rounded pair
    //    would read as twin barrels, which is what this weapon must never be
    //    mistaken for. Both take the lit tone with a shaded inner edge, so the
    //    fork stays symmetric : lighting one horn and shading the other made the
    //    dark side look like a missing piece at small tile sizes.
    for (const side of [-1, 1]) {
      ctx.fillStyle = M.shell;
      ctx.beginPath();
      ctx.moveTo(hornRoot - unit * 0.04, side * hc * 0.2);
      ctx.lineTo(hornRoot - unit * 0.04, side * hc * 0.5);
      ctx.lineTo(hornTip, side * hornSpread);
      ctx.lineTo(hornTip, side * (hornSpread - hc * 0.16));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.save();
      ctx.strokeStyle = M.shellDeep;
      ctx.lineWidth = fine;
      ctx.beginPath();
      ctx.moveTo(hornRoot - unit * 0.02, side * hc * 0.23);
      ctx.lineTo(hornTip - unit * 0.03, side * (hornSpread - hc * 0.13));
      ctx.stroke();
      ctx.restore();
    }

    // 6. The emitter. Three things happen here, in this order across the cycle,
    //    and none of them exist at progress 0 : a spent fork is cold metal.
    const nodeY = hornSpread - hc * 0.08;
    const nodeX = hornTip - unit * 0.07;
    const throatCharge = band(0.4, 0.78);
    const nodeCharge = band(0.55, 0.88);
    // Struck only in the last stretch, and only then does anything on this
    // weapon go white: the arc is the "ready to fire" state, so it must not be
    // confusable with any of the build-up below it.
    const strike = band(0.86, 1);

    // Charge gathering in the throat of the fork, before the horns have it.
    if (throatCharge > 0) {
      ctx.save();
      ctx.shadowColor = arcGlow;
      ctx.shadowBlur = qualityShadowBlur(3 + 9 * throatCharge);
      ctx.fillStyle = mixColor(arcGlow, "#ffffff", 0.5 * throatCharge);
      ctx.beginPath();
      ctx.arc(hornRoot + unit * 0.06, 0, Math.max(0.8, unit * (0.025 + 0.045 * throatCharge)), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Emitter nodes on the horn tips, brightening as the charge reaches them.
    if (nodeCharge > 0) {
      ctx.save();
      ctx.shadowColor = arcGlow;
      ctx.shadowBlur = qualityShadowBlur(3 + 9 * nodeCharge);
      ctx.fillStyle = mixColor(arcGlow, "#ffffff", 0.25 + 0.6 * nodeCharge);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(nodeX, side * nodeY, Math.max(0.9, unit * (0.04 + 0.04 * nodeCharge)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // The discharge itself: a bowed strand with a zigzag inside it. The curve
    // carries the arc at a glance, the zigzag keeps it reading as lightning when
    // the tile is small enough that the glow is all that survives. The bow's
    // control point stays inside hl : bowed past the footprint edge it hung the
    // discharge over the neighbouring tile and clipped in the baked texture.
    if (strike > 0) {
      ctx.save();
      ctx.shadowColor = arcGlow;
      ctx.shadowBlur = qualityShadowBlur(6 + 12 * strike);
      ctx.strokeStyle = arcGlow;
      ctx.lineWidth = Math.max(fine, unit * 0.05) * (0.5 + 0.5 * strike);
      ctx.beginPath();
      ctx.moveTo(nodeX, -nodeY);
      ctx.quadraticCurveTo(hornTip + unit * 0.06 * strike, 0, nodeX, nodeY);
      ctx.stroke();
      ctx.strokeStyle = mixColor(arcGlow, arcCore, strike);
      ctx.lineWidth = Math.max(fine * 0.9, unit * 0.035);
      ctx.beginPath();
      ctx.moveTo(hornTip - unit * 0.09, -(hornSpread - hc * 0.12));
      ctx.lineTo(hornTip - unit * 0.2, -hc * 0.12);
      ctx.lineTo(hornTip - unit * 0.06, hc * 0.06);
      ctx.lineTo(hornTip - unit * 0.09, hornSpread - hc * 0.12);
      ctx.stroke();
      ctx.restore();
    }
    return true;
  }

  if (artType === "plasmaCannon") {
    // A containment weapon, not a gun: a bottle at the breech holding the charge,
    // a short wide throat, and a flared magnetic nozzle. Deliberately built from
    // the beam family's language (chamber -> channel -> aperture) rather than the
    // ballistic one, because what leaves it is contained plasma, but it keeps a
    // solid muzzle mouth so it never reads as an emitter.
    const bottleFront = -hl * 0.18;

    ctx.fillStyle = M.housing;
    roundRect(ctx, { x: -hl * 0.96, y: -hc * 0.56, width: bottleFront + hl * 0.96, height: hc * 1.12, radius: unit * 0.1 });
    ctx.fill();
    ctx.stroke();

    // Charge visible through the bottle wall.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(7);
    ctx.fillStyle = M.hot;
    roundRect(ctx, { x: -hl * 0.8, y: -hc * 0.28, width: (bottleFront + hl * 0.8) * 0.82, height: hc * 0.56, radius: unit * 0.06 });
    ctx.fill();
    ctx.restore();

    // Containment rings clamped over the bottle.
    ctx.save();
    ctx.strokeStyle = M.shellDeep;
    ctx.lineWidth = Math.max(fine, unit * 0.075);
    for (const rx of [-hl * 0.62, -hl * 0.36]) {
      ctx.beginPath();
      ctx.moveTo(rx, -hc * 0.6);
      ctx.lineTo(rx, hc * 0.6);
      ctx.stroke();
    }
    ctx.restore();

    // Throat forward to the nozzle.
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: bottleFront, y: -hc * 0.24, width: hl * 0.82 - bottleFront, height: hc * 0.48, radius: unit * 0.05 });
    ctx.fill();
    ctx.stroke();

    // Flared magnetic nozzle with a hot mouth.
    ctx.fillStyle = M.shellDeep;
    ctx.beginPath();
    ctx.moveTo(hl * 0.7, -hc * 0.3);
    ctx.lineTo(hl * 0.96, -hc * 0.56);
    ctx.lineTo(hl * 0.96, hc * 0.56);
    ctx.lineTo(hl * 0.7, hc * 0.3);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = qualityShadowBlur(8);
    ctx.fillStyle = M.hot;
    ctx.fillRect(hl * 0.88, -hc * 0.34, unit * 0.09, hc * 0.68);
    ctx.restore();
    return true;
  }

  if (artType === "fragmentationCannon") {
    // A shell gun: heavy squat barrel, a visible autoloader drum on one flank,
    // and a stepped muzzle brake. The drum is what separates it from the plain
    // blaster silhouette : you can see it feeds rounds rather than energy.
    const back = -hl * 0.86;
    const tip = hl * 0.92;

    // Autoloader drum, drawn first so the barrel overlaps its root.
    ctx.save();
    ctx.fillStyle = M.housing;
    ctx.strokeStyle = "rgba(3,6,12,0.75)";
    ctx.lineWidth = fine;
    ctx.beginPath();
    ctx.arc(-hl * 0.5, hc * 0.34, Math.min(hc * 0.5, unit * 0.36), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.munitionDeep;
    for (let round = 0; round < 5; round += 1) {
      const a = (Math.PI * 2 * round) / 5;
      ctx.beginPath();
      ctx.arc(-hl * 0.5 + Math.cos(a) * unit * 0.19, hc * 0.34 + Math.sin(a) * unit * 0.19, Math.max(0.9, unit * 0.055), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Breech block and barrel.
    ctx.fillStyle = M.housing;
    roundRect(ctx, { x: back, y: -hc * 0.52, width: hl * 0.44, height: hc * 1.04, radius: unit * 0.07 });
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: back + hl * 0.2, y: -hc * 0.26, width: tip - back - hl * 0.2, height: hc * 0.52, radius: unit * 0.05 });
    ctx.fill();
    ctx.stroke();

    // Stepped muzzle brake: two vents cut through the barrel wall near the mouth.
    ctx.save();
    ctx.fillStyle = "rgba(4,7,13,0.7)";
    for (const vx of [hl * 0.44, hl * 0.62]) {
      ctx.fillRect(vx, -hc * 0.3, unit * 0.07, hc * 0.6);
    }
    ctx.restore();
    ctx.fillStyle = M.shellDeep;
    roundRect(ctx, { x: tip - unit * 0.16, y: -hc * 0.38, width: unit * 0.16, height: hc * 0.76, radius: unit * 0.04 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.bore;
    ctx.fillRect(tip - unit * 0.12, -hc * 0.2, unit * 0.1, hc * 0.4);
    return true;
  }

  if (artType === "spinalAccelerator") {
    drawSpinalAcceleratorTop(unit, hl, hc, color, M, fine, chargeProgress);
    return true;
  }
  return false;
}


export function drawSpecialFootprintDetail(type, unit, tilesLong, tilesCross, color, hl, hc, visualState, rotation = 0, flipped = false) {
  const line = Math.max(1, unit * 0.075);
  const fine = Math.max(0.7, unit * 0.045);

  if (type === "proximityDemolitionCharge" || type === "demolitionCharge") {
    drawDemolitionChargeAssembly(unit, tilesLong, hl, hc, color, visualState);
    return true;
  }

  return false;
}
