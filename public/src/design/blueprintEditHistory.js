// Runtime-only Blueprint Designer undo history.

import { state } from "../state.js";
import { normalizeDesignDetailed } from "./blueprintStorage.js";

export const MAX_BLUEPRINT_EDIT_HISTORY = 20;

let blueprintEditHistory = [];

function cloneDesign(design) {
  return Array.isArray(design) ? design.map((part) => ({ ...part })) : [];
}

export function captureBlueprintEditSnapshot(source = state) {
  const design = cloneDesign(source.design);
  return {
    design,
    dataLinks: Array.isArray(source.dataLinks) ? source.dataLinks.map((link) => ({ ...link })) : [],
    loadedEditorBlueprintId: source.loadedEditorBlueprintId ?? null
  };
}

export function restoreBlueprintEditSnapshot(target = state, snapshot) {
  const design = cloneDesign(snapshot?.design);
  target.design = design;
  target.dataLinks = Array.isArray(snapshot?.dataLinks) ? snapshot.dataLinks.map((link) => ({ ...link })) : [];
  target.loadedEditorBlueprintId = snapshot?.loadedEditorBlueprintId ?? null;
  return target;
}

function canonicalDesign(design) {
  return normalizeDesignDetailed(design, { allowEmpty: true }).modules.map((part) => ({
    type: part.type,
    x: Math.trunc(Number(part.x)),
    y: Math.trunc(Number(part.y)),
    rotation: Math.trunc(Number(part.rotation) || 0),
    // Mirroring is a real edit: without it here, flipping a component would look
    // like a no-op and never reach the undo stack.
    flipped: part.flipped === true,
    droneType: part.type === "droneBay" ? (part.droneType || null) : undefined
  }));
}

export function canonicalBlueprintEditSnapshot(snapshot) {
  const design = canonicalDesign(snapshot?.design);
  return {
    design,
    dataLinks: (Array.isArray(snapshot?.dataLinks) ? snapshot.dataLinks : [])
      .map((link) => ({ sourceIndex: Math.trunc(Number(link.sourceIndex)), targetIndex: Math.trunc(Number(link.targetIndex)) }))
      .sort((a, b) => a.sourceIndex - b.sourceIndex || a.targetIndex - b.targetIndex),
    loadedEditorBlueprintId: snapshot?.loadedEditorBlueprintId ?? null
  };
}

export function blueprintSnapshotsEqual(a, b) {
  return JSON.stringify(canonicalBlueprintEditSnapshot(a)) === JSON.stringify(canonicalBlueprintEditSnapshot(b));
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

