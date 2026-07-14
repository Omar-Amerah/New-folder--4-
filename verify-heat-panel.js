"use strict";

// Regression coverage for the selected-ship combat Heat panel display logic:
// fractional overall-heat percentages derived from stored values, live
// component readout refresh across replacement snapshots, ship-id-keyed
// component selection, and the summary/component heat consistency diagnostic.
// Runs against the bundled public/client.js (run `npm run build` first).

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

if (!fs.existsSync("public/client.js")) {
  console.error("public/client.js is missing — run `npm run build` before verify-heat-panel.js");
  process.exit(1);
}

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

  closest() { return null; }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) {
      handler({
        key: "",
        button: 0,
        clientX: 0,
        clientY: 0,
        pointerId: 1,
        currentTarget: this,
        preventDefault() {},
        stopPropagation() {},
        ...event
      });
    }
  }

  click() { this.dispatch("click"); }

  appendChild(child) {
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  insertAdjacentHTML(position, html) { this.innerHTML += String(html); }

  prepend(child) {
    this.children.unshift(child);
    child.parentNode = this;
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
  }

  focus() {}
  setPointerCapture() {}

  querySelectorAll(selector) {
    const selectors = String(selector).split(",").map((item) => item.trim()).filter(Boolean);
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
    return { left: 0, top: 0, width: this.width || 960, height: this.height || 640 };
  }

  getContext() {
    if (!this._ctx) {
      // All-permissive 2D context stub: any method call succeeds and returns a
      // loose object that itself accepts any method call (gradients etc).
      const loose = () => new Proxy(function () {}, {
        get(target, prop) {
          if (prop === Symbol.toPrimitive) return () => 0;
          return loose();
        },
        apply() { return loose(); },
        set() { return true; }
      });
      this._ctx = new Proxy({}, {
        get(target, prop) {
          if (!(prop in target)) target[prop] = () => loose();
          return target[prop];
        },
        set(target, prop, value) {
          target[prop] = value;
          return true;
        }
      });
    }
    return this._ctx;
  }

  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get offsetHeight() { return 1; }
}

const elements = new Map();
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
  querySelector() { return null; }
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
  send() {}
  close() { this.readyState = FakeWebSocket.CLOSED; }
}

// The bundle boots the arena renderer at load, which dynamic-imports pixi.js.
// The vm harness has no module loader, so that rejection is expected and not
// part of what this file verifies — swallow exactly that error, fail on others.
process.on("unhandledRejection", (err) => {
  if (err && err.code === "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") return;
  throw err;
});

const warnings = [];
const context = {
  console: {
    ...console,
    error(...args) {
      if (String(args[0]).includes("PixiJS/WebGL initialization failed")) return;
      console.error(...args);
    },
    warn(...args) { warnings.push(args.map(String).join(" ")); }
  },
  document,
  window: { addEventListener() {} },
  localStorage: {
    getItem(key) { return localStore.has(key) ? localStore.get(key) : null; },
    setItem(key, value) { localStore.set(key, String(value)); }
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
  setTimeout() { return 0; },
  clearTimeout() {}
};

vm.createContext(context);
for (const file of [
  "public/src/shared/heatRules.js",
  "public/src/shared/engineExhaust.js",
  "public/src/shared/turretRules.js",
  "public/client.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

// --- Pure display helper coverage -------------------------------------------

const helperChecks = vm.runInContext(`
  ({
    fractional: formatHeatPercent(shipHeatPercent({ heatNow: 3.5, heatMax: 1100 })),
    trueZero: formatHeatPercent(shipHeatPercent({ heatNow: 0, heatMax: 1100 })),
    noCapacity: shipHeatPercent({ heatNow: 12, heatMax: 0 }),
    capped: shipHeatPercent({ heatNow: 5000, heatMax: 100 }),
    fmtZero: formatHeatPercent(0),
    fmtTiny: formatHeatPercent(0.04),
    fmtSubOne: formatHeatPercent(0.32),
    fmtSmall: formatHeatPercent(3.46),
    fmtLarge: formatHeatPercent(42.1),
    fmtWhole: formatHeatPercent(5.0)
  })
`, context);
assert.strictEqual(helperChecks.fractional, "0.3%", "3.5 / 1100 H must display as 0.3%, not 0%");
assert.strictEqual(helperChecks.trueZero, "0%", "exact zero heat must display 0%");
assert.strictEqual(helperChecks.noCapacity, 0, "missing capacity must derive 0%");
assert.strictEqual(helperChecks.capped, 125, "derived percent must cap at 125");
assert.strictEqual(helperChecks.fmtZero, "0%");
assert.strictEqual(helperChecks.fmtTiny, "<0.1%", "non-zero heat below 0.1% must not display 0%");
assert.strictEqual(helperChecks.fmtSubOne, "0.3%");
assert.strictEqual(helperChecks.fmtSmall, "3.5%");
assert.strictEqual(helperChecks.fmtLarge, "42%");
assert.strictEqual(helperChecks.fmtWhole, "5%", "x.0 percentages should drop the trailing .0");

// --- Panel snapshot/selection coverage ---------------------------------------

vm.runInContext(`
  function makePanelShip(overrides = {}) {
    return Object.assign({
      id: "s1",
      ownerId: "p1",
      alive: true,
      design: [
        { x: 7, y: 7, type: "frame" },
        { x: 8, y: 7, type: "frame" },
        { x: 9, y: 7, type: "engine" }
      ],
      chp: [40, 40, 48],
      componentHeat: [[1, 0, 0.012, 85], [1, 0, 0.012, 85], [21, 0, 0.247, 85]],
      heat: 0.3,
      heatNow: 3.5,
      heatMax: 1100,
      hot: 0,
      overheated: 0
    }, overrides);
  }
  function installPanelSnapshot(ships, selectedId) {
    state.phase = "active";
    state.shipStatusView = "heat";
    state.selectedShipIds = new Set([selectedId]);
    state.snapshot = { ships, players: [{ id: "p1", color: "#8fd8ff" }] };
  }
  dom.shipDamageCanvas.width = 360;
  dom.shipDamageCanvas.height = 360;
  PART_STATS.reactor.footprint = { width: 2, height: 1 };
  PART_STATS.reactor.rotatable = true;
`, context);

// Heat/status legends are wider than narrow mobile side panels; they must wrap
// instead of overflowing and being clipped beside the diagram.
const stylesCss = fs.readFileSync("public/styles.css", "utf8");
const damageLegendRule = stylesCss.match(/\.damage-legend\s*\{([\s\S]*?)\}/)?.[1] || "";
const damageLegendItemRule = stylesCss.match(/\.damage-legend span\s*\{([\s\S]*?)\}/)?.[1] || "";
assert(/flex-wrap\s*:\s*wrap/.test(damageLegendRule), "status legends must wrap on narrow panels instead of clipping");
assert(/max-width\s*:\s*100%/.test(damageLegendRule), "status legends must stay within the side panel width");
assert(/white-space\s*:\s*nowrap/.test(damageLegendItemRule), "individual legend labels should stay intact while the legend wraps between items");

// Damage diagram geometry: multi-cell reactor artwork must contribute its full
// rotated footprint to bounds, scaling, overlays, hit testing, and padding.
const diagramGeometryChecks = vm.runInContext(`
  function makeReactorEdgeShip(rotation, anchorX, anchorY = 7) {
    return makePanelShip({
      id: "reactor-edge-" + rotation,
      design: [
        { x: 7, y: 7, type: "core" },
        { x: 8, y: 7, type: "frame" },
        { x: anchorX, y: anchorY, type: "reactor", rotation }
      ],
      chp: [100, 40, 62],
      componentHeat: [[0,0,0,85],[0,0,0,85],[20,0,0.2,100]],
      heatNow: 20,
      heatMax: 100
    });
  }
  function boundsPadding(geometry, width = 360, height = 360) {
    const left = geometry.originX + geometry.bounds.minX * geometry.cellSize;
    const right = width - (geometry.originX + geometry.bounds.maxX * geometry.cellSize);
    const top = geometry.originY + geometry.bounds.minY * geometry.cellSize;
    const bottom = height - (geometry.originY + geometry.bounds.maxY * geometry.cellSize);
    return { left, right, top, bottom };
  }
  function reactorCells(geometry) {
    return [...geometry.cellMap.entries()].filter(([, index]) => index === 2).map(([key]) => key).sort((a, b) => {
      const [ax, ay] = a.split(",").map(Number);
      const [bx, by] = b.split(",").map(Number);
      return ax - bx || ay - by;
    });
  }
  function checkShip(ship) {
    installPanelSnapshot([ship], ship.id);
    renderShipDamagePanel();
    const geometry = diagramInteraction;
    const pads = boundsPadding(geometry);
    return {
      cells: reactorCells(geometry),
      pads,
      equalHorizontal: Math.abs(pads.left - pads.right),
      equalVertical: Math.abs(pads.top - pads.bottom),
      minPad: Math.min(pads.left, pads.right, pads.top, pads.bottom),
      width: geometry.bounds.maxX - geometry.bounds.minX,
      height: geometry.bounds.maxY - geometry.bounds.minY
    };
  }
  ({
    right: checkShip(makeReactorEdgeShip(0, 9)),
    mirrored: checkShip(makeReactorEdgeShip(180, 10)),
    up: checkShip(makeReactorEdgeShip(90, 9)),
    down: checkShip(makeReactorEdgeShip(270, 9))
  })
`, context);
assert.strictEqual(JSON.stringify(diagramGeometryChecks.right.cells), JSON.stringify(["9,7", "10,7"]),
  "rotation 0 reactor must contribute both horizontal cells at the right edge");
assert.strictEqual(JSON.stringify(diagramGeometryChecks.mirrored.cells), JSON.stringify(["9,7", "10,7"]),
  "rotation 180 reactor must contribute the cell left of its anchor and its anchor cell");
assert.strictEqual(JSON.stringify(diagramGeometryChecks.up.cells), JSON.stringify(["9,7", "9,8"]),
  "rotation 90 reactor must contribute both vertical cells");
assert.strictEqual(JSON.stringify(diagramGeometryChecks.down.cells), JSON.stringify(["9,6", "9,7"]),
  "rotation 270 reactor must include the cell above its anchor");
for (const [name, result] of Object.entries(diagramGeometryChecks)) {
  assert(result.minPad >= 18, `${name} reactor artwork must remain inside canvas with intended padding, got ${JSON.stringify(result.pads)}`);
  assert(result.equalHorizontal < 1e-9, `${name} reactor diagram must be horizontally centred with equal padding, got ${JSON.stringify(result.pads)}`);
  assert(result.equalVertical < 1e-9, `${name} reactor diagram must be vertically centred with equal padding, got ${JSON.stringify(result.pads)}`);
}

// Fractional overall heat in the summary (3.5 / 1100 H -> 0.3%, not 0%).
const summaryChecks = vm.runInContext(`
  installPanelSnapshot([makePanelShip()], "s1");
  renderShipDamagePanel();
  const overallLine = dom.shipHeatSummary.innerHTML;
  installPanelSnapshot([makePanelShip({ componentHeat: [[0,0,0,85],[0,0,0,85],[0,0,0,85]], heatNow: 0, heat: 0 })], "s1");
  renderShipDamagePanel();
  ({ overallLine, zeroLine: dom.shipHeatSummary.innerHTML })
`, context);
assert(summaryChecks.overallLine.includes("Overall heat"), "summary must be renamed to Overall heat");
assert(!summaryChecks.overallLine.includes("Ship heat"), "old Ship heat label must be gone");
assert(summaryChecks.overallLine.includes(">0.3%<"), `summary must show 0.3% for 3.5/1100 H, got: ${summaryChecks.overallLine}`);
assert(!/>0%</.test(summaryChecks.overallLine), "summary must not show 0% next to non-zero stored heat");
assert(summaryChecks.overallLine.includes("3.5 / 1100 H"), "summary must keep the Stored amount");
assert(summaryChecks.zeroLine.includes(">0%<"), "true zero must still display 0%");

// Heat HUD label/bar derive from stored values too.
const hudChecks = vm.runInContext(`
  installPanelSnapshot([makePanelShip({ ownerId: state.myId })], "s1");
  state.snapshot.points = [];
  state.mine = null;
  const ship = state.snapshot.ships[0];
  ship.ownerId = state.myId = "me";
  state.snapshot.players.push({ id: "me", color: "#fff" });
  updateHud();
  ({ label: dom.heatHudLabel.textContent, width: dom.heatHudFill.style.width })
`, context);
assert(hudChecks.label.includes("0.3%"), `heat HUD must show the derived fractional percent, got: ${hudChecks.label}`);
assert(!hudChecks.label.includes(" 0%"), "heat HUD must not flatten non-zero heat to 0%");
assert(Number.parseFloat(hudChecks.width) > 0 && Number.parseFloat(hudChecks.width) < 1,
  `heat bar width must use the real fractional percent, got: ${hudChecks.width}`);

// Component refresh: select component 2 (21 / 85 H), then replace the ship
// snapshot object (same id) with component 2 at 2 / 85 H and rerender without
// any pointer movement. The readout must follow the latest snapshot.
const refreshChecks = vm.runInContext(`
  installPanelSnapshot([makePanelShip()], "s1");
  renderShipDamagePanel();
  // Tap component 2 through the pointer pipeline (touch pointerType).
  const canvas = dom.shipDamageCanvas;
  const geometry = diagramInteraction;
  let cellKey = null;
  for (const [key, idx] of geometry.cellMap) if (idx === 2) { cellKey = key; break; }
  const [gx, gy] = cellKey.split(",").map(Number);
  const rect = canvas.getBoundingClientRect();
  const px = geometry.originX + (gx - 7) * geometry.cellSize;
  const py = geometry.originY + (gy - 7) * geometry.cellSize;
  const clientX = rect.left + px * (rect.width / canvas.width);
  const clientY = rect.top + py * (rect.height / canvas.height);
  canvas.dispatch("pointerdown", { clientX, clientY, pointerType: "touch" });
  const afterTap = dom.shipDamageHover.textContent;
  const selectedAfterTap = diagramInteraction.componentIndex;
  // Replacement snapshot: new ship object, same id, component 2 now 2 H.
  installPanelSnapshot([makePanelShip({ componentHeat: [[1,0,0.012,85],[1,0,0.012,85],[2,0,0.024,85]], heatNow: 4 })], "s1");
  renderShipDamagePanel();
  ({ afterTap, selectedAfterTap, afterReplace: dom.shipDamageHover.textContent, keptIndex: diagramInteraction.componentIndex, keptShip: diagramInteraction.shipId })
`, context);
assert.strictEqual(refreshChecks.selectedAfterTap, 2, "tap must persistently select component 2");
assert(refreshChecks.afterTap.includes("Engine") && refreshChecks.afterTap.includes("21 / 85 H"),
  `tap readout must show the tapped component's heat, got: ${refreshChecks.afterTap}`);
assert(refreshChecks.afterReplace.includes("2 / 85 H"),
  `readout must refresh to the latest snapshot value, got: ${refreshChecks.afterReplace}`);
assert(!refreshChecks.afterReplace.includes("21 / 85"),
  `stale component heat must not remain visible, got: ${refreshChecks.afterReplace}`);
assert.strictEqual(refreshChecks.keptIndex, 2, "component selection must survive replacement ship objects (same id)");
assert.strictEqual(refreshChecks.keptShip, "s1");

// Different selected ship: old component selection and readout must clear.
const switchChecks = vm.runInContext(`
  installPanelSnapshot([
    makePanelShip({ componentHeat: [[1,0,0.012,85],[1,0,0.012,85],[2,0,0.024,85]], heatNow: 4 }),
    makePanelShip({ id: "s2", componentHeat: [[0,0,0,85],[0,0,0,85],[0,0,0,85]], heatNow: 0, heat: 0 })
  ], "s2");
  renderShipDamagePanel();
  ({ text: dom.shipDamageHover.textContent, shipId: diagramInteraction.shipId, index: diagramInteraction.componentIndex })
`, context);
assert.strictEqual(switchChecks.shipId, "s2", "interaction context must re-key to the newly selected ship");
assert.strictEqual(switchChecks.index, undefined, "component selection must not carry across ships");
assert.strictEqual(switchChecks.text, "Tap or hover a component",
  `readout must reset when the selected ship changes, got: ${switchChecks.text}`);

// Invalid component index (shorter replacement design) clears instead of lingering.
const invalidChecks = vm.runInContext(`
  installPanelSnapshot([makePanelShip()], "s1");
  renderShipDamagePanel();
  diagramInteraction.componentIndex = 2;
  installPanelSnapshot([makePanelShip({ design: [{ x: 7, y: 7, type: "frame" }], chp: [40], componentHeat: [[1,0,0.012,85]] })], "s1");
  renderShipDamagePanel();
  ({ text: dom.shipDamageHover.textContent, index: diagramInteraction.componentIndex })
`, context);
assert.strictEqual(invalidChecks.index, undefined, "invalid component index must be dropped");
assert.strictEqual(invalidChecks.text, "Tap or hover a component", "invalid selection must reset the readout");

// Switching Heat -> Damage resets the readout to the damage wording.
const viewChecks = vm.runInContext(`
  installPanelSnapshot([makePanelShip()], "s1");
  renderShipDamagePanel();
  diagramInteraction.componentIndex = 2;
  renderShipDamagePanel();
  const heatText = dom.shipDamageHover.textContent;
  dom.shipDamageTab.click();
  ({ heatText, damageText: dom.shipDamageHover.textContent, view: state.shipStatusView })
`, context);
assert(viewChecks.heatText.includes("21 / 85 H"));
assert.strictEqual(viewChecks.view, "damage");
assert.strictEqual(viewChecks.damageText, "Hover a component",
  `heat readout must not linger on the Damage view, got: ${viewChecks.damageText}`);
vm.runInContext(`state.shipStatusView = "heat";`, context);

// --- Summary/component consistency diagnostic --------------------------------

const consistencyChecks = vm.runInContext(`
  ({
    consistent: checkShipHeatConsistency({ id: "ok", heatNow: 24.2, componentHeat: [[8,0,0,85],[8,0,0,85],[8,0,0,85]] }, false),
    mismatch: checkShipHeatConsistency({ id: "bad", heatNow: 3.5, componentHeat: [[1,0,0,85],[1,0,0,85],[21,0,0,85]] }, true)
  })
`, context);
assert.strictEqual(consistencyChecks.consistent.ok, true,
  "component totals within rounding tolerance must pass the consistency check");
assert.strictEqual(consistencyChecks.mismatch.ok, false,
  "impossible summary/component mismatch must be reported");
assert(consistencyChecks.mismatch.tolerance >= 1 && consistencyChecks.mismatch.tolerance <= 3 * 0.55 + 1e-9,
  "tolerance must scale with component count");
assert(warnings.some((entry) => entry.includes("bad") && entry.includes("3.5") && entry.includes("23")),
  `mismatch must log a development warning with ship id and both totals, got: ${JSON.stringify(warnings)}`);

console.log("Heat panel verification passed");
