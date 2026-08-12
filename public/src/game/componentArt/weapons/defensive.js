// Point defence, flak, interceptor, and Aegis artwork.

import { ctx } from "../../../ui/dom.js";
import { qualityShadowBlur } from "../../renderSettings.js";
import { mixColor, roundRect } from "../common.js";
import { drawTurretCap, weaponBodyFill, weaponFine, weaponLine } from "./common.js";

function drawAegisEmitterRing(unit, radius) {
  ctx.save();
  ctx.shadowColor = "#34d399";
  ctx.shadowBlur = qualityShadowBlur(6);
  ctx.strokeStyle = "#6ee7b7";
  ctx.lineWidth = Math.max(1.4, unit * 0.085);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(110,231,183,0.45)";
  ctx.lineWidth = Math.max(0.8, unit * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.6, 0, Math.PI * 2);
  ctx.stroke();
  // Emitter nodes on the ring keep the field legible when the glow is off.
  ctx.fillStyle = "#a7f3d0";
  for (let i = 0; i < 4; i += 1) {
    const a = Math.PI * (0.25 + i * 0.5);
    ctx.beginPath();
    ctx.arc(Math.cos(a) * radius, Math.sin(a) * radius, Math.max(1, unit * 0.06), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#ecfdf5";
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1, unit * 0.09), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function drawDefensiveWeaponTop(artType, size, color, M) {
  if (artType === "pointDefense") {
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: 0, y: -size * 0.08, width: size * 0.62, height: size * 0.16, radius: size * 0.04 });
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = M.bore;
    ctx.fillRect(size * 0.5, -size * 0.06, size * 0.12, size * 0.12);
    ctx.fillStyle = M.hot;
    ctx.fillRect(size * 0.54, -size * 0.025, size * 0.06, size * 0.05);
    ctx.strokeStyle = M.trimLine;
    ctx.lineWidth = weaponFine(size);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.3, -Math.PI * 0.34, Math.PI * 0.34);
    ctx.stroke();
    drawTurretCap(size, color, 0.14);
    return true;
  }

  if (artType === "flakCannon") {
    ctx.lineWidth = weaponLine(size) * 0.8;
    for (const cy of [-size * 0.22, size * 0.22]) {
      ctx.save();
      ctx.translate(0, cy);
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: size * 0.01, y: -size * 0.06, width: size * 0.44, height: size * 0.12, radius: size * 0.02 });
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = M.bore;
      ctx.fillRect(size * 0.37, -size * 0.05, size * 0.08, size * 0.1);
      ctx.restore();
    }
    ctx.lineWidth = weaponLine(size);
    ctx.save();
    ctx.translate(0, -size * 0.22);
    drawTurretCap(size * 0.65, color, 0.16);
    ctx.restore();
    ctx.save();
    ctx.translate(0, size * 0.22);
    drawTurretCap(size * 0.65, color, 0.16);
    ctx.restore();
    return true;
  }

  if (artType === "aegisProjector") {
    drawAegisEmitterRing(size, size * 0.32);
    return true;
  }

  if (artType === "interceptorPod") {
    // Three-cell interceptor launcher: a boxed magazine with three tubes running
    // forward, each holding a round whose nose sits at the tube mouth. This was
    // three bare dark bars with a dot on the end of each, which read as a vent
    // rather than a weapon and shared no construction with the other launchers.
    const back = -size * 0.32;
    const mouth = size * 0.36;
    const half = size * 0.085;
    const rows = [-size * 0.21, 0, size * 0.21];

    ctx.fillStyle = M.housing;
    ctx.lineWidth = weaponLine(size);
    roundRect(ctx, { x: back, y: -size * 0.33, width: mouth - back + size * 0.03, height: size * 0.66, radius: size * 0.06 });
    ctx.fill();
    ctx.stroke();

    ctx.lineWidth = weaponFine(size);
    for (const cy of rows) {
      ctx.save();
      ctx.translate(0, cy);
      // Tube bore, open at the front.
      ctx.fillStyle = M.bore;
      roundRect(ctx, { x: back + size * 0.04, y: -half, width: mouth - back - size * 0.02, height: half * 2, radius: size * 0.02 });
      ctx.fill();
      // Loaded round: flat body, darker nose cone, seated with the nose at the
      // mouth so a loaded pod is distinguishable from an empty rack.
      ctx.fillStyle = weaponBodyFill(M);
      roundRect(ctx, { x: back + size * 0.09, y: -half * 0.6, width: size * 0.47, height: half * 1.2, radius: size * 0.015 });
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = M.shellDeep;
      ctx.beginPath();
      ctx.moveTo(mouth - size * 0.01, 0);
      ctx.lineTo(mouth - size * 0.11, -half * 0.6);
      ctx.lineTo(mouth - size * 0.11, half * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Seeker heads: the pod's one emissive mark, repeated once per loaded round.
    ctx.fillStyle = M.hot;
    for (const cy of rows) {
      ctx.beginPath();
      ctx.arc(mouth - size * 0.05, cy, Math.max(0.7, size * 0.026), 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Unknown rotating weapon: generic barrel to the shared default muzzle tip.
    ctx.fillStyle = weaponBodyFill(M);
    roundRect(ctx, { x: size * 0.02, y: -size * 0.11, width: size * 0.58, height: size * 0.22, radius: size * 0.06 });
    ctx.fill();
    drawTurretCap(size, color);
    return true;
  }
  return false;
}

export function drawDefensiveMultiWeaponTop(artType, unit, hl, hc, color, chargeProgress, M, fine) {
  if (artType === "aegisProjector") {
    // Same emitter ring as the single-cell head, scaled to the footprint: no
    // barrel, so a multi-cell projector never reads as a gun.
    drawAegisEmitterRing(unit, Math.min(hl, hc) * 0.82);
    return true;
  }
  return false;
}
