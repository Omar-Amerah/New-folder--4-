// Runtime-only physical Blueprint Designer undo history.

import { state } from "../state.js";
import { normalizeWiring } from "./blueprintStorage.js";

export const MAX_BLUEPRINT_EDIT_HISTORY = 20;

let blueprintEditHistory = [];

function cloneDesign(design) {
  return Array.isArray(design) ? design.map((part) => ({ ...part })) : [];
}

function cloneWiring(wiring, design) {
  const rules = globalThis.WiringRules;
  const cloned = rules?.cloneWiring ? rules.cloneWiring(wiring) : JSON.parse(JSON.stringify(wiring ?? null));
  return normalizeWiring(cloned, design);
}

export function captureBlueprintEditSnapshot(source = state) {
  const design = cloneDesign(source.design);
  return {
    design,
    wiring: cloneWiring(source.wiring, design),
    loadedEditorBlueprintId: source.loadedEditorBlueprintId ?? null
  };
}

export function restoreBlueprintEditSnapshot(target = state, snapshot) {
  const design = cloneDesign(snapshot?.design);
  target.design = design;
  target.wiring = cloneWiring(snapshot?.wiring, design);
  target.loadedEditorBlueprintId = snapshot?.loadedEditorBlueprintId ?? null;
  return target;
}

export function blueprintSnapshotsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function pushBlueprintEditSnapshot(stackOrSnapshot, maybeSnapshot) {
  const stack = maybeSnapshot === undefined ? blueprintEditHistory : stackOrSnapshot;
  const snapshot = maybeSnapshot === undefined ? stackOrSnapshot : maybeSnapshot;
  if (!snapshot) return stack.length;
  stack.push(captureBlueprintEditSnapshot(snapshot));
  while (stack.length > MAX_BLUEPRINT_EDIT_HISTORY) stack.shift();
  return stack.length;
}

export function clearBlueprintEditHistory() {
  blueprintEditHistory = [];
}

export function canUndoBlueprintEdit() {
  return blueprintEditHistory.length > 0;
}

export function blueprintEditHistorySize() {
  return blueprintEditHistory.length;
}

export function undoBlueprintEdit() {
  const snapshot = blueprintEditHistory.pop();
  if (!snapshot) return null;
  restoreBlueprintEditSnapshot(state, snapshot);
  return captureBlueprintEditSnapshot(state);
}

export function __getBlueprintEditHistoryForTests() {
  return blueprintEditHistory;
}
