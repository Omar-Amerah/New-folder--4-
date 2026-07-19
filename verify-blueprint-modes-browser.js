"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

(async () => {
  let chromium;
  try { ({ chromium } = require("playwright")); } catch (error) { throw new Error(`Playwright is required for browser mode verification: ${error.message}`); }
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", msg => { if (["error"].includes(msg.type())) errors.push(msg.text()); });
  try {
    await page.goto(`file://${process.cwd()}/public/index.html`);
    await page.waitForSelector("#blueprintBuildTab");
    assert.deepEqual(await page.$$eval('.blueprint-view-tabs [role="tab"]', tabs => tabs.map(t => t.textContent.trim())), ["Build", "Heat", "Wiring"]);
    assert.equal(await page.$eval("#blueprintBuildTab", el => el.getAttribute("aria-selected")), "true");
    const buildGrid = await page.$eval("#buildGrid", el => el.getBoundingClientRect().toJSON());
    await page.click("#blueprintHeatTab");
    assert.match(await page.textContent("#blueprintModeContext"), /Heat/);
    const heatGrid = await page.$eval("#buildGrid", el => el.getBoundingClientRect().toJSON());
    await page.click("#blueprintWiringTab");
    assert.match(await page.textContent("#blueprintModeContext"), /Wiring/);
    assert.match(await page.textContent("#partPalette"), /Component placement paused in Wiring mode/);
    const wiringGrid = await page.$eval("#buildGrid", el => el.getBoundingClientRect().toJSON());
    for (const rect of [heatGrid, wiringGrid]) {
      assert.ok(Math.abs(rect.x - buildGrid.x) <= 1 && Math.abs(rect.y - buildGrid.y) <= 1, "grid position stable");
      assert.ok(Math.abs(rect.width - buildGrid.width) <= 1 && Math.abs(rect.height - buildGrid.height) <= 1, "grid size stable");
    }
    assert.deepEqual(errors, []);
  } catch (error) {
    fs.mkdirSync("test-artifacts/blueprint-modes-browser", { recursive: true });
    await page.screenshot({ path: "test-artifacts/blueprint-modes-browser/failure.png", fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
  console.log("Blueprint modes browser verification passed");
})();
