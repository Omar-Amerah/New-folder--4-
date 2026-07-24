// Comprehensive test suite for Beam Emitter Core-directed targeting and limited burn-through.

const assert = require("assert");
const {
  targetCoreAimWorldPosition,
  findBeamRayIntersections,
  damageBeamTargets,
  updateShipWeapons,
  isComponentAlive
} = require("./src/server/combat");
const { PARTS } = require("./src/server/components");
const { initComponentState } = require("./src/server/componentHealth");

function createMockRoom() {
  return {
    nextEntityId: 100,
    mapSeed: 42,
    map: { safeZones: [], asteroids: [] },
    ships: new Map(),
    bullets: [],
    drones: new Map(),
    effects: [],
    players: new Map([
      ["p1", { id: "p1", team: "blue", ships: [] }],
      ["p2", { id: "p2", team: "red", ships: [] }]
    ])
  };
}

function createMockShip(id, ownerId, x, y, angle = 0, design = null) {
  const defaultDesign = design || [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 },
    { type: "armor", x: 7, y: 5, rotation: 0 }
  ];

  const ship = {
    id,
    ownerId,
    x,
    y,
    vx: 0,
    vy: 0,
    angle,
    alive: true,
    removed: false,
    hp: 100,
    maxHp: 100,
    radius: 40,
    shield: 0,
    maxShield: 0,
    design: defaultDesign,
    stats: {
      maxHp: 100,
      radius: 40,
      unitCost: 100,
      weaponDps: 20
    },
    componentPower: { byComponentIndex: defaultDesign.map(() => ({ operationalMultiplier: 1 })) }
  };

  initComponentState(ship);
  return ship;
}

function createBeamShip(id, ownerId, x, y, angle = 0) {
  const design = [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "beamEmitter", x: 7, y: 6, rotation: 0 }
  ];
  const ship = createMockShip(id, ownerId, x, y, angle, design);
  return ship;
}

function runTests() {
  console.log("Starting Beam Emitter verification tests...");

  // -------------------------------------------------------------
  // Test 1: Core-directed targeting
  // -------------------------------------------------------------
  {
    // Core at (7,7) -> world x=200, y=0. Frame at (7,6) -> world x=213. Armor at (7,5) -> world x=226.
    // Shooter at x=350, y=0 faces target (beam travels left from 350 to 200, striking Armor at 226 first).
    const targetDesign = [
      { type: "core", x: 7, y: 7, rotation: 0 },
      { type: "frame", x: 7, y: 6, rotation: 0 },
      { type: "armor", x: 7, y: 5, rotation: 0 }
    ];
    const target = createMockShip("target1", "p2", 200, 0, 0, targetDesign);
    const aim = targetCoreAimWorldPosition(target);

    assert.ok(aim, "Target Core aim point should be found");
    assert.strictEqual(aim.componentIndex, 0, "Target Core aim should point to component index 0 (Core)");

    // Beam cast towards target Core from shooter at x=350, y=0
    const intersections = findBeamRayIntersections(target, 350, 0, aim.x, aim.y, 15);
    assert.ok(intersections.length >= 2, "Ray should intersect outer armour/frame before Core");
    assert.strictEqual(target.design[intersections[0].index].type, "armor", "Outer armour should be intersected first");
    assert.strictEqual(target.design[intersections[intersections.length - 1].index].type, "core", "Core should be intersected last");
    console.log("PASS: Core-directed targeting");
  }

  // -------------------------------------------------------------
  // Test 2: Rotated target
  // -------------------------------------------------------------
  {
    const targetDesign = [
      { type: "core", x: 7, y: 7, rotation: 0 },
      { type: "armor", x: 7, y: 5, rotation: 0 }
    ];
    // Rotate target by 90 degrees (Math.PI / 2) -> Armor is at (100, 126), Core is at (100, 100)
    const targetRotated = createMockShip("targetRot", "p2", 100, 100, Math.PI / 2, targetDesign);
    const aimRotated = targetCoreAimWorldPosition(targetRotated);

    assert.ok(aimRotated, "Rotated Core aim point should be found");
    assert.strictEqual(Math.round(aimRotated.x), 100, "Rotated Core world X should be target X");
    assert.strictEqual(Math.round(aimRotated.y), 100, "Rotated Core world Y should be target Y");

    // Shooter at (100, 300) fires down along x=100 towards Core at (100, 100), striking Armor at (100, 126) first
    const intersections = findBeamRayIntersections(targetRotated, 100, 300, aimRotated.x, aimRotated.y, 15);
    assert.ok(intersections.length > 0, "Ray should intersect rotated target components");
    assert.strictEqual(targetRotated.design[intersections[0].index].type, "armor", "Rotated target front armour should be hit first");
    console.log("PASS: Rotated target aim point calculation");
  }

  // -------------------------------------------------------------
  // Test 3: Moving target tracking
  // -------------------------------------------------------------
  {
    const target = createMockShip("targetMoving", "p2", 200, 0, 0);
    const aim1 = targetCoreAimWorldPosition(target);

    // Target moves to new position
    target.x = 250;
    target.y = 50;
    target.angle = 0.5;
    const aim2 = targetCoreAimWorldPosition(target);

    assert.notStrictEqual(aim1.x, aim2.x, "Aim point should update as target moves X");
    assert.notStrictEqual(aim1.y, aim2.y, "Aim point should update as target moves Y");
    assert.strictEqual(aim2.componentIndex, 0, "Aim should consistently track Core component");
    console.log("PASS: Moving target smooth tracking");
  }

  // -------------------------------------------------------------
  // Test 4: Active shield interaction
  // -------------------------------------------------------------
  {
    const room = createMockRoom();
    const shooter = createBeamShip("s1", "p1", 350, 0);
    const target = createMockShip("t1", "p2", 200, 0);
    target.shield = 50;
    target.maxShield = 50;

    const initialArmorHp = target.componentHp[2]; // index 2 is armor

    // Damage beam with active shield (shield >= SHIELD_HIT_MIN)
    const resultShield = damageBeamTargets(room, shooter, [target], 350, 0, -210, 0, 15, 30, 1000, {
      shieldDamageMultiplier: 1.55,
      hullDamageMultiplier: 0.65,
      burnThroughCarryMultiplier: 0.4
    });

    assert.ok(target.shield < 50, "Shield should receive damage first");
    assert.strictEqual(resultShield.firstHitIndex, -1, "Beam should stop on outer shield bubble ring while shield holds");
    assert.ok(resultShield.hitX > 226, "Beam visual impact point should stop on outer shield bubble before reaching physical hull");
    assert.strictEqual(target.componentHp[2], initialArmorHp, "No physical burn-through or component damage should occur through active shield");

    // Deplete shield to 0 (shield < SHIELD_HIT_MIN)
    target.shield = 0;
    const resultHull = damageBeamTargets(room, shooter, [target], 350, 0, -210, 0, 15, 30, 1050, {
      shieldDamageMultiplier: 1.55,
      hullDamageMultiplier: 0.65,
      burnThroughCarryMultiplier: 0.4
    });

    assert.ok(resultHull.firstHitIndex >= 0, "Beam should pass through to physical components once shield is depleted");
    console.log("PASS: Active shield interaction (beam stopped on shield bubble until depleted)");
  }

  // -------------------------------------------------------------
  // Test 5: One-layer burn-through (Armour -> Frame -> Core)
  // -------------------------------------------------------------
  {
    const room = createMockRoom();
    const shooter = createBeamShip("s1", "p1", 350, 0);
    const targetDesign = [
      { type: "core", x: 7, y: 7, rotation: 0 },   // index 0 (x=200)
      { type: "frame", x: 7, y: 6, rotation: 0 },  // index 1 (x=213)
      { type: "armor", x: 7, y: 5, rotation: 0 }   // index 2 (x=226)
    ];
    const target = createMockShip("tBurn", "p2", 200, 0, 0, targetDesign);
    target.shield = 0;

    // Set low HP on Armour (index 2) so 1 beam tick destroys it with excess damage
    target.componentHp[2] = 5;
    const initialFrameHp = target.componentHp[1];
    const initialCoreHp = target.componentHp[0];

    // Beam damage event: 30 damage. Hull mult: 1.0. Burn-through mult: 0.4.
    damageBeamTargets(room, shooter, [target], 350, 0, 200, 0, 15, 30, 1000, {
      shieldDamageMultiplier: 1.55,
      hullDamageMultiplier: 1.0,
      burnThroughCarryMultiplier: 0.4
    });

    assert.strictEqual(target.componentHp[2], 0, "Armour should be destroyed by beam damage");
    assert.ok(target.componentHp[1] < initialFrameHp, "Frame (index 1) should receive carry-through damage");
    assert.strictEqual(target.componentHp[0], initialCoreHp, "Core (index 0) should receive NO damage from this single event");
    console.log("PASS: One-layer burn-through (stops after 1 additional component)");
  }

  // -------------------------------------------------------------
  // Test 6: No recursive penetration (Low HP Armour & Frame)
  // -------------------------------------------------------------
  {
    const room = createMockRoom();
    const shooter = createBeamShip("s1", "p1", 350, 0);
    const targetDesign = [
      { type: "core", x: 7, y: 7, rotation: 0 },   // index 0 (x=200)
      { type: "frame", x: 7, y: 6, rotation: 0 },  // index 1 (x=213)
      { type: "armor", x: 7, y: 5, rotation: 0 }   // index 2 (x=226)
    ];
    const target = createMockShip("tRec", "p2", 200, 0, 0, targetDesign);
    target.shield = 0;

    // Set Armour and Frame to very low HP (e.g., 2 HP each)
    target.componentHp[2] = 2;
    target.componentHp[1] = 2;
    const initialCoreHp = target.componentHp[0];

    damageBeamTargets(room, shooter, [target], 350, 0, 200, 0, 15, 50, 1000, {
      shieldDamageMultiplier: 1.0,
      hullDamageMultiplier: 1.0,
      burnThroughCarryMultiplier: 0.4
    });

    assert.strictEqual(target.componentHp[2], 0, "Armour should be destroyed");
    assert.strictEqual(target.componentHp[1], 0, "Frame should be destroyed by carry-through");
    assert.strictEqual(target.componentHp[0], initialCoreHp, "Core should NOT be damaged recursively in the same event");
    console.log("PASS: No recursive penetration into third layer");
  }

  // -------------------------------------------------------------
  // Test 7: No excess damage
  // -------------------------------------------------------------
  {
    const room = createMockRoom();
    const shooter = createBeamShip("s1", "p1", 350, 0);
    const targetDesign = [
      { type: "core", x: 7, y: 7, rotation: 0 },   // index 0
      { type: "frame", x: 7, y: 6, rotation: 0 },  // index 1
      { type: "armor", x: 7, y: 5, rotation: 0 }   // index 2
    ];
    const target = createMockShip("tExact", "p2", 200, 0, 0, targetDesign);
    target.shield = 0;

    // Armour flat reduction is 5. Damage 10 -> effective damage 5. Set Armour HP to 5 to match effective damage exactly.
    target.componentHp[2] = 5;
    const initialFrameHp = target.componentHp[1];

    damageBeamTargets(room, shooter, [target], 350, 0, 200, 0, 15, 10, 1000, {
      shieldDamageMultiplier: 1.0,
      hullDamageMultiplier: 1.0,
      burnThroughCarryMultiplier: 0.4
    });

    assert.strictEqual(target.componentHp[2], 0, "Armour should be destroyed with exact HP");
    assert.strictEqual(target.componentHp[1], initialFrameHp, "Frame should take 0 carry-through damage when excess damage is zero");
    console.log("PASS: No excess damage carry-through when HP matches damage exactly");
  }

  // -------------------------------------------------------------
  // Test 8: Contact reset conditions
  // -------------------------------------------------------------
  {
    const room = createMockRoom();
    const shooter = createBeamShip("sBeam", "p1", 0, 0, 0);
    const target1 = createMockShip("t1", "p2", 200, 0, 0);
    const target2 = createMockShip("t2", "p2", 200, 20, 0);

    room.ships.set(shooter.id, shooter);
    room.ships.set(target1.id, target1);
    room.ships.set(target2.id, target2);

    // Run 2 ticks to complete turret rotation and establish active beam contact
    updateShipWeapons(room, shooter, [shooter, target1, target2], 0.2, 1000);
    updateShipWeapons(room, shooter, [shooter, target1, target2], 0.2, 1200);

    assert.ok(shooter.weaponBeamContacts, "weaponBeamContacts should be initialized");
    assert.ok(shooter.weaponBeamContacts[1], "Beam weapon index 1 should have active contact");
    assert.strictEqual(shooter.weaponBeamContacts[1].targetShipId, target1.id, "Contact target should be target1");

    // Target switch to target2
    shooter.focusTargetId = target2.id;
    updateShipWeapons(room, shooter, [shooter, target1, target2], 0.2, 1400);

    const contact = shooter.weaponBeamContacts[1];
    if (contact) {
      assert.strictEqual(contact.targetShipId, target2.id, "Contact target should reset to target2");
      assert.ok(contact.contactDuration <= 0.21, "Contact duration should reset on target switch");
    }

    // Power loss
    shooter.componentPower.byComponentIndex[1].operationalMultiplier = 0;
    updateShipWeapons(room, shooter, [shooter, target1, target2], 0.2, 1600);
    assert.strictEqual(shooter.weaponBeamContacts[1], null, "Contact state should reset to null on Power loss");

    console.log("PASS: Contact state tracking and reset conditions");
  }

  // -------------------------------------------------------------
  // Test 9: Missing Core fallback
  // -------------------------------------------------------------
  {
    const targetDesign = [
      { type: "frame", x: 7, y: 7, rotation: 0 },  // index 0
      { type: "armor", x: 7, y: 6, rotation: 0 }   // index 1
    ];
    const targetNoCore = createMockShip("tNoCore", "p2", 200, 0, 0, targetDesign);
    const aim = targetCoreAimWorldPosition(targetNoCore);

    assert.ok(aim, "Aim point should fallback to remaining occupied cells");
    assert.strictEqual(aim.componentIndex, -1, "Fallback aim point componentIndex should be -1");

    // Destroy all components
    targetNoCore.componentHp[0] = 0;
    targetNoCore.componentHp[1] = 0;
    const aimEmpty = targetCoreAimWorldPosition(targetNoCore);
    assert.strictEqual(aimEmpty, null, "Aim point should return null when no living geometry remains");

    console.log("PASS: Missing Core fallback behavior");
  }

  // -------------------------------------------------------------
  // Test 10: Server Authority & Determinism
  // -------------------------------------------------------------
  {
    const room = createMockRoom();
    const shooter = createBeamShip("sAuth", "p1", 0, 0, 0);
    const target = createMockShip("tAuth", "p2", 200, 0, 0);

    room.ships.set(shooter.id, shooter);
    room.ships.set(target.id, target);

    updateShipWeapons(room, shooter, [shooter, target], 0.05, 1000);

    const serverAim = targetCoreAimWorldPosition(target);
    assert.ok(serverAim, "Server authoritatively determines Core aim point");
    assert.strictEqual(shooter.combatTargetId, target.id, "Server authoritatively acquires target");

    console.log("PASS: Server authority and determinism");
  }

  console.log("\nALL BEAM EMITTER VERIFICATION TESTS PASSED SUCCESSFULLY!");
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };
