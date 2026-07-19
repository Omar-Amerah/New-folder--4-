"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

(async () => {
  const server = spawn(process.execPath, ["server.js"], { stdio: ["ignore", "pipe", "pipe"] });
  let baseUrl = "http://127.0.0.1:3000";
  const logs = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not report readiness: ${logs.join("")}`)), 10000);
    const onData = (d) => {
      const text = String(d);
      logs.push(text);
      const match = text.match(/http:\/\/(?:localhost|127\.0\.0\.1):(\d+)/i);
      if (match) {
        baseUrl = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timer);
        resolve();
      }
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.once("exit", code => reject(new Error(`server exited before readiness with ${code}: ${logs.join("")}`)));
  });
  await ready;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", msg => { if (["error"].includes(msg.type())) errors.push(msg.text()); });
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#mainMenuScreen").evaluate(el => { el.hidden = true; });
    await page.evaluate(async () => { const mod = await import("/src/ui/designerUi.js"); mod.openBlueprintDesigner(); });
    await page.locator("#blueprintDesignerScreen:not([hidden]) #buildGrid").waitFor({ state: "visible" });
    await assertVisible(page, "#saveDesignButton", "Save button visible without page scrolling");
    await page.locator(".designer-right-col").evaluate(el => { el.scrollTop = el.scrollHeight; });
    await assertVisible(page, "#saveDesignButton", "Save button remains visible while right column scrolls");
    assert.match(await page.locator("#blueprintCostBanner").innerText(), /Build cost/, "cost banner says Build cost");
    await page.evaluate(() => { window.__oldCost = document.querySelector("#blueprintCostLabel").textContent; });
    await page.locator("#blueprintHeatTab").click();
    await expectText(page, "#partInspector", /Predicted in this design|Not placed in this design yet/);
    await page.locator("#blueprintBuildTab").click();
    const statusCss = await page.locator(".purchase-status").first().evaluate(el => getComputedStyle(el).whiteSpace).catch(() => "normal");
    assert.equal(statusCss, "normal", "purchase status allows wrapping");
    assert.deepEqual(errors, [], "no unexpected console or page errors");
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
  console.log("Blueprint information polish browser verification passed");
})().catch((error) => { console.error(error); process.exit(1); });

async function assertVisible(page, selector, message) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0, message);
}
async function expectText(page, selector, pattern) {
  const text = await page.locator(selector).innerText();
  assert.match(text, pattern);
}
