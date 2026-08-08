"use strict";
// Presentation side of the coolant redesign: the connection mask that gives a
// placed Heat Pipe its shape, and the network lookup the designer uses to
// highlight "what is plumbed to what" on hover.
//
// The player places ONE "Heat Pipe" part; there are no straight/corner/T
// variants in the catalogue. These checks pin that contract down.
const assert = require("assert");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");

globalThis.HeatRules = HeatRules;
global.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, getContext: () => null })
};
global.window = { devicePixelRatio: 1 };

(async () => {
  const layout = await import("../public/src/design/coolantLayout.js");
  const parts = await import("../public/src/design/parts.js");
  parts.applyServerParts(PARTS);
  const catalogue = parts.PART_STATS;
  const { CONNECT_NORTH, CONNECT_EAST, CONNECT_SOUTH, CONNECT_WEST } = layout;

  const masksFor = (design) => layout.coolantConnectionMasks(design, catalogue);
  const pipe = (x, y) => ({ type: "heatPipe", x, y });

  // --- The catalogue has exactly one Heat Pipe part -------------------------
  const pipeVariants = Object.keys(catalogue).filter((id) => /heatpipe/i.test(id));
  assert.deepStrictEqual(pipeVariants, ["heatPipe"], "there is exactly one Heat Pipe part, with no shape variants");
  assert.deepStrictEqual(catalogue.heatPipe.footprint, { width: 1, height: 1 }, "the Heat Pipe stays 1x1");
  assert.strictEqual(parts.isRotatablePart("heatPipe"), false, "the Heat Pipe is not rotatable");
  assert.strictEqual(parts.isRotatablePart("heatVent"), false, "the Heat Vent is not rotatable");
  assert.strictEqual(parts.isPalettePart("heatVent"), true, "the Heat Vent is placeable from the palette");
  assert.strictEqual(catalogue.heatVent.category, "Heat Components", "the Heat Vent joins the thermal family");

  // --- Every shape a pipe can take -----------------------------------------
  assert.strictEqual(masksFor([pipe(5, 5)])[0], 0, "isolated pipe has no connections");

  const horizontal = masksFor([pipe(4, 5), pipe(5, 5), pipe(6, 5)]);
  assert.strictEqual(horizontal[0], CONNECT_EAST, "left endpoint connects east only");
  assert.strictEqual(horizontal[1], CONNECT_EAST | CONNECT_WEST, "middle pipe is a horizontal run");
  assert.strictEqual(horizontal[2], CONNECT_WEST, "right endpoint connects west only");

  const vertical = masksFor([pipe(5, 4), pipe(5, 5), pipe(5, 6)]);
  assert.strictEqual(vertical[1], CONNECT_NORTH | CONNECT_SOUTH, "middle pipe is a vertical run");

  const corner = masksFor([pipe(5, 4), pipe(5, 5), pipe(6, 5)]);
  assert.strictEqual(corner[1], CONNECT_NORTH | CONNECT_EAST, "the bend is a corner");

  const tee = masksFor([pipe(4, 5), pipe(5, 5), pipe(6, 5), pipe(5, 6)]);
  assert.strictEqual(tee[1], CONNECT_EAST | CONNECT_SOUTH | CONNECT_WEST, "the branch point is a T-junction");

  const cross = masksFor([pipe(5, 5), pipe(5, 4), pipe(5, 6), pipe(4, 5), pipe(6, 5)]);
  assert.strictEqual(cross[0], CONNECT_NORTH | CONNECT_EAST | CONNECT_SOUTH | CONNECT_WEST, "four neighbours make a cross");

  // Diagonals never connect.
  assert.strictEqual(masksFor([pipe(5, 5), pipe(6, 6)])[0], 0, "diagonal pipes do not connect");

  // --- Connections reach non-pipe components too ----------------------------
  const withParts = masksFor([
    pipe(5, 5),
    { type: "railgun", x: 4, y: 5 },
    { type: "radiator", x: 6, y: 5 },
    { type: "heatVent", x: 5, y: 6 }
  ]);
  assert.strictEqual(withParts[0], CONNECT_EAST | CONNECT_SOUTH | CONNECT_WEST,
    "a pipe terminates toward every adjacent component, not just other pipes");
  assert.strictEqual(withParts[1], CONNECT_EAST, "the railgun shows a stub toward the pipe");
  assert.strictEqual(withParts[2], CONNECT_WEST, "the radiator shows a stub toward the pipe");
  assert.strictEqual(withParts[3], CONNECT_NORTH, "the vent shows a stub toward the pipe, from any side");

  // Non-pipe components never show a stub toward each other.
  const noPipes = masksFor([{ type: "railgun", x: 4, y: 5 }, { type: "radiator", x: 5, y: 5 }]);
  assert.deepStrictEqual(noPipes, [0, 0], "components with no pipe adjacency show no coolant stub");

  // --- Ship-local rotation --------------------------------------------------
  assert.strictEqual(layout.rotateConnectionMask(CONNECT_NORTH, 1), CONNECT_EAST, "one quarter turn maps blueprint-up onto ship-forward");
  assert.strictEqual(layout.rotateConnectionMask(CONNECT_WEST, 1), CONNECT_NORTH, "rotation wraps around the four bits");
  assert.strictEqual(layout.rotateConnectionMask(CONNECT_NORTH | CONNECT_SOUTH, 1), CONNECT_EAST | CONNECT_WEST, "a vertical run rotates to a horizontal one");
  assert.strictEqual(layout.rotateConnectionMask(15, 1), 15, "a cross is rotation-invariant");
  assert.strictEqual(layout.rotateConnectionMask(CONNECT_NORTH, 4), CONNECT_NORTH, "four quarter turns is the identity");
  // Ship-local space is blueprint space turned a quarter clockwise
  // (moduleLocalPosition maps blueprint -y onto ship-local +x), so the upper
  // pipe's blueprint-south link becomes a ship-local west link and vice versa.
  const shipLocal = layout.shipLocalCoolantMasks([pipe(5, 4), pipe(5, 5)], catalogue);
  assert.strictEqual(masksFor([pipe(5, 4), pipe(5, 5)])[0], CONNECT_SOUTH, "the upper pipe links south on the blueprint");
  assert.strictEqual(shipLocal[0], CONNECT_WEST, "arena art receives the rotated mask");
  assert.strictEqual(shipLocal[1], CONNECT_EAST, "the lower pipe's blueprint-north link points ship-forward");

  // --- Network lookup used by the designer highlight ------------------------
  const branched = [
    { type: "railgun", x: 4, y: 5 },
    pipe(5, 5), pipe(6, 5), pipe(6, 4),
    { type: "radiator", x: 6, y: 3 },
    { type: "heatSink", x: 7, y: 5 },
    { type: "frame", x: 9, y: 9 }
  ];
  const fromPipe = layout.coolantNetworkAt(branched, 1, catalogue);
  assert.deepStrictEqual([...fromPipe.pipes].sort((a, b) => a - b), [1, 2, 3], "the whole pipe run is one network");
  assert.deepStrictEqual([...fromPipe.attachments].sort((a, b) => a - b), [0, 4, 5], "every attached endpoint is reported");

  const fromEndpoint = layout.coolantNetworkAt(branched, 4, catalogue);
  assert.deepStrictEqual([...fromEndpoint.pipes].sort((a, b) => a - b), [1, 2, 3],
    "hovering an attached component finds the same network as hovering a pipe");
  assert.strictEqual(layout.coolantNetworkAt(branched, 6, catalogue), null, "an unplumbed component has no coolant network");

  // Removing the middle pipe splits the presentation network the same way the
  // server splits the simulated one.
  const severed = branched.filter((_, index) => index !== 2);
  const severedRailgunSide = layout.coolantNetworkAt(severed, 1, catalogue);
  assert.deepStrictEqual([...severedRailgunSide.pipes], [1], "the source side keeps only its own pipe");
  assert.deepStrictEqual([...severedRailgunSide.attachments].sort((a, b) => a - b), [0], "the radiator is no longer on the source's network");

  console.log("Coolant layout (Heat Pipe shapes and network highlight) verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
