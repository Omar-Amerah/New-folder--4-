"use strict";
// Group 5: the core is destroyable (but hard to reach and kept out of the hull
// sum), penetration resolves front-to-back through components, and a reactor
// meltdown detonates, damaging nearby components.
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const {
  initComponentState,
  applyHullDamage,
  componentsAlongImpactRay,
  detonateComponent
} = require("./src/server/componentHealth");

function makeShip(design) {
  const ship = { design, x: 0, y: 0, angle: 0, alive: true };
  ship.stats = { ...computeStats(design) };
  initComponentState(ship);
  return ship;
}

// 1. The core has its own large pool and is excluded from the hull-integrity sum.
{
  const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }, { x: 6, y: 7, type: "frame" }];
  const ship = makeShip(design);
  assert(ship.componentHp[0] >= 320, "core should have a large hp pool");
  const hullSum = ship.componentHp.reduce((sum, hp, i) => (design[i].type === "core" ? sum : sum + hp), 0);
  assert(Math.abs(hullSum - ship.hp) < 0.5, "ship.hp should equal the non-core component sum");
  assert(ship.coreDestroyed === false, "core should start intact");
}

// 2. The core can be destroyed once a shot reaches it, which flags the ship.
{
  const ship = makeShip([{ x: 7, y: 7, type: "core" }]);
  // A hit incoming from the +x world side rays straight into the centre cell.
  applyHullDamage(null, ship, 100000, 0, 100, 0);
  assert.strictEqual(ship.componentHp[0], 0, "core should be destroyed by an overwhelming penetrating hit");
  assert.strictEqual(ship.coreDestroyed, true, "destroying the core should flag coreDestroyed (ship dies)");
}

// 3. Penetration order: exterior armour is reached before the inner core.
{
  const design = [{ x: 7, y: 4, type: "armor" }, { x: 7, y: 7, type: "core" }, { x: 7, y: 9, type: "reactor" }];
  const ship = makeShip(design);
  const chain = componentsAlongImpactRay(ship, 100, 0); // ray along the gx=7 column
  const armorPos = chain.indexOf(0);
  const corePos = chain.indexOf(1);
  assert(armorPos !== -1 && corePos !== -1, "ray should pass through both armour and core");
  assert(armorPos < corePos, "armour should be penetrated before the core");
}

// 4. Reactor meltdown detonates: it is destroyed and a neighbour takes damage.
{
  const design = [{ x: 7, y: 7, type: "reactor" }, { x: 8, y: 7, type: "blaster" }, { x: 7, y: 9, type: "core" }];
  const ship = makeShip(design);
  const powerBefore = ship.stats.powerGeneration;
  const neighbourHpBefore = ship.componentHp[1];
  const fired = detonateComponent(null, ship, 0, 1.9, 60, 0);
  assert.strictEqual(fired, true, "detonation should fire");
  assert.strictEqual(ship.componentHp[0], 0, "the reactor should be destroyed by its own meltdown");
  assert(ship.componentHp[1] < neighbourHpBefore, "an adjacent component should take blast damage");
  assert(ship.componentHp[1] > 0, "a healthy adjacent component should survive one blast (no instant chain)");
  assert(ship.stats.powerGeneration < powerBefore, "destroyed reactor should stop contributing power");
}

console.log("Core/reactor verification passed");
