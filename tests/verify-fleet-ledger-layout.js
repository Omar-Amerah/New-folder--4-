"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.dirname(__dirname);

global.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {},
    classList: { add(){}, remove(){}, toggle(){} },
    setAttribute(){},
    appendChild(){},
    getContext: () => null
  })
};
global.window = { devicePixelRatio: 1 };

(async () => {
  const [{ renderArticleContent }, { getArticleById }] = await Promise.all([
    import("../public/src/ledger/fleetLedgerUi.js"),
    import("../public/src/ledger/ledgerContent.js")
  ]);

  const layoutFixture = {
    title: "Movement & Orders",
    category: "movement",
    summary: "Movement rules",
    importantStats: [
      { label: "Engine Authority", value: "Linear per live component" },
      { label: "Braking", value: "5x forward acceleration" },
      { label: "Turn Authority", value: "No built-in hull turn. Turn comes from Engines, Gyroscopes, and Maneuver Thrusters." },
      { label: "Maneuver Thrust", value: "0.35 minimum, +0.35 per cell, 1.75 maximum" },
      { label: "Mass", value: "Affects movement continuously" },
      { label: "Acceleration", value: "Shows how quickly the ship changes velocity" },
      { label: "Turn Rate", value: "Turning systems, reduced continuously by mass" },
      { label: "Movement Efficiency", value: "Linear per consumer, capped at 100%" }
    ],
    practicalUse: "Balance propulsion and turning systems against the hull you are building."
  };
  const layoutHtml = renderArticleContent(layoutFixture);
  assert.match(layoutHtml, /<dl class="ledger-key-stat-list">/, "Key Stats must use a semantic definition list");
  assert.doesNotMatch(layoutHtml, /ledger-stat-grid/, "Key Stats must not render the old dense stat grid");
  assert.doesNotMatch(layoutHtml, /ledger-stat-row/, "Key Stats must not render the old card rows");
  for (const label of layoutFixture.importantStats.map((stat) => stat.label)) {
    assert.match(layoutHtml, new RegExp(`<dt class="ledger-key-stat-label">${label}</dt>`),
      `Key Stats must render the complete ${label} label`);
  }
  assert.doesNotMatch(layoutHtml, /Engine An\.\.\.|Turn Auth\.\.\.|Maneuver \.\.\.|Movemen\.\.\./,
    "Key Stats labels must not be ellipsized");

  const keyStatsEnd = layoutHtml.indexOf("</dl>");
  const practicalUseStart = layoutHtml.indexOf('id="ledger-sec-practical-use"');
  assert.ok(keyStatsEnd >= 0 && practicalUseStart > keyStatsEnd,
    "Practical Use must remain below the complete Key Stats summary");

  const movementHtml = renderArticleContent(getArticleById("movement"));
  assert.match(movementHtml, /<section class="ledger-section ledger-key-stats-section"/,
    "Movement article must use the refactored Key Stats section");
  assert.match(movementHtml, /<dt class="ledger-key-stat-label">Turn Authority<\/dt>/,
    "Movement article must retain its Turn Authority row");
  assert.match(movementHtml, /<dt class="ledger-key-stat-label">Mass<\/dt>/,
    "Movement article must retain its Mass row");

  const cssContent = fs.readFileSync(path.join(ROOT, "public", "styles", "fleet-ledger.css"), "utf8");
  const keyStatsCssStart = cssContent.indexOf(".ledger-key-stat-list");
  const keyStatsCssEnd = cssContent.indexOf(".ledger-stat-grid");
  assert.ok(keyStatsCssStart >= 0 && keyStatsCssEnd > keyStatsCssStart,
    "Fleet Ledger CSS must define a distinct Key Stats layout before legacy conditional grids");
  const keyStatsCss = cssContent.slice(keyStatsCssStart, keyStatsCssEnd);
  assert.match(keyStatsCss, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    "Key Stats must use two columns at wide widths");
  assert.match(keyStatsCss, /min-width:\s*0/,
    "Key Stats rows must allow content to shrink without overflow");
  assert.match(keyStatsCss, /max-width:\s*100%/,
    "Key Stats panel must stay within its containing panel");
  assert.match(keyStatsCss, /overflow-wrap:\s*anywhere/,
    "Key Stats values must wrap instead of clipping");
  assert.doesNotMatch(keyStatsCss, /text-overflow:\s*ellipsis/,
    "Key Stats CSS must not truncate labels or values");
  assert.match(cssContent, /@media \(max-width: 600px\)[\s\S]*?\.ledger-key-stat-list[\s\S]*?grid-template-columns:\s*1fr/,
    "Key Stats must collapse to one column on narrow layouts");

  console.log("Fleet Ledger layout verification passed: definition-list summary, complete labels, responsive wrapping, and Practical Use ordering");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
