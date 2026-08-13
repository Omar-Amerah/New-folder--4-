"use strict";

// Component Hull is literal: each component owns its catalogue Hull value,
// while the main Core remains a separate durability pool outside ship.hp.
const assert = require("assert");
const fs = require("fs");
const HullRules = require("../public/src/shared/componentHullRules.js");
const { PARTS } = require("../src/server/components");
const { getOccupiedCells } = require("../src/server/footprint");
const { computeStats } = require("../src/server/shipStats");
const { createImmutableShipTemplate } = require("../src/server/shipTemplates");
const health = require("../src/server/componentHealth");
const heat = require("../src/server/heat");
const combat = require("../src/server/combat");

function close(actual, expected, message, tolerance = 1e-9) {
  assert(Math.abs(Number(actual) - Number(expected)) <= tolerance,
    `${message}: expected ${expected}, got ${actual}`);
}

function nonCoreSum(ship) {
  return ship.componentHp.reduce(
    (total, hp, index) => ship.design[index].type === "core" ? total : total + hp,
    0
  );
}

function assertHullInvariant(ship, message) {
  close(nonCoreSum(ship), ship.hp, `${message}: non-Core component HP equals ship.hp`);
}

function room() {
  return {
    effects: [],
    players: new Map(),
    map: { safeZones: [] },
    ships: new Map(),
    spatialIndex: { remove() {} }
  };
}

function makeShip(design) {
  const stats = computeStats(design);
  const ship = {
    id: `hull-${Math.random()}`,
    ownerId: "p",
    x: 0,
    y: 0,
    angle: 0,
    radius: stats.radius,
    alive: true,
    design,
    stats,
    maxHp: stats.maxHp,
    hp: stats.maxHp,
    maxShield: 0,
    shield: 0,
    dirtyComponents: new Set(),
    dataLinks: []
  };
  health.initComponentState(ship);
  heat.initShipHeat(ship);
  return ship;
}

function componentCenter(module) {
  const part = PARTS[module.type] || PARTS.frame;
  const cells = getOccupiedCells(module.x, module.y, part.footprint || { width: 1, height: 1 }, module.rotation || 0);
  return cells.reduce((center, cell) => ({ x: center.x + cell.x / cells.length, y: center.y + cell.y / cells.length }), { x: 0, y: 0 });
}

// The shared helper is the authority consumed by both server and browser
// modules, and it must not reintroduce a ship-wide scale factor.
const directDesign = [
  { type: "core", x: 7, y: 7 },
  { type: "repair", x: 6, y: 7 }
];
assert.strictEqual(HullRules.nonCoreHullTotal(directDesign, PARTS), PARTS.repair.hp, "50 Hull component is the non-Core ship Hull total");
assert.deepStrictEqual(HullRules.componentMaxHpForDesign(directDesign, PARTS), [PARTS.core.hp, PARTS.repair.hp], "component max HP uses listed Hull values directly");
assert.strictEqual(PARTS.repair.hp, 50, "the catalogue fixture has a 50 Hull component");

const direct = makeShip(directDesign);
assert.strictEqual(direct.componentMaxHp[0], 320, "Core 320 Hull is its actual Core HP");
assert.strictEqual(direct.componentMaxHp[1], 50, "50 Hull component spawns with exactly 50 component HP");
assert.strictEqual(direct.maxHp, 50, "ship maxHp excludes the separate Core pool");
assert.strictEqual(direct.hp, 50, "initial ordinary ship.hp excludes Core HP");
assertHullInvariant(direct, "fresh direct-Hull ship");
const template = createImmutableShipTemplate(directDesign, [], computeStats(directDesign));
assert.deepStrictEqual(template.prebuiltShipState.componentMaxHp, [320, 50], "spawn template preserves direct Core and component Hull values");
assert.strictEqual(template.prebuiltShipState.maxHp, 50, "spawn template ordinary maxHp excludes Core");

const armor = makeShip([
  { type: "core", x: 7, y: 7 },
  { type: "armor", x: 6, y: 7 }
]);
assert.strictEqual(armor.componentMaxHp[0], 320, "Core remains 320 HP beside Armor");
assert.strictEqual(armor.componentMaxHp[1], 240, "Armor 240 Hull is its actual component HP");
assert.strictEqual(armor.stats.maxHp, 240, "aggregate stats equal the non-Core Hull sum");
assert.strictEqual(armor.maxHp, 240, "runtime maxHp equals the non-Core Hull sum");
assertHullInvariant(armor, "Armor ship");

// Ordinary damage removes exactly the HP removed from a non-Core component;
// repair restores the same amount and preserves the aggregate invariant.
const damageShip = makeShip([
  { type: "core", x: 10, y: 7 },
  { type: "frame", x: 7, y: 5 },
  { type: "frame", x: 7, y: 6 }
]);
const damageRoom = room();
const hpBeforeDamage = damageShip.hp;
const applied = health.applyHullDamage(damageRoom, damageShip, 10, 1000, 60, 0);
close(applied, 10, "normal damage reports actual HP removed");
close(hpBeforeDamage - damageShip.hp, applied, "normal damage subtracts actual component HP from ship.hp");
assertHullInvariant(damageShip, "after normal damage");
const healed = health.repairShipComponents(null, damageShip, applied, 1100);
close(healed, applied, "repair restores the damaged component amount");
assertHullInvariant(damageShip, "after ordinary repair");

// Core damage changes only the separate Core pool. A powered backup keeps this
// partial-damage case alive so command-state evaluation cannot destroy the ship.
const coreShip = makeShip([
  { type: "core", x: 7, y: 7 },
  { type: "backupCore", x: 6, y: 7 },
  { type: "frame", x: 5, y: 7 }
]);
const coreRoom = room();
const ordinaryBeforeCoreDamage = coreShip.hp;
const coreBefore = coreShip.componentHp[0];
const coreApplied = combat.applyDirectComponentDamage(coreRoom, coreShip, 0, 50, "attacker", 1200);
close(coreApplied, 50, "Core damage removes actual Core HP");
close(coreShip.componentHp[0], coreBefore - 50, "Core pool takes direct damage");
close(coreShip.hp, ordinaryBeforeCoreDamage, "Core damage does not reduce ordinary ship.hp");
assertHullInvariant(coreShip, "after Core damage");
health.repairShipComponents(null, coreShip, 50, 1300);
close(coreShip.hp, ordinaryBeforeCoreDamage, "Core repair does not inflate ordinary ship.hp");
close(coreShip.componentHp[0], coreBefore, "Core repair restores the separate pool");

// Destroying and repairing an active component still changes the effective
// systems while using the component's exact listed HP.
const systemShip = makeShip([
  { type: "core", x: 7, y: 7 },
  { type: "reactor", x: 7, y: 6 },
  { type: "engine", x: 7, y: 8 },
  { type: "frame", x: 6, y: 7 }
]);
const systemRoom = room();
const engineIndex = 2;
const engineMax = systemShip.componentMaxHp[engineIndex];
const thrustBefore = systemShip.stats.thrust;
combat.applyDirectComponentDamage(systemRoom, systemShip, engineIndex, engineMax + 1, "attacker", 1400);
assert.strictEqual(systemShip.componentHp[engineIndex], 0, "destroyed engine reaches zero actual HP");
assert(systemShip.stats.thrust < thrustBefore, "destroying an engine recalculates movement systems");
assertHullInvariant(systemShip, "after engine destruction");
health.repairShipComponents(null, systemShip, engineMax, 1500);
assert.strictEqual(systemShip.componentHp[engineIndex], engineMax, "repair resurrects the exact engine HP pool");
assert(systemShip.stats.thrust >= thrustBefore, "repair re-enables the destroyed engine system");
assertHullInvariant(systemShip, "after engine repair");

// Reactor detonation continues to damage real component pools, not a
// rescaled/redistributed ship-wide pool, and Core remains outside ship.hp.
const reactorShip = makeShip([
  { type: "core", x: 10, y: 7 },
  { type: "reactor", x: 7, y: 7 },
  { type: "frame", x: 7, y: 6 }
]);
const reactorRoom = room();
const reactorBefore = reactorShip.componentHp[1];
const frameBefore = reactorShip.componentHp[2];
const coreBeforeExplosion = reactorShip.componentHp[0];
health.detonateComponent(reactorRoom, reactorShip, 1, 1.5, 12, 1600);
assert.strictEqual(reactorShip.componentHp[1], 0, "reactor detonation destroys the reactor pool");
const reactorCenter = componentCenter(reactorShip.design[1]);
const frameCenter = componentCenter(reactorShip.design[2]);
const splashDistance = Math.hypot(reactorCenter.x - frameCenter.x, reactorCenter.y - frameCenter.y);
const expectedSplash = 12 * (1 - splashDistance / 1.5);
close(reactorShip.componentHp[2], frameBefore - expectedSplash, "reactor splash uses actual distance falloff damage");
close(reactorShip.componentHp[0], coreBeforeExplosion, "reactor splash does not damage the out-of-radius Core");
close(reactorShip.hp, reactorShip.maxHp - reactorBefore - expectedSplash, "reactor detonation subtracts only non-Core HP from ship.hp");
assertHullInvariant(reactorShip, "after reactor detonation");

// Penetration still consumes the raw budget based on actual component HP.
const penetrationShip = makeShip([
  { type: "core", x: 10, y: 7 },
  { type: "frame", x: 7, y: 5 },
  { type: "frame", x: 7, y: 6 }
]);
penetrationShip.componentHp[1] = 10;
penetrationShip.componentHp[2] = 100;
penetrationShip.hp = nonCoreSum(penetrationShip);
health.applyHullDamage(room(), penetrationShip, 30, 1700, 60, 0);
assert.strictEqual(penetrationShip.componentHp[1], 0, "penetration destroys the first actual HP pool");
close(penetrationShip.componentHp[2], 80, "remaining penetration reaches the next component using raw damage");
assertHullInvariant(penetrationShip, "after penetration");

// Keep the browser mirrors tied to the same helper and reject the removed
// ship-wide rescaling equation in future edits.
for (const file of [
  "public/src/design/componentStats.js",
  "public/src/game/shipVitals.js",
  "public/src/game/componentDamage.js"
]) {
  const source = fs.readFileSync(file, "utf8");
  assert.match(source, /componentHullRules/, `${file} uses the shared Hull authority`);
  assert.doesNotMatch(source, /1\.15|Max\(140|rawSum|\(maxHp.*sum/, `${file} has no old Hull rescaling equation`);
}

console.log("component Hull parity verification passed");
