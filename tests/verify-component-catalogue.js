const assert = require('assert');
const HeatRules = require('../public/src/shared/heatRules');

global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add(){}, remove(){}, toggle(){} }, setAttribute(){}, appendChild(){}, getContext: () => null })
};
global.window = { devicePixelRatio: 1 };

(async () => {
  const parts = await import('../public/src/design/parts.js');
  const { PART_CATEGORIES } = await import('../public/src/constants.js');
  const before = parts.PART_STATS.core.cost;
  for (const type of ['signalAmplifier', 'stabilizerNode']) {
    assert.strictEqual(parts.PART_STATS[type].category, 'Support', `${type} belongs to Support`);
  }
  assert.strictEqual(parts.PART_STATS.smallSensor.sensorRole, 'omniSmall');
  assert.strictEqual(parts.PART_STATS.largeSensor.sensorRole, 'omniLarge');
  assert.strictEqual(parts.PART_STATS.smallDirectedSensor.sensorRole, 'directed');
  assert.strictEqual(parts.PART_STATS.largeDirectedSensor.sensorRole, 'directed');
  assert.strictEqual(parts.PART_STATS.sensorArray, undefined, 'legacy Sensor Array is removed from the live catalogue');
  assert.strictEqual(parts.PART_STATS.directedSensor, undefined, 'legacy Directed Sensor is removed from the live catalogue');
  assert.deepStrictEqual(parts.PART_STATS.largeSensor.footprint, { width: 2, height: 1 });
  assert.deepStrictEqual(parts.PART_STATS.smallDirectedSensor.footprint, { width: 1, height: 1 });
  assert.deepStrictEqual(parts.PART_STATS.largeDirectedSensor.footprint, { width: 2, height: 1 });
  assert.strictEqual(parts.PART_STATS.captureModule, undefined, 'Capture Module is removed from the catalogue');
  assert.strictEqual(parts.PART_STATS.backupCore.category, 'Command');
  assert.strictEqual(parts.PART_STATS.droneBay.category, 'Command');
  assert.strictEqual(parts.PART_STATS.heatPipe.category, 'Heat Components');
  assert.deepStrictEqual(parts.PART_STATS.nuclearReactor.footprint, { width: 3, height: 2 });
  assert.strictEqual(parts.PART_STATS.nuclearReactor.powerGeneration, 40);
  assert(HeatRules.activityHeat('nuclearReactor', parts.PART_STATS.nuclearReactor)
    > HeatRules.activityHeat('reactor', parts.PART_STATS.reactor) * 2,
  'Nuclear Reactor generates substantially more Heat than a standard Reactor');
  assert(PART_CATEGORIES.includes('Heat Components'));
  assert(PART_CATEGORIES.includes('Command'));
  assert.strictEqual(parts.isPalettePart('backupCore'), true);
  assert.strictEqual(parts.isPalettePart('droneBay'), true);
  assert.strictEqual(parts.isPalettePart('nuclearReactor'), true);
  assert.strictEqual(parts.isPalettePart('smallSensor'), true);
  assert.strictEqual(parts.isPalettePart('largeSensor'), true);
  assert.strictEqual(parts.isPalettePart('smallDirectedSensor'), true);
  assert.strictEqual(parts.isPalettePart('largeDirectedSensor'), true);
  assert.strictEqual(parts.isPalettePart('sensorArray'), false);
  assert.strictEqual(parts.isPalettePart('directedSensor'), false);
  assert.strictEqual(parts.isPalettePart('captureModule'), false);
  assert.strictEqual(Object.values(parts.PART_STATS).some((part) => part.category === 'Utility'), false,
    'the component catalogue exposes no Utility category');
  assert.notStrictEqual(parts.componentCatalogueSource(), 'server');
  parts.applyServerParts({ core: { cost: 123, mass: 1, hp: 1, footprint: { width: 1, height: 1 } } });
  assert.strictEqual(parts.componentCatalogueSource(), 'server');
  assert.strictEqual(parts.PART_STATS.core.cost, 123);
  const applied = parts.applyComponentBalance({ components: [{ id: 'core', cost: 999, mass: 1, hull: 1, footprint: { width: 1, height: 1 } }] });
  assert.strictEqual(applied, false, 'late HTTP balance must not override server catalogue');
  assert.strictEqual(parts.PART_STATS.core.cost, 123);
  assert(Number.isFinite(before));
  console.log('Component catalogue precedence verification passed');
})();
