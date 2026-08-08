#!/usr/bin/env node
"use strict";
// Designer UX for component mirroring: the F action on a pending placement and
// on a placed component, per-part transform memory, the transform indicator, and
// the guarantee that a component without a mirror ignores F silently.
//
// Uses a minimal fake DOM (same approach as the other designer UI suites) so the
// real designerUi/partPaletteUi modules run unmodified.
const assert = require("node:assert/strict");

globalThis.MfaFeatureFlags = require("../public/src/shared/featureFlags.js");
globalThis.WiringRules = require("../public/src/shared/wiringRules.js");
globalThis.DataSupportRules = require("../public/src/shared/dataSupportRules.js");
globalThis.EngineExhaustRules = require("../public/src/shared/engineExhaust.js");
globalThis.HeatRules = require("../public/src/shared/heatRules.js");
globalThis.TurretRules = require("../public/src/shared/turretRules.js");
globalThis.PowerPolicyRules = require("../public/src/shared/powerPolicyRules.js");
globalThis.PowerAllocationRules = require("../public/src/shared/powerAllocationRules.js");
globalThis.PowerDemandRules = require("../public/src/shared/powerDemandRules.js");
globalThis.PowerFlowRules = require("../public/src/shared/powerFlowRules.js");
globalThis.WiringInfrastructureRules = require("../public/src/shared/wiringInfrastructureRules.js");
globalThis.PowerCableThermalRules = require("../public/src/shared/powerCableThermalRules.js");

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
  "blueprintBuildTab", "blueprintHeatTab", "blueprintWiringTab", "wiringToolbar", "wiringStatusPanel", "heatToolbar",
  "blueprintThermalHud", "blueprintHeatLegend", "thermalLoadModes", "thermalScenarioLabel", "heatFlowViewControls",
  "showAllHeatFlows", "heatFlowHint", "heatFlowOverlayHost", "wiringOverlayHost", "heatContextCard",
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
  const [{ state }, storage, designer, history, paletteUi] = await Promise.all([
    import("../public/src/state.js"),
    import("../public/src/design/blueprintStorage.js"),
    import("../public/src/ui/designerUi.js"),
    import("../public/src/design/blueprintEditHistory.js"),
    import("../public/src/ui/partPaletteUi.js")
  ]);
  paletteUi.setPartPaletteSelectionPresentationRefresh(designer.refreshBlueprintSelectionPresentation);
  designer.setBlueprintEditHistoryUiHooksForTests({
    persistDesign: () => {},
    refresh: () => { designer.renderBuildGrid(); }
  });

  state.mine = { money: 9999 };
  state.rules = { startingMoney: 9999 };
  state.design = storage.defaultDesign();
  state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design);
  state.loadedEditorBlueprintId = null;
  state.blueprintView = "build";
  state.hoveredCell = null;
  state.selectedCell = null;
  state.partTransformMemory = {};
  history.clearBlueprintEditHistory();
  designer.setBlueprintView("build");
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
