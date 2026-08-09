#!/usr/bin/env node
"use strict";
// Component mirroring (flip) verification.
//
// Covers the whole path a mirrored component travels: the shared transform
// authority, the catalogue's `flippable` metadata, designer placement/preview,
// blueprint save/load and duplication, server validation, and client/server
// geometry agreement — plus the compatibility guarantee that a blueprint with no
// `flipped` field behaves exactly as it did before mirroring existed.
const assert = require("assert/strict");
const ComponentTransform = require("../public/src/shared/componentTransform.js");
const serverFootprint = require("../src/server/footprint");
const shipDesign = require("../src/server/shipDesign");
const { PARTS } = require("../src/server/components");
const StructuralConnectivity = require("../public/src/shared/structuralConnectivity.js");
const EngineExhaust = require("../public/src/shared/engineExhaust.js");
const HeatRules = require("../public/src/shared/heatRules.js");

// Every shaped structural silhouette, in all five materials.
const EXPECTED_FLIPPABLE = [
  "halfFrameDiagonal", "halfArmorDiagonal", "halfCompositeArmorDiagonal",
  "halfAblativeArmorDiagonal", "halfRefractoryArmorDiagonal",
  "bevelFrame", "bevelArmor", "bevelCompositeArmor", "bevelAblativeArmor", "bevelRefractoryArmor",
  "roundedFrame", "roundedArmor", "roundedCompositeArmor", "roundedAblativeArmor", "roundedRefractoryArmor",
  "longWedgeFrame", "longWedgeArmor", "longWedgeCompositeArmor", "longWedgeAblativeArmor", "longWedgeRefractoryArmor"
].sort();

const NOT_FLIPPABLE = ["frame", "armor", "compositeArmor", "ablativeArmor", "refractoryArmor",
  "wingFrame", "wingArmor", "wingCompositeArmor", "core", "blaster", "railgun", "reactor", "engine", "shield"];

const cellKeys = (cells) => cells.map((cell) => `${cell.x},${cell.y}`).sort();

(async () => {
  // ---------------------------------------------------------------- transform
  // 1. A component with no `flipped` field is not mirrored.
  assert.equal(ComponentTransform.normalizeFlipped(undefined), false, "absent flipped defaults to false");
  assert.equal(ComponentTransform.normalizeFlipped(null), false, "null flipped defaults to false");
  assert.equal(ComponentTransform.normalizeFlipped(0), false, "falsy flipped is false");
  assert.equal(ComponentTransform.normalizeFlipped("true"), false, "only an explicit boolean true is a flip");
  assert.equal(ComponentTransform.normalizeFlipped(true), true, "explicit true is a flip");
  assert.equal(ComponentTransform.TRANSFORM_ORDER, "mirror-then-rotate", "one documented transform order");

  // 2. The mirror reverses local shape coordinates about the footprint centre.
  const wide = { width: 3, height: 2 };
  assert.deepEqual(
    ComponentTransform.transformLocalOffset(0, 0, wide, 0, true),
    { x: 2, y: 0 },
    "mirror maps the leading local column to the trailing one"
  );
  assert.deepEqual(
    ComponentTransform.transformLocalOffset(2, 1, wide, 0, true),
    { x: 0, y: 1 },
    "mirror is horizontal only: the local row is untouched"
  );

  // 3-5. Mirror combined with each rotation. Expected values are derived by
  // hand: mirror first (dx -> width-1-dx), then the rotation about the anchor.
  const wedge = { width: 2, height: 1 };
  const transformed = (rotation, flipped) => ComponentTransform
    .getOccupiedCells(7, 7, wedge, rotation, flipped)
    .map((cell) => `${cell.x},${cell.y}`);
  assert.deepEqual(transformed(0, false), ["7,7", "8,7"], "unflipped 0deg");
  assert.deepEqual(transformed(0, true), ["8,7", "7,7"], "flipped 0deg reverses local order in place");
  assert.deepEqual(transformed(90, false), ["7,7", "7,8"], "unflipped 90deg");
  assert.deepEqual(transformed(90, true), ["7,8", "7,7"], "flip + 90deg");
  assert.deepEqual(transformed(180, false), ["7,7", "6,7"], "unflipped 180deg");
  assert.deepEqual(transformed(180, true), ["6,7", "7,7"], "flip + 180deg");
  assert.deepEqual(transformed(270, false), ["7,7", "7,6"], "unflipped 270deg");
  assert.deepEqual(transformed(270, true), ["7,6", "7,7"], "flip + 270deg");

  // 6. Flipping twice restores the original geometry, at every rotation.
  for (const rotation of [0, 90, 180, 270]) {
    const once = ComponentTransform.transformLocalOffset(0, 0, wide, rotation, true);
    const twice = ComponentTransform.transformLocalOffset(
      ComponentTransform.transformLocalOffset(0, 0, wide, 0, true).x,
      0,
      wide,
      rotation,
      true
    );
    const plain = ComponentTransform.transformLocalOffset(0, 0, wide, rotation, false);
    assert.deepEqual(twice, plain, `double flip is identity at ${rotation}deg`);
    assert.notDeepEqual(once, plain, `a single flip actually changes local geometry at ${rotation}deg`);
  }

  // 7. Four rotations return to the original orientation, mirrored or not.
  for (const flipped of [false, true]) {
    const start = cellKeys(ComponentTransform.getOccupiedCells(7, 7, wedge, 0, flipped));
    let rotation = 0;
    for (let step = 0; step < 4; step += 1) rotation = (rotation + 90) % 360;
    assert.deepEqual(cellKeys(ComponentTransform.getOccupiedCells(7, 7, wedge, rotation, flipped)), start,
      `four 90deg rotations return to the original cells (flipped=${flipped})`);
  }

  // A mirror inside a rectangular footprint never moves the component: pressing
  // Flip cannot relocate a placed part or change its footprint.
  for (const footprint of [{ width: 1, height: 1 }, { width: 2, height: 1 }, { width: 3, height: 2 }]) {
    for (const rotation of [0, 90, 180, 270]) {
      assert.deepEqual(
        cellKeys(ComponentTransform.getOccupiedCells(7, 7, footprint, rotation, true)),
        cellKeys(ComponentTransform.getOccupiedCells(7, 7, footprint, rotation, false)),
        `mirrored ${footprint.width}x${footprint.height} occupies the same cells at ${rotation}deg`
      );
      assert.deepEqual(
        ComponentTransform.getFootprintBounds(7, 7, footprint, rotation, true),
        ComponentTransform.getFootprintBounds(7, 7, footprint, rotation, false),
        `mirrored bounds are unchanged at ${rotation}deg`
      );
    }
  }

  assert.equal(ComponentTransform.artFlipScaleX(true), -1, "mirrored art scales x by -1");
  assert.equal(ComponentTransform.artFlipScaleX(false), 1, "unmirrored art is unscaled");

  // ---------------------------------------------------------------- catalogue
  const serverFlippable = Object.keys(PARTS).filter((id) => PARTS[id].flippable === true).sort();
  assert.deepEqual(serverFlippable, EXPECTED_FLIPPABLE, "exactly the shaped structural variants are flippable");
  for (const type of NOT_FLIPPABLE) {
    assert.ok(PARTS[type], `${type} exists in the catalogue`);
    assert.notEqual(PARTS[type].flippable, true, `${type} is not flippable`);
  }

  // ------------------------------------------------------------------- client
  global.document = {
    createElement: () => ({
      getContext: () => ({
        clearRect() {}, fillRect() {}, beginPath() {}, arc() {}, fill() {}, stroke() {}, moveTo() {},
        lineTo() {}, closePath() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
        clip() {}, setTransform() {}, fillText() {}, measureText() { return { width: 0 }; }
      }),
      toDataURL: () => "data:image/png;base64,"
    }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { classList: { add() {}, remove() {} } }
  };
  global.window = { devicePixelRatio: 1 };
  globalThis.EngineExhaustRules = EngineExhaust;
  globalThis.HeatRules = HeatRules;
  globalThis.DataSupportRules = require("../public/src/shared/dataSupportRules.js");

  const parts = await import("../public/src/design/parts.js");
  parts.applyServerParts(PARTS);
  const storage = await import("../public/src/design/blueprintStorage.js");
  const clientFootprint = await import("../public/src/design/footprint.js");
  const { createPlacementCandidate } = await import("../public/src/design/placementCandidate.js");

  const clientFlippable = Object.keys(PARTS).filter((id) => parts.isFlippablePart(id)).sort();
  assert.deepEqual(clientFlippable, EXPECTED_FLIPPABLE, "client and server agree on which parts are flippable");

  // 1 (client). No `flipped` field means not mirrored, and nothing is written.
  const plain = storage.makeDesignPart(5, 5, "bevelArmor", 0);
  assert.equal(plain.flipped, undefined, "an unmirrored part carries no flipped field");
  assert.equal(plain.flipped === true, false, "an unmirrored part reads as not flipped");

  const mirrored = storage.makeDesignPart(5, 5, "bevelArmor", 90, true);
  assert.equal(mirrored.flipped, true, "a mirrored flippable part stores flipped: true");
  assert.equal(mirrored.rotation, 90, "mirroring leaves rotation alone");

  // 9. A non-flippable component ignores the flip cleanly (no error, no field).
  const symmetric = storage.makeDesignPart(5, 5, "armor", 0, true);
  assert.equal(symmetric.flipped, undefined, "a non-flippable part silently drops the flip");

  // ------------------------------------------------------- placement + preview
  // core 1x1 at (7,7); engine is 1x2 (7,8)-(7,9); reactor is 2x1 (5,7)-(6,7).
  const baseDesign = [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "engine" },
    { x: 5, y: 7, type: "reactor" }
  ];

  // 8. The preview's transformed shape is exactly what gets placed.
  const preview = createPlacementCandidate({
    grid: { x: 8, y: 7 },
    componentType: "bevelArmor",
    rotation: 90,
    flipped: true,
    design: baseDesign,
    catalogue: parts.PART_STATS
  });
  assert.ok(preview.ok, `mirrored placement is valid: ${preview.message}`);
  assert.equal(preview.normalizedFlipped, true, "the preview reports the mirrored transform");
  assert.equal(preview.part.flipped, true, "the placed part carries the previewed mirror");
  const placed = preview.nextDesign.find((part) => part.type === "bevelArmor");
  assert.deepEqual(
    cellKeys(preview.occupiedCells),
    cellKeys(clientFootprint.getOccupiedCells(placed.x, placed.y, PARTS.bevelArmor.footprint, placed.rotation, placed.flipped === true)),
    "previewed cells are the placed component's cells"
  );

  // 9 (placement). Flip requested on a non-flippable part is dropped, not rejected.
  const symmetricCandidate = createPlacementCandidate({
    grid: { x: 8, y: 7 },
    componentType: "armor",
    rotation: 0,
    flipped: true,
    design: baseDesign,
    catalogue: parts.PART_STATS
  });
  assert.ok(symmetricCandidate.ok, "a flip request never invalidates a non-flippable placement");
  assert.equal(symmetricCandidate.normalizedFlipped, false, "non-flippable placement reports no mirror");
  assert.equal(symmetricCandidate.part.flipped, undefined, "non-flippable placement stores no flipped field");

  // 15. An invalid mirrored placement is still rejected.
  const overlapping = createPlacementCandidate({
    grid: { x: 5, y: 7 },
    componentType: "longWedgeArmor",
    rotation: 0,
    flipped: true,
    design: baseDesign,
    catalogue: parts.PART_STATS,
    mode: "add"
  });
  assert.equal(overlapping.ok, false, "a mirrored placement over another component is rejected");
  assert.equal(overlapping.reasonCode, "overlap", "rejection names the overlap");

  const offGrid = createPlacementCandidate({
    grid: { x: 14, y: 7 },
    componentType: "longWedgeArmor",
    rotation: 0,
    flipped: true,
    design: baseDesign,
    catalogue: parts.PART_STATS,
    mode: "add"
  });
  assert.equal(offGrid.ok, false, "a mirrored placement leaving the grid is rejected");
  assert.equal(offGrid.reasonCode, "out-of-bounds", "rejection names the bounds failure");

  // ------------------------------------------------------------ save and load
  const mirroredDesign = [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "engine" },
    { x: 6, y: 7, type: "bevelArmor", rotation: 0, flipped: true },
    { x: 8, y: 7, type: "bevelArmor", rotation: 0 },
    { x: 7, y: 6, type: "roundedFrame", rotation: 270, flipped: true }
  ];

  // 10. Save/load preserves flipped.
  const envelope = storage.designEnvelope(mirroredDesign, null, [], "hold");
  const reloaded = storage.migrateDesignStorage(JSON.parse(JSON.stringify(envelope)));
  const reloadedByCell = new Map(reloaded.modules.map((part) => [`${part.x},${part.y}`, part]));
  assert.equal(reloadedByCell.get("6,7").flipped, true, "a mirrored component survives save/load");
  assert.equal(reloadedByCell.get("8,7").flipped, undefined, "its unmirrored twin stays unmirrored");
  assert.equal(reloadedByCell.get("7,6").flipped, true, "mirror survives alongside a rotation");
  assert.equal(reloadedByCell.get("7,6").rotation, 270, "rotation survives alongside a mirror");

  // 11. Old blueprint data (no flipped anywhere) is unchanged by the new field.
  const legacy = [
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "engine" },
    { x: 6, y: 7, type: "bevelArmor", rotation: 90 }
  ];
  const legacyModules = storage.normalizeDesignDetailed(legacy).modules;
  assert.deepEqual(
    legacyModules,
    [
      { x: 7, y: 7, type: "core", rotation: 0 },
      { x: 7, y: 8, type: "engine", rotation: 0 },
      { x: 6, y: 7, type: "bevelArmor", rotation: 90 }
    ],
    "a pre-mirroring blueprint normalizes to exactly the same modules as before"
  );
  for (const part of legacyModules) {
    assert.ok(!Object.hasOwn(part, "flipped"), `${part.type} gains no flipped field`);
  }

  // 12. Duplicate/copy keeps the mirror.
  const saved = [{ id: "d1", name: "Mirrored", blueprint: mirroredDesign, dataLinks: [], combatStyle: "hold" }];
  const exported = storage.exportBlueprints(saved, []);
  const imported = storage.importBlueprints(JSON.parse(JSON.stringify(exported)), [], []);
  assert.equal(imported.acceptedDesigns, 1, `import accepted the mirrored blueprint: ${imported.warnings.join("; ")}`);
  const importedPart = imported.designs[0].blueprint.find((part) => part.x === 6 && part.y === 7);
  assert.equal(importedPart.flipped, true, "export/import round trip preserves the mirror");
  const duplicate = imported.designs[0].blueprint.map((part) => ({ ...part }));
  assert.equal(duplicate.find((part) => part.x === 6 && part.y === 7).flipped, true, "duplicating a design preserves the mirror");

  // -------------------------------------------------------------- server side
  const validated = shipDesign.validateDesign(mirroredDesign);
  assert.ok(validated.ok, `server accepts a mirrored design: ${validated.reason || ""}`);
  const serverByCell = new Map(validated.modules.map((part) => [`${part.x},${part.y}`, part]));
  assert.equal(serverByCell.get("6,7").flipped, true, "the server preserves a mirrored component");
  assert.equal(serverByCell.get("8,7").flipped, undefined, "the server writes no flipped field when unmirrored");

  const spoofed = shipDesign.validateDesign([
    { x: 7, y: 7, type: "core" },
    { x: 7, y: 8, type: "engine" },
    { x: 6, y: 7, type: "armor", flipped: true }
  ]);
  assert.ok(spoofed.ok, "a flip claimed on a non-flippable part does not reject the design");
  assert.equal(spoofed.modules.find((part) => part.type === "armor").flipped, undefined,
    "the server drops a flip the catalogue does not offer");

  const snapshot = shipDesign.createShipBlueprintSnapshot(mirroredDesign, null);
  assert.equal(snapshot.design.find((part) => part.x === 6 && part.y === 7).flipped, true,
    "the spawned ship's blueprint snapshot keeps the mirror");

  // 11 (server). A design with no flipped fields serializes exactly as before.
  assert.deepEqual(
    shipDesign.normalizeShipDesignSnapshot(legacy),
    [
      { x: 7, y: 7, type: "core", rotation: 0 },
      { x: 7, y: 8, type: "engine", rotation: 0 },
      { x: 6, y: 7, type: "bevelArmor", rotation: 90 }
    ],
    "server snapshot of a pre-mirroring design is unchanged"
  );

  // 16. Client and server agree on the transformed geometry, part for part.
  for (const type of EXPECTED_FLIPPABLE) {
    const footprint = PARTS[type].footprint || { width: 1, height: 1 };
    for (const rotation of [0, 90, 180, 270]) {
      for (const flipped of [false, true]) {
        assert.deepEqual(
          clientFootprint.getOccupiedCells(7, 7, footprint, rotation, flipped),
          serverFootprint.getOccupiedCells(7, 7, footprint, rotation, flipped),
          `${type} cells agree at ${rotation}deg flipped=${flipped}`
        );
        assert.deepEqual(
          clientFootprint.getFootprintBounds(7, 7, footprint, rotation, flipped),
          serverFootprint.getFootprintBounds(7, 7, footprint, rotation, flipped),
          `${type} bounds agree at ${rotation}deg flipped=${flipped}`
        );
      }
    }
  }
  const clientNormalized = storage.normalizeDesignDetailed(mirroredDesign).modules
    .map((part) => ({ x: part.x, y: part.y, type: part.type, rotation: part.rotation, flipped: part.flipped === true }));
  const serverNormalized = validated.modules
    .map((part) => ({ x: part.x, y: part.y, type: part.type, rotation: part.rotation, flipped: part.flipped === true }));
  assert.deepEqual(clientNormalized, serverNormalized, "client and server normalize a mirrored design identically");

  // 14 / 13. Gameplay geometry: collision cells and structural adjacency see the
  // mirrored component on exactly the cells the designer showed.
  const { componentCellLocalCoords } = require("../src/server/componentGeometry");
  const localKeys = (coords) => coords.map((point) => `${point.x},${point.y}`).sort();
  for (const rotation of [0, 90, 180, 270]) {
    const flippedCoords = componentCellLocalCoords({ x: 7, y: 7, type: "longWedgeArmor", rotation, flipped: true });
    const plainCoords = componentCellLocalCoords({ x: 7, y: 7, type: "longWedgeArmor", rotation });
    // Same cells (the mirror is taken inside the footprint), listed from the
    // mirrored end first — collision only reads the set, never the order.
    assert.deepEqual(localKeys(flippedCoords), localKeys(plainCoords),
      `mirrored hull collision cells match the placed footprint at ${rotation}deg`);
  }
  assert.ok(
    StructuralConnectivity.isConnected(validated.modules, PARTS, serverFootprint.getOccupiedCells),
    "a hull built from mirrored pieces stays structurally connected"
  );

  // 13. Exposed hull edges are derived from the mirrored component's real cells.
  const outline = await import("../public/src/game/shipHullOutline.js");
  const mirroredOutline = outline.buildExteriorHullEdges(mirroredDesign, { scale: 13 });
  const unmirroredOutline = outline.buildExteriorHullEdges(
    mirroredDesign.map(({ flipped, ...part }) => part),
    { scale: 13 }
  );
  assert.ok(mirroredOutline.length > 0, "a mirrored hull produces an exposed-edge outline");
  assert.deepEqual(mirroredOutline, unmirroredOutline,
    "mirroring does not move a component, so its exposed edges are unchanged");

  // ---------------------------------------------------------------------- art
  // The mirror must reach the artwork, not just the geometry. A recording
  // context tracks the live transform and reports every drawn point in canvas
  // space, so "flipped" can be compared against "unflipped" exactly.
  const { withCanvasContext } = await import("../public/src/ui/dom.js");
  const { drawModule } = await import("../public/src/game/componentArt.js");

  function recordingContext() {
    // Affine transform [a c e; b d f], mirroring the canvas CTM.
    let matrix = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const points = [];
    const apply = (x, y) => ({
      x: Math.round((matrix[0] * x + matrix[2] * y + matrix[4]) * 1000) / 1000,
      y: Math.round((matrix[1] * x + matrix[3] * y + matrix[5]) * 1000) / 1000
    });
    const multiply = (m) => {
      const [a, b, c, d, e, f] = matrix;
      matrix = [
        a * m[0] + c * m[1], b * m[0] + d * m[1],
        a * m[2] + c * m[3], b * m[2] + d * m[3],
        a * m[4] + c * m[5] + e, b * m[4] + d * m[5] + f
      ];
    };
    const record = (x, y) => { const p = apply(x, y); points.push(`${p.x},${p.y}`); };
    return {
      points,
      canvas: { width: 100, height: 100 },
      save() { stack.push(matrix.slice()); },
      restore() { matrix = stack.pop() || [1, 0, 0, 1, 0, 0]; },
      translate(x, y) { multiply([1, 0, 0, 1, x, y]); },
      rotate(angle) { multiply([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0]); },
      scale(x, y) { multiply([x, 0, 0, y, 0, 0]); },
      setTransform(a, b, c, d, e, f) { matrix = [a, b, c, d, e, f]; },
      moveTo: record,
      lineTo: record,
      arc(x, y) { record(x, y); },
      arcTo(x1, y1, x2, y2) { record(x1, y1); record(x2, y2); },
      rect(x, y, w, h) { record(x, y); record(x + w, y + h); },
      roundRect(x, y, w, h) { record(x, y); record(x + w, y + h); },
      fillRect(x, y, w, h) { record(x, y); record(x + w, y + h); },
      beginPath() {}, closePath() {}, fill() {}, stroke() {}, clip() {}, fillText() {},
      createLinearGradient: () => ({ addColorStop() {} }),
      createRadialGradient: () => ({ addColorStop() {} }),
      measureText: () => ({ width: 0 }),
      set fillStyle(_) {}, get fillStyle() { return ""; },
      set strokeStyle(_) {}, get strokeStyle() { return ""; },
      set lineWidth(_) {}, get lineWidth() { return 1; },
      set lineCap(_) {}, get lineCap() { return "butt"; },
      set lineJoin(_) {}, get lineJoin() { return "miter"; },
      set globalAlpha(_) {}, get globalAlpha() { return 1; },
      set shadowColor(_) {}, get shadowColor() { return ""; },
      set shadowBlur(_) {}, get shadowBlur() { return 0; },
      set font(_) {}, get font() { return ""; },
      set textAlign(_) {}, get textAlign() { return "left"; }
    };
  }

  const drawnPoints = (type, rotation, flipped) => {
    const recorder = recordingContext();
    withCanvasContext(recorder, () => {
      drawModule({ x: 0, y: 0, size: 40, color: "#ff9a62", type, trim: "#e7eef8", rotation, flipped });
    });
    return recorder.points;
  };
  const mirrorPoints = (points) => points.map((point) => {
    const [x, y] = point.split(",");
    // -0 and 0 are the same coordinate; normalize so the comparison is exact.
    return `${Math.round(-Number(x) * 1000) / 1000 || 0},${Number(y) || 0}`;
  });
  const zeroed = (points) => points.map((point) => {
    const [x, y] = point.split(",");
    return `${Number(x) || 0},${Number(y) || 0}`;
  });

  for (const type of ["bevelArmor", "roundedFrame", "halfArmorDiagonal"]) {
    const plainArt = drawnPoints(type, 0, false);
    const mirroredArt = drawnPoints(type, 0, true);
    assert.ok(plainArt.length > 0, `${type} draws something`);
    assert.deepEqual(zeroed(mirroredArt), mirrorPoints(plainArt),
      `${type} art at 0deg is the exact horizontal mirror of the unflipped art`);
    for (const rotation of [90, 180, 270]) {
      assert.notDeepEqual(drawnPoints(type, rotation, true), drawnPoints(type, rotation, false),
        `${type} art actually changes when mirrored at ${rotation}deg`);
    }
  }

  // 9 (art). A non-flippable component's art ignores the flag entirely.
  assert.deepEqual(drawnPoints("armor", 0, true), drawnPoints("armor", 0, false),
    "non-flippable art is identical with and without the flip flag");

  console.log("Component flip verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
