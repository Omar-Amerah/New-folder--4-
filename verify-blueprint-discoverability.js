"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
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
// Section 7D-3: Blueprint thermal prediction uses the shared Power/Cable rules.
globalThis.PowerPolicyRules = require("./public/src/shared/powerPolicyRules.js");
globalThis.PowerAllocationRules = require("./public/src/shared/powerAllocationRules.js");
globalThis.PowerDemandRules = require("./public/src/shared/powerDemandRules.js");
globalThis.PowerFlowRules = require("./public/src/shared/powerFlowRules.js");
globalThis.WiringInfrastructureRules = require("./public/src/shared/wiringInfrastructureRules.js");
globalThis.PowerCableThermalRules = require("./public/src/shared/powerCableThermalRules.js");

class FakeElement {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.parentNode = null; this.listeners = new Map();
    this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this.attributes = {}; this.className = ""; this.type = ""; this.title = "";
    this._textContent = ""; this._innerHTML = "";
  }
  set textContent(v) { this._textContent = String(v); if (v === "") this.children = []; }
  get textContent() { return this._textContent || this.children.map(c => c.textContent).join(""); }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  get classList() { const el=this; const set=()=>new Set(String(el.className).split(/\s+/).filter(Boolean)); return { add(...n){const s=set();n.forEach(x=>s.add(x));el.className=[...s].join(" ");}, remove(...n){const s=set();n.forEach(x=>s.delete(x));el.className=[...s].join(" ");}, contains(n){return set().has(n);}, toggle(n,f){const s=set(); const on=f===undefined?!s.has(n):f; if(on)s.add(n);else s.delete(n); el.className=[...s].join(" "); return on;}, [Symbol.iterator](){return set()[Symbol.iterator]();} }; }
  appendChild(c){ c.parentNode=this; this.children.push(c); return c; } append(c){ this.appendChild(c); } prepend(c){ c.parentNode=this; this.children.unshift(c); } replaceChildren(...kids){ this.children=[]; kids.forEach(k=>this.appendChild(k)); }
  remove(){ if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(c=>c!==this); }
  addEventListener(t,h){ const a=this.listeners.get(t)||[]; a.push(h); this.listeners.set(t,a); }
  dispatchEvent(e){ e.target ||= this; for(const h of this.listeners.get(e.type)||[]) h(e); return !e.defaultPrevented; }
  setAttribute(n,v){ this.attributes[n]=String(v); if(n==="aria-expanded") this.ariaExpanded=String(v); } getAttribute(n){ return this.attributes[n] ?? null; } removeAttribute(n){ delete this.attributes[n]; }
  focus(){ globalThis.document.activeElement=this; }
  contains(node){ while(node){ if(node===this) return true; node=node.parentNode; } return false; }
  closest(sel){ let n=this; while(n){ if(matches(n,sel)) return n; n=n.parentNode; } return null; }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel){ const out=[]; const walk=(n)=>{ for(const c of n.children){ if(matches(c,sel)) out.push(c); walk(c); } }; walk(this); return out; }
  insertAdjacentHTML(){ }
  getBoundingClientRect(){ return { left:0, top:0, width:600, height:600, right:600, bottom:600 }; }
}
function matches(el, sel) {
  if (!el) return false;
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  const data = sel.match(/^\.([\w-]+)\[data-([\w-]+)=\"([^\"]+)\"\]$/);
  if (data) return el.classList.contains(data[1]) && String(el.dataset[data[2]]) === data[3];
  if (sel.startsWith(".")) return sel.slice(1).split(".").every(c => el.classList.contains(c));
  if (sel === "strong" || sel === "span") return el.tagName.toLowerCase() === sel;
  return false;
}
const ids = ["buildGrid","buildGridStage","buildInteractionGuide","rotationIndicator","emptyGridInstruction","blueprintBuildTab","blueprintHeatTab","blueprintWiringTab","wiringToolbar","wiringStatusPanel","heatToolbar","blueprintThermalHud","blueprintHeatLegend","thermalLoadModes","thermalScenarioLabel","heatFlowViewControls","showAllHeatFlows","heatFlowHint","heatFlowOverlayHost","wiringOverlayHost","heatContextCard","undoBlueprintEditButton","resetButton","clearGridButton","shipStatusChip","shipStatusText","shipStatusDetails","confirmModal","confirmModalTitle","confirmModalMessage","confirmCancelButton","confirmAcceptButton","partPalette","partInspector","statsGrid","blueprintCostLabel","blueprintCostStatus","combatStyleSelect","saveDesignButton","savedDesignList"];
const elements = new Map(ids.map(id => [id, new FakeElement("div", id)]));
elements.set("buildGrid", new FakeElement("div", "buildGrid")); elements.set("undoBlueprintEditButton", new FakeElement("button", "undoBlueprintEditButton")); elements.set("resetButton", new FakeElement("button", "resetButton")); elements.set("clearGridButton", new FakeElement("button", "clearGridButton")); elements.set("shipStatusChip", new FakeElement("button", "shipStatusChip"));
const empty = elements.get("emptyGridInstruction"); empty.appendChild(new FakeElement("strong")); empty.appendChild(new FakeElement("span"));
const documentListeners = new Map();
globalThis.document = { activeElement:null, getElementById:id=>{ if(!elements.has(id)) elements.set(id, new FakeElement("div", id)); return elements.get(id); }, createElement:t=>new FakeElement(t), createElementNS:(ns,t)=>new FakeElement(t), addEventListener:(t,h)=>{ const a=documentListeners.get(t)||[]; a.push(h); documentListeners.set(t,a); }, querySelector:s=>[...elements.values()].find(e=>matches(e,s))||null, querySelectorAll:s=>[...elements.values()].filter(e=>matches(e,s)) };
globalThis.window = { addEventListener:()=>{}, removeEventListener:()=>{}, requestAnimationFrame:(cb)=>setTimeout(cb,0), getComputedStyle: () => ({ visibility:"visible", display:"block", columnGap:"2px", rowGap:"2px", gap:"2px", paddingLeft:"8px", paddingRight:"8px", paddingTop:"8px", paddingBottom:"8px", borderLeftWidth:"1px", borderRightWidth:"1px", borderTopWidth:"1px", borderBottomWidth:"1px" }), innerWidth:1280 };
globalThis.HTMLElement = FakeElement; globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };

function mouseEvent(type, target, button = 0) { let prevented=false; return { type, target, button, clientX: 340, clientY: 340, preventDefault(){prevented=true;}, get defaultPrevented(){return prevented;}, stopPropagation(){} }; }
function keyEvent(key) { return { key, preventDefault(){ this.defaultPrevented=true; }, stopPropagation(){} }; }
function clickCell(grid, x, y, button = 0) { const cell = grid.querySelector(`.build-cell[data-x="${x}"][data-y="${y}"]`) || grid.querySelector(".build-cell"); const ev = mouseEvent(button===2?"contextmenu":"click", cell, button); grid.dispatchEvent(ev); return ev; }

(async () => {
  const [{ state }, storage, designer, history, wiringUi, paletteUi] = await Promise.all([
    import("./public/src/state.js"), import("./public/src/design/blueprintStorage.js"), import("./public/src/ui/designerUi.js"), import("./public/src/design/blueprintEditHistory.js"), import("./public/src/ui/wiringUi.js"), import("./public/src/ui/partPaletteUi.js")
  ]);
  paletteUi.setPartPaletteSelectionPresentationRefresh(designer.refreshBlueprintSelectionPresentation);
  let persistCalls = 0;
  designer.setBlueprintEditHistoryUiHooksForTests({ persistDesign: () => { persistCalls += 1; }, refresh: () => { designer.renderBuildGrid(); designer.renderLocalStats(); designer.refreshBlueprintUndoControl(); } });
  state.mine = { money: 9999 }; state.rules = { startingMoney: 9999 };
  state.design = storage.defaultDesign(); state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design); state.loadedEditorBlueprintId = null; state.selectedPart = "frame"; state.previewRotation = 0; state.blueprintView = "build";
  history.clearBlueprintEditHistory(); designer.renderBuildGrid(); designer.renderLocalStats();
  const grid = elements.get("buildGrid");

  clickCell(grid, 8, 8, 0); assert.ok(state.design.length > storage.defaultDesign().length, "Build primary click routes to physical editing");
  const buildLength = state.design.length; clickCell(grid, 8, 8, 2); assert.equal(state.design.length, buildLength - 1, "Build secondary click removes through physical path");
  const afterRight = state.design.length; clickCell(grid, 8, 8, 2); assert.equal(state.design.length, afterRight, "secondary click on empty/non-removable cell does not primary edit");

  state.blueprintView = "heat"; state.selectedPart = "armor"; designer.setBlueprintView("heat"); const beforeHeat = history.captureBlueprintEditSnapshot(state); persistCalls = 0; const beforeHistory = history.blueprintEditHistorySize(); clickCell(grid, 8, 8, 0); assert.ok(state.design.length > beforeHeat.design.length, "Heat primary click routes to physical editing"); assert.equal(history.blueprintEditHistorySize(), beforeHistory + 1, "Heat edit creates one history entry"); assert.equal(persistCalls, 1, "Heat edit persists once"); assert.equal(designer.undoBlueprintEdit(), true, "Heat physical Undo succeeds"); assert.equal(JSON.stringify(history.captureBlueprintEditSnapshot(state)), JSON.stringify(beforeHeat), "Heat Undo restores exact paired snapshot");

  state.blueprintView = "wiring"; designer.setBlueprintView("wiring"); const beforeWiring = JSON.stringify(history.captureBlueprintEditSnapshot(state)); clickCell(grid, 8, 8, 0); assert.equal(JSON.stringify(history.captureBlueprintEditSnapshot(state)), beforeWiring, "Wiring primary click does not physically edit");

  function paletteCategoryButton(name) { return elements.get("partPalette").children[0].children.find((button) => button.textContent === name); }
  function palettePartButton(name) { return elements.get("partPalette").children[1].children.find((button) => String(button.title).startsWith(`${name} |`)); }
  function clickPaletteCategory(name) { const button = paletteCategoryButton(name); assert.ok(button, `palette category ${name} exists`); button.dispatchEvent(mouseEvent("click", button)); }
  function clickPalettePart(name) { const button = palettePartButton(name); assert.ok(button, `palette part ${name} exists`); button.dispatchEvent(mouseEvent("click", button)); }

  designer.setBlueprintView("build"); paletteUi.renderPalette(); assert.equal(elements.get("buildInteractionGuide").hidden, false, "Build guide visible"); assert.match(elements.get("buildInteractionGuide").textContent, /right-click/i);
  clickPaletteCategory("Weapons"); assert.equal(state.selectedPart, "blaster", "category change selects first weapon"); assert.equal(elements.get("rotationIndicator").hidden, false, "category change to rotatable first part shows indicator");
  clickPaletteCategory("Structure"); clickPalettePart("Armor"); assert.equal(state.selectedPart, "armor", "real palette click selects Armor"); assert.equal(elements.get("rotationIndicator").hidden, true, "non-rotatable palette part hides indicator");
  clickPalettePart("Armor"); assert.equal(state.selectedPart, null, "real palette click deselects active Armor"); assert.equal(elements.get("rotationIndicator").hidden, true, "deselecting active part hides indicator");
  clickPaletteCategory("Weapons"); assert.equal(elements.get("rotationIndicator").hidden, false, "rotatable palette part immediately shows indicator"); const beforePaletteR = state.previewRotation; designer.rotateFocusedPart(); assert.notEqual(state.previewRotation, beforePaletteR, "pressing R path changes previewRotation"); assert.ok(elements.get("rotationIndicator").textContent.includes(`Rotation: ${state.previewRotation}°`), "pressing R path updates displayed normalized rotation");
  state.design = []; designer.renderBuildGrid(); assert.equal(elements.get("emptyGridInstruction").hidden, false, "Build empty instruction visible");
  designer.setBlueprintView("heat"); clickPaletteCategory("Weapons"); assert.equal(elements.get("buildInteractionGuide").hidden, false, "Heat guide visible"); assert.match(elements.get("buildInteractionGuide").textContent, /Hover to inspect Heat/i); assert.equal(elements.get("rotationIndicator").hidden, false, "Heat rotatable palette selection shows indicator"); assert.equal(elements.get("emptyGridInstruction").hidden, false, "Heat empty instruction visible");
  designer.setBlueprintView("wiring"); clickPaletteCategory("Weapons"); assert.equal(elements.get("buildInteractionGuide").hidden, true, "Wiring guide hidden"); assert.equal(elements.get("rotationIndicator").hidden, true, "Wiring rotation hidden despite selected rotatable part"); assert.equal(elements.get("emptyGridInstruction").hidden, true, "Wiring empty instruction hidden");

  state.design = storage.defaultDesign(); state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design); state.loadedEditorBlueprintId = null; history.clearBlueprintEditHistory(); designer.renderBuildGrid(); assert.equal(designer.requestResetDesign(), false, "no-op Reset does not open modal"); state.design = []; state.wiring = globalThis.WiringRules.emptyWiring(); designer.renderBuildGrid(); assert.equal(designer.requestClearDesign(), false, "no-op Clear does not open modal"); state.design = [{ type:"core", x:7, y:7, rotation:0 }]; const beforeConfirm = JSON.stringify(history.captureBlueprintEditSnapshot(state)); assert.equal(designer.requestResetDesign(), true, "genuine Reset opens modal"); assert.equal(elements.get("confirmModal").hidden, false); assert.equal(designer.closeBlueprintConfirmModalIfPending(), true, "Cancel closes modal"); assert.equal(JSON.stringify(history.captureBlueprintEditSnapshot(state)), beforeConfirm, "Cancel changes nothing"); persistCalls = 0; assert.equal(designer.requestClearDesign(), true, "genuine Clear opens modal"); assert.equal(designer.handleBlueprintConfirmModalAction(), true, "acceptance handled"); assert.equal(state.design.length, 0, "accepted Clear changes design"); assert.equal(history.blueprintEditHistorySize(), 1, "accepted Clear creates one history entry"); assert.equal(persistCalls, 1, "accepted Clear persists once");

  state.design = storage.defaultDesign(); state.wiring = storage.normalizeWiring(storage.defaultWiring(), state.design); elements.get("shipStatusChip").setAttribute("aria-expanded", "false"); elements.get("shipStatusDetails").hidden = true; state.blueprintStatusDisclosure.currentErrorFingerprint = null; state.blueprintStatusDisclosure.dismissedErrorFingerprint = null; designer.renderBuildGrid(); designer.renderLocalStats(); assert.equal(elements.get("shipStatusChip").getAttribute("aria-expanded"), "false", "status starts collapsed"); elements.get("shipStatusChip").dispatchEvent(mouseEvent("click", elements.get("shipStatusChip"))); assert.equal(elements.get("shipStatusChip").getAttribute("aria-expanded"), "true", "click opens status"); for (const h of documentListeners.get("keydown") || []) h(keyEvent("Escape")); assert.equal(elements.get("shipStatusChip").getAttribute("aria-expanded"), "false", "Escape closes status"); state.design = []; designer.renderBuildGrid(); designer.renderLocalStats(); assert.equal(elements.get("shipStatusChip").getAttribute("aria-expanded"), "true", "first error auto-expands"); elements.get("shipStatusChip").dispatchEvent(mouseEvent("click", elements.get("shipStatusChip"))); designer.renderLocalStats(); assert.equal(elements.get("shipStatusChip").getAttribute("aria-expanded"), "false", "same dismissed error stays closed"); state.design = [{ type:"core", x:7, y:7, rotation:0 }]; designer.renderBuildGrid(); designer.renderLocalStats(); assert.equal(elements.get("shipStatusChip").getAttribute("aria-expanded"), "true", "different error reopens");

  const source = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
  assert(!source.includes('if (state.blueprintView === "heat") return;\n      editCell'), "Heat click path is not blocked before editCell");
  designer.setBlueprintEditHistoryUiHooksForTests(null);
  console.log("Blueprint discoverability verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
