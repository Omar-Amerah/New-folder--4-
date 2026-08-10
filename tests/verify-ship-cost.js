const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { PARTS } = require("../src/server/components");
const { computeStats: computeServerStats } = require("../src/server/shipStats");
const balance = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "component-balance.json"), "utf8"));

const legacyPricingFields = [
  "baseShipCost",
  "partCostMultiplier",
  "massCostMultiplier",
  "hullCostMultiplier",
  "shieldCostMultiplier",
  "repairCostMultiplier",
  "weaponPremiums",
  "fleetCountFormulaInputs"
];

for (const field of legacyPricingFields) {
  assert(!(field in (balance.shipPricing || {})), `legacy ship-pricing field remains: ${field}`);
}

global.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    getContext: () => null
  })
};
global.window = { devicePixelRatio: 1 };

(async () => {
  const { computeStats: computeClientStats } = await import("../public/src/design/componentStats.js");
  const designs = [
    [
      { x: 7, y: 7, type: "core" },
      { x: 7, y: 8, type: "engine" },
      { x: 8, y: 7, type: "missile" }
    ],
    [
      { x: 7, y: 7, type: "core" },
      { x: 7, y: 8, type: "engine" },
      { x: 8, y: 8, type: "reactor" },
      { x: 9, y: 8, type: "railgun" }
    ]
  ];

  for (const design of designs) {
    const expected = design.reduce((sum, part) => sum + PARTS[part.type].cost, 0);
    const server = computeServerStats(design);
    const client = computeClientStats(design);

    assert.strictEqual(server.cost, expected, "server cost is the direct component sum");
    assert.strictEqual(server.unitCost, expected, "server unitCost is the direct component sum");
    assert.strictEqual(client.cost, expected, "client cost is the direct component sum");
    assert.strictEqual(client.unitCost, expected, "client unitCost is the direct component sum");
    assert.strictEqual(server.unitCost, client.unitCost, "client and server ship costs match");
    assert.strictEqual("fleetCount" in server, false, "server no longer exposes the legacy fleet count");
    assert.strictEqual("fleetCount" in client, false, "client no longer exposes the legacy fleet count");
    assert.strictEqual("costBreakdown" in server, false, "server no longer exposes a cost breakdown");
    assert.strictEqual("costBreakdown" in client, false, "client no longer exposes a cost breakdown");
  }

  console.log("Simple component ship cost verification passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
