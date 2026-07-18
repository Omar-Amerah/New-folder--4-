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
const stabilizerBefore = { ...PARTS.stabilizerNode };
analyze(["stabilizerNode", "railgun"], [network([0], [1])]);
assert.deepEqual(PARTS.stabilizerNode, stabilizerBefore, "allocation does not alter stabilizer catalogue stats");

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
assert.equal(zero.range, base.range); assert.equal(zero.accuracy, base.accuracy); assert.equal(zero.fireRate, base.fireRate); Object.values({ range: zero.range, accuracy: zero.accuracy, fireRate: zero.fireRate, reload: zero.reload }).forEach((value) => assert(Number.isFinite(value)));

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

// 6A hardening regression coverage.
const malformed = analyze(["fireControl", "railgun"], [{
  id: "malformed",
  sourceIndices: ["null", "undefined", "", "0", true, false, 0.1, -1, "NaN", "Infinity", 99],
  weaponIndices: ["null", "undefined", "", "1", true, false, 1.1, -1, "NaN", "Infinity", 99],
  sectionIds: ["m"]
}]);
assert.equal(malformed.networkCount, 0, "malformed indexes cannot coerce into component indexes 0 or 1");
assert.equal(malformed.sources[0].status, "idle-no-weapons");
assert.equal(malformed.weapons[0].status, "disconnected");

const idlessTypes = ["fireControl", "railgun", "sensorArray", "beam"];
const idlessA = [network([2], [3], undefined, ["c", "b"]), network([0], [1], undefined, ["a"])]
  .map(({ label, ...item }) => item);
const idlessB = [...idlessA].reverse();
assert.deepEqual(analyze(idlessTypes, idlessA), analyze(idlessTypes, idlessB), "ID-less network fallback identities are order-independent");

const explicit = analyze(idlessTypes, [{ id: "explicit-data", sourceIndices: [0], weaponIndices: [1], sectionIds: ["x"] }]);
assert.equal(explicit.networks[0].id, "explicit-data", "explicit valid network IDs are preserved");

const catalogueWeapons = ["blaster", "railgun", "beamEmitter", "missile", "pointDefense"];
const compatibility = analyze(["fireControl", ...catalogueWeapons], [network([0], catalogueWeapons.map((_, i) => i + 1))]);
assert.deepEqual(compatibility.weapons.map((weapon) => weapon.weaponType), catalogueWeapons);
assert(compatibility.weapons.every((weapon) => weapon.status === "supported"), "all representative catalogue weapon families are Section 6A compatible");

const baseWeapon = PARTS.railgun.weapon;
const baseWeaponBefore = { ...baseWeapon };
const supportedProfile = Rules.effectiveWeaponProfile(baseWeapon, { fireRateBonus: 0.5 });
assert(supportedProfile.dps > baseWeapon.dps, "DPS increases with fire-rate support");
close(supportedProfile.dps, supportedProfile.damage * supportedProfile.fireRate, "DPS matches effective damage times fire rate");
close(supportedProfile.reload, 1000 / supportedProfile.fireRate, "reload matches resulting fire rate");
assert.deepEqual(PARTS.railgun.weapon, baseWeaponBefore, "effective profile does not mutate catalogue weapon object");
const zeroProfile = Rules.effectiveWeaponProfile(baseWeapon, { rangeBonus: 0, accuracyBonus: 0, fireRateBonus: 0 });
close(zeroProfile.dps, baseWeapon.dps, "zero support preserves base DPS");
Object.values({ range: zeroProfile.range, accuracy: zeroProfile.accuracy, fireRate: zeroProfile.fireRate, reload: zeroProfile.reload, dps: zeroProfile.dps }).forEach((value) => assert(Number.isFinite(value), "effective weapon profile values are finite"));
const unsupportedProfile = Rules.effectiveWeaponProfile({ type: "frame", custom: 7 }, { fireRateBonus: 1 });
assert.equal(unsupportedProfile.custom, 7, "unsupported profiles retain original effective values");

const shuffledTypes = ["railgun", "fireControl", "beamEmitter", "sensorArray", "missile", "targetingComputer"];
const shuffledNetworks = [
  { id: "z", sourceIndices: [5, 3], weaponIndices: [4, 2], sectionIds: ["z2", "z1"] },
  { id: "a", sourceIndices: [1], weaponIndices: [0], sectionIds: ["a2", "a1"] }
];
const stableA = analyze(shuffledTypes, shuffledNetworks);
const stableB = analyze(shuffledTypes, shuffledNetworks.map((n) => ({ ...n, sourceIndices: [...n.sourceIndices].reverse(), weaponIndices: [...n.weaponIndices].reverse(), sectionIds: [...n.sectionIds].reverse() })).reverse());
assert.deepEqual(stableA, stableB, "stable ordering survives shuffled network, source, weapon, contribution, and warning inputs");

const overlap = analyze(["fireControl", "railgun", "beamEmitter", "frame", "sensorArray", "missile"], [
  { id: "b", sourceIndices: [0], weaponIndices: [1], sectionIds: ["b"] },
  { id: "a", sourceIndices: [0], weaponIndices: [2], sectionIds: ["a"] },
  { id: "c", sourceIndices: [4], weaponIndices: [5], sectionIds: ["c"] }
]);
assert.equal(overlap.networkCount, 2);
assert.equal(overlap.sources.find((s) => s.sourceIndex === 0).effectiveBudget, budget("fireControl"));
assert.equal(overlap.sources.find((s) => s.sourceIndex === 0).recipientCount, 2);
overlap.weapons.filter((w) => [1, 2].includes(w.weaponIndex)).forEach((weapon) => assert.deepEqual(weapon.sourceIndices, [0], "no duplicate source entries in contributions"));
assert.deepEqual(overlap.warnings.map((w) => w.code), ["merged-overlapping-data-domains"]);

const multiDesign = [moduleAt("fireControl", 0, 0), moduleAt("railgun", 0, 1), moduleAt("beamEmitter", 2, 0)];
let multiWiring = WiringRules.emptyWiring();
multiWiring = WiringRules.addPath(multiWiring, "data", [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 0, y: 2 }, { x: 0, y: 3 }], multiDesign, PARTS);
let multiPhysical = WiringRules.analyzeWiring(multiDesign, multiWiring, PARTS).data.supportAnalysis;
assert.deepEqual(multiPhysical.networks[0].weaponIndices, [1], "multi-cell weapon appears once");
assert.deepEqual(multiPhysical.sources[0].connectedWeaponIndices, [1], "multi-cell weapon is one recipient");
close(multiPhysical.sources[0].bonusPerWeapon, budget("fireControl"), "multi-cell weapon receives one contribution and source budget is not multiplied");

const exitsDesign = [moduleAt("fireControl", 0, 0), moduleAt("railgun", 1, 0), moduleAt("beamEmitter", 0, 1)];
let exitsWiring = WiringRules.emptyWiring();
exitsWiring = WiringRules.addPath(exitsWiring, "data", [{ x: 0, y: 0 }, { x: 1, y: 0 }], exitsDesign, PARTS);
exitsWiring = WiringRules.addPath(exitsWiring, "data", [{ x: 0, y: 0 }, { x: 0, y: 1 }], exitsDesign, PARTS);
const exitsPhysical = WiringRules.analyzeWiring(exitsDesign, exitsWiring, PARTS).data.supportAnalysis;
assert.deepEqual(exitsPhysical.networks[0].sourceIndices, [0], "source touching multiple exits appears once");
assert.equal(exitsPhysical.sources[0].recipientCount, 2);
close(exitsPhysical.sources[0].effectiveBudget, budget("fireControl"), "repeated source exits keep one total budget");
close(exitsPhysical.sources[0].bonusPerWeapon, budget("fireControl") / 2, "repeated source exits do not duplicate contributions");


console.log("Data support rules verification passed.");
