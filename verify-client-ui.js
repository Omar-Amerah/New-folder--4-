"use strict";

const fs = require("fs");
const vm = require("vm");

// The bundle boots the arena renderer at load, which dynamic-imports pixi.js.
// The vm harness has no module loader, so that rejection is expected and not
// part of what this file verifies — swallow exactly that error, fail on others.
process.on("unhandledRejection", (err) => {
  if (err && err.code === "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") return;
  throw err;
});

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.className = "";
    this._textContent = "";
    this._innerHTML = "";
    Object.defineProperty(this, "textContent", {
      get: () => this._textContent,
      set: (value) => {
        this._textContent = String(value);
        if (value === "") this.children = [];
      }
    });
    Object.defineProperty(this, "innerHTML", {
      get: () => this._innerHTML,
      set: (value) => {
        this._innerHTML = String(value);
        if (value === "") this.children = [];
      }
    });
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
  }

  get classList() {
    const el = this;
    const set = () => new Set(String(el.className).split(/\s+/).filter(Boolean));
    return {
      add(...names) { const s = set(); names.forEach((n) => s.add(n)); el.className = [...s].join(" "); },
      remove(...names) { const s = set(); names.forEach((n) => s.delete(n)); el.className = [...s].join(" "); },
      contains(name) { return set().has(name); },
      toggle(name, force) {
        const s = set();
        const shouldHave = force === undefined ? !s.has(name) : force;
        if (shouldHave) s.add(name); else s.delete(name);
        el.className = [...s].join(" ");
        return shouldHave;
      },
      [Symbol.iterator]() { return set()[Symbol.iterator](); }
    };
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  setAttribute(name, value) {
    if (!this.attributes) this.attributes = {};
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return this.attributes && name in this.attributes ? this.attributes[name] : null;
  }

  removeAttribute(name) {
    if (this.attributes) delete this.attributes[name];
  }

  closest(selector) {
    const id = String(selector).startsWith("#") ? String(selector).slice(1) : null;
    const className = String(selector).startsWith(".") ? String(selector).slice(1).split(".")[0] : null;
    let node = this;
    while (node) {
      if (id && node.id === id) return node;
      if (className && String(node.className).split(/\s+/).includes(className)) return node;
      node = node.parentNode;
    }
    return null;
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({
        key: "",
        button: 0,
        clientX: 0,
        clientY: 0,
        pointerId: 1,
        preventDefault() {},
        ...event
      });
    }
  }

  click() {
    this.dispatch("click");
  }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  insertAdjacentHTML(position, html) {
    if (String(html).includes("component-heat-value")) {
      const badge = new FakeElement("span");
      badge.className = "component-heat-value";
      this.appendChild(badge);
    }
    this.innerHTML += String(html);
  }

  prepend(child) {
    this.children.unshift(child);
    child.parentNode = this;
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
  }

  focus() {
    document.activeElement = this;
  }

  setPointerCapture() {}

  querySelectorAll(selector) {
    const selectorText = String(selector);
    const selectors = selectorText.split(",").map((item) => item.trim()).filter(Boolean);
    const matchesSelector = (element, selectorItem) => {
      if (!selectorItem.startsWith(".")) return false;
      const required = selectorItem.slice(1).split(".").filter(Boolean);
      const classes = new Set(String(element.className).split(/\s+/).filter(Boolean));
      return required.every((className) => classes.has(className));
    };
    const matches = [];
    const walk = (element) => {
      for (const child of element.children) {
        if (selectors.some((selectorItem) => matchesSelector(child, selectorItem))) matches.push(child);
        walk(child);
      }
    };
    walk(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 960, height: 640 };
  }

  getContext() {
    return new Proxy({}, {
      get(target, prop) {
        if (!(prop in target)) target[prop] = () => {};
        return target[prop];
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      }
    });
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] || null;
  }

  get offsetHeight() {
    return 1;
  }
}

const ids = [
  "arenaCanvas",
  "connectionStatus",
  "roomStateText",
  "pilotName",
  "teamSelect",
  "roomCode",
  "createButton",
  "currentRoomCard",
  "currentRoomCode",
  "phaseDetail",
  "stepLobby",
  "stepDesign",
  "stepBattle",
  "stepEnd",
  "joinButton",
  "copyButton",
  "botButton",
  "adminControls",
  "startDesignButton",
  "closeLobbyButton",
  "playerList",
  "deployButton",
  "resetButton",
  "formationSelect",
  "partPalette",
  "partInspector",
  "buildGrid",
  "shipStatusChip",
  "shipStatusText",
  "shipStatusDetails",
  "statsGrid",
  "saveDesignButton",
  "savedDesignList",
  "budgetText",
  "roomLabel",
  "fleetLabel",
  "moneyHudLabel",
  "relayLabel",
  "selectionLabel",
  "objectiveLabel",
  "moneyTitle",
  "moneyLabel",
  "incomeLabel",
  "unitCostTitle",
  "unitCostLabel",
  "canBuildTitle",
  "canBuildLabel",
  "afterBuildTitle",
  "afterBuildLabel",
  "budgetCard",
  "budgetTitle",
  "fleetCapLabel",
  "buildShipButton",
  "buildFiveButton",
  "scoreList",
  "eventLog",
  "toastStack",
  "matchProgressFill",
  "matchSummary",
  "latencyText",
  "commandMarker",
  "winnerBanner",
  "endGameScreen",
  "endGameTitle",
  "endGameSummary",
  "endGameActions",
  "restartButton",
  "endCloseButton"
];

const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
elements.get("teamSelect").value = "blue";
elements.get("formationSelect").value = "line";

const localStore = new Map();
const document = {
  activeElement: null,
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  },
  createElement(tagName) {
    const element = new FakeElement(tagName);
    element.tagName = tagName.toUpperCase();
    return element;
  },
  createElementNS(namespace, tagName) {
    const element = new FakeElement(tagName);
    element.namespaceURI = namespace;
    element.tagName = tagName.toUpperCase();
    return element;
  },
  createTextNode(text) {
    const element = new FakeElement("#text");
    element.textContent = text;
    return element;
  },
  querySelector(selector) {
    for (const element of elements.values()) {
      if (element.querySelectorAll(selector).length) return element.querySelector(selector);
    }
    return null;
  }
};

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(data) {
    this.lastSent = data;
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const context = {
  console,
  document,
  window: { addEventListener() {} },
  localStorage: {
    getItem(key) {
      return localStore.has(key) ? localStore.get(key) : null;
    },
    setItem(key, value) {
      localStore.set(key, String(value));
    }
  },
  navigator: {},
  location: { protocol: "http:", host: "localhost:3001", search: "" },
  WebSocket: FakeWebSocket,
  URL,
  URLSearchParams,
  Math,
  performance: { now: () => 0 },
  requestAnimationFrame() {},
  setInterval() {},
  setTimeout(handler) {
    return 0;
  },
  clearTimeout() {}
};

vm.createContext(context);
vm.runInContext(fs.readFileSync("public/src/shared/heatRules.js", "utf8"), context, {
  filename: "public/src/shared/heatRules.js"
});
vm.runInContext(fs.readFileSync("public/src/shared/engineExhaust.js", "utf8"), context, {
  filename: "public/src/shared/engineExhaust.js"
});
vm.runInContext(fs.readFileSync("public/src/shared/turretRules.js", "utf8"), context, {
  filename: "public/src/shared/turretRules.js"
});
vm.runInContext(fs.readFileSync("public/client.js", "utf8"), context, {
  filename: "public/client.js"
});

elements.get("createButton").click();

if (elements.get("connectionStatus").textContent !== "Connecting") {
  throw new Error("Create Game did not update connection status");
}

if (!elements.get("connectionStatus").className.includes("connecting")) {
  throw new Error("Create Game did not apply connecting status class");
}

if (!elements.get("createButton").disabled || !elements.get("joinButton").disabled) {
  throw new Error("Create Game did not disable lobby actions while connecting");
}

if (context.numberOr(5) !== 5) throw new Error("numberOr failed on integer");
if (context.numberOr("5") !== 5) throw new Error("numberOr failed on string number");
if (context.numberOr("5.5") !== 5.5) throw new Error("numberOr failed on decimal string");
if (context.numberOr("", 10) !== 0) throw new Error("numberOr failed on empty string");
if (context.numberOr(null, 10) !== 0) throw new Error("numberOr failed on null");
if (context.numberOr(undefined, 10) !== 10) throw new Error("numberOr failed on undefined with fallback");
if (context.numberOr(NaN, 7) !== 7) throw new Error("numberOr failed on NaN with fallback");
if (context.numberOr(Infinity, 3) !== 3) throw new Error("numberOr failed on Infinity with fallback");
if (context.numberOr("-Infinity", 3) !== 3) throw new Error("numberOr failed on -Infinity string with fallback");
if (context.numberOr("abc", 2) !== 2) throw new Error("numberOr failed on non-numeric string");
if (context.numberOr("10px", 5) !== 5) throw new Error("numberOr failed on string with trailing characters");

const balance = JSON.parse(fs.readFileSync("component-balance.json", "utf8"));
context.applyComponentBalance(balance);

const railgunFootprintAngles = vm.runInContext(`
  [
    footprintArtAngle("railgun", 0, 3, 1),
    footprintArtAngle("railgun", 90, 1, 3),
    footprintArtAngle("railgun", 180, 3, 1),
    footprintArtAngle("railgun", 270, 1, 3)
  ];
`, context);
const expectedRailgunAngles = [-Math.PI / 2, 0, Math.PI / 2, -Math.PI];
for (let i = 0; i < expectedRailgunAngles.length; i += 1) {
  if (Math.abs(railgunFootprintAngles[i] - expectedRailgunAngles[i]) > 1e-9) {
    throw new Error(`railgun footprint icon angle ${i} regressed: ${railgunFootprintAngles.join(",")}`);
  }
}

for (const type of ["pointDefense", "flakCannon", "interceptorPod"]) {
  if (!context.isRotatablePart(type)) {
    throw new Error(`${type} should be rotatable`);
  }
  const part = context.makeDesignPart(1, 1, type, 90);
  if (part.rotation !== 90) {
    throw new Error(`${type} did not preserve rotation`);
  }
}

if (context.isRotatablePart("engine")) {
  throw new Error("engine should not be rotatable");
}

if (context.makeDesignPart(1, 1, "engine", 90).rotation !== 0) {
  throw new Error("engine placement should ignore preview rotation");
}

if (!context.isRotatablePart("halfArmorDiagonal")) {
  throw new Error("half armor diagonal should preserve balance rotatable metadata");
}

if (context.isRotatablePart("shield")) {
  throw new Error("plain shield module should not be rotatable");
}

const enginePreviewRotation = vm.runInContext(`
  state.selectedPart = "engine";
  state.hoveredCell = { x: 0, y: 0 };
  state.selectedCell = null;
  state.previewRotation = 0;
  rotateFocusedPart();
  state.previewRotation;
`, context);
if (enginePreviewRotation !== 0) {
  throw new Error("engine preview rotation should not change");
}

const weaponPreviewRotation = vm.runInContext(`
  state.selectedPart = "blaster";
  state.hoveredCell = null;
  state.selectedCell = null;
  state.previewRotation = 0;
  rotateFocusedPart();
  state.previewRotation;
`, context);
if (weaponPreviewRotation !== 90) {
  throw new Error("selected rotatable part preview should rotate");
}

const rotationCycle = vm.runInContext(`
  state.design = [
    { x: 5, y: 5, type: "core", rotation: 0 },
    { x: 5, y: 6, type: "blaster", rotation: 0 }
  ];
  state.selectedPart = "blaster";
  state.previewRotation = 0;
  [rotateCell(5, 6), state.design[1].rotation, state.previewRotation,
   rotateCell(5, 6), state.design[1].rotation, state.previewRotation,
   rotateCell(5, 6), state.design[1].rotation, state.previewRotation,
   rotateCell(5, 6), state.design[1].rotation, state.previewRotation];
`, context);
if (rotationCycle.join(",") !== "true,90,90,true,180,180,true,270,270,true,0,0") {
  throw new Error(`placed component rotation cycle regressed: ${rotationCycle.join(",")}`);
}

const hoverPreviewSize = vm.runInContext(`
  state.design = [
    { x: 5, y: 5, type: "core", rotation: 0 },
    { x: 5, y: 6, type: "blaster", rotation: 0 }
  ];
  state.selectedPart = "railgun";
  state.previewRotation = 90;
  state.hoveredCell = { x: 5, y: 6 };
  renderHoverPreview();
  const preview = dom.grid.querySelectorAll(".build-preview")[0];
  [Number.parseFloat(preview.style.width), Number.parseFloat(preview.style.height)];
`, context);
if (!(hoverPreviewSize[0] > hoverPreviewSize[1] * 2)) {
  throw new Error(`hover preview should keep selected rotation over occupied cells: ${hoverPreviewSize.join(",")}`);
}


const paletteDeselectionRegression = vm.runInContext(`
(() => {
  state.selectedPartCategory = "Structure";
  state.selectedPart = null;
  state.previewRotation = 180;
  state.hoveredCell = { x: 0, y: 0 };
  renderPalette();
  renderPartInspector();
  const buttons = dom.palette.querySelectorAll(".part-button");
  const frameButton = buttons.find(button => button.innerHTML.includes("Frame"));
  const armorButton = buttons.find(button => button.innerHTML.includes("Armor"));
  if (!frameButton || !armorButton) return { missingButtons: true };
  frameButton.click();
  const selectedFrame = state.selectedPart === "frame" && frameButton.className.includes("active");
  const previewAfterSelect = dom.grid.querySelectorAll(".build-preview").length > 0;
  frameButton.click();
  const deselected = state.selectedPart === null;
  const noActiveAfterDeselect = dom.palette.querySelectorAll(".part-button.active").length === 0;
  const noPreviewAfterDeselect = dom.grid.querySelectorAll(".build-preview, .engine-exhaust-preview, .engine-thrust-arrow").length === 0;
  const rotationReset = state.previewRotation === 0;
  const neutralInspector = dom.partInspector.innerHTML.includes("Select a component to view its details");
  armorButton.click();
  const switched = state.selectedPart === "armor" && dom.palette.querySelectorAll(".part-button.active").length === 1;
  return { selectedFrame, previewAfterSelect, deselected, noActiveAfterDeselect, noPreviewAfterDeselect, rotationReset, neutralInspector, switched };
})()
`, context);
for (const [key, value] of Object.entries(paletteDeselectionRegression)) {
  if (!value) throw new Error(`palette deselection regression failed: ${key}`);
}

const blueprintHeatPlacementRegression = vm.runInContext(`
(() => {
  state.design = [
    { x: 5, y: 5, type: "core", rotation: 0 },
    { x: 5, y: 6, type: "frame", rotation: 0 }
  ];
  state.selectedPart = null;
  state.hoveredCell = { x: 5, y: 7 };
  state.previewRotation = 0;
  state.blueprintView = "build";
  renderBuildGrid();
  const beforeDeselected = JSON.stringify(state.design);
  editCell(5, 7);
  renderHoverPreview();
  const deselectedNoChange = JSON.stringify(state.design) === beforeDeselected;
  const deselectedNoPreview = dom.grid.querySelectorAll(".build-preview, .engine-exhaust-preview, .engine-thrust-arrow").length === 0;

  state.selectedPart = "railgun";
  state.previewRotation = 90;
  state.hoveredCell = { x: 5, y: 7 };
  setBlueprintView("heat");
  const heatBefore = getScenarioHeatAnalysis(state.thermalLoadMode || "idle");
  renderHoverPreview();
  const preview = dom.grid.querySelector(".build-preview.valid");
  const expected = createPlacementCandidate({ grid: { x: 5, y: 7 }, componentType: "railgun", rotation: 90, design: state.design, catalogue: PART_STATS });
  editCell(5, 7);
  const placed = state.design.some(part => part.type === "railgun" && part.x === expected.part.x && part.y === expected.part.y && part.rotation === expected.normalizedRotation);
  const heatAfter = getScenarioHeatAnalysis(state.thermalLoadMode || "idle");
  const heatRefreshed = heatAfter !== heatBefore;
  const invalidBefore = JSON.stringify(state.design);
  state.selectedPart = "reactor";
  state.previewRotation = 0;
  state.hoveredCell = { x: 0, y: 0 };
  renderHoverPreview();
  const invalidPreview = dom.grid.querySelector(".build-preview.invalid");
  editCell(0, 0);
  const invalidRejected = JSON.stringify(state.design) === invalidBefore;
  setBlueprintView("build");
  const selectedPreservedBuild = state.selectedPart === "reactor";
  state.selectedPart = null;
  setBlueprintView("heat");
  const deselectedPreservedHeat = state.selectedPart === null;
  return { deselectedNoChange, deselectedNoPreview, heatPreviewShown: Boolean(preview), heatPreviewMatchesCandidate: Boolean(preview) && expected.ok, placed, heatRefreshed, invalidPreview: Boolean(invalidPreview), invalidRejected, selectedPreservedBuild, deselectedPreservedHeat };
})()
`, context);
for (const [key, value] of Object.entries(blueprintHeatPlacementRegression)) {
  if (!value) throw new Error(`blueprint Heat placement regression failed: ${key}`);
}

const delegatedHandlerRegression = vm.runInContext(`
(() => {
  dom.grid.dataset.hasDelegatedClick = "";
  dom.grid.dataset.hasHeatTabs = "";
  dom.grid.listeners = new Map();
  ensureBlueprintGridEventHandlers();
  ensureBlueprintGridEventHandlers();
  setBlueprintView("build");
  setBlueprintView("heat");
  ensureBlueprintGridEventHandlers();
  return {
    click: (dom.grid.listeners.get("click") || []).length,
    mousemove: (dom.grid.listeners.get("mousemove") || []).length,
    contextmenu: (dom.grid.listeners.get("contextmenu") || []).length,
    buildTab: (dom.blueprintBuildTab.listeners.get("click") || []).length,
    heatTab: (dom.blueprintHeatTab.listeners.get("click") || []).length
  };
})()
`, context);
for (const [key, value] of Object.entries(delegatedHandlerRegression)) {
  if (value !== 1) throw new Error(`delegated handler duplicated for ${key}: ${value}`);
}

const shieldedShip = { alive: true, radius: 50, shield: 40, maxShield: 100 };
if (context.shieldRatioForShip(shieldedShip) !== 0.4) {
  throw new Error("shield ratio should use shield / maxShield");
}
if (context.shieldRatioForShip({ shield: 150, maxShield: 100 }) !== 1) {
  throw new Error("shield ratio should clamp to 1");
}
if (context.shieldRatioForShip({ shield: 25, maxShield: 0 }) !== 0) {
  throw new Error("shield ratio should be 0 without max shield");
}
if (context.shieldRingRadius(shieldedShip) <= shieldedShip.radius) {
  throw new Error("shield ring should scale outside ship radius");
}


const clonedHeatAnalysisRegression = vm.runInContext(`
(() => {
  invalidateHeatAnalysisCache();
  const originalDesign = defaultDesign();
  state.design = originalDesign;
  state.thermalLoadMode = "idle";
  const first = getScenarioHeatAnalysis("idle");
  state.design = originalDesign.map(part => ({ ...part }));
  const second = getScenarioHeatAnalysis("idle");
  return {
    recomputed: second !== first,
    currentPredictions: state.design.every(part => second.predictions.has(part)),
    currentHeat: state.design.every(part => second.componentHeat.has(part)),
    currentClasses: state.design.every(part => second.componentClasses.has(part)),
    oldPredictionsMissCurrent: state.design.every(part => !first.predictions.has(part)),
    diagnosticsMatch: heatInteractionDiagnostics().heatAnalysisMatchesCurrentDesign,
    referencesMatch: heatInteractionDiagnostics().heatCachePartReferencesMatch
  };
})()
`, context);
if (!clonedHeatAnalysisRegression.recomputed) {
  throw new Error("equivalent cloned design should force heat analysis recomputation");
}
for (const [key, value] of Object.entries(clonedHeatAnalysisRegression)) {
  if (!value) throw new Error(`cloned heat analysis regression failed: ${key}`);
}

const initialHeatTabRegression = vm.runInContext(`
(() => {
  invalidateHeatAnalysisCache();
  const originalDesign = defaultDesign();
  state.design = originalDesign;
  state.thermalLoadMode = "idle";
  const stale = getScenarioHeatAnalysis("idle");
  state.design = originalDesign.map(part => ({ ...part }));
  state.blueprintView = "build";
  state.showAllHeatFlows = true;
  renderBuildGrid();
  setBlueprintView("heat");
  const occupied = dom.grid.querySelectorAll(".build-cell.occupied");
  const diagnostics = heatInteractionDiagnostics();
  return {
    noErrorMessage: document.querySelector(".heat-ui-error-message") === null,
    noGridError: document.querySelector(".build-grid.heat-ui-error") === null && !dom.grid.classList.contains("heat-ui-error"),
    badgesForComponents: dom.grid.querySelectorAll(".component-heat-value").length >= occupied.length,
    hudShowsIdle: dom.blueprintThermalHud.innerHTML.includes("Idle"),
    staleMissesCurrent: state.design.every(part => !stale.predictions.has(part)),
    diagnosticsMatch: diagnostics.heatAnalysisMatchesCurrentDesign,
    referencesMatch: diagnostics.heatCachePartReferencesMatch,
    noVisibleDiagnosticError: !diagnostics.heatUiErrorVisible
  };
})()
`, context);
for (const [key, value] of Object.entries(initialHeatTabRegression)) {
  if (!value) throw new Error(`initial Heat tab cloned-design regression failed: ${key}`);
}
vm.runInContext(`state.blueprintView = "build"; clearHeatPresentation();`, context);



const designerSource = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
const buildGridCss = fs.readFileSync("public/styles/build-grid.css", "utf8");
for (const cls of ["heat-flow-incoming", "heat-flow-outgoing", "incoming-flow-label", "outgoing-flow-label"]) {
  if (!designerSource.includes(cls) && !buildGridCss.includes(cls)) {
    throw new Error(`missing directional heat-flow visual class: ${cls}`);
  }
}
if (!designerSource.includes("heat-flow-arrow-incoming") || !designerSource.includes("heat-flow-arrow-outgoing")) {
  throw new Error("focused heat transfer arrows should use direction-specific arrow markers");
}
if (!designerSource.includes('for (const cell of occupiedByIndex[flow.from]') || !designerSource.includes(') !== flow.to) continue')) {
  throw new Error("heat transfer arrows should be drawn from flow.from to flow.to only");
}
for (const phrase of ["Natural cooling", "Cooling received through network", "Complete route:", "Cooling route"]) {
  if (designerSource.includes(phrase)) throw new Error(`misleading heat UI phrase remains: ${phrase}`);
}
// The inferred cooling-path preview has been removed from the designer; if it
// ever returns, it must again be labelled as an estimate with a provenance
// disclaimer rather than presented as authoritative routing.
if (designerSource.includes("reachable cooling path")
  && (!designerSource.includes("Estimated reachable cooling path") || !designerSource.includes("not authoritative source-to-radiator heat provenance"))) {
  throw new Error("inferred cooling paths must be labelled as estimates with provenance disclaimer");
}
if (!designerSource.includes("if (!showAll && !focusedFlow) continue;")) {
  throw new Error("local heat-flow mode should remain first-hop/direct only");
}
if (!/heat-flow-incoming[^}]+#38d9ff/i.test(buildGridCss) || !/heat-flow-outgoing[^}]+#ff9a3d/i.test(buildGridCss)) {
  throw new Error("directional heat flows should use distinct cyan incoming and amber outgoing colours");
}
if (!/focused-flow-label[^}]+font-size:\.19px/i.test(buildGridCss) || !/focused-flow-label[^}]+stroke-width:\.05px/i.test(buildGridCss)) {
  throw new Error("focused H/s flow labels should remain compact and readable");
}
if (!designerSource.includes('markerWidth="3.4" markerHeight="3.4"') || designerSource.includes('markerWidth="5" markerHeight="5"')) {
  throw new Error("heat transfer arrow markers should use compact dimensions");
}
if (!designerSource.includes('let width = 0.032 + strength * 0.065') || !designerSource.includes('width = Math.min(0.12, width + 0.018)')) {
  throw new Error("heat transfer stroke widths should use the compact range");
}
if (!designerSource.includes('const fallbackWidth = Math.min(LABEL_MAX_WIDTH, Math.max(0.56, text.length * 0.092 + LABEL_TEXT_PADDING_X * 2))') || !designerSource.includes('const fallbackHeight = 0.24')) {
  throw new Error("heat transfer label collision boxes should match compact label pills");
}
if (!designerSource.includes('suppressHeatGridNativeTooltips') || !designerSource.includes('update.cell.removeAttribute("title")') || !designerSource.includes('update.cell.setAttribute("aria-label", update.ariaLabel)')) {
  throw new Error("heat-view grid cells should suppress native titles and expose aria labels");
}
for (const cls of ["low-heat-flow", "moderate-heat-flow", "high-heat-flow", "critical-heat-flow"]) {
  if (!buildGridCss.includes(cls)) throw new Error(`missing warm transfer intensity class: ${cls}`);
}
if (!buildGridCss.includes("heat-sink-absorption") || !buildGridCss.includes("radiator-exposed")) {
  throw new Error("cooling components should remain visually identifiable via non-directional styling");
}


for (const phrase of ["export function setBlueprintView", "cachedHeatAnalysis", "renderThermalHud", "renderHeatContextCard", "thermalRoleMarkup"]) {
  if (!designerSource.includes(phrase)) throw new Error(`missing contextual heat overlay implementation marker: ${phrase}`);
}
for (const phrase of ["blueprintThermalHud", "heatContextCard", "heatFlowOverlayHost", "buildGridStage"]) {
  if (!fs.readFileSync("public/index.html", "utf8").includes(phrase)) throw new Error(`missing separate heat overlay DOM layer: ${phrase}`);
}
if (!designerSource.includes('updateHeatInspectionOverlay(currentHeatAnalysis())')) {
  throw new Error("hover and inspect should reuse the selected scenario analysis instead of rerunning thermal simulation directly");
}
if (!designerSource.includes("const shouldLabel = focusedFlow && !labeledEdges.has(labelEdgeKey);")
  || !designerSource.includes("if (flow.amount < HEAT_FLOW_THRESHOLD) continue;")) {
  throw new Error("local heat-flow mode should label focused first-hop transfers above the display threshold");
}
if (!designerSource.includes("state.hoveredHeatPartIndex = null") || !designerSource.includes('event.key === "Escape"')) {
  throw new Error("the thermal inspection focus must be clearable (hover reset + Escape handling)");
}
if (!buildGridCss.includes("blueprint-thermal-hud") || !buildGridCss.includes("heat-context-card") || !buildGridCss.includes("thermal-role-indicator")) {
  throw new Error("missing thermal HUD, contextual card, or role-indicator styles");
}
if (!designerSource.includes('prediction.generation > 0.05') || !designerSource.includes('title="Active heat source: +${prediction.generation.toFixed(1)} H/s"') || !designerSource.includes('>✦</span>')) {
  throw new Error("active heat sources should render as value-specific orange spark indicators above the generation threshold");
}
if (designerSource.includes('class="thermal-role-indicator heat-source" title="Generating') || designerSource.includes('heat-source" title="Generating') || designerSource.includes('>↑</span>`')) {
  throw new Error("heat source indicators must not use the old upward arrow or vague generation tooltip");
}
if (!/\.thermal-role-indicator\.heat-source \{[^}]*right:2px;[^}]*top:2px;[^}]*width:10px;[^}]*height:10px;[^}]*font-size:6px;[^}]*box-shadow:0 0 4px rgba\(255,154,61,\.28\);[^}]*opacity:\.9;[^}]*\}/.test(buildGridCss)) {
  throw new Error("heat source spark should be small, calm, amber, and positioned top-right");
}
if (/\.thermal-role-indicator\.heat-source \{[^}]*animation:/i.test(buildGridCss)) {
  throw new Error("heat source spark must not animate");
}
if (!fs.readFileSync("public/index.html", "utf8").includes("orange spark = active heat source")) {
  throw new Error("heat legend should explain the active heat source spark");
}

if (!designerSource.includes('function addClassString(element, classString)') || !designerSource.includes('element.classList.add(...tokens)')) {
  throw new Error('heat class strings should be tokenized before classList.add');
}
if (designerSource.includes('cell.classList.add(heatClass)')) {
  throw new Error('multi-class heat strings must not be passed as one DOMTokenList token');
}
if (/if \(state\.blueprintView === "heat"\) \{\s*removePlacementPreviewElements\(\);\s*return;/.test(designerSource)
  || designerSource.includes('if (state.blueprintView === \"heat\") return;\n  const existing')) {
  throw new Error('Heat tab should allow the normal placement preview and edit path');
}
if (!designerSource.includes('function removePlacementPreviewElements()') || !designerSource.includes('.build-preview, .engine-exhaust-preview, .engine-thrust-arrow')) {
  throw new Error('all placement preview elements should be removed by one helper');
}
if (!designerSource.includes('refreshHeatPresentationSafely()') || !designerSource.includes('console.error("Heat presentation failed", error)')) {
  throw new Error('heat presentation should have a visible error boundary');
}
if (!designerSource.includes('export function heatInteractionDiagnostics()')) {
  throw new Error('disabled heat interaction diagnostics helper is missing');
}

console.log("client ui verification passed");
