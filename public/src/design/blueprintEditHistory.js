// Runtime-only physical Blueprint Designer undo history.

import { state } from "../state.js";
import { normalizeDesignDetailed, normalizeWiring } from "./blueprintStorage.js";

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

function canonicalDesign(design) {
  return normalizeDesignDetailed(design, { allowEmpty: true }).modules.map((part) => ({
    type: part.type,
    x: Math.trunc(Number(part.x)),
    y: Math.trunc(Number(part.y)),
    rotation: Math.trunc(Number(part.rotation) || 0),
    switchgearMode: part.type === "switchgear" ? (part.switchgearMode || "closed") : undefined,
    switchgearRatingTier: part.type === "switchgear" ? (part.switchgearRatingTier || "standard") : undefined
  }));
}

function canonicalWiring(wiring, design) {
  const normalized = normalizeWiring(wiring, design);
  const bucket = (value) => ({
    sections: (Array.isArray(value?.sections) ? value.sections : []).map((section) => ({
      id: String(section.id || ""),
      x1: Math.trunc(Number(section.x1)),
      y1: Math.trunc(Number(section.y1)),
      x2: Math.trunc(Number(section.x2)),
      y2: Math.trunc(Number(section.y2)),
      tier: section.tier || "standard"
    })),
    connections: (Array.isArray(value?.connections) ? value.connections : []).map((connection) => ({
      sourceIndex: Math.trunc(Number(connection.sourceIndex)),
      targetIndex: Math.trunc(Number(connection.targetIndex)),
      sectionIds: Array.isArray(connection.sectionIds) ? connection.sectionIds.map(String) : []
    }))
  });
  const policy = normalized.powerPolicy && typeof normalized.powerPolicy === "object" ? normalized.powerPolicy : {};
  return {
    version: normalized.version || 3,
    power: bucket(normalized.power),
    data: bucket(normalized.data),
    powerPolicy: {
      preset: String(policy.preset || "balanced"),
      customOrder: Array.isArray(policy.customOrder) ? policy.customOrder.map(String) : []
    }
  };
}

export function canonicalBlueprintEditSnapshot(snapshot) {
  const design = canonicalDesign(snapshot?.design);
  return {
    design,
    wiring: canonicalWiring(snapshot?.wiring, design),
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

