"use strict";

const fs = require("fs");
const path = require("path");

// 1. Emit the frontend build SHA as a tiny classic script loaded before the
// app so both the ES-module dev build and the bundled client report the same
// build. Netlify provides COMMIT_REF; local builds fall back to git, then "dev".
function resolveFrontendBuildSha() {
  const fromEnv = process.env.MFA_BUILD_SHA || process.env.COMMIT_REF || "";
  if (fromEnv) return String(fromEnv).trim();
  try {
    const { execSync } = require("child_process");
    const sha = execSync("git rev-parse HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (sha) return sha;
  } catch {
    // Not a git checkout.
  }
  return "dev";
}
const frontendBuildSha = resolveFrontendBuildSha();
fs.writeFileSync(
  path.join(__dirname, "public", "build-sha.js"),
  `globalThis.__MFA_BUILD_SHA__ = ${JSON.stringify(frontendBuildSha)};\n`,
  "utf8"
);
console.log(`Frontend build SHA: ${frontendBuildSha}`);

// 2. Vendor the PixiJS browser ESM bundle (served as .js because the server MIME map has no .mjs entry)
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

// 3. Vendor the MessagePack UMD browser bundle (exposes window.MessagePack) so
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

// 4. Perform Netlify asset checks
const requiredFiles = [
  path.join(__dirname, "public", "index.html"),
  path.join(__dirname, "public", "styles.css"),
  path.join(__dirname, "public", "vendor", "pixi.min.js"),
  path.join(__dirname, "public", "vendor", "msgpack.min.js"),
  path.join(__dirname, "public", "src", "shared", "turretRules.js"),
  path.join(__dirname, "public", "src", "shared", "protocolVersion.js"),
  path.join(__dirname, "public", "build-sha.js")
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) {
    throw new Error("Missing required Netlify asset: " + file);
  }
}

console.log("Netlify static assets are ready in public/");
