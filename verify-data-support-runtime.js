"use strict";

const assert = require("assert");
const { PARTS } = require("./src/server/components");
const WiringRules = require("./public/src/shared/wiringRules");
const DataSupportRules = require("./public/src/shared/dataSupportRules");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { rebuildShipWiringState } = require("./src/server/componentPower");
const { rebuildShipDataSupport, getWeaponDataSupport, getEffectiveWeaponStats, getSourceDataAllocation } = require("./src/server/componentData");
const { updateShipWeapons, findPointDefenseTarget } = require("./src/server/combat");

const close = (a, b, msg) => assert(Math.abs(a - b) < 1e-9, `${msg}: ${a} !== ${b}`);
const mod = (type, x, y, rotation = 0) => ({ type, x, y, rotation });
const budget = (type) => DataSupportRules.nominalSupportBudget(type, PARTS);

function wire(design, paths) {
  let wiring = WiringRules.emptyWiring();
  for (const path of paths) wiring = WiringRules.addPath(wiring, "data", path, design, PARTS);
  return wiring;
}

function ship(design, paths = [], overrides = {}) {
  const s = { id: overrides.id || "s", ownerId: overrides.ownerId || "p1", alive: true, x: overrides.x || 0, y: overrides.y || 0, vx: 0, vy: 0, angle: 0, targetX: 0, targetY: 0, stats: computeStats(design), design, wiring: wire(design, paths) };
  initComponentState(s);
  rebuildShipWiringState(s, "test", { skipRuntimeStats: true });
  rebuildShipDataSupport(s);
  s.componentPower = { byComponentIndex: design.map(() => ({ operationalMultiplier: 1, state: "powered" })) };
  return s;
}

function room() {
  return { bullets: [], effects: [], map: { asteroids: [] }, rules: { gameMode: "solo" }, players: new Map([["p1", { id: "p1", team: "a" }], ["p2", { id: "p2", team: "b" }]]), ships: new Map(), combatRandom: () => 0.5 };
}

// 1-2 connected railgun receives fire rate support; disconnected blaster stays base.
let design = [mod("fireControl", 0, 0), mod("railgun", 1, 0), mod("blaster", 4, 0)];
let s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }]]);
close(getWeaponDataSupport(s, 1).fireRateBonus, budget("fireControl"), "railgun gets Fire Control");
close(getEffectiveWeaponStats(s, 1).fireRate, PARTS.railgun.weapon.fireRate * (1 + budget("fireControl")), "effective fire rate");
close(getEffectiveWeaponStats(s, 1).reload, 1000 / getEffectiveWeaponStats(s, 1).fireRate, "reload recalculated");
close(getWeaponDataSupport(s, 2).fireRateBonus, 0, "disconnected blaster has no support");
close(getEffectiveWeaponStats(s, 2).fireRate, PARTS.blaster.weapon.fireRate, "blaster base fire rate");
assert.deepEqual(PARTS.railgun.weapon, { ...PARTS.railgun.weapon }, "catalogue object remains readable");

// 3 separate networks do not leak.
design = [mod("sensorArray", 0, 0), mod("railgun", 1, 0), mod("fireControl", 4, 0), mod("blaster", 5, 0)];
s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 4, y: 0 }, { x: 5, y: 0 }]]);
close(getWeaponDataSupport(s, 1).rangeBonus, budget("sensorArray"), "railgun range only");
close(getWeaponDataSupport(s, 1).fireRateBonus, 0, "railgun no fire-rate leak");
close(getWeaponDataSupport(s, 3).fireRateBonus, budget("fireControl"), "blaster fire rate only");
close(getWeaponDataSupport(s, 3).rangeBonus, 0, "blaster no range leak");

// 4 source split across three weapons.
design = [mod("fireControl", 0, 0), mod("railgun", 1, 0), mod("blaster", 2, 0), mod("beamEmitter", 3, 0)];
s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]]);
[1, 2, 3].forEach((i) => close(getWeaponDataSupport(s, i).fireRateBonus, budget("fireControl") / 3, "three-way split"));
close(getSourceDataAllocation(s, 0).bonusPerWeapon, budget("fireControl") / 3, "source allocation lookup");

// 5 multiple sources stack independently.
design = [mod("fireControl", 0, 0), mod("sensorArray", 1, 0), mod("targetingComputer", 2, 0), mod("railgun", 3, 0)];
s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]]);
close(getWeaponDataSupport(s, 3).fireRateBonus, budget("fireControl"), "stack fire");
close(getWeaponDataSupport(s, 3).rangeBonus, budget("sensorArray"), "stack range");
close(getWeaponDataSupport(s, 3).accuracyBonus, budget("targetingComputer"), "stack accuracy");

// 6-12 combat consumes effective range, accuracy, cooldown and PD range.
function enemyAt(x, y) { return { id: "e", ownerId: "p2", alive: true, x, y, vx: 0, vy: 0, angle: Math.PI, radius: 30, stats: computeStats([mod("core", 7, 7)]), design: [mod("core", 7, 7)], componentHp: [100], componentMaxHp: [100] }; }
let r = room();
design = [mod("sensorArray", 7, 6), mod("railgun", 7, 7)];
s = ship(design, [[{ x: 7, y: 6 }, { x: 7, y: 7 }]], { x: 0, y: 0 });
let e = enemyAt(PARTS.railgun.weapon.range + 25, 0); r.ships.set(s.id, s); r.ships.set(e.id, e);
updateShipWeapons(r, s, [s, e], 1, 1000);
assert.equal(r.bullets.length, 1, "supported railgun fires beyond base range");
close(r.bullets[0].life, getEffectiveWeaponStats(s, 1).range / (PARTS.railgun.weapon.projectileSpeed || 1080), "projectile life uses effective range");

r = room(); const unsupported = ship([mod("railgun", 7, 7)], [], { id: "u", x: 0, y: 0 }); e = enemyAt(PARTS.railgun.weapon.range + 25, 0); r.ships.set(unsupported.id, unsupported); r.ships.set(e.id, e);
updateShipWeapons(r, unsupported, [unsupported, e], 1, 1000);
assert.equal(r.bullets.length, 0, "unsupported railgun cannot fire beyond base range");

r = room(); r.combatRandom = () => 0; s = ship([mod("targetingComputer", 7, 6), mod("blaster", 7, 7)], [[{ x: 7, y: 6 }, { x: 7, y: 7 }]], { x: 0, y: 0 }); e = enemyAt(300, 0); r.ships.set(s.id, s); r.ships.set(e.id, e);
updateShipWeapons(r, s, [s, e], 1, 1000);
const supportedAngle = Math.atan2(r.bullets[0].vy, r.bullets[0].vx);
const expectedSpread = -(1 - getEffectiveWeaponStats(s, 1).accuracy) * 0.22;
close(supportedAngle, expectedSpread, "deterministic spread uses effective accuracy");
close(s.weaponCooldowns[1], 1 / getEffectiveWeaponStats(s, 1).fireRate, "unsupported-by-fire cooldown stays base when only accuracy support exists");

r = room(); s = ship([mod("fireControl", 7, 6), mod("blaster", 7, 7), mod("railgun", 8, 7), mod("missile", 9, 7), mod("beamEmitter", 10, 7), mod("pointDefense", 11, 7)], [[{ x: 7, y: 6 }, { x: 7, y: 7 }, { x: 8, y: 7 }, { x: 9, y: 7 }, { x: 10, y: 7 }, { x: 11, y: 7 }]], { x: 0, y: 0 });
[1, 2, 3, 4, 5].forEach((i) => close(getWeaponDataSupport(s, i).fireRateBonus, budget("fireControl") / 5, "all weapon families including PD eligible"));

design = [mod("sensorArray", 7, 6), mod("pointDefense", 7, 7), mod("fireControl", 0, 0)];
s = ship(design, [[{ x: 7, y: 6 }, { x: 7, y: 7 }]], { x: 0, y: 0 });
r = room(); r.bullets.push({ id: "m", type: "missile", interceptable: true, life: 5, ownerId: "p2", x: PARTS.pointDefense.weapon.range + 20, y: 0 });
assert(findPointDefenseTarget(r, 0, 0, "p1", getEffectiveWeaponStats(s, 1), [s], s.id), "PD effective acquisition range");
close(getWeaponDataSupport(s, 1).fireRateBonus, 0, "unrelated Fire Control no PD leak");

// 13-17 no global leakage, exactly-once, unsupported function, immutability and determinism.
design = [mod("fireControl", 0, 0), mod("railgun", 7, 7), mod("blaster", 8, 7)];
s = ship(design, []);
[1, 2].forEach((i) => close(getEffectiveWeaponStats(s, i).fireRate, PARTS[design[i].type].weapon.fireRate, "disconnected source no global leakage"));

design = [mod("fireControl", 7, 6), mod("railgun", 7, 7)];
const beforeParts = JSON.stringify(PARTS); const beforeDesign = JSON.stringify(design); const wiring = [[{ x: 7, y: 6 }, { x: 7, y: 7 }]];
s = ship(design, wiring);
close(getEffectiveWeaponStats(s, 1).fireRate, PARTS.railgun.weapon.fireRate * (1 + budget("fireControl")), "support applied exactly once");
const first = JSON.stringify(s.runtimeDataSupport); rebuildShipDataSupport(s); const second = JSON.stringify(s.runtimeDataSupport);
assert.equal(first, second, "runtime state deterministic across rebuilds");
assert.equal(JSON.stringify(PARTS), beforeParts, "PARTS immutable through runtime support");
assert.equal(JSON.stringify(design), beforeDesign, "design immutable through runtime support");
assert.equal(JSON.stringify(s.wiring), JSON.stringify(wire(design, wiring)), "wiring immutable through runtime support");

r = room(); unsupported.x = 0; unsupported.y = 0; e = enemyAt(PARTS.railgun.weapon.range - 50, 0); r.ships.set(unsupported.id, unsupported); r.ships.set(e.id, e);
updateShipWeapons(r, unsupported, [unsupported, e], 1, 2000);
assert(r.bullets.length > 0, "unsupported weapon still fires normally inside base range");

console.log("Data support runtime verification passed.");
