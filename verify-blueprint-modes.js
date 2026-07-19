"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("public/index.html", "utf8");
const designer = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
const palette = fs.readFileSync("public/src/ui/partPaletteUi.js", "utf8");

assert.match(html, /id="blueprintBuildTab"[^>]*>Build<\/button>/, "Build tab keeps stable id with visible Build label");
assert.match(html, /id="blueprintHeatTab"[^>]*>Heat<\/button>/, "Heat tab is visible");
assert.match(html, /id="blueprintWiringTab"[^>]*>Wiring<\/button>/, "Wiring tab is visible");
assert.match(html, /id="blueprintModeContext"[\s\S]*id="blueprintModeTitle"[\s\S]*id="blueprintModeDescription"[\s\S]*id="blueprintModeControls"/, "stable mode context wraps authoritative controls");
assert.match(designer, /build:\s*\{ title: "Build", description: "Add, rotate and remove ship components\." \}/, "Build title/description are production data");
assert.match(designer, /heat:\s*\{ title: "Heat", description: "Build while viewing predicted component Heat and thermal flow\." \}/, "Heat title/description are production data");
assert.match(designer, /wiring:\s*\{ title: "Wiring", description: "Draw and edit Power or Data networks\. Component placement is paused\." \}/, "Wiring title/description are production data");
assert.match(designer, /export function isPhysicalBlueprintEditMode[\s\S]*mode === "build" \|\| mode === "heat"/, "physical edit helper includes Build and Heat");
assert.match(designer, /export function isPaletteBlueprintEditMode[\s\S]*mode === "build" \|\| mode === "heat"/, "palette edit helper includes Build and Heat");
assert.match(designer, /export function isWiringBlueprintEditMode[\s\S]*mode === "wiring"/, "wiring edit helper is explicit");
assert.match(designer, /export function isBlueprintRemovalMode[\s\S]*mode === "build"/, "removal helper is Build-only");
assert.match(designer, /if \(!isBlueprintRemovalMode\(\)\) return;[\s\S]*removeCell\(x, y\)/, "right-click removal is routed through Build-only helper");
assert.match(designer, /export function rotateFocusedPart\(\) \{\n  if \(!isBlueprintRotationMode\(\)\) return;/, "R rotation is mode-gated");
assert.match(designer, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/, "tablist keyboard navigation is registered");
assert.match(palette, /const locked = !isPaletteBlueprintEditMode\(\)/, "palette lock uses production mode helper");
assert.match(palette, /tab\.disabled = locked[\s\S]*button\.disabled = locked/, "palette lock uses disabled semantics");
assert.match(palette, /Component placement paused in Wiring mode[\s\S]*Switch to Build or Heat to add or change components/, "palette lock explanation is accessible text");

console.log("Blueprint modes verification passed");
