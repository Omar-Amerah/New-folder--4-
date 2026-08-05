#!/usr/bin/env node
"use strict";
const assert = require("assert/strict");
const shared = require("./public/src/shared/rotationRules.js");
const server = require("./src/server/shipDesign.js");
const { PARTS } = require("./src/server/components.js");

(async () => {
  const client = await import("./public/src/design/rotation.js");
  const columns = [6, 7, 8];
  const allowedSets = [undefined, [0, 90, 180, 270], [90, 270], [0, 180], [90], [270]];
  const values = [0, 90, 180, 270, -90, 450, undefined, null, "90", "invalid"];

  for (const x of columns) {
    for (const allowed of allowedSets) {
      for (const value of values) {
        const expected = shared.normalizeRotation(value, allowed, x);
        assert.equal(client.normalizeRotation(value, allowed, x), expected, `client normalize ${value}/${allowed}/${x}`);
        assert.equal(server.normalizeRotation(value, allowed, x), expected, `server normalize ${value}/${allowed}/${x}`);
      }
    }
  }

  for (const [x, expected] of [[6, 90], [7, 270], [8, 270]]) {
    for (const api of [shared, client]) {
      assert.equal(api.normalizeRotation("invalid", [90, 270], x), expected, `two-sided fallback at x ${x}`);
      assert.equal(api.legacySideRotation(x), expected, `legacy side at x ${x}`);
      assert.equal(api.maneuverThrusterAutoRotation(x), expected, `maneuver auto at x ${x}`);
    }
    assert.equal(server.normalizeRotation("invalid", [90, 270], x), expected, `server two-sided fallback at x ${x}`);
    assert.equal(server.normalizePartRotation("maneuverThruster", x, 0), expected, `server maneuver at x ${x}`);
  }

  assert.equal(shared.normalizeRotation(90, [90, 270], 8), 90, "exact valid side rotation is preserved");
  assert.equal(shared.normalizeRotation("invalid", [0, 180], 8), 0, "non-two-sided invalid prefers zero");
  assert.equal(shared.normalizeRotation("invalid", [90], 8), 90, "non-two-sided invalid falls back to first allowed");

  for (const type of ["blaster", "missile", "railgun", "beam", "reactor", "shield"]) {
    if (!PARTS[type]) continue;
    for (const x of columns) {
      for (const value of values) {
        const allowed = PARTS[type].allowedRotations;
        const clientValue = client.normalizeRotation(value, allowed, x);
        const serverValue = server.normalizePartRotation(type, x, value);
        if (Array.isArray(allowed) && allowed.length) assert.equal(serverValue, clientValue, `${type} parity at ${x}/${value}`);
      }
    }
  }
  assert.equal(server.normalizePartRotation("armor", 7, 90), 0, "non-rotatable parts remain rotation 0");
  assert.equal(server.normalizePartRotation("core", 7, 270), 0, "core remains rotation 0");

  console.log("Rotation parity verification passed");
})().catch((err) => { console.error(err); process.exit(1); });
