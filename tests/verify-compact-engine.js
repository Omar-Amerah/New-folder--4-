"use strict";

const assert = require("assert");
const { PARTS } = require("../src/server/components");
const { computeStats } = require("../src/server/shipStats");
const { validateDesign, normalizeShipDesignSnapshot } = require("../src/server/shipDesign");
const EngineExhaust = require("../public/src/shared/engineExhaust.js");
const { initComponentState, updateEngineExhaustState } = require("../src/server/componentHealth");
const { initShipHeat, updateShipHeat } = require("../src/server/heat");
const { heatAdjustedMovementStats, applyEngineHeat } = require("../src/server/movementCapability");

function withCore(...modules) {
  return [{ x: 7, y: 7, type: "core" }].concat(modules);
}

function compactStats() {
  return {
    part: PARTS.compactEngine,
    stats: computeStats(withCore({ x: 7, y: 9, type: "compactEngine" }))
  };
}

// --- Catalogue ---
assert(PARTS.compactEngine, "compactEngine missing from PARTS");
assert.strictEqual(PARTS.compactEngine.category, "Engines");
assert.strictEqual(PARTS.compactEngine.cost, 10);
assert.strictEqual(PARTS.compactEngine.mass, 3);
assert.strictEqual(PARTS.compactEngine.hp, 32);
assert.strictEqual(PARTS.compactEngine.powerUse, 0.75);
assert.strictEqual(PARTS.compactEngine.powerCategory, "propulsion");
assert.strictEqual(PARTS.compactEngine.thrust, 95);
assert.strictEqual(PARTS.compactEngine.turn, 0);
assert.strictEqual(PARTS.compactEngine.rotatable, false);
assert.deepStrictEqual(PARTS.compactEngine.footprint, { width: 1, height: 1 });

// Standard engine identity unchanged.
assert.strictEqual(PARTS.engine.category, "Engines");
assert.strictEqual(PARTS.engine.thrust, 227);
assert.strictEqual(PARTS.engine.powerUse, 1.02);
assert.strictEqual(PARTS.engine.mass, 4);
assert.strictEqual(PARTS.engine.hp, 48);

// --- Rotation normalisation ---
for (const rotation of [0, 90, 180, 270]) {
  const normalised = normalizeShipDesignSnapshot(withCore({ x: 7, y: 9, type: "compactEngine", rotation }));
  assert.strictEqual(normalised[1].rotation, 0, `compactEngine rotation ${rotation} should normalise to 0`);
}

// --- Single-engine movement ---
const single = compactStats().stats;
assert.strictEqual(single.thrust, 95, "single compact thrust");
assert.strictEqual(single.effectiveThrust, 95, "single compact effectiveThrust");
assert(single.accel > 0, "single compact acceleration");
assert(single.maxSpeed > 0, "single compact maxSpeed");
assert(single.turnRate > 0, "single compact vector turn contribution");

// --- Stacking comparisons ---
const dualCompact = computeStats(withCore(
  { x: 6, y: 9, type: "compactEngine" },
  { x: 8, y: 9, type: "compactEngine" }
));
assert.strictEqual(dualCompact.effectiveThrust, 186.2, "two Compact Engines stack with falloff");

const standard = computeStats(withCore({ x: 7, y: 9, type: "engine" }));
assert(standard.effectiveThrust > dualCompact.effectiveThrust, "one standard Engine beats two Compact Engines");
assert(standard.thrust > dualCompact.thrust, "one standard nominal thrust beats two Compact");

const costMassPowerComparison = computeStats(withCore(
  { x: 6, y: 9, type: "compactEngine" },
  { x: 8, y: 9, type: "compactEngine" }
));
assert(costMassPowerComparison.cost > standard.cost, "two Compact Engines cost more");
assert(costMassPowerComparison.mass > standard.mass, "two Compact Engines weigh more");
assert(costMassPowerComparison.powerUse > standard.powerUse, "two Compact Engines draw more Power");

// --- Mixed stacking is order-independent ---
const mixedA = computeStats(withCore(
  { x: 6, y: 9, type: "compactEngine" },
  { x: 8, y: 9, type: "engine" }
));
const mixedB = computeStats(withCore(
  { x: 6, y: 9, type: "engine" },
  { x: 8, y: 9, type: "compactEngine" }
));
assert.strictEqual(mixedA.effectiveThrust, mixedB.effectiveThrust, "mixed engine stacking order should not matter");
assert.strictEqual(mixedA.effectiveThrust, 318.2, "stronger engine takes the primary stack position");

// --- Exhaust geometry ---
const clear = EngineExhaust.analyze(withCore({ x: 7, y: 9, type: "compactEngine" }), PARTS);
assert(clear.validEngineIndices.has(1), "unobstructed Compact Engine is valid");
assert.deepStrictEqual(clear.engines.get(1).exhaust, { x: 0, y: 1 }, "Compact Engine exhaust points +y");

const blocked = EngineExhaust.analyze(withCore({ x: 7, y: 9, type: "compactEngine" }, { x: 7, y: 10, type: "armor" }), PARTS);
assert(blocked.blockedEngineIndices.has(1), "armor directly behind blocks Compact Engine");

const side = EngineExhaust.analyze(withCore({ x: 7, y: 9, type: "compactEngine" }, { x: 6, y: 9, type: "armor" }, { x: 8, y: 9, type: "armor" }), PARTS);
assert(side.validEngineIndices.has(1), "side-adjacent components do not block a 1x1 exhaust lane");

const sideBlocked = computeStats(withCore({ x: 7, y: 9, type: "compactEngine" }, { x: 6, y: 9, type: "armor" }, { x: 8, y: 9, type: "armor" }));
assert.strictEqual(sideBlocked.blockedEngines, 0, "side-adjacent components do not count as blocked");

// --- Damage and redundancy ---
const damageDesign = withCore(
  { x: 6, y: 9, type: "compactEngine" },
  { x: 8, y: 9, type: "compactEngine" }
);
const damagedShip = { design: damageDesign, alive: true };
const intactStats = computeStats(damageDesign);
damagedShip.stats = intactStats;
initComponentState(damagedShip);
initShipHeat(damagedShip);

const one = heatAdjustedMovementStats(damagedShip, damagedShip.stats);
assert.strictEqual(one.effectiveThrust, dualCompact.effectiveThrust, "both compact engines contribute when healthy");

// Destroy the first compact engine (index 1).
damagedShip.componentHp[1] = 0;
updateEngineExhaustState(damagedShip);
const afterOne = heatAdjustedMovementStats(damagedShip, damagedShip.stats);
assert.strictEqual(afterOne.effectiveThrust, 95, "destroying one Compact Engine removes only its contribution");

// Destroy the second compact engine.
damagedShip.componentHp[2] = 0;
updateEngineExhaustState(damagedShip);
const afterBoth = heatAdjustedMovementStats(damagedShip, damagedShip.stats);
assert.strictEqual(afterBoth.effectiveThrust, 0, "destroying all main engines gives zero effective thrust");
assert.strictEqual(afterBoth.maxSpeed, 0, "destroying all main engines gives zero max speed");

// --- Power scaling ---
const powerDesign = withCore({ x: 7, y: 9, type: "compactEngine" });
const powerShip = { design: powerDesign, alive: true };
powerShip.stats = computeStats(powerDesign);
initComponentState(powerShip);
initShipHeat(powerShip);

const full = heatAdjustedMovementStats(powerShip, powerShip.stats);
assert.strictEqual(full.effectiveThrust, 95, "fully-powered Compact Engine contributes 95 effective thrust");

// Remove power on the engine by zeroing its operational multiplier.
powerShip.componentPower = { byComponentIndex: { 1: { operationalMultiplier: 0 } } };
const unpowered = heatAdjustedMovementStats(powerShip, powerShip.stats);
assert.strictEqual(unpowered.effectiveThrust, 0, "zero Power gives zero Compact Engine thrust");

// --- Heat ---
const heatDesign = withCore({ x: 7, y: 9, type: "compactEngine" });
const heatShip = { design: heatDesign, alive: true };
heatShip.stats = computeStats(heatDesign);
initComponentState(heatShip);
initShipHeat(heatShip);

const beforeHeat = heatShip.componentHeat[1];
applyEngineHeat(heatShip, 1, 1);
updateShipHeat(heatShip, 0.2);
assert(heatShip.componentHeat[1] > beforeHeat, "Compact Engine thrust activity produces Heat");

const coastShip = { design: heatDesign, alive: true };
coastShip.stats = computeStats(heatDesign);
initComponentState(coastShip);
initShipHeat(coastShip);
const coastBefore = coastShip.componentHeat[1];
applyEngineHeat(coastShip, 0, 1);
updateShipHeat(coastShip, 0.2);
assert.strictEqual(coastShip.componentHeat[1], coastBefore, "coasting produces no engine activity Heat");

const blockedDesign = withCore({ x: 7, y: 9, type: "compactEngine" }, { x: 7, y: 10, type: "armor" });
const blockedHeatShip = { design: blockedDesign, alive: true };
blockedHeatShip.stats = computeStats(blockedDesign);
initComponentState(blockedHeatShip);
initShipHeat(blockedHeatShip);
const blockedHeatBefore = blockedHeatShip.componentHeat[1];
applyEngineHeat(blockedHeatShip, 1, 1);
updateShipHeat(blockedHeatShip, 0.2);
assert.strictEqual(blockedHeatShip.componentHeat[1], blockedHeatBefore, "blocked Compact Engine produces no thrust Heat");

console.log("Compact Engine verification passed");
