"use strict";

// Module-era replacement for the old public/client.js VM harness. This checks
// the same designer contracts at their current production ownership boundary.
const assert = require("assert/strict");
const fs = require("fs");

globalThis.document = { getElementById() { return null; } };

(async () => {
  await import("../public/src/shared/rotationRules.js");
  await import("../public/src/shared/componentTransform.js");
  await import("../public/src/shared/engineExhaust.js");

  const { nextRotation } = await import("../public/src/design/rotation.js");
  const { createPlacementCandidate } = await import("../public/src/design/placementCandidate.js");
  const { PART_STATS } = await import("../public/src/design/parts.js");

  assert.deepStrictEqual(
    [nextRotation(0), nextRotation(90), nextRotation(180), nextRotation(270)],
    [90, 180, 270, 0],
    "pending placement rotation cycles through the shared rotation contract"
  );
  assert.equal(nextRotation(0, [0, 180]), 180, "component-specific rotations are respected");

  const design = [{ x: 7, y: 7, type: "core", rotation: 0 }];
  const placement = createPlacementCandidate({
    grid: { x: 7, y: 6 },
    componentType: "railgun",
    rotation: 90,
    design,
    catalogue: PART_STATS
  });
  assert.equal(placement.ok, true, placement.message);
  assert.equal(placement.normalizedRotation, 90, "preview and placement share one normalized rotation");
  assert.equal(placement.nextDesign.at(-1).type, "railgun");
  assert.equal(placement.occupiedCells.length, 3, "multi-cell preview validates its full footprint");

  const coreReplacement = createPlacementCandidate({
    grid: { x: 7, y: 7 },
    componentType: "frame",
    design,
    catalogue: PART_STATS
  });
  assert.equal(coreReplacement.reasonCode, "core-replace", "the designer cannot replace the Core");

  const paletteSource = fs.readFileSync("public/src/ui/partPaletteUi.js", "utf8");
  assert.match(paletteSource, /wasSelected\s*\?\s*null\s*:\s*type/, "clicking the active palette part deselects it");
  const designerSource = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
  assert.match(designerSource, /querySelectorAll\("\.build-cell"\)/, "designer behavior reads live build cells");
  assert.match(designerSource, /cell\.getBoundingClientRect\(\)/, "overlay geometry comes from live cell rectangles");
  assert.match(designerSource, /ResizeObserver|window\.addEventListener\("resize"/, "designer overlay geometry is synchronized on resize");

  const gridCss = fs.readFileSync("public/styles/build-grid.css", "utf8");
  assert.match(gridCss, /\.heat-flow-overlay[^}]*pointer-events:\s*none/s, "Heat SVG overlays remain presentational");
  assert.match(gridCss, /\.heat-flow-overlay-host[^}]*pointer-events:\s*none/s, "Heat overlay host cannot steal grid input");
  const index = fs.readFileSync("public/index.html", "utf8");
  assert.match(index, /id="heatOverlayLegendHeading"/, "the Heat overlay has an explicit legend");
  assert.match(index, /<script type="module" src="\/src\/main\.js/, "the production client boots from the modular entrypoint");

  console.log("client UI module-boundary verification passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
