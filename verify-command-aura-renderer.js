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

const auraBody = functionBody("drawPixiCommandAura");
const updateBody = functionBody("updatePixiShips");

assert.match(auraBody, /ship\.commandAuraActive\s*&&\s*state\.selectedShipIds\.has\(ship\.id\)/, "only selected operational command emitters should draw their aura range");
assert.doesNotMatch(auraBody, /commandAuraReceived/, "a ship receiving a buff should not draw an aura ring");
assert.match(updateBody, /if \(ship\.commandAuraActive\) drawPixiCommandAura/, "ships without active command components should skip aura rendering");
assert.doesNotMatch(updateBody, /commandAuraActive\s*\|\|\s*ship\.commandAuraReceived/, "received aura state should not enter the aura renderer");

console.log("command aura renderer assertions passed");
