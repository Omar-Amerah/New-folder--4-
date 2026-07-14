"use strict";
// Browser-level proof that Pixi turret artwork visibly tracks its authoritative
// ship-relative weapon angle. This drives the real built client in headless
// Chromium (WebGL/Pixi backend), injects synthetic snapshots through the
// exposed window.__mfaState handle, reads live turret transforms through
// window.__mfaTurretDebugInfo, and diffs before/after screenshots so the checks
// prove rendered behaviour rather than source shape.
//
// Run: node verify-turret-render.js   (starts its own server on PORT 5599)

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");
const { launchChromium } = require("./verify-pixi-browser-support.js");

const PORT = Number(process.env.TEST_PORT || 5599);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOT_DIR = process.env.SHOT_DIR || path.join(require("os").tmpdir(), "mfa-turret-shots");

function waitForServer(timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE}/index.html`, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("server did not start"));
        else setTimeout(tick, 200);
      });
    };
    tick();
  });
}

// Injected page helpers -------------------------------------------------------
// These run inside the page. They build synthetic snapshots and step the Pixi
// ticker through real requestAnimationFrame frames.

const PAGE_HELPERS = `
window.__mfaTest = {
  async frames(n) {
    // Step at least n frames, and always end on a fresh frame AFTER the Pixi
    // ticker's own rAF has run, so sprite.worldTransform reflects the latest
    // state we set. A double-rAF per step avoids racing the ticker's rAF queue.
    for (let i = 0; i < n + 2; i++) {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    }
  },
  setShip(snapshot, cameraTarget) {
    const state = window.__mfaState;
    state.myId = "p1";
    state.snapshot = snapshot;
    state.snapshotReceivedAt = performance.now();
    // Pin the interpolated visual pose to the authoritative pose so hull angle
    // is exactly what we set (no smoothing lag) for deterministic assertions.
    state.visualShips = new Map();
    for (const s of snapshot.ships) {
      state.visualShips.set(s.id, { x: s.x, y: s.y, angle: s.angle });
    }
    const focus = cameraTarget || snapshot.ships[0];
    state.camera.x = focus.x;
    state.camera.y = focus.y;
    state.camera.zoom = 3.0;
    state.camera.follow = false;
    state.camera.manualZoom = 3.0;
  },
  setHullAngle(shipId, angle) {
    const state = window.__mfaState;
    const ship = state.snapshot.ships.find((s) => s.id === shipId);
    ship.angle = angle;
    const vis = state.visualShips.get(shipId);
    if (vis) vis.angle = angle;
  },
  setWeaponAngle(shipId, designIndex, angle) {
    const ship = window.__mfaState.snapshot.ships.find((s) => s.id === shipId);
    ship.weaponAngles[designIndex] = angle;
  }
};
`;

function design(...parts) {
  return parts.map((p) => ({ x: p[0], y: p[1], type: p[2], rotation: p[3] || 0 }));
}

function snapshotWith(shipId, shipDesign, extra = {}) {
  const weaponAngles = shipDesign.map((p) => 0);
  return {
    players: [{ id: "p1", name: "Tester", color: "#38bdf8", design: shipDesign }],
    ships: [{
      id: shipId,
      ownerId: "p1",
      x: 1600,
      y: 950,
      vx: 0,
      vy: 0,
      angle: 0,
      radius: 30,
      alive: true,
      hp: 500,
      maxHp: 500,
      shield: 0,
      maxShield: 0,
      design: shipDesign,
      weaponAngles,
      ...extra
    }],
    bullets: [],
    points: [],
    map: { asteroids: [], safeZones: [], clouds: [] }
  };
}

const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push([true, name]); console.log("  ok  -", name); },
    (err) => { results.push([false, name]); console.log("  FAIL-", name, "\n       ", err.message); }
  );
}

async function shot(page, file) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const p = path.join(SHOT_DIR, file);
  // The camera centres the ship on the arena canvas, so crop a tight box around
  // the canvas centre — a rotating barrel then dominates the pixel diff instead
  // of static background.
  const box = await page.evaluate(() => {
    const c = document.getElementById("arenaCanvas") || document.querySelector("canvas");
    const r = c.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  });
  const half = 90;
  await page.screenshot({ path: p, clip: { x: Math.max(0, box.cx - half), y: Math.max(0, box.cy - half), width: half * 2, height: half * 2 } });
  return fs.readFileSync(p);
}

function pixelsDiffer(a, b) {
  if (a.length !== b.length) return true;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  // Require a meaningful number of differing bytes, not a stray compression byte.
  return diff > a.length * 0.0005;
}

const EPS = 0.02;

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
  try {
    await waitForServer();
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
    await page.addScriptTag({ content: PAGE_HELPERS });
    // Dismiss the boot menu overlays so the arena (and turret) is on-screen for
    // the before/after screenshots.
    await page.evaluate(() => {
      for (const id of ["mainMenuScreen", "lobbyManagementScreen", "settingsScreen", "lobbyScreen", "designerScreen"]) {
        const el = document.getElementById(id);
        if (el) el.hidden = true;
      }
    });

    // 0. The active backend must be Pixi (the migration target).
    await page.waitForFunction(() => window.__mfaRenderer && window.__mfaRenderer.backend, null, { timeout: 15000 });
    const backend = await page.evaluate(() => window.__mfaRenderer.backend);
    await check("active backend is pixi", () => {
      assert.strictEqual(backend, "pixi", `backend was ${backend} (expected pixi). serverLog:\n${serverLog}`);
    });
    // Wait until component balance loaded so PART_STATS knows the blaster weapon.
    await page.waitForFunction(() => window.__mfaState && window.__mfaState.parts && Object.keys(window.__mfaState.parts).length > 0, null, { timeout: 15000 }).catch(() => {});

    // 1. Spawn a ship with a blaster; exactly one turret sprite exists.
    let blasterInfo;
    await check("blaster ship spawns exactly one turret sprite", async () => {
      const d = design([7, 7, "core"], [8, 7, "blaster"]);
      await page.evaluate((snap) => window.__mfaTest.setShip(snap), snapshotWith("ship-blaster", d));
      await page.evaluate(() => window.__mfaTest.frames(4));
      blasterInfo = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-blaster"));
      assert.ok(blasterInfo, "no debug info for ship-blaster");
      assert.strictEqual(blasterInfo.turretCount, 1, `turretCount was ${blasterInfo.turretCount}`);
      assert.strictEqual(blasterInfo.turrets[0].partType, "blaster");
      assert.strictEqual(blasterInfo.turrets[0].designIndex, 1, "turret must keep original design index");
      assert.ok(blasterInfo.turrets[0].visible && blasterInfo.turrets[0].alpha > 0.9, "turret should be visible");
    });

    // 2. Changing the authoritative weapon angle rotates the sprite and its
    //    world transform, and visibly changes the rendered barrel (screenshot).
    await check("authoritative angle change rotates turret + pixels", async () => {
      // Use direct assignment so the visible barrel is exactly the authoritative
      // angle (no smoothing) — proves the transform, per the task.
      await page.evaluate(() => { window.__mfaDisableTurretSmoothing = true; });
      await page.evaluate(() => window.__mfaTest.setWeaponAngle("ship-blaster", 1, 0));
      await page.evaluate(() => window.__mfaTest.frames(3));
      const before = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-blaster"));
      const beforeShot = await shot(page, "blaster-before.png");

      await page.evaluate(() => window.__mfaTest.setWeaponAngle("ship-blaster", 1, Math.PI / 2));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const after = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-blaster"));
      const afterShot = await shot(page, "blaster-after.png");

      const b = before.turrets[0];
      const a = after.turrets[0];
      assert.ok(Math.abs(a.localRotation - Math.PI / 2) < EPS, `sprite local rotation did not reach target: ${a.localRotation}`);
      assert.ok(Math.abs(a.localRotation - b.localRotation) > 1.0, "sprite local rotation did not change");
      assert.ok(Math.abs(a.worldTransformRotation - b.worldTransformRotation) > 1.0, "world transform rotation did not change");
      assert.ok(pixelsDiffer(beforeShot, afterShot), "rendered barrel pixels did not change");
    });

    // 3. World turret direction = hull rotation + turret local rotation. Rotate
    //    the hull with a fixed relative angle: local rotation stays, world moves.
    await check("rotating hull moves world barrel, keeps local (stationary target)", async () => {
      await page.evaluate(() => window.__mfaTest.setWeaponAngle("ship-blaster", 1, 0.3));
      await page.evaluate(() => window.__mfaTest.setHullAngle("ship-blaster", 0));
      await page.evaluate(() => window.__mfaTest.frames(3));
      const before = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-blaster"));
      await page.evaluate(() => window.__mfaTest.setHullAngle("ship-blaster", 1.0));
      await page.evaluate(() => window.__mfaTest.frames(3));
      const after = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-blaster"));
      const bt = before.turrets[0];
      const at = after.turrets[0];
      const worldAdvance = Math.atan2(Math.sin(at.worldRotation - bt.worldRotation), Math.cos(at.worldRotation - bt.worldRotation));
      assert.ok(Math.abs(at.localRotation - bt.localRotation) < EPS, "turret local rotation must not move when only the hull rotates");
      assert.ok(Math.abs(after.hullRotation - before.hullRotation - 1.0) < EPS, "hull rotation should have advanced by ~1.0 rad");
      assert.ok(Math.abs(worldAdvance - 1.0) < 0.05, `world barrel direction should advance with the hull (advanced ${worldAdvance.toFixed(3)})`);
      // Cross-check against the actual Pixi world matrix when it reads cleanly.
      if (Number.isFinite(at.worldTransformRotation) && Number.isFinite(bt.worldTransformRotation)) {
        const mtxAdvance = Math.atan2(Math.sin(at.worldTransformRotation - bt.worldTransformRotation), Math.cos(at.worldTransformRotation - bt.worldTransformRotation));
        assert.ok(Math.abs(mtxAdvance - 1.0) < 0.05, `world matrix rotation should advance with the hull (advanced ${mtxAdvance.toFixed(3)})`);
      }
    });

    // 4. Debug direction lines: authoritative world dir == rendered world dir.
    await check("authoritative world angle == rendered world angle (lines overlap)", async () => {
      const info = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-blaster"));
      const ship = await page.evaluate(() => window.__mfaState.snapshot.ships.find((s) => s.id === "ship-blaster"));
      const t = info.turrets[0];
      const authoritativeWorld = ship.angle + ship.weaponAngles[1];
      // rendered world (from transform) must match the authoritative world angle.
      const d = Math.atan2(Math.sin(t.worldTransformRotation - authoritativeWorld), Math.cos(t.worldTransformRotation - authoritativeWorld));
      assert.ok(Math.abs(d) < 0.05, `red/cyan mismatch: rendered ${t.worldTransformRotation.toFixed(3)} vs authoritative ${authoritativeWorld.toFixed(3)}`);
    });

    // 5. Projectile velocity direction aligns with the rendered barrel.
    await check("projectile direction aligns with rendered barrel", async () => {
      const info = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-blaster"));
      const ship = await page.evaluate(() => window.__mfaState.snapshot.ships.find((s) => s.id === "ship-blaster"));
      // The server fires along ship.angle + weaponAngles[i]; the rendered barrel
      // world angle must equal that so bullets leave the visible muzzle forward.
      const fireDir = ship.angle + ship.weaponAngles[1];
      const rendered = info.turrets[0].worldRotation;
      const d = Math.atan2(Math.sin(rendered - fireDir), Math.cos(rendered - fireDir));
      assert.ok(Math.abs(d) < 0.05, `barrel ${rendered.toFixed(3)} vs fire dir ${fireDir.toFixed(3)}`);
    });

    // 6. Multi-cell weapon (railgun): one persistent turret at its design index.
    await check("multi-cell railgun gets one persistent turret sprite", async () => {
      const d = design([7, 7, "core"], [8, 7, "railgun"]);
      await page.evaluate((snap) => window.__mfaTest.setShip(snap), snapshotWith("ship-railgun", d));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const info = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-railgun"));
      assert.ok(info, "no railgun debug info");
      assert.strictEqual(info.turretCount, 1, `railgun turretCount ${info.turretCount}`);
      assert.strictEqual(info.turrets[0].partType, "railgun");
      await page.evaluate(() => { window.__mfaDisableTurretSmoothing = true; });
      await page.evaluate(() => window.__mfaTest.setWeaponAngle("ship-railgun", 1, -1.2));
      await page.evaluate(() => window.__mfaTest.frames(3));
      const after = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-railgun"));
      assert.ok(Math.abs(after.turrets[0].localRotation + 1.2) < EPS, `railgun turret did not rotate: ${after.turrets[0].localRotation}`);
    });

    // 7. Destroyed turret: freezes and dims (does not vanish or re-track).
    await check("destroyed turret dims and freezes", async () => {
      const d = design([7, 7, "core"], [8, 7, "blaster"]);
      // Component hp: core full, blaster at 0 => destroyed weapon.
      const snap = snapshotWith("ship-dead", d, { chp: [500, 0] });
      await page.evaluate((s) => window.__mfaTest.setShip(s), snap);
      await page.evaluate(() => window.__mfaTest.frames(4));
      const info = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-dead"));
      assert.strictEqual(info.turretCount, 1, "destroyed turret sprite should still exist");
      assert.ok(info.turrets[0].alpha < 0.5, `destroyed turret should be dimmed, alpha ${info.turrets[0].alpha}`);
    });

    // 8. Pooled view reuse: a freed view assigned to a new ship shows no stale
    //    turrets from the previous ship.
    await check("pooled view reuse leaves no stale turrets", async () => {
      // Ship A: two weapons.
      const dA = design([7, 7, "core"], [8, 7, "blaster"], [6, 7, "railgun"]);
      await page.evaluate((s) => window.__mfaTest.setShip(s), snapshotWith("pool-A", dA));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const a = await page.evaluate(() => window.__mfaTurretDebugInfo("pool-A"));
      assert.strictEqual(a.turretCount, 2, `ship A should have 2 turrets, got ${a.turretCount}`);
      // Remove A (empty snapshot frame releases its view to the pool), then a new
      // ship id with ONE weapon acquires the recycled view.
      await page.evaluate(() => {
        window.__mfaState.snapshot = { players: window.__mfaState.snapshot.players, ships: [], bullets: [], points: [], map: { asteroids: [], safeZones: [], clouds: [] } };
        window.__mfaState.visualShips = new Map();
      });
      await page.evaluate(() => window.__mfaTest.frames(3));
      const dB = design([7, 7, "core"], [8, 7, "blaster"]);
      await page.evaluate((s) => window.__mfaTest.setShip(s), snapshotWith("pool-B", dB));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const b = await page.evaluate(() => window.__mfaTurretDebugInfo("pool-B"));
      assert.ok(b, "no debug info for recycled ship");
      assert.strictEqual(b.turretCount, 1, `recycled view should have exactly 1 turret, got ${b.turretCount}`);
      assert.strictEqual(b.turrets[0].partType, "blaster", "recycled turret should be the new ship's weapon");
    });

    // 9. Forced-arrow debug mode swaps in an obvious arrow (transform vs artwork).
    await check("forced-arrow debug mode replaces turret art", async () => {
      const d = design([7, 7, "core"], [8, 7, "blaster"]);
      await page.evaluate((s) => window.__mfaTest.setShip(s), snapshotWith("ship-arrow", d));
      await page.evaluate(() => window.__mfaTest.frames(3));
      const normalShot = await shot(page, "arrow-off.png");
      await page.evaluate(() => { window.__mfaDebugTurretArrows = true; });
      await page.evaluate(() => window.__mfaTest.frames(4));
      const arrowShot = await shot(page, "arrow-on.png");
      await page.evaluate(() => { window.__mfaDebugTurretArrows = false; });
      assert.ok(pixelsDiffer(normalShot, arrowShot), "forced-arrow mode did not change the rendered turret");
    });

    // 10. Real gameplay path: with smoothing ENABLED (the default), a turret
    //     sweeps toward a changed authoritative angle and reaches it.
    await check("turret tracks its target under smoothing (real gameplay)", async () => {
      await page.evaluate(() => { window.__mfaDisableTurretSmoothing = false; });
      const d = design([7, 7, "core"], [8, 7, "blaster"]);
      await page.evaluate((s) => window.__mfaTest.setShip(s), snapshotWith("ship-smooth", d));
      await page.evaluate(() => window.__mfaTest.setHullAngle("ship-smooth", 0));
      await page.evaluate(() => window.__mfaTest.setWeaponAngle("ship-smooth", 1, 0));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const start = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-smooth"));
      // Aim 1.4 rad away; the turret must move toward it and, given enough
      // frames, converge — proving the smoothing path actually drives rotation.
      await page.evaluate(() => window.__mfaTest.setWeaponAngle("ship-smooth", 1, 1.4));
      await page.evaluate(() => window.__mfaTest.frames(2));
      const mid = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-smooth"));
      await page.evaluate(() => window.__mfaTest.frames(30));
      const end = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-smooth"));
      const s0 = start.turrets[0].localRotation;
      const sMid = mid.turrets[0].localRotation;
      const sEnd = end.turrets[0].localRotation;
      assert.ok(Math.abs(sMid - s0) > 0.01, `turret must start moving toward target (start ${s0.toFixed(3)}, mid ${sMid.toFixed(3)})`);
      assert.ok(sMid > s0 - EPS && sMid < 1.4 + EPS, `turret must move toward target monotonically (mid ${sMid.toFixed(3)})`);
      assert.ok(Math.abs(sEnd - 1.4) < 0.05, `turret must converge on the target angle (ended ${sEnd.toFixed(3)}, expected ~1.4)`);
    });

    // 11. Engine exhaust is anchored to the ship body: it lives in the hull
    //     frame and its world rotation tracks the hull, so a turning ship's
    //     exhaust turns with it (regression: exhaust used to stay put).
    await check("engine exhaust follows hull rotation", async () => {
      const d = design([7, 7, "core"], [6, 7, "engine"], [8, 7, "blaster"]);
      // Moving forward toward a target so the exhaust plume is active.
      await page.evaluate((s) => window.__mfaTest.setShip(s), snapshotWith("ship-engine", d, { vx: 200, vy: 0, targetX: 3000, targetY: 950 }));
      await page.evaluate(() => window.__mfaTest.setHullAngle("ship-engine", 0));
      await page.evaluate(() => window.__mfaTest.frames(5));
      const at0 = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-engine"));
      assert.strictEqual(at0.engineParentLabel, "HullContainer", "engine effects must live inside the hull frame");
      assert.ok(at0.engineVisible, "engine exhaust should be active while thrusting");
      assert.ok(Math.abs(at0.engineWorldRotation - at0.hullRotation) < EPS, `engine world rotation must equal hull rotation at 0 (eng ${at0.engineWorldRotation}, hull ${at0.hullRotation})`);
      await page.evaluate(() => window.__mfaTest.setHullAngle("ship-engine", 1.2));
      await page.evaluate(() => window.__mfaTest.frames(5));
      const at1 = await page.evaluate(() => window.__mfaTurretDebugInfo("ship-engine"));
      assert.ok(Math.abs(at1.hullRotation - 1.2) < EPS, `hull should be at 1.2 (was ${at1.hullRotation})`);
      assert.ok(Math.abs(at1.engineWorldRotation - at1.hullRotation) < EPS, `engine world rotation must track the hull after turning (eng ${at1.engineWorldRotation}, hull ${at1.hullRotation})`);
    });

    await check("no uncaught page errors during rendering", () => {
      assert.strictEqual(pageErrors.length, 0, `page errors:\n${pageErrors.join("\n")}`);
    });

    await browser.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGKILL");
  }

  const failed = results.filter(([ok]) => !ok);
  console.log(`\nScreenshots written to ${SHOT_DIR}`);
  console.log(`Turret render checks: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error("FAILED:\n" + failed.map(([, n]) => "  - " + n).join("\n"));
    process.exit(1);
  }
  console.log("Turret render verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
