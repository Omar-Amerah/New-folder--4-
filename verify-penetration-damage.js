// Regression coverage for penetration raw-damage accounting through thermally
// weakened passive structure.
//
// Thermal amplification multiplies the HP damage a hot passive component takes,
// but destroying it must consume only the EQUIVALENT RAW damage (hpRemoved /
// mult) from the penetration budget — the same principle Beam burn-through uses.
// Previously the amplified HP damage was subtracted from the raw budget, so hot
// structure wrongly absorbed extra penetration.

const assert = require("assert");
const HeatRules = require("./public/src/shared/heatRules");
const { PARTS } = require("./src/server/components");
const { initComponentState, applyHullDamage } = require("./src/server/componentHealth");

const NORMAL = HeatRules.STATE.NORMAL;
const HOT = HeatRules.STATE.HOT;         // mult 1.15
const CRITICAL = HeatRules.STATE.CRITICAL; // mult 1.35
const OVERHEATED = HeatRules.STATE.OVERHEATED; // mult 1.6

function makeShip(design) {
  const ship = {
    id: "s", ownerId: "p", x: 0, y: 0, angle: 0, alive: true, hp: 400, maxHp: 400, radius: 40,
    design, stats: { maxHp: 400, radius: 40 },
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) }
  };
  initComponentState(ship);
  ship.componentHeatState = design.map(() => NORMAL);
  return ship;
}

// Ship whose +x impact ray crosses frame(7,5)=idx1 then frame(7,6)=idx2, with an
// off-ray core. Source (60,0) is just outside the front frame.
function twoFrameShip() {
  return makeShip([
    { type: "core", x: 10, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 5, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 }
  ]);
}

const mult = (state) => HeatRules.structuralDamageMultiplierForState(state);
const SOURCE = [60, 0];
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: got ${a}, expected ${b}`);

// 1. Normal-temperature structure: raw consumed == HP removed (mult 1).
(function normalTemp() {
  const ship = twoFrameShip();
  ship.componentHp[1] = 10; ship.componentHp[2] = 100;
  applyHullDamage({ effects: [] }, ship, 30, 1000, SOURCE[0], SOURCE[1], {});
  assert.strictEqual(ship.componentHp[1], 0, "front frame destroyed");
  near(ship.componentHp[2], 100 - (30 - 10), "cold front consumes raw == HP removed; 20 penetrates");
  console.log("PASS: normal-temperature structure consumes raw damage equal to HP removed");
})();

// 2. Hot structure penetrates further (raw consumed = HP / 1.15).
(function hotStructure() {
  const ship = twoFrameShip();
  ship.componentHp[1] = 10; ship.componentHp[2] = 100; ship.componentHeatState[1] = HOT;
  applyHullDamage({ effects: [] }, ship, 30, 1000, SOURCE[0], SOURCE[1], {});
  assert.strictEqual(ship.componentHp[1], 0, "hot front frame destroyed");
  near(ship.componentHp[2], 100 - (30 - 10 / mult(HOT)), "hot front consumes only raw-equivalent; more penetrates");
  console.log("PASS: hot structure consumes only the equivalent raw damage");
})();

// 3. Critical structure penetrates even further (raw consumed = HP / 1.35).
(function criticalStructure() {
  const ship = twoFrameShip();
  ship.componentHp[1] = 10; ship.componentHp[2] = 100; ship.componentHeatState[1] = CRITICAL;
  applyHullDamage({ effects: [] }, ship, 30, 1000, SOURCE[0], SOURCE[1], {});
  near(ship.componentHp[2], 100 - (30 - 10 / mult(CRITICAL)), "critical front consumes even less raw budget");
  console.log("PASS: critical structure consumes only the equivalent raw damage");
})();

// 4. Armour flat reduction combined with Heat amplification.
(function armorPlusHeat() {
  // Front armour (armorFlatReduction 5, hp 240) hot; behind it a frame.
  const ship = makeShip([
    { type: "core", x: 10, y: 7, rotation: 0 },
    { type: "armor", x: 7, y: 5, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 }
  ]);
  ship.componentHp[1] = 10; ship.componentHp[2] = 100; ship.componentHeatState[1] = OVERHEATED;
  const armorPart = PARTS.armor;
  const protection = HeatRules.passiveProtectionForState(OVERHEATED);
  const reduction = armorPart.armorFlatReduction * protection * 1; // interactionSeconds = 1
  applyHullDamage({ effects: [] }, ship, 30, 1000, SOURCE[0], SOURCE[1], { armorInteractionSeconds: 1 });
  assert.strictEqual(ship.componentHp[1], 0, "front armour destroyed");
  // remaining after armour flat reduction = 30 - reduction; raw consumed to
  // destroy = HP(10) / mult(1.6); the rest penetrates to the frame behind.
  const remainingAfterArmor = 30 - reduction;
  const expectedBehind = 100 - (remainingAfterArmor - 10 / mult(OVERHEATED));
  near(ship.componentHp[2], expectedBehind, "armour reduction applies to raw budget, then heat-adjusted raw is consumed");
  console.log("PASS: armour flat reduction combines correctly with Heat amplification");
})();

// 5. Multiple structural layers: penetration threads through all of them.
(function multipleLayers() {
  const ship = makeShip([
    { type: "core", x: 10, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 5, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 },
    { type: "frame", x: 7, y: 7, rotation: 0 }
  ]);
  ship.componentHp[1] = 5; ship.componentHp[2] = 5; ship.componentHp[3] = 100;
  ship.componentHeatState[1] = OVERHEATED; ship.componentHeatState[2] = OVERHEATED;
  applyHullDamage({ effects: [] }, ship, 40, 1000, SOURCE[0], SOURCE[1], {});
  assert.strictEqual(ship.componentHp[1], 0, "layer 1 destroyed");
  assert.strictEqual(ship.componentHp[2], 0, "layer 2 destroyed");
  // Raw consumed by the two hot layers = 5/1.6 + 5/1.6 = 6.25; remainder hits layer 3.
  near(ship.componentHp[3], 100 - (40 - (5 / mult(OVERHEATED) + 5 / mult(OVERHEATED))), "raw budget threads through multiple hot layers");
  console.log("PASS: penetration accounts raw damage across multiple structural layers");
})();

// 6. Exact damage with no remaining penetration.
(function exactNoRemainder() {
  const ship = twoFrameShip();
  ship.componentHp[1] = 10; ship.componentHp[2] = 100; ship.componentHeatState[1] = NORMAL;
  // Exactly enough raw to destroy the cold front frame, nothing left over.
  applyHullDamage({ effects: [] }, ship, 10, 1000, SOURCE[0], SOURCE[1], {});
  assert.strictEqual(ship.componentHp[1], 0, "front frame destroyed exactly");
  assert.strictEqual(ship.componentHp[2], 100, "no penetration reaches the component behind");
  console.log("PASS: exact damage destroys the front component with no remaining penetration");
})();

// 7. Core behind thermally weakened structure is reached by leftover raw damage.
(function coreBehindHotStructure() {
  // Ray crosses front frame(7,5)=idx1 then core(7,7)=idx0.
  const ship = makeShip([
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 5, rotation: 0 }
  ]);
  ship.componentHp[1] = 10; ship.componentHeatState[1] = OVERHEATED;
  const coreBefore = ship.componentHp[0];
  applyHullDamage({ effects: [] }, ship, 30, 1000, SOURCE[0], SOURCE[1], {});
  assert.strictEqual(ship.componentHp[1], 0, "hot front frame destroyed");
  const coreDamage = coreBefore - ship.componentHp[0];
  near(coreDamage, 30 - 10 / mult(OVERHEATED), "leftover raw damage reaches the core behind the weakened structure");
  console.log("PASS: core behind thermally weakened structure takes the correct leftover damage");
})();

console.log("\nPENETRATION RAW-DAMAGE REGRESSION TESTS PASSED");
