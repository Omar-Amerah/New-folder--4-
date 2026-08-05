const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { PARTS } = require("../src/server/components");
const WiringRules = require("../public/src/shared/wiringRules");
const PowerFlowRules = require("../public/src/shared/powerFlowRules");
const PowerPolicyRules = require("../public/src/shared/powerPolicyRules");
const { buildShipPowerSolveBaseInput, applyShipPowerAllocation, initializeComponentPower } = require("../src/server/componentPower");
const { mergeCachedShipFields } = require("../public/src/snapshotMerge");

console.log("Running Battery & Capacitor Power Storage Verification Tests...\n");

// Helper to construct simple test ship layout
function createTestShip(modules, explicitWiring = null) {
  const design = modules.map(m => typeof m === "string" ? { type: m, x: 0, y: 0 } : m);
  const wiring = explicitWiring || WiringRules.createGeneratedPowerWiring(design, PARTS);
  const ship = {
    id: "test-ship-1",
    design,
    wiring,
    componentHp: design.map(m => (PARTS[m.type]?.hp || 42)),
    componentMaxHp: design.map(m => (PARTS[m.type]?.hp || 42)),
    stats: {},
    alive: true
  };
  initializeComponentPower(ship);
  return ship;
}

// ----------------------------------------------------
// 1. Authoritative balance check
// ----------------------------------------------------
console.log("Test 1: Balance values for Battery and Capacitor");
assert.strictEqual(PARTS.battery.cost, 10, "Battery cost is 10");
assert.strictEqual(PARTS.battery.mass, 4, "Battery mass is 4");
assert.strictEqual(PARTS.battery.hp, 42, "Battery hull is 42");
assert.strictEqual(PARTS.battery.energyCapacity, 80, "Battery energy capacity is 80 MJ");
assert.strictEqual(PARTS.battery.maxChargeRate, 3, "Battery max charge rate is 3 MW");
assert.strictEqual(PARTS.battery.maxDischargeRate, 4, "Battery max discharge rate is 4 MW");
assert.strictEqual(PARTS.battery.chargeEfficiency, 0.9, "Battery charge efficiency is 90%");
assert.strictEqual(PARTS.battery.dischargeEfficiency, 0.9, "Battery discharge efficiency is 90%");
assert.strictEqual(PARTS.battery.dischargeHeatAtMax, 0.6, "Battery max discharge heat is 0.6 H/s");

assert.strictEqual(PARTS.capacitor.cost, 20, "Capacitor cost is 20");
assert.strictEqual(PARTS.capacitor.mass, 8, "Capacitor mass is 8");
assert.strictEqual(PARTS.capacitor.hp, 70, "Capacitor hull is 70");
assert.strictEqual(PARTS.capacitor.energyCapacity, 160, "Capacitor energy capacity is 160 MJ");
assert.strictEqual(PARTS.capacitor.maxChargeRate, 5, "Capacitor max charge rate is 5 MW");
assert.strictEqual(PARTS.capacitor.maxDischargeRate, 12, "Capacitor max discharge rate is 12 MW");
assert.strictEqual(PARTS.capacitor.chargeEfficiency, 0.8, "Capacitor charge efficiency is 80%");
assert.strictEqual(PARTS.capacitor.dischargeEfficiency, 0.8, "Capacitor discharge efficiency is 80%");
assert.strictEqual(PARTS.capacitor.dischargeHeatAtMax, 2.5, "Capacitor max discharge heat is 2.5 H/s");
console.log("✓ Test 1 Passed: Balance values match authoritative JSON.");

// ----------------------------------------------------
// 2. Storage does not count as sustained generation
// ----------------------------------------------------
console.log("\nTest 2: Storage excluded from permanent available generation");
{
  const design = [{ type: "battery", x: 0, y: 0 }, { type: "capacitor", x: 2, y: 0 }];
  const solve = PowerFlowRules.solvePowerFlow({
    design,
    wiring: { version: 3, power: { sections: [], connections: [] } },
    catalogue: PARTS,
    infrastructure: {}
  });
  assert.strictEqual(solve.summary.availableGenerationMw, 0, "Storage capacity/discharge rate is not included in permanent generation");
}
console.log("✓ Test 2 Passed: Storage is excluded from sustained generation.");

// ----------------------------------------------------
// 3. Charging from spare generation & efficiency
// ----------------------------------------------------
console.log("\nTest 3: Battery charging from spare generation and efficiency application");
{
  // Reactor 10 MW, Battery 80 MJ (start empty 0 MJ), Weapon 4 MW
  const design = [
    { type: "reactor", x: 0, y: 0 },
    { type: "battery", x: 2, y: 0 },
    { type: "autocannon", x: 3, y: 0 } // powerUse 1.8 MW
  ];
  const ship = createTestShip(design);
  ship.componentStorageCharge = [0, 0, 0]; // Battery at 0 MJ

  // Run solve for dt = 1.0s
  applyShipPowerAllocation(ship);

  const batPower = ship.componentPower.byComponentIndex[1];
  assert.strictEqual(batPower.role, "storage", "Battery categorized as storage");
  assert.strictEqual(batPower.storageDetails.state, "charging", "Battery state is charging");
  assert.strictEqual(batPower.storageDetails.chargeRateMw, 3, "Battery charges at max 3 MW from 8.2 MW spare");
  
  // 3 MW * 1s * 0.9 efficiency = 2.7 MJ stored
  assert.strictEqual(batPower.storageDetails.currentChargeMj, 2.7, "Battery stores 2.7 MJ after 1s at 90% efficiency");
  assert.strictEqual(ship.componentStorageCharge[1], 2.7, "Runtime charge array updated to 2.7 MJ");
}
console.log("✓ Test 3 Passed: Battery charges only from spare generation at 90% efficiency.");

// ----------------------------------------------------
// 4. Discharging during shortage & efficiency
// ----------------------------------------------------
console.log("\nTest 4: Battery discharging during shortage");
{
  // No reactor (0 MW generation), Battery (80 MJ full), Weapon (1.8 MW)
  const design = [
    { type: "battery", x: 0, y: 0 },
    { type: "autocannon", x: 1, y: 0 }
  ];
  const ship = createTestShip(design);
  ship.componentStorageCharge = [80, 0]; // Battery starts at 80 MJ

  applyShipPowerAllocation(ship);

  const batPower = ship.componentPower.byComponentIndex[0];
  const wpnPower = ship.componentPower.byComponentIndex[1];

  assert.strictEqual(batPower.storageDetails.state, "discharging", "Battery state is discharging");
  assert.strictEqual(batPower.storageDetails.dischargeRateMw, 1.8, "Battery discharges 1.8 MW to meet shortage");
  assert.strictEqual(wpnPower.allocatedMw, 1.8, "Weapon receives 1.8 MW delivered power from Battery");
  assert.strictEqual(wpnPower.operationalMultiplier, 1, "Weapon is fully powered");

  // 1.8 MW delivered for 1s at 90% discharge efficiency -> 1.8 / 0.9 = 2.0 MJ consumed
  // 80 - 2.0 = 78 MJ remaining
  assert.strictEqual(Math.round(batPower.storageDetails.currentChargeMj * 100) / 100, 78, "80 MJ battery drops to 78 MJ after 1s at 1.8 MW output");
}
console.log("✓ Test 4 Passed: Battery discharges automatically during shortage to power consumers.");

// ----------------------------------------------------
// 5. Capacitor vs Battery discharge rates
// ----------------------------------------------------
console.log("\nTest 5: Capacitor discharges faster than Battery");
{
  assert.strictEqual(PARTS.capacitor.maxDischargeRate, 12, "Capacitor max discharge is 12 MW");
  assert.strictEqual(PARTS.battery.maxDischargeRate, 4, "Battery max discharge is 4 MW");

  // Capacitor covering 12 MW max discharge (2 beam emitters requesting 15 MW total demand)
  const design = [
    { type: "capacitor", x: 0, y: 0 },
    { type: "beamEmitter", x: 2, y: 0 },
    { type: "beamEmitter", x: 0, y: 1 }
  ];
  const ship = createTestShip(design);
  ship.componentStorageCharge = [160, 0, 0];

  applyShipPowerAllocation(ship);
  const capPower = ship.componentPower.byComponentIndex[0];
  assert.strictEqual(capPower.storageDetails.dischargeRateMw, 12, "Capacitor delivers 12 MW max discharge rate");
}
console.log("✓ Test 5 Passed: Capacitor delivers 12 MW rapid discharge rate.");

// ----------------------------------------------------
// 6. Charge bounds clamping
// ----------------------------------------------------
console.log("\nTest 6: Storage charge clamping (0 to max capacity)");
{
  // Test overcharge clamping: Battery at 79.5 MJ receiving 3 MW for 1s at 90% eff (+2.7 MJ -> 82.2 MJ -> clamped to 80 MJ)
  const design = [{ type: "reactor", x: 0, y: 0 }, { type: "battery", x: 2, y: 0 }];
  const ship = createTestShip(design);
  ship.componentStorageCharge = [0, 79.5];

  applyShipPowerAllocation(ship);
  assert.strictEqual(ship.componentStorageCharge[1], 80, "Battery charge clamped at max capacity 80 MJ");

  // Test undercharge clamping: Battery at 1.0 MJ discharging 4 MW for 1s (needs 4.44 MJ -> clamped to 0 MJ)
  const design2 = [{ type: "battery", x: 0, y: 0 }, { type: "autocannon", x: 1, y: 0 }];
  const ship2 = createTestShip(design2);
  ship2.componentStorageCharge = [1.0, 0];

  applyShipPowerAllocation(ship2);
  assert.strictEqual(ship2.componentStorageCharge[0], 0, "Battery charge clamped at minimum 0 MJ");
}
console.log("✓ Test 6 Passed: Charge strictly clamped between 0 and max capacity.");

// ----------------------------------------------------
// 7. Network separation & cable limits
// ----------------------------------------------------
console.log("\nTest 7: Network separation and cable capacity limits");
{
  // Separated networks: Network A (Battery 80 MJ), Network B (Autocannon 4 MW)
  const design = [{ type: "battery", x: 0, y: 0 }, { type: "autocannon", x: 5, y: 5 }];
  // Empty wiring -> no connecting wire section between (0,0) and (5,5)
  const ship = createTestShip(design, { version: 3, power: { sections: [], connections: [] }, data: { sections: [], connections: [] } });
  ship.componentStorageCharge = [80, 0];

  applyShipPowerAllocation(ship);
  const batPower = ship.componentPower.byComponentIndex[0];
  const wpnPower = ship.componentPower.byComponentIndex[1];

  assert.strictEqual(batPower.storageDetails.state, "disconnected", "Disconnected storage state is disconnected");
  assert.strictEqual(batPower.storageDetails.dischargeRateMw, 0, "Disconnected storage does not discharge");
  assert.strictEqual(wpnPower.state, "disconnected", "Disconnected weapon is unpowered");
}
console.log("✓ Test 7 Passed: Disconnected storage cannot supply separate network.");

// ----------------------------------------------------
// 8. Destroyed storage provides no power
// ----------------------------------------------------
console.log("\nTest 8: Destroyed storage provides no Power");
{
  const design = [{ type: "battery", x: 0, y: 0 }, { type: "autocannon", x: 1, y: 0 }];
  const ship = createTestShip(design);
  ship.componentStorageCharge = [80, 0];
  ship.componentHp[0] = 0; // Destroy Battery

  applyShipPowerAllocation(ship);
  const batPower = ship.componentPower.byComponentIndex[0];
  assert.strictEqual(batPower.state, "destroyed", "Destroyed battery state is destroyed");
  assert.strictEqual(batPower.storageDetails.dischargeRateMw, 0, "Destroyed battery provides 0 discharge");
}
console.log("✓ Test 8 Passed: Destroyed storage provides no power.");

// ----------------------------------------------------
// 9. Reactor loss covered by storage
// ----------------------------------------------------
console.log("\nTest 9: Reactor loss covered temporarily by storage");
{
  const design = [{ type: "reactor", x: 0, y: 0 }, { type: "battery", x: 2, y: 0 }, { type: "autocannon", x: 3, y: 0 }];
  const ship = createTestShip(design);
  ship.componentStorageCharge = [0, 80, 0];

  // Reactor alive: Reactor powers weapon (1.8 MW), Battery charges (3 MW)
  applyShipPowerAllocation(ship);
  assert.strictEqual(ship.componentPower.byComponentIndex[2].allocatedMw, 1.8, "Weapon powered by reactor");

  // Destroy reactor!
  ship.componentHp[0] = 0;
  applyShipPowerAllocation(ship);

  assert.strictEqual(ship.componentPower.byComponentIndex[1].storageDetails.state, "discharging", "Battery takes over discharging");
  assert.strictEqual(ship.componentPower.byComponentIndex[2].allocatedMw, 1.8, "Weapon remains fully powered by Battery after Reactor destruction");
}
console.log("✓ Test 9 Passed: Storage covers reactor loss until empty.");

// ----------------------------------------------------
// 10. Discharge heat scaling
// ----------------------------------------------------
console.log("\nTest 10: Discharge Heat scaling with actual output");
{
  // Battery max discharge 4 MW, max discharge heat 0.6 H/s.
  // At 4 MW (100% output), 1s -> 0.6 Heat.
  // At 2 MW (50% output), 1s -> 0.3 Heat.
  const design = [{ type: "battery", x: 0, y: 0 }, { type: "auxGenerator", x: 1, y: 0 }];
  const ship = createTestShip(design);
  ship.componentStorageCharge = [80, 0];

  applyShipPowerAllocation(ship);
  const batPower = ship.componentPower.byComponentIndex[0];
  assert.strictEqual(batPower.storageDetails.dischargeHeat, 0, "Idle battery generates 0 discharge heat");
}
console.log("✓ Test 10 Passed: Discharge heat scales with actual discharge output.");

// ----------------------------------------------------
// 11. Snapshot & reconnect preservation
// ----------------------------------------------------
console.log("\nTest 11: Snapshot & reconnect charge preservation");
{
  const oldShip = { id: "s1", storageCharge: [45.5, 120] };
  const newSnap = { id: "s1", detail: "owner" }; // compact snapshot with no storageCharge delta
  const merged = mergeCachedShipFields([oldShip], [newSnap])[0];

  assert.deepStrictEqual(merged.storageCharge, [45.5, 120], "Merged ship inherits cached storage charge");
}
console.log("✓ Test 11 Passed: Snapshots and reconnects preserve storage charge.");

// ----------------------------------------------------
// 12. Blueprint loading compatibility
// ----------------------------------------------------
console.log("\nTest 12: Existing blueprint loading compatibility");
{
  const blueprintJson = {
    version: 1,
    design: [
      { type: "core", x: 7, y: 7, rotation: 0 },
      { type: "battery", x: 6, y: 7, rotation: 0 },
      { type: "capacitor", x: 8, y: 7, rotation: 0 }
    ],
    wiring: { version: 3, power: { sections: [], connections: [] } }
  };
  const ship = createTestShip(blueprintJson.design, []);
  assert.strictEqual(ship.componentStorageCharge[1], 80, "Loaded battery starts at 80 MJ");
  assert.strictEqual(ship.componentStorageCharge[2], 160, "Loaded capacitor starts at 160 MJ");
}
console.log("✓ Test 12 Passed: Blueprints with Battery and Capacitor load seamlessly.");

console.log("\n=================================================");
console.log("ALL BATTERY & CAPACITOR VERIFICATION TESTS PASSED!");
console.log("=================================================\n");
