// Shared weapon-only metals, line scales, and turret cap primitives.

import { ctx } from "../../../ui/dom.js";
import { colorLightness, mixColor, parseColor, saturate, withLightness } from "../common.js";

export function weaponBodyFill(M) {
  return M.shell;
}

export function weaponMetals(color) {
  const { r, g, b } = parseColor(color);
  // Already-pale parts (the railgun's near-white, for one) have nowhere to go
  // lighter: brightening them further collapses the whole weapon into one grey
  // mass on a grey tile. Those shade downward instead, keeping the same
  // light-body/dark-structure relationship the rest of the family has.
  const pale = (r * 0.299 + g * 0.587 + b * 0.114) / 255 > 0.9;
  // A round drawn onto the bare hull cube needs more separation than `shell`
  // gives it. `shell` is one small step off the component colour, which is
  // plenty inside a recessed dark bay but vanishes against a full-strength hull
  // face of the same colour : the missile's amber body on its amber launcher was
  // invisible, leaving the round reading as a black line drawing. The munition
  // ramp keeps the component hue and forces a fixed lightness step instead:
  // upward for dark and mid hulls, downward for ones already too light to climb
  // (a lighter lilac than the torpedo's would just wash out to white).
  const lightness = colorLightness(color);
  const bodyLight = lightness > 0.72 ? lightness - 0.19 : Math.min(0.78, lightness + 0.19);
  // Re-saturated like the rest of the ramp: setting lightness alone squeezes the
  // chroma out of a colour on its way up, which turned the swarm rack's teal
  // rounds into pale mint.
  const munition = saturate(withLightness(color, bodyLight), 0.35);
  // Warhead cone and casing bands. Measured down from whichever of the hull and
  // the body is darker, so the head separates from both : pinned to the body
  // alone it landed back on the hull's own value on the parts whose round is the
  // lighter of the two.
  const munitionDeep = saturate(
    withLightness(color, Math.max(0.16, Math.min(lightness, bodyLight) - 0.22)),
    0.25
  );
  return {
    shell: pale ? mixColor(color, "#5c6577", 0.4) : saturate(mixColor(color, "#f4f7ff", 0.16), 0.5),
    shellDeep: saturate(mixColor(color, "#05070c", pale ? 0.55 : 0.3), 0.4),
    housing: saturate(mixColor(color, "#05070c", pale ? 0.68 : 0.44), 0.3),
    trimLine: "rgba(226,232,240,0.28)",
    bore: "rgba(4,7,13,0.94)",
    hot: pale ? mixColor(color, "#ffffff", 0.2) : saturate(mixColor(color, "#ffffff", 0.26), 0.75),
    munition,
    munitionDeep
  };
}

export function weaponLine(unit) {
  return Math.max(0.8, unit * 0.06);
}

export function weaponFine(unit) {
  return Math.max(0.7, unit * 0.04);
}

export function drawTurretCap(size, color, r = 0.16) {
  ctx.save();
  ctx.fillStyle = mixColor(color, "#05070c", 0.3);
  ctx.strokeStyle = "rgba(3,6,12,0.72)";
  ctx.lineWidth = Math.max(0.7, size * 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, size * r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Concentric pivot mark, not an offset specular blob: the off-centre highlight
  // was reading as a lit sphere sitting on the tile.
  ctx.fillStyle = "rgba(226,232,240,0.22)";
  ctx.beginPath();
  ctx.arc(0, 0, size * r * 0.38, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

