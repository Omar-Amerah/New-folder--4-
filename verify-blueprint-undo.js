import assert from "node:assert/strict";
import wiringRules from "./public/src/shared/wiringRules.js";
globalThis.WiringRules = wiringRules;
globalThis.document = { getElementById: () => null };
globalThis.performance ??= { now: () => Date.now() };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { state } = await import("./public/src/state.js");
const { defaultDesign, defaultWiring, normalizeWiring } = await import("./public/src/design/blueprintStorage.js");
const history = await import("./public/src/design/blueprintEditHistory.js");
const { captureBlueprintEditSnapshot, pushBlueprintEditSnapshot, undoBlueprintEdit, canUndoBlueprintEdit, clearBlueprintEditHistory, blueprintEditHistorySize, MAX_BLUEPRINT_EDIT_HISTORY } = history;

function reset() { state.design = defaultDesign(); state.wiring = normalizeWiring(defaultWiring(), state.design); state.loadedEditorBlueprintId = "saved-a"; clearBlueprintEditHistory(); }
function snap() { return captureBlueprintEditSnapshot(state); }

reset();
const before = snap();
pushBlueprintEditSnapshot(undefined, before);
state.design = [...state.design, { x: 7, y: 10, type: "frame", rotation: 0 }];
state.wiring = normalizeWiring(state.wiring, state.design);
assert.equal(blueprintEditHistorySize(), 1, "place creates one history entry");
undoBlueprintEdit();
assert.deepEqual(snap(), before, "undo restores design, wiring and loaded id after place");

reset();
const deep = snap();
state.design[0].x = 1;
state.wiring.power.sections.push({ id: "mutated", x1: 0, y1: 0, x2: 1, y2: 0, tier: "standard" });
assert.equal(deep.design[0].x, 7, "snapshot design is deep cloned");
assert.equal(deep.wiring.power.sections.some((s) => s.id === "mutated"), false, "snapshot wiring is deep cloned");

reset();
for (let i = 0; i < MAX_BLUEPRINT_EDIT_HISTORY + 5; i += 1) {
  state.loadedEditorBlueprintId = `id-${i}`;
  pushBlueprintEditSnapshot(undefined, snap());
}
assert.equal(blueprintEditHistorySize(), MAX_BLUEPRINT_EDIT_HISTORY, "history is capped at 20");
assert.equal(canUndoBlueprintEdit(), true, "history reports undo availability");
undoBlueprintEdit();
assert.equal(state.loadedEditorBlueprintId, `id-${MAX_BLUEPRINT_EDIT_HISTORY + 4}`, "undo is last-in-first-out");

clearBlueprintEditHistory();
assert.equal(canUndoBlueprintEdit(), false, "clear removes undo availability");
assert.equal(undoBlueprintEdit(), null, "empty undo is a no-op");
console.log("Blueprint undo verification passed");
