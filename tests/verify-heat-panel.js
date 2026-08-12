"use strict";

// Heat-panel math now lives in renderer-neutral modules; verify those directly
// and then assert that the live selected-ship panel consumes the same helpers.
const assert = require("assert/strict");
const fs = require("fs");

(async () => {
  const {
    shipHeatPercent,
    formatHeatPercent,
    checkShipHeatConsistency
  } = await import("../public/src/shared/heatDisplay.js");

  assert.equal(shipHeatPercent({ heatNow: 0.04, heatMax: 100 }), 0.04);
  assert.equal(formatHeatPercent(0), "0%");
  assert.equal(formatHeatPercent(0.04), "<0.1%", "small non-zero Heat never displays as zero");
  assert.equal(formatHeatPercent(3.46), "3.5%");
  assert.equal(formatHeatPercent(42.1), "42%");

  const consistent = checkShipHeatConsistency({
    id: "ok",
    heatNow: 12,
    componentHeat: [[5], [7]],
    chp: [10, 10]
  }, false);
  assert.equal(consistent.ok, true);
  assert.equal(consistent.componentTotal, 12);

  const destroyedExcluded = checkShipHeatConsistency({
    id: "destroyed",
    heatNow: 5,
    componentHeat: [[5], [99]],
    chp: [10, 0]
  }, false);
  assert.equal(destroyedExcluded.ok, true, "destroyed-component retained Heat is excluded from the living total");
  assert.equal(destroyedExcluded.includedCount, 1);

  const mismatch = checkShipHeatConsistency({
    id: "bad",
    heatNow: 20,
    componentHeat: [[2], [3], [4]],
    chp: [10, 10, 10]
  }, false);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.tolerance, 1.6500000000000001, "rounding tolerance scales with living component count");

  const panelSource = fs.readFileSync("public/src/ui/shipDamagePanelUi.js", "utf8");
  assert.match(panelSource, /shipHeatPercent, formatHeatPercent, checkShipHeatConsistency/, "the selected-ship panel imports shared Heat display math");
  assert.match(panelSource, /diagramInteraction\.shipId !== ship\.id/, "component hover/selection state is keyed to the current ship");
  assert.match(panelSource, /updateComponentHeatTrends\(ship, state\.snapshotReceivedAt/, "live snapshots refresh per-component Heat trends");
  assert.match(panelSource, /state\.shipStatusView === "heat"/, "Damage and Heat tabs share an explicit view state");

  const index = fs.readFileSync("public/index.html", "utf8");
  for (const id of ["shipDamageTab", "shipHeatTab", "shipHeatSummary", "shipDamageCanvas"]) {
    assert(index.includes(`id="${id}"`), `selected-ship panel is missing ${id}`);
  }

  console.log("Heat panel module-boundary verification passed");
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
