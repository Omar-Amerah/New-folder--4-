// Regression coverage for component-aware Repair Drone targeting.
//
// Repair Drones must use the shared component-aware repair-need helper
// (shipRepairNeed) rather than aggregate ship.hp, so Core-only and
// component-only damage are detected. They must never target enemies, never
// select a fully-repaired ship, and respect command range and alive state.

const assert = require("assert");
const { _test, CONFIG } = require("./src/server/drones");
const { initComponentState } = require("./src/server/componentHealth");
const { chooseTarget } = _test;

const REPAIR = CONFIG.types.repair;

function makeRoom() {
  return {
    rules: { gameMode: "teams" },
    ships: new Map(),
    drones: new Map(),
    players: new Map([
      ["p1", { id: "p1", team: "blue" }],
      ["p2", { id: "p2", team: "red" }]
    ])
  };
}

function makeShip(id, ownerId, x, y) {
  const design = [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "beamEmitter", x: 7, y: 5, rotation: 0 },
    { type: "frame", x: 7, y: 8, rotation: 0 }
  ];
  const ship = {
    id, ownerId, x, y, angle: 0, alive: true, radius: 30, design,
    stats: { maxHp: 300, radius: 30 }
  };
  initComponentState(ship);
  return ship;
}

function repairDrone(ownerId, parentId) {
  return { id: `d-${parentId}`, ownerId, type: "repair", parentShipId: parentId, x: 0, y: 0, destroyed: false };
}

function setup() {
  const room = makeRoom();
  const parent = makeShip("parent", "p1", 0, 0);
  room.ships.set(parent.id, parent);
  const drone = repairDrone("p1", "parent");
  return { room, parent, drone };
}

function addAlly(room, id, x = 50, y = 0) {
  const ally = makeShip(id, "p1", x, y);
  room.ships.set(id, ally);
  return ally;
}

// 1. Core-only damage makes a ship count as damaged (aggregate hp misses it).
(function coreOnlyDamage() {
  const { room, parent, drone } = setup();
  // Damage only the core component; ship.hp stays at max (core has its own pool).
  parent.componentHp[0] = parent.componentMaxHp[0] * 0.5;
  assert.strictEqual(parent.hp, parent.maxHp, "core damage does not reduce aggregate hp");
  assert.strictEqual(chooseTarget(room, drone, parent, REPAIR), parent, "parent with core-only damage is a valid repair target");
  console.log("PASS: a ship with only Core damage is considered damaged");
})();

// 2. Weapon-only damage on an ally is detected.
(function weaponOnlyDamageAlly() {
  const { room, parent, drone } = setup();
  const ally = addAlly(room, "ally", 60, 0);
  ally.componentHp[1] = ally.componentMaxHp[1] * 0.5; // beamEmitter damaged
  ally.hp = ally.maxHp - (ally.componentMaxHp[1] * 0.5); // reflect in hull too
  assert.strictEqual(chooseTarget(room, drone, parent, REPAIR), ally, "ally with weapon damage is selected when parent is intact");
  console.log("PASS: a ship with only component (weapon) damage is considered damaged");
})();

// 3. Hull damage on an ally is detected.
(function hullDamageAlly() {
  const { room, parent, drone } = setup();
  const ally = addAlly(room, "ally", 60, 0);
  ally.componentHp[2] = ally.componentMaxHp[2] * 0.4;
  ally.hp = ally.maxHp * 0.7;
  assert.strictEqual(chooseTarget(room, drone, parent, REPAIR), ally, "ally with hull damage is selected");
  console.log("PASS: hull damage is considered damaged");
})();

// 4. Among several damaged allies the most-in-need (weighted) is chosen.
(function severalDamagedAllies() {
  const { room, parent, drone } = setup();
  const light = addAlly(room, "ally-light", 60, 0);
  light.componentHp[2] = light.componentMaxHp[2] - 5; // minor hull scratch
  light.hp = light.maxHp - 5;
  const heavy = addAlly(room, "ally-heavy", 80, 0);
  heavy.componentHp[0] = heavy.componentMaxHp[0] * 0.3; // core badly hurt
  heavy.componentHp[1] = heavy.componentMaxHp[1] * 0.3; // weapon badly hurt
  heavy.hp = heavy.maxHp * 0.4;
  assert.strictEqual(chooseTarget(room, drone, parent, REPAIR), heavy, "the ally in greatest need is chosen");
  console.log("PASS: among several damaged allies the neediest is selected");
})();

// 5. Fully repaired allies are not selected (falls back to parent).
(function fullyRepairedNotSelected() {
  const { room, parent, drone } = setup();
  addAlly(room, "ally-a", 60, 0); // fully repaired
  addAlly(room, "ally-b", 70, 0); // fully repaired
  // parent also full -> no valid target, defaults to parent, never an ally.
  const target = chooseTarget(room, drone, parent, REPAIR);
  assert.strictEqual(target, parent, "with everyone full, a fully-repaired ally is never chosen");
  console.log("PASS: a fully repaired ship is not selected");
})();

// 6. Enemies are never targeted.
(function neverTargetEnemies() {
  const { room, parent, drone } = setup();
  const enemy = makeShip("enemy", "p2", 60, 0);
  enemy.componentHp[0] = enemy.componentMaxHp[0] * 0.2; // badly damaged enemy
  enemy.hp = enemy.maxHp * 0.2;
  room.ships.set("enemy", enemy);
  const target = chooseTarget(room, drone, parent, REPAIR);
  assert.notStrictEqual(target, enemy, "a damaged enemy is never selected for repair");
  assert.strictEqual(target, parent, "falls back to the parent instead");
  console.log("PASS: Repair Drones must not target enemies");
})();

// 7. A destroyed ally is not selected.
(function destroyedTargetNotSelected() {
  const { room, parent, drone } = setup();
  const ally = addAlly(room, "ally", 60, 0);
  ally.componentHp[1] = ally.componentMaxHp[1] * 0.5;
  ally.hp = ally.maxHp * 0.5;
  ally.alive = false; // destroyed during repair
  assert.strictEqual(chooseTarget(room, drone, parent, REPAIR), parent, "a destroyed ally is not selected");
  console.log("PASS: a target destroyed during repair is dropped");
})();

// 8. An ally outside command range is not selected.
(function outOfCommandRange() {
  const { room, parent, drone } = setup();
  const ally = addAlly(room, "ally", REPAIR.commandRange + 200, 0);
  ally.componentHp[1] = ally.componentMaxHp[1] * 0.5;
  ally.hp = ally.maxHp * 0.5;
  assert.strictEqual(chooseTarget(room, drone, parent, REPAIR), parent, "an ally beyond command range is not selected");
  console.log("PASS: a target leaving command range is dropped");
})();

console.log("\nREPAIR DRONE TARGETING REGRESSION TESTS PASSED");
