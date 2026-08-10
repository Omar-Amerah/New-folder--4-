"use strict";

const assert = require("assert");
const fs = require("fs");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState } = require("../src/server/componentHealth");
const {
  selectComponentAimIndex
} = require("../src/server/combat");

const design = [
  { x: 7, y: 7, type: "core" },
  { x: 8, y: 7, type: "reactor" },
  { x: 9, y: 7, type: "engine" },
  { x: 10, y: 7, type: "armor" },
  { x: 11, y: 7, type: "blaster" }
];

const target = {
  id: "weighted-target",
  ownerId: "enemy",
  x: 0,
  y: 0,
  angle: 0,
  alive: true,
  design,
  stats: computeStats(design),
  shield: 0,
  maxShield: 0
};
initComponentState(target);

assert.strictEqual(selectComponentAimIndex({ combatRandom: () => 0 }, target), 1, "automatic targeting starts with the living non-Core systems");
assert.strictEqual(selectComponentAimIndex({ combatRandom: () => 0 }, target, 1), 2, "the previous component is retained as a retargeting input");
assert.strictEqual(selectComponentAimIndex({ combatRandom: () => 0.999 }, target, 1), 4, "weighted selection can still choose a later active weapon");

target.componentHp[1] = 0;
target.componentHp[3] = 0;
const remaining = [0, 2, 4];
for (let i = 0; i < remaining.length; i += 1) {
  const roll = i / remaining.length + 0.000001;
  assert.notStrictEqual(selectComponentAimIndex({ combatRandom: () => roll }, target, null), 1, "destroyed modules are excluded from automatic targeting");
}
assert.strictEqual(selectComponentAimIndex({ combatRandom: () => 0 }, target, 2), 4, "the surviving non-Core system remains selectable");

const combatSource = fs.readFileSync("src/server/combat.js", "utf8");
const inductionStart = combatSource.indexOf("function selectInductionComponentIndex");
const inductionEnd = combatSource.indexOf("function getInductionAimPoint", inductionStart);
assert(inductionStart >= 0 && inductionEnd > inductionStart, "Thermal Induction Lance selector remains explicit");
assert(combatSource.slice(inductionStart, inductionEnd).includes("powerGenerators"), "Thermal Induction Lance checks living Power generators first");
assert(combatSource.slice(inductionStart, inductionEnd).includes("part.powerGeneration > 0"), "Thermal Induction Lance recognises Power generators");

const thermal = PARTS.thermalInductionLance.weapon;
assert.strictEqual(thermal.damage, 0, "Thermal Induction Lance remains zero-damage");
assert(thermal.inductionHeatBasePerSecond > 0 && thermal.inductionHeatMaxPerSecond > thermal.inductionHeatBasePerSecond, "Thermal Induction Lance Heat ramp remains authored");
assert(PARTS.thermalInductionLance.description.includes("Prioritises functioning Power generators when available, then other active systems"), "Thermal Induction Lance copy describes generator-first targeting");

console.log("verify-neutral-component-targeting passed");
