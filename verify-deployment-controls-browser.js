"use strict";

const assert = require("assert");
const msgpack = require("@msgpack/msgpack");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, waitForBrowserReady, uniquePort, uniqueRoom } = require("./verify-pixi-browser-support.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class Client {
  constructor(port) { this.port = port; this.latest = {}; }
  async connect() {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/socket`);
      this.ws.binaryType = "arraybuffer";
      this.ws.addEventListener("open", resolve);
      this.ws.addEventListener("error", reject);
      this.ws.addEventListener("message", (event) => {
        const message = event.data instanceof ArrayBuffer
          ? msgpack.decode(new Uint8Array(event.data))
          : JSON.parse(event.data);
        this.latest[message.type] = message;
      });
    });
  }
  send(message) { this.ws.send(msgpack.encode(message)); }
  close() { try { this.ws.close(); } catch {} }
}

const port = uniquePort();
const base = `http://127.0.0.1:${port}`;
const room = uniqueRoom("ready");
const { server } = startServer(port);
let browser;
let peer;

(async () => {
  try {
    await waitForServer(base);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${base}/index.html?room=${room}`, { waitUntil: "load" });
    await waitForBrowserReady(page, room, {}, 20_000);

    peer = new Client(port);
    await peer.connect();
    await until(() => peer.latest.hello, 5000, "peer hello");
    peer.send({ type: "join", room, name: "Peer", team: "red", protocolVersion: 5, minProtocolVersion: 5, maxProtocolVersion: 5, capabilities: ["messagepack"] });
    await until(() => peer.latest.joined, 5000, "peer join");

    await page.click("#startDesignButton");
    await page.waitForFunction(() => window.__mfaState.phase === "design", null, { timeout: 10000 });
    const designPresentation = await page.evaluate(() => {
      const button = document.getElementById("deployButton");
      return { hidden: button.hidden, disabled: button.disabled, reloads: performance.getEntriesByType("navigation").length };
    });
    assert.deepStrictEqual(designPresentation, { hidden: false, disabled: false, reloads: 1 }, "Ready appears without refresh after Start Design");

    const pending = await page.evaluate(() => {
      document.getElementById("deployButton").click();
      return {
        pending: window.__mfaState.pendingDeploy,
        loading: document.getElementById("deployButton").classList.contains("is-loading")
      };
    });
    assert(pending.pending && pending.loading, "Ready click immediately enters loading state");
    await page.waitForFunction(() => window.__mfaState.mine?.ready === true && !window.__mfaState.pendingDeploy, null, { timeout: 10000 });
    const confirmed = await page.evaluate(() => {
      const button = document.getElementById("deployButton");
      return { hidden: button.hidden, disabled: button.disabled, text: button.textContent };
    });
    assert.strictEqual(confirmed.hidden, false);
    assert.strictEqual(confirmed.disabled, true);
    assert(/Waiting/i.test(confirmed.text), "confirmed player sees waiting state");

    peer.send({
      type: "deploy",
      design: peer.latest.hello.defaultDesign,
      wiring: peer.latest.hello.defaultWiring,
      combatStyle: "hold"
    });
    await page.waitForFunction(() => window.__mfaState.phase === "active", null, { timeout: 10000 });
    assert.strictEqual(await page.locator("#deployButton").isHidden(), true, "Ready hides immediately when active");
    assert.strictEqual(pageErrors.length, 0, `browser page errors: ${pageErrors.join("\n")}`);
    console.log("Deployment controls browser verification passed: no refresh required.");
  } finally {
    peer?.close();
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
})().catch((error) => {
  console.error(error);
  server.kill();
  process.exit(1);
});
