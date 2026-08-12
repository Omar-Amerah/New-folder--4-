"use strict";

// combat.js may reach movement during its own load. Keep the dependency lazy
// and memoised exactly once for every extracted movement responsibility.
let combatModule = null;
function combat() {
  if (!combatModule) combatModule = require("../combat");
  return combatModule;
}

module.exports = { combat };

