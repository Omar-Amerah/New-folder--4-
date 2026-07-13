const assert = require('assert');
const HeatRules = require('./public/src/shared/heatRules');
const heat = require('./src/server/heat');
const { PARTS } = require('./src/server/components');
const fs = require('fs');

const S = HeatRules.STATE;
assert.strictEqual(HeatRules.activeOutputForState(S.WARM), 1, 'Warm active output remains 1');
assert.strictEqual(HeatRules.activeOutputForState(S.HOT), 0.70, 'Hot active output is 0.70');
assert.strictEqual(HeatRules.activeOutputForState(S.CRITICAL), 0.40, 'Critical active output is 0.40');
assert.strictEqual(HeatRules.activeOutputForState(S.OVERHEATED), 0, 'Overheated active output is 0');
assert.strictEqual(HeatRules.passiveProtectionForState(S.HOT), 0.85, 'Hot passive protection is 0.85');
assert.strictEqual(HeatRules.passiveProtectionForState(S.OVERHEATED), 0.40, 'Overheated passive protection remains partial');
assert.strictEqual(HeatRules.activeCoolingForState(S.HOT), 0.75, 'Hot active cooling is 0.75');
assert.strictEqual(HeatRules.activeCoolingForState(S.OVERHEATED), 0, 'Overheated active cooling is 0');
assert.strictEqual(Number(HeatRules.structuralDamageMultiplierForState(S.HOT).toFixed(2)), 1.15, 'Hot structure takes x1.15');
assert.strictEqual(Number(HeatRules.structuralDamageMultiplierForState(S.CRITICAL).toFixed(2)), 1.35, 'Critical structure takes x1.35');
assert.strictEqual(Number(HeatRules.structuralDamageMultiplierForState(S.OVERHEATED).toFixed(2)), 1.60, 'Overheated structure takes x1.60');

const ship = {
  design: [{ type: 'targetingComputer' }, { type: 'fireControl' }, { type: 'sensorArray' }, { type: 'captureModule' }, { type: 'reactor' }, { type: 'auxGenerator' }],
  componentHp: [1, 1, 1, 1, 1, 1],
  componentHeatState: [S.OVERHEATED, S.OVERHEATED, S.OVERHEATED, S.OVERHEATED, S.OVERHEATED, S.NORMAL]
};
assert.strictEqual(heat.effectiveComponentBonus(ship, 'accuracyBonus'), 0, 'Overheated targeting module removes only its bonus');
assert.strictEqual(heat.effectiveComponentBonus(ship, 'fireRateBonus'), 0, 'Overheated Fire Control removes only its bonus');
assert.strictEqual(heat.effectiveComponentBonus(ship, 'rangeBonus'), 0, 'Overheated Sensor Array removes only its bonus');
assert.strictEqual(heat.effectiveComponentBonus(ship, 'captureBonus'), 0, 'Overheated Capture Module contributes no capture bonus');
assert(PARTS.blaster.weapon.accuracy > 0, 'Base weapon accuracy remains on weapon definition');

const componentHealth = fs.readFileSync('./src/server/componentHealth.js', 'utf8');
assert(componentHealth.includes('armorFlatReduction * protection'), 'Armour flat reduction is heat-aware');
assert(componentHealth.includes('structuralDamageMultiplierForState'), 'Passive structures take heat-scaled component damage');

const serverCombat = fs.readFileSync('./src/server/combat.js', 'utf8');
assert(serverCombat.includes('componentPerformance(ship, i) * (ship.thermalPowerFactor ?? 1) * dt'), 'Beam DPS scales by local heat performance and thermal power');
assert(serverCombat.includes('fireRateMultiplier * heatPerformance'), 'Projectile reload uses active heat performance');
assert(!serverCombat.includes('systemPerformance(ship'), 'Utility bonuses are not applied as whole-system performance multipliers');

const serverMovement = fs.readFileSync('./src/server/movement.js', 'utf8');
assert(serverMovement.includes('heatWeightedMovementFactors'), 'Movement uses weighted heat factors');
assert(serverMovement.includes('maxSpeed: (stats.maxSpeed || 0) * factors.thrust * factors.power'), 'Max speed scales with engine heat and thermal power');
assert(serverMovement.includes('turnRate: (stats.turnRate || 0) * factors.turn * factors.power'), 'Turn rate scales with turn contribution heat and thermal power');

const serverHeat = fs.readFileSync('./src/server/heat.js', 'utf8');
assert(serverHeat.includes('availablePower += output * activeOutputForState(nextState)'), 'Generator output is weighted by nominal generation and active heat performance');
assert(serverHeat.includes('passiveFloor'), 'Radiator has a passive cooling floor for recovery');
assert(serverHeat.includes('edgeTransfer'), 'Heat Pipe transfer topology remains shared edge transfer based');

const inspector = fs.readFileSync('./public/src/ui/partInspectorUi.js', 'utf8');
assert(!inspector.includes('Hot / Critical penalty'), 'Inspector no longer uses generic hot/critical penalty wording');
assert(!inspector.includes('Overheat shutdown'), 'Inspector no longer uses generic overheat shutdown wording');
assert(inspector.includes('Transfer unaffected'), 'Heat Pipe inspector states transfer is unaffected');
assert(inspector.includes('protection') && inspector.includes('Takes ×'), 'Passive UI uses role-specific protection/damage wording');

console.log('heat effects verification passed');
