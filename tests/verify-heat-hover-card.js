"use strict";
// Blueprint Heat hover/context card — information-architecture contract.
//
// The card is a decision aid, not a diagnostics dump. These checks pin:
//   * role-specific rows (producer / Heat Sink / Radiator / Heat Pipe),
//   * exceptions-only presentation (no "100%" multiplier row, "Never" collapses
//     into one status line, real countdowns are prominent),
//   * that accumulated simulation totals (componentActivityHeat) never reach the
//     player through this card,
//   * and that the CSS cannot wrap labels character-by-character again.
// Non-browser: shared UMD modules register the browser globals the model reads.

const assert = require("assert");
const fs = require("fs");
require("../public/src/shared/featureFlags.js");
const HeatRules = require("../public/src/shared/heatRules");
globalThis.HeatRules = HeatRules;
globalThis.WiringRules = require("../public/src/shared/wiringRules");
globalThis.DataSupportRules = require("../public/src/shared/dataSupportRules");
globalThis.EngineExhaustRules = require("../public/src/shared/engineExhaust");
globalThis.PowerPolicyRules = require("../public/src/shared/powerPolicyRules");
globalThis.PowerAllocationRules = require("../public/src/shared/powerAllocationRules");
globalThis.PowerDemandRules = require("../public/src/shared/powerDemandRules");
globalThis.PowerFlowRules = require("../public/src/shared/powerFlowRules");
globalThis.WiringInfrastructureRules = require("../public/src/shared/wiringInfrastructureRules");
globalThis.PowerCableThermalRules = require("../public/src/shared/powerCableThermalRules");
// Catalogue modules reach for the browser globals at import time.
global.document = { createElement: () => ({ getContext: () => ({}), style: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {} }), createElementNS: () => ({ setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}, documentElement: { style: { setProperty() {} } }, body: { classList: { add() {}, remove() {} } } };
global.window = { devicePixelRatio: 1, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
global.localStorage = { getItem: () => null, setItem: () => {} };

let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }

const STATE = HeatRules.STATE;

// `heat`/`ratio`/`state` are the transient peak; `final*` is where the run
// settled, and it is the instant the rate fields describe.
function prediction(overrides = {}) {
  const base = {
    heat: 33, capacity: 85, ratio: 33 / 85, peakRatio: 33 / 85,
    finalHeat: 33, finalRatio: 33 / 85, finalState: STATE.NORMAL, finalGeneration: 5.3,
    generation: 5.3, received: 0, transferredOut: 0, cooling: 4.9,
    state: STATE.NORMAL, timeToOverheat: null, meltdownTime: null,
    exposedEdges: 0, exteriorDirections: [], exposureCoolingMultiplier: 1
  };
  const merged = { ...base, ...overrides };
  // Convenience: an override that only moves the peak fields keeps the settled
  // fields in step unless the test is deliberately separating the two.
  if (overrides.heat != null && overrides.finalHeat == null) merged.finalHeat = overrides.heat;
  if (overrides.ratio != null && overrides.finalRatio == null) merged.finalRatio = overrides.ratio;
  if (overrides.state != null && overrides.finalState == null) merged.finalState = overrides.state;
  if (overrides.ratio != null && overrides.peakRatio == null) merged.peakRatio = overrides.ratio;
  if (overrides.generation != null && overrides.finalGeneration == null) merged.finalGeneration = overrides.generation;
  return merged;
}

function labelsOf(model) { return model.rows.map((row) => row.label); }
function valueFor(model, label) { return model.rows.find((row) => row.label === label)?.value; }
function text(model, markup) { return `${JSON.stringify(model)}\n${markup}`; }

(async () => {
  const { buildHeatCardModel, heatCardMarkup, heatCardRole } = await import("../public/src/design/heatCardModel.js");
  const { analyzeDesignHeat } = await import("../public/src/design/thermalAnalysis.js");

  const REACTOR_DESIGN = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 7, y: 6, type: "reactor", rotation: 0 },
    { x: 8, y: 7, type: "frame", rotation: 0 },
    { x: 8, y: 6, type: "heatPipe", rotation: 0 },
    { x: 9, y: 6, type: "radiator", rotation: 0 },
    { x: 8, y: 5, type: "heatSink", rotation: 0 }
  ];
  const indexOf = (type) => REACTOR_DESIGN.findIndex((module) => module.type === type);
  const card = (index, overrides = {}, result = null) => buildHeatCardModel({
    design: REACTOR_DESIGN, index, prediction: prediction(overrides), result
  });

  check("producer card shows peak, generation, net heat and coolant only", () => {
    const model = card(indexOf("reactor"));
    const markup = heatCardMarkup(model);
    assert.deepStrictEqual(labelsOf(model), ["Generates", "Net heat", "Coolant"], text(model, markup));
    assert.strictEqual(valueFor(model, "Generates"), "+5.3 H/s");
    assert.strictEqual(valueFor(model, "Net heat"), "+0.4 H/s");
    assert.strictEqual(model.meter.label, "Settles at");
    assert.strictEqual(model.meter.percent, 39);
    assert.strictEqual(model.meter.detail, "33 / 85 H");
    assert.ok(/Reactor #\d+/.test(model.title), model.title);
    assert.strictEqual(model.stateLabel, "Cool");
  });

  check("the meter reads the settled state, with the transient peak beside it", () => {
    // Settles at 78%, but the run touched 82% on the way there.
    const model = card(indexOf("reactor"), {
      generation: 6.8, cooling: 6.8,
      peakRatio: 0.82, heat: 70, ratio: 0.82, state: STATE.HOT,
      finalRatio: 0.78, finalHeat: 66, finalState: STATE.HOT, finalGeneration: 6.8
    });
    assert.strictEqual(model.meter.label, "Settles at");
    assert.strictEqual(model.meter.percent, 78);
    assert.strictEqual(model.meter.detail, "66 / 85 H");
    assert.strictEqual(model.meter.peakPercent, 82, "the transient peak is stated separately");
    assert.strictEqual(model.stateLabel, "Hot", "the badge describes the settled state");
    assert.strictEqual(valueFor(model, "Net heat"), "+0.0 H/s", "equilibrium: net zero at the settled temperature");
    const markup = heatCardMarkup(model);
    assert.ok(markup.includes('<div class="heat-card-meter-peak"><span>Peak</span><strong>82%</strong></div>'), markup);
    assert.ok(markup.indexOf("Peak") < markup.indexOf("Generates"), "peak belongs with the meter, not the rate rows");
  });

  check("the peak row is hidden when it adds nothing, and flagged when it was worse", () => {
    const settled = card(indexOf("reactor"));
    assert.strictEqual(settled.meter.peakPercent, null, "a peak equal to the settled heat is noise");
    assert.ok(!heatCardMarkup(settled).includes("Peak"));
    const spiked = card(indexOf("reactor"), {
      peakRatio: 0.91, ratio: 0.91, heat: 77, state: STATE.CRITICAL,
      finalRatio: 0.5, finalHeat: 42, finalState: STATE.WARM
    });
    assert.strictEqual(spiked.meter.percent, 50);
    assert.strictEqual(spiked.meter.peakPercent, 91);
    assert.strictEqual(spiked.meter.peakTone, "warn", "a peak in a worse Heat state must stand out");
    assert.strictEqual(spiked.stateLabel, "Warm");
  });

  check("a component that never settles says so", () => {
    const model = card(indexOf("reactor"), { ratio: 1, heat: 85, state: STATE.OVERHEATED, timeToOverheat: 25.2 });
    assert.strictEqual(model.meter.label, "Ends at", "'Settles at' would be a lie for a runaway component");
  });

  check("generation and net heat describe the same instant", () => {
    // A throttled reactor makes less than its nominal rate; the card must not
    // pair the nominal figure with final-state transfer and cooling rates.
    const model = card(indexOf("reactor"), {
      generation: 5.3, finalGeneration: 0, cooling: 2.1, received: 0, transferredOut: 0,
      state: STATE.OVERHEATED, finalState: STATE.OVERHEATED, ratio: 1, heat: 85
    });
    assert.ok(!heatCardMarkup(model).includes("+5.3 H/s"), "nominal generation must not appear beside settled rates");
    assert.strictEqual(valueFor(model, "Net heat"), "-2.1 H/s");
    assert.strictEqual(valueFor(model, "Generates"), undefined, "a shut-down generator makes nothing");
  });

  check("hover card carries no diagnostics dump", () => {
    const markup = heatCardMarkup(card(indexOf("reactor")));
    const banned = [
      "Base Heat capacity", "Capacity bonuses", "Hosted Power", "Hosted Data",
      "displacement", "Scenario activity", "Requested", "allocated",
      "Operational multiplier", "Component activity Heat", "Power cable",
      "Incoming transfer", "Outgoing transfer", "Final Heat", "Stored Heat",
      "Wiring", "Overheat in", "Never"
    ];
    for (const phrase of banned) {
      assert.ok(!markup.includes(phrase), `hover card must not display "${phrase}": ${markup}`);
    }
    // Twenty-row tooltips are what this replaced: keep the row count small.
    assert.ok(card(indexOf("reactor")).rows.length <= 4, "producer card should stay compact");
  });

  check("100% operational multiplier is hidden, reduced output is surfaced", () => {
    const cool = card(indexOf("reactor"));
    assert.deepStrictEqual(cool.notes, [], "no penalty note while cool");
    assert.ok(!heatCardMarkup(cool).includes("100%"), "a 100% multiplier is normal state, not a row");
    const hot = card(indexOf("reactor"), { state: STATE.CRITICAL, ratio: 0.91, heat: 77 });
    const note = hot.notes.find((entry) => /reducing/.test(entry.text));
    assert.ok(note, `critical reactor should surface its output penalty: ${JSON.stringify(hot.notes)}`);
    assert.strictEqual(note.text, "⚠ Heat reducing power output to 40%");
    assert.strictEqual(note.tone, "warn");
  });

  check("'Never' collapses into a stable status, real countdowns are prominent", () => {
    const safe = card(indexOf("reactor"));
    assert.deepStrictEqual(safe.statuses, [{ text: "No overheat predicted", tone: "ok" }]);
    const doomed = card(indexOf("reactor"), { state: STATE.CRITICAL, ratio: 0.91, heat: 77, timeToOverheat: 8.4 });
    assert.strictEqual(doomed.statuses[0].text, "OVERHEATS IN 8.4 s");
    assert.strictEqual(doomed.statuses[0].tone, "danger");
    assert.ok(heatCardMarkup(doomed).includes('class="heat-card-status heat-card-status-danger">OVERHEATS IN 8.4 s'));
    const melting = card(indexOf("reactor"), { timeToOverheat: 8.4, meltdownTime: 11.4, state: STATE.OVERHEATED, ratio: 1.02, heat: 87 });
    assert.ok(melting.statuses.some((entry) => entry.text === "MELTDOWN IN 11.4 s" && entry.tone === "danger"));
  });

  check("heat bar renders the shared Heat state visual language", () => {
    for (const [state, className] of [[STATE.NORMAL, "cool"], [STATE.WARM, "warm"], [STATE.HOT, "hot"], [STATE.CRITICAL, "critical"], [STATE.OVERHEATED, "overheated"]]) {
      const model = card(indexOf("reactor"), { state, ratio: 0.5, heat: 42 });
      assert.strictEqual(model.stateClass, className);
      assert.ok(heatCardMarkup(model).includes(`heat-card-bar heat-ui-${className}`), `bar should carry heat-ui-${className}`);
    }
    const model = card(indexOf("reactor"), { ratio: 1.6, heat: 136, state: STATE.OVERHEATED });
    assert.strictEqual(model.meter.percent, 100, "the bar clamps at 100%");
    assert.ok(heatCardMarkup(model).includes('style="width:100%"'));
  });

  check("Heat Sink card is storage-shaped", () => {
    const model = buildHeatCardModel({
      design: REACTOR_DESIGN, index: indexOf("heatSink"),
      prediction: prediction({ heat: 212, capacity: 340, ratio: 212 / 340, generation: 0, cooling: 1.5, received: 7.7 })
    });
    assert.strictEqual(heatCardRole("heatSink"), "heatSink");
    // The meter reads "Stored 212 / 340 H"; a "Stored" row would duplicate it.
    assert.deepStrictEqual(labelsOf(model), ["Filling", "Coolant"]);
    assert.strictEqual(valueFor(model, "Filling"), "+6.2 H/s");
    assert.strictEqual(model.meter.label, "Stored");
    assert.strictEqual(model.meter.detail, "212 / 340 H");
    const visible = heatCardMarkup(model).replace(/aria-label="[^"]*"/g, "");
    assert.strictEqual((visible.match(/Stored/g) || []).length, 1, "stored heat is stated once");
    const saturating = buildHeatCardModel({
      design: REACTOR_DESIGN, index: indexOf("heatSink"),
      prediction: prediction({ heat: 320, capacity: 340, ratio: 320 / 340, generation: 0, cooling: 1.5 })
    });
    assert.strictEqual(saturating.statuses[0].text, "Nearly saturated");
    const full = buildHeatCardModel({
      design: REACTOR_DESIGN, index: indexOf("heatSink"),
      prediction: prediction({ heat: 340, capacity: 340, ratio: 1, generation: 0, cooling: 1.5, timeToOverheat: 22.5 })
    });
    assert.strictEqual(full.statuses[0].text, "SATURATES IN 22.5 s");
  });

  check("Radiator card is rejection-shaped and makes poor exposure obvious", () => {
    const exposed = buildHeatCardModel({
      design: REACTOR_DESIGN, index: indexOf("radiator"),
      prediction: prediction({ generation: 0, cooling: 11.8, exposedEdges: 3, exposureCoolingMultiplier: 1 })
    });
    assert.deepStrictEqual(labelsOf(exposed), ["Heat removed", "Exposure", "Coolant"]);
    assert.strictEqual(valueFor(exposed, "Heat removed"), "11.8 H/s");
    assert.strictEqual(valueFor(exposed, "Exposure"), "Full");
    const enclosed = buildHeatCardModel({
      design: REACTOR_DESIGN, index: indexOf("radiator"),
      prediction: prediction({ generation: 0, cooling: 2.9, exposedEdges: 0, exposureCoolingMultiplier: HeatRules.RADIATOR_ENCLOSED_MULTIPLIER })
    });
    const row = enclosed.rows.find((entry) => entry.label === "Exposure");
    assert.strictEqual(row.value, "⚠ Enclosed — 25%");
    assert.strictEqual(row.tone, "warn", "enclosed exposure must be visually obvious");
  });

  check("Heat Pipe card is transport-shaped", () => {
    const model = buildHeatCardModel({
      design: REACTOR_DESIGN, index: indexOf("heatPipe"),
      prediction: prediction({ generation: 0, cooling: 0, received: 18.2, transferredOut: 17.9, capacity: 10, heat: 4, ratio: 0.4 })
    });
    assert.deepStrictEqual(labelsOf(model), ["Flow", "Network"]);
    assert.strictEqual(valueFor(model, "Flow"), "18.2 H/s");
    assert.strictEqual(valueFor(model, "Network"), "● Connected");
    const lonely = buildHeatCardModel({
      design: [{ x: 0, y: 0, type: "heatPipe", rotation: 0 }], index: 0,
      prediction: prediction({ generation: 0, cooling: 0, capacity: 10, heat: 0, ratio: 0 })
    });
    assert.strictEqual(valueFor(lonely, "Network"), "⚠ Nothing attached");
  });

  check("thermal connection is reported honestly per role", () => {
    // Reactor touches a Heat Pipe network via the frame? No — it touches nothing
    // plumbed, so it reports direct contact only when it touches a cooler.
    const isolated = buildHeatCardModel({
      design: [{ x: 0, y: 0, type: "reactor", rotation: 0 }], index: 0, prediction: prediction()
    });
    assert.strictEqual(valueFor(isolated, "Coolant"), "⚠ Disconnected");
    const touching = buildHeatCardModel({
      design: [{ x: 0, y: 0, type: "reactor", rotation: 0 }, { x: 0, y: 1, type: "radiator", rotation: 0 }],
      index: 0, prediction: prediction()
    });
    assert.strictEqual(valueFor(touching, "Coolant"), "● Direct contact");
    const plumbed = buildHeatCardModel({
      design: [{ x: 0, y: 0, type: "reactor", rotation: 0 }, { x: 0, y: 1, type: "heatPipe", rotation: 0 }],
      index: 0, prediction: prediction()
    });
    assert.strictEqual(valueFor(plumbed, "Coolant"), "● Connected");
  });

  check("card renders from a real thermal analysis", () => {
    const result = analyzeDesignHeat(REACTOR_DESIGN, null, "full");
    for (let index = 0; index < REACTOR_DESIGN.length; index += 1) {
      const model = buildHeatCardModel({
        design: REACTOR_DESIGN, index, prediction: result.predictions.get(REACTOR_DESIGN[index]), result
      });
      assert.ok(model, `card model for ${REACTOR_DESIGN[index].type}`);
      const markup = heatCardMarkup(model);
      assert.ok(markup.includes("heat-card-grid"), markup);
      assert.ok(!/\d{3,}\.\d H\b/.test(markup), `accumulated simulation totals must not leak into the card: ${markup}`);
      assert.ok(!markup.includes("undefined") && !markup.includes("NaN"), markup);
      for (const row of model.rows) assert.ok(row.value && row.value !== "—", `${row.label} needs a value`);
    }
    // The accumulated total still exists for the detailed panel / parity tests.
    assert.ok(Number.isFinite(result.powerThermal.components[indexOf("reactor")].componentActivityHeat));
  });

  check("designer delegates the card to the pure model", () => {
    const source = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
    assert.ok(source.includes("buildHeatCardModel") && source.includes("heatCardMarkup"), "designer should render via heatCardModel");
    for (const phrase of ["Component activity Heat", "Base Heat capacity", "Operational multiplier", "Hosted Power cells", "Overheat in"]) {
      assert.ok(!source.includes(phrase), `designer hover card must not reintroduce "${phrase}"`);
    }
    for (const phrase of ["Power cable", "Wiring routing", "overload"]) {
      assert.ok(!new RegExp(`heat-card[^\\n]*${phrase}`, "i").test(source), `wiring mechanics must stay out of the Heat card (${phrase})`);
    }
  });

  check("card CSS cannot wrap labels character-by-character", () => {
    const css = fs.readFileSync("public/styles/build-grid.css", "utf8");
    const grid = css.match(/\.heat-card-grid \{[^}]*\}/);
    assert.ok(grid, "missing .heat-card-grid rule");
    assert.ok(/grid-template-columns:minmax\(\d+px,1fr\) auto;/.test(grid[0]), `label column needs a minimum width: ${grid[0]}`);
    const span = css.match(/\.heat-card-grid span \{[^}]*\}/)[0];
    const strong = css.match(/\.heat-card-grid strong \{[^}]*\}/)[0];
    for (const rule of [span, strong]) {
      assert.ok(!/overflow-wrap:anywhere/.test(rule), `character-by-character wrapping must be gone: ${rule}`);
      assert.ok(/overflow-wrap:normal/.test(rule) && /word-break:normal/.test(rule), rule);
    }
    assert.ok(/white-space:nowrap/.test(strong), "values must stay intact on one line");
    assert.ok(/\.heat-card-bar \{[^}]*\}/.test(css), "missing heat bar style");
    const danger = css.match(/\.heat-card-status-danger \{[^}]*\}/)[0];
    assert.ok(!/text-transform/.test(danger), `uppercasing the countdown turns "8.4 s" into "8.4 S": ${danger}`);
    for (const state of ["warm", "hot", "critical", "overheated"]) {
      assert.ok(css.includes(`.heat-card-bar.heat-ui-${state} i`), `heat bar needs a ${state} colour`);
    }
    // The card must stay inside the stage on edge components.
    assert.ok(/\.heat-context-card \{[^}]*max-width:min\(/.test(css), "card width must be viewport-aware");
    assert.ok(/@media \(max-width:640px\) \{[^@]*\.heat-card-grid \{/.test(css), "narrow layouts need a tighter label column");
  });

  console.log(`\nverify-heat-hover-card: ${passed} checks passed`);
})().catch((error) => { console.error(error); process.exit(1); });
