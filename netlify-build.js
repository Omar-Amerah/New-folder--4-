"use strict";

const fs = require("fs");
const path = require("path");

// 1. Bundle src files into client.js
const srcDir = path.join(__dirname, "public", "src");
const clientJsPath = path.join(__dirname, "public", "client.js");

const srcFiles = [
  "constants.js",
  "shared/math.js",
  "shared/movementStats.js",
  "shared/formatting.js",
  "shared/ids.js",
  "shared/componentHeatSnapshot.js",
  "design/rotation.js",
  "design/statFormatting.js",
  "design/parts.js",
  "design/footprint.js",
  "design/componentStats.js",
  "design/blueprintValidation.js",
  "design/blueprintStorage.js",
  "design/thermalAnalysis.js",
  "state.js",
  "ui/dom.js",
  "ui/toastUi.js",
  "ui/partPaletteUi.js",
  "ui/partInspectorUi.js",
  "ui/savedBlueprintsUi.js",
  "ui/purchaseUi.js",
  "ui/hudUi.js",
  "ui/sidePanelUi.js",
  "ui/scoreboardUi.js",
  "ui/endGameUi.js",
  "ui/lobbyUi.js",
  "ui/designerUi.js",
  "ui/designerScreenUi.js",
  "ui/componentIcon.js",
  "ui/shipThumbnail.js",
  "game/interpolation.js",
  "game/camera.js",
  "game/selection.js",
  "game/componentDamage.js",
  "game/commands.js",
  "game/input.js",
  "game/renderSettings.js",
  "game/debugOverlay.js",
  "game/shipGeometry.js",
  "game/shipVitals.js",
  "game/weaponAim.js",
  "game/componentArt.js",
  "game/shipDynamics.js",
  "game/renderInterpolation.js",
  "game/viewportCulling.js",
  "game/componentDamageCanvas.js",
  "game/worldArt.js",
  "ui/shipDamagePanelUi.js",
  "game/pixi/pixiBake.js",
  "game/pixi/pixiScreenUi.js",
  "game/pixi/pixiWorld.js",
  "game/pixi/pixiShipView.js",
  "game/pixi/pixiShips.js",
  "game/pixi/pixiRenderer.js",
  "game/renderController.js",
  "network.js",
  "messages.js",
  "main.js"
];

try {
  let bundledCode = `"use strict";\n\n`;

  for (const filename of srcFiles) {
    const filePath = path.join(srcDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Source file missing for bundle: ${filename}`);
    }
    let content = fs.readFileSync(filePath, "utf8");

    // Remove "use strict"; from individual files
    content = content.replace(/"use strict";\r?\n?/g, "");
    content = content.replace(/'use strict';\r?\n?/g, "");

    // Strip imports (single-line and multi-line imports)
    content = content.replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm, "");
    content = content.replace(/^\s*import\s+["'][^"']+["'];?\s*$/gm, "");

    // Strip exports, but preserve the definitions
    content = content.replace(/^\s*export\s+const\s+/gm, "const ");
    content = content.replace(/^\s*export\s+let\s+/gm, "let ");
    content = content.replace(/^\s*export\s+function\s+/gm, "function ");
    content = content.replace(/^\s*export\s+async\s+function\s+/gm, "async function ");
    content = content.replace(/^\s*export\s+class\s+/gm, "class ");
    content = content.replace(/^\s*export\s+default\s+/gm, "");
    // Remove standalone exports like export { ... };
    content = content.replace(/^\s*export\s*\{[\s\S]*?\};?$/gm, "");

    bundledCode += `// --- Module: ${filename} ---\n` + content.trim() + "\n\n";
  }

  fs.writeFileSync(clientJsPath, bundledCode, "utf8");
  console.log("Successfully bundled public/client.js from public/src/");
} catch (err) {
  console.error("Bundling failed:", err);
  process.exit(1);
}

// 1b. Vendor the PixiJS browser ESM bundle (served as .js because the server MIME map has no .mjs entry)
const pixiSource = path.join(__dirname, "node_modules", "pixi.js", "dist", "pixi.min.mjs");
const vendorDir = path.join(__dirname, "public", "vendor");
const pixiVendorPath = path.join(vendorDir, "pixi.min.js");
if (fs.existsSync(pixiSource)) {
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.copyFileSync(pixiSource, pixiVendorPath);
  console.log("Vendored pixi.js to public/vendor/pixi.min.js");
} else if (fs.existsSync(pixiVendorPath)) {
  console.warn("node_modules/pixi.js missing; keeping existing public/vendor/pixi.min.js");
} else {
  console.error("pixi.js is not installed and no vendored copy exists — run npm install first.");
  process.exit(1);
}

// 1c. Vendor the MessagePack UMD browser bundle (exposes window.MessagePack) so
// the client can decode the binary WebSocket snapshots the server now sends.
const msgpackSource = path.join(__dirname, "node_modules", "@msgpack", "msgpack", "dist.umd", "msgpack.min.js");
const msgpackVendorPath = path.join(vendorDir, "msgpack.min.js");
if (fs.existsSync(msgpackSource)) {
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.copyFileSync(msgpackSource, msgpackVendorPath);
  console.log("Vendored @msgpack/msgpack to public/vendor/msgpack.min.js");
} else if (fs.existsSync(msgpackVendorPath)) {
  console.warn("node_modules/@msgpack/msgpack missing; keeping existing public/vendor/msgpack.min.js");
} else {
  console.error("@msgpack/msgpack is not installed and no vendored copy exists — run npm install first.");
  process.exit(1);
}

// 2. Perform Netlify asset checks
const requiredFiles = [
  path.join(__dirname, "public", "index.html"),
  path.join(__dirname, "public", "client.js"),
  path.join(__dirname, "public", "styles.css"),
  path.join(__dirname, "public", "vendor", "pixi.min.js"),
  path.join(__dirname, "public", "vendor", "msgpack.min.js"),
  path.join(__dirname, "public", "src", "shared", "turretRules.js")
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error("Missing required Netlify asset: " + file);
  }
}

fs.writeFileSync(path.join(__dirname, "public", "blueprint-fix.js"), "\"use strict\";\n");

console.log("Netlify static assets are ready in public/");
