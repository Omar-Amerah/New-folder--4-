"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const msgpack = require("@msgpack/msgpack");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort, uniqueRoom, writeJsonArtifact } = require("./verify-pixi-browser-support.js");

const PORT = Number(process.env.TEST_PORT || uniquePort());
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = process.env.TEST_ROOM || uniqueRoom("heat-browser");
const ARTIFACT_DIR = process.env.TEST_ARTIFACT_DIR || path.join(process.env.SHOT_DIR || path.join(os.tmpdir(), "mfa-browser-artifacts"), "heat-browser");
const DESIGN = [
  { x: 7, y: 7, type: "core", rotation: 0 },
  { x: 7, y: 8, type: "frame", rotation: 0 },
  { x: 6, y: 8, type: "engine", rotation: 0 },
  { x: 8, y: 8, type: "engine", rotation: 0 },
  { x: 6, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 8, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 6, y: 6, type: "reactor", rotation: 0 },
  { x: 7, y: 5, type: "blaster", rotation: 0 },
  { x: 8, y: 6, type: "heatSink", rotation: 0 },
  { x: 9, y: 6, type: "radiator", rotation: 0 }
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor() { this.latest = {}; this.snapshots = []; this.events = []; }
  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", (e) => { this.events.push({ type: "error", at: Date.now(), message: String(e.message || e.type || e) }); reject(new Error("bot websocket error")); });
      ws.addEventListener("close", (e) => this.events.push({ type: "close", at: Date.now(), code: e.code, reason: e.reason }));
      ws.addEventListener("message", (event) => {
        let message;
        try { message = event.data instanceof ArrayBuffer ? msgpack.decode(new Uint8Array(event.data)) : JSON.parse(event.data); }
        catch (err) { this.events.push({ type: "decode-error", at: Date.now(), message: err.message }); return; }
        this.latest[message.type] = message;
        if (message.type === "state") {
          this.snapshots.push({ at: Date.now(), state: message });
          if (this.snapshots.length > 120) this.snapshots.shift();
        }
      });
    });
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  close() { try { this.ws?.close(); } catch {} }
}

async function until(fn, what, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(100);
  }
}

(async () => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const { server, getLog } = startServer(PORT);
  let browser;
  let page;
  const bot = new Client();
  const diagnostics = { script: "verify-heat-browser.js", room: ROOM, port: PORT, base: BASE, pageErrors: [], console: [], failedRequests: [], websocket: [], phases: [], snapshots: [] };
  try {
    await waitForServer(BASE);
    browser = await launchChromium(chromium);
    page = await browser.newPage({ viewport: { width: 900, height: 700 }, hasTouch: true });
    page.on("pageerror", (e) => diagnostics.pageErrors.push({ at: Date.now(), message: e.message, stack: e.stack }));
    page.on("console", (m) => diagnostics.console.push({ at: Date.now(), type: m.type(), text: m.text() }));
    page.on("requestfailed", (r) => diagnostics.failedRequests.push({ at: Date.now(), url: r.url(), method: r.method(), failure: r.failure()?.errorText || "unknown" }));
    page.on("websocket", (ws) => {
      const entry = { at: Date.now(), url: ws.url(), errors: [], closed: false };
      diagnostics.websocket.push(entry);
      ws.on("socketerror", (err) => entry.errors.push({ at: Date.now(), message: err.message }));
      ws.on("close", () => { entry.closed = true; entry.closedAt = Date.now(); });
    });

    await page.goto(`${BASE}/index.html?room=${ROOM}`, { waitUntil: "load" });
    await page.waitForFunction((room) => window.__mfaState?.room === room && window.__mfaState?.myId, ROOM, { timeout: 20000 });
    const myId = await page.evaluate(() => window.__mfaState.myId);
    diagnostics.playerId = myId;

    await bot.open();
    bot.send({ type: "join", room: ROOM, name: "HeatBot", team: "red" });
    await until(() => bot.latest.joined, "bot join");
    diagnostics.botPlayerId = bot.latest.joined.id;
    await page.evaluate(() => window.__mfaNetSend({ type: "setRules", rules: { asteroidDensity: "none" } }));
    await page.evaluate(() => window.__mfaNetSend({ type: "startDesign" }));
    await until(() => bot.latest.state?.phase === "design", "design phase");
    diagnostics.phases.push({ phase: "design", at: Date.now() });
    await page.evaluate((design) => window.__mfaNetSend({ type: "deploy", design, combatStyle: "sentry" }), DESIGN);
    bot.send({ type: "deploy", design: DESIGN, combatStyle: "sentry" });
    await until(() => bot.latest.state?.phase === "active", "active phase");
    diagnostics.phases.push({ phase: "active", at: Date.now() });

    const ship = await until(() => bot.latest.state?.ships?.find((s) => s.ownerId === myId && s.alive && Array.isArray(s.design) && Array.isArray(s.componentHeat)), "authoritative heat snapshot with selected ship");
    diagnostics.shipIds = bot.latest.state.ships.map((s) => s.id);
    diagnostics.selectedShipId = ship.id;
    await page.evaluate((id) => { window.__mfaState.selectedShipIds = new Set([id]); window.__mfaState.selectedShipId = id; }, ship.id);
    await page.waitForFunction((id) => {
      const ship = window.__mfaState?.snapshot?.ships?.find((s) => s.id === id);
      return ship && Array.isArray(ship.design) && Array.isArray(ship.componentHeat);
    }, ship.id, { timeout: 15000 });

    await page.click("#shipHeatTab");
    await until(() => page.locator("#shipHeatSummary").textContent().then((t) => /Overall heat|Stored/.test(t || "")), "heat panel summary");
    await page.evaluate((id) => window.__mfaNetSend({ type: "command", shipIds: [id], x: 1800, y: 1300 }), ship.id);
    const heated = await until(() => bot.latest.state?.ships?.find((s) => s.id === ship.id && Number(s.heatNow) > 0 && Array.isArray(s.componentHeat)), "authoritative heat update", 20000);
    diagnostics.heat = { heatNow: heated.heatNow, heatMax: heated.heatMax, hot: heated.hot, overheated: heated.overheated, componentHeat: heated.componentHeat };
    await page.waitForFunction((id) => {
      const ship = window.__mfaState?.snapshot?.ships?.find((s) => s.id === id);
      return ship && Number(ship.heatNow) > 0 && !document.querySelector("#shipHeatSummary")?.hidden;
    }, ship.id, { timeout: 15000 });

    const summary = await page.locator("#shipHeatSummary").textContent();
    assert(/\d/.test(summary || ""), "whole-ship heat values render");
    const canvas = page.locator("#shipDamageCanvas");
    const box = await canvas.boundingBox();
    assert(box, "heat canvas visible");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await until(() => page.locator("#shipDamageHover").textContent().then((t) => /H|Cool|Warm|Hot/.test(t || "")), "component heat readout");
    assert.strictEqual(await page.evaluate(() => globalThis.__mfaLastMoveFromHeatPanel || false), false, "panel did not set movement sentinel");
    await page.touchscreen.tap(box.x + box.width / 2 + 12, box.y + box.height / 2);
    const frac = await page.evaluate(async () => { const m = await import("/src/shared/heatDisplay.js"); return m.formatHeatPercent(m.shipHeatPercent({ heatNow: 3.5, heatMax: 1100 })); });
    assert.strictEqual(frac, "0.3%", "fractional percentage displays");
    await page.evaluate(() => { window.__mfaState.selectedShipIds = new Set(); window.__mfaState.selectedShipId = null; });
    await page.waitForFunction(() => document.querySelector("#shipDamagePanel")?.hidden === true && /Hover|Tap|component/i.test(document.querySelector("#shipDamageHover")?.textContent || ""), null, { timeout: 5000 });
    assert.deepStrictEqual(diagnostics.pageErrors, [], `page errors: ${diagnostics.pageErrors.map((e) => e.message).join("\n")}`);
    const consoleErrors = diagnostics.console.filter((m) => m.type === "error");
    assert.deepStrictEqual(consoleErrors, [], `console errors: ${consoleErrors.map((e) => e.text).join("\n")}`);
    assert.deepStrictEqual(diagnostics.failedRequests, [], `failed requests: ${diagnostics.failedRequests.map((e) => `${e.method} ${e.url}: ${e.failure}`).join("\n")}`);
    console.log(`Real Heat panel browser verification passed (room=${ROOM}, port=${PORT}, player=${myId}, ship=${ship.id})`);
  } catch (err) {
    diagnostics.error = { message: err.message, stack: err.stack };
    diagnostics.serverLogTail = getLog().split("\n").slice(-80).join("\n");
    diagnostics.snapshots = bot.snapshots.slice(-5).map(({ at, state }) => ({ at, phase: state.phase, players: state.players?.map((p) => ({ id: p.id, team: p.team })), ships: state.ships?.map((s) => ({ id: s.id, ownerId: s.ownerId, alive: s.alive, x: s.x, y: s.y, heatNow: s.heatNow, heatMax: s.heatMax, targetId: s.targetId })) }));
    if (page) await page.screenshot({ path: path.join(ARTIFACT_DIR, "failure.png"), fullPage: true }).catch(() => {});
    writeJsonArtifact(path.join(ARTIFACT_DIR, "diagnostics.json"), diagnostics);
    fs.writeFileSync(path.join(ARTIFACT_DIR, "server.log"), getLog());
    console.error(err);
    console.error(`Diagnostics written to ${ARTIFACT_DIR}`);
    console.error(diagnostics.serverLogTail);
    process.exitCode = 1;
  } finally {
    bot.close();
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGKILL");
  }
})();
