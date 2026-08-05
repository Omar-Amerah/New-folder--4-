"use strict";
const assert = require("assert");

(async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;

  const { PARTS } = require("../src/server/components");
  const { computeStats } = require("../src/server/shipStats");
  const { initComponentState } = require("../src/server/componentHealth");
  const { updateShipWeapons } = require("../src/server/combat");
  const { reallocateShipPower } = require("../src/server/componentPower");
  const WiringRules = require("../public/src/shared/wiringRules");

  function makeTestShip(design, wiring = null, ownerId = "p1") {
    let shipWiring = wiring;
    if (!shipWiring) {
      try {
        shipWiring = WiringRules.createGeneratedPowerWiring(design, PARTS);
      } catch (_) {
        shipWiring = { power: [], data: [] };
      }
    }
    const stats = computeStats(design, shipWiring);
    const ship = {
      id: `test-ship-${Math.random().toString(36).substr(2, 5)}`,
      ownerId,
      x: 100,
      y: 100,
      angle: 0,
      vx: 0,
      vy: 0,
      design,
      wiring: shipWiring,
      stats,
      alive: true,
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      shield: 0,
      maxShield: 0,
      commandState: "mainCore"
    };
    initComponentState(ship);
    reallocateShipPower(ship, "init");
    ship.weaponAngles = ship.design.map((m) => (m.rotation || 0) * (Math.PI / 180));
    ship.weaponCooldowns = ship.design.map(() => 0);
    ship.weaponDesiredAngles = ship.design.map(() => 0);
    ship.weaponAimTargetIds = ship.design.map(() => null);
    ship.weaponFireTargetIds = ship.design.map(() => null);
    return ship;
  }

  function makeRoom(ships = []) {
    const shipMap = new Map();
    const playerMap = new Map([
      ["p1", { id: "p1", name: "Player 1", team: "A", kills: 0, losses: 0, money: 1000, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }],
      ["p2", { id: "p2", name: "Player 2", team: "B", kills: 0, losses: 0, money: 1000, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }]
    ]);
    for (const ship of ships) {
      shipMap.set(ship.id, ship);
      const owner = playerMap.get(ship.ownerId);
      if (owner) owner.ships.push(ship);
    }
    return {
      code: "test-room",
      phase: "active",
      ships: shipMap,
      players: playerMap,
      bullets: [],
      drones: new Map(),
      points: [],
      effects: [],
      map: { asteroids: [] },
      rules: { gameMode: "solo" },
      world: { width: 4000, height: 4000 }
    };
  }

  console.log("Running Torpedo Point Defence Priority Tests...\n");

  // Test 1: getCandidatePriorityIndex correctly prioritizes torpedo over ordinary missile
  {
    const { getCandidatePriorityIndex } = require("../src/server/combat");
    const priorityList = ["torpedo", "missile", "projectile", "ship"];
    
    const torpedoCandidate = { type: "projectile", entity: { type: "missile", subtype: "torpedo" } };
    const missileCandidate = { type: "projectile", entity: { type: "missile", subtype: "missile" } };
    
    const torpedoIdx = getCandidatePriorityIndex(torpedoCandidate, priorityList);
    const missileIdx = getCandidatePriorityIndex(missileCandidate, priorityList);
    
    assert.strictEqual(torpedoIdx, 0, "Torpedo subtype matches priority index 0");
    assert.strictEqual(missileIdx, 1, "Missile subtype matches priority index 1");
    assert.ok(torpedoIdx < missileIdx, "Torpedo is prioritized over ordinary missile");
    console.log("✔ Test 1 passed: getCandidatePriorityIndex correctly prioritizes torpedo over ordinary missile.");
  }

  // Test 2: Torpedo subtype is correctly matched in priority list with swarmMissile
  {
    const { getCandidatePriorityIndex } = require("../src/server/combat");
    const priorityList = ["torpedo", "missile", "swarmMissile", "projectile", "ship"];
    
    const torpedoCandidate = { type: "projectile", entity: { type: "missile", subtype: "torpedo" } };
    const swarmCandidate = { type: "projectile", entity: { type: "missile", subtype: "swarmMissile" } };
    
    const torpedoIdx = getCandidatePriorityIndex(torpedoCandidate, priorityList);
    const swarmIdx = getCandidatePriorityIndex(swarmCandidate, priorityList);
    
    assert.strictEqual(torpedoIdx, 0, "Torpedo subtype matches priority index 0");
    assert.strictEqual(swarmIdx, 2, "Swarm missile subtype matches priority index 2");
    assert.ok(torpedoIdx < swarmIdx, "Torpedo is prioritized over swarm missile");
    console.log("✔ Test 2 passed: Torpedo subtype is correctly matched in priority list with swarmMissile.");
  }

  // Test 3: Point Defense respects subtype when no subtype-specific priority exists
  {
    const { getCandidatePriorityIndex } = require("../src/server/combat");
    const priorityList = ["torpedo", "missile", "projectile", "ship"];
    
    const missileNoSubtype = { type: "projectile", entity: { type: "missile" } };
    const genericProjectile = { type: "projectile", entity: { type: "rail" } };
    
    const missileIdx = getCandidatePriorityIndex(missileNoSubtype, priorityList);
    const genericIdx = getCandidatePriorityIndex(genericProjectile, priorityList);
    
    assert.strictEqual(missileIdx, 1, "Missile without subtype falls back to 'missile' priority");
    assert.strictEqual(genericIdx, 2, "Generic projectile falls back to 'projectile' priority");
    assert.ok(missileIdx < genericIdx, "Missile is prioritized over generic projectile");
    console.log("✔ Test 3 passed: Point Defense respects subtype when no subtype-specific priority exists.");
  }

  console.log("\nAll 3 Torpedo Point Defence Priority Tests Passed Successfully!");
})();
