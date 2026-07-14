"use strict";

// Client-side turret diagnostics coverage: the missing-authoritative-angle
// warning (deduplicated per ship/design index, with build identification), the
// blueprint fallback that keeps production rendering, the frontend/backend
// protocol compatibility check, and the read-only live turret diagnostics
// handle. Runs against the bundled public/client.js (run `npm run build` first).

const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

if (!fs.existsSync("public/client.js")) {
  console.error("public/client.js is missing — run `npm run build` before verify-turret-client.js");
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
      set: (value) => { this._textContent = String(value); if (value === "") this.children = []; }
    });
    Object.defineProperty(this, "innerHTML", {
      get: () => this._innerHTML,
      set: (value) => { this._innerHTML = String(value); if (value === "") this.children = []; }
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

  setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); }
  getAttribute(name) { return this.attributes && name in this.attributes ? this.attributes[name] : null; }
  removeAttribute(name) { if (this.attributes) delete this.attributes[name]; }
  closest() { return null; }
  click() {}
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  replaceChildren(...children) { this.children = []; for (const child of children) this.appendChild(child); }
  insertAdjacentHTML(position, html) { this.innerHTML += String(html); }
  prepend(child) { this.children.unshift(child); child.parentNode = this; return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); }
  focus() {}
  setPointerCapture() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 640 }; }
  getContext() {
    if (!this._ctx) {
      const loose = () => new Proxy(function () {}, {
        get(target, prop) { return prop === Symbol.toPrimitive ? () => 0 : loose(); },
        apply() { return loose(); },
        set() { return true; }
      });
      this._ctx = new Proxy({}, {
        get(target, prop) { if (!(prop in target)) target[prop] = () => loose(); return target[prop]; },
        set(target, prop, value) { target[prop] = value; return true; }
      });
    }
    return this._ctx;
  }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get offsetHeight() { return 1; }
}

const elements = new Map();
const localStore = new Map();
const documentStub = {
  activeElement: null,
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  },
  createElement(tagName) { const el = new FakeElement(tagName); el.tagName = tagName.toUpperCase(); return el; },
  createElementNS(ns, tagName) { const el = new FakeElement(tagName); el.namespaceURI = ns; el.tagName = tagName.toUpperCase(); return el; },
  createTextNode(text) { const el = new FakeElement("#text"); el.textContent = text; return el; },
  querySelector() { return null; }
};

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = FakeWebSocket.CONNECTING; this.listeners = new Map(); }
  addEventListener(type, handler) { const h = this.listeners.get(type) || []; h.push(handler); this.listeners.set(type, h); }
  send() {}
  close() { this.readyState = FakeWebSocket.CLOSED; }
}

// The bundle boots the arena renderer at load, which dynamic-imports pixi.js.
// The vm harness has no module loader, so that rejection is expected here.
process.on("unhandledRejection", (err) => {
  if (err && err.code === "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") return;
  throw err;
});

const warnings = [];
const errors = [];
const context = {
  console: {
    ...console,
    warn(...args) { warnings.push(args.map(String).join(" ")); },
    error(...args) {
      const text = args.map(String).join(" ");
      if (text.includes("PixiJS/WebGL initialization failed")) return;
      errors.push(text);
    }
  },
  document: documentStub,
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
  "public/src/shared/protocolVersion.js",
  "public/src/shared/heatRules.js",
  "public/src/shared/engineExhaust.js",
  "public/src/shared/turretRules.js",
  "public/client.js"
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

// Load the real component balance so PART_STATS knows weapon categories
// (isRotatingWeaponPart needs them, same as the live client after boot).
context.applyComponentBalance(JSON.parse(fs.readFileSync("component-balance.json", "utf8")));

// --- Missing authoritative angle warning (deduplicated) ----------------------

const angleChecks = vm.runInContext(`
  (() => {
    resetMissingWeaponAngleWarnings();
    globalThis.__mfaServerBuild = { protocolVersion: 2, buildSha: "backend-sha-123" };
    const ship = {
      id: "ship-x",
      design: [
        { x: 7, y: 7, type: "core", rotation: 0 },
        { x: 8, y: 7, type: "blaster", rotation: 90 },
        { x: 6, y: 7, type: "frame", rotation: 0 }
      ],
      weaponAngles: []
    };
    const first = authoritativeWeaponAngle(ship, 1);
    const second = authoritativeWeaponAngle(ship, 1); // same slot: no second warning
    const frameFallback = authoritativeWeaponAngle(ship, 2); // not a rotating weapon: silent
    const present = authoritativeWeaponAngle({ id: "ship-y", weaponAngles: [0, 1.25] }, 1,
      { type: "blaster", rotation: 0 });
    return { first, second, frameFallback, present };
  })()
`, context);
assert(Math.abs(angleChecks.first - Math.PI / 2) < 1e-9, "missing angle must fall back to the blueprint facing");
assert.strictEqual(angleChecks.first, angleChecks.second, "fallback must be stable");
assert.strictEqual(angleChecks.frameFallback, 0, "non-weapon parts fall back silently");
assert.strictEqual(angleChecks.present, 1.25, "a finite authoritative angle must be returned untouched");

const missingWarnings = warnings.filter((entry) => entry.includes("Missing authoritative weapon angle"));
assert.strictEqual(missingWarnings.length, 1,
  `missing-angle warning must fire exactly once per ship/design index, got ${missingWarnings.length}`);
for (const field of ["shipId=ship-x", "designIndex=1", "partType=blaster", "weaponAnglesLength=0",
  "frontendBuild=", "backendBuild=backend-sha-123", "backendProtocol=2"]) {
  assert(missingWarnings[0].includes(field), `missing-angle warning must include ${field}: ${missingWarnings[0]}`);
}

// A different design index on the same ship warns separately (dedupe is per slot).
vm.runInContext(`
  authoritativeWeaponAngle({ id: "ship-x", design: [{ type: "blaster", rotation: 0 }], weaponAngles: [] }, 0);
`, context);
assert.strictEqual(warnings.filter((entry) => entry.includes("Missing authoritative weapon angle")).length, 2,
  "a different design index must produce its own warning");

// --- Frontend/backend protocol compatibility ----------------------------------

const protocolChecks = vm.runInContext(`
  (() => {
    const stale = checkServerProtocol({ protocolVersion: null, buildSha: "old-backend" });
    const staleAgain = checkServerProtocol({ protocolVersion: null, buildSha: "old-backend" });
    const ok = checkServerProtocol({ protocolVersion: 2, buildSha: "fresh-backend" });
    const tooNew = checkServerProtocol({ protocolVersion: 99, buildSha: "future-backend" });
    return { stale, staleAgain, ok, tooNew, frontendBuild: globalThis.__mfaFrontendBuild };
  })()
`, context);
assert.strictEqual(protocolChecks.stale, "stale", "a backend without protocolVersion must be reported stale");
assert.strictEqual(protocolChecks.staleAgain, "stale");
assert.strictEqual(protocolChecks.ok, "ok", "the current protocol must be accepted");
assert.strictEqual(protocolChecks.tooNew, "incompatible", "a newer-than-supported protocol must be rejected");
assert(protocolChecks.frontendBuild, "the frontend build identifier must be exposed");

const staleWarnings = warnings.filter((entry) => entry.includes("Stale WebSocket backend"));
assert.strictEqual(staleWarnings.length, 1, "the stale-backend warning must be deduplicated");
assert(staleWarnings[0].includes("redeploying"), "the stale warning must explain the backend needs redeploying");
assert(staleWarnings[0].includes("Turret verification cannot be claimed"),
  "the stale warning must not let turret verification be claimed");
assert(staleWarnings[0].includes("frontend=") && staleWarnings[0].includes("backend=old-backend"),
  "the stale warning must identify both builds");
assert.strictEqual(errors.filter((entry) => entry.includes("Incompatible WebSocket protocol")).length, 1,
  "the incompatible-protocol rejection must be reported once");

// A hello message records the backend identity on state and the debug handle.
const helloChecks = vm.runInContext(`
  (() => {
    handleServerMessage({ type: "hello", id: "p9", protocolVersion: 2, serverBuildSha: "hello-sha", parts: {}, world: { width: 3200, height: 1900 } });
    return { server: state.server, handle: globalThis.__mfaServerBuild };
  })()
`, context);
assert.strictEqual(helloChecks.server.protocolVersion, 2);
assert.strictEqual(helloChecks.server.buildSha, "hello-sha");
assert.strictEqual(helloChecks.server.compatibility, "ok");
assert.strictEqual(helloChecks.handle.buildSha, "hello-sha");

// --- Read-only live turret diagnostics handle ---------------------------------

const diagnosticsChecks = vm.runInContext(`
  (() => {
    const exists = typeof window.__mfaLiveTurretDiagnostics === "function";
    const missing = window.__mfaLiveTurretDiagnostics("no-such-ship");
    state.snapshot = {
      ships: [{
        id: "diag-ship",
        ownerId: "p9",
        angle: 0.4,
        combatTargetId: "enemy-1",
        design: [
          { x: 7, y: 7, type: "core", rotation: 0 },
          { x: 8, y: 7, type: "blaster", rotation: 0 }
        ],
        weaponAngles: [0, 0.9]
      }],
      players: []
    };
    const before = JSON.stringify(state.snapshot);
    const rows = window.__mfaLiveTurretDiagnostics("diag-ship");
    const unchanged = JSON.stringify(state.snapshot) === before;
    return { exists, missing, rows, unchanged };
  })()
`, context);
assert.strictEqual(diagnosticsChecks.exists, true, "window.__mfaLiveTurretDiagnostics must exist");
assert.strictEqual(diagnosticsChecks.missing, null, "unknown ships must return null");
assert.strictEqual(diagnosticsChecks.rows.length, 1, "one row per rotating weapon");
const row = diagnosticsChecks.rows[0];
assert.strictEqual(row.designIndex, 1);
assert.strictEqual(row.partType, "blaster");
assert.strictEqual(row.receivedAuthoritativeAngle, 0.9);
assert.strictEqual(row.anglePresent, true);
assert.strictEqual(row.targetId, "enemy-1");
assert.strictEqual(row.hullAngle, 0.4, "without a bound view the snapshot hull angle is reported");
assert.strictEqual(diagnosticsChecks.unchanged, true, "the diagnostics handle must not mutate state");

// --- Live hello-path traverse-rate regression ---------------------------------
// The root cause of the frozen live turrets: server PARTS arrive over
// MessagePack, which encodes an absent weapon.aimSpeed as null; the client's
// makeWeapon then produced Number(null) === 0, and turnRateFor treated the
// finite 0 as an authoritative traverse rate — freezing every connected
// client's turret sprites. Simulate exactly that path.
const helloPartsChecks = vm.runInContext(`
  (() => {
    applyServerParts({
      blaster: {
        category: "Weapons",
        cost: 31, mass: 5, hp: 46,
        rotatable: true,
        weapon: {
          type: "blaster", damage: 18, fireRate: 1.6, range: 560,
          projectileSpeed: 760, accuracy: 0.9, tracking: 0,
          aimSpeed: null, // what MessagePack delivers for "undefined"
          arc: 125, shieldDamageMultiplier: 1.05, hullDamageMultiplier: 1
        }
      }
    });
    const weapon = PART_STATS.blaster.weapon;
    return {
      aimSpeed: weapon.aimSpeed,
      turnRate: getWeaponTurnRate(weapon),
      familyRate: globalThis.TurretRules.TURN_RATES.blaster
    };
  })()
`, context);
assert.strictEqual(helloPartsChecks.aimSpeed, undefined,
  "a null aimSpeed from the live hello message must normalize to undefined, not 0");
assert(helloPartsChecks.turnRate > 0, "live-normalized weapons must keep a positive traverse rate");
assert.strictEqual(helloPartsChecks.turnRate, helloPartsChecks.familyRate,
  "live-normalized weapons must traverse at the shared family rate");

console.log("Turret client verification passed");
