#!/usr/bin/env node
"use strict";
// Designer UX for component mirroring: the F action on a pending placement and
// on a placed component, per-part transform memory, the transform indicator, and
// the guarantee that a component without a mirror ignores F silently.
//
// Uses a minimal fake DOM (same approach as the other designer UI suites) so the
// real designerUi/partPaletteUi modules run unmodified.
const assert = require("node:assert/strict");

globalThis.DataSupportRules = require("../public/src/shared/dataSupportRules.js");
globalThis.EngineExhaustRules = require("../public/src/shared/engineExhaust.js");
globalThis.HeatRules = require("../public/src/shared/heatRules.js");
globalThis.TurretRules = require("../public/src/shared/turretRules.js");

class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.parentNode = null; this.listeners = new Map();
    this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this.attributes = {};
    this.className = ""; this.type = ""; this.title = ""; this._textContent = ""; this._innerHTML = "";
  }
  set textContent(v) { this._textContent = String(v); if (v === "") this.children = []; }
  get textContent() { return this._textContent || this.children.map((c) => c.textContent).join(""); }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  get classList() {
    const el = this;
    const set = () => new Set(String(el.className).split(/\s+/).filter(Boolean));
    return {
      add(...n) { const s = set(); n.forEach((x) => s.add(x)); el.className = [...s].join(" "); },
      remove(...n) { const s = set(); n.forEach((x) => s.delete(x)); el.className = [...s].join(" "); },
      contains(n) { return set().has(n); },
      toggle(n, f) { const s = set(); const on = f === undefined ? !s.has(n) : f; if (on) s.add(n); else s.delete(n); el.className = [...s].join(" "); return on; },
      [Symbol.iterator]() { return set()[Symbol.iterator](); }
    };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(c) { this.appendChild(c); }
  prepend(c) { c.parentNode = this; this.children.unshift(c); }
  replaceChildren(...kids) { this.children = []; kids.forEach((k) => this.appendChild(k)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  addEventListener(t, h) { const a = this.listeners.get(t) || []; a.push(h); this.listeners.set(t, a); }
  dispatchEvent(e) { e.target ||= this; for (const h of this.listeners.get(e.type) || []) h(e); return !e.defaultPrevented; }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  focus() { globalThis.document.activeElement = this; }
  contains(node) { while (node) { if (node === this) return true; node = node.parentNode; } return false; }
  closest(sel) { let n = this; while (n) { if (matches(n, sel)) return n; n = n.parentNode; } return null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } }; walk(this); return out; }
  insertAdjacentHTML() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 600, right: 600, bottom: 600 }; }
}
function matches(el, sel) {
  if (!el) return false;
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  const data = sel.match(/^\.([\w-]+)\[data-([\w-]+)="([^"]+)"\]$/);
  if (data) return el.classList.contains(data[1]) && String(el.dataset[data[2]]) === data[3];
  if (sel.startsWith(".")) return sel.slice(1).split(".").every((c) => el.classList.contains(c));
  if (sel === "strong" || sel === "span") return el.tagName.toLowerCase() === sel;
  return false;
}

const ids = ["buildGrid", "buildGridStage", "buildInteractionGuide", "rotationIndicator", "emptyGridInstruction",
  "blueprintBuildTab", "blueprintHeatTab", "blueprintDataLinksTab", "dataLinksToolbar", "heatToolbar",
  "blueprintThermalHud", "blueprintHeatLegend", "blueprintHeatLegendButton", "thermalLoadModes", "thermalScenarioLabel",
  "heatFlowOverlayHost", "dataLinksOverlayHost", "heatContextCard", "blueprintDesignerNotice",
  "undoBlueprintEditButton", "resetButton", "clearGridButton", "confirmModal", "confirmModalTitle",
  "confirmModalMessage", "confirmCancelButton", "confirmAcceptButton", "partPalette", "partInspector", "statsGrid",
  "blueprintCostLabel", "blueprintCostStatus", "combatStyleSelect", "saveDesignButton", "savedDesignList"];
const elements = new Map(ids.map((id) => [id, new FakeElement("div", id)]));
const empty = elements.get("emptyGridInstruction");
empty.appendChild(new FakeElement("strong"));
empty.appendChild(new FakeElement("span"));
globalThis.document = {
  activeElement: null,
  getElementById: (id) => { if (!elements.has(id)) elements.set(id, new FakeElement("div", id)); return elements.get(id); },
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  addEventListener() {},
  querySelector: (s) => [...elements.values()].find((e) => matches(e, s)) || null,
  querySelectorAll: (s) => [...elements.values()].filter((e) => matches(e, s))
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame: (cb) => setTimeout(cb, 0),
  getComputedStyle: () => ({ visibility: "visible", display: "block", columnGap: "2px", rowGap: "2px", gap: "2px", paddingLeft: "8px", paddingRight: "8px", paddingTop: "8px", paddingBottom: "8px", borderLeftWidth: "1px", borderRightWidth: "1px", borderTopWidth: "1px", borderBottomWidth: "1px" }),
  innerWidth: 1280
};
globalThis.HTMLElement = FakeElement;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

(async () => {
  const [{ state }, storage, designer, history, paletteUi, noticeUi, savedUi] = await Promise.all([
    import("../public/src/state.js"),
    import("../public/src/design/blueprintStorage.js"),
    import("../public/src/ui/designerUi.js"),
    import("../public/src/design/blueprintEditHistory.js"),
    import("../public/src/ui/partPaletteUi.js"),
    import("../public/src/ui/designerNoticeUi.js"),
    import("../public/src/ui/savedBlueprintsUi.js")
  ]);
  noticeUi.resetDesignerNoticeForTests();
  paletteUi.setPartPaletteSelectionPresentationRefresh(designer.refreshBlueprintSelectionPresentation);
  designer.setBlueprintEditHistoryUiHooksForTests({
    persistDesign: () => {},
    refresh: () => { designer.renderBuildGrid(); }
  });

  state.mine = { money: 9999 };
  state.rules = { startingMoney: 9999 };
  state.design = storage.defaultDesign();
  state.dataLinks = [];
  state.loadedEditorBlueprintId = null;
  state.blueprintView = "build";
  state.hoveredCell = null;
  state.selectedCell = null;
  state.partTransformMemory = {};
  history.clearBlueprintEditHistory();
  designer.setBlueprintView("build");
  designer.renderBuildGrid();

  // Disconnected layouts remain editable. Final validation and the live UI
  // report the invalid state without blocking the physical edit.
  const connectedChain = [
    { x: 7, y: 7, type: "core" },
    { x: 6, y: 7, type: "frame" },
    { x: 5, y: 7, type: "frame" },
    { x: 4, y: 7, type: "armor" }
  ];
  state.design = connectedChain.map((part) => ({ ...part }));
  state.selectedPart = "frame";
  state.previewRotation = 0;
  state.previewFlipped = false;
  designer.renderBuildGrid();
  designer.editCell(1, 1);
  assert.ok(state.design.some((part) => part.type === "frame" && part.x === 1 && part.y === 1),
    "a disconnected placement is committed for continued editing");
  const notice = elements.get("blueprintDesignerNotice");
  assert.equal(notice.hidden, true, "editing into a disconnected state stays quiet");
  const saveResult = await savedUi.saveCurrentDesign();
  assert.equal(saveResult, false, "saving a disconnected design is rejected");
  assert.equal(notice.hidden, false, "saving an invalid design shows the designer notice");
  assert.equal(notice.textContent, "1 disconnected component: Frame at (1, 1)",
    "the designer notice uses the specific single-component message");
  assert.doesNotMatch(notice.textContent, /Invalid design: disconnected parts\./,
    "the old generic disconnected toast copy is not used");
  const initialNoticeSequence = notice.dataset.noticeSequence;
  assert.equal((await savedUi.saveCurrentDesign()), false,
    "a repeated invalid save remains rejected");
  assert.equal(notice.dataset.noticeSequence, initialNoticeSequence,
    "repeated saves do not spam the same notice while it is visible");

  state.selectedPart = "heatPipe";
  designer.editCell(5, 7);
  assert.equal(notice.dataset.noticeSequence, initialNoticeSequence,
    "subsequent edits do not re-trigger the save notice");
  assert.equal(state.design.find((part) => part.x === 5 && part.y === 7).type, "heatPipe",
    "a replacement that strands structure is committed for continued editing");

  assert.equal(designer.removeCell(5, 7), true, "removing a structural bridge is allowed");
  assert.equal(state.design.some((part) => part.type === "heatPipe" && part.x === 5 && part.y === 7), false,
    "the bridge removal is committed");

  state.design = [
    { x: 7, y: 7, type: "core" },
    { x: 5, y: 7, type: "reactor" }
  ];
  state.selectedPart = null;
  designer.renderBuildGrid();
  assert.equal(designer.rotateCell(5, 7), true, "a rotation that disconnects a reactor is allowed");
  assert.equal(state.design.find((part) => part.type === "reactor").rotation, 90,
    "the disconnecting rotation is committed");

  state.design = [
    ...connectedChain.map((part) => ({ ...part })),
    { x: 1, y: 1, type: "frame" }
  ];
  noticeUi.resetDesignerNoticeForTests();
  designer.renderBuildGrid();
  assert.equal(elements.get("buildGrid").querySelectorAll(".build-cell.disconnected-component").length, 1,
    "an invalid loaded design outlines the actual disconnected component");
  designer.renderLocalStats();
  assert.match(elements.get("statsGrid").innerHTML, /Frame at \(1, 1\) has no structural path to the Core/,
    "Ship Summary names the disconnected component and anchor");
  assert.equal(notice.hidden, true,
    "loading an already-invalid design does not continuously show a transient notice");
  assert.equal(elements.get("buildGrid").querySelectorAll(".blueprint-validation-chip").length, 0,
    "the disconnected validation chip is no longer rendered on the grid");

  state.design = [
    ...connectedChain.map((part) => ({ ...part })),
    { x: 1, y: 1, type: "frame" },
    { x: 3, y: 3, type: "armor" }
  ];
  designer.renderBuildGrid();
  assert.equal(elements.get("buildGrid").querySelectorAll(".build-cell.disconnected-component").length, 2,
    "all disconnected component anchors are highlighted");
  assert.equal(notice.hidden, true,
    "re-rendering an unchanged invalid design does not show a transient notice");

  state.design = [{ x: 7, y: 7, type: "core" }];
  noticeUi.resetDesignerNoticeForTests();
  designer.renderBuildGrid();
  assert.equal((await savedUi.saveCurrentDesign()), false,
    "saving a design without an engine is rejected");
  assert.equal(notice.textContent, "Invalid design: add at least one engine.",
    "the same designer notice presents non-connectivity save errors");

  // Mirroring remains an executable edit even while the design is already
  // disconnected, and it remains undoable.
  state.design = [
    { x: 7, y: 7, type: "core" },
    { x: 1, y: 1, type: "bevelArmor" }
  ];
  state.selectedPart = null;
  designer.renderBuildGrid();
  const mirrorHistoryBefore = history.blueprintEditHistorySize();
  assert.equal(designer.flipCell(1, 1), true, "mirroring an invalid design is allowed");
  assert.equal(history.blueprintEditHistorySize(), mirrorHistoryBefore + 1, "mirroring remains undoable while invalid");
  assert.equal(designer.undoBlueprintEdit(), true, "undo restores the disconnected pre-mirror design");

  state.design = storage.defaultDesign();
  state.selectedPart = null;
  state.hoveredCell = null;
  state.selectedCell = null;
  state.partTransformMemory = {};
  noticeUi.resetDesignerNoticeForTests();
  designer.renderBuildGrid();


  const indicator = elements.get("rotationIndicator");
  const select = (type) => {
    state.selectedPart = type;
    const transform = designer.recalledPartTransform(type);
    state.previewRotation = transform.rotation;
    state.previewFlipped = transform.flipped;
    designer.refreshBlueprintSelectionPresentation();
  };

  // --- Pending placement -----------------------------------------------------
  select("bevelArmor");
  assert.equal(state.previewFlipped, false, "a freshly selected part starts unmirrored");
  assert.match(indicator.textContent, /Flip ↔ off \(F\)/, "the indicator advertises the mirror action and its key");

  assert.equal(designer.flipFocusedPart(), true, "F mirrors the pending placement");
  assert.equal(state.previewFlipped, true, "the pending placement is mirrored");
  assert.match(indicator.textContent, /Flip ↔ on/, "the indicator reports the mirror");

  const rotationBeforeFlip = state.previewRotation;
  designer.rotateFocusedPart();
  assert.notEqual(state.previewRotation, rotationBeforeFlip, "R still rotates while mirrored");
  assert.equal(state.previewFlipped, true, "rotating keeps the mirror");

  assert.equal(designer.flipFocusedPart(), true, "F toggles the mirror back off");
  assert.equal(state.previewFlipped, false, "a second F removes the mirror");
  designer.flipFocusedPart();
  assert.equal(state.previewFlipped, true, "and a third restores it");

  // --- Placement + per-part memory ------------------------------------------
  const chosenRotation = state.previewRotation;
  designer.editCell(9, 7);
  const placed = state.design.find((part) => part.x === 9 && part.y === 7);
  assert.ok(placed, "the mirrored component was placed");
  assert.equal(placed.type, "bevelArmor", "the placed component is the selected one");
  assert.equal(placed.flipped, true, "the placed component matches the mirrored preview");
  assert.equal(placed.rotation, chosenRotation, "the placed component matches the previewed rotation");
  assert.equal(state.previewFlipped, true, "placing does not reset the mirror");

  select("armor");
  assert.equal(state.previewFlipped, false, "a different, non-flippable part is never mirrored");
  select("bevelArmor");
  assert.equal(state.previewFlipped, true, "reselecting a part recalls its last mirror");
  assert.equal(state.previewRotation, chosenRotation, "reselecting a part recalls its last rotation");

  // --- Placed component ------------------------------------------------------
  const historyBefore = history.blueprintEditHistorySize();
  assert.equal(designer.flipCell(9, 7), true, "a placed flippable component mirrors in place");
  assert.equal(state.design.find((part) => part.x === 9 && part.y === 7).flipped, undefined,
    "mirroring a mirrored component returns it to its original handedness");
  assert.equal(history.blueprintEditHistorySize(), historyBefore + 1, "mirroring a placed component is one undoable edit");
  assert.equal(designer.undoBlueprintEdit(), true, "the mirror edit undoes");
  assert.equal(state.design.find((part) => part.x === 9 && part.y === 7).flipped, true, "undo restores the mirror");

  // Mirroring never moves a component, so a valid placement stays valid.
  const cellsBefore = state.design.map((part) => `${part.type}@${part.x},${part.y}`).sort();
  designer.flipCell(9, 7);
  assert.deepEqual(state.design.map((part) => `${part.type}@${part.x},${part.y}`).sort(), cellsBefore,
    "mirroring leaves every component exactly where it was");

  // --- Components without a mirror ------------------------------------------
  // F follows the same focus rule as R: the hovered/selected placed component
  // first, otherwise the pending placement. Clear the focus so this section
  // exercises the pending-placement path.
  state.hoveredCell = null;
  state.selectedCell = null;
  select("armor");
  const designBefore = JSON.stringify(state.design);
  const historyBeforeNoop = history.blueprintEditHistorySize();
  assert.equal(designer.flipFocusedPart(), false, "F on a non-flippable selection does nothing");
  assert.equal(state.previewFlipped, false, "a non-flippable selection is never marked mirrored");
  assert.equal(indicator.hidden, true, "a part with neither rotation nor mirror shows no transform indicator");
  select("blaster");
  assert.equal(indicator.hidden, false, "a rotatable part still shows its rotation indicator");
  assert.doesNotMatch(indicator.textContent, /Flip/, "no mirror control is advertised for a rotatable but non-flippable part");
  assert.equal(designer.flipFocusedPart(), false, "F on a rotatable non-flippable selection does nothing");
  select("armor");
  assert.equal(designer.flipCell(7, 7), false, "F on the core does nothing");
  const engine = state.design.find((part) => part.type === "engine");
  assert.equal(designer.flipCell(engine.x, engine.y), false, "F on an engine does nothing");
  assert.equal(history.blueprintEditHistorySize(), historyBeforeNoop, "a no-op mirror creates no history entry");
  assert.equal(JSON.stringify(state.design), designBefore, "a no-op mirror leaves the design untouched");

  designer.setBlueprintEditHistoryUiHooksForTests(null);
  console.log("Component flip UX verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
