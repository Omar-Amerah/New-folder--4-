"use strict";

const assert = require("assert");
const Rules = require("./public/src/shared/dataSupportRules");
const WiringRules = require("./public/src/shared/wiringRules");
const { PARTS } = require("./src/server/components");

const moduleAt = (type, x = 0, y = 0) => ({ type, x, y, rotation: 0 });
const network = (sources, weapons, id = "data-a", sections = ["0,0:1,0"]) => ({ id, label: "Data Network A", sourceIndices: sources, weaponIndices: weapons, sectionIds: sections });
const analyze = (types, networks, options) => Rules.analyzeDataSupport(types.map((type, i) => moduleAt(type, i, 0)), networks, PARTS, options);
const budget = (type) => Rules.nominalSupportBudget(type, PARTS);
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} !== ${expected}`);

for (const [source, field, count] of [["fireControl", "fireRateBonus", 1], ["fireControl", "fireRateBonus", 3], ["sensorArray", "rangeBonus", 2], ["targetingComputer", "accuracyBonus", 4], ["signalAmplifier", "rangeBonus", 1], ["stabilizerNode", "accuracyBonus", 1]]) {
  const types = [source, ...Array(count).fill("railgun")];
  const result = analyze(types, [network([0], Array.from({ length: count }, (_, i) => i + 1))]);
  result.weaponBonuses.forEach((weapon) => close(weapon[field], budget(source) / count, `${source} equal split`));
  close(result.sourceAllocations[0].effectiveBudget, budget(source), `${source} catalogue budget`);
}
assert.equal(PARTS.stabilizerNode.turn, PARTS.stabilizerNode.turn, "allocation does not alter the stabilizer turn stat");

let result = analyze(["fireControl", "railgun"], [network([0], [])]);
assert.equal(result.sources[0].status, "idle-no-weapons");
assert.equal(result.weapons[0].fireRateBonus, 0);
result = analyze(["railgun"], [network([], [0])]);
assert.equal(result.weapons[0].status, "connected-unsupported");
assert.deepEqual([result.weapons[0].rangeBonus, result.weapons[0].accuracyBonus, result.weapons[0].fireRateBonus], [0, 0, 0]);

result = analyze(["targetingComputer", "targetingComputer", "railgun", "railgun"], [network([1, 0], [3, 2])]);
result.weapons.forEach((weapon) => close(weapon.accuracyBonus, budget("targetingComputer"), "identical sources stack independently"));
assert(result.weapons.every((weapon) => weapon.contributions.length === 2 && weapon.contributions.every((item) => Number.isInteger(item.sourceIndex))));
result = analyze(["sensorArray", "signalAmplifier", "targetingComputer", "fireControl", "railgun"], [network([3, 1, 2, 0], [4])]);
close(result.weapons[0].rangeBonus, budget("sensorArray") + budget("signalAmplifier"), "range sources stack");
close(result.weapons[0].accuracyBonus, budget("targetingComputer"), "accuracy remains independent");
close(result.weapons[0].fireRateBonus, budget("fireControl"), "fire rate remains independent");

for (const [value, expected] of [[1, 1], [0.5, 0.5], [0, 0], [-1, 0], [NaN, 0], [Infinity, 0], ["bad", 0], [2, 1]]) assert.equal(Rules.normalizeSourceMultiplier(value), expected);
assert.equal(Rules.normalizeSourceMultiplier(), 1);
result = analyze(["fireControl", "railgun", "railgun"], [network([0], [1, 2])], { sourceMultiplier: () => 0.5, isWeaponEligible: (index) => index !== 2 });
close(result.sources[0].bonusPerWeapon, budget("fireControl") * 0.5, "eligibility redistributes after multiplier");
assert.equal(analyze(["fireControl", "railgun"], [network([0], [1])], { isSourceEligible: () => false }).sources[0].status, "disabled");

const duplicated = analyze(["fireControl", "railgun"], [network([0, 0], [1, 1], "b", ["z", "a"]), network([0], [1], "a", ["c"])]);
assert.equal(duplicated.sourceAllocations.length, 1);
close(duplicated.sources[0].bonusPerWeapon, budget("fireControl"), "duplicate source gets one budget");
assert.equal(duplicated.networkCount, 1);
assert.equal(duplicated.warnings[0].code, "merged-overlapping-data-domains");
const passive = analyze(["fireControl", "railgun", "frame", "sensorArray", "beam"], [network([0], [1], "a"), network([3], [4], "b")]);
assert.equal(passive.networkCount, 2, "passive hosts do not merge allocation domains");

const base = { type: "railgun", range: 100, accuracy: 0.98, fireRate: 2, damage: 10 };
const copy = { ...base };
const profile = Rules.effectiveWeaponProfile(base, { rangeBonus: 20, accuracyBonus: 0.2, fireRateBonus: 0.5 });
assert.deepEqual(base, copy); assert.equal(profile.range, 120); assert.equal(profile.accuracy, 0.99); assert.equal(profile.fireRate, 3); close(profile.reload, 1000 / 3, "reload recalculated");
const zero = Rules.effectiveWeaponProfile(base, Rules.weaponSupportForIndex({}, 0));
assert.equal(zero.range, base.range); assert.equal(zero.accuracy, base.accuracy); assert.equal(zero.fireRate, base.fireRate); Object.values({ range: zero.range, accuracy: zero.accuracy, fireRate: zero.fireRate, reload: zero.reload }).forEach(Number.isFinite);

const frozenDesign = Object.freeze([Object.freeze(moduleAt("fireControl")), Object.freeze(moduleAt("railgun", 1))]);
const frozenNetworks = Object.freeze([Object.freeze({ ...network([0], [1]), sourceIndices: Object.freeze([0]), weaponIndices: Object.freeze([1]), sectionIds: Object.freeze(["b", "a"]) })]);
const first = Rules.analyzeDataSupport(frozenDesign, frozenNetworks, Object.freeze(PARTS));
const second = Rules.analyzeDataSupport(frozenDesign, [...frozenNetworks].reverse(), PARTS);
assert.deepEqual(first, second); assert.doesNotThrow(() => JSON.stringify(first));
assert.notStrictEqual(first.networks[0].sectionIds, frozenNetworks[0].sectionIds);

const physicalDesign = [moduleAt("fireControl", 0), moduleAt("frame", 1), moduleAt("railgun", 2)];
let wiring = WiringRules.emptyWiring();
wiring = WiringRules.addPath(wiring, "data", [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }], physicalDesign, PARTS);
wiring.data.connections = [{ sourceIndex: 99, targetIndex: 99, sectionIds: [] }];
const physical = WiringRules.analyzeWiring(physicalDesign, wiring, PARTS);
assert.equal(physical.data.supportAnalysis.version, 1); close(physical.data.weaponBonuses[0].fireRateBonus, budget("fireControl"), "physical topology is authoritative");
assert.deepEqual(physical.data.supports[0].connectedWeaponIndices, [2]);

console.log("Data support rules verification passed.");
