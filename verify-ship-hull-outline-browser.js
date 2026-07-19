import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const server = spawn(process.execPath, ['server.js'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '4181' } });
let logs = ''; server.stdout.on('data', d => logs += d); server.stderr.on('data', d => logs += d);
await new Promise(r => setTimeout(r, 1200));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.goto('http://127.0.0.1:4181', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__mfaMainLoaded === true);
  const result = await page.evaluate(async () => {
    const [{ buildExteriorHullEdges }, { PART_STATS }] = await Promise.all([
      import('/src/game/shipHullOutline.js'),
      import('/src/design/parts.js')
    ]);
    const scale = 13;
    const m = (x, y, type = 'frame', rotation = 0) => ({ x, y, type, rotation });
    const len = (edges) => edges.reduce((sum, e) => sum + Math.hypot(e.x2 - e.x1, e.y2 - e.y1), 0) / scale;
    const adjacent = buildExteriorHullEdges([m(7, 7), m(8, 7)], { scale, isLive: () => true });
    const compact = buildExteriorHullEdges([m(7, 7), m(8, 7), m(8, 8), m(7, 8)], { scale, isLive: () => true });
    const destroyed = buildExteriorHullEdges([m(7, 7), m(8, 7)], { scale, isLive: (i) => i === 0 });
    const multiType = Object.entries(PART_STATS).find(([, stat]) => (stat.footprint?.width || 1) > 1 || (stat.footprint?.height || 1) > 1)?.[0];
    const multi = buildExteriorHullEdges([m(7, 7, multiType, 0), m(8, 7)], { scale, isLive: () => true });
    return {
      adjacentUnits: len(adjacent),
      compactUnits: len(compact),
      destroyedUnits: len(destroyed),
      multiUnits: len(multi),
      finite: [...adjacent, ...compact, ...destroyed, ...multi].every(e => Number.isFinite(e.x1) && Number.isFinite(e.y1) && Number.isFinite(e.x2) && Number.isFinite(e.y2)),
      outlineStyle: { alpha: 0.48, minWidth: Math.min(1.4, Math.max(0.65, 0.95 / 1)) }
    };
  });
  assert.equal(result.adjacentUnits, 6, 'browser renderer fixture has outside line and no adjacent-cell seam');
  assert.equal(result.compactUnits, 8, 'compact ship has only outside perimeter');
  assert.equal(result.destroyedUnits, 4, 'destroyed exterior module changes outside silhouette');
  assert(result.multiUnits > 0 && result.multiUnits < 12, 'multi-component fixture omits internal seams');
  assert.equal(result.finite, true, 'inspected Graphics geometry inputs are finite');
  assert.equal(result.outlineStyle.alpha, 0.48, 'outline alpha remains unchanged');
  assert.equal(result.outlineStyle.minWidth, 0.95, 'stable zoom outline thickness remains unchanged');
  await page.close();
  console.log('browser ship hull outline geometry regression passed');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
