"use strict";

const assert = require("assert");

global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, appendChild(){}, getContext: () => null })
};
global.window = { devicePixelRatio: 1 };

(async () => {
  // Load HeatRules before importing ledgerContent so globalThis.HeatRules
  // is available when componentMechanics.js evaluates.
  const HeatRules = require("../public/src/shared/heatRules");

  const ledger = await import("../public/src/ledger/ledgerContent.js");
  const { SPECIAL_MECHANICS_COMPONENTS, LEDGER_RULE_CONTRACTS } = ledger;
  const { getArticleById, searchArticles, getAllArticles } = ledger;

  const { PART_STATS } = await import("../public/src/design/parts.js");

  let passed = 0;
  const errors = [];

  function ok(label) { passed++; }
  function fail(msg) { errors.push(msg); }

  // --- 1. Radiator article has conditional performance ---
  const radiator = getArticleById("component:radiator");
  assert.ok(radiator, "Radiator article missing");
  assert.ok(radiator.conditionalPerformance && radiator.conditionalPerformance.length > 0,
    "Radiator article must have conditionalPerformance");
  ok("radiator conditional performance exists");

  // --- 2. Radiator article has special mechanics ---
  assert.ok(radiator.specialMechanics && radiator.specialMechanics.length >= 5,
    "Radiator article must have at least 5 specialMechanics entries");
  ok("radiator special mechanics exist");

  // --- 3. Radiator article has requirements ---
  assert.ok(radiator.requirementsLimitations && radiator.requirementsLimitations.length > 0,
    "Radiator article must have requirementsLimitations");
  ok("radiator requirements exist");

  // --- 4. Radiator article has interactions ---
  assert.ok(radiator.interactions && radiator.interactions.length > 0,
    "Radiator article must have interactions");
  ok("radiator interactions exist");

  // --- 5. Radiator conditional performance values match heatRules ---
  const cp = radiator.conditionalPerformance;
  const exposedEntry = cp.find((e) => e.label.includes("Exposed"));
  assert.ok(exposedEntry, "Missing exposed entry in conditional performance");
  const expectedExposed = Math.round((HeatRules.RADIATOR_EXPOSED_MULTIPLIER ?? 1) * 100) + "%";
  assert.strictEqual(exposedEntry.value, expectedExposed,
    `Exposed multiplier mismatch: ${exposedEntry.value} vs ${expectedExposed}`);
  ok("radiator exposed multiplier matches heatRules");

  const enclosedEntry = cp.find((e) => e.label.includes("Enclosed"));
  assert.ok(enclosedEntry, "Missing enclosed entry in conditional performance");
  const expectedEnclosed = Math.round((HeatRules.RADIATOR_ENCLOSED_MULTIPLIER ?? 0.25) * 100) + "%";
  assert.strictEqual(enclosedEntry.value, expectedEnclosed,
    `Enclosed multiplier mismatch: ${enclosedEntry.value} vs ${expectedEnclosed}`);
  ok("radiator enclosed multiplier matches heatRules");

  assert.strictEqual(HeatRules.RADIATOR_PASSIVE_COOLING_FRACTION, undefined,
    "Radiator has no hidden passive cooling floor");
  assert.ok(!cp.some((e) => e.label.includes("Passive")),
    "Radiator article must not advertise a passive cooling floor");
  ok("radiator has no passive cooling floor");

  // --- 6. Radiator heat-state entries match active cooling table ---
  const hotEntry = cp.find((e) => e.label.includes("Hot"));
  assert.ok(hotEntry, "Missing Hot state entry");
  const expectedHot = Math.round((HeatRules.RADIATOR_ACTIVE_COOLING_BY_STATE?.hot ?? 0.75) * 100) + "%";
  assert.strictEqual(hotEntry.value, expectedHot,
    `Hot state cooling mismatch: ${hotEntry.value} vs ${expectedHot}`);
  ok("radiator hot state cooling matches heatRules");

  const overheatedEntry = cp.find((e) => e.label.includes("Overheated"));
  assert.ok(overheatedEntry, "Missing Overheated state entry");
  const expectedOverheated = Math.round((HeatRules.RADIATOR_ACTIVE_COOLING_BY_STATE?.overheated ?? 0) * 100) + "%";
  assert.strictEqual(overheatedEntry.value, expectedOverheated,
    `Overheated state cooling mismatch: ${overheatedEntry.value} vs ${expectedOverheated}`);
  ok("radiator overheated state cooling matches heatRules");

  // --- 7. Radiator requirements mention exterior edge ---
  const reqText = radiator.requirementsLimitations.map((r) => r.label + " " + (r.detail || "")).join(" ");
  assert.ok(reqText.toLowerCase().includes("exterior") || reqText.toLowerCase().includes("exposed"),
    "Radiator requirements must mention exterior/exposed edge");
  ok("radiator requirements mention exterior edge");

  // --- 8. Radiator has warning about enclosing ---
  const hasWarning = radiator.specialMechanics.some((m) => m.warning) ||
    radiator.requirementsLimitations.some((r) => r.warning) ||
    radiator.conditionalPerformance.some((c) => c.warning);
  assert.ok(hasWarning, "Radiator article must have at least one warning flag");
  ok("radiator has warning flag");

  // --- 9. Coverage manifest: every listed component has mechanics ---
  for (const partId of SPECIAL_MECHANICS_COMPONENTS) {
    if (!PART_STATS[partId]) continue; // skip parts not in current balance
    const article = getArticleById(`component:${partId}`);
    if (!article) continue;
    const hasMechanics = article.specialMechanics || article.requirementsLimitations ||
      article.conditionalPerformance || article.interactions;
    assert.ok(hasMechanics, `Component ${partId} in coverage manifest but has no mechanics sections`);
  }
  ok("coverage manifest components have mechanics");

  // --- 10. Search includes mechanics text ---
  const passiveResults = searchArticles("passive cooling");
  assert.ok(passiveResults.some((a) => a.id === "component:radiator"),
    "Search for 'passive cooling' must find radiator article");
  ok("search finds radiator via mechanics text");

  const enclosedResults = searchArticles("enclosed");
  assert.ok(enclosedResults.some((a) => a.id === "component:radiator"),
    "Search for 'enclosed' must find radiator article");
  ok("search finds radiator via 'enclosed'");

  const exhaustResults = searchArticles("exhaust");
  assert.ok(exhaustResults.some((a) => a.id === "component:engine"),
    "Search for 'exhaust' must find engine article");
  ok("search finds engine via 'exhaust'");

  // --- 11. Stale-value guard: radiator enclosed value is not a raw number ---
  const enclosedMech = radiator.specialMechanics.find((m) => m.label === "Enclosed Output");
  assert.ok(enclosedMech, "Missing 'Enclosed Output' in special mechanics");
  assert.ok(enclosedMech.value.includes("%"),
    `Enclosed Output value should be formatted as percentage, got: ${enclosedMech.value}`);
  ok("stale-value guard: enclosed output is formatted");

  // --- 12. Rule contracts: each contract's article exists and has matching sourceKey ---
  for (const contract of LEDGER_RULE_CONTRACTS) {
    const article = getArticleById(contract.articleId);
    assert.ok(article, `Contract references missing article: ${contract.articleId}`);
    // Verify the sourceKey resolves to a non-undefined value in HeatRules
    const parts = contract.sourceKey.split(".");
    let val = HeatRules;
    for (const p of parts.slice(1)) { // skip "heatRules" prefix
      val = val?.[p];
    }
    assert.ok(val !== undefined, `Contract sourceKey ${contract.sourceKey} resolves to undefined`);
  }
  ok("rule contracts valid");

  // --- 13. No $ currency in any article stat values ---
  const allArticles = getAllArticles();
  for (const article of allArticles) {
    if (!article.importantStats) continue;
    for (const stat of article.importantStats) {
      if (stat.value && stat.value.includes("$")) {
        fail(`Article ${article.id} stat "${stat.label}" still uses $ currency: ${stat.value}`);
      }
    }
  }
  ok("no $ currency in article stats");

  // --- 14. Combat styles article does not mention "Circle" ---
  const combatArticle = getArticleById("combat-styles");
  assert.ok(combatArticle, "Combat styles article missing");
  assert.ok(!combatArticle.howItWorks.toLowerCase().includes("circle"),
    "Combat styles article should not reference stale 'Circle' style");
  assert.ok(combatArticle.howItWorks.toLowerCase().includes("orbit"),
    "Combat styles article must mention Orbit");
  assert.ok(combatArticle.howItWorks.toLowerCase().includes("kite"),
    "Combat styles article must mention Kite");
  ok("combat styles article updated");

  // --- 15. Destroyed radiator behaviour is documented ---
  const destroyedMech = radiator.specialMechanics.find((m) =>
    m.label.toLowerCase().includes("destroyed"));
  assert.ok(destroyedMech, "Radiator article must document destroyed behaviour");
  assert.ok((destroyedMech.value || "").toLowerCase().includes("no cooling")
    || (destroyedMech.detail || "").toLowerCase().includes("stops rejecting"),
    "Destroyed radiator behaviour must mention that cooling stops");
  ok("destroyed radiator behaviour documented");

  console.log(`\nLedger mechanics verification: ${passed} checks passed, ${errors.length} errors`);
  if (errors.length) {
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }
  console.log("Ledger mechanics verification passed");
})();
