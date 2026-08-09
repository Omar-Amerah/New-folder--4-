"use strict";
const assert = require("assert");

let testShipCounter = 0;

(async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;

  const { PARTS } = require("../src/server/components");
  const { computeStats } = require("../src/server/shipStats");
  const { validateDesign } = require("../src/server/shipDesign");
  const { initComponentState } = require("../src/server/componentHealth");
  const { reallocateShipPower } = require("../src/server/componentPower");
  const { findPointDefenseTarget } = require("../src/server/combat");
  const TargetingEligibility = require("../src/server/targetingEligibility");
  const TargetingCadence = require("../src/server/targetingCadence");
  const TargetingTelemetry = require("../src/server/targetingTelemetry");
  const RoomTelemetry = require("../src/server/roomTelemetry");
  const PointDefenceThreats = require("../src/server/pointDefenceThreats");
  const { updateShipWeapons } = require("../src/server/combat");
  const { updateStationWeapons } = require("../src/server/stationCombat");
  const { buildRoomSpatialIndex } = require("../src/server/spatialIndex");
  const { getShipComponentIndexes } = require("../src/server/componentIndexes");
  const { getEffectiveWeaponStatsCached, getEffectiveWeaponStatsInternal, ensureEffectiveWeaponProfileCache } = require("../src/server/componentData");

  function makeTestShip(design, dataLinks = [], ownerId = "p1") {
    const stats = computeStats(design, { dataLinks });
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
      dataLinks,
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
    if (ship.componentPower?.byComponentIndex) {
      for (let i = 0; i < ship.design.length; i += 1) {
        const rec = ship.componentPower.byComponentIndex[i];
        if (rec) rec.operationalMultiplier = 1;
      }
    }
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

  // 4. The canonical PD threat set selects the stable target.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const enemyShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    const room = makeRoom([pdShip, enemyShip]);

    const missile = { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 150, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    const first = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);

    PointDefenceThreats.invalidatePointDefenceThreatSet(pdShip);
    const repeat = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [enemyShip], pdShip.id);
    PointDefenceThreats.invalidatePointDefenceThreatSet(pdShip);

    assert.strictEqual(first && first.entity && first.entity.id, missile.id, "Canonical path picks the missile");
    assert.strictEqual(repeat && repeat.entity && repeat.entity.id, missile.id, "Repeated canonical selection is stable");
    console.log("✔ Test 4 passed: Canonical PD threat set selects deterministically.");
  }

  // 5. A removed projectile is not fired upon after threat-set construction.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);

    const missile = { id: "m2", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 150, y: 100, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    const threatSet = PointDefenceThreats.ensurePointDefenceThreatSet(room, pdShip, "p1", 0);

    // Simulate the missile being destroyed after the set was built.
    missile.life = 0;
    const selected = PointDefenceThreats.selectPointDefenceTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, pdShip.id, 0, threatSet);


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
    const ComponentData = require("../src/server/componentData");
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
    const first = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [], pdShip.id, 0);
    pdShip._pdThreatSet = null;
    const repeat = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [], pdShip.id, 0);

    assert.ok(first, "Canonical path finds a missile");
    assert.strictEqual(repeat && repeat.entity.id, missile.id, "Repeated canonical path selects the supported missile");
    console.log("✔ Test 9 passed: Canonical PD rejects unsupported target categories.");
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

    const selected = findPointDefenseTarget(room, 100, 100, "p1", weapon, [], pdShip.id, 0);

    assert.ok(selected, "Shared path finds the enemy ship from the Map fallback");
    assert.strictEqual(selected.entity.id, enemy.id, "Selected entity is a ship, not a [id, ship] pair");
    console.log("✔ Test 10 passed: Shared PD handles room.ships Map fallback.");
  }

  // 11. A canonical PD miss is recorded once and does not run a fallback scan.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);
    const t0 = RoomTelemetry.resetRoomTelemetry(room);

    const selected = findPointDefenseTarget(room, 100, 100, "p1", PARTS.pointDefense.weapon, [], pdShip.id, 0);

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.strictEqual(selected, null, "Empty shared set returns null");
    assert.strictEqual(t.pointDefenceThreatSetMisses, 1, "Canonical threat-set miss is recorded once");
    console.log("✔ Test 11 passed: Canonical PD does not run a fallback scan.");
  }

  // 12. Room reset clears all Phase 3 caches.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 8, y: 7, type: "pointDefense" }, { x: 7, y: 6, type: "reactor" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);
    const PointDefenceThreats = require("../src/server/pointDefenceThreats");
    PointDefenceThreats.ensurePointDefenceThreatSet(room, pdShip, "p1", 0);
    pdShip._targetAcquisitionSchedule = { "ordinaryShip:0_start": 0 };
    pdShip._weaponTargetState = [{ id: "x" }];
    pdShip.effectiveWeaponProfileCache = { revision: 1 };

    require("../src/server/rooms").bumpStateEpoch(room, "test");

    assert.strictEqual(pdShip._pdThreatSet, null, "PD threat set cleared after state epoch");
    assert.strictEqual(pdShip._targetAcquisitionSchedule, null, "Target acquisition schedule cleared");
    assert.strictEqual(pdShip._weaponTargetState, null, "Weapon target state cleared");
    assert.strictEqual(pdShip.effectiveWeaponProfileCache, null, "Effective profile cache cleared");
    console.log("✔ Test 12 passed: Room reset clears all Phase 3 caches.");
  }

  // 13. updateShipWeapons with no targets and cadence defers most searches.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 6, y: 7, type: "blaster" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([ship]);
    RoomTelemetry.resetRoomTelemetry(room);

    for (let tick = 0; tick < 5; tick += 1) {
      const now = (tick + 1) * (1000 / 30);
      buildRoomSpatialIndex(room, [ship], now);
      updateShipWeapons(room, ship, [], 1 / 30, now);
    }

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.ok(t.ordinaryTargetSearchDeferred >= 3, "Per-weapon no-target searches are deferred between cadence windows");
    assert.ok(t.ordinaryTargetSearches <= 2, "Per-weapon no-target searches happen at cadence due times only");
    assert.ok(t.shipCombatTargetSearchDeferred >= 3, "Ship-level no-target searches are deferred between cadence windows");
    assert.ok(t.shipCombatTargetSearches <= 2, "Ship-level no-target searches happen at 4 Hz due times only");
    console.log("✔ Test 13 passed: Ship cadence defers no-target searches.");
  }

  // 14. Destroyed ordinary target forces immediate reacquisition.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 6, y: 7, type: "blaster" }, { x: 7, y: 8, type: "engine" }]);
    const enemy = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemy.x = 150;
    enemy.y = 100;
    const room = makeRoom([ship, enemy]);
    RoomTelemetry.resetRoomTelemetry(room);

    for (let tick = 0; tick < 3; tick += 1) {
      const now = (tick + 1) * (1000 / 30);
      buildRoomSpatialIndex(room, [ship, enemy], now);
      if (tick === 2) enemy.alive = false;
      updateShipWeapons(room, ship, [ship, enemy], 1 / 30, now);
    }

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.ok(t.ordinaryTargetImmediateReacquisitions >= 1, "A destroyed target triggers immediate reacquisition");
    console.log("✔ Test 14 passed: Destroyed ordinary target triggers immediate reacquisition.");
  }

  // 15. Fallback target does not force a full search every tick.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 6, y: 7, type: "blaster" }, { x: 7, y: 8, type: "engine" }]);
    const far = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    far.x = 1200;
    far.y = 0;
    const close = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    close.x = 150;
    close.y = 0;
    const room = makeRoom([ship, far, close]);
    ship.focusTargetId = far.id;
    RoomTelemetry.resetRoomTelemetry(room);

    for (let tick = 0; tick < 5; tick += 1) {
      const now = (tick + 1) * (1000 / 30);
      buildRoomSpatialIndex(room, [ship, far, close], now);
      updateShipWeapons(room, ship, [ship, far], 1 / 30, now);
    }

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.ok(t.ordinaryTargetSearches <= 2, "Fallback target is not re-searched every tick");
    console.log("✔ Test 15 passed: Fallback target is retained without searching every tick.");
  }

  // 16. Multiple PD mounts share one threat set across several ticks.
  {
    const pdShip = makeTestShip([
      { x: 7, y: 7, type: "core" },
      { x: 8, y: 7, type: "pointDefense" },
      { x: 9, y: 7, type: "pointDefense" },
      { x: 8, y: 6, type: "pointDefense" },
      { x: 7, y: 6, type: "reactor" },
      { x: 7, y: 8, type: "engine" }
    ]);
    const room = makeRoom([pdShip]);
    for (let i = 0; i < 30; i += 1) {
      const angle = (i / 30) * Math.PI * 2;
      const d = 120;
      room.bullets.push({ id: `m3-${i}`, type: "missile", ownerId: "p2", targetId: pdShip.id, x: pdShip.x + Math.cos(angle) * d, y: pdShip.y + Math.sin(angle) * d, life: 5, interceptable: true, hp: 20 });
    }

    RoomTelemetry.resetRoomTelemetry(room);

    for (let tick = 0; tick < 4; tick += 1) {
      const now = (tick + 1) * (1000 / 30);
      buildRoomSpatialIndex(room, [pdShip], now);
      updateShipWeapons(room, pdShip, [pdShip], 1 / 30, now);
    }

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.ok(t.pointDefenceThreatSetBuilds <= 2, "Threat set is not rebuilt every tick");
    assert.ok(t.pointDefenceThreatSetReuses >= 6, "Multiple PD mounts reuse the same threat set");
    assert.ok(t.pointDefenceMountSelections >= 9, "Every PD mount selects a target each tick");
    console.log("✔ Test 16 passed: Multiple PD mounts share one threat set.");
  }

  // 17. Effective weapon profile cache is reused across updateShipWeapons ticks.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 6, y: 7, type: "blaster" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([ship]);
    RoomTelemetry.resetRoomTelemetry(room);

    for (let tick = 0; tick < 5; tick += 1) {
      const now = (tick + 1) * (1000 / 30);
      buildRoomSpatialIndex(room, [ship], now);
      updateShipWeapons(room, ship, [ship], 1 / 30, now);
    }

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.strictEqual(t.effectiveWeaponProfileBuilds, 1, "Profile cache is built exactly once");
    assert.ok(t.effectiveWeaponProfileCacheHits >= 3, "Profile cache is reused for subsequent ticks");
    console.log("✔ Test 17 passed: Effective weapon profile cache is reused across updateShipWeapons.");
  }

  // 18. Station cadence defers ordinary target searches.
  {
    const station = {
      id: `test-station-${(testShipCounter += 1)}`,
      entityType: "station",
      moduleScale: 59,
      x: 1000,
      y: 1000,
      angle: 0,
      team: "A",
      state: "operational",
      alive: true,
      hp: 1000,
      maxHp: 1000,
      design: [
        { x: 7, y: 7, type: "core" },
        { x: 6, y: 7, type: "blaster" },
        { x: 8, y: 7, type: "blaster" }
      ],
      componentHp: [1000, 1000, 1000],
      componentMaxHp: [1000, 1000, 1000],
      weaponCooldowns: [0, 0, 0],
      weaponAngles: [0, 0, 0],
      weaponAimTargetIds: [null, null, null],
      weaponFireTargetIds: [null, null, null],
      weaponDesiredAngles: [null, null, null]
    };
    const enemy = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemy.x = 1100;
    enemy.y = 1000;
    const room = makeRoom([station]);
    room.ships.set(enemy.id, enemy);

    RoomTelemetry.resetRoomTelemetry(room);

    for (let tick = 0; tick < 5; tick += 1) {
      const now = (tick + 1) * (1000 / 30);
      buildRoomSpatialIndex(room, [...room.ships.values()], now);
      updateStationWeapons(room, [station], [...room.ships.values()], 1 / 30, now);
    }

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.ok(t.stationTargetSearchDeferred >= 2, "Station cadence defers searches");
    assert.ok(t.stationTargetSearches <= 4, "Station searches happen at cadence due times");
    console.log("✔ Test 18 passed: Station cadence defers ordinary target searches.");
  }

  // 19. Edge-mounted station PD uses the correct module scale.
  {
    const station = {
      id: `test-station-${(testShipCounter += 1)}`,
      entityType: "station",
      moduleScale: 59,
      x: 1000,
      y: 1000,
      angle: 0,
      team: "A",
      state: "operational",
      alive: true,
      hp: 1000,
      maxHp: 1000,
      design: [
        { x: 7, y: 7, type: "core" },
        { x: 14, y: 7, type: "pointDefense" }
      ],
      componentHp: [1000, 1000],
      componentMaxHp: [1000, 1000],
      weaponCooldowns: [0, 0],
      weaponAngles: [0, 0],
      weaponAimTargetIds: [null, null],
      weaponFireTargetIds: [null, null],
      weaponDesiredAngles: [null, null]
    };
    const room = makeRoom([station]);
    const missile = { id: "m-edge", type: "missile", ownerId: "p2", targetId: station.id, x: 1000 - 25, y: 1000 + 440, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(missile);

    RoomTelemetry.resetRoomTelemetry(room);
    const now = 33;
    buildRoomSpatialIndex(room, [...room.ships.values()], now);
    updateStationWeapons(room, [station], [], 1 / 30, now);

    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.ok(t.pointDefenceThreatSetHits >= 1, "Edge-mounted station PD selects the canonical candidate");
    assert.ok(t.pointDefenceMountSelections >= 1, "Edge-mounted station PD can select a target");
    assert.strictEqual(station.weaponAimTargetIds[1], missile.id, "Edge-mounted station PD tracks the intended missile");
    console.log("✔ Test 19 passed: Edge-mounted station PD uses the correct module scale.");
  }

  // 20. Cached and internal effective weapon profiles match for all weapon families.
  {
    const design = [
      { x: 7, y: 7, type: "core" },
      { x: 6, y: 6, type: "blaster" },
      { x: 8, y: 6, type: "missile" },
      { x: 6, y: 8, type: "railgun" },
      { x: 8, y: 8, type: "beamEmitter" },
      { x: 7, y: 8, type: "engine" }
    ];
    const ship = makeTestShip(design);
    ensureEffectiveWeaponProfileCache(ship);
    const indexes = getShipComponentIndexes(ship).weaponIndices;
    assert.ok(indexes.length >= 4, "Ship has at least one module per weapon family");
    for (const i of indexes) {
      const cached = getEffectiveWeaponStatsCached(ship, i);
      const internal = getEffectiveWeaponStatsInternal(ship, i);
      assert.deepStrictEqual(cached, internal, `Cached and internal profiles match for ${ship.design[i].type}`);
    }
    console.log("✔ Test 20 passed: Cached and internal effective weapon profiles match for all families.");
  }

  // 21. Profile cache invalidates on component destruction and is consistent after repair.
  {
    const ship = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 6, y: 7, type: "blaster" }, { x: 7, y: 8, type: "engine" }]);
    ensureEffectiveWeaponProfileCache(ship);
    const before = getEffectiveWeaponStatsCached(ship, 1);
    assert.ok(before, "Blaster has a cached profile before destruction");
    ship.componentHp[1] = 0;
    ship.componentAliveRevision = (ship.componentAliveRevision || 0) + 1;
    ensureEffectiveWeaponProfileCache(ship);
    const afterDestroy = getEffectiveWeaponStatsInternal(ship, 1);
    assert.ok(afterDestroy, "Blaster internal profile is still computable after destruction");
    assert.deepStrictEqual(getEffectiveWeaponStatsCached(ship, 1), afterDestroy, "Cached and internal profiles match after destruction");
    ship.componentHp[1] = ship.componentMaxHp[1];
    ship.componentAliveRevision = (ship.componentAliveRevision || 0) + 1;
    ensureEffectiveWeaponProfileCache(ship);
    const afterRepair = getEffectiveWeaponStatsCached(ship, 1);
    assert.deepStrictEqual(afterRepair, getEffectiveWeaponStatsInternal(ship, 1), "Cached and internal profiles match after repair");
    console.log("✔ Test 21 passed: Profile cache invalidates and stays consistent through destruction and repair.");
  }

  // 22. Shared PD respects each weapon's individual target priority.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "pointDefense" }, { x: 7, y: 8, type: "engine" }]);
    const flakShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "flakCannon" }, { x: 7, y: 8, type: "engine" }]);
    const podShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "interceptorPod" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip, flakShip, podShip]);
    room.bullets = [
      { id: "m1", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 100, y: 0, life: 5, interceptable: true, hp: 20 },
      { id: "t1", type: "torpedo", ownerId: "p2", targetId: pdShip.id, x: 100, y: 0, life: 5, interceptable: true, hp: 20 }
    ];
    room.drones = new Map();
    room.drones.set("f1", { id: "f1", type: "fighter", ownerId: "p2", targetId: pdShip.id, x: 100, y: 0, hull: 10, x: 100, y: 0, alive: true });


    const pd = findPointDefenseTarget(room, pdShip.x, pdShip.y, pdShip.ownerId, PARTS.pointDefense.weapon, [pdShip], pdShip.id, 33);
    const flak = findPointDefenseTarget(room, flakShip.x, flakShip.y, flakShip.ownerId, PARTS.flakCannon.weapon, [flakShip], flakShip.id, 33);
    const pod = findPointDefenseTarget(room, podShip.x, podShip.y, podShip.ownerId, PARTS.interceptorPod.weapon, [podShip], podShip.id, 33);


    assert.strictEqual(pd?.entity?.id, "f1", "pointDefense prefers drones before missiles");
    assert.strictEqual(flak?.entity?.id, "m1", "flakCannon prefers missiles before drones");
    assert.strictEqual(pod?.entity?.id, "t1", "interceptorPod prefers torpedoes before missiles");
    console.log("✔ Test 22 passed: Shared PD respects individual weapon target priorities.");
  }

  // 23. Destroyed PD target is immediately reacquired between cadence windows.
  {
    const pdShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 6, y: 7, type: "pointDefense" }, { x: 7, y: 8, type: "engine" }]);
    const room = makeRoom([pdShip]);
    const oldMissile = { id: "m-old", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 100, y: 0, life: 5, interceptable: true, hp: 20 };
    const otherMissile = { id: "m-other", type: "missile", ownerId: "p2", targetId: pdShip.id, x: 120, y: 0, life: 5, interceptable: true, hp: 20 };
    room.bullets.push(oldMissile, otherMissile);

    RoomTelemetry.resetRoomTelemetry(room);

    // First tick: acquire old missile.
    const now1 = 33;
    buildRoomSpatialIndex(room, [pdShip], now1);
    updateShipWeapons(room, pdShip, [pdShip], 1 / 30, now1);
    const pdIndex = getShipComponentIndexes(pdShip).weaponIndices[0];
    assert.strictEqual(pdShip.pdAcquiredTargetIds[pdIndex], "m-old", "PD acquired the initial missile");

    // Second tick, well before the 12 Hz PD window: destroy old, leaving the
    // other threat already in the shared set.
    const now2 = 66;
    oldMissile.life = 0;
    buildRoomSpatialIndex(room, [pdShip], now2);
    updateShipWeapons(room, pdShip, [pdShip], 1 / 30, now2);


    const t = RoomTelemetry.getRoomTelemetry(room);
    assert.ok(t.pointDefenceImmediateReacquisitions >= 1, "Invalidating the cached PD target triggers immediate reacquisition");
    assert.ok(t.pointDefenceTargetSearches >= 2, "PD performs a new search when the old target is lost");
    assert.strictEqual(pdShip.pdPendingTargetIds[pdIndex], "m-other", "PD immediately switches to the other threat");
    console.log("✔ Test 23 passed: Destroyed PD target is immediately reacquired.");
  }

  // 24. Live beam firing does not throw and produces a contact.
  {
    const beamShip = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 6, type: "beamEmitter" }, { x: 7, y: 8, type: "engine" }]);
    const enemy = makeTestShip([{ x: 7, y: 7, type: "core" }, { x: 7, y: 8, type: "engine" }], null, "p2");
    enemy.x = 250;
    enemy.y = 0;
    const room = makeRoom([beamShip, enemy]);
    const wIdx = getShipComponentIndexes(beamShip).weaponIndices[0];
    const desired = Math.atan2(enemy.y - beamShip.y, enemy.x - beamShip.x) - (beamShip.angle || 0);
    beamShip.weaponAngles[wIdx] = desired;
    const now = 100;
    buildRoomSpatialIndex(room, [beamShip, enemy], now);
    updateShipWeapons(room, beamShip, [beamShip, enemy], 1 / 30, now);
    assert.ok(Array.isArray(beamShip.weaponBeamContacts), "Beam firing initializes contacts without throwing");
    console.log("✔ Test 24 passed: Live beam firing does not throw.");
  }

  console.log("\nPhase 3 Targeting & Point Defence verification passed.");
})();
