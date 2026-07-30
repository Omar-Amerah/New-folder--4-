"use strict";

const { MODERN_MOVEMENT } = require("../../public/src/shared/featureFlags");
const modern = require("./movementModern");

if (MODERN_MOVEMENT) {
  module.exports = modern;
} else {
  const legacy = require("./movementLegacy");
  // Keep modern-only helpers available while running the legacy core movement.
  module.exports = Object.assign({}, modern, legacy);
}
