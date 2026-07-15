"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const msgpack = require("@msgpack/msgpack");
const { chromium } = require("playwright");
const { launchChromium, startServer, waitForServer, uniquePort, uniqueRoom, waitForBrowserReady, writeJsonArtifact } = require("./verify-pixi-browser-support.js");

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
  constructor(mergeSnapshotTransaction) {
    this.mergeSnapshotTransaction = mergeSnapshotTransaction;
    this.latest = {};
    this.events = [];
    this.rawSnapshots = [];
    this.mergedSnapshots = [];
    this.mergeEvents = [];
    this.snapshots = this.mergedSnapshots;
    this.mergedSnapshot = null;
    this.snapshotNetwork = { stateEpoch: 0, snapshotSeq: 0, staticRevision: undefined, hasFullBaseline: false };
  }
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
        if (message.type === "state") this.processState(message);
      });
    });
  }
  processState(message) {
    const at = Date.now();
    this.latest.rawState = message;
    this.rawSnapshots.push({ at, state: message });
    if (this.rawSnapshots.length > 160) this.rawSnapshots.shift();
    const result = this.mergeSnapshotTransaction(this.mergedSnapshot, this.snapshotNetwork, message);
    const event = {
      at,
      stateEpoch: message.stateEpoch,
      snapshotSeq: message.snapshotSeq,
      snapshotKind: message.snapshotKind,
      baseSnapshotSeq: message.baseSnapshotSeq,
      staticRevision: message.staticRevision,
      accepted: !!result.ok,
      reason: result.reason,
      previousSeq: this.snapshotNetwork.snapshotSeq
    };
    this.mergeEvents.push(event);
    if (this.mergeEvents.length > 160) this.mergeEvents.shift();
    if (!result.ok) {
      if (["duplicate-sequence", "stale-sequence", "stale-epoch"].includes(result.reason)) return;
      this.latest.mergeError = event;
      return;
    }
    this.mergedSnapshot = result.snapshot;
    this.snapshotNetwork = result.networkState;
    this.latest.state = result.snapshot;
    this.mergedSnapshots.push({ at, state: result.snapshot, merge: event });
    if (this.mergedSnapshots.length > 160) this.mergedSnapshots.shift();
  }
  send(message) { this.ws.send(msgpack.encode(message)); }
  close() { try { this.ws?.close(); } catch {} }
}

function summarizeState(state, raw, merge, playerId) {
  const ships = state?.ships || [];
  const selected = ships.find((ship) => ship.ownerId === playerId) || ships[0];
  const invalidHeat = [];
  const heat = selected?.componentHeat;
  if (Array.isArray(heat)) heat.forEach((entry, index) => { if (!Array.isArray(entry) || entry.length < 4 || !entry.every((v) => Number.isFinite(Number(v)))) invalidHeat.push(index); });
  return {
    stateEpoch: state?.stateEpoch ?? raw?.stateEpoch,
    snapshotSeq: state?.snapshotSeq ?? raw?.snapshotSeq,
    snapshotKind: state?.snapshotKind ?? raw?.snapshotKind,
    baseSnapshotSeq: state?.baseSnapshotSeq ?? raw?.baseSnapshotSeq,
    staticRevision: state?.staticRevision ?? raw?.staticRevision,
    mergeAccepted: merge?.accepted,
    rejectionReason: merge?.reason,
    phase: state?.phase,
    browserPlayerId: playerId,
    availablePlayerIds: (state?.players || []).map((p) => p.id),
    availableShipIds: ships.map((ship) => ship.id),
    shipOwnerIds: ships.map((ship) => ship.ownerId),
    shipAliveStatus: ships.map((ship) => ({ id: ship.id, alive: ship.alive })),
    designLength: Array.isArray(selected?.design) ? selected.design.length : null,
    componentHpLength: Array.isArray(selected?.chp) ? selected.chp.length : null,
    componentHeatLength: Array.isArray(selected?.componentHeat) ? selected.componentHeat.length : null,
    componentHeatDeltaLength: Array.isArray(raw?.ships?.find((ship) => ship.id === selected?.id)?.componentHeatD) ? raw.ships.find((ship) => ship.id === selected?.id).componentHeatD.length : null,
    invalidComponentHeatIndexes: invalidHeat,
    heatNow: selected?.heatNow,
    heatMax: selected?.heatMax,
    mapPresent: !!state?.map,
    worldPresent: !!state?.world,
    rulesPresent: !!state?.rules
  };
}

function assertPrerequisite(name, condition, details) {
  assert(condition, `${name} failed${details ? `: ${details}` : ""}`);
}

function assertNoMergeError(bot) {
  assert(!bot.latest.mergeError, `snapshot merge rejected unexpectedly: ${JSON.stringify(bot.latest.mergeError)}`);
}

function assertValidAuthoritativeShip(state, ship, playerId) {
  assertPrerequisite("ship.design-array", Array.isArray(ship.design));
  assertPrerequisite("ship.componentHp-array", Array.isArray(ship.chp));
  assertPrerequisite("ship.componentHeat-array", Array.isArray(ship.componentHeat));
  assertPrerequisite("componentHp-design-length", ship.chp.length === ship.design.length, `${ship.chp.length} !== ${ship.design.length}`);
  assertPrerequisite("componentHeat-design-length", ship.componentHeat.length === ship.design.length, `${ship.componentHeat.length} !== ${ship.design.length}`);
  ship.componentHeat.forEach((entry, index) => {
    assertPrerequisite(`componentHeat-${index}-tuple`, Array.isArray(entry) && entry.length >= 4, JSON.stringify(entry));
    entry.forEach((value, field) => assertPrerequisite(`componentHeat-${index}-${field}-finite`, Number.isFinite(Number(value)), JSON.stringify(entry)));
  });
  assertPrerequisite("componentHeat-no-missing-or-shifted-index", ship.componentHeat.every((_, index) => index in ship.componentHeat));
  assertPrerequisite("static-map-present", !!state.map);
  assertPrerequisite("static-world-present", !!state.world);
  assertPrerequisite("static-rules-present", !!state.rules);
  const player = state.players?.find((p) => p.id === playerId);
  assertPrerequisite("static-player-present", !!player, playerId);
  for (const field of ["design", "stats", "name", "team"]) assertPrerequisite(`player-${field}-preserved`, player[field] !== undefined, JSON.stringify(player));
  assertPrerequisite("player-colour-preserved", player.colour !== undefined || player.color !== undefined, JSON.stringify(player));
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
  let myId;
  const { mergeSnapshotTransaction } = await import("./public/src/snapshotMerge.js");
  const bot = new Client(mergeSnapshotTransaction);
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
    await waitForBrowserReady(page, ROOM, diagnostics, 20000);
    myId = await page.evaluate(() => window.__mfaState.myId);
    diagnostics.playerId = myId;

    await bot.open();
    bot.send({ type: "join", room: ROOM, name: "HeatBot", team: "red", protocolVersion:4, minProtocolVersion:4, maxProtocolVersion:4, capabilities:["messagepack"] });
    await until(() => bot.latest.joined, "bot join");
    diagnostics.botPlayerId = bot.latest.joined.playerId || bot.latest.joined.id;
    await page.evaluate(() => window.__mfaNetSend({ type: "setRules", rules: { asteroidDensity: "none" } }));
    await page.evaluate(() => window.__mfaNetSend({ type: "startDesign" }));
    await until(() => bot.latest.state?.phase === "design", "design phase");
    diagnostics.phases.push({ phase: "design", at: Date.now() });
    await page.evaluate((design) => window.__mfaNetSend({ type: "deploy", design, combatStyle: "sentry" }), DESIGN);
    bot.send({ type: "deploy", design: DESIGN, combatStyle: "sentry" });
    await until(() => bot.latest.state?.phase === "active", "active phase");
    diagnostics.phases.push({ phase: "active", at: Date.now() });

    const ship = await until(() => {
      assertNoMergeError(bot);
      const state = bot.latest.state;
      if (!state || state.phase !== "active" || !Array.isArray(state.ships)) return null;
      return state.ships.find((s) => s.ownerId === myId && s.alive);
    }, "active merged snapshot with living browser-owned ship");
    assertValidAuthoritativeShip(bot.latest.state, ship, myId);
    diagnostics.authoritativeShip = summarizeState(bot.latest.state, bot.latest.rawState, bot.mergeEvents.at(-1), myId);
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
    const heated = await until(() => { assertNoMergeError(bot); return bot.latest.state?.ships?.find((s) => s.id === ship.id && Number(s.heatNow) > 0 && Array.isArray(s.componentHeat)); }, "authoritative heat update", 20000);
    assertValidAuthoritativeShip(bot.latest.state, heated, myId);
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
    diagnostics.rawSnapshots = bot.rawSnapshots.slice(-8).map(({ at, state }) => ({ at, ...summarizeState(state, state, null, myId) }));
    diagnostics.mergedSnapshots = bot.mergedSnapshots.slice(-8).map(({ at, state, merge }) => ({ at, ...summarizeState(state, bot.rawSnapshots.find((r) => r.state.snapshotSeq === state.snapshotSeq)?.state, merge, myId) }));
    diagnostics.mergeEvents = bot.mergeEvents.slice(-20);
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
