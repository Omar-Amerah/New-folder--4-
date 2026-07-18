"use strict";

const assert = require("assert");
const { PARTS } = require("./src/server/components");
const WiringRules = require("./public/src/shared/wiringRules");
const DataSupportRules = require("./public/src/shared/dataSupportRules");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState } = require("./src/server/componentHealth");
const { initShipHeat } = require("./src/server/heat");
const { rebuildShipWiringState } = require("./src/server/componentPower");
const { rebuildShipDataSupport, getWeaponDataSupport, getEffectiveWeaponStats, getSourceDataAllocation } = require("./src/server/componentData");
const { updateShipWeapons, findPointDefenseTarget } = require("./src/server/combat");

const close = (a, b, msg, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${msg}: ${a} !== ${b}`);
const mod = (type, x, y, rotation = 0) => ({ type, x, y, rotation });
const budget = (type) => DataSupportRules.nominalSupportBudget(type, PARTS);
const spreadScale = (weapon, family) => (1 - Math.max(0.1, Math.min(0.99, Number(weapon.accuracy) || 0.8))) * (family === "missile" ? 0.35 : family === "pointDefense" ? 0.05 : 0.22);
const bulletAngle = (b) => Math.atan2(b.vy, b.vx);
const snapshot = (design, wiring) => ({ parts: JSON.stringify(PARTS), design: JSON.stringify(design), wiring: JSON.stringify(wiring) });
const assertSnapshot = (snap, design, wiring, msg) => {
  assert.equal(JSON.stringify(PARTS), snap.parts, `${msg} PARTS immutable`);
  assert.equal(JSON.stringify(design), snap.design, `${msg} design immutable`);
  assert.equal(JSON.stringify(wiring), snap.wiring, `${msg} wiring immutable`);
};

function wire(design, paths) {
  let wiring = WiringRules.emptyWiring();
  for (const path of paths) wiring = WiringRules.addPath(wiring, "data", path, design, PARTS);
  return wiring;
}

function ship(design, paths = [], overrides = {}) {
  const wiring = wire(design, paths);
  const s = { id: overrides.id || "s", ownerId: overrides.ownerId || "p1", alive: true, x: overrides.x || 0, y: overrides.y || 0, vx: 0, vy: 0, angle: overrides.angle || 0, targetX: 0, targetY: 0, radius: 30, stats: computeStats(design), design, wiring };
  initComponentState(s);
  initShipHeat(s);
  rebuildShipWiringState(s, "test", { skipRuntimeStats: true });
  // Section 6B runtime tests focus on Data-combat authority without modelling
  // Power wiring. Install explicit initialized Power runtime instead of relying
  // on componentData to infer implicit full power.
  s.componentPower = { byComponentIndex: design.map(() => ({ operationalMultiplier: 1, state: "powered" })) };
  require("./src/server/componentData").refreshShipDataAllocation(s, "test-explicit-power");
  s.weaponCooldowns = design.map(() => 0);
  s.weaponAngles = design.map(() => 0);
  return s;
}

function room(random = 0.5) {
  return { bullets: [], effects: [], map: { asteroids: [] }, rules: { gameMode: "solo" }, players: new Map([["p1", { id: "p1", team: "a" }], ["p2", { id: "p2", team: "b" }]]), ships: new Map(), combatRandom: () => random };
}

function enemyAt(x, y, id = "e") {
  const e = { id, ownerId: "p2", alive: true, x, y, vx: 0, vy: 0, angle: Math.PI, radius: 30, shield: 0, maxShield: 0, stats: computeStats([mod("frame", 7, 7)]), design: [mod("frame", 7, 7)] };
  initComponentState(e);
  initShipHeat(e);
  return e;
}

// Allocation smoke: connected weapons receive support, split and stacked by physical Data networks only.
let design = [mod("fireControl", 0, 0), mod("railgun", 1, 0), mod("blaster", 4, 0)];
let s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }]]);
close(getWeaponDataSupport(s, 1).fireRateBonus, budget("fireControl"), "railgun gets Fire Control");
close(getEffectiveWeaponStats(s, 1).fireRate, PARTS.railgun.weapon.fireRate * (1 + budget("fireControl")), "effective fire rate");
close(getWeaponDataSupport(s, 2).fireRateBonus, 0, "disconnected blaster has no support");

design = [mod("sensorArray", 0, 0), mod("railgun", 1, 0), mod("fireControl", 4, 0), mod("blaster", 5, 0)];
s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 4, y: 0 }, { x: 5, y: 0 }]]);
close(getWeaponDataSupport(s, 1).rangeBonus, budget("sensorArray"), "railgun range only");
close(getWeaponDataSupport(s, 1).fireRateBonus, 0, "railgun no fire-rate leak");
close(getWeaponDataSupport(s, 3).fireRateBonus, budget("fireControl"), "blaster fire rate only");

design = [mod("fireControl", 0, 0), mod("railgun", 1, 0), mod("blaster", 2, 0), mod("beamEmitter", 3, 0)];
s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]]);
[1, 2, 3].forEach((i) => close(getWeaponDataSupport(s, i).fireRateBonus, budget("fireControl") / 3, "three-way split"));
close(getSourceDataAllocation(s, 0).bonusPerWeapon, budget("fireControl") / 3, "source allocation lookup");

design = [mod("fireControl", 0, 0), mod("sensorArray", 1, 0), mod("targetingComputer", 2, 0), mod("railgun", 3, 0)];
s = ship(design, [[{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]]);
close(getWeaponDataSupport(s, 3).fireRateBonus, budget("fireControl"), "stack fire");
close(getWeaponDataSupport(s, 3).rangeBonus, budget("sensorArray"), "stack range");
close(getWeaponDataSupport(s, 3).accuracyBonus, budget("targetingComputer"), "stack accuracy");

// Existing non-PD projectile path still consumes effective range, accuracy and cooldown exactly once.
let r = room();
design = [mod("sensorArray", 7, 6), mod("railgun", 7, 7)];
s = ship(design, [[{ x: 7, y: 6 }, { x: 7, y: 7 }]], { x: 0, y: 0 });
let e = enemyAt(PARTS.railgun.weapon.range + 25, 0); r.ships.set(s.id, s); r.ships.set(e.id, e);
updateShipWeapons(r, s, [s, e], 10, 1000);
assert.equal(r.bullets.length, 1, "supported railgun fires beyond base range");
close(r.bullets[0].life, getEffectiveWeaponStats(s, 1).range / (PARTS.railgun.weapon.projectileSpeed || 1080), "projectile life uses effective range");

r = room(0); s = ship([mod("targetingComputer", 7, 6), mod("blaster", 7, 7)], [[{ x: 7, y: 6 }, { x: 7, y: 7 }]], { x: 0, y: 0 }); e = enemyAt(300, 0); r.ships.set(s.id, s); r.ships.set(e.id, e);
updateShipWeapons(r, s, [s, e], 10, 1000);
close(bulletAngle(r.bullets[0]), -spreadScale(getEffectiveWeaponStats(s, 1), "blaster"), "blaster deterministic spread uses effective accuracy");
close(s.weaponCooldowns[1], 1 / getEffectiveWeaponStats(s, 1).fireRate, "accuracy support does not affect cooldown");

// Test 1: Point Defence accuracy support changes actual projectile spread and leaves inputs immutable.
design = [mod("targetingComputer", 7, 6), mod("pointDefense", 7, 7)];
let paths = [[{ x: 7, y: 6 }, { x: 7, y: 7 }]];
let snap = snapshot(design, wire(design, paths));
s = ship(design, paths);
r = room(0); r.bullets.push({ id: "m", type: "missile", interceptable: true, life: 5, ownerId: "p2", x: 180, y: 0 });
updateShipWeapons(r, s, [s], 10, 1000);
assert(getEffectiveWeaponStats(s, 1).accuracy > PARTS.pointDefense.weapon.accuracy, "PD effective accuracy above base");
let expectedBaseAngle = Math.atan2(r.bullets[0].y - r.bullets[1].y, r.bullets[0].x - r.bullets[1].x);
close(bulletAngle(r.bullets[1]), expectedBaseAngle - spreadScale(getEffectiveWeaponStats(s, 1), "pointDefense"), "supported PD actual spread uses effective accuracy");
assertSnapshot(snap, design, wire(design, paths), "supported PD accuracy");

r = room(0); s = ship([mod("pointDefense", 7, 7)], []); r.bullets.push({ id: "m2", type: "missile", interceptable: true, life: 5, ownerId: "p2", x: 180, y: 0 });
updateShipWeapons(r, s, [s], 10, 1000);
expectedBaseAngle = Math.atan2(r.bullets[0].y - r.bullets[1].y, r.bullets[0].x - r.bullets[1].x);
close(bulletAngle(r.bullets[1]), expectedBaseAngle - spreadScale(PARTS.pointDefense.weapon, "pointDefense"), "unsupported PD spread remains base");

// Test 2: PD accuracy support does not leak across two physical Data networks.
design = [mod("targetingComputer", 7, 5), mod("pointDefense", 7, 6), mod("pointDefense", 7, 8)];
paths = [[{ x: 7, y: 5 }, { x: 7, y: 6 }]];
s = ship(design, paths);
close(getWeaponDataSupport(s, 1).accuracyBonus, budget("targetingComputer"), "PD A receives accuracy");
close(getWeaponDataSupport(s, 2).accuracyBonus, 0, "PD B stays base accuracy");
assert.notEqual(getEffectiveWeaponStats(s, 1).accuracy, getEffectiveWeaponStats(s, 2).accuracy, "PD effective accuracies differ");

// Test 3: PD fire-rate support controls its own cooldown exactly once.
design = [mod("fireControl", 7, 6), mod("pointDefense", 7, 7)];
s = ship(design, [[{ x: 7, y: 6 }, { x: 7, y: 7 }]]); r = room(); r.bullets.push({ id: "m", type: "missile", interceptable: true, life: 5, ownerId: "p2", x: 180, y: 0 });
updateShipWeapons(r, s, [s], 10, 1000);
close(s.weaponCooldowns[1], Math.max(0.05, 1 / (PARTS.pointDefense.weapon.fireRate * (1 + budget("fireControl")))), "PD cooldown uses allocated fire rate");

// Test 4: PD stagger is only a coordination delay; each PD keeps its own full reload when firing.
design = [mod("fireControl", 7, 5), mod("pointDefense", 7, 6), mod("pointDefense", 7, 8)];
s = ship(design, [[{ x: 7, y: 5 }, { x: 7, y: 6 }]]); r = room(); r.bullets.push({ id: "m", type: "missile", interceptable: true, life: 5, ownerId: "p2", x: 180, y: 0 });
s.weaponCooldowns[2] = 999;
updateShipWeapons(r, s, [s], 10, 1000);
const pdASupportedReload = Math.max(0.05, 1 / getEffectiveWeaponStats(s, 1).fireRate);
close(s.weaponCooldowns[1], pdASupportedReload, "PD A supported reload");
close(getWeaponDataSupport(s, 2).fireRateBonus, 0, "PD B receives no PD A fire-rate bonus");
close(s.weaponCooldowns[2], 989, "longer PD B cooldown is not overwritten by stagger");
s.weaponCooldowns[1] = 999; s.weaponCooldowns[2] = 0; r.bullets = [{ id: "m2", type: "missile", interceptable: true, life: 5, ownerId: "p2", x: 180, y: 0 }];
updateShipWeapons(r, s, [s], 10, 2000);
close(s.weaponCooldowns[2], Math.max(0.05, 1 / PARTS.pointDefense.weapon.fireRate), "PD B own full reload remains base when it fires");

function beamTick(design, paths) {
  const attacker = ship(design, paths);
  const target = enemyAt(220, 0);
  const rm = room(); rm.ships.set(attacker.id, attacker); rm.ships.set(target.id, target);
  const beforeHp = target.hp;
  const beforeHeat = attacker.componentHeatInput.slice();
  updateShipWeapons(rm, attacker, [attacker, target], 0.5, 1000);
  const beamIndex = design.findIndex((m) => PARTS[m.type]?.weapon?.type === "beam");
  return { damage: beforeHp - target.hp, heat: attacker.componentHeatInput[beamIndex] - beforeHeat[beamIndex], attacker, target };
}

// Tests 5-7: Beam Fire Control support, unsupported baseline and network isolation.
let baseline = beamTick([mod("beamEmitter", 7, 7)], []);
let supported = beamTick([mod("fireControl", 7, 6), mod("beamEmitter", 7, 7)], [[{ x: 7, y: 6 }, { x: 7, y: 7 }]]);
close(supported.damage, baseline.damage * (1 + budget("fireControl")), "beam damage scales by allocated Fire Control", 1e-8);
close(supported.heat, baseline.heat * (1 + budget("fireControl")), "beam heat scales by allocated Fire Control", 1e-8);
close(baseline.damage, PARTS.beamEmitter.weapon.damage * 0.5 * PARTS.beamEmitter.weapon.hullDamageMultiplier, "unsupported beam baseline damage");
close(baseline.heat, Math.max(3, Math.sqrt(PARTS.beamEmitter.weapon.damage)) * 0.5, "unsupported beam baseline heat");
let isolated = beamTick([mod("fireControl", 7, 5), mod("blaster", 7, 6), mod("beamEmitter", 7, 8)], [[{ x: 7, y: 5 }, { x: 7, y: 6 }]]);
close(isolated.damage, baseline.damage, "Fire Control on blaster network does not boost beam");
let connected = beamTick([mod("fireControl", 7, 6), mod("beamEmitter", 7, 7)], [[{ x: 7, y: 6 }, { x: 7, y: 7 }]]);
close(connected.damage, baseline.damage * (1 + budget("fireControl")), "connected Fire Control boosts beam");

// Test 8: one Fire Control splits between Beam, PD and Missile; budget is not duplicated.
design = [mod("fireControl", 7, 5), mod("beamEmitter", 7, 6), mod("pointDefense", 7, 7), mod("missile", 7, 8)];
paths = [[{ x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 }, { x: 7, y: 8 }]];
s = ship(design, paths);
[1, 2, 3].forEach((i) => close(getWeaponDataSupport(s, i).fireRateBonus, budget("fireControl") / 3, "split Fire Control budget"));
close(getSourceDataAllocation(s, 0).effectiveBudget, budget("fireControl"), "split source total budget remains nominal");
close(getEffectiveWeaponStats(s, 1).fireRate / PARTS.beamEmitter.weapon.fireRate, 1 + budget("fireControl") / 3, "beam allocated share");
close(getEffectiveWeaponStats(s, 2).fireRate / PARTS.pointDefense.weapon.fireRate, 1 + budget("fireControl") / 3, "PD allocated share");
close(getEffectiveWeaponStats(s, 3).fireRate / PARTS.missile.weapon.fireRate, 1 + budget("fireControl") / 3, "missile allocated share");

// Test 9: Supported missile actual combat path uses effective range, lifetime, cooldown and spread with isolation.
design = [mod("sensorArray", 7, 5), mod("fireControl", 7, 6), mod("targetingComputer", 7, 7), mod("missile", 7, 8), mod("fireControl", 0, 0), mod("blaster", 0, 1)];
paths = [[{ x: 7, y: 5 }, { x: 7, y: 6 }, { x: 7, y: 7 }, { x: 7, y: 8 }], [{ x: 0, y: 0 }, { x: 0, y: 1 }]];
s = ship(design, paths); e = enemyAt(PARTS.missile.weapon.range + 10, 0); r = room(0); r.ships.set(s.id, s); r.ships.set(e.id, e);
updateShipWeapons(r, s, [s, e], 10, 1000);
assert.equal(r.bullets[0].type, "missile", "supported missile fires through actual path beyond base range");
close(r.bullets[0].life, getEffectiveWeaponStats(s, 3).range / PARTS.missile.weapon.projectileSpeed, "missile lifetime uses effective range");
close(s.weaponCooldowns[3], Math.max(0.05, 1 / getEffectiveWeaponStats(s, 3).fireRate), "missile cooldown uses effective fire rate");
close(bulletAngle(r.bullets[0]), -spreadScale(getEffectiveWeaponStats(s, 3), "missile"), "missile spread uses effective accuracy");
close(getWeaponDataSupport(s, 3).fireRateBonus, budget("fireControl"), "unrelated Fire Control network does not leak to missile");

// Test 10: exactly-once application for beam, PD and missile from catalogue + individual allocation.
const fc = budget("fireControl");
close(connected.damage, baseline.damage * (1 + fc), "beam exactly once from effective profile ratio", 1e-8);
close(pdASupportedReload, Math.max(0.05, 1 / (PARTS.pointDefense.weapon.fireRate * (1 + fc))), "PD exactly once cooldown");
close(getEffectiveWeaponStats(s, 3).fireRate, PARTS.missile.weapon.fireRate * (1 + fc), "missile exactly once fire rate");

// PD effective range still used for acquisition.
design = [mod("sensorArray", 7, 6), mod("pointDefense", 7, 7), mod("fireControl", 0, 0)];
s = ship(design, [[{ x: 7, y: 6 }, { x: 7, y: 7 }]], { x: 0, y: 0 });
r = room(); r.bullets.push({ id: "far", type: "missile", interceptable: true, life: 5, ownerId: "p2", x: PARTS.pointDefense.weapon.range + 20, y: 0 });
assert(findPointDefenseTarget(r, 0, 0, "p1", getEffectiveWeaponStats(s, 1), [s], s.id), "PD effective acquisition range");
close(getWeaponDataSupport(s, 1).fireRateBonus, 0, "unrelated Fire Control no PD leak");

// Runtime support rebuild remains deterministic and immutable.
design = [mod("fireControl", 7, 6), mod("railgun", 7, 7)];
paths = [[{ x: 7, y: 6 }, { x: 7, y: 7 }]];
snap = snapshot(design, wire(design, paths));
s = ship(design, paths);
const first = JSON.stringify(s.runtimeDataSupport); rebuildShipDataSupport(s); const second = JSON.stringify(s.runtimeDataSupport);
assert.equal(first, second, "runtime state deterministic across rebuilds");
assertSnapshot(snap, design, wire(design, paths), "runtime rebuild");

console.log("Data support runtime verification passed.");
