"use strict";
// Review regressions: core repair preserves hull-integrity accounting, and beam
// targeting chooses the closest component on the beam path rather than blueprint
// insertion order.
const assert = require("assert");
const { computeStats } = require("./src/server/shipStats");
const { initComponentState, repairShipComponents } = require("./src/server/componentHealth");
const { updateShipWeapons, componentAimWorldPosition, selectComponentAimIndex } = require("./src/server/combat");

function makeShip(design, overrides = {}) {
  const ship = {
    id: overrides.id || "ship",
    ownerId: overrides.ownerId || "p1",
    design,
    x: overrides.x || 0,
    y: overrides.y || 0,
    vx: 0,
    vy: 0,
    angle: overrides.angle || 0,
    alive: true,
    shield: 0,
    ...overrides
  };
  ship.stats = { ...computeStats(design), ...(overrides.stats || {}) };
  initComponentState(ship);
  ship.maxShield = ship.stats.maxShield || 0;
  return ship;
}

// Repairing the core should restore only the core's private pool. It must not
// raise ship.hp because the core is excluded from hull integrity.
{
  const ship = makeShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "frame" }]);
  ship.componentHp[0] -= 40;
  ship.dirtyComponents.add(0);
  const hullBeforeRepair = ship.hp;
  assert(ship.componentHp[0] < ship.componentMaxHp[0], "core pool should be damaged for the repair test");
  repairShipComponents(null, ship, 20, 0);
  assert.strictEqual(ship.hp, hullBeforeRepair, "core repair must not inflate hull hp");
}


// Component-aware targeting should use rotated component centres, avoid the core
// while protected by other living modules, and prefer a different module when
// retargeting is requested.
{
  const target = makeShip(
    [
      { x: 7, y: 7, type: "core" },
      { x: 7, y: 5, type: "frame" },
      { x: 5, y: 7, type: "blaster" }
    ],
    { id: "component-target", ownerId: "p2", x: 100, y: 200, angle: Math.PI / 2 }
  );
  const point = componentAimWorldPosition(target, 1);
  assert(Math.abs(point.x - 100) < 0.0001, "component aim point should rotate with the target ship");
  assert(Math.abs(point.y - 226) < 0.0001, "component aim point should translate with the target ship");

  const room = { combatRandom: () => 0.999 };
  assert.notStrictEqual(selectComponentAimIndex(room, target, null), 0, "core should not be selected while non-core components live");
  assert.strictEqual(selectComponentAimIndex({ combatRandom: () => 0 }, target, 1), 2, "retarget should prefer a different living component when possible");
  target.componentHp[1] = 0;
  assert.strictEqual(selectComponentAimIndex({ combatRandom: () => 0 }, target, 1), 2, "destroyed component should retarget to another living component");
}

// A beam crossing a target whose rear module is listed first should still damage
// the front module first. This catches order-dependent beam penetration.
{
  const attacker = makeShip(
    [{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "beamEmitter" }],
    { id: "a", ownerId: "p1", x: 0, y: 0, angle: 0 }
  );
  attacker.weaponCooldowns = [0, 0];
  attacker.weaponAngles = [0, 0];
  attacker.thermalPowerFactor = 1;

  const target = makeShip(
    [
      { x: 7, y: 5, type: "frame" }, // rear along the incoming beam, deliberately listed first
      { x: 7, y: 9, type: "frame" }, // front along the incoming beam
      { x: 7, y: 7, type: "core" }
    ],
    { id: "t", ownerId: "p2", x: 130, y: 0, angle: 0 }
  );
  const frontHp = target.componentHp[1];
  const rearHp = target.componentHp[0];
  const room = {
    players: new Map([["p1", { id: "p1", team: 1 }], ["p2", { id: "p2", team: 2 }]]),
    ships: new Map([[attacker.id, attacker], [target.id, target]]),
    bullets: [],
    effects: [],
    map: { asteroids: [] },
    world: { width: 1000, height: 1000 }
  };

  updateShipWeapons(room, attacker, [attacker, target], 1, 1000);
  assert(target.componentHp[1] < frontHp, "front component should take beam damage first");
  assert.strictEqual(target.componentHp[0], rearHp, "rear component should not be hit before the front component");
}

console.log("Combat review verification passed");
