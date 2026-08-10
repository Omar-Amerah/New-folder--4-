"use strict";

const assert = require("assert");
const ShieldRules = require("../public/src/shared/shieldRules");
const HeatRules = require("../public/src/shared/heatRules");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { initComponentState, flushComponentLifecycleRefresh } = require("../src/server/componentHealth");
const { initShipHeat } = require("../src/server/heat");
const { initializeComponentPower, effectiveShieldStats, effectiveShieldCapacityContributions } = require("../src/server/componentPower");
const { damageShip, SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE } = require("../src/server/combat");

const at = (type, x, y) => ({ type, x, y, rotation: 0 });
const close = (actual, expected, message) => assert(Math.abs(actual - expected) < 1e-9, message + ": " + actual + " !== " + expected);

const linearRegen = ShieldRules.calculateShieldStats(
  [at("shield", 0, 0), at("shield", 1, 0)],
  PARTS
);
close(linearRegen.recharge, PARTS.shield.shieldRegen * 2, "shield regeneration stacks linearly");
assert.deepEqual(
  linearRegen.regenerationContributions.map((entry) => entry.effectiveRate),
  [PARTS.shield.shieldRegen, PARTS.shield.shieldRegen],
  "each shield contributes its full authored regeneration rate"
);

function makeShip(design) {
  const dataLinks = [];
  const ship = {
    id: "shield-impact",
    ownerId: "owner",
    x: 100,
    y: 100,
    angle: 0,
    design,
    dataLinks,
    stats: computeStats(design, { dataLinks }),
    shield: 0,
    alive: true
  };
  initComponentState(ship);
  ship.componentPowerState = design.map(() => 1);
  initializeComponentPower(ship);
  initShipHeat(ship);
  ship.shield = effectiveShieldStats(ship).capacity;
  return ship;
}

function roomFor(ship) {
  return {
    id: "shield-room",
    map: { safeZones: [], asteroids: [] },
    players: new Map([
      ["owner", { id: "owner", team: "blue" }],
      ["attacker", { id: "attacker", team: "red" }]
    ]),
    ships: new Map([[ship.id, ship]]),
    effects: []
  };
}

const design = [at("reactor", 0, 0), at("shield", 1, 0), at("aegisProjector", 2, 0)];
const ship = makeShip(design);
const contributions = effectiveShieldCapacityContributions(ship);
assert.deepEqual(contributions.map((entry) => entry.index), [1, 2], "live shield-capacity components are included");
const before = ship.componentHeatInput.slice();
const blocked = Math.min(ship.shield, 40);
damageShip(roomFor(ship), ship, 40, "attacker", 100, 0, 1000);
const deltas = ship.componentHeatInput.map((value, index) => value - before[index]);
const expectedHeat = blocked * SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE;
close(deltas.reduce((sum, value) => sum + value, 0), expectedHeat, "blocked damage heat is conserved");
const totalCapacity = contributions.reduce((sum, entry) => sum + entry.capacity, 0);
for (const entry of contributions) close(deltas[entry.index], expectedHeat * entry.capacity / totalCapacity, "blocked heat follows shield capacity");

ship.componentHp[2] = 0;
flushComponentLifecycleRefresh(ship);
ship.shield = effectiveShieldStats(ship).capacity;
const afterDestroy = effectiveShieldCapacityContributions(ship);
assert.deepEqual(afterDestroy.map((entry) => entry.index), [1], "destroyed shield contributor is removed");
const beforeDestroyedHit = ship.componentHeatInput.slice();
damageShip(roomFor(ship), ship, 20, "attacker", 100, 0, 1200);
assert.equal(ship.componentHeatInput[2], beforeDestroyedHit[2], "destroyed shield contributor receives no impact heat");

ship.componentHeatState[1] = HeatRules.STATE.HOT;
ship.heatStateRevision += 1;
assert.equal(effectiveShieldStats(ship).capacity, effectiveShieldStats(ship).capacity, "shield capacity remains stable across Heat state updates");
const shared = ShieldRules.calculateShieldStats(ship.design, PARTS, {
  isLive: (index) => (ship.componentHp[index] ?? 1) > 0,
  powerMultiplier: () => 1,
  capacityPowerMultiplier: () => 1,
  heatMultiplier: (index) => HeatRules.activeOutputForState(ship.componentHeatState[index] || HeatRules.STATE.NORMAL)
});
close(shared.capacity, effectiveShieldStats(ship).capacity, "shared and runtime shield capacity remain in parity");

console.log("Direct Power shield impact Heat verification passed.");
