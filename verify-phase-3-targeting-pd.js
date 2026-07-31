"use strict";
const assert = require("assert");

let testShipCounter = 0;

(async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;

  const { PARTS } = require("./src/server/components");
  const { computeStats } = require("./src/server/shipStats");
  const { validateDesign } = require("./src/server/shipDesign");
  const { initComponentState } = require("./src/server/componentHealth");
  const { reallocateShipPower } = require("./src/server/componentPower");
  const { findPointDefenseTarget } = require("./src/server/combat");
  const PerformanceFlags = require("./src/server/performanceFlags");
  const TargetingEligibility = require("./src/server/targetingEligibility");
  const TargetingCadence = require("./src/server/targetingCadence");
  const TargetingTelemetry = require("./src/server/targetingTelemetry");
  const RoomTelemetry = require("./src/server/roomTelemetry");
  const PointDefenceThreats = require("./src/server/pointDefenceThreats");
  const WiringRules = require("./public/src/shared/wiringRules");

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
      id: `test-ship-${(testShipCounter += 1)}`,
      ownerId,
      team: ownerId === "p1" ? "A" : "B",
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
    ship.weaponAngles = ship.design.map(() => 0);
    ship.weaponCooldowns = ship.design.map(() => 0);
    ship.weaponDesiredAngles = ship.design.map(() => 0);
    ship.weaponAimTargetIds = ship.design.map(() => null);
    ship.weaponFireTargetIds = ship.design.map(() => null);
    return ship;
  }

  function makeRoom(ships = []) {
    const shipMap = new Map();
    const playerMap = new Map([
      ["p1", { id: "p1", name: "Player 1", team: "A" }],
      ["p2", { id: "p2", name: "Player 2", team: "B" }]
    ]);
    for (const ship of ships) {
      shipMap.set(ship.id, ship);
      const owner = playerMap.get(ship.ownerId);
      if (owner) owner.ships = (owner.ships || []).concat(ship.id);
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
      map: { asteroids: [], safeZones: [] },
      rules: { gameMode: "solo" },
      world: { width: 4000, height: 4000 }
    };
  }

  console.log("Starting Phase 3 Targeting & Point Defence Verification...\n");

  // 1. All Phase 3 feature flags default to false.
  {
    assert.strictEqual(PerformanceFlags.WEAPON_TARGET_ACQUISITION_CADENCE(), false, "WEAPON_TARGET_ACQUISITION_CADENCE defaults false");
    assert.strictEqual(PerformanceFlags.POINT_DEFENCE_SHARED_THREATS(), false, "POINT_DEFENCE_SHARED_THREATS defaults false");
    assert.strictEqual(PerformanceFlags.WEAPON_PROFILE_REVISION_CACHE(), false, "WEAPON_PROFILE_REVISION_CACHE defaults false");
    console.log("✔ Test 1 passed: Phase 3 flags default false and Phase Two defaults are untouched.");
  }

  // 2. Target eligibility helpers mirror current rules.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }]);
    const enemy = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([ship, enemy]);
    const now = 0;

    assert.strictEqual(
      TargetingEligibility.isOrdinaryWeaponTargetValid(room, ship, enemy, now, 500, { originX: ship.x, originY: ship.y }),
      true,
      "Ordinary target is valid"
    );
    assert.strictEqual(
      TargetingEligibility.isOrdinaryWeaponTargetValid(room, ship, ship, now, 500, { originX: ship.x, originY: ship.y }),
      false,
      "Self target is rejected"
    );

    enemy.alive = false;
    assert.strictEqual(
      TargetingEligibility.isOrdinaryWeaponTargetValid(room, ship, enemy, now, 500, { originX: ship.x, originY: ship.y }),
      false,
      "Destroyed target is rejected"
    );
    enemy.alive = true;

    console.log("✔ Test 2 passed: isOrdinaryWeaponTargetValid preserves basic validity rules.");
  }

  // 3. Point Defence candidate ordering and tie-breaking is stable.
  {
    const a = { type: "projectile", entity: { id: "a" } };
    const b = { type: "projectile", entity: { id: "b" } };
    const priority = ["projectile"];
    assert.strictEqual(
      TargetingEligibility.isCandidateBetter(a, 100, null, Infinity, priority, null, null, null),
      true,
      "First candidate wins against null"
    );
    assert.strictEqual(
      TargetingEligibility.isCandidateBetter(b, 100, a, 100, priority, null, null, null),
      false,
      "Stable id tie-breaks equal candidates"
    );
    console.log("✔ Test 3 passed: Point Defence candidate comparison is stable.");
  }

  // 4. Shared PD threat sets select the same target as the legacy path.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([pdShip, enemyShip]);

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 150, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    const legacy = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);

    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(true);
    PointDefenceThreats.invalidatePointDefenceThreatSet(pdShip);
    const shared = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);
    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(false);
    PointDefenceThreats.invalidatePointDefenceThreatSet(pdShip);

    assert.strictEqual(legacy && legacy.entity && legacy.entity.id, missile.id, "Legacy path picks the missile");
    assert.strictEqual(shared && shared.entity && shared.entity.id, missile.id, "Shared threat path picks the same missile");
    console.log("✔ Test 4 passed: Shared PD threat set matches legacy selection.");
  }

  // 5. A removed projectile is not fired upon after threat-set construction.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);

    const missile = { id: "m2", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 150, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(true);
    const threatSet = PointDefenceThreats.ensurePointDefenceThreatSet(room, pdShip, "p1", 0);

    // Simulate the missile being destroyed after the set was built.
    missile.life = 0;
    const selected = PointDefenceThreats.selectPointDefenceTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, pdShip.id, 0, threatSet);

    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(false);

    assert.strictEqual(selected, null, "Destroyed projectile in shared set is not selected");
    console.log("✔ Test 5 passed: Shared set candidates are revalidated before selection.");
  }

  // 6. Acquisition cadence is deterministic and staggered.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }]);
    const now = 1000;
    const t1 = TargetingCadence.nextAcquisitionAt(ship, "ordinaryShip", 0, now);
    const t2 = TargetingCadence.nextAcquisitionAt(ship, "ordinaryShip", 1, now);
    assert.ok(t1 > now && t1 <= now + 125, "First cadence bucket is within the 8 Hz interval");
    assert.ok(t2 > now && t2 <= now + 125, "Second cadence bucket is within the 8 Hz interval");
    assert.notStrictEqual(t1, t2, "Different weapon indices are staggered");

    // A full interval later, the absolute phase recurs.
    const t1Next = TargetingCadence.nextAcquisitionAt(ship, "ordinaryShip", 0, t1);
    assert.strictEqual(t1Next - t1, 125, "Cadence recurs at a stable 125 ms interval");
    console.log("✔ Test 6 passed: Acquisition cadence is deterministic and staggered.");
  }

  // 7. Telemetry counters are registered in room telemetry.
  {
    const room = makeRoom([]);
    RoomTelemetry.resetRoomTelemetry(room);
    TargetingTelemetry.bump(room, "ordinaryTargetSearches");
    TargetingTelemetry.bump(room, "pointDefenceThreatSetBuilds", 3);
    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.strictEqual(t.ordinaryTargetSearches, 1, "ordinaryTargetSearches counter bumped");
    assert.strictEqual(t.pointDefenceThreatSetBuilds, 3, "pointDefenceThreatSetBuilds counter bumped");
    console.log("✔ Test 7 passed: Targeting telemetry counters are wired.");
  }

  // 8. Effective weapon profile cache is revision-based and invalidated on component destruction.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "blaster" }, { x: 7, y: 8, type: "engine" }]);
    const ComponentData = require("./src/server/componentData");
    const cache1 = ComponentData.ensureEffectiveWeaponProfileCache(ship);
    assert.ok(cache1.revision >= 1, "Profile cache has a revision");
    assert.ok(cache1.signature, "Profile cache has a signature");

    const cache2 = ComponentData.ensureEffectiveWeaponProfileCache(ship);
    assert.strictEqual(cache2.revision, cache1.revision, "Unchanged inputs keep the same cache revision");

    ship.componentHp[1] = 0;
    ship.componentAliveRevision = (ship.componentAliveRevision || 1) + 1;
    const cache3 = ComponentData.ensureEffectiveWeaponProfileCache(ship);
    assert.ok(cache3.revision > cache2.revision, "Destroyed component invalidates the profile cache");
    console.log("✔ Test 8 passed: Effective weapon profile cache is revision-based and invalidates on component destruction.");
  }

  // 9. Shared PD rejects unsupported target categories.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);
    const missile = { id: "m-priority", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 120, y: 100, life: 5, interceptable: true, hp: 20 };
    const decoy = { id: "d-priority", type: "decoy", ownerId: "p2", x: 110, y: 100, expiresAt: Infinity };
    room.bullets.push(missile, decoy);

    pdShip._pdThreatSet = null;
    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(false);
    const legacy = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [], pdShip.id, 0);
    pdShip._pdThreatSet = null;
    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(true);
    const shared = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [], pdShip.id, 0);
    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(false);

    assert.ok(legacy, "Legacy path finds a missile");
    assert.strictEqual(shared && shared.entity.id, missile.id, "Shared path also selects the supported missile");
    console.log("✔ Test 9 passed: Shared PD rejects unsupported target categories.");
  }

  // 10. Shared PD works with room.ships as a Map (no spatial index).
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemy = makeTestShip([{ x: 7, y: 7, type: "core" }], null, "p2");
    enemy.x = 120;
    enemy.y = 100;
    enemy.alive = true;
    const room = makeRoom([pdShip, enemy]);
    const weapon = { ...PARTS.pointDefense.weapon, targetPriority: ["ship"] };

    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(true);
    const selected = findPointDefenseTarget(room, 100, 100, "p1", weapon, [], pdShip.id, 0);
    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(false);

    assert.ok(selected, "Shared path finds the enemy ship from the Map fallback");
    assert.strictEqual(selected.entity.id, enemy.id, "Selected entity is a ship, not a [id, ship] pair");
    console.log("✔ Test 10 passed: Shared PD handles room.ships Map fallback.");
  }

  // 11. Shared PD does not fall through to a second legacy scan.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);
    const t0 = RoomTelemetry.resetRoomTelemetry(room);

    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(true);
    const selected = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [], pdShip.id, 0);
    PerformanceFlags.__setPOINT_DEFENCE_SHARED_THREATS(false);

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.strictEqual(selected, null, "Empty shared set returns null");
    assert.strictEqual(t.pointDefenceLegacyScansAvoided, 1, "Legacy scan is avoided when the shared set is valid");
    console.log("✔ Test 11 passed: Shared PD does not fall through to a second legacy scan.");
  }

  // 12. Room reset clears all Phase 3 caches.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);
    const PointDefenceThreats = require("./src/server/pointDefenceThreats");
    PointDefenceThreats.ensurePointDefenceThreatSet(room, pdShip, "p1", 0);
    pdShip._targetAcquisitionSchedule = { "ordinaryShip:0_start": 0 };
    pdShip._weaponTargetState = [{ id: "x" }];
    pdShip.effectiveWeaponProfileCache = { revision: 1 };

    require("./src/server/rooms").bumpStateEpoch(room, "test");

    assert.strictEqual(pdShip._pdThreatSet, null, "PD threat set cleared after state epoch");
    assert.strictEqual(pdShip._targetAcquisitionSchedule, null, "Target acquisition schedule cleared");
    assert.strictEqual(pdShip._weaponTargetState, null, "Weapon target state cleared");
    assert.strictEqual(pdShip.effectiveWeaponProfileCache, null, "Effective profile cache cleared");
    console.log("✔ Test 12 passed: Room reset clears all Phase 3 caches.");
  }

  console.log("\nPhase 3 Targeting & Point Defence verification passed.");
})();
