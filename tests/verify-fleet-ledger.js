"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);

global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, appendChild(){}, getContext: () => null })
};
global.window = { devicePixelRatio: 1 };

(async () => {
  const ledger = await import("../public/src/ledger/ledgerContent.js");

  const errors = [];
  let passed = 0;

  function ok(label) { passed++; }
  function fail(msg) { errors.push(msg); }

  // --- 1. Categories are well-formed ---
  const { CATEGORIES, getAllArticles, getArticleById, getArticlesByCategory, getRelatedArticles, searchArticles, validateArticles } = ledger;

  const expectedCategories = [
    ["start-here", "Start Here"],
    ["building-ships", "Building Ships"],
    ["combat", "Combat"],
    ["heat", "Heat"],
    ["movement", "Movement"],
    ["sensors-detection", "Sensors & Detection"],
    ["data-links", "Data Links"],
    ["weapons", "Weapons"],
    ["shields-armour", "Shields & Armour"],
    ["drones", "Drones"],
    ["command", "Command"],
    ["economy-objectives", "Economy & Objectives"],
    ["advanced-mechanics", "Advanced Mechanics"],
    ["component-reference", "Component Reference"]
  ];
  assert.ok(Array.isArray(CATEGORIES), "CATEGORIES must be an array");
  assert.deepStrictEqual(
    CATEGORIES.map((category) => [category.id, category.label]),
    expectedCategories,
    "Ledger categories must keep the learnability-first order"
  );
  const catIds = new Set();
  for (const cat of CATEGORIES) {
    assert.ok(cat.id, `Category missing id: ${JSON.stringify(cat)}`);
    assert.ok(cat.label, `Category missing label: ${cat.id}`);
    assert.ok(!catIds.has(cat.id), `Duplicate category id: ${cat.id}`);
    catIds.add(cat.id);
  }
  ok("categories well-formed");

  // --- 2. All articles have unique ids ---
  const articles = getAllArticles();
  assert.ok(articles.length >= 14, `Expected at least 14 articles, got ${articles.length}`);
  const ids = new Set();
  for (const article of articles) {
    assert.ok(article.id, `Article missing id: ${article.title}`);
    assert.ok(!ids.has(article.id), `Duplicate article id: ${article.id}`);
    ids.add(article.id);
    assert.ok(article.title, `Article missing title: ${article.id}`);
    assert.ok(article.category, `Article missing category: ${article.id}`);
    assert.ok(catIds.has(article.category), `Article ${article.id} has unknown category: ${article.category}`);
    assert.ok(article.summary, `Article missing summary: ${article.id}`);
  }
  ok("article uniqueness and category validity");

  // --- 3. All related references resolve ---
  for (const article of articles) {
    if (article.related) {
      for (const ref of article.related) {
        const target = getArticleById(ref);
        assert.ok(target, `Article ${article.id} references unknown article: ${ref}`);
      }
    }
  }
  ok("related references valid");

  // --- 4. validateArticles returns no errors ---
  const validationErrors = validateArticles();
  assert.deepStrictEqual(validationErrors, [], `validateArticles returned errors: ${validationErrors.join("; ")}`);
  ok("validateArticles clean");

  // --- 5. Manual articles exist for each category ---
  const expectedManual = ["overview", "blueprint-designer", "power", "combat", "combat-styles", "heat", "movement", "sensors-detection", "support", "weapons", "defence", "drones", "command", "economy", "advanced-mechanics", "component-reference"];
  for (const id of expectedManual) {
    const article = getArticleById(id);
    assert.ok(article, `Missing manual article: ${id}`);
    assert.ok(article.howItWorks, `Manual article ${id} missing howItWorks`);
  }
  ok("manual articles present");

  // --- 5b. The manual is substantive, searchable, and tied to live rules ---
  const manualArticles = articles.filter((article) => !article.isComponent);
  for (const article of manualArticles) {
    assert.ok(article.howItWorks && article.howItWorks.length >= 100,
      `Manual article ${article.id} needs a substantive mechanics explanation`);
    assert.ok(article.practicalUse && article.practicalUse.length >= 40,
      `Manual article ${article.id} needs practical guidance`);
    assert.ok(Array.isArray(article.commonProblems) && article.commonProblems.length >= 2,
      `Manual article ${article.id} needs at least two troubleshooting entries`);
    assert.ok(Array.isArray(article.keywords) && article.keywords.length >= 4,
      `Manual article ${article.id} needs useful search keywords`);
  }

  for (const id of ["targeting-and-arcs", "damage-and-destruction", "stations-infrastructure"]) {
    assert.ok(getArticleById(id), `Missing comprehensive manual article: ${id}`);
  }

  const generatedBalance = (await import("../public/src/generatedBalance.js")).GENERATED_BALANCE;
  const heatRules = require("../public/src/shared/heatRules.js");
  const movementStats = await import("../public/src/shared/movementStats.js");
  const statValue = (articleId, label) => getArticleById(articleId)?.importantStats
    ?.find((stat) => stat.label === label)?.value;

  const { computeStats } = require("../src/server/shipStats.js");
  const { PARTS } = require("../src/server/components.js");
  const pricingFixture = [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 8, rotation: 0 },
    { type: "armor", x: 7, y: 9, rotation: 0 }
  ];
  const expectedUnitCost = pricingFixture.reduce((sum, part) => sum + PARTS[part.type].cost, 0);
  assert.strictEqual(computeStats(pricingFixture).unitCost, expectedUnitCost,
    "Server fixture must prove that unit cost is the sum of component catalogue costs");
  assert.strictEqual(statValue("ship-cost-formula", "Unit Cost"), "Sum Of Every Placed Component Cost",
    "Ledger must state the authoritative server pricing rule");
  assert.strictEqual(statValue("ship-cost-formula", "Purchase Clamp"), "None",
    "Ledger must not invent unenforced minimum or maximum price clamps");
  assert.strictEqual(statValue("heat", "Warm"), `${Math.round(heatRules.THRESHOLDS.warm * 100)}%`,
    "Ledger Warm threshold must match Heat rules");
  assert.strictEqual(statValue("heat", "Critical"), `${Math.round(heatRules.THRESHOLDS.critical * 100)}%`,
    "Ledger Critical threshold must match Heat rules");
  assert.strictEqual(statValue("command", "Aura Radius"), `${generatedBalance.commandAura.range} m`,
    "Ledger aura radius must match live balance");
  assert.strictEqual(statValue("sensors-detection", "Remembered Ship Contact"), `${generatedBalance.visibility.rememberedContactSeconds}s`,
    "Ledger remembered-contact duration must match live balance");
  assert.ok(statValue("movement", "Turn Caps").includes(String(movementStats.turnCapForMass(54))),
    "Ledger Light turn cap must match movement authority");
  assert.ok(statValue("movement", "Turn Caps").includes(String(movementStats.turnCapForMass(230))),
    "Ledger Capital turn cap must match movement authority");

  const effectiveManualText = JSON.stringify(manualArticles);
  const staleClaims = [
    /Placement Is Blocked[^.]*Disconnected/i,
    /Overlapping Command Auras[^.]*Stack/i,
    /WASD Or Edge[- ]Scroll/i,
    /Victory Is Achieved[^.]*Every Relay[^.]*Or[^.]*Home Station/i,
    /Base Ship Cost/i,
    /Weapon Premiums/i,
    /Allowed Price/i
  ];
  for (const claim of staleClaims) {
    assert.ok(!claim.test(effectiveManualText), `Effective manual retains stale claim: ${claim}`);
  }
  assert.ok(!effectiveManualText.includes("\u2014"), "Shipped Fleet Ledger copy must not contain em dashes");
  ok("manual completeness and authoritative rule contracts");

  // --- 6. Component articles are generated from PART_STATS ---
  const { PART_STATS } = await import("../public/src/design/parts.js");
  const componentArticleIds = articles.filter((a) => a.isComponent).map((a) => a.id);
  assert.ok(componentArticleIds.length > 0, "No component articles generated");
  for (const partId of Object.keys(PART_STATS)) {
    const articleId = `component:${partId}`;
    const article = getArticleById(articleId);
    assert.ok(article, `Missing component article for part: ${partId}`);
    assert.ok(article.importantStats && article.importantStats.length > 0, `Component article ${articleId} has no stats`);
  }
  assert.ok(
    articles.filter((article) => article.isComponent).every((article) => article.category === "component-reference"),
    "Generated component articles must live only in Component Reference"
  );
  assert.deepStrictEqual(
    articles.filter((article) => article.category === "component-reference" && !article.isComponent).map((article) => article.id),
    ["component-reference"],
    "Component Reference should have one manual landing article"
  );
  ok("component articles generated from PART_STATS");

  // --- 7. Component article stats match authoritative balance ---
  for (const partId of Object.keys(PART_STATS)) {
    const stats = PART_STATS[partId];
    const article = getArticleById(`component:${partId}`);
    if (!article || !article.importantStats) continue;
    const statMap = {};
    for (const s of article.importantStats) statMap[s.label] = s.value;
    if (stats.cost) assert.ok(statMap["Cost"], `Component ${partId} missing cost stat`);
    if (stats.mass) assert.ok(statMap["Mass"], `Component ${partId} missing mass stat`);
    if (stats.hull) assert.ok(statMap["Hull HP"], `Component ${partId} missing hull stat`);
  }
  ok("component stats match balance");

  // --- 8. Search returns relevant results ---
  const powerResults = searchArticles("power");
  assert.ok(powerResults.length > 0, "Search for 'power' returned no results");
  assert.ok(powerResults.some((a) => a.id === "power"), "Search for 'power' must include the power article");

  const missileResults = searchArticles("missile");
  assert.ok(missileResults.length > 0, "Search for 'missile' returned no results");

  assert.ok(searchArticles("sensors detection").some((a) => a.id === "sensors-detection"),
    "Search for 'sensors detection' must include the Sensors & Detection guide");
  assert.ok(searchArticles("data links").some((a) => a.id === "support"),
    "Search for 'data links' must include the Data Links guide");
  assert.ok(searchArticles("emergency reserve").some((a) => a.id === "command"),
    "Search must index mechanics prose, not only titles and keywords");
  assert.ok(searchArticles("partial hull without shields").some((a) => a.id === "stations-infrastructure"),
    "Search must index practical and troubleshooting content");

  const emptyResults = searchArticles("");
  assert.deepStrictEqual(emptyResults, [], "Empty search must return no results");
  ok("search functionality");

  // Obsolete infrastructure concepts must not return through manual prose,
  // generated component mechanics, keywords, stats, or related metadata.
  const obsoleteInfrastructureTerm = /\b(?:wiring|wire|wires|cable|cables|overload|overloads|overloaded)\b/i;
  for (const article of articles) {
    assert.ok(!obsoleteInfrastructureTerm.test(JSON.stringify(article)),
      `Article ${article.id} contains obsolete infrastructure terminology`);
  }
  ok("obsolete infrastructure articles and terminology removed");

  // --- 9. getArticlesByCategory works ---
  const expectedLandingByCategory = {
    "start-here": "overview",
    "building-ships": "blueprint-designer",
    combat: "combat",
    heat: "heat",
    movement: "movement",
    "sensors-detection": "sensors-detection",
    "data-links": "support",
    weapons: "weapons",
    "shields-armour": "defence",
    drones: "drones",
    command: "command",
    "economy-objectives": "economy",
    "advanced-mechanics": "advanced-mechanics",
    "component-reference": "component-reference"
  };
  for (const cat of CATEGORIES) {
    const catArticles = getArticlesByCategory(cat.id);
    assert.ok(catArticles.length > 0, `Category ${cat.id} has no articles`);
    assert.strictEqual(catArticles[0].id, expectedLandingByCategory[cat.id],
      `Category ${cat.id} must open with its landing article`);
  }
  ok("getArticlesByCategory");

  // --- 10. getRelatedArticles returns article objects ---
  const overview = getArticleById("overview");
  const related = getRelatedArticles(overview);
  assert.ok(related.length > 0, "Overview article has no related articles");
  for (const r of related) {
    assert.ok(r.id, "Related article missing id");
    assert.ok(r.title, "Related article missing title");
  }
  ok("getRelatedArticles");

  // --- 11. HTML structure: Fleet Ledger overlay and buttons exist in index.html ---
  const indexHtml = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.ok(indexHtml.includes('id="fleetLedgerOverlay"'), "index.html missing fleetLedgerOverlay section");
  assert.ok(indexHtml.includes('id="fleetLedgerButton"'), "index.html missing fleetLedgerButton in main menu");
  assert.ok(indexHtml.includes('id="designerFleetLedgerButton"'), "index.html missing designerFleetLedgerButton");
  assert.ok(indexHtml.includes('id="ledgerSearchInput"'), "index.html missing ledgerSearchInput");
  assert.ok(indexHtml.includes('id="ledgerCategoryNav"'), "index.html missing ledgerCategoryNav");
  assert.ok(indexHtml.includes('id="ledgerContent"'), "index.html missing ledgerContent");
  assert.ok(indexHtml.includes('id="ledgerRelated"'), "index.html missing ledgerRelated");
  assert.ok(indexHtml.includes('id="ledgerBackButton"'), "index.html missing ledgerBackButton");
  assert.ok(indexHtml.includes('id="ledgerForwardButton"'), "index.html missing ledgerForwardButton");
  assert.ok(indexHtml.includes('id="ledgerHomeButton"'), "index.html missing ledgerHomeButton");
  assert.ok(indexHtml.includes('id="ledgerCloseButton"'), "index.html missing ledgerCloseButton");
  assert.ok(indexHtml.includes('aria-label="Fleet Ledger">?'), "index.html Fleet Ledger button should show ? with aria-label");
  ok("HTML structure: overlay and buttons present");

  // --- 12. CSS file exists ---
  const cssPath = path.join(ROOT, "public", "styles", "fleet-ledger.css");
  assert.ok(fs.existsSync(cssPath), "fleet-ledger.css not found");
  const cssContent = fs.readFileSync(cssPath, "utf8");
  assert.ok(cssContent.includes(".ledger-overlay"), "fleet-ledger.css missing .ledger-overlay");
  assert.ok(cssContent.includes("@media (max-width: 900px)"), "fleet-ledger.css missing responsive breakpoint");
  assert.ok(cssContent.includes("@media (prefers-reduced-motion"), "fleet-ledger.css missing reduced-motion support");
  ok("CSS file exists and has responsive + accessibility styles");

  // --- 13. CSS link is in index.html ---
  assert.ok(indexHtml.includes("fleet-ledger.css"), "index.html missing fleet-ledger.css link");
  ok("CSS link in index.html");

  // --- 14. DOM references exist in dom.js ---
  const domContent = fs.readFileSync(path.join(ROOT, "public", "src", "ui", "dom.js"), "utf8");
  assert.ok(domContent.includes("fleetLedgerButton"), "dom.js missing fleetLedgerButton");
  assert.ok(domContent.includes("designerFleetLedgerButton"), "dom.js missing designerFleetLedgerButton");
  assert.ok(domContent.includes("ledgerOverlay"), "dom.js missing ledgerOverlay");
  assert.ok(domContent.includes("ledgerSearchInput"), "dom.js missing ledgerSearchInput");
  assert.ok(domContent.includes("ledgerContent"), "dom.js missing ledgerContent");
  assert.ok(domContent.includes("ledgerRelated"), "dom.js missing ledgerRelated");
  assert.ok(!domContent.includes("ledgerArticleTitle"), "dom.js should not have stale ledgerArticleTitle ref");
  ok("DOM references in dom.js");

  // --- 15. main.js wires up the ledger ---
  const mainContent = fs.readFileSync(path.join(ROOT, "public", "src", "main.js"), "utf8");
  assert.ok(mainContent.includes("fleetLedgerUi.js"), "main.js missing fleetLedgerUi import");
  assert.ok(mainContent.includes("openLedger"), "main.js missing openLedger call");
  assert.ok(mainContent.includes("initLedger"), "main.js missing initLedger call");
  ok("main.js wires up ledger");

  // --- 16. input.js handles Escape for ledger ---
  const inputContent = fs.readFileSync(path.join(ROOT, "public", "src", "game", "input.js"), "utf8");
  assert.ok(inputContent.includes("ledgerOverlay"), "input.js missing ledgerOverlay check");
  assert.ok(inputContent.includes("closeLedger"), "input.js missing closeLedger import");
  ok("input.js handles Escape for ledger");

  // --- 17. Part inspector has deep link ---
  const inspectorContent = fs.readFileSync(path.join(ROOT, "public", "src", "ui", "partInspectorUi.js"), "utf8");
  assert.ok(inspectorContent.includes("data-ledger-link"), "partInspectorUi.js missing data-ledger-link");
  assert.ok(inspectorContent.includes("openArticle"), "partInspectorUi.js missing openArticle import");
  ok("part inspector has deep link to ledger");

  // --- 18. Module boundary: ledger files are under public/src/ ---
  const ledgerDir = path.join(ROOT, "public", "src", "ledger");
  assert.ok(fs.existsSync(path.join(ledgerDir, "ledgerContent.js")), "ledgerContent.js not found in ledger dir");
  assert.ok(fs.existsSync(path.join(ledgerDir, "fleetLedgerUi.js")), "fleetLedgerUi.js not found in ledger dir");
  ok("ledger module files exist under public/src/ledger/");

  // --- 19. No gameplay/balance files modified ---
  const serverEconomy = fs.readFileSync(path.join(ROOT, "src", "server", "economy.js"), "utf8");
  assert.ok(!serverEconomy.includes("fleetLedger"), "economy.js should not reference fleetLedger");
  ok("no gameplay file contamination");

  console.log(`\nFleet Ledger verification: ${passed} checks passed, ${errors.length} errors`);
  if (errors.length) {
    for (const e of errors) console.error(` - ${e}`);
    process.exit(1);
  }
  console.log("Fleet Ledger verification passed");
})();
