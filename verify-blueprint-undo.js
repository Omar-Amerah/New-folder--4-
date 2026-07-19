import assert from "node:assert/strict";
import wiringRules from "./public/src/shared/wiringRules.js";
import dataSupportRules from "./public/src/shared/dataSupportRules.js";
import engineExhaustRules from "./public/src/shared/engineExhaust.js";
import heatRules from "./public/src/shared/heatRules.js";

globalThis.WiringRules = wiringRules;
globalThis.DataSupportRules = dataSupportRules;
globalThis.EngineExhaustRules = engineExhaustRules;
globalThis.HeatRules = heatRules;
const fakeElements = new Map();
function fakeClassList() { return { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false }; }
function fakeElement(id = "") {
  if (fakeElements.has(id)) return fakeElements.get(id);
  const el = {
    id, hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", dataset: {}, style: {},
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
const input = await import("./public/src/game/input.js");
const wiringUi = await import("./public/src/ui/wiringUi.js");
const { captureBlueprintEditSnapshot, pushBlueprintEditSnapshot, undoBlueprintEdit: popHistoryUndo, canUndoBlueprintEdit, clearBlueprintEditHistory, blueprintEditHistorySize, MAX_BLUEPRINT_EDIT_HISTORY, blueprintSnapshotsEqual } = history;
const { editCell, rotateCell, removeCell, resetDesign, clearDesign, undoBlueprintEdit, clearPhysicalBlueprintHistory, setBlueprintEditHistoryUiHooksForTests } = designer;
const { handleKeyDown } = input;
const { canUndoWiring } = wiringUi;

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
  state.wiringUi.undoStack = [];
  fakeElement("blueprintDesignerScreen").hidden = false;
  clearBlueprintEditHistory();
}
function snap() { return captureBlueprintEditSnapshot(state); }

function keyEvent({ key = "z", ctrlKey = false, metaKey = false, shiftKey = false, editable = false } = {}) {
  let prevented = false;
  const target = editable ? { isContentEditable: false, closest: (selector) => selector.includes("input") ? {} : null } : { closest: () => null };
  return { key, ctrlKey, metaKey, shiftKey, repeat: false, target, preventDefault: () => { prevented = true; }, get prevented() { return prevented; } };
}

function wiringSignature() { return JSON.stringify(state.wiring); }
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
state.wiringUi.undoStack = [globalThis.WiringRules.cloneWiring(state.wiring)];
assert.equal(canUndoWiring(), true, "wiring undo is available before topology replacement");
state.selectedPart = "frame";
before = snap();
const wiringBeforeReplace = wiringSignature();
editCell(6, 6);
assert.equal(blueprintEditHistorySize(), 1, "wired replace creates one physical history entry");
assert.notEqual(wiringSignature(), wiringBeforeReplace, "production wiring normalization changes replaced topology wiring");
assert.equal(canUndoWiring(), false, "physical replacement clears stale wiring undo history");
state.blueprintView = "wiring";
const staleWiring = wiringSignature();
const wiringKey = keyEvent({ ctrlKey: true });
handleKeyDown(wiringKey);
assert.equal(wiringKey.prevented, false, "wiring Ctrl+Z is not consumed when stale wiring history was cleared");
assert.equal(wiringSignature(), staleWiring, "stale wiring undo does not restore after physical replacement");
state.blueprintView = "build";
assertUndoRestores("wired replace", before);

reset();
const missile = state.design.find((p) => p.type === "missile");
before = snap();
assert.equal(rotateCell(missile.x, missile.y), true, "valid rotation succeeds");
assert.equal(blueprintEditHistorySize(), 1, "rotate creates one history entry");
assertUndoRestores("rotate", before);

reset();
before = snap();
state.wiringUi.undoStack = [globalThis.WiringRules.cloneWiring(state.wiring)];
removeCell(9, 7);
assert.equal(blueprintEditHistorySize(), 1, "remove creates one history entry");
assert.equal(canUndoWiring(), false, "physical removal clears stale wiring undo history");
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
const omittedZero = snap();
const explicitZero = { ...omittedZero, design: omittedZero.design.map((part) => ({ ...part, rotation: part.rotation || 0 })) };
assert.equal(blueprintSnapshotsEqual(omittedZero, explicitZero), true, "canonical equality treats omitted and explicit zero rotations as equal");
const changedWiring = captureBlueprintEditSnapshot({ ...state, wiring: { ...state.wiring, power: { ...state.wiring.power, sections: state.wiring.power.sections.slice(1) } } });
assert.equal(blueprintSnapshotsEqual(omittedZero, changedWiring), false, "canonical equality detects genuine wiring changes");

reset();
before = snap();
editCell(8, 8);
let evt = keyEvent({ ctrlKey: true });
handleKeyDown(evt);
assert.equal(evt.prevented, true, "Ctrl+Z triggers physical undo in Build mode");
assert.deepEqual(snap(), before, "Ctrl+Z restores physical snapshot");
editCell(8, 8);
evt = keyEvent({ metaKey: true });
handleKeyDown(evt);
assert.equal(evt.prevented, true, "Cmd+Z triggers physical undo in Build mode");
editCell(8, 8);
evt = keyEvent({ ctrlKey: true, shiftKey: true });
handleKeyDown(evt);
assert.equal(evt.prevented, false, "Ctrl+Shift+Z is ignored");
evt = keyEvent({ ctrlKey: true, editable: true });
handleKeyDown(evt);
assert.equal(evt.prevented, false, "editable controls keep native undo behavior");
clearBlueprintEditHistory();
evt = keyEvent({ ctrlKey: true });
handleKeyDown(evt);
assert.equal(evt.prevented, false, "empty physical history does not consume Ctrl+Z");
state.blueprintView = "wiring";
state.wiringUi.undoStack = [globalThis.WiringRules.cloneWiring(state.wiring)];
evt = keyEvent({ ctrlKey: true });
handleKeyDown(evt);
assert.equal(evt.prevented, true, "Wiring mode routes Ctrl+Z to Wiring Undo when available");
state.wiringUi.undoStack = [];
pushBlueprintEditSnapshot(snap());
evt = keyEvent({ ctrlKey: true });
handleKeyDown(evt);
assert.equal(evt.prevented, false, "Wiring mode does not fall back to physical Undo when Wiring history is empty");
state.blueprintView = "build";
clearPhysicalBlueprintHistory();
assert.equal(canUndoBlueprintEdit(), false, "clearPhysicalBlueprintHistory clears physical history");

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
const ignoredRendererErrors = [];
const ignoreHeadlessRendererFailure = (error) => {
  if (String(error?.message || error).includes("getContext")) { ignoredRendererErrors.push(error); return; }
  throw error;
};
process.on("unhandledRejection", ignoreHeadlessRendererFailure);
await import(`./public/src/main.js?blueprintUndoRegression=${Date.now()}`);
await new Promise((resolve) => setTimeout(resolve, 0));
process.off("unhandledRejection", ignoreHeadlessRendererFailure);
assert.equal(globalThis.window.__mfaMainLoaded, true, "browser entry point loads without undefined UI action references");
setBlueprintEditHistoryUiHooksForTests(null);
console.log("Blueprint undo verification passed");
