"use strict";
// End-to-end live turret tracking over the REAL server + WebSocket protocol.
//
// Unlike verify-turret-render.js (which injects synthetic snapshots and angles
// directly into the client), this test never assigns ship.weaponAngles. It:
//   1. starts the real current server.js;
//   2. joins a real Chromium client (the shooter) and a real Node WebSocket
//      client (the enemy) through the real lobby -> design -> match flow;
//   3. moves both ships OUT of the safe zones into blaster tracking range;
//   4. captures successive real MessagePack snapshots and asserts the
//      server-provided weaponAngles[designIndex] is always present and tracks
//      the enemy;
//   5. moves the enemy to a significantly different bearing and asserts the
//      authoritative angle changes toward the new relative angle;
//   6. asserts the live Pixi turret sprite follows the received angles
//      (never invents its own), with before/after screenshots whose barrel
//      pixels must differ;
//   7. asserts real projectiles leave along the rendered barrel;
//   8. verifies frontend/backend build + protocol identification end to end.
//
// Run after `npm run build`: node verify-live-turrets.js

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const msgpack = require("@msgpack/msgpack");
const { chromium } = require("playwright");
const { launchChromium } = require("./verify-pixi-browser-support.js");

const PORT = Number(process.env.TEST_PORT || 5603);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOM = "TRRTE2E";
const SHOT_DIR = process.env.SHOT_DIR || path.join(require("os").tmpdir(), "mfa-live-turret-shots");

for (const required of ["public/vendor/pixi.min.js", "public/vendor/msgpack.min.js", "public/build-sha.js"]) {
  if (!fs.existsSync(required)) {
    console.error(`${required} is missing — run \`npm run build\` before verify-live-turrets.js`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, timeoutMs, what) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout after ${timeoutMs}ms waiting for: ${what}`);
    await sleep(150);
  }
}

function angleDiff(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}

function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE}/index.html`, (res) => { res.resume(); resolve(); });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("server did not start"));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (err) { reject(err); }
      });
    }).on("error", reject);
  });
}

// A real WebSocket client speaking the real protocol: JSON text frames out,
// MessagePack binary snapshots in. Caches per-ship designs the way the real
// client does (the server sends each design once).
class NetClient {
  constructor(name) {
    this.name = name;
    this.latest = {};
    this.snapshots = [];
    this.designs = new Map();
    this.map = null;
    this.world = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/socket`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error(`${this.name}: websocket error`)));
      ws.addEventListener("message", (event) => {
        let message;
        try {
          message = event.data instanceof ArrayBuffer
            ? msgpack.decode(new Uint8Array(event.data))
            : JSON.parse(event.data);
        } catch {
          return;
        }
        this.latest[message.type] = message;
        if (message.map) this.map = message.map;
        if (message.world) this.world = message.world;
        if (message.type === "state") {
          for (const ship of message.ships || []) {
            if (ship.design) this.designs.set(ship.id, ship.design);
            else ship.design = this.designs.get(ship.id);
          }
          this.snapshots.push({ at: Date.now(), state: message });
          if (this.snapshots.length > 900) this.snapshots.shift();
        }
      });
    });
  }

  send(message) { this.ws.send(JSON.stringify(message)); }
  state() { return this.latest.state || null; }
  ship(id) { return this.state()?.ships?.find((candidate) => candidate.id === id) || null; }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

function inAnySafeZone(map, x, y) {
  for (const zone of map?.safeZones || []) {
    if (Math.hypot(x - zone.x, y - zone.y) <= zone.radius) return true;
  }
  return false;
}

// Shooter: one clearly directional forward blaster (design index 7). The
// reactor keeps the ship fully powered so it moves at real combat speed.
const SHOOTER_DESIGN = [
  { x: 7, y: 7, type: "core", rotation: 0 },
  { x: 7, y: 8, type: "frame", rotation: 0 },
  { x: 6, y: 8, type: "engine", rotation: 0 },
  { x: 8, y: 8, type: "engine", rotation: 0 },
  { x: 6, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 8, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 6, y: 6, type: "reactor", rotation: 0 },
  { x: 7, y: 5, type: "blaster", rotation: 0 }
];
const SHOOTER_BLASTER_INDEX = 7;

// Enemy: an armoured, weaponless brick that survives sustained fire while it
// repositions (armour flat reduction blunts each bolt).
const ENEMY_DESIGN = [
  { x: 7, y: 7, type: "core", rotation: 0 },
  { x: 7, y: 8, type: "frame", rotation: 0 },
  { x: 6, y: 8, type: "engine", rotation: 0 },
  { x: 8, y: 8, type: "engine", rotation: 0 },
  { x: 6, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 8, y: 7, type: "maneuverThruster", rotation: 0 },
  { x: 5, y: 8, type: "maneuverThruster", rotation: 0 },
  { x: 9, y: 8, type: "maneuverThruster", rotation: 0 },
  { x: 6, y: 6, type: "reactor", rotation: 0 },
  { x: 8, y: 6, type: "armor", rotation: 0 },
  { x: 5, y: 7, type: "armor", rotation: 0 },
  { x: 9, y: 7, type: "armor", rotation: 0 },
  { x: 7, y: 5, type: "armor", rotation: 0 },
  { x: 8, y: 5, type: "armor", rotation: 0 }
];

const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push([true, name]); console.log("  ok  -", name); },
    (err) => { results.push([false, name]); console.log("  FAIL-", name, "\n       ", err.message); }
  );
}

async function shot(page, file) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const target = path.join(SHOT_DIR, file);
  const box = await page.evaluate(() => {
    const canvas = document.getElementById("arenaCanvas") || document.querySelector("canvas");
    const rect = canvas.getBoundingClientRect();
    return { cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2 };
  });
  const half = 90;
  await page.screenshot({ path: target, clip: { x: Math.max(0, box.cx - half), y: Math.max(0, box.cy - half), width: half * 2, height: half * 2 } });
  return fs.readFileSync(target);
}

function pixelsDiffer(a, b) {
  if (a.length !== b.length) return true;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  return diff > a.length * 0.0005;
}

async function pinCameraOnShip(page, shipId) {
  await page.evaluate((id) => {
    const state = window.__mfaState;
    const ship = state.snapshot?.ships?.find((candidate) => candidate.id === id);
    if (!ship) return;
    state.camera.x = ship.x;
    state.camera.y = ship.y;
    state.camera.zoom = 3.0;
    state.camera.follow = false;
    state.camera.manualZoom = 3.0;
  }, shipId);
  await sleep(250);
}

async function main() {
  const server = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += d; });
  server.stderr.on("data", (d) => { serverLog += d; });

  let browser;
  const enemy = new NetClient("enemy");
  const report = {};

  try {
    await waitForServer();
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    // 1. The Chromium client joins the room through the real UI/auto-join path
    //    (first joiner => room admin).
    await page.goto(`${BASE}/index.html?room=${ROOM}`, { waitUntil: "load" });
    await page.waitForFunction((room) => window.__mfaState?.room === room && window.__mfaState?.myId, ROOM, { timeout: 20000 });
    const browserPlayerId = await page.evaluate(() => window.__mfaState.myId);

    // 2. Frontend/backend identification is present on the real hello message.
    const serverInfo = await page.evaluate(() => ({ ...(window.__mfaState.server || {}) }));
    const frontendBuild = await page.evaluate(() => globalThis.__mfaFrontendBuild || null);
    report.frontendBuild = frontendBuild;
    report.backendBuild = serverInfo.buildSha;
    await check("hello carries protocolVersion + serverBuildSha and is compatible", () => {
      assert(Number.isFinite(serverInfo.protocolVersion), `protocolVersion missing on hello: ${JSON.stringify(serverInfo)}`);
      assert(serverInfo.buildSha, "serverBuildSha missing on hello");
      assert.strictEqual(serverInfo.compatibility, "ok", `expected compatible protocol, got ${serverInfo.compatibility}`);
      assert(frontendBuild, "frontend build identifier missing");
    });

    // 3. The enemy joins through a raw Node WebSocket client (real protocol).
    await enemy.connect();
    await until(() => enemy.latest.hello, 10000, "enemy hello");
    await check("node client hello carries protocol + build identification", () => {
      assert(Number.isFinite(enemy.latest.hello.protocolVersion), "hello.protocolVersion missing");
      assert(enemy.latest.hello.serverBuildSha, "hello.serverBuildSha missing");
    });
    enemy.send({ type: "join", room: ROOM, name: "EnemyBrick", team: "red" });
    await until(() => enemy.latest.joined, 10000, "enemy joined room");
    const enemyPlayerId = enemy.latest.joined.id;

    // Make sure the two players are on opposing teams.
    enemy.send({ type: "setTeam", team: "red" });
    await until(() => {
      const players = enemy.state()?.players;
      const mine = players?.find((p) => p.id === enemyPlayerId);
      const theirs = players?.find((p) => p.id === browserPlayerId);
      return mine && theirs && mine.team !== theirs.team;
    }, 10000, "players on opposing teams");

    // 4. Admin clears asteroids (they would randomly block line of sight and
    //    make target acquisition nondeterministic), starts design; both deploy
    //    real designs; the match starts.
    await page.evaluate(() => window.__mfaNetSend({ type: "setRules", rules: { asteroidDensity: "none" } }));
    await until(() => enemy.state()?.rules?.asteroidDensity === "none"
      || enemy.latest.state?.rules?.asteroidDensity === "none", 10000, "asteroid-free map rules");
    await page.evaluate(() => window.__mfaNetSend({ type: "startDesign" }));
    await until(() => enemy.state()?.phase === "design", 10000, "design phase");
    await page.evaluate((design) => window.__mfaNetSend({ type: "deploy", design, combatStyle: "sentry" }), SHOOTER_DESIGN);
    enemy.send({ type: "deploy", design: ENEMY_DESIGN, combatStyle: "sentry" });
    await until(() => enemy.state()?.phase === "active", 15000, "match start");

    const shooterShip = await until(() => enemy.state()?.ships?.find((s) => s.ownerId === browserPlayerId && s.alive), 10000, "shooter ship spawn");
    const enemyShip = await until(() => enemy.state()?.ships?.find((s) => s.ownerId === enemyPlayerId && s.alive), 10000, "enemy ship spawn");
    const shooterId = shooterShip.id;
    const enemyId = enemyShip.id;

    await check("shooter design + authoritative angle field arrive over the wire", () => {
      const ship = enemy.ship(shooterId);
      assert(Array.isArray(ship.design), "shooter design missing from snapshots");
      assert.strictEqual(ship.design[SHOOTER_BLASTER_INDEX].type, "blaster", "expected the blaster at design index 6");
      assert(Array.isArray(ship.weaponAngles), "ship.weaponAngles missing from real snapshot");
      assert(Number.isFinite(ship.weaponAngles[SHOOTER_BLASTER_INDEX]),
        `weaponAngles[${SHOOTER_BLASTER_INDEX}] missing/non-finite: ${JSON.stringify(ship.weaponAngles)}`);
    });
    report.firstReceivedAngle = enemy.ship(shooterId).weaponAngles[SHOOTER_BLASTER_INDEX];

    // 5. Move both ships out of the safe zones to a mid-field engagement spot.
    const world = enemy.world || { width: 4160, height: 2560 };
    const P1 = { x: world.width / 2 - 400, y: world.height / 2 + 520 };
    const A = { x: P1.x + 430, y: P1.y };          // enemy bearing A: east of shooter
    const B = { x: P1.x + 40, y: P1.y - 430 };     // enemy bearing B: ~north of shooter
    await page.evaluate((p) => window.__mfaNetSend({ type: "command", x: p.x, y: p.y }), P1);
    enemy.send({ type: "command", x: A.x, y: A.y });

    await until(() => {
      const shooter = enemy.ship(shooterId);
      const foe = enemy.ship(enemyId);
      if (!shooter || !foe) return false;
      return Math.hypot(shooter.x - P1.x, shooter.y - P1.y) < 150 && Math.hypot(foe.x - A.x, foe.y - A.y) < 150;
    }, 60000, "ships reach the phase-A engagement positions");

    await check("both ships are outside every safe zone", () => {
      const shooter = enemy.ship(shooterId);
      const foe = enemy.ship(enemyId);
      assert(enemy.map?.safeZones?.length, "map safe zones unknown");
      assert(!inAnySafeZone(enemy.map, shooter.x, shooter.y), "shooter still inside a safe zone");
      assert(!inAnySafeZone(enemy.map, foe.x, foe.y), "enemy still inside a safe zone");
    });

    // 6. Phase A: capture successive real snapshots and require the
    //    authoritative angle to be present and to track the enemy bearing.
    const phaseAStart = enemy.snapshots.length;
    await sleep(4000);
    const phaseASamples = enemy.snapshots.slice(phaseAStart).map(({ state }) => {
      const shooter = state.ships.find((s) => s.id === shooterId);
      const foe = state.ships.find((s) => s.id === enemyId);
      if (!shooter || !foe) return null;
      return {
        rel: shooter.weaponAngles?.[SHOOTER_BLASTER_INDEX],
        hull: shooter.angle,
        bearing: Math.atan2(foe.y - shooter.y, foe.x - shooter.x),
        bullets: (state.bullets || []).filter((b) => b.type === "bolt" && b.ownerId === browserPlayerId)
      };
    }).filter(Boolean);

    let phaseAEnd = null;
    await check("server snapshots track the enemy on bearing A (angle present in every snapshot)", () => {
      assert(phaseASamples.length >= 20, `too few snapshots sampled: ${phaseASamples.length}`);
      for (const sample of phaseASamples) {
        assert(Number.isFinite(sample.rel), "weaponAngles entry missing from a live snapshot");
      }
      phaseAEnd = phaseASamples[phaseASamples.length - 1];
      const aimError = Math.abs(angleDiff(phaseAEnd.hull + phaseAEnd.rel, phaseAEnd.bearing));
      assert(aimError < 0.35, `turret world aim is ${aimError.toFixed(3)} rad off the enemy bearing`);
    });

    // The authoritative angle must have left the blueprint default at some
    // point (the turret leads the slower hull while acquiring the target).
    await check("authoritative angle does not stay at the blueprint default", () => {
      const maxOffDefault = Math.max(...phaseASamples.map((sample) => Math.abs(angleDiff(sample.rel, 0))));
      assert(maxOffDefault > 0.15,
        `weaponAngles never left the blueprint default (max deviation ${maxOffDefault.toFixed(3)} rad)`);
    });

    // 7. Real projectiles leave along the authoritative barrel direction.
    await check("projectile direction aligns with the authoritative barrel", () => {
      let checked = 0;
      for (const sample of phaseASamples) {
        for (const bullet of sample.bullets) {
          if ((bullet.age || 0) > 0.2) continue; // only freshly fired bolts
          const velocityDir = Math.atan2(bullet.vy, bullet.vx);
          const barrel = sample.hull + sample.rel;
          const error = Math.abs(angleDiff(velocityDir, barrel));
          assert(error < 0.45, `bolt velocity ${velocityDir.toFixed(3)} vs barrel ${barrel.toFixed(3)} (off ${error.toFixed(3)})`);
          checked += 1;
        }
      }
      assert(checked > 0, "no freshly fired bolts observed while the enemy was in range");
    });

    // 8. The live Pixi sprite follows the received angles (phase A settle).
    await pinCameraOnShip(page, shooterId);
    const beforeDiag = await page.evaluate((id) => window.__mfaLiveTurretDiagnostics(id), shooterId);
    const beforeShot = await shot(page, "live-before.png");
    await check("live Pixi sprite renders the received authoritative angle (phase A)", () => {
      const row = beforeDiag.find((entry) => entry.designIndex === SHOOTER_BLASTER_INDEX);
      assert(row, "no live diagnostics row for the blaster");
      assert.strictEqual(row.anglePresent, true, "diagnostics report the angle as missing");
      const lag = Math.abs(angleDiff(row.renderedLocalAngle, row.receivedAuthoritativeAngle));
      assert(lag < 0.35, `rendered local angle lags authoritative by ${lag.toFixed(3)} rad`);
    });

    // 9. Phase B: move the enemy to a significantly different bearing. The
    //    server angles must change toward the new relative angle and the
    //    rendered sprite must follow.
    enemy.send({ type: "command", x: B.x, y: B.y });
    const phaseBStart = enemy.snapshots.length;
    await until(() => {
      const foe = enemy.ship(enemyId);
      return foe && Math.hypot(foe.x - B.x, foe.y - B.y) < 150;
    }, 45000, "enemy reaches the phase-B bearing");
    await sleep(3000);

    const phaseBSamples = enemy.snapshots.slice(phaseBStart).map(({ state }) => {
      const shooter = state.ships.find((s) => s.id === shooterId);
      const foe = state.ships.find((s) => s.id === enemyId);
      if (!shooter || !foe) return null;
      return {
        rel: shooter.weaponAngles?.[SHOOTER_BLASTER_INDEX],
        hull: shooter.angle,
        bearing: Math.atan2(foe.y - shooter.y, foe.x - shooter.x)
      };
    }).filter(Boolean);

    let phaseBEnd = null;
    await check("server angles change toward the new relative angle (phase B)", () => {
      assert(phaseBSamples.length >= 20, `too few phase-B snapshots: ${phaseBSamples.length}`);
      for (const sample of phaseBSamples) {
        assert(Number.isFinite(sample.rel), "weaponAngles entry went missing during phase B");
      }
      phaseBEnd = phaseBSamples[phaseBSamples.length - 1];
      const bearingChange = Math.abs(angleDiff(phaseAEnd.bearing, phaseBEnd.bearing));
      assert(bearingChange > 0.8, `enemy bearing only changed ${bearingChange.toFixed(3)} rad`);
      const aimError = Math.abs(angleDiff(phaseBEnd.hull + phaseBEnd.rel, phaseBEnd.bearing));
      assert(aimError < 0.35, `turret world aim is ${aimError.toFixed(3)} rad off the new bearing`);
      const worldAimChange = Math.abs(angleDiff(phaseAEnd.hull + phaseAEnd.rel, phaseBEnd.hull + phaseBEnd.rel));
      assert(worldAimChange > 0.5, `world aim only moved ${worldAimChange.toFixed(3)} rad between bearings`);
      const relChanged = Math.max(...phaseBSamples.map((sample) => Math.abs(angleDiff(sample.rel, phaseBSamples[0].rel))));
      assert(relChanged > 0.1, `authoritative relative angle never moved during the bearing change (max ${relChanged.toFixed(3)})`);
    });
    report.changedTargetAngle = phaseBEnd ? phaseBEnd.bearing : null;
    report.finalReceivedAngle = phaseBEnd ? phaseBEnd.rel : null;

    // 10. Rendered sprite followed the change; barrel pixels rotated.
    await pinCameraOnShip(page, shooterId);
    const afterDiag = await page.evaluate((id) => window.__mfaLiveTurretDiagnostics(id), shooterId);
    const afterShot = await shot(page, "live-after.png");
    const afterRow = afterDiag.find((entry) => entry.designIndex === SHOOTER_BLASTER_INDEX);
    report.finalRenderedAngle = afterRow ? afterRow.renderedLocalAngle : null;
    await check("live Pixi sprite follows the changed authoritative angle (phase B)", () => {
      assert(afterRow, "no live diagnostics row after the bearing change");
      assert.strictEqual(afterRow.anglePresent, true);
      assert.strictEqual(afterRow.angleChangedRecently, true, "the authoritative angle should have changed recently");
      const lag = Math.abs(angleDiff(afterRow.renderedLocalAngle, afterRow.receivedAuthoritativeAngle));
      assert(lag < 0.35, `rendered angle lags authoritative by ${lag.toFixed(3)} rad after the change`);
      // The sprite must not invent rotation the server never sent: the rendered
      // world direction has to match the authoritative world direction.
      const worldError = Math.abs(angleDiff(afterRow.renderedWorldAngle, afterRow.hullAngle + afterRow.receivedAuthoritativeAngle));
      assert(worldError < 0.35, `rendered world direction disagrees with the authoritative one by ${worldError.toFixed(3)}`);
    });
    await check("visible barrel pixels rotate between bearings", () => {
      assert(pixelsDiffer(beforeShot, afterShot), "before/after screenshots are identical — the barrel did not visibly rotate");
    });

    // 11. The development diagnostics endpoint exposes the full aim state.
    await check("dev /debug/turrets endpoint reports the aim decision state", async () => {
      const { status, json } = await httpGetJson(`${BASE}/debug/turrets?room=${ROOM}&ship=${shooterId}`);
      assert.strictEqual(status, 200, `debug endpoint status ${status}`);
      assert(json.serverBuildSha, "debug endpoint missing serverBuildSha");
      assert(Number.isFinite(json.protocolVersion), "debug endpoint missing protocolVersion");
      const shipEntry = json.ships.find((entry) => entry.shipId === shooterId);
      assert(shipEntry, "debug endpoint missing the shooter");
      const turret = shipEntry.turrets.find((entry) => entry.designIndex === SHOOTER_BLASTER_INDEX);
      assert(turret, "debug endpoint missing the blaster turret");
      for (const field of ["shipId", "componentType", "defaultRelativeAngle", "currentRelativeAngle",
        "desiredRelativeAngle", "hullWorldAngle", "weaponWorldAngle", "aimTargetId", "fireTargetId",
        "targetDistance", "inFiringRange", "inFixedArc", "safeZoneFiringBlocked", "componentAlive",
        "thermalPerformance"]) {
        assert(field in turret, `debug turret entry missing ${field}`);
      }
      assert.strictEqual(turret.componentType, "blaster");
    });

    await check("no uncaught page errors during the live match", () => {
      assert.strictEqual(pageErrors.length, 0, `page errors:\n${pageErrors.join("\n")}`);
    });

    await browser.close();
  } catch (err) {
    console.error("live turret test aborted:", err.message);
    console.error("server log tail:\n" + serverLog.split("\n").slice(-25).join("\n"));
    results.push([false, `aborted: ${err.message}`]);
  } finally {
    enemy.close();
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGKILL");
  }

  const fmt = (value) => (Number.isFinite(value) ? value.toFixed(4) : String(value));
  console.log(`\nScreenshots written to ${SHOT_DIR}`);
  console.log("Live turret report:");
  console.log(`  first received angle : ${fmt(report.firstReceivedAngle)} rad`);
  console.log(`  changed target angle : ${fmt(report.changedTargetAngle)} rad (world bearing)`);
  console.log(`  final received angle : ${fmt(report.finalReceivedAngle)} rad (ship-relative)`);
  console.log(`  final rendered angle : ${fmt(report.finalRenderedAngle)} rad (sprite local)`);
  console.log(`  backend build SHA    : ${report.backendBuild}`);
  console.log(`  frontend build SHA   : ${report.frontendBuild}`);

  const failed = results.filter(([ok]) => !ok);
  console.log(`\nLive turret checks: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:\n" + failed.map(([, name]) => "  - " + name).join("\n"));
    process.exit(1);
  }
  console.log("Live turret verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
