"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const wiringRules = require("./public/src/shared/wiringRules.js");
const heatRules = require("./public/src/shared/heatRules.js");
const engineExhaustRules = require("./public/src/shared/engineExhaust.js");
const dataSupportRules = require("./public/src/shared/dataSupportRules.js");
const turretRules = require("./public/src/shared/turretRules.js");

globalThis.WiringRules = wiringRules;
globalThis.HeatRules = heatRules;
globalThis.EngineExhaustRules = engineExhaustRules;
globalThis.DataSupportRules = dataSupportRules;
globalThis.TurretRules = turretRules;

class FakeElement {
  constructor(tag = "div", id = "") { this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.parentNode = null; this.listeners = new Map(); this.style = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this.attributes = {}; this.className = ""; this.type = ""; this.title = ""; this._textContent = ""; this._innerHTML = ""; }
  set textContent(v) { this._textContent = String(v); if (v === "") this.children = []; }
  get textContent() { return this._textContent || this.children.map(c => c.textContent).join(""); }
  set innerHTML(v) { this._innerHTML = String(v); this.children = []; }
  get innerHTML() { return this._innerHTML; }
  get classList() { const el = this; const set = () => new Set(String(el.className).split(/\s+/).filter(Boolean)); return { add(...n){ const s=set(); n.forEach(x=>s.add(x)); el.className=[...s].join(" "); }, remove(...n){ const s=set(); n.forEach(x=>s.delete(x)); el.className=[...s].join(" "); }, contains(n){ return set().has(n); }, toggle(n, force){ const s=set(); const on=force===undefined?!s.has(n):force; if(on)s.add(n); else s.delete(n); el.className=[...s].join(" "); return on; } }; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...kids) { kids.forEach(k => this.appendChild(k)); }
  focus() { globalThis.document.activeElement = this; }
  addEventListener(type, handler) { const list = this.listeners.get(type) || []; list.push(handler); this.listeners.set(type, list); }
  setAttribute(n, v) { this.attributes[n] = String(v); }
  getAttribute(n) { return this.attributes[n] ?? null; }
  removeAttribute(n) { delete this.attributes[n]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const elements = new Map([
  "saveDesignButton", "loadedBlueprintName", "confirmModal", "confirmModalTitle", "confirmModalMessage", "confirmAcceptButton", "confirmCancelButton", "combatStyleSelect", "blueprintCostLabel", "blueprintCostStatus", "statsGrid", "partInspector", "buildGrid", "shipStatusChip", "shipStatusText", "shipStatusDetails", "deployButton", "openBlueprintDesignerButton", "moneyHudLabel", "incomeHudLabel", "phaseDetail"
].map((id) => [id, new FakeElement(id.endsWith("Button") ? "button" : "div", id)]));

globalThis.document = {
  activeElement: null,
  getElementById: (id) => elements.get(id) || null,
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (ns, tag) => new FakeElement(tag),
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => []
};
globalThis.window = { addEventListener: () => {}, removeEventListener: () => {}, requestAnimationFrame: (cb) => setTimeout(cb, 0), getComputedStyle: () => ({ display: "block", visibility: "visible" }), innerWidth: 1280 };
globalThis.HTMLElement = FakeElement;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

(async () => {
  const [{ state }, storage, componentStats, history, savedUi, purchaseUi] = await Promise.all([
    import("./public/src/state.js"),
    import("./public/src/design/blueprintStorage.js"),
    import("./public/src/design/componentStats.js"),
    import("./public/src/design/blueprintEditHistory.js"),
    import("./public/src/ui/savedBlueprintsUi.js"),
    import("./public/src/ui/purchaseUi.js")
  ]);

  const saveButton = elements.get("saveDesignButton");
  const loadedName = elements.get("loadedBlueprintName");
  const baseDesign = storage.defaultDesign();
  const baseWiring = storage.normalizeWiring(storage.defaultWiring(), baseDesign);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const saved = (id, name, design = baseDesign) => ({ id, name, blueprint: clone(design), wiring: clone(baseWiring), combatStyle: "sentry", createdAt: 1, updatedAt: 1 });

  state.design = clone(baseDesign);
  state.wiring = clone(baseWiring);
  state.savedDesigns = [];
  state.loadedEditorBlueprintId = null;
  savedUi.refreshLoadedBlueprintPresentation();
  assert.equal(loadedName.textContent, "Unsaved design", "unsaved context names the current design");
  assert.equal(saveButton.textContent, "Save Blueprint", "unsaved context shows Save Blueprint");

  state.savedDesigns = [saved("loaded", "Alpha"), saved("other", "Beta")];
  state.loadedEditorBlueprintId = "loaded";
  savedUi.refreshLoadedBlueprintPresentation();
  assert.equal(loadedName.textContent, "Alpha");
  assert.equal(saveButton.textContent, 'Update "Alpha"');

  const beforeDesign = clone(state.design);
  const beforeWiring = clone(state.wiring);
  const beforePhysicalUndo = history.blueprintEditHistorySize();
  const beforeWiringUndo = state.wiringUi.undoStack.length;
  savedUi.renameSavedDesign("loaded", "Alpha Prime");
  assert.equal(state.savedDesigns.find(d => d.id === "loaded").name, "Alpha Prime");
  assert.equal(loadedName.textContent, "Alpha Prime");
  assert.equal(saveButton.textContent, 'Update "Alpha Prime"');
  assert.deepEqual(state.design, beforeDesign, "rename loaded design does not change physical design");
  assert.deepEqual(state.wiring, beforeWiring, "rename loaded design does not change Wiring");
  assert.equal(history.blueprintEditHistorySize(), beforePhysicalUndo, "rename loaded design does not touch physical Undo");
  assert.equal(state.wiringUi.undoStack.length, beforeWiringUndo, "rename loaded design does not touch Wiring Undo");

  savedUi.renameSavedDesign("other", "Gamma");
  assert.equal(state.savedDesigns.find(d => d.id === "other").name, "Gamma");
  assert.equal(loadedName.textContent, "Alpha Prime", "unrelated rename leaves loaded context unchanged");
  assert.equal(saveButton.textContent, 'Update "Alpha Prime"');

  savedUi.openDeleteDesignModal(state.savedDesigns.find(d => d.id === "loaded"));
  savedUi.confirmModalAction();
  assert.equal(state.loadedEditorBlueprintId, null, "delete loaded design clears loaded identity");
  assert.equal(loadedName.textContent, "Unsaved design");
  assert.equal(saveButton.textContent, "Save Blueprint");
  assert.deepEqual(state.design, beforeDesign, "delete loaded design preserves editor design");
  assert.deepEqual(state.wiring, beforeWiring, "delete loaded design preserves editor Wiring");

  state.design = clone(baseDesign);
  state.wiring = clone(baseWiring);
  state.savedDesigns = [saved("saved-a", "Saved A"), saved("saved-b", "Saved B")];
  state.loadouts = [{ id: "loadout-one", name: "Loadout One", designIds: ["saved-a"] }];
  state.activeLoadoutId = "all";
  state.phase = "active";
  state.mine = { money: 10000, activeShips: 0, shipCap: 10, ready: true };
  state.rules = { ...state.rules, shipCap: 10, startingMoney: 10000 };
  state.pendingPurchases = new Map();
  state.purchaseErrors = new Map();
  state.designNeedsAttention = false;

  const allOptions = purchaseUi.getPurchaseOptions();
  assert.deepEqual(allOptions.map(o => o.name), ["Current Design", "Saved A", "Saved B"], "All Loadout includes Current Design and all saved designs");
  const currentAllState = purchaseUi.getPurchaseOptionState(allOptions[0], 1);
  purchaseUi.setActiveLoadout("loadout-one");
  const customOptions = purchaseUi.getPurchaseOptions();
  assert.deepEqual(customOptions.map(o => o.name), ["Current Design", "Saved A"], "custom Loadout preserves Current Design and filters saved designs");
  assert.deepEqual(purchaseUi.getPurchaseOptionState(customOptions[0], 1), currentAllState, "switching Loadouts does not alter Current Design eligibility");
  assert.equal(purchaseUi.purchaseStatusText(purchaseUi.getPurchaseOptionState(customOptions[1], 1)), "Available to build", "improved status wording appears inside custom Loadout");

  const option = allOptions[0];
  const baseline = purchaseUi.getPurchaseOptionState(option, 1);
  assert.equal(baseline.canBuy, true, "purchasable option remains buyable");
  assert.equal(purchaseUi.purchaseStatusText(baseline), "Available to build");

  state.mine.money = option.stats.unitCost - 7;
  const insufficient = purchaseUi.getPurchaseOptionState(option, 1);
  assert.equal(insufficient.canBuy, false);
  assert.equal(insufficient.reason, "Need $7 more", "monetary shortfall remains exact");
  assert.equal(purchaseUi.purchaseStatusText(insufficient), "Need $7 more");

  state.mine.money = 10000;
  state.mine.activeShips = 10;
  let fleet = purchaseUi.getPurchaseOptionState(option, 1);
  assert.equal(fleet.canBuy, false);
  assert.equal(fleet.reason, "Fleet full");
  assert.equal(purchaseUi.purchaseStatusText(fleet), "Fleet full");

  state.mine.activeShips = 8;
  fleet = purchaseUi.getPurchaseOptionState(option, 5);
  assert.equal(fleet.canBuy, false);
  assert.equal(fleet.reason, "Need 5 fleet slots");
  assert.equal(purchaseUi.purchaseStatusText(fleet), "Need 5 fleet slots");

  state.mine.activeShips = 0;
  state.mine.ready = false;
  const notReady = purchaseUi.getPurchaseOptionState(option, 1);
  assert.equal(notReady.canBuy, false);
  assert.equal(notReady.reason, "Complete your starting ship first");
  assert.equal(purchaseUi.purchaseStatusText(notReady), "Complete your starting ship first");

  state.mine.ready = true;
  const invalidOption = { ...option, id: "invalid", blueprint: [], stats: componentStats.computeStats([]) };
  const invalid = purchaseUi.getPurchaseOptionState(invalidOption, 1);
  assert.equal(invalid.canBuy, false);
  assert.ok(invalid.reason, "authoritative invalid reason is preserved");
  assert.match(purchaseUi.purchaseStatusText(invalid), /^Design invalid — /);

  state.pendingPurchases.set("req-1", { optionId: option.id, requestId: "req-1" });
  const pending = purchaseUi.getPurchaseOptionState(option, 1);
  assert.equal(pending.canBuy, false);
  assert.ok(pending.pending);
  assert.equal(purchaseUi.purchaseStatusText(pending), "Building…");

  state.pendingPurchases.clear();
  state.purchaseErrors.set(option.id, { message: "Server said no" });
  const failed = purchaseUi.getPurchaseOptionState(option, 1);
  assert.equal(failed.canBuy, false);
  assert.equal(failed.reason, "Server said no");
  assert.equal(purchaseUi.purchaseStatusText(failed), "Purchase failed — Server said no");

  const html = fs.readFileSync("public/index.html", "utf8");
  const controlsCss = fs.readFileSync("public/styles/blueprint-controls.css", "utf8");
  const purchaseCss = fs.readFileSync("public/styles/purchase-ui.css", "utf8");
  assert.match(html, /id="blueprintCostBanner"[\s\S]*Build cost/, "cost banner keeps existing id and says Build cost");
  assert.equal((html.match(/id="saveDesignButton"/g) || []).length, 1, "Save button remains a single DOM element");
  assert.match(controlsCss, /blueprint-cost-banner[\s\S]*overflow-wrap:\s*anywhere/, "cost banner supports wrapping without clipping");
  assert.match(purchaseCss, /purchase-status[\s\S]*white-space:\s*normal[\s\S]*-webkit-line-clamp:\s*3/, "purchase reasons wrap in a stable status area");

  console.log("Blueprint information polish verification passed");
})().catch((error) => { console.error(error); process.exit(1); });
