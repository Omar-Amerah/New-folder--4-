// Browser smoke coverage for physical Blueprint Designer undo UX.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assertNoClientErrors(errors) { assert.deepEqual(errors, [], `unexpected browser errors:\n${errors.join("\n")}`); }

async function main() {
  const server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let url = null;
  server.stdout.on("data", (chunk) => {
    const match = String(chunk).match(/http:\/\/localhost:(\d+)/);
    if (match) url = `http://localhost:${match[1]}`;
  });
  try {
    for (let i = 0; i < 80 && !url; i += 1) await wait(100);
    assert.ok(url, "server started");
    const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const clientErrors = [];
      page.on("pageerror", (error) => clientErrors.push(`pageerror: ${error.message}`));
      page.on("console", (message) => { if (message.type() === "error") clientErrors.push(`console.error: ${message.text()}`); });
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__mfaMainLoaded === true);
      await page.click("#openBlueprintDesignerButton");
      await page.waitForSelector("#blueprintDesignerScreen:not([hidden]) #undoBlueprintEditButton");
      assert.equal(await page.locator("#undoBlueprintEditButton").getAttribute("title"), "Undo last blueprint edit (Ctrl+Z)");
      assert.equal(await page.locator("#undoBlueprintEditButton").getAttribute("aria-label"), "Undo last blueprint edit");
      assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), true, "undo starts disabled");


      const noOpResetPreserved = await page.evaluate(async () => {
        const wiringUi = await import("/src/ui/wiringUi.js");
        window.__mfaState.loadedEditorBlueprintId = null;
        window.__mfaState.wiringUi.undoStack = [window.WiringRules.emptyWiring()];
        return wiringUi.canUndoWiring();
      });
      assert.equal(noOpResetPreserved, true, "browser setup has Wiring Undo before no-op Reset");
      await page.click("#resetButton");
      assert.equal(await page.evaluate(async () => (await import("/src/ui/wiringUi.js")).canUndoWiring()), true, "no-op Reset preserves Wiring Undo availability in browser");

      await page.evaluate(() => { window.__mfaState.selectedPart = "frame"; window.__mfaState.blueprintView = "build"; });
      await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
      const afterPlace = await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring }));
      assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "undo enables after first visible edit");

      await page.locator('.build-cell[data-x="9"][data-y="7"]').click({ button: "right" });
      assert.notEqual(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "second visible edit changes design");
      await page.click("#undoBlueprintEditButton");
      assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "Undo restores previous design and Wiring after remove");


      await page.evaluate(() => { window.__mfaState.wiringUi.undoStack = [window.WiringRules.emptyWiring()]; });
      await page.click("#resetButton");
      assert.equal(await page.evaluate(async () => (await import("/src/ui/wiringUi.js")).canUndoWiring()), false, "genuine Reset clears stale Wiring Undo in browser");
      assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "genuine Reset leaves physical Undo available in browser");
      await page.click("#undoBlueprintEditButton");
      assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "Undo restores ship after genuine Reset in browser");

      await page.click("#clearGridButton");
      assert.equal(await page.evaluate(() => window.__mfaState.design.length), 0, "Clear empties the current design");
      await page.click("#undoBlueprintEditButton");
      assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), afterPlace, "Undo restores entire ship after Clear");

      await page.evaluate(() => { window.__mfaState.selectedPart = "armor"; });
      await page.locator('.build-cell[data-x="8"][data-y="8"]').click();
      const beforeKeyboardUndo = afterPlace;
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
      assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), beforeKeyboardUndo, "keyboard Undo restores actual design state");

      const wiredBefore = await page.evaluate(async () => {
        const storage = await import("/src/design/blueprintStorage.js");
        window.__mfaState.design = storage.defaultDesign();
        window.__mfaState.wiring = storage.normalizeWiring(storage.defaultWiring(), window.__mfaState.design);
        window.__mfaState.selectedPart = "frame";
        const designer = await import("/src/ui/designerUi.js");
        designer.renderBuildGrid();
        return JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring });
      });
      await page.locator('.build-cell[data-x="6"][data-y="6"]').click();
      await page.click("#undoBlueprintEditButton");
      assert.equal(await page.evaluate(() => JSON.stringify({ design: window.__mfaState.design, wiring: window.__mfaState.wiring })), wiredBefore, "Undo restores known wired design snapshot");

      await page.setViewportSize({ width: 390, height: 740 });
      const box = await page.locator("#undoBlueprintEditButton").boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 24, "touch viewport keeps undo button accessible");
      assertNoClientErrors(clientErrors);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
}

main().then(() => console.log("Blueprint undo browser verification passed"));
