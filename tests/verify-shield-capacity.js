"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ShieldRules = require("../public/src/shared/shieldRules");
const EngineExhaustRules = require("../public/src/shared/engineExhaust");
const WeaponPresentationRules = require("../public/src/shared/weaponPresentationRules");
const BackupCoreRules = require("../public/src/shared/backupCoreRules");
const { PARTS } = require("../src/server/components");
const { computeStats: serverComputeStats } = require("../src/server/shipStats");
const {
  effectiveShieldStats,
  initializeComponentPower
} = require("../src/server/componentPower");
const { initComponentState } = require("../src/server/componentHealth");
const { initShipHeat } = require("../src/server/heat");

globalThis.EngineExhaustRules = EngineExhaustRules;
globalThis.WeaponPresentationRules = WeaponPresentationRules;
globalThis.BackupCoreRules = BackupCoreRules;
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    appendChild() {},
    addEventListener() {},
    getContext: () => null
  }),
  createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  documentElement: { style: { setProperty() {} } },
  body: { classList: { add() {}, remove() {} } }
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };

const TEST_PARTS = Object.freeze({
  shield60: { shield: 60, shieldRegen: 5, mass: 20 },
  shield100: { shield: 100, shieldRegen: 5, mass: 40 },
  shield180: { shield: 180, shieldRegen: 5, mass: 80 },
  armour: { shield: 0, mass: 120 },
  engine: { shield: 0, mass: 50 },
  structure: { shield: 0, mass: 90 }
});

function modulesFor(types) {
  return types.map((type, index) => ({ type, x: index, y: 0, rotation: 0 }));
}

function directCapacity(types, options = {}) {
  return ShieldRules.calculateShieldStats(modulesFor(types), TEST_PARTS, options).capacity;
}

function makeRuntimeShip(design) {
  const ship = {
    design,
    dataLinks: [],
    stats: serverComputeStats(design),
    shield: 0,
    alive: true
  };
  initComponentState(ship);
  initShipHeat(ship);
  initializeComponentPower(ship);
  return ship;
}

function allRows(model) {
  return [
    ...(model.core || []),
    ...(model.capability || []),
    ...(model.thermalSummary || []),
    ...(model.sections || []).flatMap((section) => section.rows || [])
  ];
}

function shieldCapacityFromInspector(model) {
  const row = allRows(model).find((candidate) => candidate.id === "shield.capacity");
  assert.ok(row, "Shield component inspector shows Shield Capacity");
  return Number.parseFloat(row.value);
}

function sourceText(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

async function run() {
  // The shared rule is literal for authored examples and ignores unrelated mass.
  assert.equal(directCapacity(["shield100"]), 100, "one 100-Shield component contributes exactly 100");
  assert.equal(directCapacity(["shield100", "shield100"]), 200, "two 100-Shield components contribute exactly 200");
  assert.equal(directCapacity(["shield60", "shield100", "shield180"]), 340, "60 + 100 + 180 contributes exactly 340");
  assert.equal(directCapacity(["shield100"]), directCapacity(["shield100", "armour", "engine", "structure"]),
    "Armor, Engines, and Structure do not increase Shield Capacity");
  assert.equal(directCapacity(["shield100", "structure"]), 100, "extra structural mass does not change Shield Capacity");
  assert.equal(directCapacity(["shield100", "armour", "armour", "armour"]), 100, "extra armor mass does not change Shield Capacity");
  assert.equal(directCapacity(["shield100", "engine", "engine", "engine"]), 100, "extra engine mass does not change Shield Capacity");

  const lowMassParts = {
    shield100: { shield: 100, mass: 20 },
    extra: { shield: 0, mass: 0 }
  };
  const highMassParts = {
    shield100: { shield: 100, mass: 300 },
    extra: { shield: 0, mass: 0 }
  };
  assert.equal(
    ShieldRules.calculateShieldStats(modulesFor(["shield100"]), lowMassParts).capacity,
    ShieldRules.calculateShieldStats(modulesFor(["shield100"]), highMassParts).capacity,
    "20 T and 300 T Shield designs have identical Shield Capacity"
  );

  const ordered = ShieldRules.calculateShieldStats(modulesFor(["shield60", "shield100", "shield180"]), TEST_PARTS);
  const reversed = ShieldRules.calculateShieldStats(modulesFor(["shield180", "shield100", "shield60"]), TEST_PARTS);
  assert.equal(ordered.capacity, reversed.capacity, "component ordering does not change Shield Capacity");
  assert.deepEqual(ordered.capacityContributions.map(({ capacity }) => capacity), [60, 100, 180]);

  const lowPower = ShieldRules.calculateShieldStats(modulesFor(["shield100"]), TEST_PARTS, {
    powerMultiplier: () => 0.25
  });
  assert.equal(lowPower.capacity, 100, "Power does not scale maximum Shield Capacity");
  assert.equal(lowPower.recharge, 1.25, "Power still scales Shield regeneration");

  const liveModules = modulesFor(["shield100", "shield180"]);
  const allLive = ShieldRules.calculateShieldStats(liveModules, TEST_PARTS);
  const firstDestroyed = ShieldRules.calculateShieldStats(liveModules, TEST_PARTS, { isLive: (index) => index !== 0 });
  const bothDestroyed = ShieldRules.calculateShieldStats(liveModules, TEST_PARTS, { isLive: () => false });
  assert.equal(allLive.capacity, 280, "two live Shield components total 280");
  assert.equal(firstDestroyed.capacity, 180, "destroying one Shield removes exactly its contribution");
  assert.equal(bothDestroyed.capacity, 0, "destroying both Shields removes all capacity");

  // Client and server summaries both resolve through the same shared rule.
  const { PART_STATS, PART_DEFS, partCategory, partDescription } = await import("../public/src/design/parts.js");
  const ClientStats = await import("../public/src/design/componentStats.js");
  const Inspector = await import("../public/src/design/componentInspectorModel.js");
  const shieldTypes = Object.entries(PART_STATS)
    .filter(([type, stat]) => Number(stat.shield || 0) > 0 && Number(PARTS[type]?.shield || 0) > 0)
    .map(([type]) => type);
  assert.ok(shieldTypes.length > 0, "the authoritative catalogue contains Shield components");

  const actualDesign = modulesFor(["core", "reactor", "frame", "armor", "engine", ...shieldTypes]);
  const clientStats = ClientStats.computeStats(actualDesign);
  const serverStats = serverComputeStats(actualDesign);
  const authoredTotal = shieldTypes.reduce((sum, type) => sum + Number(PART_STATS[type].shield || 0), 0);
  assert.equal(clientStats.maxShield, authoredTotal, "Blueprint total Shield equals authored component capacity sum");
  assert.equal(serverStats.maxShield, authoredTotal, "server total Shield equals authored component capacity sum");
  assert.equal(clientStats.maxShield, serverStats.maxShield, "client and server Shield Capacity match exactly");

  const displayedTotal = shieldTypes.reduce((sum, type) => {
    const stat = PART_STATS[type];
    const model = Inspector.buildComponentInspectorModel(type, stat, {
      name: PART_DEFS[type]?.name || type,
      description: partDescription(type, stat),
      category: partCategory(type),
      effectiveCost: `$${stat.cost}`,
      prediction: null
    });
    const displayed = shieldCapacityFromInspector(model);
    assert.equal(displayed, Number(stat.shield), `${type} displays its actual authored Shield contribution`);
    return sum + displayed;
  }, 0);
  assert.equal(displayedTotal, clientStats.maxShield, "Blueprint total equals the sum of displayed component Shield values");

  // Live runtime behaviour still removes destroyed components and preserves the
  // explicit complete-shutdown state, while partial Power leaves capacity full.
  const runtimeType = shieldTypes[0];
  const runtimeDesign = modulesFor(["core", "reactor", runtimeType, runtimeType]);
  const runtimeShip = makeRuntimeShip(runtimeDesign);
  const runtimeShieldCapacity = Number(PARTS[runtimeType].shield || 0);
  const runtimeBefore = effectiveShieldStats(runtimeShip).capacity;
  assert.equal(runtimeBefore, runtimeShieldCapacity * 2, "live runtime sums both Shield components literally");
  runtimeShip.componentPowerState = runtimeShip.componentPowerState || [];
  runtimeShip.componentPowerState[2] = 1;
  runtimeShip.componentPower = runtimeShip.componentPower || {};
  runtimeShip.componentPower.byComponentIndex = runtimeShip.componentPower.byComponentIndex || [];
  runtimeShip.componentPower.byComponentIndex[2] = {
    ...(runtimeShip.componentPower.byComponentIndex[2] || {}),
    operationalMultiplier: 0.25
  };
  runtimeShip.powerRevision = (runtimeShip.powerRevision || 0) + 1;
  runtimeShip._shieldStatsCache = null;
  assert.equal(effectiveShieldStats(runtimeShip).capacity, runtimeBefore, "partial Power does not reduce live maximum capacity");
  runtimeShip.componentHp[3] = 0;
  runtimeShip.componentAliveRevision = (runtimeShip.componentAliveRevision || 0) + 1;
  assert.equal(effectiveShieldStats(runtimeShip).capacity, runtimeShieldCapacity, "destroyed runtime Shield removes exactly its capacity");
  runtimeShip.componentPowerState[2] = 0;
  runtimeShip.powerRevision = (runtimeShip.powerRevision || 0) + 1;
  runtimeShip._shieldStatsCache = null;
  assert.equal(effectiveShieldStats(runtimeShip).capacity, 0, "the existing complete zero-Power shutdown removes the inactive field");

  const sharedSource = sourceText("public/src/shared/shieldRules.js");
  const powerSource = sourceText("src/server/componentPower.js");
  const forbiddenConstant = ["SHIELD", "MASS", "SCALE", "FACTOR"].join("_");
  const forbiddenFunction = ["ship", "Mass", "Shield", "Scale"].join("");
  const forbiddenCapacityOption = ["capacity", "Power", "Multiplier"].join("");
  const forbiddenCapacityHelper = ["get", "Shield", "Capacity", "Power", "Multiplier"].join("");
  assert.equal(ShieldRules[forbiddenConstant], undefined, "the removed mass constant is not exported");
  assert.equal(ShieldRules[forbiddenFunction], undefined, "the removed mass helper is not exported");
  assert.doesNotMatch(sharedSource, /mass/i, "shared Shield rules contain no mass-based capacity code");
  assert.equal(sharedSource.includes(forbiddenCapacityOption), false, "shared Shield capacity has no Power multiplier");
  assert.equal(powerSource.includes(forbiddenCapacityHelper), false, "server Shield capacity has no Power scaling helper");

  assert.equal(ShieldRules.getShieldImpactHeatPerDamage(), 0.12, "Shield impact Heat remains 0.12 H per blocked damage");
  assert.equal(ShieldRules.SHIELD_RESTART_DELAY_MS, 3000, "Shield depletion restart remains 3 seconds");
  assert.equal(ShieldRules.SHIELD_ABSORPTION_FRACTION, 0.95, "Shield absorption has one shared authority");
  assert.equal(ShieldRules.SHIELD_LEAK_FRACTION, 0.05, "Shield leakage is derived from shared absorption");

  console.log("Shield capacity literality, mass independence, runtime destruction, and client/server parity passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
