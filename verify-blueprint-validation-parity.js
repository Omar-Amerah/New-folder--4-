#!/usr/bin/env node
const assert = require('node:assert/strict');
const { validateDesign } = require('./src/server/shipDesign.js');

(async () => {
  globalThis.document = { createElement: () => ({ getContext: () => ({}) }), getElementById: () => null };
  globalThis.window = globalThis;
  globalThis.EngineExhaustRules = (await import('./public/src/shared/engineExhaust.js')).default || (await import('./public/src/shared/engineExhaust.js'));
  await import('./public/src/shared/wiringRules.js');
  const { validateBlueprint } = await import('./public/src/design/blueprintValidation.js');
  const { normalizeDesignDetailed, defaultDesign } = await import('./public/src/design/blueprintStorage.js');
  const { computeStats } = await import('./public/src/design/componentStats.js');
  const valid = defaultDesign();
  const noEngine = valid.filter(p => p.type !== 'engine');
  const fixtures = [
    ['valid ship', valid],
    ['empty design', []],
    ['missing core', valid.filter(p => p.type !== 'core')],
    ['multiple cores', [...valid, { x: 10, y: 10, type: 'core' }]],
    ['unknown module type', [{ x: 7, y: 7, type: 'core' }, { x: 7, y: 8, type: 'engine' }, { x: 6, y: 7, type: 'nope' }]],
    ['non-numeric coordinate', [{ x: 7, y: 7, type: 'core' }, { x: 'x', y: 8, type: 'engine' }]],
    ['out-of-bounds 1x1', [{ x: 7, y: 7, type: 'core' }, { x: 15, y: 8, type: 'engine' }]],
    ['overlapping 1x1', [{ x: 7, y: 7, type: 'core' }, { x: 7, y: 7, type: 'engine' }]],
    ['valid without engine', noEngine],
    ['valid with engine', valid]
  ];
  for (const [name, design] of fixtures) {
    const detailed = normalizeDesignDetailed(design, { allowEmpty: true });
    const client = validateBlueprint(detailed.modules, { requireThrust: true, stats: computeStats(detailed.modules), normalizationIssues: detailed.issues });
    const server = validateDesign(design);
    assert.equal(client.ok, server.ok, `${name}: validity`);
    assert.equal(client.errors[0] || '', server.reason || '', `${name}: reason`);
  }
  const invalidThenSurvivors = [{ x: 99, y: 7, type: 'armor' }, ...valid];
  const detailed = normalizeDesignDetailed(invalidThenSurvivors, { allowEmpty: true });
  assert.ok(detailed.modules.length > 0, 'client keeps safe survivors for display');
  assert.equal(validateBlueprint(detailed.modules, { normalizationIssues: detailed.issues }).ok, false, 'client rejects original');
  assert.equal(validateDesign(invalidThenSurvivors).ok, false, 'server rejects original');
  console.log('Blueprint validation parity verification passed');
})();
