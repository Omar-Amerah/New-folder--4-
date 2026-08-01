"use strict";
// Partial enemy-ship visibility mask verifier.
//
// Drives the built client in a headless Chromium/Pixi renderer, injects
// synthetic snapshots with a friendly sensor source and an enemy ship, and
// asserts that the shared visibility mask is built and that at least one enemy
// ship is placed in the masked body layer. A screenshot is saved for manual
// visual confirmation.
//
// Run: node verify-partial-visibility-mask.js   (starts its own server)

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  launchChromium,
  startServer,
  waitForServer,
  PAGE_HELPERS,
  DISMISS_MENUS,
  design,
  defaultArtifactDir
} = require("./verify-pixi-browser-support.js");

const PORT = Number(process.env.TEST_PORT || 5600);
const BASE = `http://127.0.0.1:${PORT}`;
const ARTIFACTS = defaultArtifactDir("partial-visibility");

const results = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push([true, name]); console.log("  ok  -", name); },
    (err) => { results.push([false, name]); console.log("  FAIL-", name, "\n       ", err.message); }
  );
}

function maskDiagnostics(page) {
  return page.evaluate(() => window.__mfaVisibilityMaskDiagnostics ? window.__mfaVisibilityMaskDiagnostics() : null);
}

async function main() {
  const { server, getLog } = startServer(PORT);
  let browser;
  try {
    await waitForServer(BASE);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
    await page.addScriptTag({ content: PAGE_HELPERS });
    await page.evaluate(DISMISS_MENUS);

    await page.waitForFunction(() => typeof window.__mfaVisibilityMaskDiagnostics === "function", null, { timeout: 15000 });
    await page.waitForFunction(() => window.__mfaState && window.__mfaState.parts && Object.keys(window.__mfaState.parts).length > 0, null, { timeout: 15000 }).catch(() => {});

    const largeDesign = design([0,0,"core"], [1,0,"blaster"], [2,0,"blaster"], [3,0,"blaster"], [4,0,"blaster"], [-1,0,"blaster"]);

    const snapshot = {
      players: [
        { id: "p1", name: "Friendly", color: "#38d5ff", design: largeDesign, team: "alpha" },
        { id: "p2", name: "Enemy", color: "#ef4444", design: largeDesign, team: "beta" }
      ],
      ships: [
        {
          id: "sensor-source",
          ownerId: "p1",
          x: 1600,
          y: 950,
          vx: 0,
          vy: 0,
          angle: 0,
          radius: 40,
          alive: true,
          hp: 500,
          maxHp: 500,
          shield: 0,
          maxShield: 0,
          design: largeDesign,
          weaponAngles: largeDesign.map(() => 0),
          sensorRange: 100,
          team: "alpha"
        },
        {
          id: "straddler",
          ownerId: "p2",
          x: 1670,
          y: 950,
          vx: 0,
          vy: 0,
          angle: 0,
          radius: 60,
          alive: true,
          hp: 500,
          maxHp: 500,
          shield: 0,
          maxShield: 0,
          design: largeDesign,
          weaponAngles: largeDesign.map(() => 0),
          team: "beta"
        }
      ],
      bullets: [],
      points: [],
      map: { asteroids: [], safeZones: [], clouds: [] }
    };

    await page.evaluate((snap) => {
      window.__mfaTest.setSnapshot(snap);
      window.__mfaState.rules = { visibilityMode: "sensors" };
    }, snapshot);
    await page.evaluate(() => window.__mfaTest.frames(6));

    let d = await maskDiagnostics(page);
    await check("visibility-mask diagnostics API is populated", () => {
      if (!d) throw new Error("__mfaVisibilityMaskDiagnostics() did not return data");
      if (!d.enabled) throw new Error("expected mask to be enabled in sensor visibility mode");
      if (d.maskBuilds < 1) throw new Error("expected at least one mask build");
      if (d.sourceCount < 1) throw new Error("expected at least one sensor source in mask");
      if (d.maskedEnemyShipCount < 1) throw new Error("expected at least one masked enemy ship");
    });

    await check("enemy ship is in the masked body layer and friendly ship is not", async () => {
      const counts = await page.evaluate(() => {
        const env = typeof window.__mfaGetPixiEnv === "function" ? window.__mfaGetPixiEnv() : null;
        return {
          friendly: env?.layers?.friendlyShipBodies?.children?.length || 0,
          enemy: env?.layers?.enemyShipBodiesMasked?.children?.length || 0,
          overlays: env?.layers?.shipOverlays?.children?.length || 0
        };
      });
      if (counts.enemy < 1) throw new Error(`expected enemy ship in masked layer, got ${counts.enemy}`);
      if (counts.friendly < 1) throw new Error(`expected friendly ship in friendly layer, got ${counts.friendly}`);
      if (counts.overlays < 1) throw new Error(`expected ship overlay root, got ${counts.overlays}`);
    });

    await check("screenshot captured for visual review", async () => {
      const shot = path.join(ARTIFACTS, "straddler-screenshot.png");
      fs.mkdirSync(ARTIFACTS, { recursive: true });
      await page.screenshot({ path: shot });
      console.log("        screenshot saved to", shot);
    });

    if (pageErrors.length) {
      console.log("\n  page errors captured during test:", pageErrors.slice(0, 5));
    }
  } finally {
    try { await browser?.close(); } catch {}
    try { server.kill(); } catch {}
  }

  const passed = results.filter(([, ok]) => ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nserver log tail:\n", getLog().slice(-4000));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
