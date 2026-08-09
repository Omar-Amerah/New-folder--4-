"use strict";

const assert = require("assert");
const Rules = require("../public/src/shared/dataSupportRules");
const { PARTS } = require("../src/server/components");

const at = (type, x, y = 0) => ({ type, x, y, rotation: 0 });
const budget = (type) => Rules.nominalSupportBudget(type, PARTS);
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-12, message + ": " + actual + " !== " + expected);
const direct = (design, links, options) => Rules.analyzeDirectDataSupport(design, links, PARTS, options);

const farApart = [
  at("fireControl", 0, 0),
  at("railgun", 14, 14),
  at("blaster", 1, 13),
  at("beamEmitter", 13, 1)
];
const one = direct(farApart, [{ sourceIndex: 0, targetIndex: 1 }]);
assert.equal(one.links.length, 1, "one explicit Data Link is retained");
assert(!Object.prototype.hasOwnProperty.call(one, "networks"), "direct support has no physical network collection");
close(one.sourceAllocations[0].effectiveBudget, budget("fireControl"), "one weapon receives the whole source budget");
close(one.sourceAllocations[0].bonusPerWeapon, budget("fireControl"), "one weapon receives the whole per-weapon allocation");
close(one.weaponBonuses.find((weapon) => weapon.weaponIndex === 1).fireRateBonus, budget("fireControl"), "linked weapon receives the full fire-rate budget");

const fourWeaponDesign = [at("fireControl", 0), at("railgun", 1), at("blaster", 2), at("beamEmitter", 3), at("missile", 4)];
const fourLinks = [1, 2, 3, 4].map((targetIndex) => ({ sourceIndex: 0, targetIndex }));
const four = direct(fourWeaponDesign, fourLinks);
assert.equal(four.sourceAllocations[0].recipientCount, 4, "recipient count follows explicit links");
close(four.sourceAllocations[0].bonusPerWeapon, budget("fireControl") / 4, "one source budget is divided across four weapons");
four.weaponBonuses.forEach((weapon) => close(weapon.fireRateBonus, budget("fireControl") / 4, "every linked weapon receives an equal share"));

const mixedDesign = [at("signalAmplifier", 0), at("targetingComputer", 1), at("fireControl", 2), at("railgun", 3), at("blaster", 4)];
const mixed = direct(mixedDesign, [
  { sourceIndex: 0, targetIndex: 3 }, { sourceIndex: 0, targetIndex: 4 },
  { sourceIndex: 1, targetIndex: 3 }, { sourceIndex: 1, targetIndex: 4 },
  { sourceIndex: 2, targetIndex: 3 }, { sourceIndex: 2, targetIndex: 4 }
]);
mixed.weaponBonuses.forEach((weapon) => {
  close(weapon.rangeBonus, budget("signalAmplifier") / 2, "range support is split per source");
  close(weapon.accuracyBonus, budget("targetingComputer") / 2, "accuracy support is split per source");
  close(weapon.fireRateBonus, budget("fireControl") / 2, "fire-rate support is split per source");
  assert.equal(weapon.sourceIndices.length, 3, "each weapon records each linked source once");
});

const before = JSON.stringify(PARTS.fireControl);
direct([at("fireControl", 0), at("railgun", 1)], [{ sourceIndex: 0, targetIndex: 1 }]);
assert.equal(JSON.stringify(PARTS.fireControl), before, "allocation never mutates catalogue stats");

const malformed = direct([at("fireControl", 0), at("railgun", 1)], [
  { sourceIndex: 0, targetIndex: 1 },
  { sourceIndex: 0, targetIndex: 1 },
  { sourceIndex: "bad", targetIndex: 1 },
  { sourceIndex: 1, targetIndex: 0 },
  { sourceIndex: 0, targetIndex: 99 },
  { sourceIndex: 0, targetIndex: 0 }
]);
assert.deepEqual(malformed.links, [{ sourceIndex: 0, targetIndex: 1 }], "normalization keeps only unique valid source-to-weapon links");
const rejected = Rules.validateDataLinks([at("fireControl", 0), at("railgun", 1)], [
  { sourceIndex: 0, targetIndex: 1 },
  { sourceIndex: 0, targetIndex: 1 },
  { sourceIndex: 1, targetIndex: 0 }
], PARTS);
assert.equal(rejected.valid.length, 1);
assert.deepEqual(rejected.rejected.map((item) => item.code), ["duplicate", "target-is-source"]);

const disabled = direct([at("fireControl", 0), at("railgun", 1)], [{ sourceIndex: 0, targetIndex: 1 }], {
  sourceMultiplier: () => 0
});
assert.equal(disabled.sourceAllocations[0].status, "disabled", "an unavailable source contributes nothing");
assert.equal(disabled.weaponBonuses[0].status, "connected-unsupported", "linked weapons stay at base stats when a source is unavailable");
close(disabled.weaponBonuses[0].fireRateBonus, 0, "unavailable source contributes zero");

const reduced = direct([at("fireControl", 0), at("railgun", 1)], [{ sourceIndex: 0, targetIndex: 1 }], {
  sourceMultiplier: () => 0.25
});
close(reduced.sourceAllocations[0].effectiveBudget, budget("fireControl") * 0.25, "source state scales its effective budget");
close(reduced.weaponBonuses[0].fireRateBonus, budget("fireControl") * 0.25, "scaled source budget reaches the linked weapon");

const baseWeapon = PARTS.railgun.weapon;
const profile = Rules.effectiveWeaponProfile(baseWeapon, { rangeBonus: 20, accuracyBonus: 0.2, fireRateBonus: 0.5 });
assert(profile.range > baseWeapon.range, "range support changes the effective weapon profile");
assert(profile.fireRate > baseWeapon.fireRate, "fire-rate support changes the effective weapon profile");
close(profile.reload, 1000 / profile.fireRate, "reload follows the effective fire rate");
assert(Number.isFinite(profile.dps), "effective weapon profile remains finite");

console.log("Direct Data Links support verification passed.");
