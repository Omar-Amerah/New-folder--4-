"use strict";

const assert = require("node:assert/strict");
const wiringRules = require("./public/src/shared/wiringRules.js");
const dataSupportRules = require("./public/src/shared/dataSupportRules.js");
const engineExhaustRules = require("./public/src/shared/engineExhaust.js");
const heatRules = require("./public/src/shared/heatRules.js");
const turretRules = require("./public/src/shared/turretRules.js");

globalThis.WiringRules = wiringRules;
globalThis.DataSupportRules = dataSupportRules;
globalThis.EngineExhaustRules = engineExhaustRules;
globalThis.HeatRules = heatRules;
globalThis.TurretRules = turretRules;

class FakeElement {
  constructor(tag = "div", id = "") { this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.parentNode = null; this.listeners = new Map(); this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this.attributes = {}; this.className = ""; this.type = ""; this.title = ""; this._textContent = ""; this._innerHTML = ""; }
  set textContent(v) { this._textContent = String(v); if (v === "") this.children = []; } get textContent() { return this._textContent || this.children.map(c => c.textContent).join(""); }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; } get innerHTML() { return this._innerHTML; }
  get classList() { const el=this; const set=()=>new Set(String(el.className).split(/\s+/).filter(Boolean)); return { add(...n){const s=set();n.forEach(x=>s.add(x));el.className=[...s].join(" ");}, remove(...n){const s=set();n.forEach(x=>s.delete(x));el.className=[...s].join(" ");}, contains(n){return set().has(n);}, toggle(n,f){const s=set(); const on=f===undefined?!s.has(n):f; if(on)s.add(n);else s.delete(n); el.className=[...s].join(" "); return on;}, [Symbol.iterator](){return set()[Symbol.iterator]();} }; }
  appendChild(c){ c.parentNode=this; this.children.push(c); return c; } append(...kids){ kids.forEach(c=>this.appendChild(c)); } replaceChildren(...kids){ this.children=[]; kids.forEach(k=>this.appendChild(k)); }
  addEventListener(t,h){ const a=this.listeners.get(t)||[]; a.push(h); this.listeners.set(t,a); }
  dispatchEvent(e){ e.target ||= this; e.currentTarget ||= this; for(const h of this.listeners.get(e.type)||[]) h(e); return !e.defaultPrevented; }
  setAttribute(n,v){ this.attributes[n]=String(v); if (n.startsWith("data-")) this.dataset[n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v); } getAttribute(n){ return this.attributes[n] ?? null; } removeAttribute(n){ delete this.attributes[n]; }
  focus(){ globalThis.document.activeElement=this; }
  contains(node){ while(node){ if(node===this) return true; node=node.parentNode; } return false; }
  closest(sel){ let n=this; while(n){ if(matches(n,sel)) return n; n=n.parentNode; } return null; }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel){ const out=[]; const walk=(n)=>{ for(const c of n.children){ if(matches(c,sel)) out.push(c); walk(c); } }; walk(this); return out; }
  insertAdjacentHTML(){} getBoundingClientRect(){ return { left:0, top:0, x:0, y:0, width:600, height:600, right:600, bottom:600 }; }
}
function matches(el, sel) { if (!el) return false; if (sel.includes(",")) return sel.split(",").some(part => matches(el, part.trim())); if (sel.startsWith("#")) return el.id === sel.slice(1); const dataOnly = sel.match(/^\[data-([\w-]+)\]$/); if (dataOnly) return el.dataset[dataOnly[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] != null; const data = sel.match(/^\.([\w-]+)\[data-([\w-]+)=\"([^\"]+)\"\]$/); if (data) return el.classList.contains(data[1]) && String(el.dataset[data[2]]) === data[3]; if (sel.startsWith(".")) return sel.slice(1).split(".").every(c => el.classList.contains(c)); if (["strong","span","button"].includes(sel)) return el.tagName.toLowerCase() === sel; return false; }
const ids = ["buildGrid","buildGridStage","buildInteractionGuide","rotationIndicator","emptyGridInstruction","blueprintBuildTab","blueprintHeatTab","blueprintWiringTab","blueprintModeContext","blueprintModeTitle","blueprintModeDescription","blueprintModeControls","wiringToolbar","wiringStatusPanel","heatToolbar","blueprintThermalHud","blueprintHeatLegend","thermalLoadModes","thermalScenarioLabel","heatFlowViewControls","showAllHeatFlows","heatFlowHint","heatFlowOverlayHost","wiringOverlayHost","heatContextCard","undoBlueprintEditButton","resetButton","clearGridButton","shipStatusChip","shipStatusText","shipStatusDetails","confirmModal","confirmModalTitle","confirmModalMessage","confirmCancelButton","confirmAcceptButton","partPalette","partInspector","statsGrid","blueprintCostLabel","blueprintCostStatus","combatStyleSelect","saveDesignButton","savedDesignList","wiringModePower","wiringModeData","wiringUndoButton","wiringClearNetworkButton","wiringHint"];
const elements = new Map(ids.map(id => [id, new FakeElement("div", id)]));
for (const id of ["blueprintBuildTab","blueprintHeatTab","blueprintWiringTab","undoBlueprintEditButton","resetButton","clearGridButton","wiringModePower","wiringModeData","wiringUndoButton","wiringClearNetworkButton"]) elements.set(id, new FakeElement("button", id));
elements.get("buildGridStage").appendChild(elements.get("buildGrid")); elements.get("buildGridStage").appendChild(elements.get("wiringOverlayHost"));
const empty = elements.get("emptyGridInstruction"); empty.appendChild(new FakeElement("strong")); empty.appendChild(new FakeElement("span"));
const documentListeners = new Map();
globalThis.document = { activeElement:null, getElementById:id=>{ if(!elements.has(id)) elements.set(id, new FakeElement("div", id)); return elements.get(id); }, createElement:t=>new FakeElement(t), createElementNS:(ns,t)=>new FakeElement(t), addEventListener:(t,h)=>{ const a=documentListeners.get(t)||[]; a.push(h); documentListeners.set(t,a); }, dispatchEvent:e=>{ for (const h of documentListeners.get(e.type)||[]) h(e); return true; }, querySelector:s=>[...elements.values()].find(e=>matches(e,s))||null, querySelectorAll:s=>[...elements.values()].filter(e=>matches(e,s)) };
globalThis.window = { addEventListener:()=>{}, removeEventListener:()=>{}, requestAnimationFrame:(cb)=>setTimeout(cb,0), getComputedStyle: () => ({ visibility:"visible", display:"block", columnGap:"2px", rowGap:"2px", gap:"2px", paddingLeft:"8px", paddingRight:"8px", paddingTop:"8px", paddingBottom:"8px", borderLeftWidth:"1px", borderRightWidth:"1px", borderTopWidth:"1px", borderBottomWidth:"1px" }), innerWidth:1280 };
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
globalThis.HTMLElement = FakeElement; globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
function event(type, target, props = {}) { return { type, target, button: 0, key: "", clientX: 340, clientY: 340, preventDefault(){ this.defaultPrevented=true; }, stopPropagation(){}, ...props }; }
function clickCell(grid, x, y, button = 0) { const cell = grid.querySelector(`.build-cell[data-x="${x}"][data-y="${y}"]`) || grid.querySelector(".build-cell"); return grid.dispatchEvent(event(button === 2 ? "contextmenu" : "click", cell, { button })); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function canonicalWiring(wiring, design, partStats) { return wiringRules.normalizeWiring(wiring, design, partStats).wiring; }
function findRoute(design, partStats, mode, existingWiring = null) {
  const occupied = new Set();
  const cellsByIndex = design.map((module) => wiringRules.moduleCells(module, partStats).sort((a, b) => a.y - b.y || a.x - b.x));
  cellsByIndex.flat().forEach((cell) => occupied.add(wiringRules.cellKey(cell.x, cell.y)));
  const candidates = [];
  for (const [sourceIndex, source] of design.entries()) {
    const validSource = mode === "data" ? wiringRules.isDataSourceType(source.type) : wiringRules.isPowerSourceType(source.type);
    if (!validSource) continue;
    for (const [targetIndex, target] of design.entries()) {
      if (sourceIndex === targetIndex) continue;
      const validTarget = mode === "data" ? wiringRules.isCompatibleWeapon(source.type, target.type, partStats) : wiringRules.isPowerConsumer(target.type, partStats);
      if (validTarget) candidates.push({ sourceIndex, targetIndex });
    }
  }
  for (const candidate of candidates.sort((a, b) => a.sourceIndex - b.sourceIndex || a.targetIndex - b.targetIndex)) {
    const starts = cellsByIndex[candidate.sourceIndex];
    const targets = new Set(cellsByIndex[candidate.targetIndex].map((cell) => wiringRules.cellKey(cell.x, cell.y)));
    const queue = starts.map((cell) => [cell]);
    const seen = new Set(starts.map((cell) => wiringRules.cellKey(cell.x, cell.y)));
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const path = queue[cursor];
      const last = path.at(-1);
      if (targets.has(wiringRules.cellKey(last.x, last.y)) && path.length > 1 && wiringRules.additionalLengthForPath(existingWiring, mode, path) > 0) return { ...candidate, path };
      for (const next of [{ x: last.x, y: last.y - 1 }, { x: last.x - 1, y: last.y }, { x: last.x + 1, y: last.y }, { x: last.x, y: last.y + 1 }]) {
        const key = wiringRules.cellKey(next.x, next.y);
        if (occupied.has(key) && !seen.has(key)) { seen.add(key); queue.push([...path, next]); }
      }
    }
  }
  throw new Error(`No valid ${mode} wiring route found in default design`);
}
function clickWiringPort(wiringOverlayHost, index, mode) {
  const port = wiringOverlayHost.querySelectorAll("[data-wiring-port-kind]").find((item) => item.dataset.wiringPortKind === mode && Number(item.dataset.wiringComponentIndex) === index);
  assert.ok(port, `missing ${mode} Wiring port for component ${index}`);
  wiringOverlayHost.dispatchEvent(event("click", port));
}

(async () => {
  const [{ state }, storage, designer, history, wiringUi, paletteUi, { PART_STATS }] = await Promise.all([
    import("./public/src/state.js"), import("./public/src/design/blueprintStorage.js"), import("./public/src/ui/designerUi.js"), import("./public/src/design/blueprintEditHistory.js"), import("./public/src/ui/wiringUi.js"), import("./public/src/ui/partPaletteUi.js"), import("./public/src/design/parts.js")
  ]);
  paletteUi.setPartPaletteSelectionPresentationRefresh(designer.refreshBlueprintSelectionPresentation);
  designer.setBlueprintEditHistoryUiHooksForTests({ persistDesign: () => {}, refresh: () => { designer.renderBuildGrid(); designer.renderLocalStats(); designer.refreshBlueprintUndoControl(); } });
  state.mine = { money: 9999 }; state.rules = { startingMoney: 9999 }; state.design = storage.defaultDesign(); state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design); state.selectedPart = "frame"; state.selectedPartCategory = "Structure"; state.previewRotation = 0; state.blueprintView = "build"; history.clearBlueprintEditHistory(); wiringUi.resetWiringEditorState(); designer.renderBuildGrid(); designer.renderLocalStats(); paletteUi.renderPalette();
  const grid = elements.get("buildGrid");
  const assertTabs = (active) => { for (const [mode, tab] of [["build", elements.get("blueprintBuildTab")], ["heat", elements.get("blueprintHeatTab")], ["wiring", elements.get("blueprintWiringTab")]]) { assert.equal(tab.getAttribute("aria-selected"), String(mode === active), `${mode} aria-selected`); assert.equal(tab.getAttribute("tabindex"), mode === active ? "0" : "-1", `${mode} tabindex`); } };
  const paletteButtons = () => elements.get("partPalette").querySelectorAll("button");
  const categoryButton = (name) => elements.get("partPalette").children[0].children.find(b => b.textContent === name);
  const partButton = (name) => elements.get("partPalette").querySelectorAll("button").find(b => String(b.title).startsWith(`${name} |`));

  designer.setBlueprintView("build"); paletteUi.renderPalette(); assert.equal(elements.get("blueprintModeTitle").textContent, "Build"); assert.equal(elements.get("blueprintModeDescription").textContent, "Add, rotate and remove ship components."); assertTabs("build"); assert.equal(elements.get("buildInteractionGuide").hidden, false); assert.equal(elements.get("heatToolbar").hidden, true); assert.equal(elements.get("wiringToolbar").hidden, true); assert.ok(paletteButtons().every(b => !b.disabled), "Build palette enabled");
  designer.setBlueprintView("heat"); paletteUi.renderPalette(); assert.equal(elements.get("blueprintModeTitle").textContent, "Heat"); assert.equal(elements.get("blueprintModeDescription").textContent, "Build while viewing predicted component Heat and thermal flow."); assertTabs("heat"); assert.equal(elements.get("heatToolbar").hidden, false); assert.equal(elements.get("wiringToolbar").hidden, true); assert.ok(paletteButtons().every(b => !b.disabled), "Heat palette enabled");
  designer.setBlueprintView("wiring"); paletteUi.renderPalette(); assert.equal(elements.get("blueprintModeTitle").textContent, "Wiring"); assert.equal(elements.get("blueprintModeDescription").textContent, "Draw and edit Power or Data networks. Component placement is paused."); assertTabs("wiring"); assert.equal(elements.get("wiringToolbar").hidden, false); assert.equal(elements.get("heatToolbar").hidden, true); assert.equal(elements.get("buildInteractionGuide").hidden, true); assert.equal(elements.get("rotationIndicator").hidden, true); assert.ok(paletteButtons().every(b => b.disabled), "Wiring palette disabled"); assert.match(elements.get("partPalette").textContent, /Component placement paused in Wiring mode/);

  designer.setBlueprintView("build"); paletteUi.renderPalette(); categoryButton("Weapons").dispatchEvent(event("click", categoryButton("Weapons"))); const blaster = partButton("Blaster"); blaster.dispatchEvent(event("click", blaster)); state.previewRotation = 90; const preserved = { part: state.selectedPart, category: state.selectedPartCategory, rotation: state.previewRotation };
  designer.setBlueprintView("wiring"); paletteUi.renderPalette(); const disabledArmor = partButton("Blaster"); disabledArmor.dispatchEvent(event("click", disabledArmor)); disabledArmor.dispatchEvent(event("keydown", disabledArmor, { key: "Enter" })); assert.deepEqual({ part: state.selectedPart, category: state.selectedPartCategory, rotation: state.previewRotation }, preserved, "disabled Wiring palette cannot change preserved selection");
  designer.setBlueprintView("heat"); paletteUi.renderPalette(); assert.ok(paletteButtons().every(b => !b.disabled)); assert.deepEqual({ part: state.selectedPart, category: state.selectedPartCategory, rotation: state.previewRotation }, preserved, "Heat restores palette selection"); designer.setBlueprintView("wiring"); designer.setBlueprintView("build"); paletteUi.renderPalette(); assert.deepEqual({ part: state.selectedPart, category: state.selectedPartCategory, rotation: state.previewRotation }, preserved, "Build restores palette selection");

  state.selectedPart = "frame"; state.selectedPartCategory = "Structure"; state.previewRotation = 0; designer.setBlueprintView("build"); paletteUi.renderPalette(); const beforeBuild = state.design.length; clickCell(grid, 9, 8); assert.ok(state.design.length > beforeBuild, "Build primary click edits physical design"); const withLeaf = clone(state.design); clickCell(grid, 9, 8, 2); assert.ok(state.design.length < withLeaf.length, "Build right-click removes"); designer.undoBlueprintEdit();
  designer.setBlueprintView("heat"); state.selectedPart = "armor"; state.selectedPartCategory = "Structure"; state.previewRotation = 0; const beforeHeat = JSON.stringify(state.design); clickCell(grid, 9, 8); assert.notEqual(JSON.stringify(state.design), beforeHeat, "Heat primary click edits physical design"); const heatDesign = JSON.stringify(state.design); clickCell(grid, 9, 8, 2); assert.equal(JSON.stringify(state.design), heatDesign, "Heat right-click does not remove"); state.selectedPart = "blaster"; state.selectedPartCategory = "Weapons"; state.previewRotation = 0; const rotBefore = state.previewRotation; designer.rotateFocusedPart(); assert.notEqual(state.previewRotation, rotBefore, "Heat R path rotates preview");
  designer.setBlueprintView("wiring"); const wiringDesign = JSON.stringify(state.design); const wiringRot = state.previewRotation; clickCell(grid, 8, 8); assert.equal(JSON.stringify(state.design), wiringDesign, "Wiring primary click does not physically edit"); designer.rotateFocusedPart(); assert.equal(state.previewRotation, wiringRot, "Wiring R does not rotate physical preview"); clickCell(grid, 9, 8, 2); assert.equal(JSON.stringify(state.design), wiringDesign, "Wiring right-click does not remove");

  designer.setBlueprintView("wiring"); state.wiringUi.mode = "power"; designer.renderBuildGrid();
  const preEdit = { wiring: canonicalWiring(state.wiring, state.design, PART_STATS), design: clone(state.design), physicalHistorySize: history.blueprintEditHistorySize(), wiringUndoDepth: state.wiringUi.undoStack.length };
  const route = findRoute(state.design, PART_STATS, "power", state.wiring);
  assert.ok(wiringRules.isPowerSourceType(state.design[route.sourceIndex].type), "selected power source is production-valid");
  assert.ok(wiringRules.isPowerConsumer(state.design[route.targetIndex].type, PART_STATS), "selected power destination is production-compatible");
  clickWiringPort(elements.get("wiringOverlayHost"), route.sourceIndex, "power");
  assert.equal(state.wiringUi.sourceIndex, route.sourceIndex, "production Wiring handler starts route");
  for (const cell of route.path.slice(1)) wiringUi.handleWiringCellClick(cell.x, cell.y);
  wiringUi.handleWiringCellClick(route.path.at(-1).x, route.path.at(-1).y);
  const completedState = { wiring: canonicalWiring(state.wiring, state.design, PART_STATS), wiringUndoDepth: state.wiringUi.undoStack.length, design: clone(state.design), physicalHistorySize: history.blueprintEditHistorySize(), selectedPart: state.selectedPart, selectedPartCategory: state.selectedPartCategory, previewRotation: state.previewRotation, wiringMode: state.wiringUi.mode };
  assert.notDeepEqual(completedState.wiring, preEdit.wiring, "completed Wiring edit changes wiring");
  assert.ok(completedState.wiring.power.sections.length > preEdit.wiring.power.sections.length, "completed Wiring sections exist");
  assert.equal(completedState.wiringUndoDepth, preEdit.wiringUndoDepth + 1, "completed Wiring edit creates exactly one Undo entry");
  assert.deepEqual(completedState.design, preEdit.design, "completed Wiring edit does not change physical design");
  assert.equal(completedState.physicalHistorySize, preEdit.physicalHistorySize, "completed Wiring edit does not add physical history");
  clickWiringPort(elements.get("wiringOverlayHost"), route.sourceIndex, "power");
  state.wiringUi.path.push(route.path[1]); state.wiringUi.hoverCell = { ...route.path[1], valid: true }; state.wiringUi.livePointer = { x: route.path[1].x + .5, y: route.path[1].y + .5 }; state.wiringUi.dragging = true; state.wiringUi.activeOrigin = { ...route.path[0] };
  designer.setBlueprintView("build"); assert.deepEqual(canonicalWiring(state.wiring, state.design, PART_STATS), completedState.wiring, "leaving Wiring preserves completed wiring"); assert.equal(state.wiringUi.undoStack.length, completedState.wiringUndoDepth, "leaving Wiring preserves genuine Wiring Undo stack depth"); assert.deepEqual(state.design, completedState.design, "leaving Wiring preserves physical design"); assert.equal(history.blueprintEditHistorySize(), completedState.physicalHistorySize, "leaving Wiring preserves physical history"); assert.equal(state.selectedPart, completedState.selectedPart); assert.equal(state.selectedPartCategory, completedState.selectedPartCategory); assert.equal(state.previewRotation, completedState.previewRotation); assert.equal(state.wiringUi.mode, completedState.wiringMode, "Wiring mode preserved"); assert.equal(state.wiringUi.sourceIndex, null); assert.deepEqual(state.wiringUi.path, []); assert.equal(state.wiringUi.hoverCell, null); assert.equal(state.wiringUi.livePointer, null); assert.equal(state.wiringUi.dragging, false); assert.equal(state.wiringUi.activeOrigin, null);
  designer.setBlueprintView("wiring"); assert.equal(wiringUi.undoWiring(), true, "Wiring Undo remains usable after mode transition"); assert.deepEqual(canonicalWiring(state.wiring, state.design, PART_STATS), preEdit.wiring, "Wiring Undo restores exact canonical pre-edit wiring"); assert.equal(state.wiringUi.undoStack.length, preEdit.wiringUndoDepth, "Wiring Undo depth decreases by one"); assert.deepEqual(state.design, preEdit.design, "Wiring Undo does not change physical design"); assert.equal(history.blueprintEditHistorySize(), preEdit.physicalHistorySize, "Wiring Undo does not change physical history");
  designer.setBlueprintView("build"); clickCell(grid, 9, 8); assert.notDeepEqual(state.design, preEdit.design, "stale Wiring click suppression does not block first Build edit"); designer.undoBlueprintEdit(); assert.deepEqual(state.design, preEdit.design, "physical Undo restores Build interaction used for suppression coverage");

  designer.setBlueprintView("heat"); state.hoveredHeatPartIndex = 0; const heatSnapshot = JSON.stringify({ design: state.design, wiring: state.wiring, undo: state.wiringUi.undoStack }); designer.setBlueprintView("build"); assert.equal(state.hoveredHeatPartIndex, null, "Heat transient inspection clears when leaving Heat"); assert.equal(JSON.stringify({ design: state.design, wiring: state.wiring, undo: state.wiringUi.undoStack }), heatSnapshot, "leaving Heat preserves design, wiring, and undo");
  designer.setBlueprintEditHistoryUiHooksForTests(null);
  console.log("Blueprint modes verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
