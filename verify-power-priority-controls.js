import assert from "node:assert/strict";
import wiringRules from "./public/src/shared/wiringRules.js";
import powerPolicyRules from "./public/src/shared/powerPolicyRules.js";
import powerAllocationRules from "./public/src/shared/powerAllocationRules.js";
import powerFlowRules from "./public/src/shared/powerFlowRules.js";
import wiringInfrastructureRules from "./public/src/shared/wiringInfrastructureRules.js";
import dataSupportRules from "./public/src/shared/dataSupportRules.js";
import engineExhaustRules from "./public/src/shared/engineExhaust.js";
import heatRules from "./public/src/shared/heatRules.js";

// Section 7C-4 — Blueprint Designer Power Priority controls, the authoritative
// policy update path, Undo/persistence integration, solver-backed diagnostics,
// and the component-catalogue category audit. Non-browser: a fake DOM captures
// the rendered panel HTML so we assert on stable semantic markup, never CSS.

globalThis.WiringRules = wiringRules;
globalThis.PowerPolicyRules = powerPolicyRules;
globalThis.PowerAllocationRules = powerAllocationRules;
globalThis.PowerFlowRules = powerFlowRules;
globalThis.WiringInfrastructureRules = wiringInfrastructureRules;
globalThis.DataSupportRules = dataSupportRules;
globalThis.EngineExhaustRules = engineExhaustRules;
globalThis.HeatRules = heatRules;

let passed = 0;
function check(label, fn) { fn(); passed += 1; console.log(`  ok  ${label}`); }

// ---------------------------------------------------------------------------
// Part 1 — component catalogue category audit (server catalogue is authoritative)
// ---------------------------------------------------------------------------
const { PARTS } = await import("./src/server/components.js").then((m) => m.default || m).catch(() => require("./src/server/components.js"));
const AUTH = ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"];
console.log("Catalogue category audit");
check("Every live Power consumer has one valid authoritative category", () => {
  const bad = [];
  for (const [type, part] of Object.entries(PARTS)) {
    const use = Number(part.powerUse) || 0;
    if (use > 0 && !AUTH.includes(part.powerCategory)) bad.push(`${type}=${part.powerCategory}`);
  }
  assert.deepStrictEqual(bad, [], `uncategorised/invalid consumers: ${bad.join(", ")}`);
});
check("Shields and Point Defence stay separate; no combined 'defence' category appears", () => {
  const cats = new Set(Object.values(PARTS).map((p) => p.powerCategory).filter(Boolean));
  assert.ok(cats.has("shields") && cats.has("pointDefence"), "both categories used");
  for (const forbidden of ["defence", "defense", "defensiveSystems", "shieldsAndPointDefence"]) {
    assert.ok(!cats.has(forbidden), `catalogue never uses ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Part 2 — designer UI policy controls (fake DOM harness)
// ---------------------------------------------------------------------------
const fakeElements = new Map();
function fakeClassList() { return { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false }; }
function fakeElement(id = "") {
  if (fakeElements.has(id)) return fakeElements.get(id);
  const el = {
    id, hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", dataset: {}, style: {}, tabIndex: 0,
    classList: fakeClassList(), children: [],
    addEventListener: () => {}, removeEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    appendChild: () => {}, append: () => {}, prepend: () => {}, remove: () => {}, replaceChildren: () => {}, querySelectorAll: () => [], querySelector: () => null,
    closest: () => null, focus: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 600 })
  };
  fakeElements.set(id, el);
  return el;
}
globalThis.document = {
  getElementById: (id) => fakeElement(id),
  createElement: (tag) => fakeElement(`created-${tag}-${fakeElements.size}`),
  createElementNS: (_ns, tag) => fakeElement(`created-${tag}-${fakeElements.size}`),
  addEventListener: () => {}, removeEventListener: () => {}, visibilityState: "visible", activeElement: null, documentElement: { style: { setProperty: () => {} }, classList: fakeClassList() }
};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1, __mfaMainLoaded: false };
Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: () => Promise.resolve() } }, configurable: true });
globalThis.location = { href: "http://localhost/" };
globalThis.WebSocket = { OPEN: 1 };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.performance ??= { now: () => Date.now() };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { state } = await import("./public/src/state.js");
const { defaultDesign, defaultWiring, normalizeWiring } = await import("./public/src/design/blueprintStorage.js");
const history = await import("./public/src/design/blueprintEditHistory.js");
const designer = await import("./public/src/ui/designerUi.js");
const wiringUi = await import("./public/src/ui/wiringUi.js");
const { canonicalBlueprintEditSnapshot, clearBlueprintEditHistory, blueprintEditHistorySize } = history;
const { applyPowerPolicyChange, undoBlueprintEdit, setBlueprintEditHistoryUiHooksForTests } = designer;
const { refreshWiringPresentation } = wiringUi;

let persistCalls = 0; let refreshCalls = 0;
setBlueprintEditHistoryUiHooksForTests({
  persistDesign: () => { persistCalls += 1; return true; },
  refresh: () => { refreshCalls += 1; refreshWiringPresentation(); }
});

function resetDesigner(preset = "balanced") {
  persistCalls = 0; refreshCalls = 0;
  state.design = defaultDesign();
  state.wiring = normalizeWiring(defaultWiring(), state.design);
  state.wiring.powerPolicy = powerPolicyRules.normalizePolicy({ preset });
  state.blueprintView = "wiring";
  state.wiringUi.mode = "power";
  state.wiringUi.undoStack = [];
  state.wiringUi.sourceIndex = null;
  state.wiringUi.path = [];
  clearBlueprintEditHistory();
}
function panelHtml() { refreshWiringPresentation(); return fakeElement("wiringStatusPanel").innerHTML; }
function policyNow() { return powerPolicyRules.normalizePolicy(state.wiring.powerPolicy); }

console.log("Designer Power Priority panel");
resetDesigner("balanced");
check("Power Priority panel is visible in the Power Wiring view", () => {
  assert.ok(panelHtml().includes('data-wiring-panel="power-priority"'), "priority panel rendered");
});
check("All five preset choices are offered", () => {
  const html = panelHtml();
  for (const preset of ["balanced", "defensive", "offensive", "mobility", "custom"]) {
    assert.ok(html.includes(`data-preset="${preset}"`), `${preset} preset control present`);
  }
});
check("Six separate authoritative category labels are shown (Shields and Point Defence distinct)", () => {
  const html = panelHtml();
  for (const label of ["Command &amp; Control", "Propulsion", "Shields", "Point Defence", "Weapons", "Cooling &amp; Support"]) {
    assert.ok(html.includes(label), `label ${label} present`);
  }
  assert.ok(!html.includes(">Defence<"), "no combined Defence label");
});
check("Balanced shows Shields and Point Defence tied at the same priority number, still separate rows", () => {
  const html = panelHtml();
  // Both categories carry data-priority-band="3" (command 1, propulsion 2, tied 3).
  assert.ok(/data-priority-band="3" data-category="shields"/.test(html), "shields at priority 3");
  assert.ok(/data-priority-band="3" data-category="pointDefence"/.test(html), "point defence at priority 3");
  assert.ok(html.includes("power-priority-tied"), "tie indicated");
});
check("Solver-backed diagnostics render unmet demand by separate category", () => {
  const html = panelHtml();
  assert.ok(html.includes("data-power-priority-diagnostics"), "diagnostics block present");
  assert.ok(html.includes("Unmet demand by priority"), "per-category heading present");
  assert.ok(html.includes('data-diag-category="shields"') && html.includes('data-diag-category="pointDefence"'), "shields and point defence reported separately");
});

console.log("Policy update path, persistence and Undo");
resetDesigner("balanced");
check("Selecting a named preset makes one Blueprint edit, persists and refreshes", () => {
  const before = canonicalBlueprintEditSnapshot(state);
  applyPowerPolicyChange((current) => powerPolicyRules.selectPreset(current, "defensive"));
  assert.strictEqual(policyNow().preset, "defensive", "preset switched");
  assert.strictEqual(blueprintEditHistorySize(), 1, "one undo entry");
  assert.strictEqual(persistCalls, 1, "persisted once");
  assert.ok(refreshCalls >= 1, "refreshed analysis/controls");
  assert.notDeepStrictEqual(canonicalBlueprintEditSnapshot(state), before, "policy actually changed");
});
check("Undo restores the previous preset (policy is a Blueprint design edit)", () => {
  assert.strictEqual(undoBlueprintEdit(), true, "undo succeeds");
  assert.strictEqual(policyNow().preset, "balanced", "preset restored");
});
check("A no-op preset selection creates no Undo entry and does not persist", () => {
  resetDesigner("balanced");
  applyPowerPolicyChange((current) => powerPolicyRules.selectPreset(current, "balanced"));
  assert.strictEqual(blueprintEditHistorySize(), 0, "no history entry");
  assert.strictEqual(persistCalls, 0, "no persist");
});
check("Selecting a named preset preserves the previously configured Custom order", () => {
  resetDesigner("balanced");
  const customOrder = ["weapons", "command", "shields", "propulsion", "pointDefence", "coolingSupport"];
  applyPowerPolicyChange(() => ({ preset: "custom", customOrder }));
  assert.strictEqual(policyNow().preset, "custom");
  applyPowerPolicyChange((current) => powerPolicyRules.selectPreset(current, "offensive"));
  assert.strictEqual(policyNow().preset, "offensive");
  assert.deepStrictEqual(policyNow().customOrder, customOrder, "custom order retained under named preset");
  applyPowerPolicyChange((current) => powerPolicyRules.selectPreset(current, "custom"));
  assert.deepStrictEqual(policyNow().customOrder, customOrder, "returning to custom restores the order");
});

console.log("Custom ordering controls");
resetDesigner("custom");
check("Custom mode renders six independently ordered rows with Up/Down controls", () => {
  const html = panelHtml();
  for (const cat of AUTH) assert.ok(html.includes(`data-custom-row data-category="${cat}"`), `${cat} custom row`);
  const moves = html.match(/data-wiring-action="power-priority-move"/g) || [];
  assert.strictEqual(moves.length, 12, "two move controls per row");
});
check("Up is disabled on the first row and Down on the last", () => {
  const order = policyNow().customOrder;
  const html = panelHtml();
  const first = order[0]; const last = order[order.length - 1];
  assert.ok(new RegExp(`data-category="${first}" data-direction="up"[^>]*disabled`).test(html), "first row up disabled");
  assert.ok(new RegExp(`data-category="${last}" data-direction="down"[^>]*disabled`).test(html), "last row down disabled");
});
check("Moving one category by one position is a single Undo entry and activates Custom", () => {
  resetDesigner("balanced");
  const start = policyNow().customOrder.slice();
  const shieldsIndex = start.indexOf("shields");
  applyPowerPolicyChange((current) => powerPolicyRules.moveCustomCategory(current, "shields", -1));
  assert.strictEqual(policyNow().preset, "custom", "reordering activates custom");
  assert.strictEqual(policyNow().customOrder.indexOf("shields"), shieldsIndex - 1, "shields moved up one");
  assert.strictEqual(blueprintEditHistorySize(), 1, "single undo entry");
});
check("Shields can be reordered independently of Point Defence", () => {
  resetDesigner("balanced");
  const pdBefore = policyNow().customOrder.indexOf("pointDefence");
  applyPowerPolicyChange((current) => powerPolicyRules.moveCustomCategory(current, "shields", -1));
  applyPowerPolicyChange((current) => powerPolicyRules.moveCustomCategory(current, "shields", -1));
  const order = policyNow().customOrder;
  assert.notStrictEqual(order.indexOf("shields"), order.indexOf("pointDefence"), "shields and point defence at different positions");
  assert.strictEqual(order.indexOf("pointDefence"), pdBefore, "point defence position unaffected by moving shields past it");
});
check("The saved policy persists on the Blueprint wiring (existing storage location, no new schema)", () => {
  resetDesigner("balanced");
  applyPowerPolicyChange((current) => powerPolicyRules.selectPreset(current, "mobility"));
  assert.strictEqual(state.wiring.powerPolicy.preset, "mobility", "policy stored under wiring.powerPolicy");
  const round = normalizeWiring(JSON.parse(JSON.stringify(state.wiring)), state.design);
  assert.strictEqual(round.powerPolicy.preset, "mobility", "survives wiring normalization/persistence round-trip");
});

setBlueprintEditHistoryUiHooksForTests(null);
console.log(`\nSection 7C-4 Power priority controls verification passed (${passed} checks)`);
