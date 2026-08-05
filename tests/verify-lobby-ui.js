"use strict";

const assert = require("assert");
const fs = require("fs");

const html = fs.readFileSync("public/index.html", "utf8");
const css = fs.readFileSync("public/styles.css", "utf8");
const js = fs.readFileSync("public/src/ui/lobbyUi.js", "utf8");

assert(html.includes('<label for="teamSelect"'), "Team selector has an associated <label> for the control");

assert(html.includes('aria-label="Choose team"'), "Team <select> has an accessible label");
assert(html.includes('<option value="" disabled selected>Choose a team</option>'), "Team selector placeholder option exists");
assert(html.includes('<option value="blue">Blue Wing</option>'), "Blue Wing option exists");
assert(html.includes('<option value="red">Red Wing</option>'), "Red Wing option exists");

assert(css.includes(".game-rules-grid"), "Game Rules use a responsive grid class");
assert(css.includes(".game-rule > dt"), "Rule labels are styled separately from values");
assert(css.includes(".game-rule > dd"), "Rule values are styled separately from labels");
assert(css.includes("@media (max-width: 520px)"), "Team card has a narrow-viewport breakpoint");
assert(css.includes(".team-choice-card select"), "Team select is styled");

assert(js.includes("Loading teams…"), "Team selector loading state is present");
assert(js.includes("No teams available"), "Team selector empty-list fallback is present");
assert(js.includes("Choose a team"), "Team selector placeholder is present");
assert(js.includes('game-rules-grid'), "Game Rules render as a semantic <dl> grid");
assert(js.includes("<dt>Mode</dt>"), "Game Rules Mode uses a <dt> label");
assert(js.includes("<dd>"), "Game Rules values use <dd> elements");
assert(js.includes("Automatic by player count"), "Auto map size is presented cleanly");
assert(js.includes("handleTeamSelectChange"), "Team select change handler is present");
assert(js.includes("onServerError"), "Server-error restore hook is present");
assert(js.includes("Locked after lobby"), "Locked rules status text is present");
assert(!js.includes('state.myTeam'), "Removed undefined state.myTeam usage");

(async () => {
  const formatting = await import("./public/src/shared/formatting.js");
  assert.strictEqual(formatting.formatMoney(1000), "$1,000", "formatMoney formats with comma");
  assert.strictEqual(formatting.formatMoney(12), "$12", "formatMoney formats small integers");
  assert.strictEqual(formatting.formatMoney(1000.6), "$1,001", "formatMoney rounds to integer");
  assert.strictEqual(formatting.escapeHtml("<script>"), "&lt;script&gt;", "escapeHtml still works");
  console.log("Lobby UI verification passed");
})();
