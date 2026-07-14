"use strict";
// Static guard for the PixiJS-only migration: fails if any remnant of the
// Canvas 2D arena backend or its runtime fallback survives in the client
// sources. Offscreen Canvas texture baking / UI artwork is explicitly allowed;
// only the deleted arena backend and its loop must be gone.

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "public", "src");
const failures = [];
function fail(msg) { failures.push(msg); }

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

// 1. The Canvas arena renderer file must be gone (no alias/shell).
if (fs.existsSync(path.join(SRC, "game", "renderer.js"))) {
  fail("public/src/game/renderer.js must be deleted (no Canvas arena renderer)");
}

// 2. The renderer-neutral / artwork replacement modules must exist.
for (const rel of [
  "game/renderInterpolation.js",
  "game/viewportCulling.js",
  "game/componentDamageCanvas.js",
  "game/worldArt.js"
]) {
  if (!fs.existsSync(path.join(SRC, rel))) fail(`expected module missing: public/src/${rel}`);
}

// 3. No source may import the deleted renderer, or reference the removed
//    fallback backend, loop, or canvas-2d arena APIs.
const forbidden = [
  { re: /from\s+["'][^"']*\/renderer\.js["']/, msg: 'import from a deleted renderer.js' },
  { re: /\bcanvas2d\b/, msg: 'reference to the removed "canvas2d" backend' },
  { re: /startCanvas2dFallback/, msg: 'reference to startCanvas2dFallback (removed fallback)' },
  { re: /mfa\.rendererBackend/, msg: 'reference to the removed mfa.rendererBackend override' },
  { re: /\bresizeCanvas\b/, msg: 'reference to the removed Canvas resizeCanvas()' },
  { re: /\brenderArena\b/, msg: 'reference to the removed renderArena()' },
  { re: /requestAnimationFrame\(\s*frame\s*\)/, msg: 'the removed Canvas animation loop' },
  { re: /\bacquireArenaCtx\b/, msg: 'reference to removed acquireArenaCtx()' },
  { re: /\breplaceArenaCanvasElement\b/, msg: 'reference to removed replaceArenaCanvasElement()' }
];

for (const file of listJsFiles(SRC)) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(__dirname, file);
  for (const { re, msg } of forbidden) {
    if (re.test(text)) fail(`${rel}: ${msg}`);
  }
}

// 4. The arena canvas must never acquire a 2D context in production runtime.
//    (Only offscreen/UI canvases get getContext("2d").)
const domSrc = fs.readFileSync(path.join(SRC, "ui", "dom.js"), "utf8");
if (/dom\.canvas\.getContext\(\s*["']2d["']/.test(domSrc)) {
  fail('public/src/ui/dom.js must not call getContext("2d") on the arena canvas');
}

// 5. renderController must be Pixi-only: sets backend "pixi", surfaces a WebGL
//    fatal message, and starts no alternative renderer.
const ctrl = fs.readFileSync(path.join(SRC, "game", "renderController.js"), "utf8");
if (!/backend:\s*["']pixi["']|activeBackend\s*=\s*["']pixi["']/.test(ctrl)) {
  fail("renderController must set the active backend to pixi");
}
if (!/WebGL/.test(ctrl)) {
  fail("renderController must surface a WebGL-required fatal message on init failure");
}

// 6. The build must not list the deleted files and must list the new modules.
const build = fs.readFileSync(path.join(__dirname, "netlify-build.js"), "utf8");
if (/game\/renderer\.js/.test(build)) fail("netlify-build.js must not bundle game/renderer.js");
for (const rel of ["game/renderInterpolation.js", "game/viewportCulling.js", "game/componentDamageCanvas.js", "game/worldArt.js"]) {
  if (!build.includes(rel)) fail(`netlify-build.js must bundle ${rel}`);
}

if (failures.length) {
  console.error("Canvas-arena-removal guard FAILED:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("Canvas-arena-removal guard passed: PixiJS is the only arena backend.");
