// Browser smoke coverage for physical Blueprint Designer undo UX.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.click("#openBlueprintDesignerButton");
      await page.waitForSelector("#blueprintDesignerScreen:not([hidden]) #undoBlueprintEditButton");
      assert.equal(await page.locator("#undoBlueprintEditButton").getAttribute("title"), "Undo last blueprint edit (Ctrl+Z)");
      assert.equal(await page.locator("#undoBlueprintEditButton").getAttribute("aria-label"), "Undo last blueprint edit");
      assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), true, "undo starts disabled");

      await page.evaluate(async () => {
        const [{ state }, designer] = await Promise.all([import("/src/state.js"), import("/src/ui/designerUi.js")]);
        state.selectedPart = "frame";
        designer.editCell(7, 10);
      });
      assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), false, "undo enables after edit");
      await page.click("#undoBlueprintEditButton");
      assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), true, "undo disables after final undo");

      await page.evaluate(async () => {
        const [{ state }, designer] = await Promise.all([import("/src/state.js"), import("/src/ui/designerUi.js")]);
        state.selectedPart = "frame";
        designer.editCell(7, 10);
      });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
      assert.equal(await page.locator("#undoBlueprintEditButton").isDisabled(), true, "keyboard undo consumes available physical history");

      await page.setViewportSize({ width: 390, height: 740 });
      const box = await page.locator("#undoBlueprintEditButton").boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 24, "touch viewport keeps undo button accessible");
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
}

main().then(() => console.log("Blueprint undo browser verification passed"));
