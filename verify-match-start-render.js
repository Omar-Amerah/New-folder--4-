"use strict";
// Real desktop match-start regression: exercises lobby -> design -> active match
// over the real server/protocol with default map features enabled.

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const msgpack = require("@msgpack/msgpack");
const { chromium } = require("playwright");
const { launchChromium } = require("./verify-pixi-browser-support.js");

const PORT = Number(process.env.TEST_PORT || 5617);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.SHOT_DIR || path.join(require("os").tmpdir(), "mfa-match-start-render-shots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const required of ["public/vendor/pixi.min.js", "public/vendor/msgpack.min.js", "public/build-sha.js"]) {
  if (!fs.existsSync(required)) throw new Error(`${required} is missing; run npm run build first`);
}

function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE}/index.html`, (res) => { res.resume(); resolve(); });
      req.on("error", () => Date.now() - start > timeoutMs ? reject(new Error("server did not start")) : setTimeout(tick, 200));
    };
    tick();
  });
}
async function until(fn, timeoutMs, what) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms waiting for ${what}`);
    await sleep(150);
  }
}
class NetClient {
  constructor(name) { this.name = name; this.latest = {}; this.designs = new Map(); this.errors = []; this.closes = []; }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket`);
      ws.binaryType = "arraybuffer"; this.ws = ws;
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", (e) => { this.errors.push(String(e.message || e.type || "error")); reject(new Error(`${this.name} websocket error`)); });
      ws.addEventListener("close", (e) => this.closes.push({ code: e.code, reason: e.reason }));
      ws.addEventListener("message", (event) => {
        try {
          const msg = event.data instanceof ArrayBuffer ? msgpack.decode(new Uint8Array(event.data)) : JSON.parse(event.data);
          this.latest[msg.type] = msg;
          if (msg.type === "state") {
            for (const ship of msg.ships || []) {
              if (ship.design) this.designs.set(ship.id, ship.design);
              else ship.design = this.designs.get(ship.id);
            }
          }
        } catch (err) { this.errors.push(err.stack || err.message); }
      });
    });
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  state() { return this.latest.state || null; }
  close() { try { this.ws.close(); } catch {} }
}
const ENEMY_DESIGN = [
  { x: 7, y: 7, type: "core", rotation: 0 },
  { x: 7, y: 8, type: "frame", rotation: 0 },
  { x: 6, y: 8, type: "engine", rotation: 0 },
  { x: 8, y: 8, type: "engine", rotation: 0 },
  { x: 6, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 8, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 6, y: 6, type: "reactor", rotation: 0 },
  { x: 8, y: 6, type: "armor", rotation: 0 }
];
async function canvasStats(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById("arenaCanvas");
    const rect = canvas.getBoundingClientRect();
    const copy = document.createElement("canvas");
    copy.width = Math.max(1, Math.floor(rect.width)); copy.height = Math.max(1, Math.floor(rect.height));
    const ctx = copy.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, copy.width, copy.height);
    const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
    let lit = 0, total = 0;
    for (let i = 0; i < data.length; i += 16) { total++; if (data[i] + data[i + 1] + data[i + 2] > 18) lit++; }
    return { width: rect.width, height: rect.height, litRatio: lit / total };
  });
}
async function shot(page, name) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name), fullPage: true }); }
async function runDensity(browser, density) {
  const room = `MS${density === "high" ? "HIGH" : "MED"}${Math.floor(Math.random() * 1000)}`.slice(0, 8);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const enemy = new NetClient(`enemy-${density}`);
  const pageErrors = [], consoleLines = [], failedRequests = [], contextLost = [];
  page.on("console", (msg) => consoleLines.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => pageErrors.push(err.stack || err.message));
  page.on("requestfailed", (req) => failedRequests.push(`${req.url()} ${req.failure()?.errorText}`));
  await page.goto(`${BASE}/index.html?room=${room}`, { waitUntil: "load" });
  await page.evaluate(() => document.getElementById("arenaCanvas").addEventListener("webglcontextlost", (e) => { window.__matchStartContextLost = true; e.preventDefault(); }));
  await page.waitForFunction((r) => window.__mfaState?.room === r && window.__mfaState?.myId, room, { timeout: 20000 });
  await page.evaluate(() => { window.__matchStartContextLost = false; });
  const myId = await page.evaluate(() => window.__mfaState.myId);
  const frontendBuild = await page.evaluate(() => globalThis.__mfaFrontendBuild || null);
  const backendBuild = await page.evaluate(() => window.__mfaState.server?.buildSha || null);
  if (density !== "medium") {
    await page.evaluate((d) => window.__mfaNetSend({ type: "setRules", rules: { asteroidDensity: d } }), density);
    await until(() => page.evaluate((d) => window.__mfaState.rules?.asteroidDensity === d, density), 10000, `${density} rules`);
  }
  await enemy.connect(); await until(() => enemy.latest.hello, 10000, "enemy hello");
  enemy.send({ type: "join", room, name: `Enemy-${density}`, team: "red" });
  await until(() => enemy.latest.joined, 10000, "enemy joined");
  enemy.send({ type: "setTeam", team: "red" });
  await page.click("#startDesignButton");
  await until(() => page.evaluate(() => window.__mfaState.phase === "design"), 10000, "design phase");
  await shot(page, `${density}-before-match.png`);
  enemy.send({ type: "deploy", design: ENEMY_DESIGN, combatStyle: "sentry" });
  await page.click("#deployButton");
  await until(() => page.evaluate(() => window.__mfaState.phase === "active" && window.__mfaState.snapshot?.ships?.length >= 2), 15000, "active snapshot");
  await shot(page, `${density}-first-active.png`);
  await sleep(10000);
  await shot(page, `${density}-after-10s.png`);

  const ownShipId = await page.evaluate((id) => window.__mfaState.snapshot.ships.find((s) => s.ownerId === id && s.alive)?.id || null, myId);
  const beforeCamera = await page.evaluate(() => ({ ...window.__mfaState.camera }));
  await page.keyboard.press("KeyW"); await sleep(400);
  const afterKeyCamera = await page.evaluate(() => ({ ...window.__mfaState.camera }));
  const canvasBox = await page.locator("#arenaCanvas").boundingBox();
  const cx = canvasBox.x + canvasBox.width / 2, cy = canvasBox.y + canvasBox.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down({ button: "middle" }); await page.mouse.move(cx + 120, cy + 40); await page.mouse.up({ button: "middle" }); await sleep(100);
  const afterMiddle = await page.evaluate(() => ({ ...window.__mfaState.camera }));
  await page.keyboard.down("Space"); await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx - 120, cy - 40); await page.mouse.up(); await page.keyboard.up("Space"); await sleep(100);
  const afterSpaceDrag = await page.evaluate(() => ({ ...window.__mfaState.camera }));
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 70, cy + 70); await page.mouse.up(); await sleep(100);
  const afterLeftDrag = await page.evaluate(() => ({ ...window.__mfaState.camera }));

  const diagnostics = await page.evaluate((shipId) => ({
    renderer: window.__mfaRenderer?.diagnostics?.(),
    textures: window.__mfaPixiTextureDiagnostics?.(),
    shipView: window.__mfaTurretDebugInfo?.(shipId),
    contextLost: window.__matchStartContextLost === true,
    activeElement: document.activeElement?.tagName,
    phase: window.__mfaState.phase,
    builds: { frontend: globalThis.__mfaFrontendBuild, backend: window.__mfaState.server?.buildSha }
  }), ownShipId);
  const stats = await canvasStats(page);

  assert.strictEqual(pageErrors.length, 0, `page errors for ${density}:\n${pageErrors.join("\n")}`);
  assert.strictEqual(contextLost.length, 0, `context lost events for ${density}`);
  assert.strictEqual(diagnostics.contextLost || diagnostics.renderer?.webglContextLost, false, `WebGL context lost for ${density}`);
  assert.strictEqual(diagnostics.renderer?.fatalFrameError, null, `fatal Pixi error for ${density}: ${JSON.stringify(diagnostics.renderer?.fatalFrameError, null, 2)}`);
  assert.strictEqual(diagnostics.renderer?.tickerStarted, true, `Pixi ticker stopped for ${density}`);
  assert(diagnostics.renderer.screenWidth > 0 && diagnostics.renderer.screenHeight > 0, `invalid renderer screen for ${density}`);
  assert(stats.width > 0 && stats.height > 0 && stats.litRatio > 0.001, `black/empty arena for ${density}: ${JSON.stringify(stats)}`);
  assert(ownShipId, `missing own ship after match start for ${density}`);
  assert(diagnostics.textures?.activeShipViews >= 1, `missing live Pixi ship view for ${density}`);
  assert.notDeepStrictEqual(afterKeyCamera, beforeCamera, `camera did not move after Ready/Deploy button focus for ${density}`);
  assert.notDeepStrictEqual(afterMiddle, afterKeyCamera, `middle mouse drag did not pan camera for ${density}`);
  assert.notDeepStrictEqual(afterSpaceDrag, afterMiddle, `Space + left-drag did not pan camera for ${density}`);
  assert(Math.abs(afterLeftDrag.x - afterSpaceDrag.x) < 1 && Math.abs(afterLeftDrag.y - afterSpaceDrag.y) < 1, `normal left drag changed camera for ${density}`);
  assert.strictEqual(enemy.errors.length, 0, `websocket errors for ${density}: ${enemy.errors.join("\n")}`);
  await page.close(); enemy.close();
  return { density, room, frontendBuild, backendBuild, stats, diagnostics, consoleLines: consoleLines.slice(-20), failedRequests };
}
async function main() {
  const server = spawn("node", ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = ""; server.stdout.on("data", (d) => { serverLog += d; }); server.stderr.on("data", (d) => { serverLog += d; });
  let browser;
  try {
    await waitForServer(); browser = await launchChromium(chromium);
    const reports = [];
    reports.push(await runDensity(browser, "medium"));
    reports.push(await runDensity(browser, "high"));
    console.log(JSON.stringify({ screenshots: SHOT_DIR, reports, serverLogTail: serverLog.split("\n").slice(-20) }, null, 2));
  } catch (err) {
    console.error("match-start render verification failed:", err.stack || err.message);
    console.error("server log tail:\n" + serverLog.split("\n").slice(-40).join("\n"));
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGKILL");
  }
}
main();
