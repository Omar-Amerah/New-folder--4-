const { chromium } = require('playwright');
const { startServer, launchChromium } = require('../verify-pixi-browser-support.js');
const port = 9889;
const { server } = startServer(port);
(async () => {
  const browser = await launchChromium(chromium);
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/public/index.html`);
  await page.locator('#designerAnalysisTab').click();
  const panel = page.locator('#wiringStatusPanel');
  const dataAdvanced = page.locator('[data-wiring-details="advanced"]');
  if ((await dataAdvanced.getAttribute("open")) === null) await dataAdvanced.locator(":scope > summary").click();

  const authoritative = await page.evaluate(async () => {
    const [{ state }, { PART_STATS }] = await Promise.all([import('/src/state.js'), import('/src/design/parts.js')]);
    const analysis = globalThis.DesignDataSupportAnalysis.getCachedDesignDataSupport(state.design, state.wiring, PART_STATS, { thermalLoadMode: state.thermalLoadMode });
    const vulnerabilities = globalThis.DesignDataSupportAnalysis.getCachedDataVulnerabilities(state.design, state.wiring, PART_STATS, analysis);
    const criticalSections = vulnerabilities.filter((item) => item.kind === 'section' && item.severity === 'critical');
    return { criticalSectionId: criticalSections[0]?.id || null, criticalRecord: criticalSections[0] };
  });

  console.log('CRITICAL RECORD:', JSON.stringify(authoritative.criticalRecord, null, 2));
  const criticalHit = page.locator(`.wire-hit[data-section-id="${authoritative.criticalSectionId}"]`);
  await criticalHit.click();
  console.log('PANEL TEXT:', await panel.textContent());
  await browser.close();
  server.close();
})();
