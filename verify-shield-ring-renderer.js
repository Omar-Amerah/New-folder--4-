"use strict";

const assert = require("assert");
const { readFileSync } = require("fs");

const source = readFileSync("public/src/game/pixi/pixiShips.js", "utf8");

function functionBody(name) {
  const start = source.indexOf(`function ${name}`);
  assert.notStrictEqual(start, -1, `${name} should exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`could not extract ${name}`);
}

const shieldBody = functionBody("updatePixiShieldRing");
const colorBody = functionBody("pixiShieldColorForRatio");
const brightenBody = functionBody("brightenPixiShieldColor");
const viewSource = readFileSync("public/src/game/pixi/pixiShipView.js", "utf8");
const vitalsSource = readFileSync("public/src/game/shipVitals.js", "utf8");
const geometrySource = readFileSync("public/src/game/shipGeometry.js", "utf8");
const balance = JSON.parse(readFileSync("component-balance.json", "utf8"));

assert.match(colorBody, /cyan\s*=\s*0x38d5ff/, "full shields should map toward cyan/light blue");
assert.match(colorBody, /amber\s*=\s*0xfbbf24/, "medium shields should map toward amber");
assert.match(colorBody, /red\s*=\s*0xef4444/, "critical shields should map toward red");
assert.match(colorBody, /ratio\s*>\s*0\.5/, "cyan-to-amber transition should be above 50%");
assert.match(colorBody, /ratio\s*\/\s*0\.5/, "red-to-amber transition should cover critical/medium ratios");
assert.match(colorBody, /blendPixiShieldColor/, "shield colours should blend between thresholds");

assert.match(shieldBody, /fieldAlpha\s*=\s*0\.018\s*\+\s*ratio\s*\*\s*0\.055/, "shield field glow should decrease with shield ratio");
assert.match(shieldBody, /shieldRingRadius\(ship, design, SHIP_SCALE\)/, "shield radius should use the rendered design footprint");
assert.match(shieldBody, /fieldRadius\s*=\s*ringRadius/, "shield field fill should end at its visible border");
assert.match(shieldBody, /baseLineWidth\s*=\s*2\.5\s*;/, "shield border should use a stable world width that scales naturally with camera zoom");
assert.doesNotMatch(shieldBody, /baseLineWidth\s*=\s*[^;]*\/\s*zoom/, "shield border should not thicken relative to the ship when zooming out");
assert.strictEqual((shieldBody.match(/gfx\.circle/g) || []).length, 2, "shield rendering should contain only the field circle and continuous main ring");
assert.match(shieldBody, /ringAlpha\s*=\s*0\.24\s*\+\s*ratio\s*\*\s*0\.46/, "main ring opacity should decrease with shield ratio while staying visible");
assert.match(shieldBody, /lineWidth\s*=\s*baseLineWidth\s*\*\s*\(0\.72\s*\+\s*ratio\s*\*\s*0\.28\)/, "main ring thickness should decrease with shield ratio");
assert.match(shieldBody, /if \(ratio <= 0\)[\s\S]*gfx\.visible = false/, "zero shields should hide shield graphics");
assert.match(shieldBody, /shieldRingSig/, "stable shield values should reuse their existing ring geometry");
assert.match(shieldBody, /Math\.round\(ratio \* 1000\)/, "insignificant shield float noise should be quantized before redraw");
assert.match(shieldBody, /phase\s*=\s*pixiShieldIdPhase/, "the highlight should be stable for each ship rather than animate like flicker");
assert.match(shieldBody, /phase \+ Math\.PI \* 0\.42/, "static highlight should remain a short arc");
assert.match(shieldBody, /highlightColor/, "static highlight should use a brighter current shield colour");
assert.doesNotMatch(shieldBody, /performance\.now|now \*/, "shield geometry should not redraw for a wall-clock animation");
assert.match(brightenBody, /0xffffff/, "highlight should brighten the active shield colour");

assert.doesNotMatch(shieldBody, /segmentCount|activeSegments/, "segmented shield counters should be removed");
assert.doesNotMatch(shieldBody, /for\s*\(/, "shield ring should not draw a segmented loop");
assert.doesNotMatch(shieldBody, /gap\s*=/, "continuous shield ring should not contain gaps");
const shieldCode = shieldBody.replace(/\/\/.*$/gm, "");
assert.doesNotMatch(shieldCode, /new\s+(PIXI\.)?(Graphics|Sprite)|Texture|filter|BlurFilter|Particle/i, "shield update should not allocate Pixi objects, textures, filters, or particles per frame");
assert.match(shieldBody, /gfx\.circle\(0, 0, ringRadius\);\s*gfx\.stroke\(\{ width: lineWidth, color, alpha: ringAlpha \}\);/, "main shield ring should be a continuous stroked circle");

const shieldGraphicsMatches = viewSource.match(/new PIXI\.Graphics\(\)/g) || [];
assert.ok(shieldGraphicsMatches.length >= 1, "ship views should own persistent Graphics objects");
assert.strictEqual((viewSource.match(/label = "ShieldRing"/g) || []).length, 1, "there should be one persistent ShieldRing display object per ship view");
assert.match(vitalsSource, /shipLocalBounds\(design, scale\)\.radius/, "shield sizing should derive from occupied hull corners");
assert.match(vitalsSource, /GENERATED_BALANCE\?\.projectiles\?\.shieldCollision/, "visual shield padding should use the authoritative collision balance");
assert.match(geometrySource, /export function shipLocalBounds/, "renderer-neutral footprint bounds should be shared by ship visuals");
assert.match(viewSource, /forwardEdge\s*=\s*hasFootprint\s*\?\s*hullBounds\.maxX\s*:\s*radius/, "direction arrow should anchor to the foremost rendered hull edge");
assert.strictEqual(balance.projectiles.shieldCollision.flatPadding, 12, "small ships should keep twelve units of shield clearance");
assert.match(viewSource, /arrowBaseX\s*=\s*forwardEdge\s*\+\s*9/, "the whole direction arrow should sit farther in front of the hull");
assert.match(viewSource, /arrowTipX\s*=\s*forwardEdge\s*\+\s*21/, "the direction arrow tip should remain clearly separated from the hull");
assert.match(viewSource, /lineWidth\s*=\s*1\.6\s*\/\s*BAKE_NOMINAL_ZOOM/, "the direction arrow should use a thinner stroke");
assert.match(viewSource, /lineTo\(arrowBaseX, -7\)[\s\S]*lineTo\(arrowBaseX, 7\)/, "the direction arrow should retain its original broad arrowhead proportions");

console.log("shield ring renderer assertions passed");
