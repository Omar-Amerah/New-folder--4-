import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { launchChromium, startServer, waitForServer, uniqueRoom } from './verify-pixi-browser-support.js';
import { setupActiveMatch, writeFailureArtifacts } from './verify-active-match-browser-support.js';

const require = createRequire(import.meta.url);
const PORT = Number(process.env.TEST_PORT || 5750);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { server, getLog } = startServer(PORT);
  let browser;
  try {
    await waitForServer(BASE);
    browser = await launchChromium(chromium);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1.5 });
    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];

    page.on('console', (m) => {
      if (m.type() === 'error' && !/WebGL context lost/.test(m.text())) {
        consoleErrors.push(m.text());
      }
    });
    page.on('pageerror', (e) => {
      console.error('Pageerror caught:', e.message);
      pageErrors.push(e.message);
    });

    console.log('Starting PixiJS Active Match Quality Switch Browser Verification Test...');

    const setup = await setupActiveMatch(page, {
      baseUrl: BASE,
      room: uniqueRoom('qsw'),
      bots: 3,
      startingMoney: 14000,
      scenario: 'quality-switch'
    });

    await page.evaluate(() => window.__mfaSetRendererMetricsPhase('steady', { reset: true }));
    await sleep(500);

    // Initial check: active match rendering ships, turrets, bullets, asteroids, nebulas
    const beforeDiag = await page.evaluate(() => window.__mfaRenderer.diagnostics());
    assert.ok(beforeDiag.initialized, 'Renderer initialized');
    assert.strictEqual(beforeDiag.fatalFrameError, null, 'No initial fatal frame error');

    // 1. Sequential Quality Switches: High -> Low -> Medium -> High
    const sequence = ['high', 'low', 'medium', 'high'];
    for (const targetQuality of sequence) {
      console.log(`  Testing quality switch to: ${targetQuality.toUpperCase()}`);
      await page.evaluate((q) => {
        localStorage.setItem('mfa.renderQuality', q);
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new Event('resize'));
      }, targetQuality);

      await sleep(400);

      const d = await page.evaluate(() => window.__mfaRenderer.diagnostics());
      assert.strictEqual(d.tickerStarted, true, `Ticker active on quality ${targetQuality}`);
      assert.strictEqual(d.fatalFrameError, null, `No fatal error on quality ${targetQuality}`);
      
      const fatalPanelCount = await page.locator('#pixiFatalErrorPanel').count();
      assert.strictEqual(fatalPanelCount, 0, `No fatal error panel DOM element on quality ${targetQuality}`);

      // Verify visible sprites have valid, non-null TextureSource
      const spriteCheck = await page.evaluate(() => {
        const app = window.__mfaEnv?.app;
        if (!app) return { count: 0, invalidCount: 0 };
        let count = 0;
        let invalidCount = 0;
        const check = (node) => {
          if (!node) return;
          if (node.isSprite || node.texture) {
            count++;
            const tex = node.texture;
            if (tex && (tex.destroyed || !tex.source || tex.source.destroyed)) {
              invalidCount++;
            }
          }
          if (node.children) {
            for (const child of node.children) check(child);
          }
        };
        check(app.stage);
        return { count, invalidCount };
      });

      assert.strictEqual(spriteCheck.invalidCount, 0, `All ${spriteCheck.count} visible Sprites have valid TextureSource`);
    }

    // 2. Rapid repeated quality changes in quick succession
    console.log('  Testing rapid repeated quality changes...');
    await page.evaluate(async () => {
      const rapidSequence = ['low', 'high', 'medium', 'low', 'high', 'medium', 'high'];
      for (const q of rapidSequence) {
        localStorage.setItem('mfa.renderQuality', q);
        window.dispatchEvent(new Event('storage'));
        window.dispatchEvent(new Event('resize'));
        await new Promise((r) => setTimeout(r, 15));
      }
    });

    await sleep(600);

    const afterRapid = await page.evaluate(() => window.__mfaRenderer.diagnostics());
    assert.strictEqual(afterRapid.tickerStarted, true, 'Ticker remains active after rapid quality changes');
    assert.strictEqual(afterRapid.fatalFrameError, null, 'No fatal frame error after rapid quality changes');
    assert.strictEqual(await page.locator('#pixiFatalErrorPanel').count(), 0, 'No fatal panel after rapid changes');

    for (const cache of afterRapid.textures.caches) {
      assert.strictEqual(cache.duplicateReleases, 0, `Cache '${cache.name}' has 0 duplicate releases`);
    }

    // 3. Assert zero uncaught pageerrors or alphaMode exceptions
    const alphaErrors = pageErrors.filter((e) => e.includes('alphaMode') || e.includes('TextureSource'));
    assert.strictEqual(alphaErrors.length, 0, `Expected 0 alphaMode/TextureSource errors, got: ${alphaErrors.join('; ')}`);
    assert.strictEqual(pageErrors.length, 0, `Expected 0 page errors, got: ${pageErrors.join('; ')}`);
    assert.strictEqual(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);

    console.log('\nAll PixiJS Active Match Quality Change Browser Verification Tests Passed Successfully!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
  }
}

main();
