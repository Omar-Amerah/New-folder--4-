const assert = require('assert');
const { PARTS } = require('../src/server/components');
const { initComponentState, applyHullDamage } = require('../src/server/componentHealth');
const { damageShip, damageBeamTargets, updateShipWeapons, findBeamRayIntersections, weaponReloadSeconds } = require('../src/server/combat');
const { updateBullets, SHIELD_HIT_MIN } = require('../src/server/projectiles');
const HeatRules = require('../public/src/shared/heatRules');

const EPS = 1e-6;
function close(actual, expected, msg, eps = EPS) {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: expected ${expected}, got ${actual}`);
}
function room() {
  return { nextEntityId: 1, bullets: [], effects: [], map: { asteroids: [] }, world: { width: 2000, height: 2000 }, rules: { gameMode: 'teams' }, players: new Map([[1, { id: 1, team: 'a' }], [2, { id: 2, team: 'b' }]]), ships: new Map(), combatRandom: () => 0.5 };
}
function target(type = 'armor') {
  const ship = { id: `t${Math.random()}`, ownerId: 2, x: 500, y: 500, vx: 0, vy: 0, angle: 0, radius: 35, alive: true, shield: 0, maxShield: 0, stats: { maxHp: 10000, frontDamageReduction: 0, frontArc: 0 }, design: [{ type, x: 7, y: 6, rotation: 0 }, { type: 'core', x: 7, y: 7, rotation: 0 }] };
  initComponentState(ship);
  ship.componentHp[0] = 9000;
  ship.componentMaxHp[0] = 9000;
  ship.hp = 9000;
  return ship;
}
function impact(ship) { return { x: ship.x + 13, y: ship.y }; }
function damageOnce(t, damage, options = {}) {
  const r = room(); r.ships.set(t.id, t); const p = impact(t); const before = t.hp;
  damageShip(r, t, damage, 1, 0, p.x, p.y, options);
  return before - t.hp;
}
function sustained(type, seconds, dt, weapon) {
  const t = target(type); const r = room(); r.ships.set(t.id, t); const p = impact(t);
  const intersections = findBeamRayIntersections(t, t.x + 50, t.y, t.x - 50, t.y);
  assert.ok(intersections.length, 'beam test ray intersects the target component');
  const events = Math.round(seconds / dt); const before = t.hp;
  for (let i = 0; i < events; i++) {
    damageShip(r, t, weapon.damage * dt, 1, i * dt * 1000, p.x, p.y, {
      hullDamageMultiplier: weapon.hullDamageMultiplier,
      intersections,
      beamDeltaSeconds: dt
    });
  }
  return (before - t.hp) / (events * dt);
}

const armor = PARTS.armor.armorFlatReduction;
assert.strictEqual(armor, 5, 'production standard armour flat reduction remains 5');

{
  const w = PARTS.beamEmitter.weapon; const dt = 1 / 30;
  const unarmored = w.damage * w.hullDamageMultiplier;
  close(sustained('armor', 1, dt, w), Math.max(0, unarmored - armor), 'beam armour sustained DPS');
  assert.ok(sustained('armor', 1, dt, w) > 0, 'beam still damages standard armour with production balance');
  close(sustained('frame', 1, dt, w), unarmored, 'beam unarmoured control');
}
for (const id of ['autocannon', 'blaster']) {
  const w = PARTS[id].weapon; const shots = Math.round(w.fireRate * 10); const duration = shots / w.fireRate; const t = target('armor'); const before = t.hp; const p = impact(t);
  for (let i = 0; i < shots; i++) damageShip(room(), t, w.damage, 1, i, p.x, p.y, { hullDamageMultiplier: w.hullDamageMultiplier });
  const dps = (before - t.hp) / duration;
  const expected = Math.max(0, w.damage * w.hullDamageMultiplier - armor) * w.fireRate;
  close(dps, expected, `${id} armour sustained DPS`);
}
{
  const w = PARTS.autocannon.weapon; const t = target('frame'); const before = t.hp; const p = impact(t); const shots = 43;
  for (let i = 0; i < shots; i++) damageShip(room(), t, w.damage, 1, i, p.x, p.y, { hullDamageMultiplier: w.hullDamageMultiplier });
  close((before - t.hp) / (shots / w.fireRate), w.damage * w.hullDamageMultiplier * w.fireRate, 'autocannon unarmoured control');
}
for (const id of ['railgun', 'torpedo']) {
  const w = PARTS[id].weapon; close(damageOnce(target('armor'), w.damage, { hullDamageMultiplier: w.hullDamageMultiplier }), w.damage * w.hullDamageMultiplier - armor, `${id} full per-hit armour`);
}
{
  const w = PARTS.pointDefense.weapon; const shot = damageOnce(target('armor'), w.damage * w.shipDamageMultiplier, { hullDamageMultiplier: w.hullDamageMultiplier });
  close(shot, 0, 'point defence anti-ship remains fully absorbed by standard armour');
}
close(damageOnce(target('armor'), 20), 15, 'discrete projectile hit applies full reduction');
{
  const expected = [
    [HeatRules.STATE.NORMAL, 5],
    [HeatRules.STATE.WARM, 5],
    [HeatRules.STATE.HOT, 4.25],
    [HeatRules.STATE.CRITICAL, 3.25],
    [HeatRules.STATE.OVERHEATED, 2]
  ];
  for (const [state, reduction] of expected) {
    const t = target('armor');
    t.componentHeatState = [];
    t.componentHeatState[0] = state;
    const protection = HeatRules.passiveProtectionForState(state);
    const structural = HeatRules.structuralDamageMultiplierForState(state);
    close(armor * protection, reduction, `${HeatRules.STATE_LABELS[state]} armour reduction`);
    close(damageOnce(t, 20), (20 - reduction) * structural, `${HeatRules.STATE_LABELS[state]} thermal armour damage`);
  }
}
// Production propagation: spawned projectile payloads do not carry a cadence-based armour field.
{
  const r = room(); const shooter = { id: 's', ownerId: 1, x: 430, y: 500, vx: 0, vy: 0, angle: 0, radius: 20, alive: true, shield: 0, stats: { maxHp: 1000 }, design: [{ type: 'autocannon', x: 7, y: 7, rotation: 0 }] }; initComponentState(shooter);
  const victim = target('armor'); r.ships.set(shooter.id, shooter); r.ships.set(victim.id, victim);
  updateShipWeapons(r, shooter, [shooter, victim], 1 / 30, 0);
  updateShipWeapons(r, shooter, [shooter, victim], 1 / 30, 1000);
  assert.strictEqual(r.bullets.length, 1, 'autocannon spawned one projectile');
  assert.ok(!Object.prototype.hasOwnProperty.call(r.bullets[0], 'armorInteractionSeconds'), 'projectiles do not carry armour interaction time');
}
// updateBullets resolves each projectile hit with the full discrete reduction.
{
  const r = room(); const victim = target('armor'); r.ships.set(victim.id, victim);
  r.bullets.push({ id: 'b', type: 'bolt', ownerId: 1, targetId: victim.id, x: victim.x + 50, y: victim.y, vx: -100, vy: 0, life: 1, damage: 20, hullDamageMultiplier: 1 });
  updateBullets(r, 0.5, 0); close(9000 - victim.hp, 15, 'updateBullets applies flat projectile reduction');
  const rLegacy = room(); const legacy = target('armor'); rLegacy.ships.set(legacy.id, legacy); rLegacy.bullets = [{ id: 'c', type: 'bolt', ownerId: 1, targetId: legacy.id, x: legacy.x + 50, y: legacy.y, vx: -100, vy: 0, life: 1, damage: 20, hullDamageMultiplier: 1 }];
  updateBullets(rLegacy, 0.5, 1); close(9000 - legacy.hp, 15, 'legacy projectile defaults to full reduction');
  const rIntercept = room();
  const missile = { id: 'm', type: 'missile', ownerId: 2, x: 100, y: 100, vx: 0, vy: 0, life: 1, damage: 99, hp: 6, interceptable: true };
  rIntercept.bullets = [missile, { id: 'pd', type: 'pdShot', ownerId: 1, x: 100, y: 100, vx: 0, vy: 0, life: 1, damage: 6, pdTargetType: 'projectile', pdTargetId: 'm' }];
  updateBullets(rIntercept, 0.01, 2); assert.strictEqual(missile.life, 0, 'interception destroys projectile without ship armour');
}
// Scatter pellets are separate projectile hits, so armour is applied once per pellet.
{
  const w = PARTS.scatterCannon.weapon;
  const pelletDamage = w.damage * w.hullDamageMultiplier;
  const r = room(); const t = target('armor'); const before = t.hp;
  r.ships.set(t.id, t);
  for (let i = 0; i < w.pelletCount; i++) {
    r.bullets.push({ id: `pellet-${i}`, type: 'bolt', ownerId: 1, targetId: t.id, x: t.x + 50, y: t.y, vx: -100, vy: 0, life: 1, damage: w.damage, hullDamageMultiplier: w.hullDamageMultiplier });
  }
  updateBullets(r, 0.5, 0);
  const separatePellets = w.pelletCount * Math.max(0, pelletDamage - armor);
  close(before - t.hp, separatePellets, 'Scatter Cannon applies armour per pellet');
  const combinedVolley = damageOnce(target('armor'), w.damage * w.pelletCount, { hullDamageMultiplier: w.hullDamageMultiplier });
  assert.ok(combinedVolley > separatePellets, 'combining pellets would not bypass their individual armour checks');
}
// Beam production firing branch forwards dt through damageBeamTargets.
{
  const w = PARTS.beamEmitter.weapon; const dt = 1 / 30; const r = room();
  const shooter = { id: 's2', ownerId: 1, x: 600, y: 500, vx: 0, vy: 0, angle: 0, radius: 20, alive: true, shield: 0, stats: { maxHp: 1000 }, design: [{ type: 'beamEmitter', x: 7, y: 7, rotation: 180 }] };
  initComponentState(shooter);
  const victim = target('armor'); r.ships.set(shooter.id, shooter); r.ships.set(victim.id, victim);
  updateShipWeapons(r, shooter, [shooter, victim], dt, 0);
  close(9000 - victim.hp, w.damage * w.hullDamageMultiplier * dt - armor * dt, 'beam firing branch forwards dt');
}
// Beam hull bleed-through from an active shield keeps the same per-second
// armour rule as an unshielded beam contact.
{
  const dt = 0.1; const r = room(); const victim = target('armor'); victim.shield = SHIELD_HIT_MIN; victim.maxShield = SHIELD_HIT_MIN;
  const shooter = { id: 's3', ownerId: 1, x: victim.x + 100, y: victim.y, vx: 0, vy: 0, angle: Math.PI, radius: 20, alive: true, stats: { maxHp: 1000 } };
  r.ships.set(victim.id, victim);
  const beamDamage = 20;
  const result = damageBeamTargets(r, shooter, [victim], victim.x + 100, victim.y, victim.x - 100, victim.y, 0, beamDamage, 0, {
    shieldDamageMultiplier: 1,
    hullDamageMultiplier: 1,
    beamDeltaSeconds: dt
  });
  assert.strictEqual(result.firstHitIndex, -1, 'beam test remains on the active shield boundary');
  const bleedThrough = SHIELD_HIT_MIN * (1 - 0.95);
  const overflow = beamDamage - SHIELD_HIT_MIN + bleedThrough;
  close(9000 - victim.hp, overflow - armor * dt, 'beam shield bleed-through uses dt-scaled armour');
}
console.log('verify-armor-delivery passed');
