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
          x: 1693,
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

    await check("enemy bodies use an inward-only soft alpha mask and overlays fade with the centre", async () => {
      const result = await page.evaluate(async () => {
        const { sensorVisibilityAlpha, visibilityAlphaAtPoint } = await import("/src/game/pixi/pixiFog.js");
        const env = typeof window.__mfaGetPixiEnv === "function" ? window.__mfaGetPixiEnv() : null;
        const mask = env?.layers?.enemyVisibilityMask;
        const source = { x: 1600, y: 950, range: 100, shape: "circle" };
        const canvas = mask?.texture?.source?.resource || mask?.texture?.source?._resource || null;
        const context = canvas?.getContext?.("2d") || null;
        const sample = (x, y) => {
          if (!context || !canvas || !(mask?.width > 0) || !(mask?.height > 0)) return null;
          const px = Math.max(0, Math.min(canvas.width - 1, Math.round(x / mask.width * canvas.width)));
          const py = Math.max(0, Math.min(canvas.height - 1, Math.round(y / mask.height * canvas.height)));
          return context.getImageData(px, py, 1, 1).data[3] / 255;
        };
        const overlays = env?.layers?.shipOverlays?.children || [];
        const enemyOverlay = overlays.find((child) => Math.abs((child.position?.x || 0) - 1693) < 1);
        return {
          maskConstructor: mask?.constructor?.name || null,
          maskType: window.__mfaVisibilityMaskDiagnostics?.().maskType || null,
          maskTextureIsCanvas: Boolean(canvas && context),
          innerTextureAlpha: sample(1650, 950),
          fadeTextureAlpha: sample(1690, 950),
          boundaryTextureAlpha: sample(1700, 950),
          innerAlpha: visibilityAlphaAtPoint(1650, 950, [source]),
          fadeAlpha: visibilityAlphaAtPoint(1693, 950, [source]),
          boundaryAlpha: visibilityAlphaAtPoint(1700, 950, [source]),
          formulaStart: sensorVisibilityAlpha(86, 100),
          formulaMid: sensorVisibilityAlpha(93, 100),
          formulaEnd: sensorVisibilityAlpha(100, 100),
          overlayAlpha: enemyOverlay?.alpha ?? null,
          overlayVisible: enemyOverlay?.visible ?? null
        };
      });
      if (result.maskConstructor === "Graphics") throw new Error("enemy visibility mask is still Graphics-backed");
      if (result.maskType !== "sprite-alpha") throw new Error(`expected sprite-alpha mask, got ${result.maskType}`);
      if (!result.maskTextureIsCanvas) throw new Error("expected a canvas-backed alpha texture");
      if (!(result.innerTextureAlpha > 0.9)) throw new Error(`inner body alpha was ${result.innerTextureAlpha}`);
      if (!(result.fadeTextureAlpha > 0.1 && result.fadeTextureAlpha < 0.9)) throw new Error(`fade body alpha was ${JSON.stringify(result)}`);
      if (!(result.boundaryTextureAlpha <= 0.05)) throw new Error(`boundary body alpha was ${result.boundaryTextureAlpha}`);
      if (result.innerAlpha !== 1 || Math.abs(result.fadeAlpha - 0.5) > 0.001 || result.boundaryAlpha !== 0) {
        throw new Error(`visibility alpha formula mismatch: ${JSON.stringify(result)}`);
      }
      if (result.formulaStart !== 1 || Math.abs(result.formulaMid - 0.5) > 0.001 || result.formulaEnd !== 0) {
        throw new Error(`sensorVisibilityAlpha mismatch: ${JSON.stringify(result)}`);
      }
      if (!(result.overlayAlpha > 0.01 && result.overlayAlpha < 0.99 && result.overlayVisible)) {
        throw new Error(`expected a partially faded visible overlay: ${JSON.stringify(result)}`);
      }
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
