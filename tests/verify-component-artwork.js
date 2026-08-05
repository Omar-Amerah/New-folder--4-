"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const {
  launchChromium,
  startServer,
  waitForServer,
  uniquePort
} = require("./verify-pixi-browser-support");

(async () => {
  const port = uniquePort();
  const base = `http://127.0.0.1:${port}`;
  const serverHandle = startServer(port);
  let browser;
  try {
    await waitForServer(base, 20000, serverHandle);
    browser = await launchChromium(chromium);
    const page = await browser.newPage({ viewport: { width: 980, height: 650 }, deviceScaleFactor: 1 });
    await page.goto(base, { waitUntil: "domcontentloaded" });

    const result = await page.evaluate(async () => {
      const { withCanvasContext } = await import("/src/ui/dom.js");
      const { drawFootprintComponent, drawModule } = await import("/src/game/componentArt.js");
      const { componentIconDataUrl } = await import("/src/ui/componentIcon.js");
      const { PART_STATS } = await import("/src/design/parts.js");
      const canvas = document.createElement("canvas");
      canvas.width = 980;
      canvas.height = 650;
      canvas.style.background = "#07101d";
      document.body.replaceChildren(canvas);
      const context = canvas.getContext("2d");
      context.fillStyle = "#07101d";
      context.fillRect(0, 0, canvas.width, canvas.height);

      const samples = [
        { type: "proximityDemolitionCharge", label: "DEMOLITION — SAFED", x: 165, y: 135, long: 3, cross: 2, color: "#f59e0b", state: "safed" },
        { type: "proximityDemolitionCharge", label: "DEMOLITION — ARMED", x: 495, y: 135, long: 3, cross: 2, color: "#f59e0b", state: "armed" },
        { type: "nuclearReactor", label: "NUCLEAR REACTOR", x: 825, y: 135, long: 3, cross: 2, color: "#facc15" },
        { type: "backupCore", label: "BACKUP CORE", x: 135, y: 345, long: 2, cross: 1, color: "#c4b5fd" },
        { type: "engine", label: "ENGINE", x: 365, y: 345, long: 2, cross: 1, color: "#54d7ff" },
        { type: "railgun", label: "RAILGUN", x: 645, y: 345, long: 3, cross: 1, color: "#f4f7ff" },
        { type: "droneBay", label: "DRONE BAY", x: 865, y: 345, long: 2, cross: 2, color: "#67e8f9" }
      ];

      withCanvasContext(context, () => {
        for (const sample of samples) {
          context.save();
          context.translate(sample.x, sample.y);
          drawFootprintComponent({
            type: sample.type,
            unit: 48,
            tilesLong: sample.long,
            tilesCross: sample.cross,
            color: sample.color,
            trim: "#e7eef8",
            visualState: sample.state
          });
          context.restore();
          context.fillStyle = "#d8e7fa";
          context.font = "700 11px system-ui";
          context.textAlign = "center";
          context.fillText(sample.label, sample.x, sample.y + sample.cross * 24 + 24);
        }

        for (const [index, state] of ["active", "inactive", "damaged"].entries()) {
          const x = 360 + index * 125;
          const y = 535;
          context.save();
          context.translate(x, y);
          drawModule({ x: 0, y: 0, size: 64, color: "#93c5fd", type: "decoyLauncher", visualState: state });
          context.restore();
          context.fillStyle = "#d8e7fa";
          context.font = "700 11px system-ui";
          context.textAlign = "center";
          context.fillText(`DECOY — ${state.toUpperCase()}`, x, y + 51);
        }
      });

      const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let changed = 0;
      for (let i = 0; i < image.length; i += 4) {
        if (image[i] !== 7 || image[i + 1] !== 16 || image[i + 2] !== 29) changed += 1;
      }
      const imageSize = (url) => new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = reject;
        image.src = url;
      });
      const rotations = {};
      for (const type of ["railgun", "beamEmitter", "swarmMissile", "torpedo"]) {
        rotations[type] = {
          zero: await imageSize(componentIconDataUrl(type, 0)),
          ninety: await imageSize(componentIconDataUrl(type, 90)),
          oneEighty: await imageSize(componentIconDataUrl(type, 180)),
          twoSeventy: await imageSize(componentIconDataUrl(type, 270))
        };
      }
      const multiCellIcons = {};
      for (const [type, stat] of Object.entries(PART_STATS)) {
        const footprint = stat.footprint || { width: 1, height: 1 };
        if ((footprint.width || 1) === 1 && (footprint.height || 1) === 1) continue;
        multiCellIcons[type] = await imageSize(componentIconDataUrl(type, 0));
      }

      const lower = document.createElement("canvas");
      lower.width = 490;
      lower.height = 325;
      lower.getContext("2d").drawImage(canvas, 0, 0, lower.width, lower.height);
      return {
        dataUrl: canvas.toDataURL("image/png"),
        lowerDataUrl: lower.toDataURL("image/png"),
        changed,
        rotations,
        multiCellIcons
      };
    });

    assert.ok(result.changed > 35000, "artwork should visibly occupy the sampled footprints");
    for (const [type, rotations] of Object.entries(result.rotations)) {
      assert.ok(rotations.zero.height > rotations.zero.width, `${type} 0° should use its tall footprint`);
      assert.ok(rotations.ninety.width > rotations.ninety.height, `${type} 90° should swap the footprint`);
      assert.deepStrictEqual(rotations.oneEighty, rotations.zero, `${type} 180° should retain footprint dimensions`);
      assert.deepStrictEqual(rotations.twoSeventy, rotations.ninety, `${type} 270° should retain swapped dimensions`);
    }
    assert.ok(Object.keys(result.multiCellIcons).length >= 12, "all catalogue multi-cell components should render");
    for (const [type, size] of Object.entries(result.multiCellIcons)) {
      assert.ok(size.width > 0 && size.height > 0, `${type} should bake a non-empty multi-cell icon`);
    }
    const outputDir = path.join(__dirname, "test-artifacts", "component-artwork");
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(outputDir, "footprint-machinery.png"),
      Buffer.from(result.dataUrl.replace(/^data:image\/png;base64,/, ""), "base64")
    );
    fs.writeFileSync(
      path.join(outputDir, "footprint-machinery-low-zoom.png"),
      Buffer.from(result.lowerDataUrl.replace(/^data:image\/png;base64,/, ""), "base64")
    );
    console.log("Component artwork verification passed.");
  } finally {
    if (browser) await browser.close();
    serverHandle.server.kill();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
