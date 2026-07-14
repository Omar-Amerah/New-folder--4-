"use strict";
// Turret behaviour: turrets rotate toward their target at the shared traverse
// rate (no instant snapping), hold fire until aligned, and projectiles spawn at
// the barrel tip of the (possibly rotated, possibly multi-tile) weapon.
const assert = require("assert");
const TurretRules = require("./public/src/shared/turretRules");
const { PARTS } = require("./src/server/components");
const {
  updateShipWeapons,
  weaponModuleWorldPosition,
  weaponMuzzleDistance,
  moduleRotationToRadians
} = require("./src/server/combat");
const { angleDifference } = require("./src/server/utils");

const SCALE = 13;

function makeRoom() {
  return {
    rules: { gameMode: "solo" },
    map: { asteroids: [], safeZones: [] },
    players: new Map([["me", { id: "me" }], ["foe", { id: "foe" }]]),
    bullets: [],
    effects: [],
    nextEntityId: 1,
    ships: new Map()
  };
}

function makeShip(ownerId, x, y, design) {
  return {
    id: `${ownerId}-ship`, ownerId, x, y, vx: 0, vy: 0, angle: 0, alive: true,
    design,
    stats: { powerUse: 0, powerGeneration: 10, efficiency: 1, accuracyBonus: 1, fireRateBonus: 0 },
    componentHp: design.map(() => 100),
    componentMaxHp: design.map(() => 100),
    shield: 0, maxShield: 0, hp: 500, maxHp: 500
  };
}

function runTicks(room, me, ships, count, dt) {
  const log = [];
  for (let t = 0; t < count; t += 1) {
    updateShipWeapons(room, me, ships, dt, t * dt * 1000);
    log.push({ angle: me.weaponAngles.slice(), bullets: room.bullets.length });
  }
  return log;
}

// 1. Turrets sweep gradually at the shared traverse rate instead of snapping.
{
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "blaster", rotation: 0 }
  ];
  const room = makeRoom();
  const me = makeShip("me", 0, 0, design);
  const foe = makeShip("foe", 300, 180, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  room.ships.set(me.id, me); room.ships.set(foe.id, foe);
  const dt = 1 / 30;
  const log = runTicks(room, me, [me, foe], 60, dt);

  const origin = weaponModuleWorldPosition(me, design[1]);
  const targetRelative = Math.atan2(foe.y - origin.y, foe.x - origin.x) - me.angle;
  const rate = TurretRules.turnRateFor(PARTS.blaster.weapon);
  const ticksNeeded = Math.ceil(Math.abs(targetRelative) / (rate * dt));
  assert(ticksNeeded >= 3, `test premise: traverse must take multiple ticks (needs ${ticksNeeded})`);

  // Not aligned after the first tick, aligned after enough ticks, and each step
  // is bounded by the traverse rate.
  assert(Math.abs(angleDifference(log[0].angle[1], targetRelative)) > 0.05, "turret must not snap to target in one tick");
  assert(Math.abs(angleDifference(log[ticksNeeded + 2].angle[1], targetRelative)) < 0.01, "turret should reach the target angle after sweeping");
  for (let t = 1; t < ticksNeeded; t += 1) {
    const step = Math.abs(angleDifference(log[t].angle[1], log[t - 1].angle[1]));
    assert(step <= rate * dt + 1e-9, `traverse step ${step.toFixed(4)} exceeded rate limit at tick ${t}`);
  }

  // 2. No firing while the barrel is still far off target (> 0.26 rad).
  for (let t = 0; t < log.length; t += 1) {
    if (log[t].bullets > 0) {
      const err = Math.abs(angleDifference(log[t].angle[1], targetRelative));
      assert(err <= 0.26 + rate * dt, `fired while misaligned by ${err.toFixed(3)} rad`);
      break;
    }
  }
  assert(log[log.length - 1].bullets > 0, "turret should fire once aligned");

  // 3. The bullet spawns at the barrel tip, along the turret's aim.
  const bullet = room.bullets[0];
  const spawnOffset = Math.hypot(bullet.x - origin.x, bullet.y - origin.y);
  const expected = weaponMuzzleDistance(design[1], "blaster");
  assert(Math.abs(spawnOffset - expected) < 0.01, `bullet spawned ${spawnOffset.toFixed(2)}px from pivot, expected ${expected.toFixed(2)}`);
  assert(Math.abs(expected / SCALE - TurretRules.MUZZLE_TIP_TILES.blaster) < 1e-9, "blaster muzzle should be at the art barrel tip");
  // The shot may legally fire mid-sweep (within the 0.26 rad alignment gate),
  // so compare the spawn offset direction against the shot's own velocity: the
  // bullet must leave from the barrel it travels along, within the weapon's
  // real accuracy spread (accuracy bonuses come from components, not ship
  // stats, so the blaster's base accuracy applies here).
  const spawnDir = Math.atan2(bullet.y - origin.y, bullet.x - origin.x);
  const velocityDir = Math.atan2(bullet.vy, bullet.vx);
  const blasterAccuracy = Math.min(1, Math.max(0.1, PARTS.blaster.weapon.accuracy));
  const maxSpread = (1 - blasterAccuracy) * 0.22 + 0.01;
  assert(Math.abs(angleDifference(spawnDir, velocityDir)) <= maxSpread,
    `bullet must leave along the barrel it was fired from (off by ${Math.abs(angleDifference(spawnDir, velocityDir)).toFixed(4)}, allowed ${maxSpread.toFixed(4)})`);
}

// 4. Rotated multi-tile weapon: muzzle sits at the forward footprint edge,
// measured from the footprint centre (the turret pivot), not the anchor cell.
{
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "frame", rotation: 0 },
    { x: 9, y: 9, type: "railgun", rotation: 0 }, // occupies (9,9),(9,10),(9,11)
    { x: 8, y: 9, type: "frame", rotation: 0 },
    { x: 8, y: 10, type: "frame", rotation: 0 },
    { x: 8, y: 11, type: "frame", rotation: 0 }
  ];
  const room = makeRoom();
  const me = makeShip("me", 0, 0, design);
  // Dead ahead of the railgun's blueprint facing so its narrow 35-45 degree arc allows fire.
  const foe = makeShip("foe", 600, 26, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  room.ships.set(me.id, me); room.ships.set(foe.id, foe);
  runTicks(room, me, [me, foe], 400, 1 / 30);
  assert(room.bullets.length > 0, "railgun should fire at an in-arc target");
  const bullet = room.bullets[0];
  const pivot = weaponModuleWorldPosition(me, design[2]);
  const spawnOffset = Math.hypot(bullet.x - pivot.x, bullet.y - pivot.y);
  const footprint = PARTS.railgun.footprint;
  const longTiles = Math.max(footprint.width, footprint.height);
  const expected = (longTiles * 0.5 - 0.04) * SCALE;
  assert(Math.abs(spawnOffset - expected) < 0.01, `railgun bullet spawned ${spawnOffset.toFixed(2)}px from pivot, expected ${expected.toFixed(2)} (barrel tip)`);
}

// 5. Client and server share one traverse-rate table. The client's rate lookup
// now lives in the renderer-neutral weaponAim module, imported by both renderers.
{
  const fs = require("fs");
  const weaponAimSource = fs.readFileSync("./public/src/game/weaponAim.js", "utf8");
  assert(/globalThis\.TurretRules\.turnRateFor/.test(weaponAimSource), "client weaponAim must delegate turret turn rates to shared TurretRules");
  const combatSource = fs.readFileSync("./src/server/combat.js", "utf8");
  assert(/TurretRules\.turnRateFor/.test(combatSource), "server combat must delegate turret turn rates to shared TurretRules");
  const html = fs.readFileSync("./public/index.html", "utf8");
  assert(/src\/shared\/turretRules\.js/.test(html), "index.html must load the shared turretRules script");
  // The Pixi renderer (the only arena renderer) consumes the shared lookup.
  assert(/from "\.\.\/weaponAim\.js"/.test(fs.readFileSync("./public/src/game/pixi/pixiShips.js", "utf8")), "pixi renderer must import turret aim helpers from weaponAim");
  // Point defense stays the fastest traverse so missile interception still works.
  assert(TurretRules.TURN_RATES.pointDefense > TurretRules.TURN_RATES.blaster, "point defense must traverse faster than main guns");

  // Regression: MessagePack turns an absent aimSpeed into null on the live
  // hello path, and Number(null) is 0 — either value must fall through to the
  // family traverse table instead of freezing every live turret at 0 rad/s.
  assert(TurretRules.turnRateFor({ type: "blaster", aimSpeed: null }) > 0, "null aimSpeed must not freeze the traverse");
  assert(TurretRules.turnRateFor({ type: "blaster", aimSpeed: 0 }) > 0, "zero aimSpeed must not freeze the traverse");
  assert.strictEqual(TurretRules.turnRateFor({ type: "blaster", aimSpeed: null }), TurretRules.TURN_RATES.blaster,
    "null aimSpeed must use the family traverse rate");
  assert.strictEqual(PARTS.blaster.weapon.aimSpeed, undefined, "server blaster must not normalize aimSpeed to a number");
}

// 6. Pixi scene graph: persistent turret sprites, ship-relative rotation applied
// on a hull-rotated frame (never double-adding the hull angle), and static
// content rebuilt only on a signature change.
{
  const fs = require("fs");
  const pixiSource = fs.readFileSync("./public/src/game/pixi/pixiShips.js", "utf8");
  const viewSource = fs.readFileSync("./public/src/game/pixi/pixiShipView.js", "utf8");
  const artSource = fs.readFileSync("./public/src/game/componentArt.js", "utf8");
  const netlifyBuild = fs.readFileSync("./netlify-build.js", "utf8");

  // Per-view smoothed turret angles, reset on pool reuse; no canvas global cache.
  assert(/visualTurretAngles/.test(pixiSource), "Pixi ship views must own smoothed turret angles so pooled views can reset them");
  assert(!/state\.weaponAnglesMap/.test(pixiSource), "Pixi turret rotation must not use the canvas global weapon angle cache");

  // The hull frame owns the hull world rotation; turret sprites receive only the
  // ship-relative visual angle and must never add the hull angle a second time.
  assert(/setHullFrameRotation\(view,\s*renderShip\.angle\)/.test(pixiSource), "Pixi ships must drive the hull frame from the rendered ship angle");
  assert(/hullContainer\.rotation\s*=\s*angle/.test(viewSource), "HullContainer must own the hull world rotation");
  assert(/sprite\.rotation\s*=\s*visual\b/.test(pixiSource), "Pixi turret sprites must receive the ship-relative visual angle");
  assert(!/sprite\.rotation\s*=\s*[^;]*(ship|renderShip)\.angle\s*\+/.test(pixiSource), "Pixi turret sprites must not add hull angle a second time");
  assert(/updatePixiTurrets\(env,\s*view,\s*ship,\s*design\)/.test(pixiSource), "Pixi turrets must update every rendered ship frame");

  // One persistent turret per ORIGINAL design index, retained across snapshots.
  assert(/turretsByDesignIndex/.test(viewSource), "Pixi views must key persistent turrets by original design index");
  assert(/sprite\.__designIndex\s*=\s*i/.test(viewSource), "turret sprites must store their original design index");
  // Static content rebuilt only when the static signature changes.
  assert(/view\.staticKey\s*!==\s*staticKey/.test(pixiSource), "Pixi static hull/turrets must rebuild only on a signature change");
  assert(/rebuildPixiShipStatic/.test(pixiSource), "Pixi ships must have an explicit static rebuild path");
  // Debug parity assertion between rotating weapons and turret sprites exists.
  assert(/rotatingWeaponCount/.test(pixiSource) && /turretSpriteCount/.test(pixiSource), "debug mode must assert rotatingWeaponCount === turretSpriteCount");
  // Forced-arrow debug mode to separate transform bugs from artwork bugs.
  assert(/__mfaDebugTurretArrows/.test(pixiSource), "Pixi renderer must support a forced-arrow debug mode");

  // Explicit static/dynamic artwork split APIs, covering every weapon type.
  assert(/drawStaticComponentBase/.test(artSource) && /drawStaticWeaponMount/.test(artSource) && /drawRotatingWeaponTop/.test(artSource), "componentArt must expose explicit static/dynamic weapon APIs");
  assert(/debugTurrets:\s*false/.test(fs.readFileSync("./public/src/state.js", "utf8")), "turret debug logging must be disabled by default");
  assert(/turretRules\.js/.test(netlifyBuild), "Netlify build must require the shared turret rules asset");
  assert(/pixiShipView\.js/.test(netlifyBuild), "Netlify build must bundle the Pixi ship view module");
  for (const type of ["blaster", "autocannon", "railgun", "missile", "torpedo", "swarmMissile", "pointDefense", "flakCannon", "beamEmitter"]) {
    assert(artSource.includes(type), `componentArt should include ${type} weapon artwork`);
  }
}

// 7. Safe-zone regression: aiming and firing permission are independent. A ship
// inside a safe zone with an enemy visible must rotate its turret toward the
// enemy while creating no projectile, dealing no beam damage, adding no firing
// heat, and consuming no cooldown.
{
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "blaster", rotation: 0 }
  ];
  const room = makeRoom();
  room.map.safeZones = [{ x: 0, y: 0, radius: 400 }];
  const me = makeShip("me", 0, 0, design);
  me.stats.blasterRange = PARTS.blaster.weapon.range;
  me.stats.missileRange = 0;
  me.stats.railgunRange = 0;
  me.stats.beamRange = 0;
  me.componentHeatInput = design.map(() => 0); // firing heat sink for the assertion
  const foe = makeShip("foe", 320, 200, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  room.ships.set(me.id, me); room.ships.set(foe.id, foe);
  const dt = 1 / 30;
  runTicks(room, me, [me, foe], 90, dt);

  const origin = weaponModuleWorldPosition(me, design[1]);
  const targetRelative = Math.atan2(foe.y - origin.y, foe.x - origin.x) - me.angle;
  assert(Math.abs(angleDifference(me.weaponAngles[1], targetRelative)) < 0.01,
    "turret must track the enemy from inside a safe zone");
  assert(Math.abs(angleDifference(me.weaponAngles[1], 0)) > 0.3,
    "safe-zone turret must have left its blueprint facing");
  assert.strictEqual(me.combatTargetId, foe.id, "safe-zone ship should still acquire its combat target");
  assert.strictEqual(room.bullets.length, 0, "no projectile may be created from a safe zone");
  assert.strictEqual(me.weaponCooldowns[1], 0, "cooldown must not be consumed as though a shot fired");
  assert(me.componentHeatInput.every((value) => value === 0), "no firing heat may be added in a safe zone");

  // Beam variant: visible tracking, but zero beam damage and zero beam effects.
  const beamRoom = makeRoom();
  beamRoom.map.safeZones = [{ x: 0, y: 0, radius: 400 }];
  const beamMe = makeShip("me", 0, 0, [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "beamEmitter", rotation: 0 }
  ]);
  beamMe.componentHeatInput = [0, 0];
  beamMe.thermalPowerFactor = 1;
  const beamFoe = makeShip("foe", 200, 60, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  const beamFoeHp = beamFoe.hp;
  const beamFoeComponentHp = beamFoe.componentHp.slice();
  beamRoom.ships.set(beamMe.id, beamMe); beamRoom.ships.set(beamFoe.id, beamFoe);
  runTicks(beamRoom, beamMe, [beamMe, beamFoe], 90, dt);
  assert(Math.abs(me.weaponAngles[1]) > 0.3, "beam emitter should still traverse in a safe zone");
  assert.strictEqual(beamFoe.hp, beamFoeHp, "no beam damage may be dealt from a safe zone");
  assert.deepStrictEqual(beamFoe.componentHp, beamFoeComponentHp, "no beam component damage from a safe zone");
  assert.strictEqual(beamRoom.effects.filter((effect) => effect.type === "beam").length, 0,
    "no beam effect may be emitted from a safe zone");
  assert(beamMe.componentHeatInput.every((value) => value === 0), "no beam firing heat in a safe zone");
}

// 8. Out-of-range aiming: an assigned enemy inside the fixed arc but outside
// firing range is tracked visually without firing; once it enters range the
// turret keeps tracking smoothly and fires only after normal alignment checks.
{
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "blaster", rotation: 0 }
  ];
  const room = makeRoom();
  const me = makeShip("me", 0, 0, design);
  me.stats.blasterRange = PARTS.blaster.weapon.range;
  me.stats.missileRange = 0;
  me.stats.railgunRange = 0;
  me.stats.beamRange = 0;
  // Inside the 120-degree blueprint arc, outside the 500 firing range, inside
  // the assigned-target detection window (range * 1.12 for a focused target).
  const bearing = 0.5;
  const outDistance = PARTS.blaster.weapon.range + 35;
  const foe = makeShip("foe", Math.cos(bearing) * outDistance, Math.sin(bearing) * outDistance,
    [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  me.focusTargetId = foe.id;
  room.ships.set(me.id, me); room.ships.set(foe.id, foe);
  const dt = 1 / 30;
  const rate = TurretRules.turnRateFor(PARTS.blaster.weapon);

  const outLog = runTicks(room, me, [me, foe], 90, dt);
  const origin = weaponModuleWorldPosition(me, design[1]);
  const outRelative = Math.atan2(foe.y - origin.y, foe.x - origin.x) - me.angle;
  assert(Math.abs(angleDifference(me.weaponAngles[1], outRelative)) < 0.01,
    "turret must orient toward the assigned target before it enters firing range");
  assert.strictEqual(room.bullets.length, 0, "turret must not fire while the target is out of range");
  assert.strictEqual(me.weaponAimTargetIds[1], foe.id, "aim target should be the assigned enemy");
  assert.strictEqual(me.weaponFireTargetIds[1], null, "there must be no fire target outside range");

  // Bring the enemy into range on a new bearing: tracking continues smoothly
  // (rate-limited, no snap) and firing begins only once aligned.
  foe.x = Math.cos(-0.2) * 380;
  foe.y = Math.sin(-0.2) * 380;
  const inLog = runTicks(room, me, [me, foe], 120, dt);
  for (let t = 1; t < inLog.length; t += 1) {
    const step = Math.abs(angleDifference(inLog[t].angle[1], inLog[t - 1].angle[1]));
    assert(step <= rate * dt + 1e-9, `in-range transition traverse step ${step.toFixed(4)} exceeded the rate limit`);
  }
  assert(room.bullets.length > 0, "turret should fire once the target is in range and aligned");
  const inRelative = Math.atan2(foe.y - origin.y, foe.x - origin.x) - me.angle;
  for (let t = 0; t < inLog.length; t += 1) {
    if (inLog[t].bullets > 0) {
      const err = Math.abs(angleDifference(inLog[t].angle[1], inRelative));
      assert(err <= 0.26 + rate * dt, `fired while misaligned by ${err.toFixed(3)} rad after entering range`);
      break;
    }
  }
}

// 9. Turret aim diagnostics expose the full per-weapon decision state for
// development/testing (dev-only /debug/turrets endpoint uses the same builder).
{
  const { buildShipTurretDiagnostics } = require("./src/server/combat");
  const design = [
    { x: 7, y: 7, type: "core", rotation: 0 },
    { x: 8, y: 7, type: "blaster", rotation: 90 }
  ];
  const room = makeRoom();
  room.map.safeZones = [{ x: 0, y: 0, radius: 400 }];
  const me = makeShip("me", 0, 0, design);
  const foe = makeShip("foe", 60, 320, [{ x: 7, y: 7, type: "core", rotation: 0 }]);
  room.ships.set(me.id, me); room.ships.set(foe.id, foe);
  runTicks(room, me, [me, foe], 40, 1 / 30);

  const diagnostics = buildShipTurretDiagnostics(room, me);
  assert.strictEqual(diagnostics.length, 1, "one diagnostics entry per weapon module");
  const entry = diagnostics[0];
  assert.strictEqual(entry.shipId, "me-ship");
  assert.strictEqual(entry.designIndex, 1);
  assert.strictEqual(entry.componentType, "blaster");
  assert(Math.abs(entry.defaultRelativeAngle - Math.PI / 2) < 1e-9, "blueprint relative angle must be reported");
  assert(Number.isFinite(entry.currentRelativeAngle), "current authoritative relative angle must be reported");
  assert(Number.isFinite(entry.desiredRelativeAngle), "desired relative angle must be reported");
  assert(Number.isFinite(entry.hullWorldAngle) && Number.isFinite(entry.weaponWorldAngle),
    "hull and weapon world angles must be reported");
  assert.strictEqual(entry.weaponWorldAngle, entry.hullWorldAngle + entry.currentRelativeAngle);
  assert.strictEqual(entry.aimTargetId, foe.id, "aim target id must be reported");
  assert.strictEqual(entry.fireTargetId, foe.id, "fire target id must be reported");
  assert(Number.isFinite(entry.targetDistance) && entry.targetDistance > 0, "target distance must be reported");
  assert.strictEqual(entry.inFiringRange, true, "firing-range flag must be reported");
  assert.strictEqual(entry.inFixedArc, true, "fixed-arc flag must be reported");
  assert.strictEqual(entry.safeZoneFiringBlocked, true, "safe-zone firing block must be reported");
  assert.strictEqual(entry.componentAlive, true, "component liveness must be reported");
  assert.strictEqual(entry.thermalPerformance, 1, "thermal performance must be reported");
  // Verbose diagnostics stay out of normal snapshots.
  const snapshotsSource = require("fs").readFileSync("./src/server/snapshots.js", "utf8");
  assert(!snapshotsSource.includes("buildShipTurretDiagnostics"),
    "verbose turret diagnostics must not ride in normal snapshots");
}

console.log("Turret verification passed");
