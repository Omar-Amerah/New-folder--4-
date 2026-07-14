"use strict";
const assert = require("assert");
const serverFootprint = require("./src/server/footprint");
(async () => {
  const clientFootprint = await import("./public/src/design/footprint.js");
  const rotation = await import("./public/src/design/rotation.js");
  const heat = await import("./public/src/shared/componentHeatSnapshot.js");
  const cases = [
    { x: 0, y: 0, footprint: { width: 1, height: 1 } },
    { x: 5, y: 5, footprint: { width: 2, height: 1 } },
    { x: 5, y: 5, footprint: { width: 1, height: 2 } }
  ];
  for (const c of cases) for (const r of [-90, 0, 90, 180, 270, 450]) {
    assert.deepStrictEqual(clientFootprint.getOccupiedCells(c.x, c.y, c.footprint, r), serverFootprint.getOccupiedCells(c.x, c.y, c.footprint, r));
    assert.deepStrictEqual(clientFootprint.getFootprintBounds(c.x, c.y, c.footprint, r), serverFootprint.getFootprintBounds(c.x, c.y, c.footprint, r));
  }
  assert.strictEqual(rotation.normalizeRotation(-90), 0);
  assert.strictEqual(rotation.normalizeRotation(450), 0);
  assert.strictEqual(heat.COMPONENT_HEAT_DELTA_STRIDE, 5);
  assert.deepStrictEqual(heat.componentHeatTupleFromDelta([0, 1, 2, 0.5, 10], 0), { index: 0, tuple: [1, 2, 0.5, 10] });
  console.log("Shared parity verification passed");
})().catch((err) => { console.error(err); process.exit(1); });
