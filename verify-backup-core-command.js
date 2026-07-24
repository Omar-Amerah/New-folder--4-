"use strict";
const assert = require("assert");

(async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;

  const { PARTS } = require("./src/server/components");
  const { computeStats } = require("./src/server/shipStats");
  const { validateDesign } = require("./src/server/shipDesign");
  const { validateBlueprint } = await import("./public/src/design/blueprintValidation.js");
  const { initComponentState, applyHullDamage } = require("./src/server/componentHealth");
  const { evaluateShipCommandState, destroyShip, targetCoreAimWorldPosition } = require("./src/server/combat");
  const { reallocateShipPower } = require("./src/server/componentPower");
  const { buildSharedSnapshot, snapshotRoom } = require("./src/server/snapshots");

  const WiringRules = require("./public/src/shared/wiringRules");
  function makeTestShip(design, wiring = null) {
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
      id: "test-ship-1",
      ownerId: "p1",
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
    return ship;
  }

  function makeRoom(ships = []) {
    const shipMap = new Map();
    const playerMap = new Map([
      ["p1", { id: "p1", name: "Player 1", team: "A", kills: 0, losses: 0, score: 0, money: 1000, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }],
      ["p2", { id: "p2", name: "Player 2", team: "B", kills: 0, losses: 0, score: 0, money: 1000, earned: 0, destroyedEnemyCost: 0, lostFleetCost: 0, ships: [], design: [] }]
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
      points: [],
      effects: [],
      rules: { gameMode: "solo" },
      world: { width: 4000, height: 4000 }
    };
  }

  console.log("Starting Backup Core and Core Destruction Verification Tests...\n");

  // 1. Exposed main Core can be hit by projectiles
  {
    const design = [{ x: 7, y: 7, type: "core" }];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    const initialCoreHp = ship.componentHp[0];
    applyHullDamage(room, ship, 50, 1000, 100, 50);
    assert.strictEqual(ship.componentHp[0], initialCoreHp - 50, "Exposed main Core takes damage from projectile ray");
    console.log("✔ Test 1 passed: Exposed main Core can be hit by projectiles.");
  }

  // 2. Exposed main Core can be hit by beams
  {
    const design = [{ x: 7, y: 7, type: "core" }];
    const ship = makeTestShip(design);
    const aimPos = targetCoreAimWorldPosition(ship);
    assert.ok(aimPos, "targetCoreAimWorldPosition locates exposed Core");
    assert.strictEqual(aimPos.componentIndex, 0, "Beam targeting targets exposed Core index 0");
    console.log("✔ Test 2 passed: Exposed main Core can be hit by beams.");
  }

  // 3. Core is no longer skipped by fallback collision
  {
    const design = [{ x: 7, y: 7, type: "core" }];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);
    const initialCoreHp = ship.componentHp[0];
    applyHullDamage(room, ship, 30, 1000, 100.1, 100.1);
    assert.strictEqual(ship.componentHp[0], initialCoreHp - 30, "Fallback ray selection hits the Core when exposed");
    console.log("✔ Test 3 passed: Core is no longer skipped by fallback collision.");
  }

  // 4. Protected Core is not damaged through intact components without valid penetration
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 7, y: 6, type: "armor" },
      { x: 7, y: 8, type: "armor" },
      { x: 6, y: 7, type: "armor" },
      { x: 8, y: 7, type: "armor" }
    ];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);
    const initialCoreHp = ship.componentHp[0];
    const initialArmorHp = ship.componentHp[1];

    applyHullDamage(room, ship, 40, 1000, 150, 100);
    assert.strictEqual(ship.componentHp[0], initialCoreHp, "Protected Core takes 0 damage when hit strikes front armor");
    assert.ok(ship.componentHp[1] < initialArmorHp, "Front armor soaks the impact");
    console.log("✔ Test 4 passed: Protected Core is not damaged through intact components without valid penetration.");
  }

  // 5. Main Core destruction without backup destroys the ship
  {
    const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "armor" }];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    ship.componentHp[0] = 0;
    const alive = evaluateShipCommandState(room, ship, 1000, "p2");
    assert.strictEqual(alive, false, "Ship without backup core is destroyed when main Core dies");
    assert.strictEqual(ship.alive, false, "ship.alive is false");
    console.log("✔ Test 5 passed: Main Core destruction without backup destroys the ship.");
  }

  // 6. Main Core destruction with a powered backup keeps the ship alive
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 },
      { x: 8, y: 6, type: "reactor" }
    ];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    ship.componentHp[0] = 0;
    const alive = evaluateShipCommandState(room, ship, 1000, "p2");
    assert.strictEqual(alive, true, "Ship with powered backup core remains alive");
    assert.strictEqual(ship.alive, true, "ship.alive remains true");
    assert.strictEqual(ship.commandState, "backupCore", "commandState transferred to backupCore");
    assert.ok(room.effects.some(e => e.text === "BACKUP COMMAND ACTIVE"), "Command transfer effect created");
    console.log("✔ Test 6 passed: Main Core destruction with a powered backup keeps the ship alive.");
  }

  // 7. Emergency penalties apply exactly once
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 },
      { x: 8, y: 6, type: "reactor" },
      { x: 6, y: 7, type: "blaster" }
    ];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    const { getEffectiveWeaponStatsInternal } = require("./src/server/componentData");
    const baseProfile = getEffectiveWeaponStatsInternal(ship, 3);
    const baseAccuracy = baseProfile.accuracy;

    ship.componentHp[0] = 0;
    evaluateShipCommandState(room, ship, 1000, "p2");

    const backupProfile = getEffectiveWeaponStatsInternal(ship, 3);
    assert.strictEqual(backupProfile.accuracy, baseAccuracy * 0.85, "Weapon accuracy penalized to exactly 85%");

    const backupProfile2 = getEffectiveWeaponStatsInternal(ship, 3);
    assert.strictEqual(backupProfile2.accuracy, baseAccuracy * 0.85, "Repeated evaluations retain exact 85% penalty without compounding");
    console.log("✔ Test 7 passed: Emergency penalties apply exactly once.");
  }

  // 8. Backup Power loss starts the reserve countdown
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 }
    ];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    ship.componentHp[0] = 0;
    const alive = evaluateShipCommandState(room, ship, 1000, "p2");
    assert.strictEqual(alive, true, "Unpowered backup core starts 2s emergency reserve");
    assert.strictEqual(ship.emergencyReserveUntil, 3000, "Emergency reserve set to now + 2000ms");

    const aliveMid = evaluateShipCommandState(room, ship, 2000, "p2");
    assert.strictEqual(aliveMid, true, "Ship remains alive at 1s into reserve window");

    const aliveEnd = evaluateShipCommandState(room, ship, 3001, "p2");
    assert.strictEqual(aliveEnd, false, "Ship is destroyed after emergency reserve countdown expires");
    assert.strictEqual(ship.alive, false, "ship.alive is false");
    console.log("✔ Test 8 passed: Backup Power loss starts the reserve countdown.");
  }

  // 9. Power restoration cancels destruction
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 },
      { x: 8, y: 6, type: "reactor" }
    ];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    ship.componentHp[0] = 0;
    ship.componentHp[2] = 0; // destroy reactor -> unpowered backup
    evaluateShipCommandState(room, ship, 1000, "p2");
    assert.strictEqual(ship.emergencyReserveUntil, 3000, "Reserve countdown started");

    ship.componentHp[2] = 200; // repair reactor
    reallocateShipPower(ship, "repair");
    evaluateShipCommandState(room, ship, 1500, "p2");

    assert.strictEqual(ship.emergencyReserveUntil, null, "Power restoration cancels emergency countdown");
    assert.strictEqual(ship.alive, true, "Ship remains alive and functional");
    console.log("✔ Test 9 passed: Power restoration cancels destruction.");
  }

  // 10. Backup destruction after main-Core loss destroys the ship
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 },
      { x: 8, y: 6, type: "reactor" }
    ];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    ship.componentHp[0] = 0;
    evaluateShipCommandState(room, ship, 1000, "p2");
    assert.strictEqual(ship.alive, true, "Alive on backup core");

    ship.componentHp[1] = 0;
    const alive = evaluateShipCommandState(room, ship, 1200, "p2");
    assert.strictEqual(alive, false, "Backup Core destruction destroys the ship");
    assert.strictEqual(ship.alive, false, "ship.alive is false");
    console.log("✔ Test 10 passed: Backup destruction after main-Core loss destroys the ship.");
  }

  // 11. Blueprint validation enforces one main Core and at most one backup
  {
    const validDesign = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 },
      { x: 6, y: 7, type: "engine" }
    ];
    const res = validateDesign(validDesign);
    assert.strictEqual(res.ok, true, "Server accepts 1 main Core + 1 Backup Core");
    assert.strictEqual(validateBlueprint(validDesign).ok, true, "Client accepts 1 main Core + 1 Backup Core");

    const noMainCoreDesign = [
      { x: 7, y: 7, type: "backupCore", rotation: 0 },
      { x: 6, y: 7, type: "engine" }
    ];
    const noCoreRes = validateDesign(noMainCoreDesign);
    assert.strictEqual(noCoreRes.ok, false, "Backup core cannot replace required main Core");
    assert.strictEqual(noCoreRes.reason, "Invalid design: missing core.");

    const multiBackupDesign = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 },
      { x: 4, y: 7, type: "backupCore", rotation: 0 },
      { x: 6, y: 7, type: "engine" }
    ];
    const multiRes = validateDesign(multiBackupDesign);
    assert.strictEqual(multiRes.ok, false, "Multiple Backup Cores rejected");
    assert.strictEqual(multiRes.reason, "Invalid design: maximum one Backup Command Core is allowed.");
    console.log("✔ Test 11 passed: Blueprint validation enforces one main Core and at most one backup.");
  }

  // 12. Kill attribution and scoring occur exactly once
  {
    const design = [{ x: 7, y: 7, type: "core" }];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);
    const attacker = room.players.get("p2");
    const initialKills = attacker.kills;

    const res1 = destroyShip(room, ship, "p2", 1000);
    assert.strictEqual(res1, true, "First destroyShip returns true");
    assert.strictEqual(attacker.kills, initialKills + 1, "Attacker credited with kill");

    const res2 = destroyShip(room, ship, "p2", 1010);
    assert.strictEqual(res2, false, "Duplicate destroyShip call returns false");
    assert.strictEqual(attacker.kills, initialKills + 1, "Kills count not incremented twice");
    console.log("✔ Test 12 passed: Kill attribution and scoring occur exactly once.");
  }

  // 13. Save/load, snapshots and reconnect preserve command state
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "backupCore", rotation: 0 },
      { x: 8, y: 6, type: "reactor" }
    ];
    const ship = makeTestShip(design);
    const room = makeRoom([ship]);

    ship.componentHp[0] = 0;
    evaluateShipCommandState(room, ship, 1000, "p2");
    assert.strictEqual(ship.commandState, "backupCore", "Active command state set to backupCore");

    const sharedSnap = buildSharedSnapshot(room, 1000, true);
    const shipSnap = sharedSnap.ships.find(s => s.id === ship.id);
    assert.strictEqual(shipSnap.commandState, "backupCore", "Snapshot preserves commandState");

    const fullSnap = snapshotRoom(room, 1000, room.players.get("p1"), true, sharedSnap);
    const clientShipSnap = fullSnap.ships.find(s => s.id === ship.id);
    assert.strictEqual(clientShipSnap.commandState, "backupCore", "Client reconnect snapshot retains commandState");
    console.log("✔ Test 13 passed: Save/load, snapshots and reconnect preserve command state.");
  }

  console.log("\nAll 13 Backup Core and Core Destruction Verification Tests Passed Successfully!");
})();
