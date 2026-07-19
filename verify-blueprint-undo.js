import assert from "node:assert/strict";
import wiringRules from "./public/src/shared/wiringRules.js";
import dataSupportRules from "./public/src/shared/dataSupportRules.js";

globalThis.WiringRules = wiringRules;
globalThis.DataSupportRules = dataSupportRules;
globalThis.document = { getElementById: () => null, createElement: () => ({}), addEventListener: () => {}, removeEventListener: () => {}, visibilityState: "visible" };
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, devicePixelRatio: 1 };
globalThis.performance ??= { now: () => Date.now() };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const { state } = await import("./public/src/state.js");
const { defaultDesign, defaultWiring, normalizeWiring } = await import("./public/src/design/blueprintStorage.js");
const history = await import("./public/src/design/blueprintEditHistory.js");
const designer = await import("./public/src/ui/designerUi.js");
const { captureBlueprintEditSnapshot, pushBlueprintEditSnapshot, undoBlueprintEdit: popHistoryUndo, canUndoBlueprintEdit, clearBlueprintEditHistory, blueprintEditHistorySize, MAX_BLUEPRINT_EDIT_HISTORY } = history;
const { editCell, rotateCell, removeCell, resetDesign, clearDesign, undoBlueprintEdit, setBlueprintEditHistoryUiHooksForTests } = designer;

let persistCalls = 0;
let refreshCalls = 0;
setBlueprintEditHistoryUiHooksForTests({
  persistDesign: () => { persistCalls += 1; return true; },
  refresh: () => { refreshCalls += 1; }
});

function reset() {
  persistCalls = 0;
  refreshCalls = 0;
  state.design = defaultDesign();
  state.wiring = normalizeWiring(defaultWiring(), state.design);
  state.loadedEditorBlueprintId = "saved-a";
  state.blueprintView = "build";
  state.selectedPart = "frame";
  state.previewRotation = 0;
  clearBlueprintEditHistory();
}
function snap() { return captureBlueprintEditSnapshot(state); }
function assertUndoRestores(label, before) {
  assert.equal(canUndoBlueprintEdit(), true, `${label}: history available`);
  assert.equal(undoBlueprintEdit(), true, `${label}: undo succeeds`);
  assert.deepEqual(snap(), before, `${label}: undo restores exact snapshot`);
}

reset();
let before = snap();
editCell(8, 8);
assert.equal(blueprintEditHistorySize(), 1, "place creates one history entry");
assert.equal(persistCalls, 1, "place persists once");
assertUndoRestores("place", before);
assert.equal(persistCalls, 2, "undo persists once");

reset();
state.selectedPart = "frame";
before = snap();
editCell(6, 5);
assert.equal(blueprintEditHistorySize(), 1, "replace creates one history entry");
assert.equal(state.design.find((p) => p.x === 6 && p.y === 5)?.type, "frame", "replace path completes");
assertUndoRestores("replace", before);

reset();
const missile = state.design.find((p) => p.type === "missile");
before = snap();
assert.equal(rotateCell(missile.x, missile.y), true, "valid rotation succeeds");
assert.equal(blueprintEditHistorySize(), 1, "rotate creates one history entry");
assertUndoRestores("rotate", before);

reset();
before = snap();
removeCell(9, 7);
assert.equal(blueprintEditHistorySize(), 1, "remove creates one history entry");
assertUndoRestores("remove", before);

reset();
state.design = [...state.design, { x: 8, y: 8, type: "frame", rotation: 0 }];
state.wiring = normalizeWiring(state.wiring, state.design);
state.loadedEditorBlueprintId = "custom-id";
before = snap();
resetDesign();
assert.equal(blueprintEditHistorySize(), 1, "reset creates one history entry");
assert.equal(state.loadedEditorBlueprintId, null, "reset clears loaded id");
assertUndoRestores("reset", before);
assert.equal(state.loadedEditorBlueprintId, "custom-id", "reset undo restores loaded id");

reset();
before = snap();
clearDesign();
assert.equal(blueprintEditHistorySize(), 1, "clear creates one history entry");
assert.equal(state.design.length, 0, "clear empties design");
assertUndoRestores("clear", before);

reset();
state.selectedPart = "frame";
editCell(99, 99);
assert.equal(blueprintEditHistorySize(), 0, "invalid placement creates no history");
assert.equal(persistCalls, 0, "invalid placement does not persist");
removeCell(7, 7);
assert.equal(blueprintEditHistorySize(), 0, "core removal creates no history");
state.loadedEditorBlueprintId = null;
resetDesign();
assert.equal(blueprintEditHistorySize(), 0, "no-op reset creates no history");

reset();
const deep = snap();
state.design[0].x = 1;
state.wiring.power.sections.push({ id: "mutated", x1: 0, y1: 0, x2: 1, y2: 0, tier: "standard" });
assert.equal(deep.design[0].x, 7, "snapshot design is deep cloned");
assert.equal(deep.wiring.power.sections.some((s) => s.id === "mutated"), false, "snapshot wiring is deep cloned");

reset();
for (let i = 0; i < MAX_BLUEPRINT_EDIT_HISTORY + 5; i += 1) {
  state.loadedEditorBlueprintId = `id-${i}`;
  pushBlueprintEditSnapshot(snap());
}
assert.equal(blueprintEditHistorySize(), MAX_BLUEPRINT_EDIT_HISTORY, "history is capped at 20");
assert.equal(canUndoBlueprintEdit(), true, "history reports undo availability");
popHistoryUndo();
assert.equal(state.loadedEditorBlueprintId, `id-${MAX_BLUEPRINT_EDIT_HISTORY + 4}`, "undo is last-in-first-out");

clearBlueprintEditHistory();
assert.equal(canUndoBlueprintEdit(), false, "clear removes undo availability");
assert.equal(popHistoryUndo(), null, "empty undo is a no-op");
setBlueprintEditHistoryUiHooksForTests(null);
console.log("Blueprint undo verification passed");
