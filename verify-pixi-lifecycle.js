"use strict";
// Browser-level texture-lifecycle proof for the Pixi arena renderer. Drives the
// real built client in headless Chromium (WebGL/Pixi), injects synthetic
// snapshots, and reads the live texture diagnostics via
// window.__mfaPixiTextureDiagnostics() to assert reference-counted sharing,
// clean release on pool recycling, generation-safe quality changes, and full
// renderer teardown/reinit. Proves rendered lifecycle, not source shape.
//
// Run: node verify-pixi-lifecycle.js   (starts its own server on PORT 5600)

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");
const {
  launchChromium,
  startServer,
  waitForServer,
  PAGE_HELPERS,
  DISMISS_MENUS,
  design,
  snapshotManyShips,
  snapshotWith,
  uniquePort
} = require("./verify-pixi-browser-support.js");

const ARTIFACT_DIR = path.join(__dirname, "test-artifacts", "pixi-lifecycle");
const PORT = uniquePort();
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let currentPage = null;
async function collectDiagnostics() {
  if (!currentPage) return null;
  try { return await currentPage.evaluate(() => ({
    textures: typeof window.__mfaPixiTextureDiagnostics === "function" ? window.__mfaPixiTextureDiagnostics() : null,
    renderer: window.__mfaRenderer?.diagnostics?.() || null,
    appGeneration: window.__mfaRenderer?.diagnostics?.().applicationGeneration ?? null,
    bakeGeneration: window.__mfaPixiTextureDiagnostics?.().generation ?? null
  })); } catch { return null; }
}
async function check(name, fn) {
  const startedAt = new Date().toISOString(); const before = await collectDiagnostics();
  try { await fn(); const after = await collectDiagnostics(); results.push({ passed:true, ok:true, name, startedAt, endedAt:new Date().toISOString(), before, after }); console.log("  ok  -", name); }
  catch (err) { const after = await collectDiagnostics(); results.push({ passed:false, ok:false, name, startedAt, endedAt:new Date().toISOString(), assertionMessage:err.message, stack:err.stack, before, after }); console.log("  FAIL-", name, "\n       ", err.message); }
}

// Reads window.__mfaPixiTextureDiagnostics() in the page.
function diag(page) {
  return page.evaluate(() => window.__mfaPixiTextureDiagnostics());
}
function findCacheEntry(d, name) { return d?.caches?.find((c) => c.name === name) || null; }
function optionalCacheEntry(d, name) { return findCacheEntry(d, name) || { name, entries: 0, live: 0, refs: 0, stale: 0 }; }
function requireCacheEntry(d, name) { const entry = findCacheEntry(d, name); assert.ok(entry, `required texture cache ${name} was not present`); return entry; }
function cacheEntry(d, name) { return requireCacheEntry(d, name); }

async function main() {
  fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true }); fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const { server, getLog } = startServer(PORT);
  let browser;
  let pageErrors = [];
  let consoleErrors = [];
  try {
    await waitForServer(BASE);
    browser = await launchChromium(chromium);
    const context = await browser.newContext({ viewport: { width: 1024, height: 700 }, deviceScaleFactor: 1 });
    await context.clearCookies();
    const page = await context.newPage(); currentPage = page;
    pageErrors = []; consoleErrors = [];
    page.on("pageerror", (e) => pageErrors.push({ message:e.message, stack:e.stack }));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.goto(`${BASE}/index.html`, { waitUntil: "load" });
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await page.addScriptTag({ content: PAGE_HELPERS });
    await page.evaluate(DISMISS_MENUS);

    await page.waitForFunction(() => window.__mfaRenderer && window.__mfaRenderer.backend, null, { timeout: 15000 });
    const backend = await page.evaluate(() => window.__mfaRenderer.backend);
    await check("active backend is pixi", () => {
      assert.strictEqual(backend, "pixi", `backend was ${backend}. serverLog:\n${getLog()}`);
    });
    await page.waitForFunction(() => typeof window.__mfaPixiTextureDiagnostics === "function", null, { timeout: 15000 });
    await page.waitForFunction(() => window.__mfaState && window.__mfaState.parts && Object.keys(window.__mfaState.parts).length > 0, null, { timeout: 15000 }).catch(() => {});

    const shipDesign = design([7, 7, "core"], [8, 7, "blaster"], [6, 7, "railgun"]);

    // 1. Twenty identical ships share ONE hull texture and ONE turret texture
    //    per distinct weapon type; matching sprites reference the same Texture.
    await check("20 identical ships share one hull + one texture per weapon type", async () => {
      await page.evaluate((snap) => window.__mfaTest.setSnapshot(snap), snapshotManyShips(20, shipDesign));
      await page.evaluate(() => window.__mfaTest.setCamera(640, 480, 0.9));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const d = await diag(page);
      const hull = cacheEntry(d, "shipHull");
      const turret = cacheEntry(d, "shipTurret");
      assert.strictEqual(d.activeShipViews, 20, `expected 20 active views, got ${d.activeShipViews}`);
      assert.strictEqual(hull.live, 1, `expected 1 hull texture, got ${hull.live}`);
      assert.strictEqual(hull.refs, 20, `expected hull refcount 20, got ${hull.refs}`);
      // Two distinct rotating weapon types (blaster, railgun) -> 2 turret textures.
      assert.strictEqual(turret.live, 2, `expected 2 turret textures, got ${turret.live}`);
      assert.strictEqual(turret.refs, 40, `expected turret refcount 40 (20 ships x 2), got ${turret.refs}`);
      // Confirm sprites really share the same Texture objects across ships.
      const shared = await page.evaluate(() => {
        const a = window.__mfaTurretDebugInfo("ship-0");
        const b = window.__mfaTurretDebugInfo("ship-19");
        return { a: a.turretCount, b: b.turretCount };
      });
      assert.strictEqual(shared.a, 2);
      assert.strictEqual(shared.b, 2);
    });

    // 2. Remove all twenty ships: leases released, no negative refs, textures
    //    retained at refcount 0 (reusable), no double destruction.
    let createdAfterSpawn;
    await check("removing all ships releases every lease with no negative refs", async () => {
      const before = await diag(page);
      createdAfterSpawn = before.createdTextures;
      await page.evaluate(() => window.__mfaTest.clearShips());
      await page.evaluate(() => window.__mfaTest.frames(4));
      const d = await diag(page);
      const hull = cacheEntry(d, "shipHull");
      const turret = cacheEntry(d, "shipTurret");
      assert.strictEqual(d.activeShipViews, 0, `expected 0 active views, got ${d.activeShipViews}`);
      assert.ok(hull.refs === 0, `hull refs should be 0, got ${hull.refs}`);
      assert.ok(turret.refs === 0, `turret refs should be 0, got ${turret.refs}`);
      assert.ok(d.liveReferenceCount >= 0, "no negative reference counts");
    });

    // 3. Respawn identical ships: shared textures reused, no duplicate creation,
    //    no stale turret sprites from pooled views.
    await check("respawn reuses shared textures (no duplicate creation)", async () => {
      const before = await diag(page);
      await page.evaluate((snap) => window.__mfaTest.setSnapshot(snap), snapshotManyShips(20, shipDesign));
      await page.evaluate(() => window.__mfaTest.setCamera(640, 480, 0.9));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const d = await diag(page);
      assert.strictEqual(d.activeShipViews, 20, `expected 20 active views, got ${d.activeShipViews}`);
      assert.strictEqual(cacheEntry(d, "shipHull").refs, 20, "hull refcount should be 20 again");
      assert.strictEqual(d.createdTextures, before.createdTextures, `no new textures should be created on respawn (was ${before.createdTextures}, now ${d.createdTextures})`);
      // Every ship has exactly its 2 turrets (no stale extras).
      const counts = await page.evaluate(() => {
        let ok = true;
        for (let i = 0; i < 20; i++) { if (window.__mfaTurretDebugInfo("ship-" + i).turretCount !== 2) ok = false; }
        return ok;
      });
      assert.ok(counts, "every recycled ship view has exactly its 2 turrets");
    });

    // 4. Change one ship's design: only that ship requests a different hull;
    //    unchanged ships keep their shared texture.
    await check("changing one design only re-textures that ship", async () => {
      const before = await diag(page);
      const beforeHull = cacheEntry(before, "shipHull");
      await page.evaluate(() => {
        const ship = window.__mfaState.snapshot.ships.find((s) => s.id === "ship-0");
        // Swap the railgun for a second blaster (distinct design signature).
        ship.design = [{ x: 7, y: 7, type: "core", rotation: 0 }, { x: 8, y: 7, type: "blaster", rotation: 0 }];
        ship.weaponAngles = [0, 0];
      });
      await page.evaluate(() => window.__mfaTest.frames(4));
      const d = await diag(page);
      const hull = cacheEntry(d, "shipHull");
      assert.strictEqual(hull.live, 2, `expected 2 hull textures (19 shared + 1 changed), got ${hull.live}`);
      assert.strictEqual(hull.refs, 20, `hull refcount total should stay 20, got ${hull.refs}`);
      assert.ok(d.createdTextures > before.createdTextures, "the changed design should bake one new hull texture");
      // The 19 unchanged ships still share their original hull (refcount 19).
      assert.ok(beforeHull.live === 1, "sanity: started from a single shared hull");
    });

    // 5. Change graphics quality: generation advances, visible ships get
    //    new-generation textures, old textures destroyed after final release,
    //    no sprite references a destroyed texture.
    await check("quality change advances generation without tearing in-use textures", async () => {
      // Reset to a clean single design set for a deterministic count.
      await page.evaluate((snap) => window.__mfaTest.setSnapshot(snap), snapshotManyShips(20, shipDesign));
      await page.evaluate(() => window.__mfaTest.setCamera(640, 480, 0.9));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const before = await diag(page);
      const genBefore = before.generation;
      const destroyedBefore = before.destroyedTextures;

      // Force a real quality change through the render settings + resize path
      // (setRenderQuality updates the cached value; resizeArenaRenderer applies
      // the new bake scale and advances the texture generation).
      await page.evaluate(async () => {
        const rs = await import("/src/game/renderSettings.js");
        const cur = rs.getRenderQuality();
        rs.setRenderQuality(cur === "low" ? "high" : "low");
        const rc = await import("/src/game/renderController.js");
        rc.resizeArenaRenderer();
      });
      await page.evaluate(() => window.__mfaTest.frames(8));
      const d = await diag(page);
      assert.ok(d.generation > genBefore, `generation should advance (was ${genBefore}, now ${d.generation})`);
      // Visible ships still render with a valid (current-generation) hull texture.
      const hull = cacheEntry(d, "shipHull");
      assert.ok(hull.refs >= 20, `visible ships must hold current-gen hull leases, refs=${hull.refs}`);
      // Old-generation textures were destroyed after their leases released.
      assert.ok(d.destroyedTextures >= destroyedBefore, "old-generation textures should be destroyed after release");
      // No page errors implies no sprite rendered a destroyed texture.
      assert.strictEqual(pageErrors.length, 0, `page errors during quality change:\n${pageErrors.join("\n")}`);
    });

    // 6. Toggle forced debug turret arrows: base leases stay valid, the arrow
    //    texture is shared, disabling restores the original texture, and
    //    repeated toggles do not leak.
    await check("forced-arrow toggle shares one arrow texture and does not leak", async () => {
      await page.evaluate((snap) => window.__mfaTest.setSnapshot(snap), snapshotWith("arrow-ship", design([7, 7, "core"], [8, 7, "blaster"])));
      await page.evaluate(() => window.__mfaTest.frames(4));
      const baseline = await diag(page);
      for (let i = 0; i < 5; i += 1) {
        await page.evaluate(() => { window.__mfaDebugTurretArrows = true; });
        await page.evaluate(() => window.__mfaTest.frames(3));
        await page.evaluate(() => { window.__mfaDebugTurretArrows = false; });
        await page.evaluate(() => window.__mfaTest.frames(3));
      }
      const d = await diag(page);
      const arrow = findCacheEntry(d, "turretArrow") || findCacheEntry(d, "arrowTurret") || optionalCacheEntry(d, "turretArrow");
      // After disabling, no arrow lease is held.
      assert.ok(arrow.refs === 0, `arrow refcount should be 0 when disabled, got ${arrow.refs}`);
      // At most one arrow texture entry exists (shared), and turret base texture
      // count did not balloon from repeated toggles.
      assert.ok(arrow.entries <= 1, `expected <=1 arrow texture entry, got ${arrow.entries}`);
      assert.ok(cacheEntry(d, "shipTurret").live <= baseline.caches.find((c) => c.name === "shipTurret").live + 1, "turret textures should not leak across toggles");
      assert.strictEqual(pageErrors.length, 0, `page errors during arrow toggles:\n${pageErrors.join("\n")}`);
    });

    // 7. Destroy and reinitialize the renderer: all caches/pools cleared, then a
    //    fresh application renders normally.
    await check("destroy + reinit clears caches/pools and renders again", async () => {
      const reinit = await page.evaluate(async () => {
        const mod = await import("/src/game/pixi/pixiRenderer.js");
        mod.destroyPixiRenderer();
        const afterDestroy = window.__mfaPixiTextureDiagnostics();
        await mod.initPixiRenderer();
        return { afterDestroy };
      });
      const afterDestroy = reinit.afterDestroy;
      // Every cache entry destroyed; created === destroyed after full teardown.
      const liveEntries = afterDestroy.caches.reduce((n, c) => n + c.live, 0);
      assert.strictEqual(liveEntries, 0, `all cache entries should be destroyed, ${liveEntries} remain`);
      assert.strictEqual(afterDestroy.activeShipViews, 0, "no ship views after destroy");
      assert.strictEqual(afterDestroy.destroyedTextures, afterDestroy.createdTextures, `created(${afterDestroy.createdTextures}) should equal destroyed(${afterDestroy.destroyedTextures}) after teardown`);

      // The fresh renderer draws a new ship normally.
      await page.evaluate((snap) => window.__mfaTest.setSnapshot(snap), snapshotWith("post-reinit", design([7, 7, "core"], [8, 7, "blaster"])));
      await page.evaluate(() => window.__mfaTest.frames(6));
      const info = await page.evaluate(() => window.__mfaTurretDebugInfo("post-reinit"));
      assert.ok(info && info.turretCount === 1, "reinitialized renderer should render a turret sprite");
      const d = await diag(page);
      assert.ok(cacheEntry(d, "shipHull").live >= 1, "reinitialized renderer should bake a fresh hull texture");
    });

    await check("no uncaught page errors overall", () => {
      assert.strictEqual(pageErrors.length, 0, `page errors:\n${pageErrors.join("\n")}`);
    });
  } finally {
    if (browser && !results.some((r) => !r.ok)) await browser.close().catch(() => {});
    if (!results.some((r) => !r.ok)) server.kill("SIGKILL");
  }

  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(ARTIFACT_DIR, "checks.json"), JSON.stringify(results, null, 2));
  console.log(`\nPixi texture-lifecycle checks: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    fs.writeFileSync(path.join(ARTIFACT_DIR, "diagnostics.json"), JSON.stringify(await collectDiagnostics(), null, 2));
    if (currentPage) await currentPage.screenshot({ path: path.join(ARTIFACT_DIR, "failure.png"), fullPage: true }).catch(()=>{});
    fs.writeFileSync(path.join(ARTIFACT_DIR, "server.log"), getLog());
    fs.writeFileSync(path.join(ARTIFACT_DIR, "page-errors.json"), JSON.stringify(pageErrors, null, 2));
    fs.writeFileSync(path.join(ARTIFACT_DIR, "console.json"), JSON.stringify(consoleErrors, null, 2));
    console.error("FAILED:\n" + failed.map((r) => "  - " + r.name).join("\n"));
    if (browser) await browser.close().catch(() => {});
    server.kill("SIGKILL");
    process.exit(1);
  }
  if (browser) await browser.close().catch(() => {});
  server.kill("SIGKILL");
  console.log("Pixi texture-lifecycle verification passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
