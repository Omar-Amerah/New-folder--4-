const assert = require('assert');
const { PARTS } = require('./src/server/components');
const { initComponentState, applyHullDamage } = require('./src/server/componentHealth');
const { damageShip, updateShipWeapons, weaponReloadSeconds } = require('./src/server/combat');
const { updateBullets } = require('./src/server/projectiles');
const HeatRules = require('./public/src/shared/heatRules');

const EPS = 1e-6;
function close(actual, expected, msg, eps = EPS) {
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: expected ${expected}, got ${actual}`);
}
function room() {
  return { nextEntityId: 1, bullets: [], effects: [], map: { asteroids: [] }, world: { width: 2000, height: 2000 }, rules: { gameMode: 'team' }, players: new Map([[1, { id: 1, team: 'a' }], [2, { id: 2, team: 'b' }]]), ships: new Map(), combatRandom: () => 0.5 };
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
  const events = Math.round(seconds / dt); const before = t.hp;
  for (let i = 0; i < events; i++) damageShip(r, t, weapon.damage * dt, 1, i * dt * 1000, p.x, p.y, { hullDamageMultiplier: weapon.hullDamageMultiplier, armorInteractionSeconds: dt });
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
  for (let i = 0; i < shots; i++) damageShip(room(), t, w.damage, 1, i, p.x, p.y, { hullDamageMultiplier: w.hullDamageMultiplier, armorInteractionSeconds: Math.min(1, 1 / w.fireRate) });
  const dps = (before - t.hp) / duration;
  const expected = Math.max(0, w.damage * w.hullDamageMultiplier * w.fireRate - armor);
  close(dps, expected, `${id} armour sustained DPS`);
  if (id === 'autocannon') assert.ok(dps > 0, 'autocannon no longer loses full armour per shot');
}
{
  const w = PARTS.autocannon.weapon; const t = target('frame'); const before = t.hp; const p = impact(t); const shots = 43;
  for (let i = 0; i < shots; i++) damageShip(room(), t, w.damage, 1, i, p.x, p.y, { hullDamageMultiplier: w.hullDamageMultiplier, armorInteractionSeconds: Math.min(1, 1 / w.fireRate) });
  close((before - t.hp) / (shots / w.fireRate), w.damage * w.hullDamageMultiplier * w.fireRate, 'autocannon unarmoured control');
}
for (const id of ['railgun', 'torpedo']) {
  const w = PARTS[id].weapon; close(damageOnce(target('armor'), w.damage, { hullDamageMultiplier: w.hullDamageMultiplier, armorInteractionSeconds: Math.min(1, 1 / w.fireRate) }), w.damage * w.hullDamageMultiplier - armor, `${id} full per-hit armour`);
}
{
  const w = PARTS.pointDefense.weapon; const shot = damageOnce(target('armor'), w.damage * w.shipDamageMultiplier, { hullDamageMultiplier: w.hullDamageMultiplier, armorInteractionSeconds: Math.min(1, 1 / w.fireRate) });
  close(shot, 0, 'point defence anti-ship remains fully absorbed by standard armour');
}
close(damageOnce(target('armor'), 20), 15, 'default compatibility applies full reduction');
close(damageOnce(target('armor'), 20, { armorInteractionSeconds: 1 }), 15, 'one second cadence full reduction');
close(damageOnce(target('armor'), 20, { armorInteractionSeconds: 0.25 }), 18.75, 'quarter second cadence quarter reduction');
{
  const t = target('armor'); t.componentHeatState = []; t.componentHeatState[0] = HeatRules.STATE.HOT;
  const protection = HeatRules.passiveProtectionForState(HeatRules.STATE.HOT);
  const structural = HeatRules.structuralDamageMultiplierForState(HeatRules.STATE.HOT);
  close(damageOnce(t, 20, { armorInteractionSeconds: 0.25 }), (20 - armor * protection * 0.25) * structural, 'thermal protection composes with interval');
}
// Production propagation: spawned autocannon projectile interval matches cooldown.
{
  const r = room(); const shooter = { id: 's', ownerId: 1, x: 430, y: 500, vx: 0, vy: 0, angle: 0, radius: 20, alive: true, shield: 0, stats: { maxHp: 1000 }, design: [{ type: 'autocannon', x: 7, y: 7, rotation: 0 }] }; initComponentState(shooter);
  const victim = target('armor'); r.ships.set(shooter.id, shooter); r.ships.set(victim.id, victim);
  updateShipWeapons(r, shooter, [shooter, victim], 1 / 30, 0);
  assert.strictEqual(r.bullets.length, 1, 'autocannon spawned one projectile');
  close(r.bullets[0].armorInteractionSeconds, Math.min(1, shooter.weaponCooldowns[0]), 'projectile interval matches cooldown');
}
// updateBullets forwards interval, legacy bullets default full, and interception bypasses ship armour.
{
  const r = room(); const victim = target('armor'); r.ships.set(victim.id, victim);
  r.bullets.push({ id: 'b', type: 'bolt', ownerId: 1, targetId: victim.id, x: victim.x + 50, y: victim.y, vx: -100, vy: 0, life: 1, damage: 20, hullDamageMultiplier: 1, armorInteractionSeconds: 0.25 });
  updateBullets(r, 0.5, 0); close(9000 - victim.hp, 18.75, 'updateBullets forwards projectile interval');
  const rLegacy = room(); const legacy = target('armor'); rLegacy.ships.set(legacy.id, legacy); rLegacy.bullets = [{ id: 'c', type: 'bolt', ownerId: 1, targetId: legacy.id, x: legacy.x + 50, y: legacy.y, vx: -100, vy: 0, life: 1, damage: 20, hullDamageMultiplier: 1 }];
  updateBullets(rLegacy, 0.5, 1); close(9000 - legacy.hp, 15, 'legacy projectile defaults to full reduction');
  const missile = { id: 'm', type: 'missile', ownerId: 2, x: 100, y: 100, vx: 0, vy: 0, life: 1, damage: 99, hp: 6, interceptable: true };
  r.bullets = [missile, { id: 'pd', type: 'pdShot', ownerId: 1, x: 100, y: 100, vx: 0, vy: 0, life: 1, damage: 6, pdTargetType: 'projectile', pdTargetId: 'm' }];
  updateBullets(r, 0.01, 2); assert.strictEqual(missile.life, 0, 'interception destroys projectile without ship armour');
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
console.log('verify-armor-delivery passed');
