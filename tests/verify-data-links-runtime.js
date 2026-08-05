// Focused runtime tests for explicit direct Data-support links.
const assert = require("assert");
const DataRules = require("./public/src/shared/dataSupportRules");
const ComponentData = require("./src/server/componentData");
const { PARTS } = require("./src/server/components");

globalThis.DataSupportRules = DataRules;

global.__mfaDataSupportPerf = {};

function makeShip(design, dataLinks) {
  return {
    design,
    dataLinks,
    componentHp: design.map(() => 1),
    componentPower: { byComponentIndex: design.map((_, i) => ({ operationalMultiplier: 1 })) },
    componentHeatState: design.map(() => globalThis.HeatRules?.STATE?.NORMAL || 0)
  };
}

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

check("runtime one source one weapon", () => {
  const nominal = PARTS.fireControl.fireRateBonus;
  const ship = makeShip([
    { type: "fireControl" },
    { type: "beamEmitter" }
  ], [{ sourceIndex: 0, targetIndex: 1 }]);
  ComponentData.rebuildShipDataSupport(ship);
  assert.strictEqual(ComponentData.getSourceDataAllocation(ship, 0).bonusPerWeapon, nominal, "source");
  const weapon = ComponentData.getWeaponDataSupport(ship, 1);
  assert.strictEqual(weapon.fireRateBonus, nominal, "weapon");
  const stats = ComponentData.getEffectiveWeaponStats(ship, 1);
  assert.ok(stats.fireRate > 1, "effective fire rate");
});

check("runtime one source two weapons", () => {
  const nominal = PARTS.fireControl.fireRateBonus;
  const ship = makeShip([
    { type: "fireControl" },
    { type: "beamEmitter" },
    { type: "beamEmitter" }
  ], [{ sourceIndex: 0, targetIndex: 1 }, { sourceIndex: 0, targetIndex: 2 }]);
  ComponentData.rebuildShipDataSupport(ship);
  assert.strictEqual(ComponentData.getSourceDataAllocation(ship, 0).bonusPerWeapon, nominal / 2, "split");
});

check("runtime destroyed source contributes zero", () => {
  const ship = makeShip([
    { type: "fireControl" },
    { type: "beamEmitter" }
  ], [{ sourceIndex: 0, targetIndex: 1 }]);
  ship.componentHp[0] = 0;
  ComponentData.rebuildShipDataSupport(ship);
  const source = ComponentData.getSourceDataAllocation(ship, 0);
  assert.strictEqual(source.sourceMultiplier, 0, "source multiplier");
  const weapon = ComponentData.getWeaponDataSupport(ship, 1);
  assert.strictEqual(weapon.fireRateBonus, 0, "no bonus");
});

check("runtime destroyed weapon removed from recipients", () => {
  const nominal = PARTS.fireControl.fireRateBonus;
  const ship = makeShip([
    { type: "fireControl" },
    { type: "beamEmitter" },
    { type: "beamEmitter" }
  ], [{ sourceIndex: 0, targetIndex: 1 }, { sourceIndex: 0, targetIndex: 2 }]);
  ship.componentHp[1] = 0;
  ComponentData.rebuildShipDataSupport(ship);
  assert.strictEqual(ComponentData.getSourceDataAllocation(ship, 0).bonusPerWeapon, nominal, "remaining weapon");
});

console.log("\nDone.");
