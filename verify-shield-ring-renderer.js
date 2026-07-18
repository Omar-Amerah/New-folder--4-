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

assert.match(colorBody, /cyan\s*=\s*0x38d5ff/, "full shields should map toward cyan/light blue");
assert.match(colorBody, /amber\s*=\s*0xfbbf24/, "medium shields should map toward amber");
assert.match(colorBody, /red\s*=\s*0xef4444/, "critical shields should map toward red");
assert.match(colorBody, /ratio\s*>\s*0\.5/, "cyan-to-amber transition should be above 50%");
assert.match(colorBody, /ratio\s*\/\s*0\.5/, "red-to-amber transition should cover critical/medium ratios");
assert.match(colorBody, /blendPixiShieldColor/, "shield colours should blend between thresholds");

assert.match(shieldBody, /fieldAlpha\s*=\s*0\.018\s*\+\s*ratio\s*\*\s*0\.055/, "shield field glow should decrease with shield ratio");
assert.strictEqual((shieldBody.match(/gfx\.circle/g) || []).length, 2, "shield rendering should contain only the field circle and continuous main ring");
assert.match(shieldBody, /ringAlpha\s*=\s*0\.24\s*\+\s*ratio\s*\*\s*0\.46/, "main ring opacity should decrease with shield ratio while staying visible");
assert.match(shieldBody, /lineWidth\s*=\s*baseLineWidth\s*\*\s*\(0\.72\s*\+\s*ratio\s*\*\s*0\.28\)/, "main ring thickness should decrease with shield ratio");
assert.match(shieldBody, /if \(ratio <= 0\)[\s\S]*gfx\.visible = false/, "zero shields should hide shield graphics");
assert.match(shieldBody, /phase\s*=\s*now \* 1\.15 \+ pixiShieldIdPhase/, "animated highlight should continue rotating smoothly");
assert.match(shieldBody, /phase \+ Math\.PI \* 0\.42/, "animated highlight should remain a short arc");
assert.match(shieldBody, /highlightColor/, "animated highlight should use a brighter current shield colour");
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

console.log("shield ring renderer assertions passed");
