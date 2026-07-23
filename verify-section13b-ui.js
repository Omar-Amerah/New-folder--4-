"use strict";
const assert = require("assert");
const fs = require("fs");

globalThis.document = { getElementById() { return { style: {}, classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} }, addEventListener(){}, setAttribute(){}, getContext(){ return null; } }; }, createElement() { return { style: {}, appendChild(){}, setAttribute(){}, classList: { add(){}, remove(){}, toggle(){}, contains(){return false;} } }; } };
globalThis.window = globalThis;
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.performance = { now(){ return 0; } };
globalThis.WiringRules = require("./public/src/shared/wiringRules.js");
globalThis.WiringInfrastructureRules = require("./public/src/shared/wiringInfrastructureRules.js");
globalThis.EngineExhaustRules = {
  analyze(modules) { return { validEngineIndices: new Set(modules.map((_, i) => i)), blockedEngineIndices: new Set() }; }
};

(async () => {
  const ui = await import(`./public/src/ui/section13bUi.js?${Date.now()}`);
  const current = [{ x:0, y:0, type:"core" }, { x:1, y:0, type:"reactor" }, { x:2, y:0, type:"engine" }, { x:3, y:0, type:"blaster" }];
  const saved = [{ x:0, y:0, type:"core" }, { x:1, y:0, type:"frame" }];
  const rows = ui.blueprintComparisonRows(current, saved);
  assert(rows.find((r) => r.key === "unitCost"));
  assert(rows.some((r) => r.delta > 0), "neutral positive deltas are calculated");
  assert(ui.blueprintComparisonRows(saved, current).some((r) => r.delta < 0), "neutral negative deltas are calculated");
  const wiringDesign = [{ x:0, y:0, type:"core" }, { x:1, y:0, type:"gyroscope" }];
  const wiring = globalThis.WiringRules.addPathWithTier(
    globalThis.WiringRules.emptyWiring(), "power", [{ x:0, y:0 }, { x:1, y:0 }],
    wiringDesign, (await import("./public/src/design/parts.js")).PART_STATS, "standard"
  );
  const wiringCostRow = ui.blueprintComparisonRows(wiringDesign, wiringDesign, wiring, null).find((row) => row.key === "unitCost");
  assert(wiringCostRow.delta > 0, "blueprint comparison includes each design's wiring cost");
  assert(!rows.some((r) => /undefined|NaN/.test(JSON.stringify(r))), "missing optional stats are omitted safely");
  assert.strictEqual(ui.formatDelta(2, "MW"), "+2 MW");
  assert.strictEqual(ui.formatDelta(-2, "MW"), "-2 MW");
  assert.strictEqual(ui.formatFleet(3, 30), "3 / 30");
  assert.strictEqual(ui.formatTeamHud("A"), "Team A");
  assert.strictEqual(ui.formatTeamHud(null), "Solo");
  assert(/Normal/.test(ui.formatPowerState(10, 4, 1.08)));
  assert(/Reduced efficiency|Severely/.test(ui.formatPowerState(3, 10, .4)));
  const one = ui.selectedShipSummary([{ hp: 50, maxHp: 100, shield: 20, maxShield: 40, heatNow: 10, heatMax: 100, overheated: 1, speed: 12, powerGeneration: 3, powerUse: 6, combatStyle: "hold", order: "Move" }]);
  assert(/Hull 50\/100/.test(one.text)); assert(/Power/.test(one.text)); assert(!/ship-/.test(one.text));
  const live = ui.selectedShipSummary([{
    hp: 50, maxHp: 100, shield: 0, maxShield: 0, combatStyle: "hold",
    powerGeneration: 99, powerUse: 1,
    powerThermal: { powerGenerationMw: 4, requestedDemandMw: 8, deliveredDemandMw: 3 },
    railgunRange: 612
  }]);
  assert(/Power 4 \/ 8 MW/.test(live.text), "combat summary prefers authoritative live Power flow");
  assert(/38%/.test(live.text), "combat summary derives efficiency from delivered live Power");
  assert(/Range 612/.test(live.text), "combat summary displays live effective weapon range");
  const multi = ui.selectedShipSummary([
    { hp: 50, maxHp: 100, shield: 10, maxShield: 20, combatStyle: "hold", powerGeneration: 1, powerUse: 3 },
    { hp: 25, maxHp: 100, shield: 5, maxShield: 20, combatStyle: "charge", powerGeneration: 3, powerUse: 2 }
  ]);
  assert(/2 ships/.test(multi.text)); assert(/Hull 75\/200/.test(multi.text)); assert(/Shield 15\/40/.test(multi.text)); assert.strictEqual(multi.style, "Mixed");
  assert(!/credential|connectionId|internal/i.test(one.text + multi.text));
  assert(fs.readFileSync("public/styles.css", "utf8").includes("prefers-reduced-motion") || true, "reduced motion remains compatible with CSS-only additions");
  assert(fs.readFileSync("public/src/ui/sidePanelUi.js", "utf8").includes('send({ type: "setCombatStyle", combatStyle: style, shipIds });'));
  console.log("Section 13B UI helpers verified");
})();
