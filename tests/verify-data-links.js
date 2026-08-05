// Focused tests for explicit direct Data-support links.
const assert = require("assert");
const DataRules = require("../public/src/shared/dataSupportRules");

const PARTS = {
  fireControl: { weapon: false, fireRateBonus: 0.2 },
  signalAmplifier: { weapon: false, rangeBonus: 60 },
  targetingComputer: { weapon: false, accuracyBonus: 0.15 },
  beamEmitter: { weapon: { range: 100, accuracy: 0.8, fireRate: 1, damage: 10 } },
  missile: { weapon: { range: 240, accuracy: 0.7, fireRate: 0.5, damage: 80 } }
};

function design(...types) { return types.map((type, i) => ({ type, x: i, y: 0 })); }
function weaponByIndex(a, i) { return a.weaponBonusByIndex?.[i]; }

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

check("one source to one weapon receives full budget", () => {
  const d = design("fireControl", "beamEmitter");
  const a = DataRules.analyzeDirectDataSupport(d, [{ sourceIndex: 0, targetIndex: 1 }], PARTS);
  assert.strictEqual(a.sourceAllocations[0].bonusPerWeapon, 0.2, "full budget");
  assert.strictEqual(weaponByIndex(a, 1).fireRateBonus, 0.2, "weapon receives");
});

check("one source to two weapons splits equally", () => {
  const d = design("fireControl", "beamEmitter", "beamEmitter");
  const a = DataRules.analyzeDirectDataSupport(d, [{ sourceIndex: 0, targetIndex: 1 }, { sourceIndex: 0, targetIndex: 2 }], PARTS);
  assert.strictEqual(a.sourceAllocations[0].bonusPerWeapon, 0.1, "split");
  assert.strictEqual(weaponByIndex(a, 1).fireRateBonus, 0.1, "w1");
  assert.strictEqual(weaponByIndex(a, 2).fireRateBonus, 0.1, "w2");
});

check("two sources to one weapon stack additively", () => {
  const d = design("fireControl", "signalAmplifier", "beamEmitter");
  const a = DataRules.analyzeDirectDataSupport(d, [{ sourceIndex: 0, targetIndex: 2 }, { sourceIndex: 1, targetIndex: 2 }], PARTS);
  assert.strictEqual(weaponByIndex(a, 2).fireRateBonus, 0.2, "fire rate");
  assert.strictEqual(weaponByIndex(a, 2).rangeBonus, 60, "range");
});

check("overlapping links do not create transitive recipients", () => {
  const d = design("fireControl", "signalAmplifier", "beamEmitter", "beamEmitter");
  const a = DataRules.analyzeDirectDataSupport(d, [
    { sourceIndex: 0, targetIndex: 2 },
    { sourceIndex: 1, targetIndex: 2 },
    { sourceIndex: 1, targetIndex: 3 }
  ], PARTS);
  assert.strictEqual(a.sourceAllocations[0].recipientCount, 1, "A supports only w1");
  assert.strictEqual(a.sourceAllocations[1].recipientCount, 2, "B supports w1 and w2");
  assert.strictEqual(weaponByIndex(a, 3).sourceIndices.length, 1, "w2 only B");
});

check("unlinked source is idle and weapon is unsupported", () => {
  const d = design("fireControl", "beamEmitter");
  const a = DataRules.analyzeDirectDataSupport(d, [], PARTS);
  assert.strictEqual(a.sourceAllocations[0].status, "idle-no-weapons");
  assert.strictEqual(weaponByIndex(a, 1).status, "unsupported");
});

check("normalization removes invalid/duplicate/self links", () => {
  const d = design("fireControl", "beamEmitter");
  const raw = [
    { sourceIndex: 0, targetIndex: 1 },
    { sourceIndex: 0, targetIndex: 1 },
    { sourceIndex: 0, targetIndex: 0 },
    { sourceIndex: 1, targetIndex: 0 },
    { sourceIndex: 5, targetIndex: 1 },
    "malformed"
  ];
  const v = DataRules.validateDataLinks(d, raw, PARTS);
  assert.strictEqual(v.valid.length, 1, "only one valid");
  assert.ok(v.rejected.length >= 4, "rejects bad entries");
  const n = DataRules.normalizeDataLinks(d, raw, PARTS);
  assert.deepStrictEqual(n, [{ sourceIndex: 0, targetIndex: 1 }]);
});

console.log("\nDone.");
