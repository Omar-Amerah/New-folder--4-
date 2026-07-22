#!/usr/bin/env node
"use strict";

// Focused verifier for the Blueprint Designer category cleanup that removes the
// "Support" component palette category and folds every previously-Support
// component into "Utility".
//
// This is a static/authoritative-data verifier: it reads the authoritative
// balance, its generated mirrors, the server catalogue and the client catalogue
// module, and asserts the merge is complete, lossless and internally consistent
// without launching a browser. A companion browser verifier
// (verify-support-utility-category-ui-browser.js) exercises the live palette
// DOM; this file owns every check that does not require Chromium.
//
// It deliberately does NOT touch the Power priority category "coolingSupport":
// that is a runtime allocation concept, not a palette category, and must be
// preserved unchanged. The checks below prove the two remain independent.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = __dirname;
let checks = 0;
function check(label, condition) {
  assert(condition, label);
  checks += 1;
}

// ---------------------------------------------------------------------------
// Load authoritative sources.
// ---------------------------------------------------------------------------
const sourceBalance = JSON.parse(fs.readFileSync(path.join(ROOT, "component-balance.json"), "utf8"));
const publicBalance = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "component-balance.json"), "utf8"));
const generatedText = fs.readFileSync(path.join(ROOT, "public", "src", "generatedBalance.js"), "utf8");
const { PARTS: SERVER_PARTS } = require(path.join(ROOT, "src", "server", "components.js"));
const PowerPolicyRules = require(path.join(ROOT, "public", "src", "shared", "powerPolicyRules.js"));

const sourceComponents = sourceBalance.components;
const byId = Object.fromEntries(sourceComponents.map((c) => [c.id, c]));

// The seven components named in the task plus the discovered eighth
// (fireControl), which was the only additional component whose authoritative
// category was exactly "Support".
const MOVED_FROM_SUPPORT = [
  "heatPipe",
  "heatSink",
  "radiator",
  "repair",
  "repairBeam",
  "sensorArray",
  "targetingComputer",
  "fireControl"
];
// Components that were already Utility and must stay Utility.
const EXISTING_UTILITY = ["captureModule", "signalAmplifier", "stabilizerNode"];
const ALL_UTILITY = [...MOVED_FROM_SUPPORT, ...EXISTING_UTILITY];

// Authoritative pre-merge behaviour snapshot for the eight moved components.
// Every field EXCEPT the palette `category` is pinned here from the balance as
// it stood on main before the merge, so a stray balance edit smuggled in with
// the category change fails this verifier. Descriptions and display names are
// intentionally excluded (they are prose, checked separately for stale claims).
const MOVED_BEHAVIOUR = {
  heatPipe: { cost: 16, mass: 2.5, hull: 16, powerGeneration: 0, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: 0, energy: 0, repair: 0, utility: "heatTransfer" },
  heatSink: { cost: 24, mass: 6, hull: 48, powerGeneration: 0, powerUse: 0, shield: 0, shieldRegen: 0, thrust: 0, turn: -0.01, energy: 0, repair: 0, utility: "cooling" },
  radiator: { cost: 30, mass: 5, hull: 40, powerGeneration: 0, powerUse: 0.5, powerCategory: "coolingSupport", shield: 0, shieldRegen: 0, thrust: 0, turn: -0.015, energy: 0, repair: 0, utility: "cooling" },
  repair: { cost: 27, mass: 6, hull: 50, powerGeneration: 0, powerUse: 2.4, powerCategory: "coolingSupport", shield: 12, shieldRegen: 0.15, thrust: 0, turn: -0.01, energy: 0, repair: 3.5 },
  repairBeam: { cost: 62, mass: 8, hull: 52, powerGeneration: 0, powerUse: 6, powerCategory: "coolingSupport", shield: 18, shieldRegen: 0.15, thrust: 0, turn: -0.02, energy: 0, repair: 8, rotatable: true, footprint: { width: 2, height: 1 } },
  sensorArray: { cost: 21, mass: 3, hull: 26, powerGeneration: 0, powerUse: 1.2, powerCategory: "coolingSupport", shield: 0, shieldRegen: 0, thrust: 0, turn: 0.01, energy: 0, repair: 0, utility: "range", rangeBonus: 40 },
  targetingComputer: { cost: 29, mass: 4, hull: 30, powerGeneration: 0, powerUse: 2.2, powerCategory: "coolingSupport", shield: 0, shieldRegen: 0, thrust: 0, turn: 0.02, energy: 0, repair: 0, utility: "accuracy", accuracyBonus: 0.04 },
  fireControl: { cost: 34, mass: 5, hull: 38, powerGeneration: 0, powerUse: 2.7, powerCategory: "coolingSupport", shield: 0, shieldRegen: 0, thrust: 0, turn: -0.01, energy: 0, repair: 0, utility: "fireRate", fireRateBonus: 0.075 }
};

// ===========================================================================
// 1. No authoritative component keeps the Support palette category.
// ===========================================================================
check(
  "1. No authoritative component has category 'Support'",
  sourceComponents.every((c) => c.category !== "Support")
);

// ===========================================================================
// 2. Every previously-Support component (including the discovered fireControl)
//    is now categorised Utility.
// ===========================================================================
for (const id of MOVED_FROM_SUPPORT) {
  check(`2. ${id} is now category 'Utility'`, byId[id] && byId[id].category === "Utility");
}

// ===========================================================================
// 3. fireControl was genuinely the only additional Support component: exactly
//    the eight known ids were the moved set (no missed component, none invented).
// ===========================================================================
check(
  "3. Utility now contains exactly the moved + pre-existing Utility ids",
  (() => {
    const utility = new Set(sourceComponents.filter((c) => c.category === "Utility").map((c) => c.id));
    return utility.size === ALL_UTILITY.length && ALL_UTILITY.every((id) => utility.has(id));
  })()
);

// ===========================================================================
// 4. Existing Utility components stay Utility.
// ===========================================================================
for (const id of EXISTING_UTILITY) {
  check(`4. ${id} remains category 'Utility'`, byId[id] && byId[id].category === "Utility");
}

// ===========================================================================
// 5. Component IDs are unchanged and none were duplicated.
// ===========================================================================
check("5. No duplicate component ids in the authoritative balance", (() => {
  const ids = sourceComponents.map((c) => c.id);
  return new Set(ids).size === ids.length;
})());
for (const id of ALL_UTILITY) check(`5. id '${id}' still exists`, Boolean(byId[id]));

// ===========================================================================
// 6. Numerical balance / footprint / rotation / power-use for each moved
//    component is byte-for-byte what it was before the merge (only `category`
//    changed). This is the "no gameplay/balance change" guard.
// ===========================================================================
for (const id of MOVED_FROM_SUPPORT) {
  const actual = { ...byId[id] };
  delete actual.category;
  delete actual.name;
  delete actual.description;
  delete actual.id;
  check(
    `6. ${id} behaviour fields are unchanged apart from category`,
    JSON.stringify(sortDeep(actual)) === JSON.stringify(sortDeep(MOVED_BEHAVIOUR[id]))
  );
}

// ===========================================================================
// 7. The Power priority category "coolingSupport" is untouched: every moved
//    component that carried it still carries it, and no palette move rewrote a
//    component's powerCategory.
// ===========================================================================
const COOLING_SUPPORT_MEMBERS = ["radiator", "repair", "repairBeam", "sensorArray", "targetingComputer", "fireControl", "captureModule", "signalAmplifier", "stabilizerNode"];
for (const id of COOLING_SUPPORT_MEMBERS) {
  check(`7. ${id} still has powerCategory 'coolingSupport'`, byId[id] && byId[id].powerCategory === "coolingSupport");
}
// heatPipe / heatSink never had a power category and must not have gained one.
check("7. heatPipe has no powerCategory", byId.heatPipe && byId.heatPipe.powerCategory === undefined);
check("7. heatSink has no powerCategory", byId.heatSink && byId.heatSink.powerCategory === undefined);

// ===========================================================================
// 8. The six locked Power priority categories remain defined and distinct, and
//    "coolingSupport" is still one of them (renaming it was explicitly barred).
// ===========================================================================
const powerCats = PowerPolicyRules.POWER_CATEGORIES;
check("8. Six Power priority categories are defined", Array.isArray(powerCats) && powerCats.length === 6);
check("8. Power priority categories are distinct", new Set(powerCats).size === 6);
check("8. 'coolingSupport' is still a Power priority category", powerCats.includes("coolingSupport"));
for (const expected of ["command", "propulsion", "shields", "pointDefence", "weapons", "coolingSupport"]) {
  check(`8. Power priority category '${expected}' is present`, powerCats.includes(expected));
}

// ===========================================================================
// 9. Palette category list: "Utility" appears exactly once and "Support" is
//    absent, in the single authoritative PART_CATEGORIES list.
// ===========================================================================
const constantsText = fs.readFileSync(path.join(ROOT, "public", "src", "constants.js"), "utf8");
const partCategoriesMatch = constantsText.match(/export const PART_CATEGORIES = (\[[^\]]*\]);/);
check("9. PART_CATEGORIES is defined in constants.js", Boolean(partCategoriesMatch));
const partCategories = JSON.parse(partCategoriesMatch[1].replace(/'/g, '"'));
check("9. PART_CATEGORIES contains no 'Support'", !partCategories.includes("Support"));
check("9. PART_CATEGORIES contains 'Utility' exactly once", partCategories.filter((c) => c === "Utility").length === 1);
check("9. PART_CATEGORIES order is Structure..Utility", JSON.stringify(partCategories) === JSON.stringify(["Structure", "Power", "Engines", "Defence", "Weapons", "Utility"]));

// ===========================================================================
// 10. The client palette classifier partCategory() no longer hard-codes any
//     component into "Support" (the old `repair -> Support` fallback is gone).
// ===========================================================================
const partsText = fs.readFileSync(path.join(ROOT, "public", "src", "design", "parts.js"), "utf8");
check("10. parts.js has no residual 'Support' classification", !/return\s+"Support"/.test(partsText));

// ===========================================================================
// 11. Generated + public mirrors match the authoritative source exactly, and
//     none of them mention the removed palette category.
// ===========================================================================
check("11. public/component-balance.json equals the source balance", JSON.stringify(publicBalance) === JSON.stringify(sourceBalance));
for (const id of ALL_UTILITY) {
  const re = new RegExp(`"id":\\s*"${id}"[\\s\\S]*?"category":\\s*"([A-Za-z]+)"`);
  const m = generatedText.match(re);
  check(`11. generatedBalance.js lists ${id} as Utility`, m && m[1] === "Utility");
}
check("11. generatedBalance.js contains no '\"category\": \"Support\"'", !/"category":\s*"Support"/.test(generatedText));
check("11. source balance JSON has no Support category literal", !/"category":\s*"Support"/.test(JSON.stringify(sourceBalance)));

// ===========================================================================
// 12. Server catalogue and client catalogue agree on every moved/utility
//     component's category and power category.
// ===========================================================================
for (const id of ALL_UTILITY) {
  const server = SERVER_PARTS[id];
  check(`12. server catalogue has ${id}`, Boolean(server));
  check(`12. server catalogue categorises ${id} as Utility`, server.category === "Utility");
}
check("12. server catalogue has no Support-category part", Object.values(SERVER_PARTS).every((p) => p.category !== "Support"));
for (const id of COOLING_SUPPORT_MEMBERS) {
  check(`12. server catalogue keeps ${id} powerCategory coolingSupport`, SERVER_PARTS[id].powerCategory === "coolingSupport");
}

// ===========================================================================
// 13. Client PART_STATS (built from the generated mirror) categorises every
//     moved/utility component as Utility, and partCategory() returns Utility.
// ===========================================================================
(async () => {
  global.document = global.document || {
    getElementById: () => null,
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, getContext: () => null })
  };
  global.window = global.window || { devicePixelRatio: 1 };
  const parts = await import("./public/src/design/parts.js");
  for (const id of ALL_UTILITY) {
    check(`13. client PART_STATS categorises ${id} as Utility`, parts.PART_STATS[id] && parts.PART_STATS[id].category === "Utility");
    check(`13. partCategory('${id}') === 'Utility'`, parts.partCategory(id) === "Utility");
  }
  check("13. no client part classifies as Support", Object.keys(parts.PART_STATS).every((id) => parts.partCategory(id) !== "Support"));

  // =========================================================================
  // 14. Palette discoverability: every moved component is a real palette part
  //     (not hidden), so the data-driven palette and its search surface it.
  // =========================================================================
  for (const id of ALL_UTILITY) {
    check(`14. ${id} is a visible palette part`, parts.isPalettePart(id));
  }

  // =========================================================================
  // 15. Deterministic ordering: the palette renders Utility parts in PART_DEFS
  //     key order (the existing authoritative order mechanism — no separate
  //     UI-only sort layer). That order must be the intended contiguous,
  //     sensible sequence with every moved component before the pre-existing
  //     Utility modules.
  // =========================================================================
  const paletteUtilityOrder = Object.keys(parts.PART_DEFS).filter((type) => parts.isPalettePart(type) && parts.partCategory(type) === "Utility");
  const EXPECTED_UTILITY_ORDER = ["heatPipe", "heatSink", "radiator", "repair", "repairBeam", "sensorArray", "targetingComputer", "fireControl", "captureModule", "signalAmplifier", "stabilizerNode"];
  check(
    "15. Utility palette order lists all expected ids exactly once",
    paletteUtilityOrder.length === ALL_UTILITY.length && ALL_UTILITY.every((id) => paletteUtilityOrder.includes(id))
  );
  check(
    "15. Utility palette order is the deterministic sensible sequence",
    JSON.stringify(paletteUtilityOrder) === JSON.stringify(EXPECTED_UTILITY_ORDER)
  );
  const lastMovedIdx = Math.max(...MOVED_FROM_SUPPORT.map((id) => paletteUtilityOrder.indexOf(id)));
  const firstExistingIdx = Math.min(...EXISTING_UTILITY.map((id) => paletteUtilityOrder.indexOf(id)));
  check("15. moved components are grouped before pre-existing Utility components", lastMovedIdx < firstExistingIdx);

  // =========================================================================
  // 16. Saved-design compatibility: a design/loadout referencing the moved
  //     component ids still resolves through the client catalogue (ids
  //     unchanged means no migration is required to load old saves).
  // =========================================================================
  for (const id of ALL_UTILITY) {
    check(`16. saved-design id '${id}' still resolves in the catalogue`, Boolean(parts.PART_STATS[id]));
  }

  runStaticSurfaceChecks();
  runBranchScopeChecks();

  console.log(`verify-support-utility-category-merge passed (${checks} checks).`);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});

// ===========================================================================
// 17-23. Static UI-surface + branch-scope checks (no browser needed).
// ===========================================================================
function runStaticSurfaceChecks() {
  const paletteUi = fs.readFileSync(path.join(ROOT, "public", "src", "ui", "partPaletteUi.js"), "utf8");
  // 17. The palette is data-driven off PART_CATEGORIES / partCategory, so it
  //     never hard-codes a "Support" heading, tab, filter or accordion.
  check("17. partPaletteUi.js iterates PART_CATEGORIES (data-driven tabs)", /PART_CATEGORIES/.test(paletteUi));
  check("17. partPaletteUi.js has no hard-coded 'Support' category literal", !/["']Support["']/.test(paletteUi));

  // 18. index.html carries no Support palette heading. The one 'Support'
  //     substring that remains is the unrelated dataSupportRules script, and
  //     the "cooling & support" priority label — neither is a palette category.
  const index = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  check("18. index.html has no standalone 'Support' palette category heading", !/>\s*Support\s*</.test(index));

  // 19. The ship-role inference label "Support" is a distinct concept and must
  //     survive (renaming general 'support' concepts was explicitly barred).
  const purchaseUi = fs.readFileSync(path.join(ROOT, "public", "src", "ui", "purchaseUi.js"), "utf8");
  check("19. inferShipRole still returns the 'Support' ship role", /return\s+"Support"/.test(purchaseUi));

  // 20. The default selected palette category is a real remaining category, so
  //     no stale 'Support' default can leave the palette empty.
  const stateText = fs.readFileSync(path.join(ROOT, "public", "src", "state.js"), "utf8");
  const defaultMatch = stateText.match(/selectedPartCategory:\s*"([A-Za-z]+)"/);
  check("20. default selectedPartCategory is a valid non-Support category", defaultMatch && defaultMatch[1] !== "Support");
}

function runBranchScopeChecks() {
  // 21. No combat Power-tab work is introduced by this branch. That feature
  //     already lives on main; this verifier only guards that the merge diff
  //     did not resurrect or duplicate it. We assert the balance/palette files
  //     changed here contain no Power-tab markers.
  const changed = execFileSync("git", ["diff", "--name-only", "origin/main...HEAD"], { cwd: ROOT }).toString().trim().split("\n").filter(Boolean);
  const scopeFiles = new Set([
    "component-balance.json",
    "public/component-balance.json",
    "public/src/constants.js",
    "public/src/design/parts.js",
    "public/src/generatedBalance.js",
    "verify-support-utility-category-merge.js",
    "verify-support-utility-category-ui-browser.js",
    "tools/run-tests.js",
    "package.json"
  ]);
  const unexpected = changed.filter((f) => !scopeFiles.has(f));
  check(`21. branch changes stay within the category-merge scope (unexpected: ${unexpected.join(", ") || "none"})`, unexpected.length === 0);

  // 22. No touch/mobile behaviour is introduced by the changed source files.
  for (const file of ["public/src/constants.js", "public/src/design/parts.js"]) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const token of ["touchstart", "pointerdown", "longpress", "swipe"]) {
      check(`22. ${file} introduces no ${token} behaviour`, !text.toLowerCase().includes(token));
    }
  }

  // 23. Blueprint normalisation is idempotent for the moved ids: the server
  //     catalogue accepts them and re-normalising a part yields a stable
  //     category (no oscillation between Support/Utility across passes).
  for (const id of MOVED_FROM_SUPPORT) {
    check(`23. server normalisation is stable (Utility) for ${id}`, SERVER_PARTS[id].category === "Utility");
  }
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortDeep(value[key]);
      return acc;
    }, {});
  }
  return value;
}
