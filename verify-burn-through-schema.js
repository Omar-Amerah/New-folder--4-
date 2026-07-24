// Regression coverage for burnThroughCarryMultiplier balance-schema validation.
//
// The field is optional, but when present must be a finite number in [0, 1] and
// only on a supported (beam) weapon. Invalid source data must fail validation
// loudly rather than being silently clamped or zeroed. The live component
// balance's Beam Emitter value of 0.4 must remain valid.

const assert = require("assert");
const fs = require("fs");
const { validateComponentBalance } = require("./src/server/componentSchema");

// Minimal-but-complete balance skeleton so only the weapon field under test drives
// the burn-through-specific validation result.
function balanceWith(weapon) {
  return {
    metadata: {}, shipPricing: { minimum: 1, maximum: 2, weaponPremiums: {} }, economy: { shipCap: 1 },
    rewards: {}, match: { matchScore: 1 }, movement: {}, projectiles: {}, missileGuidance: {},
    fleetLimits: {}, capture: {}, repair: {},
    drones: {
      squadSize: 1, maxBaysPerShip: 1, maxActivePerShip: 1, maxActivePerPlayer: 1,
      launchIntervalSeconds: 1, launchDurationSeconds: 1, orphanLifetimeSeconds: 1,
      standbyPowerMw: 1, activePowerMw: 1, productionPowerMw: 1,
      standbyHeatPerSecond: 1, activeHeatPerSecond: 1, productionHeatPerSecond: 1,
      types: {
        fighter: { productionSeconds: 1, hull: 1, speed: 1 },
        defence: { productionSeconds: 1, hull: 1, speed: 1 },
        repair: { productionSeconds: 1, hull: 1, speed: 1 }
      }
    },
    components: [{ id: "x", weapon }]
  };
}

function burnThroughErrors(btc, family = "beam") {
  const weapon = { family, damage: 1, fireRate: 1, range: 1 };
  if (btc !== "OMIT") weapon.burnThroughCarryMultiplier = btc;
  return validateComponentBalance(balanceWith(weapon)).errors.filter((e) => /burnThroughCarryMultiplier/.test(e));
}

// Valid values produce no burn-through error.
for (const valid of ["OMIT", 0, 0.4, 1]) {
  assert.deepStrictEqual(burnThroughErrors(valid), [], `${JSON.stringify(valid)} must be accepted`);
}
console.log("PASS: 0, 0.4, 1 and omission are accepted");

// Invalid values fail loudly.
for (const invalid of [-0.1, 1.2, NaN, Infinity, "0.4", true, null]) {
  const errors = burnThroughErrors(invalid);
  assert.ok(errors.length > 0, `${JSON.stringify(invalid)} must be rejected loudly`);
}
console.log("PASS: -0.1, 1.2, NaN, \"0.4\" and other malformed values are rejected loudly");

// Only meaningful for supported (beam) weapon families.
assert.ok(burnThroughErrors(0.4, "blaster").length > 0, "0.4 on a blaster is rejected");
assert.deepStrictEqual(burnThroughErrors(0.4, "beam"), [], "0.4 on a beam is accepted");
console.log("PASS: burn-through is only valid on supported (beam) weapons");

// The live component balance keeps a valid Beam Emitter value of 0.4.
for (const file of ["component-balance.json", "public/component-balance.json"]) {
  const balance = JSON.parse(fs.readFileSync(file, "utf8"));
  const result = validateComponentBalance(balance, { filePath: file });
  assert.strictEqual(result.ok, true, `${file} must validate:\n${result.errors.join("\n")}`);
  const beam = balance.components.find((c) => c.id === "beamEmitter");
  assert.ok(beam && beam.weapon && beam.weapon.burnThroughCarryMultiplier === 0.4, `${file} preserves Beam Emitter burnThroughCarryMultiplier of 0.4`);
}
console.log("PASS: live component balance preserves the Beam Emitter value of 0.4 and validates");

console.log("\nBURN-THROUGH SCHEMA REGRESSION TESTS PASSED");
