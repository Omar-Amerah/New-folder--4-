"use strict";

const assert = require("assert");
const WiringRules = require("./public/src/shared/wiringRules");
const ShieldRules = require("./public/src/shared/shieldRules");
const HeatRules = require("./public/src/shared/heatRules");
const { PARTS } = require("./src/server/components");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, flushComponentLifecycleRefresh } = require("./src/server/componentHealth");
const { initShipHeat, updateShipHeat, distributeComponentHeatByWeight } = require("./src/server/heat");
const { rebuildShipWiringState, effectiveShieldStats, effectiveShieldCapacityContributions } = require("./src/server/componentPower");
const { damageShip, SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE } = require("./src/server/combat");

const EPS = 1e-9;
const at = (type, x, y) => ({ type, x, y, rotation: 0 });
let nextShipId = 1;
function close(actual, expected, message, eps = EPS) { assert(Math.abs(actual - expected) <= eps, `${message}: ${actual} !== ${expected}`); }
function wiringFor(design, paths) { let wiring = WiringRules.emptyWiring(); for (const path of paths) wiring = WiringRules.addConnection(wiring, "power", path[0], path[1], path[2], design, PARTS); return wiring; }
function room() { return { id: "room", map: { safeZones: [], asteroids: [] }, players: new Map([["owner", { id: "owner", team: "blue" }], ["attacker", { id: "attacker", team: "red" }]]), ships: new Map(), effects: [], rules: { gameMode: "team" } }; }
function shipFor(design, paths = []) {
  const ship = { id: `ship-${nextShipId++}`, ownerId: "owner", x: 1000, y: 1000, angle: 0, design, wiring: wiringFor(design, paths), stats: computeStats(design), shield: 0, alive: true };
  initComponentState(ship);
  initShipHeat(ship);
  rebuildShipWiringState(ship, "test-fixture");
  ship.shield = effectiveShieldStats(ship).capacity;
  return ship;
}
function heatDeltas(ship, fn) { const before = ship.componentHeatInput.slice(); fn(); return ship.componentHeatInput.map((value, index) => value - before[index]); }
function sum(values) { return values.reduce((total, value) => total + value, 0); }
function expectedBlocked(ship, damage, options = {}) { return Math.min(ship.shield, damage * Number(options.shieldDamageMultiplier ?? 1)); }
function hit(ship, damage, options = {}) { const blocked = expectedBlocked(ship, damage, options); const contributionsBefore = effectiveShieldCapacityContributions(ship).map(c => ({ ...c })); const r = room(); r.ships.set(ship.id, ship); const deltas = heatDeltas(ship, () => damageShip(r, ship, damage, "attacker", 100, 0, 1000, options)); return { blocked, heat: blocked * SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE, deltas, room: r, contributionsBefore }; }
function assertWeighted(ship, deltas, expectedHeat, message, contributionsOverride = null) {
  const contributions = contributionsOverride || effectiveShieldCapacityContributions(ship);
  const total = contributions.reduce((v, c) => v + c.capacity, 0);
  close(sum(deltas), expectedHeat, `${message} total heat`);
  for (const c of contributions) close(deltas[c.index], expectedHeat * c.capacity / total, `${message} component ${c.index}`);
  for (let i = 0; i < deltas.length; i += 1) if (!contributions.some(c => c.index === i)) close(deltas[i], 0, `${message} unrelated ${i}`);
}
function assertContributionParity(ship, label) {
  const shared = ShieldRules.calculateShieldCapacityContributions(ship.design, PARTS, { isLive: i => (ship.componentHp?.[i] ?? 1) > 0, powerMultiplier: i => ship.componentPower.byComponentIndex[i].operationalMultiplier });
  const stats = ShieldRules.calculateShieldStats(ship.design, PARTS, { isLive: i => (ship.componentHp?.[i] ?? 1) > 0, powerMultiplier: i => ship.componentPower.byComponentIndex[i].operationalMultiplier, heatMultiplier: i => HeatRules.activeOutputForState(ship.componentHeatState[i] || HeatRules.STATE.NORMAL) });
  const runtime = effectiveShieldCapacityContributions(ship);
  close(shared.reduce((v, c) => v + c.capacity, 0), stats.capacity, `${label} shared sum matches stats capacity`);
  assert.deepStrictEqual(runtime, shared, `${label} runtime/shared contribution parity`);
}

// Full mixed-system production path.
{
  const design = [at("reactor",0,0), at("reactor",0,1), at("shield",1,0), at("aegisProjector",2,0), at("battery",1,1), at("capacitor",4,0), at("engine",8,8)];
  const ship = shipFor(design, [[0,2,[{x:0,y:0},{x:1,y:0}]], [0,3,[{x:0,y:0},{x:1,y:0},{x:2,y:0}]], [1,3,[{x:0,y:1},{x:1,y:1},{x:1,y:0},{x:2,y:0}]]]);
  const { deltas, heat } = hit(ship, 60);
  assertWeighted(ship, deltas, heat, "mixed");
  assert(deltas[3] > deltas[2] && PARTS.aegisProjector.shield > PARTS.shield.shield, "aegis receives more than shield");
  assert(deltas[2] > deltas[5] && PARTS.shield.shield > PARTS.capacitor.shield, "shield receives more than capacitor");
  assert(deltas[5] > deltas[4] && PARTS.capacitor.shield > PARTS.battery.shield, "capacitor receives more than battery");
}

// Equal contributors.
{
  const ship = shipFor([at("reactor",0,0), at("shield",1,0), at("shield",2,0)], [[0,2,[{x:0,y:0},{x:1,y:0},{x:2,y:0}]]]);
  const { deltas, heat } = hit(ship, 50);
  close(deltas[1], heat / 2, "first equal shield half"); close(deltas[2], heat / 2, "second equal shield half"); close(sum(deltas), heat, "equal total conserved");
}

// Real underpowered network.
{
  const ship = shipFor([at("reactor",0,0), at("auxGenerator",0,2), at("shield",1,0), at("shield",1,2)], [[0,2,[{x:0,y:0},{x:1,y:0}]], [1,3,[{x:0,y:2},{x:1,y:2}]]]);
  close(ship.componentPower.byComponentIndex[2].operationalMultiplier, 1, "full shield multiplier");
  const partial = PARTS.auxGenerator.powerGeneration / PARTS.shield.powerUse;
  close(ship.componentPower.byComponentIndex[3].operationalMultiplier, partial, "partial shield multiplier");
  const contributions = effectiveShieldCapacityContributions(ship);
  close(contributions.find(c => c.index === 2).capacity, PARTS.shield.shield, "full capacity contribution");
  close(contributions.find(c => c.index === 3).capacity, PARTS.shield.shield * partial, "partial capacity contribution");
  const { deltas, heat } = hit(ship, 40); assertWeighted(ship, deltas, heat, "underpowered"); assert(deltas[3] < deltas[2], "underpowered receives less heat");
}

// Disconnected/unpowered, destroyed renormalisation, and before/after proof.
{
  const ship = shipFor([at("reactor",0,0), at("shield",1,0), at("shield",4,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
  assert.deepStrictEqual(effectiveShieldCapacityContributions(ship).map(c => c.index), [1], "disconnected shield absent");
  let result = hit(ship, 20); close(result.deltas[2], 0, "disconnected shield no heat"); assertWeighted(ship, result.deltas, result.heat, "disconnected");
  const mixed = shipFor([at("reactor",0,0), at("reactor",0,2), at("shield",1,0), at("aegisProjector",1,2)], [[0,2,[{x:0,y:0},{x:1,y:0}]], [1,3,[{x:0,y:2},{x:1,y:2}]]]);
  const before = hit(mixed, 20); assert(before.deltas[3] > 0, "aegis received heat before destruction");
  mixed.shield = effectiveShieldStats(mixed).capacity; mixed.componentHp[3] = 0; flushComponentLifecycleRefresh(mixed); rebuildShipWiringState(mixed, "destroyed-test");
  const after = hit(mixed, 20); close(after.deltas[3], 0, "destroyed contributor no heat"); assertWeighted(mixed, after.deltas, after.heat, "destroyed renormalised");
}

// Battery/capacitor decision and no new activity Heat.
{
  const ship = shipFor([at("battery",0,0), at("capacitor",1,0)], []);
  const result = hit(ship, 30); assert(result.deltas[0] > 0 && result.deltas[1] > 0, "battery and capacitor receive impact heat");
  close(HeatRules.activityHeat("battery", PARTS.battery), 0, "battery activity heat remains zero"); close(HeatRules.activityHeat("capacitor", PARTS.capacitor), 0, "capacitor activity heat remains zero");
  updateShipHeat(ship, 1, room(), 200); updateShipHeat(ship, 1, room(), 300); close(ship.componentHeatGenerated[0], 0, "battery update adds no continuous activity heat"); close(ship.componentHeatGenerated[1], 0, "capacitor update adds no continuous activity heat");
}

// Heat-state independence with regen still heat-sensitive.
{
  const shares = [], capacities = [], regens = [];
  for (const state of [HeatRules.STATE.NORMAL, HeatRules.STATE.HOT, HeatRules.STATE.OVERHEATED]) {
    const ship = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
    ship.componentHeatState[1] = state; capacities.push(effectiveShieldCapacityContributions(ship)[0].capacity); regens.push(effectiveShieldStats(ship).recharge); shares.push(hit(ship, 25).deltas[1]);
  }
  close(capacities[0], capacities[1], "hot capacity independent"); close(capacities[0], capacities[2], "overheated capacity independent"); close(shares[0], shares[1], "hot impact share independent"); close(shares[0], shares[2], "overheated impact share independent"); assert(regens[0] > regens[1] && regens[1] > regens[2], "shield regen still changes by Heat multiplier");
}

// Partial shield absorption, shield multipliers, no-block cases, repeated impacts.
{
  const ship = shipFor([at("reactor",0,0), at("shield",1,0), at("capacitor",2,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]);
  ship.shield = 10; const hp = ship.hp; const partial = hit(ship, 100); close(partial.blocked, 10, "partial blocked only current shield"); close(sum(partial.deltas), 10 * SHIELD_IMPACT_HEAT_PER_BLOCKED_DAMAGE, "overflow adds no shield heat"); assert(ship.hp < hp, "overflow hull damage applies"); assertWeighted(ship, partial.deltas, partial.heat, "partial overflow", partial.contributionsBefore);
  for (const multiplier of [1.75, 0.4]) { const s = shipFor([at("reactor",0,0), at("shield",1,0), at("capacitor",2,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]); const r = hit(s, 20, { shieldDamageMultiplier: multiplier }); close(r.blocked, 20 * multiplier, `multiplier ${multiplier} blocked`); assertWeighted(s, r.deltas, r.heat, `multiplier ${multiplier}`); }
  const empty = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]); empty.shield = 0; close(sum(hit(empty, 20).deltas), 0, "empty pool no heat");
  const zero = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]); close(sum(hit(zero, 20, { shieldDamageMultiplier: 0 }).deltas), 0, "zero shield damage no heat");
  const dead = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]); dead.alive = false; dead.hp = 0; dead.shield = 0; close(sum(hit(dead, 20).deltas), 0, "dead ship no impact heat beyond existing semantics");
  const invalid = shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]); close(sum(hit(invalid, NaN).deltas), 0, "invalid damage no impact heat");
  const repeated = shipFor([at("reactor",0,0), at("shield",1,0), at("capacitor",2,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]); repeated.shield = 35; let expected = 0; for (const dmg of [5, 11, 40]) { const r = hit(repeated, dmg); expected += r.heat; assertWeighted(repeated, r.deltas, r.heat, `repeated ${dmg}`); } close(sum(repeated.componentHeatInput), expected, "repeated accumulated conserved");
}

// Shared/runtime contribution parity cases.
{
  const cases = [
    shipFor([at("reactor",0,0), at("shield",1,0), at("battery",2,0), at("capacitor",3,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]),
    shipFor([at("auxGenerator",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]]),
    shipFor([at("reactor",0,0), at("shield",4,0)], []),
    shipFor([at("reactor",0,0), at("shield",1,0)], [[0,1,[{x:0,y:0},{x:1,y:0}]]])
  ];
  cases[3].componentHeatState[1] = HeatRules.STATE.OVERHEATED;
  cases[0].componentHeatState[1] = HeatRules.STATE.HOT; cases[0].componentHp[2] = 0; flushComponentLifecycleRefresh(cases[0]); rebuildShipWiringState(cases[0], "parity-destroyed");
  cases.forEach((s, i) => assertContributionParity(s, `parity ${i}`));
}

// Weighted allocator focused edge cases.
{
  const original = [{ index: 0, capacity: 1 }, { index: 1, capacity: 1 }, { index: 1, capacity: 2 }, { index: 2, capacity: 9 }, { index: 99, capacity: 9 }, { index: 0, capacity: -1 }, { index: 0, weight: NaN }];
  const clone = JSON.stringify(original); const ship = { componentHp: [1, 1, 0], componentHeatInput: [0, 0, 0] };
  close(distributeComponentHeatByWeight(ship, original, 0), 0, "zero amount queues nothing"); close(distributeComponentHeatByWeight(ship, original, -1), 0, "negative amount queues nothing"); close(distributeComponentHeatByWeight(ship, original, Infinity), 0, "non-finite amount queues nothing");
  close(distributeComponentHeatByWeight(ship, original, 10), 10, "allocator returns queued amount"); close(ship.componentHeatInput[0], 2.5, "allocator proportional first"); close(ship.componentHeatInput[1], 7.5, "allocator duplicate/remainder"); close(ship.componentHeatInput[2], 0, "allocator ignores destroyed"); assert.strictEqual(JSON.stringify(original), clone, "allocator does not mutate inputs");
}

console.log("Shield impact Heat production-path verification passed.");
