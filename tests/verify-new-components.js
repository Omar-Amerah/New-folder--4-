"use strict";
// Verification for the components added alongside the spinal-weapon work:
// Heavy Engine, Overclocked Repair Unit, Burst Cooler, Refractory Armour,
// Plasma Cannon, Fragmentation Cannon, Scatter Cannon and Spinal Accelerator.
//
// The catalogue assertions guard the design contract each part was added under
// (footprint, family, per-ship limit); the behaviour assertions cover the four
// genuinely new mechanics: projectile impact Heat, offensive impact bursts,
// penetrating damage down the impact ray, burst cooling, and the spinal charge
// cycle with its committed aim.

const assert = require("assert");
const { PARTS } = require("../src/server/components");
const { applyHullDamage, initComponentState } = require("../src/server/componentHealth");
const { initShipHeat, updateShipHeat, addComponentHeat } = require("../src/server/heat");
const { updateBullets } = require("../src/server/projectiles");
const {
  updateShipWeapons,
  isInductionBlockedByHeatShield,
  spinalTraverseScale
} = require("../src/server/combat");
const { decaySpinalCharge } = require("../src/server/combat/spinal");
const { heatAdjustedMovementStats } = require("../src/server/movementCapability");
const HeatRules = require("../public/src/shared/heatRules");
const TurretRules = require("../public/src/shared/turretRules");

function makeRoom() {
  return {
    rules: { gameMode: "solo" },
    nextEntityId: 100,
    mapSeed: 7,
    map: { safeZones: [], asteroids: [] },
    ships: new Map(),
    drones: new Map(),
    decoys: new Map(),
    bullets: [],
    effects: [],
    disableSpatialIndex: true,
    world: { width: 4096, height: 4096 },
    players: new Map([
      ["p1", { id: "p1", team: "blue", ships: [] }],
      ["p2", { id: "p2", team: "red", ships: [] }]
    ])
  };
}

function makeShip(id, ownerId, x, y, design, angle = 0) {
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
    radius: 40,
    shield: 0,
    maxShield: 0,
    design,
    stats: { unitCost: 100, powerUse: 0, powerGeneration: 100, efficiency: 1, accuracyBonus: 0, fireRateBonus: 0 },
    componentPower: { byComponentIndex: design.map(() => ({ operationalMultiplier: 1 })) },
    weaponCooldowns: design.map(() => 0),
    weaponAngles: design.map(() => 0),
    weaponDesiredAngles: design.map(() => null),
    weaponAimTargetIds: design.map(() => null),
    weaponFireTargetIds: design.map(() => null),
    dirtyComponents: new Set()
  };
  initComponentState(ship);
  ship.maxHp = ship.hp;
  ship.stats.maxHp = ship.hp;
  return ship;
}

let passed = 0;
function ok(message) {
  passed += 1;
  console.log(`PASS: ${message}`);
}

// --- Catalogue contract -------------------------------------------------------
{
  const heavy = PARTS.heavyEngine;
  const engine = PARTS.engine;
  assert.deepStrictEqual(heavy.footprint, { width: 2, height: 3 }, "Heavy Engine is a six-cell block");
  assert.strictEqual(heavy.category, "Engines");
  assert.strictEqual(heavy.rotatable, false, "main drives always face forward");
  assert(heavy.thrust / heavy.powerUse > engine.thrust / engine.powerUse,
    "Heavy Engine must be more thrust-efficient per MW than the standard Engine");
  assert(heavy.mass / heavy.thrust > engine.mass / engine.thrust,
    "Heavy Engine must pay for that efficiency in mass per unit of thrust");
  ok("Heavy Engine trades mass for thrust-per-Power against the standard Engine");
}

{
  const fast = PARTS.overclockedRepair;
  const base = PARTS.repair;
  assert(fast.repairRate > base.repairRate * 2.5, "Overclocked Repair Unit repairs far faster");
  assert(fast.powerUse > base.powerUse * 3, "and draws far more Power");
  assert(HeatRules.activityHeat("overclockedRepair", fast) > HeatRules.activityHeat("repair", base) * 1.5,
    "and generates substantially more Heat");
  assert(HeatRules.profile("overclockedRepair", fast).capacity < HeatRules.profile("repair", base).capacity,
    "with less thermal mass of its own to absorb it");
  ok("Overclocked Repair Unit is a faster, hotter, hungrier Repair module");
}

{
  const refractory = PARTS.refractoryArmor;
  const armor = PARTS.armor;
  assert.strictEqual(refractory.category, "Structure");
  assert.strictEqual(refractory.heatBeamShield, true, "Refractory Armour blocks induction Heat beams");
  assert(refractory.hp < armor.hp, "Refractory Armour gives up hull against standard Armor");
  const refractoryProfile = HeatRules.profile("refractoryArmor", refractory);
  const armorProfile = HeatRules.profile("armor", armor);
  assert(refractoryProfile.capacity > armorProfile.capacity * 3, "for a far larger thermal mass");
  assert(refractoryProfile.cooling * refractoryProfile.retention > armorProfile.cooling * armorProfile.retention,
    "and slightly faster shedding");
  ok("Refractory Armour trades hull for thermal capacity and Heat-beam immunity");
}

// Every structural material in the catalogue ships as a full silhouette family,
// and each variant must be a straight statScale of the base block — otherwise a
// tapered edge becomes a cheaper or tougher way to buy the same material.
{
  const base = PARTS.refractoryArmor;
  const variants = [
    ["halfRefractoryArmorDiagonal", 0.5, "halfDiagonal"],
    ["wingRefractoryArmor", 0.8, "wing"],
    ["bevelRefractoryArmor", 0.75, "bevel"],
    ["roundedRefractoryArmor", 0.8, "roundedCorner"],
    ["longWedgeRefractoryArmor", 1.5, "longWedge"]
  ];
  // The armour family's own convention: flat reduction scales down for the
  // cut-away shapes but a long wedge keeps the full block's value, exactly as
  // longWedgeArmor keeps Armor's 5 and longWedgeCompositeArmor keeps 3.5.
  assert.strictEqual(PARTS.longWedgeArmor.armorFlatReduction, PARTS.armor.armorFlatReduction,
    "the existing long wedge keeps its material's full flat reduction");

  for (const [id, scale, shapeType] of variants) {
    const part = PARTS[id];
    assert(part, `${id} exists`);
    assert.strictEqual(part.category, "Structure", `${id} is Structure`);
    assert.strictEqual(part.shapeType, shapeType, `${id} declares its silhouette`);
    assert.strictEqual(part.statScale, scale, `${id} declares its stat scale`);
    assert.strictEqual(part.rotatable, true, `${id} rotates to face its edge`);
    assert.strictEqual(part.heatBeamShield, true, `${id} still blocks induction Heat beams`);
    const close = (actual, expected, label) => assert(Math.abs(actual - expected) < 0.001,
      `${id} ${label}: ${actual} should be ${expected}`);
    close(part.hp, base.hp * scale, "hull");
    close(part.mass, base.mass * scale, "mass");
    close(part.cost, Math.round(base.cost * scale), "cost");
    close(part.heatCapacity, base.heatCapacity * scale, "heat capacity");
    close(part.heatCooling, base.heatCooling * scale, "heat cooling");
    // Conductivity and retention are material properties, not quantities.
    close(part.heatConductivity, base.heatConductivity, "heat conductivity");
    close(part.heatRetention, base.heatRetention, "heat retention");
    const expectedReduction = shapeType === "longWedge" ? base.armorFlatReduction : base.armorFlatReduction * scale;
    close(part.armorFlatReduction, expectedReduction, "flat reduction");
  }
  assert.deepStrictEqual(PARTS.longWedgeRefractoryArmor.footprint, { width: 2, height: 1 },
    "the long wedge is a two-cell prow");
  ok("The Refractory Armour silhouette family scales cleanly off the base block");
}

{
  assert.strictEqual(PARTS.spinalAccelerator.maxPerShip, 1, "only one spinal mount per ship");
  assert.deepStrictEqual(PARTS.spinalAccelerator.footprint, { width: 3, height: 6 });
  const charge = PARTS.spinalAccelerator.weapon.spinalCharge;
  assert(charge, "the Spinal Accelerator carries a charge configuration");
  assert.strictEqual(PARTS.spinalAccelerator.weapon.damage, 2040, "Spinal damage is buffed by 70%");
  assert.strictEqual(charge.chargeSeconds, 8, "Spinal charge time is 20% faster");
  for (let i = 1; i < charge.penetrationProfile.length; i += 1) {
    assert(charge.penetrationProfile[i] < charge.penetrationProfile[i - 1],
      "penetration must weaken with every component passed through");
  }
  ok("Spinal Accelerator is a single, long-charging, penetrating capital mount");
}

{
  assert.strictEqual(PARTS.scatterCannon.weapon.pelletCount, 6);
  assert(PARTS.scatterCannon.weapon.damage < PARTS.armor.armorFlatReduction * 1.5,
    "a pellet must be weak enough for flat armour reduction to be a real counter");
  assert.strictEqual(TurretRules.barrelCount("scatterCannon"), 3, "the art shows three muzzles");
  assert(PARTS.fragmentationCannon.weapon.blastRadius > 0 && PARTS.fragmentationCannon.weapon.blastDamage > 0);
  assert(PARTS.plasmaCannon.weapon.impactHeatPerDamage > 0);
  assert(PARTS.plasmaCannon.weapon.projectileSpeed < PARTS.blaster.weapon.projectileSpeed / 2,
    "a plasma slug is slow enough to dodge at range");
  ok("Scatter, Fragmentation and Plasma cannons carry their distinguishing weapon data");
}

// --- Projectile impact Heat (Plasma Cannon) -----------------------------------
{
  const room = makeRoom();
  const target = makeShip("t", "p2", 0, 0, [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 }
  ]);
  initShipHeat(target);
  // addComponentHeat queues into componentHeatInput; the thermal tick then moves
  // it into componentHeat. Reading the queue is what proves the delivery, without
  // the assertion also depending on one tick of conduction and cooling.
  const before = target.componentHeatInput.reduce((sum, value) => sum + value, 0);
  applyHullDamage(room, target, 40, 1000, 0, -200, { impactHeatPerDamage: 0.9 });
  const after = target.componentHeatInput.reduce((sum, value) => sum + value, 0);
  assert(after - before > 20, `impact Heat must reach the struck component (got ${after - before})`);
  ok("Plasma-style impact Heat is deposited into the components a round damages");
}

// --- Penetration profile (Spinal Accelerator) ---------------------------------
{
  const room = makeRoom();
  // A hit from world -y enters the design grid along a row of constant grid y
  // (see worldToGrid), so four frames in that row are the exact geometry the
  // penetration profile describes: a shot running down the length of a hull.
  const design = [
    { type: "core", x: 11, y: 7, rotation: 0 },
    { type: "frame", x: 3, y: 7, rotation: 0 },
    { type: "frame", x: 4, y: 7, rotation: 0 },
    { type: "frame", x: 5, y: 7, rotation: 0 },
    { type: "frame", x: 6, y: 7, rotation: 0 }
  ];
  const withProfile = makeShip("a", "p2", 0, 0, design.map((m) => ({ ...m })));
  const withoutProfile = makeShip("b", "p2", 0, 0, design.map((m) => ({ ...m })));
  const damage = 400;
  const profile = PARTS.spinalAccelerator.weapon.spinalCharge.penetrationProfile;

  // applyHullDamage takes the impact point, not the shooter's position: the ray
  // is walked from that cell back out along the incoming direction. (0, -58) is
  // the outer face of the frame at grid (3,7).
  applyHullDamage(room, withProfile, damage, 1000, 0, -58, { penetrationProfile: profile });
  applyHullDamage(room, withoutProfile, damage, 1000, 0, -58, {});

  const destroyedWith = withProfile.componentHp.filter((hp) => hp <= 0).length;
  const destroyedWithout = withoutProfile.componentHp.filter((hp) => hp <= 0).length;
  assert(destroyedWith >= 3, `a penetrating lance punches a channel (destroyed ${destroyedWith})`);
  assert(destroyedWith <= profile.length,
    "the channel stops once the penetration profile runs out");
  assert(destroyedWithout >= destroyedWith,
    "the profile costs the round damage rather than granting it extra reach");
  ok("Penetration profile drives damage down the impact ray and then stops");
}

// --- Offensive impact burst (Fragmentation Cannon) ----------------------------
{
  const room = makeRoom();
  const hullDesign = () => [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 },
    { type: "frame", x: 7, y: 8, rotation: 0 }
  ];
  const primary = makeShip("hit", "p2", 0, 0, hullDesign());
  const bystander = makeShip("near", "p2", 40, 0, hullDesign());
  primary.radius = 12;
  bystander.radius = 12;
  room.ships.set(primary.id, primary);
  room.ships.set(bystander.id, bystander);
  // ship.hp excludes the core's own pool, so component HP is the honest measure.
  const totalComponentHp = (ship) => ship.componentHp.reduce((sum, hp) => sum + hp, 0);
  const primaryHpBefore = totalComponentHp(primary);
  const bystanderHpBefore = totalComponentHp(bystander);

  const weapon = PARTS.fragmentationCannon.weapon;
  room.bullets.push({
    id: "frag-1",
    type: "bolt",
    ownerId: "p1",
    targetId: primary.id,
    x: -30,
    y: 0,
    vx: 600,
    vy: 0,
    damage: weapon.damage,
    shieldDamageMultiplier: weapon.shieldDamageMultiplier,
    hullDamageMultiplier: weapon.hullDamageMultiplier,
    blastDamage: weapon.blastDamage,
    blastRadius: weapon.blastRadius,
    innerFullDamageRadius: weapon.innerFullDamageRadius,
    falloffExponent: weapon.falloffExponent,
    maximumExplosionTargets: weapon.maximumExplosionTargets,
    life: 2,
    bornAt: 0
  });

  // One step long enough for the swept segment to cross the target hull.
  updateBullets(room, 0.1, 1000);
  assert(totalComponentHp(primary) < primaryHpBefore, "the direct hit still lands");
  assert(totalComponentHp(bystander) < bystanderHpBefore, "and the burst rakes a neighbouring hull");
  assert(room.effects.some((effect) => effect.type === "flakburst"), "the burst is visible");
  ok("Fragmentation-style shells detonate on impact and damage everything in the blast");
}

// --- Multi-pellet fire (Scatter Cannon) ---------------------------------------
{
  const room = makeRoom();
  const design = [
    { type: "core", x: 7, y: 8, rotation: 0 },
    { type: "scatterCannon", x: 7, y: 6, rotation: 0 }
  ];
  const attacker = makeShip("scatter", "p1", 0, 0, design);
  const target = makeShip("pellet-target", "p2", 200, 0, [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 6, rotation: 0 }
  ]);
  initShipHeat(attacker);
  room.ships.set(attacker.id, attacker);
  room.ships.set(target.id, target);

  const weapon = PARTS.scatterCannon.weapon;
  let now = 1000;
  // Let the turret traverse onto the target, then fire once.
  for (let step = 0; step < 40 && room.bullets.length === 0; step += 1) {
    updateShipWeapons(room, attacker, [attacker, target], 0.1, now);
    now += 100;
  }
  assert.strictEqual(room.bullets.length, weapon.pelletCount,
    `one trigger pull launches every pellet (got ${room.bullets.length})`);
  for (const pellet of room.bullets) {
    assert.strictEqual(pellet.damage, weapon.damage, "each pellet carries the per-pellet damage");
  }
  const angles = room.bullets.map((pellet) => Math.atan2(pellet.vy, pellet.vx));
  const spread = Math.max(...angles) - Math.min(...angles);
  assert(spread > 0, "and the pellets leave in a cone rather than a single line");
  assert(spread <= (weapon.pelletSpreadDegrees * Math.PI / 180) * 2 + 0.35,
    "bounded by the configured cone plus the weapon's own accuracy spread");
  ok("Scatter Cannon fires its full pellet count across a spread cone in one shot");
}

// --- Burst cooling ------------------------------------------------------------
{
  const room = makeRoom();
  const config = PARTS.burstCooler.burstCooler;
  const ship = makeShip("cooler", "p1", 0, 0, [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "burstCooler", x: 7, y: 6, rotation: 0 }
  ]);
  initShipHeat(ship);
  const coolerIndex = 1;
  const capacity = ship.componentThermals[coolerIndex].capacity;
  // addComponentHeat queues into componentHeatInput; the thermal tick loads it
  // and, in the same pass, the accumulator crosses its trigger and vents.
  const charged = capacity * 0.9;
  assert(charged / capacity >= config.triggerHeatRatio, "the accumulator is above its trigger");
  addComponentHeat(ship, coolerIndex, charged);

  updateShipHeat(ship, HeatRules.TICK_SECONDS, room, 1000);
  const afterBurst = ship.componentHeat[coolerIndex];
  assert(charged - afterBurst > config.burstHeat * 0.5,
    `the vent dumps a large store at once (removed ${charged - afterBurst})`);
  assert(ship.componentBurstCoolerRecharge[coolerIndex] > 0, "and then starts recharging");

  // While recharging it must not simply vent again on the next spike.
  addComponentHeat(ship, coolerIndex, charged);
  const before = ship.componentHeat[coolerIndex];
  updateShipHeat(ship, HeatRules.TICK_SECONDS, room, 1200);
  const removedWhileRecharging = before + charged - ship.componentHeat[coolerIndex];
  assert(removedWhileRecharging < config.burstHeat * 0.5,
    `a recharging Burst Cooler cannot vent again (removed ${removedWhileRecharging})`);
  ok("Burst Cooler dumps its whole store, then goes ineffective while it recharges");
}

// --- Refractory Armour blocks induction Heat beams ----------------------------
{
  const shielded = makeShip("shielded", "p2", 0, 0, [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "refractoryArmor", x: 7, y: 5, rotation: 0 }
  ]);
  const plain = makeShip("plain", "p2", 0, 0, [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "frame", x: 7, y: 5, rotation: 0 }
  ]);
  // The beam runs from far -x (blueprint "above" the ship) toward the core, so
  // it must cross the plate at grid y=5 before reaching the core at y=7.
  const coreIndex = 0;
  assert.strictEqual(
    isInductionBlockedByHeatShield(shielded, coreIndex, 400, 0, 0, 0, 8),
    true,
    "Refractory Armour in the beam line blocks the lance"
  );
  assert.strictEqual(
    isInductionBlockedByHeatShield(plain, coreIndex, 400, 0, 0, 0, 8),
    false,
    "ordinary structure does not"
  );
  ok("Refractory Armour fully blocks an induction Heat beam aimed through it");
}

// --- Spinal charge cycle ------------------------------------------------------
{
  const config = PARTS.spinalAccelerator.weapon.spinalCharge;
  assert.strictEqual(spinalTraverseScale(config, 0), 1, "aim is free early in the charge");
  assert.strictEqual(spinalTraverseScale(config, config.committedAimStartProgress), 1,
    "and right up to the commitment point");
  assert(spinalTraverseScale(config, 0.9) < 0.5, "traverse collapses in the late charge");
  assert(Math.abs(spinalTraverseScale(config, 1) - config.committedAimTraverseFloor) < 1e-9,
    "and bottoms out at the configured floor");
  ok("Spinal mount traverse commitment ramps exactly as configured");
}

// Charge changes only mount traverse. It never changes the live movement
// envelope produced by an otherwise identical hull.
{
  const ship = makeShip("turn-rate", "p1", 0, 0, [
    { type: "core", x: 7, y: 10, rotation: 0 },
    { type: "spinalAccelerator", x: 6, y: 2, rotation: 0 },
    { type: "gyroscope", x: 5, y: 10, rotation: 0 }
  ]);
  const baseStats = { mass: 300, thrust: 0, powerGeneration: 100, powerUse: 30 };
  const chargeSeconds = PARTS.spinalAccelerator.weapon.spinalCharge.chargeSeconds;
  const rates = [0, 0.5, 0.8, 0.99].map((progress) => {
    ship.weaponCharge = [0, progress * chargeSeconds, 0];
    return heatAdjustedMovementStats(ship, baseStats).turnRate;
  });
  assert(rates[0] > 0, "fixture has real hull turn authority");
  rates.forEach((rate) => assert.strictEqual(rate, rates[0]));
  ok("Spinal charge leaves hull turn rate unchanged at 0%, 50%, 80% and near-full charge");
}

{
  const room = makeRoom();
  const design = [
    { type: "core", x: 7, y: 10, rotation: 0 },
    { type: "spinalAccelerator", x: 6, y: 2, rotation: 0 }
  ];
  const attacker = makeShip("spinal", "p1", 0, 0, design);
  const target = makeShip("victim", "p2", 900, 0, [
    { type: "core", x: 7, y: 7, rotation: 0 },
    { type: "armor", x: 7, y: 6, rotation: 0 }
  ]);
  initShipHeat(attacker);
  initShipHeat(target);
  room.ships.set(attacker.id, attacker);
  room.ships.set(target.id, target);

  const dt = 0.25;
  let now = 1000;
  let fired = false;
  let sawPartialCharge = false;
  const chargeSeconds = PARTS.spinalAccelerator.weapon.spinalCharge.chargeSeconds;
  for (let step = 0; step < Math.ceil((chargeSeconds + 2) / dt); step += 1) {
    updateShipWeapons(room, attacker, [attacker, target], dt, now);
    now += dt * 1000;
    const progress = attacker.weaponCharge[1] / chargeSeconds;
    if (progress > 0.1 && progress < 0.95) sawPartialCharge = true;
    if (room.bullets.length > 0) { fired = true; break; }
  }

  assert(sawPartialCharge, "the mount visibly charges instead of firing immediately");
  assert(fired, "and eventually launches its lance");
  const lance = room.bullets[0];
  assert.strictEqual(lance.type, "rail");
  assert(Array.isArray(lance.penetrationProfile) && lance.penetrationProfile.length > 1,
    "the launched round carries its penetration profile");
  assert.strictEqual(attacker.weaponCharge[1], 0, "and the accumulator is spent");
  assert.strictEqual(Object.hasOwn(attacker, "spinalTurnPenalty"), false,
    "charging does not publish a movement-side hull penalty");
  ok("A Spinal Accelerator charges, commits its mount, fires a penetrating lance and resets");
}

// A mount that loses its firing solution keeps its charge briefly, then bleeds.
{
  const room = makeRoom();
  const design = [
    { type: "core", x: 7, y: 10, rotation: 0 },
    { type: "spinalAccelerator", x: 6, y: 2, rotation: 0 }
  ];
  const attacker = makeShip("spinal2", "p1", 0, 0, design);
  initShipHeat(attacker);
  room.ships.set(attacker.id, attacker);
  const config = PARTS.spinalAccelerator.weapon.spinalCharge;
  const hold = config.chargeHoldSeconds;
  assert.strictEqual(hold, 2, "the configured retention window is exactly two seconds");
  let now = 1000;
  // No target in the room at all, so every tick is an idle tick. The first tick
  // also allocates the per-slot charge arrays.
  updateShipWeapons(room, attacker, [attacker], 0.001, now);
  attacker.weaponCharge[1] = 5;
  attacker.weaponChargeIdle[1] = 0;
  updateShipWeapons(room, attacker, [attacker], 1.9, now);
  assert.strictEqual(attacker.weaponCharge[1], 5, "charge is unchanged through a 1.9 second loss");

  // Reacquisition resets idle time and continues from the retained value.
  attacker.weaponChargeIdle[1] = 0;
  attacker.weaponCharge[1] += 0.1;
  assert.strictEqual(attacker.weaponCharge[1], 5.1, "reacquisition resumes from retained charge");

  // A tick that crosses the boundary decays only its post-grace portion.
  attacker.weaponCharge[1] = 5;
  attacker.weaponChargeIdle[1] = 1.9;
  decaySpinalCharge(attacker, 1, config, 0.2);
  const expected = 5 - 0.1 * config.chargeDecayMultiplier;
  assert(Math.abs(attacker.weaponCharge[1] - expected) < 1e-9,
    "decay starts after two seconds and uses the configured decay multiplier");
  ok("Spinal charge retains for two seconds, resumes on reacquisition, then decays at the existing rate");
}

// Regression for an orbit-style target. The target's bearing advances quickly
// enough that the former late-charge 45% hull scale could not keep up, while
// this hull's real turn authority can. The mount must therefore finish its
// eight-second charge rather than repeatedly losing and reacquiring the arc.
{
  const room = makeRoom();
  const design = [
    { type: "core", x: 7, y: 10, rotation: 0 },
    { type: "spinalAccelerator", x: 6, y: 2, rotation: 0 },
    { type: "gyroscope", x: 5, y: 10, rotation: 0 },
    { type: "gyroscope", x: 9, y: 10, rotation: 0 }
  ];
  const attacker = makeShip("tracking-spinal", "p1", 0, 0, design);
  const target = makeShip("orbiting-target", "p2", 900, 0, [
    { type: "core", x: 7, y: 7, rotation: 0 }
  ]);
  initShipHeat(attacker);
  initShipHeat(target);
  room.ships.set(attacker.id, attacker);
  room.ships.set(target.id, target);

  const baseStats = { mass: 300, thrust: 0, powerGeneration: 100, powerUse: 30 };
  const normalTurnRate = heatAdjustedMovementStats(attacker, baseStats).turnRate;
  assert(normalTurnRate > 0, "tracking fixture has real turn authority");
  const targetAngularRate = normalTurnRate * 0.75;
  const dt = 0.05;
  let bearing = 0;
  let now = 1000;
  let minimumObservedTurnRate = Infinity;
  const maxSteps = Math.ceil(10 / dt);
  for (let step = 0; step < maxSteps && room.bullets.length === 0; step += 1) {
    bearing += targetAngularRate * dt;
    target.x = Math.cos(bearing) * 900;
    target.y = Math.sin(bearing) * 900;
    updateShipWeapons(room, attacker, [attacker, target], dt, now);
    const effectiveTurnRate = heatAdjustedMovementStats(attacker, baseStats).turnRate;
    minimumObservedTurnRate = Math.min(minimumObservedTurnRate, effectiveTurnRate);
    const error = Math.atan2(Math.sin(bearing - attacker.angle), Math.cos(bearing - attacker.angle));
    attacker.angle += Math.sign(error) * Math.min(Math.abs(error), effectiveTurnRate * dt);
    now += dt * 1000;
  }

  assert.strictEqual(minimumObservedTurnRate, normalTurnRate,
    "hull tracks at its normal rate throughout the rising charge");
  assert(room.bullets.length > 0, "the Spinal reaches full charge and fires at the orbiting target");
  ok("Fast-turn Spinal tracks an orbit-style target at full hull authority and fires");
}

console.log(`\nNew component verification passed (${passed} checks)`);
