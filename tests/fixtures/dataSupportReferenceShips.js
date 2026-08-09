"use strict";

const assert = require("assert");
const DataSupportRules = require("../../public/src/shared/dataSupportRules");
const { PARTS } = require("../../src/server/components");

const clone = (value) => JSON.parse(JSON.stringify(value));
const part = (type) => {
  if (!PARTS[type]) throw new Error("Unknown component type: " + type);
  return PARTS[type];
};
const moduleAt = (type, x, y = 0) => ({ type, x, y, rotation: 0 });
const typeIndices = (design, predicate) => design.map((module, index) => predicate(module.type) ? index : -1).filter((index) => index >= 0);

function summarize(design, dataLinks) {
  return design.reduce((summary, module) => {
    const stats = part(module.type);
    summary.cost += stats.cost || 0;
    summary.mass += stats.mass || 0;
    summary.powerUse += stats.powerUse || 0;
    summary.powerGeneration += stats.powerGeneration || 0;
    summary.heatGeneration += stats.heatGeneration || 0;
    if (DataSupportRules.isDataSupportSource(module.type)) summary.supportCost += stats.cost || 0;
    if (stats.weapon) summary.weaponCost += stats.cost || 0;
    return summary;
  }, {
    cost: 0,
    mass: 0,
    powerUse: 0,
    powerGeneration: 0,
    heatGeneration: 0,
    supportCost: 0,
    weaponCost: 0,
    dataLinkCount: dataLinks.length
  });
}

function buildExpected(design, dataLinks) {
  const analysis = DataSupportRules.analyzeDirectDataSupport(design, dataLinks, PARTS);
  return {
    sources: typeIndices(design, DataSupportRules.isDataSupportSource),
    weapons: typeIndices(design, (type) => Boolean(PARTS[type]?.weapon)),
    linkCount: analysis.links.length,
    sourceAllocations: analysis.sourceAllocations.map((source) => ({
      sourceIndex: source.sourceIndex,
      recipientCount: source.recipientCount,
      bonusPerWeapon: source.bonusPerWeapon
    }))
  };
}

function make(key, name, components, links) {
  const design = components.map(([type, x, y]) => moduleAt(type, x, y));
  const dataLinks = DataSupportRules.normalizeDataLinks(
    design,
    links.map(([sourceIndex, targetIndex]) => ({ sourceIndex, targetIndex })),
    PARTS
  );
  const expected = buildExpected(design, dataLinks);
  const fixture = {
    key,
    name,
    design: clone(design),
    dataLinks: clone(dataLinks),
    expectedLinkCount: expected.linkCount,
    expected,
    summary: summarize(design, dataLinks)
  };
  validateReferenceFixture(fixture);
  return fixture;
}

function validateReferenceFixture(fixture) {
  fixture.design.forEach((module) => assert(PARTS[module.type], fixture.name + " component type exists: " + module.type));
  const validation = DataSupportRules.validateDataLinks(fixture.design, fixture.dataLinks, PARTS);
  assert.deepEqual(validation.rejected, [], fixture.name + " has no rejected Data Links");
  assert.deepEqual(validation.valid, fixture.dataLinks, fixture.name + " Data Links are canonical");
  const analysis = DataSupportRules.analyzeDirectDataSupport(fixture.design, fixture.dataLinks, PARTS);
  assert.equal(analysis.links.length, fixture.expectedLinkCount, fixture.name + " exact Data Link count");
  assert(!Object.prototype.hasOwnProperty.call(analysis, "networks"), fixture.name + " has no physical Data network state");
  fixture.expected.sources.forEach((index) => {
    assert(DataSupportRules.isDataSupportSource(fixture.design[index].type), fixture.name + " source index validates: " + index);
  });
  fixture.expected.weapons.forEach((index) => assert(PARTS[fixture.design[index].type].weapon, fixture.name + " weapon eligible: " + index));
  return fixture;
}

function cloneReferenceFixture(fixture) {
  return clone(fixture);
}

function precisionBuild() {
  return make("precision", "Reference A — Precision build", [
    ["core", 0, 0], ["reactor", 1, 0], ["engine", 3, 0], ["radiator", 4, 0],
    ["targetingComputer", 5, 0], ["signalAmplifier", 6, 0], ["railgun", 7, 0]
  ], [[4, 6], [5, 6]]);
}

function broadsideBuild() {
  return make("broadside", "Reference B — Broadside build", [
    ["core", 0, 0], ["reactor", 1, 0], ["engine", 3, 0], ["radiator", 4, 0],
    ["fireControl", 5, 0], ["blaster", 6, 0], ["blaster", 7, 0], ["blaster", 8, 0],
    ["blaster", 9, 0], ["auxGenerator", 10, 0]
  ], [[4, 5], [4, 6], [4, 7], [4, 8]]);
}

function mixedSupportBuild() {
  return make("mixed", "Reference C — Mixed direct links", [
    ["core", 0, 0], ["reactor", 1, 0], ["engine", 3, 0], ["radiator", 4, 0],
    ["fireControl", 5, 0], ["signalAmplifier", 6, 0], ["targetingComputer", 7, 0],
    ["railgun", 8, 0], ["blaster", 9, 0], ["pointDefense", 10, 0],
    ["auxGenerator", 11, 0], ["auxGenerator", 12, 0], ["auxGenerator", 13, 0]
  ], [
    [4, 7], [4, 8], [4, 9],
    [5, 7], [5, 8], [5, 9],
    [6, 7], [6, 8], [6, 9]
  ]);
}

function redundantSupport() {
  return make("redundant", "Reference D — Redundant direct support", [
    ["core", 0, 0], ["reactor", 1, 0], ["engine", 3, 0], ["radiator", 4, 0],
    ["fireControl", 5, 0], ["signalAmplifier", 6, 0], ["frame", 7, 0],
    ["missile", 8, 0], ["blaster", 9, 0], ["pointDefense", 10, 0],
    ["frame", 7, 1], ["frame", 8, 1], ["frame", 9, 1],
    ["auxGenerator", 11, 0], ["auxGenerator", 12, 0]
  ], [[4, 7], [4, 8], [5, 8], [5, 9]]);
}

function independentLinks() {
  return make("isolated", "Reference E — Independent direct links", [
    ["core", 0, 0], ["reactor", 1, 0], ["engine", 3, 0], ["radiator", 4, 0],
    ["signalAmplifier", 5, 0], ["railgun", 6, 0], ["fireControl", 7, 0],
    ["blaster", 8, 0], ["auxGenerator", 9, 0], ["auxGenerator", 10, 0], ["auxGenerator", 11, 0]
  ], [[4, 5], [6, 7]]);
}

function allReferenceShips() {
  return [precisionBuild(), broadsideBuild(), mixedSupportBuild(), redundantSupport(), independentLinks()].map(cloneReferenceFixture);
}

module.exports = {
  precisionBuild,
  broadsideBuild,
  mixedSupportBuild,
  redundantSupport,
  independentLinks,
  allReferenceShips,
  componentIndicesByType: (fixture, type) => fixture.design.map((module, index) => module.type === type ? index : -1).filter((index) => index >= 0),
  firstComponentIndexByType: (fixture, type) => {
    const index = fixture.design.findIndex((module) => module.type === type);
    assert(index >= 0, fixture.name + " has " + type);
    return index;
  },
  validateReferenceFixture,
  cloneReferenceFixture
};
