"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("public/index.html", "utf8");
const designer = fs.readFileSync("public/src/ui/designerUi.js", "utf8");
const purchase = fs.readFileSync("public/src/ui/purchaseUi.js", "utf8");
const inspector = fs.readFileSync("public/src/ui/partInspectorUi.js", "utf8");
const purchaseCss = fs.readFileSync("public/styles/purchase-ui.css", "utf8");
const layoutCss = fs.readFileSync("public/styles/blueprint-layout.css", "utf8");
const controlsCss = fs.readFileSync("public/styles/blueprint-controls.css", "utf8");

assert.match(html, /id="blueprintCostBanner"[\s\S]*Build cost/, "cost banner keeps existing id and says Build cost");
assert.match(designer, /Starting funds remaining: \$\$\{Math\.floor\(money - stats\.unitCost\)\.toLocaleString\(\)\}/, "starting-funds remaining wording is rendered from production stats");
assert.match(designer, /Need \$\$\{Math\.ceil\(stats\.unitCost - money\)\.toLocaleString\(\)\} more for starting ship/, "starting-ship unaffordable wording is specific");
assert.match(designer, /Funds after one purchase: \$\$\{Math\.floor\(money - stats\.unitCost\)\.toLocaleString\(\)\}/, "active-match cost wording is specific");
assert.doesNotMatch(html, /Current ship cost/, "old cost banner label was removed");
assert.match(designer, /stats\.unitCost\.toLocaleString\(\)/, "large build costs are formatted without abbreviation");

for (const phrase of ["Available to build", "Building…", "Complete your starting ship first", "Fleet full", "fleet slots", "Design invalid —", "Purchase failed —"]) {
  assert.ok(purchase.includes(phrase), `purchase card status includes ${phrase}`);
}
assert.match(purchase, /const statusText = purchaseStatusText\(optionState\);[\s\S]*setCardText\(card, "\.purchase-status", statusText\)/, "visible purchase status is authoritative");
assert.match(purchase, /aria-describedby/, "purchase cards expose status descriptions");
assert.match(purchaseCss, /purchase-status[\s\S]*white-space:\s*normal[\s\S]*-webkit-line-clamp:\s*3/, "purchase reasons wrap in a stable status area");
assert.match(purchase, /renderLoadoutTabs\(dom\.loadoutTabs, false\)/, "Loadout filtering path remains in purchase bar");

for (const phrase of ["Component identity", "Key stats", "Predicted in this design", "Thermal properties"]) {
  if (phrase === "Component identity") assert.match(inspector, /part-identity-section/, "inspector has identity section");
  else assert.ok(inspector.includes(phrase), `inspector includes ${phrase}`);
}
assert.match(inspector, /analyzeDesignHeat\(state\.design/, "inspector keeps existing thermal analysis path");
assert.match(inspector, /No Power requirement/, "non-applicable power zero is simplified");
assert.doesNotMatch(inspector, /inspectorStat\("Shield", formatShield\(stat\.shield\)\)/, "shield row is not blindly shown for every component");

assert.match(html, /class="designer-right-actions"[\s\S]*id="loadedBlueprintName"[\s\S]*id="saveDesignButton"/, "existing Save button lives in sticky right-column action area");
assert.equal((html.match(/id="saveDesignButton"/g) || []).length, 1, "Save button remains a single DOM element");
assert.match(designer, /loadedBlueprintName[\s\S]*Unsaved design/, "loaded design name context is updated");
assert.match(layoutCss, /\.designer-right-actions[\s\S]*position:\s*sticky/, "save action area is sticky");
assert.match(controlsCss, /blueprint-cost-banner[\s\S]*overflow-wrap:\s*anywhere/, "cost banner supports wrapping without clipping");

console.log("Blueprint information polish verification passed");
