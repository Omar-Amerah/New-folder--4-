"use strict";

const fs = require("fs");
const vm = require("vm");

class FakeElement {
  constructor(id = "") {
    this.id = id;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.className = "";
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
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
  "joinButton",
  "copyButton",
  "botButton",
  "deployButton",
  "resetButton",
  "formationSelect",
  "partPalette",
  "partInspector",
  "buildGrid",
  "buildStatus",
  "statsGrid",
  "budgetText",
  "roomLabel",
  "fleetLabel",
  "moneyHudLabel",
  "relayLabel",
  "selectionLabel",
  "objectiveLabel",
  "moneyLabel",
  "incomeLabel",
  "unitCostLabel",
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
  "winnerBanner"
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

console.log("client ui verification passed");
