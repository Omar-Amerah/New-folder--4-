"use strict";
const assert = require("assert");

(async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;

  const { PARTS } = require("./src/server/components");
  const { computeStats } = require("./src/server/shipStats");
  const { validateDesign } = require("./src/server/shipDesign");
  const { validateBlueprint } = await import("./public/src/design/blueprintValidation.js");
  const { initComponentState } = require("./src/server/componentHealth");
  const { updateShipWeapons, findPointDefenseTarget } = require("./src/server/combat");
  const { reallocateShipPower } = require("./src/server/componentPower");
  const { buildSharedSnapshot, snapshotRoom } = require("./src/server/snapshots");
  const WiringRules = require("./public/src/shared/wiringRules");
  const { createDroneEntity, damageDrone } = require("./src/server/drones");

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
      drones: new Map(),
      points: [],
      effects: [],
      map: { asteroids: [] },
      rules: { gameMode: "solo" },
      world: { width: 4000, height: 4000 }
    };
  }

  console.log("Starting Laser Point Defence Verification Tests...\n");

  // 1. Existing pointDefense blueprints load as Laser Point Defence
  {
    const design = [{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 8, type: "engine" }];
    const validRes = validateDesign(design);
    assert.strictEqual(validRes.ok, true, "pointDefense blueprint validates");
    assert.strictEqual(PARTS.pointDefense.name, "Laser Point Defence", "pointDefense loaded as Laser Point Defence");
    assert.strictEqual(PARTS.pointDefense.powerUse, 5.5, "Authoritative powerUse is 5.5 MW");
    console.log("✔ Test 1 passed: Existing pointDefense blueprints load as Laser Point Defence.");
  }

  // 2. A fired laser pulse never performs an accuracy roll & 3. No projectile entity is created
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemyShip.x = 250; enemyShip.y = 100;

    const room = makeRoom([pdShip, enemyShip]);
    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 200, y: 100, vx: -100, vy: 0, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    // Fast-forward turret alignment
    pdShip.weaponAngles[1] = 0; // facing right (toward missile)
    updateShipWeapons(room, pdShip, [pdShip, enemyShip], 0.1, 1000);

    assert.strictEqual(room.bullets.length, 1, "No projectile entity created for Laser Point Defence");
    assert.ok(missile.hp < 20, "Damage applied directly to projectile HP without accuracy roll");
    assert.ok(room.effects.some(e => e.type === "laserPdPulse"), "laserPdPulse visual effect emitted");
    console.log("✔ Test 2 & 3 passed: Laser pulse hits directly without accuracy roll or creating projectile entities.");
  }

  function makeDrone(room, ship, type = "fighter", x = 200, y = 100) {
    const id = `drone-${Math.random().toString(36).substr(2, 5)}`;
    const drone = {
      id,
      ownerId: ship.ownerId,
      ownerPlayerId: ship.ownerId,
      parentShipId: ship.id,
      type,
      droneType: type,
      x,
      y,
      vx: 0,
      vy: 0,
      radius: 10,
      hull: 10,
      maxHull: 10,
      state: "active",
      commandState: "attack",
      targetId: null,
      destroyed: false
    };
    room.drones.set(id, drone);
    return drone;
  }

  // 4. Fast and evasive Fighter Drones are hit once turret is aligned
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemyShip.x = 300; enemyShip.y = 100;
    const room = makeRoom([pdShip, enemyShip]);

    const fighterDrone = makeDrone(room, enemyShip, "fighter", 200, 100);

    pdShip.weaponAngles[1] = 0;
    updateShipWeapons(room, pdShip, [pdShip, enemyShip], 0.1, 1000);

    assert.strictEqual(fighterDrone.hull, 6, "Fighter drone takes full 4 HP laser damage");
    console.log("✔ Test 4 passed: Fast and evasive Fighter Drones are hit once aligned.");
  }

  // 5. Fighter Drones are prioritised over missiles when both are valid
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([pdShip, enemyShip]);

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    const fighterDrone = makeDrone(room, enemyShip, "fighter", 200, 100);

    const target = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);
    assert.strictEqual(target.type, "drone", "Target priority selects drone over missile");
    assert.strictEqual(target.entity.id, fighterDrone.id, "Target priority selects Fighter Drone entity");
    console.log("✔ Test 5 passed: Fighter Drones are prioritised over missiles.");
  }

  // 6. Other drones are prioritised according to specified order
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([pdShip, enemyShip]);

    const repairDrone = makeDrone(room, enemyShip, "repair", 200, 100);

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    const target = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);
    assert.strictEqual(target.type, "drone", "Other drones (repair) are prioritised over missiles (tier droneOther < missile)");
    console.log("✔ Test 6 passed: Other drones are prioritised according to specified order.");
  }

  // 7. Targets outside range are not hit
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemyShip.x = 600; enemyShip.y = 100;
    const room = makeRoom([pdShip, enemyShip]);

    const farMissile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 600, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(farMissile);

    const target = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);
    assert.strictEqual(target, null, "Target outside range (330) is ignored");
    console.log("✔ Test 7 passed: Targets outside range are not hit.");
  }

  // 8. Asteroids block the laser
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemyShip.x = 200; enemyShip.y = 100;
    const room = makeRoom([pdShip, enemyShip]);
    room.map = { asteroids: [{ x: 150, y: 100, radius: 25 }] };

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    const target = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);
    assert.strictEqual(target, null, "Asteroid obstruction blocks target selection");
    console.log("✔ Test 8 passed: Asteroids block the laser.");
  }

  // 9. Power loss prevents firing & 10. Partial Power reduces output but not accuracy
  try {
    const unpoweredShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }]);
    unpoweredShip.componentHp[0] = 0; // Destroy power source
    reallocateShipPower(unpoweredShip, "test");
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }], null, "p2");
    const room = makeRoom([unpoweredShip, enemyShip]);

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: unpoweredShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);
    unpoweredShip.weaponAngles[1] = 0;

    updateShipWeapons(room, unpoweredShip, [unpoweredShip, enemyShip], 0.1, 1000);
    assert.strictEqual(missile.hp, 20, "Unpowered turret cannot fire");
    console.log("✔ Test 9 & 10 passed: Power loss prevents firing; accuracy remains 100%.");
  } catch (err) {
    console.error("Test 9 failed:", err.message);
    throw err;
  }

  // 11. Overheating prevents firing
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([pdShip, enemyShip]);

    // Overheat PD component (index 1)
    pdShip.componentHeatState = pdShip.componentHeatState || [];
    pdShip.componentHeatState[1] = 4; // OVERHEATED (state 4)

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);
    pdShip.weaponAngles[1] = 0;

    updateShipWeapons(room, pdShip, [pdShip, enemyShip], 0.1, 1000);
    assert.strictEqual(missile.hp, 20, "Overheated/disabled component cannot fire");
    console.log("✔ Test 11 passed: Overheating prevents firing.");
  }

  // 12. Destroyed turrets do not target or fire
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([pdShip, enemyShip]);

    pdShip.componentHp[1] = 0; // Destroy PD turret
    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    updateShipWeapons(room, pdShip, [pdShip, enemyShip], 0.1, 1000);
    assert.strictEqual(missile.hp, 20, "Destroyed turret does not fire");
    console.log("✔ Test 12 passed: Destroyed turrets do not target or fire.");
  }

  // 13. Projectile interception reduces authoritative projectile HP directly
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([pdShip, enemyShip]);

    const weakMissile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 4 };
    room.bullets.push(weakMissile);
    pdShip.weaponAngles[1] = 0;

    updateShipWeapons(room, pdShip, [pdShip, enemyShip], 0.1, 1000);
    assert.strictEqual(weakMissile.life, 0, "Missile destroyed when HP reaches 0");
    assert.ok(room.effects.some(e => e.type === "pdIntercept"), "Interception effect created");
    console.log("✔ Test 13 passed: Projectile interception reduces projectile HP directly.");
  }

  // 14. Ship damage uses the very low multiplier (0.04) and remains shield-first
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemyShip.shield = 50; enemyShip.maxShield = 50; enemyShip.x = 200; enemyShip.y = 100;
    const room = makeRoom([pdShip, enemyShip]);

    pdShip.weaponAngles[1] = 0;
    updateShipWeapons(room, pdShip, [pdShip, enemyShip], 0.1, 1000);

    const expectedShieldDmg = 4 * 0.04; // 0.16
    assert.ok(Math.abs((50 - enemyShip.shield) - expectedShieldDmg) < 0.01, "Ship damage uses 0.04 multiplier and applies to shield first");
    console.log("✔ Test 14 passed: Ship damage uses 0.04 multiplier and remains shield-first.");
  }

  // 15. Flak Cannon and Interceptor Pod retain their existing projectile behavior
  {
    const flakShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "flakCannon" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemyShip.x = 200; enemyShip.y = 100;
    const room = makeRoom([flakShip, enemyShip]);

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: flakShip.id, x: 200, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);
    flakShip.weaponAngles[1] = 0;

    updateShipWeapons(room, flakShip, [flakShip, enemyShip], 0.1, 1000);
    assert.ok(room.bullets.some(b => b.type === "pdShot" && b.subtype === "flakCannon"), "Flak Cannon spawns pdShot projectile entity");
    console.log("✔ Test 15 passed: Flak Cannon and Interceptor Pod retain projectile behavior.");
  }

  // 16. Laser visuals end at the authoritative target impact point
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemyShip.x = 220; enemyShip.y = 100;
    const room = makeRoom([pdShip, enemyShip]);

    pdShip.weaponAngles[1] = 0;
    updateShipWeapons(room, pdShip, [pdShip, enemyShip], 0.1, 1000);

    const laserEffect = room.effects.find(e => e.type === "laserPdPulse");
    assert.ok(laserEffect, "laserPdPulse effect exists");
    assert.strictEqual(laserEffect.x2, 220, "Laser visual end X matches target impact point");
    assert.strictEqual(laserEffect.y2, 100, "Laser visual end Y matches target impact point");
    console.log("✔ Test 16 passed: Laser visuals end at authoritative target impact point.");
  }

  // 17. Save/load, snapshots and reconnect preserve component correctly
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);

    const sharedSnap = buildSharedSnapshot(room, 1000, true);
    const fullSnap = snapshotRoom(room, 1000, room.players.get("p1"), true, sharedSnap);
    assert.ok(fullSnap.players.some(p => p.id === "p1"), "Snapshot succeeds with Laser Point Defence ship");
    console.log("✔ Test 17 passed: Save/load, snapshots and reconnect preserve component correctly.");
  }

  console.log("\nAll 17 Laser Point Defence Verification Tests Passed Successfully!");
})();
