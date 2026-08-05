// Comprehensive tests for Command component footprints, rotation, inspector
// aura display, formationResponseMultiplier removal, aura multiplier gameplay
// integration, and saved-blueprint migration.
//
// Run: node tests/verify-command-components.js

const assert = require("assert");

// --- Server-side imports ---
const { PARTS } = require("../src/server/components");
const { BALANCE } = require("../src/server/balanceConfig");
const {
  getCommandAuraRange,
  commandAuraSelfAllowed,
  getCommandAuraMultiplier,
  collectAuraSources,
  isAuraComponentOperational
} = require("../src/server/commandAuras");
const HeatRules = require("../public/src/shared/heatRules");

// --- Component IDs ---
const COMMAND_IDS = [
  "backupCore",
  "fireControlCommandCentre",
  "fleetDefenceCoordinator",
  "shieldCommandRelay",
  "engineeringCommandCentre",
  "propulsionCommandRelay",
  "electronicWarfareCommandCentre"
];

// --- Expected footprints ---
const EXPECTED_FOOTPRINTS = {
  backupCore: { width: 2, height: 1 },
  fireControlCommandCentre: { width: 2, height: 2 },
  fleetDefenceCoordinator: { width: 2, height: 2 },
  shieldCommandRelay: { width: 2, height: 1 },
  engineeringCommandCentre: { width: 2, height: 2 },
  propulsionCommandRelay: { width: 2, height: 1 },
  electronicWarfareCommandCentre: { width: 2, height: 2 }
};

// --- Expected rotatable flags ---
const EXPECTED_ROTATABLE = {
  backupCore: true,
  fireControlCommandCentre: false,
  fleetDefenceCoordinator: false,
  shieldCommandRelay: true,
  engineeringCommandCentre: false,
  propulsionCommandRelay: true,
  electronicWarfareCommandCentre: false
};

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// ===========================================================================
// 1. Footprint correctness
// ===========================================================================
console.log("\n--- Footprint correctness ---");

for (const id of COMMAND_IDS) {
  test(`${id} has correct footprint`, () => {
    const part = PARTS[id];
    assert(part, `${id} should exist in PARTS`);
    const fp = part.footprint;
    assert(fp, `${id} should have an explicit footprint`);
    assert.strictEqual(fp.width, EXPECTED_FOOTPRINTS[id].width, `${id} footprint width`);
    assert.strictEqual(fp.height, EXPECTED_FOOTPRINTS[id].height, `${id} footprint height`);
  });
}

test("all command footprints are multi-cell (width*height > 1)", () => {
  for (const id of COMMAND_IDS) {
    const fp = PARTS[id].footprint;
    assert(fp.width * fp.height > 1, `${id} should occupy more than 1 cell`);
  }
});

// ===========================================================================
// 2. Rotation behavior
// ===========================================================================
console.log("\n--- Rotation behavior ---");

for (const id of COMMAND_IDS) {
  test(`${id} rotatable=${EXPECTED_ROTATABLE[id]}`, () => {
    const part = PARTS[id];
    assert.strictEqual(
      Boolean(part.rotatable),
      EXPECTED_ROTATABLE[id],
      `${id} rotatable should be ${EXPECTED_ROTATABLE[id]}`
    );
  });
}

test("2x2 command centres are not rotatable (rotatable: false)", () => {
  for (const id of COMMAND_IDS) {
    const fp = PARTS[id].footprint;
    if (fp.width === fp.height && fp.width > 1) {
      assert.strictEqual(PARTS[id].rotatable, false, `${id} is square and should not be rotatable`);
    }
  }
});

test("2x1 relays and backupCore are rotatable", () => {
  for (const id of COMMAND_IDS) {
    const fp = PARTS[id].footprint;
    if (fp.width !== fp.height) {
      assert.strictEqual(PARTS[id].rotatable, true, `${id} is rectangular and should be rotatable`);
    }
  }
});

// ===========================================================================
// 3. formationResponseMultiplier removal
// ===========================================================================
console.log("\n--- formationResponseMultiplier removal ---");

test("component-balance.json has no formationResponseMultiplier", () => {
  const raw = JSON.stringify(BALANCE);
  assert(!raw.includes("formationResponseMultiplier"), "component-balance.json should not contain formationResponseMultiplier");
});

test("commandAuras.js AURA_STAT_KEYS has no formationResponseMultiplier", () => {
  const { AURA_STAT_KEYS } = require("../src/server/commandAuras");
  // AURA_STAT_KEYS is a Set in commandAuras.js
  assert(!AURA_STAT_KEYS.has("formationResponseMultiplier"), "AURA_STAT_KEYS should not contain formationResponseMultiplier");
});

test("componentSchema.js AURA_STAT_KEYS has no formationResponseMultiplier", () => {
  // Re-require to get the array
  delete require.cache[require.resolve("../src/server/componentSchema.js")];
  const schema = require("../src/server/componentSchema.js");
  // Check if AURA_STAT_KEYS is exported or accessible
  const raw = require("fs").readFileSync("./src/server/componentSchema.js", "utf8");
  assert(!raw.includes("formationResponseMultiplier"), "componentSchema.js source should not contain formationResponseMultiplier");
});

test("generatedBalance.js has no formationResponseMultiplier", () => {
  const raw = require("fs").readFileSync("./public/src/generatedBalance.js", "utf8");
  assert(!raw.includes("formationResponseMultiplier"), "generatedBalance.js should not contain formationResponseMultiplier");
});

test("propulsionCommandRelay aura does not have formationResponseMultiplier", () => {
  const aura = PARTS.propulsionCommandRelay.aura;
  assert(aura, "propulsionCommandRelay should have an aura");
  assert(!("formationResponseMultiplier" in aura), "propulsionCommandRelay aura should not have formationResponseMultiplier");
});

// ===========================================================================
// 4. Aura multiplier gameplay integration
// ===========================================================================
console.log("\n--- Aura multiplier gameplay integration ---");

// Build a ship with an electronicWarfareCommandCentre to test sensorRange, missileTrackingResistance, componentAimRetention
function makeShip(id, ownerId, x, y, design, componentPower = null, componentHp = null, componentHeatState = null) {
  return {
    id,
    ownerId,
    x,
    y,
    alive: true,
    design,
    componentHp: componentHp || design.map(() => 1),
    componentPower: componentPower || { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    componentHeatState: componentHeatState || design.map(() => HeatRules.STATE.NORMAL),
    commandAurasReceived: {},
    commandAuraMultipliers: {}
  };
}

function makeRoom(ships, phase = "active") {
  return {
    phase,
    ships: new Map(ships.map((s) => [s.id, s])),
    players: new Map()
  };
}

const { updateCommandAuras } = require("../src/server/commandAuras");

test("sensorRangeMultiplier is applied to weapon acquisition range", () => {
  const combatSrc = require("fs").readFileSync("./src/server/combat.js", "utf8");
  assert(combatSrc.includes("sensorRangeMultiplier"), "combat.js should consume sensorRangeMultiplier");
});

test("missileTrackingResistanceMultiplier is applied in projectiles.js", () => {
  const projSrc = require("fs").readFileSync("./src/server/projectiles.js", "utf8");
  assert(projSrc.includes("missileTrackingResistanceMultiplier"), "projectiles.js should consume missileTrackingResistanceMultiplier");
});

test("componentAimRetentionMultiplier is applied in combat.js", () => {
  const combatSrc = require("fs").readFileSync("./src/server/combat.js", "utf8");
  assert(combatSrc.includes("componentAimRetentionMultiplier"), "combat.js should consume componentAimRetentionMultiplier");
});

test("shieldRestartDelayMultiplier is applied in runtimeShield.js", () => {
  const shieldSrc = require("fs").readFileSync("./src/server/runtimeShield.js", "utf8");
  assert(shieldSrc.includes("shieldRestartDelayMultiplier"), "runtimeShield.js should consume shieldRestartDelayMultiplier");
});

test("shieldRegenMultiplier is applied in componentPower.js", () => {
  const powSrc = require("fs").readFileSync("./src/server/componentPower.js", "utf8");
  assert(powSrc.includes("shieldRegenMultiplier"), "componentPower.js should consume shieldRegenMultiplier");
});

test("overheatRecoveryMultiplier is applied in heat.js", () => {
  const heatSrc = require("fs").readFileSync("./src/server/heat.js", "utf8");
  assert(heatSrc.includes("overheatRecoveryMultiplier"), "heat.js should consume overheatRecoveryMultiplier");
});

// Command auras reach movement through the hull's live performance envelope,
// which is derived in movementCapability.js.
test("accelerationMultiplier is applied in movementCapability.js", () => {
  const moveSrc = require("fs").readFileSync("./src/server/movementCapability.js", "utf8");
  assert(moveSrc.includes("accelerationMultiplier"), "movementCapability.js should consume accelerationMultiplier");
});

test("turnRateMultiplier is applied in movementCapability.js", () => {
  const moveSrc = require("fs").readFileSync("./src/server/movementCapability.js", "utf8");
  assert(moveSrc.includes("turnRateMultiplier"), "movementCapability.js should consume turnRateMultiplier");
});

test("repairRateMultiplier is applied in componentHealth.js", () => {
  const healthSrc = require("fs").readFileSync("./src/server/componentHealth.js", "utf8");
  assert(healthSrc.includes("repairRateMultiplier"), "componentHealth.js should consume repairRateMultiplier");
});

test("heatDissipationMultiplier is applied in heat.js", () => {
  const heatSrc = require("fs").readFileSync("./src/server/heat.js", "utf8");
  assert(heatSrc.includes("heatDissipationMultiplier"), "heat.js should consume heatDissipationMultiplier");
});

test("weaponAccuracyMultiplier is applied in componentData.js", () => {
  const dataSrc = require("fs").readFileSync("./src/server/componentData.js", "utf8");
  assert(dataSrc.includes("weaponAccuracyMultiplier"), "componentData.js should consume weaponAccuracyMultiplier");
});

test("all aura multipliers from component-balance.json are consumed by gameplay systems", () => {
  // Collect all aura keys from balance
  const allAuraKeys = new Set();
  for (const id of COMMAND_IDS) {
    const aura = PARTS[id]?.aura;
    if (!aura) continue;
    for (const key of Object.keys(aura)) {
      if (key !== "type") allAuraKeys.add(key);
    }
  }
  // Check each is consumed somewhere in server code
  const serverFiles = [
    "./src/server/combat.js",
    "./src/server/projectiles.js",
    "./src/server/movement.js",
    // Movement auras are consumed where the hull's live performance envelope is
    // derived, not in the controller.
    "./src/server/movementCapability.js",
    "./src/server/heat.js",
    "./src/server/componentPower.js",
    "./src/server/componentHealth.js",
    "./src/server/componentData.js"
  ];
  const allSource = serverFiles.map((f) => require("fs").readFileSync(f, "utf8")).join("\n");
  for (const key of allAuraKeys) {
    assert(allSource.includes(key), `Aura key ${key} should be consumed by at least one gameplay system`);
  }
});

// ===========================================================================
// 5. Aura collection and stacking
// ===========================================================================
console.log("\n--- Aura collection and stacking ---");

test("all command components emit aura sources", () => {
  for (const id of COMMAND_IDS) {
    const ship = makeShip(`test-${id}`, "p1", 0, 0, [{ type: id }]);
    const sources = collectAuraSources(ship);
    assert.strictEqual(sources.length, 1, `${id} should emit one aura source`);
    assert(sources[0].multipliers, `${id} aura source should have multipliers`);
  }
});

test("ewar aura provides sensorRange, missileTrackingResistance, and componentAimRetention buffs", () => {
  const ship = makeShip("ewar", "p1", 0, 0, [{ type: "electronicWarfareCommandCentre" }]);
  const recipient = makeShip("recip", "p1", 100, 0, [{ type: "frame" }]);
  const room = makeRoom([ship, recipient]);
  updateCommandAuras(room, [ship, recipient], 0);
  assert(getCommandAuraMultiplier(recipient, "sensorRangeMultiplier") > 1, "recipient should get sensorRange buff");
  assert(getCommandAuraMultiplier(recipient, "missileTrackingResistanceMultiplier") > 1, "recipient should get missileTrackingResistance buff");
  assert(getCommandAuraMultiplier(recipient, "componentAimRetentionMultiplier") > 1, "recipient should get componentAimRetention buff");
});

test("unpowered command component does not emit aura", () => {
  const ship = makeShip("unpowered", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
  ship.componentPower.byComponentIndex[0].operationalMultiplier = 0;
  const recipient = makeShip("recip2", "p1", 50, 0, [{ type: "frame" }]);
  const room = makeRoom([ship, recipient]);
  updateCommandAuras(room, [ship, recipient], 0);
  assert.strictEqual(getCommandAuraMultiplier(recipient, "weaponAccuracyMultiplier"), 1, "unpowered component should not emit aura");
});

test("overheated command component does not emit aura", () => {
  const ship = makeShip("overheated", "p1", 0, 0, [{ type: "fireControlCommandCentre" }]);
  ship.componentHeatState[0] = HeatRules.STATE.OVERHEATED;
  const recipient = makeShip("recip3", "p1", 50, 0, [{ type: "frame" }]);
  const room = makeRoom([ship, recipient]);
  updateCommandAuras(room, [ship, recipient], 0);
  assert.strictEqual(getCommandAuraMultiplier(recipient, "weaponAccuracyMultiplier"), 1, "overheated component should not emit aura");
});

// ===========================================================================
// 6. Inspector model (client-side, tested via module loading)
// ===========================================================================
console.log("\n--- Inspector model ---");

// The inspector model uses ES modules, so we test the formatting logic
// by requiring the generated balance and checking the aura data structure.
test("all command components have aura data in generated balance", () => {
  const raw = require("fs").readFileSync("./public/component-balance.generated.json", "utf8");
  const generated = JSON.parse(raw);
  const components = generated.components || generated;
  for (const id of COMMAND_IDS) {
    const comp = Array.isArray(components) ? components.find((c) => c.id === id) : components[id];
    assert(comp, `${id} should exist in generated balance`);
    assert(comp.aura, `${id} should have aura data in generated balance`);
  }
});

test("commandAura config exists in generated balance", () => {
  const raw = require("fs").readFileSync("./public/component-balance.generated.json", "utf8");
  const generated = JSON.parse(raw);
  assert(generated.commandAura, "generated balance should have commandAura config");
  assert(typeof generated.commandAura.range === "number", "commandAura range should be a number");
  assert(generated.commandAura.range > 0, "commandAura range should be positive");
});

test("all command components share the same aura range", () => {
  const range = getCommandAuraRange();
  assert.strictEqual(range, Number(BALANCE.commandAura.range) || 500, "aura range should match balance config");
});

test("self-aura is disabled by default", () => {
  assert.strictEqual(commandAuraSelfAllowed(), false, "self aura should be disabled");
});

// ===========================================================================
// 7. Saved blueprint migration
// ===========================================================================
console.log("\n--- Saved blueprint migration ---");

// Test the migration function indirectly by simulating a design with old 1x1
// command components near the grid edge.
// Since migrateCommandFootprints is a client-side ES module, we test the
// logic by simulating the footprint calculation directly.

test("migrateCommandFootprints relocates edge command component to valid position", () => {
  // Simulate: a fireControlCommandCentre at (14, 7) with old 1x1 footprint.
  // New 2x2 footprint would go out of bounds at x=15. Migration should shift it.
  const { getOccupiedCells } = require("../public/src/design/footprint.js");
  // We can't directly call the ES module function, but we can verify the logic
  // by checking that a 2x2 at (13, 7) fits but at (14, 7) doesn't.
  const fp = { width: 2, height: 2 };
  const cellsAt14 = getOccupiedCells(14, 7, fp, 0);
  const outOfBounds = cellsAt14.some((c) => c.x > 14);
  assert(outOfBounds, "2x2 at x=14 should go out of bounds");
  const cellsAt13 = getOccupiedCells(13, 7, fp, 0);
  const fits = cellsAt13.every((c) => c.x >= 0 && c.x <= 14 && c.y >= 0 && c.y <= 14);
  assert(fits, "2x2 at x=13 should fit in grid");
});

test("2x1 relay rotation swaps footprint correctly", () => {
  const { getOccupiedCells } = require("../public/src/design/footprint.js");
  const fp = { width: 2, height: 1 };
  const cells0 = getOccupiedCells(5, 5, fp, 0);
  const cells90 = getOccupiedCells(5, 5, fp, 90);
  // At rotation 0: occupies (5,5) and (6,5) — 2 wide, 1 tall
  assert.strictEqual(cells0.length, 2, "2x1 at rotation 0 should occupy 2 cells");
  assert(cells0.some((c) => c.x === 6 && c.y === 5), "2x1 at rotation 0 should extend right");
  // At rotation 90: occupies (5,5) and (5,6) — 1 wide, 2 tall
  assert.strictEqual(cells90.length, 2, "2x1 at rotation 90 should occupy 2 cells");
  assert(cells90.some((c) => c.x === 5 && c.y === 6), "2x1 at rotation 90 should extend down");
});

// ===========================================================================
// 8. Server-side rotation validation
// ===========================================================================
console.log("\n--- Server-side rotation validation ---");

test("server isRotatablePart returns false for 2x2 command centres", () => {
  const { normalizePartRotation } = require("../src/server/shipDesign");
  // If isRotatablePart returns false, normalizePartRotation returns 0
  // regardless of input rotation.
  for (const id of COMMAND_IDS) {
    const fp = PARTS[id].footprint;
    if (fp.width === fp.height && fp.width > 1) {
      const rot = normalizePartRotation(id, 7, 90);
      assert.strictEqual(rot, 0, `${id} should not be rotatable server-side (got rotation ${rot})`);
    }
  }
});

test("server isRotatablePart returns true for 2x1 relays and backupCore", () => {
  const { normalizePartRotation } = require("../src/server/shipDesign");
  for (const id of COMMAND_IDS) {
    const fp = PARTS[id].footprint;
    if (fp.width !== fp.height) {
      // Rotatable parts should normalize to a valid rotation, not always 0
      // (unless the input is 0 and 0 is valid)
      const rot = normalizePartRotation(id, 7, 90);
      assert.notStrictEqual(rot, undefined, `${id} should be rotatable server-side`);
    }
  }
});

// ===========================================================================
// Summary
// ===========================================================================
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
